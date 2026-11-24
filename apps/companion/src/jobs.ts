// The companion's job queue: captures are processed one at a time, in the order
// they were queued, and each job's status is written to its capture.json as it moves
// through queued → recording → … → done, or failed with the error.

import type { Job, JobStatus } from "@kinetic/schema";
import { captureDir, listCaptureRefs, readCapture, updateCapture } from "./library.ts";

export type JobKind = "record";

export interface JobContext {
  site: string;
  slug: string;
  /** Absolute path of the capture folder. */
  dir: string;
  /** Writes an intermediate status, such as "recording". */
  setStatus(status: JobStatus): Promise<void>;
}

/** Does the work and returns the status to finish with. Throwing marks the job failed. */
export type JobHandler = (context: JobContext) => Promise<JobStatus>;

export interface JobQueueOptions {
  libraryDir: string;
  handlers: Partial<Record<JobKind, JobHandler>>;
  /** Where failures are reported. Defaults to console.error. */
  onError?: (message: string, error: unknown) => void;
}

interface QueuedJob {
  site: string;
  slug: string;
  dir: string;
  kind: JobKind;
}

const MAX_ERROR_LENGTH = 2000;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/** Writes the job block into capture.json. */
export function setJob(dir: string, status: JobStatus, error?: string): Promise<Job> {
  const job: Job = { status, ...(error !== undefined ? { error } : {}), updatedAt: new Date().toISOString() };
  return updateCapture(dir, (capture) => ({ ...capture, job })).then(() => job);
}

export class JobQueue {
  readonly #libraryDir: string;
  readonly #handlers: Partial<Record<JobKind, JobHandler>>;
  readonly #onError: (message: string, error: unknown) => void;
  readonly #waiting: QueuedJob[] = [];
  #running: QueuedJob | undefined;
  #idleWaiters: (() => void)[] = [];

  constructor({ libraryDir, handlers, onError }: JobQueueOptions) {
    this.#libraryDir = libraryDir;
    this.#handlers = handlers;
    this.#onError = onError ?? ((message, error) => console.error(`[kinetic] ${message}`, error));
  }

  /** True when a handler for this kind of job is set up. */
  handles(kind: JobKind): boolean {
    return this.#handlers[kind] !== undefined;
  }

  /**
   * Queues a job for a capture. A job of the same kind already waiting for the same
   * capture is not queued twice. Writes "queued" to capture.json unless that capture
   * is being processed right now, in which case the new job runs after it.
   */
  async enqueue(site: string, slug: string, kind: JobKind): Promise<Job> {
    const dir = captureDir(this.#libraryDir, site, slug);
    if (!this.#handlers[kind]) throw new Error(`no handler for ${kind} jobs`);
    const waiting = this.#waiting.some((j) => j.dir === dir && j.kind === kind);
    const busy = this.#running?.dir === dir;
    let job: Job;
    if (busy || waiting) {
      job = (await readCapture(dir)).job ?? { status: "queued", updatedAt: new Date().toISOString() };
    } else {
      job = await setJob(dir, "queued");
    }
    if (!waiting) this.#waiting.push({ site, slug, dir, kind });
    this.#pump();
    return job;
  }

  /** Jobs waiting or running. */
  get size(): number {
    return this.#waiting.length + (this.#running ? 1 : 0);
  }

  /** Resolves once nothing is waiting or running. */
  idle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #pump(): void {
    if (this.#running) return;
    const next = this.#waiting.shift();
    if (!next) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    this.#running = next;
    void this.#run(next).finally(() => {
      this.#running = undefined;
      this.#pump();
    });
  }

  async #run(job: QueuedJob): Promise<void> {
    const handler = this.#handlers[job.kind] as JobHandler;
    const setStatus = async (status: JobStatus) => {
      await setJob(job.dir, status);
    };
    try {
      const final = await handler({ site: job.site, slug: job.slug, dir: job.dir, setStatus });
      await setStatus(final);
    } catch (error) {
      this.#onError(`${job.kind} job failed for ${job.site}/${job.slug}`, error);
      await setJob(job.dir, "failed", errorMessage(error)).catch((writeError: unknown) => this.#onError("could not write the failed status", writeError));
    }
  }
}

const UNFINISHED: readonly JobStatus[] = ["queued", "recording", "rebuilding"];

/**
 * After a restart nothing is running, so a capture still marked queued, recording or
 * rebuilding was interrupted. Marks those failed so the status is not left hanging.
 */
export async function failInterruptedJobs(libraryDir: string): Promise<number> {
  let count = 0;
  for (const ref of await listCaptureRefs(libraryDir)) {
    try {
      const status = (await readCapture(ref.dir)).job?.status;
      if (status && UNFINISHED.includes(status)) {
        await setJob(ref.dir, "failed", "The companion stopped before this job finished. Start it again.");
        count++;
      }
    } catch {
      // An unreadable capture.json is reported when it is listed, not here.
    }
  }
  return count;
}
