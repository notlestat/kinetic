import { describe, expect, it } from "vitest";
import type { CaptureListItem } from "./api.ts";
import { EMPTY_FILTERS, type FilterState, matchesFilters, sitesOf, tagsFor, toggle } from "./filters.ts";

function item(overrides: Partial<CaptureListItem>): CaptureListItem {
  return {
    site: "127.0.0.1",
    slug: "card",
    componentName: "Card",
    meta: { url: "http://127.0.0.1:5180/card.html", timestamp: "2026-11-24T12:00:00.000Z", selector: "section.card" },
    framework: { kind: "none", detected: [] },
    hasThree: false,
    media: {},
    ...overrides,
  };
}

const button = item({
  slug: "button-hero",
  componentName: "ButtonHero",
  motion: { total: 10, bySource: { "css-transition": 8, sampled: 2 }, triggers: ["click", "hover", "loop"], primary: "css", suggestedLibrary: "framer-motion" },
  notes: "# Taste\n\nSoft lift on hover with a springy press.",
});
const gsap = item({
  site: "example.com",
  slug: "gsap-scrub",
  motion: { total: 2, bySource: { scrolltrigger: 1, gsap: 1 }, triggers: ["scroll", "load"], primary: "gsap", suggestedLibrary: "gsap" },
  framework: { kind: "react", detected: [{ name: "next", version: "15.0.0" }] },
});
const three = item({ slug: "three-stage", hasThree: true, motion: { total: 1, bySource: {}, triggers: ["loop"], primary: "three", suggestedLibrary: "react-three-fiber" } });
const all = [button, gsap, three];

const filter = (state: Partial<FilterState>) => all.filter((i) => matchesFilters(i, { ...EMPTY_FILTERS, ...state })).map((i) => i.slug);

describe("tagsFor", () => {
  it("lists motion sources by entry count, then frameworks, then 3D", () => {
    expect(tagsFor(button).map((t) => t.label)).toEqual(["CSS transition", "Sampled"]);
    expect(tagsFor(gsap).map((t) => t.label)).toEqual(["ScrollTrigger", "GSAP", "Next.js", "React"]);
    expect(tagsFor(three)).toEqual([{ kind: "three", label: "3D" }]);
  });
});

describe("matchesFilters", () => {
  it("shows everything with no filters", () => {
    expect(filter({})).toEqual(["button-hero", "gsap-scrub", "three-stage"]);
  });

  it("filters by site, motion source and trigger, and every selection must match", () => {
    expect(filter({ site: "example.com" })).toEqual(["gsap-scrub"]);
    expect(filter({ sources: ["css"] })).toEqual(["button-hero"]);
    expect(filter({ sources: ["three"] })).toEqual(["three-stage"]);
    expect(filter({ sources: ["gsap", "scrolltrigger"] })).toEqual(["gsap-scrub"]);
    expect(filter({ sources: ["gsap", "css"] })).toEqual([]);
    expect(filter({ triggers: ["hover"] })).toEqual(["button-hero"]);
    expect(filter({ triggers: ["scroll", "load"] })).toEqual(["gsap-scrub"]);
    expect(filter({ sources: ["lottie"] })).toEqual([]);
  });

  it("searches every word across names, URL and NOTES.md, ignoring case", () => {
    expect(filter({ text: "SPRINGY press" })).toEqual(["button-hero"]);
    expect(filter({ text: "springy scrub" })).toEqual([]);
    expect(filter({ text: "example.com" })).toEqual(["gsap-scrub"]);
    expect(filter({ text: "  " })).toHaveLength(3);
  });
});

describe("helpers", () => {
  it("lists sites once, sorted, and toggles values", () => {
    expect(sitesOf(all)).toEqual(["127.0.0.1", "example.com"]);
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });
});
