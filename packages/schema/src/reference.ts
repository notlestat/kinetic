// A capture as one block of Markdown that you can paste into a coding agent or a note.
// The extension copies it to the clipboard when you pick a component.
// Type-only imports keep zod out of the content script bundle.

import type { Capture, Easing, MotionEntry, StyledNode, Tokens } from "./capture.ts";

export interface ReferenceLimits {
  /** Characters of HTML before it is cut. */
  html: number;
  /** Styled nodes listed in the CSS block. */
  nodes: number;
  /** Motion entries listed. */
  motion: number;
}

export const DEFAULT_REFERENCE_LIMITS: ReferenceLimits = { html: 20_000, nodes: 120, motion: 30 };

const TOKEN_GROUPS: readonly (keyof Tokens)[] = ["colors", "fontSizes", "spacing", "radii", "shadows"];

function tokenNames(tokens: Tokens | undefined): Set<string> {
  const names = new Set<string>();
  if (tokens) for (const group of TOKEN_GROUPS) for (const name of Object.keys(tokens[group])) names.add(name);
  return names;
}

/** "html > body > main > section.hero > p" becomes "section.hero > p" when the root is "html > body > main > section.hero". */
export function relativeSelector(selector: string, rootSelector: string): string {
  if (!selector.startsWith(rootSelector)) return selector;
  const rootLast = rootSelector.split(/\s*>\s*|\s+/).at(-1) || rootSelector;
  return rootLast + selector.slice(rootSelector.length);
}

function cssBlock(node: StyledNode, rootSelector: string, names: Set<string>): string {
  const lines = Object.entries(node.styles).map(([prop, value]) => `  ${prop}: ${names.has(value) ? `var(--${value})` : value};`);
  return `${relativeSelector(node.selector, rootSelector)} {\n${lines.join("\n")}\n}`;
}

function easingText(easing: Easing): string {
  return typeof easing === "string" ? easing : `cubic-bezier(${easing.join(", ")})`;
}

function motionLine(entry: MotionEntry, rootSelector: string): string {
  const props = entry.properties
    .map((p) => {
      const first = p.keyframes[0]?.value;
      const last = p.keyframes.at(-1)?.value;
      return p.keyframes.length > 1 && first !== last ? `${p.name} ${first} → ${last}` : p.name;
    })
    .join(", ");
  const parts = [
    entry.trigger,
    entry.source,
    `\`${relativeSelector(entry.target, rootSelector)}\``,
    props || "no properties read",
    `${Math.round(entry.duration)}ms`,
    easingText(entry.easing),
  ];
  if (entry.delay) parts.push(`delay ${Math.round(entry.delay)}ms`);
  if (entry.stagger) parts.push(`stagger ${Math.round(entry.stagger)}ms`);
  if (entry.iterations !== 1) parts.push(entry.iterations === "infinite" ? "infinite" : `${entry.iterations}×`);
  if (entry.direction !== "normal") parts.push(entry.direction);
  return `- ${parts.join(" · ")}`;
}

/** Markdown describing the component: source, tokens, fonts, HTML, CSS and motion. */
export function referenceMarkdown(capture: Capture, limits: ReferenceLimits = DEFAULT_REFERENCE_LIMITS): string {
  const { meta, styles, motion } = capture;
  const root = styles?.nodes[0];
  const rootName = relativeSelector(meta.selector, meta.selector);
  const out: string[] = [`# Component reference: \`${rootName}\``, ""];

  out.push(`- Source: ${meta.url}`);
  if (meta.title) out.push(`- Page: ${meta.title}`);
  if (root) out.push(`- Size: ${Math.round(root.box.width)}×${Math.round(root.box.height)} px, in a ${meta.viewport.width}×${meta.viewport.height} viewport`);
  out.push(`- Kinetic library: \`library/${meta.site}/${meta.slug}\` (states, video and REBUILD.md, once the companion has it)`);

  const tokens = styles?.tokens;
  const names = tokenNames(tokens);
  if (tokens && names.size > 0) {
    const vars = TOKEN_GROUPS.flatMap((group) => Object.entries(tokens[group]).map(([name, value]) => `  --${name}: ${value};`));
    out.push("", "## Tokens", "", "```css", ":root {", ...vars, "}", "```");
  }

  const fonts = styles?.fonts ?? [];
  if (fonts.length > 0) {
    out.push("", "## Fonts", "");
    const seen = new Set<string>();
    for (const font of fonts) {
      const line = `- ${font.family} ${font.weight} ${font.style}${font.src ? ` (${font.src})` : ""}`;
      if (!seen.has(line)) out.push(line);
      seen.add(line);
    }
  }

  const html = capture.dom?.html ?? "";
  out.push("", "## HTML", "", "```html", html.length > limits.html ? `${html.slice(0, limits.html)}\n<!-- cut at ${limits.html} of ${html.length} characters -->` : html, "```");

  const nodes = (styles?.nodes ?? []).filter((n) => Object.keys(n.styles).length > 0);
  if (nodes.length > 0) {
    out.push("", "## CSS", "", "Computed styles that differ from the browser defaults.", "", "```css");
    out.push(nodes.slice(0, limits.nodes).map((n) => cssBlock(n, meta.selector, names)).join("\n\n"));
    if (nodes.length > limits.nodes) out.push(`\n/* ${nodes.length - limits.nodes} more elements in capture.json */`);
    out.push("```");
  }

  const entries = motion?.entries ?? [];
  if (entries.length > 0 || motion?.warnings?.length) {
    out.push("", "## Motion", "");
    if (motion?.summary && entries.length > 0) out.push(`Mostly ${motion.summary.primary}. Suggested library: ${motion.summary.suggestedLibrary}.`, "");
    for (const entry of entries.slice(0, limits.motion)) out.push(motionLine(entry, meta.selector));
    if (entries.length > limits.motion) out.push(`- …and ${entries.length - limits.motion} more in capture.json`);
    for (const warning of motion?.warnings ?? []) out.push(`- Note: ${warning}`);
  }

  return `${out.join("\n")}\n`;
}
