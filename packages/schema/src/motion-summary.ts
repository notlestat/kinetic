// The motion summary: counts by source and the trigger types, so a rebuild can
// choose between Framer Motion, GSAP and React Three Fiber at a glance.
// Type-only imports keep zod out of the bundle for callers that only need this.

import type { MotionEntry, MotionSource, MotionSummary, MotionTrigger } from "./capture.ts";

/** Which family each source belongs to when picking the main source. */
export const SOURCE_FAMILY: Readonly<Record<MotionSource, MotionSummary["primary"]>> = {
  "css-transition": "css",
  "css-keyframes": "css",
  waapi: "css",
  gsap: "gsap",
  scrolltrigger: "gsap",
  "framer-motion": "framer-motion",
  sampled: "sampled",
  three: "three",
  lottie: "lottie",
  rive: "rive",
  spline: "spline",
};

/** When two families tie, the earlier one wins: a library the site loaded on purpose beats plain CSS. */
const FAMILY_PRIORITY: readonly MotionSummary["primary"][] = [
  "three",
  "gsap",
  "framer-motion",
  "lottie",
  "rive",
  "spline",
  "css",
  "sampled",
];

export function summariseMotion(entries: readonly MotionEntry[]): MotionSummary {
  const bySource: Partial<Record<MotionSource, number>> = {};
  const triggers = new Set<MotionTrigger>();
  const families = new Map<MotionSummary["primary"], number>();
  for (const entry of entries) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
    triggers.add(entry.trigger);
    const family = SOURCE_FAMILY[entry.source];
    families.set(family, (families.get(family) ?? 0) + 1);
  }

  let primary: MotionSummary["primary"] = "none";
  let best = 0;
  for (const family of FAMILY_PRIORITY) {
    const count = families.get(family) ?? 0;
    if (count > best) {
      primary = family;
      best = count;
    }
  }

  const suggestedLibrary: MotionSummary["suggestedLibrary"] =
    (families.get("three") ?? 0) > 0 ? "react-three-fiber" : primary === "gsap" ? "gsap" : "framer-motion";

  return {
    total: entries.length,
    bySource,
    triggers: [...triggers].sort(),
    primary,
    suggestedLibrary,
  };
}
