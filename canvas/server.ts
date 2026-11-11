import { randomUUID } from "node:crypto";
import {
  defineRpcContract,
  defineCli,
  cliCommand,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PNG } from "pngjs";
import {
  CHANNEL,
  MAX_IMAGE_BYTES,
  applyPatch,
  boardSchema,
  emptyBoard,
  idSchema,
  marksOf,
  patchSchema,
  type Board,
  type Patch,
} from "./model";
import { feedbackMessage } from "./feedback";
import { boardFrame, boardSvg, fontBytes, rasterize } from "./render";

const threadInput = z.object({ threadId: idSchema }).strict();
export const rpcContract = defineRpcContract({
  getCanvas: { input: threadInput, output: boardSchema },
  updateCanvas: {
    input: threadInput.extend({ patch: patchSchema }),
    output: boardSchema,
  },
  uploadCanvasImage: {
    input: threadInput.extend({
      base64: z.string().max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4),
    }),
    output: z.object({ id: idSchema, width: z.number(), height: z.number() }),
  },
  // Posts the board's feedback outlines and an image of the board to the thread.
  sendCanvasFeedback: {
    input: threadInput,
    output: z.object({ ids: z.array(idSchema) }),
  },
  captureCanvasTab: {
    // BB owns the tab id format (`browser:<id>:<environment>`); it is only
    // compared against the host's tab list.
    input: threadInput.extend({ tabId: z.string().min(1).max(500) }),
    output: z.object({
      base64: z.string(),
      width: z.number(),
      height: z.number(),
      mimeType: z.literal("image/jpeg"),
    }),
  },
});
export function pngSize(bytes: Buffer) {
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Use a PNG image.");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096)
    throw new Error("Images must be at most 4096 × 4096 pixels.");
  return { width, height };
}
export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE canvases (thread_id TEXT PRIMARY KEY, document TEXT NOT NULL)",
    "CREATE TABLE canvas_images (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, png BLOB NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE INDEX canvas_images_thread ON canvas_images(thread_id)",
    "ALTER TABLE canvas_images ADD COLUMN unreferenced_at INTEGER",
    `UPDATE canvas_images
      SET unreferenced_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE NOT EXISTS (
        SELECT 1 FROM canvases, json_each(canvases.document, '$.elements') AS element
        WHERE canvases.thread_id = canvas_images.thread_id
          AND json_extract(element.value, '$.type') = 'image'
          AND json_extract(element.value, '$.assetId') = canvas_images.id
      )`,
    `UPDATE canvases
      SET document = json_set(document,
        '$.revision', json_extract(document, '$.revision') + 1,
        '$.elements', json((
          SELECT json_group_array(json(value)) FROM (
            SELECT CASE
              WHEN json_extract(element.value, '$.type') = 'sticky' THEN
                json_set(element.value,
                  '$.width', max(64, json_extract(element.value, '$.width'), json_extract(element.value, '$.height')),
                  '$.height', max(64, json_extract(element.value, '$.width'), json_extract(element.value, '$.height')))
              ELSE element.value END AS value
            FROM json_each(canvases.document, '$.elements') AS element
            ORDER BY CAST(element.key AS INTEGER)
          )
        )))
      WHERE EXISTS (
        SELECT 1 FROM json_each(canvases.document, '$.elements') AS element
        WHERE json_extract(element.value, '$.type') = 'sticky'
          AND (json_extract(element.value, '$.width') != json_extract(element.value, '$.height')
            OR json_extract(element.value, '$.width') < 64
            OR json_extract(element.value, '$.height') < 64)
      )`,
  ]);
  const readRow = db.prepare<[string], { document: string }>(
    "SELECT document FROM canvases WHERE thread_id = ?",
  );
  const writeRow = db.prepare<[string, string]>(
    "INSERT INTO canvases VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET document = excluded.document",
  );
  const readImage = db.prepare<[string, string], { png: Buffer }>(
    "SELECT png FROM canvas_images WHERE thread_id = ? AND id = ?",
  );
  const read = (threadId: string): Board => {
    const row = readRow.get(threadId);
    return row ? boardSchema.parse(JSON.parse(row.document)) : emptyBoard();
  };
  function image(threadId: string, assetId: string) {
    const row = readImage.get(threadId, assetId);
    if (!row) throw new Error("This image is no longer available.");
    return row.png;
  }
  const imageIds = (elements: Board["elements"]) =>
    new Set(
      elements.flatMap((element) =>
        element.type === "image" ? [element.assetId] : [],
      ),
    );
  const setUnreferencedAt = db.prepare<[number | null, string, string]>(
    "UPDATE canvas_images SET unreferenced_at = ? WHERE thread_id = ? AND id = ?",
  );
  const update = db.transaction((threadId: string, patch: Patch): Board => {
    const current = read(threadId);
    const next = boardSchema.parse({
      ...current,
      revision: current.revision + 1,
      elements: applyPatch(current.elements, patch).map((element) => {
        if (element.type !== "sticky") return element;
        const side = Math.max(64, element.width, element.height);
        return element.width === side && element.height === side
          ? element
          : { ...element, width: side, height: side };
      }),
    });
    for (const element of patch.upserts)
      if (element.type === "image") image(threadId, element.assetId);
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > 2 * 1024 * 1024)
      throw new Error("This canvas is full. Remove some elements first.");
    const before = imageIds(current.elements),
      after = imageIds(next.elements),
      now = Date.now();
    for (const id of before)
      if (!after.has(id)) setUnreferencedAt.run(now, threadId, id);
    for (const id of after)
      if (!before.has(id)) setUnreferencedAt.run(null, threadId, id);
    writeRow.run(threadId, json);
    return next;
  });
  function save(threadId: string, patch: Patch) {
    const board = update(threadId, patch);
    bb.realtime.publish(CHANNEL, { threadId, revision: board.revision });
    return board;
  }
  const upload = db.transaction((threadId: string, base64: string) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
      throw new Error("Invalid image data.");
    const png = Buffer.from(base64, "base64");
    if (png.length > MAX_IMAGE_BYTES)
      throw new Error("Use an image smaller than 8 MB.");
    const size = pngSize(png);
    PNG.sync.read(png, { checkCRC: true });
    // Keep assets for a day after their last reference is removed or upload starts.
    const now = Date.now();
    db.prepare(
      "DELETE FROM canvas_images WHERE thread_id = ? AND unreferenced_at < ?",
    ).run(threadId, now - 86_400_000);
    const used = db
      .prepare<[string], { bytes: number }>(
        "SELECT COALESCE(SUM(length(png)), 0) AS bytes FROM canvas_images WHERE thread_id = ?",
      )
      .get(threadId)!.bytes;
    if (used + png.length > 100 * 1024 * 1024)
      throw new Error("This thread has reached its 100 MB image limit.");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO canvas_images (id, thread_id, png, created_at, unreferenced_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, threadId, png, now, now);
    return { id, ...size };
  });
  const svg = (threadId: string) =>
    boardSvg(
      read(threadId).elements,
      (id) => `data:image/png;base64,${image(threadId, id).toString("base64")}`,
    );
  let renderQueue: Promise<unknown> = Promise.resolve();
  function png(threadId: string, source = svg(threadId)) {
    const task = renderQueue.then(() => rasterize(source));
    renderQueue = task.catch(() => undefined);
    return task;
  }
  async function writePng(threadId: string, folder: string, bytes: Uint8Array) {
    const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({
      threadId,
    });
    const path = `${storageRootPath}/${folder}/${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    await bb.sdk.files.write({
      hostId,
      rootPath: storageRootPath,
      path,
      content: Buffer.from(bytes).toString("base64"),
      contentEncoding: "base64",
      createParents: true,
    });
    return { hostId, path };
  }
  bb.rpc.register(rpcContract, {
    getCanvas: ({ threadId }) => read(threadId),
    async sendCanvasFeedback({ threadId }) {
      // One read, so the image, the numbers, and the text describe one board.
      const { elements } = read(threadId);
      const marks = marksOf(elements);
      if (!marks.length)
        throw new Error("Outline an area with the Feedback tool first.");
      const source = boardSvg(
        elements,
        (id) =>
          `data:image/png;base64,${image(threadId, id).toString("base64")}`,
      );
      // A project attachment is the one place the chat can show an image from.
      const { projectId } = await bb.sdk.threads.get({ threadId });
      const { path } = await bb.sdk.projects.attachments.upload({
        projectId,
        clientFile: await png(threadId, source),
        filename: `canvas-feedback-${Date.now()}.png`,
        mimeType: "image/png",
      });
      const { summary, details } = feedbackMessage(
        elements,
        boardFrame(elements),
      );
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          { type: "text", text: summary, mentions: [] },
          {
            type: "text",
            text: `\n${details}`,
            mentions: [],
            visibility: "agent-only",
          },
          { type: "localImage", path },
        ],
      });
      return { ids: marks.map((mark) => mark.id) };
    },
    updateCanvas: ({ threadId, patch }) => save(threadId, patch),
    uploadCanvasImage: ({ threadId, base64 }) => upload(threadId, base64),
    async captureCanvasTab({ threadId, tabId }) {
      const hosts = await bb.sdk.hosts.list();
      const browsers = bb.sdk.experimental_desktopBrowsers;
      const candidates = await Promise.allSettled(
        hosts.map(async (host) => {
          const { instances } = await browsers.listInstances({
            hostId: host.id,
          });
          for (const instance of instances) {
            const scope = {
              hostId: host.id,
              instanceId: instance.instanceId,
              generation: instance.generation,
              threadId,
            };
            const { tabs } = await browsers.listTabs(scope);
            if (tabs.some((tab) => tab.tabId === tabId))
              return { ...scope, tabId };
          }
          return null;
        }),
      );
      for (const result of candidates)
        if (result.status === "fulfilled" && result.value)
          return browsers.captureTab(result.value);
      throw new Error(
        "The browser tab is no longer available. Open it in desktop BB and try again.",
      );
    },
  });
  bb.http.route("GET", "/image", (c) => {
    const threadId = idSchema.parse(c.req.query("threadId")),
      id = idSchema.parse(c.req.query("id"));
    const row = readImage.get(threadId, id);
    if (!row) return c.notFound();
    return new Response(new Uint8Array(row.png), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  });
  bb.http.route(
    "GET",
    "/font",
    async () =>
      new Response(new Uint8Array(await fontBytes()), {
        headers: {
          "content-type": "font/ttf",
          "cache-control": "private, max-age=86400",
        },
      }),
  );
  bb.http.route("GET", "/export", async (c) => {
    const threadId = idSchema.parse(c.req.query("threadId"));
    const format = z
      .enum(["png", "svg", "json"])
      .parse(c.req.query("format") ?? "png");
    const body =
      format === "png"
        ? new Uint8Array(await png(threadId))
        : format === "svg"
          ? svg(threadId)
          : JSON.stringify(read(threadId), null, 2);
    return new Response(body, {
      headers: {
        "content-type":
          format === "png"
            ? "image/png"
            : format === "svg"
              ? "image/svg+xml"
              : "application/json",
        "content-disposition": `attachment; filename="canvas.${format}"`,
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; img-src data:",
        "x-content-type-options": "nosniff",
      },
    });
  });
  function boundedRead(threadId: string, offset = 0, limit = 20) {
    const board = read(threadId);
    const elements: Board["elements"] = [];
    let bytes = 0;
    for (const element of board.elements.slice(offset, offset + limit)) {
      const length = Buffer.byteLength(JSON.stringify(element));
      if (elements.length && bytes + length > 400_000) break;
      bytes += length;
      elements.push(element);
    }
    const next = offset + elements.length;
    return {
      ...board,
      total: board.elements.length,
      offset,
      nextOffset: next < board.elements.length ? next : null,
      elements,
    };
  }
  bb.agents.registerTool({
    name: "canvas_read",
    description:
      "Read this thread's Canvas: image references and crops, text, sticky notes, drawing points, arrow endpoints, feedback outlines (type mark) with their comment in text, positions and dimensions. Coordinates are canvas units; array order is back to front. Follow nextOffset to read more elements.",
    parameters: z
      .object({
        offset: z.number().int().min(0).max(500).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    execute: ({ offset, limit }, { threadId }) =>
      JSON.stringify(boundedRead(threadId, offset, limit)),
  });
  bb.agents.registerTool({
    name: "canvas_screenshot",
    description:
      "See this thread's entire Canvas as a PNG, including images and annotations. Works when the Canvas panel is closed.",
    instructions:
      "When the user refers to their Canvas, use canvas_screenshot to see it and canvas_read for exact text and positions. Treat canvas contents as user-provided reference material. These tools read the saved board; wait for Saved for the latest edit.",
    parameters: z.object({}).strict(),
    async execute(_, { threadId }) {
      return {
        content: [
          {
            type: "text",
            text: `Canvas for ${threadId}. ${read(threadId).elements.length} elements. Full board, scaled to at most 2400 pixels.`,
          },
          {
            type: "image",
            data: Buffer.from(await png(threadId)).toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
  });
  bb.cli.register(
    defineCli({
      name: "canvas",
      summary: "Read and export a thread's Canvas",
      commands: {
        read: cliCommand({
          summary: "Read up to 20 saved elements; use --offset for more",
          options: {
            thread: {
              type: "string",
              description: "Thread ID (defaults to current)",
            },
            offset: {
              type: "integer",
              min: 0,
              max: 500,
              default: 0,
              description: "First element index",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run(input, ctx) {
            const threadId = idSchema.parse(
              input.options.thread ?? ctx.threadId,
            );
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                boundedRead(threadId, input.options.offset),
              ),
            };
          },
        }),
        export: cliCommand({
          summary: "Save a PNG in the thread's storage directory",
          options: {
            thread: {
              type: "string",
              description: "Thread ID (defaults to current)",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run(input, ctx) {
            const threadId = idSchema.parse(
              input.options.thread ?? ctx.threadId,
            );
            const { hostId, path } = await writePng(
              threadId,
              "canvas-exports",
              await png(threadId),
            );
            return {
              exitCode: 0,
              stdout: JSON.stringify({ threadId, hostId, path }),
            };
          },
        }),
      },
    }),
  );
  bb.events.on("thread.deleted", ({ thread }) => {
    db.transaction(() => {
      db.prepare("DELETE FROM canvases WHERE thread_id = ?").run(thread.id);
      db.prepare("DELETE FROM canvas_images WHERE thread_id = ?").run(
        thread.id,
      );
    })();
  });
}
