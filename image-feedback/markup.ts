// No runtime import of ./shared here: it would pull the server SDK into the page.
/** Largest side of the marked-up image the page sends, in pixels. */
const MAX_SIDE = 2000;

/** A freehand outline in the pixels of the original image, and its comment. */
export type Mark = { id: string; points: [number, number][]; text: string };
export type Picture = { bitmap: ImageBitmap; name: string; url: string };

export const COLOR = "#e5484d";

export function boundsOf(mark: Pick<Mark, "points">) {
  const xs = mark.points.map(([x]) => x),
    ys = mark.points.map(([, y]) => y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("The image could not be encoded."));
    reader.readAsDataURL(blob);
  });

/**
 * The original image with every outline and its number drawn on it, at most
 * `MAX_SIDE` pixels on its longer side. `screenScale` is how large the user
 * saw the image, so strokes and pins keep the weight they had on screen.
 */
export async function markUp(
  bitmap: ImageBitmap,
  marks: Mark[],
  screenScale: number,
) {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // Screen pixels to pixels of this copy.
  const unit = Math.max(1, scale / screenScale);
  context.lineJoin = context.lineCap = "round";
  context.lineWidth = 3 * unit;
  context.strokeStyle = COLOR;
  for (const mark of marks) {
    context.beginPath();
    mark.points.forEach(([x, y], index) =>
      index
        ? context.lineTo(x * scale, y * scale)
        : context.moveTo(x * scale, y * scale),
    );
    // A single point still shows, as a dot.
    if (mark.points.length === 1)
      context.lineTo(mark.points[0]![0] * scale, mark.points[0]![1] * scale);
    context.stroke();
  }
  const radius = 11 * unit;
  context.font = `600 ${12 * unit}px -apple-system, "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  marks.forEach((mark, index) => {
    const box = boundsOf(mark);
    // Keep the whole pin inside the image at its edges.
    const x = Math.min(
      canvas.width - radius - 2 * unit,
      Math.max(radius + 2 * unit, box.x * scale),
    );
    const y = Math.min(
      canvas.height - radius - 2 * unit,
      Math.max(radius + 2 * unit, box.y * scale),
    );
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = COLOR;
    context.fill();
    context.lineWidth = 2 * unit;
    context.strokeStyle = "#ffffff";
    context.stroke();
    context.fillStyle = "#ffffff";
    context.fillText(String(index + 1), x, y + 0.5 * unit);
  });
  const encode = (type: "image/png" | "image/jpeg") =>
    new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("The image could not be encoded.")),
        type,
        0.9,
      ),
    );
  let mimeType: "image/png" | "image/jpeg" = "image/png";
  let blob = await encode(mimeType);
  // Photos make huge PNGs; a JPEG keeps them under the upload limit.
  if (blob.size > 6 * 1024 * 1024) {
    mimeType = "image/jpeg";
    blob = await encode(mimeType);
  }
  return {
    base64: await base64(blob),
    mimeType,
    width: canvas.width,
    height: canvas.height,
  };
}
