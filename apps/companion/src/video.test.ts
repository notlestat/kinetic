import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cropVideo, planCrop, runFfmpeg, videoInfo } from "./video.ts";

/** Evaluates a crop expression the way ffmpeg would, for the subset planCrop writes. */
function evaluate(expr: string, t: number): number {
  const js = expr
    .replace(/clip\(([^,]+),0,1\)/g, "Math.min(1,Math.max(0,$1))")
    .replace(/gte\(t,([\d.]+)\)/g, "(t>=$1?1:0)");
  return Function("t", `return ${js};`)(t) as number;
}

describe("planCrop", () => {
  it("sizes the window to the largest box plus padding, even and inside the video", () => {
    const plan = planCrop(
      [
        { t: 0, box: { x: 100, y: 100, width: 301, height: 81 } },
        { t: 1000, box: { x: 100, y: 100, width: 301, height: 81 } },
      ],
      { width: 1280, height: 800 },
    );
    expect(plan.width).toBe(348);
    expect(plan.height).toBe(128);
    // Centred on the box: 100 + 150.5 - 174 = 76.5
    expect(evaluate(plan.x, 0.5)).toBeCloseTo(76.5, 1);
    expect(evaluate(plan.y, 0.5)).toBeCloseTo(76.5, 1);
  });

  it("follows the box between track points and clamps at the frame edges", () => {
    const plan = planCrop(
      [
        { t: 0, box: { x: 0, y: 600, width: 200, height: 100 } },
        { t: 2000, box: { x: 0, y: 600, width: 200, height: 100 } },
        { t: 3000, box: { x: 0, y: 100, width: 200, height: 100 } },
        { t: 4000, box: { x: 0, y: -200, width: 200, height: 100 } },
      ],
      { width: 640, height: 720 },
    );
    expect(plan.width).toBe(248);
    expect(evaluate(plan.x, 1)).toBe(0); // clamped: the box sits on the left edge
    // Centred would be 650 - 74 = 576, but a 148 px window in a 720 px frame stops at 572.
    expect(evaluate(plan.y, 1)).toBeCloseTo(572, 1);
    expect(evaluate(plan.y, 2.5)).toBeCloseTo((572 + 76) / 2, 1);
    expect(evaluate(plan.y, 3)).toBeCloseTo(76, 1);
    expect(evaluate(plan.y, 4)).toBe(0);
  });

  it("never asks for a window bigger than the video", () => {
    const plan = planCrop([{ t: 0, box: { x: -50, y: -50, width: 2000, height: 1500 } }], { width: 1279, height: 799 });
    expect(plan).toMatchObject({ width: 1278, height: 798, x: "1", y: "1" });
  });
});

describe("cropVideo with ffmpeg", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kinetic-video-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("crops a moving window and trims the video", async () => {
    const input = path.join(dir, "raw.webm");
    // Playwright records VP8 WebM; a 3 s test pattern stands in for it.
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=3", "-c:v", "libvpx", "-b:v", "1M", input]);
    const plan = planCrop(
      [
        { t: 0, box: { x: 40, y: 40, width: 150, height: 90 } },
        { t: 1500, box: { x: 40, y: 40, width: 150, height: 90 } },
        { t: 2500, box: { x: 400, y: 200, width: 150, height: 90 } },
      ],
      { width: 640, height: 360 },
    );
    const output = path.join(dir, "original.webm");
    await cropVideo({ input, output, plan, startMs: 500, endMs: 2500 });
    const info = await videoInfo(output);
    expect(info.width).toBe(198);
    expect(info.height).toBe(138);
    expect(info.durationMs).toBeGreaterThan(1800);
    expect(info.durationMs).toBeLessThan(2200);
  }, 30_000);

  it("reports ffmpeg's error when the input is missing", async () => {
    await expect(cropVideo({ input: path.join(dir, "missing.webm"), output: path.join(dir, "x.webm"), plan: planCrop([], { width: 10, height: 10 }), startMs: 0, endMs: 1 })).rejects.toThrow(/ffmpeg exited/);
  });
});
