// Project icons — backend. Owns the icon table, resolves icons for projects
// that have none (repo icon → deterministic emoji → nothing when the name
// already starts with an emoji), and exposes the RPC the sidebar overlay uses.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isIconShaped, pickEmoji, pngDimensions, rankIconCandidates, startsWithEmoji } from "./lib/detect";

export const CHANNEL = "icons";
const MAX_AUTO_IMAGE_BYTES = 1_500_000;
const MAX_UPLOAD_CHARS = 600_000; // data URL of a 128px PNG is far below this
const SWEEP_INTERVAL_MS = 60_000;

const iconKind = z.enum(["image", "emoji", "none"]);
const iconRow = z.object({
  projectId: z.string(),
  kind: iconKind,
  data: z.string(),
  source: z.enum(["manual", "auto"]),
});
export type IconRow = z.infer<typeof iconRow>;

export const rpcContract = defineRpcContract({
  list: { input: z.null(), output: z.object({ icons: z.array(iconRow) }) },
  set: {
    input: z
      .object({
        projectId: z.string().min(1),
        kind: z.enum(["image", "emoji"]),
        data: z.string().min(1).max(MAX_UPLOAD_CHARS),
      })
      .strict(),
    output: z.object({ icon: iconRow }),
  },
  remove: { input: z.object({ projectId: z.string().min(1) }).strict(), output: z.object({ ok: z.literal(true) }) },
  redetect: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ icon: iconRow, found: z.boolean() }),
  },
  resolveMissing: { input: z.null(), output: z.object({ resolved: z.number() }) },
});

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ico: "image/x-icon",
};

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS project_icons (
      project_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('image','emoji','none')),
      data TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual','auto')),
      updated_at INTEGER NOT NULL
    )`,
  ]);

  const selectAll = db.prepare<[], IconRow>(
    `SELECT project_id AS projectId, kind, data, source FROM project_icons`,
  );
  const selectOne = db.prepare<[string], IconRow>(
    `SELECT project_id AS projectId, kind, data, source FROM project_icons WHERE project_id = ?`,
  );
  const upsert = db.prepare<[string, string, string, string, number]>(
    `INSERT INTO project_icons (project_id, kind, data, source, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET kind = excluded.kind, data = excluded.data,
       source = excluded.source, updated_at = excluded.updated_at`,
  );

  function write(row: IconRow): IconRow {
    upsert.run(row.projectId, row.kind, row.data, row.source, Date.now());
    return row;
  }

  function notify() {
    bb.realtime.publish(CHANNEL, { at: Date.now() });
  }

  async function projectPath(projectId: string): Promise<{ hostId: string; path: string } | null> {
    const project = await bb.sdk.projects.get({ projectId }).catch(() => null);
    const sources = project?.sources ?? [];
    const src = sources.find((s) => s.isDefault) ?? sources[0];
    return src === undefined ? null : { hostId: src.hostId, path: src.path };
  }

  /** Looks for an app icon inside the project folder; null when none qualifies. */
  async function detectImage(projectId: string): Promise<string | null> {
    const root = await projectPath(projectId);
    if (root === null) return null;
    // listPaths caps at 10k entries, so query the few names an icon can carry
    // instead of walking the whole tree.
    const relPaths = new Set<string>();
    for (const query of ["icon", "logo", "favicon", "appiconset"]) {
      try {
        const listing = await bb.sdk.files.listPaths({
          hostId: root.hostId,
          path: root.path,
          query,
          includeFiles: true,
          includeDirectories: false,
          includeHidden: false,
          limit: 2000,
        });
        for (const entry of listing.paths) relPaths.add(entry.path);
      } catch (error) {
        bb.log.warn(`listPaths failed for ${projectId} at ${root.path} (${query}): ${String(error)}`);
        return null;
      }
    }
    const sep = root.path.includes("\\") ? "\\" : "/";
    for (const rel of rankIconCandidates([...relPaths]).slice(0, 5)) {
      try {
        const file = await bb.sdk.files.read({ hostId: root.hostId, path: `${root.path}${sep}${rel}`, rootPath: root.path });
        if (file.sizeBytes > MAX_AUTO_IMAGE_BYTES) continue;
        const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
        const mime = file.mimeType ?? MIME_BY_EXT[ext] ?? "application/octet-stream";
        const bytes =
          file.contentEncoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
        if (!isIconShaped(pngDimensions(bytes))) continue; // banners and wordmarks are not icons
        return `data:${mime};base64,${bytes.toString("base64")}`;
      } catch (error) {
        bb.log.warn(`icon read failed for ${projectId} (${rel}): ${String(error)}`);
      }
    }
    return null;
  }

  /**
   * Auto-resolution for one project; returns the row it wrote. A name that
   * already starts with an emoji ("🧪 playground") is its own marker, so
   * the sweep leaves it alone; an explicit "Find in project folder" still searches.
   */
  async function resolve(projectId: string, name: string, explicit: boolean): Promise<{ row: IconRow; found: boolean }> {
    const marked = startsWithEmoji(name);
    if (marked && !explicit) return { row: write({ projectId, kind: "none", data: "", source: "auto" }), found: false };
    const image = await detectImage(projectId);
    if (image !== null) return { row: write({ projectId, kind: "image", data: image, source: "auto" }), found: true };
    if (marked) return { row: write({ projectId, kind: "none", data: "", source: "auto" }), found: false };
    return { row: write({ projectId, kind: "emoji", data: pickEmoji(projectId), source: "auto" }), found: false };
  }

  let sweeping: Promise<number> | null = null;
  function resolveMissing(): Promise<number> {
    if (sweeping !== null) return sweeping;
    sweeping = (async () => {
      let resolved = 0;
      try {
        const projects = await bb.sdk.projects.list();
        for (const project of projects) {
          if (selectOne.get(project.id) !== undefined) continue;
          await resolve(project.id, project.name, false);
          resolved += 1;
          bb.log.info(`auto icon for ${project.id} (${project.name})`);
        }
      } catch (error) {
        bb.log.warn(`sweep failed: ${String(error)}`);
      } finally {
        sweeping = null;
      }
      if (resolved > 0) notify();
      return resolved;
    })();
    return sweeping;
  }

  bb.rpc.register(rpcContract, {
    list() {
      return { icons: selectAll.all() };
    },
    set({ projectId, kind, data }) {
      if (kind === "image" && !/^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/.test(data)) {
        throw new Error("image must be a base64 data URL");
      }
      if (kind === "emoji" && (data.length > 16 || data.trim() === "")) throw new Error("emoji is too long");
      const icon = write({ projectId, kind, data: data.trim(), source: "manual" });
      notify();
      return { icon };
    },
    remove({ projectId }) {
      write({ projectId, kind: "none", data: "", source: "manual" });
      notify();
      return { ok: true as const };
    },
    async redetect({ projectId }) {
      const project = await bb.sdk.projects.get({ projectId });
      const result = await resolve(projectId, project.name, true);
      notify();
      return { icon: result.row, found: result.found };
    },
    async resolveMissing() {
      return { resolved: await resolveMissing() };
    },
  });

  bb.background.service("sweep", {
    async start(signal) {
      while (!signal.aborted) {
        await resolveMissing();
        await new Promise<void>((done) => {
          const timer = setTimeout(done, SWEEP_INTERVAL_MS);
          signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
        });
      }
    },
  });

  bb.log.info("loaded");
}
