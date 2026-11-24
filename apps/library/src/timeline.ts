// Motion timeline layout and easing curves. Pure, so the geometry is unit tested.

import type { Easing, MotionEntry } from "@kinetic/schema";
import { type Bezier, bezierAt, FRAMER_NAMED_EASINGS, gsapEaseToBezier, parseCssEasing } from "@kinetic/schema/easing";

export type Point = [x: number, y: number];

const SAMPLES = 48;

function sample(fn: (x: number) => number): Point[] {
  return Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const x = i / SAMPLES;
    return [x, fn(x)];
  });
}

const fromBezier = (bezier: Bezier) => sample((x) => bezierAt(bezier, x));

/** A damped spring from 0 to 1 over its settle time, with damping ratio zeta. */
function springCurve(zeta: number): Point[] {
  const z = Math.min(Math.max(zeta, 0.05), 4);
  // Scale time so the curve settles (within 1%) at x = 1.
  const settle = z < 1 ? Math.log(100) / z : Math.log(100) * (z + Math.sqrt(z * z - 1));
  return sample((x) => {
    const t = x * settle;
    if (z < 1) {
      const wd = Math.sqrt(1 - z * z);
      return 1 - Math.exp(-z * t) * (Math.cos(wd * t) + (z / wd) * Math.sin(wd * t));
    }
    if (z === 1) return 1 - Math.exp(-t) * (1 + t);
    const r = Math.sqrt(z * z - 1);
    const r1 = -z + r;
    const r2 = -z - r;
    return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
  });
}

function namedNumber(text: string, name: string): number | undefined {
  const m = new RegExp(`${name}\\s*:\\s*(-?[\\d.]+)`).exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * Points (x and y from 0 to 1, y may overshoot) for an easing, or undefined when
 * the easing has no drawable curve. Handles cubic-bezier points, CSS names,
 * steps(), linear() stops, GSAP and Framer Motion names, and the spring strings
 * the extension writes.
 */
export function easingCurve(easing: Easing): Point[] | undefined {
  if (typeof easing !== "string") return fromBezier(easing);
  const text = easing.trim();
  if (text === "linear" || text === "none") return [[0, 0], [1, 1]];

  if (text.startsWith("spring(")) {
    const bounce = namedNumber(text, "bounce");
    if (bounce !== undefined) return springCurve(1 - bounce);
    const k = namedNumber(text, "stiffness") ?? 100;
    const c = namedNumber(text, "damping") ?? 10;
    const m = namedNumber(text, "mass") ?? 1;
    return springCurve(c / (2 * Math.sqrt(k * m)));
  }

  const steps = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+))?\s*\)$/.exec(text);
  if (steps) {
    const n = Math.max(1, Number(steps[1]));
    const start = steps[2] === "start" || steps[2] === "jump-start";
    const points: Point[] = [[0, start ? 1 / n : 0]];
    for (let i = 1; i <= n; i++) {
      const x = i / n;
      points.push([x, points.at(-1)?.[1] ?? 0], [x, Math.min(1, (start ? i + 1 : i) / n)]);
    }
    return points;
  }

  const stops = /^linear\((.+)\)$/.exec(text);
  if (stops?.[1]) {
    const values = stops[1].split(",").map((part) => Number.parseFloat(part.trim()));
    if (values.length >= 2 && values.every(Number.isFinite)) return values.map((y, i): Point => [i / (values.length - 1), y]);
    return undefined;
  }

  const css = parseCssEasing(text);
  if (typeof css !== "string") return fromBezier(css);
  const framer = FRAMER_NAMED_EASINGS[text];
  if (framer) return framer === "linear" ? [[0, 0], [1, 1]] : fromBezier(framer);
  const gsap = gsapEaseToBezier(text);
  if (gsap) return gsap === "linear" ? [[0, 0], [1, 1]] : fromBezier(gsap);
  return undefined;
}

/** An SVG path for the curve in a width × height box, y up, with room for overshoot. */
export function curvePath(points: readonly Point[], width: number, height: number, pad = 0.2): string {
  const ys = points.map(([, y]) => y);
  const min = Math.min(0, ...ys);
  const max = Math.max(1, ...ys);
  const span = max - min || 1;
  const inner = height * (1 - 2 * pad);
  const top = height * pad;
  return points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${round(x * width)} ${round(top + inner * (1 - (y - min) / span))}`)
    .join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface TimelineRow {
  key: string;
  entryId: string;
  /** The last part of the target selector, e.g. "button.cta". */
  element: string;
  property: string;
  source: MotionEntry["source"];
  trigger: MotionEntry["trigger"];
  confidence: MotionEntry["confidence"];
  easing: Easing;
  /** Start and end as fractions of the axis (0 to 1). Scroll rows span the scroll range instead. */
  start: number;
  end: number;
  /** Keyframe offsets inside the bar, 0 to 1. */
  offsets: number[];
  /** "150 ms", "1.2 s × ∞", "scroll" and so on. */
  label: string;
  repeats: boolean;
}

export interface Timeline {
  /** Rows on the time axis, which runs from 0 to axisMs. */
  timed: TimelineRow[];
  /** Rows driven by scroll position. */
  scroll: TimelineRow[];
  axisMs: number;
}

export function lastPart(selector: string): string {
  return selector.split(">").at(-1)?.trim() ?? selector;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Number((ms / 1000).toFixed(2))} s`;
}

function isScrollDriven(entry: MotionEntry): boolean {
  return entry.scroll !== undefined || (entry.trigger === "scroll" && entry.duration === 0);
}

/** One row per animated property, on a shared time axis, with scroll-driven entries apart. */
export function buildTimeline(entries: readonly MotionEntry[]): Timeline {
  const timedEntries = entries.filter((e) => !isScrollDriven(e));
  const axisMs = Math.max(100, ...timedEntries.map((e) => Math.max(0, e.delay) + e.duration * (e.iterations === "infinite" ? 1 : Math.min(Math.max(e.iterations, 1), 3))));
  const rows = (entry: MotionEntry, start: number, end: number, label: string, repeats: boolean): TimelineRow[] =>
    entry.properties.map((property) => ({
      key: `${entry.id}:${property.name}`,
      entryId: entry.id,
      element: lastPart(entry.target),
      property: property.name,
      source: entry.source,
      trigger: entry.trigger,
      confidence: entry.confidence,
      easing: entry.easing,
      start,
      end,
      offsets: property.keyframes.map((k) => k.offset),
      label,
      repeats,
    }));

  const timed = timedEntries.flatMap((entry) => {
    const start = Math.max(0, entry.delay) / axisMs;
    const end = Math.min(1, (Math.max(0, entry.delay) + entry.duration) / axisMs);
    const repeat = entry.iterations === "infinite" ? " × ∞" : entry.iterations > 1 ? ` × ${entry.iterations}` : "";
    const delay = entry.delay > 0 ? ` after ${formatMs(entry.delay)}` : "";
    return rows(entry, start, Math.max(end, start + 0.004), `${formatMs(entry.duration)}${repeat}${delay}`, entry.iterations === "infinite" || entry.iterations > 1);
  });
  const scroll = entries.filter(isScrollDriven).flatMap((entry) => {
    const range = entry.scroll ? `${entry.scroll.start} → ${entry.scroll.end}${entry.scroll.scrub !== false ? ", scrub" : ""}${entry.scroll.pin ? ", pin" : ""}` : "page scroll";
    return rows(entry, 0, 1, range, false);
  });
  return { timed, scroll, axisMs };
}
