import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  captureDirFor,
  captureOnly,
  captureSelector,
  expect,
  fileExists,
  kineticCall,
  openTestPage,
  pngSize,
  readCaptureJson,
  test,
} from "./fixtures.ts";

const SITE = "127.0.0.1";

test("captures the button with styles, tokens, fonts, states and screenshots", async ({ page }) => {
  await openTestPage(page, "button.html");
  const outcome = await captureSelector(page, "button.cta", "cta-button");
  expect(outcome).toMatchObject({ ok: true, copied: true, truncated: false });

  const dir = captureDirFor(SITE, "cta-button");
  const capture = await readCaptureJson(SITE, "cta-button");
  expect(capture.meta.url).toBe("http://127.0.0.1:5180/button.html");
  expect(capture.meta.selector).toBe("html > body > main > section.hero > button.cta");

  // DOM: inline handlers and tracking attributes are gone, classes and aria stay.
  const dom = await readFile(path.join(dir, "dom.html"), "utf8");
  expect(dom).toContain('class="cta"');
  expect(dom).toContain('aria-hidden="true"');
  expect(dom).not.toContain("onclick");
  expect(dom).not.toContain("data-analytics-id");

  // Styles: only non-default properties, with the token names where values repeat.
  const styles = capture.styles;
  expect(styles).toBeDefined();
  const button = styles?.nodes.find((n) => n.tag === "button");
  expect(button?.box.width).toBeGreaterThan(100);
  expect(button?.styles["background-color"]).toBe("rgb(99, 91, 255)");
  expect(button?.styles["border-top-left-radius"]).toBe("radius-1");
  expect(button?.styles["transition-duration"]).toBe("0.15s, 0.15s, 0.2s");
  // inline-flex computes to flex inside the grid parent.
  expect(button?.styles.display).toBe("flex");
  // currentcolor-derived colours that just follow the text colour are dropped.
  expect(button?.styles).not.toHaveProperty("border-top-color");
  expect(button?.styles).not.toHaveProperty("position");
  expect(styles?.tokens?.radii).toEqual({ "radius-1": "999px" });
  // Fonts: Inter 600 with the @font-face source served by the test pages.
  const inter = styles?.fonts?.find((f) => f.family === "Inter" && f.weight === "600");
  expect(inter?.src).toMatch(/^http:\/\/127\.0\.0\.1:5180\/assets\/inter-latin-600-normal-.*\.woff2$/);

  // States: hover and focus each record only the changes, with a screenshot.
  const hover = capture.states?.find((s) => s.name === "hover");
  expect(hover?.target).toBe("html > body > main > section.hero > button.cta");
  expect(hover?.changes["html > body > main > section.hero > button.cta"]).toMatchObject({
    "background-color": "rgb(10, 37, 64)",
    transform: "matrix(1, 0, 0, 1, 0, -2)",
  });
  expect(Object.keys(hover?.changes ?? {})).toContain("html > body > main > section.hero > button.cta > span.arrow");
  const focus = capture.states?.find((s) => s.name === "focus");
  expect(focus?.changes["html > body > main > section.hero > button.cta"]).toMatchObject({ "outline-style": "solid" });
  expect(capture.states?.find((s) => s.name === "mobile")).toBeDefined();

  for (const state of capture.states ?? []) {
    expect(state.screenshot, `${state.name} screenshot`).toBeDefined();
    expect(await fileExists(path.join(dir, state.screenshot ?? ""))).toBe(true);
  }
  expect(capture.media?.screenshot).toBe("states/default.png");
  // Screenshots are the box plus 8px on every side, so focus rings and shadows stay in frame.
  const shot = await pngSize(path.join(dir, "states/default.png"));
  expect(Math.abs(shot.width - (button?.box.width ?? 0) - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(shot.height - (button?.box.height ?? 0) - 16)).toBeLessThanOrEqual(1);
  // The mobile state is a 390px viewport where the button fills the width.
  const mobile = await pngSize(path.join(dir, "states/mobile.png"));
  expect(mobile.width).toBeGreaterThan(shot.width * 2);
});

test("captures the nav bar with absolute URLs, link tokens and per-link hover states", async ({ page }) => {
  await openTestPage(page, "nav.html");
  const outcome = await captureSelector(page, "nav.site-nav", "site-nav");
  expect(outcome.ok).toBe(true);

  const dir = captureDirFor(SITE, "site-nav");
  const capture = await readCaptureJson(SITE, "site-nav");
  const dom = await readFile(path.join(dir, "dom.html"), "utf8");
  expect(dom).not.toContain("<script");
  expect(dom).not.toContain("data-track-click");
  expect(dom).toContain('src="http://127.0.0.1:5180/logo.svg"');
  expect(dom).toContain('href="http://127.0.0.1:5180/pricing"');

  const tokens = capture.styles?.tokens;
  const linkColor = Object.entries(tokens?.colors ?? {}).find(([, v]) => v === "rgb(66, 84, 102)")?.[0];
  expect(linkColor).toBeDefined();
  const links = capture.styles?.nodes.filter((n) => n.selector.includes("ul.links") && n.tag === "a") ?? [];
  expect(links).toHaveLength(3);
  for (const link of links) expect(link.styles.color).toBe(linkColor);
  expect(Object.values(tokens?.spacing ?? {})).toEqual(expect.arrayContaining(["8px", "12px"]));

  // The three links and the sign-in button change on hover. The brand link has no hover styles, so no hover state.
  const hoverTargets = capture.states?.filter((s) => s.name === "hover").map((s) => s.target) ?? [];
  expect(hoverTargets).toHaveLength(4);
  const pricingHover = capture.states?.find((s) => s.name === "hover" && s.target.includes("li:nth-of-type(2)"));
  const changed = Object.values(pricingHover?.changes ?? {})[0];
  expect(changed).toMatchObject({ color: "rgb(10, 37, 64)", "background-color": "rgb(246, 249, 252)" });
});

test("picker highlights, walks the tree with the arrow keys, copies on click and exits on Esc", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5180" });
  await openTestPage(page, "button.html");
  const label = page.locator("kinetic-picker .label");

  await kineticCall(page, "test:picker");
  const button = await page.locator("button.cta").boundingBox();
  if (!button) throw new Error("button is not visible");
  await page.mouse.move(button.x + 10, button.y + 10);
  await expect(label).toHaveText(/^button\s+\d+×\d+/);

  await page.keyboard.press("ArrowUp");
  await expect(label).toHaveText(/^section\s+/);
  await page.keyboard.press("ArrowDown");
  await expect(label).toHaveText(/^p\s+/);
  await page.keyboard.press("ArrowUp");

  // Clicking captures the selection instead of reaching the page.
  await page.evaluate(() => {
    (window as { sectionClicks?: number }).sectionClicks = 0;
    document.querySelector("section.hero")?.addEventListener("click", () => {
      (window as unknown as { sectionClicks: number }).sectionClicks += 1;
    });
  });
  await page.mouse.click(button.x - 20 > 0 ? button.x + 4 : button.x + 4, button.y - 8);
  await expect(label).toContainText("Copied. Paste it into Claude Code.", { timeout: 60_000 });
  expect(await page.evaluate(() => (window as { sectionClicks?: number }).sectionClicks)).toBe(0);

  // The prompt is on the system clipboard, ready to paste.
  await page.bringToFront();
  const pasted = await page.evaluate(() => navigator.clipboard.readText());
  expect(pasted).toMatch(/^# Rebuild /);
  expect(pasted).toContain("Component root on that page: `");
  expect(pasted).toContain("section.hero");

  await page.keyboard.press("Escape");
  await expect(page.locator("kinetic-picker")).toHaveCount(0);
});

test("copies a self-contained prompt and never saves to the companion", async ({ page }) => {
  await openTestPage(page, "button.html");
  const outcome = await captureOnly(page, "button.cta", "clipboard-only");
  expect(outcome).toMatchObject({ ok: true, copied: true });
  if (!outcome.ok || !outcome.debug) throw new Error("no debug output from the test build");
  expect(outcome.chars).toBe(outcome.debug.prompt.length);

  const prompt = outcome.debug.prompt;
  for (const heading of ["## Task", "## Motion", "## States", "## Tokens", "## Markup", "## Computed styles"]) expect(prompt).toContain(heading);
  expect(prompt).toContain("Library: **Framer Motion**");
  expect(prompt).toMatch(/\| \d+ ms \|/);
  // Nothing points at files that only exist in a capture folder.
  expect(prompt).not.toMatch(/\]\([^)]*\.(json|png|webm|html)\)/);

  // The extension never posted it anywhere.
  expect(await fileExists(path.join(captureDirFor(SITE, "clipboard-only"), "capture.json"))).toBe(false);
});

test("the toolbar button flags a page Kinetic can't run on, and opens the picker on a normal page", async ({ context, page }) => {
  const [worker] = context.serviceWorkers();
  if (!worker) throw new Error("no service worker");
  // Presses the toolbar button for the active tab and reads back its badge and tooltip.
  const press = () =>
    worker.evaluate(async () => {
      type TabArgs = { tabId: number };
      const { chrome } = globalThis as unknown as {
        chrome: {
          tabs: { query(query: { active: boolean }): Promise<{ id?: number }[]> };
          action: { getBadgeText(args: TabArgs): Promise<string>; getTitle(args: TabArgs): Promise<string> };
        };
      };
      const [tab] = await chrome.tabs.query({ active: true });
      const tabId = tab?.id as number;
      await (globalThis as { kineticTogglePicker?: (id?: number) => Promise<void> }).kineticTogglePicker?.(tabId);
      return { badge: await chrome.action.getBadgeText({ tabId }), title: await chrome.action.getTitle({ tabId }) };
    });

  // Chrome keeps scripts out of about:blank, like its own pages, so the picker cannot open there.
  await page.goto("about:blank");
  expect(await press()).toEqual({ badge: "!", title: expect.stringContaining("Kinetic can't run on this page") });

  await openTestPage(page, "button.html");
  expect(await press()).toEqual({ badge: "", title: "Kinetic: pick a component (Alt+Shift+K)" });
  await expect(page.locator("kinetic-picker")).toHaveCount(1);
});
