import type { MotionEntry } from "@kinetic/schema";
import { describe, expect, it } from "vitest";
import { buildTimeline, curvePath, easingCurve, formatMs } from "./timeline.ts";

function entry(overrides: Partial<MotionEntry>): MotionEntry {
  return {
    id: "e1",
    source: "css-transition",
    target: "html > body > section.hero > button.cta",
    trigger: "hover",
    properties: [{ name: "transform", keyframes: [{ offset: 0, value: "none" }, { offset: 1, value: "translateY(-2px)" }] }],
    duration: 150,
    delay: 0,
    easing: [0, 0, 0.58, 1],
    iterations: 1,
    direction: "normal",
    confidence: "exact",
    raw: null,
    ...overrides,
  };
}

describe("easingCurve", () => {
  const at = (points: [number, number][] | undefined, x: number) => points?.find(([px]) => Math.abs(px - x) < 1e-9)?.[1];

  it("draws cubic-bezier points and CSS, Framer Motion and GSAP names", () => {
    const easeOut = easingCurve([0, 0, 0.58, 1]);
    expect(at(easeOut, 0)).toBe(0);
    expect(at(easeOut, 1)).toBe(1);
    expect(at(easeOut, 0.5)).toBeGreaterThan(0.5);
    expect(easingCurve("ease-in")).toEqual(easingCurve([0.42, 0, 1, 1]));
    expect(easingCurve("easeOut")).toEqual(easingCurve([0, 0, 0.58, 1]));
    expect(easingCurve("power2.out")).toEqual(easingCurve([0.215, 0.61, 0.355, 1]));
    expect(easingCurve("linear")).toEqual([[0, 0], [1, 1]]);
  });

  it("draws springs that overshoot when underdamped and settle at 1", () => {
    const bouncy = easingCurve("spring(stiffness: 300, damping: 10, mass: 1)") ?? [];
    expect(Math.max(...bouncy.map(([, y]) => y))).toBeGreaterThan(1.1);
    expect(Math.abs((bouncy.at(-1)?.[1] ?? 0) - 1)).toBeLessThan(0.02);
    const stiff = easingCurve("spring(duration: 0.4, bounce: 0)") ?? [];
    expect(Math.max(...stiff.map(([, y]) => y))).toBeLessThanOrEqual(1.0001);
  });

  it("draws steps and linear() stops, and gives up on unknown easings", () => {
    expect(easingCurve("steps(2, end)")).toEqual([[0, 0], [0.5, 0], [0.5, 0.5], [1, 0.5], [1, 1]]);
    expect(easingCurve("linear(0, 0.8, 1)")).toEqual([[0, 0], [0.5, 0.8], [1, 1]]);
    expect(easingCurve("elastic.out(1, 0.3)")).toBeUndefined();
  });

  it("fits an overshooting curve into the box", () => {
    const d = curvePath([[0, 0], [0.5, 1.5], [1, 1]], 100, 50, 0);
    expect(d).toBe("M0 50 L50 0 L100 16.67");
  });
});

describe("buildTimeline", () => {
  it("puts one row per property on a shared axis, with delays, repeats and keyframe ticks", () => {
    const timeline = buildTimeline([
      entry({ id: "lift" }),
      entry({ id: "glow", duration: 200, delay: 100, properties: [{ name: "box-shadow", keyframes: [{ offset: 0, value: "a" }, { offset: 0.4, value: "b" }, { offset: 1, value: "c" }] }] }),
      entry({ id: "dot", target: "a.chip > span.dot", trigger: "loop", source: "sampled", duration: 1200, iterations: "infinite", easing: "linear" }),
    ]);
    expect(timeline.axisMs).toBe(1200);
    expect(timeline.timed.map((r) => [r.key, r.element, r.start, Number(r.end.toFixed(4)), r.label, r.repeats])).toEqual([
      ["lift:transform", "button.cta", 0, 0.125, "150 ms", false],
      ["glow:box-shadow", "button.cta", 100 / 1200, 0.25, "200 ms after 100 ms", false],
      ["dot:transform", "span.dot", 0, 1, "1.2 s × ∞", true],
    ]);
    expect(timeline.timed[1]?.offsets).toEqual([0, 0.4, 1]);
    expect(timeline.scroll).toEqual([]);
  });

  it("keeps scroll-driven entries off the time axis", () => {
    const timeline = buildTimeline([
      entry({ id: "scrub", source: "scrolltrigger", trigger: "scroll", duration: 500, scroll: { start: "top bottom", end: "bottom top", scrub: true, pin: false } }),
      entry({ id: "orb", source: "sampled", trigger: "scroll", duration: 0, properties: [{ name: "y", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: -60 }] }] }),
    ]);
    expect(timeline.timed).toEqual([]);
    expect(timeline.scroll.map((r) => [r.key, r.label])).toEqual([
      ["scrub:transform", "top bottom → bottom top, scrub"],
      ["orb:y", "page scroll"],
    ]);
    expect(formatMs(7854)).toBe("7.85 s");
  });
});
