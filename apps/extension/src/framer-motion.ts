// Framer Motion props → motion entries. Framer Motion keeps no registry of running
// animations, but every motion component carries its whole animation as props
// (initial, animate, whileHover, variants, transition…), which the React fiber tree
// exposes. Pure, so it is unit tested with fixture props.
//
// Defaults below are Framer Motion's own (motion-dom 14): default-transitions.mjs,
// generators/spring.mjs and projection's defaultLayoutTransition.

import type { MotionEntry, MotionTrigger } from "@kinetic/schema";
import { type Bezier, FRAMER_NAMED_EASINGS, springDuration } from "@kinetic/schema/easing";
import type { TreeNode } from "./component-tree.ts";
import type { KeyedDraft, MotionDraft } from "./motion-normalise.ts";

/** One motion component inside the selection, with its motion props copied to plain JSON. */
export interface FramerRecord {
  /** Selector of the element the motion component renders. */
  target: string;
  /** "motion.div", "motion.create(Card)". */
  component: string;
  props: Record<string, unknown>;
  /** Index in the record list of the nearest motion ancestor, or null. */
  parent: number | null;
  /** Position among the parent's motion children, for staggerChildren. */
  childIndex: number;
}

/** The props that describe motion. Everything else on a motion component is ordinary DOM props. */
export const FRAMER_PROP_KEYS = [
  "initial",
  "animate",
  "exit",
  "variants",
  "transition",
  "whileHover",
  "whileTap",
  "whileFocus",
  "whileInView",
  "whileDrag",
  "viewport",
  "layout",
  "layoutId",
  "inherit",
] as const;

/**
 * Collects a FramerRecord for every motion component whose element is inside the
 * selection. `copy` turns raw props into plain JSON (sanitizeValue with a deep limit).
 */
export function collectFramerRecords<E>(
  roots: readonly TreeNode<E>[],
  isInside: (element: E) => boolean,
  selectorFor: (element: E) => string,
  copy: (value: unknown) => unknown,
): FramerRecord[] {
  const records: FramerRecord[] = [];
  const childCount = new Map<number | null, number>();
  const visit = (node: TreeNode<E>, parent: number | null) => {
    let next = parent;
    const element = node.elements[0];
    if (node.motionProps && element !== undefined && isInside(element)) {
      const props: Record<string, unknown> = {};
      for (const key of FRAMER_PROP_KEYS) {
        if (node.motionProps[key] !== undefined) props[key] = copy(node.motionProps[key]);
      }
      const childIndex = childCount.get(parent) ?? 0;
      childCount.set(parent, childIndex + 1);
      records.push({ target: selectorFor(element), component: node.name ?? "motion", props, parent, childIndex });
      next = records.length - 1;
    }
    for (const child of node.children) visit(child, next);
  };
  for (const root of roots) visit(root, null);
  return records;
}

// ─── resolving targets ───────────────────────────────────────────────────────

type Target = Record<string, unknown>;
type Transition = Record<string, unknown>;

/** Props that set a target and the trigger each one maps to. Order sets entry order. */
const TRIGGER_PROPS: readonly { prop: string; trigger: MotionTrigger }[] = [
  { prop: "animate", trigger: "load" },
  { prop: "whileHover", trigger: "hover" },
  { prop: "whileFocus", trigger: "focus" },
  { prop: "whileTap", trigger: "click" },
  { prop: "whileInView", trigger: "scroll" },
  { prop: "whileDrag", trigger: "unknown" },
  { prop: "exit", trigger: "unknown" },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLabel(value: unknown): value is string | string[] {
  return typeof value === "string" || (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string"));
}

/**
 * The value of a target prop, following variant propagation: a motion child with
 * variants but no value of its own takes the parent's label.
 */
function labelOrTarget(records: readonly FramerRecord[], index: number, prop: string): { value: unknown; inherited: boolean } {
  const record = records[index] as FramerRecord;
  const own = record.props[prop];
  if (own !== undefined) return { value: own, inherited: false };
  if (record.props.inherit === false || !isObject(record.props.variants)) return { value: undefined, inherited: false };
  for (let p = record.parent; p !== null; p = (records[p] as FramerRecord).parent) {
    const value = (records[p] as FramerRecord).props[prop];
    if (isLabel(value)) return { value, inherited: true };
    if (value !== undefined) break;
  }
  return { value: undefined, inherited: false };
}

/** Turns a label, a list of labels or a target object into one target. unresolved is set when a variant is a function. */
function resolveTarget(value: unknown, variants: unknown): { target: Target | undefined; unresolved: boolean } {
  if (isObject(value)) return { target: value, unresolved: false };
  if (!isLabel(value)) return { target: undefined, unresolved: false };
  const labels = typeof value === "string" ? [value] : value;
  let target: Target | undefined;
  let unresolved = false;
  for (const label of labels) {
    const variant = isObject(variants) ? variants[label] : undefined;
    if (isObject(variant)) target = { ...target, ...variant };
    else if (variant !== undefined) unresolved = true; // A function variant, copied as "[function]".
  }
  return { target, unresolved };
}

/** framer-motion's getValueTransition: a per-value transition, then "default", then the whole object. */
function valueTransition(transition: Transition | undefined, key: string): Transition | undefined {
  if (!transition) return undefined;
  const own = transition[key];
  if (isObject(own)) return own;
  const fallback = transition.default;
  if (isObject(fallback)) return fallback;
  return transition;
}

/** framer-motion's orchestration keys: they schedule an animation but do not shape it. */
const ORCHESTRATION_KEYS = new Set([
  "when",
  "delay",
  "delayChildren",
  "staggerChildren",
  "staggerDirection",
  "repeat",
  "repeatType",
  "repeatDelay",
  "from",
  "elapsed",
]);

function isTransitionDefined(transition: Transition): boolean {
  return Object.keys(transition).some((k) => !ORCHESTRATION_KEYS.has(k));
}

const TRANSFORM_KEYS = new Set([
  "transformPerspective",
  "x",
  "y",
  "z",
  "translateX",
  "translateY",
  "translateZ",
  "scale",
  "scaleX",
  "scaleY",
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "skew",
  "skewX",
  "skewY",
]);

/** Framer Motion's default transition for a value (getDefaultTransition). */
export function defaultTransition(key: string, keyframes: readonly unknown[]): Transition {
  if (keyframes.length > 2) return { type: "keyframes", duration: 0.8 };
  if (TRANSFORM_KEYS.has(key)) {
    if (key.startsWith("scale")) {
      const target = keyframes[keyframes.length - 1];
      return { type: "spring", stiffness: 550, damping: target === 0 ? 2 * Math.sqrt(550) : 30, restSpeed: 10 };
    }
    return { type: "spring", stiffness: 500, damping: 25, restSpeed: 10 };
  }
  return { type: "keyframes", ease: [0.25, 0.1, 0.35, 1], duration: 0.3 };
}

const SPRING_KEYS = ["stiffness", "damping", "mass", "bounce", "visualDuration"];

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function easeOf(ease: unknown): MotionEntry["easing"] {
  if (typeof ease === "string") return FRAMER_NAMED_EASINGS[ease] ?? ease;
  if (Array.isArray(ease)) {
    if (ease.length === 4 && ease.every((n) => typeof n === "number")) return ease as Bezier;
    return easeOf(ease[0]); // One ease per keyframe segment: the first stands for the whole.
  }
  if (ease === "[function]") return "linear";
  return "linear";
}

interface Timing {
  duration: number;
  delay: number;
  easing: MotionEntry["easing"];
  iterations: MotionEntry["iterations"];
  direction: MotionEntry["direction"];
  times: number[] | undefined;
}

/** Duration, delay and easing for one Framer transition, in ms. */
export function timingOf(transition: Transition): Timing {
  const repeat = transition.repeat;
  const endless = repeat === "Infinity" || repeat === Number.POSITIVE_INFINITY;
  const repeatCount = num(repeat) ?? 0;
  const repeatType = transition.repeatType;
  const times = Array.isArray(transition.times) && transition.times.every((t) => typeof t === "number") ? (transition.times as number[]) : undefined;
  const base = {
    delay: round((num(transition.delay) ?? 0) * 1000),
    iterations: endless ? ("infinite" as const) : repeatCount + 1,
    direction: (repeatType === "reverse" || repeatType === "mirror" ? "alternate" : "normal") as MotionEntry["direction"],
    times,
  };

  const type = transition.type;
  const spring = type === "spring" || (type === undefined && SPRING_KEYS.some((k) => transition[k] !== undefined));
  if (spring) {
    const stiffness = num(transition.stiffness);
    const damping = num(transition.damping);
    const mass = num(transition.mass);
    const physics = stiffness !== undefined || damping !== undefined || mass !== undefined;
    const duration = num(transition.duration);
    const bounce = num(transition.bounce);
    if (!physics && (duration !== undefined || bounce !== undefined || transition.visualDuration !== undefined)) {
      // Duration-based spring: framer-motion defaults are duration 0.8 s and bounce 0.3.
      const visual = num(transition.visualDuration);
      const seconds = visual ?? duration ?? 0.8;
      return { ...base, duration: round(seconds * 1000), easing: `spring(duration: ${seconds}, bounce: ${bounce ?? 0.3})` };
    }
    const k = stiffness ?? 100;
    const c = damping ?? 10;
    const m = mass ?? 1;
    return { ...base, duration: springDuration(k, c, m), easing: `spring(stiffness: ${round(k)}, damping: ${round(c)}, mass: ${round(m)})` };
  }
  if (type === "inertia" || type === "decay") return { ...base, duration: 0, easing: "inertia" };
  // Tweens and keyframes: framer-motion's defaults are 0.3 s and easeInOut.
  return {
    ...base,
    duration: round((num(transition.duration) ?? 0.3) * 1000),
    easing: transition.ease === undefined ? FRAMER_NAMED_EASINGS.easeInOut ?? "ease-in-out" : easeOf(transition.ease),
  };
}

type KeyframeValue = string | number;

function toKeyframeValue(value: unknown): KeyframeValue | undefined {
  if (typeof value === "number" || typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  return JSON.stringify(value);
}

/** Keyframes for one value, from its value before the trigger to its target. */
function keyframesFor(from: unknown, to: unknown, times: number[] | undefined): MotionEntry["properties"][number]["keyframes"] {
  const fromValue = toKeyframeValue(Array.isArray(from) ? from[from.length - 1] : from);
  if (Array.isArray(to)) {
    const out: MotionEntry["properties"][number]["keyframes"] = [];
    to.forEach((v, i) => {
      // null is Framer's wildcard for "the current value".
      const value = v === null ? (i === 0 ? fromValue : undefined) : toKeyframeValue(v);
      if (value === undefined) return;
      const offset = times?.[i] ?? (to.length === 1 ? 1 : i / (to.length - 1));
      out.push({ offset: Math.min(1, Math.max(0, offset)), value });
    });
    return out;
  }
  const toValue = toKeyframeValue(to);
  return [
    ...(fromValue === undefined ? [] : [{ offset: 0, value: fromValue }]),
    ...(toValue === undefined ? [] : [{ offset: 1, value: toValue }]),
  ];
}

/** Delay a parent's staggerChildren and delayChildren add to a child animating to the same label. */
function orchestrationDelay(records: readonly FramerRecord[], index: number, prop: string): number {
  const record = records[index] as FramerRecord;
  if (record.parent === null) return 0;
  const parent = records[record.parent] as FramerRecord;
  const label = parent.props[prop];
  if (!isLabel(label)) return 0;
  const { target } = resolveTarget(label, parent.props.variants);
  const transition = isObject(target?.transition) ? target.transition : isObject(parent.props.transition) ? parent.props.transition : undefined;
  if (!transition) return 0;
  const delayChildren = num(transition.delayChildren) ?? 0;
  const stagger = num(transition.staggerChildren) ?? 0;
  return round((delayChildren + stagger * record.childIndex) * 1000);
}

/** Turns Framer Motion records into motion entries, one per component, trigger and shared transition. */
export function fromFramerRecords(records: readonly FramerRecord[]): KeyedDraft[] {
  const drafts: KeyedDraft[] = [];
  records.forEach((record, index) => {
    const { props } = record;
    const variants = props.variants;
    const initial = labelOrTarget(records, index, "initial");
    const animate = labelOrTarget(records, index, "animate");
    const initialTarget = initial.value === false ? undefined : resolveTarget(initial.value, variants).target;
    const animateTarget = resolveTarget(animate.value, variants).target;
    const propTransition = isObject(props.transition) ? props.transition : undefined;

    for (const { prop, trigger } of TRIGGER_PROPS) {
      const { value, inherited } = prop === "animate" ? animate : prop === "initial" ? initial : labelOrTarget(records, index, prop);
      // animate with initial={false} sets the resting state without a mount animation.
      if (prop === "animate" && initial.value === false) continue;
      const { target, unresolved } = resolveTarget(value, variants);
      if (!target) continue;
      const before = prop === "animate" ? initialTarget : prop === "exit" ? animateTarget : (animateTarget ?? initialTarget);
      const variantTransition = isObject(target.transition) ? target.transition : undefined;
      const extraDelay = inherited || isLabel(value) ? orchestrationDelay(records, index, prop) : 0;

      // Group values that share a transition into one entry.
      const groups = new Map<string, { timing: Timing; defaulted: boolean; transition: Transition; properties: MotionEntry["properties"] }>();
      for (const [key, to] of Object.entries(target)) {
        if (key === "transition" || key === "transitionEnd") continue;
        const declared = valueTransition(variantTransition ?? propTransition, key);
        const keyframes = Array.isArray(to) ? to : [before?.[key], to];
        const defaulted = !declared || !isTransitionDefined(declared);
        const transition = defaulted ? { ...defaultTransition(key, keyframes), ...declared } : declared;
        const timing = timingOf(transition);
        const frames = keyframesFor(before?.[key], to, timing.times);
        if (frames.length === 0) continue;
        const signature = JSON.stringify(timing) + String(defaulted);
        let group = groups.get(signature);
        if (!group) {
          group = { timing, defaulted, transition, properties: [] };
          groups.set(signature, group);
        }
        group.properties.push({ name: key, keyframes: frames });
      }

      for (const group of groups.values()) {
        const names = group.properties.map((p) => p.name).sort().join(",");
        const entry: MotionDraft = {
          source: "framer-motion",
          target: record.target,
          trigger,
          properties: group.properties,
          duration: group.timing.duration,
          delay: round(group.timing.delay + extraDelay),
          easing: group.timing.easing,
          iterations: group.timing.iterations,
          direction: group.timing.direction,
          confidence: unresolved ? "approximate" : "near",
          raw: {
            component: record.component,
            prop,
            ...(isLabel(value) ? { variant: value } : {}),
            ...(inherited ? { inheritedFrom: "parent" } : {}),
            transition: group.transition,
            ...(group.defaulted ? { defaultTransition: true } : {}),
            ...(extraDelay ? { orchestrationDelay: extraDelay } : {}),
            ...(prop === "whileInView" && props.viewport !== undefined ? { viewport: props.viewport } : {}),
          },
        };
        drafts.push({ key: `framer|${record.target}|${prop}|${names}`, entry });
      }
    }

    // Layout animations: Framer measures the element before and after a re-render and animates between them.
    const layout = props.layout;
    if ((layout !== undefined && layout !== false) || props.layoutId !== undefined) {
      const declared = valueTransition(propTransition, "layout");
      const transition = declared && isTransitionDefined(declared) ? declared : { duration: 0.45, ease: [0.4, 0, 0.1, 1], ...declared };
      const timing = timingOf(transition);
      drafts.push({
        key: `framer|${record.target}|layout`,
        entry: {
          source: "framer-motion",
          target: record.target,
          trigger: "unknown",
          properties: [{ name: "layout", keyframes: [{ offset: 1, value: typeof layout === "string" ? layout : "true" }] }],
          duration: timing.duration,
          delay: timing.delay,
          easing: timing.easing,
          iterations: timing.iterations,
          direction: timing.direction,
          confidence: "near",
          raw: { component: record.component, prop: "layout", layout: layout ?? null, layoutId: props.layoutId ?? null, transition },
        },
      });
    }
  });
  return drafts;
}
