// Formatting shared by every rebuild brief: the companion's REBUILD.md and the
// extension's clipboard prompt. Type-only imports keep zod out of the extension bundle.

import type { Capture, Easing, MotionEntry, Styles } from "./capture.ts";
import { summariseMotion } from "./motion-summary.ts";

export type MotionLibrary = "framer-motion" | "gsap" | "react-three-fiber";

/** R3F + drei when there is a three block; GSAP + ScrollTrigger when GSAP is the main source; Framer Motion otherwise. */
export function chooseMotionLibrary(capture: Capture): MotionLibrary {
  if (capture.three) return "react-three-fiber";
  const summary = capture.motion?.summary ?? summariseMotion(capture.motion?.entries ?? []);
  return summary.primary === "gsap" ? "gsap" : "framer-motion";
}

export const LIBRARY_RULES: Readonly<Record<MotionLibrary, { name: string; rule: string }>> = {
  "framer-motion": {
    name: "Framer Motion",
    rule: "Animate with Framer Motion (`framer-motion`): `motion.*` elements with `whileHover`, `whileFocus`, `animate` and `transition`; `useScroll` and `useTransform` for scroll-linked motion. Plain CSS transitions are fine for simple colour changes.",
  },
  gsap: {
    name: "GSAP + ScrollTrigger",
    rule: "The original's main motion source is GSAP, so animate with `gsap` and `gsap/ScrollTrigger`: register the plugin once, create tweens and triggers inside `useLayoutEffect` with `gsap.context()`, and revert the context on unmount.",
  },
  "react-three-fiber": {
    name: "React Three Fiber + drei",
    rule: "The capture has a three.js scene, so draw it with `@react-three/fiber` (`<Canvas>`) and `@react-three/drei` helpers. Match the camera, lights, tone mapping and fog below. Use Framer Motion for any DOM motion around the canvas.",
  },
};

export const MOTION_TABLE_INTRO =
  "Use the exact durations, delays, easing curves and stagger from the table for every `exact` and `near` entry. Treat `approximate` entries (frame-sampled) as the feel to match, not exact values. Respect `prefers-reduced-motion` by switching large movement off.";

export function formatEasing(easing: Easing): string {
  return Array.isArray(easing) ? `cubic-bezier(${easing.join(", ")})` : easing;
}

function formatValue(value: string | number): string {
  return typeof value === "number" ? String(Math.round(value * 1000) / 1000) : value;
}

function formatProperties(entry: MotionEntry): string {
  return entry.properties
    .map((p) => {
      const first = p.keyframes[0];
      const last = p.keyframes.at(-1);
      if (!first || !last) return p.name;
      const extra = p.keyframes.length > 2 ? ` (${p.keyframes.length} keyframes)` : "";
      return `${p.name}: ${formatValue(first.value)} → ${formatValue(last.value)}${extra}`;
    })
    .join("; ");
}

/** Table cells may not contain pipes or newlines. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function scrollText(entry: MotionEntry): string {
  if (!entry.scroll) return "";
  const { start, end, scrub, pin } = entry.scroll;
  return ` · scroll ${start} → ${end}${scrub !== false ? `, scrub ${scrub}` : ""}${pin ? ", pinned" : ""}`;
}

export interface MotionTableOptions {
  maxRows?: number;
  /** The line under the table when rows were left out. */
  moreNote?: (count: number) => string;
}

export function motionTable(entries: readonly MotionEntry[], options: MotionTableOptions = {}): string[] {
  const maxRows = options.maxRows ?? 40;
  if (entries.length === 0) return ["No motion was captured. Keep any state changes below as simple transitions."];
  const order = { exact: 0, near: 1, approximate: 2 } as const;
  const sorted = [...entries].sort((a, b) => order[a.confidence] - order[b.confidence]);
  const lines = [
    "| id | target | trigger | properties | duration | delay | easing | stagger | iterations | confidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...sorted.slice(0, maxRows).map((e) => {
      const cells = [
        e.id,
        `\`${e.target}\``,
        `${e.trigger}${scrollText(e)}`,
        formatProperties(e),
        `${Math.round(e.duration)} ms`,
        `${Math.round(e.delay)} ms`,
        `\`${formatEasing(e.easing)}\``,
        e.stagger !== undefined ? `${Math.round(e.stagger)} ms` : "",
        `${e.iterations}${e.direction !== "normal" ? ` ${e.direction}` : ""}`,
        e.confidence,
      ];
      return `| ${cells.map(cell).join(" | ")} |`;
    }),
  ];
  const left = sorted.length - maxRows;
  if (left > 0) lines.push("", options.moreNote?.(left) ?? `${left} more entries were left out.`);
  return lines;
}

/** Smooth scrolling and capture warnings, as lines that follow the motion table. */
export function motionNotes(capture: Capture): string[] {
  const lines: string[] = [];
  const smooth = capture.motion?.smoothScroll;
  if (smooth) lines.push(`The page used ${smooth.library} smooth scrolling with options \`${JSON.stringify(smooth.options)}\`; scroll motion should feel that smooth.`, "");
  for (const warning of capture.motion?.warnings ?? []) lines.push(`- Note: ${warning}`);
  if (capture.motion?.warnings?.length) lines.push("");
  return lines;
}

export function tokenCss(styles: Styles | undefined): string[] {
  const tokens = styles?.tokens;
  if (!tokens) return [];
  const lines = Object.values(tokens).flatMap((group) => Object.entries(group).map(([name, value]) => `  --${name}: ${value};`));
  return lines.length > 0 ? [":root {", ...lines, "}"] : [];
}

export function componentTree(capture: Capture): string[] {
  const components = capture.framework?.components ?? [];
  if (components.length === 0) return [];
  const children = new Map<string | null, typeof components>();
  for (const c of components) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
  const ids = new Set(components.map((c) => c.id));
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const c of children.get(parentId) ?? []) {
      if (lines.length >= 40) return;
      lines.push(`${"  ".repeat(depth)}- ${c.name}${c.minified ? " (minified name)" : ""}`);
      walk(c.id, depth + 1);
    }
  };
  // Roots are components whose parent is not in the list.
  for (const c of components.filter((c) => c.parentId === null || !ids.has(c.parentId))) {
    if (lines.length >= 40) break;
    lines.push(`- ${c.name}${c.minified ? " (minified name)" : ""}`);
    walk(c.id, 1);
  }
  return lines;
}

/** "html > body > main > section.hero > a.chip > span.dot" → "span.dot". */
export function lastPart(selector: string): string {
  return selector.split(" > ").at(-1) ?? selector;
}

/** One line per state. With `links`, each line links its screenshot. */
export function stateLines(capture: Capture, options: { links?: boolean } = {}): string[] {
  return (capture.states ?? []).map((s) => {
    // Each change is labelled with its element, since a state can change descendants too.
    const changes = Object.entries(s.changes).flatMap(([selector, props]) => {
      const label = selector === s.target ? "" : `\`${lastPart(selector)}\` `;
      return Object.entries(props).map(([k, v]) => `${label}${k}: ${v}`);
    });
    const shown = changes.slice(0, 8).join("; ");
    const more = changes.length > 8 ? ` (+${changes.length - 8} more)` : "";
    const shot = options.links && s.screenshot ? ` · [${s.screenshot}](${s.screenshot})` : "";
    return `- **${s.name}** on \`${s.target}\`${shot}${shown ? ` · ${shown}${more}` : ""}`;
  });
}

/** Camera, lights, renderer, fog and post-processing of the three.js scene. */
export function threeSceneLines(capture: Capture): string[] {
  const three = capture.three;
  if (!three) return [];
  const out: string[] = [];
  if (three.camera) {
    const c = three.camera;
    out.push(`- Camera: ${c.type}${c.fov !== undefined ? `, fov ${c.fov}` : ""}, position [${c.position.join(", ")}], looking at [${c.target.join(", ")}]`);
  }
  for (const light of three.lights ?? []) {
    out.push(`- Light: ${light.type}${light.color ? ` ${light.color}` : ""}${light.intensity !== undefined ? `, intensity ${light.intensity}` : ""}${light.position ? ` at [${light.position.join(", ")}]` : ""}`);
  }
  if (three.renderer) out.push(`- Renderer: ${three.renderer.toneMapping}, exposure ${three.renderer.toneMappingExposure}, ${three.renderer.outputColorSpace}`);
  if (three.fog) out.push(`- Fog: ${three.fog.type} ${three.fog.color}`);
  if (three.postProcessing?.length) out.push(`- Post-processing seen: ${three.postProcessing.join(", ")}`);
  return out;
}
