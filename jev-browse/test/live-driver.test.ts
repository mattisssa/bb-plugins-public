// Live browser check without model calls. Needs an open browser-automation
// session owned by the thread:
//   JEV_LIVE_SESSION=<session-id> JEV_LIVE_THREAD=<thread-id> npx vitest run test/live-driver.test.ts
import { describe, expect, it } from "vitest";
import { BrowserAutomation, DevBrowserDriver, httpTransport } from "../src/driver";

const session = process.env.JEV_LIVE_SESSION;
const thread = process.env.JEV_LIVE_THREAD;
const server = process.env.BB_SERVER_URL ?? "http://127.0.0.1:38886";

describe.skipIf(!session || !thread)("DevBrowserDriver (live)", () => {
  it("observes, types, rejects stale decisions, and clicks", async () => {
    const automation = new BrowserAutomation(httpTransport(() => server), thread!);
    const driver = new DevBrowserDriver(automation, session!);
    let started = performance.now();
    const page = await driver.open("https://en.wikipedia.org/wiki/Main_Page");
    console.log("open ms", Math.round(performance.now() - started), "actions", page.actions.length);
    const fill = page.actions.find((a) => a.kind === "fill" && /search/i.test(a.label));
    expect(fill).toBeDefined();

    started = performance.now();
    expect(await driver.fresh(page)).toBe(true);
    console.log("fresh ms", Math.round(performance.now() - started));

    started = performance.now();
    const typed = await driver.step(fill!, page, "Gödel's incompleteness theorems");
    console.log("step ms", Math.round(performance.now() - started), JSON.stringify((typed as { reason?: string }).reason));
    expect(typed.kind).toBe("executed");
    const after = typed.kind === "executed" ? typed.observation! : page;
    const field = after.actions.find((a) => a.node === fill!.node && a.kind === "fill");
    expect(field?.value).toBe("Gödel's incompleteness theorems");

    // The old page's marker no longer matches: a TYPE_TEXT decision on it must not execute.
    const stale = await driver.step(fill!, page, "should not be typed");
    expect(stale.kind).toBe("stale");
    const check = await driver.observe();
    expect(check.actions.find((a) => a.kind === "fill" && /search/i.test(a.label))?.value).toBe(
      "Gödel's incompleteness theorems",
    );

    const button = check.actions.find((a) => a.kind === "click" && /^search$/i.test(a.label.trim()));
    expect(button).toBeDefined();
    const clicked = await driver.step(button!, check, null);
    expect(clicked.kind).toBe("executed");
    const final = await driver.observe();
    console.log("final url", final.url);
    expect(final.url).not.toContain("Main_Page");
  }, 90_000);
});
