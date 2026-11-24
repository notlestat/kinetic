// Crops Playwright's viewport recording down to the component with ffmpeg from
// ffmpeg-static. The component moves in the viewport during the scroll pass, so the
// crop window follows it: its x and y are piecewise-linear expressions of time.
// ffmpeg is always spawned with an argument array, never a shell string.

import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

/** KINETIC_FFMPEG overrides the bundled binary, e.g. for a system ffmpeg. */
export function ffmpegPath(): string {
  const path = process.env.KINETIC_FFMPEG ?? ffmpegStatic;
  if (!path) throw new Error("ffmpeg-static has no binary for this platform; set KINETIC_FFMPEG to an ffmpeg path");
  return path;
}

/** Runs ffmpeg, resolving with its stderr (where ffmpeg logs) and rejecting with the end of it on failure. */
export function runFfmpeg(args: readonly string[], { timeoutMs = 120_000, allowFailure = false } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep the tail only: ffmpeg's progress lines can run long.
      stderr = (stderr + chunk).slice(-64_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) resolve(stderr);
      else reject(new Error(`ffmpeg ${signal ? `was killed (${signal})` : `exited with ${code}`}: ${stderr.trim().split("\n").slice(-6).join("\n")}`));
    });
  });
}

export interface VideoInfo {
  width: number;
  height: number;
  /** Undefined when the file does not say (Playwright's raw recordings leave it out). */
  durationMs?: number;
}

/** Reads a video's size and duration from ffmpeg's own description of the file. */
export async function videoInfo(file: string): Promise<VideoInfo> {
  // With no output file ffmpeg exits with an error after printing the input's details, which is all this needs.
  const log = await runFfmpeg(["-hide_banner", "-i", file], { allowFailure: true, timeoutMs: 30_000 });
  const size = /Stream #\d+:\d+.*?: Video: .*?, (\d{2,5})x(\d{2,5})/.exec(log);
  if (!size) throw new Error(`could not read the video size of ${file}`);
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const durationMs = d ? Math.round(((Number(d[1]) * 60 + Number(d[2])) * 60 + Number(d[3])) * 1000) : undefined;
  return { width: Number(size[1]), height: Number(size[2]), ...(durationMs !== undefined ? { durationMs } : {}) };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the component was in the viewport at a moment of the raw video. */
export interface TrackPoint {
  /** ms from the start of the raw video. */
  t: number;
  /** Viewport box in CSS pixels. */
  box: Box;
}

export interface CropPlan {
  width: number;
  height: number;
  /** ffmpeg expressions of t (seconds) for the crop window's top-left corner. */
  x: string;
  y: string;
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function fmt(n: number, digits: number): string {
  return Number(n.toFixed(digits)).toString();
}

/** A piecewise-linear function of t as a sum of clipped ramps, so it needs no nesting. */
function rampExpression(points: readonly { t: number; v: number }[]): string {
  const first = points[0];
  if (!first) return "0";
  let expr = fmt(first.v, 1);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as { t: number; v: number };
    const b = points[i] as { t: number; v: number };
    const dv = b.v - a.v;
    if (Math.abs(dv) < 0.05) continue;
    const t0 = a.t / 1000;
    const t1 = b.t / 1000;
    if (t1 <= t0) {
      // A jump at one instant.
      expr += `+(${fmt(dv, 1)})*gte(t,${fmt(t0, 3)})`;
      continue;
    }
    expr += `+(${fmt(dv, 1)})*clip((t-${fmt(t0, 3)})/${fmt(t1 - t0, 3)},0,1)`;
  }
  return expr;
}

/** Drops points that sit between two neighbours with the same value, keeping the corners. */
function dedupe(points: readonly { t: number; v: number }[]): { t: number; v: number }[] {
  return points.filter((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];
    return !prev || !next || Math.abs(prev.v - p.v) >= 0.05 || Math.abs(next.v - p.v) >= 0.05;
  });
}

/**
 * The crop window: big enough for the largest box seen plus padding (never bigger
 * than the video), even-sized for the encoder, centred on the component at each
 * track point and kept inside the frame.
 */
export function planCrop(track: readonly TrackPoint[], video: { width: number; height: number }, padding = 24): CropPlan {
  const sorted = [...track].sort((a, b) => a.t - b.t);
  const maxW = Math.max(1, ...sorted.map((p) => p.box.width));
  const maxH = Math.max(1, ...sorted.map((p) => p.box.height));
  const width = Math.min(even(video.width), even(Math.ceil(maxW + 2 * padding)));
  const height = Math.min(even(video.height), even(Math.ceil(maxH + 2 * padding)));
  const clamp = (v: number, max: number) => Math.min(Math.max(0, v), Math.max(0, max));
  const xs = sorted.map((p) => ({ t: p.t, v: clamp(p.box.x + p.box.width / 2 - width / 2, video.width - width) }));
  const ys = sorted.map((p) => ({ t: p.t, v: clamp(p.box.y + p.box.height / 2 - height / 2, video.height - height) }));
  return { width, height, x: rampExpression(dedupe(xs)), y: rampExpression(dedupe(ys)) };
}

export interface CropOptions {
  input: string;
  output: string;
  plan: CropPlan;
  /** ms of the raw video to keep. */
  startMs: number;
  endMs: number;
}

/**
 * Crops and trims the raw recording into a VP9 WebM. The crop runs before the trim,
 * so the crop expressions use the raw video's clock.
 */
export async function cropVideo({ input, output, plan, startMs, endMs }: CropOptions): Promise<void> {
  const filter = [
    `crop=w=${plan.width}:h=${plan.height}:x='max(0,min(in_w-out_w,${plan.x}))':y='max(0,min(in_h-out_h,${plan.y}))'`,
    `trim=start=${fmt(startMs / 1000, 3)}:end=${fmt(endMs / 1000, 3)}`,
    "setpts=PTS-STARTPTS",
  ].join(",");
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-vf",
    filter,
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "0",
    "-crf",
    "32",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-row-mt",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "webm",
    output,
  ]);
}
