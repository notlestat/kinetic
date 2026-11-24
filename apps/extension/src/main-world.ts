// MAIN world hooks. Each feature adds its own clearly marked section below and
// must never throw into page code: wrap every hook in try/catch, and never change
// what the page renders.

import { isKineticMessage, type MainWorldReport, postToWindow, ROOT_ATTRIBUTE } from "./messages.ts";

/** What each feature section gets when the content script asks for a report. */
export interface CollectContext {
  root: Element;
  rootSelector: string;
  report: MainWorldReport;
}

type Collector = (ctx: CollectContext) => void | Promise<void>;

const collectors: { name: string; collect: Collector }[] = [];

/** Registers a feature's part of the capture report. A failing collector never stops the others. */
function addCollector(name: string, collect: Collector): void {
  collectors.push({ name, collect });
}

export function startMainWorld(): void {
  try {
    installBridge();
  } catch {
    // Never break the site.
  }
}

// ─── bridge: answers capture:collect from the content script ────────────────

function installBridge(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    try {
      if (event.source !== window || !isKineticMessage(event.data)) return;
      if (event.data.type !== "capture:collect") return;
      const requestId = event.data.requestId;
      const rootSelector = event.data.rootSelector;
      if (typeof requestId !== "string" || typeof rootSelector !== "string") return;
      void collect(requestId, rootSelector);
    } catch {
      // Never break the site.
    }
  });
}

async function collect(requestId: string, rootSelector: string): Promise<void> {
  const report: MainWorldReport = { sections: {}, files: [] };
  const root = document.querySelector(`[${ROOT_ATTRIBUTE}="${CSS.escape(requestId)}"]`);
  if (root) {
    for (const { collect: run } of collectors) {
      try {
        await run({ root, rootSelector, report });
      } catch {
        // One feature failing must not lose the others.
      }
    }
  }
  postToWindow("capture:collected", { requestId, report });
}
