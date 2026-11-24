// Content-script side of the MAIN world bridge.
//
// The MAIN world can read page globals (gsap, React fibers, three.js scenes) but
// has no extension APIs. The content script marks the capture root with an
// attribute, asks the MAIN world for its report over window.postMessage, and
// waits for the answer with the same request id.

import { isKineticMessage, type MainWorldReport, postToWindow, ROOT_ATTRIBUTE } from "./messages.ts";

/** The MAIN world samples three.js renders for a few seconds, so this has to be generous. */
export const MAIN_WORLD_TIMEOUT_MS = 20_000;

export async function requestMainWorldReport(root: Element, rootSelector: string): Promise<MainWorldReport | undefined> {
  const requestId = crypto.randomUUID();
  root.setAttribute(ROOT_ATTRIBUTE, requestId);
  try {
    return await new Promise<MainWorldReport | undefined>((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(undefined);
      }, MAIN_WORLD_TIMEOUT_MS);
      function onMessage(event: MessageEvent) {
        if (event.source !== window || !isKineticMessage(event.data)) return;
        if (event.data.type !== "capture:collected" || event.data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(event.data.report as MainWorldReport);
      }
      window.addEventListener("message", onMessage);
      postToWindow("capture:collect", { requestId, rootSelector });
    });
  } finally {
    root.removeAttribute(ROOT_ATTRIBUTE);
  }
}
