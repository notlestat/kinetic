// Tags and filters for the capture grid. Pure functions, so they are unit tested.

import type { MotionSource, MotionTrigger } from "@kinetic/schema";
import type { CaptureListItem } from "./api.ts";

export interface MotionFilter {
  id: string;
  label: string;
  /** Motion sources that count as this filter. */
  sources: readonly MotionSource[];
}

/** The motion-source filters, in the order the spec names them. */
export const MOTION_FILTERS: readonly MotionFilter[] = [
  { id: "gsap", label: "GSAP", sources: ["gsap"] },
  { id: "scrolltrigger", label: "ScrollTrigger", sources: ["scrolltrigger"] },
  { id: "framer-motion", label: "Framer Motion", sources: ["framer-motion"] },
  { id: "css", label: "CSS", sources: ["css-transition", "css-keyframes"] },
  { id: "three", label: "three", sources: ["three"] },
  { id: "lottie", label: "Lottie", sources: ["lottie"] },
];

export const TRIGGER_FILTERS: readonly { id: MotionTrigger; label: string }[] = [
  { id: "hover", label: "Hover" },
  { id: "scroll", label: "Scroll" },
  { id: "load", label: "Load" },
];

const SOURCE_LABELS: Readonly<Record<MotionSource, string>> = {
  "css-transition": "CSS transition",
  "css-keyframes": "CSS keyframes",
  waapi: "WAAPI",
  gsap: "GSAP",
  scrolltrigger: "ScrollTrigger",
  "framer-motion": "Framer Motion",
  sampled: "Sampled",
  three: "three",
  lottie: "Lottie",
  rive: "Rive",
  spline: "Spline",
};

const FRAMEWORK_LABELS: Readonly<Record<string, string>> = {
  react: "React",
  next: "Next.js",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  astro: "Astro",
};

export interface Tag {
  kind: "source" | "framework" | "three";
  label: string;
}

/** Motion sources (most entries first), frameworks, then has-3D. */
export function tagsFor(item: CaptureListItem): Tag[] {
  const sources = Object.entries(item.motion?.bySource ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([source]): Tag => ({ kind: "source", label: SOURCE_LABELS[source as MotionSource] ?? source }));
  const frameworkNames = new Set(item.framework.detected.map((d) => d.name));
  if (item.framework.kind !== "none") frameworkNames.add(item.framework.kind);
  const frameworks = [...frameworkNames].map((name): Tag => ({ kind: "framework", label: FRAMEWORK_LABELS[name] ?? name }));
  return [...sources, ...frameworks, ...(item.hasThree ? [{ kind: "three", label: "3D" } as const] : [])];
}

export interface FilterState {
  text: string;
  site: string;
  /** MotionFilter ids; a capture must match every selected one. */
  sources: string[];
  /** Triggers; a capture must have every selected one. */
  triggers: MotionTrigger[];
}

export const EMPTY_FILTERS: FilterState = { text: "", site: "", sources: [], triggers: [] };

export function hasSource(item: CaptureListItem, filterId: string): boolean {
  const filter = MOTION_FILTERS.find((f) => f.id === filterId);
  if (!filter) return false;
  if (filter.id === "three" && item.hasThree) return true;
  return filter.sources.some((source) => (item.motion?.bySource[source] ?? 0) > 0);
}

/** Every word must appear somewhere in the site, names, URL, selector or NOTES.md. */
export function matchesText(item: CaptureListItem, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [item.site, item.slug, item.componentName, item.meta.title ?? "", item.meta.url, item.meta.selector, item.notes ?? ""].join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function matchesFilters(item: CaptureListItem, filters: FilterState): boolean {
  if (filters.site && item.site !== filters.site) return false;
  if (!filters.sources.every((id) => hasSource(item, id))) return false;
  const triggers = item.motion?.triggers ?? [];
  if (!filters.triggers.every((t) => triggers.includes(t))) return false;
  return matchesText(item, filters.text);
}

/** Sites in the library, alphabetically, for the site select. */
export function sitesOf(items: readonly CaptureListItem[]): string[] {
  return [...new Set(items.map((i) => i.site))].sort((a, b) => a.localeCompare(b));
}

export function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
