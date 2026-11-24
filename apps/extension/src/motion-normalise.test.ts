import { MotionSchema } from "@kinetic/schema";
import { describe, expect, it } from "vitest";
import gsapFixture from "./fixtures/motion-gsap.json" with { type: "json" };
import keyframesFixture from "./fixtures/motion-keyframes.json" with { type: "json" };
import type { AnimationRecord, GsapRecord } from "./motion-records.ts";
import {
  buildMotion,
  fromAnimationRecord,
  fromGsapRecords,
  type MotionInputs,
  mergeGsapRecords,
  mergeMotion,
  propertiesFromKeyframes,
  transitionCovers,
} from "./motion-normalise.ts";

// Fixtures are raw inputs recorded from captures of the test pages (e2e/record-fixtures.e2e.ts).
const keyframesInputs = keyframesFixture as unknown as MotionInputs;
const gsapInputs = gsapFixture as unknown as MotionInputs;

describe("buildMotion with the keyframes page fixture", () => {
  const motion = buildMotion(keyframesInputs);
  const bySourceTarget = (source: string, target: string) =>
    motion.entries.filter((e) => e.source === source && e.target.includes(target));

  it("produces a valid motion block with unique ids", () => {
    expect(MotionSchema.safeParse(motion).success).toBe(true);
    expect(new Set(motion.entries.map((e) => e.id)).size).toBe(motion.entries.length);
  });

  it("keeps the running CSS animation from getAnimations() over the stylesheet copy", () => {
    const pulses = bySourceTarget("css-keyframes", "span.badge");
    expect(pulses).toHaveLength(1);
    expect(pulses[0]).toMatchObject({ trigger: "loop", duration: 1200, iterations: "infinite", easing: [0.42, 0, 0.58, 1] });
    expect((pulses[0]?.raw as { from?: string }).from).toBeUndefined();
  });

  it("reads a load animation that is still running from getAnimations()", () => {
    const [fade] = bySourceTarget("css-keyframes", "h2.fade-in");
    expect(fade).toMatchObject({ trigger: "load", duration: 600, delay: 100, easing: [0.2, 0, 0, 1], raw: { kind: "CSSAnimation" } });
  });

  it("recovers a load animation that finished before the capture from the stylesheet", () => {
    // Drop the running copy, as if the animation ended before the user clicked.
    const atStart = keyframesInputs.atStart;
    if (!atStart) throw new Error("fixture has no atStart");
    const finished = buildMotion({
      ...keyframesInputs,
      atStart: { ...atStart, animations: atStart.animations.filter((a) => a.name !== "fade-up") },
    });
    const [fade] = finished.entries.filter((e) => e.source === "css-keyframes" && e.target.includes("h2.fade-in"));
    expect(fade).toMatchObject({ trigger: "load", duration: 600, delay: 100, easing: [0.2, 0, 0, 1] });
    expect(fade?.raw).toMatchObject({ from: "stylesheet", name: "fade-up" });
    expect(fade?.properties.find((p) => p.name === "transform")?.keyframes).toEqual([
      { offset: 0, value: "translateY(16px)" },
      { offset: 1, value: "translateY(0px)" },
    ]);
  });

  it("labels WAAPI animations by the step that started them", () => {
    const card = bySourceTarget("waapi", "div.card");
    expect(card.map((e) => e.trigger).sort()).toEqual(["focus", "hover"]);
    expect(bySourceTarget("waapi", "div.spinner")[0]).toMatchObject({ trigger: "loop", easing: "linear" });
  });

  it("keeps one hover transition per property, preferring the one real input fired", () => {
    const go = motion.entries.filter((e) => e.source === "css-transition" && e.trigger === "hover" && e.target.includes("button.go"));
    expect(go).toHaveLength(1);
    expect((go[0]?.raw as { from?: string }).from).toBeUndefined();
  });

  it("summarises CSS as the main source", () => {
    expect(motion.summary).toMatchObject({ primary: "css", suggestedLibrary: "framer-motion" });
  });
});

describe("buildMotion with the GSAP page fixture", () => {
  const motion = buildMotion(gsapInputs);

  it("produces a valid motion block", () => {
    expect(MotionSchema.safeParse(motion).success).toBe(true);
  });

  it("maps tweens driven by ScrollTrigger to scrolltrigger entries with a scroll block", () => {
    const scrub = motion.entries.find((e) => e.target.includes("div.scrub-box"));
    expect(scrub).toMatchObject({
      source: "scrolltrigger",
      trigger: "scroll",
      scroll: { start: "top 80%", end: "bottom 20%", scrub: 1, pin: false },
    });
  });

  it("adds a pin-only ScrollTrigger as its own entry", () => {
    const pin = motion.entries.find((e) => e.scroll?.pin);
    expect(pin).toMatchObject({ source: "scrolltrigger", properties: [], scroll: { start: "top top", end: "+=600" } });
  });

  it("gives the hover tween the hover trigger and converts its ease", () => {
    const hover = motion.entries.find((e) => e.source === "gsap" && e.trigger === "hover");
    expect(hover).toMatchObject({ duration: 300, easing: [0.175, 0.885, 0.32, 1.275], raw: { ease: "back.out(1.7)" } });
  });

  it("records Lenis and picks GSAP for the rebuild", () => {
    expect(motion.smoothScroll).toMatchObject({ library: "lenis", detectedBy: "global" });
    expect(motion.summary).toMatchObject({ primary: "gsap", suggestedLibrary: "gsap" });
  });
});

const animation = (overrides: Partial<AnimationRecord> = {}): AnimationRecord => ({
  kind: "CSSAnimation",
  target: "#a",
  pseudoElement: null,
  name: "spin",
  keyframes: [
    { offset: 0, computedOffset: 0, easing: "ease-in", composite: "auto", transform: "rotate(0deg)" },
    { offset: 1, computedOffset: 1, easing: "linear", composite: "auto", transform: "rotate(360deg)" },
  ],
  timing: { duration: 500, delay: 0, endDelay: 0, iterations: 1, direction: "normal", easing: "linear", fill: "auto" },
  playState: "running",
  inside: true,
  ...overrides,
});

describe("fromAnimationRecord", () => {
  it("takes the keyframe easing of a CSS animation when the effect easing is linear", () => {
    expect(fromAnimationRecord(animation(), "load")?.entry.easing).toEqual([0.42, 0, 1, 1]);
  });

  it("appends the pseudo-element to the target", () => {
    expect(fromAnimationRecord(animation({ pseudoElement: "::after" }), "load")?.entry.target).toBe("#a::after");
  });

  it("returns null when no property is animated", () => {
    expect(fromAnimationRecord(animation({ keyframes: [{ offset: 0 }, { offset: 1 }] }), "load")).toBeNull();
  });
});

describe("propertiesFromKeyframes", () => {
  it("converts camelCase names and spreads missing offsets evenly", () => {
    expect(
      propertiesFromKeyframes([
        { offset: null, backgroundColor: "red" },
        { offset: null, backgroundColor: "blue" },
        { offset: null, backgroundColor: "green" },
      ]),
    ).toEqual([
      {
        name: "background-color",
        keyframes: [
          { offset: 0, value: "red" },
          { offset: 0.5, value: "blue" },
          { offset: 1, value: "green" },
        ],
      },
    ]);
  });
});

describe("transitionCovers", () => {
  it("matches all, exact names and shorthands", () => {
    expect(transitionCovers("all", "opacity")).toBe(true);
    expect(transitionCovers("border", "border-top-color")).toBe(true);
    expect(transitionCovers("background-color", "background-color")).toBe(true);
    expect(transitionCovers("background", "background-color")).toBe(true);
    expect(transitionCovers("color", "background-color")).toBe(false);
  });
});

const tween = (overrides: Partial<GsapRecord> = {}): GsapRecord => ({
  id: "gsap-tween-1",
  targets: ["#a", "#b"],
  values: { x: { from: 0, to: 100 } },
  vars: {},
  duration: 0.5,
  delay: 0.2,
  ease: "power3.inOut",
  stagger: 0.05,
  repeat: 1,
  yoyo: true,
  position: null,
  timelineId: null,
  scrollTriggered: false,
  isActive: false,
  paused: true,
  ...overrides,
});

describe("GSAP normalisation", () => {
  it("converts seconds to milliseconds, repeat to iterations and yoyo to alternate", () => {
    const [draft] = fromGsapRecords([{ record: tween(), trigger: "hover" }], []);
    expect(draft?.entry).toMatchObject({
      source: "gsap",
      target: "#a, #b",
      duration: 500,
      delay: 200,
      stagger: 50,
      iterations: 2,
      direction: "alternate",
      easing: [0.77, 0, 0.175, 1],
      confidence: "exact",
    });
  });

  it("keeps eases without a cubic-bezier mapping as the GSAP name", () => {
    const [draft] = fromGsapRecords([{ record: tween({ ease: "elastic.out(1, 0.3)" }), trigger: "load" }], []);
    expect(draft?.entry.easing).toBe("elastic.out(1, 0.3)");
  });

  it("marks a tween near when a value could not be read", () => {
    const [draft] = fromGsapRecords([{ record: tween({ values: { x: { from: null, to: 100 } } }), trigger: "load" }], []);
    expect(draft?.entry.confidence).toBe("near");
    expect(draft?.entry.properties).toEqual([{ name: "x", keyframes: [{ offset: 1, value: 100 }] }]);
  });

  it("upgrades a paused tween's trigger to the step that played it", () => {
    const merged = mergeGsapRecords([tween()], [{ trigger: "hover", records: [tween({ isActive: true, paused: false })] }]);
    expect(merged.map((m) => m.trigger)).toEqual(["hover"]);
  });

  it("keeps load for a tween already running from load", () => {
    const merged = mergeGsapRecords([tween({ paused: false })], [{ trigger: "hover", records: [tween()] }]);
    expect(merged.map((m) => m.trigger)).toEqual(["load"]);
  });
});

describe("mergeMotion", () => {
  it("keeps the first draft per key and numbers ids per source", () => {
    const base = fromAnimationRecord(animation({ kind: "Animation" }), "hover");
    if (!base) throw new Error("expected a draft");
    const entries = mergeMotion([base], [{ ...base, entry: { ...base.entry, duration: 999 } }], [{ key: "other", entry: base.entry }]);
    expect(entries.map((e) => [e.id, e.duration])).toEqual([
      ["waapi-1", 500],
      ["waapi-2", 500],
    ]);
  });
});

describe("buildMotion with Framer Motion records", () => {
  const waapiOpacity: AnimationRecord = {
    kind: "Animation",
    target: "div.box",
    pseudoElement: null,
    name: "",
    keyframes: [
      { offset: 0, opacity: "0", computedOffset: 0, easing: "linear", composite: "auto" },
      { offset: 1, opacity: "1", computedOffset: 1, easing: "linear", composite: "auto" },
    ],
    timing: { duration: 300, delay: 0, endDelay: 0, iterations: 1, direction: "normal", easing: "cubic-bezier(0.25, 0.1, 0.35, 1)", fill: "both" },
    playState: "finished",
    inside: true,
  };
  const inputs: MotionInputs = {
    atStart: {
      animations: [waapiOpacity],
      gsap: [],
      scrollTriggers: [],
      gsapUnreachable: false,
      smoothScroll: undefined,
      framer: [{ target: "div.box", component: "motion.div", props: { initial: { opacity: 0 }, animate: { opacity: 1 } }, parent: null, childIndex: 0 }],
    },
    passes: [],
    css: { keyframes: {}, animated: [], transitions: [] },
    baseline: {},
    states: [],
  };

  it("keeps the Framer entry and drops the WAAPI animation Framer ran for it", () => {
    const motion = buildMotion(inputs);
    expect(motion.entries.map((e) => e.source)).toEqual(["framer-motion"]);
    expect(motion.summary).toMatchObject({ primary: "framer-motion", suggestedLibrary: "framer-motion" });
  });

  it("keeps WAAPI animations on elements Framer does not own", () => {
    const other = { ...waapiOpacity, target: "div.other" };
    const motion = buildMotion({ ...inputs, atStart: { ...(inputs.atStart as NonNullable<MotionInputs["atStart"]>), animations: [other] } });
    expect(motion.entries.map((e) => e.source).sort()).toEqual(["framer-motion", "waapi"]);
  });
});
