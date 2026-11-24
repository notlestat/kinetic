import { type Bezier, bezierAt, type MotionEntry } from "@kinetic/schema";
import { describe, expect, it } from "vitest";
import {
  analyseSamples,
  curveDistance,
  decomposeMatrix,
  familyOf,
  fitCubicBezier,
  type FrameWindow,
  fromFrameWindows,
  fromScrollSamples,
  mergeSampledMotion,
  type NodeValues,
  parseTransformMatrix,
  simplifyKeyframes,
} from "./sampling.ts";

function node(partial: Partial<NodeValues> = {}): NodeValues {
  return { transform: "none", opacity: 1, width: 100, height: 40, ...partial };
}

function translateY(y: number): string {
  return `matrix(1, 0, 0, 1, 0, ${y})`;
}

/** 60 fps frame times over `ms`. */
function frameTimes(ms: number): number[] {
  return Array.from({ length: Math.floor(ms / 16.67) + 1 }, (_, i) => i * 16.67);
}

function entry(partial: Partial<MotionEntry>): MotionEntry {
  return {
    id: "x-1",
    source: "css-transition",
    target: "#a",
    trigger: "hover",
    properties: [],
    duration: 0,
    delay: 0,
    easing: "linear",
    iterations: 1,
    direction: "normal",
    confidence: "exact",
    raw: null,
    ...partial,
  };
}

describe("transform matrices", () => {
  it("reads matrix() and the 2D part of matrix3d()", () => {
    expect(parseTransformMatrix("none")).toBeNull();
    expect(parseTransformMatrix("matrix(1, 0, 0, 1, 10, -4)")).toEqual([1, 0, 0, 1, 10, -4]);
    expect(parseTransformMatrix("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1)")).toEqual([1, 0, 0, 1, 5, 6]);
    expect(parseTransformMatrix("matrix(1, 0, 0)")).toBeNull();
  });

  it("splits a matrix into translate, rotate and scale", () => {
    const angle = (30 * Math.PI) / 180;
    const [c, s] = [Math.cos(angle) * 2, Math.sin(angle) * 2];
    const t = decomposeMatrix([c, s, -s * 0.5, c * 0.5, 12, -8]);
    expect(t.x).toBe(12);
    expect(t.y).toBe(-8);
    expect(t.rotate).toBeCloseTo(30, 6);
    expect(t.scaleX).toBeCloseTo(2, 6);
    expect(t.scaleY).toBeCloseTo(1, 6);
    expect(decomposeMatrix(null)).toEqual({ x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1 });
  });
});

describe("simplifyKeyframes", () => {
  it("reduces a straight line to its two ends", () => {
    const points = Array.from({ length: 30 }, (_, i) => ({ offset: i / 29, value: 10 + 90 * (i / 29) }));
    expect(simplifyKeyframes(points)).toEqual([
      { offset: 0, value: 10 },
      { offset: 1, value: 100 },
    ]);
  });

  it("keeps the corner of a triangle and drops noise below the tolerance", () => {
    const points = Array.from({ length: 41 }, (_, i) => {
      const x = i / 40;
      const noise = i % 2 === 0 ? 0.004 : -0.004; // 0.4% of the range
      return { offset: x, value: (x < 0.5 ? x * 2 : 2 - x * 2) + noise };
    });
    const simplified = simplifyKeyframes(points);
    expect(simplified).toHaveLength(3);
    expect(simplified[1]?.offset).toBeCloseTo(0.5, 6);
    expect(simplified[0]?.offset).toBe(0);
    expect(simplified[2]?.offset).toBe(1);
  });

  it("keeps every point that matters on a curve and stays within the tolerance", () => {
    const points = Array.from({ length: 101 }, (_, i) => ({ offset: i / 100, value: Math.sin((i / 100) * Math.PI * 2) }));
    const simplified = simplifyKeyframes(points, 0.02);
    expect(simplified.length).toBeGreaterThan(4);
    expect(simplified.length).toBeLessThanOrEqual(12);
    // Every original sample lies within 2% of the range (2 units here) of the simplified polyline, or the cap loosened it.
    for (const p of points) {
      const right = simplified.findIndex((k) => k.offset >= p.offset);
      const b = simplified[right] as { offset: number; value: number };
      const a = simplified[Math.max(0, right - 1)] as { offset: number; value: number };
      const t = b.offset === a.offset ? 0 : (p.offset - a.offset) / (b.offset - a.offset);
      expect(Math.abs(a.value + (b.value - a.value) * t - p.value)).toBeLessThan(0.1);
    }
  });

  it("respects the point cap by loosening the tolerance", () => {
    const points = Array.from({ length: 200 }, (_, i) => ({ offset: i / 199, value: Math.sin(i / 3) }));
    expect(simplifyKeyframes(points, 0.001, 8).length).toBeLessThanOrEqual(8);
  });

  it("returns both ends for a flat line and copies short inputs", () => {
    expect(simplifyKeyframes([{ offset: 0, value: 1 }, { offset: 0.5, value: 1 }, { offset: 1, value: 1 }])).toEqual([
      { offset: 0, value: 1 },
      { offset: 1, value: 1 },
    ]);
    expect(simplifyKeyframes([{ offset: 0, value: 3 }])).toEqual([{ offset: 0, value: 3 }]);
  });
});

describe("fitCubicBezier", () => {
  const sample = (curve: Bezier, count = 40) => Array.from({ length: count }, (_, i) => ({ x: i / (count - 1), y: bezierAt(curve, i / (count - 1)) }));

  it("snaps to the standard easing the samples came from", () => {
    expect(fitCubicBezier(sample([0.215, 0.61, 0.355, 1]))).toMatchObject({ bezier: [0.215, 0.61, 0.355, 1], named: "power2.out" });
    expect(fitCubicBezier(sample([0.25, 0.1, 0.25, 1])).named).toBe("ease");
    expect(fitCubicBezier(sample([0, 0, 1, 1])).named).toBe("linear");
  });

  it("recovers a custom curve closely", () => {
    for (const curve of [
      [0.7, 0.1, 0.3, 0.9],
      [0.2, 0, 0, 1],
      [0.5, -0.3, 0.6, 1.4],
    ] as Bezier[]) {
      const fit = fitCubicBezier(sample(curve));
      expect(fit.error).toBeLessThan(0.006);
      expect(curveDistance(fit.bezier, curve)).toBeLessThan(0.02);
      expect(fit.bezier[0]).toBeGreaterThanOrEqual(0);
      expect(fit.bezier[2]).toBeLessThanOrEqual(1);
    }
  });

  it("still finds the curve under frame jitter and noise", () => {
    const curve: Bezier = [0.4, 0, 0.2, 1];
    const noisy = Array.from({ length: 19 }, (_, i) => {
      const x = Math.min(1, Math.max(0, i / 18 + (i % 3 === 0 ? 0.004 : -0.003)));
      return { x, y: bezierAt(curve, x) + (i % 2 === 0 ? 0.01 : -0.01) };
    });
    const fit = fitCubicBezier(noisy);
    expect(curveDistance(fit.bezier, curve)).toBeLessThan(0.04);
  });
});

describe("familyOf", () => {
  it("maps property names from every source to a family", () => {
    for (const name of ["transform", "x", "rotation", "xPercent", "scale", "translate", "position.y"]) expect(familyOf(name)).toBe("transform");
    expect(familyOf("autoAlpha")).toBe("opacity");
    expect(familyOf("max-height")).toBe("size");
    expect(familyOf("clipPath")).toBe("clip");
    expect(familyOf("background-color")).toBeUndefined();
  });
});

describe("frame sampling", () => {
  const curve: Bezier = [0.215, 0.61, 0.355, 1];

  /** A hover window where #chip moves to y=-4 over 300 ms with `curve`, starting one frame in. */
  function hoverWindow(): FrameWindow {
    const times = frameTimes(900);
    const samples = times.map((t) => {
      const p = Math.min(1, Math.max(0, (t - 16.67) / 300));
      return node({ transform: translateY(-4 * bezierAt(curve, p)) });
    });
    return { kind: "hover", target: "#chip", times, nodes: [{ selector: "#chip", samples }, { selector: "#still", samples: times.map(() => node()) }] };
  }

  /** An idle window with #dot pulsing opacity on a 600 ms period. */
  function idleWindow(): FrameWindow {
    const times = frameTimes(1500);
    return {
      kind: "idle",
      times,
      nodes: [
        { selector: "#dot", samples: times.map((t) => node({ opacity: 0.6 + 0.4 * Math.cos((2 * Math.PI * t) / 600) })) },
        { selector: "#chip", samples: times.map(() => node()) },
      ],
    };
  }

  it("turns a hover move with no entry into a sampled hover entry with a fitted curve", () => {
    const [draft, ...rest] = fromFrameWindows([hoverWindow()], []);
    expect(rest).toHaveLength(0);
    expect(draft?.entry).toMatchObject({
      source: "sampled",
      target: "#chip",
      trigger: "hover",
      confidence: "approximate",
      delay: 0,
      iterations: 1,
      properties: [{ name: "y", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: -4 }] }],
    });
    expect(Math.abs((draft?.entry.duration ?? 0) - 300)).toBeLessThanOrEqual(34);
    expect(curveDistance(draft?.entry.easing as Bezier, curve)).toBeLessThan(0.08);
  });

  it("finds an idle loop and its period, and keeps loops out of hover windows", () => {
    const hover: FrameWindow = { ...hoverWindow(), nodes: [...hoverWindow().nodes, idleWindow().nodes[0] as FrameWindow["nodes"][number]] };
    // The dot keeps pulsing in the hover window too; give it the right number of samples.
    hover.nodes[2] = { selector: "#dot", samples: hover.times.map((t) => node({ opacity: 0.6 + 0.4 * Math.cos((2 * Math.PI * t) / 600) })) };
    const drafts = fromFrameWindows([idleWindow(), hover], []);
    const loop = drafts.find((d) => d.entry.target === "#dot");
    expect(loop?.entry).toMatchObject({ trigger: "loop", iterations: "infinite", easing: "linear" });
    expect(Math.abs((loop?.entry.duration ?? 0) - 600)).toBeLessThan(25);
    const keyframes = loop?.entry.properties[0]?.keyframes ?? [];
    expect(keyframes[0]).toEqual({ offset: 0, value: 1 });
    expect(keyframes.some((k) => Math.abs(Number(k.value) - 0.2) < 0.03)).toBe(true);
    // Only one entry for the dot: its pulse in the hover window is the same loop.
    expect(drafts.filter((d) => d.entry.target === "#dot")).toHaveLength(1);
    expect(drafts.filter((d) => d.entry.trigger === "hover").map((d) => d.entry.target)).toEqual(["#chip"]);
  });

  it("skips nodes whose motion an existing entry already covers", () => {
    const existing = [entry({ target: "#chip", properties: [{ name: "transform", keyframes: [{ offset: 0, value: "none" }] }] })];
    expect(fromFrameWindows([hoverWindow()], existing)).toEqual([]);
    // An entry for another property family does not cover the move.
    const other = [entry({ target: "#chip", properties: [{ name: "background-color", keyframes: [{ offset: 0, value: "red" }] }] })];
    expect(fromFrameWindows([hoverWindow()], other)).toHaveLength(1);
  });

  it("falls back to simplified keyframes and linear easing when the motion goes out and back", () => {
    const times = frameTimes(800);
    const samples = times.map((t) => node({ transform: translateY(t < 400 ? (-8 * t) / 400 : t < 800 ? -8 + (8 * (t - 400)) / 400 : 0) }));
    samples[samples.length - 1] = node();
    const [draft] = fromFrameWindows([{ kind: "focus", target: "#a", times, nodes: [{ selector: "#a", samples }] }], []);
    expect(draft?.entry.easing).toBe("linear");
    expect(draft?.entry.trigger).toBe("focus");
    const keyframes = draft?.entry.properties[0]?.keyframes ?? [];
    expect(keyframes.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...keyframes.map((k) => Number(k.value)))).toBeCloseTo(-8, 0);
  });
});

describe("scroll sampling", () => {
  const scrollY = Array.from({ length: 21 }, (_, i) => i * 50);

  it("turns scroll-linked transform into a near scroll entry over the range where it changes", () => {
    const drafts = fromScrollSamples(
      {
        scrollY,
        nodes: [
          {
            selector: "#orb",
            // Moves between scrollY 200 and 800.
            samples: scrollY.map((y) => node({ transform: translateY(-Math.min(120, Math.max(0, (y - 200) / 5))), box: { x: 0, y: 400, width: 80, height: 80 } })),
          },
          { selector: "#still", samples: scrollY.map(() => node()) },
        ],
      },
      [],
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.entry).toMatchObject({
      source: "sampled",
      target: "#orb",
      trigger: "scroll",
      confidence: "near",
      easing: "linear",
      scroll: { start: 200, end: 800, scrub: true, pin: false },
      properties: [{ name: "y", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: -120 }] }],
    });
    expect((drafts[0]?.entry.raw as { bbox: unknown[] }).bbox.length).toBeGreaterThan(0);
  });

  it("does not duplicate a ScrollTrigger entry for the same node and family", () => {
    const samples = scrollY.map((y) => node({ transform: translateY(y / 10), opacity: 1 - y / 2000 }));
    const scrollTrigger = entry({ source: "scrolltrigger", trigger: "scroll", target: "#box, #other", properties: [{ name: "y", keyframes: [{ offset: 0, value: 0 }] }] });
    const drafts = fromScrollSamples({ scrollY, nodes: [{ selector: "#box", samples }] }, [scrollTrigger]);
    // Transform is covered by the ScrollTrigger; opacity is not.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.entry.properties.map((p) => p.name)).toEqual(["opacity"]);
  });

  it("records clip-path changes and leaves out channels that move on their own", () => {
    const samples = scrollY.map((y, i) => node({ clipPath: y < 500 ? "inset(0px 0px 50% 0px)" : "inset(0px)", opacity: i % 2 === 0 ? 1 : 0.5 }));
    const loops = new Map([["#clip", new Set(["opacity" as const])]]);
    const drafts = fromScrollSamples({ scrollY, nodes: [{ selector: "#clip", samples }] }, [], loops);
    expect(drafts[0]?.entry.properties).toEqual([
      {
        name: "clip-path",
        keyframes: [
          { offset: 0, value: "inset(0px 0px 50% 0px)" },
          { offset: 1, value: "inset(0px)" },
        ],
      },
    ]);
  });
});

describe("merging", () => {
  it("replaces old sampled entries, numbers new ones and refreshes the summary", () => {
    const motion = {
      entries: [entry({ id: "css-transition-1" }), entry({ id: "sampled-1", source: "sampled", target: "#old" })],
      warnings: ["kept"],
    };
    const drafts = analyseSamples({
      windows: [],
      scroll: { scrollY: [0, 100, 200], nodes: [{ selector: "#n", samples: [node(), node({ opacity: 0.5 }), node({ opacity: 0 })] }] },
      existing: motion.entries,
    });
    const merged = mergeSampledMotion(motion, [...drafts, ...drafts]);
    expect(merged.entries.map((e) => e.id)).toEqual(["css-transition-1", "sampled-1"]);
    expect(merged.entries[1]?.target).toBe("#n");
    expect(merged.warnings).toEqual(["kept"]);
    expect(merged.summary).toMatchObject({ total: 2, bySource: { "css-transition": 1, sampled: 1 } });
  });
});
