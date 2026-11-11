// Pure token-load model shared by server.ts and app.tsx (no runtime deps).

export type Level = 0 | 1 | 2;

export interface Thresholds {
  contextWarn: number;
  contextHeavy: number;
  burnWarn: number;
  burnHeavy: number;
}

/** Per-call usage counters as bb records them in `thread/tokenUsage/updated`. */
export interface UsageCounters {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ThreadLoad {
  threadId: string;
  contextUsed: number | null;
  contextWindow: number | null;
  /** Weighted usage in the last 5 hours (input-token equivalents). */
  burn5h: number;
  burn24h: number;
  raw5h: UsageCounters;
  contextLevel: Level;
  burnLevel: Level;
  level: Level;
  updatedAt: number;
}

export const FIVE_HOURS = 5 * 3600_000;
export const DAY = 24 * 3600_000;

/**
 * API price ratios relative to uncached input: cache write 1.25x, cache read
 * 0.1x, output 5x. Subscription limits are metered close to cost, so this
 * tracks limit drain far better than the raw token total, which cache reads
 * dominate.
 */
export function weigh(c: UsageCounters): number {
  return (
    c.inputTokens +
    1.25 * c.cacheWriteInputTokens +
    0.1 * c.cacheReadInputTokens +
    5 * c.outputTokens
  );
}

export function zeroCounters(): UsageCounters {
  return {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

/** Normalizes a raw `tokenUsage.total` object; Codex reports only `cachedInputTokens`. */
export function countersFrom(raw: Record<string, unknown> | null | undefined): UsageCounters | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const n = (key: string) => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const cached = n("cachedInputTokens");
  const write = n("cacheWriteInputTokens");
  const read = n("cacheReadInputTokens") || Math.max(0, cached - write);
  return {
    inputTokens: n("inputTokens"),
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write,
    outputTokens: n("outputTokens"),
    totalTokens: n("totalTokens"),
  };
}

/**
 * Usage added since the previous cumulative reading of the same provider
 * session. A smaller total means the provider session restarted, so the new
 * reading counts in full.
 */
export function delta(previous: UsageCounters | undefined, current: UsageCounters): UsageCounters {
  if (previous === undefined || current.totalTokens < previous.totalTokens) return current;
  const d = zeroCounters();
  for (const key of Object.keys(d) as (keyof UsageCounters)[]) {
    d[key] = Math.max(0, current[key] - previous[key]);
  }
  return d;
}

export function addCounters(a: UsageCounters, b: UsageCounters): UsageCounters {
  const sum = zeroCounters();
  for (const key of Object.keys(sum) as (keyof UsageCounters)[]) sum[key] = a[key] + b[key];
  return sum;
}

export function levelOf(value: number | null, warn: number, heavy: number): Level {
  if (value === null) return 0;
  if (value >= heavy) return 2;
  if (value >= warn) return 1;
  return 0;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

export function describe(load: ThreadLoad): string {
  const parts: string[] = [];
  if (load.contextUsed !== null) parts.push(`контекст ${formatTokens(load.contextUsed)}`);
  parts.push(`за 5 ч ${formatTokens(load.burn5h)}`);
  return parts.join(", ");
}
