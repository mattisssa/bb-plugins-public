import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { PNG } from "pngjs";
import plugin, { pngSize } from "./server";
import { boardSvg, rasterize } from "./render";
import { layoutSticky } from "./layout";
import {
  CHANNEL,
  STICKY_BACKGROUND,
  type ArrowElement,
  type Board,
  type CanvasElement,
  type ImageElement,
  type Patch,
  type StickyElement,
} from "./model";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function setup(options?: Parameters<typeof createFakePluginHost>[0]) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "canvas",
    ...options,
  });
  plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  return {
    harness,
    read: (threadId = "thread-a") =>
      harness.behavior.callRpc("getCanvas", { threadId }) as Promise<Board>,
    update: (patch: Patch, threadId = "thread-a") =>
      harness.behavior.callRpc("updateCanvas", {
        threadId,
        patch,
      }) as Promise<Board>,
    upload: (base64: string, threadId = "thread-a") =>
      harness.behavior.callRpc("uploadCanvasImage", {
        threadId,
        base64,
      }) as Promise<{ id: string; width: number; height: number }>,
  };
}

function note(id: string, text = "Hello"): CanvasElement {
  return {
    id,
    type: "text",
    x: -50,
    y: 10,
    width: 200,
    height: 40,
    text,
    color: "#242424",
    fontSize: 20,
  };
}
function picture(id: string, assetId: string): CanvasElement {
  return {
    id,
    type: "image",
    assetId,
    x: 0,
    y: 0,
    width: 40,
    height: 30,
    name: "sample.png",
  };
}
const legacySticky: StickyElement = {
  id: "legacy-sticky",
  type: "sticky",
  x: 100,
  y: 80,
  width: 301,
  height: 112,
  text: "Keep every word\nSecond line",
  color: "#8854c8",
  background: STICKY_BACKGROUND,
  fontSize: 24,
};
const patch = (...upserts: CanvasElement[]): Patch => ({
  upserts,
  removeIds: [],
});
let sampleImage: Promise<Buffer> | undefined;
const samplePng = () =>
  (sampleImage ??= rasterize(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#e5484d"/></svg>',
  ).then((data) => Buffer.from(data)));
function pixel(png: PNG, x: number, y: number) {
  const offset = (y * png.width + x) * 4;
  return [...png.data.subarray(offset, offset + 4)];
}

describe("thread storage and edits", () => {
  it("migrates only affected boards to square stickies without changing their other data", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "canvas" });
    cleanups.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, [
      "CREATE TABLE canvases (thread_id TEXT PRIMARY KEY, document TEXT NOT NULL)",
      "CREATE TABLE canvas_images (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, png BLOB NOT NULL, created_at INTEGER NOT NULL)",
      "CREATE INDEX canvas_images_thread ON canvas_images(thread_id)",
    ]);
    const png = await samplePng();
    db.prepare("INSERT INTO canvas_images VALUES (?, ?, ?, ?)").run(
      "saved",
      "thread-a",
      png,
      123,
    );
    const image: ImageElement = {
      id: "image",
      type: "image",
      assetId: "saved",
      name: "original.png",
      x: 0,
      y: 0,
      width: 40,
      height: 30,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    };
    const tiny: StickyElement = {
      ...legacySticky,
      id: "tiny",
      x: 450,
      y: 10,
      width: 20,
      height: 40,
    };
    const before: Board = {
      version: 1,
      revision: 7,
      elements: [note("plain"), image, legacySticky, tiny],
    };
    const untouched: Board = {
      version: 1,
      revision: 12,
      elements: [{ ...legacySticky, width: 180, height: 180 }],
    };
    const untouchedJson = JSON.stringify(untouched, null, 2);
    const empty: Board = { version: 1, revision: 0, elements: [] };
    for (const [id, document] of [
      ["thread-a", JSON.stringify(before)],
      ["thread-b", untouchedJson],
      ["thread-c", JSON.stringify(empty)],
    ])
      db.prepare("INSERT INTO canvases VALUES (?, ?)").run(id, document);

    plugin(bb);
    const expected: Board = {
      ...before,
      revision: 8,
      elements: [
        note("plain"),
        image,
        { ...legacySticky, width: 301, height: 301 },
        { ...tiny, width: 64, height: 64 },
      ],
    };
    expect(
      await harness.behavior.callRpc("getCanvas", {
        threadId: "thread-a",
      }),
    ).toEqual(expected);
    expect(
      await harness.behavior.callRpc("getCanvas", {
        threadId: "thread-b",
      }),
    ).toEqual(untouched);
    expect(
      await harness.behavior.callRpc("getCanvas", {
        threadId: "thread-c",
      }),
    ).toEqual(empty);
    expect(
      db
        .prepare<[string], { document: string }>(
          "SELECT document FROM canvases WHERE thread_id = ?",
        )
        .get("thread-b")!.document,
    ).toBe(untouchedJson);

    const replacement = await harness.lifecycle.reload(plugin);
    cleanups.push(() => replacement.harness.lifecycle.dispose());
    const read = await replacement.harness.behavior.callAgentTool(
      "canvas_read",
      {},
      { threadId: "thread-a" },
    );
    expect(JSON.parse(read as string)).toMatchObject(expected);
    const original = await replacement.harness.behavior.fetchHttp(
      "GET",
      "/image?threadId=thread-a&id=saved",
    );
    expect(Buffer.from(await original.arrayBuffer())).toEqual(png);
    const exported = await replacement.harness.behavior.fetchHttp(
      "GET",
      "/export?threadId=thread-a&format=png",
    );
    const rendered = PNG.sync.read(Buffer.from(await exported.arrayBuffer()));
    expect({ width: rendered.width, height: rendered.height }).toEqual({
      width: 612,
      height: 429,
    });
    // The old 112px-high note ended well above this pixel; the square reaches it.
    expect(pixel(rendered, 274, 374)).toEqual([255, 243, 176, 255]);
  });

  it("normalizes legacy sticky patches before saving without mutating other elements", async () => {
    const { update, read } = setup();
    const tiny = { ...legacySticky, id: "tiny", width: 20, height: 40 };
    const saved = await update(patch(note("plain"), legacySticky, tiny));
    expect(saved).toEqual({
      version: 1,
      revision: 1,
      elements: [
        note("plain"),
        { ...legacySticky, width: 301, height: 301 },
        { ...tiny, width: 64, height: 64 },
      ],
    });
    expect(await read()).toEqual(saved);
    expect(legacySticky.height).toBe(112);
    expect(tiny.width).toBe(20);
  });

  it("persists arrows and stickies alongside existing elements and returns them to agents", async () => {
    const { harness, update } = setup();
    const arrow: ArrowElement = {
      id: "arrow",
      type: "arrow",
      x: -30,
      y: 20,
      points: [
        [10, 5],
        [-90, -45],
      ],
      color: "#087bdf",
      strokeWidth: 8,
    };
    const sticky: StickyElement = {
      id: "sticky",
      type: "sticky",
      x: 120,
      y: -40,
      width: 200,
      height: 200,
      text: "Keep the padding\nSecond line",
      color: "#242424",
      background: STICKY_BACKGROUND,
      fontSize: 24,
    };
    const elements = [note("existing"), arrow, sticky];
    await update(patch(...elements));
    const replacement = await harness.lifecycle.reload(plugin);
    cleanups.push(() => replacement.harness.lifecycle.dispose());
    expect(
      await replacement.harness.behavior.callRpc("getCanvas", {
        threadId: "thread-a",
      }),
    ).toEqual({ version: 1, revision: 1, elements });
    const read = await replacement.harness.behavior.callAgentTool(
      "canvas_read",
      {},
      { threadId: "thread-a" },
    );
    expect(JSON.parse(read as string).elements).toEqual(elements);
  });

  it("persists a board across reloads and keeps threads independent", async () => {
    const { harness, update } = setup();
    await update(patch(note("a")));
    await update(patch(note("b", "Other thread")), "thread-b");
    const replacement = await harness.lifecycle.reload(plugin);
    cleanups.push(() => replacement.harness.lifecycle.dispose());
    const read = (threadId = "thread-a") =>
      replacement.harness.behavior.callRpc("getCanvas", { threadId });
    expect(await read()).toEqual({
      version: 1,
      revision: 1,
      elements: [note("a")],
    });
    expect(await read("thread-b")).toMatchObject({
      elements: [note("b", "Other thread")],
    });
    expect(await read("thread-c")).toEqual({
      version: 1,
      revision: 0,
      elements: [],
    });
  });

  it("merges concurrent patches on separate elements without losing edits", async () => {
    const { harness, read, update } = setup();
    await Promise.all([update(patch(note("a"))), update(patch(note("b")))]);
    const board = await read();
    expect(board.revision).toBe(2);
    expect(board.elements.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(harness.inspection.realtimeSignals).toEqual([
      { channel: CHANNEL, payload: { threadId: "thread-a", revision: 1 } },
      { channel: CHANNEL, payload: { threadId: "thread-a", revision: 2 } },
    ]);
  });

  it("rejects another thread's image atomically and prevents HTTP reads of it", async () => {
    const { harness, read, update, upload } = setup();
    const { id } = await upload((await samplePng()).toString("base64"));
    const image: CanvasElement = {
      id: "image",
      type: "image",
      assetId: id,
      x: 0,
      y: 0,
      width: 40,
      height: 30,
      name: "sample.png",
    };
    await expect(
      update(patch(note("note"), image), "thread-b"),
    ).rejects.toThrow();
    expect(await read("thread-b")).toEqual({
      version: 1,
      revision: 0,
      elements: [],
    });
    expect(
      (
        await harness.behavior.fetchHttp(
          "GET",
          `/image?threadId=thread-b&id=${id}`,
        )
      ).status,
    ).toBe(404);
    const response = await harness.behavior.fetchHttp(
      "GET",
      `/image?threadId=thread-a&id=${id}`,
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      await samplePng(),
    );
  });

  it("deletes only the removed thread's board and assets", async () => {
    const { harness, read, update, upload } = setup();
    const { id } = await upload((await samplePng()).toString("base64"));
    await update(patch(note("a")));
    await update(patch(note("b")), "thread-b");
    const result = await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thread-a" }),
    });
    expect(result.errors).toEqual([]);
    expect((await read()).elements).toEqual([]);
    expect((await read("thread-b")).elements).toEqual([note("b")]);
    expect(
      (
        await harness.behavior.fetchHttp(
          "GET",
          `/image?threadId=thread-a&id=${id}`,
        )
      ).status,
    ).toBe(404);
  });

  it("rolls back an update that exceeds the board byte limit", async () => {
    const { read, update } = setup();
    await update(patch(note("original")));
    const large = Array.from({ length: 250 }, (_, i) =>
      note(`note-${i}`, "x".repeat(10_000)),
    );
    await expect(update(patch(...large))).rejects.toThrow();
    expect(await read()).toEqual({
      version: 1,
      revision: 1,
      elements: [note("original")],
    });
  });
});

describe("image boundary and exports", () => {
  it("exports a colored arrow with both head arms visible and unclipped", async () => {
    const { harness, update } = setup();
    await update(
      patch({
        id: "arrow",
        type: "arrow",
        x: 10,
        y: 20,
        points: [
          [0, 0],
          [100, 0],
        ],
        color: "#087bdf",
        strokeWidth: 4,
      }),
    );
    const response = await harness.behavior.fetchHttp(
      "GET",
      "/export?threadId=thread-a&format=png",
    );
    expect(response.status).toBe(200);
    const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    expect({ width: png.width, height: png.height }).toEqual({
      width: 152,
      height: 68,
    });
    expect(pixel(png, 76, 34)).toEqual([8, 123, 223, 255]);
    expect(pixel(png, 110, 26)).toEqual([8, 123, 223, 255]);
    expect(pixel(png, 110, 42)).toEqual([8, 123, 223, 255]);
    expect(pixel(png, 110, 46)).toEqual([255, 255, 255, 255]);
  });

  it.each(["arrow", "draw"] as const)(
    "exports a zero-length %s as a finite colored dot",
    async (type) => {
      const svg = boardSvg(
        [
          {
            id: "dot",
            type,
            x: 10,
            y: 20,
            points:
              type === "arrow"
                ? [
                    [0, 0],
                    [0, 0],
                  ]
                : [[0, 0]],
            color: "#087bdf",
            strokeWidth: 8,
          } as CanvasElement,
        ],
        () => "",
      );
      const png = PNG.sync.read(Buffer.from(await rasterize(svg)));
      expect({ width: png.width, height: png.height }).toEqual({
        width: 56,
        height: 56,
      });
      expect(pixel(png, 28, 28)).toEqual([8, 123, 223, 255]);
      expect(pixel(png, 23, 28)).toEqual([255, 255, 255, 255]);
      expect(pixel(png, 28, 32)).toEqual([255, 255, 255, 255]);
    },
  );

  it("exports a sticky background with inset, escaped text", async () => {
    const { harness, update } = setup();
    const sticky: StickyElement = {
      id: "sticky",
      type: "sticky",
      x: -20,
      y: 10,
      width: 180,
      height: 180,
      text: "Hello\n<&>",
      color: "#087bdf",
      background: STICKY_BACKGROUND,
      fontSize: 20,
    };
    const svg = boardSvg([sticky], () => "");
    expect(svg).toContain('<tspan x="-4" y="46">Hello</tspan>');
    expect(svg).toContain('<tspan x="-4" y="72">&lt;&amp;&gt;</tspan>');
    await update(patch(sticky));
    const response = await harness.behavior.fetchHttp(
      "GET",
      "/export?threadId=thread-a&format=png",
    );
    expect(response.status).toBe(200);
    const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    expect({ width: png.width, height: png.height }).toEqual({
      width: 228,
      height: 228,
    });
    expect(pixel(png, 30, 70)).toEqual([255, 243, 176, 255]);
    expect(pixel(png, 100, 120)).toEqual([255, 243, 176, 255]);
    expect(pixel(png, 23, 70)).toEqual([255, 255, 255, 255]);
    expect(pixel(png, 100, 204)).toEqual([255, 255, 255, 255]);
    const textPixels: number[][] = [];
    for (let y = 40; y < 90; y++)
      for (let x = 40; x < 180; x++) textPixels.push(pixel(png, x, y));
    expect(textPixels).toContainEqual([8, 123, 223, 255]);
  });

  it.each([
    {
      name: "paragraph",
      text: "Every line of this explanation belongs inside the note. "
        .repeat(7)
        .trim(),
    },
    { name: "long word", text: "A".repeat(500) },
  ])("fits an entire sticky $name in the exported PNG", async ({ text }) => {
    const note: StickyElement = {
      id: "sticky",
      type: "sticky",
      x: 0,
      y: 0,
      width: 180,
      height: 180,
      text,
      fontSize: 24,
      color: "#087bdf",
      background: STICKY_BACKGROUND,
    };
    const layout = layoutSticky(note);
    const svg = boardSvg([note], () => "");
    expect(svg.match(/<tspan /g)).toHaveLength(layout.lines.length);
    expect(svg).toContain("font-feature-settings:'kern' 0,'liga' 0");
    const png = PNG.sync.read(Buffer.from(await rasterize(svg)));
    const painted: { x: number; y: number }[] = [];
    for (let y = 0; y < png.height; y++)
      for (let x = 0; x < png.width; x++) {
        const [red, , blue] = pixel(png, x, y);
        if (red! < 240 && blue! > 200 && blue! > red! + 20)
          painted.push({ x, y });
      }
    expect(painted.length).toBeGreaterThan(100);
    expect(Math.min(...painted.map(({ x }) => x))).toBeGreaterThanOrEqual(39);
    expect(Math.max(...painted.map(({ x }) => x))).toBeLessThanOrEqual(187);
    expect(Math.min(...painted.map(({ y }) => y))).toBeGreaterThanOrEqual(39);
    expect(Math.max(...painted.map(({ y }) => y))).toBeLessThan(188);
    const lastBaseline =
      24 +
      layout.padding +
      layout.fontSize +
      (layout.lines.length - 1) * layout.lineHeight;
    expect(
      painted.some(
        ({ y }) =>
          y >= Math.floor(lastBaseline - layout.fontSize) && y <= lastBaseline,
      ),
    ).toBe(true);
  });

  it("persists a crop and exports only its selected region while retaining the original asset", async () => {
    const { harness, update, upload } = setup();
    const source = Buffer.from(
      await rasterize(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="4" height="8" fill="#e5484d"/><rect x="4" width="4" height="8" fill="#087bdf"/></svg>',
      ),
    );
    const { id } = await upload(source.toString("base64"));
    const cropped: ImageElement = {
      id: "cropped",
      type: "image",
      assetId: id,
      name: "original.png",
      x: 30,
      y: 40,
      width: 40,
      height: 80,
      crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
    };
    const whole: ImageElement = {
      id: "whole",
      type: "image",
      assetId: id,
      name: "original.png",
      x: 90,
      y: 40,
      width: 80,
      height: 80,
    };
    await update(patch(cropped, whole));
    const replacement = await harness.lifecycle.reload(plugin);
    cleanups.push(() => replacement.harness.lifecycle.dispose());
    const read = await replacement.harness.behavior.callAgentTool(
      "canvas_read",
      {},
      { threadId: "thread-a" },
    );
    expect(JSON.parse(read as string).elements).toEqual([cropped, whole]);
    const original = await replacement.harness.behavior.fetchHttp(
      "GET",
      `/image?threadId=thread-a&id=${id}`,
    );
    expect(Buffer.from(await original.arrayBuffer())).toEqual(source);
    const response = await replacement.harness.behavior.fetchHttp(
      "GET",
      "/export?threadId=thread-a&format=png",
    );
    expect(response.status).toBe(200);
    const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    expect({ width: png.width, height: png.height }).toEqual({
      width: 188,
      height: 128,
    });
    expect(pixel(png, 44, 64)).toEqual([8, 123, 223, 255]);
    expect(pixel(png, 14, 64)).toEqual([255, 255, 255, 255]);
    expect(pixel(png, 74, 64)).toEqual([255, 255, 255, 255]);
    expect(pixel(png, 94, 64)).toEqual([229, 72, 77, 255]);
    expect(pixel(png, 154, 64)).toEqual([8, 123, 223, 255]);
    expect(pixel(png, 44, 109)).toEqual([255, 255, 255, 255]);
  });

  it("keeps a newly deleted old image for undo while reclaiming abandoned uploads", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { harness, update, upload } = setup();
    const base64 = (await samplePng()).toString("base64");
    const asset = await upload(base64),
      abandoned = await upload(base64);
    const element = picture("image", asset.id);
    await update(patch(element));
    now += 2 * 86_400_000;
    await update({ upserts: [], removeIds: [element.id] });
    await upload(base64);
    expect(
      (
        await harness.behavior.fetchHttp(
          "GET",
          `/image?threadId=thread-a&id=${abandoned.id}`,
        )
      ).status,
    ).toBe(404);
    expect((await update(patch(element))).elements).toEqual([element]);
    now += 2 * 86_400_000;
    await upload(base64);
    expect(
      (
        await harness.behavior.fetchHttp(
          "GET",
          `/image?threadId=thread-a&id=${asset.id}`,
        )
      ).status,
    ).toBe(200);
  });

  it("expires a shared asset only a day after its last reference is removed", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { harness, update, upload } = setup();
    const base64 = (await samplePng()).toString("base64");
    const asset = await upload(base64);
    await update(
      patch(picture("first", asset.id), picture("second", asset.id)),
    );
    now += 2 * 86_400_000;
    await update({ upserts: [], removeIds: ["first"] });
    now += 86_400_000 + 1;
    await upload(base64);
    const status = async () =>
      (
        await harness.behavior.fetchHttp(
          "GET",
          `/image?threadId=thread-a&id=${asset.id}`,
        )
      ).status;
    expect(await status()).toBe(200);
    await update({ upserts: [], removeIds: ["second"] });
    now += 86_400_000 - 1;
    await upload(base64);
    expect(await status()).toBe(200);
    now += 2;
    await upload(base64);
    expect(await status()).toBe(404);
  });

  it("migrates existing images without losing boards and persists retention across reload", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "canvas" });
    cleanups.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, [
      "CREATE TABLE canvases (thread_id TEXT PRIMARY KEY, document TEXT NOT NULL)",
      "CREATE TABLE canvas_images (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, png BLOB NOT NULL, created_at INTEGER NOT NULL)",
      "CREATE INDEX canvas_images_thread ON canvas_images(thread_id)",
    ]);
    const png = await samplePng();
    const board: Board = {
      version: 1,
      revision: 7,
      elements: [picture("image", "saved")],
    };
    db.prepare("INSERT INTO canvases VALUES (?, ?)").run(
      "thread-a",
      JSON.stringify(board),
    );
    const created = Date.now() - 2 * 86_400_000;
    for (const id of ["saved", "orphan"])
      db.prepare("INSERT INTO canvas_images VALUES (?, ?, ?, ?)").run(
        id,
        "thread-a",
        png,
        created,
      );
    plugin(bb);
    expect(
      await harness.behavior.callRpc("getCanvas", { threadId: "thread-a" }),
    ).toEqual(board);
    await harness.behavior.callRpc("uploadCanvasImage", {
      threadId: "thread-a",
      base64: png.toString("base64"),
    });
    for (const id of ["saved", "orphan"])
      expect(
        (
          await harness.behavior.fetchHttp(
            "GET",
            `/image?threadId=thread-a&id=${id}`,
          )
        ).status,
      ).toBe(200);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000 + 2_000);
    const replacement = await harness.lifecycle.reload(plugin);
    cleanups.push(() => replacement.harness.lifecycle.dispose());
    await replacement.harness.behavior.callRpc("uploadCanvasImage", {
      threadId: "thread-a",
      base64: png.toString("base64"),
    });
    for (const [id, status] of [
      ["saved", 200],
      ["orphan", 404],
    ] as const)
      expect(
        (
          await replacement.harness.behavior.fetchHttp(
            "GET",
            `/image?threadId=thread-a&id=${id}`,
          )
        ).status,
      ).toBe(status);
    expect(
      await replacement.harness.behavior.callRpc("getCanvas", {
        threadId: "thread-a",
      }),
    ).toEqual(board);
  });

  it("rejects corrupt PNG headers instead of persisting unrenderable assets", async () => {
    const { upload } = setup();
    const png = await samplePng();
    await expect(
      upload(png.subarray(0, 33).toString("base64")),
    ).rejects.toThrow();
    await expect(upload("not a png")).rejects.toThrow();
    const tooWide = Buffer.from(png);
    tooWide.writeUInt32BE(4097, 16);
    await expect(upload(tooWide.toString("base64"))).rejects.toThrow();
  });

  it("escapes text content and rasterizes images, lines, and text as a bounded PNG", async () => {
    const png = await samplePng();
    const elements: CanvasElement[] = [
      {
        id: "image",
        type: "image",
        assetId: "asset",
        x: -500,
        y: 0,
        width: 20_000,
        height: 10_000,
        name: "image",
      },
      note("text", '<script>& "quoted"\nsecond line'),
      {
        id: "stroke",
        type: "draw",
        x: -490,
        y: -30,
        color: "#087bdf",
        strokeWidth: 4,
        points: [
          [0, 0],
          [100, 100],
        ],
      },
    ];
    const svg = boardSvg(
      elements,
      () => `data:image/png;base64,${png.toString("base64")}`,
    );
    expect(svg).toContain("&lt;script&gt;&amp;");
    expect(svg).not.toContain("<script>");
    const rendered = Buffer.from(await rasterize(svg));
    const dimensions = pngSize(rendered);
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(
      2400,
    );
    expect(rendered.subarray(-8, -4).toString("ascii")).toBe("IEND");
  });

  it("embeds a reused image once and renders every copy at its own position", async () => {
    const source = `data:image/png;base64,${(await samplePng()).toString("base64")}`;
    let reads = 0;
    const copies: CanvasElement[] = Array.from({ length: 500 }, (_, i) => ({
      id: `image-${i}`,
      type: "image",
      assetId: "shared-image",
      name: "image",
      x: (i % 25) * 16,
      y: Math.floor(i / 25) * 16,
      width: 12,
      height: 10,
    }));
    const svg = boardSvg(
      copies,
      () => {
        reads += 1;
        return source;
      },
      { x: 0, y: 0, width: 400, height: 320 },
    );
    expect(reads).toBe(1);
    expect(svg.split(source)).toHaveLength(2);
    const png = PNG.sync.read(Buffer.from(await rasterize(svg)));
    const pixel = (x: number, y: number) => [
      ...png.data.subarray(
        (y * png.width + x) * 4,
        (y * png.width + x) * 4 + 4,
      ),
    ];
    expect(pixel(5, 5)).toEqual([229, 72, 77, 255]);
    expect(pixel(390, 309)).toEqual([229, 72, 77, 255]);
    expect(pixel(14, 14)).toEqual([255, 255, 255, 255]);
  });

  it("lets an agent read only its own board and view it with no frontend mounted", async () => {
    const { harness, update } = setup();
    await update(patch(note("a", "Review this")));
    await update(patch(note("b", "Other thread")), "thread-b");
    const read = await harness.behavior.callAgentTool(
      "canvas_read",
      {},
      { threadId: "thread-a" },
    );
    expect(typeof read).toBe("string");
    expect(JSON.parse(read as string).elements).toEqual([
      note("a", "Review this"),
    ]);
    const result = await harness.behavior.callAgentTool(
      "canvas_screenshot",
      {},
      { threadId: "thread-a" },
    );
    expect(typeof result).toBe("object");
    if (typeof result === "string") throw new Error("Expected an image result");
    const image = result.content.find((part) => part.type === "image");
    if (!image || image.type !== "image")
      throw new Error("Missing canvas image");
    expect(image.mimeType).toBe("image/png");
    expect(pngSize(Buffer.from(image.data, "base64"))).toEqual({
      width: 248,
      height: 88,
    });
  });

  it("keeps exports usable when pasted text includes XML control characters", async () => {
    const svg = boardSvg([note("text", "Before\u0000\u000cAfter")], () => "");
    const rendered = Buffer.from(await rasterize(svg));
    expect(pngSize(rendered).width).toBeGreaterThan(0);
  });

  it("keeps CLI and agent reads bounded for a large valid board", async () => {
    const { harness, update } = setup();
    await update(
      patch(
        ...Array.from({ length: 150 }, (_, i) =>
          note(`note-${i}`, "x".repeat(10_000)),
        ),
      ),
    );
    const result = await harness.behavior.runCli([
      "read",
      "--thread",
      "thread-a",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(
      Buffer.byteLength(result.stdout + result.stderr),
    ).toBeLessThanOrEqual(PLUGIN_CLI_OUTPUT_MAX_BYTES);
    const tool = await harness.behavior.callAgentTool(
      "canvas_read",
      {},
      { threadId: "thread-a" },
    );
    const text = typeof tool === "string" ? tool : JSON.stringify(tool);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      PLUGIN_CLI_OUTPUT_MAX_BYTES,
    );
  });

  it("paginates maximum-length strokes without losing their points or exceeding read budgets", async () => {
    const { harness, update } = setup();
    const strokes: CanvasElement[] = Array.from({ length: 5 }, (_, i) => ({
      id: `stroke-${i}`,
      type: "draw",
      x: i * 100,
      y: 0,
      color: "#242424",
      strokeWidth: 4,
      points: Array.from({ length: 6000 }, () => [
        1.234567890123456e-100, -1.234567890123456e-100,
      ]),
    }));
    await update(patch(...strokes));
    const collected: CanvasElement[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await harness.behavior.callAgentTool(
        "canvas_read",
        { offset },
        { threadId: "thread-a" },
      );
      expect(typeof result).toBe("string");
      expect(Buffer.byteLength(result as string)).toBeLessThan(401_000);
      const page = JSON.parse(result as string) as Board & {
        total: number;
        offset: number;
        nextOffset: number | null;
      };
      expect(page.total).toBe(5);
      expect(page.offset).toBe(offset);
      if (page.nextOffset !== null)
        expect(page.nextOffset).toBeGreaterThan(offset);
      collected.push(...page.elements);
      offset = page.nextOffset;
    }
    expect(collected).toEqual(strokes);
    const cli = await harness.behavior.runCli([
      "read",
      "--thread",
      "thread-a",
      "--offset",
      "4",
      "--json",
    ]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      total: 5,
      offset: 4,
      nextOffset: null,
      elements: [strokes[4]],
    });
    expect(Buffer.byteLength(cli.stdout)).toBeLessThan(401_000);
  });

  it("exports through the owning thread's storage host", async () => {
    const { harness } = setup({
      sdk: {
        threads: {
          storageLocation: async () => ({
            hostId: "host-remote",
            storageRootPath: "/remote/thread-storage/thread-a",
          }),
        },
        files: { write: (async () => ({ outcome: "written" })) as never },
      },
    });
    const result = await harness.behavior.runCli([
      "export",
      "--thread",
      "thread-a",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const [[write]] = harness.inspection.sdk.callsTo("files.write") as [
      {
        hostId: string;
        rootPath: string;
        path: string;
        contentEncoding: string;
        content: string;
      },
    ][];
    expect(write).toMatchObject({
      hostId: "host-remote",
      rootPath: "/remote/thread-storage/thread-a",
      contentEncoding: "base64",
    });
    expect(write.path).toMatch(
      /^\/remote\/thread-storage\/thread-a\/canvas-exports\/.+\.png$/,
    );
    expect(pngSize(Buffer.from(write.content, "base64"))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("sends outlined areas to the thread with their comments, positions, and an image of the board", async () => {
    const send = vi.fn(async () => ({}));
    const { harness, update, upload } = setup({
      sdk: {
        threads: {
          storageLocation: async () => ({
            hostId: "host-remote",
            storageRootPath: "/remote/thread-storage/thread-a",
          }),
          get: (async () => ({ projectId: "project-a" })) as never,
          send: send as never,
        },
        projects: {
          attachments: {
            upload: (async () => ({ path: "canvas-feedback.png" })) as never,
          },
        },
      },
    });
    await expect(
      harness.behavior.callRpc("sendCanvasFeedback", { threadId: "thread-a" }),
    ).rejects.toThrow("Outline an area");
    const asset = await upload((await samplePng()).toString("base64"));
    const mark = (id: string, x: number, text: string): CanvasElement => ({
      id,
      type: "mark",
      x,
      y: 10,
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      color: "#e5484d",
      strokeWidth: 2,
      text,
    });
    await update(
      patch(
        picture("image", asset.id),
        mark("first", 10, "Make this bigger"),
        mark("second", 200, ""),
      ),
    );
    await expect(
      harness.behavior.callRpc("sendCanvasFeedback", { threadId: "thread-a" }),
    ).resolves.toEqual({ ids: ["first", "second"] });
    const [[upload_]] = harness.inspection.sdk.callsTo(
      "projects.attachments.upload",
    ) as [{ projectId: string; clientFile: Uint8Array; filename: string }][];
    expect(upload_).toMatchObject({
      projectId: "project-a",
      mimeType: "image/png",
    });
    expect(upload_.filename).toMatch(/^canvas-feedback-\d+\.png$/);
    const content = Buffer.from(upload_.clientFile);
    // The board spans x -24…235 and y -24…54 with its 24-unit margin.
    expect(pngSize(content)).toEqual({ width: 259, height: 78 });
    expect(send).toHaveBeenCalledWith({
      threadId: "thread-a",
      mode: "auto",
      input: [
        {
          type: "text",
          mentions: [],
          text: "Canvas feedback (2 comments)\n\n1. Make this bigger\n2. (no comment)",
        },
        {
          type: "text",
          mentions: [],
          visibility: "agent-only",
          text: expect.stringContaining(
            '1. in the attached image x 33, y 33, 12 × 12 px; over image "sample.png" at 23–53% from its left and 30–70% from its top; canvas units x 9, y 9, 12 × 12.\n2. in the attached image x 223, y 33, 12 × 12 px; canvas units x 199, y 9, 12 × 12.',
          ),
        },
        { type: "localImage", path: "canvas-feedback.png" },
      ],
    });
    const png = PNG.sync.read(content);
    // The numbered pin sits on the outline's top-left corner.
    expect(pixel(png, 33 - 8, 33)).toEqual([229, 72, 77, 255]);
  });

  it("captures the exact Browser tab on its owning desktop host", async () => {
    // BB 0.46 names a Browser tab `browser:<id>:<environment>`.
    const tabId = "browser:IerUSsiWilmHE7CfYs_Gu:env_iihkzqcd2i";
    const { harness } = setup({
      sdk: {
        hosts: { list: async () => [makeHostResponse({ id: "desktop-host" })] },
        experimental_desktopBrowsers: {
          listInstances: async () => ({
            instances: [
              {
                hostId: "desktop-host",
                instanceId: "instance",
                generation: "generation",
                label: "Desktop",
              },
            ],
          }),
          listTabs: (async () => ({
            tabs: [{ tabId, threadId: "thread-a" }],
          })) as never,
          captureTab: async () => ({
            base64: "jpeg",
            mimeType: "image/jpeg",
            width: 800,
            height: 600,
          }),
        },
      },
    });
    expect(
      await harness.behavior.callRpc("captureCanvasTab", {
        threadId: "thread-a",
        tabId,
      }),
    ).toMatchObject({ width: 800, height: 600 });
    expect(
      harness.inspection.sdk.callsTo("experimental_desktopBrowsers.captureTab"),
    ).toEqual([
      [
        {
          hostId: "desktop-host",
          instanceId: "instance",
          generation: "generation",
          threadId: "thread-a",
          tabId,
        },
      ],
    ]);
  });
});
