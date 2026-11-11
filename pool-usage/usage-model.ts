import type { UsageAccount, UsageSnapshot, UsageWindow } from "./server";

export const DEFAULT_RED_THRESHOLD = 80;

/** How many five-hour windows a weekly allowance holds. */
const WEEK_IN_FIVE_HOUR_WINDOWS = 5.5;

const RESET_HORIZON_MS = 7 * 24 * 60 * 60_000;

/** Changes smaller than this round away on screen. */
const VISIBLE_CHANGE = 0.005;

/** Resets whose gains differ by less than this share are worth the same. */
const GAIN_TIE = 0.01;

export interface UsageStep {
  at: number;
  /** Share of capacity still used right after this reset. */
  used: number;
}

export interface ProviderUsage {
  /** bb's provider id. */
  provider: string;
  /**
   * Share of capacity that can't serve a request now: spent quota plus
   * accounts without a trustworthy reading. Null when no account counts.
   */
  used: number | null;
  /** The spent-quota part of `used`, the only part a reset frees. */
  spent: number;
  /** Resets that lower `used` within a week, soonest first. */
  steps: UsageStep[];
  /** Resets the accounts can spend to clear their limits early. */
  availableResets: number;
  /** The reset worth spending first; null when none lowers `used`. */
  resetPlan: ResetPlan | null;
  accounts: UsageAccount[];
}

export interface ResetPlan {
  account: UsageAccount;
  /** When the reset expires; null when the provider doesn't say. */
  expiresAt: number | null;
  /** The account's share that can't serve a request, now and after it. */
  accountUsed: { before: number; after: number };
  /** The provider's `used`, now and right after the reset. */
  used: { before: number; after: number };
  /** When the account would free up as much on its own; null past a week. */
  freesAt: number | null;
}

function usedAt(window: UsageWindow, time: number): number | null {
  if (window.resetAt !== null && window.resetAt <= time) return 0;
  if (window.rejected) return 1;
  if (window.utilization === null) return null;
  return Math.min(1, Math.max(0, window.utilization));
}

export function countsTowardCapacity(account: UsageAccount): boolean {
  return !account.disabled && account.weight > 0;
}

/** A window's size in five-hour windows, when the account has one. */
function windowScale(account: UsageAccount, window: UsageWindow): number {
  const hasFiveHour = account.windows.some(({ minutes }) => minutes === 300);
  return hasFiveHour && window.minutes === 10_080
    ? WEEK_IN_FIVE_HOUR_WINDOWS
    : 1;
}

/** Whether Account Pooler routes to the account at `time`. */
function servesAt(account: UsageAccount, time: number): boolean {
  if (account.heldUntil !== null && account.heldUntil > time) return false;
  const cleared =
    (account.heldUntil !== null && account.heldUntil <= time) ||
    account.windows.some(({ resetAt }) => resetAt !== null && resetAt <= time);
  return !account.blocked || cleared;
}

/**
 * The share of one short window the account could serve at `time`, assuming
 * nobody uses it meanwhile. A weekly allowance holds several five-hour
 * windows, so it binds only once it runs low.
 */
function availableAt(
  account: UsageAccount,
  time: number,
  switchThreshold: number,
): number {
  if (!servesAt(account, time)) return 0;
  let available = 1;
  for (const window of account.windows) {
    const used = usedAt(window, time) ?? 0;
    const remaining = used >= switchThreshold ? 0 : 1 - used;
    available = Math.min(available, remaining * windowScale(account, window));
  }
  return available;
}

/** What an account has served by `at`, in five-hour windows. */
interface Served {
  at: number;
  total: number;
}

/**
 * What a busy account serves before `end`: the total after each time it
 * grows. It takes all its windows allow as soon as they
 * allow it, and each window starts again as soon as it resets.
 */
function servedUntil(
  account: UsageAccount,
  end: number,
  switchThreshold: number,
  now: number,
): Served[] {
  const budgets = account.windows.map((window) => {
    const scale = windowScale(account, window);
    const used = usedAt(window, now) ?? 0;
    const length = window.minutes === null ? null : window.minutes * 60_000;
    return {
      full: switchThreshold * scale,
      left: Math.max(0, switchThreshold - used) * scale,
      length,
      // An unused window starts with the first request.
      resetAt:
        window.resetAt !== null && window.resetAt > now
          ? window.resetAt
          : used === 0 && length !== null
            ? now + length
            : null,
    };
  });
  const served: Served[] = [];
  let total = 0;
  let time = now;
  while (budgets.length > 0) {
    const amount = Math.min(...budgets.map(({ left }) => left));
    if (amount > 0 && servesAt(account, time)) {
      total += amount;
      for (const budget of budgets) budget.left -= amount;
      served.push({ at: time, total });
    }
    const next = Math.min(
      ...budgets.map(({ resetAt }) => resetAt ?? Infinity),
      account.heldUntil !== null && account.heldUntil > time
        ? account.heldUntil
        : Infinity,
    );
    if (next >= end) break;
    time = next;
    for (const budget of budgets) {
      if (budget.resetAt !== time) continue;
      budget.left = budget.full;
      budget.resetAt = budget.length === null ? null : time + budget.length;
    }
  }
  return served;
}

/** How much more `ahead` has served than `behind`, summed over time. */
function lead(
  ahead: readonly Served[],
  behind: readonly Served[],
  now: number,
  end: number,
): number {
  const totalAt = (served: readonly Served[], time: number) => {
    let total = 0;
    for (const step of served) if (step.at <= time) total = step.total;
    return total;
  };
  const times = [
    ...new Set([now, ...[...ahead, ...behind].map(({ at }) => at)]),
  ].sort((a, b) => a - b);
  let sum = 0;
  times.forEach((time, index) => {
    const next = times[index + 1] ?? end;
    sum += (totalAt(ahead, time) - totalAt(behind, time)) * (next - time);
  });
  return sum;
}

function share(part: number, total: number): number {
  const value = part / total;
  // Weighted sums leave float dust that would render as "<1%".
  return value < 1e-9 ? 0 : Math.min(1, value);
}

function usageAt(
  accounts: readonly UsageAccount[],
  time: number,
  switchThreshold: number,
): { used: number; spent: number } | null {
  let total = 0;
  let offline = 0;
  let free = 0;
  for (const account of accounts) {
    if (!countsTowardCapacity(account)) continue;
    total += account.weight;
    if (account.offline !== null) offline += account.weight;
    else free += account.weight * availableAt(account, time, switchThreshold);
  }
  if (total === 0) return null;
  return {
    used: share(total - free, total),
    spent: share(total - offline - free, total),
  };
}

function resetSteps(
  accounts: readonly UsageAccount[],
  used: number,
  switchThreshold: number,
  now: number,
): UsageStep[] {
  const times = new Set<number>();
  for (const account of accounts) {
    if (!countsTowardCapacity(account) || account.offline !== null) continue;
    for (const time of [
      account.heldUntil,
      ...account.windows.map(({ resetAt }) => resetAt),
    ]) {
      if (time !== null && time > now && time <= now + RESET_HORIZON_MS) {
        times.add(time);
      }
    }
  }
  const steps: UsageStep[] = [];
  let previous = used;
  for (const time of [...times].sort((a, b) => a - b)) {
    const next = usageAt(accounts, time, switchThreshold)?.used ?? previous;
    if (previous - next >= VISIBLE_CHANGE) {
      steps.push({ at: time, used: next });
      previous = next;
    }
  }
  return steps;
}

/**
 * The reset worth spending: plan weight times how much more the account
 * serves with it, through every window it clears, summed over time until the
 * account would free up on its own, within a week. Of resets worth about the
 * same, the one that expires first. Only a reset that lowers the percentage
 * shown now.
 */
function planReset(
  accounts: readonly UsageAccount[],
  used: number,
  switchThreshold: number,
  now: number,
): ResetPlan | null {
  const end = now + RESET_HORIZON_MS;
  const available = (account: UsageAccount, time: number) =>
    availableAt(account, time, switchThreshold);
  const served = (account: UsageAccount, until: number) =>
    servedUntil(account, until, switchThreshold, now);
  let best: ResetPlan | null = null;
  let bestScore = 0;
  for (const account of accounts) {
    const { reset } = account;
    if (!reset || !countsTowardCapacity(account) || account.offline !== null) {
      continue;
    }
    const cleared = ({ minutes }: UsageWindow) =>
      reset.clears === null || reset.clears.includes(minutes ?? 0);
    // A hold stays: Account Pooler keeps it through a new reading.
    const after = {
      ...account,
      blocked: account.blocked && !account.windows.some(cleared),
      windows: account.windows.map((window) =>
        cleared(window)
          ? { ...window, utilization: 0, resetAt: null, rejected: false }
          : window,
      ),
    };
    const swapped = accounts.map((other) =>
      other === account ? after : other,
    );
    const usedAfter = usageAt(swapped, now, switchThreshold)?.used ?? used;
    if (formatPercent(usedAfter) === formatPercent(used)) continue;
    // On its own, the account frees up once every window the reset would
    // empty resets; with nothing spent, once its first window resets.
    const spent = account.windows.filter(
      (window) => cleared(window) && (usedAt(window, now) ?? 0) > 0,
    );
    const resets = (spent.length > 0 ? spent : account.windows).map(
      ({ resetAt }) => resetAt ?? Infinity,
    );
    const freesOn =
      spent.length > 0 ? Math.max(...resets) : Math.min(...resets);
    const freesAt = freesOn <= end ? freesOn : null;
    const until = freesAt ?? end;
    const score =
      account.weight *
      lead(served(after, until), served(account, until), now, until);
    if (score <= 0) continue;
    if (
      best !== null &&
      (score < bestScore * (1 - GAIN_TIE) ||
        (score <= bestScore * (1 + GAIN_TIE) &&
          (reset.expiresAt ?? Infinity) >= (best.expiresAt ?? Infinity)))
    ) {
      continue;
    }
    best = {
      account,
      expiresAt: reset.expiresAt,
      accountUsed: {
        before: 1 - available(account, now),
        after: 1 - available(after, now),
      },
      used: { before: used, after: usedAfter },
      freesAt,
    };
    bestScore = score;
  }
  return best;
}

/** One entry per provider that has accounts, in the snapshot's order. */
export function summarizeUsage(
  snapshot: UsageSnapshot,
  now: number,
): ProviderUsage[] {
  return snapshot.providers.flatMap(({ id: provider, switchThreshold }) => {
    const own = snapshot.accounts.filter(
      (account) => account.provider === provider,
    );
    if (own.length === 0) return [];
    const current = usageAt(own, now, switchThreshold);
    return [
      {
        provider,
        used: current?.used ?? null,
        spent: current?.spent ?? 0,
        steps:
          current === null
            ? []
            : resetSteps(own, current.used, switchThreshold, now),
        availableResets: own
          .filter(countsTowardCapacity)
          .reduce((sum, account) => sum + (account.availableResets ?? 0), 0),
        resetPlan:
          current === null
            ? null
            : planReset(own, current.used, switchThreshold, now),
        accounts: own,
      },
    ];
  });
}

/** Whether the summary has spent quota worth a reset forecast. */
export function hasSpentQuota(usage: ProviderUsage): boolean {
  return usage.spent >= VISIBLE_CHANGE;
}

export function formatPercent(fraction: number): string {
  if (fraction > 0 && fraction < 0.005) return "<1%";
  return `${Math.round(fraction * 100)}%`;
}

/** Compares what the user reads, so "80%" is red at an 80% threshold. */
export function isHot(fraction: number, threshold: number): boolean {
  return Math.round(fraction * 100) >= threshold;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

export function redThreshold(
  values: Record<string, unknown> | undefined,
): number {
  const value = values?.redThreshold;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(1, Math.round(value)))
    : DEFAULT_RED_THRESHOLD;
}
