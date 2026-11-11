import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULT_RED_THRESHOLD } from "./usage-model";

const poolProviderSchema = z.enum(["claude", "codex"]);
const poolAccountStatusSchema = z.enum([
  "disabled",
  "ready",
  "held",
  "exhausted",
  "error",
]);

const poolLimitWindowSchema = z.object({
  slot: z.enum(["primary", "secondary"]),
  windowMinutes: z.number().int().positive().nullable(),
  utilization: z.number().nullable(),
  resetAt: z.number().int().nullable(),
  status: z.string().nullable(),
});

// Parse only the fields used here. Account Pooler is experimental, so
// accepting additive fields keeps this companion resilient to small changes.
const poolAccountSchema = z.object({
  id: z.string().min(1),
  provider: poolProviderSchema,
  kind: z.enum(["oauth", "api-key"]),
  label: z.string().min(1),
  email: z.string().email().nullable(),
  /** The ChatGPT account a Codex login acts for. */
  codexAccountId: z.string().min(1).optional().catch(undefined),
  subscriptionType: z.string().nullable(),
  rateLimitTier: z.string().nullable(),
  enabled: z.boolean(),
  priority: z.number().int(),
  fiveHourUtilization: z.number().nullable(),
  fiveHourResetAt: z.number().int().nullable(),
  fiveHourStatus: z.string().nullable(),
  sevenDayUtilization: z.number().nullable(),
  sevenDayResetAt: z.number().int().nullable(),
  sevenDayStatus: z.string().nullable(),
  limitWindows: z.array(poolLimitWindowSchema),
  observedAt: z.number().int().nullable(),
  heldUntil: z.number().int().nullable(),
  error: z.string().nullable(),
  inFlight: z.number().int().nonnegative(),
  status: poolAccountStatusSchema,
});

const poolStatusSchema = z.object({
  accounts: z.array(poolAccountSchema),
  /** Whether bb routes each provider's threads through the pool. */
  routing: z.record(z.string(), z.boolean()).optional().catch(undefined),
  /** A parent bb server's pool, which serves instead when proxying. */
  parent: z
    .object({
      mode: z.string(),
      availability: z.record(z.string(), z.boolean()),
    })
    .nullable()
    .optional()
    .catch(null),
});

const poolConfigSchema = z.object({
  switchThreshold: z.number(),
});

const usageWindowSchema = z.object({
  /** Window length; null when the provider does not say. */
  minutes: z.number().int().positive().nullable(),
  utilization: z.number().nullable(),
  resetAt: z.number().int().nullable(),
  /** The provider refused requests in this window until it resets. */
  rejected: z.boolean(),
});

// bb's provider-usage.v1 source contract, read leniently: an odd field
// falls back to a safe value instead of failing the whole source.
const sourceResourceSchema = z.object({
  id: z.string().min(1),
  accountKey: z.string().min(1).nullable().catch(null),
  providerId: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({ kind: z.literal("host"), hostId: z.string().min(1) }),
  ]),
});

const sourceListSchema = z.object({
  resources: z.array(sourceResourceSchema),
});

const sourceWindowSchema = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]).catch("custom"),
  usedPercent: z.number(),
  resetsAt: z.string().nullable().catch(null),
  /** The model family the window limits; null for all models. */
  model: z.string().nullable().catch(null),
});

const sourcePlanSchema = z.object({
  id: z.string(),
  multiplier: z.number().positive().nullable(),
});

const sourceMeasurementSchema = z.object({
  accountKey: z.string().min(1).nullable().catch(null),
  usage: z.object({
    status: z.string(),
    plan: sourcePlanSchema.nullable().catch(null),
    windows: z.array(sourceWindowSchema).catch([]),
  }),
});

const usageAccountSchema = z.object({
  id: z.string().min(1),
  /** bb's provider id, such as `claude-code`. */
  provider: z.string().min(1),
  /** Account Pooler's name for the account. */
  label: z.string().optional(),
  email: z.string().nullable().optional(),
  /** The plan's name, such as `Max 20x`. */
  plan: z.string().nullable().optional(),
  /** Relative capacity within the provider; 0 keeps it out of the total. */
  weight: z.number().nonnegative(),
  disabled: z.boolean(),
  /** Why the account's quota can't be trusted right now. */
  offline: z.enum(["login error", "error", "no data"]).nullable(),
  /** Account Pooler won't route to it until a hold ends or a window resets. */
  blocked: z.boolean(),
  heldUntil: z.number().int().nullable(),
  windows: z.array(usageWindowSchema),
  /** Resets the account can spend to clear its limits; absent when unknown. */
  availableResets: z.number().int().nonnegative().optional(),
  /** The reset a spend would use; absent when none can be spent now. */
  reset: z
    .object({
      expiresAt: z.number().int().nullable(),
      /** The lengths, in minutes, of the windows it clears; null for all. */
      clears: z.array(z.number().int().positive()).nullable(),
    })
    .optional(),
});

const usageProviderSchema = z.object({
  id: z.string().min(1),
  /** Utilization at which a window stops taking requests. */
  switchThreshold: z.number(),
});

/** Pay-as-you-go spending past the subscription, summed over accounts. */
const extraUsageSchema = z.object({
  /** bb's provider id, such as `claude-code`. */
  provider: z.string().min(1),
  /** Spent this month, in the currency's major unit. */
  used: z.number().nonnegative(),
  /** The monthly cap in the same unit; null when there is none. */
  limit: z.number().nonnegative().nullable(),
  currency: z.string().min(1),
});

const usageSnapshotSchema = z.object({
  /** Providers with accounts, the ones Account Pooler serves first. */
  providers: z.array(usageProviderSchema),
  accounts: z.array(usageAccountSchema),
  extraUsage: z.array(extraUsageSchema).optional(),
});

export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type UsageAccount = z.infer<typeof usageAccountSchema>;
export type UsageProvider = z.infer<typeof usageProviderSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
export type ExtraUsage = z.infer<typeof extraUsageSchema>;
export type PoolAccount = z.infer<typeof poolAccountSchema>;
type PoolProvider = z.infer<typeof poolProviderSchema>;
type PoolStatus = z.infer<typeof poolStatusSchema>;
type SourceResource = z.infer<typeof sourceResourceSchema>;
type SourceWindow = z.infer<typeof sourceWindowSchema>;
type SourceUsage = z.infer<typeof sourceMeasurementSchema>["usage"];

/** This plugin's id, so it never reads back the usage it reports. */
const SELF_PLUGIN_ID = "pool-usage";
const EXTRA_RESOURCE_ID = "claude-extra-usage";

const sourceUsageOutputSchema = z.object({
  accountKey: z.string().min(1).nullable(),
  observedAt: z.number().int().nonnegative().nullable(),
  usage: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      plan: z.null(),
      accountEmail: z.string().nullable(),
      planLabel: z.string().nullable(),
      windows: z.array(
        z.object({
          kind: z.literal("custom"),
          id: z.string().min(1),
          label: z.string().min(1),
          usedPercent: z.number().nonnegative(),
          resetsAt: z.string().nullable(),
          model: z.null(),
          cost: z.null(),
        }),
      ),
    }),
    z.object({
      status: z.literal("unauthenticated"),
      plan: z.null(),
      accountEmail: z.null(),
      planLabel: z.null(),
    }),
  ]),
});

export const rpcContract = defineRpcContract({
  /**
   * bb's usage source contract, so bb's own usage panel shows Claude's extra
   * usage as a row of its own.
   */
  "provider-usage.v1.listResources": {
    input: z.object({}),
    output: z.object({
      label: z.string().min(1).optional(),
      resources: z.array(
        z.object({
          accountKey: z.null(),
          id: z.string().min(1),
          providerId: z.string().min(1),
          label: z.string().min(1),
          scope: z.object({ kind: z.literal("shared") }),
        }),
      ),
    }),
  },
  "provider-usage.v1.getResource": {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: sourceUsageOutputSchema,
  },
  usage_get: {
    input: z.null(),
    output: usageSnapshotSchema,
  },
  /**
   * Spends the account's next reset. A retry with the same request id never
   * uses a second one.
   */
  reset_use: {
    input: z.object({ accountId: z.string().min(1), requestId: z.uuid() }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("reset") }),
      /** This try spent nothing; the message says why. */
      z.object({ outcome: z.literal("refused"), message: z.string() }),
    ]),
  },
});

const POOL_PLUGIN_ID = "account-pool";

/** bb's ids for the providers Account Pooler serves. */
const POOL_PROVIDERS: Record<PoolProvider, string> = {
  claude: "claude-code",
  codex: "codex",
};

/** Account Pooler's default; the live value comes from its `config.get` RPC. */
const DEFAULT_SWITCH_THRESHOLD = 0.98;

/** A provider's own login serves until a window is full. */
const SOURCE_SWITCH_THRESHOLD = 1;

/** Account Pooler polls every five minutes, so older readings are lost. */
const STALE_OBSERVATION_MS = 30 * 60_000;

const LOGIN_ERROR =
  /auth|api key|(?:access|refresh|id) token|token (?:expired|revoked)|invalid token|log ?in|sign ?in|\b40[13]\b|unauthori[sz]ed|credential/iu;

interface Plan {
  tier: string;
  weight: number;
}

/**
 * Capacity relative to Plus: Pro $100 and Business $100 are 5x, Pro $200 is
 * 20x. See https://learn.chatgpt.com/docs/pricing for the plan multipliers.
 * Plans without a stated multiplier count as 1x.
 */
const CODEX_PLANS = new Map<string, Plan>([
  ["pro", { tier: "Pro 20x", weight: 20 }],
  ["prolite", { tier: "Pro 5x", weight: 5 }],
  ["self_serve_business_prolite", { tier: "Biz Pro Lite", weight: 5 }],
  ["plus", { tier: "Plus", weight: 1 }],
  ["team", { tier: "Team", weight: 1 }],
  ["business", { tier: "Business", weight: 1 }],
  ["enterprise", { tier: "Enterprise", weight: 1 }],
  ["edu", { tier: "Edu", weight: 1 }],
  ["free", { tier: "Free", weight: 1 }],
  ["go", { tier: "Go", weight: 1 }],
]);

const CODEX_PLAN_WORDS = new Map([
  ["business", "Biz"],
  ["prolite", "Pro Lite"],
]);

function codexPlan(value: string | null): Plan | null {
  if (value === null) return null;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "");
  const known = CODEX_PLANS.get(key);
  if (known !== undefined) return known;
  const words = key
    .split("_")
    .filter((word) => word !== "" && word !== "self" && word !== "serve")
    .map(
      (word) =>
        CODEX_PLAN_WORDS.get(word) ?? word[0].toUpperCase() + word.slice(1),
    );
  return words.length === 0 ? null : { tier: words.join(" "), weight: 1 };
}

/**
 * Capacity relative to Pro, as Anthropic states it: Max is 5x or 20x, a
 * standard Team seat 1.25x and a premium one 5x a standard seat. Enterprise
 * has no stated multiplier and counts as 1x unless its tier names one.
 */
function claudePlan(
  subscriptionType: string | null,
  rateLimitTier: string | null,
): Plan | null {
  const type = subscriptionType?.trim().toLowerCase() ?? "";
  const limit = rateLimitTier?.trim().toLowerCase() ?? "";
  const multiplier = /max_(\d+)x/u.exec(limit)?.[1];
  const weight = multiplier === undefined ? null : Number(multiplier);
  if (type.includes("enterprise")) {
    return { tier: "Enterprise", weight: weight ?? 1 };
  }
  if (type.includes("team")) {
    return weight === null
      ? { tier: "Team", weight: 1.25 }
      : { tier: "Team Premium", weight: 1.25 * weight };
  }
  if (weight !== null) return { tier: `Max ${weight}x`, weight };
  if (type === "max" || limit.includes("max"))
    return { tier: "Max", weight: 5 };
  if (type === "pro" || limit.includes("pro"))
    return { tier: "Pro", weight: 1 };
  if (type === "free") return { tier: "Free", weight: 1 };
  return null;
}

/** The subscription's display name and its capacity relative to its peers. */
export function accountPlan(
  account: Pick<
    PoolAccount,
    "provider" | "kind" | "subscriptionType" | "rateLimitTier"
  >,
): Plan | null {
  if (account.kind === "api-key") return { tier: "API", weight: 0 };
  return account.provider === "claude"
    ? claudePlan(account.subscriptionType, account.rateLimitTier)
    : codexPlan(account.subscriptionType);
}

function quotaWindow(
  minutes: number | null,
  utilization: number | null,
  resetAt: number | null,
  status: string | null,
): UsageWindow {
  return {
    minutes,
    utilization,
    resetAt,
    rejected: status?.toLowerCase() === "rejected",
  };
}

function accountWindows(account: PoolAccount): UsageWindow[] {
  const windows = [
    quotaWindow(
      300,
      account.fiveHourUtilization,
      account.fiveHourResetAt,
      account.fiveHourStatus,
    ),
    quotaWindow(
      10_080,
      account.sevenDayUtilization,
      account.sevenDayResetAt,
      account.sevenDayStatus,
    ),
  ].filter((window) => window.utilization !== null || window.rejected);
  for (const window of account.limitWindows) {
    if (
      window.windowMinutes !== null &&
      windows.some(({ minutes }) => minutes === window.windowMinutes)
    ) {
      continue;
    }
    const normalized = quotaWindow(
      window.windowMinutes,
      window.utilization,
      window.resetAt,
      window.status,
    );
    if (normalized.utilization !== null || normalized.rejected) {
      windows.push(normalized);
    }
  }
  return windows;
}

function offlineReason(
  account: PoolAccount,
  now: number,
  resetUsedAt: number | undefined,
): UsageAccount["offline"] {
  if (account.status === "error") {
    return account.error !== null && LOGIN_ERROR.test(account.error)
      ? "login error"
      : "error";
  }
  // A reading from before a reset shows limits the reset cleared.
  if (
    account.observedAt === null ||
    (resetUsedAt !== undefined && account.observedAt < resetUsedAt)
  ) {
    return "no data";
  }
  // Account Pooler sends a held or exhausted account nothing, so its last
  // reading stays true until a window resets, though nothing renews it.
  const blocked = account.status === "held" || account.status === "exhausted";
  if (!blocked && now - account.observedAt > STALE_OBSERVATION_MS) {
    return "no data";
  }
  return null;
}

export function normalizeAccount(
  account: PoolAccount,
  options: {
    now: number;
    planFallback?: Plan | null;
    /** When this plugin last reset the account's limits. */
    resetUsedAt?: number;
  },
): UsageAccount {
  const plan = accountPlan(account) ?? options.planFallback ?? null;
  const weight = plan?.weight ?? 1;
  const disabled = !account.enabled || account.status === "disabled";
  return {
    id: account.id,
    provider: POOL_PROVIDERS[account.provider],
    label: account.label,
    email: account.email,
    plan: plan?.tier ?? null,
    weight,
    disabled,
    offline:
      disabled || weight === 0
        ? null
        : offlineReason(account, options.now, options.resetUsedAt),
    heldUntil: account.heldUntil,
    blocked: account.status === "held" || account.status === "exhausted",
    windows: accountWindows(account),
  };
}

/**
 * Who serves a provider's threads, as Account Pooler decides it: its own
 * accounts, a parent bb server's pool, or, when null, the provider's own
 * login.
 */
function poolRoute(
  status: PoolStatus,
  provider: PoolProvider,
): "accounts" | "parent" | null {
  if (status.routing?.[provider] === false) return null;
  if (status.parent?.mode === "proxy") {
    return status.parent.availability[provider] === true ? "parent" : null;
  }
  return status.accounts.some(
    (account) => account.enabled && account.provider === provider,
  )
    ? "accounts"
    : null;
}

const WINDOW_MINUTES = {
  "five-hour": 300,
  daily: 1_440,
  weekly: 10_080,
  custom: null,
} as const;

function sourceWindow(window: SourceWindow): UsageWindow {
  const resetAt =
    window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
  return {
    minutes: WINDOW_MINUTES[window.kind],
    utilization: window.usedPercent / 100,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    rejected: false,
  };
}

/** Sources name a plan but not its rate-limit tier; weigh it like the pool. */
function sourceWeight(provider: string, plan: SourceUsage["plan"]): number {
  if (plan === null) return 1;
  if (plan.multiplier !== null) return plan.multiplier;
  const known =
    provider === POOL_PROVIDERS.claude
      ? claudePlan(plan.id, null)
      : provider === POOL_PROVIDERS.codex
        ? codexPlan(plan.id)
        : null;
  return known?.weight ?? 1;
}

/** What a source's measurement says about quota; null when it says nothing. */
export function sourceAccount(
  id: string,
  provider: string,
  usage: SourceUsage,
): UsageAccount | null {
  const account = {
    id,
    provider,
    weight: sourceWeight(provider, usage.plan),
    disabled: false,
    heldUntil: null,
    blocked: false,
  };
  if (usage.status === "expired") {
    return { ...account, offline: "login error", windows: [] };
  }
  if (usage.status !== "ok") return null;
  // A model's own window limits only that model.
  const windows = usage.windows
    .filter(({ model }) => model === null)
    .map(sourceWindow);
  return windows.length === 0 ? null : { ...account, offline: null, windows };
}

interface SourceReading {
  account: UsageAccount;
  accountKey: string | null;
  shared: boolean;
}

/** One reading per quota account, preferring a shared source's. */
function distinctReadings(readings: readonly SourceReading[]): UsageAccount[] {
  const result: SourceReading[] = [];
  const known = new Map<string, number>();
  for (const reading of readings) {
    // An unknown account may be anyone's, so it never merges.
    if (reading.accountKey === null) {
      result.push(reading);
      continue;
    }
    const key = JSON.stringify([reading.account.provider, reading.accountKey]);
    const index = known.get(key);
    if (index === undefined) {
      known.set(key, result.length);
      result.push(reading);
    } else if (reading.shared && !result[index]!.shared) {
      result[index] = reading;
    }
  }
  return result.map(({ account }) => account);
}

const CODEX_PLAN_CACHE_MS = 5 * 60_000;

/** A fresh read serves every client polling within this window. */
const SNAPSHOT_TTL_MS = 15_000;

const USAGE_LIST_METHOD = "provider-usage.v1.listResources";
const USAGE_GET_METHOD = "provider-usage.v1.getResource";

/** Sources may ask the provider, so they are read less often than the pool. */
const SOURCE_TTL_MS = 60_000;
const SOURCE_TIMEOUT_MS = 10_000;
const SOURCE_BATCH_SIZE = 3;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function inBatches<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += SOURCE_BATCH_SIZE) {
    results.push(
      ...(await Promise.all(
        items.slice(start, start + SOURCE_BATCH_SIZE).map(read),
      )),
    );
  }
  return results;
}

/**
 * Reads the accounts that bb's usage sources report, such as the Claude
 * Code, Codex and ACP providers' own logins, except for the providers
 * Account Pooler serves.
 */
function createSourceReader(
  bb: BbPluginApi,
): (served: ReadonlySet<string>) => Promise<UsageAccount[]> {
  /** Each source's last inventory, for a listing that fails. */
  const inventories = new Map<string, SourceResource[]>();
  /** Each resource's last reading, for a measurement that fails. */
  const readings = new Map<string, SourceReading>();
  let cache: {
    served: string;
    readAt: number;
    accounts: UsageAccount[];
  } | null = null;
  let pending: { served: string; promise: Promise<UsageAccount[]> } | null =
    null;

  async function sourcePlugins(): Promise<string[]> {
    try {
      const methods = await bb.sdk.plugins.experimental_discoverRpc({
        method: USAGE_LIST_METHOD,
      });
      // Account Pooler's accounts come from its status, with more detail.
      return [...new Set(methods.map(({ pluginId }) => pluginId))].filter(
        (pluginId) =>
          pluginId !== POOL_PLUGIN_ID && pluginId !== SELF_PLUGIN_ID,
      );
    } catch (cause) {
      bb.log.debug(`Could not discover usage sources: ${errorMessage(cause)}`);
      return [...inventories.keys()];
    }
  }

  /** Connected, persistent hosts; null when they can't be listed. */
  async function usableHosts(): Promise<Set<string> | null> {
    try {
      const hosts = await bb.sdk.hosts.list();
      return new Set(
        hosts
          .filter(
            (host) => host.status === "connected" && host.type !== "ephemeral",
          )
          .map(({ id }) => id),
      );
    } catch (cause) {
      bb.log.debug(`Could not list hosts: ${errorMessage(cause)}`);
      return null;
    }
  }

  async function listResources(pluginId: string): Promise<SourceResource[]> {
    try {
      const { resources } = await bb.sdk.plugins.callRpc({
        pluginId,
        method: USAGE_LIST_METHOD,
        input: {},
        outputSchema: sourceListSchema,
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      inventories.set(pluginId, resources);
      return resources;
    } catch (cause) {
      bb.log.debug(`Could not list ${pluginId} usage: ${errorMessage(cause)}`);
      return inventories.get(pluginId) ?? [];
    }
  }

  async function measure(
    pluginId: string,
    resource: SourceResource,
  ): Promise<SourceReading | null> {
    const id = `${pluginId}:${resource.id}`;
    try {
      const { accountKey, usage } = await bb.sdk.plugins.callRpc({
        pluginId,
        method: USAGE_GET_METHOD,
        input: { resourceId: resource.id, refresh: false },
        outputSchema: sourceMeasurementSchema,
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      // A failed collection keeps the last reading, as bb's usage panel does.
      if (usage.status === "error") return readings.get(id) ?? null;
      const account = sourceAccount(id, resource.providerId, usage);
      if (account === null) {
        readings.delete(id);
        return null;
      }
      const reading = {
        account,
        accountKey: accountKey ?? resource.accountKey,
        shared: resource.scope.kind === "shared",
      };
      readings.set(id, reading);
      return reading;
    } catch (cause) {
      bb.log.debug(`Could not read ${id} usage: ${errorMessage(cause)}`);
      return readings.get(id) ?? null;
    }
  }

  async function readAccounts(
    served: ReadonlySet<string>,
  ): Promise<UsageAccount[]> {
    const pluginIds = await sourcePlugins();
    for (const pluginId of inventories.keys()) {
      if (!pluginIds.includes(pluginId)) inventories.delete(pluginId);
    }
    const listed = (
      await inBatches(pluginIds, async (pluginId) =>
        (await listResources(pluginId)).map((resource) => ({
          pluginId,
          resource,
        })),
      )
    ).flat();
    const ids = new Set(
      listed.map(({ pluginId, resource }) => `${pluginId}:${resource.id}`),
    );
    for (const id of readings.keys()) {
      if (!ids.has(id)) readings.delete(id);
    }
    const idle = listed.filter(
      ({ resource }) => !served.has(resource.providerId),
    );
    const hosts = idle.some(({ resource }) => resource.scope.kind === "host")
      ? await usableHosts()
      : null;
    const wanted = idle.filter(
      ({ resource }) =>
        resource.scope.kind === "shared" ||
        hosts === null ||
        hosts.has(resource.scope.hostId),
    );
    const measured = await inBatches(wanted, ({ pluginId, resource }) =>
      measure(pluginId, resource),
    );
    return distinctReadings(measured.filter((reading) => reading !== null));
  }

  return (served) => {
    const key = [...served].sort().join(" ");
    if (cache?.served === key && Date.now() - cache.readAt < SOURCE_TTL_MS) {
      return Promise.resolve(cache.accounts);
    }
    let current = pending;
    if (current?.served !== key) {
      const promise = readAccounts(served)
        .then((accounts) => {
          cache = { served: key, readAt: Date.now(), accounts };
          return accounts;
        })
        .finally(() => {
          if (pending?.promise === promise) pending = null;
        });
      current = { served: key, promise };
      pending = current;
    }
    return current.promise;
  };
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function fetchOfficialCodexPlans(
  bb: BbPluginApi,
  accounts: readonly PoolAccount[],
): Promise<Map<string, Plan>> {
  const unresolvedEmails = new Set(
    accounts.flatMap((account) =>
      account.provider === "codex" &&
      account.email !== null &&
      accountPlan(account) === null
        ? [normalizedEmail(account.email)]
        : [],
    ),
  );
  if (unresolvedEmails.size === 0) return new Map();

  const hosts = (await bb.sdk.hosts.list()).filter(
    (host) => host.status === "connected",
  );
  const results = await Promise.allSettled(
    hosts.map((host) =>
      bb.sdk.system.usageLimits({ hostId: host.id, providerId: "codex" }),
    ),
  );
  const candidates = new Map<string, Map<string, Plan>>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const usage = result.value.codex;
    if (
      usage?.status !== "ok" ||
      usage.accountEmail === null ||
      usage.planLabel === null
    ) {
      continue;
    }
    const email = normalizedEmail(usage.accountEmail);
    if (!unresolvedEmails.has(email)) continue;
    const plan = codexPlan(usage.planLabel);
    if (plan === null) continue;
    const plans = candidates.get(email) ?? new Map<string, Plan>();
    plans.set(plan.tier, plan);
    candidates.set(email, plans);
  }

  return new Map(
    [...candidates].flatMap(([email, plans]) =>
      plans.size === 1 ? [[email, [...plans.values()][0] as Plan]] : [],
    ),
  );
}

async function fetchSwitchThreshold(bb: BbPluginApi): Promise<number> {
  try {
    const config = await bb.sdk.plugins.callRpc({
      pluginId: POOL_PLUGIN_ID,
      method: "config.get",
      input: null,
      outputSchema: poolConfigSchema,
    });
    const threshold = config.switchThreshold;
    return typeof threshold === "number" && threshold > 0 && threshold <= 1
      ? threshold
      : DEFAULT_SWITCH_THRESHOLD;
  } catch (cause) {
    bb.log.debug(
      `Could not read Account Pooler's switch threshold, assuming ${DEFAULT_SWITCH_THRESHOLD}: ${errorMessage(cause)}`,
    );
    return DEFAULT_SWITCH_THRESHOLD;
  }
}

/** Counts change only when a grant arrives or someone spends a reset. */
const RESETS_TTL_MS = 10 * 60_000;
/** How long a retry remembers the reset its request sent. */
const SENT_RESET_TTL_MS = 24 * 60 * 60_000;
const SENT_RESET_KEY = "sentReset:";
const CODEX_API = "https://chatgpt.com/backend-api/wham";
const CLAUDE_API = "https://api.anthropic.com/api";
/** Spending moves with every request, so it's read more often than resets. */
const EXTRA_USAGE_TTL_MS = 2 * 60_000;
/** The Claude windows a grant clears, by their length in minutes. */
const CLAUDE_WINDOWS = new Map([
  ["five_hour", 300],
  ["seven_day", 10_080],
]);
/** Answers that keep the reset; any other may be retried as is. */
const REFUSALS = new Set([
  "nothing_to_reset",
  "no_credit",
  "not_limited",
  "ineligible",
  "already_used",
  "already_redeemed",
]);
/** Refusals that, to a retry, mean its first try used the reset. */
const REPEATS = new Set(["already_used", "already_redeemed"]);

interface AccountResets {
  count: number;
  /** The credit or grant a spend would use. */
  next: {
    id: string;
    expiresAt: number | null;
    /** The lengths, in minutes, of the windows it clears; null for all. */
    clears: number[] | null;
  } | null;
}

type SpendOutcome =
  { outcome: "reset" } | { outcome: "refused"; message: string };

interface SentReset {
  resetId: string;
  sentAt: number;
  /** When the provider confirmed the reset. */
  usedAt?: number;
}

// The providers' replies are undocumented, so they're read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function parseTime(value: unknown): number | null {
  const time = Date.parse(String(value));
  return Number.isNaN(time) ? null : time;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** A reset without a readable end stays open, as Claude Code reads it. */
function isOpen(end: unknown, now: number): boolean {
  return (parseTime(end) ?? Infinity) > now;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Json> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? headers
        : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A spend clears the limits before it answers.
    signal: AbortSignal.timeout(body === undefined ? 10_000 : 30_000),
  });
  if (response.ok) return response.json();
  // A spend the provider refuses may answer with an error status.
  const reply: Json =
    body === undefined ? null : await response.json().catch(() => null);
  if ((reply?.code ?? reply?.result) === undefined) {
    throw new Error(`HTTP ${response.status}`);
  }
  return reply;
}

function formatMoney(
  amount: number,
  currency: string,
  fractionDigits = 2,
): string {
  try {
    return amount.toLocaleString("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  } catch {
    return `${amount.toFixed(fractionDigits)} ${currency}`;
  }
}

/** Where Claude Code keeps its login on macOS, and elsewhere. */
const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CODE_CREDENTIALS_FILE = path.join(
  homedir(),
  ".claude",
  ".credentials.json",
);

function keychainSecret(service: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 10_000 },
      // Only stdout carries the secret, so the error is safe to report.
      (error, stdout) =>
        error
          ? reject(new Error("no Claude Code login in the keychain"))
          : resolve(stdout),
    );
  });
}

/**
 * The access token of Claude Code's own login, read as bb's Claude Code
 * provider reads it for its usage panel. It's never refreshed here, since
 * Claude Code owns the refresh token, and never logged.
 */
export async function readClaudeCodeToken(
  read: () => Promise<string> = () =>
    process.platform === "darwin"
      ? keychainSecret(CLAUDE_CODE_KEYCHAIN_SERVICE)
      : readFile(CLAUDE_CODE_CREDENTIALS_FILE, "utf8"),
  now = Date.now(),
): Promise<string> {
  let login: Json;
  try {
    login = JSON.parse(await read())?.claudeAiOauth;
  } catch {
    throw new Error("no readable Claude Code login");
  }
  const { accessToken, expiresAt } = login ?? {};
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new Error("no Claude Code OAuth login");
  }
  if (typeof expiresAt === "number" && !(expiresAt > now)) {
    throw new Error("Claude Code's login has expired until it refreshes");
  }
  return accessToken;
}

/** A Claude account's extra usage, null when it's off or unreadable. */
export function parseClaudeExtraUsage(
  reply: Json,
): Omit<ExtraUsage, "provider"> | null {
  const extra = reply?.extra_usage;
  if (extra?.is_enabled !== true) return null;
  const amount = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value / 100
      : null;
  const used = amount(extra.used_credits);
  if (used === null) return null;
  return {
    used,
    limit: amount(extra.monthly_limit),
    currency:
      typeof extra.currency === "string" && extra.currency !== ""
        ? extra.currency.toUpperCase()
        : "USD",
  };
}

export default function plugin(bb: BbPluginApi): void {
  bb.settings.define({
    redThreshold: {
      type: "number",
      label: "Red at, %",
      description:
        "Usage at or above this percentage turns red in the footer and on the usage cards.",
      experimental_schema: z.number().int().min(1).max(100),
      default: DEFAULT_RED_THRESHOLD,
    },
  });

  const readSources = createSourceReader(bb);
  const secretsDir = path.join(
    bb.server.experimental_dataDir,
    "plugins",
    POOL_PLUGIN_ID,
    "secrets",
    "accounts",
  );
  const resetCache = new Map<
    string,
    { readAt: number; value: Promise<AccountResets | null> }
  >();
  /** When extra usage was last read, for the usage panel's "updated". */
  let extraObservedAt: number | null = null;
  let extraCache: {
    readAt: number;
    value: Promise<ExtraUsage[]>;
  } | null = null;
  /** Accounts with a spend on its way. */
  const spending = new Set<string>();
  let claudeAgent: { readAt: number; value: Promise<string> } | null = null;
  let codexPlanCache: { expiresAt: number; plans: Map<string, Plan> } | null =
    null;
  let snapshot: { readAt: number; value: UsageSnapshot } | null = null;
  let pending: Promise<UsageSnapshot> | null = null;

  async function codexPlans(
    accounts: readonly PoolAccount[],
  ): Promise<Map<string, Plan>> {
    const now = Date.now();
    if (codexPlanCache !== null && codexPlanCache.expiresAt > now) {
      return codexPlanCache.plans;
    }
    let plans = new Map<string, Plan>();
    try {
      plans = await fetchOfficialCodexPlans(bb, accounts);
    } catch (cause) {
      bb.log.debug(
        `Could not supplement Codex tiers from provider usage: ${errorMessage(cause)}`,
      );
    }
    codexPlanCache = { expiresAt: now + CODEX_PLAN_CACHE_MS, plans };
    return plans;
  }

  /**
   * Headers with the access token Account Pooler stores for the account.
   * The token is never refreshed, since Account Pooler owns the refresh
   * token, and never logged.
   */
  async function authHeaders(
    account: PoolAccount,
  ): Promise<Record<string, string>> {
    if (!/^[\w-]+$/u.test(account.id)) throw new Error("unexpected account id");
    let secret: Json;
    try {
      secret = JSON.parse(
        await readFile(
          path.join(secretsDir, `account-${account.id}.json`),
          "utf8",
        ),
      );
    } catch {
      // The parser's message would quote the file, which holds the token.
      throw new Error("no readable stored login");
    }
    const { kind, accessToken, expiresAt } = secret ?? {};
    if (
      kind !== "oauth" ||
      typeof accessToken !== "string" ||
      (expiresAt !== null && !(expiresAt > Date.now()))
    ) {
      throw new Error("no live OAuth login");
    }
    const auth = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    };
    if (account.provider === "codex") {
      if (account.codexAccountId === undefined) {
        throw new Error("no ChatGPT account id");
      }
      return {
        ...auth,
        "chatgpt-account-id": account.codexAccountId,
        originator: "bb",
      };
    }
    return {
      ...auth,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": await claudeUserAgent(),
    };
  }

  /** Claude reports resets only to Claude Code, which it knows by this. */
  function claudeUserAgent(): Promise<string> {
    if (
      claudeAgent === null ||
      Date.now() - claudeAgent.readAt >= RESETS_TTL_MS
    ) {
      const value = (async () => {
        const { providers } = await bb.sdk.system.providerStates({
          signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
        });
        return /\d+\.\d+\.\d+/u.exec(
          providers.find(
            ({ providerId }) => providerId === POOL_PROVIDERS.claude,
          )?.installedVersion ?? "",
        )?.[0];
      })()
        .catch(() => undefined)
        .then(
          (version) => `claude-cli/${version ?? "2.1.284"} (external, cli)`,
        );
      claudeAgent = { readAt: Date.now(), value };
    }
    return claudeAgent.value;
  }

  async function readResets(
    account: PoolAccount,
    headers: Record<string, string>,
  ): Promise<AccountResets> {
    const now = Date.now();
    if (account.provider === "codex") {
      const [usage, list] = await Promise.all([
        fetchJson(`${CODEX_API}/usage`, headers),
        fetchJson(`${CODEX_API}/rate-limit-reset-credits`, headers),
      ]);
      const count: unknown =
        usage.rate_limit_reset_credits?.available_count ?? 0;
      if (!isCount(count)) throw new Error("unreadable reset count");
      // The credit that expires first; a Codex reset clears every window.
      const next = (list.credits as Json[])
        .filter(
          (credit) =>
            credit?.status === "available" &&
            credit.is_supported_by_plan !== false &&
            typeof credit.id === "string" &&
            isOpen(credit.expires_at, now),
        )
        .map((credit) => ({
          id: credit.id as string,
          expiresAt: parseTime(credit.expires_at),
          clears: null,
        }))
        .sort(
          (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || 0,
        )[0];
      return { count, next: next ?? null };
    }
    const program = (
      await fetchJson(
        `${CLAUDE_API}/oauth/usage?cedar_ember=1&skip_spend=1`,
        headers,
      )
    ).cedar_ember;
    if (!program?.eligible || !Array.isArray(program.grants)) {
      return { count: 0, next: null };
    }
    const open: Json[] = program.grants.filter(
      (grant: Json) =>
        grant?.paused !== true &&
        isCount(grant.resets_left) &&
        isOpen(grant.ends_at, now),
    );
    // The grant Claude Code would claim.
    const grant = open.find(
      ({ id, usable_now, resets_left }) =>
        typeof id === "string" &&
        id === program.next_grant_id &&
        usable_now === true &&
        resets_left > 0,
    );
    return {
      count: open.reduce((sum, { resets_left }) => sum + resets_left, 0),
      next:
        grant === undefined
          ? null
          : {
              id: grant.id,
              expiresAt: parseTime(grant.ends_at),
              clears: (Array.isArray(grant.clears) ? grant.clears : []).flatMap(
                (name: unknown) => CLAUDE_WINDOWS.get(String(name)) ?? [],
              ),
            },
    };
  }

  /**
   * Read again after ten minutes, showing the last read meanwhile. A failed
   * read shows none, since the login may have ended.
   */
  function cachedResets(account: PoolAccount): Promise<AccountResets | null> {
    const hit = resetCache.get(account.id);
    if (hit !== undefined && Date.now() - hit.readAt < RESETS_TTL_MS) {
      return hit.value;
    }
    const value = authHeaders(account)
      .then((headers) => readResets(account, headers))
      .catch((cause: unknown) => {
        bb.log.debug(
          `Could not read resets for ${account.provider} account ${account.id}: ${errorMessage(cause)}`,
        );
        return null;
      });
    resetCache.set(account.id, { readAt: Date.now(), value });
    return hit?.value ?? value;
  }

  /**
   * Claude's extra usage on Claude Code's own login, read again after two
   * minutes. A failed read shows none, as resets do.
   */
  function cachedExtraUsage(): Promise<ExtraUsage[]> {
    const hit = extraCache;
    if (hit !== null && Date.now() - hit.readAt < EXTRA_USAGE_TTL_MS) {
      return hit.value;
    }
    const value = (async (): Promise<ExtraUsage[]> => {
      const accessToken = await readClaudeCodeToken();
      const reading = parseClaudeExtraUsage(
        await fetchJson(`${CLAUDE_API}/oauth/usage`, {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": await claudeUserAgent(),
        }),
      );
      extraObservedAt = Date.now();
      return reading === null
        ? []
        : [{ provider: POOL_PROVIDERS.claude, ...reading }];
    })().catch((cause: unknown) => {
      bb.log.debug(`Could not read Claude extra usage: ${errorMessage(cause)}`);
      return [];
    });
    extraCache = { readAt: Date.now(), value };
    return hit?.value ?? value;
  }

  /**
   * Spends the account's next reset as Claude Code and Codex do. A retry
   * sends the same request for the same reset, which the provider applies
   * once, even after a reload.
   */
  async function spendReset(
    account: PoolAccount,
    requestId: string,
  ): Promise<SpendOutcome> {
    let headers: Record<string, string>;
    try {
      headers = await authHeaders(account);
    } catch (cause) {
      return {
        outcome: "refused",
        message: `Pool Usage can't use the account's login: ${errorMessage(cause)}. Nothing was used.`,
      };
    }
    const key = `${SENT_RESET_KEY}${account.id}:${requestId}`;
    const sent = await bb.storage.kv.get<SentReset>(key);
    const resetId =
      sent?.resetId ?? (await readResets(account, headers)).next?.id;
    if (resetId === undefined) {
      return {
        outcome: "refused",
        message: "The account has no reset to use right now.",
      };
    }
    let url = `${CODEX_API}/rate-limit-reset-credits/consume`;
    let body: object = { redeem_request_id: requestId, credit_id: resetId };
    if (account.provider === "claude") {
      const profile = await fetchJson(`${CLAUDE_API}/oauth/profile`, headers);
      const organization: unknown = profile.organization?.uuid;
      if (typeof organization !== "string") throw new Error("no organization");
      url = `${CLAUDE_API}/organizations/${encodeURIComponent(organization)}/reset_rate_limits`;
      body = {
        program: "cedar_ember",
        grant_id: resetId,
        request_id: requestId,
      };
    }
    await bb.storage.kv.set(key, { resetId, sentAt: Date.now() });
    const reply = await fetchJson(url, headers, body);
    const answer = String(reply?.code ?? reply?.result);
    if (answer === "reset" || (sent !== undefined && REPEATS.has(answer))) {
      const usedAt = Date.now();
      await bb.storage.kv.set(key, { resetId, sentAt: usedAt, usedAt });
      return { outcome: "reset" };
    }
    if (!REFUSALS.has(answer)) throw new Error(`the provider said ${answer}`);
    return {
      outcome: "refused",
      message:
        sent !== undefined
          ? "The reset isn't available any more. The earlier try may have used it."
          : `${account.provider === "claude" ? "Claude" : "Codex"} kept the reset (${answer}). Nothing was used.`,
    };
  }

  /** When this plugin last reset each account, over the past day. */
  async function resetsUsed(): Promise<Map<string, number>> {
    const used = new Map<string, number>();
    for (const key of await bb.storage.kv.list(SENT_RESET_KEY)) {
      const usedAt = (await bb.storage.kv.get<SentReset>(key))?.usedAt;
      const accountId = key.slice(SENT_RESET_KEY.length).split(":")[0];
      if (usedAt !== undefined && accountId !== undefined) {
        used.set(accountId, Math.max(used.get(accountId) ?? 0, usedAt));
      }
    }
    return used;
  }

  /** Forgets the resets that retries no longer need. */
  async function pruneSentResets(): Promise<void> {
    for (const key of await bb.storage.kv.list(SENT_RESET_KEY)) {
      const sent = await bb.storage.kv.get<SentReset>(key);
      if (!(Date.now() - (sent?.sentAt ?? 0) < SENT_RESET_TTL_MS)) {
        await bb.storage.kv.delete(key);
      }
    }
  }

  async function readPoolStatus(): Promise<PoolStatus> {
    return bb.sdk.plugins.callRpc({
      pluginId: POOL_PLUGIN_ID,
      method: "status.get",
      input: null,
      outputSchema: poolStatusSchema,
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  }

  /**
   * Account Pooler's accounts for the providers they serve. `served` also
   * names the providers a parent bb server's pool serves, whose accounts
   * this server can't see.
   */
  async function readPool(): Promise<UsageSnapshot & { served: Set<string> }> {
    let status: PoolStatus;
    try {
      status = await readPoolStatus();
    } catch (cause) {
      bb.log.debug(
        `Could not read Account Pooler status: ${errorMessage(cause)}`,
      );
      return { providers: [], accounts: [], served: new Set() };
    }
    const routes = poolProviderSchema.options.map((provider) => ({
      provider,
      route: poolRoute(status, provider),
    }));
    const served = new Set(
      routes
        .filter(({ route }) => route !== null)
        .map(({ provider }) => POOL_PROVIDERS[provider]),
    );
    const pooled = routes
      .filter(({ route }) => route === "accounts")
      .map(({ provider }) => provider);
    const accounts = status.accounts.filter((account) =>
      pooled.includes(account.provider),
    );
    const spendable = accounts.filter(
      ({ enabled, kind }) => enabled && kind === "oauth",
    );
    for (const id of resetCache.keys()) {
      if (!spendable.some((account) => account.id === id)) {
        resetCache.delete(id);
      }
    }
    if (accounts.length === 0) return { providers: [], accounts: [], served };
    // Resets come from the providers, so they load alongside the rest.
    const pendingResets = Promise.all(
      spendable.map(async (account) => [
        account.id,
        await cachedResets(account),
      ]),
    ).then((entries) => new Map(entries as [string, AccountResets | null][]));
    const plans = await codexPlans(accounts);
    const switchThreshold = await fetchSwitchThreshold(bb);
    const accountResets = await pendingResets;
    const used = await resetsUsed();
    return {
      served,
      providers: pooled.map((provider) => ({
        id: POOL_PROVIDERS[provider],
        switchThreshold,
      })),
      accounts: accounts.map((account) => {
        const normalized = normalizeAccount(account, {
          now: Date.now(),
          planFallback:
            account.provider === "codex" && account.email !== null
              ? (plans.get(normalizedEmail(account.email)) ?? null)
              : null,
          resetUsedAt: used.get(account.id),
        });
        const own = accountResets.get(account.id);
        if (own === undefined || own === null) return normalized;
        const { count, next } = own;
        return count > 0 && next !== null
          ? {
              ...normalized,
              availableResets: count,
              reset: { expiresAt: next.expiresAt, clears: next.clears },
            }
          : { ...normalized, availableResets: count };
      }),
    };
  }

  async function readSnapshot(): Promise<UsageSnapshot> {
    const pool = await readPool();
    const [accounts, extraUsage] = await Promise.all([
      readSources(pool.served),
      cachedExtraUsage(),
    ]);
    const providers = [...new Set(accounts.map(({ provider }) => provider))];
    return {
      ...(extraUsage.length === 0 ? {} : { extraUsage }),
      providers: [
        ...pool.providers,
        ...providers.map((id) => ({
          id,
          switchThreshold: SOURCE_SWITCH_THRESHOLD,
        })),
      ],
      accounts: [...pool.accounts, ...accounts],
    };
  }

  bb.rpc.register(rpcContract, {
    "provider-usage.v1.listResources": async () => {
      const [extra] = await (extraCache?.value ?? cachedExtraUsage());
      return {
        label: "Claude extra usage",
        resources:
          extra === undefined
            ? []
            : [
                {
                  accountKey: null,
                  id: EXTRA_RESOURCE_ID,
                  providerId: POOL_PROVIDERS.claude,
                  label: "Extra usage",
                  scope: { kind: "shared" as const },
                },
              ],
      };
    },
    "provider-usage.v1.getResource": async ({ refresh }) => {
      if (refresh) extraCache = null;
      const [extra] = await cachedExtraUsage();
      if (extra === undefined) {
        return {
          accountKey: null,
          observedAt: extraObservedAt,
          usage: {
            status: "unauthenticated" as const,
            plan: null,
            accountEmail: null,
            planLabel: null,
          },
        };
      }
      const money = (amount: number) =>
        formatMoney(amount, extra.currency, extra.used >= 1000 ? 0 : 2);
      return {
        accountKey: null,
        observedAt: extraObservedAt,
        usage: {
          status: "ok" as const,
          plan: null,
          accountEmail: "Extra usage",
          planLabel:
            extra.limit === null
              ? `${money(extra.used)} spent`
              : `${money(extra.used)} / ${money(extra.limit)}`,
          windows:
            extra.limit === null || extra.limit === 0
              ? []
              : [
                  {
                    kind: "custom" as const,
                    id: "monthly",
                    label: "Month",
                    usedPercent: (extra.used / extra.limit) * 100,
                    resetsAt: null,
                    model: null,
                    cost: null,
                  },
                ],
        },
      };
    },
    usage_get: async () => {
      if (snapshot !== null && Date.now() - snapshot.readAt < SNAPSHOT_TTL_MS) {
        return snapshot.value;
      }
      if (pending === null) {
        const read: Promise<UsageSnapshot> = readSnapshot()
          .then((value) => {
            // A reset spent during the read drops it.
            if (pending === read) snapshot = { readAt: Date.now(), value };
            return value;
          })
          .finally(() => {
            if (pending === read) pending = null;
          });
        pending = read;
      }
      return pending;
    },
    reset_use: async ({ accountId, requestId }): Promise<SpendOutcome> => {
      const status = await readPoolStatus().catch(() => {
        throw new Error("Couldn't reach Account Pooler. Nothing was used.");
      });
      const account = status.accounts.find(
        ({ id, enabled, kind }) =>
          id === accountId && enabled && kind === "oauth",
      );
      if (account === undefined) {
        return {
          outcome: "refused",
          message: "Account Pooler no longer serves that account.",
        };
      }
      if (spending.has(accountId)) {
        return {
          outcome: "refused",
          message: "A reset for this account is already on its way.",
        };
      }
      spending.add(accountId);
      let outcome: SpendOutcome | undefined;
      try {
        outcome = await spendReset(account, requestId);
        return outcome;
      } catch (cause) {
        bb.log.debug(
          `Could not spend a reset for account ${accountId}: ${errorMessage(cause)}`,
        );
        throw new Error(
          "Couldn't use the reset. Trying again won't use a second one.",
        );
      } finally {
        // Account Pooler reads what a spend that wasn't refused may have
        // cleared now, not at its next poll.
        if (outcome?.outcome !== "refused") {
          await bb.sdk.plugins
            .callRpc({
              pluginId: POOL_PLUGIN_ID,
              method: "account.refreshUsage",
              input: { accountId },
              outputSchema: z.unknown(),
              signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
            })
            .catch((cause: unknown) =>
              bb.log.debug(
                `Could not refresh account ${accountId}: ${errorMessage(cause)}`,
              ),
            );
        }
        spending.delete(accountId);
        // The next read shows what the spend changed.
        resetCache.delete(accountId);
        snapshot = null;
        pending = null;
        await pruneSentResets().catch((cause: unknown) =>
          bb.log.debug(`Could not prune sent resets: ${errorMessage(cause)}`),
        );
      }
    },
  });
}
