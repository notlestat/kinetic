import type { MotionEntry } from "@kinetic/schema";
import { captureOnly, captureSelector, expect, kineticCall, openTestPage, readCaptureJson, saveWorkerCapture, test } from "./fixtures.ts";

const SITE = "127.0.0.1";

function find(entries: readonly MotionEntry[], match: Partial<MotionEntry> & { targetIncludes?: string; property?: string }) {
  return entries.filter(
    (e) =>
      (match.source === undefined || e.source === match.source) &&
      (match.trigger === undefined || e.trigger === match.trigger) &&
      (match.targetIncludes === undefined || e.target.includes(match.targetIncludes)) &&
      (match.property === undefined || e.properties.some((p) => p.name === match.property)),
  );
}

test("captures CSS keyframes, CSS transitions and WAAPI motion with exact values", async ({ page }) => {
  await openTestPage(page, "keyframes.html");
  const outcome = await captureSelector(page, "section.panel", "keyframes-panel");
  expect(outcome).toMatchObject({ ok: true });
  const capture = await readCaptureJson(SITE, "keyframes-panel");
  const entries = capture.motion?.entries ?? [];

  // An endless CSS animation that was already running: read from document.getAnimations().
  const [pulse] = find(entries, { source: "css-keyframes", targetIncludes: "span.badge" });
  expect(pulse).toMatchObject({ trigger: "loop", duration: 1200, iterations: "infinite", easing: [0.42, 0, 0.58, 1], confidence: "exact" });
  expect(pulse?.properties.find((p) => p.name === "opacity")?.keyframes).toEqual([
    { offset: 0, value: "1" },
    { offset: 0.5, value: "0.6" },
    { offset: 1, value: "1" },
  ]);

  // A load animation that finished before the capture: only stylesheet parsing sees it.
  const [fade] = find(entries, { source: "css-keyframes", targetIncludes: "h2.fade-in" });
  expect(fade).toMatchObject({ trigger: "load", duration: 600, delay: 100, iterations: 1, easing: [0.2, 0, 0, 1] });
  expect(fade?.properties.map((p) => p.name).sort()).toEqual(["opacity", "transform"]);

  // An endless WAAPI animation started by a script.
  const [spin] = find(entries, { source: "waapi", targetIncludes: "div.spinner" });
  expect(spin).toMatchObject({ trigger: "loop", duration: 1000, iterations: "infinite", easing: "linear" });
  expect(spin?.properties[0]?.keyframes).toEqual([
    { offset: 0, value: "rotate(0deg)" },
    { offset: 1, value: "rotate(360deg)" },
  ]);

  // WAAPI started by mouseenter and focus handlers, caught by the Animation domain during the motion pass.
  const cardHover = find(entries, { source: "waapi", trigger: "hover", targetIncludes: "div.card" })[0];
  expect(cardHover).toMatchObject({ duration: 250, easing: [0.3, 0, 0, 1], confidence: "exact" });
  expect(cardHover?.properties[0]?.keyframes.at(-1)).toEqual({ offset: 1, value: "translateY(-6px)" });
  expect(find(entries, { source: "waapi", trigger: "focus", targetIncludes: "div.card" })).toHaveLength(1);

  // A CSS transition fired by real hover, with values from getKeyframes().
  const [goHover] = find(entries, { source: "css-transition", trigger: "hover", targetIncludes: "button.go" });
  expect(goHover).toMatchObject({ duration: 200, easing: [0.25, 0.1, 0.25, 1], confidence: "exact" });
  expect(goHover?.properties).toEqual([
    {
      name: "background-color",
      keyframes: [
        { offset: 0, value: "rgb(10, 37, 64)" },
        { offset: 1, value: "rgb(99, 91, 255)" },
      ],
    },
  ]);
  // Deduplicated: the stylesheet copy of the same transition is dropped.
  expect(find(entries, { source: "css-transition", trigger: "hover", targetIncludes: "button.go" })).toHaveLength(1);

  expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  expect(capture.motion?.summary).toMatchObject({ primary: "css", suggestedLibrary: "framer-motion" });
  expect(capture.motion?.summary?.triggers).toEqual(expect.arrayContaining(["focus", "hover", "load", "loop"]));
});

test("captures GSAP tweens, ScrollTriggers and Lenis options", async ({ page }) => {
  await openTestPage(page, "gsap.html");
  // The whole body, so every GSAP feature on the page is inside the selection.
  const outcome = await captureSelector(page, "body", "gsap-body");
  expect(outcome).toMatchObject({ ok: true });
  const capture = await readCaptureJson(SITE, "gsap-body");
  const motion = capture.motion;
  const entries = motion?.entries ?? [];

  const [marquee] = find(entries, { source: "gsap", targetIncludes: "div.marquee-track" });
  expect(marquee).toMatchObject({ trigger: "loop", duration: 8000, iterations: "infinite", easing: "linear", confidence: "exact" });
  expect(marquee?.properties).toEqual([{ name: "xPercent", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: -50 }] }]);

  // The hover tween only exists after mouseenter, so the motion pass finds it.
  const [hover] = find(entries, { source: "gsap", trigger: "hover", targetIncludes: "div.hover-card" });
  expect(hover).toMatchObject({ duration: 300, easing: [0.175, 0.885, 0.32, 1.275] });
  expect(hover?.raw).toMatchObject({ ease: "back.out(1.7)" });
  expect(hover?.properties[0]).toEqual({ name: "scale", keyframes: [{ offset: 0, value: 1 }, { offset: 1, value: 1.04 }] });

  const [scrub] = find(entries, { source: "scrolltrigger", targetIncludes: "div.scrub-box" });
  expect(scrub).toMatchObject({ trigger: "scroll", scroll: { start: "top 80%", end: "bottom 20%", scrub: 1, pin: false } });
  expect(scrub?.properties.map((p) => p.name).sort()).toEqual(["rotation", "x"]);
  expect(scrub?.properties.find((p) => p.name === "x")?.keyframes).toEqual([{ offset: 0, value: 0 }, { offset: 1, value: 300 }]);

  const pin = entries.find((e) => e.source === "scrolltrigger" && e.scroll?.pin);
  expect(pin).toMatchObject({ target: expect.stringContaining("section.pin-section"), scroll: { start: "top top", end: "+=600" } });

  const [title] = find(entries, { source: "scrolltrigger", targetIncludes: "h2.pin-title" });
  expect(title?.raw).toMatchObject({ ease: "power3.out", scrollTrigger: { toggleActions: "play none none reverse" } });
  expect(title?.easing).toEqual([0.165, 0.84, 0.44, 1]);

  expect(motion?.smoothScroll).toMatchObject({ library: "lenis", detectedBy: "global", options: { duration: 1.2, easing: "[function]", smoothWheel: true } });
  expect(motion?.summary).toMatchObject({ primary: "gsap", suggestedLibrary: "gsap" });
  expect(motion?.summary?.bySource.scrolltrigger).toBeGreaterThanOrEqual(3);
});

test("reloads to record GSAP load animations when the user opts in", async ({ context, page }) => {
  await openTestPage(page, "gsap.html");
  // The capture reloads the page, so this page never hears back. Take the result from the worker.
  void captureOnly(page, "section.hero", "gsap-hero-load", { reloadForLoadAnimations: true }).catch(() => undefined);
  await saveWorkerCapture(context, "gsap-hero-load");
  const capture = await readCaptureJson(SITE, "gsap-hero-load");
  const [hero] = find(capture.motion?.entries ?? [], { source: "gsap", targetIncludes: "div.hero-item" });
  expect(hero).toMatchObject({ trigger: "load", duration: 600, stagger: 100, easing: [0.215, 0.61, 0.355, 1] });
  expect(hero?.target.split(", ")).toHaveLength(3);
  expect(hero?.properties.find((p) => p.name === "y")?.keyframes).toEqual([{ offset: 0, value: 40 }, { offset: 1, value: 0 }]);
  expect(hero?.properties.find((p) => p.name === "opacity")?.keyframes).toEqual([{ offset: 0, value: 0 }, { offset: 1, value: 1 }]);
});

test("Shift+Enter in the picker opts into the reload for load animations", async ({ context, page }) => {
  await openTestPage(page, "gsap.html");
  await kineticCall(page, "test:picker");
  const item = await page.locator("div.hero-item").first().boundingBox();
  if (!item) throw new Error("hero item is not visible");
  await page.mouse.move(item.x + 10, item.y + 10);
  await expect(page.locator("kinetic-picker .label")).toContainText("Shift+click also records load animations");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("kinetic-picker .label")).toHaveText(/^section\s+/);
  // A reload clears this marker, so it shows the capture really reloaded the page.
  await page.evaluate(() => Object.assign(window, { kineticBeforeReload: true }));
  await page.keyboard.press("Shift+Enter");

  // The picker's slug ends in a timestamp, so match the prefix.
  const slug = await saveWorkerCapture(context, "section-hero-");
  const capture = await readCaptureJson(SITE, slug);
  const [hero] = find(capture.motion?.entries ?? [], { source: "gsap", targetIncludes: "div.hero-item" });
  expect(hero).toMatchObject({ trigger: "load", duration: 600, stagger: 100 });
  await expect.poll(() => page.evaluate(() => "kineticBeforeReload" in window).catch(() => true)).toBe(false);
});
