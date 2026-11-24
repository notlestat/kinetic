// Sends captures to the local companion. When the companion is not running, the
// capture is kept in extension storage and retried later.

import type { Capture } from "@kinetic/schema";
import { browser } from "wxt/browser";
import type { CaptureFile, CaptureOutcome } from "./messages.ts";

export const COMPANION_URL = "http://127.0.0.1:4517";
let companionUrl = COMPANION_URL;

/** Test builds only: points delivery at another URL to simulate an offline companion. */
export function setCompanionUrlForTests(url: string | undefined): void {
  companionUrl = url ?? COMPANION_URL;
}
export const RETRY_ALARM = "kinetic:retry";
const PENDING_KEY = "kinetic:pending";

export interface PendingCapture {
  capture: Capture;
  files: CaptureFile[];
}

class CompanionOffline extends Error {}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${companionUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new CompanionOffline(error instanceof Error ? error.message : String(error));
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Posts capture.json, then every file. Throws CompanionOffline when the companion cannot be reached. */
async function send(item: PendingCapture): Promise<CaptureOutcome> {
  const { status, json } = await post("/capture", item.capture);
  if (status >= 400) return { ok: false, error: `companion rejected the capture (${status}): ${String(json.error ?? "")}` };
  const { site, slug } = item.capture.meta;
  for (const file of item.files) {
    const res = await post("/capture/file", { site, slug, path: file.path, contentBase64: file.contentBase64 });
    if (res.status >= 400) {
      return { ok: false, error: `companion rejected ${file.path} (${res.status}): ${String(res.json.error ?? "")}` };
    }
  }
  return { ok: true, saved: "companion", path: `${site}/${slug}` };
}

async function readPending(): Promise<PendingCapture[]> {
  const stored = await browser.storage.local.get(PENDING_KEY);
  const value = stored[PENDING_KEY];
  return Array.isArray(value) ? (value as PendingCapture[]) : [];
}

async function writePending(items: PendingCapture[]): Promise<void> {
  await browser.storage.local.set({ [PENDING_KEY]: items });
  if (items.length > 0) await browser.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  else await browser.alarms.clear(RETRY_ALARM);
}

/** Sends a capture, or queues it if the companion is offline. */
export async function deliver(item: PendingCapture): Promise<CaptureOutcome> {
  await retryPending();
  try {
    return await send(item);
  } catch (error) {
    if (!(error instanceof CompanionOffline)) throw error;
    await writePending([...(await readPending()), item]);
    return { ok: true, saved: "queued", reason: `${companionUrl} is not reachable` };
  }
}

let retrying: Promise<void> | undefined;

/** Retries queued captures in order and stops at the first one that still cannot reach the companion. */
export async function pendingCount(): Promise<number> {
  return (await readPending()).length;
}

export function retryPending(): Promise<void> {
  retrying ??= (async () => {
    try {
      const pending = await readPending();
      const remaining = [...pending];
      for (const item of pending) {
        try {
          const outcome = await send(item);
          if (!outcome.ok) console.warn("[kinetic] dropping a queued capture the companion rejected:", outcome.error);
          remaining.shift();
        } catch (error) {
          if (error instanceof CompanionOffline) break;
          throw error;
        }
      }
      if (remaining.length !== pending.length) await writePending(remaining);
    } finally {
      retrying = undefined;
    }
  })();
  return retrying;
}
