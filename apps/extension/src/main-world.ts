// MAIN world hooks. Each feature adds its own clearly marked section below and
// must never throw into page code: wrap every hook in try/catch, and never change
// what the page renders.

import type { SmoothScroll } from "@kinetic/schema";
import { isKineticMessage, type MainWorldReport, postToWindow, ROOT_ATTRIBUTE } from "./messages.ts";
import { type AnimationRecord, type GsapRecord, readAnimationRecord, type ScrollTriggerRecord } from "./motion-records.ts";
import { uniqueSelector } from "./selector.ts";

/**
 * "full" runs when the user captures. "motion" runs during the motion pass,
 * after each hover or focus, and only reports motion.
 */
export type CollectMode = "full" | "motion";

/** What each feature section gets when the content script asks for a report. */
export interface CollectContext {
  root: Element;
  rootSelector: string;
  mode: CollectMode;
  report: MainWorldReport;
}

type Collector = (ctx: CollectContext) => void | Promise<void>;

const collectors: { name: string; collect: Collector }[] = [];

/** Registers a feature's part of the capture report. A failing collector never stops the others. */
function addCollector(name: string, collect: Collector): void {
  collectors.push({ name, collect });
}

/** Set by the background before it reloads the page to record load motion. Read once, then cleared. */
const LOAD_CAPTURE_FLAG = "kinetic:load-capture";

function takeLoadCaptureFlag(): boolean {
  try {
    const flagged = sessionStorage.getItem(LOAD_CAPTURE_FLAG) === "1";
    if (flagged) sessionStorage.removeItem(LOAD_CAPTURE_FLAG);
    return flagged;
  } catch {
    return false; // Storage blocked.
  }
}

export function startMainWorld(): void {
  let loadCapture = false;
  try {
    loadCapture = takeLoadCaptureFlag();
  } catch {
    // Never break the site.
  }
  const installers = [installBridge, () => installAnimationWatcher(loadCapture), () => installGsapLoadRecording(loadCapture)];
  for (const install of installers) {
    try {
      install();
    } catch {
      // Never break the site.
    }
  }
}

// ─── shared helpers ──────────────────────────────────────────────────────────

/** True when el is the root or inside it. */
function inside(root: Element, el: unknown): boolean {
  return el instanceof Element && (el === root || root.contains(el));
}

/**
 * Copies a value into plain JSON for postMessage: functions become "[function]",
 * elements become their selector, and deep or large structures are cut off.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object") return String(value);
  if (value instanceof Element) return uniqueSelector(value);
  if (value === window || value instanceof Node) return "[node]";
  if (depth >= 3) return "[object]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value).slice(0, 40)) out[key] = sanitize(v, depth + 1);
  return out;
}

function motionOf(report: MainWorldReport) {
  report.motion ??= { animations: [], gsap: [], scrollTriggers: [], gsapUnreachable: false, smoothScroll: undefined };
  return report.motion;
}

// ─── bridge: answers capture:collect from the content script ────────────────

function installBridge(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    try {
      if (event.source !== window || !isKineticMessage(event.data)) return;
      const { type, requestId } = event.data;
      if (typeof requestId !== "string") return;
      if (type === "capture:collect") {
        const { rootSelector, mode } = event.data;
        if (typeof rootSelector !== "string") return;
        void collect(requestId, rootSelector, mode === "motion" ? "motion" : "full");
      } else if (type === "motion:watch") {
        armWatch(String(event.data.trigger), false, WATCH_STEP_MS);
        armGsapWatch();
        postToWindow("motion:watching", { requestId });
      }
    } catch {
      // Never break the site.
    }
  });
}

function findRoot(requestId: string, rootSelector: string): Element | null {
  try {
    return (
      document.querySelector(`[${ROOT_ATTRIBUTE}="${CSS.escape(requestId)}"]`) ?? document.querySelector(rootSelector)
    );
  } catch {
    return null;
  }
}

async function collect(requestId: string, rootSelector: string, mode: CollectMode): Promise<void> {
  const report: MainWorldReport = { sections: {}, files: [] };
  const root = findRoot(requestId, rootSelector);
  if (root) {
    for (const { collect: run } of collectors) {
      try {
        await run({ root, rootSelector, mode, report });
      } catch {
        // One feature failing must not lose the others.
      }
    }
  }
  try {
    postToWindow("capture:collected", { requestId, report });
  } catch {
    // A value that cannot be cloned slipped through. Answer with an empty report rather than hang the capture.
    postToWindow("capture:collected", { requestId, report: { sections: {}, files: [] } });
  }
}

// ─── WAAPI: document.getAnimations() ─────────────────────────────────────────
// A second source for CSS transitions, CSS animations and script animations.
// A full collect reads what is already running when the capture starts (loops,
// load animations). A motion collect returns what the watcher saw start.

addCollector("waapi", ({ root, mode, report }) => {
  const motion = motionOf(report);
  if (mode === "motion") {
    motion.animations.push(...takeWatch(root));
    return;
  }
  for (const animation of document.getAnimations()) {
    try {
      const record = readAnimationRecord(animation, root, uniqueSelector);
      if (record?.inside) motion.animations.push(record);
    } catch {
      // Skip animations that cannot be read.
    }
  }
});

// ─── animation watcher: what starts during each step of the motion pass ─────
// Stands in for the CDP Animation domain, which extensions cannot use. While a
// step is armed, transitionrun and animationstart events and a per-frame
// document.getAnimations() scan collect every new Animation object. Records are
// read at collect time, so short transitions that already finished still count.

/** A step disarms itself after this long if nobody collects it. */
const WATCH_STEP_MS = 10_000;
const WATCH_LOAD_MS = 20_000;

interface Watch {
  trigger: string;
  seen: WeakSet<Animation>;
  started: Animation[];
  until: number;
}
let watch: Watch | undefined;

function scanAnimations(): void {
  if (!watch) return;
  for (const animation of document.getAnimations()) {
    if (watch.seen.has(animation)) continue;
    watch.seen.add(animation);
    watch.started.push(animation);
  }
}

function pollWatch(): void {
  try {
    if (!watch) return;
    if (performance.now() > watch.until) {
      watch = undefined;
      return;
    }
    scanAnimations();
    requestAnimationFrame(pollWatch);
  } catch {
    // Never break the site.
  }
}

/** Starts a step. Animations already running are ignored unless includeRunning is set (the load step). */
function armWatch(trigger: string, includeRunning: boolean, durationMs: number): void {
  const seen = new WeakSet<Animation>();
  if (!includeRunning) for (const animation of document.getAnimations()) seen.add(animation);
  const first = watch === undefined;
  watch = { trigger, seen, started: [], until: performance.now() + durationMs };
  if (first) requestAnimationFrame(pollWatch);
}

function takeWatch(root: Element): AnimationRecord[] {
  if (!watch) return [];
  scanAnimations();
  const started = watch.started;
  watch = undefined;
  const records: AnimationRecord[] = [];
  for (const animation of started) {
    try {
      const record = readAnimationRecord(animation, root, uniqueSelector);
      if (record?.inside) records.push(record);
    } catch {
      // Skip animations that cannot be read.
    }
  }
  return records;
}

function installAnimationWatcher(loadCapture: boolean): void {
  const onCssEvent = () => {
    try {
      scanAnimations();
    } catch {
      // Never break the site.
    }
  };
  // Capture phase and passive, so the page's own handlers run exactly as before.
  window.addEventListener("transitionrun", onCssEvent, { capture: true, passive: true });
  window.addEventListener("animationstart", onCssEvent, { capture: true, passive: true });
  if (loadCapture) armWatch("load", true, WATCH_LOAD_MS);
}

// ─── GSAP: gsap.globalTimeline ───────────────────────────────────────────────

interface GsapTween {
  vars: Record<string, unknown>;
  parent: GsapTimeline | null;
  scrollTrigger?: unknown;
  targets?: () => unknown[];
  getChildren?: unknown;
  duration(): number;
  delay(): number;
  startTime(): number;
  repeat(): number;
  yoyo(): boolean;
  progress(value?: number, suppressEvents?: boolean): number;
  isActive(): boolean;
  paused(): boolean;
}
interface GsapTimeline extends GsapTween {
  getChildren(nested: boolean, tweens: boolean, timelines: boolean): GsapTween[];
}
interface Gsap {
  globalTimeline: GsapTimeline & { autoRemoveChildren: boolean };
  getProperty(target: Element, property: string): unknown;
}

/** GSAP's own keys in tween vars. Everything else is an animated property. */
const GSAP_SPECIAL_KEYS = new Set([
  "duration",
  "delay",
  "ease",
  "stagger",
  "repeat",
  "repeatDelay",
  "repeatRefresh",
  "yoyo",
  "yoyoEase",
  "immediateRender",
  "lazy",
  "overwrite",
  "paused",
  "reversed",
  "runBackwards",
  "startAt",
  "parent",
  "inherit",
  "id",
  "data",
  "keyframes",
  "scrollTrigger",
  "defaults",
  "callbackScope",
  "modifiers",
  "snap",
  "autoRound",
  "smoothOrigin",
  "onStart",
  "onStartParams",
  "onUpdate",
  "onUpdateParams",
  "onComplete",
  "onCompleteParams",
  "onRepeat",
  "onRepeatParams",
  "onReverseComplete",
  "onReverseCompleteParams",
  "onInterrupt",
  "onInterruptParams",
  "totalProgress",
]);

const tweenIds = new WeakMap<object, string>();
let nextTweenId = 1;
function idFor(tween: object): string {
  let id = tweenIds.get(tween);
  if (!id) {
    id = `gsap-tween-${nextTweenId++}`;
    tweenIds.set(tween, id);
  }
  return id;
}

function readGsap(): Gsap | undefined {
  const gsap = (window as { gsap?: Gsap }).gsap;
  return gsap && typeof gsap.globalTimeline?.getChildren === "function" ? gsap : undefined;
}

function staggerSeconds(stagger: unknown, targetCount: number): number | undefined {
  if (typeof stagger === "number") return stagger;
  if (stagger && typeof stagger === "object") {
    const { each, amount } = stagger as { each?: unknown; amount?: unknown };
    if (typeof each === "number") return each;
    if (typeof amount === "number" && targetCount > 1) return amount / (targetCount - 1);
  }
  return undefined;
}

function primitive(value: unknown): string | number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  if (typeof value === "string") return value;
  return null;
}

/** Start and end values, read by seeking the tween with events suppressed and seeking straight back within one task, so nothing renders in between. */
function tweenValues(gsap: Gsap, tween: GsapTween, target: Element, props: string[]): GsapRecord["values"] {
  const values: GsapRecord["values"] = {};
  const saved = tween.progress();
  try {
    tween.progress(0, true);
    for (const p of props) values[p] = { from: primitive(gsap.getProperty(target, p)), to: null };
    tween.progress(1, true);
    for (const p of props) {
      const v = values[p];
      if (v) v.to = primitive(gsap.getProperty(target, p));
    }
  } finally {
    tween.progress(saved, true);
  }
  return values;
}

/** Offset of a tween from the start of its top-level timeline (the one on the global timeline). */
function timelineOffset(gsap: Gsap, tween: GsapTween): { delay: number; position: number | null; timeline: GsapTween | null } {
  if (!tween.parent || tween.parent === gsap.globalTimeline) {
    return { delay: tween.delay(), position: null, timeline: null };
  }
  let offset = tween.startTime();
  let timeline: GsapTween = tween.parent;
  while (timeline.parent && timeline.parent !== gsap.globalTimeline) {
    offset += timeline.startTime();
    timeline = timeline.parent;
  }
  return { delay: offset + timeline.delay(), position: tween.startTime(), timeline };
}

function drivenByScrollTrigger(gsap: Gsap, tween: GsapTween): boolean {
  let node: GsapTween | null = tween;
  while (node && node !== gsap.globalTimeline) {
    if (node.scrollTrigger || node.vars.scrollTrigger) return true;
    node = node.parent;
  }
  return false;
}

function readTween(gsap: Gsap, tween: GsapTween, root: Element): GsapRecord | undefined {
  const all = typeof tween.targets === "function" ? tween.targets() : [];
  const targets = all.filter((t): t is Element => t instanceof Element);
  if (targets.length === 0 || !targets.some((t) => inside(root, t))) return undefined;
  const props: string[] = [];
  for (const [key, value] of Object.entries(tween.vars)) {
    if (GSAP_SPECIAL_KEYS.has(key)) continue;
    if (key === "css" && value && typeof value === "object") props.push(...Object.keys(value));
    else props.push(key);
  }
  if (props.length === 0) return undefined;
  const first = targets[0] as Element;
  const { delay, position, timeline } = timelineOffset(gsap, tween);
  const stagger = staggerSeconds(tween.vars.stagger, targets.length);
  const varsDuration = tween.vars.duration;
  return {
    id: idFor(tween),
    targets: targets.map(uniqueSelector),
    values: tweenValues(gsap, tween, first, props),
    vars: sanitize(Object.fromEntries(Object.entries(tween.vars).filter(([k]) => k !== "parent"))) as Record<string, unknown>,
    duration: typeof varsDuration === "number" ? varsDuration : tween.duration(),
    delay,
    // GSAP's default ease is power1.out.
    ease: typeof tween.vars.ease === "string" ? tween.vars.ease : tween.vars.ease ? "[function]" : "power1.out",
    stagger,
    repeat: tween.repeat(),
    yoyo: tween.yoyo(),
    position,
    timelineId: timeline ? idFor(timeline) : null,
    scrollTriggered: drivenByScrollTrigger(gsap, tween),
    isActive: tween.isActive(),
    paused: tween.paused() || (timeline?.paused() ?? false),
  };
}

/**
 * The tweens on the global timeline when a motion step was armed, and which of
 * them were running. A step's tweens are the new ones, plus old ones the step set
 * running (a paused timeline that a mouseenter handler plays).
 */
let gsapStep: { before: WeakSet<object>; activeBefore: WeakSet<object>; restore: () => void } | undefined;

function armGsapWatch(): void {
  gsapStep?.restore();
  gsapStep = undefined;
  const gsap = readGsap();
  if (!gsap) return;
  const before = new WeakSet<object>();
  const activeBefore = new WeakSet<object>();
  for (const tween of gsap.globalTimeline.getChildren(true, true, true)) {
    before.add(tween);
    if (tween.isActive()) activeBefore.add(tween);
  }
  // A hover tween often finishes before the step is collected, and GSAP removes
  // finished tweens from the global timeline. Keep them until the step ends.
  const timeline = gsap.globalTimeline;
  const previous = timeline.autoRemoveChildren;
  timeline.autoRemoveChildren = false;
  const timer = setTimeout(() => {
    timeline.autoRemoveChildren = previous;
  }, WATCH_STEP_MS);
  gsapStep = {
    before,
    activeBefore,
    restore: () => {
      clearTimeout(timer);
      timeline.autoRemoveChildren = previous;
    },
  };
}

/** True when a tween belongs to the current motion step. Checks the tween and its timelines. */
function startedThisStep(gsap: Gsap, tween: GsapTween, step: NonNullable<typeof gsapStep>): boolean {
  let node: GsapTween | null = tween;
  while (node && node !== gsap.globalTimeline) {
    if (!step.before.has(node)) return true;
    if (node.isActive() && !step.activeBefore.has(node)) return true;
    node = node.parent;
  }
  return false;
}

addCollector("gsap", ({ root, mode, report }) => {
  const motion = motionOf(report);
  const gsap = readGsap();
  if (!gsap) {
    motion.gsapUnreachable = Array.isArray((window as { gsapVersions?: unknown }).gsapVersions);
    return;
  }
  const step = gsapStep;
  if (mode === "motion") gsapStep = undefined;
  try {
    for (const child of gsap.globalTimeline.getChildren(true, true, false)) {
      try {
        // During the motion pass, only tweens this hover or focus started count.
        if (mode === "motion" && !(step ? startedThisStep(gsap, child, step) : child.isActive())) continue;
        const record = readTween(gsap, child, root);
        if (record) motion.gsap.push(record);
      } catch {
        // Skip tweens that cannot be read.
      }
    }
  } finally {
    if (mode === "motion") step?.restore();
  }
});

/**
 * GSAP removes finished tweens from the global timeline, so a load animation is
 * gone by the time the user clicks. When the background reloads the page to
 * record load motion, finished tweens are kept for ten seconds. Nothing about
 * rendering changes.
 */
function installGsapLoadRecording(loadCapture: boolean): void {
  if (!loadCapture) return;
  const started = performance.now();
  const poll = () => {
    try {
      const gsap = readGsap();
      if (gsap) {
        gsap.globalTimeline.autoRemoveChildren = false;
        setTimeout(() => {
          gsap.globalTimeline.autoRemoveChildren = true;
        }, 10_000);
        return;
      }
      if (performance.now() - started < 10_000) requestAnimationFrame(poll);
    } catch {
      // Never break the site.
    }
  };
  requestAnimationFrame(poll);
}

// ─── ScrollTrigger: ScrollTrigger.getAll() ───────────────────────────────────

interface ScrollTriggerInstance {
  trigger?: Element;
  pin?: Element;
  start: number;
  end: number;
  vars: Record<string, unknown>;
  animation?: GsapTween;
}

addCollector("scrolltrigger", ({ root, mode, report }) => {
  if (mode !== "full") return;
  const motion = motionOf(report);
  const ScrollTrigger = (window as { ScrollTrigger?: { getAll(): ScrollTriggerInstance[] } }).ScrollTrigger;
  const gsap = readGsap();
  if (!ScrollTrigger || typeof ScrollTrigger.getAll !== "function") return;

  const known = new Set(motion.gsap.map((r) => r.id));
  for (const st of ScrollTrigger.getAll()) {
    try {
      const animation = st.animation;
      const tweens: GsapTween[] = [];
      if (animation) {
        if (typeof animation.getChildren === "function") {
          tweens.push(...(animation as GsapTimeline).getChildren(true, true, false));
        } else {
          tweens.push(animation);
        }
      }
      const records = gsap ? tweens.map((t) => readTween(gsap, t, root)).filter((r): r is GsapRecord => !!r) : [];
      const trigger = st.trigger;
      const pinTarget = st.pin ?? (st.vars.pin instanceof Element ? st.vars.pin : undefined);
      const related =
        records.length > 0 ||
        inside(root, trigger) ||
        (trigger instanceof Element && trigger.contains(root)) ||
        inside(root, pinTarget);
      if (!related) continue;
      for (const record of records) {
        if (!known.has(record.id)) {
          known.add(record.id);
          motion.gsap.push(record);
        }
      }
      const scrub = st.vars.scrub;
      const record: ScrollTriggerRecord = {
        id: `scrolltrigger-${motion.scrollTriggers.length + 1}`,
        trigger: trigger instanceof Element ? uniqueSelector(trigger) : null,
        start: typeof st.vars.start === "string" || typeof st.vars.start === "number" ? st.vars.start : "top bottom",
        end: typeof st.vars.end === "string" || typeof st.vars.end === "number" ? st.vars.end : "bottom top",
        startPx: Math.round(st.start),
        endPx: Math.round(st.end),
        scrub: typeof scrub === "number" ? scrub : scrub === true,
        pin: Boolean(st.vars.pin),
        pinTarget: pinTarget instanceof Element ? uniqueSelector(pinTarget) : null,
        toggleActions: typeof st.vars.toggleActions === "string" ? st.vars.toggleActions : "play none none none",
        tweenIds: records.map((r) => r.id),
      };
      motion.scrollTriggers.push(record);
    } catch {
      // Skip triggers that cannot be read.
    }
  }
});

// ─── Lenis: smooth scroll ────────────────────────────────────────────────────

addCollector("lenis", ({ mode, report }) => {
  if (mode !== "full") return;
  const motion = motionOf(report);
  const lenis = (window as { lenis?: { options?: unknown } }).lenis;
  let smoothScroll: SmoothScroll | undefined;
  if (lenis && typeof lenis.options === "object" && lenis.options !== null) {
    smoothScroll = { library: "lenis", detectedBy: "global", options: sanitize(lenis.options) as Record<string, unknown> };
  } else if (document.documentElement.classList.contains("lenis")) {
    smoothScroll = { library: "lenis", detectedBy: "class", options: {} };
  }
  motion.smoothScroll = smoothScroll;
});
