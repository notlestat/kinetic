// Background service worker: chrome.debugger (CDP), screenshots, and copying the finished
// capture to the clipboard as a prompt for Claude Code.

import { browser } from "wxt/browser";
import { type AssetRecord, toAssetsBlock } from "./asset-records.ts";
import { CdpSession } from "./cdp.ts";
import { MotionPass, type PassHooks, type PassResult } from "./cdp-motion.ts";
import { type NetworkAsset, NetworkRecorder, resolveNetworkAssets } from "./cdp-network.ts";
import { copyToClipboard } from "./clipboard.ts";
import { buildClipboardPrompt, type PromptFile } from "./clipboard-prompt.ts";
import type { CaptureFile, CaptureOutcome, CaptureSubmission, RuntimeMessage } from "./messages.ts";
import type { MainWorldMotion } from "./motion-records.ts";
import { buildMotion } from "./motion-normalise.ts";
import { captureStates, type StateCaptureResult } from "./states.ts";

/** Test hooks exist only in dev and test builds. */
const TEST_HOOKS = import.meta.env.MODE !== "production";

export function startBackground(): void {
  // Lets end-to-end tests press the toolbar button, which Playwright cannot click.
  if (TEST_HOOKS) (globalThis as { kineticTogglePicker?: typeof togglePicker }).kineticTogglePicker = togglePicker;
  browser.action.onClicked.addListener((tab) => void togglePicker(tab.id));
  browser.commands.onCommand.addListener((command, tab) => {
    if (command === "toggle-picker") void togglePicker(tab?.id);
  });
  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (response?: unknown) => void) => {
    const message = raw as RuntimeMessage;
    if (message.type !== "capture:submit") return false;
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: "capture must come from a tab" } satisfies CaptureOutcome);
      return false;
    }
    runCapture(tabId, message.submission).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies CaptureOutcome),
    );
    return true;
  });
}

export const UNREACHABLE_BADGE = "!";
export const UNREACHABLE_TITLE = "Kinetic can't run on this page. Chrome keeps extensions out of its own pages, the Web Store and the PDF viewer. On other pages, refresh and try again.";
const DEFAULT_TITLE = "Kinetic: pick a component (Alt+Shift+K)";

/** WXT's output paths for the two content scripts. */
const CONTENT_SCRIPT = "/content-scripts/content.js";
const MAIN_WORLD_SCRIPT = "/content-scripts/main-world.js";

function sendToggle(tabId: number): Promise<unknown> {
  return browser.tabs.sendMessage(tabId, { type: "picker:toggle" } satisfies RuntimeMessage, { frameId: 0 });
}

/**
 * Loads Kinetic's scripts into a tab that doesn't have them: a tab open since before
 * Kinetic was installed or reloaded. Needs the <all_urls> host permission; content script
 * matches alone don't let chrome.scripting into a page.
 */
async function injectContentScripts(tabId: number): Promise<void> {
  const target = { tabId, frameIds: [0] };
  // The MAIN world script skips itself when an older copy is still in the page.
  await browser.scripting.executeScript({ target, files: [MAIN_WORLD_SCRIPT], world: "MAIN" });
  await browser.scripting.executeScript({ target, files: [CONTENT_SCRIPT] });
}

async function togglePicker(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    try {
      await sendToggle(tabId);
    } catch {
      await injectContentScripts(tabId);
      await sendToggle(tabId);
    }
    await browser.action.setBadgeText({ tabId, text: "" });
    await browser.action.setTitle({ tabId, title: DEFAULT_TITLE });
  } catch {
    // Chrome refused the scripts: one of its own pages, or a page it keeps extensions out of.
    await browser.action.setBadgeText({ tabId, text: UNREACHABLE_BADGE }).catch(() => {});
    await browser.action.setBadgeBackgroundColor({ tabId, color: "#d93025" }).catch(() => {});
    await browser.action.setTitle({ tabId, title: UNREACHABLE_TITLE }).catch(() => {});
  }
}

/** Asks the content script (and through it the MAIN world) for the motion running right now. */
async function collectMotion(tabId: number, rootSelector: string): Promise<MainWorldMotion | undefined> {
  // After a reload the content script needs a moment to start, so retry briefly.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return (await browser.tabs.sendMessage(tabId, { type: "capture:collect-motion", rootSelector } satisfies RuntimeMessage, {
        frameId: 0,
      })) as MainWorldMotion | undefined;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return undefined;
}

/**
 * Adds what only the debugger can see (states, screenshots, the Animation
 * domain) to the content script's capture, then copies it as a prompt.
 */
async function runCapture(tabId: number, submission: CaptureSubmission): Promise<CaptureOutcome> {
  const capture = structuredClone(submission.capture);
  const files = [...submission.files];
  const { rootSelector, interactive } = submission;

  let session: CdpSession | undefined;
  try {
    session = await CdpSession.attach(tabId);
  } catch (error) {
    // Another debugger (DevTools) is attached, or the page cannot be debugged. Save what we have.
    console.warn("[kinetic] could not attach the debugger; saving without states or the Animation domain", error);
  }

  let states: StateCaptureResult | undefined;
  const passes: PassResult[] = [];
  let networkAssets: NetworkAsset[] = [];
  if (session) {
    const network = new NetworkRecorder(session);
    await network.start();
    try {
      states = await captureStates(session, rootSelector, interactive);
      capture.states = states.states;
      files.push(...states.files);
      if (states.screenshot) capture.media = { ...capture.media, screenshot: states.screenshot };

      const hooks: PassHooks = {
        arm: async (trigger) => {
          await browser.tabs.sendMessage(tabId, { type: "capture:watch", trigger } satisfies RuntimeMessage, { frameId: 0 });
        },
        collect: () => collectMotion(tabId, rootSelector),
      };
      const pass = new MotionPass(session, hooks);
      passes.push(...(await pass.fireStates(interactive)));
      if (submission.options.reloadForLoadAnimations) passes.push(...(await pass.reloadForLoadAnimations()));
      networkAssets = await network.finish(submission.motion?.assets?.length ?? 0);
    } finally {
      await session.detach();
    }
  }

  // Animation assets: what the MAIN world found, completed by what the Network domain caught.
  let assets: AssetRecord[] = submission.motion?.assets ?? [];
  if (networkAssets.length > 0) {
    const resolved = resolveNetworkAssets(assets, submission.motion?.unresolvedAssets ?? [], networkAssets);
    assets = resolved.records;
    files.push(...resolved.files);
  }
  if (assets.length > 0) capture.assets = { files: toAssetsBlock(assets) };

  const motionInputs = {
    atStart: submission.motion,
    passes,
    css: submission.cssMotion,
    assets,
    baseline: states?.baseline.styles ?? {},
    states: capture.states ?? [],
  };
  capture.motion = buildMotion(motionInputs);

  const prompt = buildClipboardPrompt(capture, textFiles(files));
  await copyToClipboard(prompt.text);
  const outcome: CaptureOutcome = { ok: true, copied: true, chars: prompt.text.length, truncated: prompt.truncated };
  if (!TEST_HOOKS) return outcome;
  // Test builds return everything the capture made, so the e2e tests can save and check it. They
  // also keep it on the worker, for captures that reload the page before the page hears back.
  const withDebug: CaptureOutcome = { ...outcome, debug: { motionInputs, capture, files, prompt: prompt.text } };
  (globalThis as { kineticLastCapture?: CaptureOutcome }).kineticLastCapture = withDebug;
  return withDebug;
}

const TEXT_FILE = /\.(glsl|vert|frag|json|txt)$/i;

/** The capture's text files, decoded, for the prompt. Images and binary assets stay out. */
function textFiles(files: readonly CaptureFile[]): PromptFile[] {
  return files
    .filter((f) => TEXT_FILE.test(f.path))
    .map((f) => ({ path: f.path, text: new TextDecoder().decode(Uint8Array.from(atob(f.contentBase64), (c) => c.charCodeAt(0))) }));
}
