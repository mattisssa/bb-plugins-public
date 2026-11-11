import {
  boundsOf,
  intersects,
  marksOf,
  type Bounds,
  type CanvasElement,
} from "./model";

const percent = (value: number) =>
  Math.round(Math.max(0, Math.min(1, value)) * 100);
const overlap = (a: Bounds, b: Bounds) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * The message a feedback send posts: `summary` is the user's numbered
 * comments; `details` locates each outline for the agent, in the pixels of
 * the attached export (`frame`), on the image under it, and in canvas units.
 */
export function feedbackMessage(
  elements: CanvasElement[],
  frame: { box: Bounds; scale: number },
) {
  const marks = marksOf(elements);
  const images = elements.filter((element) => element.type === "image");
  const { box, scale } = frame;
  const count = `${marks.length} comment${marks.length === 1 ? "" : "s"}`;
  const summary = [
    `Canvas feedback (${count})`,
    "",
    ...marks.map(
      (mark, index) => `${index + 1}. ${mark.text.trim() || "(no comment)"}`,
    ),
  ].join("\n");
  const details = [
    `The attached image is this thread's Canvas, ${Math.ceil(box.width * scale)} × ${Math.ceil(box.height * scale)} px. Each numbered outline marks the area one comment above refers to; its number sits at the top-left corner of the outline.`,
    "",
    ...marks.map((mark, index) => {
      const area = boundsOf(mark);
      const px = (value: number) => Math.round(value * scale);
      const parts = [
        `in the attached image x ${px(area.x - box.x)}, y ${px(area.y - box.y)}, ${px(area.width)} × ${px(area.height)} px`,
      ];
      // The image the outline covers most, topmost first on a tie.
      const under = images
        .filter((image) => intersects(boundsOf(image), area))
        .reduce<(typeof images)[number] | null>(
          (best, image) =>
            best &&
            overlap(boundsOf(best), area) > overlap(boundsOf(image), area)
              ? best
              : image,
          null,
        );
      if (under)
        parts.push(
          `over image "${under.name}" at ${percent((area.x - under.x) / under.width)}–${percent((area.x + area.width - under.x) / under.width)}% from its left and ${percent((area.y - under.y) / under.height)}–${percent((area.y + area.height - under.y) / under.height)}% from its top`,
        );
      parts.push(
        `canvas units x ${Math.round(area.x)}, y ${Math.round(area.y)}, ${Math.round(area.width)} × ${Math.round(area.height)}`,
      );
      return `${index + 1}. ${parts.join("; ")}.`;
    }),
  ].join("\n");
  return { summary, details };
}
