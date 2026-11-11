import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { actionSpace } from "../src/action-space";
import { READ_STATE } from "../src/snapshot.gen";
import { buildRequest, choose, validateChoice } from "../src/typesafe";
import { fieldText } from "../src/text-helper";
import type { Action } from "../src/types";
import { buyButton, checkbox, page, searchBox, searchBoxClick, searchButton } from "./helpers";

const select: Action[] = [
  { id: "e6", kind: "select", node: 5, role: "combobox", label: "Sort → Price", value: "price", current_value: "Best" },
  { id: "e7", kind: "select", node: 5, role: "combobox", label: "Sort → Rating", value: "rating", current_value: "Best" },
];

function answer(choice: string, ids: string[], confidence = 0.8) {
  const rest = (1 - 0.7) / Math.max(1, ids.length - 1);
  return {
    choice,
    confidence,
    probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? (ids.length === 1 ? 1 : 0.7) : rest])),
  };
}

function fakeFetch(answers: (body: { questions: Record<string, { criteria: Record<string, unknown> }> }) => Record<string, unknown>) {
  const requests: { questions: Record<string, { criteria: Record<string, unknown> }> }[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return new Response(JSON.stringify({ answers: answers(body), model: "jev-test", usage: { input_tokens: 1 } }));
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("action space", () => {
  it("gives one index per node and operation-specific targets", () => {
    const { elements, targets, controls } = actionSpace([searchBox, searchBoxClick, searchButton, checkbox, ...select, { id: "wait", kind: "wait", label: "Wait" }]);
    expect(elements.map((e) => [e.index, e.label, e.operations])).toEqual([
      ["1", "Search", ["TYPE_TEXT", "CLICK"]],
      ["2", "Search", ["CLICK"]],
      ["3", "Free cancellation", ["CLICK"]],
      ["4", "Sort", ["SELECT"]],
    ]);
    expect(Object.keys(targets.TYPE_TEXT!)).toEqual(["1"]);
    expect(Object.keys(targets.CLICK!)).toEqual(["1", "2", "3"]);
    expect(Object.keys(targets.SELECT!)).toEqual(["4:1", "4:2"]);
    expect(Object.keys(controls)).toEqual(["WAIT"]);
  });

  it("turns TYPE_TEXT targets into field + value pairs when values are provided", () => {
    const { targets } = actionSpace([searchBox, searchButton], ["Zurich", "London"]);
    expect(Object.entries(targets.TYPE_TEXT!).map(([key, t]) => [key, t.valueIndex])).toEqual([
      ["1:v1", 0],
      ["1:v2", 1],
      ["1:new", null],
    ]);
  });

  it("distinguishes checkboxes from editable fields", () => {
    const { targets } = actionSpace([checkbox]);
    expect(targets.TYPE_TEXT).toBeUndefined();
    expect(Object.keys(targets.CLICK!)).toEqual(["1"]);
  });
});

describe("choose", () => {
  const current = page([searchBox, searchBoxClick, searchButton, buyButton]);

  it("asks every head in one request and executes only the selected operation's head", async () => {
    const { fetchImpl, requests } = fakeFetch((body) => ({
      operation: answer("CLICK", Object.keys(body.questions.operation!.criteria)),
      click_target: answer("2", Object.keys(body.questions.click_target!.criteria)),
      type_text_target: answer("1:v1", Object.keys(body.questions.type_text_target!.criteria)),
    }));
    const decision = await choose(current, "Search for Gödel", [], {
      apiKey: "k",
      model: "jev-latest",
      values: ["Gödel"],
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(["click_target", "operation", "type_text_target"]);
    expect(decision).toMatchObject({ choice: "e3", operation: "CLICK", target: "2", sensitiveProbability: null });
    expect(decision.valueIndex).toBeUndefined();
  });

  it("maps a TYPE_TEXT pair back to its value index", async () => {
    const { fetchImpl } = fakeFetch((body) => ({
      operation: answer("TYPE_TEXT", Object.keys(body.questions.operation!.criteria)),
      type_text_target: answer("1:v2", Object.keys(body.questions.type_text_target!.criteria)),
      click_target: answer("1", Object.keys(body.questions.click_target!.criteria)),
    }));
    const decision = await choose(current, "Search for London", [], { apiKey: "k", model: "m", values: ["Zurich", "London"], fetchImpl });
    expect(decision).toMatchObject({ choice: "e1", operation: "TYPE_TEXT", target: "1:v2", valueIndex: 1 });
  });

  it("cannot consume a TYPE_TEXT target for a CLICK", async () => {
    const { fetchImpl } = fakeFetch((body) => ({
      operation: answer("CLICK", Object.keys(body.questions.operation!.criteria)),
      click_target: answer("1:v1", ["1:v1"]),
    }));
    await expect(choose(current, "x", [], { apiKey: "k", model: "m", values: ["a"], fetchImpl })).rejects.toThrow(
      "Invalid TypeSafe response",
    );
  });

  it("adds the sensitive head and reports the chosen target's probability", async () => {
    const { fetchImpl, requests } = fakeFetch((body) => {
      const sensitiveIds = Object.keys(body.questions.sensitive_target!.criteria);
      return {
        operation: answer("CLICK", Object.keys(body.questions.operation!.criteria)),
        click_target: answer("3", Object.keys(body.questions.click_target!.criteria)),
        type_text_target: answer("1", Object.keys(body.questions.type_text_target!.criteria)),
        sensitive_target: answer("3", sensitiveIds),
      };
    });
    const decision = await choose(current, "Buy it", [], { apiKey: "k", model: "m", sensitive: true, fetchImpl });
    expect(Object.keys(requests[0]!.questions.sensitive_target!.criteria)).toEqual(["1", "2", "3", "NONE"]);
    expect(decision.sensitiveProbability).toBeCloseTo(0.7);
  });

  it("fails closed when the sensitive head is missing", async () => {
    const { fetchImpl } = fakeFetch((body) => ({
      operation: answer("CLICK", Object.keys(body.questions.operation!.criteria)),
      click_target: answer("3", Object.keys(body.questions.click_target!.criteria)),
    }));
    const decision = await choose(current, "Buy it", [], { apiKey: "k", model: "m", sensitive: true, fetchImpl });
    expect(decision.choice).toBe("e5");
    expect(Number.isNaN(decision.sensitiveProbability)).toBe(true);
  });

  it("sends target heads the control state and both rule sets", () => {
    const { body } = buildRequest(page([checkbox]), "Tick free cancellation", [], { model: "m" });
    const question = body.questions.click_target as { criteria: Record<string, Record<string, unknown>>; instructions: { rules: string[] } };
    expect(question.criteria["1"]).toMatchObject({ element: "[1] Free cancellation", checked: "false", role: "checkbox" });
    expect(question.instructions.rules).toHaveLength(2);
  });

  it("does not execute when the provider fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(choose(current, "x", [], { apiKey: "k", model: "m", fetchImpl })).rejects.toThrow("HTTP 500");
  });
});

describe("validateChoice", () => {
  it.each([
    [{ choice: "a", confidence: 0.5, probabilities: { a: 0.4, b: 0.6 } }],
    [{ choice: "a", confidence: 0.5, probabilities: { a: 1 } }],
    [{ choice: "c", confidence: 0.5, probabilities: { a: 0.5, b: 0.5 } }],
    [{ choice: "a", confidence: 2, probabilities: { a: 0.5, b: 0.5 } }],
    [{ choice: "a", confidence: 0.5, probabilities: { a: 0.3, b: 0.3 } }],
    [null],
  ])("rejects %j", (value) => {
    expect(() => validateChoice(value, ["a", "b"])).toThrow();
  });
});

describe("text helper", () => {
  const context = { goal: "g", field: { label: "City", role: "textbox", value: "" }, page: { title: "t", text: "" }, recent_actions: [] };
  const config = { apiKey: "k", baseUrl: "https://example.test/v1/", model: "m", reasoning: "none" as const };
  const reply = (content: string) =>
    vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as unknown as typeof fetch;

  it("returns a valid value and null for a missing one", async () => {
    expect((await fieldText(context, config, { fetchImpl: reply('{"text":"London"}') })).text).toBe("London");
    expect((await fieldText(context, config, { fetchImpl: reply('{"text":null}') })).text).toBeNull();
  });

  it.each(['{"text":""}', '{"text":"a","extra":1}', "London", '{"text":42}'])("rejects %s", async (content) => {
    await expect(fieldText(context, config, { fetchImpl: reply(content) })).rejects.toThrow("nothing typed");
  });
});

describe("vendored snapshot", () => {
  it("matches the generated module", () => {
    const source = readFileSync(new URL("../src/snapshot.js", import.meta.url), "utf8").trim();
    expect(READ_STATE).toBe(source);
  });
});
