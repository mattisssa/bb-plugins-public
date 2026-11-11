import { z } from "zod";
import {
  boardSchema,
  elementSchema,
  idSchema,
  type Board,
  type CanvasElement,
} from "./model";

export const CANVAS_CLIPBOARD_TYPE = "application/x-bb-canvas";
const PREFIX = "bb-canvas-elements:";
const MAX_BYTES = 2 * 1024 * 1024;
const clipboardSchema = z
  .object({
    version: z.literal(1),
    copyId: idSchema,
    sourceThreadId: idSchema,
    elements: z.array(elementSchema).min(1).max(500),
  })
  .strict();
export type CanvasClipboard = z.infer<typeof clipboardSchema>;

export function encodeClipboard(
  sourceThreadId: string,
  elements: CanvasElement[],
): string {
  const value =
    PREFIX +
    JSON.stringify({
      version: 1,
      copyId: crypto.randomUUID(),
      sourceThreadId,
      elements,
    });
  // Leave room for the envelope around a maximum-size board selection.
  if (new TextEncoder().encode(value).length > MAX_BYTES + 2048)
    throw new Error("This selection is too large to copy.");
  return value;
}

export function decodeClipboard(value: string): CanvasClipboard | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    if (
      value.length > MAX_BYTES + 2048 ||
      new TextEncoder().encode(value).length > MAX_BYTES + 2048
    )
      throw new Error("Clipboard limit exceeded.");
    return clipboardSchema.parse(JSON.parse(value.slice(PREFIX.length)));
  } catch {
    throw new Error(
      "This Canvas clipboard data is invalid. Copy the elements again.",
    );
  }
}

export function duplicateElements(
  elements: CanvasElement[],
  offset: number,
): CanvasElement[] {
  // Translate the entire group equally, including at the board's limits.
  const shift = (axis: "x" | "y") =>
    Math.max(
      -100_000 - Math.min(...elements.map((element) => element[axis])),
      Math.min(
        offset,
        100_000 - Math.max(...elements.map((element) => element[axis])),
      ),
    );
  const x = shift("x"),
    y = shift("y");
  return elements.map((element) => ({
    ...element,
    id: crypto.randomUUID(),
    x: element.x + x,
    y: element.y + y,
  }));
}

export function validatePaste(board: Board, added: CanvasElement[]) {
  const next = { ...board, elements: [...board.elements, ...added] };
  if (
    !boardSchema.safeParse(next).success ||
    new TextEncoder().encode(JSON.stringify(next)).length > MAX_BYTES
  )
    throw new Error(
      "This canvas is full. Remove some elements before pasting.",
    );
}
