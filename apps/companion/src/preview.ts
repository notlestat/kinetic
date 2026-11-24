// The preview step: renders Component.tsx in the Vite sandbox, records
// Component.preview.webm with the same script as original.webm, screenshots each
// state the original has a screenshot for, and scores each pair with pixelmatch.
//
// Component.tsx is untrusted. It is built by the sandbox's own Vite (sandbox.ts) and
// runs only in a Playwright page that can reach nothing but the sandbox's static
// server: every other request and every WebSocket is refused.

import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Capture, Preview, PreviewScore, RecordingStep } from "@kinetic/schema";
import type { Browser, BrowserContext, CDPSession, ElementHandle, Page } from "playwright";
import { PNG } from "pngjs";
import { uniqueSelector } from "../../extension/src/selector.ts";
import { DEFAULT_DIFF_THRESHOLD, diffImages, passes } from "./diff.ts";
import { readCapture, updateCapture, writeFileAtomic } from "./library.ts";
import * as scripts from "./page-scripts.ts";
import { COMPONENT_FILE, DIFF_REPORT, NOTES_FILE, PREVIEW_VIDEO, REBUILD_FILE, withFixPass, withoutFixPass } from "./rebuild-prompt.ts";
import { MAX_TARGETS, playScript, saveCroppedVideo, type ScriptTargets, withBrowser } from "./recorder.ts";
import { buildSandbox, serveStatic } from "./sandbox.ts";

const PREVIEW_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 20_000;
/** Same padding as the extension's state screenshots (SCREENSHOT_PADDING in states.ts). */
const SCREENSHOT_PADDING = 8;
/** Same mobile viewport as the extension's mobile state. */
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2 };
/** Same pseudo-classes the extension forces for each state. */
const FORCED = { default: [], hover: ["hover"], focus: ["focus", "focus-visible", "focus-within"], active: ["active", "hover"], mobile: [] } as const;

type ShotKind = keyof typeof FORCED;

/** Thrown when there is no Component.tsx to preview yet. */
export class ComponentMissingError extends Error {}

interface ShotPlan {
  /** "default", "hover-0", "mobile": the original screenshot's file name without .png. */
  state: string;
  original: string;
  kind: ShotKind;
  /** Child-index path from the root to the element the state is forced on. */
  path?: number[];
  error?: string;
}

const samePath = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The path recorded for a selector during the original's recording, or [] for the root itself. */
function pathFor(capture: Capture, target: string): number[] | undefined {
  if (target === capture.meta.selector) return [];
  return capture.recording?.steps.find((s) => s.target === target && s.path)?.path;
}

/** Which screenshots to take: one per original screenshot that exists on disk. */
export function planShots(capture: Capture, existing: ReadonlySet<string>): ShotPlan[] {
  const plans: ShotPlan[] = [];
  const name = (file: string) => path.basename(file, path.extname(file));
  const shot = capture.media?.screenshot;
  if (shot && existing.has(shot)) plans.push({ state: name(shot), original: shot, kind: "default", path: [] });
  for (const s of capture.states ?? []) {
    if (!s.screenshot || !existing.has(s.screenshot)) continue;
    const state = name(s.screenshot);
    if (s.name === "mobile") {
      plans.push({ state, original: s.screenshot, kind: "mobile", path: [] });
    } else if (s.name === "hover" || s.name === "focus" || s.name === "active") {
      const p = pathFor(capture, s.target);
      plans.push(p ? { state, original: s.screenshot, kind: s.name, path: p } : { state, original: s.screenshot, kind: s.name, error: `no recorded path for ${s.target}, so the element could not be found in the rebuild` });
    } else {
      plans.push({ state, original: s.screenshot, kind: "default", error: `the ${s.name} state is not replayed by the preview` });
    }
  }
  return plans;
}

/** Hover and focus targets in the rebuild: the elements at the paths the original recording used. */
export function targetsFromSteps(steps: readonly RecordingStep[], paths: readonly number[][], warnings: string[]): ScriptTargets {
  const pick = (kind: "hover" | "focus") => {
    const out: number[] = [];
    for (const step of steps.filter((s) => s.kind === kind && s.path)) {
      const index = paths.findIndex((p) => samePath(p, step.path as number[]));
      if (index === -1) warnings.push(`The ${kind} target ${step.target ?? ""} (path [${step.path?.join(", ")}]) has no element at the same place in the rebuild.`);
      else if (!out.includes(index)) out.push(index);
      if (out.length >= MAX_TARGETS) break;
    }
    return out;
  };
  const hover = pick("hover");
  return { hover: hover.length > 0 ? hover : [0], focus: pick("focus") };
}

/** Allows requests to the sandbox's own origin only, and no WebSockets. */
async function lockDown(context: BrowserContext, origin: string): Promise<void> {
  await context.route("**/*", (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort("blockedbyclient")));
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  await context.addInitScript({ content: scripts.NAME_SHIM });
}

/** Opens the preview page and waits for the harness. Throws with the component's error if it failed to render. */
async function openPreview(page: Page, origin: string, rootWidth?: number): Promise<ElementHandle<Element>> {
  await page.goto(`${origin}/index.html${rootWidth ? `?rootWidth=${rootWidth}` : ""}`, { waitUntil: "load", timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(() => window.__kineticReady === true, null, { timeout: READY_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const error = await page.evaluate(() => window.__kineticError ?? null);
  if (error) throw new Error(`Component.tsx failed in the preview:\n${error}`);
  const handle = await page.evaluateHandle(scripts.previewRoot);
  const root = handle.asElement() as ElementHandle<Element> | null;
  if (!root) throw new Error("the preview harness did not mount");
  const box = await root.boundingBox();
  if (!box || box.width < 1 || box.height < 1) throw new Error("Component.tsx rendered nothing visible");
  return root;
}

/**
 * The same capture as the extension: the box plus padding, in document coordinates.
 * The extension's Chrome returns device pixels for scale 1, but Playwright's headless
 * shell returns CSS pixels, so the scale is the device scale factor here.
 */
async function captureBox(cdp: CDPSession, element: { x: number; y: number; width: number; height: number }, scale: number): Promise<Buffer> {
  const x = Math.max(0, element.x - SCREENSHOT_PADDING);
  const y = Math.max(0, element.y - SCREENSHOT_PADDING);
  const clip = { x, y, width: element.x + element.width + SCREENSHOT_PADDING - x, height: element.y + element.height + SCREENSHOT_PADDING - y, scale };
  const metrics = (await cdp.send("Page.getLayoutMetrics")) as { cssLayoutViewport: { clientHeight: number; pageY: number } };
  const viewport = metrics.cssLayoutViewport;
  const inView = clip.y >= viewport.pageY && clip.y + clip.height <= viewport.pageY + viewport.clientHeight;
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: !inView, fromSurface: true });
  return Buffer.from(data, "base64");
}

/** Forces each planned state on its element, as the extension did, and screenshots the root. */
async function takeShots(page: Page, root: ElementHandle<Element>, plans: readonly ShotPlan[]): Promise<Map<string, Buffer | string>> {
  const out = new Map<string, Buffer | string>();
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  for (const plan of plans) {
    if (plan.error || !plan.path) continue;
    let nodeId: number | undefined;
    try {
      if (!(await root.evaluate(scripts.markPath, plan.path))) {
        out.set(plan.state, "the rebuild has no element at the same place as the original's target");
        continue;
      }
      if (FORCED[plan.kind].length > 0) {
        const { root: doc } = (await cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
        ({ nodeId } = (await cdp.send("DOM.querySelector", { nodeId: doc.nodeId, selector: "[data-kinetic-target]" })) as { nodeId: number });
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...FORCED[plan.kind]] });
      }
      const box = await root.evaluate(scripts.documentBox);
      await page.evaluate(scripts.settle, { minMs: 450, maxMs: 1500 });
      out.set(plan.state, await captureBox(cdp, box, scale));
    } finally {
      if (nodeId) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => undefined);
    }
  }
  await cdp.detach().catch(() => undefined);
  return out;
}

function percent(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

export function buildDiffReport(preview: Preview, sizes: ReadonlyMap<string, { original: string; preview: string }>): string {
  const failing = preview.scores.filter((s) => s.score !== undefined && !passes(s.score, preview.threshold));
  const lines = [
    "# Preview diff",
    "",
    `Rendered ${preview.renderedAt}. Threshold: ${percent(preview.threshold)} of pixels. Over the threshold in ${failing.length} of ${preview.scores.length} states.`,
    "",
    "| state | score | size (original → rebuild) | original | rebuild | diff |",
    "| --- | --- | --- | --- | --- | --- |",
    ...preview.scores.map((s) => {
      const size = sizes.get(s.state);
      const score = s.score === undefined ? `not scored: ${s.error ?? "unknown"}` : `${percent(s.score)}${passes(s.score, preview.threshold) ? "" : " (over)"}`;
      const img = (file: string | undefined) => (file ? `![${file}](${file})` : "");
      return `| ${s.state} | ${score} | ${size ? `${size.original} → ${size.preview}` : ""} | ${img(s.original)} | ${img(s.preview)} | ${img(s.diff)} |`;
    }),
    "",
    "Score is the share of pixels that differ (pixelmatch, colour tolerance 0.1) on a canvas the size of the larger image, so a size difference counts as mismatch. Red pixels in each diff image mark the mismatches. Screenshots are the component's box plus 8 px, with each state forced on the same element as in the original. The rebuild is laid out at the original root's width (and, for mobile, at the width it had in a 390 px viewport).",
  ];
  if (preview.warnings?.length) lines.push("", "## Warnings", "", ...preview.warnings.map((w) => `- ${w}`));
  if (preview.file) lines.push("", `Compare the motion too: [original.webm](original.webm) and [${preview.file}](${preview.file}).`);
  return `${lines.join("\n")}\n`;
}

export interface PreviewOptions {
  threshold?: number;
  timeoutMs?: number;
}

/** Renders, records, screenshots and scores Component.tsx; writes the preview block and, when over the threshold, DIFF.md. */
export async function runPreview(dir: string, { threshold = DEFAULT_DIFF_THRESHOLD, timeoutMs = PREVIEW_TIMEOUT_MS }: PreviewOptions = {}): Promise<Preview> {
  const capture = await readCapture(dir);
  let source: string;
  try {
    source = await readFile(path.join(dir, COMPONENT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ComponentMissingError(`${COMPONENT_FILE} not found in ${capture.meta.site}/${capture.meta.slug}. Write it first: see ${REBUILD_FILE}.`);
    throw error;
  }
  const rootNode = capture.styles?.nodes.find((n) => n.selector === capture.meta.selector);
  const build = await buildSandbox(source, { rootWidth: rootNode ? Math.round(rootNode.box.width) : null });
  const server = await serveStatic(build.distDir);
  const warnings: string[] = [];
  const existing = new Set<string>();
  for (const file of [capture.media?.screenshot, ...(capture.states ?? []).map((s) => s.screenshot)]) {
    if (file && (await stat(path.join(dir, file)).then((s) => s.isFile(), () => false))) existing.add(file);
  }
  const plans = planShots(capture, existing);
  let shots = new Map<string, Buffer | string>();
  let videoFile: string | undefined;

  try {
    await withBrowser(timeoutMs, "the preview", async (browser: Browser, tmp: string) => {
      const { width, height, deviceScaleFactor } = capture.meta.viewport;

      // 1. The video: the same script the original was recorded with.
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, recordVideo: { dir: tmp, size: { width, height } }, reducedMotion: "no-preference", acceptDownloads: false, serviceWorkers: "block" });
      await lockDown(context, server.origin);
      const page = await context.newPage();
      const videoStart = Date.now();
      const root = await openPreview(page, server.origin);
      await page.evaluate(`window.__kineticUniqueSelector = ${uniqueSelector.toString()};`);
      const steps = capture.recording?.steps ?? [];
      const run = await playScript(page, root, {
        videoStart,
        chooseTargets: async (p, nodes) => (steps.length > 0 ? targetsFromSteps(steps, nodes.paths, warnings) : p.evaluate(scripts.listTargets, { states: [], max: MAX_TARGETS })),
      });
      warnings.push(...run.warnings);
      await saveCroppedVideo(page, context, run, { width, height }, path.join(dir, PREVIEW_VIDEO));
      videoFile = PREVIEW_VIDEO;

      // 2. Desktop state screenshots, in a fresh page with no video.
      const desktopPlans = plans.filter((p) => p.kind !== "mobile");
      if (desktopPlans.length > 0) {
        const shotsContext = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, reducedMotion: "no-preference", serviceWorkers: "block" });
        await lockDown(shotsContext, server.origin);
        const shotsPage = await shotsContext.newPage();
        shots = await takeShots(shotsPage, await openPreview(shotsPage, server.origin), desktopPlans);
        await shotsContext.close();
      }

      // 3. The mobile screenshot at the extension's 390 px viewport.
      const mobilePlans = plans.filter((p) => p.kind === "mobile");
      if (mobilePlans.length > 0) {
        // The original's root width at 390 px, read back from its mobile screenshot (box plus padding, at 2x).
        const mobileOriginal = mobilePlans[0] ? PNG.sync.read(await readFile(path.join(dir, mobilePlans[0].original))) : undefined;
        const mobileWidth = mobileOriginal ? Math.max(1, Math.round(mobileOriginal.width / MOBILE.deviceScaleFactor) - 2 * SCREENSHOT_PADDING) : undefined;
        const mobileContext = await browser.newContext({ viewport: { width: MOBILE.width, height: MOBILE.height }, deviceScaleFactor: MOBILE.deviceScaleFactor, isMobile: true, hasTouch: true, serviceWorkers: "block" });
        await lockDown(mobileContext, server.origin);
        const mobilePage = await mobileContext.newPage();
        for (const [state, png] of await takeShots(mobilePage, await openPreview(mobilePage, server.origin, mobileWidth), mobilePlans)) shots.set(state, png);
        await mobileContext.close();
      }
    });
  } finally {
    await server.close();
    await build.cleanup();
  }

  // 4. Score each pair.
  const scores: PreviewScore[] = [];
  const sizes = new Map<string, { original: string; preview: string }>();
  for (const plan of plans) {
    const shot = shots.get(plan.state);
    if (plan.error || typeof shot === "string" || !shot) {
      scores.push({ state: plan.state, original: plan.original, error: plan.error ?? (typeof shot === "string" ? shot : "no screenshot was taken") });
      continue;
    }
    const previewFile = `preview/${plan.state}.png`;
    const diffFile = `diff/${plan.state}.png`;
    const result = diffImages(await readFile(path.join(dir, plan.original)), shot);
    await writeFileAtomic(path.join(dir, previewFile), shot);
    await writeFileAtomic(path.join(dir, diffFile), result.diffPng);
    sizes.set(plan.state, { original: `${result.original.width}×${result.original.height}`, preview: `${result.preview.width}×${result.preview.height}` });
    scores.push({ state: plan.state, original: plan.original, preview: previewFile, diff: diffFile, score: Math.round(result.score * 10_000) / 10_000 });
  }

  const scored = scores.filter((s): s is PreviewScore & { score: number } => s.score !== undefined);
  const failing = scored.filter((s) => !passes(s.score, threshold));
  if (scored.length === 0) warnings.push("No state could be scored, so the preview has no diff.");
  const passed = scored.length > 0 && failing.length === 0;
  const preview: Preview = {
    ...(videoFile ? { file: videoFile } : {}),
    threshold,
    scores,
    passed,
    ...(failing.length > 0 ? { diffReport: DIFF_REPORT } : {}),
    renderedAt: new Date().toISOString(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  // 5. DIFF.md and the Fix pass section when a state is over the threshold; otherwise clear both.
  const rebuildFile = path.join(dir, REBUILD_FILE);
  const rebuildMd = await readFile(rebuildFile, "utf8").catch(() => undefined);
  if (failing.length > 0) {
    await writeFileAtomic(path.join(dir, DIFF_REPORT), buildDiffReport(preview, sizes));
    if (rebuildMd !== undefined) await writeFileAtomic(rebuildFile, withFixPass(rebuildMd, failing, threshold));
  } else {
    await rm(path.join(dir, DIFF_REPORT), { force: true });
    if (rebuildMd !== undefined) await writeFileAtomic(rebuildFile, withoutFixPass(rebuildMd));
  }

  const hasNotes = await stat(path.join(dir, NOTES_FILE)).then((s) => s.isFile(), () => false);
  await updateCapture(dir, (current) => ({
    ...current,
    preview,
    media: { ...current.media, component: COMPONENT_FILE, ...(videoFile ? { preview: videoFile } : {}), ...(hasNotes ? { notes: NOTES_FILE } : {}) },
  }));
  return preview;
}
