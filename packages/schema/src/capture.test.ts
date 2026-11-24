import { describe, expect, it } from "vitest";
import sample from "../fixtures/sample-capture.json" with { type: "json" };
import { CaptureSchema, JobStatusSchema, MotionEntrySchema, PreviewSchema } from "./capture.ts";

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

describe("rebuild and preview blocks", () => {
  const preview = {
    file: "Component.preview.webm",
    threshold: 0.1,
    scores: [
      { state: "default", original: "states/default.png", preview: "preview/default.png", diff: "diff/default.png", score: 0.04 },
      { state: "active-0", original: "states/active-0.png", error: "no recorded path" },
    ],
    passed: true,
    renderedAt: "2026-11-24T12:00:00.000Z",
  };

  it("accepts a rebuild record and preview scores on a capture", () => {
    const rebuild = { mode: "claude-cli", prompt: "REBUILD.md", fixPasses: 1, updatedAt: "2026-11-24T12:00:00.000Z" };
    expect(CaptureSchema.safeParse({ ...sample, rebuild, preview }).success).toBe(true);
  });

  it("rejects an unknown mode, scores outside 0 to 1 and paths that leave the capture folder", () => {
    const rebuild = { mode: "magic", prompt: "REBUILD.md", fixPasses: 0, updatedAt: "2026-11-24T12:00:00.000Z" };
    expect(CaptureSchema.safeParse({ ...sample, rebuild }).success).toBe(false);
    expect(PreviewSchema.safeParse({ ...preview, scores: [{ state: "default", original: "states/default.png", score: 1.2 }] }).success).toBe(false);
    expect(PreviewSchema.safeParse({ ...preview, scores: [{ state: "default", original: "../secret.png", score: 0 }] }).success).toBe(false);
    expect(PreviewSchema.safeParse({ ...preview, diffReport: "/tmp/DIFF.md" }).success).toBe(false);
  });

  it("has a previewing job status between rebuilding and done", () => {
    expect(JobStatusSchema.options).toEqual(["queued", "recording", "awaiting-rebuild", "rebuilding", "previewing", "done", "failed"]);
  });
});
