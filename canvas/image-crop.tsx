import { useEffect, useRef, type PointerEvent } from "react";
import {
  assetUrl,
  imageViewport,
  type Bounds,
  type ImageElement,
  type Point,
} from "./model";
import { moveCrop, resizeCrop, type CropHandle } from "./crop";
import { ResizeHandles } from "./resize-handles";

type View = { x: number; y: number; zoom: number };

export function CanvasImage({
  image,
  threadId,
  frame = image,
}: {
  image: ImageElement;
  threadId: string;
  frame?: Bounds;
}) {
  return (
    <svg
      x={frame.x}
      y={frame.y}
      width={frame.width}
      height={frame.height}
      viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
      preserveAspectRatio="none"
      overflow="hidden"
    >
      <image
        href={assetUrl(threadId, image.assetId)}
        {...imageViewport(image)}
        preserveAspectRatio="none"
      />
    </svg>
  );
}

export function ImageCrop({
  image,
  frame,
  threadId,
  view,
  onChange,
  onApply,
}: {
  image: ImageElement;
  frame: Bounds;
  threadId: string;
  view: View;
  onChange(frame: Bounds): void;
  onApply(): void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const apply = useRef(onApply);
  apply.current = onApply;
  const gesture = useRef<{
    pointerId: number;
    frame: Bounds;
    start: Point;
    handle: CropHandle | null;
  } | null>(null);
  useEffect(() => {
    const node = layer.current!;
    const canvas = node.closest(".cv-root");
    const document = node.ownerDocument;
    const clickAway = (event: globalThis.PointerEvent) => {
      if (
        event.button === 0 &&
        !gesture.current &&
        event.target instanceof Node &&
        !(canvas ?? node).contains(event.target)
      )
        apply.current();
    };
    document.addEventListener("pointerdown", clickAway, true);
    return () => document.removeEventListener("pointerdown", clickAway, true);
  }, []);
  const full = imageViewport(image);
  const world = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - view.x) / view.zoom,
      y: (event.clientY - rect.top - view.y) / view.zoom,
    };
  };
  function update(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const point = world(event);
    onChange(
      current.handle
        ? resizeCrop(image, current.frame, current.handle, point)
        : moveCrop(image, current.frame, {
            x: point.x - current.start.x,
            y: point.y - current.start.y,
          }),
    );
  }
  function release(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return (
    <div
      ref={layer}
      className="cv-crop-layer"
      role="group"
      aria-label="Crop image"
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0 || gesture.current) return;
        const target = event.target as Element;
        const handle = target
          .closest("[data-crop-handle]")
          ?.getAttribute("data-crop-handle") as CropHandle | undefined;
        event.preventDefault();
        if (!handle && !target.closest("[data-crop-frame]")) {
          onApply();
          return;
        }
        gesture.current = {
          pointerId: event.pointerId,
          start: world(event),
          frame,
          handle: handle ?? null,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        event.stopPropagation();
        update(event);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        update(event);
        release(event);
      }}
      onPointerCancel={(event) => {
        event.stopPropagation();
        release(event);
      }}
      onLostPointerCapture={(event) => {
        event.stopPropagation();
        release(event);
      }}
    >
      <svg className="cv-crop-overlay" aria-label="Image crop preview">
        <rect width="100%" height="100%" fill="#000000" opacity=".14" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          <image
            href={assetUrl(threadId, image.assetId)}
            {...full}
            preserveAspectRatio="none"
            opacity=".4"
          />
          <CanvasImage image={image} threadId={threadId} frame={frame} />
          {[1, 2].map((part) => (
            <g
              key={part}
              stroke="white"
              strokeWidth={1 / view.zoom}
              opacity=".55"
              pointerEvents="none"
            >
              <path
                d={`M ${frame.x + (frame.width * part) / 3} ${frame.y} v ${frame.height}`}
              />
              <path
                d={`M ${frame.x} ${frame.y + (frame.height * part) / 3} h ${frame.width}`}
              />
            </g>
          ))}
          <rect
            {...frame}
            data-crop-frame=""
            fill="transparent"
            stroke="var(--cv-accent)"
            strokeWidth={1.5 / view.zoom}
            style={{ cursor: "move" }}
          />
          <ResizeHandles box={frame} zoom={view.zoom} crop />
        </g>
      </svg>
    </div>
  );
}
