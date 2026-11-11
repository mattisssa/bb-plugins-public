// BrowserDriver over `bb browser-automation` sessions.
//
// Transport: the bb CLI proxies plugin commands as
// POST <server>/api/v1/plugins/<id>/cli {argv, threadId}. Calling that
// endpoint directly from the plugin server costs ~25 ms per run instead of
// ~230 ms for a CLI process. If the endpoint disappears in a future bb, the
// driver falls back to spawning the bb CLI.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { freshScript, observeScript, openScript, stepScript, type Viewport } from "./scripts";
import { StalePage, UncertainMutation, type Action, type BrowserDriver, type Page, type StepResult } from "./types";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Transport = (argv: string[], threadId: string, signal?: AbortSignal) => Promise<CliResult>;

export class BrowserAutomationError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "BrowserAutomationError";
  }
}

export function httpTransport(baseUrl: () => string, fetchImpl: typeof fetch = fetch): Transport {
  return async (argv, threadId, signal) => {
    const response = await fetchImpl(`${baseUrl()}/api/v1/plugins/browser-automation/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv, threadId }),
      signal,
    });
    if (response.status === 404) throw new TransportUnavailable(`HTTP 404 from the plugin CLI endpoint`);
    const body = (await response.json().catch(() => null)) as Partial<CliResult> | null;
    if (body === null || typeof body.exitCode !== "number") {
      throw new BrowserAutomationError(`Unexpected response from browser-automation (HTTP ${response.status})`);
    }
    return { exitCode: body.exitCode, stdout: body.stdout ?? "", stderr: body.stderr ?? "" };
  };
}

export class TransportUnavailable extends Error {}

export function cliTransport(bin = process.env.BB_CLI ?? "bb"): Transport {
  return (argv, threadId, signal) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        ["browser-automation", ...argv],
        { env: { ...process.env, BB_THREAD_ID: threadId }, maxBuffer: 32 * 1024 * 1024, signal },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
          resolve({ exitCode: error ? Number((error as { code?: number }).code) : 0, stdout, stderr });
        },
      );
    });
}

/** HTTP first; on a missing endpoint or refused connection, use the CLI from then on. */
export function resilientTransport(primary: Transport, fallback: Transport): Transport {
  let useFallback = false;
  return async (argv, threadId, signal) => {
    if (!useFallback) {
      try {
        return await primary(argv, threadId, signal);
      } catch (error) {
        const refused = (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED";
        if (!(error instanceof TransportUnavailable) && !refused) throw error;
        useFallback = true;
      }
    }
    return fallback(argv, threadId, signal);
  };
}

/** Parse `--json` output; throws BrowserAutomationError for `{ok:false}` envelopes. */
export function parseJsonOutput(result: CliResult): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new BrowserAutomationError(
      (result.stderr || result.stdout || `browser-automation exited ${result.exitCode}`).trim().slice(0, 500),
    );
  }
  if (typeof parsed !== "object" || parsed === null) throw new BrowserAutomationError("Malformed output");
  const envelope = parsed as { ok?: boolean; error?: { code?: string; message?: string } };
  if (envelope.ok === false || result.exitCode !== 0) {
    throw new BrowserAutomationError(
      envelope.error?.message ?? (result.stderr.trim() || `browser-automation exited ${result.exitCode}`),
      envelope.error?.code ?? null,
    );
  }
  return parsed as Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprint(state: Pick<Page, "url" | "text" | "actions" | "scroll">): string {
  const content = { url: state.url, text: state.text, actions: state.actions, scroll: state.scroll };
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

function toPage(raw: unknown): Page | null {
  if (typeof raw !== "object" || raw === null) return null;
  const state = raw as Omit<Page, "fingerprint">;
  if (typeof state.url !== "string" || !Array.isArray(state.actions)) return null;
  return { ...state, fingerprint: fingerprint(state) };
}

export interface SessionInfo {
  id: string;
  hostId: string;
  backend: string;
  previewDirective: string | null;
}

export class BrowserAutomation {
  constructor(
    private readonly transport: Transport,
    readonly threadId: string,
  ) {}

  async command(argv: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return parseJsonOutput(await this.transport([...argv, "--json"], this.threadId, signal));
  }

  async open(
    options: { hostId: string; backend: "local" | "desktop"; desktop?: string; tab?: string },
    signal?: AbortSignal,
  ): Promise<SessionInfo> {
    const argv = ["open", "--backend", options.backend, "--machine", options.hostId];
    if (options.backend === "local") argv.push("--headless");
    else {
      if (!options.desktop) throw new Error("Desktop sessions need a desktop instance id");
      argv.push("--desktop", options.desktop);
      if (options.tab) argv.push("--tab", options.tab);
    }
    const result = await this.command(argv, signal);
    return {
      id: String(result.id),
      hostId: String(result.hostId ?? options.hostId),
      backend: String(result.backend ?? options.backend),
      previewDirective: typeof result.previewDirective === "string" ? result.previewDirective : null,
    };
  }

  async list(signal?: AbortSignal): Promise<{ id: string; backend: string; state: string; hostId: string }[]> {
    const result = await this.command(["list"], signal);
    const sessions = Array.isArray(result) ? result : (result.sessions as unknown[]) ?? [];
    return (sessions as Record<string, unknown>[]).map((s) => ({
      id: String(s.id),
      backend: String(s.backend),
      state: String(s.state),
      hostId: String(s.hostId),
    }));
  }

  async screenshot(sessionId: string, page: string, signal?: AbortSignal): Promise<{ path: string; hostId: string } | null> {
    const result = await this.command(["screenshot", sessionId, "--page", page], signal);
    const images = result.images as { path?: string }[] | undefined;
    const path = images?.[0]?.path;
    return typeof path === "string" ? { path, hostId: String(result.hostId ?? "") } : null;
  }

  async close(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.command(["close", sessionId], signal);
  }

  async runScript(sessionId: string, script: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const result = await this.command(["run", sessionId, "--script", script, "--timeout-ms", String(timeoutMs)], signal);
    let value: unknown = result.text;
    for (let i = 0; i < 2 && typeof value === "string"; i++) {
      try {
        value = JSON.parse(value);
      } catch {
        break;
      }
    }
    return value;
  }
}

export class DevBrowserDriver implements BrowserDriver {
  constructor(
    private readonly automation: BrowserAutomation,
    readonly sessionId: string,
    readonly pageName = "main",
    private readonly timeoutMs = 30_000,
  ) {}

  private run(script: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    return this.automation.runScript(this.sessionId, script, timeoutMs);
  }

  async open(url: string, viewport: Viewport | null = null): Promise<Page> {
    const result = (await this.run(openScript(this.pageName, url, viewport), 45_000)) as { observation?: unknown };
    const page = toPage(result?.observation);
    if (page === null) throw new StalePage("Page did not settle after navigation");
    return page;
  }

  async observe(): Promise<Page> {
    const result = (await this.run(observeScript(this.pageName))) as { observation?: unknown };
    const page = toPage(result?.observation);
    if (page === null) throw new StalePage("Page did not settle");
    return page;
  }

  async fresh(page: Page): Promise<boolean> {
    const result = (await this.run(freshScript(this.pageName, page))) as { fresh?: unknown };
    return result?.fresh === true;
  }

  async step(action: Action, page: Page, text: string | null): Promise<StepResult> {
    const script = stepScript(this.pageName, action, page, text);
    let result: { stale?: boolean; reason?: string; executed?: boolean; uncertain?: string; observation?: unknown; observeError?: string | null };
    try {
      result = (await this.run(script)) as typeof result;
    } catch (error) {
      // The script may have executed input before the transport failed. Never retry.
      if (action.kind === "wait") throw new StalePage("Wait interrupted");
      const message = error instanceof Error ? error.message : String(error);
      throw new UncertainMutation(`Browser step outcome unknown (${message}); inspect before retrying.`);
    }
    if (result?.uncertain) throw new UncertainMutation(result.uncertain);
    if (result?.stale) return { kind: "stale", observation: toPage(result.observation), reason: result.reason };
    if (result?.executed) {
      return { kind: "executed", observation: toPage(result.observation), observeError: result.observeError ?? null };
    }
    throw new UncertainMutation("Browser step returned no result; inspect before retrying.");
  }
}
