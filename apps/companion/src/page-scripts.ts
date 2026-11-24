// Code that runs inside the recorded page. Each export is passed to page.evaluate,
// which sends the function's source text to the page, so a function here must not use
// anything from outside its own body: no imports and no module-level helpers. Shared
// state lives on window.__kineticRecorder, set up by initRecorder.

/** One node at one moment: computed transform (individual translate/rotate/scale folded in), opacity, layout size. */
export type NodeRow = [transform: string, opacity: number, width: number, height: number];
/** A NodeRow plus clip-path and the document-space box. */
export type ScrollRow = [...NodeRow, clipPath: string, x: number, y: number, width: number, height: number];

export interface FramesResult {
  /** ms since startFrames. */
  times: number[];
  /** Only nodes whose values changed during the window. */
  nodes: { index: number; rows: NodeRow[] }[];
}

interface RecorderState {
  root: Element;
  nodes: Element[];
  read(): NodeRow[];
  readScroll(): ScrollRow[];
  frames?: { start: number; times: number[]; rows: NodeRow[][]; handle: number };
}

declare global {
  interface Window {
    __kineticRecorder?: RecorderState;
    /** uniqueSelector from the extension, injected as source text so selectors match the capture. */
    __kineticUniqueSelector?: (el: Element) => string;
    /** Set by the sandbox harness once the rebuild has mounted (sandbox/src/harness.tsx). */
    __kineticReady?: boolean;
    /** The rebuild's render or runtime error, from the sandbox harness. */
    __kineticError?: string;
  }
}

/**
 * tsx (used in development and e2e) compiles named functions with an __name() helper
 * that only exists in Node. This init script gives the page a no-op stand-in.
 */
export const NAME_SHIM = "globalThis.__name = globalThis.__name || function (target) { return target; };";

/** Finds the component again by its text and document box when the selector no longer matches one element. */
export function findByTextAndBox(ref: { tag: string; text: string; box: { x: number; y: number; width: number; height: number } | null }): Element | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  let candidates: Element[];
  try {
    candidates = Array.from(document.querySelectorAll(ref.tag || "*"));
  } catch {
    candidates = Array.from(document.querySelectorAll("*"));
  }
  let best: Element | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    let textScore = 0;
    if (ref.text) {
      const text = norm(el.textContent ?? "");
      if (text === ref.text) textScore = 3;
      else if (text.startsWith(ref.text.slice(0, 60))) textScore = 2;
      else if (text.includes(ref.text.slice(0, 30))) textScore = 1;
      else continue;
    }
    let distance = 0;
    if (ref.box) {
      distance =
        Math.abs(r.left + window.scrollX - ref.box.x) +
        Math.abs(r.top + window.scrollY - ref.box.y) +
        Math.abs(r.width - ref.box.width) +
        Math.abs(r.height - ref.box.height);
      if (!ref.text && distance > Math.max(40, (ref.box.width + ref.box.height) * 0.25)) continue;
    } else if (!ref.text) {
      continue;
    }
    const score = textScore * 1_000_000 - distance;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

/** Collects the root and its descendants (document order, capped) and sets up the readers. */
export function initRecorder(root: Element, maxNodes: number): { selectors: string[]; paths: number[][] } {
  const nodes: Element[] = [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n && nodes.length < maxNodes; n = walker.nextNode()) nodes.push(n as Element);

  const select = window.__kineticUniqueSelector;
  const selectors = nodes.map((el) => {
    try {
      return select ? select(el) : el.localName;
    } catch {
      return el.localName;
    }
  });
  const paths = nodes.map((el) => {
    const path: number[] = [];
    for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
      const parent: Element | null = e.parentElement;
      if (!parent) break;
      path.unshift(Array.prototype.indexOf.call(parent.children, e));
    }
    return path;
  });

  const size = (el: Element): [number, number] => {
    if (el instanceof HTMLElement) return [el.offsetWidth, el.offsetHeight];
    const r = el.getBoundingClientRect();
    return [r.width, r.height];
  };
  // translate, rotate and scale are separate properties from transform (Tailwind v4 uses them),
  // so fold them in: the element's matrix is translate · rotate · scale · transform.
  const matrixOf = (cs: CSSStyleDeclaration, width: number, height: number): string => {
    const m = new DOMMatrix();
    try {
      if (cs.translate && cs.translate !== "none") {
        const [tx = "0", ty = "0", tz = "0"] = cs.translate.split(/\s+/);
        const length = (v: string, basis: number) => (v.endsWith("%") ? (parseFloat(v) / 100) * basis : parseFloat(v) || 0);
        m.translateSelf(length(tx, width), length(ty, height), parseFloat(tz) || 0);
      }
      if (cs.rotate && cs.rotate !== "none") {
        const parts = cs.rotate.split(/\s+/);
        const angle = parts[parts.length - 1] as string;
        const axis = parts.length === 2 ? ({ x: "rotateX", y: "rotateY", z: "rotateZ" } as Record<string, string>)[parts[0] as string] : undefined;
        const fn = parts.length === 1 ? `rotate(${angle})` : axis ? `${axis}(${angle})` : `rotate3d(${parts.slice(0, 3).join(",")},${angle})`;
        m.multiplySelf(new DOMMatrix(fn));
      }
      if (cs.scale && cs.scale !== "none") {
        const [sx = "1", sy = sx, sz = "1"] = cs.scale.split(/\s+/);
        m.scaleSelf(parseFloat(sx), parseFloat(sy), parseFloat(sz));
      }
      if (cs.transform && cs.transform !== "none") m.multiplySelf(new DOMMatrix(cs.transform));
    } catch {
      return cs.transform || "none";
    }
    if (m.isIdentity) return "none";
    return `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
  };
  const read = (): NodeRow[] =>
    nodes.map((el) => {
      const cs = getComputedStyle(el);
      const [w, h] = size(el);
      return [matrixOf(cs, w, h), Number(cs.opacity), w, h];
    });
  const readScroll = (): ScrollRow[] =>
    nodes.map((el) => {
      const cs = getComputedStyle(el);
      const [w, h] = size(el);
      const r = el.getBoundingClientRect();
      return [matrixOf(cs, w, h), Number(cs.opacity), w, h, cs.clipPath || "none", r.left + window.scrollX, r.top + window.scrollY, r.width, r.height];
    });

  window.__kineticRecorder = { root, nodes, read, readScroll };
  return { selectors, paths };
}

/** Starts reading every node on every animation frame. The first read happens now, before any input. */
export function startFrames(): void {
  const state = window.__kineticRecorder;
  if (!state) throw new Error("recorder is not set up");
  if (state.frames) cancelAnimationFrame(state.frames.handle);
  const frames = { start: performance.now(), times: [] as number[], rows: [] as NodeRow[][], handle: 0 };
  const tick = () => {
    frames.times.push(performance.now() - frames.start);
    frames.rows.push(state.read());
    frames.handle = requestAnimationFrame(tick);
  };
  state.frames = frames;
  tick();
}

/** Stops the frame loop and returns the nodes that changed. */
export function stopFrames(): FramesResult {
  const state = window.__kineticRecorder;
  const frames = state?.frames;
  if (!state || !frames) return { times: [], nodes: [] };
  cancelAnimationFrame(frames.handle);
  delete state.frames;
  const first = frames.rows[0] ?? [];
  const nodes: FramesResult["nodes"] = [];
  first.forEach((row0, index) => {
    const changed = frames.rows.some((rows) => {
      const row = rows[index] as NodeRow;
      return row[0] !== row0[0] || Math.abs(row[1] - row0[1]) > 1e-6 || Math.abs(row[2] - row0[2]) > 1e-6 || Math.abs(row[3] - row0[3]) > 1e-6;
    });
    if (changed) nodes.push({ index, rows: frames.rows.map((rows) => rows[index] as NodeRow) });
  });
  return { times: frames.times, nodes };
}

/** Every node's values at the current scroll position, plus the root's viewport box. */
export function readScroll(): { rows: ScrollRow[]; rect: { x: number; y: number; width: number; height: number } } {
  const state = window.__kineticRecorder;
  if (!state) throw new Error("recorder is not set up");
  const r = state.root.getBoundingClientRect();
  return { rows: state.readScroll(), rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
}

/** The root's box in the viewport. */
export function rootRect(): { x: number; y: number; width: number; height: number } {
  const root = window.__kineticRecorder?.root;
  if (!root) throw new Error("recorder is not set up");
  const r = root.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Where the root sits in the document, and how far the page scrolls. */
export function geometry(): { docTop: number; docBottom: number; height: number; viewportWidth: number; viewportHeight: number; maxScroll: number; scrollY: number } {
  const root = window.__kineticRecorder?.root;
  if (!root) throw new Error("recorder is not set up");
  const r = root.getBoundingClientRect();
  const scroller = document.scrollingElement ?? document.documentElement;
  return {
    docTop: r.top + window.scrollY,
    docBottom: r.bottom + window.scrollY,
    height: r.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    maxScroll: Math.max(0, scroller.scrollHeight - window.innerHeight),
    scrollY: window.scrollY,
  };
}

/** Scrolls instantly, waits two frames so scroll handlers and ScrollTrigger have run, and returns the actual scrollY. */
export function scrollToY(y: number): Promise<number> {
  window.scrollTo({ top: y, left: window.scrollX, behavior: "instant" });
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY))));
}

/**
 * Elements to hover and focus: the states the capture recorded, then interactive
 * elements inside the component. Returns node indices. The root is hovered when
 * nothing else qualifies.
 */
export function listTargets(input: { states: { name: string; selector: string }[]; max: number }): { hover: number[]; focus: number[] } {
  const state = window.__kineticRecorder;
  if (!state) throw new Error("recorder is not set up");
  const { root, nodes } = state;
  const interactive = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const focusable = (el: Element) => el.matches(interactive) && !(el as HTMLButtonElement).disabled;
  const fromStates = (name: string) =>
    input.states
      .filter((s) => s.name === name)
      .map((s) => {
        try {
          return document.querySelector(s.selector);
        } catch {
          return null;
        }
      });
  const inside = [root, ...Array.from(root.querySelectorAll(interactive))].filter((el) => el.matches(interactive));
  const pick = (elements: (Element | null)[], keep: (el: Element) => boolean) => {
    const out: number[] = [];
    for (const el of elements) {
      if (!el || !keep(el)) continue;
      const index = nodes.indexOf(el);
      if (index !== -1 && !out.includes(index)) out.push(index);
      if (out.length >= input.max) break;
    }
    return out;
  };
  const hover = pick([...fromStates("hover"), ...inside], visible);
  const focus = pick([...fromStates("focus"), ...inside], (el) => visible(el) && focusable(el));
  return { hover: hover.length > 0 ? hover : [0], focus };
}

/** The viewport centre of a node, scrolling it into view first when it is off screen. Null when it has no box. */
export function nodeCenter(index: number): { x: number; y: number } | null {
  const el = window.__kineticRecorder?.nodes[index];
  if (!el) return null;
  let r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    r = el.getBoundingClientRect();
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Focuses a node with a visible focus ring, as keyboard focus would show it. */
export function focusNode(index: number): boolean {
  const el = window.__kineticRecorder?.nodes[index];
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
  el.focus({ focusVisible: true } as FocusOptions);
  return document.activeElement === el;
}

export function blurActive(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
}

// ─── preview only ────────────────────────────────────────────────────────────

/** The rebuild's root in the sandbox harness: #kinetic-root's only child, or #kinetic-root when it renders several. */
export function previewRoot(): Element | null {
  const host = document.getElementById("kinetic-root");
  if (!host) return null;
  return host.children.length === 1 ? (host.firstElementChild as Element) : host;
}

/** Marks the element at a child-index path from `root` with data-kinetic-target, clearing any earlier mark. */
export function markPath(root: Element, path: number[]): boolean {
  for (const el of Array.from(document.querySelectorAll("[data-kinetic-target]"))) el.removeAttribute("data-kinetic-target");
  let node: Element | undefined = root;
  for (const index of path) node = node?.children[index];
  if (!node) return false;
  node.setAttribute("data-kinetic-target", "");
  return true;
}

/** The element's box in document coordinates, after scrolling it to the middle of the viewport. */
export function documentBox(el: Element): { x: number; y: number; width: number; height: number } {
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
}

/**
 * Waits for a forced state's transitions: at least minMs, then until no finite
 * animation is running, up to maxMs. Endless loops are ignored.
 */
export async function settle(input: { minMs: number; maxMs: number }): Promise<void> {
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, input.minMs));
  while (performance.now() - start < input.maxMs) {
    const running = document.getAnimations().filter((a) => {
      if (a.playState !== "running") return false;
      const end = a.effect?.getComputedTiming().endTime;
      return typeof end === "number" && Number.isFinite(end);
    });
    if (running.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
