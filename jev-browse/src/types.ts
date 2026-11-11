/** One observed, executable candidate produced by snapshot.js. */
export interface Action {
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait";
  label: string;
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  delta?: number;
  rect?: { x: number; y: number; w: number; h: number };
}

/** One atomic page observation. `marker`, `page_key` and `guards` are opaque freshness data. */
export interface Page {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  scroll: { y: number; height: number };
  actions: Action[];
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  omitted_actions: number;
  fingerprint: string;
}

export type Operation = string;

export interface Decision {
  /** An observed action id, or DONE / BLOCKED. */
  choice: string;
  operation: Operation;
  /** The target key inside the selected operation head, if any. */
  target: string | null;
  /**
   * For TYPE_TEXT: index into the run's provided values, `null` when Jev
   * decided the field needs a value that is not in the list, `undefined`
   * when no values were offered.
   */
  valueIndex?: number | null;
  confidence: number;
  probabilities: Record<string, number>;
  operationProbabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  /** Probability that the chosen CLICK/SELECT target commits an irreversible action. */
  sensitiveProbability: number | null;
  model: string;
  usage: Record<string, unknown>;
  latencyMs: number;
}

export interface HistoryEntry {
  step: number;
  action: string;
  kind: Action["kind"];
  choice: string;
  operation: Operation;
  target: string | null;
  probability: number | null;
  confidence: number;
  latencyMs: number;
  text: string | null;
  textSource: "provided" | "helper" | null;
  pageChanged: boolean | null;
  url: string;
  executedMs: number;
  /** Wall time of the batched browser step (freshness, input, settle, observation). */
  stepMs: number;
  elapsedMs: number;
}

export class StalePage extends Error {
  constructor(message = "Page changed since the decision. Observe again.") {
    super(message);
    this.name = "StalePage";
  }
}

/** A mutation may have reached the page; it must never be retried. */
export class UncertainMutation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncertainMutation";
  }
}

export type StepResult =
  | { kind: "stale"; observation: Page | null; reason?: string }
  | { kind: "executed"; observation: Page | null; observeError: string | null };

/** The browser contract the loop depends on. */
export interface BrowserDriver {
  observe(): Promise<Page>;
  fresh(page: Page): Promise<boolean>;
  /**
   * Recheck freshness, execute once, wait briefly, then observe. A stale
   * page returns `stale` without mutating. Throws UncertainMutation when the
   * mutation's outcome is unknown.
   */
  step(action: Action, page: Page, text: string | null): Promise<StepResult>;
}
