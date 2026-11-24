import type { FrameworkComponent, MotionEntry } from "@kinetic/schema";
import { captureSelector, expect, openTestPage, readCaptureJson, test } from "./fixtures.ts";

const SITE = "127.0.0.1";

const names = (components: readonly FrameworkComponent[]) => components.map((c) => c.name);

test("captures the React component tree and turns Framer Motion props into motion entries", async ({ page }) => {
  await openTestPage(page, "react.html");
  await page.waitForSelector("section.pricing article.plan");
  const outcome = await captureSelector(page, "section.pricing", "react-pricing");
  expect(outcome).toMatchObject({ ok: true });
  const capture = await readCaptureJson(SITE, "react-pricing");
  const framework = capture.framework;
  if (!framework) throw new Error("no framework block");

  expect(framework.kind).toBe("react");
  expect(framework.hook).toBe("kinetic");
  expect(framework.detected).toContainEqual(expect.objectContaining({ name: "react", version: expect.stringMatching(/^19\./) }));

  const list = names(framework.components);
  // App is the one component above PricingSection; StrictMode is not a component fiber.
  expect(list.slice(0, 2)).toEqual(["App", "PricingSection"]);
  expect(list.filter((n) => n === "PlanCard")).toHaveLength(3);
  expect(list.filter((n) => n === "CtaButton")).toHaveLength(3);
  expect(list).toContain("motion.h2");
  expect(list.filter((n) => n === "motion.article")).toHaveLength(3);

  const pricing = framework.components.find((c) => c.name === "PricingSection");
  expect(pricing?.domNodes).toEqual(["#root > section.pricing"]);
  // The fake credential is dropped; ordinary props stay.
  expect(pricing?.props).not.toHaveProperty("apiToken");
  expect(pricing?.props).toHaveProperty("plans");

  // PriceTag has no displayName, so the production build's minified name is flagged.
  const priceOwners = framework.components.filter((c) => c.domNodes.some((d) => d.includes("p.price")));
  expect(priceOwners).toHaveLength(3);
  expect(priceOwners.every((c) => c.minified)).toBe(true);

  const card = framework.components.find((c) => c.name === "CtaButton");
  expect(card?.props).toMatchObject({ onSelect: "[function]" });

  // The split follows the component tree: the heading and the repeated plan cards.
  expect(framework.suggestedSplit?.map((p) => p.name)).toEqual(["MotionH2", "PlanCard"]);

  const entries = (capture.motion?.entries ?? []).filter((e) => e.source === "framer-motion");
  // Matches the last selector step only, so "article.plan" does not also match the buttons inside the cards.
  const at = (target: string, trigger: MotionEntry["trigger"]) =>
    entries.filter((e) => (e.target.split(" > ").at(-1) ?? "").startsWith(target) && e.trigger === trigger);

  const [heading] = at("h2", "load");
  expect(heading).toMatchObject({ duration: 600, delay: 100, easing: [0, 0, 0.58, 1], confidence: "near" });
  expect(heading?.properties.map((p) => p.name)).toEqual(["opacity", "y"]);

  const cardLoads = at("article.plan", "load").sort((a, b) => a.delay - b.delay);
  expect(cardLoads.map((e) => e.delay)).toEqual([200, 320, 440]);
  expect(cardLoads[0]?.easing).toBe("spring(stiffness: 300, damping: 24, mass: 1)");

  expect(at("article.plan", "hover")).toHaveLength(3);
  expect(at("button.choose", "hover")).toHaveLength(3);
  const [press] = at("button.choose", "click");
  expect(press).toMatchObject({ easing: "spring(stiffness: 400, damping: 17, mass: 1)" });
  expect(press?.properties).toEqual([{ name: "scale", keyframes: [{ offset: 1, value: 0.95 }] }]);
  expect(capture.motion?.summary).toMatchObject({ primary: "framer-motion", suggestedLibrary: "framer-motion" });
});

test("captures the Vue component tree from a production build", async ({ page }) => {
  await openTestPage(page, "vue.html");
  await page.waitForSelector("section.pricing article.plan");
  const outcome = await captureSelector(page, "section.pricing", "vue-pricing");
  expect(outcome).toMatchObject({ ok: true });
  const capture = await readCaptureJson(SITE, "vue-pricing");
  const framework = capture.framework;
  if (!framework) throw new Error("no framework block");

  expect(framework.kind).toBe("vue");
  expect(framework.detected).toContainEqual({ name: "vue", version: expect.stringMatching(/^3\./) });
  const list = names(framework.components);
  expect(list.slice(0, 2)).toEqual(["App", "PricingGrid"]);
  expect(list.filter((n) => n === "PlanCard")).toHaveLength(3);
  expect(list.filter((n) => n === "PriceTag")).toHaveLength(3);
  expect(list.filter((n) => n === "FeatureList")).toHaveLength(3);

  const grid = framework.components.find((c) => c.name === "PricingGrid");
  expect(grid?.domNodes[0]).toBe("#app > section.pricing");
  const planCard = framework.components.find((c) => c.name === "PlanCard");
  expect(planCard?.props).not.toHaveProperty("sessionToken");
  expect(planCard?.props).toMatchObject({ plan: { name: "Starter", price: 9 } });
  expect(planCard?.domNodes.some((d) => d.includes("article.plan"))).toBe(true);

  // The unnamed functional component keeps a minified name.
  const dividers = framework.components.filter((c) => c.domNodes.some((d) => d.includes("hr")));
  expect(dividers).toHaveLength(3);
  expect(dividers.every((c) => c.minified)).toBe(true);
});

test("splits a component by DOM structure when the page has no framework", async ({ page }) => {
  await openTestPage(page, "nav.html");
  const outcome = await captureSelector(page, "nav.site-nav", "nav-split");
  expect(outcome).toMatchObject({ ok: true });
  const capture = await readCaptureJson(SITE, "nav-split");
  expect(capture.framework?.kind).toBe("none");
  expect(capture.framework?.components).toEqual([]);
  expect(capture.framework?.detected).toEqual([]);
  expect(capture.framework?.hook).toBeUndefined();
  expect(capture.framework?.suggestedSplit?.length).toBeGreaterThanOrEqual(2);
});
