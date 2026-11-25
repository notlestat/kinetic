// Content script (isolated world): picker UI, DOM and style capture.

import { referenceMarkdown } from "@kinetic/schema/reference";
import { browser } from "wxt/browser";
import { collectCapture, finishCapture, snapshotCurrent } from "./capture.ts";
import { type CopyContent, type CopyResult, copyToClipboard } from "./clipboard.ts";
import { screenshotElement } from "./element-shot.ts";
import { buildMotion } from "./motion-normalise.ts";
import {
  type CaptureOptions,
  type CaptureOutcome,
  type CaptureSubmission,
  isKineticMessage,
  postToWindow,
  type RuntimeMessage,
} from "./messages.ts";
import { armMainWorldWatch, requestMainWorldReport } from "./main-world-bridge.ts";
import { Picker } from "./picker.ts";

/** Test hooks (capture a selector, toggle the picker) exist only in dev and test builds. */
const TEST_HOOKS = import.meta.env.MODE !== "production";

export function startContent(): void {
  const picker = new Picker(async (el, { reloadForLoadAnimations }) => {
    await runCapture(el, { reloadForLoadAnimations }, picker);
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

const COPY_TEXT: Record<CopyResult, string> = {
  "image+text": "Copied image and text.",
  text: "Copied text (no screenshot).",
  failed: "Could not copy.",
};

function describe(outcome: CaptureOutcome, copy: CopyResult): { text: string; tone: "ok" | "error" | "info" } {
  const copied = COPY_TEXT[copy];
  if (!outcome.ok) return { text: `${copied} Library save failed: ${outcome.error}`, tone: "error" };
  if (outcome.saved === "companion") return { text: `${copied} Saved to library/${outcome.path}`, tone: copy === "failed" ? "error" : "ok" };
  return { text: `${copied} Companion not running; library save will retry.`, tone: copy === "failed" ? "error" : "ok" };
}

/** The capture as Markdown, with the motion the page showed at the moment of the click. */
function referenceFor(submission: CaptureSubmission): string {
  const motion = buildMotion({
    atStart: submission.motion,
    passes: [],
    css: submission.cssMotion,
    assets: submission.motion?.assets ?? [],
    baseline: {},
    states: [],
  });
  return referenceMarkdown({ ...submission.capture, motion });
}

/**
 * Copies the component to the clipboard first, then saves the full capture (states,
 * motion passes, recording) to the library in the background.
 */
export async function runCapture(
  el: Element,
  options: CaptureOptions & { slug?: string },
  picker?: Picker,
): Promise<CaptureOutcome> {
  picker?.setStatus("Copying…");
  picker?.setHidden(true);
  // Start the clipboard write before the first await, while the click still counts as a gesture.
  let fill!: (content: CopyContent) => void;
  let fail!: (error: unknown) => void;
  const copying = copyToClipboard(
    new Promise<CopyContent>((resolve, reject) => {
      fill = resolve;
      fail = reject;
    }),
  );
  let copy: CopyResult = "failed";
  let outcome: CaptureOutcome;
  try {
    const submission = await collectCapture(el, options);
    try {
      const image = await screenshotElement(el).catch(() => undefined);
      fill({ text: referenceFor(submission), image });
    } catch (error) {
      fail(error);
    }
    copy = await copying;
    void browser.runtime.sendMessage({ type: "capture:copied", result: copy } satisfies RuntimeMessage).catch(() => {});
    outcome = (await browser.runtime.sendMessage({ type: "capture:submit", submission } satisfies RuntimeMessage)) as CaptureOutcome;
    outcome ??= { ok: false, error: "no response from the background worker" };
  } catch (error) {
    fail(error);
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    finishCapture();
    picker?.setHidden(false);
  }
  const { text, tone } = describe(outcome, copy);
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
