import { describe, expect, it } from "vitest";
import sample from "../fixtures/sample-capture.json" with { type: "json" };
import { CaptureSchema, MotionEntrySchema } from "./capture.ts";

const entry = sample.motion.entries[0];

describe("CaptureSchema", () => {
  it("accepts the sample capture", () => {
    expect(CaptureSchema.safeParse(sample).success).toBe(true);
  });

  it("accepts a capture with only meta, since every feature section is optional", () => {
    const result = CaptureSchema.safeParse({ schemaVersion: 1, meta: sample.meta });
    expect(result.success).toBe(true);
  });

  it.each(["..", ".", "a/b", "../etc", ""])("rejects %j as a site folder name", (site) => {
    const result = CaptureSchema.safeParse({ ...sample, meta: { ...sample.meta, site } });
    expect(result.success).toBe(false);
  });

  it("rejects media paths that leave the capture folder", () => {
    for (const original of ["/etc/passwd", "../other/original.webm", "states\\..\\x"]) {
      const result = CaptureSchema.safeParse({ ...sample, media: { original } });
      expect(result.success).toBe(false);
    }
  });
});

describe("MotionEntrySchema", () => {
  it("accepts a CSS easing string as well as cubic-bezier numbers", () => {
    expect(MotionEntrySchema.safeParse({ ...entry, easing: "ease-in-out" }).success).toBe(true);
  });

  it('stores an endless loop as "infinite", because JSON has no Infinity', () => {
    expect(MotionEntrySchema.safeParse({ ...entry, iterations: "infinite" }).success).toBe(true);
    expect(MotionEntrySchema.safeParse({ ...entry, iterations: -1 }).success).toBe(false);
  });

  it("accepts a ScrollTrigger-style scroll range", () => {
    const scroll = { start: "top center", end: "bottom top", scrub: 0.5, pin: true };
    const result = MotionEntrySchema.safeParse({ ...entry, source: "scrolltrigger", trigger: "scroll", scroll });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(MotionEntrySchema.safeParse({ ...entry, source: "jquery" }).success).toBe(false);
  });

  it("rejects keyframe offsets outside 0 to 1", () => {
    const properties = [{ name: "opacity", keyframes: [{ offset: 1.5, value: 1 }] }];
    expect(MotionEntrySchema.safeParse({ ...entry, properties }).success).toBe(false);
  });
});
