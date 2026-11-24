// The companion's HTTP API, as the library reads it. The companion answers these
// origins with CORS headers on the read routes and the rebuild and preview routes.

import type { Capture, Job, MotionSummary, RebuildMode } from "@kinetic/schema";

export const COMPANION = (import.meta.env.VITE_KINETIC_COMPANION as string | undefined) ?? "http://127.0.0.1:4517";

export interface CaptureListItem {
  site: string;
  slug: string;
  componentName: string;
  meta: { url: string; title?: string; timestamp: string; selector: string };
  job?: Job;
  motion?: MotionSummary;
  framework: { kind: string; detected: { name: string; version?: string }[] };
  hasThree: boolean;
  preview?: { passed: boolean; threshold: number };
  /** The start of NOTES.md, for the free-text filter. */
  notes?: string;
  media: Record<string, string>;
}

export interface BrokenCapture {
  site: string;
  slug: string;
  error: string;
}

export interface CaptureFile {
  path: string;
  size: number;
  url: string;
  contentType: string;
}

export interface CaptureDetail {
  capture: Capture;
  componentName: string;
  media: Record<string, string>;
  files: CaptureFile[];
  rebuild: { mode: RebuildMode; folder: string; handoff: string };
}

export class CompanionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${COMPANION}${path}`, signal ? { signal } : {});
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new CompanionError(`The companion is not answering at ${COMPANION}. Start it with: pnpm dev:companion`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CompanionError(body.error ?? `The companion answered ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export function isBroken(item: CaptureListItem | BrokenCapture): item is BrokenCapture {
  return "error" in item;
}

export async function listCaptures(signal?: AbortSignal): Promise<(CaptureListItem | BrokenCapture)[]> {
  return (await getJson<{ captures: (CaptureListItem | BrokenCapture)[] }>("/captures", signal)).captures;
}

export function getCapture(site: string, slug: string, signal?: AbortSignal): Promise<CaptureDetail> {
  return getJson<CaptureDetail>(`/captures/${encodeURIComponent(site)}/${encodeURIComponent(slug)}`, signal);
}

/** Reads a capture file as text. Used for Component.tsx and NOTES.md, which are shown, never run. */
export async function getText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new CompanionError(`Could not read ${url} (${res.status})`, res.status);
  return res.text();
}

/** Starts a rebuild or a preview. The companion queues it and answers 202. */
export async function startJob(site: string, slug: string, action: "rebuild" | "preview"): Promise<{ job: Job; mode?: RebuildMode }> {
  let res: Response;
  try {
    res = await fetch(`${COMPANION}/captures/${encodeURIComponent(site)}/${encodeURIComponent(slug)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new CompanionError(`The companion is not answering at ${COMPANION}.`);
  }
  const body = (await res.json().catch(() => ({}))) as { job?: Job; mode?: RebuildMode; error?: string };
  if (!res.ok || !body.job) throw new CompanionError(body.error ?? `The companion answered ${res.status}`, res.status);
  return { job: body.job, ...(body.mode ? { mode: body.mode } : {}) };
}

/** Job statuses that will change without the user doing anything. */
export const RUNNING_STATUSES: ReadonlySet<Job["status"]> = new Set(["queued", "recording", "rebuilding", "previewing"]);
