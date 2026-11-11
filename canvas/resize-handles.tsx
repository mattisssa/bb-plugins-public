import type { Bounds } from "./model";

export function ResizeHandles({
  box,
  zoom,
  crop = false,
}: {
  box: Bounds;
  zoom: number;
  crop?: boolean;
}) {
  const handles = crop
    ? ["nw", "n", "ne", "e", "se", "s", "sw", "w"]
    : ["nw", "ne", "sw", "se"];
  const hitSize = crop ? 28 : 30;
  const size = crop ? 8 : 10;
  const inwardX = crop ? Math.min(4, (box.width * zoom) / 4) : 5;
  const inwardY = crop ? Math.min(4, (box.height * zoom) / 4) : 5;
  return (
    <>
      {handles.map((handle) => {
        const horizontal = handle.includes("w")
          ? 0
          : handle.includes("e")
            ? 1
            : 0.5;
        const vertical = handle.includes("n")
          ? 0
          : handle.includes("s")
            ? 1
            : 0.5;
        const x = box.x + box.width * horizontal;
        const y = box.y + box.height * vertical;
        const hitX =
          horizontal === 0
            ? hitSize - inwardX
            : horizontal === 1
              ? inwardX
              : hitSize / 2;
        const hitY =
          vertical === 0
            ? hitSize - inwardY
            : vertical === 1
              ? inwardY
              : hitSize / 2;
        return (
          <g
            key={handle}
            data-corner={crop ? undefined : handle}
            data-crop-handle={crop ? handle : undefined}
            style={{ cursor: `${handle}-resize` }}
          >
            <rect
              className={crop ? undefined : "cv-handle-hit"}
              x={x - hitX / zoom}
              y={y - hitY / zoom}
              width={hitSize / zoom}
              height={hitSize / zoom}
              fill="transparent"
            />
            <rect
              x={x - size / 2 / zoom}
              y={y - size / 2 / zoom}
              width={size / zoom}
              height={size / zoom}
              rx={(crop ? 1.5 : 2) / zoom}
              fill="white"
              stroke={crop ? "var(--cv-accent)" : "currentColor"}
              strokeWidth={1.5 / zoom}
              pointerEvents="none"
            />
          </g>
        );
      })}
    </>
  );
}
