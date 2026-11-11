// Ported from browser-use/jev-ultrafast jev_ultrafast/model.py choose() (MIT).
// One TypeSafe request asks for the operation and, speculatively, a target for
// every available operation. Only the head matching the chosen operation can
// execute. Optional extra heads (field + value pairs, sensitive targets) ride
// in the same request, so they add tokens but no round trip.
import { actionSpace, type Target } from "./action-space";
import { NEXT_ACTION, SENSITIVE, TARGET, TEXT_PAIR } from "./questions";
import type { Decision, HistoryEntry, Page } from "./types";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export interface PostOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export async function postJson(
  url: string,
  key: string,
  body: unknown,
  { signal, fetchImpl = fetch, timeoutMs = 25_000 }: PostOptions = {},
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Model connection failed; no action executed.");
    }
    if ([429, 503, 529].includes(response.status) && attempt < 2) {
      await sleep(500 * 2 ** attempt, signal);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Model provider returned HTTP ${response.status}; no action executed.`);
    }
    return response.json();
  }
  throw new Error("Model unavailable; no action executed.");
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export function validateChoice(answer: unknown, ids: readonly string[]): ChoiceAnswer {
  const invalid = () => new Error("Invalid TypeSafe response; no action executed.");
  if (typeof answer !== "object" || answer === null) throw invalid();
  const { choice, probabilities, confidence } = answer as Record<string, unknown>;
  if (typeof choice !== "string" || !ids.includes(choice)) throw invalid();
  if (typeof probabilities !== "object" || probabilities === null) throw invalid();
  const entries = Object.entries(probabilities as Record<string, unknown>);
  const keys = new Set(entries.map(([key]) => key));
  if (keys.size !== ids.length || ids.some((id) => !keys.has(id))) throw invalid();
  const numbers = [...entries.map(([, value]) => value), confidence];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw invalid();
  }
  const values = entries.map(([, value]) => value as number);
  const sum = values.reduce((total, value) => total + value, 0);
  const chosen = (probabilities as Record<string, number>)[choice]!;
  if (Math.abs(sum - 1) >= 0.02 || chosen < Math.max(...values) - 1e-6) throw invalid();
  return {
    choice,
    probabilities: probabilities as Record<string, number>,
    confidence: confidence as number,
  };
}

export interface ChooseOptions extends PostOptions {
  apiKey: string;
  model: string;
  /** Candidate strings for TYPE_TEXT, supplied by the driving agent. */
  values?: readonly string[];
  /** Ask the sensitive-target head in the same request. */
  sensitive?: boolean;
  endpoint?: string;
}

const NEW_VALUE = "(needs a value that is not among the provided values; it will be requested)";

function targetCriteria(key: string, target: Target, values: readonly string[]) {
  const { action, valueIndex } = target;
  const criteria: Record<string, unknown> = {
    element: `[${key.split(":")[0]}] ${action.label}`,
    current_value: action.current_value ?? action.value ?? "",
  };
  for (const field of ["role", "checked", "selected", "expanded"] as const) {
    if (action[field] !== undefined) criteria[field] = action[field];
  }
  if (valueIndex !== undefined) {
    criteria.text_to_type = valueIndex === null ? NEW_VALUE : values[valueIndex];
  }
  return criteria;
}

export function buildRequest(
  page: Page,
  goal: string,
  history: readonly HistoryEntry[],
  { model, values = [], sensitive = false }: Pick<ChooseOptions, "model" | "values" | "sensitive">,
) {
  const { elements, targets, controls } = actionSpace(page.actions, values);
  const labels: Record<string, string> = {
    CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
    TYPE_TEXT:
      values.length > 0
        ? "Enter or replace text in an editable field, using one of the provided values when it fits."
        : "Enter or replace text in an editable field. A helper will supply the value from the goal.",
    SELECT: "Select an observed dropdown value.",
  };
  const operations: Record<string, string> = {};
  for (const key of Object.keys(targets)) operations[key] = labels[key] ?? key;
  for (const [key, control] of Object.entries(controls)) operations[key] = control.label;
  operations.DONE = "Every requirement is visibly satisfied.";
  operations.BLOCKED = "No supported operation can progress.";

  const questions: Record<string, unknown> = {
    operation: {
      type: "choice",
      criteria: operations,
      instructions: { goal, rules: NEXT_ACTION },
    },
  };
  for (const [operation, candidates] of Object.entries(targets)) {
    const rules = [NEXT_ACTION, TARGET];
    if (operation === "TYPE_TEXT" && values.length > 0) rules.push(TEXT_PAIR);
    questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria: Object.fromEntries(
        Object.entries(candidates).map(([key, target]) => [key, targetCriteria(key, target, values)]),
      ),
      instructions: { goal, operation, rules },
    };
  }
  const sensitiveKeys = [...Object.keys(targets.CLICK ?? {}), ...Object.keys(targets.SELECT ?? {})];
  if (sensitive && sensitiveKeys.length > 0) {
    const criteria: Record<string, unknown> = {};
    for (const key of sensitiveKeys) {
      const target = targets.CLICK?.[key] ?? targets.SELECT?.[key];
      criteria[key] = { element: `[${key}] ${target!.action.label}`, role: target!.action.role };
    }
    criteria.NONE = "No observed element commits an irreversible action.";
    questions.sensitive_target = {
      type: "choice",
      criteria,
      instructions: { goal, rules: SENSITIVE },
    };
  }
  const body = {
    model,
    state: {
      page: { url: page.url, title: page.title, text: page.text },
      elements,
      recent_actions: history.slice(-10).map((entry) => ({
        action: entry.action,
        kind: entry.kind,
        text: entry.text,
        page_changed: entry.pageChanged,
      })),
      ...(values.length > 0 ? { provided_values: values } : {}),
    },
    questions,
  };
  return { body, targets, controls, operations, sensitiveKeys };
}

export async function choose(
  page: Page,
  goal: string,
  history: readonly HistoryEntry[],
  options: ChooseOptions,
): Promise<Decision> {
  const { body, targets, controls, operations, sensitiveKeys } = buildRequest(page, goal, history, options);
  const started = performance.now();
  const result = (await postJson(options.endpoint ?? TYPESAFE_ENDPOINT, options.apiKey, body, options)) as {
    answers?: Record<string, unknown>;
    model?: string;
    usage?: Record<string, unknown>;
  };
  const answers = result.answers ?? {};
  const operationAnswer = validateChoice(answers.operation, Object.keys(operations));
  const operation = operationAnswer.choice;
  let target: string | null = null;
  let valueIndex: number | null | undefined;
  let targetProbabilities: Record<string, number> = {};
  const probabilities: Record<string, number> = {};
  let choice: string;
  const candidates = targets[operation];
  if (candidates !== undefined) {
    // Unused target heads cannot cause an action. Validate only the selected head.
    const targetAnswer = validateChoice(answers[`${operation.toLowerCase()}_target`], Object.keys(candidates));
    target = targetAnswer.choice;
    targetProbabilities = targetAnswer.probabilities;
    const selected = candidates[target]!;
    choice = selected.action.id;
    valueIndex = selected.valueIndex;
    for (const [key, candidate] of Object.entries(candidates)) {
      probabilities[candidate.action.id] = Math.max(
        probabilities[candidate.action.id] ?? 0,
        targetAnswer.probabilities[key] ?? 0,
      );
    }
  } else {
    choice = controls[operation]?.id ?? operation;
    probabilities[choice] = operationAnswer.probabilities[operation] ?? 0;
  }
  let sensitiveProbability: number | null = null;
  const asked = options.sensitive === true && sensitiveKeys.length > 0;
  if (asked && (operation === "CLICK" || operation === "SELECT") && target !== null) {
    try {
      const answer = validateChoice(answers.sensitive_target, [...sensitiveKeys, "NONE"]);
      sensitiveProbability = answer.probabilities[target] ?? 0;
    } catch {
      // Fail closed: an unreadable safety head is treated as sensitive.
      sensitiveProbability = Number.NaN;
    }
  }
  return {
    choice,
    operation,
    target,
    valueIndex,
    confidence: operationAnswer.confidence,
    probabilities,
    operationProbabilities: operationAnswer.probabilities,
    targetProbabilities,
    sensitiveProbability,
    model: result.model ?? options.model,
    usage: result.usage ?? {},
    latencyMs: Math.round(performance.now() - started),
  };
}
