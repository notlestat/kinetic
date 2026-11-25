// Turns a finished capture into one prompt for Claude Code. The prompt goes to the
// clipboard, so everything the agent needs is inline: no files, no links, no companion.

import type { Capture, StyledNode } from "@kinetic/schema";
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

/** Budgets in characters. A pasted prompt this size is about 20k tokens. */
export const PROMPT_LIMITS = {
  markup: 24_000,
  styles: 30_000,
  shaders: 12_000,
  motionRows: 40,
} as const;

/** A text file from the capture, such as three/shaders/0.frag.glsl. */
export interface PromptFile {
  path: string;
  text: string;
}

export interface ClipboardPrompt {
  text: string;
  /** True when a section was cut to fit its budget. */
  truncated: boolean;
}

/** Shortens a page selector to one relative to the component root: "& > a.chip > span.dot". */
export function relativeSelector(selector: string, root: string): string {
  if (selector === root) return "&";
  return selector.startsWith(`${root} `) ? `&${selector.slice(root.length)}` : selector;
}

function cssBlock(node: StyledNode, root: string): string {
  const props = Object.entries(node.styles).map(([k, v]) => `  ${k}: ${v};`);
  return [`${relativeSelector(node.selector, root)} {`, ...props, "}"].join("\n");
}

/** Appends whole blocks until the budget runs out. Returns how many were left out. */
function fitBlocks(blocks: readonly string[], budget: number): { text: string; left: number } {
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used + block.length + 1 > budget && kept.length > 0) break;
    kept.push(block);
    used += block.length + 1;
  }
  return { text: kept.join("\n"), left: blocks.length - kept.length };
}

function clip(text: string, budget: number): { text: string; cut: boolean } {
  if (text.length <= budget) return { text, cut: false };
  return { text: `${text.slice(0, budget)}\n<!-- cut: ${text.length - budget} more characters -->`, cut: true };
}

export function buildClipboardPrompt(capture: Capture, files: readonly PromptFile[] = []): ClipboardPrompt {
  const { meta } = capture;
  const library = chooseMotionLibrary(capture);
  const root = meta.selector;
  const split = capture.framework?.suggestedSplit ?? [];
  const tokens = tokenCss(capture.styles);
  const tree = componentTree(capture);
  const states = stateLines(capture);
  const three = threeSceneLines(capture);
  let truncated = false;
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(`# Rebuild ${meta.title ? `"${meta.title}"` : "a component"} as React`, "");
  push(`Kinetic captured this component from <${meta.url}> on ${meta.timestamp} at ${meta.viewport.width}×${meta.viewport.height} (device scale ${meta.viewport.deviceScaleFactor}).`);
  push(`Component root on that page: \`${root}\`. In the markup and styles below, \`&\` stands for that root.`, "");

  push("## Task", "");
  push("Rebuild this component in this project as React + TypeScript, styled with Tailwind CSS.", "");
  push("- First look at how this project is set up: the framework, where components live, how styles work and which animation libraries are installed. Follow what is there.");
  push(`- The motion below uses ${LIBRARY_RULES[library].name}. If that library is not installed, ask before adding it.`);
  push("- Name the component after what it is, for example `HeroCta`, and put it where this project keeps its components.");
  push("- Put the design tokens in CSS variables on the component's root and use them through Tailwind arbitrary values such as `bg-[var(--color-1)]`. Do not hard-code token values.");
  if (split.length > 0) {
    push(`- Split it into these sub-components: ${split.map((s) => `\`${s.name}\``).join(", ")}.`);
    for (const s of split) push(`  - \`${s.name}\`: ${s.domNodes.slice(0, 4).map((n) => `\`${relativeSelector(n, root)}\``).join(", ")}${s.domNodes.length > 4 ? ", …" : ""}`);
  } else {
    push("- Split it into small sub-components where the structure repeats.");
  }
  push("- Use placeholder copy and images of the same length and size. Do not reuse the site's fonts, images, 3D models or text in client work.");
  push("- When you finish, write three to six plain sentences on why the component feels good (spacing, type, colour, motion) and what you changed or could not match.", "");

  push("## Motion", "");
  push(`Library: **${LIBRARY_RULES[library].name}**. ${LIBRARY_RULES[library].rule}`, "");
  push(MOTION_TABLE_INTRO, "");
  const entries = capture.motion?.entries ?? [];
  if (entries.length > PROMPT_LIMITS.motionRows) truncated = true;
  push(...motionTable(entries, { maxRows: PROMPT_LIMITS.motionRows, moreNote: (n) => `${n} lower-confidence entries were left out.` }), "");
  push(...motionNotes(capture));

  if (three.length > 0) push("## three.js scene", "", ...three, "");
  if (states.length > 0) push("## States", "", "Style changes in each state, measured by forcing the state in Chrome.", "", ...states, "");
  if (tokens.length > 0) push("## Tokens", "", "```css", ...tokens, "```", "");
  if (tree.length > 0) push("## Component tree", "", `How the original was split (${capture.framework?.kind ?? "none"}).`, "", ...tree, "");

  if (capture.dom?.html) {
    const markup = clip(capture.dom.html, PROMPT_LIMITS.markup);
    truncated ||= markup.cut;
    push("## Markup", "", "The cleaned HTML of the original.", "", "```html", markup.text, "```", "");
  }

  const nodes = capture.styles?.nodes ?? [];
  if (nodes.length > 0) {
    const fitted = fitBlocks(nodes.map((n) => cssBlock(n, root)), PROMPT_LIMITS.styles);
    truncated ||= fitted.left > 0;
    push("## Computed styles", "", "Styles that differ from the browser default, per element, in document order.", "", "```css", fitted.text, "```");
    if (fitted.left > 0) push("", `${fitted.left} more elements were left out to keep this prompt short. Infer them from the markup.`);
    push("");
  }

  const fonts = capture.styles?.fonts ?? [];
  if (fonts.length > 0) {
    push("## Fonts", "", "The original used these. Pick close open-licence matches instead of copying them.", "");
    for (const f of fonts) push(`- ${f.family} ${f.weight} ${f.style}`);
    push("");
  }

  const shaders = files.filter((f) => f.path.startsWith("three/shaders/"));
  if (shaders.length > 0) {
    const fitted = fitBlocks(shaders.map((f) => `// ${f.path}\n${f.text}`), PROMPT_LIMITS.shaders);
    truncated ||= fitted.left > 0;
    push("## Shaders", "", "```glsl", fitted.text, "```");
    if (fitted.left > 0) push("", `${fitted.left} more shaders were left out.`);
    push("");
  }

  return { text: `${lines.join("\n").trimEnd()}\n`, truncated };
}
