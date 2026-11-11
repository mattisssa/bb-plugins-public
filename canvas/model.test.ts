import { describe, expect, it } from "vitest";
import {
  applyPatch,
  arrowPath,
  boardSchema,
  boundsOf,
  constrainLine,
  contentBounds,
  elementSchema,
  imageViewport,
  isTextElement,
  STICKY_BACKGROUND,
  type ArrowElement,
  type CanvasElement,
  type ImageElement,
  type StickyElement,
} from "./model";
import { layoutSticky, stickyPadding, textAdvance } from "./layout";

const note = (id: string, x = 0): CanvasElement => ({
  id,
  type: "text",
  x,
  y: 10,
  width: 120,
  height: 40,
  text: id,
  color: "#242424",
  fontSize: 20,
});
const arrow = (
  points: ArrowElement["points"],
  strokeWidth = 4,
): ArrowElement => ({
  id: "arrow",
  type: "arrow",
  x: 20,
  y: 30,
  points,
  color: "#087bdf",
  strokeWidth,
});
const sticky: StickyElement = {
  id: "sticky",
  type: "sticky",
  x: -25,
  y: 15,
  width: 240,
  height: 180,
  text: "A note\nwith two lines",
  color: "#242424",
  background: STICKY_BACKGROUND,
  fontSize: 20,
};

describe("canvas geometry", () => {
  it("constrains Shift drawing to the nearest horizontal or vertical axis", () => {
    const start = { x: 30, y: -10 };
    expect(constrainLine(start, { x: 70, y: 8 })).toEqual({ x: 70, y: -10 });
    expect(constrainLine(start, { x: 20, y: -70 })).toEqual({ x: 30, y: -70 });
    expect(constrainLine(start, start)).toEqual(start);
  });

  it("includes stroke thickness and negative drawing coordinates in export bounds", () => {
    const stroke: CanvasElement = {
      id: "stroke",
      type: "draw",
      x: 20,
      y: 30,
      points: [
        [-50, 5],
        [10, -20],
      ],
      color: "#087bdf",
      strokeWidth: 8,
    };
    expect(boundsOf(stroke)).toEqual({ x: -34, y: 6, width: 68, height: 33 });
    expect(contentBounds([stroke, note("note", 100)], 24)).toEqual({
      x: -58,
      y: -18,
      width: 302,
      height: 92,
    });
  });

  it("gives a single drawing point a nonempty area", () => {
    expect(
      boundsOf({
        id: "dot",
        type: "draw",
        x: -100,
        y: 100,
        points: [[10, 20]],
        color: "#242424",
        strokeWidth: 4,
      }),
    ).toEqual({ x: -92, y: 118, width: 4, height: 4 });
  });

  it.each([
    {
      points: [
        [-10, 5],
        [90, 5],
      ],
      path: "M -10 5 L 90 5 M 74 13 L 90 5 L 74 -3",
      box: { x: 8, y: 25, width: 104, height: 20 },
    },
    {
      points: [
        [90, 5],
        [-10, 5],
      ],
      path: "M 90 5 L -10 5 M 6 -3 L -10 5 L 6 13",
      box: { x: 8, y: 25, width: 104, height: 20 },
    },
    {
      points: [
        [5, -10],
        [5, 90],
      ],
      path: "M 5 -10 L 5 90 M -3 74 L 5 90 L 13 74",
      box: { x: 15, y: 18, width: 20, height: 104 },
    },
    {
      points: [
        [5, 90],
        [5, -10],
      ],
      path: "M 5 90 L 5 -10 M 13 6 L 5 -10 L -3 6",
      box: { x: 15, y: 18, width: 20, height: 104 },
    },
  ])(
    "points its open head at the second endpoint: $points",
    ({ points, path, box }) => {
      const element = arrow(points as ArrowElement["points"]);
      expect(arrowPath(element)).toBe(path);
      expect(boundsOf(element)).toEqual(box);
    },
  );

  it.each([
    [-100, -10],
    [-100, 10],
    [100, -10],
    [100, 10],
  ])("includes the off-axis head for diagonal arrows to (%s, %s)", (x, y) => {
    const box = boundsOf(
      arrow([
        [0, 0],
        [x, y],
      ]),
    );
    expect(box.x).toBeCloseTo(20 + Math.min(0, x) - 2);
    expect(box.width).toBeCloseTo(104);
    // The head extends beyond the shaft's vertical range in either direction.
    if (y > 0) expect(box.y + box.height).toBeGreaterThan(30 + y + 2);
    else expect(box.y).toBeLessThan(30 + y - 2);
  });

  it("clamps short arrowheads and keeps zero-length arrows finite", () => {
    const short = arrow(
      [
        [0, 0],
        [4, 0],
      ],
      8,
    );
    expect(arrowPath(short)).toBe("M 0 0 L 4 0 M 2 1 L 4 0 L 2 -1");
    expect(boundsOf(short)).toEqual({ x: 16, y: 25, width: 12, height: 10 });
    const zero = arrow([
      [10, -20],
      [10, -20],
    ]);
    expect(arrowPath(zero)).toBe("M 10 -20 L 10 -20");
    expect(boundsOf(zero)).toEqual({ x: 28, y: 8, width: 4, height: 4 });
  });

  it("keeps the whole sticky rectangle in its bounds", () => {
    expect(boundsOf(sticky)).toEqual({
      x: -25,
      y: 15,
      width: 240,
      height: 180,
    });
    expect(contentBounds([sticky], 24)).toEqual({
      x: -49,
      y: -9,
      width: 288,
      height: 228,
    });
  });
});

describe("saved elements", () => {
  it("accepts arrows in version-one boards and requires exactly two valid endpoints", () => {
    const element = arrow([
      [0, 0],
      [-120, 80],
    ]);
    expect(
      boardSchema.parse({
        version: 1,
        revision: 0,
        elements: [note("old"), element],
      }).elements,
    ).toEqual([note("old"), element]);
    for (const points of [
      [],
      [[0, 0]],
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      [
        [0, 0],
        [Infinity, 0],
      ],
      [
        [0, 0],
        [100_001, 0],
      ],
    ])
      expect(elementSchema.safeParse({ ...element, points }).success).toBe(
        false,
      );
  });

  it("accepts sticky text in version-one boards and validates its background", () => {
    expect(
      boardSchema.parse({
        version: 1,
        revision: 0,
        elements: [note("old"), sticky],
      }).elements,
    ).toEqual([note("old"), sticky]);
    for (const background of [
      undefined,
      "yellow",
      "#fff",
      "url(https://example.com)",
    ])
      expect(elementSchema.safeParse({ ...sticky, background }).success).toBe(
        false,
      );
    expect(isTextElement(sticky)).toBe(true);
    expect(isTextElement(note("plain"))).toBe(true);
    expect(
      isTextElement(
        arrow([
          [0, 0],
          [100, 0],
        ]),
      ),
    ).toBe(false);
    expect(isTextElement(null)).toBe(false);
  });

  it("applies a patch without replacing other clients' elements or changing their stacking order", () => {
    const before = [note("a"), note("b"), note("c")];
    const after = applyPatch(before, {
      upserts: [note("b", 80), note("d", -40)],
      removeIds: ["c"],
    });
    expect(after).toEqual([note("a"), note("b", 80), note("d", -40)]);
    expect(before).toEqual([note("a"), note("b"), note("c")]);
  });

  it("rejects invalid geometry, unknown fields, and oversized boards", () => {
    for (const change of [
      { x: Infinity },
      { y: NaN },
      { width: 0 },
      { height: -2 },
      { color: "red" },
      { fontSize: 500 },
      { html: "<script/>" },
    ]) {
      expect(elementSchema.safeParse({ ...note("a"), ...change }).success).toBe(
        false,
      );
    }
    expect(
      boardSchema.safeParse({
        version: 1,
        revision: 0,
        elements: Array.from({ length: 501 }, (_, i) => note(`note-${i}`)),
      }).success,
    ).toBe(false);
  });
});

describe("sticky layout", () => {
  const square: StickyElement = {
    ...sticky,
    width: 180,
    height: 180,
    fontSize: 24,
  };
  it("wraps at words without moving breaking spaces to the next line", () => {
    const layout = layoutSticky({ ...square, text: "WWWWWW hello" });
    expect(layout.lines).toEqual(["WWWWWW", "hello"]);
    expect(layout.fontSize).toBe(24);
    expect(layout.padding).toBe(16);
    expect(layout.contentWidth).toBe(146);
    expect(layout.contentHeight).toBe(146);
    expect(layoutSticky({ ...square, text: "" }).lines).toEqual([""]);
  });

  it("preserves explicit empty lines and expands tabs without changing saved text", () => {
    const note = { ...square, text: "first\n\nlast\n" };
    expect(layoutSticky(note).lines).toEqual(["first", "", "last", ""]);
    expect(note.text).toBe("first\n\nlast\n");
    expect(layoutSticky({ ...square, text: "a\tb" }).lines).toEqual(["a    b"]);
  });

  it.each([
    { name: "long words", text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(30) },
    {
      name: "paragraph",
      text: "Words that should all remain visible. ".repeat(80).trim(),
    },
    { name: "maximum newlines", text: "x\n".repeat(5000) },
    { name: "emoji graphemes", text: "👨‍👩‍👧‍👦".repeat(60) },
  ])("fits dense content without truncation: $name", ({ text }) => {
    const layout = layoutSticky({ ...square, text });
    expect(layout.fontSize).toBeGreaterThan(0);
    expect(layout.fontSize).toBeLessThan(24);
    expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(
      layout.contentHeight + 1e-7,
    );
    for (const line of layout.lines)
      expect(textAdvance(line, layout.fontSize)).toBeLessThanOrEqual(
        layout.contentWidth + 1e-7,
      );
    expect(layout.lines.join("").replaceAll(" ", "")).toBe(
      text.replace(/[ \n]/g, ""),
    );
    if (text.includes("👨"))
      for (const line of layout.lines)
        expect(line.replaceAll("👨‍👩‍👧‍👦", "")).toBe("");
  });

  it("scales padding, wrapped lines, and fitted font proportionally", () => {
    const text =
      "An explanation that wraps across several lines of this note. ".repeat(4);
    const small = layoutSticky({ ...square, text });
    const large = layoutSticky({
      ...square,
      text,
      width: 360,
      height: 360,
      fontSize: 48,
    });
    expect(large.lines).toEqual(small.lines);
    expect(large.fontSize).toBeCloseTo(small.fontSize * 2, 6);
    expect(large.padding).toBe(small.padding * 2);
    expect(stickyPadding({ width: 90, height: 90 })).toBe(8);
    expect(textAdvance("漢", 24)).toBeGreaterThanOrEqual(24);
  });
});

describe("non-destructive image crops", () => {
  const source: ImageElement = {
    id: "image",
    type: "image",
    assetId: "asset",
    name: "original.png",
    x: 10,
    y: 20,
    width: 100,
    height: 60,
  };
  it("keeps the display bounds separate from the original image viewport", () => {
    expect(imageViewport(source)).toEqual(boundsOf(source));
    const cropped: ImageElement = {
      ...source,
      crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.6 },
    };
    expect(imageViewport(cropped)).toEqual({
      x: -40,
      y: 10,
      width: 200,
      height: 100,
    });
    expect(boundsOf(cropped)).toEqual(boundsOf(source));
    expect(
      boardSchema.parse({
        version: 1,
        revision: 2,
        elements: [source, cropped],
      }).elements,
    ).toEqual([source, cropped]);
  });

  it("rejects empty, outside, and nonfinite crops while allowing edge rounding", () => {
    const full = { x: 0, y: 0, width: 1, height: 1 };
    for (const change of [
      { x: -0.1 },
      { y: -0.1 },
      { x: 0.5 },
      { y: 0.5 },
      { width: 0 },
      { height: -1 },
      { width: 1.1 },
      { height: NaN },
      { width: Number.MIN_VALUE },
      { other: true },
      { x: 1, width: 1e-12 },
      { y: 1, height: 1e-12 },
    ])
      expect(
        elementSchema.safeParse({
          ...source,
          crop: { ...full, ...change },
        }).success,
      ).toBe(false);
    expect(
      elementSchema.safeParse({
        ...source,
        crop: { x: 0.7, y: 0, width: 0.3000000000000001, height: 1 },
      }).success,
    ).toBe(true);
  });
});
