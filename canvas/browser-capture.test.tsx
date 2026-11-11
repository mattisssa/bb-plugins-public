// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ExperimentalPluginBrowserToolbarActionProps,
  JsonValue,
} from "@get-bb/plugin-sdk/app";
import { BrowserCapture, PICKER_KEY, pickerScript } from "./browser-capture";
import { loadImage } from "./images";
import type { Board } from "./model";

vi.mock("./images", async (original) => ({
  ...(await original<typeof import("./images")>()),
  loadImage: vi.fn(),
  imageData: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

type Picker = { token: string; cleanup: () => void };
const pickerWindow = window as unknown as Record<string, Picker | undefined>;
let frames: FrameRequestCallback[];
let postMessage: ReturnType<typeof vi.fn>;
let hitTarget: Element | null;
let elementFromPoint: ReturnType<typeof vi.fn<Document["elementFromPoint"]>>;

beforeEach(() => {
  frames = [];
  postMessage = vi.fn();
  hitTarget = null;
  elementFromPoint = vi.fn(() => hitTarget);
  // jsdom does not implement layout hit testing.
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: elementFromPoint,
  });
  vi.stubGlobal("bb", { postMessage });
  vi.stubGlobal("innerWidth", 800);
  vi.stubGlobal("innerHeight", 600);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  vi.mocked(loadImage).mockResolvedValue(document.createElement("img"));
});
afterEach(() => {
  pickerWindow[PICKER_KEY]?.cleanup();
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "elementFromPoint");
});

function setRect(
  node: Element,
  rect: { x: number; y: number; width: number; height: number },
) {
  node.getBoundingClientRect = () => ({
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON() {},
  });
}
function block(
  rect: { x: number; y: number; width: number; height: number },
  parent = document.body,
) {
  const node = document.createElement("section");
  node.setAttribute("aria-label", "Feature card");
  setRect(node, rect);
  parent.append(node);
  return node;
}
function pickerElements() {
  const shield = document.documentElement.lastElementChild as HTMLElement;
  return { shield, overlay: shield.firstElementChild as HTMLElement };
}
function move(target: Element, x = 10, y = 10) {
  hitTarget = target;
  return fireEvent(
    pickerElements().shield,
    new MouseEvent("pointermove", {
      bubbles: true,
      composed: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }),
  );
}
const click = (x = 10, y = 10) =>
  fireEvent.click(pickerElements().shield, { clientX: x, clientY: y });
const nextFrame = () => frames.splice(0).forEach((callback) => callback(0));

describe("Browser page picker", () => {
  it("highlights and clips a block to the viewport, then removes the overlay before capture", () => {
    const target = block({ x: -20, y: 550, width: 200, height: 100 });
    window.eval(pickerScript("pick-one"));
    const { shield, overlay } = pickerElements();
    move(target);
    expect(overlay.style).toMatchObject({
      left: "0px",
      top: "550px",
      width: "180px",
      height: "50px",
      pointerEvents: "none",
    });
    click();
    expect(shield.isConnected).toBe(false);
    expect(overlay.isConnected).toBe(false);
    expect(pickerWindow[PICKER_KEY]).toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
    nextFrame();
    expect(postMessage).not.toHaveBeenCalled();
    nextFrame();
    expect(postMessage).toHaveBeenCalledWith({
      kind: "canvas-pick",
      token: "pick-one",
      label: "Feature card",
      rect: { x: 0, y: 550, width: 180, height: 50 },
      viewport: { width: 800, height: 600 },
    });
  });

  it("lets ArrowUp choose the parent and releases all input interception on Escape", () => {
    const parent = block({ x: 40, y: 30, width: 300, height: 200 });
    const target = block({ x: 80, y: 70, width: 90, height: 40 }, parent);
    const clicks = vi.fn();
    target.addEventListener("click", clicks);
    target.tabIndex = 0;
    target.focus();
    window.eval(pickerScript("pick-two"));
    const { shield, overlay } = pickerElements();
    expect(document.activeElement).toBe(shield);
    move(target);
    fireEvent.keyDown(shield, { key: "ArrowUp" });
    expect(overlay.style).toMatchObject({
      left: "40px",
      top: "30px",
      width: "300px",
      height: "200px",
    });
    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    shield.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.keyDown(shield, { key: "Escape" });
    expect(postMessage).toHaveBeenCalledWith({
      kind: "canvas-cancel",
      token: "pick-two",
    });
    expect(shield.isConnected).toBe(false);
    expect(overlay.isConnected).toBe(false);
    expect(document.activeElement).toBe(target);
    fireEvent.click(target);
    expect(clicks).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "captures an iframe on its first click without entering or activating it (cross-origin: %s)",
    (crossOrigin) => {
      const frame = document.createElement("iframe");
      if (crossOrigin) frame.src = "https://embedded.example/chart";
      frame.setAttribute("aria-label", "Embedded chart");
      setRect(frame, { x: 120, y: 80, width: 320, height: 180 });
      document.body.append(frame);
      const clicked = vi.fn();
      frame.addEventListener("click", clicked);
      if (crossOrigin) {
        for (const property of ["contentDocument", "contentWindow"] as const)
          vi.spyOn(frame, property, "get").mockImplementation(() => {
            throw new Error("Cross-origin frame access is forbidden");
          });
      } else {
        const button = frame.contentDocument!.createElement("button");
        button.addEventListener("click", clicked);
        frame.contentDocument!.body.append(button);
      }
      frame.focus();
      window.eval(pickerScript("pick-frame"));
      const { shield, overlay } = pickerElements();
      expect(document.activeElement).toBe(shield);
      expect(shield.style).toMatchObject({
        position: "fixed",
        inset: "0px",
        pointerEvents: "auto",
        touchAction: "none",
      });
      elementFromPoint.mockImplementation((x, y) => {
        expect([x, y]).toEqual([150, 100]);
        expect(shield.style.pointerEvents).toBe("none");
        return frame;
      });
      click(150, 100);
      expect(clicked).not.toHaveBeenCalled();
      expect(shield.style.pointerEvents).toBe("auto");
      expect(shield.isConnected).toBe(false);
      expect(overlay.isConnected).toBe(false);
      expect(postMessage).not.toHaveBeenCalled();
      nextFrame();
      expect(postMessage).not.toHaveBeenCalled();
      nextFrame();
      expect(postMessage).toHaveBeenCalledWith({
        kind: "canvas-pick",
        token: "pick-frame",
        label: "Embedded chart",
        rect: { x: 120, y: 80, width: 320, height: 180 },
        viewport: { width: 800, height: 600 },
      });
    },
  );

  it("preserves an iframe's parent selection through pointer down and click", () => {
    const parent = block({ x: 20, y: 30, width: 500, height: 300 });
    const frame = document.createElement("iframe");
    setRect(frame, { x: 120, y: 80, width: 320, height: 180 });
    parent.append(frame);
    window.eval(pickerScript("pick-parent"));
    const { shield, overlay } = pickerElements();
    move(frame, 150.5, 100.5);
    expect(overlay.style.width).toBe("320px");
    fireEvent.keyDown(shield, { key: "ArrowUp" });
    expect(overlay.style.width).toBe("500px");
    shield.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: 100,
      }),
    );
    click(150, 100);
    nextFrame();
    nextFrame();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "canvas-pick",
        rect: { x: 20, y: 30, width: 500, height: 300 },
      }),
    );
  });

  it("still highlights elements inside an open shadow root", () => {
    const host = block({ x: 20, y: 30, width: 500, height: 300 });
    const shadow = host.attachShadow({ mode: "open" });
    const target = document.createElement("button");
    setRect(target, { x: 40, y: 50, width: 80, height: 30 });
    shadow.append(target);
    Object.defineProperty(shadow, "elementFromPoint", { value: () => target });
    window.eval(pickerScript("pick-shadow"));
    move(host, 45, 55);
    const { shield, overlay } = pickerElements();
    expect(overlay.style).toMatchObject({
      left: "40px",
      top: "50px",
      width: "80px",
      height: "30px",
    });
    fireEvent.keyDown(shield, { key: "ArrowUp" });
    expect(overlay.style.width).toBe("500px");
  });

  it("cleans up a replaced picker, page navigation, and its timeout", () => {
    vi.useFakeTimers();
    window.eval(pickerScript("old"));
    const { shield: oldShield, overlay: oldOverlay } = pickerElements();
    window.eval(pickerScript("new"));
    expect(oldShield.isConnected).toBe(false);
    expect(oldOverlay.isConnected).toBe(false);
    expect(pickerWindow[PICKER_KEY]?.token).toBe("new");
    window.dispatchEvent(new Event("pagehide"));
    expect(pickerWindow[PICKER_KEY]).toBeUndefined();
    vi.advanceTimersByTime(90_000);
    expect(postMessage).not.toHaveBeenCalled();
    window.eval(pickerScript("timeout"));
    vi.advanceTimersByTime(90_000);
    expect(postMessage).toHaveBeenCalledWith({
      kind: "canvas-cancel",
      token: "timeout",
    });
    expect(pickerWindow[PICKER_KEY]).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const captured = {
  width: 1600,
  height: 900,
  mimeType: "image/jpeg" as const,
  base64: "capture",
};
const saved: Board = {
  version: 1,
  revision: 1,
  elements: [
    {
      id: "note",
      type: "text",
      x: -40,
      y: 10,
      width: 90,
      height: 30,
      text: "Note",
      color: "#242424",
      fontSize: 20,
    },
  ],
};

async function toolbar(
  overrides: {
    capture?: () => Promise<typeof captured>;
    getBoard?: () => Promise<Board>;
    update?: () => Promise<Board>;
    page?: null;
  } = {},
) {
  const listeners = new Set<(data: JsonValue) => void>();
  const unsubscribed = vi.fn();
  const page = {
    evaluate: vi.fn(async (_expression: string) => true as JsonValue),
    onMessage: vi.fn((listener: (data: JsonValue) => void) => {
      listeners.add(listener);
      return () => {
        unsubscribed();
        listeners.delete(listener);
      };
    }),
  };
  const props: ExperimentalPluginBrowserToolbarActionProps = {
    threadId: "thread-capture",
    tabId: "tab-capture",
    url: "https://example.com/one",
    isCompactViewport: false,
    experimental_page: overrides.page === null ? null : page,
  };
  const capture = vi.fn(overrides.capture ?? (async () => captured));
  const upload = vi.fn(async () => ({
    id: "asset-capture",
    width: 200,
    height: 120,
  }));
  const getBoard = vi.fn(overrides.getBoard ?? (async () => saved));
  const update = vi.fn(overrides.update ?? (async () => saved));
  const drawImage = vi.fn();
  const canvasSizes: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    function (this: HTMLCanvasElement) {
      canvasSizes.push([this.width, this.height]);
      return "data:image/png;base64,cropped";
    },
  );
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(app.browserToolbarActions[0]!, props, {
    rpc: {
      captureCanvasTab: capture,
      uploadCanvasImage: upload,
      getCanvas: getBoard,
      updateCanvas: update,
    },
  });
  const start = async () => {
    fireEvent.click(slot.getByRole("button", { name: "Capture to Canvas" }));
    await waitFor(() => expect(page.evaluate).toHaveBeenCalled());
    const script = String(page.evaluate.mock.calls.at(-1)?.[0]);
    return JSON.parse(script.match(/token = ("[^"]+")/)![1]!) as string;
  };
  const emit = async (data: JsonValue) =>
    act(async () => {
      listeners.forEach((listener) => listener(data));
    });
  return {
    slot,
    props,
    page,
    start,
    emit,
    capture,
    upload,
    getBoard,
    update,
    drawImage,
    canvasSizes,
    unsubscribed,
  };
}
const selection = (token: string): JsonValue => ({
  kind: "canvas-pick",
  token,
  label: "Feature card",
  rect: { x: 20, y: 30, width: 100, height: 80 },
  viewport: { width: 800, height: 600 },
});

describe("Browser toolbar capture", () => {
  it("hides the desktop-only control without a page bridge", async () => {
    const { slot } = await toolbar({ page: null });
    expect(slot.queryByRole("button")).toBeNull();
  });

  it("ignores picker messages when no capture is active", async () => {
    const current = await toolbar();
    await current.emit({
      kind: "canvas-pick",
      token: null,
      rect: { x: 0, y: 0, width: 100, height: 80 },
      viewport: { width: 800, height: 600 },
    });
    expect(current.capture).not.toHaveBeenCalled();
    expect(current.update).not.toHaveBeenCalled();
  });

  it("keeps a new capture active when an obsolete request finishes", async () => {
    const oldRequest = deferred<typeof captured>();
    const newRequest = deferred<typeof captured>();
    const capture = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const current = await toolbar({ capture });
    const oldToken = await current.start();
    await current.emit(selection(oldToken));
    await current.emit(selection(oldToken));
    expect(current.capture).toHaveBeenCalledOnce();
    current.slot.lifecycle.rerender(
      <BrowserCapture {...current.props} url="https://example.com/two" />,
    );
    const newToken = await current.start();
    expect(newToken).not.toBe(oldToken);
    await current.emit(selection(newToken));
    await act(async () => {
      oldRequest.resolve(captured);
    });
    expect(
      (
        current.slot.getByRole("button", {
          name: "Capture to Canvas",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(current.upload).not.toHaveBeenCalled();
    await act(async () => {
      newRequest.resolve(captured);
    });
    await waitFor(() => expect(current.update).toHaveBeenCalledOnce());
    expect(current.capture).toHaveBeenCalledTimes(2);
    expect(current.upload).toHaveBeenCalledOnce();
  });

  it("keeps its subscription stable and crops using captured pixel dimensions for the owning thread/tab", async () => {
    const current = await toolbar();
    const token = await current.start();
    expect(current.page.onMessage).toHaveBeenCalledOnce();
    expect(current.unsubscribed).not.toHaveBeenCalled();
    await current.emit(selection(token));
    await waitFor(() => expect(current.update).toHaveBeenCalledOnce());
    expect(current.capture).toHaveBeenCalledWith({
      threadId: "thread-capture",
      tabId: "tab-capture",
    });
    expect(current.drawImage).toHaveBeenCalledWith(
      expect.any(HTMLImageElement),
      40,
      45,
      200,
      120,
      0,
      0,
      200,
      120,
    );
    expect(current.canvasSizes).toEqual([[200, 120]]);
    expect(current.upload).toHaveBeenCalledWith({
      threadId: "thread-capture",
      base64: "cropped",
    });
    expect(current.update).toHaveBeenCalledWith({
      threadId: "thread-capture",
      patch: {
        upserts: [
          expect.objectContaining({
            type: "image",
            assetId: "asset-capture",
            x: 82,
            y: 10,
            width: 200,
            height: 120,
          }),
        ],
        removeIds: [],
      },
    });
    expect(current.slot.inspection.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "canvas" } },
    ]);
    expect(current.page.onMessage).toHaveBeenCalledOnce();
  });

  it("ignores stale tokens and invalid crop messages, and cancels on unmount", async () => {
    const current = await toolbar();
    const token = await current.start();
    await current.emit(selection("stale-token"));
    await current.emit({
      kind: "canvas-pick",
      token,
      rect: { x: -1, y: 0, width: 100, height: 80 },
      viewport: { width: 800, height: 600 },
    });
    await current.emit({
      kind: "canvas-pick",
      token,
      rect: { x: 780, y: 0, width: 100, height: 80 },
      viewport: { width: 800, height: 600 },
    });
    expect(current.capture).not.toHaveBeenCalled();
    current.slot.lifecycle.unmount();
    expect(current.unsubscribed).toHaveBeenCalledOnce();
    expect(current.page.evaluate).toHaveBeenLastCalledWith(
      expect.stringContaining("p.cleanup()"),
    );
    await current.emit(selection(token));
    expect(current.capture).not.toHaveBeenCalled();
  });

  it("caps a high-resolution crop at 2400 pixels without changing its aspect ratio", async () => {
    const current = await toolbar({
      capture: async () => ({ ...captured, width: 8000, height: 6000 }),
    });
    const token = await current.start();
    await current.emit({
      kind: "canvas-pick",
      token,
      rect: { x: 0, y: 0, width: 800, height: 600 },
      viewport: { width: 800, height: 600 },
    });
    await waitFor(() => expect(current.update).toHaveBeenCalledOnce());
    expect(current.canvasSizes).toEqual([[2400, 1800]]);
    expect(current.drawImage).toHaveBeenCalledWith(
      expect.any(HTMLImageElement),
      0,
      0,
      8000,
      6000,
      0,
      0,
      2400,
      1800,
    );
  });

  it("discards a pending screenshot when its page navigates", async () => {
    const request = deferred<typeof captured>();
    const current = await toolbar({ capture: () => request.promise });
    const token = await current.start();
    await current.emit(selection(token));
    current.slot.lifecycle.rerender(
      <BrowserCapture {...current.props} url="https://example.com/two" />,
    );
    await act(async () => {
      request.resolve(captured);
    });
    expect(current.upload).not.toHaveBeenCalled();
    expect(current.update).not.toHaveBeenCalled();
  });

  it("stops image upload if the toolbar unmounts while the screenshot decodes", async () => {
    const decoding = deferred<HTMLImageElement>();
    vi.mocked(loadImage).mockReturnValueOnce(decoding.promise);
    const current = await toolbar();
    const token = await current.start();
    await current.emit(selection(token));
    current.slot.lifecycle.unmount();
    await act(async () => {
      decoding.resolve(document.createElement("img"));
    });
    expect(current.upload).not.toHaveBeenCalled();
    expect(current.update).not.toHaveBeenCalled();
  });

  it("does not save or open a stale capture after navigation during the board read", async () => {
    const loading = deferred<Board>();
    const current = await toolbar({ getBoard: () => loading.promise });
    const token = await current.start();
    await current.emit(selection(token));
    await waitFor(() => expect(current.getBoard).toHaveBeenCalledOnce());
    current.slot.lifecycle.rerender(
      <BrowserCapture {...current.props} url="https://example.com/two" />,
    );
    await act(async () => {
      loading.resolve(saved);
    });
    expect(current.update).not.toHaveBeenCalled();
    expect(current.slot.inspection.navigateCalls).toEqual([]);
  });

  it("does not open a different surface after an in-flight save completes", async () => {
    const saving = deferred<Board>();
    const current = await toolbar({ update: () => saving.promise });
    const token = await current.start();
    await current.emit(selection(token));
    await waitFor(() => expect(current.update).toHaveBeenCalledOnce());
    current.slot.lifecycle.unmount();
    await act(async () => {
      saving.resolve(saved);
    });
    expect(current.slot.inspection.navigateCalls).toEqual([]);
  });
});
