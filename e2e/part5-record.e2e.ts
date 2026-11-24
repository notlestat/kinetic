import type { Bezier, Capture, MotionEntry } from "@kinetic/schema";
import { curveDistance, familyOf } from "../apps/companion/src/sampling.ts";
import { videoInfo } from "../apps/companion/src/video.ts";
import { captureDirFor, captureSelector, expect, fileExists, openTestPage, readCaptureJson, test } from "./fixtures.ts";
import path from "node:path";

const SITE = "127.0.0.1";
const COMPANION = "http://127.0.0.1:4517";

/** Starts a recording through the companion and waits until its job finishes. */
async function record(slug: string) {
  const res = await fetch(`${COMPANION}/captures/${SITE}/${slug}/record`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status).toBe(202);
  await expect
    .poll(async () => (await readCaptureJson(SITE, slug)).job?.status, { timeout: 150_000, intervals: [1000] })
    .toMatch(/^(done|failed)$/);
  const capture = await readCaptureJson(SITE, slug);
  expect(capture.job?.error).toBeUndefined();
  expect(capture.job?.status).toBe("done");
  return capture;
}

/** No sampled entry may repeat motion an existing entry already describes for the same node. */
function expectNoDuplicates(entries: readonly MotionEntry[]) {
  const others = entries.filter((e) => e.source !== "sampled");
  for (const sampled of entries.filter((e) => e.source === "sampled")) {
    const families = new Set(sampled.properties.map((p) => familyOf(p.name)));
    const sameScope = (e: MotionEntry) => (sampled.trigger === "scroll" ? e.trigger === "scroll" || e.source === "scrolltrigger" : true);
    const overlap = others.filter(
      (e) => sameScope(e) && e.target.split(", ").includes(sampled.target) && e.properties.some((p) => families.has(familyOf(p.name))),
    );
    expect(overlap, `${sampled.id} repeats ${overlap.map((e) => e.id).join(", ")}`).toEqual([]);
  }
}

/**
 * The video is cropped to the component's box plus 24 px padding, kept even and never
 * bigger than the viewport. A full-bleed section is as wide as the viewport, so its
 * crop can only be the full width.
 */
async function expectCroppedVideo(slug: string, capture: Capture) {
  const file = path.join(captureDirFor(SITE, slug), "original.webm");
  expect(await fileExists(file)).toBe(true);
  const info = await videoInfo(file);
  const box = capture.styles?.nodes.find((n) => n.selector === capture.meta.selector)?.box;
  if (!box) throw new Error("the capture has no box for its root");
  const even = (n: number) => Math.floor(n / 2) * 2;
  const { width, height } = capture.meta.viewport;
  expect(info.width).toBe(Math.min(even(width), even(Math.ceil(box.width + 48))));
  expect(info.height).toBe(Math.min(even(height), even(Math.ceil(box.height + 48))));
  expect(info.width % 2).toBe(0);
  expect(info.height % 2).toBe(0);
  expect(info.durationMs ?? 0).toBeGreaterThan(1500);
  return info;
}

test("records the button page: cropped video, hover and focus steps, and frame-sampled JS motion", async ({ page }) => {
  await openTestPage(page, "button.html");
  expect(await captureSelector(page, "section.hero", "hero-record")).toMatchObject({ ok: true });
  const before = await readCaptureJson(SITE, "hero-record");
  expect(before.job).toBeUndefined(); // KINETIC_AUTO_RECORD=0 in e2e

  const capture = await record("hero-record");
  const info = await expectCroppedVideo("hero-record", capture);
  // The hero is narrower than the viewport, so its video really is cut down.
  expect(info.width).toBeLessThan(capture.meta.viewport.width);
  expect(info.height).toBeLessThan(capture.meta.viewport.height);
  expect(capture.recording).toMatchObject({ file: "original.webm", locatedBy: "selector", size: { width: info.width, height: info.height } });
  expect(capture.media?.original).toBe("original.webm");

  const steps = capture.recording?.steps ?? [];
  expect(steps[0]).toMatchObject({ kind: "idle" });
  expect((steps[0]?.end ?? 0) - (steps[0]?.start ?? 0)).toBeGreaterThanOrEqual(1500);
  const chip = "html > body > main > section.hero > a.chip";
  const cta = "html > body > main > section.hero > button.cta";
  expect(steps.filter((s) => s.kind === "hover").map((s) => s.target)).toEqual(expect.arrayContaining([chip, cta]));
  expect(steps.filter((s) => s.kind === "focus").map((s) => s.target)).toEqual(expect.arrayContaining([chip, cta]));
  expect(steps.find((s) => s.target === chip)?.path).toEqual([2]);

  const entries = capture.motion?.entries ?? [];
  const sampled = entries.filter((e) => e.source === "sampled");
  // The chip's rAF lift: about 300 ms, ending 4 px up, on a curve close to power2.out.
  const lift = sampled.find((e) => e.target === chip && e.trigger === "hover");
  expect(lift).toMatchObject({ confidence: "approximate", iterations: 1, properties: [{ name: "y", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: -4 }] }] });
  expect(Math.abs((lift?.duration ?? 0) - 300)).toBeLessThanOrEqual(60);
  expect(Array.isArray(lift?.easing)).toBe(true);
  expect(curveDistance(lift?.easing as Bezier, [0.215, 0.61, 0.355, 1])).toBeLessThan(0.1);
  // The dot's pulse: an endless loop of about 1200 ms on opacity.
  const pulse = sampled.find((e) => e.target === `${chip} > span.dot`);
  expect(pulse).toMatchObject({ trigger: "loop", iterations: "infinite", confidence: "approximate" });
  expect(pulse?.properties.map((p) => p.name)).toEqual(["opacity"]);
  expect(Math.abs((pulse?.duration ?? 0) - 1200)).toBeLessThan(150);
  // The button's own CSS transitions are already entries, so nothing sampled repeats them.
  expectNoDuplicates(entries);
  expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  expect(capture.motion?.summary?.bySource.sampled).toBe(sampled.length);
});

test("records the ScrollTrigger page: scroll-sampled parallax without repeating the ScrollTrigger", async ({ page }) => {
  await openTestPage(page, "gsap.html");
  expect(await captureSelector(page, "section.scrub-section", "scrub-record")).toMatchObject({ ok: true });
  const capture = await record("scrub-record");
  await expectCroppedVideo("scrub-record", capture);
  expect(capture.recording?.steps.map((s) => s.kind)).toContain("scroll");
  expect(capture.recording?.scrollRange?.end).toBeGreaterThan(capture.recording?.scrollRange?.start ?? 0);

  const entries = capture.motion?.entries ?? [];
  const orb = entries.find((e) => e.source === "sampled" && e.target.includes("> div.parallax-orb"));
  expect(orb).toMatchObject({ trigger: "scroll", confidence: "near", scroll: { scrub: true, pin: false } });
  const y = orb?.properties.find((p) => p.name === "y")?.keyframes ?? [];
  expect(Number(y[0]?.value)).toBeGreaterThan(Number(y.at(-1)?.value));
  expect(Number(y.at(-1)?.value)).toBeLessThan(-40);
  expect(typeof orb?.scroll?.start).toBe("number");

  // The scrub box keeps its single ScrollTrigger entry and gets no sampled copy.
  expect(entries.filter((e) => e.source === "scrolltrigger" && e.target.includes("> div.scrub-box"))).toHaveLength(1);
  expect(entries.filter((e) => e.source === "sampled" && e.target.includes("> div.scrub-box"))).toEqual([]);
  expectNoDuplicates(entries);
});

test("lists recorded captures and serves their video with byte ranges", async () => {
  const list = (await (await fetch(`${COMPANION}/captures`)).json()) as { captures: { slug: string; job?: { status: string }; media: Record<string, string> }[] };
  const hero = list.captures.find((c) => c.slug === "hero-record");
  expect(hero?.job?.status).toBe("done");
  expect(hero?.media.original).toBe(`${COMPANION}/files/${SITE}/hero-record/original.webm`);
  const res = await fetch(hero?.media.original ?? "", { headers: { range: "bytes=0-3" } });
  expect(res.status).toBe(206);
  expect(res.headers.get("content-type")).toBe("video/webm");
  // WebM files start with the EBML magic number.
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
});
