// Turns a three.js camera path (transforms sampled from renderer.render) into
// motion entries with source "three". Pure, so it is unit tested with fixtures.
//
// Time samples: a channel that keeps changing while nothing scrolls is a running
// animation. One that changes at a steady rate (a spinning model) becomes an
// endless linear loop with the time one turn takes. Scroll samples: a channel that
// only changes between scroll steps is linked to scroll.

import type { MotionEntry } from "@kinetic/schema";
import type { KeyedDraft } from "./motion-normalise.ts";
import type { CameraPath, CameraSample, TransformSample } from "./three-scene.ts";

const EPSILON = 1e-3;
const MAX_KEYFRAMES = 12;

type Channels = Record<string, (number | undefined)[]>;

function cameraChannels(samples: readonly CameraSample[]): Channels {
  const out: Channels = {};
  const axes = ["x", "y", "z"] as const;
  samples.forEach((s, i) => {
    axes.forEach((axis, a) => {
      (out[`position.${axis}`] ??= [])[i] = s.position[a];
      (out[`rotation.${axis}`] ??= [])[i] = s.rotation[a];
    });
    if (s.fov !== undefined) (out.fov ??= [])[i] = s.fov;
    if (s.zoom !== undefined) (out.zoom ??= [])[i] = s.zoom;
  });
  return unwrapRotations(out);
}

function objectChannels(samples: readonly (TransformSample | undefined)[]): Channels {
  const out: Channels = {};
  const axes = ["x", "y", "z"] as const;
  samples.forEach((s, i) => {
    if (!s) return;
    axes.forEach((axis, a) => {
      (out[`position.${axis}`] ??= [])[i] = s.position[a];
      (out[`rotation.${axis}`] ??= [])[i] = s.rotation[a];
      (out[`scale.${axis}`] ??= [])[i] = s.scale[a];
    });
  });
  return unwrapRotations(out);
}

/**
 * Removes the jumps a rotation makes when it is read back from a quaternion and
 * wraps from π to -π, so a steady spin reads as a straight line.
 */
export function unwrapAngles(values: readonly (number | undefined)[]): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let offset = 0;
  let previous: number | undefined;
  for (const value of values) {
    if (value === undefined) {
      out.push(undefined);
      continue;
    }
    if (previous !== undefined) {
      const delta = value + offset - previous;
      if (delta > Math.PI) offset -= 2 * Math.PI;
      else if (delta < -Math.PI) offset += 2 * Math.PI;
    }
    previous = value + offset;
    out.push(previous);
  }
  return out;
}

function unwrapRotations(channels: Channels): Channels {
  for (const key of Object.keys(channels)) {
    if (key.startsWith("rotation.")) channels[key] = unwrapAngles(channels[key] ?? []);
  }
  return channels;
}

function defined(values: readonly (number | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function range(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Least-squares slope and fit quality (R²) of values over times. */
export function linearFit(times: readonly number[], values: readonly number[]): { slope: number; r2: number } {
  const n = Math.min(times.length, values.length);
  if (n < 3) return { slope: 0, r2: 0 };
  let st = 0;
  let sv = 0;
  for (let i = 0; i < n; i++) {
    st += times[i] as number;
    sv += values[i] as number;
  }
  const mt = st / n;
  const mv = sv / n;
  let num = 0;
  let den = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const dt = (times[i] as number) - mt;
    const dv = (values[i] as number) - mv;
    num += dt * dv;
    den += dt * dt;
    total += dv * dv;
  }
  if (den === 0 || total === 0) return { slope: 0, r2: 0 };
  const slope = num / den;
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const predicted = mv + slope * ((times[i] as number) - mt);
    residual += ((values[i] as number) - predicted) ** 2;
  }
  return { slope, r2: 1 - residual / total };
}

/** Up to MAX_KEYFRAMES evenly spaced samples, with offsets from 0 to 1. */
function sampleKeyframes(offsets: readonly number[], values: readonly (number | undefined)[]): MotionEntry["properties"][number]["keyframes"] {
  const points = offsets.map((offset, i) => ({ offset, value: values[i] })).filter((p): p is { offset: number; value: number } => typeof p.value === "number");
  if (points.length <= MAX_KEYFRAMES) return points.map((p) => ({ offset: round(p.offset), value: round(p.value) }));
  const out: MotionEntry["properties"][number]["keyframes"] = [];
  for (let k = 0; k < MAX_KEYFRAMES; k++) {
    const p = points[Math.round((k * (points.length - 1)) / (MAX_KEYFRAMES - 1))] as { offset: number; value: number };
    out.push({ offset: round(p.offset), value: round(p.value) });
  }
  return out;
}

interface Analysis {
  timeAnimated: Set<string>;
  entries: KeyedDraft[];
}

/** Entries for one camera or object over the time samples. */
function analyseTime(name: string, canvas: string, times: readonly number[], channels: Channels, durationMs: number): Analysis {
  const timeAnimated = new Set<string>();
  const lastT = times[times.length - 1] ?? 0;
  if (times.length < 3 || lastT <= 0) return { timeAnimated, entries: [] };
  const offsets = times.map((t) => t / lastT);
  const properties: MotionEntry["properties"] = [];
  const rates: Record<string, number> = {};
  let allLinear = true;
  let spinPeriod: number | undefined;
  for (const [channel, values] of Object.entries(channels)) {
    const known = defined(values);
    if (range(known) <= EPSILON) continue;
    timeAnimated.add(channel);
    const complete = known.length === times.length;
    const fit = complete ? linearFit(times, known) : { slope: 0, r2: 0 };
    const linear = complete && fit.r2 > 0.995;
    if (!linear) allLinear = false;
    if (linear) rates[channel] = round(fit.slope * 1000);
    if (linear && channel.startsWith("rotation.") && fit.slope !== 0) {
      const period = Math.round((2 * Math.PI) / Math.abs(fit.slope));
      spinPeriod = spinPeriod === undefined ? period : Math.max(spinPeriod, period);
    }
    properties.push({ name: channel, keyframes: sampleKeyframes(offsets, values) });
  }
  if (properties.length === 0) return { timeAnimated, entries: [] };

  // A steady spin: one full turn per period, repeated forever.
  if (allLinear && spinPeriod !== undefined) {
    const spun = properties.map((p) => {
      const rate = rates[p.name] ?? 0;
      const start = p.keyframes[0]?.value as number;
      return { name: p.name, keyframes: [{ offset: 0, value: start }, { offset: 1, value: round(start + (rate * (spinPeriod as number)) / 1000) }] };
    });
    return {
      timeAnimated,
      entries: [
        {
          key: `three|${name}|loop`,
          entry: {
            source: "three",
            target: canvas,
            trigger: "loop",
            properties: spun,
            duration: spinPeriod,
            delay: 0,
            easing: "linear",
            iterations: "infinite",
            direction: "normal",
            confidence: "approximate",
            raw: { object: name, ratesPerSecond: rates, sampledMs: Math.round(lastT) },
          },
        },
      ],
    };
  }

  // Still moving at the end of the window: treat as a running loop of unknown period.
  const tail = times.findIndex((t) => t >= lastT * 0.8);
  const movingAtEnd = Object.values(channels).some((values) => range(defined(values.slice(Math.max(0, tail)))) > EPSILON);
  return {
    timeAnimated,
    entries: [
      {
        key: `three|${name}|time`,
        entry: {
          source: "three",
          target: canvas,
          trigger: movingAtEnd ? "loop" : "load",
          properties,
          duration: Math.round(Math.min(lastT, durationMs)),
          delay: 0,
          easing: "linear",
          iterations: movingAtEnd ? "infinite" : 1,
          direction: "normal",
          confidence: "approximate",
          raw: { object: name, sampledMs: Math.round(lastT), ...(Object.keys(rates).length ? { ratesPerSecond: rates } : {}) },
        },
      },
    ],
  };
}

/** Entries for one camera or object across the scroll steps, leaving out channels that move on their own. */
function analyseScroll(
  name: string,
  canvas: string,
  progress: readonly number[],
  channels: Channels,
  skip: Set<string>,
  maxScroll: number,
): KeyedDraft[] {
  const properties: MotionEntry["properties"] = [];
  for (const [channel, values] of Object.entries(channels)) {
    if (skip.has(channel) || range(defined(values)) <= EPSILON) continue;
    properties.push({ name: channel, keyframes: sampleKeyframes(progress, values) });
  }
  if (properties.length === 0) return [];
  return [
    {
      key: `three|${name}|scroll`,
      entry: {
        source: "three",
        target: canvas,
        trigger: "scroll",
        properties,
        duration: 0,
        delay: 0,
        easing: "linear",
        iterations: 1,
        direction: "normal",
        scroll: { start: 0, end: maxScroll, scrub: true, pin: false },
        confidence: "near",
        raw: { object: name, steps: progress.length },
      },
    },
  ];
}

export function fromCameraPath(path: CameraPath): KeyedDraft[] {
  const drafts: KeyedDraft[] = [];
  const times = path.frames.map((f) => f.t);
  const objectNames = new Set<string>();
  for (const frame of path.frames) for (const name of Object.keys(frame.objects)) objectNames.add(name);
  for (const step of path.scroll?.steps ?? []) for (const name of Object.keys(step.objects)) objectNames.add(name);

  const timeCamera = analyseTime("camera", path.canvas, times, cameraChannels(path.frames.map((f) => f.camera)), path.durationMs);
  drafts.push(...timeCamera.entries);
  const timeObjects = new Map<string, Set<string>>();
  for (const name of objectNames) {
    const analysis = analyseTime(name, path.canvas, times, objectChannels(path.frames.map((f) => f.objects[name])), path.durationMs);
    timeObjects.set(name, analysis.timeAnimated);
    drafts.push(...analysis.entries);
  }

  const scroll = path.scroll;
  if (scroll && scroll.steps.length >= 2 && scroll.maxScroll > 0) {
    const progress = scroll.steps.map((s) => s.progress);
    drafts.push(...analyseScroll("camera", path.canvas, progress, cameraChannels(scroll.steps.map((s) => s.camera)), timeCamera.timeAnimated, scroll.maxScroll));
    for (const name of objectNames) {
      const channels = objectChannels(scroll.steps.map((s) => s.objects[name]));
      drafts.push(...analyseScroll(name, path.canvas, progress, channels, timeObjects.get(name) ?? new Set(), scroll.maxScroll));
    }
  }
  return drafts;
}
