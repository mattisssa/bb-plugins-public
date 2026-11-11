import { describe, expect, it } from "vitest";
import type { UsageAccount, UsageWindow } from "./server";
import {
  formatDuration,
  formatPercent,
  hasSpentQuota,
  isHot,
  redThreshold,
  summarizeUsage,
} from "./usage-model";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const THRESHOLD = 0.98;

function quota(
  minutes: number | null,
  utilization: number | null,
  resetAt: number | null = null,
  rejected = false,
): UsageWindow {
  return { minutes, utilization, resetAt, rejected };
}

function usageAccount(overrides: Partial<UsageAccount> = {}): UsageAccount {
  return {
    id: "account",
    provider: "claude-code",
    weight: 1,
    disabled: false,
    offline: null,
    heldUntil: null,
    blocked: false,
    windows: [],
    ...overrides,
  };
}

function summarize(accounts: UsageAccount[], switchThreshold = THRESHOLD) {
  const providers = ["claude-code", "codex"].map((id) => ({
    id,
    switchThreshold,
  }));
  return summarizeUsage({ providers, accounts }, NOW);
}

describe("summarizeUsage", () => {
  it("counts an account Account Pooler won't route to as used until it clears", () => {
    const [claude] = summarize([
      usageAccount({
        blocked: true,
        windows: [quota(300, 0.4, NOW + HOUR), quota(10_080, 0.3, NOW + DAY)],
      }),
    ]);

    expect(claude?.used).toBe(1);
    expect(claude?.steps[0]).toEqual({ at: NOW + HOUR, used: 0 });
  });

  it("returns one entry per provider with accounts, in the snapshot's order", () => {
    const usages = summarize([
      usageAccount({ id: "codex", provider: "codex" }),
      usageAccount({ id: "claude" }),
    ]);

    expect(usages.map(({ provider }) => provider)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(usages[1]?.accounts.map(({ id }) => id)).toEqual(["codex"]);
  });

  it("weighs accounts by their plan's capacity", () => {
    const [claude] = summarize([
      usageAccount({ id: "big", weight: 3, windows: [quota(300, 0.5)] }),
      usageAccount({ id: "small", weight: 1, windows: [quota(300, 0)] }),
    ]);

    expect(claude?.used).toBe(0.375);
  });

  it("lets a weekly window bind only once it runs low", () => {
    const [roomy] = summarize([
      usageAccount({ windows: [quota(300, 0.2), quota(10_080, 0.5)] }),
    ]);
    const [low] = summarize([
      usageAccount({ windows: [quota(300, 0.2), quota(10_080, 0.9)] }),
    ]);

    expect(roomy?.used).toBeCloseTo(0.2);
    expect(low?.used).toBeCloseTo(0.45);
  });

  it("reads a weekly-only account directly", () => {
    const [codex] = summarize([
      usageAccount({ provider: "codex", windows: [quota(10_080, 0.3)] }),
    ]);

    expect(codex?.used).toBeCloseTo(0.3);
  });

  it("treats a window past the switch threshold as spent", () => {
    const account = usageAccount({ windows: [quota(300, 0.97)] });

    expect(summarize([account], 0.95)[0]?.used).toBe(1);
    expect(summarize([account], 0.98)[0]?.used).toBeCloseTo(0.97);
  });

  it("treats a rejected window as spent whatever its utilization reads", () => {
    const [claude] = summarize([
      usageAccount({ windows: [quota(300, 0.1, NOW + HOUR, true)] }),
    ]);

    expect(claude?.used).toBe(1);
  });

  it("ignores a window that has already reset", () => {
    const [claude] = summarize([
      usageAccount({ windows: [quota(300, 0.9, NOW - MINUTE)] }),
    ]);

    expect(claude?.used).toBe(0);
  });

  it("counts offline accounts as used but not as spent", () => {
    const [claude] = summarize([
      usageAccount({ id: "broken", offline: "login error" }),
      usageAccount({ id: "working", windows: [quota(300, 0.5)] }),
    ]);

    expect(claude?.used).toBe(0.75);
    expect(claude?.spent).toBe(0.25);
  });

  it("leaves disabled accounts and API keys out of the total", () => {
    const [claude] = summarize([
      usageAccount({ id: "off", disabled: true, windows: [quota(300, 0.9)] }),
      usageAccount({ id: "api", weight: 0 }),
      usageAccount({ id: "on", windows: [quota(300, 0.25)] }),
    ]);

    expect(claude?.used).toBe(0.25);
    expect(claude?.accounts).toHaveLength(3);
  });

  it("has no total when no account counts", () => {
    const [claude] = summarize([
      usageAccount({ weight: 0, windows: [quota(300, 0.5)] }),
    ]);

    expect(claude).toMatchObject({ used: null, spent: 0, steps: [] });
  });

  it("lists the resets that lower usage, soonest first", () => {
    const [claude] = summarize([
      usageAccount({
        id: "first",
        windows: [quota(300, 0.99, NOW + 3 * HOUR)],
      }),
      usageAccount({
        id: "second",
        windows: [
          quota(300, 0.5, NOW + HOUR),
          quota(10_080, 0.3, NOW + 3 * DAY),
        ],
      }),
    ]);

    expect(claude?.used).toBe(0.75);
    expect(claude?.steps).toEqual([
      { at: NOW + HOUR, used: 0.5 },
      { at: NOW + 3 * HOUR, used: 0 },
    ]);
  });

  it("merges resets too small to show into the next visible one", () => {
    const [claude] = summarize([
      usageAccount({
        id: "big",
        weight: 200,
        windows: [quota(300, 0.5, NOW + 10 * HOUR)],
      }),
      usageAccount({ id: "a", windows: [quota(300, 1, NOW + HOUR)] }),
      usageAccount({ id: "b", windows: [quota(300, 1, NOW + 2 * HOUR)] }),
    ]);

    expect(claude?.steps.map(({ at }) => at)).toEqual([
      NOW + 2 * HOUR,
      NOW + 10 * HOUR,
    ]);
    expect(claude?.steps[0]?.used).toBeCloseTo(100 / 202);
  });

  it("looks a week ahead at most", () => {
    const [codex] = summarize([
      usageAccount({
        provider: "codex",
        windows: [quota(null, 0.5, NOW + 10 * DAY)],
      }),
    ]);

    expect(codex?.used).toBe(0.5);
    expect(codex?.steps).toEqual([]);
  });

  it("frees a held account when its hold ends", () => {
    const [claude] = summarize([
      usageAccount({
        heldUntil: NOW + 30 * MINUTE,
        windows: [quota(300, 0.1, NOW + 2 * HOUR)],
      }),
    ]);

    expect(claude?.used).toBe(1);
    expect(claude?.steps.map(({ at }) => at)).toEqual([
      NOW + 30 * MINUTE,
      NOW + 2 * HOUR,
    ]);
    expect(claude?.steps[0]?.used).toBeCloseTo(0.1);
  });

  it("forecasts resets only when quota is spent", () => {
    const [offline] = summarize([usageAccount({ offline: "no data" })]);
    const [spent] = summarize([usageAccount({ windows: [quota(300, 0.2)] })]);

    expect(offline?.used).toBe(1);
    expect(offline && hasSpentQuota(offline)).toBe(false);
    expect(spent && hasSpentQuota(spent)).toBe(true);
  });

  it("adds up the resets of the accounts that count", () => {
    const [claude] = summarize([
      usageAccount({ id: "ready", availableResets: 2 }),
      usageAccount({ id: "offline", offline: "error", availableResets: 1 }),
      usageAccount({ id: "unknown" }),
      usageAccount({ id: "disabled", disabled: true, availableResets: 4 }),
      usageAccount({ id: "api", weight: 0, availableResets: 4 }),
    ]);

    expect(claude?.availableResets).toBe(3);
  });
});

describe("resetPlan", () => {
  /** A weekly-only Codex account with a reset that clears everything. */
  function codexAccount(
    id: string,
    weight: number,
    used: number,
    resetsIn: number,
    expiresIn: number | null = 30 * DAY,
  ): UsageAccount {
    return usageAccount({
      id,
      provider: "codex",
      weight,
      windows: [quota(10_080, used, NOW + resetsIn)],
      reset: {
        expiresAt: expiresIn === null ? null : NOW + expiresIn,
        clears: null,
      },
    });
  }

  it("spends the reset that frees the most capacity until the limits reset", () => {
    const [codex] = summarize([
      codexAccount("soon", 20, 0.6, DAY),
      codexAccount("small", 1, 0.9, 6 * DAY),
      codexAccount("best", 5, 0.8, 5 * DAY),
    ]);

    // 5 x 80% for five days beats 20 x 60% for one and 1 x 90% for six.
    expect(codex?.resetPlan).toEqual({
      account: codex?.accounts[2],
      expiresAt: NOW + 30 * DAY,
      accountUsed: { before: expect.closeTo(0.8), after: 0 },
      used: {
        before: expect.closeTo(16.9 / 26),
        after: expect.closeTo(12.9 / 26),
      },
      freesAt: NOW + 5 * DAY,
    });
  });

  it("spends the reset that expires first of two worth about the same", () => {
    const later = codexAccount("later", 5, 0.8, 5 * DAY, 20 * DAY);
    const sooner = codexAccount("sooner", 5, 0.795, 5 * DAY, 10 * DAY);
    const undated = codexAccount("undated", 5, 0.8, 5 * DAY, null);

    for (const accounts of [
      [later, sooner],
      [sooner, later],
      [undated, sooner],
    ]) {
      expect(summarize(accounts)[0]?.resetPlan?.account.id).toBe("sooner");
    }
    // A clearly bigger gain still wins.
    const lighter = codexAccount("lighter", 5, 0.7, 5 * DAY, 10 * DAY);
    expect(summarize([lighter, later])[0]?.resetPlan?.account.id).toBe("later");
  });

  it("counts the weekly quota a reset frees along with the five-hour one", () => {
    const account = (
      id: string,
      fiveHour: [number, number],
      weekly: [number, number],
    ) =>
      usageAccount({
        id,
        provider: "codex",
        windows: [
          quota(300, fiveHour[0], NOW + fiveHour[1]),
          quota(10_080, weekly[0], NOW + weekly[1]),
        ],
        reset: { expiresAt: null, clears: null },
      });
    const weeklySpent = account("weekly", [0.9, 4 * HOUR], [0.8, 6 * DAY]);
    const [codex] = summarize([
      account("five-hour", [0.95, 4 * HOUR], [0.1, 6 * DAY]),
      weeklySpent,
    ]);

    // 80% of a week back for six days beats 5% more of five hours.
    expect(codex?.resetPlan?.account.id).toBe("weekly");
    expect(codex?.resetPlan?.freesAt).toBe(NOW + 6 * DAY);
    // A weekly window about to reset frees little; one six days out, a lot.
    expect(
      summarize([
        account("resetting", [0.5, 4 * HOUR], [0.95, 10 * MINUTE]),
        account("lasting", [0.4, 4 * HOUR], [0.4, 6 * DAY]),
      ])[0]?.resetPlan?.account.id,
    ).toBe("lasting");
  });

  it("plans no reset that frees nothing a busy account wouldn't get anyway", () => {
    const [codex] = summarize([
      usageAccount({
        provider: "codex",
        windows: [
          quota(300, 0.1, NOW + HOUR),
          quota(10_080, 0.02, NOW + 6 * DAY),
        ],
        reset: { expiresAt: null, clears: null },
      }),
    ]);

    // Its five-hour window starts over within the hour anyway.
    expect(codex?.used).toBeCloseTo(0.1);
    expect(codex?.resetPlan).toBeNull();
  });

  it("clears only the windows a Claude reset clears", () => {
    const account = usageAccount({
      weight: 20,
      windows: [
        quota(300, 0.99, NOW + 2 * HOUR),
        quota(10_080, 0.95, NOW + 3 * DAY),
      ],
      reset: { expiresAt: null, clears: [300] },
    });
    const [claude] = summarize([account]);

    // The weekly window still binds, and the five-hour one clears in 2h.
    expect(claude?.resetPlan).toEqual({
      account,
      expiresAt: null,
      accountUsed: { before: 1, after: expect.closeTo(0.725) },
      used: { before: 1, after: expect.closeTo(0.725) },
      freesAt: NOW + 2 * HOUR,
    });
    expect(
      summarize([
        { ...account, reset: { expiresAt: null, clears: [10_080] } },
      ])[0]?.resetPlan,
    ).toBeNull();
  });

  it("plans no reset that wouldn't lower usage now", () => {
    const reset = { expiresAt: null, clears: null };
    const windows = [quota(300, 0.5, NOW + 2 * HOUR)];
    const other = usageAccount({ id: "other", windows });

    for (const account of [
      // A hold outlasts the reset.
      usageAccount({ windows, heldUntil: NOW + HOUR, reset }),
      usageAccount({ windows, offline: "error", reset }),
      usageAccount({ windows, disabled: true, reset }),
      usageAccount({ windows: [quota(300, 0.004)], reset }),
      usageAccount({ windows }),
    ]) {
      expect(summarize([other, account])[0]?.resetPlan).toBeNull();
    }
    // Nor one that leaves the percentage shown as it is: 25% before and after.
    const [codex] = summarize([
      usageAccount({ id: "rest", windows: [quota(300, 0.492)] }),
      usageAccount({ windows: [quota(300, 0.012)], reset }),
    ]);
    expect(codex?.used).toBeCloseTo(0.252);
    expect(codex?.resetPlan).toBeNull();
  });
});

describe("formatting", () => {
  it("never rounds visible usage down to zero", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.004)).toBe("<1%");
    expect(formatPercent(0.42)).toBe("42%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("turns red at the percentage the user reads", () => {
    expect(isHot(0.79, 80)).toBe(false);
    expect(isHot(0.795, 80)).toBe(true);
    expect(isHot(0.8, 80)).toBe(true);
    expect(isHot(0.994, 100)).toBe(false);
    expect(isHot(1, 100)).toBe(true);
  });

  it("formats durations with at most two units", () => {
    expect(formatDuration(0)).toBe("1m");
    expect(formatDuration(61_000)).toBe("2m");
    expect(formatDuration(59 * MINUTE)).toBe("59m");
    expect(formatDuration(HOUR)).toBe("1h");
    expect(formatDuration(85 * MINUTE)).toBe("1h 25m");
    expect(formatDuration(DAY)).toBe("1d");
    expect(formatDuration(26 * HOUR + 30 * MINUTE)).toBe("1d 2h");
  });

  it("reads the red threshold setting within 1-100%", () => {
    expect(redThreshold(undefined)).toBe(80);
    expect(redThreshold({})).toBe(80);
    expect(redThreshold({ redThreshold: 70 })).toBe(70);
    expect(redThreshold({ redThreshold: 72.6 })).toBe(73);
    expect(redThreshold({ redThreshold: 150 })).toBe(100);
    expect(redThreshold({ redThreshold: 0 })).toBe(1);
    expect(redThreshold({ redThreshold: "70" })).toBe(80);
    expect(redThreshold({ redThreshold: Number.NaN })).toBe(80);
  });
});
