// Compares a rebuild's state screenshot with the original's using pixelmatch. The
// two PNGs can differ in size (the rebuild may be taller, say), so both are placed
// top-left on a canvas as big as the larger of each dimension. Area that only one
// image covers counts as mismatched, so a size difference raises the score.

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export const DEFAULT_DIFF_THRESHOLD = 0.1;

/** Per-pixel colour tolerance passed to pixelmatch (0 to 1; smaller is stricter). */
const PIXEL_TOLERANCE = 0.1;

/** KINETIC_DIFF_THRESHOLD: the largest share of mismatched pixels that still passes, 0 to 1. */
export function diffThreshold(value = process.env.KINETIC_DIFF_THRESHOLD): number {
  if (value === undefined || value === "") return DEFAULT_DIFF_THRESHOLD;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`KINETIC_DIFF_THRESHOLD must be a number from 0 to 1, not "${value}"`);
  return n;
}

export interface DiffResult {
  /** Share of mismatched pixels on the shared canvas, 0 to 1. */
  score: number;
  mismatched: number;
  width: number;
  height: number;
  original: { width: number; height: number };
  preview: { width: number; height: number };
  /** PNG with mismatched pixels in red over a faded copy of the original. */
  diffPng: Buffer;
}

/** Copies the image onto a canvas filled with an opaque colour, so padding never matches the other image's padding. */
function padTo(image: PNG, width: number, height: number, fill: readonly [number, number, number]): Buffer {
  if (image.width === width && image.height === height) return image.data;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = fill[0];
    out[i + 1] = fill[1];
    out[i + 2] = fill[2];
    out[i + 3] = 255;
  }
  for (let y = 0; y < image.height; y++) {
    image.data.copy(out, y * width * 4, y * image.width * 4, (y + 1) * image.width * 4);
  }
  return out;
}

export function diffImages(originalPng: Buffer, previewPng: Buffer): DiffResult {
  const a = PNG.sync.read(originalPng);
  const b = PNG.sync.read(previewPng);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(padTo(a, width, height, [255, 0, 255]), padTo(b, width, height, [0, 255, 0]), diff.data, width, height, {
    threshold: PIXEL_TOLERANCE,
    includeAA: false,
    alpha: 0.2,
  });
  const total = width * height;
  return {
    score: total === 0 ? 0 : mismatched / total,
    mismatched,
    width,
    height,
    original: { width: a.width, height: a.height },
    preview: { width: b.width, height: b.height },
    diffPng: PNG.sync.write(diff),
  };
}

/** True when the score is at or under the threshold. */
export function passes(score: number, threshold: number): boolean {
  return score <= threshold;
}
