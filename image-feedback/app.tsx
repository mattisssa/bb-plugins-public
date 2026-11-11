import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { definePluginApp, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { boundsOf, markUp, type Mark, type Picture } from "./markup";
import type { rpcContract } from "./shared";
import "./style.css";

/** Smaller images are icons and avatars, not content. */
const MIN_SIDE = 100;
/** Attachment thumbnails are shown smaller than the image they stand for. */
const MIN_SHOWN = 64;
const OWN = "[data-image-feedback]";

type Target = { image: HTMLImageElement; left: number; top: number };

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** The image under the pointer, when it is content worth annotating. */
function annotatable(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof HTMLImageElement) || target.closest(OWN)) return null;
  const rect = target.getBoundingClientRect();
  return rect.width >= MIN_SHOWN &&
    rect.height >= MIN_SHOWN &&
    target.naturalWidth >= MIN_SIDE &&
    target.naturalHeight >= MIN_SIDE
    ? target
    : null;
}

async function loadPicture(image: HTMLImageElement): Promise<Picture> {
  const src = image.currentSrc || image.src;
  // Fetched bytes keep the export canvas readable, whatever the image's origin.
  const response = await fetch(src).catch(() => null);
  if (!response?.ok)
    throw new Error(
      "This image cannot be read from here. Save it and attach it instead.",
    );
  const bitmap = await createImageBitmap(await response.blob());
  // bb serves attachments as `…/content?path=<file>`: the file is the name.
  const url = /^(data|blob):/.test(src) ? null : new URL(src, location.href);
  const file = url?.searchParams.get("path") ?? url?.pathname ?? "";
  const name = image.alt.trim() || file.split("/").pop() || "";
  return { bitmap, name: name.slice(0, 500), url: src };
}

function Comment({
  text,
  style,
  onClose,
  onRemove,
}: {
  text: string;
  style: CSSProperties;
  /** `text` is null when the user cancels. */
  onClose(text: string | null): void;
  onRemove(): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const closed = useRef(false);
  const close = (value: string | null) => {
    if (closed.current) return;
    closed.current = true;
    onClose(value);
  };
  useLayoutEffect(() => {
    input.current!.value = text;
    input.current!.focus({ preventScroll: true });
  }, []);
  return (
    <div
      className="imgfb-comment"
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <textarea
        ref={input}
        rows={3}
        maxLength={4_000}
        aria-label="Comment for this area"
        placeholder="Comment for this area"
        onBlur={(event) => {
          // The Remove button below takes the focus before it removes the mark.
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget))
            close(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close(null);
          } else if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            close(event.currentTarget.value);
          }
        }}
      />
      <div>
        <span>Enter: save · Shift+Enter: new line</span>
        <button
          type="button"
          onClick={() => {
            closed.current = true;
            onRemove();
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function Annotator({
  picture,
  threadId,
  onClose,
}: {
  picture: Picture;
  threadId: string | null;
  onClose(): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [drawing, setDrawing] = useState<Mark | null>(null);
  // The mark whose comment is open; `fresh` until its comment is first saved.
  const [editing, setEditing] = useState<{ id: string; fresh: boolean } | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const { width, height } = picture.bitmap;
  // Screen pixels per image pixel: fit the window, never enlarge past 2×.
  const scale = Math.min(
    2,
    (viewport.width - 32) / width,
    (viewport.height - 120) / height,
  );
  const stage = { width: width * scale, height: height * scale };

  useLayoutEffect(() => {
    canvas.current!.getContext("2d")!.drawImage(picture.bitmap, 0, 0);
  }, [picture]);
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
    const resize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const point = (event: ReactPointerEvent): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(width, (event.clientX - rect.left) / scale)),
      Math.max(0, Math.min(height, (event.clientY - rect.top) / scale)),
    ];
  };
  function finishDrawing() {
    const mark = drawing;
    setDrawing(null);
    if (!mark) return;
    const box = boundsOf(mark);
    // A click or a twitch is not an outline.
    if (Math.max(box.width, box.height) * scale < 6) return;
    setMarks((current) => [...current, mark]);
    setEditing({ id: mark.id, fresh: true });
  }
  function closeComment(text: string | null) {
    const current = editing;
    setEditing(null);
    root.current?.focus({ preventScroll: true });
    if (!current) return;
    if (text === null) {
      // Escape discards a new outline and keeps a saved comment unchanged.
      if (current.fresh)
        setMarks((all) => all.filter((mark) => mark.id !== current.id));
    } else
      setMarks((all) =>
        all.map((mark) =>
          mark.id === current.id ? { ...mark, text: text.trim() } : mark,
        ),
      );
  }
  async function send() {
    if (sending || !marks.length) return;
    if (!threadId) {
      toast.error("Open a thread to send image feedback to.");
      return;
    }
    setSending(true);
    try {
      await rpc.call("sendImageFeedback", {
        threadId,
        source: { name: picture.name, width, height },
        image: await markUp(picture.bitmap, marks, scale),
        notes: marks.map((mark) => ({ text: mark.text, ...boundsOf(mark) })),
      });
      toast.success(
        `Sent ${marks.length} comment${marks.length === 1 ? "" : "s"} to the thread.`,
      );
      onClose();
    } catch (cause) {
      toast.error(message(cause));
      setSending(false);
    }
  }
  const edited = marks.find((mark) => mark.id === editing?.id);
  const editedBox = edited && boundsOf(edited);
  return (
    <div
      ref={root}
      className="imgfb-root"
      data-image-feedback=""
      role="dialog"
      aria-modal="true"
      aria-label="Image feedback"
      tabIndex={-1}
      onKeyDown={(event) => {
        // bb's shortcuts must not fire behind the annotator.
        event.stopPropagation();
        if (event.target instanceof HTMLTextAreaElement) return;
        if (event.key === "Escape" && !marks.length) onClose();
        else if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "z"
        ) {
          event.preventDefault();
          setMarks((all) => all.slice(0, -1));
        } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
          void send();
      }}
    >
      <div className="imgfb-bar">
        <strong>Image feedback</strong>
        <span>
          {marks.length
            ? "Outline another area, or click a number to edit its comment"
            : "Outline an area of the image, then type your comment"}
        </span>
        <i />
        {marks.length > 0 && (
          <button
            type="button"
            className="imgfb-quiet"
            disabled={sending}
            onClick={() => setMarks((all) => all.slice(0, -1))}
          >
            Undo
          </button>
        )}
        <button
          type="button"
          className="imgfb-quiet"
          disabled={sending}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="imgfb-send"
          disabled={sending || !marks.length}
          onClick={() => void send()}
        >
          {sending
            ? "Sending…"
            : `Send${marks.length ? ` ${marks.length}` : ""}`}
        </button>
      </div>
      <div className="imgfb-stage" style={stage}>
        <canvas ref={canvas} width={width} height={height} />
        <svg
          viewBox={`0 0 ${width} ${height}`}
          onPointerDown={(event) => {
            if (event.button !== 0 || sending || drawing) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrawing({
              id: crypto.randomUUID(),
              points: [point(event)],
              text: "",
            });
          }}
          onPointerMove={(event) => {
            if (!drawing) return;
            const next = point(event);
            setDrawing(
              (mark) => mark && { ...mark, points: [...mark.points, next] },
            );
          }}
          onPointerUp={finishDrawing}
          onPointerCancel={finishDrawing}
        >
          {[...marks, ...(drawing ? [drawing] : [])].map((mark) => (
            <path
              key={mark.id}
              d={`M ${mark.points.map((p) => p.join(" ")).join(" L ")}`}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {marks.map((mark, index) => {
          const box = boundsOf(mark);
          return (
            <button
              key={mark.id}
              type="button"
              className="imgfb-pin"
              aria-label={`Comment ${index + 1}`}
              title={mark.text || "Add a comment"}
              style={{ left: box.x * scale, top: box.y * scale }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setEditing({ id: mark.id, fresh: false })}
            >
              <b>{index + 1}</b>
              {mark.text && mark.id !== editing?.id && <span>{mark.text}</span>}
            </button>
          );
        })}
        {edited && editedBox && (
          <Comment
            key={edited.id}
            text={edited.text}
            style={{
              left: Math.max(
                0,
                Math.min(stage.width - 264, editedBox.x * scale),
              ),
              // Below the outline, or over its lower part near the bottom edge.
              top: Math.min(
                (editedBox.y + editedBox.height) * scale + 8,
                Math.max(0, stage.height - 76),
              ),
            }}
            onClose={closeComment}
            onRemove={() => {
              setEditing(null);
              setMarks((all) => all.filter((mark) => mark.id !== edited.id));
              root.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
    </div>
  );
}

function ImageFeedback() {
  const context = useBbContext();
  const [target, setTarget] = useState<Target | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [loading, setLoading] = useState(false);
  const open = picture !== null;

  useEffect(() => {
    if (open) return;
    const track = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(OWN)) return;
      const image = annotatable(event.target);
      setTarget((current) => {
        if (!image) return null;
        if (current?.image === image) return current;
        const rect = image.getBoundingClientRect();
        return {
          image,
          left: Math.min(rect.right, window.innerWidth) - 8,
          top: Math.max(rect.top, 0) + 8,
        };
      });
    };
    const clear = () => setTarget(null);
    // Touch has no hover: a tap on an image offers the button as well.
    document.addEventListener("pointermove", track, true);
    document.addEventListener("pointerdown", track, true);
    document.addEventListener("scroll", clear, true);
    return () => {
      document.removeEventListener("pointermove", track, true);
      document.removeEventListener("pointerdown", track, true);
      document.removeEventListener("scroll", clear, true);
    };
  }, [open]);

  useEffect(() => () => picture?.bitmap.close(), [picture]);

  async function annotate(image: HTMLImageElement) {
    setLoading(true);
    try {
      setPicture(await loadPicture(image));
      setTarget(null);
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setLoading(false);
    }
  }
  // The route names the thread when the overlay has no thread context.
  const threadId =
    context.threadId ?? location.href.match(/\bthr_[A-Za-z0-9]+/)?.[0] ?? null;
  if (picture)
    return (
      <Annotator
        picture={picture}
        threadId={threadId}
        onClose={() => setPicture(null)}
      />
    );
  if (!target || !target.image.isConnected) return null;
  return (
    <button
      type="button"
      className="imgfb-open"
      data-image-feedback=""
      style={{ left: target.left, top: target.top }}
      disabled={loading}
      // A lightbox under the pointer must not treat this as an outside click.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void annotate(target.image);
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 4c5 0 9 2.7 9 6s-4 6-9 6c-1 0-2-.1-2.9-.3L5 19l.8-4.3C4.1 13.6 3 11.9 3 10c0-3.3 4-6 9-6Z" />
      </svg>
      {loading ? "Opening…" : "Annotate"}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "image-feedback",
    component: ImageFeedback,
  });
});
