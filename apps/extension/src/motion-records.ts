// Raw motion records read in the page by the MAIN world and the content script.
// motion-normalise.ts turns them into MotionEntry objects.

import type { SmoothScroll } from "@kinetic/schema";

export type KeyframeRecord = Record<string, string | number | null>;

/** One Web Animations API animation: a CSS transition, a CSS animation, or a script animation. */
export interface AnimationRecord {
  kind: "CSSTransition" | "CSSAnimation" | "Animation";
  target: string;
  /** "::before" and so on, or null when the animation runs on the element itself. */
  pseudoElement: string | null;
  /** transitionProperty, animationName or the animation id. */
  name: string;
  /** effect.getKeyframes() with every value as a string or number. */
  keyframes: KeyframeRecord[];
  timing: {
    duration: number;
    delay: number;
    endDelay: number;
    iterations: number | "infinite";
    direction: string;
    easing: string;
    fill: string;
  };
  playState: string;
  /** True when the target is the capture root or inside it. */
  inside: boolean;
}

/** Reads an Animation into an AnimationRecord. `selectorFor` is uniqueSelector. */
export function readAnimationRecord(
  animation: Animation,
  root: Element | null,
  selectorFor: (el: Element) => string,
): AnimationRecord | null {
  const effect = animation.effect as KeyframeEffect | null;
  const target = effect?.target;
  if (!effect || !target) return null;
  const timing = effect.getTiming();
  const ctor = animation.constructor.name;
  const kind = ctor === "CSSTransition" || ctor === "CSSAnimation" ? ctor : "Animation";
  const named = animation as Animation & { transitionProperty?: string; animationName?: string };
  const keyframes = effect.getKeyframes().map((frame) => {
    const out: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(frame)) {
      out[key] = value === null || value === undefined ? null : typeof value === "number" ? value : String(value);
    }
    return out;
  });
  return {
    kind,
    target: selectorFor(target),
    pseudoElement: effect.pseudoElement ?? null,
    name: named.transitionProperty ?? named.animationName ?? animation.id ?? "",
    keyframes,
    timing: {
      duration: typeof timing.duration === "number" ? timing.duration : 0,
      delay: timing.delay ?? 0,
      endDelay: timing.endDelay ?? 0,
      iterations: timing.iterations === Number.POSITIVE_INFINITY ? "infinite" : (timing.iterations ?? 1),
      direction: timing.direction ?? "normal",
      easing: timing.easing ?? "linear",
      fill: timing.fill ?? "auto",
    },
    playState: animation.playState,
    inside: root !== null && (root === target || root.contains(target)),
  };
}

/** One GSAP tween whose targets are inside the selection. Property names are GSAP's (x, rotation, backgroundColor). */
export interface GsapRecord {
  id: string;
  targets: string[];
  /** Animated property → start and end value for the first target. */
  values: Record<string, { from: string | number | null; to: string | number | null }>;
  /** The tween's vars with functions and elements replaced by placeholders. */
  vars: Record<string, unknown>;
  /** Seconds for one target, before stagger. */
  duration: number;
  /** Seconds. Includes the position inside the parent timelines. */
  delay: number;
  /** The ease name as written, e.g. "power2.out". */
  ease: string;
  /** Seconds between targets. */
  stagger: number | undefined;
  repeat: number;
  yoyo: boolean;
  /** Seconds from the start of the parent timeline, or null for a tween on the global timeline. */
  position: number | null;
  timelineId: string | null;
  /** True when a ScrollTrigger drives this tween or one of its timelines. */
  scrollTriggered: boolean;
  isActive: boolean;
  paused: boolean;
}

export interface ScrollTriggerRecord {
  id: string;
  trigger: string | null;
  /** As written, e.g. "top 80%". */
  start: string | number;
  end: string | number;
  /** Resolved scroll positions in pixels. */
  startPx: number;
  endPx: number;
  scrub: boolean | number;
  pin: boolean;
  pinTarget: string | null;
  toggleActions: string;
  /** Ids of the GsapRecords this trigger drives. */
  tweenIds: string[];
}

/** Everything the MAIN world reports about motion. */
export interface MainWorldMotion {
  animations: AnimationRecord[];
  gsap: GsapRecord[];
  scrollTriggers: ScrollTriggerRecord[];
  /** window.gsapVersions is set but window.gsap is not: a bundled GSAP that cannot be read. */
  gsapUnreachable: boolean;
  smoothScroll: SmoothScroll | undefined;
}

/** CSS motion read from computed styles and stylesheets in the content script. */
export interface CssMotionReport {
  /** @keyframes name → keyframes, with each keyframe's declarations. */
  keyframes: Record<string, { offset: number; easing: string | undefined; values: Record<string, string> }[]>;
  animated: {
    selector: string;
    names: string[];
    durations: string[];
    delays: string[];
    iterations: string[];
    directions: string[];
    easings: string[];
  }[];
  transitions: { selector: string; properties: string[]; durations: string[]; delays: string[]; easings: string[] }[];
}
