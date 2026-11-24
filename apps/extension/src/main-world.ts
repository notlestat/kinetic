// MAIN world hooks. Each feature adds its own clearly marked section below and
// must never throw into page code: wrap every hook in try/catch, and never change
// what the page renders.

import type { Framework, SmoothScroll } from "@kinetic/schema";
import { sanitizeValue } from "./component-props.ts";
import { type DomChild, splitFromComponents, splitFromDom } from "./component-split.ts";
import { type FlatComponent, flattenTree, type TreeNode, toFrameworkComponents } from "./component-tree.ts";
import { detectFrameworks } from "./framework-detect.ts";
import { collectFramerRecords } from "./framer-motion.ts";
import { isKineticMessage, type MainWorldReport, postToWindow, ROOT_ATTRIBUTE } from "./messages.ts";
import { type AnimationRecord, type GsapRecord, readAnimationRecord, type ScrollTriggerRecord } from "./motion-records.ts";
import {
  containerFiber,
  currentHostRoot,
  type FiberLike,
  fiberFromNode,
  findHostFiber,
  HOST_ROOT,
  hostRootOf,
  readReactTree,
  startFiber,
} from "./react-tree.ts";
import { uniqueSelector } from "./selector.ts";
import { type InstanceLike, readVue2Tree, readVue3Tree, type VNodeLike, type Vue2InstanceLike, vue2Ancestor } from "./vue-tree.ts";

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
  const installers = [
    installReactHook,
    installBridge,
    () => installAnimationWatcher(loadCapture),
    () => installGsapLoadRecording(loadCapture),
  ];
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
  report.motion ??= { animations: [], gsap: [], scrollTriggers: [], gsapUnreachable: false, smoothScroll: undefined, framer: [] };
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

// ─── React: __REACT_DEVTOOLS_GLOBAL_HOOK__ ────────────────────────────────────
// React looks for this hook when it loads and registers each renderer with it.
// When React DevTools (or another tool) already installed one, Kinetic only reads
// it. Otherwise Kinetic installs a minimal hook that records renderers and fiber
// roots and does nothing else. Caveat: if Kinetic's hook loads before the React
// DevTools extension's, DevTools sees an existing hook and stays inactive on that
// page; disable Kinetic on the site to use DevTools there.

/** Marks Kinetic's own hook, so the framework section can say which hook it read. */
const KINETIC_HOOK_MARK = "__kinetic";

function installReactHook(): void {
  if ((window as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ !== undefined) return;
  const renderers = new Map<number, unknown>();
  const roots = new Map<number, Set<unknown>>();
  let nextId = 1;
  const hook = {
    [KINETIC_HOOK_MARK]: true,
    renderers,
    supportsFiber: true,
    inject(renderer: unknown): number {
      const id = nextId++;
      renderers.set(id, renderer);
      roots.set(id, new Set());
      return id;
    },
    onCommitFiberRoot(id: number, root: { current?: { memoizedState?: { element?: unknown } | null } } | null): void {
      try {
        const set = roots.get(id);
        if (!set || !root) return;
        // An unmounted root commits with no element.
        if (root.current?.memoizedState?.element == null) set.delete(root);
        else set.add(root);
      } catch {
        // Never break the site.
      }
    },
    onCommitFiberUnmount(): void {},
    onPostCommitFiberRoot(): void {},
    onScheduleFiberRoot(): void {},
    setStrictMode(): void {},
    checkDCE(): void {},
    getFiberRoots(id: number): Set<unknown> {
      return roots.get(id) ?? new Set();
    },
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    value: hook,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function reactHookState(): NonNullable<Framework["hook"]> {
  const hook = (window as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown> }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || typeof hook !== "object") return "none";
  return hook[KINETIC_HOOK_MARK] === true ? "kinetic" : "react-devtools";
}

// ─── framework: component tree, Framer Motion props, suggested split ─────────
// React: from the selected node's fiber (__reactFiber$), in the current tree.
// Vue 3: from the app container's root vnode (container._vnode), which production
// builds keep; Vue 2: from __vue__ instances. Framework detection covers React,
// Next.js, Vue, Nuxt, Svelte and Astro islands.

/** Prop values only the page can describe: elements become selectors, other nodes and events placeholders. */
function describeHostValue(value: object): string | undefined {
  if (value instanceof Element) return uniqueSelector(value);
  if (value instanceof Node || value === window) return "[node]";
  if (value instanceof Event) return "[event]";
  return undefined;
}

/** Framer Motion props need depth: variants → label → transition → per-value transition. */
function copyMotionProps(value: unknown): unknown {
  return sanitizeValue(value, { maxDepth: 6, maxKeys: 40, maxItems: 30, maxString: 300, describe: describeHostValue });
}

/** The selection's own element and up to `limit` descendants, in document order. */
function nodesIn(root: Element, limit: number): Element[] {
  const out: Element[] = [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node && out.length < limit; node = walker.nextNode()) out.push(node as Element);
  return out;
}

function reactRoots(root: Element): TreeNode<Element>[] | undefined {
  const isInside = (node: unknown): node is Element => inside(root, node);
  let anyFiber: FiberLike | undefined;
  for (const el of nodesIn(root, 3000)) {
    anyFiber = fiberFromNode(el) ?? containerFiber(el);
    if (anyFiber) break;
  }
  // The selection may sit inside a React root without a fiber of its own (a portal target, a static wrapper).
  for (let el: Element | null = root.parentElement; !anyFiber && el; el = el.parentElement) {
    anyFiber = fiberFromNode(el) ?? containerFiber(el);
  }
  if (!anyFiber) return undefined;
  const hostRoot = anyFiber.tag === HOST_ROOT ? anyFiber : hostRootOf(anyFiber);
  if (!hostRoot) return undefined;
  const current = currentHostRoot(hostRoot);
  const options = { isInside, isRoot: (node: unknown) => node === root, describe: describeHostValue };
  const from = findHostFiber(current, isInside);
  return readReactTree(from ? startFiber(from, options) : current, options);
}

type VueContainer = Element & { __vue_app__?: unknown; _vnode?: VNodeLike };

function vueRoots(root: Element): { roots: TreeNode<Element>[]; isInside: (el: Element) => boolean } | undefined {
  const isElement = (node: unknown): node is Element => node instanceof Element;
  const options = { isElement, describe: describeHostValue };
  const insideRoot = (el: Element) => inside(root, el);

  // Vue 3: the app container is the selection, an ancestor, or inside it.
  let container: VueContainer | null = null;
  for (let el: Element | null = root; el && !container; el = el.parentElement) {
    if ((el as VueContainer).__vue_app__) container = el as VueContainer;
  }
  container ??= Array.from(document.querySelectorAll<VueContainer>("[data-v-app]")).find((el) => inside(root, el) && el.__vue_app__) ?? null;
  if (container?._vnode) return { roots: readVue3Tree(container._vnode, options), isInside: insideRoot };

  // Vue 3 development builds without a reachable container: walk up from the element's instance.
  const instance = nodesIn(root, 500)
    .map((el) => (el as { __vueParentComponent?: InstanceLike }).__vueParentComponent)
    .find(Boolean);
  if (instance) {
    let top: InstanceLike = instance;
    while (top.parent) top = top.parent;
    if (top.vnode) return { roots: readVue3Tree(top.vnode, options), isInside: insideRoot };
  }

  // Vue 2: __vue__ on the component's root element. A component owns only its $el, so an ancestor component
  // whose $el contains the selection counts as rendering into it.
  let vm: Vue2InstanceLike | undefined;
  for (let el: Element | null = root; el && !vm; el = el.parentElement) vm = (el as { __vue__?: Vue2InstanceLike }).__vue__;
  vm ??= nodesIn(root, 500)
    .map((el) => (el as { __vue__?: Vue2InstanceLike }).__vue__)
    .find(Boolean);
  if (vm) {
    return { roots: readVue2Tree(vue2Ancestor(vm, 2), options), isInside: (el) => insideRoot(el) || el.contains(root) };
  }
  return undefined;
}

const SKIPPED_TAGS = new Set(["script", "style", "template", "noscript", "kinetic-picker"]);

/** Element children of el for the DOM split. Looks inside an element only when it is a lone wrapper. */
function domChildren(el: Element, depth = 0): DomChild[] {
  const children = Array.from(el.children)
    .filter((c) => !SKIPPED_TAGS.has(c.localName))
    .slice(0, 60);
  const out = children.map((c): DomChild => {
    const r = c.getBoundingClientRect();
    return {
      selector: uniqueSelector(c),
      tag: c.localName,
      classes: Array.from(c.classList),
      box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
    };
  });
  const only = out[0];
  if (out.length === 1 && only && depth < 4) only.children = domChildren(children[0] as Element, depth + 1);
  return out;
}

function frameworkProbe(root: Element) {
  const keyed = (el: Element) => Object.keys(el).some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$"));
  const sample = [...nodesIn(root, 300), ...(document.body ? nodesIn(document.body, 300) : [])];
  const svelteEl = document.querySelector('[class*="svelte-"]');
  return {
    global: (name: string) => (window as unknown as Record<string, unknown>)[name],
    query: (selector: string) => document.querySelector(selector),
    reactNodeFound: sample.some(keyed),
    svelteClassFound: !!svelteEl && /(^|\s)svelte-[a-z0-9]+(\s|$)/.test(svelteEl.getAttribute("class") ?? ""),
    generator: document.querySelector('meta[name="generator"]')?.getAttribute("content") ?? null,
  };
}

addCollector("framework", ({ root, mode, report }) => {
  if (mode !== "full") return;
  const detected = detectFrameworks(frameworkProbe(root));
  let kind: Framework["kind"] = "none";
  let flat: FlatComponent<Element>[] = [];

  const react = reactRoots(root);
  if (react) {
    const isInside = (el: Element) => inside(root, el);
    flat = flattenTree(react, { idPrefix: "react", isInside, selectorFor: uniqueSelector });
    if (flat.length > 0) {
      kind = "react";
      motionOf(report).framer = collectFramerRecords(react, isInside, uniqueSelector, copyMotionProps);
    }
  }
  if (kind === "none") {
    const vue = vueRoots(root);
    if (vue) {
      flat = flattenTree(vue.roots, { idPrefix: "vue", isInside: vue.isInside, selectorFor: uniqueSelector });
      if (flat.length > 0) kind = "vue";
    }
  }

  const components = toFrameworkComponents(flat);
  let suggestedSplit = splitFromComponents(components);
  if (suggestedSplit.length === 0) suggestedSplit = splitFromDom(domChildren(root));
  report.sections.framework = {
    kind,
    components,
    ...(suggestedSplit.length > 0 ? { suggestedSplit } : {}),
    detected,
    ...(detected.some((d) => d.name === "react") ? { hook: reactHookState() } : {}),
  };
});
