import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

// Claude Code's login, which a test hands out; none by default, so no test
// reads the real keychain.
const claudeCodeLogin = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    done: (error: Error | null, stdout: string) => void,
  ) =>
    claudeCodeLogin.value === null
      ? done(new Error("not found"), "")
      : done(null, claudeCodeLogin.value),
}));
import plugin, {
  accountPlan,
  normalizeAccount,
  parseClaudeExtraUsage,
  readClaudeCodeToken,
  sourceAccount,
  type PoolAccount,
  type UsageSnapshot,
} from "./server";
import { formatPercent, summarizeUsage } from "./usage-model";

function account(overrides: Partial<PoolAccount> = {}): PoolAccount {
  return {
    id: "6d4a6287-16cb-42eb-9977-69132be5fddb",
    provider: "claude",
    kind: "oauth",
    label: "Personal",
    email: "account@example.com",
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    enabled: true,
    priority: 0,
    fiveHourUtilization: 0.42,
    fiveHourResetAt: 1_800_000,
    fiveHourStatus: "allowed",
    sevenDayUtilization: 0.81,
    sevenDayResetAt: 604_800_000,
    sevenDayStatus: "allowed",
    limitWindows: [],
    observedAt: 123_000,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...overrides,
  };
}

const codexAccount = (overrides: Partial<PoolAccount> = {}) =>
  account({
    provider: "codex",
    subscriptionType: "pro",
    rateLimitTier: null,
    fiveHourUtilization: null,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    ...overrides,
  });

describe("accountPlan", () => {
  it("weighs Claude plans by their usage multiplier", () => {
    expect(accountPlan(account())).toEqual({ tier: "Max 20x", weight: 20 });
    expect(
      accountPlan(account({ subscriptionType: "max", rateLimitTier: null })),
    ).toEqual({ tier: "Max", weight: 5 });
    expect(
      accountPlan(
        account({
          subscriptionType: "pro",
          rateLimitTier: "default_claude_pro",
        }),
      ),
    ).toEqual({ tier: "Pro", weight: 1 });
  });

  it("weighs Team seats at 1.25x Pro, premium seats at 5x that", () => {
    expect(
      accountPlan(
        account({
          subscriptionType: "claude_team",
          rateLimitTier: "default_claude_max_5x",
        }),
      ),
    ).toEqual({ tier: "Team Premium", weight: 6.25 });
    expect(
      accountPlan(
        account({ subscriptionType: "claude_team", rateLimitTier: null }),
      ),
    ).toEqual({ tier: "Team", weight: 1.25 });
  });

  it("weighs Codex plans by OpenAI's multipliers", () => {
    expect(accountPlan(codexAccount())).toEqual({
      tier: "Pro 20x",
      weight: 20,
    });
    expect(accountPlan(codexAccount({ subscriptionType: "prolite" }))).toEqual({
      tier: "Pro 5x",
      weight: 5,
    });
    expect(accountPlan(codexAccount({ subscriptionType: "Plus" }))).toEqual({
      tier: "Plus",
      weight: 1,
    });
    expect(
      accountPlan(
        codexAccount({ subscriptionType: "self_serve_business_prolite" }),
      ),
    ).toEqual({ tier: "Biz Pro Lite", weight: 5 });
    expect(accountPlan(codexAccount({ subscriptionType: "business" }))).toEqual({
      tier: "Business",
      weight: 1,
    });
  });

  it("keeps API keys out of the subscription total", () => {
    expect(
      accountPlan(
        account({
          kind: "api-key",
          subscriptionType: null,
          rateLimitTier: null,
        }),
      ),
    ).toEqual({ tier: "API", weight: 0 });
  });

  it("returns null for an unknown plan", () => {
    expect(
      accountPlan(account({ subscriptionType: null, rateLimitTier: null })),
    ).toBeNull();
    expect(accountPlan(codexAccount({ subscriptionType: null }))).toBeNull();
  });
});

describe("normalizeAccount", () => {
  const options = { now: 123_000 };

  it("includes Business Pro Lite capacity in a mixed Codex pool", () => {
    const accounts = [
      { subscriptionType: "self_serve_business_prolite", utilization: 0.06 },
      { subscriptionType: "self_serve_business_prolite", utilization: 0 },
      { subscriptionType: "pro", utilization: 0.49 },
      { subscriptionType: "prolite", utilization: 0.67 },
    ].map(({ subscriptionType, utilization }, index) =>
      normalizeAccount(
        codexAccount({
          id: `codex-${index}`,
          subscriptionType,
          limitWindows: [
            {
              slot: "primary",
              windowMinutes: 10_080,
              utilization,
              resetAt: 604_800_000,
              status: "allowed",
            },
          ],
        }),
        options,
      ),
    );
    const [usage] = summarizeUsage(
      { providers: [{ id: "codex", switchThreshold: 0.98 }], accounts },
      options.now,
    );

    expect(usage?.used).toBeCloseTo(0.3842857143);
    expect(formatPercent(usage!.used!)).toBe("38%");
  });

  it("keeps each window's reading", () => {
    expect(normalizeAccount(account(), options)).toEqual({
      id: "6d4a6287-16cb-42eb-9977-69132be5fddb",
      provider: "claude-code",
      label: "Personal",
      email: "account@example.com",
      plan: "Max 20x",
      weight: 20,
      disabled: false,
      offline: null,
      heldUntil: null,
      blocked: false,
      windows: [
        {
          minutes: 300,
          utilization: 0.42,
          resetAt: 1_800_000,
          rejected: false,
        },
        {
          minutes: 10_080,
          utilization: 0.81,
          resetAt: 604_800_000,
          rejected: false,
        },
      ],
    });
  });

  it("marks a rejected window and drops an unreported one", () => {
    const normalized = normalizeAccount(
      account({
        fiveHourUtilization: null,
        fiveHourResetAt: null,
        fiveHourStatus: null,
        sevenDayStatus: "rejected",
        status: "exhausted",
      }),
      options,
    );

    expect(normalized.blocked).toBe(true);
    expect(normalized.windows).toEqual([
      {
        minutes: 10_080,
        utilization: 0.81,
        resetAt: 604_800_000,
        rejected: true,
      },
    ]);
  });

  it("adds Codex limit windows without repeating a known length", () => {
    const normalized = normalizeAccount(
      codexAccount({
        sevenDayUtilization: 0.5,
        sevenDayResetAt: 700_000,
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 10_080,
            utilization: 0.67,
            resetAt: 900_000,
            status: null,
          },
          {
            slot: "secondary",
            windowMinutes: null,
            utilization: 0.22,
            resetAt: 300_000,
            status: null,
          },
        ],
      }),
      options,
    );

    expect(normalized.windows).toEqual([
      { minutes: 10_080, utilization: 0.5, resetAt: 700_000, rejected: false },
      { minutes: null, utilization: 0.22, resetAt: 300_000, rejected: false },
    ]);
  });

  it("says why an account's quota can't be trusted", () => {
    expect(
      normalizeAccount(
        account({ status: "error", error: "OAuth token expired" }),
        options,
      ).offline,
    ).toBe("login error");
    expect(
      normalizeAccount(
        account({ status: "error", error: "upstream returned 500" }),
        options,
      ).offline,
    ).toBe("error");
    expect(
      normalizeAccount(account({ observedAt: null }), options).offline,
    ).toBe("no data");
    expect(
      normalizeAccount(account({ observedAt: 0 }), { now: 31 * 60_000 })
        .offline,
    ).toBe("no data");
    // Nothing reaches a held or exhausted account to change its reading.
    for (const status of ["held", "exhausted"] as const) {
      expect(
        normalizeAccount(account({ status, observedAt: 0 }), {
          now: 31 * 60_000,
        }).offline,
      ).toBeNull();
    }
    // A reset clears what an earlier reading shows.
    expect(
      normalizeAccount(account({ status: "exhausted", observedAt: 0 }), {
        now: 60_000,
        resetUsedAt: 1,
      }).offline,
    ).toBe("no data");
    expect(
      normalizeAccount(account({ observedAt: 2 }), {
        now: 60_000,
        resetUsedAt: 1,
      }).offline,
    ).toBeNull();
  });

  it("doesn't flag accounts that stay out of the total", () => {
    const disabled = normalizeAccount(
      account({ enabled: false, observedAt: null }),
      options,
    );
    const apiKey = normalizeAccount(
      account({
        kind: "api-key",
        subscriptionType: null,
        rateLimitTier: null,
        status: "error",
        error: "invalid api key",
      }),
      options,
    );

    expect(disabled).toMatchObject({ disabled: true, offline: null });
    expect(apiKey).toMatchObject({ weight: 0, offline: null });
  });

  it("falls back to a known plan, then to an unnamed single seat", () => {
    const source = codexAccount({ subscriptionType: null });

    expect(
      normalizeAccount(source, {
        ...options,
        planFallback: { tier: "Pro 20x", weight: 20 },
      }),
    ).toMatchObject({ weight: 20 });
    expect(normalizeAccount(source, options)).toMatchObject({ weight: 1 });
  });
});

describe("sourceAccount", () => {
  const usage = {
    status: "ok",
    plan: { id: "max", multiplier: 20 },
    windows: [
      {
        kind: "five-hour" as const,
        usedPercent: 40,
        resetsAt: "2026-01-01T05:00:00.000Z",
        model: null,
      },
      {
        kind: "weekly" as const,
        usedPercent: 90,
        resetsAt: null,
        model: "opus",
      },
    ],
  };

  it("keeps the account-wide windows, weighted by the plan", () => {
    expect(sourceAccount("a", "claude-code", usage)).toEqual({
      id: "a",
      provider: "claude-code",
      weight: 20,
      disabled: false,
      offline: null,
      heldUntil: null,
      blocked: false,
      windows: [
        {
          minutes: 300,
          utilization: 0.4,
          resetAt: Date.parse("2026-01-01T05:00:00.000Z"),
          rejected: false,
        },
      ],
    });
  });

  it("falls back to the plan's official multiplier, then to 1x", () => {
    const plan = (id: string) => ({ ...usage, plan: { id, multiplier: null } });

    expect(sourceAccount("a", "codex", plan("prolite"))?.weight).toBe(5);
    expect(sourceAccount("a", "cursor", plan("ultra"))?.weight).toBe(1);
  });

  it("flags an expired login and skips anything unreadable", () => {
    expect(
      sourceAccount("a", "codex", { ...usage, status: "expired" }),
    ).toMatchObject({ offline: "login error", windows: [] });
    expect(
      sourceAccount("a", "codex", { ...usage, status: "unsupported" }),
    ).toBeNull();
    expect(sourceAccount("a", "codex", { ...usage, windows: [] })).toBeNull();
  });
});

function poolerRpc(accounts: PoolAccount[], switchThreshold = 0.95) {
  return async (request: { method: string }) =>
    request.method === "config.get" ? { switchThreshold } : { accounts };
}

const cursorUsage = {
  status: "ok",
  plan: null,
  windows: [{ kind: "custom", usedPercent: 30, resetsAt: null, model: null }],
};

/** Account Pooler plus one usage source with a Codex and a Cursor account. */
function hostWithSource(status: Record<string, unknown>) {
  return createFakePluginHost({
    pluginId: "pool-usage",
    sdk: {
      plugins: {
        experimental_discoverRpc: async () =>
          [{ pluginId: "account-pool" }, { pluginId: "provider-acp" }] as never,
        callRpc: async (request: {
          method: string;
          input?: unknown;
          outputSchema: { parse: (value: unknown) => unknown };
        }) => {
          const value =
            request.method === "config.get"
              ? { switchThreshold: 0.95 }
              : request.method === "status.get"
                ? status
                : request.method === "provider-usage.v1.listResources"
                  ? {
                      resources: ["codex", "cursor"].map((providerId) => ({
                        id: providerId,
                        accountKey: providerId,
                        providerId,
                        scope: { kind: "shared" },
                      })),
                    }
                  : {
                      accountKey: (request.input as { resourceId: string })
                        .resourceId,
                      usage: cursorUsage,
                    };
          return request.outputSchema.parse(value);
        },
      },
    },
  });
}

describe("plugin", () => {
  const CODEX_CREDITS_URL =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
  const REQUEST_ID = "9c1f4a2e-6b3d-4f8a-a7e5-2d9c8b1a0f3e";
  const credit = {
    id: "RateLimitResetCredit_1",
    status: "available",
    is_supported_by_plan: true,
    expires_at: "2026-10-22T20:28:26Z",
  };
  const dataDirs: string[] = [];

  beforeEach(() => {
    // Resets come from the providers, which only a test's own fetch reaches.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const dataDir of dataDirs.splice(0)) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  /** A bb data directory where Account Pooler keeps each account's login. */
  async function storeLogins(
    accounts: readonly PoolAccount[],
    expiresAt = Date.now() + 60 * 60_000,
  ) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "pool-usage-"));
    dataDirs.push(dataDir);
    const secretsDir = path.join(
      dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
    );
    await mkdir(secretsDir, { recursive: true });
    for (const { id } of accounts) {
      await writeFile(
        path.join(secretsDir, `account-${id}.json`),
        JSON.stringify({
          kind: "oauth",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt,
        }),
      );
    }
    // bb's hub tokens, which aren't the plugin's to read.
    await writeFile(path.join(secretsDir, "hub-token-host_1.json"), "{}");
    return dataDir;
  }

  const pooledCodex = (overrides: Partial<PoolAccount> = {}) =>
    codexAccount({
      id: "0b9e3f4c-5d1a-4c7e-8f2b-3a6d9e1c7b50",
      codexAccountId: "chatgpt-account",
      observedAt: Date.now(),
      ...overrides,
    });

  /** Codex, where the account has one reset until a spend takes it. */
  function codexWithReset() {
    let available = 1;
    return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url === `${CODEX_CREDITS_URL}/consume`) {
        available = 0;
        return Response.json({ code: "reset" });
      }
      return Response.json(
        url === CODEX_CREDITS_URL
          ? { credits: available > 0 ? [credit] : [] }
          : { rate_limit_reset_credits: { available_count: available } },
      );
    });
  }

  /** The Account Pooler methods the plugin called, in order. */
  const poolerMethods = (harness: {
    inspection: { sdk: { callsTo(path: string): unknown[][] } };
  }) =>
    harness.inspection.sdk
      .callsTo("plugins.callRpc")
      .map(([request]) => (request as { method: string }).method);

  it("reads Account Pooler's status and switch threshold", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      sdk: {
        plugins: { callRpc: poolerRpc([account({ observedAt: Date.now() })]) },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;

    expect(result.providers).toEqual([
      { id: "claude-code", switchThreshold: 0.95 },
    ]);
    expect(result.accounts).toMatchObject([{ weight: 20, offline: null }]);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(2);
    await harness.lifecycle.dispose();
  });

  it("serves every caller within 15 seconds from one read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      sdk: {
        plugins: { callRpc: poolerRpc([account({ observedAt: Date.now() })]) },
      },
    });
    await plugin(bb);

    await Promise.all([
      harness.behavior.callRpc("usage_get"),
      harness.behavior.callRpc("usage_get"),
    ]);
    vi.advanceTimersByTime(14_000);
    await harness.behavior.callRpc("usage_get");
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(2);

    vi.advanceTimersByTime(2_000);
    await harness.behavior.callRpc("usage_get");
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(4);
    await harness.lifecycle.dispose();
  });

  it("assumes Account Pooler's default threshold when it can't be read", async () => {
    const source = account({ observedAt: Date.now() });
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      sdk: {
        plugins: {
          callRpc: async (request: { method: string }) => {
            if (request.method === "config.get")
              throw new Error("unknown method");
            return { accounts: [source] };
          },
        },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;

    expect(result.providers).toEqual([
      { id: "claude-code", switchThreshold: 0.98 },
    ]);
    expect(result.accounts).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("uses official Codex usage as a tier fallback matched by email", async () => {
    const source = codexAccount({ subscriptionType: null });
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      sdk: {
        plugins: { callRpc: poolerRpc([source]) },
        hosts: {
          list: async () => [{ id: "host-1", status: "connected" }] as never,
        },
        system: {
          usageLimits: async () => ({
            codex: {
              status: "ok" as const,
              accountEmail: "ACCOUNT@example.com",
              planLabel: "Pro",
              windows: [],
            },
          }),
        },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;

    expect(result.accounts[0]).toMatchObject({ weight: 20 });
    expect(harness.inspection.sdk.callsTo("system.usageLimits")).toHaveLength(
      1,
    );
    await harness.lifecycle.dispose();
  });

  it("spends a reset, then reads the pool again", async () => {
    const accounts = [pooledCodex({ observedAt: Date.now() - 1_000 })];
    const accountId = accounts[0]!.id;
    const fetch = codexWithReset();
    vi.stubGlobal("fetch", fetch);
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      dataDir: await storeLogins(accounts),
      sdk: { plugins: { callRpc: poolerRpc(accounts) } },
    });
    await plugin(bb);

    const before = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;
    expect(before.accounts[0]).toMatchObject({
      availableResets: 1,
      offline: null,
    });

    // A second spend on the account waits for none, and spends none.
    expect(
      await Promise.all(
        [REQUEST_ID, crypto.randomUUID()].map((requestId) =>
          harness.behavior.callRpc("reset_use", { accountId, requestId }),
        ),
      ),
    ).toEqual([
      { outcome: "reset" },
      {
        outcome: "refused",
        message: "A reset for this account is already on its way.",
      },
    ]);
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({
      redeem_request_id: REQUEST_ID,
      credit_id: credit.id,
    });

    const after = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;
    // Account Pooler hasn't read the account since, so its usage is unknown.
    expect(after.accounts[0]).toMatchObject({
      availableResets: 0,
      offline: "no data",
    });
    expect(after.accounts[0]?.reset).toBeUndefined();
    // Account Pooler reads the cleared limits now, and the pool is read anew.
    expect(poolerMethods(harness)).toEqual([
      "status.get",
      "config.get",
      "status.get",
      "status.get",
      "account.refreshUsage",
      "status.get",
      "config.get",
    ]);
    expect(
      harness.inspection.sdk.callsTo("plugins.callRpc")[4]?.[0],
    ).toMatchObject({ pluginId: "account-pool", input: { accountId } });
    await harness.lifecycle.dispose();
  });

  it("says why it spent no reset", async () => {
    const accounts = [pooledCodex()];
    const accountId = accounts[0]!.id;
    let consume = () => Response.json({ code: "nothing_to_reset" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/consume")
          ? consume()
          : Response.json({ credits: [credit] }),
      ),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      dataDir: await storeLogins(accounts),
      sdk: { plugins: { callRpc: poolerRpc(accounts) } },
    });
    await plugin(bb);
    const spend = () =>
      harness.behavior.callRpc("reset_use", {
        accountId,
        requestId: crypto.randomUUID(),
      });

    expect(await spend()).toEqual({
      outcome: "refused",
      message: "Codex kept the reset (nothing_to_reset). Nothing was used.",
    });
    // A refusal may come with an error status.
    consume = () => Response.json({ code: "no_credit" }, { status: 400 });
    expect(await spend()).toEqual({
      outcome: "refused",
      message: "Codex kept the reset (no_credit). Nothing was used.",
    });
    // Nothing changed, so Account Pooler has nothing new to read.
    expect(poolerMethods(harness)).toEqual(["status.get", "status.get"]);

    consume = () => new Response(null, { status: 429 });
    await expect(spend()).rejects.toThrow(
      "Couldn't use the reset. Trying again won't use a second one.",
    );
    // The spend may have cleared the limits, so Account Pooler reads them.
    expect(poolerMethods(harness).at(-1)).toBe("account.refreshUsage");
    await expect(
      harness.behavior.callRpc("reset_use", { accountId, requestId: "1" }),
    ).rejects.toThrow();
    await harness.lifecycle.dispose();
  });

  it("spends no reset on an account Account Pooler doesn't serve", async () => {
    const accounts = [
      pooledCodex({ enabled: false }),
      pooledCodex({
        id: "a1b2c3d4-0000-4000-8000-000000000001",
        kind: "api-key",
      }),
    ];
    const fetch = codexWithReset();
    vi.stubGlobal("fetch", fetch);
    let reachable = true;
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      dataDir: await storeLogins(accounts),
      sdk: {
        plugins: {
          callRpc: async (request: { method: string }) => {
            if (!reachable) throw new Error("missing plugin");
            return poolerRpc(accounts)(request);
          },
        },
      },
    });
    await plugin(bb);

    for (const accountId of [
      ...accounts.map(({ id }) => id),
      "a1b2c3d4-0000-4000-8000-000000000002",
    ]) {
      expect(
        await harness.behavior.callRpc("reset_use", {
          accountId,
          requestId: crypto.randomUUID(),
        }),
      ).toEqual({
        outcome: "refused",
        message: "Account Pooler no longer serves that account.",
      });
    }
    reachable = false;
    await expect(
      harness.behavior.callRpc("reset_use", {
        accountId: accounts[0]!.id,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Couldn't reach Account Pooler. Nothing was used.");

    expect(fetch).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });

  it("claims Claude's next grant, and a retry the same one", async () => {
    const accounts = [account({ observedAt: Date.now() })];
    const organization = "11111111-2222-4333-8444-555555555555";
    const endsAt = "2027-01-01T00:00:00Z";
    let claims = 0;
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/oauth/profile")) {
          return Response.json({ organization: { uuid: organization } });
        }
        if (url.endsWith(`/${organization}/reset_rate_limits`)) {
          // The first claim's answer is lost; the retry finds the grant used.
          if (++claims === 1) throw new TypeError("fetch failed");
          return Response.json({ result: "already_used" });
        }
        return Response.json({
          cedar_ember: {
            eligible: true,
            next_grant_id: "g1",
            grants: [
              {
                id: "g1",
                resets_left: 2,
                usable_now: true,
                ends_at: endsAt,
                clears: ["five_hour", "seven_day"],
              },
              { id: "g2", resets_left: 5, paused: true },
              { id: "g3", resets_left: 1, ends_at: "2020-01-01T00:00:00Z" },
              { id: "g4", resets_left: -1 },
              { id: "g5", resets_left: 0.5 },
              "malformed",
            ],
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      dataDir: await storeLogins(accounts),
      sdk: {
        plugins: { callRpc: poolerRpc(accounts) },
        system: {
          providerStates: async () =>
            ({
              providers: [
                { providerId: "claude-code", installedVersion: "2.1.300" },
              ],
            }) as never,
        },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;
    expect(result.accounts[0]).toMatchObject({
      availableResets: 2,
      reset: { expiresAt: Date.parse(endsAt), clears: [300, 10_080] },
    });
    const spend = { accountId: accounts[0]!.id, requestId: REQUEST_ID };
    await expect(harness.behavior.callRpc("reset_use", spend)).rejects.toThrow(
      "Trying again won't use a second one.",
    );
    expect(await harness.behavior.callRpc("reset_use", spend)).toEqual({
      outcome: "reset",
    });
    const claimBodies = fetch.mock.calls
      .filter(([input]) => String(input).endsWith("/reset_rate_limits"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(claimBodies).toEqual([
      { program: "cedar_ember", grant_id: "g1", request_id: REQUEST_ID },
      { program: "cedar_ember", grant_id: "g1", request_id: REQUEST_ID },
    ]);
    // Claude reports resets only to the Claude Code that bb runs.
    expect(
      (fetch.mock.calls[0]![1]?.headers as Record<string, string>)[
        "user-agent"
      ],
    ).toBe("claude-cli/2.1.300 (external, cli)");
    await harness.lifecycle.dispose();
  });

  it("retries a Codex spend with the credit it sent first, even after a reload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const accounts = [pooledCodex()];
    const accountId = accounts[0]!.id;
    let consumed = 0;
    const fetch = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/consume")) {
          return ++consumed === 1
            ? new Response(null, { status: 502 })
            : Response.json({ code: "already_redeemed" });
        }
        if (url !== CODEX_CREDITS_URL) {
          return Response.json({
            rate_limit_reset_credits: { available_count: 2 },
          });
        }
        return Response.json({
          credits:
            consumed > 0
              ? [{ ...credit, id: "later" }]
              : [
                  {
                    ...credit,
                    id: "later",
                    expires_at: "2027-06-01T00:00:00Z",
                  },
                  credit,
                  { ...credit, id: "unsupported", is_supported_by_plan: false },
                  {
                    ...credit,
                    id: "expired",
                    expires_at: "2020-01-01T00:00:00Z",
                  },
                ],
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      dataDir: await storeLogins(accounts, Date.now() + 48 * 60 * 60_000),
      sdk: { plugins: { callRpc: poolerRpc(accounts) } },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;
    expect(result.accounts[0]).toMatchObject({
      availableResets: 2,
      reset: { expiresAt: Date.parse(credit.expires_at), clears: null },
    });
    const spend = { accountId, requestId: REQUEST_ID };
    await expect(
      harness.behavior.callRpc("reset_use", spend),
    ).rejects.toThrow();
    const reloaded = await harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.behavior.callRpc("reset_use", spend)).toEqual(
      { outcome: "reset" },
    );

    // To a first try, a redeemed credit is someone else's spend.
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const requestId = crypto.randomUUID();
    expect(
      await reloaded.harness.behavior.callRpc("reset_use", {
        accountId,
        requestId,
      }),
    ).toEqual({
      outcome: "refused",
      message: "Codex kept the reset (already_redeemed). Nothing was used.",
    });
    const consumeBodies = fetch.mock.calls
      .filter(([input]) => String(input).endsWith("/consume"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(consumeBodies).toEqual([
      { redeem_request_id: REQUEST_ID, credit_id: credit.id },
      { redeem_request_id: REQUEST_ID, credit_id: credit.id },
      { redeem_request_id: requestId, credit_id: "later" },
    ]);
    // A day on, the first request's retries are over.
    expect(await reloaded.bb.storage.kv.list("sentReset:")).toEqual([
      `sentReset:${accountId}:${requestId}`,
    ]);
    await reloaded.harness.lifecycle.dispose();
  });

  it("shows the last resets while it reads them again, and none it can't read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const accounts = [pooledCodex()];
    const fetch = codexWithReset();
    vi.stubGlobal("fetch", fetch);
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      dataDir: await storeLogins(accounts),
      sdk: { plugins: { callRpc: poolerRpc(accounts) } },
    });
    await plugin(bb);
    const read = async (after: number) => {
      vi.setSystemTime(Date.now() + after);
      const { accounts } = (await harness.behavior.callRpc(
        "usage_get",
      )) as UsageSnapshot;
      return accounts[0]?.availableResets;
    };

    expect(await read(0)).toBe(1);
    fetch.mockImplementation(async () =>
      Response.json({ rate_limit_reset_credits: { available_count: -1 } }),
    );
    expect(await read(10 * 60_000)).toBe(1);
    expect(await read(15_000)).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  it("skips logins it can't use, without refreshing or logging a token", async () => {
    const accounts = [pooledCodex(), account({ observedAt: Date.now() })];
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      dataDir: await storeLogins(accounts, Date.now() - 1),
      sdk: { plugins: { callRpc: poolerRpc(accounts) } },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;
    expect(
      result.accounts.map(({ availableResets }) => availableResets),
    ).toEqual([undefined, undefined]);
    expect(
      await harness.behavior.callRpc("reset_use", {
        accountId: accounts[0]!.id,
        requestId: REQUEST_ID,
      }),
    ).toEqual({
      outcome: "refused",
      message:
        "Pool Usage can't use the account's login: no live OAuth login. Nothing was used.",
    });
    expect(fetch).not.toHaveBeenCalled();
    const logs = harness.inspection.logEntries.map(({ message }) => message);
    expect(logs.join("\n")).not.toMatch(/access-token|refresh-token/u);
    await harness.lifecycle.dispose();
  });

  it("returns an empty state when Account Pooler is unavailable", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "pool-usage",
      sdk: {
        plugins: {
          callRpc: async () => {
            throw new Error("missing plugin");
          },
        },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;

    expect(result).toEqual({ providers: [], accounts: [] });
    await harness.lifecycle.dispose();
  });

  it("adds providers Account Pooler doesn't serve from usage sources", async () => {
    const { bb, harness } = hostWithSource({
      accounts: [codexAccount({ observedAt: Date.now() })],
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;

    expect(result.providers).toEqual([
      { id: "codex", switchThreshold: 0.95 },
      { id: "cursor", switchThreshold: 1 },
    ]);
    expect(result.accounts.map(({ provider }) => provider)).toEqual([
      "codex",
      "cursor",
    ]);
    await harness.lifecycle.dispose();
  });

  it("reads every provider from its source when routing is off", async () => {
    const { bb, harness } = hostWithSource({
      accounts: [codexAccount({ observedAt: Date.now() })],
      routing: { claude: true, codex: false },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;

    expect(result.providers.map(({ id }) => id)).toEqual(["codex", "cursor"]);
    expect(result.accounts).toMatchObject([
      { provider: "codex", weight: 1, windows: [{ utilization: 0.3 }] },
      { provider: "cursor" },
    ]);
    await harness.lifecycle.dispose();
  });

  it("reads Claude's extra usage with Claude Code's own login", async () => {
    claudeCodeLogin.value = JSON.stringify({
      claudeAiOauth: {
        accessToken: "claude-code-token",
        expiresAt: Date.now() + 60 * 60_000,
      },
    });
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input) === "https://api.anthropic.com/api/oauth/usage"
        ? Response.json({
            extra_usage: {
              is_enabled: true,
              used_credits: 55_834,
              monthly_limit: 700_000,
            },
          })
        : Response.json({}),
    );
    vi.stubGlobal("fetch", fetch);
    const { bb, harness } = createFakePluginHost({ pluginId: "pool-usage" });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;

    expect(result.extraUsage).toEqual([
      { provider: "claude-code", used: 558.34, limit: 7000, currency: "USD" },
    ]);
    const [, init] = fetch.mock.calls.find(
      ([url]) => String(url) === "https://api.anthropic.com/api/oauth/usage",
    ) as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: "Bearer claude-code-token",
    });
    claudeCodeLogin.value = null;
    await harness.lifecycle.dispose();
  });

  it("reports extra usage to bb's usage panel as a row of its own", async () => {
    claudeCodeLogin.value = JSON.stringify({
      claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 60_000 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          extra_usage: {
            is_enabled: true,
            used_credits: 60_640,
            monthly_limit: 700_000,
            currency: "GBP",
          },
        }),
      ),
    );
    const { bb, harness } = createFakePluginHost({ pluginId: "pool-usage" });
    await plugin(bb);

    expect(
      await harness.behavior.callRpc("provider-usage.v1.listResources", {}),
    ).toMatchObject({
      resources: [{ id: "claude-extra-usage", providerId: "claude-code" }],
    });
    expect(
      await harness.behavior.callRpc("provider-usage.v1.getResource", {
        resourceId: "claude-extra-usage",
        refresh: false,
      }),
    ).toMatchObject({
      accountKey: null,
      usage: {
        status: "ok",
        accountEmail: "Extra usage",
        planLabel: "£606.40 / £7,000.00",
        windows: [{ label: "Month", usedPercent: expect.closeTo(8.66, 2) }],
      },
    });
    claudeCodeLogin.value = null;
    await harness.lifecycle.dispose();
  });

  it("shows no extra usage without a Claude Code login", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "pool-usage" });
    await plugin(bb);

    const result = (await harness.behavior.callRpc(
      "usage_get",
    )) as UsageSnapshot;

    expect(result.extraUsage).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  it("defines one setting: the red threshold", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "pool-usage" });
    await plugin(bb);

    const descriptors = harness.inspection.registrations.settingsDescriptors;
    expect(Object.keys(descriptors)).toEqual(["redThreshold"]);
    expect(descriptors.redThreshold).toMatchObject({
      type: "number",
      label: "Red at, %",
      default: 80,
    });
    await expect(
      harness.behavior.setSettings({ redThreshold: 70 }),
    ).resolves.toBeUndefined();
    await expect(
      harness.behavior.setSettings({ redThreshold: 150 }),
    ).rejects.toThrow();
    await harness.lifecycle.dispose();
  });
});

describe("parseClaudeExtraUsage", () => {
  it("reads spending and the monthly cap from cents", () => {
    expect(
      parseClaudeExtraUsage({
        extra_usage: {
          is_enabled: true,
          used_credits: 55_834,
          monthly_limit: 700_000,
          utilization: 7.98,
        },
      }),
    ).toEqual({ used: 558.34, limit: 7000, currency: "USD" });
  });

  it("has no cap when Claude reports none", () => {
    expect(
      parseClaudeExtraUsage({
        extra_usage: { is_enabled: true, used_credits: 0, monthly_limit: null },
      }),
    ).toEqual({ used: 0, limit: null, currency: "USD" });
  });

  it("is null when extra usage is off or missing", () => {
    expect(
      parseClaudeExtraUsage({
        extra_usage: { is_enabled: false, used_credits: 10 },
      }),
    ).toBeNull();
    expect(parseClaudeExtraUsage({})).toBeNull();
    expect(
      parseClaudeExtraUsage({ extra_usage: { is_enabled: true } }),
    ).toBeNull();
  });
});

describe("readClaudeCodeToken", () => {
  const login = (claudeAiOauth: unknown) => async () =>
    JSON.stringify({ claudeAiOauth });

  it("returns the access token of a live login", async () => {
    await expect(
      readClaudeCodeToken(login({ accessToken: "t", expiresAt: 2_000 }), 1_000),
    ).resolves.toBe("t");
  });

  it("refuses an expired login instead of refreshing it", async () => {
    await expect(
      readClaudeCodeToken(login({ accessToken: "t", expiresAt: 500 }), 1_000),
    ).rejects.toThrow("expired");
  });

  it("refuses an unreadable login without quoting it", async () => {
    await expect(
      readClaudeCodeToken(async () => "secret-but-not-json", 1_000),
    ).rejects.toThrow(/^no readable Claude Code login$/);
  });
});
