// Pure icon-detection logic shared by the server. No bb imports so it stays
// unit-testable with `node --test`.

const IMAGE_EXT = /\.(png|svg|webp|jpg|jpeg|ico)$/i;
// Paths that are documentation, test fixtures, or build output never count.
const NOISE =
  /(^|\/)(docs?|references?|screenshots?|fixtures?|tests?|__tests__|spec|examples?|samples?|storybook|public\/images|img|build|dist|out|\.build|deriveddata|sourcepackages|checkouts|pods|vendor|third[-_]party|generated)(\/|$)/i;
const MAX_DEPTH = 7;

/** True when the name starts with an emoji (e.g. "🧪 playground"). */
export function startsWithEmoji(name: string): boolean {
  return /^\p{Extended_Pictographic}/u.test(name);
}

const EMOJI_SET = [
  "🚀", "🧩", "🔧", "🧪", "📦", "🛰️", "🧭", "🎯", "🪄", "🧱",
  "🔮", "🌱", "🍀", "🔥", "⚡️", "🌊", "🪐", "🎲", "🎨", "🧬",
  "🛠️", "🗺️", "📡", "🧲", "🪁", "🦊", "🐙", "🦉", "🐝", "🦄",
  "🍋", "🍉", "🥑", "🌵", "🏔️", "🎸", "🎧", "📚", "✈️", "⛵️",
];

/** Deterministic "random" emoji: same project id → same emoji across restarts. */
export function pickEmoji(projectId: string): string {
  let h = 2166136261;
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return EMOJI_SET[h % EMOJI_SET.length]!;
}

function sizeHint(base: string): number {
  // "icon-512.png", "icon_256x256.png", "icon-1024.png" → the largest number found.
  let best = 0;
  for (const m of base.matchAll(/(\d{2,4})/g)) best = Math.max(best, Number(m[1]));
  return best;
}

function score(relPath: string): number | null {
  const lower = relPath.toLowerCase();
  if (!IMAGE_EXT.test(lower) || NOISE.test(lower)) return null;
  const depth = lower.split("/").length - 1;
  if (depth > MAX_DEPTH) return null;
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  let s: number | null = null;

  if (lower.includes(".appiconset/") && base.endsWith(".png")) s = 1000;
  else if (/\.icon\/.*\.(png|svg)$/.test(lower)) s = 450; // Icon Composer bundle layer
  else if (/^icon-maskable/.test(base)) s = 500;
  else if (/^icon[-_]?\d/.test(base)) s = 800; // icon-512.png, icon_256x256.png
  else if (/^apple-touch-icon/.test(base)) s = 700;
  else if (/^(app)?icon\.(png|svg|webp)$/.test(base)) s = 650; // resources/icon.png
  else if (/^favicon[-_]?\d/.test(base)) s = 400; // favicon-96.png
  else if (/^favicon\.(png|svg|webp)$/.test(base)) s = 350;
  else if (/^favicon\.ico$/.test(base)) s = 100;
  else if (/(^|[-_])(app[-_]?icon|logo)([-_]|\.)/.test(base) && !lower.includes("sticker")) s = 300;
  else if (/icon/.test(base) && base.endsWith(".png")) s = 200;
  if (s === null) return null;

  // Larger named sizes are sharper; shallower paths are more likely the app's own.
  s += Math.min(sizeHint(base), 1024) / 1024 * 50;
  s -= depth * 3;
  if (base.endsWith(".svg")) s -= 5; // raster first; svg still fine
  if (/dark/.test(base)) s -= 1; // prefer the light variant when both exist
  return s;
}

/** Width/height of a PNG from its IHDR chunk; null for anything else. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** App icons are square; a 4000×1000 banner named logo.png is not one. */
export function isIconShaped(dim: { width: number; height: number } | null): boolean {
  if (dim === null) return true; // unknown format: trust the filename
  if (dim.width === 0 || dim.height === 0) return false;
  const ratio = dim.width / dim.height;
  return ratio >= 0.8 && ratio <= 1.25;
}

/** Project-relative image paths that look like an app icon, best first. */
export function rankIconCandidates(relPaths: readonly string[]): string[] {
  const scored: Array<[string, number]> = [];
  for (const p of relPaths) {
    const s = score(p);
    if (s !== null) scored.push([p, s]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return scored.map(([p]) => p);
}
