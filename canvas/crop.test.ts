import { describe, expect, it } from "vitest";
import { applyCrop, moveCrop, resizeCrop, type CropHandle } from "./crop";
import {
  elementSchema,
  imageViewport,
  type Bounds,
  type ImageElement,
} from "./model";

const picture: ImageElement = {
  id: "picture",
  type: "image",
  assetId: "original-asset",
  name: "Reference.png",
  x: 100,
  y: 80,
  width: 400,
  height: 200,
};
const inset: Bounds = { x: 140, y: 100, width: 240, height: 140 };

function closeBounds(actual: Bounds, expected: Bounds) {
  for (const key of ["x", "y", "width", "height"] as const)
    expect(actual[key]).toBeCloseTo(expected[key], 8);
}

describe("non-destructive image crops", () => {
  it("changes only the visible rectangle while preserving the source mapping and asset", () => {
    const source = Object.freeze({ ...picture });
    const frame = Object.freeze({ ...inset });
    const result = applyCrop(source, frame);
    expect(result).toEqual({
      ...picture,
      ...inset,
      crop: { x: 0.1, y: 0.1, width: 0.6, height: 0.7 },
    });
    expect(source).toEqual(picture);
    expect(frame).toEqual(inset);
    closeBounds(imageViewport(result), picture);
    expect(elementSchema.safeParse(result).success).toBe(true);
  });

  it("permits repeated inset, expansion, and full reset without cumulative scale changes", () => {
    const first = applyCrop(picture, inset);
    const second = applyCrop(first, { x: 200, y: 120, width: 80, height: 80 });
    expect(second.crop).toEqual({ x: 0.25, y: 0.2, width: 0.2, height: 0.4 });
    closeBounds(imageViewport(second), picture);
    const expanded = applyCrop(second, inset);
    closeBounds(expanded, first);
    closeBounds(imageViewport(expanded), picture);
    expect(applyCrop(expanded, imageViewport(expanded))).toEqual(picture);
  });

  it("retains a cropped image's later translation and resize when restoring its source", () => {
    const cropped = applyCrop(picture, inset);
    const transformed = { ...cropped, x: -80, y: 65, width: 480, height: 280 };
    const full = { x: -160, y: 25, width: 800, height: 400 };
    closeBounds(imageViewport(transformed), full);
    const result = applyCrop(transformed, {
      x: -80,
      y: 105,
      width: 400,
      height: 200,
    });
    closeBounds(imageViewport(result), full);
    expect(result.crop).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
    expect(applyCrop(result, full)).toEqual({ ...picture, ...full });
  });

  it("keeps an unchanged crop exactly unchanged and removes explicit full-image crops", () => {
    const cropped = applyCrop(picture, inset);
    expect(applyCrop(cropped, inset)).toBe(cropped);
    expect(applyCrop(picture, imageViewport(picture))).toBe(picture);
    const fullCrop = { ...picture, crop: { x: 0, y: 0, width: 1, height: 1 } };
    expect(applyCrop(fullCrop, imageViewport(fullCrop))).toEqual(picture);
    expect(applyCrop(fullCrop, imageViewport(fullCrop))).not.toHaveProperty(
      "crop",
    );
  });

  it("clamps the draft to the full source before applying it", () => {
    const cropped = applyCrop(picture, inset);
    expect(
      applyCrop(cropped, {
        x: -10_000,
        y: -10_000,
        width: 20_000,
        height: 20_000,
      }),
    ).toEqual(picture);
  });

  it("keeps crop-edge floating point noise inside normalized schema bounds", () => {
    const cropped: ImageElement = {
      ...picture,
      x: 12345.678,
      y: -4567.89,
      width: 123.456,
      height: 78.91,
      crop: {
        x: 0.123456789,
        y: 0.345678912,
        width: 0.456789123,
        height: 0.543210987,
      },
    };
    const full = imageViewport(cropped);
    const result = applyCrop(cropped, {
      x: full.x + full.width - 37.9,
      y: full.y + full.height - 21.1,
      width: 37.9,
      height: 21.1,
    });
    expect(result.crop!.x + result.crop!.width).toBeLessThanOrEqual(1);
    expect(result.crop!.y + result.crop!.height).toBeLessThanOrEqual(1);
    expect(elementSchema.safeParse(result).success).toBe(true);
    closeBounds(imageViewport(result), full);
  });

  it("does not drift after many crop and expansion cycles", () => {
    const source = {
      ...picture,
      x: -73.123,
      y: 9.876,
      width: 321.987,
      height: 109.876,
    };
    let current: ImageElement = source;
    for (let index = 0; index < 80; index++) {
      const left = index % 2 ? 0.13 : 0.37;
      const top = index % 2 ? 0.09 : 0.27;
      current = applyCrop(current, {
        x: source.x + source.width * left,
        y: source.y + source.height * top,
        width: source.width * (1 - left - 0.07),
        height: source.height * (1 - top - 0.11),
      });
      closeBounds(imageViewport(current), source);
      expect(elementSchema.safeParse(current).success).toBe(true);
    }
    const restored = applyCrop(current, imageViewport(current));
    closeBounds(restored, source);
    expect(restored).not.toHaveProperty("crop");
  });
});

describe("crop frame movement", () => {
  it("moves freely and stops at every full-image edge without resizing", () => {
    const cropped = applyCrop(picture, inset);
    expect(moveCrop(cropped, inset, { x: 10, y: -5 })).toEqual({
      ...inset,
      x: 150,
      y: 95,
    });
    expect(moveCrop(cropped, inset, { x: -10_000, y: -10_000 })).toEqual({
      ...inset,
      x: 100,
      y: 80,
    });
    expect(moveCrop(cropped, inset, { x: 10_000, y: 10_000 })).toEqual({
      ...inset,
      x: 260,
      y: 140,
    });
    expect(inset).toEqual({ x: 140, y: 100, width: 240, height: 140 });
  });

  it("leaves a full-image frame in place and preserves fractional world coordinates", () => {
    expect(moveCrop(picture, picture, { x: 40, y: -10 })).toEqual(
      imageViewport(picture),
    );
    expect(moveCrop(picture, inset, { x: 0.125, y: -0.25 })).toEqual({
      ...inset,
      x: 140.125,
      y: 99.75,
    });
  });
});

describe("crop handles", () => {
  it.each<{ handle: CropHandle; expected: Bounds }>([
    { handle: "n", expected: { x: 140, y: 150, width: 240, height: 90 } },
    { handle: "ne", expected: { x: 140, y: 150, width: 60, height: 90 } },
    { handle: "e", expected: { x: 140, y: 100, width: 60, height: 140 } },
    { handle: "se", expected: { x: 140, y: 100, width: 60, height: 50 } },
    { handle: "s", expected: { x: 140, y: 100, width: 240, height: 50 } },
    { handle: "sw", expected: { x: 200, y: 100, width: 180, height: 50 } },
    { handle: "w", expected: { x: 200, y: 100, width: 180, height: 140 } },
    { handle: "nw", expected: { x: 200, y: 150, width: 180, height: 90 } },
  ])(
    "keeps the opposite edges fixed for the $handle handle",
    ({ handle, expected }) => {
      const frame = Object.freeze({ ...inset });
      expect(resizeCrop(picture, frame, handle, { x: 200, y: 150 })).toEqual(
        expected,
      );
      expect(frame).toEqual(inset);
    },
  );

  it("expands beyond the existing crop but not beyond the source image", () => {
    const cropped = applyCrop(picture, inset);
    const expanded = resizeCrop(cropped, inset, "nw", { x: -1000, y: -1000 });
    expect(expanded).toEqual({ x: 100, y: 80, width: 280, height: 160 });
    const full = resizeCrop(cropped, expanded, "se", { x: 1000, y: 1000 });
    expect(full).toEqual(imageViewport(picture));
    expect(applyCrop(cropped, full)).toEqual(picture);
  });

  it("prevents inverted crops and keeps the minimum crop representable in the model", () => {
    const smallest = resizeCrop(picture, inset, "nw", { x: 1000, y: 1000 });
    expect(smallest).toEqual({ x: 379, y: 239, width: 1, height: 1 });
    expect(resizeCrop(picture, inset, "se", { x: -1000, y: -1000 })).toEqual({
      x: 140,
      y: 100,
      width: 1,
      height: 1,
    });
    const result = applyCrop(picture, smallest);
    expect(elementSchema.safeParse(result).success).toBe(true);
    closeBounds(imageViewport(result), picture);
    expect(
      resizeCrop(picture, inset, "se", { x: -1000, y: -1000 }, 0.01),
    ).toEqual({ x: 140, y: 100, width: 1, height: 1 });
  });

  it("accepts a zoom-adjusted minimum without changing the untouched dimension", () => {
    expect(resizeCrop(picture, inset, "w", { x: 1000, y: -1000 }, 16)).toEqual({
      x: 364,
      y: 100,
      width: 16,
      height: 140,
    });
    const thin = { x: 100, y: 80, width: 1, height: 20 };
    expect(resizeCrop(picture, thin, "n", { x: 500, y: 1000 }, 12)).toEqual({
      x: 100,
      y: 88,
      width: 1,
      height: 12,
    });
  });

  it("caps the minimum at source size and available space from the opposite anchor", () => {
    const tiny = { ...picture, width: 3, height: 2 };
    expect(resizeCrop(tiny, tiny, "nw", { x: 1000, y: 1000 }, 16)).toEqual(
      imageViewport(tiny),
    );
    const frame = { x: 101, y: 80, width: 1, height: 1 };
    expect(resizeCrop(tiny, frame, "se", { x: -1000, y: -1000 }, 16)).toEqual({
      x: 101,
      y: 80,
      width: 2,
      height: 2,
    });
  });

  it("rejects non-finite pointer coordinates rather than corrupting the draft", () => {
    expect(() => moveCrop(picture, inset, { x: NaN, y: 0 })).toThrow("finite");
    expect(() =>
      resizeCrop(picture, inset, "se", { x: 0, y: Infinity }),
    ).toThrow("finite");
    expect(() => applyCrop(picture, { ...inset, width: Infinity })).toThrow(
      "finite",
    );
  });
});
