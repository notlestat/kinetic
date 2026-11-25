// Background side of the clipboard. A service worker has no DOM and no clipboard, so
// the copy happens in an offscreen page that this module opens, uses and closes.

import { browser } from "wxt/browser";
import type { RuntimeMessage } from "./messages.ts";

const OFFSCREEN_PATH = "/offscreen.html";

/** One copy at a time, so two captures never race to open the offscreen page. */
let queue: Promise<unknown> = Promise.resolve();

export function copyToClipboard(text: string): Promise<void> {
  const run = queue.then(() => copyNow(text));
  queue = run.catch(() => undefined);
  return run;
}

async function copyNow(text: string): Promise<void> {
  const url = browser.runtime.getURL(OFFSCREEN_PATH);
  const open = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (open.length === 0) {
    await browser.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["CLIPBOARD"],
      justification: "Copy the capture prompt to the clipboard",
    });
  }
  try {
    const result = (await browser.runtime.sendMessage({ type: "offscreen:copy", text } satisfies RuntimeMessage)) as { ok?: boolean } | undefined;
    if (!result?.ok) throw new Error("Chrome refused the copy");
  } finally {
    await browser.offscreen.closeDocument().catch(() => {});
  }
}
