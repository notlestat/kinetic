// Replays a capture in Playwright Chromium: opens the same URL at the same viewport,
// finds the component again, and runs one script while recording the viewport:
//
//   idle 1.5 s → each hover target → each focus target → a scroll pass → back to rest
//
// Frames are sampled during idle, hover and focus, and every node is sampled at each
// scroll step. The raw recording is then cropped to the component (video.ts) and the
// samples become motion entries (sampling.ts).

import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Capture, Recording, RecordingStep } from "@kinetic/schema";
import { type Browser, type BrowserContext, chromium, type ElementHandle, type Page } from "playwright";
// The extension's own selector function, so recorded targets match the capture's selectors.
import { uniqueSelector } from "../../extension/src/selector.ts";
import * as scripts from "./page-scripts.ts";
import { analyseSamples, type FrameWindow, type NodeValues, type SampledDraft, type ScrollSamples } from "./sampling.ts";
import { cropVideo, planCrop, type TrackPoint, videoInfo } from "./video.ts";

const IDLE_MS = 1500;
const HOVER_MS = 900;
const LEAVE_MS = 700;
const FOCUS_MS = 900;
const BLUR_MS = 500;
const SETTLE_MS = 600;
const SCROLL_SETTLE_MS = 60;
const MAX_NODES = 300;
export const MAX_TARGETS = 6;
const CROP_PADDING = 24;
const NAVIGATION_TIMEOUT_MS = 45_000;
const RECORD_TIMEOUT_MS = 240_000;

/** The URL to open, after checking that it is http or https. Anything else (file:, chrome:, data:) is refused. */
export function assertHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https pages can be recorded, not ${url.protocol}`);
  return url.href;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** What the fallback search matches on: the root's tag, its text and its document box from the capture. */
export function locateReference(capture: Capture): { tag: string; text: string; box: { x: number; y: number; width: number; height: number } | null } {
  const html = capture.dom?.html ?? "";
  const tag = /^\s*<([a-z][a-z0-9-]*)/i.exec(html)?.[1]?.toLowerCase() ?? "";
  const text = decodeEntities(html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const nodes = capture.styles?.nodes ?? [];
  const box = (nodes.find((n) => n.selector === capture.meta.selector) ?? nodes[0])?.box ?? null;
  return { tag, text, box };
}

async function locate(page: Page, capture: Capture): Promise<{ root: ElementHandle<Element>; locatedBy: Recording["locatedBy"] }> {
  try {
    const locator = page.locator(`css=${capture.meta.selector}`);
    if ((await locator.count()) === 1) {
      const handle = await locator.elementHandle();
      if (handle) return { root: handle, locatedBy: "selector" };
    }
  } catch {
    // An invalid selector falls through to the text and box search.
  }
  const handle = await page.evaluateHandle(scripts.findByTextAndBox, locateReference(capture));
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new Error(`could not find the component: "${capture.meta.selector}" does not match exactly one element, and no element matches its text and box`);
  }
  return { root: element as ElementHandle<Element>, locatedBy: "text-and-box" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function nodeValues([transform, opacity, width, height]: scripts.NodeRow): NodeValues {
  return { transform, opacity, width, height };
}

function scrollValues([transform, opacity, width, height, clipPath, x, y, w, h]: scripts.ScrollRow): NodeValues {
  return { transform, opacity, width, height, clipPath, box: { x, y, width: w, height: h } };
}

/** A pointer position away from the component, so idle frames show it un-hovered. */
function neutralPoint(rect: { x: number; y: number; width: number; height: number }, width: number, height: number): { x: number; y: number } {
  const corners = [
    { x: width - 2, y: height - 2 },
    { x: 2, y: height - 2 },
    { x: width - 2, y: 2 },
    { x: 2, y: 2 },
  ];
  const outside = (p: { x: number; y: number }) => p.x < rect.x - 4 || p.x > rect.x + rect.width + 4 || p.y < rect.y - 4 || p.y > rect.y + rect.height + 4;
  return corners.find(outside) ?? (corners[0] as { x: number; y: number });
}

export interface RecordResult {
  /** Scroll and frame-sampled entries, to merge into motion.json. */
  drafts: SampledDraft[];
  recording: Recording;
}

export interface RecordOptions {
  capture: Capture;
  /** Absolute path of the capture folder; original.webm is written here. */
  dir: string;
}

/** Hover and focus targets, as indices into the recorder's node list. */
export interface ScriptTargets {
  hover: number[];
  focus: number[];
}

export interface ScriptRun {
  steps: RecordingStep[];
  track: TrackPoint[];
  windows: FrameWindow[];
  scroll?: ScrollSamples;
  scrollRange?: { start: number; end: number };
  warnings: string[];
  /** ms since the video started when the idle step began; the video is trimmed from just before it. */
  idleStart: number;
  /** ms since the video started when the script finished. */
  end: number;
}

export interface ScriptOptions {
  /** Date.now() when the page (and so its video) was created. */
  videoStart: number;
  /** Picks the elements to hover and focus once the recorder knows the component's nodes. */
  chooseTargets(page: Page, nodes: { selectors: string[]; paths: number[][] }): Promise<ScriptTargets>;
}

/**
 * The recording script, shared by the original's recording and the rebuild's preview:
 * rest position, idle, each hover target, each focus target, a scroll pass, back to rest.
 */
export async function playScript(page: Page, root: ElementHandle<Element>, { videoStart, chooseTargets }: ScriptOptions): Promise<ScriptRun> {
  const now = () => Date.now() - videoStart;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const steps: RecordingStep[] = [];
  const track: TrackPoint[] = [];
  const windows: FrameWindow[] = [];
  const warnings: string[] = [];
  const markRoot = async () => {
    track.push({ t: now(), box: await page.evaluate(scripts.rootRect) });
  };

  const { selectors, paths } = await root.evaluate(scripts.initRecorder, MAX_NODES);
  const toWindow = (kind: FrameWindow["kind"], frames: scripts.FramesResult, target?: string): FrameWindow => ({
    kind,
    ...(target ? { target } : {}),
    times: frames.times,
    nodes: frames.nodes.map((n) => ({ selector: selectors[n.index] ?? `node-${n.index}`, samples: n.rows.map(nodeValues) })),
  });

  // Rest position: the component centred in the viewport (or its top at the top when it is taller).
  const geo = await page.evaluate(scripts.geometry);
  const restY = clamp(geo.docTop - Math.max(0, (geo.viewportHeight - geo.height) / 2), 0, geo.maxScroll);
  await page.evaluate(scripts.scrollToY, restY);
  const neutral = neutralPoint(await page.evaluate(scripts.rootRect), geo.viewportWidth, geo.viewportHeight);
  await page.mouse.move(neutral.x, neutral.y);
  await sleep(SETTLE_MS);

  // Idle.
  await markRoot();
  const idleStart = now();
  await page.evaluate(scripts.startFrames);
  await sleep(IDLE_MS);
  windows.push(toWindow("idle", await page.evaluate(scripts.stopFrames)));
  steps.push({ kind: "idle", start: idleStart, end: now() });
  await markRoot();

  // Hover and focus each target. One mousemove straight to the target, so nothing on the way is hovered.
  const targets = await chooseTargets(page, { selectors, paths });
  const stepTarget = (index: number) => ({ ...(selectors[index] ? { target: selectors[index] } : {}), ...(paths[index] ? { path: paths[index] } : {}) });
  for (const index of targets.hover) {
    const point = await page.evaluate(scripts.nodeCenter, index);
    if (!point) continue;
    await markRoot();
    const start = now();
    await page.evaluate(scripts.startFrames);
    await page.mouse.move(point.x, point.y);
    await sleep(HOVER_MS);
    windows.push(toWindow("hover", await page.evaluate(scripts.stopFrames), selectors[index]));
    await page.mouse.move(neutral.x, neutral.y);
    await sleep(LEAVE_MS);
    await markRoot();
    steps.push({ kind: "hover", ...stepTarget(index), start, end: now() });
  }
  for (const index of targets.focus) {
    await markRoot();
    const start = now();
    await page.evaluate(scripts.startFrames);
    const focused = await page.evaluate(scripts.focusNode, index);
    await sleep(FOCUS_MS);
    const frames = await page.evaluate(scripts.stopFrames);
    await page.evaluate(scripts.blurActive);
    await sleep(BLUR_MS);
    await markRoot();
    if (!focused) continue;
    windows.push(toWindow("focus", frames, selectors[index]));
    steps.push({ kind: "focus", ...stepTarget(index), start, end: now() });
  }

  // Scroll pass: from the component's top entering at the bottom of the viewport to its bottom leaving at the top.
  let scroll: ScrollSamples | undefined;
  let scrollRange: ScriptRun["scrollRange"];
  const g = await page.evaluate(scripts.geometry);
  const from = clamp(g.docTop - g.viewportHeight, 0, g.maxScroll);
  const to = clamp(g.docBottom, 0, g.maxScroll);
  if (to - from >= 1) {
    const count = clamp(Math.ceil((to - from) / (g.viewportHeight / 12)), 12, 48);
    const start = now();
    const scrollY: number[] = [];
    const rows: scripts.ScrollRow[][] = [];
    let rect = await page.evaluate(scripts.rootRect);
    for (let i = 0; i <= count; i++) {
      // Two track points per step, so the crop jumps with the page instead of gliding behind it.
      track.push({ t: now(), box: rect });
      const actual = await page.evaluate(scripts.scrollToY, from + ((to - from) * i) / count);
      const moved = now();
      await sleep(SCROLL_SETTLE_MS);
      const sample = await page.evaluate(scripts.readScroll);
      rect = sample.rect;
      track.push({ t: moved, box: rect });
      scrollY.push(actual);
      rows.push(sample.rows);
    }
    await page.evaluate(scripts.scrollToY, restY);
    track.push({ t: now(), box: rect });
    await sleep(SETTLE_MS);
    await markRoot();
    steps.push({ kind: "scroll", start, end: now() });
    scroll = { scrollY, nodes: selectors.map((selector, n) => ({ selector, samples: rows.map((r) => scrollValues(r[n] as scripts.ScrollRow)) })) };
    scrollRange = { start: Math.round(from), end: Math.round(to) };
  } else {
    warnings.push("The page does not scroll far enough around the component, so there was no scroll pass.");
  }

  return { steps, track, windows, ...(scroll ? { scroll } : {}), ...(scrollRange ? { scrollRange } : {}), warnings, idleStart, end: now() };
}

export interface SavedVideo {
  width: number;
  height: number;
  durationMs: number;
  /** Steps with times relative to the start of the saved video. */
  steps: RecordingStep[];
}

/**
 * Closes the context (which finishes Playwright's video), then crops the raw viewport
 * recording to the component and trims it to the script. Writes through a .part file.
 */
export async function saveCroppedVideo(page: Page, context: BrowserContext, run: ScriptRun, viewport: { width: number; height: number }, output: string): Promise<SavedVideo> {
  const video = page.video();
  await context.close();
  const raw = await video?.path();
  if (!raw) throw new Error("Playwright did not produce a video");

  // Playwright may scale frames to fit its size limit, so map CSS pixels onto the raw video.
  const rawInfo = await videoInfo(raw);
  const sx = rawInfo.width / viewport.width;
  const sy = rawInfo.height / viewport.height;
  const scaled = run.track.map((p) => ({ t: p.t, box: { x: p.box.x * sx, y: p.box.y * sy, width: p.box.width * sx, height: p.box.height * sy } }));
  const plan = planCrop(scaled, rawInfo, CROP_PADDING * Math.min(sx, sy));
  const trimStart = Math.max(0, run.idleStart - 200);
  const trimEnd = (run.steps.at(-1)?.end ?? run.end) + 300;
  const partial = `${output}.${process.pid}.${Date.now()}.part`;
  try {
    await cropVideo({ input: raw, output: partial, plan, startMs: trimStart, endMs: trimEnd });
    await rename(partial, output);
  } finally {
    await rm(partial, { force: true });
  }
  const info = await videoInfo(output);
  return {
    width: info.width,
    height: info.height,
    durationMs: info.durationMs ?? trimEnd - trimStart,
    steps: run.steps.map((s) => ({ ...s, start: Math.max(0, s.start - trimStart), end: Math.max(0, s.end - trimStart) })),
  };
}

/** Launches headless Chromium, with an install hint when Playwright's browser is missing. */
export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`could not start Playwright Chromium (${reason}). Run: pnpm --filter @kinetic/companion exec playwright install chromium`);
  }
}

/** Runs `fn` with a browser that is closed afterwards, or as soon as `timeoutMs` passes. */
export async function withBrowser<T>(timeoutMs: number, what: string, fn: (browser: Browser, tmp: string) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(path.join(tmpdir(), "kinetic-record-"));
  let browser: Browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void browser.close();
  }, timeoutMs);
  try {
    return await fn(browser, tmp);
  } catch (error) {
    if (timedOut) throw new Error(`${what} took longer than ${timeoutMs / 1000} s and was stopped`);
    throw error;
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function recordCapture({ capture, dir }: RecordOptions): Promise<RecordResult> {
  const url = assertHttpUrl(capture.meta.url);
  const { width, height, deviceScaleFactor } = capture.meta.viewport;
  return withBrowser(RECORD_TIMEOUT_MS, "recording", async (browser, tmp) => {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor,
      recordVideo: { dir: tmp, size: { width, height } },
      reducedMotion: "no-preference",
      acceptDownloads: false,
    });
    await context.addInitScript({ content: scripts.NAME_SHIM });
    const page = await context.newPage();
    const videoStart = Date.now();

    await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(`window.__kineticUniqueSelector = ${uniqueSelector.toString()};`);

    const { root, locatedBy } = await locate(page, capture);
    const states = (capture.states ?? []).filter((s) => s.name === "hover" || s.name === "focus").map((s) => ({ name: s.name, selector: s.target }));
    const run = await playScript(page, root, {
      videoStart,
      chooseTargets: (p) => p.evaluate(scripts.listTargets, { states, max: MAX_TARGETS }),
    });
    if (locatedBy === "text-and-box") run.warnings.unshift(`"${capture.meta.selector}" did not match one element, so the component was found by its text and box.`);

    const saved = await saveCroppedVideo(page, context, run, { width, height }, path.join(dir, "original.webm"));
    const recording: Recording = {
      file: "original.webm",
      durationMs: saved.durationMs,
      size: { width: saved.width, height: saved.height },
      locatedBy,
      ...(run.scrollRange ? { scrollRange: run.scrollRange } : {}),
      steps: saved.steps,
      recordedAt: new Date().toISOString(),
      ...(run.warnings.length > 0 ? { warnings: run.warnings } : {}),
    };
    const drafts = analyseSamples({ windows: run.windows, ...(run.scroll ? { scroll: run.scroll } : {}), existing: capture.motion?.entries ?? [] });
    return { drafts, recording };
  });
}
