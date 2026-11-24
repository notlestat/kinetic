// State capture with chrome.debugger: forced pseudo-classes, a mobile viewport,
// and a screenshot of the selection in each state.

import type { BoundingBox, State, StateName } from "@kinetic/schema";
import { browser } from "wxt/browser";
import { type CdpSession, sleep } from "./cdp.ts";
import type { CaptureFile, RuntimeMessage, StyleSnapshot } from "./messages.ts";
import { diffSnapshots } from "./style-diff.ts";

export const MOBILE_WIDTH = 390;
export const MOBILE_HEIGHT = 844;

const FORCED: Record<"hover" | "focus" | "active", string[]> = {
  hover: ["hover"],
  focus: ["focus", "focus-visible", "focus-within"],
  active: ["active", "hover"],
};

export interface StateCaptureResult {
  states: State[];
  files: CaptureFile[];
  /** The default-state screenshot, if one was taken. */
  screenshot: string | undefined;
}

export async function requestSnapshot(tabId: number): Promise<StyleSnapshot> {
  const snapshot = (await browser.tabs.sendMessage(tabId, { type: "capture:snapshot" } satisfies RuntimeMessage, {
    frameId: 0,
  })) as StyleSnapshot | undefined;
  if (!snapshot) throw new Error("the page did not return a style snapshot");
  return snapshot;
}

/** Room around the component, so outlines, focus rings and shadows outside the box stay in the shot. */
export const SCREENSHOT_PADDING = 8;

/** PNG of the box plus padding, in document coordinates. Returns undefined for an empty box. */
export async function screenshot(session: CdpSession, element: BoundingBox): Promise<string | undefined> {
  if (element.width < 1 || element.height < 1) return undefined;
  const x = Math.max(0, element.x - SCREENSHOT_PADDING);
  const y = Math.max(0, element.y - SCREENSHOT_PADDING);
  const box = {
    x,
    y,
    width: element.x + element.width + SCREENSHOT_PADDING - x,
    height: element.y + element.height + SCREENSHOT_PADDING - y,
  };
  const metrics = await session.send<{ cssLayoutViewport: { clientHeight: number; pageY: number } }>(
    "Page.getLayoutMetrics",
  );
  const viewport = metrics.cssLayoutViewport;
  const inView = box.y >= viewport.pageY && box.y + box.height <= viewport.pageY + viewport.clientHeight;
  const { data } = await session.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    captureBeyondViewport: !inView,
    fromSurface: true,
  });
  return data;
}

async function nodeIdFor(session: CdpSession, documentNodeId: number, selector: string): Promise<number | undefined> {
  try {
    const { nodeId } = await session.send<{ nodeId: number }>("DOM.querySelector", { nodeId: documentNodeId, selector });
    return nodeId || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Forces hover, focus and active on each interactive element, one at a time, then
 * emulates a 390px viewport. Each state keeps only the style changes against the
 * default snapshot, plus a screenshot of the selection.
 */
export async function captureStates(
  session: CdpSession,
  rootSelector: string,
  interactive: readonly string[],
): Promise<StateCaptureResult> {
  const files: CaptureFile[] = [];
  const states: State[] = [];

  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });

  const baseline = await requestSnapshot(session.tabId);
  let defaultShot: string | undefined;
  const base = await screenshot(session, baseline.box);
  if (base) {
    defaultShot = "states/default.png";
    files.push({ path: defaultShot, contentBase64: base });
  }

  for (const [index, target] of interactive.entries()) {
    const nodeId = await nodeIdFor(session, root.nodeId, target);
    if (!nodeId) continue;
    for (const name of ["hover", "focus", "active"] as const) {
      await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: FORCED[name] });
      try {
        const snap = await requestSnapshot(session.tabId);
        const changes = diffSnapshots(baseline.styles, snap.styles);
        if (Object.keys(changes).length === 0) continue;
        const state: State = { name, target, changes };
        const shot = await screenshot(session, snap.box);
        if (shot) {
          state.screenshot = `states/${name}-${index}.png`;
          files.push({ path: state.screenshot, contentBase64: shot });
        }
        states.push(state);
      } finally {
        await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      }
    }
  }
  // Let the last forced state's reverse transition settle before the mobile pass.
  await requestSnapshot(session.tabId);

  const mobile = await captureMobile(session, rootSelector, baseline);
  if (mobile) {
    states.push(mobile.state);
    if (mobile.file) files.push(mobile.file);
  }
  return { states, files, screenshot: defaultShot };
}

async function captureMobile(
  session: CdpSession,
  rootSelector: string,
  baseline: StyleSnapshot,
): Promise<{ state: State; file: CaptureFile | undefined } | undefined> {
  const name: StateName = "mobile";
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: MOBILE_WIDTH,
    height: MOBILE_HEIGHT,
    deviceScaleFactor: 2,
    mobile: true,
  });
  try {
    await sleep(300);
    const snap = await requestSnapshot(session.tabId);
    const state: State = { name, target: rootSelector, changes: diffSnapshots(baseline.styles, snap.styles) };
    const shot = await screenshot(session, snap.box);
    let file: CaptureFile | undefined;
    if (shot) {
      state.screenshot = "states/mobile.png";
      file = { path: state.screenshot, contentBase64: shot };
    }
    return { state, file };
  } finally {
    await session.send("Emulation.clearDeviceMetricsOverride");
    await sleep(300);
  }
}
