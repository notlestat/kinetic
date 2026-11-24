// Stylesheet motion: the @keyframes rules and transition declarations that apply to
// the selection. Cross-checks the Animation domain and catches animations that did
// not fire while capturing (a load animation that finished before the click).

import { parseKeyText, splitCssList } from "./css-list.ts";
import type { CssMotionReport } from "./motion-records.ts";
import type { CapturedNode } from "./style-capture.ts";

function* allRules(rules: CSSRuleList): Generator<CSSRule> {
  for (const rule of Array.from(rules)) {
    yield rule;
    if (rule instanceof CSSImportRule && rule.styleSheet) {
      try {
        yield* allRules(rule.styleSheet.cssRules);
      } catch {
        // Cross-origin imported sheet.
      }
    } else if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList && !(rule instanceof CSSKeyframesRule)) {
      yield* allRules(rule.cssRules);
    }
  }
}

function keyframesRules(names: ReadonlySet<string>): CssMotionReport["keyframes"] {
  const found: CssMotionReport["keyframes"] = {};
  if (names.size === 0) return found;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // Cross-origin stylesheet without CORS.
    }
    for (const rule of allRules(rules)) {
      if (!(rule instanceof CSSKeyframesRule) || !names.has(rule.name)) continue;
      const frames: CssMotionReport["keyframes"][string] = [];
      for (const frame of Array.from(rule.cssRules)) {
        if (!(frame instanceof CSSKeyframeRule)) continue;
        const values: Record<string, string> = {};
        let easing: string | undefined;
        for (let i = 0; i < frame.style.length; i++) {
          const prop = frame.style.item(i);
          const value = frame.style.getPropertyValue(prop).trim();
          if (prop === "animation-timing-function") easing = value;
          else values[prop] = value;
        }
        for (const offset of parseKeyText(frame.keyText)) frames.push({ offset, easing, values });
      }
      // Later rules with the same name win, as in the cascade.
      found[rule.name] = frames.sort((a, b) => a.offset - b.offset);
    }
  }
  return found;
}

export function collectCssMotion(nodes: readonly CapturedNode[]): CssMotionReport {
  const animated: CssMotionReport["animated"] = [];
  const transitions: CssMotionReport["transitions"] = [];
  const names = new Set<string>();

  for (const { el, selector } of nodes) {
    const cs = getComputedStyle(el);
    const animationNames = splitCssList(cs.animationName).filter((n) => n !== "none");
    if (animationNames.length > 0) {
      for (const n of animationNames) names.add(n);
      animated.push({
        selector,
        names: animationNames,
        durations: splitCssList(cs.animationDuration),
        delays: splitCssList(cs.animationDelay),
        iterations: splitCssList(cs.animationIterationCount),
        directions: splitCssList(cs.animationDirection),
        easings: splitCssList(cs.animationTimingFunction),
      });
    }
    const durations = splitCssList(cs.transitionDuration);
    if (durations.some((d) => Number.parseFloat(d) > 0)) {
      transitions.push({
        selector,
        properties: splitCssList(cs.transitionProperty),
        durations,
        delays: splitCssList(cs.transitionDelay),
        easings: splitCssList(cs.transitionTimingFunction),
      });
    }
  }
  return { keyframes: keyframesRules(names), animated, transitions };
}
