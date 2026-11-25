// Writes REBUILD.md: the hand-off a coding agent (or the claude-cli and api modes)
// follows to turn a capture into Component.tsx and NOTES.md. Every link is relative
// to the capture folder, so the file works wherever the folder is opened.

import { stat } from "node:fs/promises";
import path from "node:path";
import type { Capture, Styles } from "@kinetic/schema";
import {
  chooseMotionLibrary,
  componentTree,
  LIBRARY_RULES,
  MOTION_TABLE_INTRO,
  motionNotes,
  motionTable,
  stateLines,
  threeSceneLines,
  tokenCss,
} from "@kinetic/schema/brief";
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
const FIX_PASS_HEADING = "## Fix pass";

export { chooseMotionLibrary, type MotionLibrary } from "@kinetic/schema/brief";

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

function threeLines(capture: Capture, files: readonly CaptureFileInfo[]): string[] {
  if (!capture.three) return [];
  const threeFiles = files.filter((f) => f.path.startsWith("three/")).slice(0, 20);
  return [...threeSceneLines(capture), ...threeFiles.map((f) => `- [${f.path}](${f.path})`)];
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
  const states = stateLines(capture, { links: true });
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
  push(MOTION_TABLE_INTRO, "");
  push(...motionTable(entries, { moreNote: (n) => `${n} more entries are in [motion.json](motion.json).` }), "");
  push(...motionNotes(capture));

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
