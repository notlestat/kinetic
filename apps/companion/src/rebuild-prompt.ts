// Writes REBUILD.md: the hand-off a coding agent (or the claude-cli and api modes)
// follows to turn a capture into Component.tsx and NOTES.md. Every link is relative
// to the capture folder, so the file works wherever the folder is opened.

import { stat } from "node:fs/promises";
import path from "node:path";
import { type Capture, type Easing, type MotionEntry, type Styles, summariseMotion } from "@kinetic/schema";
import { type CaptureFileInfo, listCaptureFiles, readCapture, writeFileAtomic, writeJson } from "./library.ts";
import { SANDBOX_PACKAGES } from "./sandbox.ts";

export const REBUILD_FILE = "REBUILD.md";
export const COMPONENT_FILE = "Component.tsx";
export const NOTES_FILE = "NOTES.md";
export const PREVIEW_VIDEO = "Component.preview.webm";
export const DIFF_REPORT = "DIFF.md";
export const STYLES_SUMMARY_FILE = "styles.summary.json";
/** styles.json above this size gets a styles.summary.json the prompt links instead. */
export const LARGE_STYLES_BYTES = 200_000;
const SUMMARY_NODES = 60;
const MAX_MOTION_ROWS = 40;
const FIX_PASS_HEADING = "## Fix pass";

export type MotionLibrary = "framer-motion" | "gsap" | "react-three-fiber";

/** R3F + drei when there is a three block; GSAP + ScrollTrigger when GSAP is the main source; Framer Motion otherwise. */
export function chooseMotionLibrary(capture: Capture): MotionLibrary {
  if (capture.three) return "react-three-fiber";
  const summary = capture.motion?.summary ?? summariseMotion(capture.motion?.entries ?? []);
  return summary.primary === "gsap" ? "gsap" : "framer-motion";
}

const LIBRARY_RULES: Readonly<Record<MotionLibrary, { name: string; rule: string }>> = {
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

function formatEasing(easing: Easing): string {
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

function motionTable(entries: readonly MotionEntry[]): string[] {
  if (entries.length === 0) return ["No motion was captured. Keep any state changes below as simple transitions."];
  const order = { exact: 0, near: 1, approximate: 2 } as const;
  const sorted = [...entries].sort((a, b) => order[a.confidence] - order[b.confidence]);
  const lines = [
    "| id | target | trigger | properties | duration | delay | easing | stagger | iterations | confidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...sorted.slice(0, MAX_MOTION_ROWS).map((e) => {
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
  if (sorted.length > MAX_MOTION_ROWS) lines.push("", `${sorted.length - MAX_MOTION_ROWS} more entries are in [motion.json](motion.json).`);
  return lines;
}

/** A smaller styles.json for prompts: tokens, fonts and the first nodes with their styles. */
export function summariseStyles(styles: Styles): Record<string, unknown> {
  return {
    note: `styles.json is large, so this summary keeps the tokens, fonts and the first ${SUMMARY_NODES} of ${styles.nodes.length} nodes. Read styles.json for the rest.`,
    tokens: styles.tokens ?? null,
    fonts: styles.fonts ?? [],
    nodeCount: styles.nodes.length,
    nodes: styles.nodes.slice(0, SUMMARY_NODES),
  };
}

function tokenCss(styles: Styles | undefined): string[] {
  const tokens = styles?.tokens;
  if (!tokens) return [];
  const lines = Object.values(tokens).flatMap((group) => Object.entries(group).map(([name, value]) => `  --${name}: ${value};`));
  return lines.length > 0 ? [":root {", ...lines, "}"] : [];
}

function componentTree(capture: Capture): string[] {
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
function lastPart(selector: string): string {
  return selector.split(" > ").at(-1) ?? selector;
}

function stateLines(capture: Capture): string[] {
  return (capture.states ?? []).map((s) => {
    // Each change is labelled with its element, since a state can change descendants too.
    const changes = Object.entries(s.changes).flatMap(([selector, props]) => {
      const label = selector === s.target ? "" : `\`${lastPart(selector)}\` `;
      return Object.entries(props).map(([k, v]) => `${label}${k}: ${v}`);
    });
    const shown = changes.slice(0, 8).join("; ");
    const more = changes.length > 8 ? ` (+${changes.length - 8} more)` : "";
    const shot = s.screenshot ? ` · [${s.screenshot}](${s.screenshot})` : "";
    return `- **${s.name}** on \`${s.target}\`${shot}${shown ? ` · ${shown}${more}` : ""}`;
  });
}

function threeLines(capture: Capture, files: readonly CaptureFileInfo[]): string[] {
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
  const threeFiles = files.filter((f) => f.path.startsWith("three/")).slice(0, 20);
  for (const f of threeFiles) out.push(`- [${f.path}](${f.path})`);
  return out;
}

export interface RebuildPromptInput {
  capture: Capture;
  files: readonly CaptureFileInfo[];
  /** True when styles.summary.json was written next to styles.json. */
  stylesSummary: boolean;
}

export function buildRebuildPrompt({ capture, files, stylesSummary }: RebuildPromptInput): string {
  const { meta } = capture;
  const library = chooseMotionLibrary(capture);
  const has = (p: string) => files.some((f) => f.path === p);
  const ref = `${meta.site}/${meta.slug}`;
  const entries = capture.motion?.entries ?? [];
  const split = capture.framework?.suggestedSplit ?? [];
  const screenshots = files.filter((f) => f.path.startsWith("states/") && f.path.endsWith(".png"));
  const tokens = tokenCss(capture.styles);
  const tree = componentTree(capture);
  const states = stateLines(capture);
  const three = threeLines(capture, files);
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(`# Rebuild ${meta.title ? `"${meta.title}"` : meta.slug}`, "");
  push(`Captured from <${meta.url}> on ${meta.timestamp} at ${meta.viewport.width}×${meta.viewport.height} (device scale ${meta.viewport.deviceScaleFactor}).`);
  push(`Component root: \`${meta.selector}\``, "");

  push("## Task", "");
  push("Rebuild this component as `Component.tsx` in React + TypeScript + Tailwind CSS.", "");
  push("- Export the component as the default export. It takes no required props.");
  push("- Put the design tokens below in CSS variables on the component's root (a `style` object or a `<style>` element) and use them through Tailwind arbitrary values such as `bg-[var(--color-1)]`. Do not hard-code token values.");
  if (split.length > 0) {
    push(`- Split it into these sub-components, all inside Component.tsx: ${split.map((s) => `\`${s.name}\``).join(", ")}.`);
    for (const s of split) push(`  - \`${s.name}\`: ${s.domNodes.slice(0, 4).map((n) => `\`${n}\``).join(", ")}${s.domNodes.length > 4 ? ", …" : ""}`);
  } else {
    push("- Split it into small sub-components where the structure repeats, all inside Component.tsx.");
  }
  push("- Use placeholder copy and images of the same length and size. Do not reuse the site's fonts, images, 3D models or text in client work.");
  push("- Write `NOTES.md`: a short taste note, three to six sentences in plain words, on why this component feels good (spacing, type, colour, motion character) and what you changed or could not match.", "");

  push("## Motion", "");
  push(`Library: **${LIBRARY_RULES[library].name}**. ${LIBRARY_RULES[library].rule}`, "");
  push("Use the exact durations, delays, easing curves and stagger from the table for every `exact` and `near` entry. Treat `approximate` entries (frame-sampled) as the feel to match, not exact values. Respect `prefers-reduced-motion` by switching large movement off.", "");
  push(...motionTable(entries), "");
  const smooth = capture.motion?.smoothScroll;
  if (smooth) push(`The page used ${smooth.library} smooth scrolling with options \`${JSON.stringify(smooth.options)}\`; scroll motion should feel that smooth.`, "");
  for (const warning of capture.motion?.warnings ?? []) push(`- Note: ${warning}`);
  if (capture.motion?.warnings?.length) push("");

  if (three.length > 0) push("## three.js scene", "", ...three, "");

  if (states.length > 0) push("## States", "", ...states, "");

  if (tokens.length > 0) push("## Tokens", "", "```css", ...tokens, "```", "");

  if (tree.length > 0) push("## Component tree", "", `From framework.json (${capture.framework?.kind ?? "none"}). Names show how the original was split.`, "", ...tree, "");

  push("## Files", "");
  for (const shot of screenshots) push(`- [${shot.path}](${shot.path})`);
  if (has("original.webm")) push("- [original.webm](original.webm): the recording, idle, then each hover and focus target, then a scroll pass");
  if (has("dom.html")) push("- [dom.html](dom.html): the cleaned markup");
  if (stylesSummary) push(`- [${STYLES_SUMMARY_FILE}](${STYLES_SUMMARY_FILE}): tokens, fonts and the first nodes. [styles.json](styles.json) is large; open it only for a specific node.`);
  else if (has("styles.json")) push("- [styles.json](styles.json): computed styles per node, with token names");
  if (has("motion.json")) push("- [motion.json](motion.json): every motion entry");
  if (has("framework.json")) push("- [framework.json](framework.json): the component tree and suggested split");
  if (files.some((f) => f.path.startsWith("three/"))) push("- [three/](three/): scene, camera path and shaders");
  push("");

  push("## Output contract", "");
  push("1. Write only `Component.tsx` and `NOTES.md`, in this folder. Do not change any other file.");
  push(`2. Import only ${SANDBOX_PACKAGES.map((p) => `\`${p}\``).join(", ")} (subpaths such as \`gsap/ScrollTrigger\` are fine). No CSS files, other packages, \`import.meta\` or network requests: the preview sandbox rejects them.`);
  push(`3. Then run, from the repo root: \`pnpm kinetic preview ${ref}\``);
  push("   It renders Component.tsx in a sandbox, records `Component.preview.webm` with the same script as the original, screenshots each state and writes the diff scores to capture.json. If a state is over the threshold it writes `DIFF.md` and adds a Fix pass section to this file.", "");

  push("## Canvas target (Blueprint or Paper)", "");
  push("When asked to build on a canvas instead of in code: make one artboard per state, **default**, **hover**, **focus** and **mobile** (390 px wide), in HTML and CSS using the CSS variables above. Beside each artboard, add a note with that state's motion values from the table: property, duration, delay, easing and stagger.", "");

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Adds (or replaces) the Fix pass section that points at DIFF.md. */
export function withFixPass(markdown: string, failing: readonly { state: string; score: number }[], threshold: number): string {
  const base = withoutFixPass(markdown);
  const list = failing.map((f) => `- \`${f.state}\`: ${(f.score * 100).toFixed(1)}% of pixels differ`).join("\n");
  return `${base.trimEnd()}\n\n${FIX_PASS_HEADING}\n\nThe preview is over the ${(threshold * 100).toFixed(1)}% threshold in ${failing.length} state${failing.length === 1 ? "" : "s"}:\n\n${list}\n\nRead [DIFF.md](DIFF.md) and the images it links, then edit Component.tsx (and NOTES.md if the note changes) to close the gap. Keep to the output contract above, then run the preview again.\n`;
}

/** Removes the Fix pass section, once the preview passes. */
export function withoutFixPass(markdown: string): string {
  const at = markdown.indexOf(`\n${FIX_PASS_HEADING}\n`);
  return at === -1 ? markdown : `${markdown.slice(0, at).trimEnd()}\n`;
}

/** Writes REBUILD.md (and styles.summary.json when styles.json is large) for a capture folder. */
export async function writeRebuildPrompt(dir: string, capture?: Capture): Promise<string> {
  const current = capture ?? (await readCapture(dir));
  const files = await listCaptureFiles(dir);
  const stylesSize = files.find((f) => f.path === "styles.json")?.size ?? 0;
  const stylesSummary = current.styles !== undefined && stylesSize > LARGE_STYLES_BYTES;
  if (stylesSummary && current.styles) await writeJson(path.join(dir, STYLES_SUMMARY_FILE), summariseStyles(current.styles));
  const listed = stylesSummary && !files.some((f) => f.path === STYLES_SUMMARY_FILE) ? [...files, { path: STYLES_SUMMARY_FILE, size: 0 }] : files;
  const markdown = buildRebuildPrompt({ capture: current, files: listed, stylesSummary });
  await writeFileAtomic(path.join(dir, REBUILD_FILE), markdown);
  return markdown;
}

export async function componentExists(dir: string): Promise<boolean> {
  return stat(path.join(dir, COMPONENT_FILE)).then((s) => s.isFile(), () => false);
}
