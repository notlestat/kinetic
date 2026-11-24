import { MotionEntrySchema } from "@kinetic/schema";
import { describe, expect, it } from "vitest";
import { sanitizeValue } from "./component-props.ts";
import type { TreeNode } from "./component-tree.ts";
import { collectFramerRecords, defaultTransition, type FramerRecord, fromFramerRecords, timingOf } from "./framer-motion.ts";
import { mergeMotion } from "./motion-normalise.ts";

// Props as the React test page (apps/test-pages/src/react-page.tsx) passes them, after the MAIN world copies them.
const grid = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { delayChildren: 0.2, staggerChildren: 0.12 } },
};
const card = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } },
};

const records: FramerRecord[] = [
  {
    target: "h2",
    component: "motion.h2",
    props: { initial: { opacity: 0, y: 24 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: "easeOut", delay: 0.1 } },
    parent: null,
    childIndex: 0,
  },
  { target: "div.plans", component: "motion.div", props: { initial: "hidden", animate: "visible", variants: grid }, parent: null, childIndex: 1 },
  { target: "article.plan:nth-of-type(1)", component: "motion.article", props: { variants: card, whileHover: { y: -6 } }, parent: 1, childIndex: 0 },
  { target: "article.plan:nth-of-type(2)", component: "motion.article", props: { variants: card, whileHover: { y: -6 } }, parent: 1, childIndex: 1 },
  {
    target: "button.choose",
    component: "motion.button",
    props: { whileHover: { scale: 1.05 }, whileTap: { scale: 0.95 }, transition: { type: "spring", stiffness: 400, damping: 17 } },
    parent: 2,
    childIndex: 0,
  },
];

const entries = mergeMotion(fromFramerRecords(records));
const find = (target: string, trigger: string) => entries.filter((e) => e.target === target && e.trigger === trigger);

describe("fromFramerRecords", () => {
  it("produces valid entries with source framer-motion and confidence near", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(MotionEntrySchema.safeParse(entry).success).toBe(true);
      expect(entry.source).toBe("framer-motion");
    }
  });

  it("turns initial → animate into a load entry with the declared tween", () => {
    const [load] = find("h2", "load");
    expect(load).toMatchObject({ duration: 600, delay: 100, easing: [0, 0, 0.58, 1], confidence: "near" });
    expect(load?.properties).toEqual([
      { name: "opacity", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: 1 }] },
      { name: "y", keyframes: [{ offset: 0, value: 24 }, { offset: 1, value: 0 }] },
    ]);
  });

  it("resolves variant labels and uses Framer's default tween when the variant only orchestrates", () => {
    const [load] = find("div.plans", "load");
    expect(load).toMatchObject({ duration: 300, easing: [0.25, 0.1, 0.35, 1], raw: { variant: "visible", defaultTransition: true } });
  });

  it("propagates the parent's labels to children and applies staggerChildren and delayChildren", () => {
    const [first] = find("article.plan:nth-of-type(1)", "load");
    const [second] = find("article.plan:nth-of-type(2)", "load");
    expect(first).toMatchObject({ delay: 200, easing: "spring(stiffness: 300, damping: 24, mass: 1)", raw: { inheritedFrom: "parent" } });
    expect(second?.delay).toBe(320);
    expect(first?.properties.map((p) => p.name)).toEqual(["opacity", "y"]);
    expect(first?.duration).toBeGreaterThan(0);
  });

  it("maps whileHover and whileTap to hover and click, starting from the resting values", () => {
    const [hover] = find("article.plan:nth-of-type(1)", "hover");
    expect(hover?.properties).toEqual([{ name: "y", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: -6 }] }]);
    // No transition for y: Framer's default under-damped spring.
    expect(hover).toMatchObject({ easing: "spring(stiffness: 500, damping: 25, mass: 1)", raw: { defaultTransition: true } });

    const [press] = find("button.choose", "click");
    expect(press).toMatchObject({ easing: "spring(stiffness: 400, damping: 17, mass: 1)" });
    expect(press?.properties).toEqual([{ name: "scale", keyframes: [{ offset: 1, value: 0.95 }] }]);
    expect(find("button.choose", "hover")).toHaveLength(1);
  });

  it("handles keyframe arrays, repeat and per-value transitions", () => {
    const [entry, opacity] = fromFramerRecords([
      {
        target: "span.dot",
        component: "motion.span",
        props: {
          animate: { scale: [1, 1.4, 1], opacity: 0.5 },
          transition: { scale: { duration: 1.2, repeat: "Infinity", repeatType: "reverse", times: [0, 0.3, 1] }, default: { duration: 0.2 } },
        },
        parent: null,
        childIndex: 0,
      },
    ]).map((d) => d.entry);
    expect(entry).toMatchObject({ duration: 1200, iterations: "infinite", direction: "alternate", easing: [0.42, 0, 0.58, 1] });
    expect(entry?.properties[0]?.keyframes).toEqual([
      { offset: 0, value: 1 },
      { offset: 0.3, value: 1.4 },
      { offset: 1, value: 1 },
    ]);
    expect(opacity).toMatchObject({ duration: 200, properties: [{ name: "opacity", keyframes: [{ offset: 1, value: 0.5 }] }] });
  });

  it("skips the mount animation when initial is false, and records layout animations", () => {
    const drafts = fromFramerRecords([
      { target: "div.tab", component: "motion.div", props: { initial: false, animate: { x: 40 }, layout: true, layoutId: "underline" }, parent: null, childIndex: 0 },
    ]);
    expect(drafts.map((d) => d.entry.trigger)).toEqual(["unknown"]);
    expect(drafts[0]?.entry).toMatchObject({ duration: 450, easing: [0.4, 0, 0.1, 1], properties: [{ name: "layout" }] });
  });

  it("marks entries approximate when a variant is a function it cannot run", () => {
    const [draft] = fromFramerRecords([
      { target: "li", component: "motion.li", props: { animate: ["visible", "lift"], variants: { visible: "[function]", lift: { y: -2 } } }, parent: null, childIndex: 0 },
    ]);
    expect(draft?.entry.confidence).toBe("approximate");
  });
});

describe("timingOf and defaultTransition", () => {
  it("follows Framer Motion's defaults", () => {
    expect(defaultTransition("x", [0, 10])).toMatchObject({ type: "spring", stiffness: 500, damping: 25 });
    expect(defaultTransition("scale", [1, 0])).toMatchObject({ stiffness: 550, damping: 2 * Math.sqrt(550) });
    expect(defaultTransition("opacity", [0, 1])).toMatchObject({ duration: 0.3, ease: [0.25, 0.1, 0.35, 1] });
    expect(defaultTransition("x", [0, 5, 10])).toMatchObject({ type: "keyframes", duration: 0.8 });
  });

  it("reads duration-based springs and named eases", () => {
    expect(timingOf({ type: "spring", duration: 0.5, bounce: 0.2 })).toMatchObject({ duration: 500, easing: "spring(duration: 0.5, bounce: 0.2)" });
    expect(timingOf({ duration: 0.4, ease: "backOut" })).toMatchObject({ duration: 400, easing: [0.33, 1.53, 0.69, 0.99] });
    expect(timingOf({ duration: 0.4, ease: "anticipate" }).easing).toBe("anticipate");
    expect(timingOf({ duration: 0.4, ease: [0.2, 0, 0, 1], repeat: 2 })).toMatchObject({ easing: [0.2, 0, 0, 1], iterations: 3 });
  });
});

describe("collectFramerRecords", () => {
  it("collects motion components inside the selection with parent links and deep copies", () => {
    const el = (id: string) => ({ id });
    const tree: TreeNode<{ id: string }>[] = [
      {
        name: "Grid",
        props: {},
        key: null,
        elements: [el("section")],
        children: [
          {
            name: "motion.div",
            props: {},
            key: null,
            elements: [el("div.plans")],
            motionProps: { animate: "visible", variants: grid, className: "plans", onAnimationComplete: () => 0 },
            children: [
              { name: "motion.article", props: {}, key: null, elements: [el("article")], motionProps: { variants: card }, children: [] },
              { name: "motion.aside", props: {}, key: null, elements: [el("outside")], motionProps: { animate: { x: 1 } }, children: [] },
            ],
          },
        ],
      },
    ];
    const found = collectFramerRecords(tree, (e) => e.id !== "outside", (e) => e.id, (v) => sanitizeValue(v, { maxDepth: 6 }));
    expect(found).toEqual([
      { target: "div.plans", component: "motion.div", props: { animate: "visible", variants: grid }, parent: null, childIndex: 0 },
      { target: "article", component: "motion.article", props: { variants: card }, parent: 0, childIndex: 0 },
    ]);
  });
});
