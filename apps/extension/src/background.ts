// Background service worker: chrome.debugger (CDP), screenshots, and sending captures to the companion.

import { browser } from "wxt/browser";
import { CdpSession } from "./cdp.ts";
import { deliver, pendingCount, RETRY_ALARM, retryPending, setCompanionUrlForTests } from "./companion-client.ts";
import type { CaptureOutcome, CaptureSubmission, RuntimeMessage } from "./messages.ts";
import { captureStates } from "./states.ts";

/** Test hooks exist only in dev and test builds. */
const TEST_HOOKS = import.meta.env.MODE !== "production";

export function startBackground(): void {
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

async function togglePicker(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    await browser.tabs.sendMessage(tabId, { type: "picker:toggle" } satisfies RuntimeMessage, { frameId: 0 });
  } catch {
    // No content script on this page (chrome:// pages, the Web Store, or a tab opened before install).
  }
}

/** Adds what only the debugger can see (states, screenshots) to the content script's capture, then delivers it. */
async function runCapture(tabId: number, submission: CaptureSubmission): Promise<CaptureOutcome> {
  const capture = structuredClone(submission.capture);
  const files = [...submission.files];

  let session: CdpSession | undefined;
  try {
    session = await CdpSession.attach(tabId);
  } catch (error) {
    // Another debugger (DevTools) is attached, or the page cannot be debugged. Save what we have.
    console.warn("[kinetic] could not attach the debugger; saving without states", error);
  }

  if (session) {
    try {
      const result = await captureStates(session, submission.rootSelector, submission.interactive);
      capture.states = result.states;
      files.push(...result.files);
      if (result.screenshot) capture.media = { ...capture.media, screenshot: result.screenshot };
    } finally {
      await session.detach();
    }
  }

  return deliver({ capture, files });
}
