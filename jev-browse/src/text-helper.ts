// Ported from browser-use/jev-ultrafast jev_ultrafast/model.py field_text() (MIT).
// Optional: only used when TYPE_TEXT has no provided value and a text model is configured.
import { TEXT_VALUE } from "./questions";
import { postJson, type PostOptions } from "./typesafe";
import type { Action, HistoryEntry, Page } from "./types";

export interface TextModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** "none" disables reasoning; "low" asks for low effort. */
  reasoning: "none" | "low";
}

export interface FieldContext {
  goal: string;
  field: { label: string; role: string | undefined; value: string | undefined };
  page: { title: string; text: string };
  recent_actions: { action: string; text: string | null }[];
}

export function fieldContext(
  goal: string,
  action: Action,
  page: Page,
  history: readonly HistoryEntry[],
): FieldContext {
  return {
    goal,
    field: { label: action.label, role: action.role, value: action.value },
    page: { title: page.title, text: page.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map((entry) => ({ action: entry.action, text: entry.text })),
  };
}

export interface TextResult {
  /** null when the helper says the goal does not contain the value. */
  text: string | null;
  model: string;
  latencyMs: number;
}

export async function fieldText(
  context: FieldContext,
  config: TextModelConfig,
  options: PostOptions = {},
): Promise<TextResult> {
  const started = performance.now();
  const reasoning =
    config.reasoning === "none" ? { reasoning: { enabled: false } } : { reasoning: { effort: "low" } };
  const result = (await postJson(
    `${config.baseUrl.replace(/\/+$/u, "")}/chat/completions`,
    config.apiKey,
    {
      model: config.model,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      ...reasoning,
      messages: [
        { role: "system", content: TEXT_VALUE },
        { role: "user", content: JSON.stringify(context) },
      ],
    },
    options,
  )) as { choices?: { message?: { content?: unknown } }[] };
  const invalid = () => new Error("Text helper returned no valid field value; nothing typed.");
  let output: unknown;
  try {
    output = JSON.parse(String(result.choices?.[0]?.message?.content));
  } catch {
    throw invalid();
  }
  if (typeof output !== "object" || output === null) throw invalid();
  const keys = Object.keys(output);
  const value = (output as { text?: unknown }).text;
  if (keys.length !== 1 || keys[0] !== "text") throw invalid();
  const latencyMs = Math.round(performance.now() - started);
  if (value === null) return { text: null, model: config.model, latencyMs };
  if (typeof value !== "string" || value.trim() === "" || value.length > 2000) throw invalid();
  return { text: value, model: config.model, latencyMs };
}
