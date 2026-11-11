import { describe, expect, it } from "vitest";
import {
  decodeClipboard,
  duplicateElements,
  encodeClipboard,
  validatePaste,
} from "./clipboard";
import {
  emptyBoard,
  type Board,
  type CanvasElement,
  type DrawElement,
  type ImageElement,
  type TextElement,
} from "./model";

const PREFIX = "bb-canvas-elements:";
const BOARD_BYTES = 2 * 1024 * 1024;
const byteLength = (value: string) => new TextEncoder().encode(value).length;

function note(id: string, text = "Keep this margin"): TextElement {
  return {
    id,
    type: "text",
    x: -90,
    y: 280,
    width: 260,
    height: 72,
    text,
    fontSize: 32,
    color: "#8854c8",
  };
}
function mixedElements(): [ImageElement, TextElement, DrawElement] {
  return [
    {
      id: "background",
      type: "image",
      assetId: "source-image",
      name: "Review.png",
      x: -120.5,
      y: 80,
      width: 320,
      height: 180,
    },
    note("annotation", "Keep this margin\n↑ Space"),
    {
      id: "mark",
      type: "draw",
      x: -100,
      y: 270,
      points: [
        [-8, 2],
        [0, 0],
        [160.25, 12.5],
      ],
      strokeWidth: 5.5,
      color: "#e5484d",
    },
  ];
}
function envelope(changes: Record<string, unknown> = {}) {
  return (
    PREFIX +
    JSON.stringify({
      version: 1,
      copyId: "copy-one",
      sourceThreadId: "thread-a",
      elements: [note("annotation")],
      ...changes,
    })
  );
}
function freeze(value: unknown) {
  if (!value || typeof value !== "object") return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}

describe("Canvas clipboard snapshots", () => {
  it("round-trips a mixed selection and preserves styles, geometry and stacking order", () => {
    const source = mixedElements();
    const encoded = encodeClipboard("thread-a", source);
    const copied = decodeClipboard(encoded)!;
    expect(copied).toMatchObject({
      version: 1,
      sourceThreadId: "thread-a",
      elements: source,
    });
    expect(copied.copyId).toMatch(/^[\w-]+$/);
    expect(copied.elements.map((element) => element.type)).toEqual([
      "image",
      "text",
      "draw",
    ]);
    const added = duplicateElements(copied.elements, 24);
    expect(added).toEqual(
      source.map((element) => ({
        ...element,
        id: expect.any(String),
        x: element.x + 24,
        y: element.y + 24,
      })),
    );
    for (const [index, element] of added.entries()) {
      expect(element.x - added[0]!.x).toBe(source[index]!.x - source[0].x);
      expect(element.y - added[0]!.y).toBe(source[index]!.y - source[0].y);
    }
    expect(() => validatePaste(emptyBoard(), added)).not.toThrow();
  });

  it("keeps the copied snapshot unchanged after the original elements are edited", () => {
    const source = mixedElements();
    const expected = structuredClone(source);
    const encoded = encodeClipboard("thread-a", source);
    source[0].assetId = "replacement-image";
    source[0].width = 640;
    source[1].text = "Changed after copying";
    source[1].color = "#087bdf";
    source[2].points[0]![0] = 900;
    source[2].points.push([500, 500]);
    source.reverse();
    expect(decodeClipboard(encoded)!.elements).toEqual(expected);
  });

  it("gives every paste fresh IDs and translates from an immutable copied snapshot", () => {
    const source = mixedElements();
    const expected = structuredClone(source);
    freeze(source);
    const first = duplicateElements(source, 24);
    const second = duplicateElements(source, 48);
    const ids = [...source, ...first, ...second].map((element) => element.id);
    expect(new Set(ids).size).toBe(9);
    expect(first[0]).toMatchObject({
      x: source[0].x + 24,
      y: source[0].y + 24,
    });
    expect(second[0]).toMatchObject({
      x: source[0].x + 48,
      y: source[0].y + 48,
    });
    expect(source).toEqual(expected);
    first[0]!.x = 0;
    expect(source).toEqual(expected);
    expect(second[0]!.x).toBe(expected[0].x + 48);
    expect(
      decodeClipboard(encodeClipboard("thread-a", source))!.copyId,
    ).not.toBe(decodeClipboard(encodeClipboard("thread-a", source))!.copyId);
  });
});

describe("Canvas clipboard boundaries", () => {
  it.each(["", "A plain text note", '{"version":1}', "bb-canvas-elements"])(
    "leaves ordinary clipboard text to the normal paste path: %j",
    (value) => expect(decodeClipboard(value)).toBeNull(),
  );

  it.each([
    ["truncated JSON", PREFIX + "{"],
    ["null envelope", PREFIX + "null"],
    ["array envelope", PREFIX + "[]"],
    ["unsupported version", envelope({ version: 2 })],
    ["missing copy ID", envelope({ copyId: undefined })],
    ["invalid source thread", envelope({ sourceThreadId: "../thread-b" })],
    ["unknown envelope fields", envelope({ script: "unexpected" })],
    ["empty selection", envelope({ elements: [] })],
    [
      "too many elements",
      envelope({
        elements: Array.from({ length: 501 }, (_, i) => note(`n-${i}`)),
      }),
    ],
    [
      "unknown element fields",
      envelope({ elements: [{ ...note("n"), html: "unexpected" }] }),
    ],
    [
      "coordinates beyond the limit",
      envelope({ elements: [{ ...note("n"), x: 100_001 }] }),
    ],
    [
      "non-finite coordinates",
      envelope({ elements: [{ ...note("n"), y: Infinity }] }),
    ],
    [
      "invalid drawing points",
      envelope({
        elements: [{ ...mixedElements()[2], points: [[0, -100_001]] }],
      }),
    ],
  ])("rejects %s with a recoverable clipboard error", (_label, value) => {
    expect(() => decodeClipboard(value)).toThrow(/clipboard data is invalid/i);
  });

  it("accepts the element count and coordinate boundaries", () => {
    const elements = Array.from({ length: 500 }, (_, i) => ({
      ...note(`n-${i}`),
      x: i % 2 ? -100_000 : 100_000,
      y: i % 2 ? 100_000 : -100_000,
    }));
    expect(
      decodeClipboard(encodeClipboard("thread-a", elements))!.elements,
    ).toEqual(elements);
  });

  it("bounds encoded and decoded clipboard data by UTF-8 bytes", () => {
    const elements = Array.from({ length: 70 }, (_, i) =>
      note(`unicode-${i}`, "界".repeat(10_000)),
    );
    const oversized = envelope({ elements });
    expect(oversized.length).toBeLessThan(BOARD_BYTES);
    expect(byteLength(oversized)).toBeGreaterThan(BOARD_BYTES + 2048);
    expect(() => encodeClipboard("thread-a", elements)).toThrow(
      /too large to copy/i,
    );
    expect(() => decodeClipboard(oversized)).toThrow(
      /clipboard data is invalid/i,
    );
    expect(() =>
      decodeClipboard(PREFIX + " ".repeat(BOARD_BYTES + 2049)),
    ).toThrow(/clipboard data is invalid/i);
    const nearLimit = elements.slice(0, 69);
    expect(
      decodeClipboard(encodeClipboard("thread-a", nearLimit))!.elements,
    ).toEqual(nearLimit);
  });
});

describe("group translation at coordinate limits", () => {
  it.each([
    {
      label: "right edge",
      xs: [99_990, 99_950],
      ys: [-40, 10],
      offset: 24,
      dx: 10,
      dy: 24,
    },
    {
      label: "bottom edge",
      xs: [-40, 10],
      ys: [99_980, 99_997],
      offset: 24,
      dx: 24,
      dy: 3,
    },
    {
      label: "top and left edges",
      xs: [-99_995, -99_960],
      ys: [-99_999, -99_950],
      offset: -24,
      dx: -5,
      dy: -1,
    },
    {
      label: "opposite edges",
      xs: [-100_000, 100_000],
      ys: [100_000, -100_000],
      offset: 24,
      dx: 0,
      dy: 0,
    },
  ])("keeps the group intact at the $label", ({ xs, ys, offset, dx, dy }) => {
    const elements = xs.map((x, i) => ({ ...note(`n-${i}`), x, y: ys[i]! }));
    const copied = duplicateElements(elements, offset);
    expect(copied.map(({ x, y }) => [x, y])).toEqual(
      elements.map(({ x, y }) => [x + dx, y + dy]),
    );
    expect(() => validatePaste(emptyBoard(), copied)).not.toThrow();
  });
});

describe("paste validation", () => {
  it("accepts the 500th element and rejects the 501st without mutating the board", () => {
    const board: Board = {
      version: 1,
      revision: 7,
      elements: Array.from({ length: 499 }, (_, i) => note(`existing-${i}`)),
    };
    const before = structuredClone(board);
    freeze(board);
    expect(() => validatePaste(board, [note("last")])).not.toThrow();
    expect(() =>
      validatePaste(board, [note("last"), note("overflow")]),
    ).toThrow(/canvas is full/i);
    expect(board).toEqual(before);
  });

  it("checks the combined board's UTF-8 size, including existing content", () => {
    const board: Board = {
      version: 1,
      revision: 7,
      elements: Array.from({ length: 69 }, (_, i) =>
        note(`existing-${i}`, "界".repeat(10_000)),
      ),
    };
    const added = [note("new", "界".repeat(10_000))];
    const next = { ...board, elements: [...board.elements, ...added] };
    expect(byteLength(JSON.stringify(board))).toBeLessThan(BOARD_BYTES);
    expect(byteLength(JSON.stringify(added))).toBeLessThan(BOARD_BYTES);
    expect(JSON.stringify(next).length).toBeLessThan(BOARD_BYTES);
    expect(byteLength(JSON.stringify(next))).toBeGreaterThan(BOARD_BYTES);
    expect(() => validatePaste(board, [])).not.toThrow();
    expect(() => validatePaste(emptyBoard(), added)).not.toThrow();
    expect(() => validatePaste(board, added)).toThrow(/canvas is full/i);
  });

  it("rejects elements outside the board schema before they can be committed", () => {
    const invalid: CanvasElement = { ...note("outside"), y: -100_001 };
    expect(() => validatePaste(emptyBoard(), [invalid])).toThrow(
      /canvas is full/i,
    );
  });
});
