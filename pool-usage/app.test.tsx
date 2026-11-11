// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import type { UsageSnapshot } from "./server";

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const NOW = Date.UTC(2026, 8, 25, 12);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const snapshot: UsageSnapshot = {
  providers: [
    { id: "codex", switchThreshold: 0.98 },
    { id: "claude-code", switchThreshold: 0.98 },
  ],
  accounts: [
    {
      id: "claude-max",
      provider: "claude-code",
      weight: 20,
      disabled: false,
      offline: null,
      heldUntil: null,
      blocked: false,
      windows: [
        {
          minutes: 300,
          utilization: 0.64,
          resetAt: NOW + 85 * MINUTE,
          rejected: false,
        },
        {
          minutes: 10_080,
          utilization: 0.72,
          resetAt: NOW + 3 * DAY,
          rejected: false,
        },
      ],
    },
    {
      id: "claude-pro",
      provider: "claude-code",
      weight: 1,
      disabled: false,
      offline: "login error",
      heldUntil: null,
      blocked: false,
      windows: [],
    },
    {
      id: "codex-pro",
      provider: "codex",
      weight: 20,
      disabled: false,
      offline: null,
      heldUntil: null,
      blocked: false,
      windows: [
        {
          minutes: 10_080,
          utilization: 0.9,
          resetAt: NOW + 2 * DAY,
          rejected: false,
        },
      ],
    },
  ],
};

const empty: UsageSnapshot = { providers: [], accounts: [] };

/** Codex's account holds three resets, each clearing all of its limits. */
const resettable: UsageSnapshot = {
  ...snapshot,
  accounts: snapshot.accounts.map((account) =>
    account.id === "codex-pro"
      ? {
          ...account,
          label: "Personal",
          email: "codex@example.com",
          plan: "Pro 20x",
          availableResets: 3,
          reset: { expiresAt: Date.UTC(2026, 9, 22, 12), clears: null },
        }
      : account,
  ),
};

type ResetUse = () => unknown;

/** bb's provider picker order: Claude before Codex. */
const providers = {
  status: "ready" as const,
  providers: [
    { id: "claude-code", displayName: "Claude Code" },
    { id: "codex", displayName: "Codex" },
  ] as never,
};

const rendered: RenderedSlot[] = [];

const pause = (ms: number) =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function loadApp() {
  const app = await loadPluginApp(() => import("./app"));
  const disclosure = app.experimentalSidebarFooterItems[0];
  const overlay = app.appOverlays[0];
  if (disclosure?.kind !== "disclosure" || overlay === undefined) {
    throw new Error("Pool Usage registered no disclosure or overlay");
  }
  return { app, disclosure, overlay };
}

async function renderDisclosure(
  usage: () => UsageSnapshot | Promise<UsageSnapshot>,
  settings?: Record<string, number>,
  resetUse: ResetUse = () => ({ outcome: "reset" }),
) {
  const { disclosure } = await loadApp();
  const slot = renderSlot(
    disclosure,
    { dismiss: () => undefined },
    { rpc: { usage_get: usage, reset_use: resetUse }, settings, providers },
  );
  rendered.push(slot);
  return slot;
}

async function renderOverlay(
  usage: () => UsageSnapshot | Promise<UsageSnapshot>,
) {
  const { disclosure, overlay } = await loadApp();
  const slot = renderSlot(
    overlay,
    {},
    { rpc: { usage_get: usage }, providers },
  );
  rendered.push(slot);
  return { slot, disclosure };
}

/** bb's footer row: the plugin's own icon, a spacer, then the update badges. */
function renderFooter() {
  const row = document.createElement("ul");
  row.dataset.sidebar = "menu";
  const icon = document.createElement("li");
  icon.dataset.footerItem = "";
  const button = document.createElement("button");
  button.dataset.testid = "plugin-sidebar-footer-item-pool-usage-pool-usage";
  button.setAttribute("aria-label", "Account usage");
  icon.append(button);
  const spacer = document.createElement("li");
  spacer.setAttribute("aria-hidden", "true");
  spacer.className = "min-w-0 flex-1";
  const badges = document.createElement("li");
  row.append(icon, spacer, badges);
  document.body.append(row);
  return { row, icon, spacer, badges };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const slot of rendered.splice(0)) slot.lifecycle.unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("registration", () => {
  it("registers the footer disclosure and the footer summary", async () => {
    const { app, disclosure, overlay } = await loadApp();

    expect(app.experimentalSidebarFooterItems).toHaveLength(1);
    expect(disclosure).toMatchObject({
      id: "pool-usage",
      label: "Account usage",
    });
    expect(app.appOverlays).toHaveLength(1);
    expect(overlay.id).toBe("footer-summary");
  });
});

describe("usage panel", () => {
  it("shows each provider's total and what it drops to at each reset", async () => {
    const slot = await renderDisclosure(() => snapshot);

    const claude = await slot.findByRole("region", { name: "Claude usage" });
    const codex = slot.getByRole("region", { name: "Codex usage" });
    expect(claude.compareDocumentPosition(codex)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(claude).getByRole("banner").textContent).toBe("Claude2x66%");
    expect(within(claude).getByText("66%").className).toBe("");
    const resets = within(claude).getByRole("list", {
      name: "Upcoming resets",
    });
    expect(
      within(resets)
        .getAllByRole("listitem")
        .map((step) => step.textContent),
    ).toEqual(["1h 25m5%"]);

    expect(codex.textContent).toBe("Codex90%2d0%");
    expect(within(codex).getByText("90%").className).toBe("pool-usage-hot");
  });

  it("lists at most four resets", async () => {
    const accounts = [1, 2, 3, 4, 5].map((hours) => ({
      ...snapshot.accounts[0]!,
      id: `claude-${hours}`,
      windows: [
        {
          minutes: 300,
          utilization: 0.9,
          resetAt: NOW + hours * 60 * MINUTE,
          rejected: false,
        },
      ],
    }));
    const slot = await renderDisclosure(() => ({ ...snapshot, accounts }));

    const claude = await slot.findByRole("region", { name: "Claude usage" });
    expect(
      within(claude)
        .getAllByRole("listitem")
        .map((step) => step.textContent),
    ).toEqual(["1h72%", "2h54%", "3h36%", "4h18%"]);
  });

  it("says how many resets there are when none lowers usage", async () => {
    const accounts = snapshot.accounts.map((account) => ({
      ...account,
      availableResets: account.id === "claude-max" ? 1 : 0,
    }));
    const slot = await renderDisclosure(() => ({ ...snapshot, accounts }));

    const claude = await slot.findByRole("region", { name: "Claude usage" });
    expect(claude.lastElementChild?.textContent).toBe("1 reset available");
    expect(within(claude).queryByRole("button")).toBeNull();
  });

  it("turns usage red at the configured threshold", async () => {
    const slot = await renderDisclosure(() => snapshot, { redThreshold: 60 });

    const claude = await slot.findByRole("region", { name: "Claude usage" });
    expect(within(claude).getByText("66%").className).toBe("pool-usage-hot");
    expect(within(claude).getByText("5%").className).toBe("");
  });

  it("shows Claude's extra usage spending against its cap", async () => {
    const slot = await renderDisclosure(() => ({
      ...snapshot,
      extraUsage: [
        { provider: "claude-code", used: 558.34, limit: 7000, currency: "USD" },
      ],
    }));

    const claude = await slot.findByRole("region", { name: "Claude usage" });
    const extra = within(claude).getByLabelText("Extra usage");
    expect(extra.textContent).toContain("8%");
    expect(extra.textContent).toContain("$558.34 / $7,000.00");
    expect(within(extra).getByRole("meter").getAttribute("aria-valuenow")).toBe(
      "8",
    );
    const codex = slot.getByRole("region", { name: "Codex usage" });
    expect(within(codex).queryByLabelText("Extra usage")).toBeNull();
  });

  it("announces loading", async () => {
    const slot = await renderDisclosure(() => new Promise(() => undefined));

    expect(slot.getByRole("status").textContent).toBe("Loading account usage…");
  });

  it("says when usage can't be loaded", async () => {
    const slot = await renderDisclosure(() => {
      throw new Error("offline");
    });

    expect(
      (await slot.findByText("Usage could not be loaded.")).getAttribute(
        "role",
      ),
    ).toBe("status");
  });

  it("says when there is no usage to show", async () => {
    const slot = await renderDisclosure(() => empty);

    expect(await slot.findByText(/^No usage to show\./u)).toBeTruthy();
  });
});

describe("footer summary", () => {
  it("stands in for the footer icon between the spacer and bb's badges", async () => {
    const { row, icon, spacer, badges } = renderFooter();
    const { slot, disclosure } = await renderOverlay(() => snapshot);

    const claude = await slot.findByRole("button", {
      name: "Claude: 66% used",
    });
    const codex = slot.getByRole("button", { name: "Codex: 90% used" });
    const summary = spacer.nextElementSibling;
    expect(summary?.className).toBe("pool-usage-footer");
    expect(summary?.nextElementSibling).toBe(badges);
    expect(summary?.contains(claude) && summary.contains(codex)).toBe(true);
    expect(icon.hasAttribute("data-pool-usage-anchor")).toBe(true);
    expect(within(codex).getByText("90%").className).toBe("pool-usage-hot");
    expect(within(claude).getByText("66%").className).toBe("");
    expect(disclosure.runtime.getSnapshot().command).toBeNull();

    slot.lifecycle.unmount();
    expect(row.querySelector(".pool-usage-footer")).toBeNull();
    expect(icon.hasAttribute("data-pool-usage-anchor")).toBe(false);
  });

  it("moves back behind the spacer when bb replaces it", async () => {
    const { row, spacer, badges } = renderFooter();
    const { slot } = await renderOverlay(() => snapshot);
    await slot.findByRole("button", { name: "Claude: 66% used" });

    const replacement = spacer.cloneNode() as HTMLElement;
    spacer.remove();
    row.insertBefore(replacement, badges);

    await waitFor(() =>
      expect(replacement.nextElementSibling?.className).toBe(
        "pool-usage-footer",
      ),
    );
  });

  it("goes last in a row without a spacer", async () => {
    const { row, spacer } = renderFooter();
    spacer.remove();
    const { slot } = await renderOverlay(() => snapshot);

    await slot.findByRole("button", { name: "Claude: 66% used" });
    expect(row.lastElementChild?.className).toBe("pool-usage-footer");
  });

  it("opens one provider's card on click until Escape or a press outside", async () => {
    renderFooter();
    const { slot } = await renderOverlay(() => snapshot);
    const codex = await slot.findByRole("button", { name: "Codex: 90% used" });

    fireEvent.click(codex);
    const card = slot.getByRole("dialog", { name: "Codex usage" });
    expect(codex.getAttribute("aria-expanded")).toBe("true");
    expect(within(card).queryByText("Claude")).toBeNull();
    expect(
      within(card).getByRole("list", { name: "Upcoming resets" }),
    ).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(slot.queryByRole("dialog")).toBeNull();

    fireEvent.click(codex);
    fireEvent.pointerDown(document.body);
    expect(slot.queryByRole("dialog")).toBeNull();

    fireEvent.click(codex);
    fireEvent.click(slot.getByRole("button", { name: "Claude: 66% used" }));
    expect(slot.getByRole("dialog").getAttribute("aria-label")).toBe(
      "Claude usage",
    );
    fireEvent.click(slot.getByRole("button", { name: "Claude: 66% used" }));
    expect(slot.queryByRole("dialog")).toBeNull();
  });

  it("opens the card on the side of the button with more room", async () => {
    renderFooter();
    const { slot } = await renderOverlay(() => snapshot);
    const codex = await slot.findByRole("button", { name: "Codex: 90% used" });
    const place = (left: number, top: number) =>
      vi.spyOn(codex, "getBoundingClientRect").mockReturnValue({
        left,
        right: left + 40,
        top,
        bottom: top + 24,
      } as DOMRect);
    const { innerWidth, innerHeight } = window;

    // A footer at the bottom-left of the window.
    place(100, innerHeight - 40);
    fireEvent.click(codex);
    let card = slot.getByRole("dialog", { name: "Codex usage" });
    expect(card.dataset.side).toBe("top");
    expect(card.style.bottom).toBe("46px");
    expect(card.style.left).toBe("100px");
    fireEvent.click(codex);

    // A footer at the top-right, as on a phone with the footer moved up.
    place(innerWidth - 60, 8);
    fireEvent.click(codex);
    card = slot.getByRole("dialog", { name: "Codex usage" });
    expect(card.dataset.side).toBe("bottom");
    expect(card.style.top).toBe("38px");
    expect(card.style.right).toBe("20px");
    expect(card.style.left).toBe("");
  });

  it("keeps the footer icon when usage can't be summarized", async () => {
    const { row, icon } = renderFooter();
    const { slot } = await renderOverlay(() => empty);

    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await pause(50);
    expect(row.querySelector(".pool-usage-footer")).toBeNull();
    expect(icon.hasAttribute("data-pool-usage-anchor")).toBe(false);
  });

  it("attaches once the footer icon appears", async () => {
    const { slot } = await renderOverlay(() => snapshot);
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await pause(50);
    expect(slot.queryByRole("button", { name: /used$/u })).toBeNull();

    const { spacer } = renderFooter();

    await slot.findByRole("button", { name: "Claude: 66% used" });
    expect(spacer.nextElementSibling?.className).toBe("pool-usage-footer");
  });
});

describe("reset", () => {
  /** Asks for the reset on the Codex card and returns its confirmation. */
  async function openConfirmation(slot: RenderedSlot) {
    const codex = await slot.findByRole("region", { name: "Codex usage" });
    fireEvent.click(
      within(codex).getByRole("button", { name: "Reset to 0% (3 available)" }),
    );
    return slot.getByRole("dialog", { name: "Use a Codex reset?" });
  }

  const buttons = (element: HTMLElement) =>
    within(element)
      .getAllByRole("button")
      .map((button) => button.textContent);

  const resetCalls = (slot: RenderedSlot) =>
    slot.inspection.rpcCalls.filter(({ method }) => method === "reset_use");

  it("says what the reset changes before using it", async () => {
    const slot = await renderDisclosure(() => resettable);

    const confirmation = await openConfirmation(slot);

    expect(confirmation.textContent).toContain(
      "Are you sure you want to use a reset, valid until Oct 22, on Personal (codex@example.com, Pro 20x) to drop Codex from 90% to 0%?" +
        "The account goes from 90% to 0% used. On its own, it frees up in 2d. 2 resets stay available.",
    );
    expect(buttons(confirmation)).toEqual(["Cancel", "Use reset"]);
  });

  it("uses no reset on Cancel or Escape and leaves the card open", async () => {
    renderFooter();
    const { slot } = await renderOverlay(() => resettable);
    fireEvent.click(
      await slot.findByRole("button", { name: "Codex: 90% used" }),
    );

    fireEvent.click(
      within(await openConfirmation(slot)).getByRole("button", {
        name: "Cancel",
      }),
    );
    fireEvent.keyDown(await openConfirmation(slot), { key: "Escape" });

    expect(
      slot.queryByRole("dialog", { name: "Use a Codex reset?" }),
    ).toBeNull();
    expect(slot.getByRole("dialog", { name: "Codex usage" })).toBeTruthy();
    expect(resetCalls(slot)).toEqual([]);
  });

  it("uses the reset once, then says so and reads usage again", async () => {
    const slot = await renderDisclosure(() => resettable);

    fireEvent.click(
      within(await openConfirmation(slot)).getByRole("button", {
        name: "Use reset",
      }),
    );

    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(resetCalls(slot)).toEqual([
      {
        method: "reset_use",
        input: { accountId: "codex-pro", requestId: expect.any(String) },
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Used a Codex reset", {
      description: "On Personal (codex@example.com, Pro 20x).",
    });
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(({ method }) => method === "usage_get"),
      ).toHaveLength(2),
    );
  });

  it("tries a failed reset again with the same request", async () => {
    const outcomes = [
      () => {
        throw new Error(
          "Couldn't use the reset. Trying again won't use a second one.",
        );
      },
      () => ({ outcome: "reset" }),
    ];
    const slot = await renderDisclosure(
      () => resettable,
      undefined,
      () => outcomes.shift()!(),
    );
    const confirmation = await openConfirmation(slot);

    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Use reset" }),
    );
    expect((await within(confirmation).findByRole("alert")).textContent).toBe(
      "Couldn't use the reset. Trying again won't use a second one.",
    );
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Try again" }),
    );

    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    const [first, second] = resetCalls(slot);
    expect(second).toEqual(first);
  });

  it("says why a reset was refused and offers only to close", async () => {
    const slot = await renderDisclosure(
      () => resettable,
      undefined,
      () => ({
        outcome: "refused",
        message: "Codex kept the reset (nothing_to_reset). Nothing was used.",
      }),
    );
    const confirmation = await openConfirmation(slot);

    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Use reset" }),
    );

    expect((await within(confirmation).findByRole("alert")).textContent).toBe(
      "Codex kept the reset (nothing_to_reset). Nothing was used.",
    );
    expect(buttons(confirmation)).toEqual(["Close"]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("opens as a bottom sheet on a phone", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const slot = await renderDisclosure(() => resettable);

    const sheet = await openConfirmation(slot);

    expect(sheet.hasAttribute("data-vaul-drawer")).toBe(true);
    expect(buttons(sheet)).toEqual(["Cancel", "Use reset"]);
  });
});
