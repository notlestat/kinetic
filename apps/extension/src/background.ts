// Background service worker: chrome.debugger (CDP), screenshots, and sending captures to the companion.

import { browser } from "wxt/browser";
import { type AssetRecord, toAssetsBlock } from "./asset-records.ts";
import { CdpSession } from "./cdp.ts";
import { MotionPass, type PassHooks, type PassResult } from "./cdp-motion.ts";
import { type NetworkAsset, NetworkRecorder, resolveNetworkAssets } from "./cdp-network.ts";
import { deliver, pendingCount, RETRY_ALARM, retryPending, setCompanionUrlForTests } from "./companion-client.ts";
import type { CaptureOutcome, CaptureSubmission, RuntimeMessage } from "./messages.ts";
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
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) void retryPending();
  });
  browser.runtime.onStartup.addListener(() => void retryPending());
  browser.runtime.onInstalled.addListener(() => void retryPending());

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (response?: unknown) => void) => {
    const message = raw as RuntimeMessage;
    if (TEST_HOOKS && message.type === "test:companion") {
      setCompanionUrlForTests(message.url);
      sendResponse({ ok: true });
      return false;
    }
    if (TEST_HOOKS && message.type === "test:retry") {
      retryPending().then(
        async () => sendResponse({ ok: true, pending: await pendingCount() }),
        (error: unknown) => sendResponse({ ok: false, error: String(error) }),
      );
      return true;
    }
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
export const UNREACHABLE_TITLE = "Kinetic can't reach this page. Refresh it, then try again. Pages open before Kinetic was installed or reloaded need a refresh; Chrome pages can't be captured.";
const DEFAULT_TITLE = "Kinetic: pick a component (Alt+Shift+K)";

async function togglePicker(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    await browser.tabs.sendMessage(tabId, { type: "picker:toggle" } satisfies RuntimeMessage, { frameId: 0 });
    await browser.action.setBadgeText({ tabId, text: "" });
    await browser.action.setTitle({ tabId, title: DEFAULT_TITLE });
  } catch {
    // No content script on this page: a tab open since before Kinetic was installed or
    // reloaded, or a page Chrome keeps extensions out of. Say so on the icon instead of
    // doing nothing.
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
 * domain) to the content script's capture, then delivers it.
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

  const outcome = await deliver({ capture, files });
  // Test builds return the raw motion inputs, so e2e/record-fixtures can save them for the unit tests.
  return TEST_HOOKS ? { ...outcome, debug: { motionInputs } } : outcome;
}
