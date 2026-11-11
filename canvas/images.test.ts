// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageData, imagePng } from "./images";
import { MAX_IMAGE_BYTES } from "./model";

const drawImage = vi.fn();
let output: { width: number; height: number };

function source(width: number, height: number) {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    naturalWidth: { value: width },
    naturalHeight: { value: height },
  });
  return image;
}

beforeEach(() => {
  drawImage.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    function (this: HTMLCanvasElement, type) {
      expect(type).toBe("image/png");
      output = { width: this.width, height: this.height };
      return "data:image/png;base64,aW1hZ2U=";
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared image rasterization", () => {
  it.each([
    [80, 60, 80, 60],
    [4000, 3000, 2400, 1800],
    [3000, 4000, 1800, 2400],
    [10_000, 1, 2400, 1],
  ])(
    "fits a %s × %s image without upscaling or zero-sized output",
    (width, height, targetWidth, targetHeight) => {
      const image = source(width, height);
      expect(imagePng(image)).toBe("aW1hZ2U=");
      expect(output).toEqual({ width: targetWidth, height: targetHeight });
      expect(drawImage).toHaveBeenCalledWith(
        image,
        0,
        0,
        width,
        height,
        0,
        0,
        targetWidth,
        targetHeight,
      );
    },
  );

  it("uses source-pixel coordinates and sizes the crop independently of the full screenshot", () => {
    const image = source(6000, 4000);
    imagePng(image, { x: 120, y: 90, width: 3000, height: 1500 });
    expect(output).toEqual({ width: 2400, height: 1200 });
    expect(drawImage).toHaveBeenCalledWith(
      image,
      120,
      90,
      3000,
      1500,
      0,
      0,
      2400,
      1200,
    );
  });

  it("rejects oversized encoded PNGs before upload for full images and crops", () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue(
      "data:image/png;base64," +
        "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4),
    );
    const image = source(3000, 2000);
    expect(() => imagePng(image)).toThrow(/image is too large/i);
    expect(() =>
      imagePng(image, { x: 1, y: 2, width: 20, height: 30 }),
    ).toThrow(/image is too large/i);
  });

  it.each([false, true])(
    "releases imported file URLs when rasterization fails: %s",
    async (fail) => {
      const image = source(4000, 3000);
      vi.stubGlobal("Image", function () {
        queueMicrotask(() => image.dispatchEvent(new Event("load")));
        return image;
      });
      const createObjectURL = vi.fn(() => "blob:imported-image");
      const revokeObjectURL = vi.fn();
      vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
      if (fail)
        vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
      const file = new Blob(["image"], { type: "image/png" });
      const pending = imageData(file);
      if (fail) await expect(pending).rejects.toThrow(/unavailable/i);
      else {
        await expect(pending).resolves.toBe("aW1hZ2U=");
        expect(output).toEqual({ width: 2400, height: 1800 });
      }
      expect(createObjectURL).toHaveBeenCalledWith(file);
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
        "blob:imported-image",
      );
    },
  );
});
