import { MotionEntrySchema } from "@kinetic/schema";
import { describe, expect, it } from "vitest";
import { mergeMotion } from "./motion-normalise.ts";
import { fromCameraPath, isSettling, linearFit, unwrapAngles } from "./three-motion.ts";
import type { CameraPath, CameraSample, TransformSample } from "./three-scene.ts";

const still = (overrides: Partial<TransformSample> = {}): TransformSample => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...overrides });
const camera = (z: number, y = 1): CameraSample => ({ position: [0, y, z], rotation: [0, 0, 0], fov: 50 });

/** 3 s at 60 fps: Spinner turns at 0.8 rad/s, Bob moves up and stops, Ground stays still; camera follows scroll only. */
function path(): CameraPath {
  const frames: CameraPath["frames"] = [];
  for (let i = 0; i <= 180; i++) {
    const t = (i * 1000) / 60;
    // Spinner is read back from a quaternion, so its angle wraps at π.
    let angle = 0.5 + (0.8 * t) / 1000;
    angle = ((angle + Math.PI) % (2 * Math.PI)) - Math.PI;
    frames.push({
      t,
      camera: camera(6),
      objects: { Spinner: still({ rotation: [0, angle, 0] }), Bob: still({ position: [0, Math.min(1, t / 1000), 0] }), Ground: still() },
    });
  }
  const steps = Array.from({ length: 9 }, (_, i) => ({
    scrollY: i * 100,
    progress: i / 8,
    camera: camera(6 - (i / 8) * 3, 1 + (i / 8) * 1.5),
    objects: { Spinner: still({ rotation: [0, i * 0.3, 0] }), Bob: still({ position: [0, 1, 0] }), Ground: still() },
  }));
  return { canvas: "#scene", durationMs: 3000, frames, scroll: { maxScroll: 800, steps } };
}

describe("fromCameraPath", () => {
  const entries = mergeMotion(fromCameraPath(path()));
  const of = (object: string) => entries.filter((e) => (e.raw as { object: string }).object === object);

  it("produces valid three entries", () => {
    for (const entry of entries) expect(MotionEntrySchema.safeParse(entry).success).toBe(true);
    expect(entries.every((e) => e.source === "three" && e.target === "#scene")).toBe(true);
  });

  it("turns a steady spin into an endless linear loop of one turn", () => {
    const [spin] = of("Spinner");
    expect(spin).toMatchObject({ trigger: "loop", iterations: "infinite", easing: "linear", confidence: "approximate" });
    expect(spin?.duration).toBe(Math.round((2 * Math.PI) / 0.0008));
    const keyframes = spin?.properties[0]?.keyframes ?? [];
    expect(Number(keyframes[1]?.value) - Number(keyframes[0]?.value)).toBeCloseTo(2 * Math.PI, 2);
    // Its rotation between scroll steps comes from the spin, not from scroll.
    expect(of("Spinner").filter((e) => e.trigger === "scroll")).toHaveLength(0);
  });

  it("treats motion that stops inside the window as a load animation", () => {
    const [bob] = of("Bob");
    expect(bob).toMatchObject({ trigger: "load", iterations: 1, properties: [{ name: "position.y" }] });
  });

  it("links camera movement between scroll steps to scroll", () => {
    const [cam] = of("camera");
    expect(cam).toMatchObject({ trigger: "scroll", scroll: { start: 0, end: 800, scrub: true, pin: false }, confidence: "near" });
    expect(cam?.properties.map((p) => p.name).sort()).toEqual(["position.y", "position.z"]);
    expect(cam?.properties.find((p) => p.name === "position.z")?.keyframes.at(-1)).toEqual({ offset: 1, value: 3 });
    expect(of("Ground")).toHaveLength(0);
  });
});

describe("motion still running when sampling ends", () => {
  /** 3 s at 60 fps of one object whose x is f(t in seconds). */
  const pathOf = (x: (seconds: number) => number): CameraPath => ({
    canvas: "#scene",
    durationMs: 3000,
    frames: Array.from({ length: 181 }, (_, i) => {
      const t = (i * 1000) / 60;
      return { t, camera: camera(6), objects: { Thing: still({ position: [x(t / 1000), 0, 0] }) } };
    }),
  });
  const entryFor = (x: (seconds: number) => number) => mergeMotion(fromCameraPath(pathOf(x)))[0];

  it("treats an intro easing into place as a one-off ease-out, not a loop", () => {
    // Eases from 14 towards 12 and is still a little short of it after 3 s, like an intro camera move.
    const intro = entryFor((s) => 12 + 2 * Math.exp(-s / 1.2));
    expect(intro).toMatchObject({ trigger: "load", iterations: 1, easing: "ease-out", raw: { stillSettling: true } });
  });

  it("keeps a sway that turns back as a loop", () => {
    const sway = entryFor((s) => Math.sin(s * 2));
    expect(sway).toMatchObject({ trigger: "loop", iterations: "infinite", easing: "linear" });
  });

  it("keeps a steady drift as a loop", () => {
    const drift = entryFor((s) => s * 0.5);
    expect(drift).toMatchObject({ trigger: "loop", iterations: "infinite" });
  });

  it("needs every moving channel to settle", () => {
    const times = [0, 500, 1000, 1500, 2000, 2500, 3000];
    const easing = times.map((t) => 2 * Math.exp(-t / 1000));
    const steady = times.map((t) => t / 1000);
    expect(isSettling(times, { "position.x": easing })).toBe(true);
    expect(isSettling(times, { "position.x": easing, "position.y": steady })).toBe(false);
    expect(isSettling(times, { "position.x": times.map(() => 1) })).toBe(false);
  });
});

describe("helpers", () => {
  it("unwraps angles that jump at ±π", () => {
    const unwrapped = unwrapAngles([3.0, 3.1, -3.1, -3.0]);
    expect(unwrapped[2]).toBeCloseTo(-3.1 + 2 * Math.PI, 6);
    expect(unwrapped[3]).toBeCloseTo(-3.0 + 2 * Math.PI, 6);
  });

  it("fits a line", () => {
    expect(linearFit([0, 1, 2, 3], [1, 3, 5, 7])).toEqual({ slope: 2, r2: 1 });
    expect(linearFit([0, 1], [0, 1])).toEqual({ slope: 0, r2: 0 });
  });
});
