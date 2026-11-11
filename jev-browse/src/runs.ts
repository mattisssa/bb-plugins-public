// Run lifecycle: open or reuse a browser-automation session, drive JevLoop,
// route sensitive actions to the user, and keep a bounded in-memory registry
// that the inspector panel, the CLI, and the agent tools share.
import { randomUUID } from "node:crypto";
import { BrowserAutomation, DevBrowserDriver, type Transport } from "./driver";
import { JevLoop, PAUSED, TERMINAL, type Decide, type GenerateText, type RunSnapshot, type RunStatus } from "./loop";

export interface RunConfig {
  confirmSensitive: boolean;
  sensitiveThreshold: number;
  maxActions: number;
}

export interface StartInput {
  threadId: string;
  goal: string;
  url?: string;
  sessionId?: string;
  values?: string[];
  backend?: "local" | "desktop";
  desktop?: string;
  maxActions?: number;
}

export interface ConfirmRequest {
  runId: string;
  threadId: string;
  goal: string;
  element: string;
  role: string | undefined;
  url: string;
  probability: number | null;
}

export interface RunManagerDeps {
  transport: Transport;
  /** Resolves the decide function per run; throws when credentials are missing. */
  decide: () => Promise<Decide>;
  generateText: () => Promise<GenerateText | undefined>;
  config: () => Promise<RunConfig>;
  resolveHost: (threadId: string) => Promise<string>;
  /** Ask the user; resolves true to approve, false to decline or cancel. */
  confirm: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>;
  publish: (threadId: string, runId: string) => void;
  log?: (message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** Optional persistence so the inspector keeps settled runs across plugin reloads. */
  store?: RunStore;
}

export interface RunStore {
  load(threadId: string): Promise<RunView[]>;
  save(threadId: string, views: RunView[]): Promise<void>;
}

const STORED_RUNS_PER_THREAD = 10;

export interface RunSummary {
  id: string;
  threadId: string;
  sessionId: string;
  hostId: string;
  backend: string;
  previewDirective: string | null;
  createdAt: number;
  updatedAt: number;
  status: RunStatus;
  goal: string;
  url: string;
  actions: number;
  elapsedMs: number;
}

export interface RunView extends RunSummary {
  snapshot: RunSnapshot;
}

interface RunRecord {
  id: string;
  threadId: string;
  sessionId: string;
  hostId: string;
  backend: string;
  previewDirective: string | null;
  createdAt: number;
  updatedAt: number;
  loop: JevLoop;
  driver: DevBrowserDriver;
  automation: BrowserAutomation;
  controller: AbortController | null;
}

const MAX_RUNS = 50;
const HEADLESS_VIEWPORT = { width: 1280, height: 800 };
const RUN_TTL_MS = 6 * 60 * 60 * 1000;

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly now: () => number;

  constructor(private readonly deps: RunManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Local headless sessions this plugin opened, per thread, reused while still alive. */
  private readonly threadSessions = new Map<string, { sessionId: string; hostId: string }>();

  private async reusableSession(
    automation: BrowserAutomation,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; hostId: string } | null> {
    const known = this.threadSessions.get(threadId);
    if (known === undefined) return null;
    const busy = [...this.runs.values()].some((run) => run.sessionId === known.sessionId && run.controller !== null);
    if (busy) return null;
    const sessions = await automation.list(signal).catch(() => []);
    if (sessions.some((session) => session.id === known.sessionId && session.state === "ready")) return known;
    this.threadSessions.delete(threadId);
    return null;
  }

  private prune(): void {
    const cutoff = this.now() - RUN_TTL_MS;
    for (const [id, run] of this.runs) {
      if (run.controller === null && run.updatedAt < cutoff) this.runs.delete(id);
    }
    const idle = [...this.runs.values()].filter((run) => run.controller === null);
    idle.sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.runs.size > MAX_RUNS && idle.length > 0) this.runs.delete(idle.shift()!.id);
  }

  private touch(run: RunRecord): void {
    run.updatedAt = this.now();
    this.deps.publish(run.threadId, run.id);
  }

  private summary(run: RunRecord): RunSummary {
    return {
      id: run.id,
      threadId: run.threadId,
      sessionId: run.sessionId,
      hostId: run.hostId,
      backend: run.backend,
      previewDirective: run.previewDirective,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      status: run.loop.status,
      goal: run.loop.goal,
      url: run.loop.page.url,
      actions: run.loop.history.length,
      elapsedMs: run.loop.snapshot().elapsedMs,
    };
  }

  list(threadId: string): RunSummary[] {
    return [...this.runs.values()]
      .filter((run) => run.threadId === threadId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((run) => this.summary(run));
  }

  /** Live runs plus settled runs persisted before a reload. */
  async listAll(threadId: string): Promise<RunSummary[]> {
    const live = this.list(threadId);
    const ids = new Set(live.map((run) => run.id));
    const stored = (await this.deps.store?.load(threadId).catch(() => [])) ?? [];
    const older = stored.filter((view) => !ids.has(view.id)).map(({ snapshot: _snapshot, ...summary }) => summary);
    return [...live, ...older].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(runId: string, threadId?: string): RunView {
    const run = this.require(runId, threadId);
    return { ...this.summary(run), snapshot: run.loop.snapshot() };
  }

  async getAny(runId: string, threadId: string): Promise<RunView> {
    if (this.runs.get(runId)?.threadId === threadId) return this.get(runId, threadId);
    const stored = (await this.deps.store?.load(threadId).catch(() => [])) ?? [];
    const view = stored.find((candidate) => candidate.id === runId);
    if (view === undefined) throw new Error(`No Jev run ${runId} in this thread.`);
    return view;
  }

  private async persist(run: RunRecord): Promise<void> {
    const store = this.deps.store;
    if (store === undefined) return;
    const view = this.get(run.id);
    const compact: RunView = {
      ...view,
      snapshot: { ...view.snapshot, elements: view.snapshot.elements.slice(0, 80), decisions: view.snapshot.decisions.slice(-20) },
    };
    const stored = await store.load(run.threadId).catch(() => []);
    const next = [compact, ...stored.filter((candidate) => candidate.id !== run.id)].slice(0, STORED_RUNS_PER_THREAD);
    await store.save(run.threadId, next);
  }

  private require(runId: string, threadId?: string): RunRecord {
    const run = this.runs.get(runId);
    if (run === undefined || (threadId !== undefined && run.threadId !== threadId)) {
      throw new Error(`No Jev run ${runId} in this thread.`);
    }
    return run;
  }

  async start(input: StartInput, signal?: AbortSignal): Promise<RunView> {
    this.prune();
    const config = await this.deps.config();
    const decide = await this.deps.decide();
    const generateText = await this.deps.generateText();
    const automation = new BrowserAutomation(this.deps.transport, input.threadId);
    const t0 = this.now();
    let sessionId = input.sessionId;
    let hostId = "";
    let backend = input.backend ?? "local";
    let previewDirective: string | null = null;
    if (sessionId === undefined) {
      const reused = backend === "local" ? await this.reusableSession(automation, input.threadId, signal) : null;
      if (reused !== null) {
        ({ sessionId, hostId } = reused);
      } else {
        hostId = await this.deps.resolveHost(input.threadId);
        const session = await automation.open({ hostId, backend, desktop: input.desktop }, signal);
        sessionId = session.id;
        hostId = session.hostId;
        backend = session.backend as typeof backend;
        previewDirective = session.previewDirective;
        if (backend === "local") this.threadSessions.set(input.threadId, { sessionId, hostId });
      }
    }
    const t1 = this.now();
    const driver = new DevBrowserDriver(automation, sessionId);
    // Headless sessions get a desktop-sized viewport so wide widgets (calendars, tables) are fully observable.
    // Desktop tabs keep the user's window as it is.
    const viewport = backend === "local" ? HEADLESS_VIEWPORT : null;
    const page = input.url ? await driver.open(input.url, viewport) : await driver.observe();
    this.deps.log?.("run prepared", { sessionMs: t1 - t0, navigateMs: this.now() - t1, reused: previewDirective === null });
    const loop = new JevLoop({ driver, decide, generateText }, page, {
      goal: input.goal,
      values: input.values,
      maxActions: Math.min(input.maxActions ?? config.maxActions, config.maxActions),
      confirmSensitive: config.confirmSensitive,
      sensitiveThreshold: config.sensitiveThreshold,
    });
    const run: RunRecord = {
      id: randomUUID().slice(0, 8),
      threadId: input.threadId,
      sessionId,
      hostId,
      backend,
      previewDirective,
      createdAt: this.now(),
      updatedAt: this.now(),
      loop,
      driver,
      automation,
      controller: null,
    };
    this.runs.set(run.id, run);
    this.touch(run);
    return this.drive(run, signal);
  }

  /** Continue a paused run: text for needs_text; the user approves needs_confirmation in the UI. */
  async resume(runId: string, threadId: string, input: { text?: string }, signal?: AbortSignal): Promise<RunView> {
    const run = this.require(runId, threadId);
    if (run.controller !== null) throw new Error(`Run ${runId} is already running.`);
    if (run.loop.status === "needs_text") {
      if (input.text === undefined) throw new Error("This run is waiting for text: pass `text`.");
      run.loop.provideText(input.text);
    } else if (run.loop.status !== "needs_confirmation") {
      throw new Error(`Run ${runId} has status ${run.loop.status}; start a new run instead.`);
    }
    return this.drive(run, signal);
  }

  stop(runId: string, threadId?: string): RunView {
    const run = this.require(runId, threadId);
    run.controller?.abort(new Error("Stopped by user"));
    run.loop.cancel("Stopped by user");
    this.touch(run);
    return this.get(runId);
  }

  private async drive(run: RunRecord, signal?: AbortSignal): Promise<RunView> {
    const controller = new AbortController();
    run.controller = controller;
    const forward = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forward, { once: true });
    try {
      for (;;) {
        if (run.loop.status === "needs_confirmation" && run.loop.pending?.kind === "confirm") {
          const pending = run.loop.pending;
          this.touch(run);
          const approved = await this.deps
            .confirm(
              {
                runId: run.id,
                threadId: run.threadId,
                goal: run.loop.goal,
                element: pending.element,
                role: pending.role,
                url: pending.url,
                probability: pending.probability,
              },
              controller.signal,
            )
            .catch(() => false);
          if (run.loop.status !== "needs_confirmation") break;
          run.loop.confirm(approved);
          this.deps.log?.("sensitive action", { runId: run.id, element: pending.element, approved });
          if (!approved) break;
        }
        if (TERMINAL.has(run.loop.status) || run.loop.status === "needs_text") break;
        await run.loop.run(controller.signal, () => this.touch(run));
        if (run.loop.status !== "needs_confirmation") break;
      }
    } finally {
      signal?.removeEventListener("abort", forward);
      run.controller = null;
      this.touch(run);
      await this.persist(run).catch((error) => this.deps.log?.("persist failed", { error: String(error) }));
    }
    this.deps.log?.("run settled", {
      runId: run.id,
      status: run.loop.status,
      actions: run.loop.history.length,
      decisions: run.loop.decisions.length,
    });
    return this.get(run.id);
  }

  /** Visible text of the run's latest observation (already capped at 6000 chars by snapshot.js). */
  pageText(runId: string): string {
    return this.runs.get(runId)?.loop.page.text ?? "";
  }

  /** Abort every active run; used on plugin reload or disable. */
  disposeAll(): void {
    for (const run of this.runs.values()) {
      run.controller?.abort(new Error("Plugin disposed"));
      run.loop.cancel("Plugin reloaded");
    }
  }

  async screenshot(runId: string): Promise<{ path: string; hostId: string } | null> {
    const run = this.require(runId);
    return run.automation.screenshot(run.sessionId, run.driver.pageName).catch(() => null);
  }
}

export function isPaused(status: RunStatus): boolean {
  return PAUSED.has(status);
}
