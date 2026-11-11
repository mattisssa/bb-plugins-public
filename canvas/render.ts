import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { layoutSticky } from "./layout";
import {
  arrowPath,
  boundsOf,
  drawPath,
  contentBounds,
  imageViewport,
  isTextElement,
  type CanvasElement,
  type Bounds,
} from "./model";

const require = createRequire(import.meta.url);
let rendererReady: Promise<void> | undefined;
let font: Promise<Buffer> | undefined;
export const fontBytes = () =>
  (font ??= readFile(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf")));
const escape = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    );
// The exported region in canvas units and its pixels per canvas unit.
export function boardFrame(elements: CanvasElement[], region?: Bounds) {
  const box = region ?? contentBounds(elements, 24);
  return { box, scale: Math.min(1, 2400 / Math.max(box.width, box.height)) };
}
export function boardSvg(
  elements: CanvasElement[],
  image: (assetId: string) => string,
  region?: Bounds,
): string {
  const { box, scale } = boardFrame(elements, region);
  const assets = [
    ...new Set(
      elements.flatMap((e) => (e.type === "image" ? [e.assetId] : [])),
    ),
  ];
  const imageDefinitions = assets
    .map(
      (id, index) =>
        `<image id="asset-${index}" width="1" height="1" preserveAspectRatio="none" href="${escape(image(id))}"/>`,
    )
    .join("");
  const clips = elements
    .map((element, index) =>
      element.type === "image" && element.crop
        ? `<clipPath id="crop-${index}" clipPathUnits="userSpaceOnUse"><rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}"/></clipPath>`
        : "",
    )
    .join("");
  const shapes = elements
    .map((e, index) => {
      if (e.type === "image") {
        const view = imageViewport(e);
        const source = `<use href="#asset-${assets.indexOf(e.assetId)}" transform="translate(${view.x} ${view.y}) scale(${view.width} ${view.height})"/>`;
        return e.crop
          ? `<g clip-path="url(#crop-${index})">${source}</g>`
          : source;
      }
      if (isTextElement(e)) {
        const layout = e.type === "sticky" ? layoutSticky(e) : null;
        const padding = layout?.padding ?? 0;
        const fontSize = layout?.fontSize ?? e.fontSize;
        const lineHeight = layout?.lineHeight ?? e.fontSize * 1.3;
        const lines = layout?.lines ?? e.text.split("\n");
        const background =
          e.type === "sticky"
            ? `<rect x="${e.x + 0.5}" y="${e.y + 0.5}" width="${Math.max(0, e.width - 1)}" height="${Math.max(0, e.height - 1)}" rx="${padding / 2}" fill="${e.background}" stroke="#242424" stroke-opacity="0.12"/>`
            : "";
        const features = layout
          ? ` style="font-kerning:none;font-variant-ligatures:none;font-feature-settings:'kern' 0,'liga' 0"`
          : "";
        return `${background}<text x="${e.x + padding}" y="${e.y + padding}" font-family="DejaVu Sans" font-size="${fontSize}" fill="${e.color}" xml:space="preserve"${features}>${lines
          .map(
            (line, i) =>
              `<tspan x="${e.x + padding}" y="${e.y + padding + fontSize + i * lineHeight}">${escape(line)}</tspan>`,
          )
          .join("")}</text>`;
      }
      const path = e.type === "arrow" ? arrowPath(e) : drawPath(e);
      return `<path transform="translate(${e.x} ${e.y})" d="${path}" stroke="${e.color}" stroke-width="${e.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  // Numbered pins keep a constant size in the exported pixels.
  const pin = 13 / scale;
  let number = 0;
  const pins = elements
    .map((e) => {
      if (e.type !== "mark") return "";
      const bounds = boundsOf(e);
      number += 1;
      return `<circle cx="${bounds.x}" cy="${bounds.y}" r="${pin}" fill="${e.color}" stroke="#ffffff" stroke-width="${2 / scale}"/><text x="${bounds.x}" y="${bounds.y + pin * 0.4}" text-anchor="middle" font-family="DejaVu Sans" font-size="${pin * 1.1}" fill="#ffffff">${number}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.ceil(box.width * scale))}" height="${Math.max(1, Math.ceil(box.height * scale))}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}"><defs>${imageDefinitions}${clips}</defs><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#ffffff"/>${shapes}${pins}</svg>`;
}
export async function rasterize(svg: string): Promise<Uint8Array> {
  rendererReady ??= readFile(
    require.resolve("@resvg/resvg-wasm/index_bg.wasm"),
  ).then((bytes) => initWasm(bytes));
  await rendererReady;
  const renderer = new Resvg(svg, {
    font: {
      fontBuffers: [await fontBytes()],
      defaultFontFamily: "DejaVu Sans",
    },
  });
  try {
    const rendered = renderer.render();
    try {
      return rendered.asPng();
    } finally {
      rendered.free();
    }
  } finally {
    renderer.free();
  }
}
