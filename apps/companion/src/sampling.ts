// Turns what the recorder samples in the page into motion entries. Pure, so it is
// unit tested with synthetic curves.
//
// Scroll sampling: values for every node at each scroll step become entries with
// trigger "scroll" and confidence "near". Frame sampling: values on every animation
// frame, for motion that no existing entry explains, become entries with source
// "sampled" and confidence "approximate". Either way a node and property that an
// existing entry already covers is left alone, so nothing is captured twice.

import { type Bezier, bezierAt, CSS_NAMED_EASINGS, gsapEaseToBezier, type Motion, type MotionEntry, summariseMotion } from "@kinetic/schema";

// ─── values ──────────────────────────────────────────────────────────────────

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the page reports for one node at one moment. */
export interface NodeValues {
  /** Computed transform: "none", "matrix(…)" or "matrix3d(…)". */
  transform: string;
  opacity: number;
  /** Layout size (offsetWidth and offsetHeight), which transforms do not change. */
  width: number;
  height: number;
  /** Computed clip-path, scroll samples only. */
  clipPath?: string;
  /** Document-space bounding box, scroll samples only. */
  box?: Box;
}

/** The 2D part of a transform matrix: matrix(a, b, c, d, e, f). */
export type Matrix2D = [number, number, number, number, number, number];

/** Reads matrix() or matrix3d() as its 2D part. "none" and anything unreadable give null. */
export function parseTransformMatrix(value: string): Matrix2D | null {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(value.trim());
  if (!m?.[2]) return null;
  const n = m[2].split(",").map((s) => Number(s.trim()));
  if (n.some((x) => !Number.isFinite(x))) return null;
  // matrix3d is column-major: m11 m12 . . m21 m22 . . . . . . m41 m42 . .
  if (m[1]) return n.length === 16 ? [n[0], n[1], n[4], n[5], n[12], n[13]] as Matrix2D : null;
  return n.length === 6 ? (n as Matrix2D) : null;
}

export interface Transform {
  /** px */
  x: number;
  /** px */
  y: number;
  /** degrees */
  rotate: number;
  scaleX: number;
  scaleY: number;
}

/** Splits a 2D matrix into translate, rotate and scale. Skew folds into scaleY. */
export function decomposeMatrix(m: Matrix2D | null): Transform {
  if (!m) return { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1 };
  const [a, b, c, d, e, f] = m;
  const scaleX = Math.hypot(a, b);
  if (scaleX === 0) return { x: e, y: f, rotate: 0, scaleX: 0, scaleY: Math.hypot(c, d) };
  return { x: e, y: f, rotate: (Math.atan2(b, a) * 180) / Math.PI, scaleX, scaleY: (a * d - b * c) / scaleX };
}

const CHANNELS = ["x", "y", "rotate", "scaleX", "scaleY", "opacity", "width", "height"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Changes smaller than this are noise: half a pixel, half a degree, half a percent. */
const EPSILON: Record<Channel, number> = { x: 0.5, y: 0.5, rotate: 0.5, scaleX: 0.005, scaleY: 0.005, opacity: 0.01, width: 0.5, height: 0.5 };
const DECIMALS: Record<Channel, number> = { x: 1, y: 1, rotate: 1, scaleX: 3, scaleY: 3, opacity: 3, width: 1, height: 1 };

export type Family = "transform" | "opacity" | "size" | "clip";
const CHANNEL_FAMILY: Record<Channel, Family> = {
  x: "transform",
  y: "transform",
  rotate: "transform",
  scaleX: "transform",
  scaleY: "transform",
  opacity: "opacity",
  width: "size",
  height: "size",
};

type Series = Record<Channel, number[]>;

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  // "|| 0" turns -0 into 0, which JSON would otherwise write as 0 but tests and Object.is tell apart.
  return Math.round(value * f) / f || 0;
}

/** Removes the jump when an angle read back from atan2 wraps from 180 to -180 degrees. */
function unwrapDegrees(values: number[]): number[] {
  let offset = 0;
  return values.map((value, i) => {
    if (i > 0) {
      const delta = value + offset - ((values[i - 1] as number) + offset);
      if (delta > 180) offset -= 360;
      else if (delta < -180) offset += 360;
    }
    return value + offset;
  });
}

function seriesOf(samples: readonly NodeValues[]): Series {
  const out = Object.fromEntries(CHANNELS.map((c) => [c, [] as number[]])) as Series;
  for (const s of samples) {
    const t = decomposeMatrix(parseTransformMatrix(s.transform));
    out.x.push(t.x);
    out.y.push(t.y);
    out.rotate.push(t.rotate);
    out.scaleX.push(t.scaleX);
    out.scaleY.push(t.scaleY);
    out.opacity.push(s.opacity);
    out.width.push(s.width);
    out.height.push(s.height);
  }
  out.rotate = unwrapDegrees(out.rotate);
  return out;
}

function range(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

// ─── keyframe simplification ─────────────────────────────────────────────────

export interface Point {
  offset: number;
  value: number;
}

function rdp(points: readonly Point[], tolerance: number, span: number): Point[] {
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    const a = points[lo] as Point;
    const b = points[hi] as Point;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i] as Point;
      const t = b.offset === a.offset ? 0 : (p.offset - a.offset) / (b.offset - a.offset);
      const expected = a.value + (b.value - a.value) * t;
      // Vertical distance in units of the value range, so pixels and opacity share one tolerance.
      const distance = Math.abs(p.value - expected) / span;
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst !== -1) {
      keep[worst] = true;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Ramer–Douglas–Peucker on a sampled curve: keeps the fewest points that stay
 * within `tolerance` (a fraction of the value range) of every sample, always
 * keeping both ends. Loosens the tolerance until at most `maxPoints` remain.
 */
export function simplifyKeyframes(points: readonly Point[], tolerance = 0.02, maxPoints = 12): Point[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const values = points.map((p) => p.value);
  const span = Math.max(...values) - Math.min(...values);
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  if (span === 0) return [{ ...first }, { ...last }];
  let tol = tolerance;
  let kept = rdp(points, tol, span);
  while (kept.length > Math.max(2, maxPoints)) {
    tol *= 1.5;
    kept = rdp(points, tol, span);
  }
  return kept.map((p) => ({ ...p }));
}

// ─── easing fit ──────────────────────────────────────────────────────────────

export interface FitPoint {
  /** Time, 0 to 1. */
  x: number;
  /** Progress, 0 to 1 (can overshoot). */
  y: number;
}

export interface BezierFit {
  bezier: Bezier;
  /** Root-mean-square distance between the curve and the samples, in progress units. */
  error: number;
  /** The standard easing the fit snapped to, e.g. "ease-out" or "power2.out". */
  named?: string;
}

/** Standard curves a fit snaps to when one matches the samples as well as the free fit does. */
const NAMED_CURVES: readonly [string, Bezier][] = (() => {
  const out: [string, Bezier][] = [["linear", [0, 0, 1, 1]]];
  for (const [name, curve] of Object.entries(CSS_NAMED_EASINGS)) out.push([name, curve]);
  for (const family of ["power1", "power2", "power3", "power4", "sine", "expo", "circ", "back"]) {
    for (const direction of ["in", "out", "inOut"]) {
      const curve = gsapEaseToBezier(`${family}.${direction}`);
      if (Array.isArray(curve)) out.push([`${family}.${direction}`, curve]);
    }
  }
  return out;
})();

/** How much worse than the free fit a standard curve may be and still be preferred. */
const SNAP_TOLERANCE = 0.004;

function rms(bezier: Bezier, points: readonly FitPoint[]): number {
  let sum = 0;
  for (const p of points) sum += (bezierAt(bezier, p.x) - p.y) ** 2;
  return Math.sqrt(sum / points.length);
}

function evenSubset<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return Array.from({ length: max }, (_, k) => items[Math.round((k * (items.length - 1)) / (max - 1))] as T);
}

/**
 * Finds the cubic-bezier closest to sampled progress: a coarse grid over the control
 * points, then a pattern search that halves its step until it stops improving.
 * x control points stay in [0, 1] as CSS requires; y may overshoot to [-1, 2].
 * Snaps to a standard easing when one fits within SNAP_TOLERANCE of the free fit.
 */
export function fitCubicBezier(samples: readonly FitPoint[]): BezierFit {
  const points = evenSubset(
    samples.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    48,
  );
  if (points.length < 2) return { bezier: [0, 0, 1, 1], error: 0, named: "linear" };

  const xs = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  const ys = [-0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
  let best: Bezier = [0, 0, 1, 1];
  let bestError = rms(best, points);
  for (const x1 of xs) {
    for (const y1 of ys) {
      for (const x2 of xs) {
        for (const y2 of ys) {
          const candidate: Bezier = [x1, y1, x2, y2];
          const error = rms(candidate, points);
          if (error < bestError) {
            best = candidate;
            bestError = error;
          }
        }
      }
    }
  }

  const limits: [number, number][] = [
    [0, 1],
    [-1, 2],
    [0, 1],
    [-1, 2],
  ];
  for (let step = 0.0625; step >= 0.0005; ) {
    let improved = false;
    for (let i = 0; i < 4; i++) {
      for (const sign of [1, -1]) {
        const candidate = [...best] as Bezier;
        const [lo, hi] = limits[i] as [number, number];
        candidate[i] = Math.min(hi, Math.max(lo, (candidate[i] as number) + sign * step));
        const error = rms(candidate, points);
        if (error < bestError - 1e-9) {
          best = candidate;
          bestError = error;
          improved = true;
        }
      }
    }
    if (!improved) step /= 2;
  }

  let snapped: { name: string; curve: Bezier; error: number } | undefined;
  for (const [name, curve] of NAMED_CURVES) {
    const error = rms(curve, points);
    if (error <= bestError + SNAP_TOLERANCE && (!snapped || error < snapped.error)) snapped = { name, curve, error };
  }
  if (snapped) return { bezier: [...snapped.curve], error: roundTo(snapped.error, 4), named: snapped.name };
  return { bezier: best.map((v) => roundTo(v, 3)) as Bezier, error: roundTo(bestError, 4) };
}

/** Largest vertical gap between two easing curves, sampled across time. For tests and checks. */
export function curveDistance(a: Bezier, b: Bezier): number {
  let worst = 0;
  for (let i = 0; i <= 100; i++) worst = Math.max(worst, Math.abs(bezierAt(a, i / 100) - bezierAt(b, i / 100)));
  return worst;
}

// ─── coverage by existing entries ────────────────────────────────────────────

/** The family a property name from any motion source belongs to: CSS, GSAP, Framer Motion or three. */
export function familyOf(property: string): Family | undefined {
  const name = property.toLowerCase();
  if (
    /^(transform|translate|rotate|scale|skew|x|y|z|xpercent|ypercent|rotation|rotationx|rotationy|rotationz|rotatex|rotatey|rotatez|scalex|scaley|scalez|skewx|skewy|translatex|translatey|translatez|transformperspective)$/.test(
      name,
    ) ||
    /^(position|rotation|scale)\./.test(name)
  ) {
    return "transform";
  }
  if (name === "opacity" || name === "autoalpha") return "opacity";
  if (/^((min|max)-?)?(width|height)$|^(inline|block)-size$/.test(name)) return "size";
  if (name === "clip-path" || name === "clippath") return "clip";
  return undefined;
}

/** Selectors an entry targets. GSAP joins several targets with ", ". */
function targetsOf(entry: MotionEntry): string[] {
  return entry.target.split(", ").map((s) => s.trim());
}

/** Families of the given node that existing entries (passing `filter`) already describe. */
export function coveredFamilies(entries: readonly MotionEntry[], selector: string, filter: (entry: MotionEntry) => boolean = () => true): Set<Family> {
  const covered = new Set<Family>();
  for (const entry of entries) {
    if (entry.source === "sampled" || !filter(entry) || !targetsOf(entry).includes(selector)) continue;
    for (const property of entry.properties) {
      const family = familyOf(property.name);
      if (family) covered.add(family);
    }
  }
  return covered;
}

// ─── building entries ────────────────────────────────────────────────────────

export type SampledEntry = Omit<MotionEntry, "id">;
export interface SampledDraft {
  key: string;
  entry: SampledEntry;
}

interface NamedSeries {
  name: string;
  channel: Channel;
  values: number[];
}

/** The output properties for changed channels: scaleX and scaleY merge into scale when they move together. */
function outputSeries(changed: readonly Channel[], series: Series): NamedSeries[] {
  const out: NamedSeries[] = [];
  const both = changed.includes("scaleX") && changed.includes("scaleY");
  const uniform = both && series.scaleX.every((v, i) => Math.abs(v - (series.scaleY[i] as number)) < EPSILON.scaleX);
  for (const channel of changed) {
    if (uniform && channel === "scaleY") continue;
    const name = uniform && channel === "scaleX" ? "scale" : channel;
    out.push({ name, channel, values: series[channel] });
  }
  return out;
}

function keyframesFor(s: NamedSeries, offsets: readonly number[], from: number, to: number): { offset: number; value: number }[] {
  const points: Point[] = [];
  for (let i = from; i <= to; i++) points.push({ offset: Math.min(1, Math.max(0, offsets[i - from] as number)), value: s.values[i] as number });
  return simplifyKeyframes(points).map((p) => ({ offset: roundTo(p.offset, 3), value: roundTo(p.value, DECIMALS[s.channel]) }));
}

/** Channels that change by more than their noise floor, minus covered families and excluded channels. */
function changedChannels(series: Series, covered: Set<Family>, excluded: Set<Channel> | undefined): Channel[] {
  return CHANNELS.filter((c) => range(series[c]) > EPSILON[c] && !covered.has(CHANNEL_FAMILY[c]) && !excluded?.has(c));
}

/** One window of frame samples: idle time, or the moments after a hover or focus started. */
export interface FrameWindow {
  kind: "idle" | "hover" | "focus";
  /** Selector of the hovered or focused element. */
  target?: string;
  /** ms from the start of the window (when the pointer moved or focus changed). */
  times: number[];
  /** samples[i] is the node at times[i]. */
  nodes: { selector: string; samples: NodeValues[] }[];
}

/** Steps through the scroll range: actual scrollY per step, and every node at each step. */
export interface ScrollSamples {
  scrollY: number[];
  nodes: { selector: string; samples: NodeValues[] }[];
}

/** Delays shorter than this are the frame or two between the input and the first change, not a real delay. */
const MIN_DELAY_MS = 50;
/** A free bezier fit worse than this (RMS, progress units) falls back to simplified keyframes and linear easing. */
const MAX_FIT_ERROR = 0.05;

/** Channels each node moves on its own while idle: running loops, not reactions to input or scroll. */
export function idleChannels(windows: readonly FrameWindow[]): Map<string, Set<Channel>> {
  const out = new Map<string, Set<Channel>>();
  for (const window of windows) {
    if (window.kind !== "idle") continue;
    for (const node of window.nodes) {
      const series = seriesOf(node.samples);
      const moving = CHANNELS.filter((c) => range(series[c]) > EPSILON[c]);
      if (moving.length === 0) continue;
      const set = out.get(node.selector) ?? new Set<Channel>();
      for (const c of moving) set.add(c);
      out.set(node.selector, set);
    }
  }
  return out;
}

/** Period of a repeating series from its mean crossings, or undefined when fewer than two crossings show. */
function estimatePeriod(times: readonly number[], values: readonly number[]): number | undefined {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const crossings: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const a = (values[i - 1] as number) - mean;
    const b = (values[i] as number) - mean;
    if (a === 0 || Math.sign(a) === Math.sign(b) || b === 0) continue;
    const t0 = times[i - 1] as number;
    const t1 = times[i] as number;
    crossings.push(t0 + ((t1 - t0) * a) / (a - b));
  }
  if (crossings.length < 2) return undefined;
  const gaps = crossings.slice(1).map((t, i) => t - (crossings[i] as number));
  return (2 * gaps.reduce((a, b) => a + b, 0)) / gaps.length;
}

function loopEntry(selector: string, times: readonly number[], outputs: readonly NamedSeries[], dominant: NamedSeries): SampledDraft {
  const t0 = times[0] as number;
  const windowMs = (times[times.length - 1] as number) - t0;
  const estimated = estimatePeriod(times, dominant.values);
  const period = estimated !== undefined && estimated < windowMs ? estimated : windowMs;
  let last = times.findIndex((t) => t - t0 >= period);
  if (last === -1) last = times.length - 1;
  const offsets = times.slice(0, last + 1).map((t) => (t - t0) / period);
  return {
    key: `sampled|loop|${selector}`,
    entry: {
      source: "sampled",
      target: selector,
      trigger: "loop",
      properties: outputs.map((s) => ({ name: s.name, keyframes: keyframesFor(s, offsets, 0, last) })),
      duration: Math.round(period),
      delay: 0,
      easing: "linear",
      iterations: "infinite",
      direction: "normal",
      confidence: "approximate",
      raw: { window: "idle", frames: times.length, sampledMs: Math.round(windowMs), periodFound: estimated !== undefined && estimated < windowMs },
    },
  };
}

function transitionEntry(window: FrameWindow, selector: string, series: Series, changed: readonly Channel[]): SampledDraft | undefined {
  const { times } = window;
  const n = times.length;
  const outputs = outputSeries(changed, series);
  // Start and settle use a threshold far below the noise floor: the noise floor decides whether
  // a channel moved at all, but an ease-out gets within half a pixel of its end long before it stops.
  const settle = Object.fromEntries(changed.map((c) => [c, Math.max(1e-6, 1e-4 * range(series[c]))])) as Record<Channel, number>;
  const differs = (i: number, j: number) => changed.some((c) => Math.abs((series[c][i] as number) - (series[c][j] as number)) > settle[c]);

  let first = -1;
  for (let i = 1; i < n && first === -1; i++) if (differs(i, 0)) first = i;
  if (first === -1) return undefined;
  const startIdx = first - 1;
  let lastFar = startIdx;
  for (let i = startIdx; i < n; i++) if (differs(i, n - 1)) lastFar = i;
  const endIdx = Math.min(n - 1, lastFar + 1);

  const tStart = times[startIdx] as number;
  const duration = Math.max(0, (times[endIdx] as number) - tStart);
  const delayMs = window.kind === "idle" || tStart < MIN_DELAY_MS ? 0 : Math.round(tStart);
  const offsets = times.slice(startIdx, endIdx + 1).map((t) => (duration > 0 ? (t - tStart) / duration : 1));

  // A clean change from one value to another: two keyframes plus the fitted curve.
  const progress = outputs.every((s) => Math.abs((s.values[n - 1] as number) - (s.values[startIdx] as number)) > EPSILON[s.channel]);
  let properties: MotionEntry["properties"] | undefined;
  let easing: MotionEntry["easing"] = "linear";
  let fit: BezierFit | undefined;
  if (progress && duration > 0) {
    const points: FitPoint[] = [];
    for (const s of outputs) {
      const v0 = s.values[startIdx] as number;
      const v1 = s.values[n - 1] as number;
      for (let i = startIdx; i <= endIdx; i++) points.push({ x: offsets[i - startIdx] as number, y: ((s.values[i] as number) - v0) / (v1 - v0) });
    }
    fit = fitCubicBezier(points);
    if (fit.error <= MAX_FIT_ERROR) {
      easing = fit.bezier;
      properties = outputs.map((s) => ({
        name: s.name,
        keyframes: [
          { offset: 0, value: roundTo(s.values[startIdx] as number, DECIMALS[s.channel]) },
          { offset: 1, value: roundTo(s.values[n - 1] as number, DECIMALS[s.channel]) },
        ],
      }));
    }
  }
  properties ??=
    duration > 0
      ? outputs.map((s) => ({ name: s.name, keyframes: keyframesFor(s, offsets, startIdx, endIdx) }))
      : outputs.map((s) => ({
          name: s.name,
          keyframes: [
            { offset: 0, value: roundTo(s.values[startIdx] as number, DECIMALS[s.channel]) },
            { offset: 1, value: roundTo(s.values[n - 1] as number, DECIMALS[s.channel]) },
          ],
        }));

  const trigger = window.kind === "idle" ? "load" : window.kind;
  return {
    key: `sampled|${trigger}|${selector}|${window.target ?? ""}`,
    entry: {
      source: "sampled",
      target: selector,
      trigger,
      properties,
      duration: Math.round(duration),
      delay: delayMs,
      easing,
      iterations: 1,
      direction: "normal",
      confidence: "approximate",
      raw: {
        window: window.kind,
        ...(window.target ? { inputTarget: window.target } : {}),
        frames: endIdx - startIdx + 1,
        ...(fit ? { fitError: fit.error, ...(fit.named ? { fitNamed: fit.named } : {}) } : {}),
      },
    },
  };
}

/**
 * Frame sampling: one entry per node that visibly moved in a window and that no
 * existing entry covers. Idle motion still running at the end of the window is a
 * loop; anything else is a transition with two keyframes and a fitted cubic-bezier,
 * or simplified keyframes with linear easing when no curve fits. Hover and focus
 * windows leave out channels the node already moves while idle.
 */
export function fromFrameWindows(windows: readonly FrameWindow[], existing: readonly MotionEntry[]): SampledDraft[] {
  const loops = idleChannels(windows);
  const drafts: SampledDraft[] = [];
  for (const window of windows) {
    if (window.times.length < 3) continue;
    for (const node of window.nodes) {
      if (node.samples.length !== window.times.length) continue;
      const series = seriesOf(node.samples);
      const changed = changedChannels(series, coveredFamilies(existing, node.selector), window.kind === "idle" ? undefined : loops.get(node.selector));
      if (changed.length === 0) continue;

      if (window.kind === "idle") {
        const n = window.times.length;
        const tail = Math.max(1, Math.floor(n * 0.8));
        const movingAtEnd = changed.some((c) => range(series[c].slice(tail - 1)) > EPSILON[c]);
        if (movingAtEnd) {
          const outputs = outputSeries(changed, series);
          const dominant = outputs.reduce((a, b) => (range(b.values) / EPSILON[b.channel] > range(a.values) / EPSILON[a.channel] ? b : a));
          drafts.push(loopEntry(node.selector, window.times, outputs, dominant));
          continue;
        }
      }
      const draft = transitionEntry(window, node.selector, series, changed);
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}

/**
 * Scroll sampling: one entry per node whose transform, opacity, size or clip-path
 * changes across the scroll steps, unless an existing scroll entry (a ScrollTrigger,
 * say) covers that node and property family or the node moves on its own while
 * idle. The scroll range is narrowed to the steps where the node actually changes.
 */
export function fromScrollSamples(samples: ScrollSamples, existing: readonly MotionEntry[], loops: Map<string, Set<Channel>> = new Map()): SampledDraft[] {
  const { scrollY } = samples;
  const n = scrollY.length;
  if (n < 2) return [];
  const drafts: SampledDraft[] = [];
  const isScrollEntry = (e: MotionEntry) => e.trigger === "scroll" || e.source === "scrolltrigger";
  for (const node of samples.nodes) {
    if (node.samples.length !== n) continue;
    const series = seriesOf(node.samples);
    const covered = coveredFamilies(existing, node.selector, isScrollEntry);
    const changed = changedChannels(series, covered, loops.get(node.selector));
    const clips = node.samples.map((s) => s.clipPath ?? "none");
    const clipChanged = !covered.has("clip") && new Set(clips).size > 1;
    if (changed.length === 0 && !clipChanged) continue;

    const stepChanged = (i: number) =>
      changed.some((c) => Math.abs((series[c][i] as number) - (series[c][i - 1] as number)) > EPSILON[c] / 2) || (clipChanged && clips[i] !== clips[i - 1]);
    let firstChange = -1;
    let lastChange = -1;
    for (let i = 1; i < n; i++) {
      if (!stepChanged(i)) continue;
      if (firstChange === -1) firstChange = i;
      lastChange = i;
    }
    if (firstChange === -1) continue;
    const a = firstChange - 1;
    const b = lastChange;
    const start = scrollY[a] as number;
    const end = scrollY[b] as number;
    if (end <= start) continue;
    const offsets = scrollY.slice(a, b + 1).map((y) => (y - start) / (end - start));

    const properties: MotionEntry["properties"] = outputSeries(changed, series).map((s) => ({ name: s.name, keyframes: keyframesFor(s, offsets, a, b) }));
    if (clipChanged) {
      const keyframes: { offset: number; value: string }[] = [];
      for (let i = a; i <= b; i++) {
        const value = clips[i] as string;
        if (keyframes.at(-1)?.value !== value || i === b) keyframes.push({ offset: roundTo(offsets[i - a] as number, 3), value });
      }
      properties.push({ name: "clip-path", keyframes: evenSubset(keyframes, 12) });
    }
    const boxes = evenSubset(
      node.samples.slice(a, b + 1).flatMap((s, i) =>
        s.box ? [{ offset: roundTo(offsets[i] as number, 3), x: roundTo(s.box.x, 1), y: roundTo(s.box.y, 1), width: roundTo(s.box.width, 1), height: roundTo(s.box.height, 1) }] : [],
      ),
      12,
    );

    drafts.push({
      key: `sampled|scroll|${node.selector}`,
      entry: {
        source: "sampled",
        target: node.selector,
        trigger: "scroll",
        properties,
        duration: 0,
        delay: 0,
        easing: "linear",
        iterations: 1,
        direction: "normal",
        scroll: { start: Math.round(start), end: Math.round(end), scrub: true, pin: false },
        confidence: "near",
        raw: { steps: b - a + 1, ...(boxes.length > 0 ? { bbox: boxes } : {}) },
      },
    });
  }
  return drafts;
}

/** Scroll entries plus frame-sampled entries for one recording. */
export function analyseSamples(input: { windows: readonly FrameWindow[]; scroll?: ScrollSamples; existing: readonly MotionEntry[] }): SampledDraft[] {
  const existing = input.existing.filter((e) => e.source !== "sampled");
  const scroll = input.scroll ? fromScrollSamples(input.scroll, existing, idleChannels(input.windows)) : [];
  return [...scroll, ...fromFrameWindows(input.windows, existing)];
}

/**
 * Replaces the sampled entries in a motion block with new ones (so recording twice
 * does not duplicate them), numbers them sampled-1, sampled-2, … and refreshes the
 * summary. Every other entry and field is kept as it was.
 */
export function mergeSampledMotion(motion: Motion | undefined, drafts: readonly SampledDraft[]): Motion {
  const kept = (motion?.entries ?? []).filter((e) => e.source !== "sampled");
  const seen = new Set<string>();
  const added: MotionEntry[] = [];
  for (const { key, entry } of drafts) {
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ id: `sampled-${added.length + 1}`, ...entry });
  }
  const entries = [...kept, ...added];
  return { ...motion, entries, summary: summariseMotion(entries) };
}
