// Thread Load — tracks how much context each thread carries and how many
// tokens it burns, from the `thread/tokenUsage/updated` and
// `thread/contextWindowUsage/updated` events bb already records. The
// frontend (app.tsx) turns this into a sidebar row glyph, a context-row
// segment above the composer, and Info-tab rows. Threads whose context
// crosses the heavy threshold are moved into a dedicated sidebar section.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DAY,
  FIVE_HOURS,
  addCounters,
  countersFrom,
  delta,
  describe,
  formatTokens,
  levelOf,
  weigh,
  zeroCounters,
  type Level,
  type ThreadLoad,
  type Thresholds,
  type UsageCounters,
} from "./model";

const countersSchema = z.object({
  inputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});
const levelSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const loadSchema = z.object({
  threadId: z.string(),
  contextUsed: z.number().nullable(),
  contextWindow: z.number().nullable(),
  burn5h: z.number(),
  burn24h: z.number(),
  raw5h: countersSchema,
  contextLevel: levelSchema,
  burnLevel: levelSchema,
  level: levelSchema,
  updatedAt: z.number(),
});
const thresholdsSchema = z.object({
  contextWarn: z.number(),
  contextHeavy: z.number(),
  burnWarn: z.number(),
  burnHeavy: z.number(),
});

export const rpcContract = defineRpcContract({
  loads_list: {
    input: z.null(),
    output: z.object({ loads: z.array(loadSchema), thresholds: thresholdsSchema }),
  },
});

export const LOADS_CHANGED = "loads-changed";

const TRACKED_TYPES = [
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
] as const;

/** One usage increment: [timestamp, input, cacheRead, cacheWrite, output, total]. */
type Sample = [number, number, number, number, number, number];

interface StoredThread {
  seq: number;
  contextUsed: number | null;
  contextWindow: number | null;
  /** Last cumulative reading per provider session. */
  sessions: Record<string, UsageCounters>;
  samples: Sample[];
  updatedAt: number;
}

const PAGE = 100;
const MAX_SESSIONS = 4;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    contextWarnK: {
      type: "number",
      label: "Context warning, thousand tokens",
      description: "Context size at which a thread is marked as loaded.",
      default: 150,
    },
    contextHeavyK: {
      type: "number",
      label: "Context heavy, thousand tokens",
      description: "Context size at which a thread is marked heavy and moved to the heavy section.",
      default: 300,
    },
    burnWarnM: {
      type: "number",
      label: "5-hour usage warning, million tokens",
      description:
        "Weighted usage over 5 hours (input 1x, cache write 1.25x, cache read 0.1x, output 5x) that marks a thread as loaded.",
      default: 1,
    },
    burnHeavyM: {
      type: "number",
      label: "5-hour usage heavy, million tokens",
      description: "Weighted usage over 5 hours that marks a thread as heavy.",
      default: 2.5,
    },
    autoSection: {
      type: "boolean",
      label: "Move heavy threads to a section",
      description:
        "Move top-level threads without a section into the heavy section while their context is above the heavy threshold, and move them back when it drops.",
      default: true,
    },
    sectionName: {
      type: "string",
      label: "Heavy section name",
      default: "Тяжёлые",
    },
  });
  const config = await settings.get();
  const thresholds: Thresholds = {
    contextWarn: config.contextWarnK * 1000,
    contextHeavy: config.contextHeavyK * 1000,
    burnWarn: config.burnWarnM * 1_000_000,
    burnHeavy: config.burnHeavyM * 1_000_000,
  };

  const stopped = new AbortController();
  bb.onDispose(() => stopped.abort());

  const states = new Map<string, StoredThread>();
  const loads = new Map<string, ThreadLoad>();
  const key = (threadId: string) => `t:${threadId}`;

  async function loadState(threadId: string): Promise<StoredThread> {
    const cached = states.get(threadId);
    if (cached !== undefined) return cached;
    const stored = await bb.storage.kv.get<StoredThread>(key(threadId));
    const state: StoredThread = stored ?? {
      seq: 0,
      contextUsed: null,
      contextWindow: null,
      sessions: {},
      samples: [],
      updatedAt: 0,
    };
    states.set(threadId, state);
    return state;
  }

  function computeLoad(threadId: string, state: StoredThread, now: number): ThreadLoad {
    let raw5h = zeroCounters();
    let burn24h = 0;
    for (const [at, input, read, write, output, total] of state.samples) {
      const counters: UsageCounters = {
        inputTokens: input,
        cacheReadInputTokens: read,
        cacheWriteInputTokens: write,
        outputTokens: output,
        totalTokens: total,
      };
      if (now - at < DAY) burn24h += weigh(counters);
      if (now - at < FIVE_HOURS) raw5h = addCounters(raw5h, counters);
    }
    const burn5h = weigh(raw5h);
    const contextLevel = levelOf(state.contextUsed, thresholds.contextWarn, thresholds.contextHeavy);
    const burnLevel = levelOf(burn5h, thresholds.burnWarn, thresholds.burnHeavy);
    return {
      threadId,
      contextUsed: state.contextUsed,
      contextWindow: state.contextWindow,
      burn5h,
      burn24h,
      raw5h,
      contextLevel,
      burnLevel,
      level: Math.max(contextLevel, burnLevel) as Level,
      updatedAt: state.updatedAt,
    };
  }

  // Realtime: one coalesced signal per second at most.
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePublish() {
    if (publishTimer !== null || stopped.signal.aborted) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      bb.realtime.publish(LOADS_CHANGED, { at: Date.now() });
    }, 1000);
  }
  bb.onDispose(() => {
    if (publishTimer !== null) clearTimeout(publishTimer);
  });

  /** Reads new tracked events for a thread and folds them into its state. */
  async function scan(threadId: string, latestSequence: number | null): Promise<void> {
    const state = await loadState(threadId);
    if (latestSequence !== null && latestSequence <= state.seq) {
      refreshLoad(threadId, state);
      return;
    }
    const now = Date.now();
    let changed = false;
    let after = state.seq;
    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(after),
        limit: String(PAGE),
        order: "asc",
        types: [...TRACKED_TYPES],
        signal: stopped.signal,
      });
      for (const row of page) {
        after = Math.max(after, row.seq);
        const data = row.data as Record<string, unknown>;
        if (row.type === "thread/contextWindowUsage/updated") {
          const usage = data.contextWindowUsage as
            | { usedTokens?: number; modelContextWindow?: number }
            | undefined;
          if (typeof usage?.usedTokens === "number") {
            state.contextUsed = usage.usedTokens;
            state.contextWindow =
              typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : state.contextWindow;
            changed = true;
          }
        } else if (row.type === "thread/tokenUsage/updated") {
          const tokenUsage = data.tokenUsage as { total?: Record<string, unknown> } | undefined;
          const total = countersFrom(tokenUsage?.total);
          if (total === null) continue;
          const session = typeof data.providerThreadId === "string" ? data.providerThreadId : "default";
          const added = delta(state.sessions[session], total);
          delete state.sessions[session];
          state.sessions[session] = total;
          const sessionIds = Object.keys(state.sessions);
          for (const stale of sessionIds.slice(0, Math.max(0, sessionIds.length - MAX_SESSIONS))) {
            delete state.sessions[stale];
          }
          if (now - row.createdAt < DAY && added.totalTokens > 0) {
            state.samples.push([
              row.createdAt,
              added.inputTokens,
              added.cacheReadInputTokens,
              added.cacheWriteInputTokens,
              added.outputTokens,
              added.totalTokens,
            ]);
          }
          changed = true;
        }
      }
      if (page.length < PAGE) break;
    }
    if (latestSequence !== null) after = Math.max(after, latestSequence);
    if (after !== state.seq) {
      state.seq = after;
      changed = true;
    }
    if (changed) {
      state.samples = state.samples.filter(([at]) => now - at < DAY);
      state.updatedAt = now;
      await bb.storage.kv.set(key(threadId), state);
    }
    refreshLoad(threadId, state);
  }

  /** Recomputes a thread's load from its state; publishes only on a visible change. */
  function refreshLoad(threadId: string, state: StoredThread) {
    if (state.contextUsed === null && state.samples.length === 0) return;
    const next = computeLoad(threadId, state, Date.now());
    const previous = loads.get(threadId);
    loads.set(threadId, next);
    if (
      previous === undefined ||
      previous.level !== next.level ||
      previous.contextUsed !== next.contextUsed ||
      Math.abs(previous.burn5h - next.burn5h) >= 1000
    ) {
      schedulePublish();
    }
  }

  // Serial work queue so bursts of events never run concurrent scans of one thread.
  const pending = new Map<string, number | null>();
  let draining = false;
  function enqueue(threadId: string, sequence: number | null) {
    const previous = pending.get(threadId);
    pending.set(
      threadId,
      previous === undefined || previous === null || sequence === null ? sequence : Math.max(previous, sequence),
    );
    void drain();
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.size > 0 && !stopped.signal.aborted) {
        const [threadId, sequence] = pending.entries().next().value as [string, number | null];
        pending.delete(threadId);
        try {
          await scan(threadId, sequence);
          await reconcileSection(threadId);
        } catch (error) {
          if (stopped.signal.aborted) return;
          bb.log.warn(`scan ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      draining = false;
    }
  }

  // --- Heavy section -------------------------------------------------------
  let sectionId: string | null = null;
  async function heavySectionId(): Promise<string> {
    if (sectionId !== null) return sectionId;
    const sections = await bb.sdk.threadSections.list({ signal: stopped.signal });
    const existing = sections.find((section) => section.name === config.sectionName);
    sectionId = existing?.id ?? (await bb.sdk.threadSections.create({ name: config.sectionName })).id;
    return sectionId;
  }
  const moved = new Set<string>((await bb.storage.kv.get<string[]>("moved")) ?? []);
  async function saveMoved() {
    await bb.storage.kv.set("moved", [...moved]);
  }

  async function reconcileSection(threadId: string): Promise<void> {
    if (!config.autoSection) return;
    const load = loads.get(threadId);
    if (load === undefined) return;
    const heavy = load.contextLevel === 2;
    if (!heavy && !moved.has(threadId)) return;
    const thread = await bb.sdk.threads.get({ threadId, signal: stopped.signal });
    const target = await heavySectionId();
    if (heavy) {
      if (moved.has(threadId) || thread.sectionId !== null) return;
      if (thread.parentThreadId !== null || thread.archivedAt !== null) return;
      await bb.sdk.threads.update({ threadId, sectionId: target });
      moved.add(threadId);
      await saveMoved();
      bb.log.info(`moved ${threadId} to "${config.sectionName}" (${describe(load)})`);
      return;
    }
    // Context dropped below heavy: return the thread unless the user moved it elsewhere.
    if (thread.sectionId === target) await bb.sdk.threads.update({ threadId, sectionId: null });
    moved.delete(threadId);
    await saveMoved();
  }

  // --- Lifecycle -----------------------------------------------------------
  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    enqueue(thread.id, sequence);
  });
  const forget = async (threadId: string) => {
    states.delete(threadId);
    if (loads.delete(threadId)) schedulePublish();
    await bb.storage.kv.delete(key(threadId));
    if (moved.delete(threadId)) await saveMoved();
  };
  bb.events.on("thread.deleted", ({ thread }) => void forget(thread.id));
  bb.events.on("thread.archived", ({ thread }) => {
    if (loads.delete(thread.id)) schedulePublish();
  });

  async function rescanRecent(): Promise<number> {
    const now = Date.now();
    const threads = await bb.sdk.threads.list({ includeHidden: true, signal: stopped.signal });
    let count = 0;
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const stored = await loadState(thread.id);
      if (now - thread.updatedAt < DAY || stored.updatedAt > 0) {
        enqueue(thread.id, null);
        count += 1;
      }
    }
    return count;
  }

  // Background: initial backfill, then roll the 5h/24h windows every 5 minutes.
  bb.background.service("windows", {
    async start(signal) {
      await rescanRecent().catch((error) => bb.log.warn(`backfill failed: ${String(error)}`));
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5 * 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        if (signal.aborted) return;
        const now = Date.now();
        let changed = false;
        for (const [threadId, state] of states) {
          const before = loads.get(threadId);
          if (before === undefined) continue;
          const after = computeLoad(threadId, state, now);
          if (after.level !== before.level || Math.abs(after.burn5h - before.burn5h) > 1) changed = true;
          loads.set(threadId, after);
        }
        if (changed) schedulePublish();
      }
    },
  });

  bb.rpc.register(rpcContract, {
    loads_list: async () => ({ loads: [...loads.values()], thresholds }),
  });

  // --- CLI -----------------------------------------------------------------
  const usage = [
    "Usage:",
    "  bb thread-load top [--limit <n>] [--json]   Heaviest threads by level, 5-hour usage, then context",
    "  bb thread-load show <thread-id> [--json]    One thread's context and usage",
    "  bb thread-load rescan [--json]              Re-read token events of recently active threads",
  ].join("\n");
  const line = (load: ThreadLoad) =>
    [
      ["  ", "! ", "!!"][load.level],
      load.threadId,
      `context ${load.contextUsed === null ? "?" : formatTokens(load.contextUsed)}${
        load.contextWindow === null ? "" : `/${formatTokens(load.contextWindow)}`
      }`,
      `5h ${formatTokens(load.burn5h)}`,
      `24h ${formatTokens(load.burn24h)}`,
    ].join("  ");
  bb.cli.register({
    name: "thread-load",
    summary: "Show which threads carry the most context and burn the most tokens",
    commands: [
      { name: "top", summary: "List the heaviest threads", usage: "bb thread-load top [--limit <n>] [--json]" },
      { name: "show", summary: "Show one thread's load", usage: "bb thread-load show <thread-id> [--json]" },
      { name: "rescan", summary: "Re-read recent threads' token events", usage: "bb thread-load rescan [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "top": {
          const limitIndex = rest.indexOf("--limit");
          const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : 15;
          if (!Number.isInteger(limit) || limit < 1) return { exitCode: 1, stderr: usage };
          const sorted = [...loads.values()]
            .sort((a, b) => b.level - a.level || b.burn5h - a.burn5h || (b.contextUsed ?? 0) - (a.contextUsed ?? 0))
            .slice(0, limit);
          return reply(
            { loads: sorted, thresholds },
            sorted.length === 0 ? "No token usage recorded yet." : sorted.map(line).join("\n"),
          );
        }
        case "show": {
          const threadId = rest[0];
          if (threadId === undefined || rest.length !== 1) return { exitCode: 1, stderr: usage };
          await scan(threadId, null);
          const load = loads.get(threadId);
          if (load === undefined) return { exitCode: 1, stderr: `No token usage recorded for ${threadId}.` };
          return reply(load, line(load));
        }
        case "rescan": {
          const count = await rescanRecent();
          return reply({ queued: count }, `Queued ${count} threads.`);
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.log.info(
    `loaded: context ${formatTokens(thresholds.contextWarn)}/${formatTokens(thresholds.contextHeavy)}, 5h ${formatTokens(
      thresholds.burnWarn,
    )}/${formatTokens(thresholds.burnHeavy)}, autoSection=${config.autoSection}`,
  );
}
