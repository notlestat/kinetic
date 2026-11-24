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

export type Outcome = { ok: true; saved: "companion"; path: string } | { ok: true; saved: "queued"; reason: string } | { ok: false; error: string };

/** Captures the element matching `selector` through the test hook. */
export async function captureSelector(
  page: Page,
  selector: string,
  slug: string,
  options: Record<string, unknown> = {},
): Promise<Outcome> {
  const result = await kineticCall<{ outcome: Outcome }>(page, "test:capture", { selector, options: { ...options, slug } });
  return result.outcome;
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
