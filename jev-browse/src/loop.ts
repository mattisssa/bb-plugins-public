// The agent loop, ported from browser-use/jev-ultrafast jev_ultrafast/agent.py (MIT).
//
// Invariants kept from the original:
// - a decision is consumed once, before any mutation or model call;
// - browser mutations are never retried; an uncertain mutation stops the run;
// - execution is logged before the next observation is used;
// - three non-WAIT actions in a row without a page change stop as blocked;
// - DONE is the model's claim, not proof: callers verify independently.
//
// Additions for BB:
// - TYPE_TEXT values can come from the driving agent (`values`), selected by Jev;
// - a field that needs a value nobody supplied pauses as `needs_text`;
// - a CLICK/SELECT that Jev rates irreversible pauses as `needs_confirmation`.
import { createHash } from "node:crypto";
import { MAX_ACTIONS, MAX_DECISIONS } from "./questions";
import { fieldContext, type FieldContext, type TextResult } from "./text-helper";
import {
  StalePage,
  UncertainMutation,
  type Action,
  type BrowserDriver,
  type Decision,
  type HistoryEntry,
  type Page,
} from "./types";

export type RunStatus =
  | "ready"
  | "running"
  | "done"
  | "blocked"
  | "needs_text"
  | "needs_confirmation"
  | "budget"
  | "error"
  | "cancelled";

const MAX_STALE_STREAK = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "blocked", "budget", "error", "cancelled"]);
export const PAUSED: ReadonlySet<RunStatus> = new Set(["needs_text", "needs_confirmation"]);

export type Pending =
  | { kind: "text"; field: string; role: string | undefined; currentValue: string; url: string }
  | { kind: "confirm"; element: string; role: string | undefined; probability: number | null; url: string; key: string };

export type Decide = (
  page: Page,
  goal: string,
  history: readonly HistoryEntry[],
  values: readonly string[],
  signal?: AbortSignal,
) => Promise<Decision>;

export type GenerateText = (context: FieldContext, signal?: AbortSignal) => Promise<TextResult>;

export interface LoopDeps {
  driver: BrowserDriver;
  decide: Decide;
  generateText?: GenerateText;
  now?: () => number;
}

export interface LoopOptions {
  goal: string;
  values?: readonly string[];
  maxActions?: number;
  maxDecisions?: number;
  confirmSensitive?: boolean;
  sensitiveThreshold?: number;
}

export interface DecisionRecord {
  operation: string;
  target: string | null;
  choice: string;
  confidence: number;
  sensitiveProbability: number | null;
  operationProbabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  latencyMs: number;
  elapsedMs: number;
  model: string;
  usage: Record<string, unknown>;
}

export interface RunSnapshot {
  goal: string;
  status: RunStatus;
  reason: string | null;
  url: string;
  title: string;
  elapsedMs: number;
  values: string[];
  pending: Pending | null;
  history: HistoryEntry[];
  decisions: DecisionRecord[];
  textCalls: { field: string; value: string | null; model: string; latencyMs: number }[];
  stale: { streak: number; total: number; lastReason: string | null };
  elements: { id: string; kind: string; label: string; value?: string }[];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export class JevLoop {
  status: RunStatus = "ready";
  reason: string | null = null;
  page: Page;
  readonly goal: string;
  readonly values: string[];
  readonly history: HistoryEntry[] = [];
  readonly decisions: DecisionRecord[] = [];
  readonly textCalls: RunSnapshot["textCalls"] = [];
  pending: Pending | null = null;
  private readonly approved = new Set<string>();
  private pendingText: { context: string; text: string } | null = null;
  private startedAt: number | null = null;
  private elapsedMs = 0;
  private readonly now: () => number;
  private readonly maxActions: number;
  private readonly maxDecisions: number;
  private readonly confirmSensitive: boolean;
  private readonly sensitiveThreshold: number;

  constructor(
    private readonly deps: LoopDeps,
    page: Page,
    options: LoopOptions,
  ) {
    const goal = options.goal.trim();
    if (goal === "") throw new Error("Supply a goal");
    this.goal = goal;
    this.page = page;
    this.values = [...(options.values ?? [])];
    this.now = deps.now ?? (() => performance.now());
    this.maxActions = options.maxActions ?? MAX_ACTIONS;
    this.maxDecisions = options.maxDecisions ?? MAX_DECISIONS;
    this.confirmSensitive = options.confirmSensitive ?? true;
    this.sensitiveThreshold = options.sensitiveThreshold ?? 0.5;
  }

  private elapsed(): number {
    if (this.startedAt === null) return this.elapsedMs;
    this.elapsedMs = Math.round(this.now() - this.startedAt);
    return this.elapsedMs;
  }

  private stop(status: RunStatus, reason: string | null = null): void {
    this.status = status;
    this.reason = reason;
    // Freeze the clock on terminal states and pauses; run() restarts it from elapsedMs.
    this.elapsed();
    this.startedAt = null;
  }

  /** Consecutive decisions that were discarded because the page changed; reset by an executed action. */
  staleStreak = 0;
  staleTotal = 0;
  lastStaleReason: string | null = null;

  /**
   * The decided page no longer matches the live one. Observe again, and slow
   * down when this repeats: an animating or still-loading page can otherwise
   * burn the whole decision budget without a single action.
   */
  private async reobserve(reason: string | null = null): Promise<void> {
    this.staleStreak += 1;
    this.staleTotal += 1;
    if (reason !== null) this.lastStaleReason = reason;
    if (this.staleStreak >= MAX_STALE_STREAK) {
      return this.stop(
        "blocked",
        `The page kept changing under ${this.staleStreak} consecutive decisions${
          this.lastStaleReason ? ` (${this.lastStaleReason})` : ""
        }; nothing was executed.`,
      );
    }
    if (this.staleStreak >= 3) await sleep(Math.min(250 * (this.staleStreak - 2), 1000));
    this.page = await this.deps.driver.observe();
  }

  private async reobserveWith(observed: Page, reason: string | null): Promise<void> {
    this.staleStreak += 1;
    this.staleTotal += 1;
    if (reason !== null) this.lastStaleReason = reason;
    if (this.staleStreak >= MAX_STALE_STREAK) {
      return this.stop(
        "blocked",
        `The page kept changing under ${this.staleStreak} consecutive decisions${
          this.lastStaleReason ? ` (${this.lastStaleReason})` : ""
        }; nothing was executed.`,
      );
    }
    if (this.staleStreak >= 3) {
      await sleep(Math.min(250 * (this.staleStreak - 2), 1000));
      this.page = await this.deps.driver.observe();
    } else {
      this.page = observed;
    }
  }

  /** Answer a needs_text pause: the value joins the list and Jev chooses again. */
  provideText(text: string): void {
    if (this.status !== "needs_text") throw new Error("This run is not waiting for text.");
    const value = text.trim();
    if (value === "" || value.length > 2000) throw new Error("Text must be 1-2000 characters.");
    if (!this.values.includes(value)) this.values.push(value);
    this.pending = null;
    this.status = "ready";
  }

  /** Answer a needs_confirmation pause. Approval covers that element in that context only. */
  confirm(approve: boolean): void {
    if (this.status !== "needs_confirmation" || this.pending?.kind !== "confirm") {
      throw new Error("This run is not waiting for confirmation.");
    }
    if (!approve) {
      this.pending = null;
      this.stop("blocked", "The user declined the sensitive action.");
      return;
    }
    this.approved.add(this.pending.key);
    this.pending = null;
    this.status = "ready";
  }

  cancel(reason = "Cancelled"): void {
    if (!TERMINAL.has(this.status)) this.stop("cancelled", reason);
  }

  /** One decision cycle. Leaves status ready, paused, or terminal. */
  async tick(signal?: AbortSignal): Promise<void> {
    if (this.status !== "ready") throw new Error(`Cannot step a run with status ${this.status}`);
    this.startedAt ??= this.now() - this.elapsedMs;
    if (this.decisions.length >= this.maxDecisions) {
      return this.stop("budget", `Reached the ${this.maxDecisions}-decision budget.`);
    }
    const page = this.page;
    const decision = await this.deps.decide(page, this.goal, this.history, this.values, signal);
    this.decisions.push({
      operation: decision.operation,
      target: decision.target,
      choice: decision.choice,
      confidence: decision.confidence,
      sensitiveProbability: Number.isNaN(decision.sensitiveProbability) ? null : decision.sensitiveProbability,
      operationProbabilities: decision.operationProbabilities,
      targetProbabilities: decision.targetProbabilities,
      latencyMs: decision.latencyMs,
      elapsedMs: this.elapsed(),
      model: decision.model,
      usage: decision.usage,
    });
    if (signal?.aborted) return this.cancel();

    if (decision.choice === "DONE" || decision.choice === "BLOCKED") {
      if (!(await this.deps.driver.fresh(page))) return this.reobserve();
      return decision.choice === "DONE"
        ? this.stop("done")
        : this.stop("blocked", "Jev found no supported operation that can progress.");
    }
    const action = page.actions.find((candidate) => candidate.id === decision.choice);
    if (action === undefined) throw new Error("Decision refers to an unobserved action");
    if (this.history.length >= this.maxActions) {
      return this.stop("budget", `Reached the ${this.maxActions}-action budget.`);
    }

    if (
      this.confirmSensitive &&
      (decision.operation === "CLICK" || decision.operation === "SELECT") &&
      decision.sensitiveProbability !== null &&
      !(decision.sensitiveProbability < this.sensitiveThreshold)
    ) {
      const key = hash([action.kind, action.value ?? null, page.guards[String(action.node)] ?? null]);
      if (!this.approved.has(key)) {
        this.pending = {
          kind: "confirm",
          element: action.label,
          role: action.role,
          probability: Number.isNaN(decision.sensitiveProbability) ? null : decision.sensitiveProbability,
          url: page.url,
          key,
        };
        return this.stop("needs_confirmation");
      }
    }

    let text: string | null = null;
    let textSource: HistoryEntry["textSource"] = null;
    if (action.kind === "fill") {
      if (typeof decision.valueIndex === "number") {
        text = this.values[decision.valueIndex] ?? null;
        textSource = "provided";
      }
      if (text === null) {
        const resolved = await this.generate(action, page, signal);
        if (resolved === "stale") return this.reobserve();
        if (resolved === null) {
          this.pending = {
            kind: "text",
            field: action.label,
            role: action.role,
            currentValue: action.value ?? "",
            url: page.url,
          };
          return this.stop("needs_text");
        }
        text = resolved;
        textSource = "helper";
      }
    }
    if (signal?.aborted) return this.cancel();

    // The step rechecks freshness immediately before input, after any text generation.
    let result;
    const stepStarted = this.now();
    try {
      result = await this.deps.driver.step(action, page, text);
    } catch (error) {
      if (error instanceof StalePage) return this.reobserve(error.message);
      if (error instanceof UncertainMutation) return this.stop("error", error.message);
      throw error;
    }
    if (result.kind === "stale") {
      const reason = result.reason ?? null;
      if (result.observation) {
        // Count it like any other stale decision, but keep the observation the step already made.
        const observed = result.observation;
        await this.reobserveWith(observed, reason);
      } else {
        await this.reobserve(reason);
      }
      return;
    }
    this.staleStreak = 0;
    this.pendingText = null;
    // Record execution before observing. A failed observation must not erase the action.
    const executedMs = this.elapsed();
    const entry: HistoryEntry = {
      step: this.history.length + 1,
      action: action.label,
      kind: action.kind,
      choice: decision.choice,
      operation: decision.operation,
      target: decision.target,
      probability: decision.probabilities[decision.choice] ?? null,
      confidence: decision.confidence,
      latencyMs: decision.latencyMs,
      text,
      textSource,
      pageChanged: null,
      url: page.url,
      executedMs,
      stepMs: Math.round(this.now() - stepStarted),
      elapsedMs: executedMs,
    };
    this.history.push(entry);
    if (result.observation) this.page = result.observation;
    else await this.observeAfterAction();
    entry.pageChanged = this.page.fingerprint !== page.fingerprint;
    entry.url = this.page.url;
    entry.elapsedMs = this.elapsed();
    const recent = this.history.slice(-3);
    if (recent.length === 3 && recent.every((h) => h.pageChanged === false && h.kind !== "wait")) {
      return this.stop("blocked", "Three actions in a row did not change the page.");
    }
  }

  private async observeAfterAction(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.reobserve();
      } catch (error) {
        if (!(error instanceof StalePage) || attempt >= 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  /** Text for a field Jev chose without a provided value: helper, cache, or null (pause). */
  private async generate(action: Action, page: Page, signal?: AbortSignal): Promise<string | null | "stale"> {
    const generateText = this.deps.generateText;
    if (generateText === undefined) return null;
    if (!(await this.deps.driver.fresh(page))) return "stale";
    const context = fieldContext(this.goal, action, page, this.history);
    const key = JSON.stringify(context);
    // Reuse a generated value after a stale retry only while the entire helper input is identical.
    if (this.pendingText?.context === key) return this.pendingText.text;
    const result = await generateText(context, signal);
    this.textCalls.push({ field: action.label, value: result.text, model: result.model, latencyMs: result.latencyMs });
    if (result.text === null) return null;
    this.pendingText = { context: key, text: result.text };
    return result.text;
  }

  /** Run until done, paused, terminal, or aborted. Errors stop the run with status error. */
  async run(signal?: AbortSignal, onProgress?: (snapshot: RunSnapshot) => void): Promise<RunSnapshot> {
    if (this.status === "ready") this.status = "running";
    while (this.status === "running") {
      if (signal?.aborted) {
        this.cancel();
        break;
      }
      this.status = "ready";
      try {
        await this.tick(signal);
      } catch (error) {
        if (signal?.aborted) this.cancel();
        else this.stop("error", error instanceof Error ? error.message : String(error));
      }
      if (this.status === "ready") this.status = "running";
      onProgress?.(this.snapshot());
    }
    return this.snapshot();
  }

  snapshot(): RunSnapshot {
    return {
      goal: this.goal,
      status: this.status,
      reason: this.reason,
      url: this.page.url,
      title: this.page.title,
      elapsedMs: this.elapsed(),
      values: [...this.values],
      pending: this.pending,
      history: this.history.map((entry) => ({ ...entry })),
      decisions: [...this.decisions],
      textCalls: [...this.textCalls],
      stale: { streak: this.staleStreak, total: this.staleTotal, lastReason: this.lastStaleReason },
      elements: this.page.actions.map(({ id, kind, label, value }) => ({ id, kind, label, value })),
    };
  }
}
