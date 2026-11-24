import { type Capture, CaptureSchema, type Preview } from "@kinetic/schema";
import sample from "@kinetic/schema/fixtures/sample-capture.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { formatPreview } from "./cli.ts";
import { buildDiffReport, planShots, targetsFromSteps } from "./preview.ts";

const base = CaptureSchema.parse(sample);
const root = base.meta.selector;
const cta = `${root} > button.cta`;
const chip = `${root} > a.chip`;

const capture: Capture = {
  ...base,
  media: { ...base.media, screenshot: "states/default.png" },
  states: [
    { name: "hover", target: cta, changes: {}, screenshot: "states/hover-0.png" },
    { name: "focus", target: chip, changes: {}, screenshot: "states/focus-1.png" },
    { name: "active", target: `${root} > a.other`, changes: {}, screenshot: "states/active-2.png" },
    { name: "hover", target: root, changes: {}, screenshot: "states/hover-3.png" },
    { name: "mobile", target: root, changes: {}, screenshot: "states/mobile.png" },
    { name: "open", target: root, changes: {}, screenshot: "states/open-0.png" },
    { name: "hover", target: chip, changes: {} },
  ],
  recording: {
    file: "original.webm",
    durationMs: 9000,
    size: { width: 400, height: 200 },
    locatedBy: "selector",
    steps: [
      { kind: "idle", start: 0, end: 1500 },
      { kind: "hover", target: cta, path: [1], start: 1500, end: 3100 },
      { kind: "hover", target: chip, path: [2], start: 3100, end: 4700 },
      { kind: "focus", target: chip, path: [2], start: 4700, end: 6100 },
      { kind: "scroll", start: 6100, end: 9000 },
    ],
    recordedAt: "2026-11-24T12:00:00.000Z",
  },
};

describe("planShots", () => {
  it("plans one shot per original screenshot on disk, with the element path the recording used", () => {
    const existing = new Set(["states/default.png", "states/hover-0.png", "states/focus-1.png", "states/active-2.png", "states/hover-3.png", "states/mobile.png", "states/open-0.png"]);
    const plans = planShots(capture, existing);
    expect(plans.map((p) => [p.state, p.kind, p.path ?? null])).toEqual([
      ["default", "default", []],
      ["hover-0", "hover", [1]],
      ["focus-1", "focus", [2]],
      ["active-2", "active", null],
      ["hover-3", "hover", []],
      ["mobile", "mobile", []],
      ["open-0", "default", null],
    ]);
    expect(plans.find((p) => p.state === "active-2")?.error).toContain("no recorded path");
    expect(plans.find((p) => p.state === "open-0")?.error).toContain("not replayed");
  });

  it("skips screenshots that are not on disk", () => {
    expect(planShots(capture, new Set(["states/hover-0.png"])).map((p) => p.state)).toEqual(["hover-0"]);
  });
});

describe("targetsFromSteps", () => {
  const paths = [[], [0], [1], [2], [2, 0]];

  it("maps the original's hover and focus steps onto the rebuild's nodes by path", () => {
    const warnings: string[] = [];
    expect(targetsFromSteps(capture.recording?.steps ?? [], paths, warnings)).toEqual({ hover: [2, 3], focus: [3] });
    expect(warnings).toEqual([]);
  });

  it("warns about targets the rebuild has no element for, and hovers the root when none map", () => {
    const warnings: string[] = [];
    expect(targetsFromSteps(capture.recording?.steps ?? [], [[], [0]], warnings)).toEqual({ hover: [0], focus: [] });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("path [1]");
  });
});

describe("reports", () => {
  const preview: Preview = {
    file: "Component.preview.webm",
    threshold: 0.1,
    scores: [
      { state: "default", original: "states/default.png", preview: "preview/default.png", diff: "diff/default.png", score: 0.04 },
      { state: "hover-0", original: "states/hover-0.png", preview: "preview/hover-0.png", diff: "diff/hover-0.png", score: 0.2341 },
      { state: "active-2", original: "states/active-2.png", error: "no recorded path" },
    ],
    passed: false,
    diffReport: "DIFF.md",
    renderedAt: "2026-11-24T12:00:00.000Z",
    warnings: ["The focus target has no element at the same place in the rebuild."],
  };

  it("DIFF.md has the numbers, the threshold and relative diff images", () => {
    const md = buildDiffReport(preview, new Map([["hover-0", { original: "400×200", preview: "400×220" }]]));
    expect(md).toContain("Threshold: 10.0% of pixels. Over the threshold in 1 of 3 states.");
    expect(md).toContain("| hover-0 | 23.4% (over) | 400×200 → 400×220 | ![states/hover-0.png](states/hover-0.png) | ![preview/hover-0.png](preview/hover-0.png) | ![diff/hover-0.png](diff/hover-0.png) |");
    expect(md).toContain("| default | 4.0% |");
    expect(md).toContain("| active-2 | not scored: no recorded path |");
    expect(md).toContain("- The focus target has no element at the same place in the rebuild.");
    expect(md).toContain("[Component.preview.webm](Component.preview.webm)");
  });

  it("the CLI prints each state against the threshold", () => {
    const text = formatPreview("example.com/cta-button", preview);
    expect(text).toContain("  default     4.0%  ok");
    expect(text).toContain("  hover-0    23.4%  over");
    expect(text).toContain("  active-2  not scored: no recorded path");
    expect(text).toContain("Over in 1 state: see DIFF.md and the Fix pass section in REBUILD.md.");
    expect(formatPreview("a/b", { ...preview, scores: [preview.scores[0] as Preview["scores"][number]], passed: true })).toContain("Every state passes.");
  });
});
