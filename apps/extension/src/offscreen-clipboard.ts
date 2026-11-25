// Runs in the offscreen page. Copies text the background sends, with a textarea and
// execCommand("copy"): navigator.clipboard needs a focused page, and this page is never focused.

import { browser } from "wxt/browser";
import type { RuntimeMessage } from "./messages.ts";

export function startOffscreenClipboard(): void {
  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (response?: unknown) => void) => {
    const message = raw as RuntimeMessage;
    if (message.type !== "offscreen:copy") return false;
    sendResponse(copy(message.text));
    return false;
  });
}

function copy(text: string): { ok: boolean } {
  const area = document.createElement("textarea");
  area.value = text;
  document.body.append(area);
  area.select();
  try {
    return { ok: document.execCommand("copy") };
  } finally {
    area.remove();
  }
}
