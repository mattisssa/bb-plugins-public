import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { Drawer } from "vaul";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  ExtraUsage,
  UsageAccount,
  UsageSnapshot,
  rpcContract,
} from "./server";
import {
  countsTowardCapacity,
  formatDuration,
  formatPercent,
  hasSpentQuota,
  isHot,
  redThreshold,
  summarizeUsage,
  type ProviderUsage,
  type ResetPlan,
} from "./usage-model";
import "./app.css";

const REFRESH_INTERVAL_MS = 30_000;
const CLOCK_INTERVAL_MS = 15_000;
const VISIBLE_STEPS = 4;
const DAY_MS = 24 * 60 * 60_000;
/** Shorter names than bb's provider picker uses, for the footer's tight space. */
const SHORT_NAMES: Record<string, string> = { "claude-code": "Claude" };

/**
 * bb's footer markup is not a versioned API. The summary finds the plugin's
 * own footer icon by its test id and stands in for it; when the icon can't
 * be found, the icon and its disclosure stay as they are.
 */
const ANCHOR_SELECTOR =
  '[data-testid="plugin-sidebar-footer-item-pool-usage-pool-usage"]';
const ANCHOR_ATTRIBUTE = "data-pool-usage-anchor";

interface UsageState {
  /** The latest snapshot read; kept when a later read fails. */
  snapshot: UsageSnapshot | null;
  loadError: string | null;
  now: number;
  /** Reads usage now, dropping a read still under way. */
  read: () => void;
}

function useUsage(): UsageState {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cancelPending = useRef(() => {});

  const read = useCallback(() => {
    cancelPending.current();
    let current = true;
    cancelPending.current = () => {
      current = false;
    };
    void rpc.call("usage_get").then(
      (result) => {
        if (!current) return;
        setSnapshot(result);
        setLoadError(null);
        setNow(Date.now());
      },
      () => {
        if (current) setLoadError("Usage could not be loaded.");
      },
    );
  }, [rpc]);

  useEffect(() => {
    read();
    const refreshTimer = window.setInterval(read, REFRESH_INTERVAL_MS);
    const clockTimer = window.setInterval(
      () => setNow(Date.now()),
      CLOCK_INTERVAL_MS,
    );
    return () => {
      cancelPending.current();
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [read]);

  return { snapshot, loadError, now, read };
}

/** A provider's usage with the name and logo bb shows for it. */
interface ProviderSummary extends ProviderUsage {
  name: string;
  logo: ComponentProps<typeof ProviderIcon>["provider"];
  /** Spending past the subscription; null when it's off or unknown. */
  extra: ExtraUsage | null;
}

/**
 * Each provider's usage, named and ordered as in bb's provider picker. Null
 * until both the usage and bb's providers have loaded.
 */
function useSummaries(
  snapshot: UsageSnapshot | null,
  now: number,
): ProviderSummary[] | null {
  const directory = useProviders();
  return useMemo(() => {
    if (snapshot === null || directory.status === "loading") return null;
    const rank = (provider: string) => {
      const index = directory.providers.findIndex(({ id }) => id === provider);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return summarizeUsage(snapshot, now)
      .map((usage) => {
        const info = directory.providers.find(
          ({ id }) => id === usage.provider,
        );
        return {
          ...usage,
          name:
            SHORT_NAMES[usage.provider] ?? info?.displayName ?? usage.provider,
          extra:
            snapshot.extraUsage?.find(
              ({ provider }) => provider === usage.provider,
            ) ?? null,
          // Without the provider's tint, the logo follows the text color.
          logo: {
            id: usage.provider,
            logoUrl: info?.logoUrl ?? null,
            icon: info?.icon ?? null,
          },
        };
      })
      .sort((a, b) => rank(a.provider) - rank(b.provider));
  }, [snapshot, now, directory]);
}

function useRedThreshold(): number {
  return redThreshold(useSettings().values);
}

function Percent({ value, threshold }: { value: number; threshold: number }) {
  return (
    <span className={isHot(value, threshold) ? "pool-usage-hot" : undefined}>
      {formatPercent(value)}
    </span>
  );
}

function formatMoney(amount: number, currency: string): string {
  try {
    return amount.toLocaleString("en-US", { style: "currency", currency });
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** "Extra usage 8%", a bar, and "$558.34 / $7,000.00". */
function ExtraUsageRow({
  extra,
  threshold,
}: {
  extra: ExtraUsage;
  threshold: number;
}) {
  const share =
    extra.limit === null || extra.limit === 0
      ? null
      : Math.min(1, extra.used / extra.limit);
  const spent = formatMoney(extra.used, extra.currency);
  return (
    <div className="pool-usage-extra" aria-label="Extra usage">
      <div className="pool-usage-extra-head">
        <span>Extra usage</span>
        {share === null ? null : <Percent value={share} threshold={threshold} />}
      </div>
      {share === null ? null : (
        <div
          className="pool-usage-meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <div
            className={isHot(share, threshold) ? "pool-usage-hot" : undefined}
            style={{ width: `${share * 100}%` }}
          />
        </div>
      )}
      <p className="pool-usage-note">
        {extra.limit === null
          ? `${spent} spent this month`
          : `${spent} / ${formatMoney(extra.limit, extra.currency)}`}
      </p>
    </div>
  );
}

/**
 * The provider's total, then what it drops to at each upcoming reset, then
 * the reset its accounts can spend now, or how many they hold.
 */
function UsageCard({
  usage,
  threshold,
  now,
  onUsed,
}: {
  usage: ProviderSummary;
  threshold: number;
  now: number;
  /** Runs once a try to spend a reset settles. */
  onUsed: () => void;
}) {
  const accounts = usage.accounts.filter(countsTowardCapacity).length;
  return (
    <section className="pool-usage-card" aria-label={`${usage.name} usage`}>
      <header className="pool-usage-head">
        <ProviderIcon
          providerKind="agent"
          provider={usage.logo}
          className="pool-usage-logo"
        />
        <span className="pool-usage-name">
          {usage.name}
          {accounts > 1 ? <small>{accounts}x</small> : null}
        </span>
        <span className="pool-usage-total">
          {usage.used === null ? (
            "—"
          ) : (
            <Percent value={usage.used} threshold={threshold} />
          )}
        </span>
      </header>
      {!hasSpentQuota(usage) ? null : usage.steps.length > 0 ? (
        <ol className="pool-usage-steps" aria-label="Upcoming resets">
          {usage.steps.slice(0, VISIBLE_STEPS).map((step) => (
            <li key={step.at}>
              <span>{formatDuration(step.at - now)}</span>
              <Percent value={step.used} threshold={threshold} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="pool-usage-note">No resets in the next 7 days</p>
      )}
      {usage.extra === null ? null : (
        <ExtraUsageRow extra={usage.extra} threshold={threshold} />
      )}
      <ResetButton usage={usage} now={now} onUsed={onUsed} />
    </section>
  );
}

function UsageDisclosure() {
  const { snapshot, loadError, now, read } = useUsage();
  const summaries = useSummaries(snapshot, now);
  const threshold = useRedThreshold();

  if (summaries === null) {
    return <p role="status">{loadError ?? "Loading account usage…"}</p>;
  }
  if (summaries.length === 0) {
    return (
      <p role="status">
        No usage to show. Sign in to a provider or add accounts to Account
        Pooler.
      </p>
    );
  }
  return (
    <div className="pool-usage-panel">
      {summaries.map((usage) => (
        <UsageCard
          key={usage.provider}
          usage={usage}
          threshold={threshold}
          now={now}
          onUsed={read}
        />
      ))}
    </div>
  );
}

/** bb's spacer between its footer items and the badges at the row's end. */
function footerSpacer(row: Element): Element | null {
  for (const child of row.children) {
    if (
      child.tagName === "LI" &&
      child.getAttribute("aria-hidden") === "true"
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Right after the spacer, so the row's items and the summary share the
 * bottom line and bb's badges wrap above it. Last in rows without one.
 */
function placeInRow(item: Element, row: Element): void {
  const spacer = footerSpacer(row);
  if (spacer === null) {
    if (item.parentElement !== row || item.nextElementSibling !== null) {
      row.append(item);
    }
  } else if (item.previousElementSibling !== spacer) {
    spacer.after(item);
  }
}

/**
 * Places a list item in the footer row that holds the plugin's icon and
 * hides the icon while the item is there. Returns null while the icon can't
 * be found.
 */
function useFooterSlot(enabled: boolean): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const item = document.createElement("li");
    item.className = "pool-usage-footer";
    let anchor: Element | null = null;
    let frame: number | null = null;

    const setAnchor = (next: Element | null) => {
      if (next === anchor) return;
      anchor?.removeAttribute(ANCHOR_ATTRIBUTE);
      next?.setAttribute(ANCHOR_ATTRIBUTE, "");
      anchor = next;
    };

    const attach = () => {
      frame = null;
      // The app mutates the DOM constantly; skip the lookup while in place.
      const current = anchor?.isConnected ? anchor.parentElement : null;
      if (current != null && item.parentElement === current) {
        placeInRow(item, current);
        return;
      }
      const next =
        document
          .querySelector(ANCHOR_SELECTOR)
          ?.closest("li[data-footer-item]") ?? null;
      const row = next?.parentElement ?? null;
      if (next === null || row === null) {
        setAnchor(null);
        item.remove();
        setSlot(null);
        return;
      }
      setAnchor(next);
      placeInRow(item, row);
      setSlot(item);
    };

    const observer = new MutationObserver(() => {
      frame ??= window.requestAnimationFrame(attach);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    attach();

    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      setAnchor(null);
      item.remove();
      setSlot(null);
    };
  }, [enabled]);

  return slot;
}

type MeasuredSummary = ProviderSummary & { used: number };

/** bb's dropdown menu surface, so the card looks like the footer's "…" menu. */
const MENU_CLASS =
  "z-50 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=top]:slide-in-from-bottom-2 data-[side=bottom]:slide-in-from-top-2";

/**
 * A provider's card next to its footer button, on the side with more room,
 * open until Escape or a press outside.
 */
function UsagePopover({
  anchor,
  onClose,
  ...card
}: ComponentProps<typeof UsageCard> & {
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The reset's confirmation, over the card, closes first.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (
        !ref.current?.contains(target) &&
        !anchor.contains(target) &&
        target.closest?.("[data-pool-usage-reset]") == null
      ) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [anchor, onClose]);

  const rect = anchor.getBoundingClientRect();
  const { innerWidth, innerHeight } = window;
  // Above a footer at the bottom of the window, below one at the top.
  const above = rect.top > innerHeight - rect.bottom;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`${card.usage.name} usage`}
      data-state="open"
      data-side={above ? "top" : "bottom"}
      className={`pool-usage-popover ${MENU_CLASS}`}
      style={{
        ...(above
          ? { bottom: innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
        // Near the right edge, the card grows leftward from the button's end.
        ...(rect.left + rect.right > innerWidth
          ? { right: Math.max(8, innerWidth - rect.right) }
          : { left: Math.max(8, rect.left) }),
      }}
    >
      <UsageCard {...card} />
    </div>,
    document.body,
  );
}

/**
 * A logo and a percentage per provider at the right end of the footer; a
 * click opens that provider's card.
 */
function FooterSummary() {
  const { snapshot, now, read } = useUsage();
  const summaries = useSummaries(snapshot, now);
  const threshold = useRedThreshold();
  const usages = useMemo(
    () =>
      (summaries ?? []).filter(
        (usage): usage is MeasuredSummary => usage.used !== null,
      ),
    [summaries],
  );
  const slot = useFooterSlot(usages.length > 0);
  const [open, setOpen] = useState<{
    provider: string;
    anchor: HTMLElement;
  } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const openUsage = usages.find(({ provider }) => provider === open?.provider);

  if (slot === null) return null;
  return (
    <>
      {createPortal(
        usages.map((usage) => (
          <button
            key={usage.provider}
            type="button"
            className="pool-usage-button"
            aria-label={`${usage.name}: ${formatPercent(usage.used)} used`}
            aria-expanded={open?.provider === usage.provider}
            onClick={(event) => {
              const anchor = event.currentTarget;
              setOpen((current) =>
                current?.provider === usage.provider
                  ? null
                  : { provider: usage.provider, anchor },
              );
            }}
          >
            <ProviderIcon
              providerKind="agent"
              provider={usage.logo}
              className="pool-usage-logo"
            />
            <Percent value={usage.used} threshold={threshold} />
          </button>
        )),
        slot,
      )}
      {open !== null && openUsage !== undefined ? (
        <UsagePopover
          anchor={open.anchor}
          onClose={close}
          usage={openUsage}
          threshold={threshold}
          now={now}
          onUsed={read}
        />
      ) : null}
    </>
  );
}

/** A version 4 UUID; `crypto.randomUUID` needs a secure context. */
function newRequestId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const variant = "89ab"[Number.parseInt(hex[16]!, 16) & 3];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** The account's name, then its email and plan when they add to it. */
function describeAccount({ label, email, plan }: UsageAccount): string {
  const name = label ?? email ?? "the account";
  const details = [email === name ? null : email, plan].filter(Boolean);
  return details.length === 0 ? name : `${name} (${details.join(", ")})`;
}

/** "Oct 22", with the year when it isn't this one and the time within a day. */
function formatDate(at: number, now: number): string {
  const date = new Date(at);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
    ...(at - now < DAY_MS ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/**
 * Marks a portaled element as the plugin's, so its styles apply and bb's
 * sidebar drawer leaves focus in it.
 */
const PORTAL_SCOPE = {
  "data-bb-portaled-overlay": "",
  "data-bb-plugin-root": "",
  "data-bb-plugin": "pool-usage",
  "data-pool-usage-reset": "",
};

/** bb's dialog, bottom sheet, and button classes. */
const OVERLAY_CLASS =
  "fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";
const DIALOG_CLASS =
  "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-sm duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg";
const SHEET_CLASS =
  "fixed inset-x-0 bottom-0 z-50 mt-24 grid grid-cols-[minmax(0,1fr)] gap-4 rounded-t-xl border bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none";
const BUTTON_CLASS =
  "inline-flex h-9 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150 hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/** A phone, where bb's dialogs are bottom sheets. */
const PHONE_QUERY = "(max-width: 767px)";

interface ResetRequest {
  usage: ProviderSummary;
  plan: ResetPlan;
  now: number;
  /** Sent with every try, so a retry never spends a second reset. */
  requestId: string;
}

/** A refusal keeps the reset; a failed try may be repeated as is. */
type Attempt = "asking" | "spending" | { refused: boolean; message: string };

/**
 * "Reset to X% (N available)", which asks before it spends the reset worth
 * spending first; or how many resets there are when none lowers usage.
 */
function ResetButton({
  usage,
  now,
  onUsed,
}: {
  usage: ProviderSummary;
  now: number;
  onUsed: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  // The request outlives the dialog's closing animation.
  const [request, setRequest] = useState<ResetRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState<Attempt>("asking");
  const spending = attempt === "spending";
  const failed = typeof attempt === "object";
  const plan = usage.resetPlan;

  const spend = ({ usage, plan, requestId }: ResetRequest) => {
    setAttempt("spending");
    void rpc
      .call("reset_use", { accountId: plan.account.id, requestId })
      .then(
        (result) => {
          if (result.outcome === "refused") {
            setAttempt({ refused: true, message: result.message });
            return;
          }
          setOpen(false);
          toast.success(`Used a ${usage.name} reset`, {
            description: `On ${describeAccount(plan.account)}.`,
          });
        },
        (error: unknown) =>
          setAttempt({
            refused: false,
            message:
              error instanceof Error
                ? error.message
                : "Couldn't use the reset. Try again.",
          }),
      )
      .finally(onUsed);
  };

  let dialog = null;
  if (request !== null) {
    const { usage, plan, now } = request;
    const left = usage.availableResets - 1;
    const body = (
      <>
        <div className="flex flex-col space-y-1.5 text-left">
          <Dialog.Title className="text-base font-semibold leading-none tracking-tight">
            Use a {usage.name} reset?
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            Are you sure you want to use a reset
            {plan.expiresAt === null
              ? ""
              : `, valid until ${formatDate(plan.expiresAt, now)},`}{" "}
            on {describeAccount(plan.account)} to drop {usage.name} from{" "}
            {formatPercent(plan.used.before)} to{" "}
            {formatPercent(plan.used.after)}?
          </Dialog.Description>
        </div>
        <p className="text-sm text-muted-foreground">
          The account goes from {formatPercent(plan.accountUsed.before)} to{" "}
          {formatPercent(plan.accountUsed.after)} used.{" "}
          {plan.freesAt === null
            ? "On its own, it doesn't free up within a week."
            : `On its own, it frees up in ${formatDuration(plan.freesAt - now)}.`}{" "}
          {left <= 0
            ? "This is the last reset available."
            : left === 1
              ? "1 reset stays available."
              : `${left} resets stay available.`}
        </p>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {attempt.message}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            className={`${BUTTON_CLASS} border border-input bg-transparent hover:bg-state-hover hover:text-foreground`}
            disabled={spending}
            onClick={() => setOpen(false)}
          >
            {failed && attempt.refused ? "Close" : "Cancel"}
          </button>
          {failed && attempt.refused ? null : (
            <button
              type="button"
              className={`${BUTTON_CLASS} bg-foreground text-background hover:bg-foreground/90`}
              disabled={spending}
              onClick={() => spend(request)}
            >
              {spending ? "Using reset…" : failed ? "Try again" : "Use reset"}
            </button>
          )}
        </div>
      </>
    );
    // Closing mid-spend would hide how it ended.
    const onOpenChange = (next: boolean) => {
      if (!spending) setOpen(next);
    };
    dialog = window.matchMedia?.(PHONE_QUERY).matches ? (
      <Drawer.Root
        open={open}
        onOpenChange={onOpenChange}
        dismissible={!spending}
      >
        <Drawer.Portal>
          <Drawer.Overlay
            {...PORTAL_SCOPE}
            className="fixed inset-0 z-50 bg-black/40"
          />
          <Drawer.Content {...PORTAL_SCOPE} className={SHEET_CLASS}>
            <div className="mx-auto my-3.5 h-1 w-10 rounded-full bg-muted-foreground/20" />
            {body}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    ) : (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay {...PORTAL_SCOPE} className={OVERLAY_CLASS} />
          <Dialog.Content {...PORTAL_SCOPE} className={DIALOG_CLASS}>
            {body}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <>
      {plan !== null ? (
        <button
          type="button"
          className="pool-usage-reset"
          onClick={() => {
            setRequest({ usage, plan, now, requestId: newRequestId() });
            setAttempt("asking");
            setOpen(true);
          }}
        >
          Reset to {formatPercent(plan.used.after)}{" "}
          <span>({usage.availableResets} available)</span>
        </button>
      ) : usage.availableResets > 0 ? (
        <p className="pool-usage-note">
          {usage.availableResets === 1
            ? "1 reset available"
            : `${usage.availableResets} resets available`}
        </p>
      ) : null}
      {dialog}
    </>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "pool-usage",
    label: "Account usage",
    icon: "ChartColumn",
    component: UsageDisclosure,
  });
  app.slots.experimental_appOverlay({
    id: "footer-summary",
    component: FooterSummary,
  });
});
