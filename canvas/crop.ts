import {
  imageViewport,
  type Bounds,
  type ImageElement,
  type Point,
} from "./model";

export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function finite(...values: number[]) {
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error("Crop coordinates must be finite.");
}

function containedFrame(full: Bounds, frame: Bounds): Bounds {
  finite(full.x, full.y, full.width, full.height);
  finite(frame.x, frame.y, frame.width, frame.height);
  if (full.width <= 0 || full.height <= 0)
    throw new Error("The image has no area to crop.");
  const width = clamp(frame.width, Math.min(1, full.width), full.width);
  const height = clamp(frame.height, Math.min(1, full.height), full.height);
  return {
    x: clamp(frame.x, full.x, full.x + Math.max(0, full.width - width)),
    y: clamp(frame.y, full.y, full.y + Math.max(0, full.height - height)),
    width,
    height,
  };
}

/** All crop frames, points, and deltas use canvas world coordinates. */
export function moveCrop(
  image: ImageElement,
  frame: Bounds,
  delta: Point,
): Bounds {
  finite(delta.x, delta.y);
  const full = imageViewport(image);
  const current = containedFrame(full, frame);
  return containedFrame(full, {
    ...current,
    x: current.x + delta.x,
    y: current.y + delta.y,
  });
}

export function resizeCrop(
  image: ImageElement,
  frame: Bounds,
  handle: CropHandle,
  point: Point,
  minSize = 1,
): Bounds {
  finite(point.x, point.y, minSize);
  const full = imageViewport(image);
  const current = containedFrame(full, frame);
  let left = current.x;
  let right = current.x + current.width;
  let top = current.y;
  let bottom = current.y + current.height;
  const minWidth = Math.min(full.width, Math.max(1, minSize));
  const minHeight = Math.min(full.height, Math.max(1, minSize));
  if (handle.includes("w"))
    left = clamp(point.x, full.x, right - Math.min(minWidth, right - full.x));
  if (handle.includes("e"))
    right = clamp(
      point.x,
      left + Math.min(minWidth, full.x + full.width - left),
      full.x + full.width,
    );
  if (handle.includes("n"))
    top = clamp(point.y, full.y, bottom - Math.min(minHeight, bottom - full.y));
  if (handle.includes("s"))
    bottom = clamp(
      point.y,
      top + Math.min(minHeight, full.y + full.height - top),
      full.y + full.height,
    );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sameFrame(a: Bounds, b: Bounds) {
  return (["x", "y", "width", "height"] as const).every(
    (key) =>
      Math.abs(a[key] - b[key]) <=
      Number.EPSILON * 16 * Math.max(1, Math.abs(a[key]), Math.abs(b[key])),
  );
}

/** Cropping changes the visible rectangle without rescaling its source image. */
export function applyCrop(image: ImageElement, frame: Bounds): ImageElement {
  const full = imageViewport(image);
  const next = containedFrame(full, frame);
  const { crop: _crop, ...source } = image;
  if (sameFrame(next, full)) return image.crop ? { ...source, ...full } : image;
  if (sameFrame(next, image)) return image;
  const x = clamp((next.x - full.x) / full.width, 0, 1);
  const y = clamp((next.y - full.y) / full.height, 0, 1);
  return {
    ...source,
    ...next,
    crop: {
      x,
      y,
      width: Math.min(next.width / full.width, 1 - x),
      height: Math.min(next.height / full.height, 1 - y),
    },
  };
}
