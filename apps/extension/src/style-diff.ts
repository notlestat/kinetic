// Pure style diffing. No DOM access here, so the rules are unit tested in Node.

export type StyleMap = Record<string, string>;

/** CSS properties that inherit by default. A child only records them when its value differs from its parent's. */
export const INHERITED_PROPERTIES: ReadonlySet<string> = new Set([
  "border-collapse",
  "border-spacing",
  "caption-side",
  "caret-color",
  "color",
  "cursor",
  "direction",
  "empty-cells",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-synthesis-small-caps",
  "font-synthesis-style",
  "font-synthesis-weight",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  "hyphens",
  "image-rendering",
  "letter-spacing",
  "line-break",
  "line-height",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "orphans",
  "overflow-wrap",
  "paint-order",
  "pointer-events",
  "quotes",
  "tab-size",
  "text-align",
  "text-align-last",
  "text-anchor",
  "text-decoration-skip-ink",
  "text-emphasis-color",
  "text-emphasis-position",
  "text-emphasis-style",
  "text-indent",
  "text-rendering",
  "text-shadow",
  "text-size-adjust",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap-mode",
  "text-wrap-style",
  "visibility",
  "white-space-collapse",
  "widows",
  "word-break",
  "word-spacing",
  "writing-mode",
  "-webkit-font-smoothing",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
  "-webkit-text-stroke-width",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
]);

/** The element's size is in its bounding box already, and these always differ from an empty default element. */
const SIZE_PROPERTIES: ReadonlySet<string> = new Set(["width", "height"]);

// Logical properties (padding-inline-start, border-block-end-color, inline-size,
// border-start-end-radius) repeat the physical ones.
const LOGICAL_PROPERTY = /(^|-)(block|inline)(-|$)|^border-(start|end)-(start|end)-radius$/;

/** Engine bookkeeping rather than authored style. */
const NOISE_PROPERTIES: ReadonlySet<string> = new Set(["-webkit-locale"]);

/** Properties that are only noise in a capture, whatever their value. */
export function isIgnoredProperty(name: string): boolean {
  return name.startsWith("--") || SIZE_PROPERTIES.has(name) || NOISE_PROPERTIES.has(name) || LOGICAL_PROPERTY.test(name);
}

/**
 * Properties that follow the element's size or the emulated device rather than
 * the author's CSS, so they are left out when comparing two states.
 */
const STATE_NOISE: ReadonlySet<string> = new Set(["transform-origin", "perspective-origin", "-webkit-tap-highlight-color"]);

/** Properties whose default is currentcolor. They only matter when set to something other than the text colour. */
const CURRENTCOLOR_PROPERTIES: ReadonlySet<string> = new Set([
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "text-emphasis-color",
  "column-rule-color",
  "row-rule-color",
  "caret-color",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
]);

export interface DiffInput {
  computed: StyleMap;
  /** Computed styles of a bare element with the same tag in a blank document. */
  defaults: StyleMap;
  /** Computed styles of the parent node, or null for the capture root. */
  parent: StyleMap | null;
  /** Element size in CSS pixels, used to drop the default centre origin. */
  size: { width: number; height: number };
}

function isCentreOrigin(value: string, size: { width: number; height: number }): boolean {
  const parts = value.split(" ").map((p) => Number.parseFloat(p));
  const [x, y] = parts;
  if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) return false;
  return Math.abs(x - size.width / 2) < 0.5 && Math.abs(y - size.height / 2) < 0.5;
}

/**
 * Keeps only the computed styles a rebuild needs:
 * - non-inherited properties that differ from the browser default for the tag,
 * - inherited properties that differ from the parent (or from the default on the root).
 */
export function diffAgainstDefaults({ computed, defaults, parent, size }: DiffInput): StyleMap {
  const out: StyleMap = {};
  for (const [name, value] of Object.entries(computed)) {
    if (isIgnoredProperty(name)) continue;
    if ((name === "transform-origin" || name === "perspective-origin") && isCentreOrigin(value, size)) continue;
    // A currentcolor default resolves to the text colour, so it differs whenever the text colour does.
    if (CURRENTCOLOR_PROPERTIES.has(name) && value === computed.color && defaults[name] === defaults.color) continue;
    // Flex and grid items compute min-width and min-height to auto. That follows the parent's layout.
    if ((name === "min-width" || name === "min-height") && value === "auto") continue;
    const baseline = parent && INHERITED_PROPERTIES.has(name) ? parent[name] : defaults[name];
    if (value !== baseline) out[name] = value;
  }
  return out;
}

/** Selector → only the properties whose value changed between two snapshots of the same nodes. */
export function diffSnapshots(
  before: Record<string, StyleMap>,
  after: Record<string, StyleMap>,
): Record<string, StyleMap> {
  const changes: Record<string, StyleMap> = {};
  for (const [selector, styles] of Object.entries(after)) {
    const previous = before[selector] ?? {};
    const changed: StyleMap = {};
    for (const [name, value] of Object.entries(styles)) {
      if (isIgnoredProperty(name) || STATE_NOISE.has(name)) continue;
      if (previous[name] !== value) changed[name] = value;
    }
    if (Object.keys(changed).length > 0) changes[selector] = changed;
  }
  return changes;
}
