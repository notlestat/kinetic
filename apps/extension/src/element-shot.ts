// A quick PNG of the picked element for the clipboard. The background grabs the visible
// tab, and the content script crops it to the element. This skips the debugger, so it
// takes a fraction of a second, but it only sees the part of the element on screen.

import { browser } from "wxt/browser";
import type { RuntimeMessage } from "./messages.ts";

/** Room around the element, so focus rings and shadows stay in the shot. */
const PADDING = 8;

function dataUrlToBlob(dataUrl: string): Blob {
  const [header = "", base64 = ""] = dataUrl.split(",");
  const type = /^data:([^;]+)/.exec(header)?.[1] ?? "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * The element's on-screen box as a PNG, or undefined when the tab cannot be captured
 * (no activeTab grant, a Chrome page) or the element is off screen.
 * Hide any overlay before calling.
 */
export async function screenshotElement(el: Element): Promise<Blob | undefined> {
  const dataUrl = (await browser.runtime.sendMessage({ type: "capture:visible-tab" } satisfies RuntimeMessage)) as
    | string
    | undefined;
  if (!dataUrl) return undefined;
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  try {
    const r = el.getBoundingClientRect();
    const left = clamp(r.left - PADDING, 0, window.innerWidth);
    const top = clamp(r.top - PADDING, 0, window.innerHeight);
    const right = clamp(r.right + PADDING, 0, window.innerWidth);
    const bottom = clamp(r.bottom + PADDING, 0, window.innerHeight);
    if (right - left < 1 || bottom - top < 1) return undefined;
    // The grab is in device pixels; keep them so the shot stays sharp on retina screens.
    const scale = bitmap.width / window.innerWidth;
    const canvas = new OffscreenCanvas(Math.round((right - left) * scale), Math.round((bottom - top) * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, left * scale, top * scale, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}
