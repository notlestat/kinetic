// Design token clustering. Pure, so it is unit tested in Node.
//
// Values that repeat across the captured nodes become tokens, and the node styles
// refer to the token name instead of the raw value. Near-identical colours (a
// channel or two apart, often from anti-aliased gradients or rounding) share one token.

import type { Tokens } from "@kinetic/schema";
import type { StyleMap } from "./style-diff.ts";

export type TokenGroup = keyof Tokens;

const COLOR_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "column-rule-color",
  "caret-color",
  "accent-color",
  "fill",
  "stroke",
]);
const SPACING_PROPERTY = /^(padding|margin)-(top|right|bottom|left)$|^(row-|column-)?gap$/;
const RADIUS_PROPERTY = /^border-(top|bottom)-(left|right)-radius$/;
const SHADOW_PROPERTIES = new Set(["box-shadow", "text-shadow"]);

const PREFIX: Record<TokenGroup, string> = {
  colors: "color",
  fontSizes: "font-size",
  spacing: "space",
  radii: "radius",
  shadows: "shadow",
};

/** Which token group a property's value belongs to, or undefined when it is not tokenised. */
export function groupFor(property: string, value: string): TokenGroup | undefined {
  if (COLOR_PROPERTIES.has(property)) {
    return isTokenColor(value) ? "colors" : undefined;
  }
  if (property === "font-size") return "fontSizes";
  if (SPACING_PROPERTY.test(property)) return isZeroOrKeyword(value) ? undefined : "spacing";
  if (RADIUS_PROPERTY.test(property)) return isZeroOrKeyword(value) ? undefined : "radii";
  if (SHADOW_PROPERTIES.has(property)) return value === "none" ? undefined : "shadows";
  return undefined;
}

function isZeroOrKeyword(value: string): boolean {
  return value === "0px" || value === "0" || value === "auto" || value === "normal" || value === "0px 0px";
}

type Rgba = [number, number, number, number];

/** Parses the rgb()/rgba() strings getComputedStyle returns. Other colour spaces only match exactly. */
export function parseRgb(value: string): Rgba | undefined {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value);
  if (!m) return undefined;
  const alphaText = m[4];
  let alpha = 1;
  if (alphaText !== undefined) {
    alpha = alphaText.endsWith("%") ? Number.parseFloat(alphaText) / 100 : Number.parseFloat(alphaText);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

function isTokenColor(value: string): boolean {
  if (value === "transparent" || value === "currentcolor" || value === "none") return false;
  const rgba = parseRgb(value);
  return rgba === undefined || rgba[3] > 0;
}

/** Colours this close on every channel (and in alpha) are treated as one. */
const COLOR_TOLERANCE = 2;
const ALPHA_TOLERANCE = 0.02;

function closeColors(a: Rgba, b: Rgba): boolean {
  return (
    Math.abs(a[0] - b[0]) <= COLOR_TOLERANCE &&
    Math.abs(a[1] - b[1]) <= COLOR_TOLERANCE &&
    Math.abs(a[2] - b[2]) <= COLOR_TOLERANCE &&
    Math.abs(a[3] - b[3]) <= ALPHA_TOLERANCE
  );
}

interface Cluster {
  /** The most frequent member, used as the token value. */
  value: string;
  members: Map<string, number>;
  count: number;
  firstSeen: number;
}

function clusterValues(group: TokenGroup, counts: Map<string, { count: number; firstSeen: number }>): Cluster[] {
  // Most frequent values first, so each cluster's representative is its most used member.
  const ordered = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[1].firstSeen - b[1].firstSeen);
  const clusters: Cluster[] = [];
  for (const [value, { count, firstSeen }] of ordered) {
    const rgba = group === "colors" ? parseRgb(value) : undefined;
    const home = rgba
      ? clusters.find((c) => {
          const rep = parseRgb(c.value);
          return rep !== undefined && closeColors(rep, rgba);
        })
      : undefined;
    if (home) {
      home.members.set(value, count);
      home.count += count;
      home.firstSeen = Math.min(home.firstSeen, firstSeen);
    } else {
      clusters.push({ value, members: new Map([[value, count]]), count, firstSeen });
    }
  }
  return clusters;
}

function numericValue(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

/** Sizes read best as an ascending scale. Colours and shadows read best by how often they are used. */
function orderClusters(group: TokenGroup, clusters: Cluster[]): Cluster[] {
  const byUse = (a: Cluster, b: Cluster) => b.count - a.count || a.firstSeen - b.firstSeen;
  if (group === "colors" || group === "shadows") return [...clusters].sort(byUse);
  return [...clusters].sort((a, b) => numericValue(a.value) - numericValue(b.value) || byUse(a, b));
}

export interface TokenisedNode {
  styles: StyleMap;
}

export interface TokenResult<N extends TokenisedNode> {
  tokens: Tokens;
  nodes: N[];
}

/** A value becomes a token once it (or its colour cluster) appears this many times. */
export const MIN_TOKEN_USES = 2;

/**
 * Clusters colours, font sizes, spacing, radii and shadows across nodes, and
 * replaces every value that repeats with its token name. Returns new nodes and
 * leaves the input untouched.
 */
export function buildTokens<N extends TokenisedNode>(nodes: readonly N[]): TokenResult<N> {
  const counts: Record<TokenGroup, Map<string, { count: number; firstSeen: number }>> = {
    colors: new Map(),
    fontSizes: new Map(),
    spacing: new Map(),
    radii: new Map(),
    shadows: new Map(),
  };

  let order = 0;
  for (const node of nodes) {
    for (const [property, value] of Object.entries(node.styles)) {
      const group = groupFor(property, value);
      if (!group) continue;
      const entry = counts[group].get(value);
      if (entry) entry.count += 1;
      else counts[group].set(value, { count: 1, firstSeen: order++ });
    }
  }

  const tokens: Tokens = { colors: {}, fontSizes: {}, spacing: {}, radii: {}, shadows: {} };
  const lookup: Record<TokenGroup, Map<string, string>> = {
    colors: new Map(),
    fontSizes: new Map(),
    spacing: new Map(),
    radii: new Map(),
    shadows: new Map(),
  };

  for (const group of Object.keys(counts) as TokenGroup[]) {
    const clusters = orderClusters(
      group,
      clusterValues(group, counts[group]).filter((c) => c.count >= MIN_TOKEN_USES),
    );
    clusters.forEach((cluster, i) => {
      const name = `${PREFIX[group]}-${i + 1}`;
      tokens[group][name] = cluster.value;
      for (const member of cluster.members.keys()) lookup[group].set(member, name);
    });
  }

  const tokenised = nodes.map((node) => {
    const styles: StyleMap = {};
    for (const [property, value] of Object.entries(node.styles)) {
      const group = groupFor(property, value);
      styles[property] = (group && lookup[group].get(value)) ?? value;
    }
    return { ...node, styles };
  });

  return { tokens, nodes: tokenised };
}
