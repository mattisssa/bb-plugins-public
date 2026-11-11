import { describe, expect, it, vi } from "vitest";
import { JevLoop } from "../src/loop";
import { StalePage, UncertainMutation, type Decision } from "../src/types";
import { buyButton, checkbox, decision, FakeDriver, page, searchBox, searchBoxClick, searchButton } from "./helpers";

const start = page([searchBox, searchBoxClick, searchButton], { fingerprint: "start" });
const typed = page([{ ...searchBox, value: "Gödel" }, searchButton], { fingerprint: "typed" });
const results = page([], { url: "https://example.test/results", fingerprint: "results" });

function decider(...decisions: Decision[]) {
  return vi.fn(async () => {
    const next = decisions.shift();
    if (!next) throw new Error("no more decisions");
    return next;
  });
}

describe("JevLoop", () => {
  it("types a provided value, clicks, and stops on DONE after a freshness check", async () => {
    const driver = new FakeDriver([typed, results]);
    const decide = decider(
      decision("e1", "TYPE_TEXT", { target: "1:v1", valueIndex: 0 }),
      decision("e3", "CLICK", { target: "2" }),
      decision("DONE", "DONE"),
    );
    const loop = new JevLoop({ driver, decide }, start, { goal: "Find Gödel", values: ["Gödel"] });
    const snapshot = await loop.run();
    expect(snapshot.status).toBe("done");
    expect(driver.typed).toEqual(["Gödel", null]);
    expect(driver.calls).toEqual(["step:e1", "step:e3", "fresh"]);
    expect(snapshot.history.map((h) => [h.operation, h.textSource, h.pageChanged])).toEqual([
      ["TYPE_TEXT", "provided", true],
      ["CLICK", null, true],
    ]);
  });

  it("pauses for text when no value fits and no helper is configured, then resumes with it", async () => {
    const driver = new FakeDriver([typed]);
    const decide = decider(
      decision("e1", "TYPE_TEXT", { target: "1:new", valueIndex: null }),
      decision("e1", "TYPE_TEXT", { target: "1:v2", valueIndex: 1 }),
      decision("DONE", "DONE"),
    );
    const loop = new JevLoop({ driver, decide }, start, { goal: "Search", values: ["unrelated"] });
    let snapshot = await loop.run();
    expect(snapshot.status).toBe("needs_text");
    expect(snapshot.pending).toMatchObject({ kind: "text", field: "Search" });
    expect(driver.calls).toEqual([]);
    loop.provideText("Gödel");
    snapshot = await loop.run();
    expect(snapshot.status).toBe("done");
    expect(driver.typed).toEqual(["Gödel"]);
  });

  it("never guesses text: missing helper and no values pauses without browser input", async () => {
    const driver = new FakeDriver([]);
    const loop = new JevLoop({ driver, decide: decider(decision("e1", "TYPE_TEXT", { target: "1" })) }, start, {
      goal: "Search",
    });
    expect((await loop.run()).status).toBe("needs_text");
    expect(driver.calls).toEqual([]);
  });

  it("reuses generated text only for an identical helper context", async () => {
    const driver = new FakeDriver([start, typed], [{ kind: "stale", observation: null }]);
    const generateText = vi.fn(async () => ({ text: "Gödel", model: "helper", latencyMs: 1 }));
    const decide = decider(
      decision("e1", "TYPE_TEXT", { target: "1" }),
      decision("e1", "TYPE_TEXT", { target: "1" }),
      decision("DONE", "DONE"),
    );
    const loop = new JevLoop({ driver, decide, generateText }, start, { goal: "Find Gödel" });
    await loop.run();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(driver.typed).toEqual(["Gödel", "Gödel"]);
  });

  it("asks the helper again when the field context changed", async () => {
    const changed = page([{ ...searchBox, label: "Search articles" }, searchButton], { fingerprint: "changed" });
    const driver = new FakeDriver([changed, typed], [{ kind: "stale", observation: null }]);
    const generateText = vi.fn(async () => ({ text: "Gödel", model: "helper", latencyMs: 1 }));
    const decide = decider(
      decision("e1", "TYPE_TEXT", { target: "1" }),
      decision("e1", "TYPE_TEXT", { target: "1" }),
      decision("DONE", "DONE"),
    );
    await new JevLoop({ driver, decide, generateText }, start, { goal: "Find Gödel" }).run();
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("re-observes on a stale step without recording an action", async () => {
    const driver = new FakeDriver([], [{ kind: "stale", observation: typed }]);
    const decide = decider(decision("e3", "CLICK", { target: "2" }), decision("DONE", "DONE"));
    const loop = new JevLoop({ driver, decide }, start, { goal: "Search" });
    const snapshot = await loop.run();
    expect(snapshot.history).toHaveLength(0);
    expect(loop.page).toBe(typed);
    expect(snapshot.status).toBe("done");
  });

  it("stops on an uncertain mutation instead of retrying", async () => {
    const driver = new FakeDriver([], [new UncertainMutation("Dropdown execution was interrupted")]);
    const decide = decider(decision("e3", "CLICK", { target: "2" }), decision("e3", "CLICK", { target: "2" }));
    const snapshot = await new JevLoop({ driver, decide }, start, { goal: "Search" }).run();
    expect(snapshot.status).toBe("error");
    expect(driver.calls.filter((c) => c.startsWith("step"))).toHaveLength(1);
  });

  it("treats a thrown StalePage as a re-observe", async () => {
    const driver = new FakeDriver([typed], [new StalePage()]);
    const decide = decider(decision("e3", "CLICK", { target: "2" }), decision("DONE", "DONE"));
    const snapshot = await new JevLoop({ driver, decide }, start, { goal: "Search" }).run();
    expect(snapshot.status).toBe("done");
    expect(driver.calls).toEqual(["step:e3", "observe", "fresh"]);
  });

  it("keeps the executed action when the post-action observation fails", async () => {
    const driver = new FakeDriver([], [{ kind: "executed", observation: null, observeError: "navigating" }]);
    driver.observe = vi
      .fn()
      .mockRejectedValueOnce(new StalePage())
      .mockResolvedValueOnce(results) as unknown as typeof driver.observe;
    const decide = decider(decision("e3", "CLICK", { target: "2" }), decision("DONE", "DONE"));
    const snapshot = await new JevLoop({ driver, decide }, start, { goal: "Search" }).run();
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]!.url).toBe("https://example.test/results");
  });

  it("re-observes instead of finishing when DONE was chosen on a stale page", async () => {
    const driver = new FakeDriver([typed]);
    driver.fresh_ = false;
    const decide = decider(decision("DONE", "DONE"), decision("BLOCKED", "BLOCKED"));
    const loop = new JevLoop({ driver, decide }, start, { goal: "Search" });
    await loop.tick();
    expect(loop.status).toBe("ready");
    expect(loop.page).toBe(typed);
  });

  it("stops after three actions without a page change, but not for waits", async () => {
    const same = page([searchBox, searchButton], { fingerprint: "start" });
    const driver = new FakeDriver([same, same, same, same, same]);
    const decide = decider(
      decision("wait", "WAIT"),
      decision("e3", "CLICK", { target: "2" }),
      decision("e3", "CLICK", { target: "2" }),
      decision("e3", "CLICK", { target: "2" }),
    );
    const snapshot = await new JevLoop({ driver, decide }, start, { goal: "Search" }).run();
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.history).toHaveLength(4);
  });

  it("enforces the decision budget", async () => {
    const driver = new FakeDriver([]);
    const decide = vi.fn(async () => decision("wait", "WAIT"));
    const snapshot = await new JevLoop({ driver, decide }, start, { goal: "Search", maxDecisions: 3 }).run();
    expect(snapshot.status).toBe("budget");
    expect(decide).toHaveBeenCalledTimes(3);
  });

  describe("sensitive actions", () => {
    const checkout = page([checkbox, buyButton], { fingerprint: "checkout" });

    it("pauses before a click Jev rates irreversible and executes only after approval", async () => {
      const driver = new FakeDriver([results]);
      const decide = decider(
        decision("e5", "CLICK", { target: "2", sensitiveProbability: 0.9 }),
        decision("e5", "CLICK", { target: "2", sensitiveProbability: 0.9 }),
        decision("DONE", "DONE"),
      );
      const loop = new JevLoop({ driver, decide }, checkout, { goal: "Buy" });
      let snapshot = await loop.run();
      expect(snapshot.status).toBe("needs_confirmation");
      expect(snapshot.pending).toMatchObject({ kind: "confirm", element: "Place order" });
      expect(driver.calls).toEqual([]);
      loop.confirm(true);
      snapshot = await loop.run();
      expect(driver.calls).toEqual(["step:e5", "fresh"]);
      expect(snapshot.status).toBe("done");
    });

    it("stops when the user declines", async () => {
      const driver = new FakeDriver([]);
      const loop = new JevLoop(
        { driver, decide: decider(decision("e5", "CLICK", { target: "2", sensitiveProbability: 0.9 })) },
        checkout,
        { goal: "Buy" },
      );
      await loop.run();
      loop.confirm(false);
      expect(loop.status).toBe("blocked");
      expect(driver.calls).toEqual([]);
    });

    it("fails closed when the safety head was unreadable", async () => {
      const loop = new JevLoop(
        { driver: new FakeDriver([]), decide: decider(decision("e4", "CLICK", { target: "1", sensitiveProbability: Number.NaN })) },
        checkout,
        { goal: "Filter" },
      );
      expect((await loop.run()).status).toBe("needs_confirmation");
    });

    it("lets low-risk clicks through and can be disabled", async () => {
      const driver = new FakeDriver([results]);
      const decide = decider(
        decision("e4", "CLICK", { target: "1", sensitiveProbability: 0.1 }),
        decision("DONE", "DONE"),
      );
      expect((await new JevLoop({ driver, decide }, checkout, { goal: "Filter" }).run()).status).toBe("done");
      const off = new JevLoop(
        {
          driver: new FakeDriver([results]),
          decide: decider(decision("e5", "CLICK", { target: "2", sensitiveProbability: 0.99 }), decision("DONE", "DONE")),
        },
        checkout,
        { goal: "Buy", confirmSensitive: false },
      );
      expect((await off.run()).status).toBe("done");
    });
  });

  it("stops as blocked after eight consecutive stale decisions instead of burning the budget", async () => {
    const driver = new FakeDriver(
      Array.from({ length: 12 }, () => start),
      Array.from({ length: 12 }, () => ({ kind: "stale" as const, observation: null, reason: "page changed" })),
    );
    const decide = vi.fn(async () => decision("e3", "CLICK", { target: "2" }));
    const snapshot = await new JevLoop({ driver, decide }, start, { goal: "Search" }).run();
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.reason).toMatch(/kept changing under 8 consecutive decisions \(page changed\)/u);
    expect(decide).toHaveBeenCalledTimes(8);
    expect(snapshot.history).toHaveLength(0);
    expect(snapshot.stale).toEqual({ streak: 8, total: 8, lastReason: "page changed" });
  }, 10_000);

  it("resets the stale streak after an executed action", async () => {
    const driver = new FakeDriver([typed, typed, typed, results], [
      { kind: "stale", observation: null },
      { kind: "stale", observation: null },
      { kind: "executed", observation: typed, observeError: null },
      { kind: "stale", observation: null },
      { kind: "executed", observation: results, observeError: null },
    ]);
    const decide = decider(
      decision("e3", "CLICK", { target: "2" }),
      decision("e3", "CLICK", { target: "2" }),
      decision("e3", "CLICK", { target: "2" }),
      decision("e3", "CLICK", { target: "2" }),
      decision("e3", "CLICK", { target: "2" }),
      decision("DONE", "DONE"),
    );
    const snapshot = await new JevLoop({ driver, decide }, start, { goal: "Search" }).run();
    expect(snapshot.status).toBe("done");
    expect(snapshot.stale).toEqual({ streak: 0, total: 3, lastReason: null });
  });

  it("freezes elapsed time once the run settles", async () => {
    let clock = 0;
    const now = () => (clock += 100);
    const loop = new JevLoop({ driver: new FakeDriver([]), decide: decider(decision("DONE", "DONE")), now }, start, { goal: "x" });
    const settled = (await loop.run()).elapsedMs;
    clock += 10_000;
    expect(loop.snapshot().elapsedMs).toBe(settled);
  });

  it("cancels when the signal aborts", async () => {
    const controller = new AbortController();
    const decide = vi.fn(async () => {
      controller.abort();
      return decision("e3", "CLICK", { target: "2" });
    });
    const driver = new FakeDriver([]);
    const snapshot = await new JevLoop({ driver, decide }, start, { goal: "Search" }).run(controller.signal);
    expect(snapshot.status).toBe("cancelled");
    expect(driver.calls).toEqual([]);
  });
});
