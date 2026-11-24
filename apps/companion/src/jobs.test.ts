import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobStatus } from "@kinetic/schema";
import sample from "@kinetic/schema/fixtures/sample-capture.json" with { type: "json" };
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failInterruptedJobs, JobQueue, setJob } from "./jobs.ts";
import { writeJson } from "./library.ts";

let libraryDir: string;

beforeEach(async () => {
  libraryDir = await mkdtemp(path.join(tmpdir(), "kinetic-jobs-"));
});

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true });
});

async function addCapture(slug: string): Promise<string> {
  const dir = path.join(libraryDir, "example.com", slug);
  await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "capture.json"), { ...sample, meta: { ...sample.meta, slug } });
  return dir;
}

async function statusOf(dir: string): Promise<JobStatus | undefined> {
  return JSON.parse(await readFile(path.join(dir, "capture.json"), "utf8")).job?.status;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("JobQueue", () => {
  it("runs one job at a time, in order, writing each status to capture.json", async () => {
    const a = await addCapture("a");
    const b = await addCapture("b");
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const gate = deferred();
    const queue = new JobQueue({
      libraryDir,
      handlers: {
        record: async ({ slug, setStatus }) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          order.push(`start ${slug}`);
          await setStatus("recording");
          if (slug === "a") await gate.promise;
          order.push(`end ${slug}`);
          running--;
          return "done";
        },
      },
    });
    await queue.enqueue("example.com", "a", "record");
    await queue.enqueue("example.com", "b", "record");
    await new Promise((r) => setTimeout(r, 20));
    expect(await statusOf(a)).toBe("recording");
    expect(await statusOf(b)).toBe("queued");
    gate.resolve();
    await queue.idle();
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
    expect(maxRunning).toBe(1);
    expect(await statusOf(a)).toBe("done");
    expect(await statusOf(b)).toBe("done");
  });

  it("does not queue the same job twice while it waits", async () => {
    await addCapture("a");
    await addCapture("b");
    const gate = deferred();
    const runs: string[] = [];
    const queue = new JobQueue({
      libraryDir,
      handlers: {
        record: async ({ slug }) => {
          runs.push(slug);
          if (slug === "a") await gate.promise;
          return "done";
        },
      },
    });
    await queue.enqueue("example.com", "a", "record");
    await queue.enqueue("example.com", "b", "record");
    await queue.enqueue("example.com", "b", "record");
    expect(queue.size).toBe(2);
    gate.resolve();
    await queue.idle();
    expect(runs).toEqual(["a", "b"]);
  });

  it("writes failed plus the error, and keeps going with the next job", async () => {
    const a = await addCapture("a");
    const b = await addCapture("b");
    const errors: string[] = [];
    const queue = new JobQueue({
      libraryDir,
      onError: (message) => errors.push(message),
      handlers: {
        record: async ({ slug }) => {
          if (slug === "a") throw new Error("page did not load");
          return "done";
        },
      },
    });
    await queue.enqueue("example.com", "a", "record");
    await queue.enqueue("example.com", "b", "record");
    await queue.idle();
    const job = JSON.parse(await readFile(path.join(a, "capture.json"), "utf8")).job;
    expect(job).toMatchObject({ status: "failed", error: "page did not load" });
    expect(job.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await statusOf(b)).toBe("done");
    expect(errors).toEqual(["record job failed for example.com/a"]);
  });

  it("lets a job queue a follow-up job for the same capture, which runs after it", async () => {
    const a = await addCapture("a");
    const runs: string[] = [];
    const queue = new JobQueue({
      libraryDir,
      handlers: {
        record: async ({ enqueue }) => {
          runs.push("record");
          await enqueue("rebuild");
          return "awaiting-rebuild";
        },
        rebuild: async ({ setStatus }) => {
          runs.push("rebuild");
          expect(await statusOf(a)).toBe("awaiting-rebuild");
          await setStatus("rebuilding");
          return "done";
        },
      },
    });
    await queue.enqueue("example.com", "a", "record");
    await queue.idle();
    expect(runs).toEqual(["record", "rebuild"]);
    expect(await statusOf(a)).toBe("done");
  });

  it("refuses unknown kinds and unsafe names", async () => {
    const queue = new JobQueue({ libraryDir, handlers: {} });
    await expect(queue.enqueue("example.com", "a", "record")).rejects.toThrow("no handler");
    const withHandler = new JobQueue({ libraryDir, handlers: { record: async () => "done" } });
    await expect(withHandler.enqueue("..", "a", "record")).rejects.toThrow();
  });
});

describe("failInterruptedJobs", () => {
  it("marks queued, recording, rebuilding and previewing captures failed and leaves the rest", async () => {
    const recording = await addCapture("recording");
    const previewing = await addCapture("previewing");
    const waiting = await addCapture("waiting");
    const done = await addCapture("done");
    const none = await addCapture("none");
    await setJob(recording, "recording");
    await setJob(previewing, "previewing");
    await setJob(waiting, "awaiting-rebuild");
    await setJob(done, "done");
    expect(await failInterruptedJobs(libraryDir)).toBe(2);
    expect(await statusOf(recording)).toBe("failed");
    expect(await statusOf(previewing)).toBe("failed");
    expect(await statusOf(waiting)).toBe("awaiting-rebuild");
    expect(await statusOf(done)).toBe("done");
    expect(await statusOf(none)).toBeUndefined();
  });
});
