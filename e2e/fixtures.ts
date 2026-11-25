import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type Capture, CaptureSchema } from "@kinetic/schema";
import { test as base, type BrowserContext, chromium, expect, type Page } from "@playwright/test";
import { E2E_LIBRARY_DIR, EXTENSION_DIR, TEST_PAGES } from "./paths.ts";

export { expect };

export const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    if (context.serviceWorkers().length === 0) await context.waitForEvent("serviceworker");
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

/** Opens a test page and waits until the extension's content script is ready. */
export async function openTestPage(page: Page, name: string): Promise<void> {
  await page.goto(`${TEST_PAGES}/${name}`);
  await page.waitForSelector("html[data-kinetic-test-ready]", { state: "attached" });
  await page.evaluate(() => document.fonts.ready);
}

/** Sends a test-hook message and waits for its "-result" reply. */
export async function kineticCall<T = Record<string, unknown>>(
  page: Page,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  return page.evaluate(
    ({ type, payload }) =>
      new Promise<T>((resolve) => {
        const requestId = crypto.randomUUID();
        const onMessage = (event: MessageEvent) => {
          const data = event.data as { source?: string; type?: string; requestId?: string } | undefined;
          if (data?.source === "kinetic" && data.type === `${type}-result` && data.requestId === requestId) {
            window.removeEventListener("message", onMessage);
            resolve(data as T);
          }
        };
        window.addEventListener("message", onMessage);
        window.postMessage({ ...payload, source: "kinetic", type, requestId }, "*");
      }),
    { type, payload },
  );
}

/** What the test build of the extension returns: the clipboard result plus everything the capture made. */
export interface CaptureDebug {
  capture: Capture;
  files: { path: string; contentBase64: string }[];
  prompt: string;
  motionInputs: unknown;
}

export type Outcome = ({ ok: true; copied: true; chars: number; truncated: boolean } | { ok: false; error: string }) & { debug?: CaptureDebug };

const COMPANION = "http://127.0.0.1:4517";

/** Captures the element matching `selector` through the test hook, without saving anything. */
export async function captureOnly(page: Page, selector: string, slug: string, options: Record<string, unknown> = {}): Promise<Outcome> {
  const result = await kineticCall<{ outcome: Outcome }>(page, "test:capture", { selector, options: { ...options, slug } });
  return result.outcome;
}

/**
 * Captures the element matching `selector`, then saves the capture through the test
 * companion so the tests can read it from disk. The extension itself only copies to the
 * clipboard; saving here is the test harness's job.
 */
export async function captureSelector(page: Page, selector: string, slug: string, options: Record<string, unknown> = {}): Promise<Outcome> {
  const outcome = await captureOnly(page, selector, slug, options);
  if (outcome.ok && outcome.debug) await saveToCompanion(outcome.debug);
  return outcome;
}

export async function saveToCompanion({ capture, files }: CaptureDebug): Promise<void> {
  const post = async (route: string, body: unknown) => {
    const res = await fetch(`${COMPANION}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`companion ${route} answered ${res.status}: ${await res.text()}`);
  };
  await post("/capture", capture);
  const { site, slug } = capture.meta;
  for (const file of files) await post("/capture/file", { site, slug, path: file.path, contentBase64: file.contentBase64 });
}

export function captureDirFor(site: string, slug: string): string {
  return path.join(E2E_LIBRARY_DIR, site, slug);
}

export async function readCaptureJson(site: string, slug: string): Promise<Capture> {
  const raw = JSON.parse(await readFile(path.join(captureDirFor(site, slug), "capture.json"), "utf8"));
  return CaptureSchema.parse(raw);
}

export async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** Width and height from a PNG header. */
export async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const buf = await readFile(file);
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Waits for the service worker's last capture to have a slug starting with `prefix`, then
 * saves it like captureSelector does. For captures that reload the page, which then never
 * hears back. Returns the slug.
 */
export async function saveWorkerCapture(context: BrowserContext, prefix: string): Promise<string> {
  const [worker] = context.serviceWorkers();
  if (!worker) throw new Error("no service worker");
  let debug: CaptureDebug | undefined;
  await expect
    .poll(
      async () => {
        const last = await worker.evaluate(() => (globalThis as { kineticLastCapture?: { debug?: unknown } }).kineticLastCapture?.debug);
        const found = last as CaptureDebug | undefined;
        if (found?.capture.meta.slug.startsWith(prefix)) debug = found;
        return debug !== undefined;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  if (!debug) throw new Error("unreachable");
  await saveToCompanion(debug);
  return debug.capture.meta.slug;
}
