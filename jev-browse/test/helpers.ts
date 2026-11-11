import type { Action, BrowserDriver, Decision, Page, StepResult } from "../src/types";

export function page(actions: Action[], overrides: Partial<Page> = {}): Page {
  return {
    url: "https://example.test/",
    title: "Example",
    w: 1120,
    h: 780,
    text: "Example page",
    scroll: { y: 0, height: 780 },
    actions: [...actions, { id: "wait", kind: "wait", label: "Wait for the page to update" }],
    marker: "m1",
    page_key: "k1",
    guards: Object.fromEntries(actions.filter((a) => a.node !== undefined).map((a) => [String(a.node), `g${a.node}`])),
    omitted_actions: 0,
    fingerprint: overrides.fingerprint ?? "f1",
    ...overrides,
  };
}

export const searchBox: Action = { id: "e1", kind: "fill", node: 1, role: "searchbox", label: "Search", value: "" };
export const searchBoxClick: Action = { id: "e2", kind: "click", node: 1, role: "searchbox", label: "Open Search", value: "" };
export const searchButton: Action = { id: "e3", kind: "click", node: 2, role: "button", label: "Search", value: "" };
export const checkbox: Action = { id: "e4", kind: "click", node: 3, role: "checkbox", label: "Free cancellation", checked: "false", value: "on" };
export const buyButton: Action = { id: "e5", kind: "click", node: 4, role: "button", label: "Place order", value: "" };

export function decision(choice: string, operation: string, extra: Partial<Decision> = {}): Decision {
  return {
    choice,
    operation,
    target: null,
    confidence: 0.9,
    probabilities: { [choice]: 0.9 },
    operationProbabilities: { [operation]: 0.9 },
    targetProbabilities: {},
    sensitiveProbability: null,
    model: "jev-test",
    usage: {},
    latencyMs: 5,
    ...extra,
  };
}

/** Scripted driver: each step pops the next result; records every call. */
export class FakeDriver implements BrowserDriver {
  calls: string[] = [];
  typed: (string | null)[] = [];
  fresh_ = true;
  constructor(
    public pages: Page[],
    public steps: (StepResult | Error)[] = [],
  ) {}
  async observe(): Promise<Page> {
    this.calls.push("observe");
    return this.pages.shift() ?? page([], { fingerprint: "same" });
  }
  async fresh(): Promise<boolean> {
    this.calls.push("fresh");
    return this.fresh_;
  }
  async step(action: Action, _page: Page, text: string | null): Promise<StepResult> {
    this.calls.push(`step:${action.id}`);
    this.typed.push(text);
    const next = this.steps.shift();
    if (next instanceof Error) throw next;
    return next ?? { kind: "executed", observation: this.pages.shift() ?? null, observeError: null };
  }
}
