import { describe, expect, it } from "vitest";
import { bezierAt, easingToCss, gsapEaseToBezier, parseCssEasing } from "./easing.ts";

describe("parseCssEasing", () => {
  it("turns named easings and cubic-bezier() into control points", () => {
    expect(parseCssEasing("ease-out")).toEqual([0, 0, 0.58, 1]);
    expect(parseCssEasing("cubic-bezier(0.2, 0, 0, 1)")).toEqual([0.2, 0, 0, 1]);
    expect(parseCssEasing("cubic-bezier(0.68,-0.55,0.265,1.55)")).toEqual([0.68, -0.55, 0.265, 1.55]);
  });

  it("keeps linear, steps() and unknown values as strings", () => {
    expect(parseCssEasing("linear")).toBe("linear");
    expect(parseCssEasing("steps(4, end)")).toBe("steps(4, end)");
    expect(parseCssEasing("")).toBe("linear");
  });

  it("round-trips through easingToCss", () => {
    expect(easingToCss([0.2, 0, 0, 1])).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(easingToCss("linear")).toBe("linear");
  });
});

describe("gsapEaseToBezier", () => {
  it("maps power eases in every spelling", () => {
    expect(gsapEaseToBezier("power2.out")).toEqual([0.215, 0.61, 0.355, 1]);
    expect(gsapEaseToBezier("power2")).toEqual([0.215, 0.61, 0.355, 1]);
    expect(gsapEaseToBezier("Power2.easeOut")).toEqual([0.215, 0.61, 0.355, 1]);
    expect(gsapEaseToBezier("cubic.inOut")).toEqual([0.645, 0.045, 0.355, 1]);
    expect(gsapEaseToBezier("expo.in")).toEqual([0.95, 0.05, 0.795, 0.035]);
  });

  it("maps linear eases and back with the default overshoot", () => {
    expect(gsapEaseToBezier("none")).toBe("linear");
    expect(gsapEaseToBezier("back.out(1.7)")).toEqual([0.175, 0.885, 0.32, 1.275]);
  });

  it("returns undefined for eases without a cubic-bezier equivalent", () => {
    expect(gsapEaseToBezier("elastic.out(1, 0.3)")).toBeUndefined();
    expect(gsapEaseToBezier("bounce.out")).toBeUndefined();
    expect(gsapEaseToBezier("back.out(3)")).toBeUndefined();
    expect(gsapEaseToBezier("steps(5)")).toBeUndefined();
  });
});

describe("bezierAt", () => {
  it("is linear for the identity curve and hits the ends exactly", () => {
    expect(bezierAt([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 5);
    expect(bezierAt([0.42, 0, 0.58, 1], 0)).toBe(0);
    expect(bezierAt([0.42, 0, 0.58, 1], 1)).toBe(1);
  });

  it("matches known values of the CSS ease-in-out curve", () => {
    expect(bezierAt([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 4);
    expect(bezierAt([0.42, 0, 0.58, 1], 0.25)).toBeCloseTo(0.1291, 3);
  });
});
