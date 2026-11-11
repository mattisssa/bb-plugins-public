import { describe, expect, it } from "vitest";
import { layoutSticky, textAdvance } from "./layout";
import type { StickyElement } from "./model";

const sticky: StickyElement = {
  id: "layout-cache-test",
  type: "sticky",
  x: 0,
  y: 0,
  width: 180,
  height: 180,
  text: "A note whose layout can be reused while moving around the canvas.",
  fontSize: 24,
  color: "#222222",
  background: "#fff3b0",
};

describe("sticky layout reuse", () => {
  it("reuses the layout when only position or colors change", () => {
    const first = layoutSticky(sticky);
    const moved = { ...sticky, x: 75, y: -120 };
    expect(layoutSticky(moved)).toBe(first);
    expect(
      layoutSticky({ ...moved, color: "#ffffff", background: "#000000" }),
    ).toBe(first);
  });

  it.each([
    { text: "A different note" },
    { width: 240 },
    { height: 240 },
    { fontSize: 16 },
  ])("invalidates changed layout inputs: %j", (change) => {
    const note = { ...sticky };
    const before = layoutSticky(note);
    Object.assign(note, change);
    const after = layoutSticky(note);
    expect(after).not.toBe(before);
    expect(after).toEqual(layoutSticky({ ...note, id: "uncached-reference" }));
    expect(layoutSticky(note)).toBe(after);
  });

  it("does not retain every note from previously opened boards", () => {
    const first = layoutSticky(sticky);
    for (let i = 0; i < 600; i++)
      layoutSticky({ ...sticky, id: `previous-board-${i}`, text: `${i}` });
    const revisited = layoutSticky(sticky);
    expect(revisited).not.toBe(first);
    expect(revisited).toEqual(first);
  });
});

describe("sticky fit measurement", () => {
  it("ignores hanging spaces when measuring visible lines", () => {
    const layout = layoutSticky({
      ...sticky,
      text: "  word  \u00a0\u2003\n\tworld\t\n  ",
    });
    expect(layout.lines).toEqual(["  word", "    world", ""]);
    expect(layout.fontSize).toBe(24);
  });

  it("keeps zero-advance content and joined graphemes during fitting", () => {
    const layout = layoutSticky({
      ...sticky,
      text: "x\u200d\u0301   👨‍👩‍👧‍👦👨‍👩‍👧‍👦\nक्षक्षक्षक्षक्षक्ष éééééé",
    });
    expect(layout.lines).toEqual([
      "x\u200d\u0301",
      "👨‍👩‍👧‍👦",
      "👨‍👩‍👧‍👦",
      "क्षक्ष",
      "क्षक्ष",
      "क्षक्ष",
      "éééééé",
    ]);
    expect(layout.fontSize).toBeCloseTo(16.043955981731415, 10);
    expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(
      layout.contentHeight,
    );
    for (const line of layout.lines)
      expect(textAdvance(line, layout.fontSize)).toBeLessThanOrEqual(
        layout.contentWidth,
      );
  });

  it("measures untrimmed lines when breaking a long token", () => {
    const text = "\u00a0".repeat(30) + "a";
    const layout = layoutSticky({ ...sticky, text });
    expect(layout.lines).toEqual([
      "\u00a0".repeat(19),
      "\u00a0".repeat(11) + "a",
    ]);
    expect(layout.lines.join("")).toBe(text);
    expect(layout.fontSize).toBe(24);
  });
});
