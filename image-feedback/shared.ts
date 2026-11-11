import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** 12 MB of image bytes, base64-encoded. */
const MAX_BASE64 = Math.ceil((12 * 1024 * 1024 * 4) / 3);
const pixels = z.number().finite().min(0).max(100_000);

export const noteSchema = z.object({
  text: z.string().max(4_000),
  // The outline's bounding box in the pixels of the original image.
  x: pixels,
  y: pixels,
  width: pixels,
  height: pixels,
});
export type Note = z.infer<typeof noteSchema>;

export const feedbackSchema = z.object({
  threadId: z.string().min(1).max(200),
  /** The original image, as the page showed it. */
  source: z.object({
    name: z.string().max(500),
    width: pixels.min(1),
    height: pixels.min(1),
  }),
  /** The marked-up copy: the original with numbered outlines drawn on it. */
  image: z.object({
    base64: z.string().min(1).max(MAX_BASE64),
    mimeType: z.enum(["image/png", "image/jpeg"]),
    width: pixels.min(1),
    height: pixels.min(1),
  }),
  notes: z.array(noteSchema).min(1).max(100),
});
export type Feedback = z.infer<typeof feedbackSchema>;

export const rpcContract = defineRpcContract({
  /** Posts the marked-up image and its comments to the thread. */
  sendImageFeedback: { input: feedbackSchema, output: z.null() },
});

const percent = (value: number) =>
  Math.round(Math.max(0, Math.min(1, value)) * 100);

/**
 * The message a send posts: `summary` is the user's numbered comments;
 * `details` locates each outline for the agent, in the pixels of the original
 * image and of the attached copy.
 */
export function feedbackMessage({
  source,
  image,
  notes,
}: Pick<Feedback, "source" | "image" | "notes">) {
  const count = `${notes.length} comment${notes.length === 1 ? "" : "s"}`;
  const summary = [
    `Image feedback (${count})`,
    "",
    ...notes.map(
      (note, index) => `${index + 1}. ${note.text.trim() || "(no comment)"}`,
    ),
  ].join("\n");
  const scale = image.width / source.width;
  const px = (value: number, factor = 1) => Math.round(value * factor);
  const scaled = Math.abs(scale - 1) > 0.001;
  const details = [
    `The attached image is a copy of an image shown in this thread${source.name ? ` (${source.name})` : ""}, ${source.width} × ${source.height} px${scaled ? `, scaled to ${image.width} × ${image.height} px` : ""}. Each numbered red outline marks the area one comment above refers to; its number sits at the top-left corner of the outline.`,
    "",
    ...notes.map((note, index) => {
      const parts = [
        `in the original image x ${px(note.x)}, y ${px(note.y)}, ${px(note.width)} × ${px(note.height)} px`,
        `${percent(note.x / source.width)}–${percent((note.x + note.width) / source.width)}% from its left and ${percent(note.y / source.height)}–${percent((note.y + note.height) / source.height)}% from its top`,
      ];
      if (scaled)
        parts.push(
          `in the attached copy x ${px(note.x, scale)}, y ${px(note.y, scale)}, ${px(note.width, scale)} × ${px(note.height, scale)} px`,
        );
      return `${index + 1}. ${parts.join("; ")}.`;
    }),
  ].join("\n");
  return { summary, details };
}
