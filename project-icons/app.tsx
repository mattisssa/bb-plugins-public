// Project icons — frontend.
//
// bb's sidebar renders a project group's title as plain text and offers no
// plugin slot for the group header, so an app overlay watches the DOM: for
// every project wrapper ([data-sidebar-project-id]) it inserts a slot before
// the title and portals an icon button into it. Clicking the icon opens a menu
// to upload an image, pick an emoji, re-detect from the repo, or remove it.
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { IconRow, rpcContract } from "./server";

const SLOT_ATTR = "data-bb-project-icon-slot";
const CHANNEL = "icons";
const SIZE = 16;
const UPLOAD_SIZE = 128;

const EMOJI_GRID = [
  "🚀", "🧩", "🔧", "🧪", "📦", "🧭", "🎯", "🪄",
  "🔮", "🌱", "🔥", "⚡️", "🌊", "🪐", "🎲", "🎨",
  "🛠️", "🗺️", "📡", "🦊", "🐙", "🦉", "🐝", "🦄",
  "🍋", "🍉", "🥑", "🌵", "🎸", "🎧", "📚", "✈️",
];

type Icons = ReadonlyMap<string, IconRow>;

// ---------- DOM: find the header label of a project group ----------

function headerLabel(wrapper: HTMLElement): HTMLElement | null {
  // wrapper > div[data-sidebar-rename-row] > [data-sidebar="group-label"] > span > span[title]{name}
  const row = wrapper.querySelector<HTMLElement>(":scope > [data-sidebar-rename-row]");
  if (row === null) return null;
  const label = row.querySelector<HTMLElement>(':scope > [data-sidebar="group-label"] span[title]');
  return label !== null && label.closest("[data-sidebar-rename-row]") === row ? label : null;
}

/** Ensures every project header has a slot element; returns projectId → slot. */
function collectSlots(): Map<string, HTMLElement> {
  const slots = new Map<string, HTMLElement>();
  for (const wrapper of document.querySelectorAll<HTMLElement>("[data-sidebar-project-id]")) {
    const projectId = wrapper.dataset.sidebarProjectId;
    if (projectId === undefined) continue;
    const label = headerLabel(wrapper);
    const parent = label?.parentElement ?? null;
    if (label === null || parent === null) continue;
    const previous = label.previousElementSibling;
    let slot: HTMLElement;
    if (previous instanceof HTMLElement && previous.getAttribute(SLOT_ATTR) === projectId) {
      slot = previous;
    } else {
      slot = document.createElement("span");
      slot.setAttribute(SLOT_ATTR, projectId);
      Object.assign(slot.style, { display: "inline-flex", flex: "0 0 auto", alignItems: "center" });
      parent.insertBefore(slot, label);
    }
    slots.set(projectId, slot);
  }
  return slots;
}

function sameSlots(a: Map<string, HTMLElement>, b: Map<string, HTMLElement>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function useProjectSlots(): Map<string, HTMLElement> {
  const [slots, setSlots] = useState<Map<string, HTMLElement>>(() => new Map());
  useEffect(() => {
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      const next = collectSlots();
      setSlots((prev) => (sameSlots(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(sync);
    };
    sync();
    const observer = new MutationObserver((records) => {
      // Ignore mutations inside our own slots (menu open/close, re-renders).
      if (records.every((r) => r.target instanceof Element && r.target.closest(`[${SLOT_ATTR}]`) !== null)) return;
      schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      for (const slot of document.querySelectorAll(`[${SLOT_ATTR}]`)) slot.remove();
    };
  }, []);
  return slots;
}

// ---------- image upload ----------

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml,image/gif";
    input.style.display = "none";
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    input.oncancel = () => {
      resolve(null);
      input.remove();
    };
    document.body.append(input);
    input.click();
  });
}

/** Downscales to a UPLOAD_SIZE square PNG data URL (keeps aspect ratio, transparent padding). */
async function toIconDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not decode the image"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = UPLOAD_SIZE;
    canvas.height = UPLOAD_SIZE;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("Canvas is unavailable");
    const scale = Math.min(UPLOAD_SIZE / img.naturalWidth, UPLOAD_SIZE / img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (UPLOAD_SIZE - w) / 2, (UPLOAD_SIZE - h) / 2, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- UI ----------

const menuStyle: CSSProperties = {
  minWidth: 180,
  padding: 4,
  borderRadius: 8,
  background: "var(--popover, #1c1c1e)",
  color: "var(--popover-foreground, #f2f2f2)",
  border: "1px solid var(--border, rgba(127,127,127,0.35))",
  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  fontSize: 13,
  zIndex: 1000,
};
const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 6,
  cursor: "default",
  outline: "none",
  userSelect: "none",
};
const itemCss = `
[data-bb-project-icon-menu] [data-highlighted] { background: var(--accent, rgba(127,127,127,0.2)); color: var(--accent-foreground, inherit); }
[${SLOT_ATTR}] button { opacity: 1; transition: opacity 120ms; }
[${SLOT_ATTR}] button[data-empty="true"] { opacity: 0; }
[data-sidebar-rename-row]:hover [${SLOT_ATTR}] button[data-empty="true"],
[${SLOT_ATTR}] button[data-empty="true"][data-state="open"] { opacity: 0.5; }
`;

function Glyph({ icon }: { icon: IconRow | undefined }) {
  if (icon?.kind === "image") {
    return (
      <img
        src={icon.data}
        alt=""
        draggable={false}
        style={{ width: SIZE, height: SIZE, borderRadius: 4, objectFit: "cover", display: "block" }}
      />
    );
  }
  if (icon?.kind === "emoji") {
    return <span style={{ fontSize: 13, lineHeight: `${SIZE}px`, width: SIZE, textAlign: "center", display: "block" }}>{icon.data}</span>;
  }
  return (
    <span
      style={{
        width: SIZE - 4,
        height: SIZE - 4,
        margin: 2,
        borderRadius: "50%",
        border: "1.5px dashed currentColor",
        display: "block",
        boxSizing: "border-box",
      }}
    />
  );
}

function IconButton({
  projectId,
  icon,
  onChanged,
}: {
  projectId: string;
  icon: IconRow | undefined;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  const run = useCallback(
    async (work: () => Promise<string | null>) => {
      setBusy(true);
      try {
        const message = await work();
        if (message !== null) toast.success(message);
        onChanged();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const upload = () =>
    run(async () => {
      const file = await pickFile();
      if (file === null) return null;
      const data = await toIconDataUrl(file);
      await rpc.call("set", { projectId, kind: "image", data });
      return "Icon updated";
    });
  const setEmoji = (emoji: string) =>
    run(async () => {
      await rpc.call("set", { projectId, kind: "emoji", data: emoji });
      return null;
    });
  const customEmoji = () => {
    const value = window.prompt("Emoji for this project", icon?.kind === "emoji" ? icon.data : "")?.trim();
    if (value) void setEmoji(value);
  };
  const redetect = () =>
    run(async () => {
      const { found } = await rpc.call("redetect", { projectId });
      return found ? "Icon found in the project folder" : "No icon in the folder, using an emoji";
    });
  const remove = () =>
    run(async () => {
      await rpc.call("remove", { projectId });
      return null;
    });

  const empty = icon === undefined || icon.kind === "none";
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button
          type="button"
          data-empty={empty ? "true" : "false"}
          aria-label="Project icon"
          title="Project icon"
          disabled={busy}
          onPointerDown={stop}
          onClick={stop}
          onKeyDown={stop}
          style={{
            // Reset the host button styles explicitly; `all: unset` inline would
            // also override the opacity rules in itemCss.
            display: "block",
            width: SIZE,
            height: SIZE,
            margin: "0 6px 0 0",
            padding: 0,
            border: 0,
            background: "none",
            color: "inherit",
            font: "inherit",
            lineHeight: 1,
            cursor: "pointer",
            flex: "0 0 auto",
          }}
        >
          <Glyph icon={icon} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content data-bb-project-icon-menu="" align="start" sideOffset={4} style={menuStyle} onClick={stop} onPointerDown={stop}>
          <Menu.Item style={itemStyle} onSelect={upload}>
            Upload image…
          </Menu.Item>
          <Menu.Sub>
            <Menu.SubTrigger style={itemStyle}>Emoji ▸</Menu.SubTrigger>
            <Menu.Portal>
              <Menu.SubContent data-bb-project-icon-menu="" sideOffset={6} style={{ ...menuStyle, minWidth: 0 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 28px)", gap: 2 }}>
                  {EMOJI_GRID.map((e) => (
                    <Menu.Item
                      key={e}
                      style={{ ...itemStyle, padding: 0, width: 28, height: 28, justifyContent: "center", fontSize: 16 }}
                      onSelect={() => void setEmoji(e)}
                    >
                      {e}
                    </Menu.Item>
                  ))}
                </div>
                <Menu.Separator style={{ height: 1, margin: "4px 0", background: "var(--border, rgba(127,127,127,0.35))" }} />
                <Menu.Item style={itemStyle} onSelect={customEmoji}>
                  Custom…
                </Menu.Item>
              </Menu.SubContent>
            </Menu.Portal>
          </Menu.Sub>
          <Menu.Item style={itemStyle} onSelect={redetect}>
            Find in project folder
          </Menu.Item>
          {!empty && (
            <>
              <Menu.Separator style={{ height: 1, margin: "4px 0", background: "var(--border, rgba(127,127,127,0.35))" }} />
              <Menu.Item style={{ ...itemStyle, color: "var(--destructive, #ff6b6b)" }} onSelect={remove}>
                Remove icon
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ProjectIconsOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const slots = useProjectSlots();
  const [icons, setIcons] = useState<Icons>(() => new Map());
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { icons: rows } = await rpc.call("list");
      if (alive.current) setIcons(new Map(rows.map((r) => [r.projectId, r])));
    } catch {
      // Keep whatever we had; the next signal or sweep will retry.
    }
  }, [rpc]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    // Ask the server to fill in any project it has not seen yet; it signals when done.
    void rpc.call("resolveMissing").catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, [rpc, refresh]);
  useRealtime(CHANNEL, () => void refresh());

  return (
    <>
      <style>{itemCss}</style>
      {[...slots].map(([projectId, slot]) =>
        createPortal(<IconButton projectId={projectId} icon={icons.get(projectId)} onChanged={refresh} />, slot, projectId),
      )}
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "project-icons", component: ProjectIconsOverlay });
});
