// Thread Load frontend: a sidebar row glyph for loaded threads, a segment in
// the context row above each thread's composer, and Info-tab rows.
import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_DetailRow as DetailRow,
  experimental_useSidebarThreads as useSidebarThreads,
  useRealtime,
  useRpc,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
  type ExperimentalThreadInfoProps,
  type PluginComposerThreadRowStatus,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { describe, formatTokens, type ThreadLoad, type Thresholds } from "./model";
import { cn } from "@/lib/utils";

const LOADS_CHANGED = "loads-changed";
type Rpc = PluginRpcClient<typeof rpcContract>;

// --- Shared store: one fetch serves every mounted component ------------------
interface Snapshot {
  loads: ReadonlyMap<string, ThreadLoad>;
  thresholds: Thresholds | null;
}
let snapshot: Snapshot = { loads: new Map(), thresholds: null };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let again = false;

function emit() {
  for (const listener of listeners) listener();
}
function refresh(rpc: Rpc) {
  if (inFlight !== null) {
    again = true;
    return;
  }
  inFlight = rpc
    .call("loads_list")
    .then(
      (result) => {
        snapshot = {
          loads: new Map(result.loads.map((load) => [load.threadId, load])),
          thresholds: result.thresholds,
        };
        emit();
      },
      () => undefined,
    )
    .finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        refresh(rpc);
      }
    });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useLoads(): Snapshot {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    if (snapshot.thresholds === null) refresh(rpc);
  }, [rpc]);
  useRealtime(LOADS_CHANGED, () => refresh(rpc));
  return useSyncExternalStore(subscribe, () => snapshot);
}

// --- Sidebar row glyphs -------------------------------------------------------
type RowSetter = (threadId: string, status: PluginComposerThreadRowStatus | null) => void;
let rowSetter: RowSetter | null = null;
const applied = new Map<string, string>();
const setterListeners = new Set<() => void>();
let setterVersion = 0;

// Attention highlight: one stylesheet, rewritten whenever the sidebar changes.
let attentionStyle: HTMLStyleElement | null = null;
let attentionCss = "";
function writeAttentionCss(css: string) {
  attentionCss = css;
  if (attentionStyle !== null && attentionStyle.textContent !== css) attentionStyle.textContent = css;
}

/** Red: blocked on you or failed. Yellow: finished and unread. */
const ATTENTION: Partial<Record<string, string>> = {
  "waiting-for-input": "239 68 68",
  "unread-error": "239 68 68",
  "unread-success": "245 158 11",
};

function attentionRule(threadId: string, rgb: string): string {
  // The anchor sits exactly two levels below its row. Group headers carry the
  // same rename attribute and contain rows, so a plain descendant :has() would
  // paint whole groups; the child combinators and the :not() guard prevent it.
  const row =
    `[data-sidebar-rename-row]:has(> span > a[data-sidebar-thread-id="${threadId}"])` +
    `:not(:has([data-sidebar-rename-row]))`;
  return `${row}{background-color:rgb(${rgb} / 0.16);box-shadow:inset 3px 0 0 rgb(${rgb} / 0.9);}` +
    `${row}:hover{background-color:rgb(${rgb} / 0.24);}`;
}

function setRowSetter(next: RowSetter | null) {
  rowSetter = next;
  applied.clear();
  setterVersion += 1;
  for (const listener of setterListeners) listener();
}

function rowStatus(load: ThreadLoad): PluginComposerThreadRowStatus | null {
  if (load.level === 0) return null;
  return load.level === 2
    ? { icon: "thread-load-flame", label: `Тяжёлый тред: ${describe(load)}`, tone: "error" }
    : { icon: "thread-load-gauge-amber", label: `Нагруженный тред: ${describe(load)}`, tone: "default" };
}

/**
 * Always-mounted overlay: keeps row glyphs in sync with the loads. The row
 * status shares its slot with bb's own indicators (unread, waiting for input,
 * running, draft), so the glyph shows only while bb has nothing to say.
 */
function RowStatusSync() {
  const { loads } = useLoads();
  const sidebar = useSidebarThreads();
  const quietIds = new Set(
    sidebar.threads.filter((thread) => thread.indicator === "none").map((thread) => thread.id),
  );
  const quietKey = [...quietIds].sort().join(",");
  const css = sidebar.threads
    .filter((thread) => /^thr_[A-Za-z0-9]+$/.test(thread.id) && ATTENTION[thread.indicator] !== undefined)
    .map((thread) => attentionRule(thread.id, ATTENTION[thread.indicator] as string))
    .join("\n");
  useEffect(() => {
    writeAttentionCss(css);
  }, [css]);
  const version = useSyncExternalStore(
    (listener) => {
      setterListeners.add(listener);
      return () => setterListeners.delete(listener);
    },
    () => setterVersion,
  );
  useEffect(() => {
    const set = rowSetter;
    if (set === null) return;
    const seen = new Set<string>();
    for (const load of loads.values()) {
      if (!quietIds.has(load.threadId)) continue;
      const status = rowStatus(load);
      if (status === null) continue;
      seen.add(load.threadId);
      const signature = JSON.stringify(status);
      if (applied.get(load.threadId) === signature) continue;
      set(load.threadId, status);
      applied.set(load.threadId, signature);
    }
    for (const threadId of [...applied.keys()]) {
      if (seen.has(threadId)) continue;
      set(threadId, null);
      applied.delete(threadId);
    }
    // quietIds is derived from quietKey; the key keeps the effect stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, version, quietKey]);
  return null;
}

// --- Thread context segment and Info rows ------------------------------------
const toneClass = ["text-muted-foreground", "text-amber-600 dark:text-amber-400", "text-destructive"] as const;

function Glyph({ level, className }: { level: number; className?: string }) {
  return level === 2 ? <FlameIcon className={className} /> : <GaugeIcon className={className} />;
}

function contextText(load: ThreadLoad): string {
  if (load.contextUsed === null) return "?";
  return load.contextWindow === null
    ? formatTokens(load.contextUsed)
    : `${formatTokens(load.contextUsed)} / ${formatTokens(load.contextWindow)}`;
}

function SegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const load = useLoads().loads.get(threadId);
  if (load === undefined) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      title={`Нагрузка треда: ${describe(load)}`}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs tabular-nums hover:bg-accent",
        toneClass[load.level],
      )}
    >
      <Glyph level={load.level} className="size-3.5" />
      <span>{load.contextUsed === null ? "—" : formatTokens(load.contextUsed)}</span>
      <span className="opacity-60">·</span>
      <span>5ч {formatTokens(load.burn5h)}</span>
    </button>
  );
}

function SegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { loads, thresholds } = useLoads();
  const load = loads.get(threadId);
  if (!isExpanded || load === undefined) return null;
  const raw = load.raw5h;
  const share = (value: number) => (load.burn5h > 0 ? `${Math.round((value / load.burn5h) * 100)}%` : "0%");
  const rows: [string, string][] = [
    ["Контекст", contextText(load)],
    ["Расход за 5 ч", `${formatTokens(load.burn5h)} (сырых ${formatTokens(raw.totalTokens)})`],
    ["Расход за 24 ч", formatTokens(load.burn24h)],
    ["Чтение кеша", `${formatTokens(raw.cacheReadInputTokens)} · ${share(0.1 * raw.cacheReadInputTokens)}`],
    ["Запись в кеш", `${formatTokens(raw.cacheWriteInputTokens)} · ${share(1.25 * raw.cacheWriteInputTokens)}`],
    ["Ответы модели", `${formatTokens(raw.outputTokens)} · ${share(5 * raw.outputTokens)}`],
  ];
  return (
    <div className="px-3 py-2 text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 tabular-nums">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-muted-foreground">
        Расход взвешен по цене: кеш 0.1×, запись 1.25×, ответ 5×. Каждый вызов инструмента заново читает
        весь контекст, поэтому большой контекст быстро съедает лимит.
        {load.contextLevel > 0 ? " Сожми тред командой /compact или начни новый для следующей задачи." : ""}
      </p>
      {thresholds === null ? null : (
        <p className="mt-1 text-muted-foreground">
          Пороги: контекст {formatTokens(thresholds.contextWarn)} / {formatTokens(thresholds.contextHeavy)}, за 5 ч{" "}
          {formatTokens(thresholds.burnWarn)} / {formatTokens(thresholds.burnHeavy)}.
        </p>
      )}
    </div>
  );
}

function useSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  return useLoads().loads.has(threadId);
}

function InfoRows({ threadId }: ExperimentalThreadInfoProps) {
  const load = useLoads().loads.get(threadId);
  if (load === undefined) return null;
  return (
    <>
      <DetailRow label="Контекст" icon="thread-load-gauge">
        <span className={cn("tabular-nums", toneClass[load.contextLevel])}>{contextText(load)}</span>
      </DetailRow>
      <DetailRow label="Расход 5 ч / 24 ч" icon="thread-load-flame">
        <span className={cn("tabular-nums", toneClass[load.burnLevel])}>
          {formatTokens(load.burn5h)} / {formatTokens(load.burn24h)}
        </span>
      </DetailRow>
    </>
  );
}

// --- Icons (lucide artwork) ---------------------------------------------------
const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
function FlameIcon({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}
function GaugeIcon({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}


/** Sidebar variant: the row tone has no warning color, so the artwork carries amber itself. */
function AmberGaugeIcon({ className }: { className?: string }) {
  return (
    <svg {...svgProps} stroke="#f59e0b" className={className}>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "thread-load-gauge-amber", component: AmberGaugeIcon });
  app.experimental_icons.register({ name: "thread-load-flame", component: FlameIcon });
  app.experimental_icons.register({ name: "thread-load-gauge", component: GaugeIcon });
  app.contentScripts.register({
    id: "row-status",
    mount(context) {
      attentionStyle = document.createElement("style");
      attentionStyle.dataset.plugin = "thread-load";
      attentionStyle.textContent = attentionCss;
      document.head.appendChild(attentionStyle);
      setRowSetter(context.experimental_setThreadRowStatus ?? null);
      return () => {
        setRowSetter(null);
        attentionStyle?.remove();
        attentionStyle = null;
      };
    },
  });
  app.slots.experimental_appOverlay({ id: "row-status-sync", component: RowStatusSync });
  app.slots.experimental_threadContextSegment({
    id: "thread-load",
    title: "Нагрузка треда",
    group: "2_load",
    summary: SegmentSummary,
    details: SegmentDetails,
    useVisible: useSegmentVisible,
  });
  app.slots.experimental_threadInfoRow({
    id: "thread-load",
    group: "1_thread",
    component: InfoRows,
  });
});
