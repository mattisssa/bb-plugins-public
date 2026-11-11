// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  applyPatch,
  STICKY_BACKGROUND,
  type Board,
  type CanvasElement,
  type Patch,
} from "./model";
import {
  CANVAS_CLIPBOARD_TYPE,
  decodeClipboard,
  encodeClipboard,
} from "./clipboard";
import * as layout from "./layout";
import * as geometry from "./model";

vi.mock("./images", () => ({
  imageData: vi.fn(async () => "image-data"),
  loadImage: vi.fn(),
}));

const note: CanvasElement = {
  id: "annotation",
  type: "text",
  x: 0,
  y: 0,
  width: 100,
  height: 32,
  text: "Keep this red",
  color: "#e5484d",
  fontSize: 24,
};
const stroke: CanvasElement = {
  id: "stroke",
  type: "draw",
  x: 10,
  y: 10,
  points: [
    [0, 0],
    [50, 0],
  ],
  strokeWidth: 3,
  color: "#242424",
};
const picture: CanvasElement = {
  id: "image",
  type: "image",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  assetId: "asset",
  name: "Screenshot",
};
const arrow: CanvasElement = {
  id: "arrow",
  type: "arrow",
  x: 20,
  y: 40,
  points: [
    [0, 0],
    [120, 30],
  ],
  color: "#087bdf",
  strokeWidth: 3,
};
const sticky: CanvasElement = {
  ...note,
  id: "sticky",
  type: "sticky",
  width: 180,
  height: 180,
  background: STICKY_BACKGROUND,
};
let counter = 0;

beforeEach(() => {
  Object.defineProperty(document, "elementFromPoint", {
    value: () => null,
    configurable: true,
    writable: true,
  });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? "mouse";
      }
    },
  );
  for (const [name, value] of Object.entries({
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: (): boolean => false,
  })) {
    Object.defineProperty(HTMLElement.prototype, name, {
      value,
      configurable: true,
    });
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 12 }),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(
  elements: CanvasElement[] = [],
  sendFeedback?: (board: Board) => { ids: string[] },
) {
  const app = await loadPluginApp(() => import("./app"));
  const threadId = `review-${++counter}`;
  let board: Board = { version: 1, revision: 1, elements };
  const update = vi.fn(
    async ({ patch }: { threadId: string; patch: Patch }) => {
      board = {
        ...board,
        revision: board.revision + 1,
        elements: applyPatch(board.elements, patch),
      };
      return board;
    },
  );
  const upload = vi.fn(async () => ({ id: "asset", width: 200, height: 100 }));
  const slot = renderSlot(
    app.threadPanelActions[0]!,
    { threadId, params: null },
    {
      rpc: {
        getCanvas: () => board,
        updateCanvas: (input) =>
          update(input as { threadId: string; patch: Patch }),
        uploadCanvasImage: upload,
        ...(sendFeedback && {
          sendCanvasFeedback: () => sendFeedback(board),
        }),
      },
    },
  );
  await slot.findByText("Saved");
  const surface = slot.container.querySelector(".cv-surface")!;
  return { slot, surface, update, upload, threadId, board: () => board };
}
function clipboardData() {
  const values = new Map<string, string>();
  return {
    items: [] as { type: string; getAsFile(): File }[],
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
  };
}
function select(surface: Element, target: Element) {
  fireEvent.pointerDown(target, {
    button: 0,
    pointerId: 1,
    clientX: 40,
    clientY: 56,
  });
  fireEvent.pointerUp(surface, {
    button: 0,
    pointerId: 1,
    clientX: 40,
    clientY: 56,
  });
}

function expectEditingBox(
  container: HTMLElement,
  width: number,
  height: number,
) {
  const editor = container.querySelector(
    ".cv-text-editor",
  ) as HTMLTextAreaElement;
  expect(container.querySelectorAll(".cv-selection")).toHaveLength(1);
  const frame = container.querySelector(".cv-selection > rect")!;
  expect(Number(frame.getAttribute("width"))).toBeCloseTo(width);
  expect(Number(frame.getAttribute("height"))).toBeCloseTo(height);
  const transform = container
    .querySelector(".cv-artboard > g")!
    .getAttribute("transform")!;
  const [, panX, panY, zoom] = transform.match(
    /translate\(([^ ]+) ([^)]+)\) scale\(([^)]+)\)/,
  )!;
  expect(parseFloat(editor.style.width)).toBeCloseTo(width * Number(zoom));
  expect(parseFloat(editor.style.height)).toBeCloseTo(height * Number(zoom));
  expect(parseFloat(editor.style.left)).toBeCloseTo(
    Number(panX) + Number(frame.getAttribute("x")) * Number(zoom),
  );
  expect(parseFloat(editor.style.top)).toBeCloseTo(
    Number(panY) + Number(frame.getAttribute("y")) * Number(zoom),
  );
}

describe("Canvas editing workflows", () => {
  it("creates a styled arrow over an image from the final release position and undoes it", async () => {
    const { slot, surface, board } = await open([picture]);
    const tools = slot.getByRole("group", { name: "Tools" });
    expect(
      Array.from(tools.querySelectorAll("button"), (button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Select (V)",
      "Sticky note (S)",
      "Text (T)",
      "Arrow (A)",
      "Draw (D)",
      "Feedback (F)",
    ]);
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "a" });
    fireEvent.click(slot.getByRole("button", { name: "Blue" }));
    fireEvent.click(slot.getByRole("button", { name: "Thick stroke (8)" }));
    fireEvent.pointerDown(
      slot.container.querySelector('[data-element="image"]')!,
      {
        button: 0,
        pointerId: 1,
        clientX: 32,
        clientY: 48,
      },
    );
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 107, clientY: 78 });
    await slot.findByText("Saved");
    expect(board().elements).toEqual([
      picture,
      expect.objectContaining({
        type: "arrow",
        x: 0,
        y: 0,
        color: "#087bdf",
        strokeWidth: 8,
        points: [
          [0, 0],
          [100, 40],
        ],
      }),
    ]);
    expect(
      slot
        .getByRole("button", { name: "Arrow (A)" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      slot.container.querySelector(
        '[data-element-type="arrow"] path[stroke="#087bdf"]',
      ),
    ).toBeTruthy();
    expect(slot.container.querySelector("[data-corner]")).toBeNull();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      ctrlKey: true,
    });
    await waitFor(() => expect(board().elements).toEqual([picture]));
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      ctrlKey: true,
      shiftKey: true,
    });
    await waitFor(() => expect(board().elements).toHaveLength(2));
  });

  it("outlines areas, takes a comment for each, and sends them to the thread", async () => {
    const send = vi.fn((saved: Board) => ({
      ids: saved.elements
        .filter((element) => element.type === "mark")
        .map((element) => element.id),
    }));
    const { slot, surface, board } = await open([picture], send);
    const outline = (x: number, y: number) => {
      fireEvent.pointerDown(
        slot.container.querySelector('[data-element="image"]')!,
        { button: 0, pointerId: 1, clientX: x, clientY: y },
      );
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: x + 30,
        clientY: y + 15,
      });
      fireEvent.pointerUp(surface, {
        pointerId: 1,
        clientX: x,
        clientY: y + 30,
      });
      return slot.getByLabelText(
        "Feedback for this area",
      ) as HTMLTextAreaElement;
    };
    expect(slot.queryByRole("button", { name: /^Send/ })).toBeNull();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "f" });
    const first = outline(47, 63);
    expect(document.activeElement).toBe(first);
    fireEvent.change(first, { target: { value: " Make this bigger " } });
    fireEvent.keyDown(first, { key: "Enter" });
    expect(slot.queryByLabelText("Feedback for this area")).toBeNull();
    // The tool stays active for the next outline; a blur saves its comment.
    const second = outline(92, 63);
    fireEvent.change(second, { target: { value: "Wrong color" } });
    fireEvent.blur(second);
    // Escape discards an outline that never got a comment.
    fireEvent.keyDown(outline(47, 93), { key: "Escape" });
    await slot.findByText("Saved");
    expect(board().elements.slice(1)).toEqual([
      expect.objectContaining({
        type: "mark",
        text: "Make this bigger",
        color: "#e5484d",
        x: 20,
        y: 20,
      }),
      expect.objectContaining({ type: "mark", text: "Wrong color", x: 80 }),
    ]);
    expect(
      Array.from(
        slot.container.querySelectorAll(".cv-pin"),
        (pin) => pin.textContent,
      ),
    ).toEqual(["1Make this bigger", "2Wrong color"]);
    // A pin reopens its comment for editing.
    fireEvent.click(slot.getByRole("button", { name: "Feedback 2" }));
    const reopened = slot.getByLabelText(
      "Feedback for this area",
    ) as HTMLTextAreaElement;
    expect(reopened.value).toBe("Wrong color");
    fireEvent.change(reopened, { target: { value: "Use the accent color" } });
    fireEvent.blur(reopened);
    fireEvent.click(slot.getByRole("button", { name: "Send 2" }));
    await slot.findByText("Sent 2 comments to the thread.");
    // The last comment was saved before the server read the board.
    expect(send.mock.calls).toEqual([
      [
        expect.objectContaining({
          elements: [
            picture,
            expect.objectContaining({ text: "Make this bigger" }),
            expect.objectContaining({ text: "Use the accent color" }),
          ],
        }),
      ],
    ]);
    await waitFor(() => expect(board().elements).toEqual([picture]));
    expect(slot.queryByRole("button", { name: /^Send/ })).toBeNull();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(board().elements.at(-1)).toMatchObject({
        text: "Use the accent color",
      }),
    );
  });

  it.each([
    { pointerType: "mouse", x: 107, y: 63, end: [100, 0] },
    { pointerType: "touch", x: 47, y: 123, end: [0, 100] },
    { pointerType: "pen", x: -43, y: 33, end: [-100, 0] },
  ])(
    "constrains an arrow for $pointerType input including release-time Shift",
    async ({ pointerType, x, y, end }) => {
      const { slot, surface, board } = await open();
      fireEvent.click(slot.getByRole("button", { name: "Arrow (A)" }));
      fireEvent.pointerDown(surface, {
        button: 0,
        pointerId: 1,
        clientX: 32,
        clientY: 48,
        pointerType,
      });
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: x - 5,
        clientY: y - 10,
        pointerType,
      });
      fireEvent.pointerUp(surface, {
        pointerId: 1,
        clientX: x,
        clientY: y,
        pointerType,
        shiftKey: true,
      });
      await slot.findByText("Saved");
      expect(board().elements[0]).toMatchObject({
        type: "arrow",
        points: [[0, 0], end],
      });
    },
  );

  it.each(["Draw (D)", "Arrow (A)"])(
    "ignores clicks and jitter with %s, but accepts a short deliberate stroke",
    async (tool) => {
      const { slot, surface, board, update } = await open();
      fireEvent.click(slot.getByRole("button", { name: tool }));
      fireEvent.pointerDown(surface, {
        button: 0,
        pointerId: 1,
        clientX: 32,
        clientY: 48,
      });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 32, clientY: 48 });
      fireEvent.pointerDown(surface, {
        button: 0,
        pointerId: 2,
        clientX: 32,
        clientY: 48,
      });
      for (let i = 0; i < 8; i++)
        fireEvent.pointerMove(surface, {
          pointerId: 2,
          clientX: 32 + (i % 2),
          clientY: 48 + (i % 2),
        });
      fireEvent.pointerUp(surface, { pointerId: 2, clientX: 33, clientY: 49 });
      expect(update).not.toHaveBeenCalled();
      expect(board().elements).toEqual([]);
      expect(slot.container.querySelectorAll("[data-element]")).toHaveLength(0);
      fireEvent.pointerDown(surface, {
        button: 0,
        pointerId: 3,
        clientX: 32,
        clientY: 48,
      });
      fireEvent.pointerUp(surface, { pointerId: 3, clientX: 36, clientY: 48 });
      await waitFor(() => expect(board().elements).toHaveLength(1));
    },
  );

  it("keeps a pencil loop that returns to its start", async () => {
    const { slot, surface, board } = await open();
    fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 32,
      clientY: 48,
    });
    for (const [clientX, clientY] of [
      [52, 48],
      [52, 68],
      [32, 68],
    ])
      fireEvent.pointerMove(surface, { pointerId: 1, clientX, clientY });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 32, clientY: 48 });
    await slot.findByText("Saved");
    expect(board().elements).toHaveLength(1);
    const saved = board().elements[0]!;
    expect(saved.type).toBe("draw");
    if (saved.type === "draw") expect(saved.points.at(-1)).toEqual([0, 0]);
  });

  it("shows Graphite in the theme's ink on the board and keeps sticky ink as saved", async () => {
    const sticky: CanvasElement = {
      id: "graphite-note",
      type: "sticky",
      x: 300,
      y: 0,
      width: 180,
      height: 180,
      text: "Note",
      color: "#242424",
      background: STICKY_BACKGROUND,
      fontSize: 24,
    };
    const { slot } = await open([
      stroke,
      { ...note, id: "graphite-text", color: "#242424" },
      note,
      sticky,
    ]);
    const ink = (selector: string, attribute: string) =>
      slot.container.querySelector(selector)!.getAttribute(attribute);
    expect(ink('[data-element="stroke"] path:last-child', "stroke")).toBe(
      "var(--cv-graphite)",
    );
    expect(ink('[data-element="graphite-text"] text', "fill")).toBe(
      "var(--cv-graphite)",
    );
    expect(ink('[data-element="annotation"] text', "fill")).toBe("#e5484d");
    expect(ink('[data-element="graphite-note"] text', "fill")).toBe("#242424");
    fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
    expect(
      slot
        .getByRole("button", { name: "Graphite" })
        .style.getPropertyValue("--swatch"),
    ).toBe("var(--cv-graphite)");
  });

  it("creates a square sticky note over an image with automatic text sizing and inline color", async () => {
    const { slot, board } = await open([picture]);
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "s" });
    fireEvent.pointerDown(
      slot.container.querySelector('[data-element="image"]')!,
      {
        button: 0,
        pointerId: 1,
        clientX: 32,
        clientY: 48,
      },
    );
    const editor = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
    expect(
      slot.container
        .querySelector('[data-element-type="sticky"] rect')!
        .getAttribute("fill"),
    ).toBe(STICKY_BACKGROUND);
    fireEvent.change(editor, {
      target: { value: "Explain this\nAdd more space" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Blue" }));
    expect(slot.queryByRole("button", { name: "Large text (48)" })).toBeNull();
    expect(editor.wrap).toBe("soft");
    expectEditingBox(slot.container, 180, 180);
    expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await slot.findByText("Saved");
    expect(board().elements).toEqual([
      picture,
      expect.objectContaining({
        type: "sticky",
        text: "Explain this\nAdd more space",
        color: "#087bdf",
        background: STICKY_BACKGROUND,
        fontSize: 24,
        width: 180,
        height: 180,
      }),
    ]);
    expect(
      slot.container
        .querySelector('[data-element-type="sticky"] rect')!
        .getAttribute("fill"),
    ).toBe(STICKY_BACKGROUND);
    expect(
      slot.container
        .querySelector('[data-element-type="sticky"] tspan')!
        .getAttribute("x"),
    ).toBe("16");
  });

  it.each(["Text (T)", "Sticky note (S)"])(
    "saves the latest %s draft when input and blur share one event batch",
    async (tool) => {
      const { slot, surface, board, update } = await open();
      fireEvent.click(slot.getByRole("button", { name: tool }));
      fireEvent.pointerDown(surface, {
        button: 0,
        clientX: 80,
        clientY: 90,
      });
      const editor = slot.getByLabelText("Canvas text");
      act(() => {
        fireEvent.change(editor, { target: { value: "The final input" } });
        fireEvent.blur(editor, { relatedTarget: document.body });
      });
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      expect(board().elements).toHaveLength(1);
      expect(board().elements[0]).toMatchObject({ text: "The final input" });
      expect(slot.queryByLabelText("Canvas text")).toBeNull();
    },
  );

  it("keeps a compact text draft aligned while it grows, gains explicit lines, and shrinks", async () => {
    const { slot, surface, board, update } = await open();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "t" });
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 32,
      clientY: 48,
    });
    const editor = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
    expect(editor.wrap).toBe("off");
    expect(editor.rows).toBe(1);
    expectEditingBox(slot.container, 52, 31.2);

    const longLine = "A".repeat(100);
    fireEvent.change(editor, { target: { value: longLine } });
    expectEditingBox(slot.container, 1204, 31.2);
    expect(editor.value).toBe(longLine);
    expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(true);
    fireEvent.change(editor, { target: { value: `${longLine}\nx\n` } });
    expectEditingBox(slot.container, 1204, 93.6);
    fireEvent.change(editor, { target: { value: "Hi" } });
    expectEditingBox(slot.container, 28, 31.2);
    expect(update).not.toHaveBeenCalled();
    expect(board().elements).toEqual([]);

    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(board().elements).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Hi",
        width: 28,
        height: expect.closeTo(31.2, 6),
      }),
    ]);
    const saved = board().elements[0]!;
    const frame = slot.container.querySelector(".cv-selection > rect")!;
    expect(Number(frame.getAttribute("width"))).toBeCloseTo(28);
    expect(Number(frame.getAttribute("height"))).toBeCloseTo(31.2);
    fireEvent.doubleClick(
      slot.container.querySelector(`[data-element="${saved.id}"]`)!,
    );
    expectEditingBox(slot.container, 28, 31.2);
    fireEvent.keyDown(slot.getByLabelText("Canvas text"), { key: "Escape" });
    expect(update).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      metaKey: true,
    });
    await waitFor(() => expect(board().elements).toEqual([]));
  });

  it("fits changing sticky text inside one fixed square and restores its readable size when shortened", async () => {
    const { slot, surface, board, update } = await open();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "s" });
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 32,
      clientY: 48,
    });
    const editor = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
    expect(editor.wrap).toBe("soft");
    expectEditingBox(slot.container, 180, 180);
    const originalFont = parseFloat(editor.style.fontSize);
    const text = "More context helps explain this screenshot. ".repeat(12);
    fireEvent.change(editor, { target: { value: text } });
    expectEditingBox(slot.container, 180, 180);
    const fittedFont = parseFloat(editor.style.fontSize);
    expect(fittedFont).toBeGreaterThan(0);
    expect(fittedFont).toBeLessThan(originalFont);
    expect(editor.value).toBe(text);
    expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(true);
    fireEvent.change(editor, { target: { value: "Hi\nThere" } });
    expectEditingBox(slot.container, 180, 180);
    expect(parseFloat(editor.style.fontSize)).toBeCloseTo(originalFont);
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: text } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(board().elements).toEqual([
      expect.objectContaining({
        type: "sticky",
        text,
        width: 180,
        height: 180,
        fontSize: 24,
      }),
    ]);
    expect(slot.queryByRole("alert")).toBeNull();
    const saved = board().elements[0]!;
    const rendered = slot.container.querySelector(
      `[data-element="${saved.id}"] text`,
    )!;
    expect(Number(rendered.getAttribute("font-size")) * 0.75).toBeCloseTo(
      fittedFont,
    );
    expect(rendered.querySelectorAll("tspan").length).toBeGreaterThan(1);
    fireEvent.doubleClick(
      slot.container.querySelector(`[data-element="${saved.id}"]`)!,
    );
    expectEditingBox(slot.container, 180, 180);
    expect(
      parseFloat(
        (slot.getByLabelText("Canvas text") as HTMLTextAreaElement).style
          .fontSize,
      ),
    ).toBeCloseTo(fittedFont);
    fireEvent.keyDown(slot.getByLabelText("Canvas text"), { key: "Escape" });
    expect(board().elements).toEqual([saved]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("only lays out the active sticky while typing on a board with detailed artwork", async () => {
    const untouched = {
      ...sticky,
      id: "untouched-sticky",
      x: 220,
      text: "This saved note should not be laid out on every keystroke. ".repeat(
        40,
      ),
    };
    const drawing: CanvasElement = {
      ...stroke,
      points: Array.from({ length: 6_000 }, (_, index) => [index, index % 7]),
    };
    const fit = vi.spyOn(layout, "layoutSticky");
    const path = vi.spyOn(geometry, "arrowPath");
    const map = vi.spyOn(Array.prototype, "map");
    const drawingMaps = () =>
      map.mock.contexts.filter(
        (value) =>
          Array.isArray(value) &&
          value.length === 6_000 &&
          Array.isArray(value[0]) &&
          value[0][0] === 0 &&
          value[5_999][0] === 5_999,
      );
    const { slot, board, update } = await open([
      picture,
      drawing,
      arrow,
      untouched,
      sticky,
    ]);
    expect(
      fit.mock.calls.some(([element]) => element.id === untouched.id),
    ).toBe(true);
    expect(path).toHaveBeenCalled();
    expect(drawingMaps().length).toBeGreaterThan(0);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="sticky"]')!,
    );
    const editor = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
    const initialFont = parseFloat(editor.style.fontSize);
    fit.mockClear();
    path.mockClear();
    map.mockClear();
    const paragraph =
      "The active note fits its text without rebuilding the board. ";
    const drafts = [
      paragraph.repeat(10),
      paragraph.repeat(20),
      paragraph.repeat(30),
    ];
    for (const text of drafts) {
      fireEvent.change(editor, { target: { value: text } });
      expect(editor.value).toBe(text);
      expectEditingBox(slot.container, 180, 180);
    }
    expect(fit.mock.calls.map(([element]) => element.id)).toEqual(
      drafts.map(() => sticky.id),
    );
    expect(path).not.toHaveBeenCalled();
    expect(drawingMaps()).toHaveLength(0);
    expect(parseFloat(editor.style.fontSize)).toBeLessThan(initialFont);
    expect(update).not.toHaveBeenCalled();
    expect(
      slot.container.querySelector('[data-element="sticky"] text'),
    ).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Blue" }));
    const finalText = `${drafts.at(-1)}Final character: ✓`;
    fireEvent.change(editor, { target: { value: finalText } });
    const fittedFont = parseFloat(editor.style.fontSize);
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const saved = board().elements.find((element) => element.id === sticky.id)!;
    expect(saved).toMatchObject({
      text: finalText,
      color: "#087bdf",
      width: 180,
      height: 180,
    });
    expect(
      board().elements.filter((element) => element.id !== sticky.id),
    ).toEqual([picture, drawing, arrow, untouched]);
    const rendered = slot.container.querySelector(
      '[data-element="sticky"] text',
    )!;
    expect(rendered.getAttribute("fill")).toBe("#087bdf");
    expect(Number(rendered.getAttribute("font-size")) * 0.75).toBeCloseTo(
      fittedFont,
    );

    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="sticky"]')!,
    );
    const reopened = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
    expect(reopened.value).toBe(finalText);
    expect(parseFloat(reopened.style.fontSize)).toBeCloseTo(fittedFont);
    fireEvent.change(reopened, {
      target: { value: "Discard this short draft" },
    });
    expect(parseFloat(reopened.style.fontSize)).toBeGreaterThan(fittedFont);
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(
      board().elements.find((element) => element.id === sticky.id),
    ).toEqual(saved);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([note, sticky])(
    "types in $type without rewriting textarea children and saves the last input on blur",
    async (element) => {
      const { slot, board, update } = await open([element]);
      fireEvent.doubleClick(
        slot.container.querySelector(`[data-element="${element.id}"]`)!,
      );
      const editor = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((records) =>
        mutations.push(...records),
      );
      observer.observe(editor, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      try {
        for (const value of [
          "Fast typing",
          "Fast typing in the middle",
          "Fast typing ✓",
        ]) {
          fireEvent.input(editor, {
            target: { value, selectionStart: 5, selectionEnd: 5 },
          });
          expect(editor.value).toBe(value);
          expect(editor.selectionStart).toBe(5);
          expect(editor.selectionEnd).toBe(5);
          mutations.push(...observer.takeRecords());
        }
        expect(mutations).toEqual([]);
      } finally {
        observer.disconnect();
      }
      fireEvent.blur(editor, { relatedTarget: slot.getByLabelText("Canvas") });
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      expect(board().elements[0]).toMatchObject({
        id: element.id,
        text: "Fast typing ✓",
      });
      fireEvent.doubleClick(
        slot.container.querySelector(`[data-element="${element.id}"]`)!,
      );
      const reopened = slot.getByLabelText(
        "Canvas text",
      ) as HTMLTextAreaElement;
      expect(reopened).not.toBe(editor);
      expect(reopened.value).toBe("Fast typing ✓");
      fireEvent.input(reopened, { target: { value: "Discard this draft" } });
      fireEvent.keyDown(reopened, { key: "Escape" });
      fireEvent.doubleClick(
        slot.container.querySelector(`[data-element="${element.id}"]`)!,
      );
      expect(
        (slot.getByLabelText("Canvas text") as HTMLTextAreaElement).value,
      ).toBe("Fast typing ✓");
      expect(update).toHaveBeenCalledTimes(1);
    },
  );

  it("persists text content bounds independently of zoom and cancels later draft resizing", async () => {
    const element = note;
    const context = {
      font: "24px",
      measureText(text: string) {
        return { width: (text.length * parseFloat(this.font)) / 2 };
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const { slot, board, update } = await open([element]);
    fireEvent.click(slot.getByRole("button", { name: "Zoom in" }));
    expect(slot.container.querySelector(".cv-zoom")!.textContent).toBe("90%");
    fireEvent.doubleClick(
      slot.container.querySelector(`[data-element="${element.id}"]`)!,
    );
    expectEditingBox(slot.container, element.width, element.height);
    const editor = slot.getByLabelText("Canvas text");
    const text = `${"Wide".repeat(30)}\nTail`;
    fireEvent.change(editor, { target: { value: text } });
    fireEvent.click(slot.getByRole("button", { name: "Large text (48)" }));
    const width = 2884,
      height = 124.8;
    expectEditingBox(slot.container, width, height);
    expect(update).not.toHaveBeenCalled();
    expect(board().elements).toEqual([element]);

    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const saved = board().elements[0]!;
    expect(saved).toMatchObject({
      id: element.id,
      type: element.type,
      text,
      fontSize: 48,
      width,
      height: expect.closeTo(height, 6),
    });
    expect(
      slot.container.querySelectorAll(`[data-element="${element.id}"] tspan`),
    ).toHaveLength(2);
    fireEvent.doubleClick(
      slot.container.querySelector(`[data-element="${element.id}"]`)!,
    );
    expectEditingBox(slot.container, width, height);
    const reopened = slot.getByLabelText("Canvas text");
    fireEvent.change(reopened, { target: { value: "Short" } });
    expectEditingBox(slot.container, 124, 62.4);
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(board().elements).toEqual([saved]);
    expect(update).toHaveBeenCalledTimes(1);
    const frame = slot.container.querySelector(".cv-selection > rect")!;
    expect(Number(frame.getAttribute("width"))).toBeCloseTo(width);
    expect(Number(frame.getAttribute("height"))).toBeCloseTo(height);
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      metaKey: true,
    });
    await waitFor(() => expect(board().elements).toEqual([element]));
  });

  it.each([
    { element: note, text: "A".repeat(2000), dimension: "width" },
    { element: note, text: "A\n".repeat(1000), dimension: "height" },
  ])(
    "preserves an oversized $dimension draft until it can be shortened and saved",
    async ({ element, text }) => {
      const { slot, board, update } = await open([element]);
      fireEvent.doubleClick(
        slot.container.querySelector(`[data-element="${element.id}"]`)!,
      );
      const editor = slot.getByLabelText("Canvas text");
      fireEvent.change(editor, { target: { value: text } });
      fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
      expect(slot.getByLabelText("Canvas text")).toHaveProperty("value", text);
      expect(document.activeElement).toBe(editor);
      expect(slot.getByRole("alert").textContent).toContain(
        "This text is too large",
      );
      expect(update).not.toHaveBeenCalled();
      expect(board().elements).toEqual([element]);
      const frame = slot.container.querySelector(".cv-selection > rect")!;
      const width = Number(frame.getAttribute("width"));
      const height = Number(frame.getAttribute("height"));
      fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
      expect(slot.getByLabelText("Canvas text")).toHaveProperty("value", text);
      expectEditingBox(slot.container, width, height);
      expect(
        slot
          .getByRole("button", { name: "Select (V)" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(update).not.toHaveBeenCalled();

      fireEvent.change(editor, { target: { value: "Recovered" } });
      fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      expect(board().elements[0]).toMatchObject({
        id: element.id,
        text: "Recovered",
      });
      expect(slot.queryByLabelText("Canvas text")).toBeNull();
      expect(slot.queryByRole("alert")).toBeNull();
    },
  );

  it("reveals a moved caret in a long line without panning an initial text selection", async () => {
    const { slot, surface, board, update } = await open();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "t" });
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 32,
      clientY: 48,
    });
    const text = "A".repeat(100);
    fireEvent.change(slot.getByLabelText("Canvas text"), {
      target: { value: text },
    });
    fireEvent.keyDown(slot.getByLabelText("Canvas text"), {
      key: "Enter",
      metaKey: true,
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const saved = board().elements[0]!;
    const position = () =>
      slot.container
        .querySelector(".cv-artboard > g")!
        .getAttribute("transform");
    const before = position();
    fireEvent.doubleClick(
      slot.container.querySelector(`[data-element="${saved.id}"]`)!,
    );
    const editor = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(text.length);
    fireEvent.select(editor);
    expect(position()).toBe(before);

    editor.setSelectionRange(0, 0);
    fireEvent.select(editor);
    expect(position()).not.toBe(before);
    expect(parseFloat(editor.style.left)).toBeCloseTo(21);
    expectEditingBox(slot.container, 1204, 31.2);
    editor.setSelectionRange(text.length, text.length);
    fireEvent.select(editor);
    expect(parseFloat(editor.style.left) + 1204 * 0.75).toBeCloseTo(376);
    expect(board().elements).toEqual([saved]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([note, sticky])(
    "edits $type after a double-click retargeted to the captured surface",
    async (element) => {
      const { slot, surface, board } = await open([element]);
      const target = slot.container.querySelector(
        `[data-element="${element.id}"]`,
      )!;
      vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
      fireEvent.doubleClick(surface, { clientX: 50, clientY: 60 });
      const editor = slot.getByLabelText("Canvas text");
      fireEvent.change(editor, { target: { value: "Changed after creation" } });
      fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
      await slot.findByText("Saved");
      expect(board().elements).toHaveLength(1);
      expect(board().elements[0]).toMatchObject({
        id: element.id,
        type: element.type,
        text: "Changed after creation",
      });
      if (element.type === "sticky")
        expect(board().elements[0]).toMatchObject({
          background: STICKY_BACKGROUND,
        });
      fireEvent.keyDown(slot.getByLabelText("Canvas"), {
        key: "z",
        metaKey: true,
      });
      await waitFor(() => expect(board().elements).toEqual([element]));
    },
  );

  it("does not edit a selection when double-clicking blank space, a resize handle, or another panel", async () => {
    const { slot, surface } = await open([sticky]);
    select(surface, slot.container.querySelector('[data-element="sticky"]')!);
    const hit = vi.spyOn(document, "elementFromPoint");
    const outside = document.createElement("div");
    outside.dataset.element = sticky.id;
    for (const target of [
      surface,
      slot.container.querySelector('[data-corner="se"]')!,
      outside,
    ]) {
      hit.mockReturnValue(target);
      fireEvent.doubleClick(surface, { clientX: 50, clientY: 60 });
      expect(slot.queryByLabelText("Canvas text")).toBeNull();
    }
  });

  it("resizes a sticky as a square with proportional text and padding, then preserves it when reopened", async () => {
    const { slot, surface, board } = await open([
      { ...sticky, text: "Short note" },
    ]);
    const renderedFont = Number(
      slot.container
        .querySelector('[data-element="sticky"] text')!
        .getAttribute("font-size"),
    );
    select(surface, slot.container.querySelector('[data-element="sticky"]')!);
    fireEvent.pointerDown(slot.container.querySelector('[data-corner="se"]')!, {
      button: 0,
      pointerId: 2,
      clientX: 167,
      clientY: 183,
    });
    fireEvent.pointerMove(surface, {
      pointerId: 2,
      clientX: 99.5,
      clientY: 115.5,
    });
    fireEvent.pointerUp(surface, {
      pointerId: 2,
      clientX: 99.5,
      clientY: 115.5,
    });
    await slot.findByText("Saved");
    expect(board().elements[0]).toMatchObject({
      width: 90,
      height: 90,
      fontSize: 12,
    });
    expect(
      Number(
        slot.container
          .querySelector('[data-element="sticky"] text')!
          .getAttribute("font-size"),
      ),
    ).toBeCloseTo(renderedFont / 2);
    expect(
      Number(
        slot.container
          .querySelector('[data-element="sticky"] tspan')!
          .getAttribute("x"),
      ),
    ).toBeCloseTo(8);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="sticky"]')!,
    );
    expectEditingBox(slot.container, 90, 90);
    const editor = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
    expect(parseFloat(editor.style.padding)).toBeCloseTo(6);
    expect(parseFloat(editor.style.fontSize)).toBeCloseTo(
      (renderedFont / 2) * 0.75,
    );
    fireEvent.keyDown(slot.getByLabelText("Canvas text"), {
      key: "Enter",
      metaKey: true,
    });
    await slot.findByText("Saved");
    expect(board().elements[0]).toMatchObject({
      width: 90,
      height: 90,
      fontSize: 12,
    });
  });

  it("converts an older rectangular sticky to a square only when its edit is saved", async () => {
    const legacy: CanvasElement = { ...sticky, width: 220, height: 160 };
    const { slot, board, update } = await open([legacy]);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="sticky"]')!,
    );
    expectEditingBox(slot.container, 220, 220);
    expect(board().elements).toEqual([legacy]);
    fireEvent.keyDown(slot.getByLabelText("Canvas text"), { key: "Escape" });
    expect(board().elements).toEqual([legacy]);
    expect(update).not.toHaveBeenCalled();
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="sticky"]')!,
    );
    fireEvent.keyDown(slot.getByLabelText("Canvas text"), {
      key: "Enter",
      metaKey: true,
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(board().elements).toEqual([{ ...legacy, width: 220, height: 220 }]);
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      metaKey: true,
    });
    await waitFor(() => expect(board().elements).toEqual([legacy]));
  });

  it("keeps Alt drawing and Space panning out of the text editor on double-click", async () => {
    const { slot, surface } = await open([note]);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "d" });
    fireEvent.doubleClick(surface, { altKey: true, clientX: 50, clientY: 60 });
    expect(slot.queryByLabelText("Canvas text")).toBeNull();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: " ",
      code: "Space",
    });
    fireEvent.doubleClick(surface, { clientX: 50, clientY: 60 });
    expect(slot.queryByLabelText("Canvas text")).toBeNull();
  });

  it("leaves the center of short text available for dragging and double-click editing", async () => {
    const { slot, surface } = await open([
      { ...note, text: "I", width: 24, height: 31.2 },
    ]);
    const target = slot.container.querySelector('[data-element="annotation"]')!;
    select(surface, target);
    const center = { x: 12, y: 15.6 };
    const handles = Array.from(
      slot.container.querySelectorAll(".cv-handle-hit"),
    );
    expect(handles).toHaveLength(4);
    for (const handle of handles) {
      const x = Number(handle.getAttribute("x")),
        y = Number(handle.getAttribute("y"));
      const width = Number(handle.getAttribute("width")),
        height = Number(handle.getAttribute("height"));
      expect(
        center.x >= x &&
          center.x <= x + width &&
          center.y >= y &&
          center.y <= y + height,
      ).toBe(false);
    }
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
    fireEvent.doubleClick(surface, { clientX: 41, clientY: 59.7 });
    expect(slot.getByLabelText("Canvas text")).toHaveProperty("value", "I");
  });

  it("copies arrows and sticky notes with their styles and cancels arrow previews", async () => {
    const { slot, surface, board } = await open([arrow, sticky]);
    const root = slot.getByLabelText("Canvas");
    fireEvent.keyDown(root, { key: "a", ctrlKey: true });
    const data = clipboardData();
    fireEvent.copy(root, { clipboardData: data });
    fireEvent.paste(root, { clipboardData: data });
    await waitFor(() => expect(board().elements).toHaveLength(4));
    expect(board().elements.slice(2)).toEqual(
      [arrow, sticky].map((element) => ({
        ...element,
        id: expect.any(String),
        x: element.x + 24,
        y: element.y + 24,
      })),
    );
    fireEvent.keyDown(root, { key: "z", metaKey: true });
    await waitFor(() => expect(board().elements).toEqual([arrow, sticky]));
    fireEvent.keyDown(root, { key: "a" });
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 500,
      clientY: 500,
    });
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      clientX: 600,
      clientY: 500,
    });
    fireEvent.keyDown(root, { key: "Escape" });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 600, clientY: 500 });
    expect(board().elements).toEqual([arrow, sticky]);
  });
  it.each(
    [note, stroke, arrow, sticky].flatMap((element) =>
      ["Draw (D)", "Text (T)"].map((tool) => ({ element, tool })),
    ),
  )(
    "moves $element.type while $tool stays active, then undoes the move",
    async ({ element, tool }) => {
      const { slot, surface, board } = await open([element]);
      fireEvent.click(slot.getByRole("button", { name: tool }));
      fireEvent.pointerDown(
        slot.container.querySelector(`[data-element="${element.id}"]`)!,
        {
          button: 0,
          pointerId: 1,
          clientX: 40,
          clientY: 56,
        },
      );
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 115,
        clientY: 86,
      });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
      await slot.findByText("Saved");
      expect(board().elements).toEqual([
        { ...element, x: element.x + 100, y: element.y + 40 },
      ]);
      expect(
        slot.getByRole("button", { name: tool }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(slot.container.querySelector(".cv-selection")).toBeTruthy();
      expect(slot.queryByLabelText("Canvas text")).toBeNull();
      fireEvent.keyDown(slot.getByLabelText("Canvas"), {
        key: "z",
        metaKey: true,
      });
      await slot.findByText("Saved");
      expect(board().elements).toEqual([element]);
    },
  );

  it.each([false, true])(
    "selects without saving a no-op drag (move sample: %s)",
    async (moveSample) => {
      const { slot, surface, update } = await open([
        { ...note, x: 0.1, y: 1 / 3 },
      ]);
      fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
      fireEvent.pointerDown(
        slot.container.querySelector('[data-element="annotation"]')!,
        {
          button: 0,
          pointerId: 1,
          clientX: 40,
          clientY: 56,
        },
      );
      if (moveSample)
        fireEvent.pointerMove(surface, {
          pointerId: 1,
          clientX: 40,
          clientY: 56,
        });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40, clientY: 56 });
      expect(update).not.toHaveBeenCalled();
      expect(
        (slot.getByRole("button", { name: "Undo (⌘Z)" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(slot.container.querySelector('[data-corner="se"]')).toBeTruthy();
    },
  );

  it("shows text presets for selected text while Draw stays active", async () => {
    const { slot, surface, board } = await open([note]);
    fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    expect(slot.queryByRole("group", { name: "Stroke width" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Large text (48)" }));
    fireEvent.click(slot.getByRole("button", { name: "Blue" }));
    await slot.findByText("Saved");
    expect(board().elements[0]).toMatchObject({
      type: "text",
      fontSize: 48,
      color: "#087bdf",
    });
    expect(
      slot
        .getByRole("button", { name: "Draw (D)" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(slot.container.querySelectorAll(".cv-swatch")).toHaveLength(6);
    expect(slot.container.querySelectorAll(".cv-size-button")).toHaveLength(3);
    expect(slot.queryByRole("combobox")).toBeNull();
  });

  it.each(["mouse", "pen", "Alt", "touch"])(
    "draws over an image with %s while preserving the image",
    async (input) => {
      const { slot, surface, board } = await open([picture]);
      fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
      fireEvent.click(slot.getByRole("button", { name: "Thick stroke (8)" }));
      const modifiers = {
        altKey: input === "Alt",
        pointerType: input === "Alt" ? "mouse" : input,
      };
      fireEvent.pointerDown(
        slot.container.querySelector('[data-element="image"]')!,
        {
          button: 0,
          pointerId: 1,
          clientX: 40,
          clientY: 56,
          ...modifiers,
        },
      );
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 115,
        clientY: 86,
        ...modifiers,
      });
      fireEvent.pointerUp(surface, {
        pointerId: 1,
        clientX: 115,
        clientY: 86,
        ...modifiers,
      });
      await slot.findByText("Saved");
      expect(board().elements).toHaveLength(2);
      expect(board().elements[0]).toEqual(picture);
      expect(board().elements[1]).toMatchObject({
        type: "draw",
        strokeWidth: 8,
      });
    },
  );

  it.each(["mouse", "pen", "Alt", "touch"])(
    "writes over an image with %s and styles its draft inline",
    async (input) => {
      const { slot, surface, board } = await open([picture]);
      fireEvent.click(slot.getByRole("button", { name: "Text (T)" }));
      fireEvent.pointerDown(
        slot.container.querySelector('[data-element="image"]')!,
        {
          button: 0,
          pointerId: 1,
          clientX: 40,
          clientY: 56,
          altKey: input === "Alt",
          pointerType: input === "Alt" ? "mouse" : input,
        },
      );
      const editor = slot.getByLabelText("Canvas text");
      fireEvent.change(editor, {
        target: { value: "Feedback over screenshot" },
      });
      fireEvent.click(slot.getByRole("button", { name: "Large text (48)" }));
      fireEvent.click(slot.getByRole("button", { name: "Blue" }));
      expect(document.activeElement).toBe(editor);
      fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
      await slot.findByText("Saved");
      expect(board().elements).toHaveLength(2);
      expect(board().elements[0]).toEqual(picture);
      expect(board().elements[1]).toMatchObject({
        type: "text",
        text: "Feedback over screenshot",
        fontSize: 48,
        color: "#087bdf",
      });
    },
  );

  it("applies draft formatting only when the text edit is finished", async () => {
    const { slot, board, update } = await open([note]);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    const editor = slot.getByLabelText("Canvas text");
    fireEvent.change(editor, { target: { value: "Edited draft" } });
    fireEvent.click(slot.getByRole("button", { name: "Large text (48)" }));
    fireEvent.click(slot.getByRole("button", { name: "Blue" }));
    expect(update).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(board().elements).toEqual([note]);
  });

  it("keeps Draw defaults separate from a previously selected text annotation", async () => {
    const { slot, surface, update } = await open([note]);
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
    expect(
      slot
        .getByRole("button", { name: "Medium stroke (3)" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Blue" }));
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps Shift selection and grouped movement available in Draw", async () => {
    const { slot, surface, board } = await open([stroke, note]);
    fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
    select(surface, slot.container.querySelector('[data-element="stroke"]')!);
    const target = slot.container.querySelector('[data-element="annotation"]')!;
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      clientX: 40,
      clientY: 56,
      shiftKey: true,
    });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40, clientY: 56 });
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      clientX: 40,
      clientY: 56,
    });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    await slot.findByText("Saved");
    expect(board().elements).toEqual(
      [stroke, note].map((element) => ({
        ...element,
        x: element.x + 100,
        y: element.y + 40,
      })),
    );
  });

  it("uses Alt to draw even over a selected text annotation's resize handle", async () => {
    const { slot, surface, board } = await open([note]);
    fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    fireEvent.pointerDown(slot.container.querySelector('[data-corner="se"]')!, {
      button: 0,
      pointerId: 1,
      clientX: 182,
      clientY: 123,
      altKey: true,
    });
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      clientX: 257,
      clientY: 163,
    });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 257, clientY: 163 });
    await slot.findByText("Saved");
    expect(board().elements).toHaveLength(2);
    expect(board().elements[0]).toEqual(note);
    expect(board().elements[1]!.type).toBe("draw");
  });

  it.each(["Draw (D)", "Text (T)"])(
    "leaves images stationary when dragging a mixed selection with %s",
    async (tool) => {
      const { slot, surface, board } = await open([picture, note, stroke]);
      fireEvent.click(slot.getByRole("button", { name: tool }));
      fireEvent.keyDown(slot.getByLabelText("Canvas"), {
        key: "a",
        metaKey: true,
      });
      expect(slot.container.querySelectorAll(".cv-selection")).toHaveLength(3);
      fireEvent.pointerDown(
        slot.container.querySelector('[data-element="annotation"]')!,
        {
          button: 0,
          pointerId: 1,
          clientX: 40,
          clientY: 56,
        },
      );
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 115,
        clientY: 86,
      });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
      await slot.findByText("Saved");
      expect(board().elements).toEqual([
        picture,
        ...[note, stroke].map((element) => ({
          ...element,
          x: element.x + 100,
          y: element.y + 40,
        })),
      ]);
      expect(slot.container.querySelectorAll(".cv-selection")).toHaveLength(2);
      expect(
        slot.getByRole("button", { name: tool }).getAttribute("aria-pressed"),
      ).toBe("true");
    },
  );

  it.each(["Draw (D)", "Text (T)"])(
    "hides selected image handles in %s and restores them in Select",
    async (tool) => {
      const { slot, surface, board } = await open([picture]);
      fireEvent.click(slot.getByRole("button", { name: tool }));
      fireEvent.keyDown(slot.getByLabelText("Canvas"), {
        key: "a",
        ctrlKey: true,
      });
      expect(slot.container.querySelector(".cv-selection")).toBeTruthy();
      expect(slot.container.querySelector("[data-corner]")).toBeNull();
      fireEvent.click(slot.getByRole("button", { name: "Select (V)" }));
      const handle = slot.container.querySelector('[data-corner="se"]')!;
      expect(handle).toBeTruthy();
      fireEvent.pointerDown(handle, {
        button: 0,
        pointerId: 1,
        clientX: 182,
        clientY: 123,
      });
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 332,
        clientY: 198,
      });
      fireEvent.pointerUp(surface, {
        pointerId: 1,
        clientX: 332,
        clientY: 198,
      });
      await slot.findByText("Saved");
      expect(board().elements[0]).toMatchObject({
        type: "image",
        x: 0,
        y: 0,
        width: 400,
        height: 200,
      });
    },
  );

  it.each(["Space", "middle"])(
    "pans with %s over an image while Draw is active",
    async (input) => {
      const { slot, surface, board, update } = await open([picture]);
      fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
      const transform = () =>
        slot.container
          .querySelector(".cv-artboard > g")!
          .getAttribute("transform");
      const before = transform();
      if (input === "Space")
        fireEvent.keyDown(slot.getByLabelText("Canvas"), {
          key: " ",
          code: "Space",
        });
      fireEvent.pointerDown(
        slot.container.querySelector('[data-element="image"]')!,
        {
          button: input === "middle" ? 1 : 0,
          pointerId: 1,
          clientX: 40,
          clientY: 56,
        },
      );
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 115,
        clientY: 86,
      });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
      expect(transform()).not.toBe(before);
      expect(board().elements).toEqual([picture]);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("keeps text cancellation and history safe when keyboard focus enters a preset", async () => {
    const { slot, surface, board, update } = await open([note]);
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    fireEvent.click(slot.getByRole("button", { name: "Blue" }));
    await slot.findByText("Saved");
    update.mockClear();
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    const editor = slot.getByLabelText("Canvas text");
    fireEvent.change(editor, { target: { value: "Unfinished draft" } });
    const preset = slot.getByRole("button", { name: "Large text (48)" });
    act(() => preset.focus());
    fireEvent.keyDown(preset, { key: "z", metaKey: true });
    expect(document.activeElement).toBe(editor);
    act(() => preset.focus());
    fireEvent.keyDown(preset, { key: "Delete" });
    expect(document.activeElement).toBe(editor);
    act(() => preset.focus());
    fireEvent.keyDown(preset, { key: "Escape" });
    expect(slot.queryByLabelText("Canvas text")).toBeNull();
    expect(board().elements).toEqual([{ ...note, color: "#087bdf" }]);
    expect(update).not.toHaveBeenCalled();
  });

  it("offers text size after switching from a selected drawing with the keyboard", async () => {
    const { slot, surface } = await open([stroke]);
    select(surface, slot.container.querySelector('[data-element="stroke"]')!);
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "t" });
    expect(slot.getByLabelText("Text size")).toBeTruthy();
    expect(slot.queryByLabelText("Stroke width")).toBeNull();
  });

  it("handles image paste only inside Canvas and leaves text editing paste alone", async () => {
    const { slot, surface, upload } = await open();
    const file = new File(["png"], "Screenshot.png", { type: "image/png" });
    const clipboardData = {
      getData: () => "",
      items: [{ type: "image/png", getAsFile: () => file }],
    };
    const elsewhere = document.createElement("textarea");
    document.body.append(elsewhere);
    fireEvent.paste(elsewhere, { clipboardData });
    expect(upload).not.toHaveBeenCalled();
    elsewhere.remove();
    fireEvent.click(slot.getByRole("button", { name: "Text (T)" }));
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 80,
      clientY: 90,
    });
    fireEvent.paste(slot.getByLabelText("Canvas text"), { clipboardData });
    expect(upload).not.toHaveBeenCalled();
    fireEvent.keyDown(slot.getByLabelText("Canvas text"), { key: "Escape" });
    fireEvent.paste(slot.getByLabelText("Canvas"), { clipboardData });
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    await slot.findByText("Saved");
  });

  it.each(["ctrlKey", "metaKey"])(
    "copies mixed selections, pastes distinct groups, and undoes with %s",
    async (modifier) => {
      const original = [picture, note, stroke];
      const { slot, board, upload, update } = await open(original);
      const root = slot.getByLabelText("Canvas");
      const data = clipboardData();
      fireEvent.keyDown(root, { key: "a", [modifier]: true });
      expect(fireEvent.copy(root, { clipboardData: data })).toBe(false);
      expect(decodeClipboard(data.getData("text/plain"))!.elements).toEqual(
        original,
      );
      expect(data.getData(CANVAS_CLIPBOARD_TYPE)).toBe(
        data.getData("text/plain"),
      );

      fireEvent.paste(root, { clipboardData: data });
      fireEvent.paste(root, { clipboardData: data });
      await waitFor(() => expect(board().elements).toHaveLength(9));
      for (let group = 1; group <= 2; group++) {
        const copies = board().elements.slice(group * 3, group * 3 + 3);
        copies.forEach((element, index) => {
          const source = original[index]!;
          expect(element).toEqual({
            ...source,
            id: expect.any(String),
            x: source.x + group * 24,
            y: source.y + group * 24,
          });
        });
      }
      expect(new Set(board().elements.map((element) => element.id)).size).toBe(
        9,
      );
      expect(slot.container.querySelectorAll(".cv-selection")).toHaveLength(3);
      expect(upload).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(root, { key: "z", [modifier]: true });
      await waitFor(() => expect(board().elements).toHaveLength(6));
      fireEvent.keyDown(root, { key: "z", [modifier]: true });
      await waitFor(() => expect(board().elements).toEqual(original));
      fireEvent.keyDown(root, { key: "z", shiftKey: true, [modifier]: true });
      await waitFor(() => expect(board().elements).toHaveLength(6));
    },
  );

  it("copies only selected elements and pastes their snapshot after the originals change", async () => {
    const { slot, surface, board } = await open([note, stroke]);
    const root = slot.getByLabelText("Canvas");
    const data = clipboardData();
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    fireEvent.copy(root, { clipboardData: data });
    fireEvent.click(slot.getByRole("button", { name: "Blue" }));
    await slot.findByText("Saved");
    // A browser may retain only the text/plain clipboard representation.
    data.setData(CANVAS_CLIPBOARD_TYPE, "");
    fireEvent.paste(root, { clipboardData: data });
    await waitFor(() => expect(board().elements).toHaveLength(3));
    expect(board().elements[0]).toMatchObject({ color: "#087bdf" });
    expect(board().elements[2]).toEqual({
      ...note,
      id: expect.any(String),
      x: 24,
      y: 24,
    });
  });

  it("does not reuse an old element copy after external text or an image replaces the clipboard", async () => {
    const { slot, surface, board, upload } = await open([note]);
    const root = slot.getByLabelText("Canvas");
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    fireEvent.copy(root, { clipboardData: clipboardData() });
    const external = clipboardData();
    external.setData("text/plain", "Ordinary copied text");
    expect(fireEvent.paste(root, { clipboardData: external })).toBe(true);
    expect(board().elements).toEqual([note]);
    const file = new File(["png"], "Fresh screenshot.png", {
      type: "image/png",
    });
    external.items.push({ type: "image/png", getAsFile: () => file });
    fireEvent.paste(root, { clipboardData: external });
    await waitFor(() => expect(board().elements).toHaveLength(2));
    expect(upload).toHaveBeenCalledOnce();
    expect(board().elements[1]).toMatchObject({
      type: "image",
      name: file.name,
    });
  });

  it("leaves native text editing, outside clipboard events, and an empty selection to the browser", async () => {
    const { slot, board, update, threadId } = await open([note]);
    const root = slot.getByLabelText("Canvas"),
      data = clipboardData();
    data.setData("text/plain", encodeClipboard(threadId, [picture]));
    const before = data.getData("text/plain");
    expect(fireEvent.copy(root, { clipboardData: data })).toBe(true);
    expect(fireEvent.cut(root, { clipboardData: data })).toBe(true);
    const outside = document.createElement("textarea");
    document.body.append(outside);
    expect(fireEvent.copy(outside, { clipboardData: data })).toBe(true);
    expect(fireEvent.cut(outside, { clipboardData: data })).toBe(true);
    outside.remove();
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    const editor = slot.getByLabelText("Canvas text");
    expect(fireEvent.copy(editor, { clipboardData: data })).toBe(true);
    expect(fireEvent.cut(editor, { clipboardData: data })).toBe(true);
    expect(fireEvent.paste(editor, { clipboardData: data })).toBe(true);
    const preset = slot.getByRole("button", { name: "Blue" });
    expect(fireEvent.copy(preset, { clipboardData: data })).toBe(true);
    expect(fireEvent.cut(preset, { clipboardData: data })).toBe(true);
    expect(fireEvent.paste(preset, { clipboardData: data })).toBe(true);
    expect(data.getData("text/plain")).toBe(before);
    expect(board().elements).toEqual([note]);
    expect(update).not.toHaveBeenCalled();
  });

  it("cuts only the selected elements, pastes their full snapshot, and restores their order with Undo", async () => {
    const croppedPicture: CanvasElement = {
      ...picture,
      x: 40,
      y: 20,
      width: 160,
      height: 80,
      crop: { x: 0.2, y: 0.2, width: 0.8, height: 0.8 },
    };
    const original = [note, stroke, croppedPicture];
    const { slot, surface, board, update, upload } = await open(original);
    const root = slot.getByLabelText("Canvas");
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    fireEvent.pointerDown(
      slot.container.querySelector('[data-element="image"]')!,
      {
        button: 0,
        pointerId: 2,
        clientX: 100,
        clientY: 100,
        shiftKey: true,
      },
    );
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 100, clientY: 100 });
    const data = clipboardData();
    expect(fireEvent.cut(root, { clipboardData: data })).toBe(false);
    expect(decodeClipboard(data.getData("text/plain"))!.elements).toEqual([
      note,
      croppedPicture,
    ]);
    expect(data.getData(CANVAS_CLIPBOARD_TYPE)).toBe(
      data.getData("text/plain"),
    );
    await waitFor(() => expect(board().elements).toEqual([stroke]));
    expect(update).toHaveBeenCalledTimes(1);
    expect(slot.container.querySelectorAll(".cv-selection")).toHaveLength(0);

    fireEvent.paste(root, { clipboardData: data });
    await waitFor(() => expect(board().elements).toHaveLength(3));
    expect(board().elements.slice(1)).toEqual(
      [note, croppedPicture].map((element) => ({
        ...element,
        id: expect.any(String),
        x: element.x + 24,
        y: element.y + 24,
      })),
    );
    expect(new Set(board().elements.map((element) => element.id)).size).toBe(3);
    expect(upload).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(root, { key: "z", ctrlKey: true });
    await waitFor(() => expect(board().elements).toEqual([stroke]));
    fireEvent.keyDown(root, { key: "z", metaKey: true });
    await waitFor(() => expect(board().elements).toEqual(original));
  });

  it("keeps a selection intact when writing the cut clipboard fails", async () => {
    const { slot, surface, board, update } = await open([note]);
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    const data = {
      ...clipboardData(),
      setData: vi.fn(() => {
        throw new Error("Clipboard unavailable");
      }),
    };
    fireEvent.cut(slot.getByLabelText("Canvas"), { clipboardData: data });
    expect(board().elements).toEqual([note]);
    expect(update).not.toHaveBeenCalled();
    expect(slot.container.querySelectorAll(".cv-selection")).toHaveLength(1);
    expect(slot.getByRole("alert").textContent).toContain(
      "Clipboard unavailable",
    );
  });

  it("cuts through the plain-text fallback when custom clipboard types are unavailable", async () => {
    const { slot, surface, board } = await open([note]);
    select(
      surface,
      slot.container.querySelector('[data-element="annotation"]')!,
    );
    const data = clipboardData();
    const write = data.setData;
    data.setData = (type, value) => {
      if (type === CANVAS_CLIPBOARD_TYPE) throw new Error("Unsupported type");
      write(type, value);
    };
    const root = slot.getByLabelText("Canvas");
    expect(fireEvent.cut(root, { clipboardData: data })).toBe(false);
    await waitFor(() => expect(board().elements).toEqual([]));
    expect(decodeClipboard(data.getData("text/plain"))!.elements).toEqual([
      note,
    ]);
    fireEvent.paste(root, { clipboardData: data });
    await waitFor(() => expect(board().elements).toHaveLength(1));
    expect(board().elements[0]).toMatchObject({
      text: note.text,
      x: 24,
      y: 24,
    });
  });

  it("cancels an active drag before cutting so its final release cannot restore the element", async () => {
    const { slot, surface, board, update } = await open([note]);
    fireEvent.pointerDown(
      slot.container.querySelector('[data-element="annotation"]')!,
      {
        button: 0,
        pointerId: 1,
        clientX: 40,
        clientY: 56,
      },
    );
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    fireEvent.cut(slot.getByLabelText("Canvas"), {
      clipboardData: clipboardData(),
    });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    await waitFor(() => expect(board().elements).toEqual([]));
    expect(update).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      metaKey: true,
    });
    await waitFor(() => expect(board().elements).toEqual([note]));
  });

  it("imports shared images once per group from another thread and preserves rapid pastes", async () => {
    const { slot, board, upload } = await open();
    upload.mockResolvedValue({ id: "imported-asset", width: 200, height: 100 });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImage = vi.fn(async () => {
      await pending;
      return {
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      };
    });
    vi.stubGlobal("fetch", fetchImage);
    const root = slot.getByLabelText("Canvas"),
      data = clipboardData();
    const copied = [picture, { ...picture, id: "second-image", x: 220 }, note];
    data.setData("text/plain", encodeClipboard("another-thread", copied));
    fireEvent.paste(root, { clipboardData: data });
    fireEvent.paste(root, { clipboardData: data });
    await waitFor(() => expect(fetchImage).toHaveBeenCalledOnce());
    expect(board().elements).toEqual([]);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(board().elements).toHaveLength(6));
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(fetchImage).toHaveBeenCalledWith(
      "/api/v1/plugins/canvas/http/image?threadId=another-thread&id=asset",
    );
    expect(upload).toHaveBeenCalledTimes(2);
    for (const element of board().elements)
      if (element.type === "image")
        expect(element.assetId).toBe("imported-asset");
    expect(board().elements.map(({ x }) => x)).toEqual([
      24, 244, 24, 48, 268, 48,
    ]);
    fireEvent.keyDown(root, { key: "z", ctrlKey: true });
    await waitFor(() => expect(board().elements).toHaveLength(3));
  });

  it("does not paste a partial group when a source image is missing", async () => {
    const { slot, board, update, upload } = await open();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    const data = clipboardData();
    data.setData(
      "text/plain",
      encodeClipboard("another-thread", [note, picture]),
    );
    fireEvent.paste(slot.getByLabelText("Canvas"), { clipboardData: data });
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("no longer available"),
    );
    expect(board().elements).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects malformed Canvas clipboard data without changing the board", async () => {
    const { slot, update } = await open([note]);
    const data = clipboardData();
    data.setData("text/plain", 'bb-canvas-elements:{"version":999}');
    fireEvent.paste(slot.getByLabelText("Canvas"), { clipboardData: data });
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("clipboard data is invalid"),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("explains a paste during loading and accepts it once the board is ready", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const threadId = `review-${++counter}`;
    const board: Board = { version: 1, revision: 0, elements: [] };
    let release!: (board: Board) => void;
    const loading = new Promise<Board>((resolve) => {
      release = resolve;
    });
    const update = vi.fn(({ patch }: { patch: Patch }) => ({
      ...board,
      revision: 1,
      elements: patch.upserts,
    }));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId, params: null },
      {
        rpc: {
          getCanvas: () => loading,
          updateCanvas: (input) => update(input as { patch: Patch }),
        },
      },
    );
    const data = clipboardData();
    data.setData("text/plain", encodeClipboard(threadId, [note]));
    fireEvent.paste(slot.getByLabelText("Canvas"), { clipboardData: data });
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Wait for Canvas to load"),
    );
    expect(update).not.toHaveBeenCalled();
    await act(async () => {
      release(board);
    });
    await slot.findByText("Saved");
    fireEvent.paste(slot.getByLabelText("Canvas"), { clipboardData: data });
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
  });

  it("cancels a drag before paste so pointer release cannot restore it", async () => {
    const { slot, surface, board, threadId } = await open([note]);
    const data = clipboardData();
    data.setData("text/plain", encodeClipboard(threadId, [note]));
    fireEvent.pointerDown(
      slot.container.querySelector('[data-element="annotation"]')!,
      {
        button: 0,
        pointerId: 1,
        clientX: 40,
        clientY: 56,
      },
    );
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    fireEvent.paste(slot.getByLabelText("Canvas"), { clipboardData: data });
    await waitFor(() => expect(board().elements).toHaveLength(2));
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    await slot.findByText("Saved");
    expect(board().elements[0]).toEqual(note);
    expect(board().elements[1]).toMatchObject({ x: 24, y: 24 });
  });

  it("uses the toolbar Paste button for Canvas elements as well as screenshots", async () => {
    const { slot, board, threadId } = await open([note]);
    const value = encodeClipboard(threadId, [note]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn(async () => [
          {
            types: ["text/plain"],
            getType: async () => ({ text: async () => value }),
          },
        ]),
      },
    });
    try {
      fireEvent.click(
        slot.getByRole("button", { name: "Paste (⌘V / Ctrl+V)" }),
      );
      await waitFor(() => expect(board().elements).toHaveLength(2));
      expect(board().elements[1]).toMatchObject({
        ...note,
        id: expect.any(String),
        x: 24,
        y: 24,
      });
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("saves a Shift-constrained stroke in world coordinates", async () => {
    const { slot, surface, board } = await open();
    fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 32,
      clientY: 48,
    });
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      clientX: 107,
      clientY: 63,
      shiftKey: true,
    });
    fireEvent.pointerUp(surface, {
      button: 0,
      pointerId: 1,
      clientX: 107,
      clientY: 63,
      shiftKey: true,
    });
    await waitFor(() => expect(board().elements).toHaveLength(1));
    expect(board().elements[0]).toMatchObject({
      type: "draw",
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [100, 0],
      ],
    });
  });

  it("keeps a second finger from replacing a drawing already in progress", async () => {
    const { slot, surface, board } = await open();
    fireEvent.click(slot.getByRole("button", { name: "Draw (D)" }));
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 48,
    });
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 2,
      pointerType: "touch",
      clientX: 182,
      clientY: 198,
    });
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 107,
      clientY: 48,
    });
    fireEvent.pointerUp(surface, {
      button: 0,
      pointerId: 1,
      pointerType: "touch",
      clientX: 107,
      clientY: 48,
    });
    await waitFor(() => expect(board().elements).toHaveLength(1));
    expect(board().elements[0]).toMatchObject({
      type: "draw",
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [100, 0],
      ],
    });
  });

  it("moves and proportionally resizes an image with Select in canvas units", async () => {
    const image: CanvasElement = {
      id: "image",
      type: "image",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      assetId: "asset",
      name: "Screenshot",
    };
    const { slot, surface, board } = await open([image]);
    fireEvent.click(slot.getByRole("button", { name: "Select (V)" }));
    const target = slot.container.querySelector('[data-element="image"]')!;
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      clientX: 40,
      clientY: 56,
    });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    await waitFor(() =>
      expect(board().elements[0]).toMatchObject({ x: 100, y: 40 }),
    );
    const handle = slot.container.querySelector('[data-corner="se"]')!;
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 257,
      clientY: 153,
    });
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      clientX: 407,
      clientY: 228,
    });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 407, clientY: 228 });
    await waitFor(() =>
      expect(board().elements[0]).toMatchObject({
        x: 100,
        y: 40,
        width: 400,
        height: 200,
      }),
    );
  });

  it("applies the final crop once when clicking blank canvas, clears selection, and undoes it", async () => {
    const { slot, surface, board, update } = await open([picture]);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      slot.container.querySelector('[data-element="image"]')!,
    );
    fireEvent.doubleClick(surface, { clientX: 100, clientY: 80 });
    const crop = slot.getByRole("group", { name: "Crop image" });
    expect(crop.querySelectorAll("[data-crop-handle]")).toHaveLength(8);
    expect(crop.querySelector("button")).toBeNull();
    expect(slot.queryByRole("button", { name: "Apply crop" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Cancel crop" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Reset crop" })).toBeNull();
    fireEvent.pointerDown(crop.querySelector('[data-crop-handle="nw"]')!, {
      button: 0,
      pointerId: 3,
      clientX: 32,
      clientY: 48,
    });
    fireEvent.pointerMove(crop, { pointerId: 3, clientX: 47, clientY: 55.5 });
    fireEvent.pointerUp(crop, { pointerId: 3, clientX: 62, clientY: 63 });
    const frame = crop.querySelector("[data-crop-frame]")!;
    expect(
      ["x", "y", "width", "height"].map((key) =>
        Number(frame.getAttribute(key)),
      ),
    ).toEqual([40, 20, 160, 80]);
    expect(board().elements).toEqual([picture]);
    expect(update).not.toHaveBeenCalled();
    const ignoredClipboard = clipboardData();
    fireEvent.cut(slot.getByLabelText("Canvas"), {
      clipboardData: ignoredClipboard,
    });
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "Delete" });
    expect(ignoredClipboard.getData("text/plain")).toBe("");
    expect(board().elements).toEqual([picture]);
    expect(update).not.toHaveBeenCalled();
    fireEvent.pointerDown(crop.querySelector(".cv-crop-overlay > rect")!, {
      button: 0,
      pointerId: 4,
      clientX: 250,
      clientY: 200,
    });
    fireEvent.pointerUp(surface, { pointerId: 4, clientX: 250, clientY: 200 });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(board().elements).toEqual([
      {
        ...picture,
        x: 40,
        y: 20,
        width: 160,
        height: 80,
        crop: { x: 0.2, y: 0.2, width: 0.8, height: 0.8 },
      },
    ]);
    expect(slot.queryByRole("group", { name: "Crop image" })).toBeNull();
    expect(slot.container.querySelector(".cv-selection")).toBeNull();
    expect(slot.queryByRole("button", { name: "Delete selection" })).toBeNull();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      metaKey: true,
    });
    await waitFor(() => expect(board().elements).toEqual([picture]));
  });

  it("applies the latest crop when release and outside click share one event batch", async () => {
    const { slot, board, update } = await open([picture]);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="image"]')!,
    );
    const crop = slot.getByRole("group", { name: "Crop image" });
    fireEvent.pointerDown(crop.querySelector('[data-crop-handle="nw"]')!, {
      button: 0,
      pointerId: 3,
      clientX: 32,
      clientY: 48,
    });
    act(() => {
      fireEvent.pointerUp(crop, { pointerId: 3, clientX: 62, clientY: 63 });
      fireEvent.pointerDown(crop.querySelector(".cv-crop-overlay > rect")!, {
        button: 0,
        pointerId: 4,
        clientX: 250,
        clientY: 200,
      });
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(board().elements).toEqual([
      {
        ...picture,
        x: 40,
        y: 20,
        width: 160,
        height: 80,
        crop: { x: 0.2, y: 0.2, width: 0.8, height: 0.8 },
      },
    ]);
    expect(slot.queryByRole("group", { name: "Crop image" })).toBeNull();
    expect(slot.container.querySelector(".cv-selection")).toBeNull();
  });

  it("keeps a tiny crop's center available for moving between its resize handles", async () => {
    const croppedPicture: CanvasElement = {
      ...picture,
      x: 100,
      y: 50,
      width: 1,
      height: 1,
      crop: { x: 0.5, y: 0.5, width: 0.005, height: 0.01 },
    };
    const { slot } = await open([croppedPicture]);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="image"]')!,
    );
    const crop = slot.getByRole("group", { name: "Crop image" });
    const handles = crop.querySelectorAll(
      "[data-crop-handle] > rect:first-child",
    );
    expect(handles).toHaveLength(8);
    const center = { x: 100.5, y: 50.5 };
    for (const handle of handles) {
      const x = Number(handle.getAttribute("x")),
        y = Number(handle.getAttribute("y"));
      const width = Number(handle.getAttribute("width")),
        height = Number(handle.getAttribute("height"));
      expect(
        center.x >= x &&
          center.x <= x + width &&
          center.y >= y &&
          center.y <= y + height,
      ).toBe(false);
    }
  });

  it("restores the full source by expanding crop handles and pressing Enter without reuploading", async () => {
    const croppedPicture: CanvasElement = {
      ...picture,
      x: 40,
      y: 20,
      width: 160,
      height: 80,
      crop: { x: 0.2, y: 0.2, width: 0.8, height: 0.8 },
    };
    const { slot, board, update, upload } = await open([croppedPicture]);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="image"]')!,
    );
    const crop = slot.getByRole("group", { name: "Crop image" });
    const source = crop.querySelector("image")!;
    expect(
      ["x", "y", "width", "height"].map((key) =>
        Number(source.getAttribute(key)),
      ),
    ).toEqual([0, 0, 200, 100]);
    fireEvent.pointerDown(crop.querySelector('[data-crop-handle="nw"]')!, {
      button: 0,
      pointerId: 3,
      clientX: 62,
      clientY: 63,
    });
    fireEvent.pointerUp(crop, { pointerId: 3, clientX: 32, clientY: 48 });
    const frame = crop.querySelector("[data-crop-frame]")!;
    expect(
      ["x", "y", "width", "height"].map((key) =>
        Number(frame.getAttribute(key)),
      ),
    ).toEqual([0, 0, 200, 100]);
    expect(update).not.toHaveBeenCalled();
    expect(board().elements).toEqual([croppedPicture]);
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "Enter" });
    await waitFor(() => expect(board().elements).toEqual([picture]));
    expect(update).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      ctrlKey: true,
    });
    await waitFor(() => expect(board().elements).toEqual([croppedPicture]));
  });

  it("saves a draft crop before switching tools from a focused toolbar button", async () => {
    const { slot, board, update } = await open([picture]);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="image"]')!,
    );
    const crop = slot.getByRole("group", { name: "Crop image" });
    fireEvent.pointerDown(crop.querySelector('[data-crop-handle="nw"]')!, {
      button: 0,
      pointerId: 3,
      clientX: 32,
      clientY: 48,
    });
    fireEvent.pointerUp(crop, { pointerId: 3, clientX: 62, clientY: 63 });
    const draw = slot.getByRole("button", { name: "Draw (D)" });
    act(() => draw.focus());
    expect(fireEvent.keyDown(draw, { key: "Enter", code: "Enter" })).toBe(true);
    expect(slot.getByRole("group", { name: "Crop image" })).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    // jsdom does not dispatch a button's native click after an Enter key.
    fireEvent.click(draw);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(board().elements).toEqual([
      {
        ...picture,
        x: 40,
        y: 20,
        width: 160,
        height: 80,
        crop: { x: 0.2, y: 0.2, width: 0.8, height: 0.8 },
      },
    ]);
    expect(draw.getAttribute("aria-pressed")).toBe("true");
    expect(slot.queryByRole("group", { name: "Crop image" })).toBeNull();
    expect(slot.container.querySelector(".cv-selection")).toBeNull();
  });

  it("does not apply a crop while dragging or releasing its handle outside the image", async () => {
    const { slot, board, update } = await open([picture]);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="image"]')!,
    );
    const crop = slot.getByRole("group", { name: "Crop image" });
    fireEvent.pointerDown(crop.querySelector('[data-crop-handle="nw"]')!, {
      button: 0,
      pointerId: 3,
      clientX: 32,
      clientY: 48,
    });
    fireEvent.pointerMove(crop, { pointerId: 3, clientX: 62, clientY: 63 });
    fireEvent.pointerDown(document.body, {
      button: 0,
      pointerId: 4,
      clientX: 1_000,
      clientY: 1_000,
    });
    expect(slot.getByRole("group", { name: "Crop image" })).toBe(crop);
    expect(update).not.toHaveBeenCalled();
    // Pointer capture keeps the release on the crop layer outside its bounds.
    fireEvent.pointerUp(crop, {
      pointerId: 3,
      clientX: 1_000,
      clientY: 1_000,
    });
    expect(slot.getByRole("group", { name: "Crop image" })).toBe(crop);
    expect(board().elements).toEqual([picture]);
    expect(update).not.toHaveBeenCalled();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "Escape" });
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves crop mode on an unchanged blank click without adding undo history", async () => {
    const { slot, board, update } = await open([picture]);
    fireEvent.doubleClick(
      slot.container.querySelector('[data-element="image"]')!,
    );
    const crop = slot.getByRole("group", { name: "Crop image" });
    fireEvent.pointerDown(crop.querySelector(".cv-crop-overlay > rect")!, {
      button: 0,
      pointerId: 3,
      clientX: 250,
      clientY: 200,
    });
    expect(slot.queryByRole("group", { name: "Crop image" })).toBeNull();
    expect(slot.container.querySelector(".cv-selection")).toBeNull();
    expect(board().elements).toEqual([picture]);
    expect(update).not.toHaveBeenCalled();
    expect(
      (slot.getByRole("button", { name: "Undo (⌘Z)" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("applies on an outside panel click without stealing focus and removes its listener on unmount", async () => {
    const { slot, board, update } = await open([picture]);
    const outside = document.createElement("input");
    document.body.append(outside);
    try {
      fireEvent.doubleClick(
        slot.container.querySelector('[data-element="image"]')!,
      );
      const crop = slot.getByRole("group", { name: "Crop image" });
      fireEvent.pointerDown(crop.querySelector('[data-crop-handle="nw"]')!, {
        button: 0,
        pointerId: 3,
        clientX: 32,
        clientY: 48,
      });
      fireEvent.pointerUp(crop, { pointerId: 3, clientX: 62, clientY: 63 });
      act(() => outside.focus());
      const pointerDown = vi.fn();
      outside.addEventListener("pointerdown", pointerDown);
      expect(fireEvent.pointerDown(outside, { button: 0, pointerId: 4 })).toBe(
        true,
      );
      expect(pointerDown).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(outside);
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      expect(board().elements[0]).toMatchObject({
        x: 40,
        y: 20,
        width: 160,
        height: 80,
        crop: { x: 0.2, y: 0.2, width: 0.8, height: 0.8 },
      });
      expect(slot.queryByRole("group", { name: "Crop image" })).toBeNull();
      expect(slot.container.querySelector(".cv-selection")).toBeNull();

      fireEvent.doubleClick(
        slot.container.querySelector('[data-element="image"]')!,
      );
      const reopened = slot.getByRole("group", { name: "Crop image" });
      fireEvent.pointerDown(
        reopened.querySelector('[data-crop-handle="nw"]')!,
        {
          button: 0,
          pointerId: 5,
          clientX: 62,
          clientY: 63,
        },
      );
      fireEvent.pointerUp(reopened, { pointerId: 5, clientX: 77, clientY: 78 });
      act(() => slot.lifecycle.unmount());
      const saved = board().elements;
      fireEvent.pointerDown(outside, { button: 0, pointerId: 6 });
      expect(board().elements).toEqual(saved);
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      outside.remove();
    }
  });

  it.each(["Escape", "Ctrl+Z", "Cmd+Z"])(
    "cancels a moved crop with %s without altering its image or other elements",
    async (cancel) => {
      const croppedPicture: CanvasElement = {
        ...picture,
        x: 40,
        y: 20,
        width: 160,
        height: 80,
        crop: { x: 0.2, y: 0.2, width: 0.8, height: 0.8 },
      };
      const original = [croppedPicture, note];
      const { slot, board, update } = await open(original);
      fireEvent.doubleClick(
        slot.container.querySelector('[data-element="image"]')!,
      );
      const crop = slot.getByRole("group", { name: "Crop image" });
      fireEvent.pointerDown(crop.querySelector("[data-crop-frame]")!, {
        button: 0,
        pointerId: 4,
        clientX: 92,
        clientY: 78,
      });
      fireEvent.pointerMove(crop, { pointerId: 4, clientX: 77, clientY: 70.5 });
      fireEvent.pointerUp(crop, { pointerId: 4, clientX: 77, clientY: 70.5 });
      const frame = crop.querySelector("[data-crop-frame]")!;
      expect(Number(frame.getAttribute("x"))).toBeCloseTo(20);
      expect(Number(frame.getAttribute("y"))).toBeCloseTo(10);
      expect(Number(frame.getAttribute("width"))).toBe(160);
      expect(Number(frame.getAttribute("height"))).toBe(80);
      fireEvent.keyDown(slot.getByLabelText("Canvas"), {
        key: cancel === "Escape" ? "Escape" : "z",
        ctrlKey: cancel === "Ctrl+Z",
        metaKey: cancel === "Cmd+Z",
      });
      expect(slot.queryByRole("group", { name: "Crop image" })).toBeNull();
      expect(board().elements).toEqual(original);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("keeps image annotation tools and Space panning from opening crop mode", async () => {
    const { slot, surface, update } = await open([picture]);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      slot.container.querySelector('[data-element="image"]')!,
    );
    const root = slot.getByLabelText("Canvas");
    for (const key of ["d", "t", "a", "s"]) {
      fireEvent.keyDown(root, { key });
      fireEvent.doubleClick(surface, { clientX: 100, clientY: 80 });
      expect(slot.queryByRole("group", { name: "Crop image" })).toBeNull();
    }
    fireEvent.keyDown(root, { key: "v" });
    fireEvent.keyDown(root, { key: " ", code: "Space" });
    fireEvent.doubleClick(surface, { clientX: 100, clientY: 80 });
    expect(slot.queryByRole("group", { name: "Crop image" })).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps separate open thread panels from saving into one another", async () => {
    const first = await open([note]);
    const second = await open([stroke]);
    select(
      first.surface,
      first.slot.container.querySelector('[data-element="annotation"]')!,
    );
    fireEvent.keyDown(first.slot.container.querySelector(".cv-root")!, {
      key: "Delete",
    });
    await waitFor(() => expect(first.board().elements).toEqual([]));
    expect(second.board().elements).toEqual([stroke]);
    expect(second.update).not.toHaveBeenCalled();
  });

  it.each(["capture loss", "pointer cancellation"])(
    "keeps a moved element at its displayed position after %s",
    async (ending) => {
      const { slot, surface, board, update } = await open([note]);
      const target = slot.container.querySelector(
        '[data-element="annotation"]',
      )!;
      fireEvent.pointerDown(target, {
        button: 0,
        pointerId: 1,
        clientX: 40,
        clientY: 56,
      });
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 115,
        clientY: 86,
      });
      const text = () =>
        slot.container.querySelector('[data-element="annotation"] tspan')!;
      expect(text().getAttribute("x")).toBe("100");
      if (ending === "capture loss")
        fireEvent.lostPointerCapture(surface, { pointerId: 1 });
      else fireEvent.pointerCancel(surface, { pointerId: 1 });
      expect(text().getAttribute("x")).toBe("100");
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      expect(board().elements[0]).toMatchObject({ x: 100, y: 40 });
    },
  );

  it("rolls a drag back on Escape and ignores subsequent capture loss", async () => {
    const { slot, surface, board, update } = await open([note]);
    const target = slot.container.querySelector('[data-element="annotation"]')!;
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      clientX: 40,
      clientY: 56,
    });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "Escape" });
    fireEvent.lostPointerCapture(surface, { pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    expect(
      slot.container
        .querySelector('[data-element="annotation"] tspan')!
        .getAttribute("x"),
    ).toBe("0");
    expect(update).not.toHaveBeenCalled();
    expect(board().elements).toEqual([note]);
  });

  it("does not restore an element deleted during a drag, and can undo the deletion", async () => {
    const { slot, surface, board } = await open([note]);
    fireEvent.pointerDown(
      slot.container.querySelector('[data-element="annotation"]')!,
      { button: 0, pointerId: 1, clientX: 40, clientY: 56 },
    );
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    fireEvent.keyDown(slot.getByLabelText("Canvas"), { key: "Delete" });
    fireEvent.lostPointerCapture(surface, { pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    await waitFor(() => expect(board().elements).toEqual([]));
    expect(
      slot.container.querySelector('[data-element="annotation"]'),
    ).toBeNull();
    fireEvent.keyDown(slot.getByLabelText("Canvas"), {
      key: "z",
      metaKey: true,
    });
    await waitFor(() => expect(board().elements).toEqual([note]));
  });

  it.each([false, true])(
    "keeps history changes after releasing an interrupted drag (redo: %s)",
    async (redo) => {
      const { slot, surface, board } = await open([note]);
      const target = () =>
        slot.container.querySelector('[data-element="annotation"]')!;
      fireEvent.pointerDown(target(), {
        button: 0,
        pointerId: 1,
        clientX: 40,
        clientY: 56,
      });
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 115,
        clientY: 86,
      });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
      await waitFor(() => expect(board().elements[0]!.x).toBe(100));
      if (redo) {
        fireEvent.keyDown(slot.getByLabelText("Canvas"), {
          key: "z",
          metaKey: true,
        });
        await waitFor(() => expect(board().elements).toEqual([note]));
      }
      fireEvent.pointerDown(target(), {
        button: 0,
        pointerId: 1,
        clientX: 115,
        clientY: 86,
      });
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 190,
        clientY: 116,
      });
      fireEvent.keyDown(slot.getByLabelText("Canvas"), {
        key: "z",
        metaKey: true,
        shiftKey: redo,
      });
      fireEvent.lostPointerCapture(surface, { pointerId: 1 });
      fireEvent.pointerUp(surface, {
        pointerId: 1,
        clientX: 190,
        clientY: 116,
      });
      await slot.findByText("Saved");
      await waitFor(() =>
        expect(board().elements).toEqual([
          { ...note, x: redo ? 100 : 0, y: redo ? 40 : 0 },
        ]),
      );
    },
  );

  it("commits final pointerup coordinates when the last move sample trails the cursor", async () => {
    const { slot, surface, board } = await open([note]);
    const target = slot.container.querySelector('[data-element="annotation"]')!;
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      clientX: 40,
      clientY: 56,
    });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 145, clientY: 101 });
    await waitFor(() => {
      expect(board().elements[0]!.x).toBeCloseTo(140);
      expect(board().elements[0]!.y).toBeCloseTo(60);
    });
  });

  it("prevents native image dragging from taking over a canvas gesture", async () => {
    const image: CanvasElement = {
      id: "image",
      type: "image",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      assetId: "asset",
      name: "Screenshot",
    };
    const { slot } = await open([image]);
    const target = slot.container.querySelector(
      '[data-element="image"] image',
    )!;
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      clientX: 40,
      clientY: 56,
    });
    const nativeDrag = new Event("dragstart", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(target, nativeDrag);
    expect(nativeDrag.defaultPrevented).toBe(true);
  });

  it("commits the latest drag preview when move and release arrive in the same batch", async () => {
    const { slot, surface, board } = await open([note]);
    const target = slot.container.querySelector('[data-element="annotation"]')!;
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      clientX: 40,
      clientY: 56,
    });
    act(() => {
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 115,
        clientY: 86,
      });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 115, clientY: 86 });
    });
    await waitFor(() =>
      expect(board().elements[0]).toMatchObject({ x: 100, y: 40 }),
    );
  });

  it.each(["", "Keep this draft"])(
    "preserves the text draft %j through color selection and saves its new color",
    async (draft) => {
      const { slot, surface, board } = await open();
      fireEvent.click(slot.getByRole("button", { name: "Text (T)" }));
      fireEvent.pointerDown(surface, {
        button: 0,
        pointerId: 1,
        clientX: 80,
        clientY: 90,
      });
      const editor = slot.getByLabelText("Canvas text") as HTMLTextAreaElement;
      fireEvent.change(editor, { target: { value: draft } });
      const trigger = slot.getByRole("button", { name: "Blue" });

      // A real focus transfer supplies relatedTarget to the editor's blur.
      act(() => trigger.focus());
      expect(slot.getByLabelText("Canvas text")).toBe(editor);
      fireEvent.click(trigger);

      await waitFor(() => expect(document.activeElement).toBe(editor));
      expect(editor.value).toBe(draft);
      expect(editor.style.color).toBe("rgb(8, 123, 223)");
      expect(board().elements).toHaveLength(0);

      const text = `${draft} final annotation`.trim();
      fireEvent.change(editor, { target: { value: text } });
      fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
      await waitFor(() => {
        expect(board().elements).toHaveLength(1);
        expect(board().elements[0]).toMatchObject({
          type: "text",
          text,
          color: "#087bdf",
        });
      });
    },
  );

  it("saves a draft when focus leaves the Size control for the chat composer", async () => {
    const { slot, surface, board } = await open();
    fireEvent.click(slot.getByRole("button", { name: "Text (T)" }));
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 80,
      clientY: 90,
    });
    const editor = slot.getByLabelText("Canvas text");
    fireEvent.change(editor, { target: { value: "Ready for the agent" } });
    act(() => slot.getByRole("button", { name: "Medium text (24)" }).focus());
    expect(slot.getByLabelText("Canvas text")).toBe(editor);
    const composer = document.createElement("textarea");
    document.body.append(composer);
    try {
      act(() => composer.focus());
      await waitFor(() => {
        expect(board().elements).toHaveLength(1);
        expect(board().elements[0]).toMatchObject({
          type: "text",
          text: "Ready for the agent",
          fontSize: 24,
        });
      });
    } finally {
      composer.remove();
    }
  });
});
