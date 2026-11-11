import { expect, it } from "vitest";
import { feedbackMessage, feedbackSchema } from "./shared";

const notes = [
  { text: " Make this bigger ", x: 100, y: 50, width: 200, height: 100 },
  { text: "", x: 0, y: 900, width: 4000, height: 100 },
];

it("lists the comments for the user and locates each outline for the agent", () => {
  const { summary, details } = feedbackMessage({
    source: { name: "home.png", width: 4000, height: 1000 },
    image: { base64: "x", mimeType: "image/png", width: 2000, height: 500 },
    notes,
  });
  expect(summary).toBe(
    "Image feedback (2 comments)\n\n1. Make this bigger\n2. (no comment)",
  );
  expect(details).toContain(
    "(home.png), 4000 × 1000 px, scaled to 2000 × 500 px.",
  );
  expect(details).toContain(
    "1. in the original image x 100, y 50, 200 × 100 px; 3–8% from its left and 5–15% from its top; in the attached copy x 50, y 25, 100 × 50 px.",
  );
  expect(details).toContain("2. in the original image x 0, y 900");
});

it("omits the copy's coordinates when the copy has the original size", () => {
  const { summary, details } = feedbackMessage({
    source: { name: "", width: 400, height: 300 },
    image: { base64: "x", mimeType: "image/png", width: 400, height: 300 },
    notes: notes.slice(0, 1),
  });
  expect(summary).toBe("Image feedback (1 comment)\n\n1. Make this bigger");
  expect(details).not.toContain("attached copy");
  expect(details).toContain("shown in this thread, 400 × 300 px. Each");
});

it("rejects feedback without an outline", () => {
  expect(
    feedbackSchema.safeParse({
      threadId: "thr_1",
      source: { name: "", width: 1, height: 1 },
      image: { base64: "x", mimeType: "image/png", width: 1, height: 1 },
      notes: [],
    }).success,
  ).toBe(false);
});
