import { z } from "zod";

export const CHANNEL = "canvas-changed";
export const PANEL_ID = "canvas";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const STICKY_PADDING = 16;
export const STICKY_BACKGROUND = "#fff3b0";
export const STICKY_SIZE = 180;
export const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w-]+$/);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const dimension = z.number().finite().min(1).max(20_000);
const color = z.string().regex(/^#[\da-fA-F]{6}$/);
const base = { id: idSchema, x: coordinate, y: coordinate };
const box = z.object({ ...base, width: dimension, height: dimension }).strict();
const text = box.extend({
  text: z.string().max(10_000),
  color,
  fontSize: z.number().min(8).max(160),
});
const stroke = z
  .object({ ...base, color, strokeWidth: z.number().min(1).max(32) })
  .strict();
const point = z.tuple([coordinate, coordinate]);
export const cropSchema = z
  .object({
    x: z.number().finite().min(0).lt(1),
    y: z.number().finite().min(0).lt(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .refine(
    (crop) =>
      crop.x + crop.width <= 1 + 1e-9 && crop.y + crop.height <= 1 + 1e-9,
    "The crop must stay inside the original image.",
  );
export const elementSchema = z.discriminatedUnion("type", [
  box
    .extend({
      type: z.literal("image"),
      assetId: idSchema,
      name: z.string().max(240),
      crop: cropSchema.optional(),
    })
    .refine((image) => {
      if (!image.crop) return true;
      const width = image.width / image.crop.width;
      const height = image.height / image.crop.height;
      return [
        width,
        height,
        image.x - image.crop.x * width,
        image.y - image.crop.y * height,
      ].every(Number.isFinite);
    }, "The crop is too small to display."),
  text.extend({ type: z.literal("text") }),
  stroke.extend({
    type: z.literal("draw"),
    points: z.array(point).min(1).max(6_000),
  }),
  text.extend({ type: z.literal("sticky"), background: color }),
  stroke.extend({ type: z.literal("arrow"), points: z.tuple([point, point]) }),
  // A freehand outline around an area, with the user's feedback about it.
  stroke.extend({
    type: z.literal("mark"),
    points: z.array(point).min(1).max(6_000),
    text: z.string().max(4_000),
  }),
]);
export type CanvasElement = z.infer<typeof elementSchema>;
export type ImageElement = Extract<CanvasElement, { type: "image" }>;
export type ImageCrop = z.infer<typeof cropSchema>;
export type TextElement = Extract<CanvasElement, { type: "text" }>;
export type StickyElement = Extract<CanvasElement, { type: "sticky" }>;
export type TextLikeElement = TextElement | StickyElement;
export type DrawElement = Extract<CanvasElement, { type: "draw" }>;
export type ArrowElement = Extract<CanvasElement, { type: "arrow" }>;
export type MarkElement = Extract<CanvasElement, { type: "mark" }>;
export type StrokeElement = DrawElement | ArrowElement | MarkElement;
export const MARK_COLOR = "#e5484d";
export function isStroke(
  element: CanvasElement | null | undefined,
): element is StrokeElement {
  return (
    element?.type === "draw" ||
    element?.type === "arrow" ||
    element?.type === "mark"
  );
}
export const marksOf = (elements: CanvasElement[]) =>
  elements.filter((element) => element.type === "mark");
export function isTextElement(
  element: CanvasElement | null | undefined,
): element is TextLikeElement {
  return element?.type === "text" || element?.type === "sticky";
}
export type Point = { x: number; y: number };
export type Bounds = Point & { width: number; height: number };
export function imageViewport(image: ImageElement): Bounds {
  if (!image.crop)
    return { x: image.x, y: image.y, width: image.width, height: image.height };
  const width = image.width / image.crop.width;
  const height = image.height / image.crop.height;
  return {
    x: image.x - image.crop.x * width,
    y: image.y - image.crop.y * height,
    width,
    height,
  };
}
export const boardSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  elements: z.array(elementSchema).max(500),
});
export type Board = z.infer<typeof boardSchema>;
export const patchSchema = z
  .object({
    upserts: z.array(elementSchema).max(500),
    removeIds: z.array(idSchema).max(500),
    order: z.array(idSchema).max(500).optional(),
  })
  .strict();
export type Patch = z.infer<typeof patchSchema>;
export const emptyBoard = (): Board => ({
  version: 1,
  revision: 0,
  elements: [],
});
export function applyPatch(
  elements: CanvasElement[],
  patch: Patch,
): CanvasElement[] {
  const removed = new Set(patch.removeIds);
  const updates = new Map(patch.upserts.map((item) => [item.id, item]));
  const result = elements
    .filter((item) => !removed.has(item.id))
    .map((item) => {
      const next = updates.get(item.id) ?? item;
      updates.delete(item.id);
      return next;
    });
  const combined = [...result, ...updates.values()];
  if (!patch.order) return combined;
  const ordered = new Set(patch.order);
  const byId = new Map(combined.map((item) => [item.id, item]));
  const queue = [...ordered].flatMap((id) =>
    byId.has(id) ? [byId.get(id)!] : [],
  );
  return combined.map((item) => (ordered.has(item.id) ? queue.shift()! : item));
}
function arrowVertices(arrow: ArrowElement): [number, number][] {
  const [start, end] = arrow.points;
  const dx = end[0] - start[0],
    dy = end[1] - start[1],
    length = Math.hypot(dx, dy);
  if (!length) return [start, end];
  const head = Math.min(Math.max(12, arrow.strokeWidth * 4), length / 2);
  const ux = dx / length,
    uy = dy / length;
  return [
    start,
    end,
    [
      end[0] - ux * head - (uy * head) / 2,
      end[1] - uy * head + (ux * head) / 2,
    ],
    [
      end[0] - ux * head + (uy * head) / 2,
      end[1] - uy * head - (ux * head) / 2,
    ],
  ];
}

// Local SVG coordinates; callers supply translation, stroke, and round caps/joins.
export function arrowPath(arrow: ArrowElement): string {
  const [start, end, left, right] = arrowVertices(arrow);
  const shaft = `M ${start!.join(" ")} L ${end!.join(" ")}`;
  return left && right
    ? `${shaft} M ${left.join(" ")} L ${end!.join(" ")} L ${right.join(" ")}`
    : shaft;
}

export function drawPath(draw: DrawElement | MarkElement): string {
  const points = draw.points.map((point) => point.join(" "));
  // A zero-length segment keeps legacy single-point strokes visible with round caps.
  if (points.length === 1) points.push(points[0]!);
  return `M ${points.join(" L ")}`;
}

export function boundsOf(element: CanvasElement): Bounds {
  if (!isStroke(element))
    return {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    };
  const points =
    element.type === "arrow" ? arrowVertices(element) : element.points;
  const xs = points.map(([x]) => x),
    ys = points.map(([, y]) => y);
  const left = Math.min(...xs) - element.strokeWidth / 2,
    top = Math.min(...ys) - element.strokeWidth / 2;
  return {
    x: element.x + left,
    y: element.y + top,
    width: Math.max(...xs) - left + element.strokeWidth / 2,
    height: Math.max(...ys) - top + element.strokeWidth / 2,
  };
}
export function contentBounds(elements: CanvasElement[], padding = 0): Bounds {
  if (!elements.length) return { x: 0, y: 0, width: 640, height: 480 };
  const boxes = elements.map(boundsOf);
  const x = Math.min(...boxes.map((b) => b.x)) - padding,
    y = Math.min(...boxes.map((b) => b.y)) - padding;
  return {
    x,
    y,
    width: Math.max(
      1,
      Math.max(...boxes.map((b) => b.x + b.width)) - x + padding,
    ),
    height: Math.max(
      1,
      Math.max(...boxes.map((b) => b.y + b.height)) - y + padding,
    ),
  };
}
export function constrainLine(start: Point, end: Point): Point {
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
    ? { x: end.x, y: start.y }
    : { x: start.x, y: end.y };
}
export function intersects(a: Bounds, b: Bounds): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}
export const assetUrl = (threadId: string, assetId: string) =>
  `/api/v1/plugins/canvas/http/image?threadId=${encodeURIComponent(threadId)}&id=${encodeURIComponent(assetId)}`;
export const exportUrl = (threadId: string, format = "png") =>
  `/api/v1/plugins/canvas/http/export?threadId=${encodeURIComponent(threadId)}&format=${format}`;
export const fontUrl = "/api/v1/plugins/canvas/http/font";
export const COLORS = [
  ["Graphite", "#242424"],
  ["Red", "#e5484d"],
  ["Orange", "#e58020"],
  ["Green", "#26834a"],
  ["Blue", "#087bdf"],
  ["Purple", "#8854c8"],
] as const;
// Exports draw saved colors on white. On the board, Graphite follows the
// theme's text color so it stays readable on a dark background.
export const boardInk = (color: string) =>
  color === COLORS[0][1] ? "var(--cv-graphite)" : color;
