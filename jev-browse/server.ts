// Jev Browse: fast goal-driven browsing inside bb.
//
// The driving agent calls `browse` with a URL, a goal, and any literal values
// the task needs. TypeSafe's Jev picks one operation + target per request; the
// plugin executes it in a `bb browser-automation` session, so the user can
// watch the live preview and the agent can take over in the same session.
import { cliCommand, defineCli, defineRpcContract, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { cliTransport, httpTransport, resilientTransport } from "./src/driver";
import type { GenerateText, RunSnapshot } from "./src/loop";
import { RunManager, type RunView } from "./src/runs";
import { fieldText } from "./src/text-helper";
import { choose } from "./src/typesafe";

const PLUGIN_ID = "jev-browse";
const RUNS_CHANGED = "runs-changed";
const CONFIRM_RENDERER = "confirm-action";

const runStatus = z.enum([
  "ready",
  "running",
  "done",
  "blocked",
  "needs_text",
  "needs_confirmation",
  "budget",
  "error",
  "cancelled",
]);

const runSummarySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sessionId: z.string(),
  hostId: z.string(),
  backend: z.string(),
  previewDirective: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: runStatus,
  goal: z.string(),
  url: z.string(),
  actions: z.number(),
  elapsedMs: z.number(),
});

export type RunSummaryDto = z.infer<typeof runSummarySchema>;

// The snapshot is plain JSON produced by our own loop; validate the envelope only.
const runViewSchema = runSummarySchema.extend({ snapshot: z.record(z.string(), z.unknown()) });

export const rpcContract = defineRpcContract({
  runs_list: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ runs: z.array(runSummarySchema) }),
  },
  run_get: {
    input: z.object({ threadId: z.string().min(1), runId: z.string().min(1) }).strict(),
    output: runViewSchema,
  },
  run_stop: {
    input: z.object({ threadId: z.string().min(1), runId: z.string().min(1) }).strict(),
    output: runViewSchema,
  },
});

export type RunSnapshotDto = RunSnapshot;

const browseParameters = z.object({
  goal: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("The complete natural-language goal, including every requirement and the stopping condition."),
  url: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//iu.test(value), "Only http(s) URLs")
    .optional()
    .describe("Page to open first. Omit to continue from the session's current page."),
  values: z
    .array(z.string().trim().min(1).max(2000))
    .max(24)
    .optional()
    .describe(
      "Exact strings the task may type (search terms, cities, dates, names). Jev picks which value goes into which field. Never include passwords or payment data.",
    ),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Existing `bb browser-automation` session of this thread. Omit to open a new local headless session."),
  backend: z
    .enum(["local", "desktop"])
    .optional()
    .describe("New session type. desktop uses the bb browser's signed-in profile and needs `desktopInstance`."),
  desktopInstance: z.string().min(1).optional().describe("Desktop instance id from `bb browser instances --json`."),
  maxActions: z.number().int().min(1).max(60).optional().describe("Action budget, at most the plugin setting."),
  screenshot: z
    .boolean()
    .optional()
    .describe("Attach a final screenshot (default true, adds about 2 s). Set false when the text is enough."),
});

const continueParameters = z.object({
  runId: z.string().min(1),
  text: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe("The value for the field a needs_text run is waiting on."),
});

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function formatRun(view: RunView, pageText: string): string {
  const snapshot = view.snapshot;
  const lines = [
    `Jev run ${view.id}: ${snapshot.status} after ${seconds(snapshot.elapsedMs)}, ${snapshot.history.length} actions, ${snapshot.decisions.length} Jev decisions.`,
    `Session: ${view.sessionId} (${view.backend}${view.hostId ? `, host ${view.hostId}` : ""})`,
    `Page: ${truncate(snapshot.title, 120)} — ${snapshot.url}`,
  ];
  if (snapshot.reason) lines.push(`Reason: ${snapshot.reason}`);
  if (snapshot.stale?.total > 0) {
    lines.push(
      `${snapshot.stale.total} decisions were discarded because the page changed before execution${
        snapshot.stale.lastReason ? ` (last: ${snapshot.stale.lastReason})` : ""
      }.`,
    );
  }
  const pending = snapshot.pending;
  if (snapshot.status === "needs_text" && pending?.kind === "text") {
    lines.push(
      `Waiting for text: field "${truncate(pending.field, 120)}" (${pending.role ?? "field"}, current value "${truncate(pending.currentValue, 80)}").`,
      `Call browse_continue with {"runId": "${view.id}", "text": "<value>"}. Ask the user if the value is not in the conversation; never invent personal data.`,
    );
  }
  if (snapshot.history.length > 0) {
    lines.push("Actions:");
    for (const entry of snapshot.history.slice(-25)) {
      const text = entry.text === null ? "" : ` ← "${truncate(entry.text, 80)}"`;
      const probability = entry.probability === null ? "" : ` p=${entry.probability.toFixed(2)}`;
      const changed = entry.pageChanged === false ? " (no page change)" : "";
      lines.push(`  ${entry.step}. ${entry.operation} "${truncate(entry.action, 80)}"${text}${probability}${changed}`);
    }
  }
  if (pageText) lines.push("Visible text (truncated):", truncate(pageText, 1500));
  lines.push(
    snapshot.status === "done"
      ? "DONE is Jev's claim, not proof: check the visible text or screenshot against every requirement before reporting success."
      : "Jev stopped before the goal. You can continue manually in the same session with `bb browser-automation run`.",
    `The session stays open for checks. Close it with \`bb browser-automation close ${view.sessionId}\` when finished.`,
  );
  if (view.previewDirective) {
    lines.push(`Live view directive for the user (post once as its own line): ${view.previewDirective}`);
  }
  return lines.join("\n");
}

/** RPC results must be strict JSON: drop undefined fields, turn non-finite numbers into null. */
function toJson(view: RunView): z.infer<typeof runViewSchema> {
  return JSON.parse(JSON.stringify(view)) as z.infer<typeof runViewSchema>;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    typesafeApiKey: { type: "string", label: "TypeSafe API key", secret: true },
    typesafeModel: { type: "string", label: "TypeSafe model", default: "jev-latest" },
    textModelApiKey: {
      type: "string",
      label: "Text model API key (optional)",
      secret: true,
    },
    textModelBaseUrl: {
      type: "string",
      label: "Text model base URL (OpenAI-compatible)",
      default: "https://openrouter.ai/api/v1",
    },
    textModel: { type: "string", label: "Text model", default: "inception/mercury-2.5" },
    textModelReasoning: {
      type: "select",
      label: "Text model reasoning",
      options: ["none", "low"],
      default: "none",
    },
    confirmSensitive: {
      type: "boolean",
      label: "Ask before irreversible clicks (purchase, send, delete, publish)",
      default: true,
    },
    sensitiveThreshold: {
      type: "number",
      label: "Sensitive-action probability threshold",
      experimental_schema: z.number().min(0.05).max(0.95),
      default: 0.35,
    },
    maxActions: {
      type: "number",
      label: "Action budget per run",
      experimental_schema: z.number().int().min(1).max(60),
      default: 60,
    },
  });

  const manager = new RunManager({
    transport: resilientTransport(
      httpTransport(() => bb.server.loopbackBaseUrl),
      cliTransport(),
    ),
    async decide() {
      const values = await settings.get();
      const apiKey = values.typesafeApiKey?.toString().trim() || process.env.TYPESAFE_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Jev Browse needs a TypeSafe API key: `bb plugin config jev-browse set typesafeApiKey <key>` or Settings → Installed plugins.",
        );
      }
      const model = values.typesafeModel || "jev-latest";
      const confirmSensitive = values.confirmSensitive;
      return (page, goal, history, provided, signal) =>
        choose(page, goal, history, { apiKey, model, values: provided, sensitive: confirmSensitive, signal });
    },
    async generateText() {
      const values = await settings.get();
      const apiKey = values.textModelApiKey?.toString().trim();
      if (!apiKey) return undefined;
      const config = {
        apiKey,
        baseUrl: values.textModelBaseUrl,
        model: values.textModel,
        reasoning: values.textModelReasoning === "low" ? ("low" as const) : ("none" as const),
      };
      const generate: GenerateText = (context, signal) => fieldText(context, config, { signal });
      return generate;
    },
    async config() {
      const values = await settings.get();
      return {
        confirmSensitive: values.confirmSensitive,
        sensitiveThreshold: values.sensitiveThreshold,
        maxActions: values.maxActions,
      };
    },
    async resolveHost(threadId) {
      const thread = (await bb.sdk.threads.get({ threadId })) as { environmentId?: string | null };
      if (thread.environmentId) {
        const environment = (await bb.sdk.environments.get({ environmentId: thread.environmentId })) as {
          hostId?: string;
        };
        if (environment.hostId) return environment.hostId;
      }
      throw new Error("Could not resolve this thread's host. Open a session yourself and pass `sessionId`.");
    },
    async confirm(request, signal) {
      const result = await bb.ui.requestInput(
        {
          threadId: request.threadId,
          rendererId: CONFIRM_RENDERER,
          title: "Confirm browser action",
          payload: {
            runId: request.runId,
            goal: truncate(request.goal, 600),
            element: truncate(request.element, 300),
            role: request.role ?? null,
            url: request.url,
            probability: request.probability,
          },
          presentation: {
            label: { pending: "Waiting for approval of a browser action", completed: "Browser action answered" },
          },
          describeSubmission: (value) => ({
            title: (value as { approve?: unknown })?.approve === true ? "Approved browser action" : "Declined browser action",
            detail: `\`${truncate(request.element, 200)}\` on ${request.url}`,
          }),
        },
        { signal },
      );
      return result.outcome === "submitted" && (result.value as { approve?: unknown })?.approve === true;
    },
    publish(threadId, runId) {
      bb.realtime.publish(RUNS_CHANGED, { threadId, runId });
    },
    store: {
      async load(threadId) {
        const value = await bb.storage.kv.get<RunView[]>(`runs:${threadId}`);
        return Array.isArray(value) ? value : [];
      },
      async save(threadId, views) {
        await bb.storage.kv.set(`runs:${threadId}`, JSON.parse(JSON.stringify(views)));
      },
    },
    log(message, data) {
      bb.log.info(data ? `${message} ${JSON.stringify(data)}` : message);
    },
  });

  async function toolResult(view: RunView, withScreenshot = true): Promise<{ content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean }> {
    const pageText = manager.pageText(view.id);
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text: formatRun(view, pageText) },
    ];
    const shot = withScreenshot ? await manager.screenshot(view.id) : null;
    if (shot !== null) {
      try {
        const file = (await bb.sdk.files.read({ hostId: shot.hostId || undefined, path: shot.path })) as {
          content?: string;
          contentEncoding?: string;
        };
        if (file.contentEncoding === "base64" && typeof file.content === "string" && file.content.length < 1_500_000) {
          content.push({ type: "image", data: file.content, mimeType: "image/jpeg" });
        }
      } catch (error) {
        bb.log.warn(`screenshot read failed: ${String(error)}`);
      }
    }
    return { content, isError: view.status === "error" };
  }

  bb.agents.registerTool({
    name: "browse",
    description:
      "Drive a real browser toward a natural-language goal with TypeSafe Jev (one fast decision per step, ~0.2 s). Opens a local headless bb browser session unless sessionId is given, runs until DONE, BLOCKED, a budget, or a pause, and returns the action trace, visible page text, and a final screenshot.",
    instructions: [
      "When the user gives a link and wants something found, filled, or navigated on the web, prefer the `browse` tool over hand-written browser scripts.",
      "Put every literal the task needs (search terms, cities, dates, names) in `values`; Jev chooses which value goes into which field. Never pass passwords or payment data.",
      "Before reporting success, verify the outcome yourself from the returned text/screenshot; DONE is Jev's claim, not proof.",
      "If the result includes a live view directive, post it once as its own line. When Jev is blocked, continue in the same session with `bb browser-automation run`.",
      "A needs_text result waits for a field value: call `browse_continue` with it (ask the user when the conversation does not contain it). Sensitive clicks are approved by the user in the composer, never by you.",
    ].join("\n"),
    presentation: { label: { pending: "Browsing with Jev", completed: "Browsed with Jev" }, icon: { glyph: "Globe" } },
    parameters: browseParameters,
    async execute(params, ctx) {
      try {
        const view = await manager.start(
          {
            threadId: ctx.threadId,
            goal: params.goal,
            url: params.url,
            sessionId: params.sessionId,
            values: params.values,
            backend: params.backend,
            desktop: params.desktopInstance,
            maxActions: params.maxActions,
          },
          ctx.signal,
        );
        return await toolResult(view, params.screenshot !== false);
      } catch (error) {
        return { content: [{ type: "text", text: `Jev browse failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "browse_continue",
    description: "Continue a paused Jev run: supply the text a needs_text run is waiting for.",
    presentation: { label: { pending: "Continuing Jev run", completed: "Continued Jev run" }, icon: { glyph: "Globe" } },
    parameters: continueParameters,
    async execute(params, ctx) {
      try {
        const view = await manager.resume(params.runId, ctx.threadId, { text: params.text }, ctx.signal);
        return await toolResult(view);
      } catch (error) {
        return { content: [{ type: "text", text: `Jev continue failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });

  bb.rpc.register(rpcContract, {
    runs_list: async ({ threadId }) => ({ runs: await manager.listAll(threadId) }),
    run_get: async ({ threadId, runId }) => toJson(await manager.getAny(runId, threadId)),
    run_stop: ({ threadId, runId }) => toJson(manager.stop(runId, threadId)),
  });

  function requireThread(threadId: string | undefined): string {
    if (threadId) return threadId;
    throw new PluginCliError("Run this from a bb thread.", {
      code: "thread_required",
      hint: "Jev runs belong to the thread that starts them; run the command inside a thread.",
    });
  }

  function cliOutput(view: RunView, json: boolean) {
    return {
      exitCode: view.status === "error" ? 1 : 0,
      stdout: json
        ? JSON.stringify({ ...view, pageText: manager.pageText(view.id) })
        : formatRun(view, manager.pageText(view.id)),
    };
  }

  bb.cli.register(
    defineCli({
      name: "jev",
      summary: "Drive a browser toward a goal with TypeSafe Jev",
      commands: {
        run: cliCommand({
          summary: "Run a goal in a browser session (opens local headless unless --session)",
          options: {
            goal: { type: "string", required: true, description: "Natural-language goal with its stopping condition" },
            url: { type: "string", description: "http(s) page to open first" },
            session: { type: "string", description: "Existing browser-automation session id" },
            value: {
              type: "string",
              repeatable: true,
              aliases: ["values"],
              description: "Literal the task may type; repeat for several (max 24)",
            },
            "max-actions": { type: "integer", min: 1, max: 60, description: "Action budget (max 60)" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = requireThread(ctx.threadId);
            const parsed = browseParameters.safeParse({
              goal: input.options.goal,
              url: input.options.url,
              sessionId: input.options.session,
              values: input.options.value,
              maxActions: input.options["max-actions"],
            });
            if (!parsed.success) {
              throw new PluginCliError(parsed.error.issues.map((issue) => issue.message).join("; "), {
                code: "invalid_input",
              });
            }
            const view = await manager.start(
              {
                threadId,
                goal: parsed.data.goal,
                url: parsed.data.url,
                sessionId: parsed.data.sessionId,
                values: parsed.data.values,
                maxActions: parsed.data.maxActions,
              },
              ctx.signal,
            );
            return cliOutput(view, input.options.json === true);
          },
        }),
        continue: cliCommand({
          summary: "Continue a needs_text run with the missing value",
          positionals: [{ name: "run-id", description: "Run id", required: true }],
          options: {
            text: { type: "string", required: true, stdin: true, description: "Value for the waiting field" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = requireThread(ctx.threadId);
            const view = await manager.resume(input.positionals["run-id"], threadId, { text: input.options.text }, ctx.signal);
            return cliOutput(view, input.options.json === true);
          },
        }),
        status: cliCommand({
          summary: "List this thread's Jev runs, or show one",
          positionals: [{ name: "run-id", description: "Run id" }],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input, ctx) {
            const threadId = requireThread(ctx.threadId);
            const runId = input.positionals["run-id"];
            if (runId) return cliOutput(await manager.getAny(runId, threadId), input.options.json === true);
            const runs = await manager.listAll(threadId);
            return {
              exitCode: 0,
              stdout:
                input.options.json === true
                  ? JSON.stringify(runs)
                  : runs.length === 0
                    ? "No Jev runs in this thread."
                    : runs
                        .map((run) => `${run.id}  ${run.status.padEnd(18)} ${run.actions} actions  ${seconds(run.elapsedMs)}  ${truncate(run.goal, 60)}`)
                        .join("\n"),
            };
          },
        }),
        stop: cliCommand({
          summary: "Stop a running Jev run",
          positionals: [{ name: "run-id", description: "Run id", required: true }],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input, ctx) {
            const threadId = requireThread(ctx.threadId);
            return cliOutput(manager.stop(input.positionals["run-id"], threadId), input.options.json === true);
          },
        }),
      },
    }),
  );

  bb.onDispose(() => manager.disposeAll());
  bb.log.info(`${PLUGIN_ID} loaded`);
}
