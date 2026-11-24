// Style capture: computed styles per node, diffed against the browser default for each tag.

import type { BoundingBox, Font, StyledNode, Styles } from "@kinetic/schema";
import { uniqueSelector } from "./selector.ts";
import { diffAgainstDefaults, type StyleMap } from "./style-diff.ts";
import { buildTokens } from "./tokens.ts";

/** Upper bound on captured nodes, so a whole-page selection still produces a usable capture. */
export const MAX_NODES = 1500;

export interface CapturedNode {
  el: Element;
  selector: string;
}

/** The root and its descendants, each with a page-unique selector. */
export function collectNodes(root: Element): CapturedNode[] {
  const els = [root, ...Array.from(root.querySelectorAll("*"))].slice(0, MAX_NODES);
  return els.map((el) => ({ el, selector: uniqueSelector(el) }));
}

export function computedStyleMap(el: Element): StyleMap {
  const cs = getComputedStyle(el);
  const out: StyleMap = {};
  for (let i = 0; i < cs.length; i++) {
    const name = cs.item(i);
    out[name] = cs.getPropertyValue(name);
  }
  return out;
}

export function documentBox(el: Element): BoundingBox {
  const r = el.getBoundingClientRect();
  return {
    x: round(r.left + window.scrollX),
    y: round(r.top + window.scrollY),
    width: round(r.width),
    height: round(r.height),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Browser default styles per tag, read from bare elements in a blank, standards-mode iframe.
 * Falls back to an empty map (every property counts as changed) if the page blocks the iframe.
 */
export class DefaultStyles {
  private frame: HTMLIFrameElement | undefined;
  private readonly cache = new Map<string, StyleMap>();

  async open(): Promise<void> {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden;";
    const loaded = new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
      setTimeout(resolve, 1000);
    });
    frame.srcdoc = "<!doctype html><html><head></head><body></body></html>";
    document.documentElement.appendChild(frame);
    await loaded;
    this.frame = frame;
  }

  close(): void {
    this.frame?.remove();
    this.frame = undefined;
  }

  for(el: Element): StyleMap {
    const ns = el.namespaceURI ?? "";
    const key = `${ns} ${el.localName}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const doc = this.frame?.contentDocument;
    if (!doc?.body) return {};
    const probe = doc.createElementNS(ns || "http://www.w3.org/1999/xhtml", el.localName);
    let holder: Element = probe;
    // SVG children only get SVG styles inside an <svg>.
    if (ns === "http://www.w3.org/2000/svg" && el.localName !== "svg") {
      holder = doc.createElementNS(ns, "svg");
      holder.appendChild(probe);
    }
    doc.body.appendChild(holder);
    const view = doc.defaultView;
    const styles: StyleMap = {};
    if (view) {
      const cs = view.getComputedStyle(probe);
      for (let i = 0; i < cs.length; i++) {
        const name = cs.item(i);
        styles[name] = cs.getPropertyValue(name);
      }
    }
    holder.remove();
    this.cache.set(key, styles);
    return styles;
  }
}

/** Styles for every node, diffed against defaults and the parent, then tokenised. */
export function captureStyles(nodes: readonly CapturedNode[], defaults: DefaultStyles): Styles {
  const computed = new Map<Element, StyleMap>();
  for (const { el } of nodes) computed.set(el, computedStyleMap(el));

  const styled: StyledNode[] = nodes.map(({ el, selector }, i) => {
    const box = documentBox(el);
    const parent = i === 0 || !el.parentElement ? null : (computed.get(el.parentElement) ?? null);
    return {
      selector,
      tag: el.localName,
      box,
      styles: diffAgainstDefaults({
        computed: computed.get(el) ?? {},
        defaults: defaults.for(el),
        parent,
        size: box,
      }),
    };
  });

  const { tokens, nodes: tokenised } = buildTokens(styled);
  return { nodes: tokenised, tokens, fonts: collectFonts(nodes.map((n) => n.el)) };
}

// ─── fonts ───────────────────────────────────────────────────────────────────

function firstFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

interface FontFace {
  family: string;
  weight: string;
  style: string;
  src: string | undefined;
  unicodeRange: string;
}

/** True when a unicode-range covers basic Latin "A" (U+0041), or there is no range at all. */
export function coversLatin(unicodeRange: string): boolean {
  const range = unicodeRange.trim();
  if (range === "") return true;
  return range.split(",").some((part) => {
    const m = /^u\+([0-9a-f?]+)(?:-([0-9a-f]+))?$/i.exec(part.trim());
    if (!m?.[1]) return false;
    const lo = Number.parseInt(m[1].replace(/\?/g, "0"), 16);
    const hi = m[2] ? Number.parseInt(m[2], 16) : Number.parseInt(m[1].replace(/\?/g, "f"), 16);
    return lo <= 0x41 && hi >= 0x41;
  });
}

function* walkRules(rules: CSSRuleList): Generator<CSSRule> {
  for (const rule of Array.from(rules)) {
    yield rule;
    if (rule instanceof CSSImportRule && rule.styleSheet) {
      try {
        yield* walkRules(rule.styleSheet.cssRules);
      } catch {
        // Cross-origin imported sheet: rules are not readable.
      }
    } else if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) {
      yield* walkRules(rule.cssRules);
    }
  }
}

function fontFaces(): FontFace[] {
  const faces: FontFace[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // Cross-origin stylesheet without CORS: its rules are not readable.
    }
    const base = sheet.href ?? document.baseURI;
    for (const rule of walkRules(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const style = rule.style;
      const url = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(style.getPropertyValue("src"))?.[2];
      let src: string | undefined;
      if (url && !url.startsWith("data:")) {
        try {
          src = new URL(url, base).href;
        } catch {
          src = undefined;
        }
      }
      faces.push({
        family: firstFamily(style.getPropertyValue("font-family")),
        weight: style.getPropertyValue("font-weight") || "400",
        style: style.getPropertyValue("font-style") || "normal",
        src,
        unicodeRange: style.getPropertyValue("unicode-range"),
      });
    }
  }
  return faces;
}

/** True when a face's weight (a single value or a "100 900" range) covers the used weight. */
function weightMatches(faceWeight: string, used: string): boolean {
  const usedNum = Number(used);
  const [lo, hi] = faceWeight.split(/\s+/).map((w) => (w === "normal" ? 400 : w === "bold" ? 700 : Number(w)));
  if (lo === undefined || Number.isNaN(lo)) return false;
  return hi === undefined || Number.isNaN(hi) ? lo === usedNum : usedNum >= lo && usedNum <= hi;
}

/** The fonts the captured nodes use: family, weight, style and the @font-face source if one is readable. */
export function collectFonts(els: readonly Element[]): Font[] {
  const used = new Map<string, Font>();
  for (const el of els) {
    const cs = getComputedStyle(el);
    const font: Font = { family: firstFamily(cs.fontFamily), weight: cs.fontWeight, style: cs.fontStyle };
    if (font.family) used.set(`${font.family}|${font.weight}|${font.style}`, font);
  }
  if (used.size === 0) return [];

  const faces = fontFaces();
  return [...used.values()].map((font) => {
    const sameFamily = faces
      .filter((f) => f.family.toLowerCase() === font.family.toLowerCase() && f.src)
      // Subset fonts split one family by script. Prefer the face that covers Latin text.
      .sort((a, b) => Number(coversLatin(b.unicodeRange)) - Number(coversLatin(a.unicodeRange)));
    const best =
      sameFamily.find((f) => weightMatches(f.weight, font.weight) && f.style === font.style) ??
      sameFamily.find((f) => weightMatches(f.weight, font.weight)) ??
      sameFamily[0];
    return best?.src ? { ...font, src: best.src } : font;
  });
}
