// Jev Browse frontend: the thread inspector tab and the approval form for
// irreversible browser actions. Server state arrives over RPC; the server's
// "runs-changed" realtime signal triggers refetches.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type ExperimentalThreadTabProps,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import type { RunSnapshotDto, RunSummaryDto, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type RunView = RunSummaryDto & { snapshot: RunSnapshotDto };

const STATUS_TONE: Record<string, string> = {
  running: "bg-primary/15 text-primary",
  ready: "bg-primary/15 text-primary",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  needs_text: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  needs_confirmation: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  blocked: "bg-muted text-muted-foreground",
  budget: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  ready: "Running",
  done: "Done",
  needs_text: "Needs text",
  needs_confirmation: "Needs approval",
  blocked: "Blocked",
  budget: "Budget reached",
  cancelled: "Stopped",
  error: "Error",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[status] ?? "bg-muted")}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function useThreadRuns(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [runs, setRuns] = useState<RunSummaryDto[] | null>(null);
  const refetch = useCallback(() => {
    rpc.call("runs_list", { threadId }).then(
      (result) => setRuns(result.runs),
      () => setRuns([]),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime("runs-changed", (payload) => {
    if ((payload as { threadId?: string } | null)?.threadId === threadId) refetch();
  });
  return runs;
}

function useRun(threadId: string, runId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (runId === null) return setView(null);
    rpc.call("run_get", { threadId, runId }).then(
      (result) => {
        setView(result as unknown as RunView);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, threadId, runId]);
  useEffect(refetch, [refetch]);
  useRealtime("runs-changed", (payload) => {
    if ((payload as { runId?: string } | null)?.runId === runId) refetch();
  });
  const stop = useCallback(() => {
    if (runId !== null) rpc.call("run_stop", { threadId, runId }).then(refetch, () => {});
  }, [rpc, threadId, runId, refetch]);
  return { view, error, stop };
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Bars({ values, limit = 5 }: { values: Record<string, number>; limit?: number }) {
  const rows = Object.entries(values)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit);
  return (
    <ul className="space-y-1">
      {rows.map(([key, value]) => (
        <li key={key} className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 truncate font-mono text-muted-foreground" title={key}>
            {key}
          </span>
          <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.round(value * 100)}%` }} />
          </span>
          <span className="w-9 text-right tabular-nums">{value.toFixed(2)}</span>
        </li>
      ))}
    </ul>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function RunDetails({ view, onStop }: { view: RunView; onStop: () => void }) {
  const snapshot = view.snapshot;
  const [showElements, setShowElements] = useState(false);
  const last = snapshot.decisions.at(-1);
  const active = view.status === "running" || view.status === "ready";
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={view.status} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {seconds(snapshot.elapsedMs)} · {snapshot.history.length} actions · {snapshot.decisions.length} decisions
        </span>
        {active ? (
          <Button variant="outline" size="sm" className="ml-auto h-7" onClick={onStop}>
            <Icon name="Square" className="size-3.5" />
            Stop
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-sm">{snapshot.goal}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground" title={snapshot.url}>
        {snapshot.title ? `${snapshot.title} — ` : ""}
        {snapshot.url}
      </p>
      {snapshot.reason ? <p className="mt-2 text-xs text-muted-foreground">{snapshot.reason}</p> : null}
      {snapshot.stale && snapshot.stale.total > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {snapshot.stale.total} decision{snapshot.stale.total === 1 ? "" : "s"} discarded because the page changed
          {snapshot.stale.lastReason ? ` (last: ${snapshot.stale.lastReason})` : ""}.
        </p>
      ) : null}
      {snapshot.pending?.kind === "text" ? (
        <p className="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs">
          Waiting for a value for <strong>{snapshot.pending.field}</strong>. The agent supplies it with browse_continue.
        </p>
      ) : null}
      {snapshot.pending?.kind === "confirm" ? (
        <p className="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs">
          Waiting for your approval to activate <strong>{snapshot.pending.element}</strong>. Answer in the composer.
        </p>
      ) : null}
      {snapshot.values.length > 0 ? (
        <Section title="Provided values">
          <div className="flex flex-wrap gap-1">
            {snapshot.values.map((value) => (
              <span key={value} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {value}
              </span>
            ))}
          </div>
        </Section>
      ) : null}
      <Section title="Actions">
        {snapshot.history.length === 0 ? (
          <Empty>No actions yet.</Empty>
        ) : (
          <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {snapshot.history.map((entry) => (
              <li key={entry.step} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
                <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{entry.step}</span>
                <span className="w-24 shrink-0 font-mono">{entry.operation}</span>
                <span className="min-w-0 flex-1 truncate" title={entry.action}>
                  {entry.action}
                  {entry.text !== null ? <span className="text-muted-foreground"> ← “{entry.text}”</span> : null}
                </span>
                {entry.pageChanged === false ? <span className="text-muted-foreground">no change</span> : null}
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                  {entry.probability === null ? "" : entry.probability.toFixed(2)}
                </span>
                <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{seconds(entry.executedMs)}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
      {last ? (
        <Section title={`Last decision · ${last.latencyMs} ms · ${last.model}`}>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Operation</p>
              <Bars values={last.operationProbabilities} />
            </div>
            {Object.keys(last.targetProbabilities).length > 0 ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Target</p>
                <Bars values={last.targetProbabilities} />
              </div>
            ) : null}
          </div>
          {last.sensitiveProbability !== null ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Irreversible-action probability for the chosen target: {last.sensitiveProbability.toFixed(2)}
            </p>
          ) : null}
        </Section>
      ) : null}
      <Section
        title={`Observed elements (${snapshot.elements.length})`}
        aside={
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setShowElements((v) => !v)}>
            {showElements ? "Hide" : "Show"}
          </Button>
        }
      >
        {showElements ? (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card">
            {snapshot.elements.map((element) => (
              <li key={element.id} className="flex gap-2 px-3 py-1 text-xs">
                <span className="w-16 shrink-0 font-mono text-muted-foreground">{element.id}</span>
                <span className="w-12 shrink-0">{element.kind}</span>
                <span className="min-w-0 flex-1 truncate" title={element.label}>
                  {element.label}
                </span>
                {element.value ? <span className="max-w-32 truncate text-muted-foreground">{element.value}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function Inspector({ threadId }: ExperimentalThreadTabProps) {
  const runs = useThreadRuns(threadId);
  const [selected, setSelected] = useState<string | null>(null);
  const runId = useMemo(() => {
    if (runs === null || runs.length === 0) return null;
    return runs.some((run) => run.id === selected) ? selected : runs[0]!.id;
  }, [runs, selected]);
  const { view, error, stop } = useRun(threadId, runId);
  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 pb-4 pt-3">
      {runs !== null && runs.length > 1 ? (
        <div className="mb-3 flex flex-wrap gap-1">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => setSelected(run.id)}
              className={cn(
                "max-w-48 truncate rounded-md border px-2 py-1 text-left text-xs",
                run.id === runId ? "border-primary bg-primary/10" : "border-border hover:bg-muted",
              )}
              title={run.goal}
            >
              {STATUS_LABEL[run.status] ?? run.status} · {run.goal}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p role="alert" className="mb-2 text-sm text-destructive">{error}</p> : null}
      {runs === null ? (
        <Empty>Loading Jev runs…</Empty>
      ) : view === null ? (
        <Empty>No Jev runs in this thread yet. Ask the agent to browse a link.</Empty>
      ) : (
        <RunDetails view={view} onStop={stop} />
      )}
    </div>
  );
}

function useHasRuns({ threadId }: ExperimentalThreadTabProps): boolean {
  const runs = useThreadRuns(threadId);
  return runs !== null && runs.length > 0;
}

interface ConfirmPayload {
  goal: string;
  element: string;
  role: string | null;
  url: string;
  probability: number | null;
}

function ConfirmAction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = interaction.payload as unknown as ConfirmPayload;
  const [pending, setPending] = useState(false);
  const answer = (approve: boolean) => {
    if (pending) return;
    setPending(true);
    submit({ approve }).finally(() => setPending(false));
  };
  return (
    <div className="rounded-xl border border-amber-500/40 bg-card p-4">
      <div className="flex items-start gap-3">
        <Icon name="AlertTriangle" className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Jev wants to activate “{payload.element}”</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This may be irreversible (purchase, send, delete, publish)
            {payload.probability !== null ? ` · risk ${payload.probability.toFixed(2)}` : " · risk check unavailable"}.
          </p>
          <p className="mt-2 truncate text-xs text-muted-foreground" title={payload.url}>
            {payload.url}
          </p>
          <p className="mt-1 line-clamp-2 text-xs">Goal: {payload.goal}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void cancel()}>
          Dismiss
        </Button>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => answer(false)}>
          Decline
        </Button>
        <Button size="sm" disabled={pending} onClick={() => answer(true)}>
          Approve
        </Button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "inspector",
    title: "Jev",
    icon: "Globe",
    tooltip: "Jev runs in this thread",
    layout: "flush",
    component: Inspector,
    useVisible: useHasRuns,
  });
  app.slots.pendingInteraction({ id: "confirm-action", component: ConfirmAction });
});
