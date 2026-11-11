import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ComponentPropsWithRef,
  type ClipboardEvent as ReactClipboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  CHANNEL,
  COLORS,
  MARK_COLOR,
  PANEL_ID,
  STICKY_BACKGROUND,
  STICKY_SIZE,
  assetUrl,
  boardInk,
  boundsOf,
  constrainLine,
  contentBounds,
  intersects,
  isStroke,
  isTextElement,
  marksOf,
  imageViewport,
  exportUrl,
  type CanvasElement,
  type StrokeElement,
  type ImageElement,
  type TextLikeElement,
  type Point,
  type Bounds,
} from "./model";
import type { rpcContract } from "./server";
import { CanvasSession } from "./session";
import { imageData } from "./images";
import {
  CANVAS_CLIPBOARD_TYPE,
  decodeClipboard,
  duplicateElements,
  encodeClipboard,
  validatePaste,
  type CanvasClipboard,
} from "./clipboard";
import { Icon } from "./icons";
import { BrowserCapture } from "./browser-capture";
import { ImageCrop } from "./image-crop";
import { CanvasArtwork } from "./artwork";
import { ResizeHandles } from "./resize-handles";
import { applyCrop } from "./crop";
import { layoutSticky, stickyPadding } from "./layout";
import { acknowledgeReveal, revealSnapshot, subscribeReveal } from "./reveal";
import { useStateRef } from "./use-state-ref";
import "./style.css";

const TOOLS = [
  { id: "select", key: "v", label: "Select (V)" },
  { id: "sticky", key: "s", label: "Sticky note (S)" },
  { id: "text", key: "t", label: "Text (T)" },
  { id: "arrow", key: "a", label: "Arrow (A)" },
  { id: "draw", key: "d", label: "Draw (D)" },
  { id: "mark", key: "f", label: "Feedback (F)" },
] as const;
type Tool = (typeof TOOLS)[number]["id"];
const SIZE_PRESETS = {
  draw: [
    { value: 1, preview: 3, label: "Thin stroke (1)" },
    { value: 3, preview: 6, label: "Medium stroke (3)" },
    { value: 8, preview: 10, label: "Thick stroke (8)" },
  ],
  text: [
    { value: 18, preview: 12, label: "Small text (18)" },
    { value: 24, preview: 16, label: "Medium text (24)" },
    { value: 48, preview: 20, label: "Large text (48)" },
  ],
} as const;
type View = { x: number; y: number; zoom: number };
type Gesture =
  | { kind: "pan"; start: Point; view: View }
  | { kind: "move"; start: Point; originals: CanvasElement[] }
  | {
      kind: "resize";
      start: Point;
      original: CanvasElement;
      box: Bounds;
      corner: string;
    }
  | { kind: "draw"; start: Point; element: StrokeElement }
  | { kind: "marquee"; start: Point; extend: string[] };
const sessions = new Map<string, CanvasSession>();
const uid = () => crypto.randomUUID();
const isInput = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest("input, textarea, select, [contenteditable=true]");
function Button({
  icon,
  label,
  children,
  active,
  ...props
}: {
  icon: string;
  label: string;
  children?: ReactNode;
  active?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="cv-button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...props}
    >
      <Icon name={icon} />
      {children}
    </button>
  );
}
function ColorChoices({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div className="cv-colors" role="group" aria-label="Color">
      {COLORS.map(([label, color]) => (
        <button
          key={color}
          type="button"
          className="cv-swatch"
          aria-label={label}
          aria-pressed={value === color}
          title={label}
          style={{ "--swatch": boardInk(color) } as CSSProperties}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}
function CanvasTextEditor({
  text,
  ref,
  ...props
}: Omit<ComponentPropsWithRef<"textarea">, "value" | "defaultValue"> & {
  text: string;
}) {
  // Keep the native value/caret while onChange updates the canvas draft.
  // Even an unchanged defaultValue replaces the textarea's text node on each
  // React render, making ancestor :has() selectors restyle the whole thread.
  // Initialize .value once and leave its DOM children empty for this edit.
  const input = useRef<HTMLTextAreaElement>(null);
  const initialText = useRef(text);
  useImperativeHandle(ref, () => input.current!, []);
  useLayoutEffect(() => {
    input.current!.value = initialText.current;
  }, []);
  return <textarea {...props} ref={input} />;
}
function MarkComment({
  text,
  style,
  onClose,
}: {
  text: string;
  style: CSSProperties;
  /** `text` is null when the user cancels; `keyboard` when a key closed it. */
  onClose(text: string | null, keyboard: boolean): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const closed = useRef(false);
  const close = (value: string | null, keyboard: boolean) => {
    if (closed.current) return;
    closed.current = true;
    onClose(value, keyboard);
  };
  // Set .value once, as CanvasTextEditor does, to keep the DOM children empty.
  useLayoutEffect(() => {
    input.current!.value = text;
    input.current!.focus({ preventScroll: true });
  }, []);
  return (
    <div
      className="cv-comment"
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <textarea
        ref={input}
        rows={3}
        maxLength={4_000}
        aria-label="Feedback for this area"
        placeholder="Feedback for this area"
        onBlur={(event) => close(event.currentTarget.value, false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            close(null, true);
          } else if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            close(event.currentTarget.value, true);
          }
        }}
      />
      <span>Enter: save · Shift+Enter: new line · Esc: cancel</span>
    </div>
  );
}
function readView(threadId: string): View {
  try {
    const view = JSON.parse(
      localStorage.getItem(`canvas:view:${threadId}`) ?? "null",
    );
    if (
      view &&
      Number.isFinite(view.x) &&
      Number.isFinite(view.y) &&
      view.zoom >= 0.1 &&
      view.zoom <= 4
    )
      return view;
  } catch {
    /* Use the initial viewport. */
  }
  return { x: 32, y: 48, zoom: 0.75 };
}
function textSize(
  text: string,
  fontSize: number,
): { width: number; height: number } {
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = `${fontSize}px "Canvas Sans"`;
  return {
    width: Math.max(
      24,
      ...text.split("\n").map((line) => context.measureText(line).width + 4),
    ),
    height: Math.max(fontSize * 1.3, text.split("\n").length * fontSize * 1.3),
  };
}
function textBounds(element: TextLikeElement) {
  if (element.type === "sticky") {
    const side = Math.max(64, element.width, element.height);
    return { width: side, height: side };
  }
  const size = textSize(element.text || "Text", element.fontSize);
  return size;
}
function CanvasPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [session] = useState(() => {
    let value = sessions.get(threadId);
    if (!value) {
      value = new CanvasSession(
        {
          read: () => rpc.call("getCanvas", { threadId }),
          update: (patch) => rpc.call("updateCanvas", { threadId, patch }),
        },
        `canvas:draft:${threadId}`,
      );
      sessions.set(threadId, value);
    }
    return value;
  });
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const reveal = useSyncExternalStore(subscribeReveal, () =>
    revealSnapshot(threadId),
  );
  const root = useRef<HTMLDivElement>(null),
    surface = useRef<HTMLDivElement>(null),
    picker = useRef<HTMLInputElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null);
  const [tool, setTool] = useState<Tool>("select"),
    [color, setColor] = useState<string>(COLORS[0][1]);
  const [fontSize, setFontSize] = useState(24),
    [strokeWidth, setStrokeWidth] = useState(3);
  const [view, setView] = useState(() => readView(threadId)),
    [size, setSize] = useState({ width: 400, height: 600 });
  const [selected, setSelected] = useState<string[]>([]),
    [marquee, setMarquee] = useState<Bounds | null>(null);
  const [preview, updatePreview, previewRef] = useStateRef<
    CanvasElement[] | null
  >(null);
  const [editing, setEditing, editingRef] = useStateRef<TextLikeElement | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting, importLock] = useStateRef(false);
  // The feedback outline whose comment is open; `fresh` until first saved.
  const [comment, setComment, commentRef] = useStateRef<{
    id: string;
    fresh: boolean;
  } | null>(null);
  const [sending, setSending, sendLock] = useStateRef(false);
  const [cropping, setCropping, croppingRef] = useStateRef<{
    image: ImageElement;
    frame: Bounds;
  } | null>(null);
  const gesture = useRef<(Gesture & { pointerId: number }) | null>(null),
    space = useRef(false),
    revealed = useRef<string | undefined>(undefined);
  const lastPaste = useRef<{ copyId: string; count: number } | null>(null);
  const pasteQueue = useRef(Promise.resolve());
  const drafts = new Map(state.board.elements.map((item) => [item.id, item]));
  for (const item of preview ?? []) drafts.set(item.id, item);
  if (editing) drafts.set(editing.id, editing);
  const elements = [...drafts.values()];
  const selection = elements.filter((element) => selected.includes(element.id));
  const single = selection.length === 1 ? selection[0]! : null;
  const canMove = (element: CanvasElement) =>
    tool === "select" || element.type !== "image";
  const styled = editing ?? (single?.type === "image" ? null : single);
  const marks = marksOf(elements);
  const commented = marks.find((mark) => mark.id === comment?.id);
  // Feedback outlines stay visible on screenshots: never the default graphite.
  const inkColor =
    tool === "mark" && color === COLORS[0][1] ? MARK_COLOR : color;
  const activeColor = styled?.color ?? inkColor;
  const propertyKind = styled
    ? isStroke(styled)
      ? "draw"
      : styled.type
    : tool === "select"
      ? null
      : tool === "arrow" || tool === "mark"
        ? "draw"
        : tool;
  const editingLayout = useMemo(
    () => (editing?.type === "sticky" ? layoutSticky(editing) : null),
    [editing],
  );
  const activeSize =
    propertyKind === "draw"
      ? isStroke(styled)
        ? styled.strokeWidth
        : strokeWidth
      : isTextElement(styled)
        ? styled.fontSize
        : fontSize;
  const showProperties =
    tool !== "select" || selection.some((element) => element.type !== "image");
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    void session.refresh();
  }, [session, connection]);
  useRealtime(
    CHANNEL,
    useCallback(
      (event: unknown) => {
        if (
          typeof event === "object" &&
          event &&
          "threadId" in event &&
          event.threadId === threadId
        )
          void session.refresh();
      },
      [session, threadId],
    ),
  );
  useEffect(() => {
    if (!surface.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width && entry.contentRect.height)
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(surface.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(`canvas:view:${threadId}`, JSON.stringify(view));
    } catch {
      /* View persistence is optional. */
    }
  }, [threadId, view]);
  useEffect(() => {
    if (editing) {
      textarea.current?.focus();
      textarea.current?.select();
    }
  }, [editing?.id]);
  useEffect(() => {
    if (!reveal || revealed.current === reveal) return;
    const item = state.board.elements.find((element) => element.id === reveal);
    if (!item) return;
    setView(frameView(boundsOf(item), 1, 32));
    setSelected([reveal]);
    revealed.current = reveal;
    acknowledgeReveal(threadId, reveal);
  }, [reveal, state.board, size]);
  useEffect(() => {
    const clear = () => {
      space.current = false;
    };
    window.addEventListener("blur", clear);
    return () => window.removeEventListener("blur", clear);
  }, []);
  const world = (event: { clientX: number; clientY: number }): Point => {
    const rect = surface.current!.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - view.x) / view.zoom,
      y: (event.clientY - rect.top - view.y) / view.zoom,
    };
  };
  const center = (): Point => ({
    x: (size.width / 2 - view.x) / view.zoom,
    y: (size.height / 2 - view.y) / view.zoom,
  });
  function focus() {
    root.current?.focus({ preventScroll: true });
  }
  function commit(upserts: CanvasElement[], removeIds: string[] = []) {
    try {
      session.commit({ upserts, removeIds });
      return true;
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }
  function finishText(cancel = false) {
    const current = editingRef.current;
    if (!current) return true;
    if (!cancel && current.text.trim()) {
      if (current.width > 20_000 || current.height > 20_000) {
        setNotice(
          "This text is too large. Use fewer characters, add line breaks, or choose a smaller size.",
        );
        return false;
      }
      if (!commit([current])) return false;
    } else if (
      !cancel &&
      state.board.elements.some((element) => element.id === current.id)
    )
      commit([], [current.id]);
    setEditing(null);
    setTool("select");
    setNotice(null);
    return true;
  }
  function startText(point: Point, sticky = false) {
    const base = {
      id: uid(),
      x: point.x,
      y: point.y,
      text: "",
      fontSize,
      color,
      width: 0,
      height: 0,
    };
    const element: TextLikeElement = sticky
      ? {
          ...base,
          type: "sticky",
          background: STICKY_BACKGROUND,
          width: STICKY_SIZE,
          height: STICKY_SIZE,
          fontSize: 24,
        }
      : { ...base, type: "text" };
    setEditing({ ...element, ...textBounds(element) });
    setSelected([element.id]);
  }
  function closeComment(text: string | null, keyboard: boolean) {
    const current = commentRef.current;
    if (!current) return;
    setComment(null);
    if (keyboard) focus();
    const mark = session
      .snapshot()
      .board.elements.find((element) => element.id === current.id);
    if (mark?.type !== "mark") return;
    if (text === null) {
      // Escape on a new outline discards it; on a saved one keeps its comment.
      if (current.fresh && commit([], [mark.id])) setSelected([]);
    } else if (text.trim() !== mark.text)
      commit([{ ...mark, text: text.trim() }]);
  }
  function saved() {
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const { error, loaded, saving } = session.snapshot();
        if (error) done(new Error(`Not saved: ${error}`));
        else if (loaded && !saving) done();
      };
      const timer = setTimeout(
        () => done(new Error("Canvas is still saving. Send again shortly.")),
        15_000,
      );
      const unsubscribe = session.subscribe(check);
      check();
    });
  }
  async function sendFeedback() {
    if (sendLock.current) return;
    setSending(true);
    setNotice(null);
    try {
      // The server sends the saved board, so the last comment must land first.
      await saved();
      const { ids } = await rpc.call("sendCanvasFeedback", { threadId });
      // Sent outlines leave the board; Undo brings them back.
      if (commit([], ids)) setSelected([]);
      setNotice(
        `Sent ${ids.length} comment${ids.length === 1 ? "" : "s"} to the thread.`,
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }
  function changeText(element: TextLikeElement, caret?: number) {
    setEditing({ ...element, ...textBounds(element) });
    if (caret !== undefined) revealTextCaret(element, caret);
  }
  function revealTextCaret(element: TextLikeElement, caret: number) {
    if (element.type === "sticky") return;
    // Follow the caret as the unwrapped line grows beyond the visible canvas.
    const lines = element.text.slice(0, caret).split("\n");
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${element.fontSize}px "Canvas Sans"`;
    const x = element.x + context.measureText(lines.at(-1)!).width + 4;
    const y = element.y + (lines.length - 1) * element.fontSize * 1.3;
    setView((current) => {
      const left = current.x + x * current.zoom;
      const top = current.y + y * current.zoom;
      const bottom = top + element.fontSize * 1.3 * current.zoom;
      const dx = left < 24 ? 24 - left : Math.min(0, size.width - 24 - left);
      const dy = top < 24 ? 24 - top : Math.min(0, size.height - 24 - bottom);
      return dx || dy
        ? { ...current, x: current.x + dx, y: current.y + dy }
        : current;
    });
  }
  function chooseTool(next: Tool) {
    cancelGesture();
    if (!finishText()) {
      textarea.current?.focus({ preventScroll: true });
      return;
    }
    if (!finishCrop({ deselect: true, restoreFocus: false })) return;
    setTool(next);
    if (next !== "select") setSelected([]);
    focus();
  }
  function chooseColor(value: string) {
    setColor(value);
    if (editingRef.current) {
      setEditing({ ...editingRef.current, color: value });
      textarea.current?.focus({ preventScroll: true });
      return;
    }
    const changed = selection
      .filter((element) => element.type !== "image")
      .map((element) => ({ ...element, color: value }));
    if (changed.length) commit(changed);
  }
  function chooseSize(value: number) {
    if (!Number.isFinite(value)) return;
    if (propertyKind === "draw") {
      value = Math.max(1, Math.min(32, value));
      setStrokeWidth(value);
      if (isStroke(single)) commit([{ ...single, strokeWidth: value }]);
    } else {
      value = Math.max(8, Math.min(160, value));
      setFontSize(value);
      if (editingRef.current) {
        changeText(
          { ...editingRef.current, fontSize: value },
          textarea.current?.selectionEnd,
        );
        textarea.current?.focus({ preventScroll: true });
        return;
      }
      if (isTextElement(single))
        commit([
          {
            ...single,
            fontSize: value,
            ...textBounds({ ...single, fontSize: value }),
          },
        ]);
    }
  }
  function frameView(box: Bounds, maxZoom = 1.5, padding = 0): View {
    const zoom = Math.max(
      0.1,
      Math.min(
        maxZoom,
        (size.width - padding * 2) / box.width,
        (size.height - padding * 2) / box.height,
      ),
    );
    return {
      x: (size.width - box.width * zoom) / 2 - box.x * zoom,
      y: (size.height - box.height * zoom) / 2 - box.y * zoom,
      zoom,
    };
  }
  function zoomAt(
    factor: number,
    anchor = { x: size.width / 2, y: size.height / 2 },
  ) {
    setView((old) => {
      const zoom = Math.max(0.1, Math.min(4, old.zoom * factor));
      return {
        x: anchor.x - ((anchor.x - old.x) * zoom) / old.zoom,
        y: anchor.y - ((anchor.y - old.y) * zoom) / old.zoom,
        zoom,
      };
    });
  }
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (isInput(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        const rect = node.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.01), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      } else
        setView((old) => ({
          ...old,
          x: old.x - event.deltaX,
          y: old.y - event.deltaY,
        }));
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [size]);
  async function runImport(operation: () => Promise<void>, reportBusy = false) {
    if (!session.snapshot().loaded) {
      setNotice("Wait for Canvas to load, then paste again.");
      return;
    }
    if (importLock.current) {
      if (reportBusy)
        setNotice("Wait for the image import to finish before pasting.");
      return;
    }
    cancelGesture();
    if (!finishCrop({ deselect: true, restoreFocus: false })) return;
    setImporting(true);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  }
  function insert(added: CanvasElement[]) {
    if (!added.length || !commit(added)) return false;
    setSelected(added.map((element) => element.id));
    focus();
    return true;
  }
  function insertFiles(files: File[] | Blob[], point = center()) {
    return runImport(async () => {
      const added: CanvasElement[] = [];
      for (const [index, file] of files.entries()) {
        const base64 = await imageData(file);
        const asset = await rpc.call("uploadCanvasImage", { threadId, base64 });
        const scale = Math.min(1, 600 / asset.width, 600 / asset.height);
        const width = asset.width * scale,
          height = asset.height * scale;
        added.push({
          id: uid(),
          type: "image",
          assetId: asset.id,
          x: point.x - width / 2 + index * 24,
          y: point.y - height / 2 + index * 24,
          width,
          height,
          name: (file instanceof File ? file.name : "Screenshot").slice(0, 240),
        });
      }
      if (insert(added)) setTool("select");
    });
  }
  function insertElements(clipboard: CanvasClipboard) {
    if (!finishCrop({ deselect: true, restoreFocus: false }))
      return Promise.resolve();
    // Preserve every paste when copying images from another thread takes time.
    const next = () => pasteElements(clipboard);
    pasteQueue.current = pasteQueue.current.then(next, next);
    return pasteQueue.current;
  }
  function pasteElements(clipboard: CanvasClipboard) {
    return runImport(async () => {
      const count =
        lastPaste.current?.copyId === clipboard.copyId
          ? lastPaste.current.count + 1
          : 1;
      const added = duplicateElements(clipboard.elements, count * 24);
      validatePaste(session.snapshot().board, added);
      if (clipboard.sourceThreadId !== threadId) {
        const assets = new Map<string, string>();
        for (const element of added) {
          if (element.type !== "image") continue;
          let assetId = assets.get(element.assetId);
          if (!assetId) {
            const response = await fetch(
              assetUrl(clipboard.sourceThreadId, element.assetId),
            );
            if (!response.ok)
              throw new Error(
                "A copied image is no longer available. Copy it again from its canvas.",
              );
            const base64 = await imageData(await response.blob());
            const asset = await rpc.call("uploadCanvasImage", {
              threadId,
              base64,
            });
            assetId = asset.id;
            assets.set(element.assetId, assetId);
          }
          element.assetId = assetId;
        }
      }
      // Other edits or realtime updates may have arrived during image imports.
      validatePaste(session.snapshot().board, added);
      if (!insert(added)) return;
      lastPaste.current = { copyId: clipboard.copyId, count };
      const box = contentBounds(added);
      const viewport = {
        x: -view.x / view.zoom,
        y: -view.y / view.zoom,
        width: size.width / view.zoom,
        height: size.height / view.zoom,
      };
      if (!intersects(box, viewport))
        setView({
          ...view,
          x: size.width / 2 - (box.x + box.width / 2) * view.zoom,
          y: size.height / 2 - (box.y + box.height / 2) * view.zoom,
        });
    }, true);
  }
  async function paste() {
    focus();
    try {
      if (!navigator.clipboard?.read)
        throw new Error("Click the canvas and press ⌘V / Ctrl+V to paste.");
      const items = await navigator.clipboard.read();
      const files: Blob[] = [];
      for (const item of items) {
        for (const type of [CANVAS_CLIPBOARD_TYPE, "text/plain"]) {
          if (!item.types.includes(type)) continue;
          const clipboard = decodeClipboard(
            await (await item.getType(type)).text(),
          );
          if (clipboard) {
            await insertElements(clipboard);
            return;
          }
        }
        const type = item.types.find((value) => value.startsWith("image/"));
        if (type) files.push(await item.getType(type));
      }
      if (!files.length)
        throw new Error(
          "Copy Canvas elements or an image first, then paste here.",
        );
      await insertFiles(files);
    } catch (cause) {
      setNotice(
        cause instanceof Error && cause.name !== "NotAllowedError"
          ? cause.message
          : "Click the canvas and press ⌘V / Ctrl+V to paste, or use Add image.",
      );
    }
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      gesture.current ||
      cropping ||
      !state.loaded ||
      importing ||
      isInput(event.target) ||
      event.button > 1
    )
      return;
    if (editingRef.current) {
      finishText();
      return;
    }
    focus();
    event.preventDefault();
    event.stopPropagation();
    const point = world(event);
    const target = event.target as Element;
    const handle = target.closest("[data-corner]")?.getAttribute("data-corner");
    const id = target.closest("[data-element]")?.getAttribute("data-element");
    const hit = elements.find((element) => element.id === id);
    const start = (next: Gesture) => {
      gesture.current = { ...next, pointerId: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
    };
    // Images are surfaces for annotations unless Select is active. Mouse and
    // pen can still grab text and strokes; touch keeps the selected tool.
    const useTool =
      tool !== "select" &&
      (hit?.type === "image" || event.altKey || event.pointerType === "touch");
    if (event.button === 1 || space.current)
      start({
        kind: "pan",
        start: { x: event.clientX, y: event.clientY },
        view,
      });
    else if (
      handle &&
      single &&
      canMove(single) &&
      !(event.altKey && tool !== "select")
    )
      start({
        kind: "resize",
        start: point,
        original: single,
        box: boundsOf(single),
        corner: handle,
      });
    else if (id && !useTool) {
      const candidates = event.shiftKey
        ? selected.includes(id)
          ? selected.filter((value) => value !== id)
          : [...selected, id]
        : selected.includes(id)
          ? selected
          : [id];
      const ids = candidates.filter((id) =>
        state.board.elements.some(
          (element) => element.id === id && canMove(element),
        ),
      );
      setSelected(ids);
      start({
        kind: "move",
        start: point,
        originals: state.board.elements.filter((element) =>
          ids.includes(element.id),
        ),
      });
    } else if (tool === "text" || tool === "sticky") {
      startText(point, tool === "sticky");
      return;
    } else if (tool === "draw" || tool === "arrow" || tool === "mark") {
      const base = {
        id: uid(),
        x: point.x,
        y: point.y,
        color: inkColor,
        strokeWidth,
      };
      const element: StrokeElement =
        tool === "arrow"
          ? {
              ...base,
              type: "arrow",
              points: [
                [0, 0],
                [0, 0],
              ],
            }
          : tool === "mark"
            ? { ...base, type: "mark", points: [[0, 0]], text: "" }
            : { ...base, type: "draw", points: [[0, 0]] };
      start({ kind: "draw", start: point, element });
      updatePreview([element]);
      setSelected([]);
    } else {
      if (event.pointerType === "touch") {
        setSelected([]);
        start({
          kind: "pan",
          start: { x: event.clientX, y: event.clientY },
          view,
        });
      } else {
        start({
          kind: "marquee",
          start: point,
          extend: event.shiftKey ? selected : [],
        });
        if (!event.shiftKey) setSelected([]);
      }
    }
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const point = world(event);
    if (current.kind === "pan") {
      setView({
        ...current.view,
        x: current.view.x + event.clientX - current.start.x,
        y: current.view.y + event.clientY - current.start.y,
      });
      return;
    }
    if (current.kind === "move") {
      updatePreview(
        current.originals.map((element) => ({
          ...element,
          x: element.x + (point.x - current.start.x),
          y: element.y + (point.y - current.start.y),
        })),
      );
      return;
    }
    if (current.kind === "draw") {
      const end = event.shiftKey ? constrainLine(current.start, point) : point;
      const relative: [number, number] = [
        end.x - current.start.x,
        end.y - current.start.y,
      ];
      if (current.element.type === "arrow" || event.shiftKey)
        current.element = { ...current.element, points: [[0, 0], relative] };
      else if (
        current.element.points.length < 6000 &&
        (current.element.points.at(-1)![0] !== relative[0] ||
          current.element.points.at(-1)![1] !== relative[1])
      )
        current.element = {
          ...current.element,
          points: [...current.element.points, relative],
        };
      updatePreview([current.element]);
      return;
    }
    if (current.kind === "marquee") {
      setMarquee({
        x: Math.min(point.x, current.start.x),
        y: Math.min(point.y, current.start.y),
        width: Math.abs(point.x - current.start.x),
        height: Math.abs(point.y - current.start.y),
      });
      return;
    }
    const { box, corner, original } = current;
    const left = corner.includes("w"),
      top = corner.includes("n");
    const anchor = {
      x: left ? box.x + box.width : box.x,
      y: top ? box.y + box.height : box.y,
    };
    const dx = (point.x - anchor.x) * (left ? -1 : 1),
      dy = (point.y - anchor.y) * (top ? -1 : 1);
    if (original.type === "sticky") {
      const side = Math.max(64, Math.min(20_000, (dx + dy) / 2));
      updatePreview([
        {
          ...original,
          x: left ? anchor.x - side : anchor.x,
          y: top ? anchor.y - side : anchor.y,
          width: side,
          height: side,
          fontSize: Math.max(
            8,
            Math.min(
              160,
              (original.fontSize * side) /
                Math.max(original.width, original.height),
            ),
          ),
        },
      ]);
      return;
    }
    const innerWidth = Math.max(1, box.width),
      innerHeight = Math.max(1, box.height);
    let scale = Math.max(
      16 / Math.max(innerWidth, innerHeight),
      Math.min(
        20_000 / Math.max(innerWidth, innerHeight),
        (dx * innerWidth + dy * innerHeight) /
          (innerWidth ** 2 + innerHeight ** 2),
      ),
    );
    if (isTextElement(original))
      scale = Math.max(
        8 / original.fontSize,
        Math.min(160 / original.fontSize, scale),
      );
    const width = innerWidth * scale,
      height = innerHeight * scale;
    if (original.type === "image" || isTextElement(original))
      updatePreview([
        {
          ...original,
          x: left ? anchor.x - width : anchor.x,
          y: top ? anchor.y - height : anchor.y,
          width,
          height,
          ...(isTextElement(original)
            ? { fontSize: original.fontSize * scale }
            : {}),
        },
      ]);
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    // A release can carry a newer position than the last pointermove. Capture
    // loss/cancellation events need the last preview, not their default (0, 0).
    if (
      event.type === "pointerup" &&
      (current.kind === "move" ||
        current.kind === "draw" ||
        (current.kind === "resize" && previewRef.current))
    )
      pointerMove(event);
    if (previewRef.current) {
      // Measure visible extent, not accumulated jitter or end-to-end distance:
      // clicks disappear, while closed loops and tiny deliberate strokes stay.
      const moved =
        current.kind === "draw"
          ? current.element.points.some(
              ([x, y]) => Math.hypot(x, y) * view.zoom >= 3,
            )
          : current.kind !== "move" ||
            previewRef.current.some((element) => {
              const before = current.originals.find(
                (item) => item.id === element.id,
              );
              return (
                !before || before.x !== element.x || before.y !== element.y
              );
            });
      const stored = moved && commit(previewRef.current);
      if (stored && current.kind === "draw") {
        setSelected([current.element.id]);
        if (current.element.type === "mark")
          setComment({ id: current.element.id, fresh: true });
      }
      // A click on an outline opens its comment.
      const [clicked] = current.kind === "move" ? current.originals : [];
      if (
        !moved &&
        event.type === "pointerup" &&
        clicked?.type === "mark" &&
        current.kind === "move" &&
        current.originals.length === 1
      )
        setComment({ id: clicked.id, fresh: false });
    }
    if (current.kind === "marquee" && marquee)
      setSelected([
        ...new Set([
          ...current.extend,
          ...elements
            .filter((element) => intersects(boundsOf(element), marquee))
            .map((element) => element.id),
        ]),
      ]);
    cancelGesture();
  }
  function cancelGesture() {
    const pointer = gesture.current?.pointerId;
    gesture.current = null;
    updatePreview(null);
    setMarquee(null);
    if (pointer !== undefined && surface.current?.hasPointerCapture(pointer))
      surface.current.releasePointerCapture(pointer);
  }
  function history(redo = false) {
    cancelGesture();
    if (cropping) {
      setCropping(null);
      focus();
      return;
    }
    if (redo) session.redo();
    else session.undo();
  }
  function remove() {
    cancelGesture();
    setCropping(null);
    if (selected.length) {
      commit([], selected);
      setSelected([]);
    }
  }
  function copySelection(
    event: ReactClipboardEvent<HTMLDivElement>,
    cut = false,
  ) {
    if (
      isInput(event.target) ||
      editingRef.current ||
      cropping ||
      !state.loaded ||
      importing ||
      !selection.length
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const value = encodeClipboard(threadId, selection);
      // The plain-text envelope survives browsers that strip custom MIME types.
      event.clipboardData.setData("text/plain", value);
      try {
        event.clipboardData.setData(CANVAS_CLIPBOARD_TYPE, value);
      } catch {
        /* Plain text still carries the complete element selection. */
      }
      lastPaste.current = null;
      setNotice(null);
      if (cut) {
        cancelGesture();
        if (
          commit(
            [],
            selection.map((element) => element.id),
          )
        )
          setSelected([]);
      }
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function finishCrop({
    cancel = false,
    deselect = false,
    restoreFocus = true,
  } = {}) {
    const cropping = croppingRef.current;
    if (!cropping) return true;
    if (!cancel) {
      if (
        !state.board.elements.some(
          (element) => element.id === cropping.image.id,
        )
      ) {
        setCropping(null);
        if (deselect) setSelected([]);
        setNotice("This image was removed while cropping.");
        return true;
      }
      const next = applyCrop(cropping.image, cropping.frame);
      if (
        next.width > 20_000 ||
        next.height > 20_000 ||
        Math.abs(next.x) > 100_000 ||
        Math.abs(next.y) > 100_000
      ) {
        setNotice(
          "This crop is outside the canvas limits. Choose a smaller area.",
        );
        return false;
      }
      if (
        JSON.stringify(next) !== JSON.stringify(cropping.image) &&
        !commit([next])
      )
        return false;
    }
    setCropping(null);
    setNotice(null);
    if (deselect) setSelected([]);
    if (restoreFocus) focus();
    return true;
  }
  const isTextControl = (target: EventTarget | null) =>
    target instanceof Element &&
    root.current?.contains(target) &&
    !!target.closest(".cv-properties, .cv-text-editor");
  return (
    <div
      ref={root}
      className="cv-root"
      data-canvas-thread={threadId}
      tabIndex={0}
      aria-label="Canvas"
      onCopy={copySelection}
      onCut={(event) => copySelection(event, true)}
      onPaste={(event) => {
        if (isInput(event.target) || editingRef.current || cropping) return;
        try {
          const clipboard = decodeClipboard(
            event.clipboardData.getData(CANVAS_CLIPBOARD_TYPE) ||
              event.clipboardData.getData("text/plain"),
          );
          if (clipboard) {
            event.preventDefault();
            event.stopPropagation();
            void insertElements(clipboard);
            return;
          }
        } catch (cause) {
          event.preventDefault();
          event.stopPropagation();
          setNotice(cause instanceof Error ? cause.message : String(cause));
          return;
        }
        const files = Array.from(event.clipboardData.items)
          .filter((item) => item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((file): file is File => !!file);
        if (files.length) {
          event.preventDefault();
          event.stopPropagation();
          void insertFiles(files);
        }
      }}
      onKeyDown={(event) => {
        if (isInput(event.target)) return;
        const command = event.metaKey || event.ctrlKey;
        if (cropping) {
          if (
            event.key === "Enter" &&
            event.target instanceof Element &&
            event.target.closest("button")
          )
            return;
          if (
            event.key === "Escape" ||
            event.key === "Enter" ||
            (command && event.key.toLowerCase() === "z")
          ) {
            event.preventDefault();
            event.stopPropagation();
            finishCrop({ cancel: event.key !== "Enter" });
          }
          return;
        }
        if (editingRef.current) {
          if (event.key === "Escape" || (command && event.key === "Enter")) {
            event.preventDefault();
            event.stopPropagation();
            if (finishText(event.key === "Escape")) focus();
            else textarea.current?.focus({ preventScroll: true });
          } else if (
            (command && ["z", "a"].includes(event.key.toLowerCase())) ||
            event.key === "Delete" ||
            event.key === "Backspace"
          ) {
            event.preventDefault();
            event.stopPropagation();
            textarea.current?.focus({ preventScroll: true });
            if (command && event.key.toLowerCase() === "a")
              textarea.current?.select();
          }
          return;
        }
        if (event.key === "Escape") {
          cancelGesture();
          setSelected([]);
          setTool("select");
        } else if (command && event.key.toLowerCase() === "z") {
          event.preventDefault();
          event.stopPropagation();
          history(event.shiftKey);
        } else if (command && event.key.toLowerCase() === "a") {
          event.preventDefault();
          event.stopPropagation();
          setSelected(elements.map((element) => element.id));
        } else if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          event.stopPropagation();
          remove();
        } else if (
          event.code === "Space" &&
          !(
            event.target instanceof Element && event.target.closest("button, a")
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          space.current = true;
        } else if (!command && !event.altKey) {
          const next = TOOLS.find(({ key }) => key === event.key.toLowerCase());
          if (next) {
            event.preventDefault();
            event.stopPropagation();
            chooseTool(next.id);
          }
        }
      }}
      onKeyUp={(event) => {
        if (event.code === "Space") space.current = false;
      }}
    >
      <style>
        {
          '@font-face { font-family: "Canvas Sans"; src: url("/api/v1/plugins/canvas/http/font") format("truetype"); font-display: swap; }'
        }
      </style>
      <div className="cv-toolbar" aria-label="Canvas tools">
        <div className="cv-segments" role="group" aria-label="Tools">
          {TOOLS.map(({ id, label }) => (
            <Button
              key={id}
              icon={id}
              label={label}
              active={tool === id}
              onClick={() => chooseTool(id)}
            />
          ))}
        </div>
        <span className="cv-separator" />
        <Button
          icon="image"
          label="Add image"
          disabled={importing || !state.loaded}
          onClick={() => picker.current?.click()}
        />
        <Button
          icon="paste"
          label="Paste (⌘V / Ctrl+V)"
          disabled={importing || !state.loaded}
          onClick={() => void paste()}
        />
        <span className="cv-spacer" />
        <Button
          icon="undo"
          label="Undo (⌘Z)"
          disabled={!state.canUndo}
          onClick={() => history()}
        />
        <Button
          icon="redo"
          label="Redo (⇧⌘Z)"
          disabled={!state.canRedo}
          onClick={() => history(true)}
        />
        <a
          className="cv-button"
          href={exportUrl(threadId)}
          download="canvas.png"
          aria-label="Export PNG"
          title="Export PNG"
          onClick={(event) => {
            if (state.saving || state.error || !state.loaded) {
              event.preventDefault();
              setNotice("Wait for the canvas to save before exporting.");
            }
          }}
        >
          <Icon name="export" />
        </a>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files)
              void insertFiles(Array.from(event.target.files));
            event.target.value = "";
          }}
        />
        {showProperties && (
          <div
            className="cv-properties"
            role="group"
            aria-label="Style"
            onPointerDown={(event) => {
              if (editingRef.current) event.preventDefault();
            }}
            onBlur={(event) => {
              if (!isTextControl(event.relatedTarget)) finishText();
            }}
          >
            <ColorChoices value={activeColor} onChange={chooseColor} />
            {propertyKind && propertyKind !== "sticky" && (
              <div
                className="cv-sizes"
                role="group"
                aria-label={
                  propertyKind === "draw" ? "Stroke width" : "Text size"
                }
              >
                {SIZE_PRESETS[propertyKind].map(({ value, preview, label }) => (
                  <button
                    key={value}
                    type="button"
                    className="cv-size-button"
                    aria-label={label}
                    title={label}
                    aria-pressed={activeSize === value}
                    onClick={() => chooseSize(value)}
                  >
                    {propertyKind === "draw" ? (
                      <span
                        className="cv-stroke-dot"
                        aria-hidden="true"
                        style={
                          { "--stroke-size": `${preview}px` } as CSSProperties
                        }
                      />
                    ) : (
                      <span
                        className="cv-text-size"
                        aria-hidden="true"
                        style={
                          { "--text-size": `${preview}px` } as CSSProperties
                        }
                      >
                        A
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {(notice || state.error) && (
        <div className="cv-notice" role="alert">
          <span>{state.error ? `Not saved: ${state.error}` : notice}</span>
          {state.error ? (
            <button onClick={session.retry}>Retry</button>
          ) : (
            <button onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      )}
      <div
        ref={surface}
        className="cv-surface"
        data-tool={tool}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={(event) => pointerUp(event)}
        onPointerCancel={(event) => pointerUp(event)}
        onLostPointerCapture={(event) => pointerUp(event)}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void insertFiles(
            Array.from(event.dataTransfer.files).filter((file) =>
              file.type.startsWith("image/"),
            ),
            world(event),
          );
        }}
        onDoubleClick={(event) => {
          if (cropping || space.current || (event.altKey && tool !== "select"))
            return;
          // Pointer capture can retarget dblclick to the surface. Hit-test the
          // actual location instead of relying on that captured event target.
          const target =
            surface.current?.ownerDocument.elementFromPoint?.(
              event.clientX,
              event.clientY,
            ) ?? (event.target as Element);
          if (
            !surface.current?.contains(target) ||
            isInput(target) ||
            target.closest("[data-corner]")
          )
            return;
          const id = target
            .closest("[data-element]")
            ?.getAttribute("data-element");
          const element = elements.find((item) => item.id === id);
          if (isTextElement(element)) {
            cancelGesture();
            setEditing(
              element.type === "sticky"
                ? { ...element, ...textBounds(element) }
                : element,
            );
            setSelected([element.id]);
          } else if (element?.type === "image" && tool === "select") {
            cancelGesture();
            setSelected([element.id]);
            setCropping({ image: element, frame: boundsOf(element) });
            const full = imageViewport(element);
            if (
              view.x + full.x * view.zoom < 24 ||
              view.y + full.y * view.zoom < 24 ||
              view.x + (full.x + full.width) * view.zoom > size.width - 24 ||
              view.y + (full.y + full.height) * view.zoom > size.height - 24
            )
              setView(frameView(full, view.zoom, 24));
            focus();
          }
        }}
      >
        <svg
          className="cv-artboard"
          aria-label="Canvas artwork"
          width="100%"
          height="100%"
        >
          <defs>
            <pattern
              id={`dots-${threadId}`}
              width={24 * view.zoom}
              height={24 * view.zoom}
              patternUnits="userSpaceOnUse"
              x={view.x}
              y={view.y}
            >
              <circle cx="1" cy="1" r=".7" fill="var(--cv-dot)" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#dots-${threadId})`} />
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            {elements.map((element) => (
              <CanvasArtwork
                key={element.id}
                element={element}
                threadId={threadId}
                zoom={view.zoom}
                editing={editing?.id === element.id}
              />
            ))}
            {!cropping &&
              selection.map((element) => {
                const box = boundsOf(element);
                return (
                  <g
                    key={`selection-${element.id}`}
                    className="cv-selection"
                    pointerEvents={editing ? "none" : undefined}
                  >
                    <rect
                      {...box}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5 / view.zoom}
                      pointerEvents="none"
                    />
                    {single &&
                      (element.type === "image" || isTextElement(element)) &&
                      canMove(element) && (
                        <ResizeHandles box={box} zoom={view.zoom} />
                      )}
                  </g>
                );
              })}
            {marquee && (
              <rect
                {...marquee}
                className="cv-marquee"
                strokeWidth={1 / view.zoom}
              />
            )}
          </g>
        </svg>
        {!elements.length && !editing && (
          <div className="cv-empty" aria-live="polite">
            <span className="cv-empty-icon">
              <Icon name="image" />
            </span>
            <strong>
              {state.loaded ? "Room for your ideas" : "Loading canvas…"}
            </strong>
            {state.loaded && (
              <>
                <span>
                  Drop an image, paste a screenshot,
                  <br />
                  or make your first mark.
                </span>
                <kbd>
                  ⌘V <span>/</span> Ctrl+V
                </kbd>
              </>
            )}
          </div>
        )}
        {editing && (
          <CanvasTextEditor
            key={editing.id}
            ref={textarea}
            className="cv-text-editor"
            data-kind={editing.type}
            aria-label="Canvas text"
            rows={1}
            wrap={editing.type === "sticky" ? "soft" : "off"}
            maxLength={10_000}
            text={editing.text}
            placeholder={editing.type === "sticky" ? "Note" : "Text"}
            style={{
              boxSizing: "border-box",
              ...(editing.type === "sticky"
                ? {
                    borderRadius: 8 * view.zoom,
                    padding: stickyPadding(editing) * view.zoom,
                    paddingRight:
                      (editing.width -
                        editingLayout!.padding -
                        editingLayout!.contentWidth) *
                      view.zoom,
                    paddingBottom:
                      (editing.height -
                        editingLayout!.padding -
                        editingLayout!.contentHeight) *
                      view.zoom,
                    fontKerning: "none",
                    fontVariantLigatures: "none",
                    fontFeatureSettings: '"kern" 0, "liga" 0',
                    tabSize: 4,
                  }
                : {}),
              left: view.x + editing.x * view.zoom,
              top: view.y + editing.y * view.zoom,
              width: editing.width * view.zoom,
              height: editing.height * view.zoom,
              fontSize:
                (editingLayout?.fontSize ?? editing.fontSize) * view.zoom,
              color:
                editing.type === "sticky"
                  ? editing.color
                  : boardInk(editing.color),
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onSelect={(event) => {
              const input = event.currentTarget;
              if (input.selectionStart === input.selectionEnd)
                revealTextCaret(editing, input.selectionEnd);
            }}
            onChange={(event) =>
              changeText(
                { ...editing, text: event.target.value },
                event.target.selectionEnd,
              )
            }
            onBlur={(event) => {
              if (!isTextControl(event.relatedTarget)) finishText();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                finishText(true);
                focus();
              } else if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                if (finishText()) focus();
              }
            }}
          />
        )}
        {marks.map((mark, index) => {
          const box = boundsOf(mark);
          return (
            <button
              key={mark.id}
              type="button"
              className="cv-pin"
              aria-label={`Feedback ${index + 1}`}
              title={mark.text || "Add feedback"}
              style={
                {
                  left: view.x + box.x * view.zoom,
                  top: view.y + box.y * view.zoom,
                  "--pin": mark.color,
                } as CSSProperties
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                setSelected([mark.id]);
                setComment({ id: mark.id, fresh: false });
              }}
            >
              <b>{index + 1}</b>
              {mark.text && mark.id !== comment?.id && <span>{mark.text}</span>}
            </button>
          );
        })}
        {commented && (
          <MarkComment
            key={commented.id}
            text={commented.text}
            style={{
              left: Math.max(
                8,
                Math.min(
                  size.width - 268,
                  view.x + boundsOf(commented).x * view.zoom,
                ),
              ),
              top: Math.max(
                8,
                Math.min(
                  size.height - 104,
                  view.y +
                    (boundsOf(commented).y + boundsOf(commented).height) *
                      view.zoom +
                    8,
                ),
              ),
            }}
            onClose={closeComment}
          />
        )}
        {cropping && (
          <ImageCrop
            image={cropping.image}
            frame={cropping.frame}
            threadId={threadId}
            view={view}
            onChange={(frame) =>
              setCropping((current) => (current ? { ...current, frame } : null))
            }
            onApply={() => finishCrop({ deselect: true, restoreFocus: false })}
          />
        )}
      </div>
      <div className="cv-footer">
        <span className="cv-save" role="status">
          {importing
            ? "Adding image…"
            : !state.loaded
              ? "Loading…"
              : state.error
                ? "Not saved"
                : state.saving
                  ? "Saving…"
                  : "Saved"}
        </span>
        {selected.length > 0 && (
          <Button icon="trash" label="Delete selection" onClick={remove} />
        )}
        <span className="cv-hint">
          {cropping
            ? "Click outside to crop · Esc: cancel"
            : tool === "mark"
              ? "Outline an area, then type your feedback"
              : tool === "draw" || tool === "arrow"
                ? "Shift: straight · ⌥/Alt: draw over"
                : tool === "text" || tool === "sticky"
                  ? "⌥/Alt: write over annotations"
                  : "Space + drag to pan"}
        </span>
        <span className="cv-spacer" />
        {marksOf(state.board.elements).length > 0 && (
          <button
            type="button"
            className="cv-send"
            title="Send the outlined areas and their comments to this thread"
            disabled={sending || importing || !state.loaded}
            onClick={() => void sendFeedback()}
          >
            <Icon name="send" />
            {sending
              ? "Sending…"
              : `Send ${marksOf(state.board.elements).length}`}
          </button>
        )}
        <Button
          icon="fit"
          label="Fit canvas"
          onClick={() =>
            setView(frameView(contentBounds(state.board.elements, 40)))
          }
        />
        <Button icon="minus" label="Zoom out" onClick={() => zoomAt(1 / 1.2)} />
        <span className="cv-zoom">{Math.round(view.zoom * 100)}%</span>
        <Button icon="plus" label="Zoom in" onClick={() => zoomAt(1.2)} />
      </div>
    </div>
  );
}
function ThreadCanvas(props: PluginThreadPanelProps) {
  return <CanvasPanel key={props.threadId} threadId={props.threadId} />;
}
export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ID,
    title: "Canvas",
    layout: "flush",
    component: ThreadCanvas,
  });
  app.slots.experimental_browserToolbarAction({
    id: "capture-to-canvas",
    title: "Capture to Canvas",
    component: BrowserCapture,
  });
  app.commands.register({
    id: "show-canvas",
    title: "Canvas: Open this thread's canvas",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      openPanel({ actionId: PANEL_ID });
    },
  });
});
