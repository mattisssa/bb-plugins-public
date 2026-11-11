import { MAX_IMAGE_BYTES, type Bounds } from "./model";

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This image could not be opened."));
    image.src = url;
  });
}
export function imagePng(
  image: HTMLImageElement,
  region: Bounds = {
    x: 0,
    y: 0,
    width: image.naturalWidth,
    height: image.naturalHeight,
  },
): string {
  const scale = Math.min(1, 2400 / Math.max(region.width, region.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.width * scale));
  canvas.height = Math.max(1, Math.round(region.height * scale));
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Image editing is unavailable in this browser.");
  context.drawImage(
    image,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const base64 = canvas.toDataURL("image/png").split(",")[1]!;
  if ((base64.length * 3) / 4 > MAX_IMAGE_BYTES)
    throw new Error("This image is too large. Use a smaller screenshot.");
  return base64;
}
export async function imageData(file: Blob): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG, WebP, GIF, or AVIF image.");
  if (file.size > 30 * 1024 * 1024)
    throw new Error("Choose an image smaller than 30 MB.");
  const url = URL.createObjectURL(file);
  try {
    return imagePng(await loadImage(url));
  } finally {
    URL.revokeObjectURL(url);
  }
}
