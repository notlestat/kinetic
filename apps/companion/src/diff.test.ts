import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DIFF_THRESHOLD, diffImages, diffThreshold, passes } from "./diff.ts";

/** A PNG filled with one colour, with an optional rectangle of another. */
function png(width: number, height: number, fill: [number, number, number], rect?: { x: number; y: number; w: number; h: number; color: [number, number, number] }): Buffer {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inRect = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const [r, g, b] = inRect ? rect.color : fill;
      const i = (y * width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

const white: [number, number, number] = [255, 255, 255];
const black: [number, number, number] = [0, 0, 0];

describe("diffImages", () => {
  it("scores identical images 0", () => {
    const a = png(40, 20, white, { x: 5, y: 5, w: 10, h: 10, color: [99, 91, 255] });
    expect(diffImages(a, a)).toMatchObject({ score: 0, mismatched: 0, width: 40, height: 20 });
  });

  it("scores the share of pixels that differ", () => {
    // A 10×10 block differs in a 40×20 image: 100 of 800 pixels.
    const a = png(40, 20, white);
    const b = png(40, 20, white, { x: 0, y: 0, w: 10, h: 10, color: black });
    const result = diffImages(a, b);
    expect(result.mismatched).toBe(100);
    expect(result.score).toBeCloseTo(100 / 800, 6);
  });

  it("counts area only one image covers as mismatched, even on a white page", () => {
    // Same content, but the rebuild is 10 px shorter: the missing 40×10 strip is a mismatch.
    const result = diffImages(png(40, 20, white), png(40, 10, white));
    expect(result).toMatchObject({ width: 40, height: 20, original: { width: 40, height: 20 }, preview: { width: 40, height: 10 }, mismatched: 400 });
    expect(result.score).toBeCloseTo(0.5, 6);
  });

  it("writes a diff image the size of the shared canvas", () => {
    const result = diffImages(png(30, 10, white), png(20, 25, white));
    const diff = PNG.sync.read(result.diffPng);
    expect([diff.width, diff.height]).toEqual([30, 25]);
  });

  it("ignores colour changes below the per-pixel tolerance", () => {
    expect(diffImages(png(10, 10, [250, 250, 250]), png(10, 10, [252, 252, 252])).score).toBe(0);
  });
});

describe("threshold", () => {
  it("defaults to 0.1 and reads KINETIC_DIFF_THRESHOLD", () => {
    expect(DEFAULT_DIFF_THRESHOLD).toBe(0.1);
    expect(diffThreshold(undefined)).toBe(0.1);
    expect(diffThreshold("")).toBe(0.1);
    expect(diffThreshold("0.25")).toBe(0.25);
    expect(diffThreshold("0")).toBe(0);
  });

  it("refuses values outside 0 to 1", () => {
    for (const bad of ["-0.1", "1.5", "lots", "NaN"]) expect(() => diffThreshold(bad)).toThrow("KINETIC_DIFF_THRESHOLD");
  });

  it("passes at or under the threshold and fails above it", () => {
    expect(passes(0.1, 0.1)).toBe(true);
    expect(passes(0.0999, 0.1)).toBe(true);
    expect(passes(0.1001, 0.1)).toBe(false);
    expect(passes(0, 0)).toBe(true);
  });
});
