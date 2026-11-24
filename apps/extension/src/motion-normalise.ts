// Turns raw motion records into MotionEntry objects. Pure, so it is unit tested
// with fixtures recorded from the test pages.
//
// Each normaliser returns keyed drafts. mergeMotion keeps the first draft for each
// key, so callers pass groups in order of trust: animations started by the motion
// pass first, then those already running, then GSAP, then stylesheet parsing.

import type { Motion, MotionEntry, MotionTrigger, State } from "@kinetic/schema";
import { gsapEaseToBezier, parseCssEasing } from "@kinetic/schema/easing";
import { summariseMotion } from "@kinetic/schema/motion-summary";
import { type AssetRecord, fromAssetRecords } from "./asset-records.ts";
import { camelToKebab, listItem, parseCssTime } from "./css-list.ts";
import { fromFramerRecords } from "./framer-motion.ts";
import { fromCameraPath } from "./three-motion.ts";
import type {
  AnimationRecord,
  CssMotionReport,
  GsapRecord,
  KeyframeRecord,
  MainWorldMotion,
  ScrollTriggerRecord,
} from "./motion-records.ts";
import type { StyleMap } from "./style-diff.ts";

export type MotionDraft = Omit<MotionEntry, "id">;
export interface KeyedDraft {
  key: string;
  entry: MotionDraft;
}

type Direction = MotionEntry["direction"];
type Property = MotionEntry["properties"][number];

const DIRECTIONS: readonly Direction[] = ["normal", "reverse", "alternate", "alternate-reverse"];
const KEYFRAME_META = new Set(["offset", "computedOffset", "easing", "composite"]);

function direction(value: string): Direction {
  return (DIRECTIONS as readonly string[]).includes(value) ? (value as Direction) : "normal";
}

function clampOffset(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function frameOffset(frame: KeyframeRecord, index: number, count: number): number {
  const computed = frame.computedOffset ?? frame.offset;
  if (typeof computed === "number") return clampOffset(computed);
  return count <= 1 ? 0 : index / (count - 1);
}

/** Groups getKeyframes() output by property. */
export function propertiesFromKeyframes(frames: readonly KeyframeRecord[]): Property[] {
  const byName = new Map<string, Property>();
  frames.forEach((frame, index) => {
    for (const [key, value] of Object.entries(frame)) {
      if (KEYFRAME_META.has(key) || value === null || value === "") continue;
      const name = camelToKebab(key);
      let prop = byName.get(name);
      if (!prop) {
        prop = { name, keyframes: [] };
        byName.set(name, prop);
      }
      prop.keyframes.push({ offset: frameOffset(frame, index, frames.length), value });
    }
  });
  return [...byName.values()].filter((p) => p.keyframes.length > 0);
}

/**
 * The easing that shapes the whole animation. CSS transitions and WAAPI put it on
 * the effect. CSS animations put it on every keyframe, so a shared keyframe easing
 * is used when the effect easing is linear.
 */
function animationEasing(record: AnimationRecord): MotionEntry["easing"] {
  if (record.timing.easing && record.timing.easing !== "linear") return parseCssEasing(record.timing.easing);
  const easings = record.keyframes.slice(0, -1).map((f) => (typeof f.easing === "string" ? f.easing : "linear"));
  const first = easings[0];
  if (first && first !== "linear" && easings.every((e) => e === first)) return parseCssEasing(first);
  return "linear";
}

const ANIMATION_SOURCE: Record<AnimationRecord["kind"], MotionEntry["source"]> = {
  CSSTransition: "css-transition",
  CSSAnimation: "css-keyframes",
  Animation: "waapi",
};

/** The trigger for an animation that was already running when the capture started. */
export function triggerForRunning(record: AnimationRecord): MotionTrigger {
  if (record.kind === "CSSTransition") return "unknown";
  return record.timing.iterations === "infinite" ? "loop" : "load";
}

function animationKey(source: MotionEntry["source"], target: string, name: string, props: Property[], trigger: MotionTrigger): string {
  if (source === "css-transition") return `transition|${target}|${props[0]?.name ?? name}|${trigger}`;
  if (source === "css-keyframes") return `keyframes|${target}|${name}`;
  return `waapi|${target}|${props.map((p) => p.name).sort().join(",")}|${trigger}`;
}

export function fromAnimationRecord(record: AnimationRecord, trigger: MotionTrigger): KeyedDraft | null {
  const properties = propertiesFromKeyframes(record.keyframes);
  if (properties.length === 0) return null;
  const source = ANIMATION_SOURCE[record.kind];
  const target = `${record.target}${record.pseudoElement ?? ""}`;
  return {
    key: animationKey(source, target, record.name, properties, trigger),
    entry: {
      source,
      target,
      trigger,
      properties,
      duration: record.timing.duration,
      delay: record.timing.delay,
      easing: animationEasing(record),
      iterations: record.timing.iterations,
      direction: direction(record.timing.direction),
      confidence: "exact",
      raw: {
        kind: record.kind,
        name: record.name,
        timing: record.timing,
        keyframeEasings: record.keyframes.map((f) => f.easing ?? null),
      },
    },
  };
}

const STATE_TRIGGER: Partial<Record<State["name"], MotionTrigger>> = { hover: "hover", focus: "focus", active: "click" };

/** True when a transition-property entry ("all", "border", "background-color") covers a longhand. */
export function transitionCovers(transitionProperty: string, longhand: string): boolean {
  return transitionProperty === "all" || transitionProperty === longhand || longhand.startsWith(`${transitionProperty}-`);
}

/**
 * Entries from stylesheet motion: one per @keyframes animation on a node, and one
 * per transitioned property that changes in a forced state, from its resting value
 * to its value in that state.
 */
export function fromCssReport(
  report: CssMotionReport,
  baseline: Readonly<Record<string, StyleMap>>,
  states: readonly State[],
): KeyedDraft[] {
  const drafts: KeyedDraft[] = [];

  for (const node of report.animated) {
    node.names.forEach((name, i) => {
      const frames = report.keyframes[name];
      const properties: Property[] = [];
      for (const frame of frames ?? []) {
        for (const [prop, value] of Object.entries(frame.values)) {
          let p = properties.find((x) => x.name === prop);
          if (!p) {
            p = { name: prop, keyframes: [] };
            properties.push(p);
          }
          p.keyframes.push({ offset: frame.offset, value });
        }
      }
      const count = listItem(node.iterations, i, "1");
      const iterations = count === "infinite" ? "infinite" : Number(count);
      drafts.push({
        key: `keyframes|${node.selector}|${name}`,
        entry: {
          source: "css-keyframes",
          target: node.selector,
          trigger: iterations === "infinite" ? "loop" : "load",
          properties,
          duration: parseCssTime(listItem(node.durations, i, "0s")),
          delay: parseCssTime(listItem(node.delays, i, "0s")),
          easing: parseCssEasing(listItem(node.easings, i, "ease")),
          iterations: Number.isNaN(iterations) ? 1 : iterations,
          direction: direction(listItem(node.directions, i, "normal")),
          // Without a readable @keyframes rule (a cross-origin sheet) the timing is exact but the values are missing.
          confidence: frames ? "exact" : "near",
          raw: { from: "stylesheet", name, keyframeEasings: (frames ?? []).map((f) => f.easing ?? null) },
        },
      });
    });
  }

  for (const node of report.transitions) {
    for (const state of states) {
      const trigger = STATE_TRIGGER[state.name];
      const changes = state.changes[node.selector];
      if (!trigger || !changes) continue;
      for (const [prop, to] of Object.entries(changes)) {
        // The last matching transition-property wins, as in CSS.
        let index = -1;
        node.properties.forEach((tp, j) => {
          if (transitionCovers(tp, prop)) index = j;
        });
        if (index < 0) continue;
        const duration = parseCssTime(listItem(node.durations, index, "0s"));
        const from = baseline[node.selector]?.[prop];
        if (duration <= 0 || from === undefined || from === to) continue;
        drafts.push({
          key: `transition|${node.selector}|${prop}|${trigger}`,
          entry: {
            source: "css-transition",
            target: node.selector,
            trigger,
            properties: [{ name: prop, keyframes: [{ offset: 0, value: from }, { offset: 1, value: to }] }],
            duration,
            delay: parseCssTime(listItem(node.delays, index, "0s")),
            easing: parseCssEasing(listItem(node.easings, index, "ease")),
            iterations: 1,
            direction: "normal",
            confidence: "exact",
            raw: { from: "stylesheet", transitionProperty: node.properties[index], state: state.name },
          },
        });
      }
    }
  }
  return drafts;
}

/** The trigger for a GSAP tween read at the start of the capture. */
export function triggerForTween(record: GsapRecord): MotionTrigger {
  if (record.repeat === -1) return "loop";
  if (record.paused) return "unknown";
  return "load";
}

export function fromGsapRecords(
  records: readonly { record: GsapRecord; trigger: MotionTrigger }[],
  scrollTriggers: readonly ScrollTriggerRecord[],
): KeyedDraft[] {
  const drafts: KeyedDraft[] = [];
  for (const { record, trigger } of records) {
    const properties: Property[] = [];
    let complete = true;
    for (const [name, { from, to }] of Object.entries(record.values)) {
      const keyframes = [
        ...(from === null ? [] : [{ offset: 0, value: from }]),
        ...(to === null ? [] : [{ offset: 1, value: to }]),
      ];
      if (from === null || to === null) complete = false;
      if (keyframes.length > 0) properties.push({ name, keyframes });
    }
    const st = scrollTriggers.find((s) => s.tweenIds.includes(record.id));
    const mapped = gsapEaseToBezier(record.ease);
    drafts.push({
      key: `gsap|${record.id}`,
      entry: {
        source: st ? "scrolltrigger" : "gsap",
        target: record.targets.join(", "),
        trigger: st ? "scroll" : trigger,
        properties,
        duration: round(record.duration * 1000),
        delay: round(record.delay * 1000),
        easing: mapped ?? record.ease,
        iterations: record.repeat === -1 ? "infinite" : record.repeat + 1,
        direction: record.yoyo ? "alternate" : "normal",
        ...(record.stagger !== undefined && record.targets.length > 1 ? { stagger: round(record.stagger * 1000) } : {}),
        ...(st ? { scroll: { start: st.start, end: st.end, scrub: st.scrub, pin: st.pin } } : {}),
        confidence: complete ? "exact" : "near",
        raw: {
          ease: record.ease,
          vars: record.vars,
          position: record.position,
          timelineId: record.timelineId,
          ...(st ? { scrollTrigger: st } : {}),
        },
      },
    });
  }

  // Triggers that drive no tween in the selection, such as a pin, still shape how the component moves.
  const driven = new Set(records.map((r) => r.record.id));
  for (const st of scrollTriggers) {
    if (st.tweenIds.some((id) => driven.has(id))) continue;
    drafts.push({
      key: `scrolltrigger|${st.id}`,
      entry: {
        source: "scrolltrigger",
        target: st.pinTarget ?? st.trigger ?? "",
        trigger: "scroll",
        properties: [],
        duration: 0,
        delay: 0,
        easing: "linear",
        iterations: 1,
        direction: "normal",
        scroll: { start: st.start, end: st.end, scrub: st.scrub, pin: st.pin },
        confidence: "exact",
        raw: { scrollTrigger: st },
      },
    });
  }
  return drafts;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Keeps the first draft for each key, then numbers the entries per source: css-transition-1, gsap-1, … */
export function mergeMotion(...groups: readonly (readonly KeyedDraft[])[]): MotionEntry[] {
  const seen = new Set<string>();
  const kept: MotionDraft[] = [];
  for (const group of groups) {
    for (const { key, entry } of group) {
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(entry);
    }
  }
  const counters = new Map<string, number>();
  return kept.map((entry) => {
    const n = (counters.get(entry.source) ?? 0) + 1;
    counters.set(entry.source, n);
    return { id: `${entry.source}-${n}`, ...entry };
  });
}

// ─── assembling the motion block ─────────────────────────────────────────────

export interface MotionInputs {
  /** What the MAIN world reported when the capture started. */
  atStart: MainWorldMotion | undefined;
  /** What the MAIN world saw start during each hover, focus or reload of the motion pass. */
  passes: readonly { trigger: MotionTrigger; motion: MainWorldMotion | undefined }[];
  css: CssMotionReport;
  /** Assets the Network domain caught during the capture, merged over the MAIN world's by URL. */
  assets?: readonly AssetRecord[];
  /** Full computed styles at rest, from the state capture. */
  baseline: Readonly<Record<string, StyleMap>>;
  states: readonly State[];
}

/**
 * Merges GSAP records read at different moments. A tween first seen paused gets
 * the trigger of the step that set it running; a tween first seen running from
 * load keeps "load".
 */
export function mergeGsapRecords(
  atStart: readonly GsapRecord[],
  passes: readonly { trigger: MotionTrigger; records: readonly GsapRecord[] }[],
): { record: GsapRecord; trigger: MotionTrigger }[] {
  const byId = new Map<string, { record: GsapRecord; trigger: MotionTrigger }>();
  for (const record of atStart) byId.set(record.id, { record, trigger: triggerForTween(record) });
  for (const { trigger, records } of passes) {
    for (const record of records) {
      const existing = byId.get(record.id);
      if (!existing) byId.set(record.id, { record, trigger: record.repeat === -1 ? "loop" : trigger });
      else if (existing.trigger === "unknown") existing.trigger = trigger;
    }
  }
  return [...byId.values()];
}

/**
 * Framer Motion runs opacity, filter and clip-path through WAAPI, so the watcher
 * also sees those animations. The prop-based entry says more (variants, springs),
 * so a WAAPI draft on a Framer target whose values a Framer entry covers is dropped.
 */
function framerOwned(framer: readonly KeyedDraft[]): (draft: KeyedDraft) => boolean {
  const covered = new Map<string, Set<string>>();
  for (const { entry } of framer) {
    const names = covered.get(entry.target) ?? new Set<string>();
    for (const p of entry.properties) names.add(camelToKebab(p.name));
    covered.set(entry.target, names);
  }
  return ({ entry }) => {
    if (entry.source !== "waapi") return false;
    const names = covered.get(entry.target);
    return !!names && entry.properties.every((p) => names.has(p.name) || (p.name === "transform" && hasTransform(names)));
  };
}

const FRAMER_TRANSFORMS = ["x", "y", "z", "scale", "scale-x", "scale-y", "rotate", "rotate-x", "rotate-y", "rotate-z", "skew", "skew-x", "skew-y"];

function hasTransform(names: Set<string>): boolean {
  return FRAMER_TRANSFORMS.some((n) => names.has(n));
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

/** Normalises every source and merges them into the capture's motion block. */
export function buildMotion(inputs: MotionInputs): Motion {
  const startMotion = inputs.atStart;
  const passAnimations = inputs.passes.flatMap(({ trigger, motion }) =>
    (motion?.animations ?? []).map((record) => fromAnimationRecord(record, trigger)),
  );
  const gsap = mergeGsapRecords(
    startMotion?.gsap ?? [],
    inputs.passes.map(({ trigger, motion }) => ({ trigger, records: motion?.gsap ?? [] })),
  );
  const scrollTriggers = [
    ...(startMotion?.scrollTriggers ?? []),
    ...inputs.passes.flatMap((p) => p.motion?.scrollTriggers ?? []),
  ];

  const framer = fromFramerRecords(startMotion?.framer ?? []);
  const waapiFromFramer = framerOwned(framer);

  // Most trusted first: animations real input started, then those already running, then GSAP, then stylesheets.
  // Framer Motion props come before stylesheets but after live animations, which they never share a key with.
  const entries = mergeMotion(
    passAnimations.filter(present).filter((d) => !waapiFromFramer(d)),
    (startMotion?.animations ?? [])
      .map((record) => fromAnimationRecord(record, triggerForRunning(record)))
      .filter(present)
      .filter((d) => !waapiFromFramer(d)),
    fromGsapRecords(gsap, scrollTriggers),
    framer,
    startMotion?.three ? fromCameraPath(startMotion.three) : [],
    fromAssetRecords(inputs.assets ?? startMotion?.assets ?? []),
    fromCssReport(inputs.css, inputs.baseline, inputs.states),
  );

  const smoothScroll = startMotion?.smoothScroll;
  const warnings: string[] = [];
  if (startMotion?.gsapUnreachable) {
    warnings.push("GSAP is on the page (window.gsapVersions) but window.gsap is not exposed, so tweens were not read.");
  }
  return {
    entries,
    ...(smoothScroll ? { smoothScroll } : {}),
    summary: summariseMotion(entries),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
