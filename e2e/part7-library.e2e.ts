// Part 7: the library UI. The example captures from examples/ are copied into the
// e2e library, then a plain Chromium page (no extension) browses them on
// 127.0.0.1:5173 through the companion's CORS routes.

import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2E_LIBRARY_DIR, REPO_ROOT } from "./paths.ts";

const LIBRARY = "http://127.0.0.1:5173";
const SITE = "127.0.0.1";
const EXAMPLES = ["button-hero", "gsap-scrub", "three-stage"];

test.beforeAll(async () => {
  for (const slug of EXAMPLES) {
    await cp(path.join(REPO_ROOT, "examples", SITE, slug), path.join(E2E_LIBRARY_DIR, SITE, slug), { recursive: true, force: true });
  }
});

const card = (page: Page, name: string) => page.locator(".card").filter({ has: page.locator(".card-name", { hasText: new RegExp(`^${name}$`) }) });

test("lists the example captures and filters them by motion source, trigger and taste note", async ({ page }) => {
  await page.goto(`${LIBRARY}/`);
  for (const name of ["ButtonHero", "GsapScrub", "ThreeStage"]) await expect(card(page, name)).toBeVisible();
  await expect(card(page, "ThreeStage").locator(".tag")).toHaveText(["three", "3D"]);
  await expect(card(page, "GsapScrub").locator(".tag")).toHaveText(["ScrollTrigger", "Sampled"]);
  // The grid preview is the original recording, muted and looping.
  const video = card(page, "ButtonHero").locator("video");
  await expect(video).toHaveAttribute("src", `http://127.0.0.1:4517/files/${SITE}/button-hero/original.webm`);
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted && v.loop && v.autoplay)).toBe(true);

  await page.getByRole("checkbox", { name: "three", exact: true }).check();
  await expect(card(page, "ThreeStage")).toBeVisible();
  await expect(card(page, "ButtonHero")).toHaveCount(0);
  await expect(card(page, "GsapScrub")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "three", exact: true }).uncheck();

  await page.getByRole("checkbox", { name: "ScrollTrigger", exact: true }).check();
  await expect(card(page, "GsapScrub")).toBeVisible();
  await expect(card(page, "ThreeStage")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "ScrollTrigger", exact: true }).uncheck();

  await page.getByRole("checkbox", { name: "Hover", exact: true }).check();
  await expect(card(page, "ButtonHero")).toBeVisible();
  await expect(card(page, "GsapScrub")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();

  // Free text searches NOTES.md.
  await page.getByRole("searchbox", { name: "Search" }).fill("saturated violet");
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(card(page, "ButtonHero")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search" }).fill("");

  await page.getByRole("combobox", { name: "Site" }).selectOption(SITE);
  await expect(card(page, "ThreeStage")).toBeVisible();
});

test("the detail page plays the original and the rebuild in sync, and shows Component.tsx as text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: LIBRARY });
  await page.goto(`${LIBRARY}/`);
  await card(page, "ButtonHero").locator(".card-link").click();
  await expect(page).toHaveURL(`${LIBRARY}/#/c/${SITE}/button-hero`);
  await expect(page.getByRole("heading", { level: 1, name: "ButtonHero" })).toBeVisible();

  const times = () =>
    page.evaluate(() =>
      ["original", "rebuild"].map((id) => {
        const v = document.querySelector<HTMLVideoElement>(`[data-testid=video-${id}]`);
        return { time: v?.currentTime ?? -1, paused: v?.paused ?? true, ready: v?.readyState ?? 0 };
      }),
    );
  await expect.poll(async () => (await times()).every((v) => v.ready >= 1)).toBe(true);

  await page.getByRole("button", { name: "Play both videos" }).click();
  await page.waitForTimeout(1500);
  const [original, rebuild] = await times();
  expect(original?.paused).toBe(false);
  expect(rebuild?.paused).toBe(false);
  expect(original?.time ?? 0).toBeGreaterThan(1);
  expect(Math.abs((original?.time ?? 0) - (rebuild?.time ?? 0))).toBeLessThan(0.15);

  // Seeking the shared scrubber moves both.
  await page.getByLabel("Position in both videos").fill("5");
  await expect.poll(async () => (await times()).map((v) => Math.round(v.time))).toEqual([5, 5]);

  await page.getByRole("button", { name: "Pause both videos" }).click();
  await expect.poll(async () => (await times()).every((v) => v.paused)).toBe(true);
  const [o, r] = await times();
  expect(Math.abs((o?.time ?? 0) - (r?.time ?? 0))).toBeLessThan(0.1);

  // States with scores, the timeline, tokens, the tree and the taste note.
  await expect(page.locator(".shot")).toHaveCount(8);
  await expect(page.locator(".shot", { hasText: "Mobile" }).locator(".score")).toHaveText("18.4% over");
  await expect(page.locator(".timeline .tl-row")).toHaveCount(10);
  await expect(page.locator(".tl-row svg.curve")).toHaveCount(10);
  await expect(page.locator(".token", { hasText: "--radius-3" })).toContainText("999px");
  await expect(page.locator(".tree")).toContainText("Cta");
  await expect(page.locator(".prose")).toContainText("saturated violet");

  // Component.tsx is highlighted text: its source shows, its button does not render.
  const source = await readFile(path.join(REPO_ROOT, "examples", SITE, "button-hero", "Component.tsx"), "utf8");
  await expect(page.locator("pre.code")).toContainText("export default function");
  expect(await page.locator("pre.code").textContent()).toBe(source);
  await expect(page.locator("main button", { hasText: "Start now" })).toHaveCount(0);
  await page.getByRole("button", { name: "Copy Component.tsx" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);

  // The rebuild panel copies the hand-off instruction in handoff mode.
  await expect(page.locator(".panel .mode")).toHaveText("Hand-off mode");
  await expect(page.locator(".handoff")).toContainText(`pnpm kinetic preview ${SITE}/button-hero`);
});

test("from the library origin, the browser may read but not write captures", async ({ page }) => {
  await page.goto(`${LIBRARY}/`);
  const results = await page.evaluate(async () => {
    const attempt = async (url: string, init?: RequestInit) => {
      try {
        return (await fetch(url, init)).status;
      } catch {
        return "blocked";
      }
    };
    const json = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    return {
      list: await attempt("http://127.0.0.1:4517/captures"),
      capture: await attempt("http://127.0.0.1:4517/capture", json),
      file: await attempt("http://127.0.0.1:4517/capture/file", json),
      record: await attempt("http://127.0.0.1:4517/captures/127.0.0.1/button-hero/record", json),
      missingPreview: await attempt("http://127.0.0.1:4517/captures/127.0.0.1/no-such-capture/preview", json),
    };
  });
  expect(results).toEqual({ list: 200, capture: "blocked", file: "blocked", record: "blocked", missingPreview: 404 });
});

test("works at 390px with the keyboard, and does not autoplay with reduced motion", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${LIBRARY}/`);
  await expect(card(page, "ButtonHero")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const video = card(page, "ButtonHero").locator("video");
  expect(await video.evaluate((v: HTMLVideoElement) => ({ autoplay: v.autoplay, paused: v.paused }))).toEqual({ autoplay: false, paused: true });

  // Tab to the first card and open it with Enter; focus is visible on the way.
  const first = page.locator(".card-link").first();
  for (let i = 0; i < 40 && !(await first.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/c\//);
  await expect(page.locator("h1")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await context.close();
});

test("every example's detail page renders without errors, including scroll-linked and 3D motion", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  for (const slug of EXAMPLES) {
    await page.goto(`${LIBRARY}/#/c/${SITE}/${slug}`);
    await expect(page.locator("pre.code")).toContainText("export default");
    await expect(page.locator(".tl-row").first()).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Scroll-linked" })).toBeVisible();
  await expect(page.locator(".tl-row", { hasText: "rotation.y" })).toContainText("7.85 s × ∞");
  expect(errors).toEqual([]);
});
