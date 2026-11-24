// Content script (isolated world): picker UI, DOM and style capture.

import { browser } from "wxt/browser";
import { collectCapture, finishCapture, snapshotCurrent } from "./capture.ts";
import {
  type CaptureOptions,
  type CaptureOutcome,
  isKineticMessage,
  postToWindow,
  type RuntimeMessage,
} from "./messages.ts";
import { armMainWorldWatch, requestMainWorldReport } from "./main-world-bridge.ts";
import { Picker } from "./picker.ts";

/** Test hooks (capture a selector, toggle the picker) exist only in dev and test builds. */
const TEST_HOOKS = import.meta.env.MODE !== "production";

export function startContent(): void {
  const picker = new Picker(async (el) => {
    await runCapture(el, {}, picker);
  });

  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (response?: unknown) => void) => {
    const message = raw as RuntimeMessage;
    if (message.type === "picker:toggle") {
      picker.toggle();
      sendResponse({ active: picker.active });
      return false;
    }
    if (message.type === "capture:snapshot") {
      void snapshotCurrent().then(sendResponse, () => sendResponse(undefined));
      return true;
    }
    if (message.type === "capture:collect-motion") {
      // Works without a capture in progress, so the background can also ask after reloading the page.
      void requestMainWorldReport(null, message.rootSelector, "motion").then(
        (report) => sendResponse(report?.motion),
        () => sendResponse(undefined),
      );
      return true;
    }
    if (message.type === "capture:watch") {
      void armMainWorldWatch(message.trigger).then(sendResponse, () => sendResponse(false));
      return true;
    }
    if (message.type === "capture:ping") {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  if (TEST_HOOKS) installTestHooks(picker);
}

function describe(outcome: CaptureOutcome): { text: string; tone: "ok" | "error" | "info" } {
  if (!outcome.ok) return { text: `Capture failed: ${outcome.error}`, tone: "error" };
  if (outcome.saved === "companion") return { text: `Saved to library/${outcome.path}`, tone: "ok" };
  return { text: `Companion not running. Capture kept and will retry. (${outcome.reason})`, tone: "error" };
}

export async function runCapture(
  el: Element,
  options: CaptureOptions & { slug?: string },
  picker?: Picker,
): Promise<CaptureOutcome> {
  picker?.setStatus("Capturing…");
  picker?.setHidden(true);
  let outcome: CaptureOutcome;
  try {
    const submission = await collectCapture(el, options);
    outcome = (await browser.runtime.sendMessage({ type: "capture:submit", submission } satisfies RuntimeMessage)) as CaptureOutcome;
    outcome ??= { ok: false, error: "no response from the background worker" };
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    finishCapture();
    picker?.setHidden(false);
  }
  const { text, tone } = describe(outcome);
  picker?.setStatus(text, tone);
  return outcome;
}

// ─── test hooks (dev and test builds only) ───────────────────────────────────

function installTestHooks(picker: Picker): void {
  document.documentElement.setAttribute("data-kinetic-test-ready", "");
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || !isKineticMessage(event.data)) return;
    const { type, requestId } = event.data;
    if (type === "test:capture") {
      const selector = String(event.data.selector);
      const el = document.querySelector(selector);
      const options = (event.data.options ?? {}) as CaptureOptions & { slug?: string };
      const done = (outcome: CaptureOutcome) => postToWindow("test:capture-result", { requestId, outcome });
      if (!el) done({ ok: false, error: `no element matches ${selector}` });
      else void runCapture(el, options, picker.active ? picker : undefined).then(done);
    } else if (type === "test:companion" || type === "test:retry") {
      const message: RuntimeMessage =
        type === "test:retry"
          ? { type: "test:retry" }
          : { type: "test:companion", ...(typeof event.data.url === "string" ? { url: event.data.url } : {}) };
      void browser.runtime.sendMessage(message).then((response: unknown) =>
        postToWindow(`${type}-result`, { requestId, response }),
      );
    } else if (type === "test:picker") {
      picker.toggle();
      postToWindow("test:picker-result", { requestId, active: picker.active });
    }
  });
}
