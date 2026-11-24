// The "record" job: records original.webm, merges the scroll and frame-sampled
// entries into motion.json and capture.json, then writes REBUILD.md so the capture is
// ready to rebuild. The "preview" job renders an existing Component.tsx and scores it.

import path from "node:path";
import type { JobStatus, Preview } from "@kinetic/schema";
import type { JobContext } from "./jobs.ts";
import { readCapture, updateCapture, writeJson } from "./library.ts";
import { writeRebuildPrompt } from "./rebuild-prompt.ts";
import type { RecordOptions, RecordResult } from "./recorder.ts";
import { mergeSampledMotion } from "./sampling.ts";

export type Recorder = (options: RecordOptions) => Promise<RecordResult>;

/** Playwright loads only when the first recording starts, so the server starts fast and tests can swap the recorder. */
const loadRecorder: Recorder = async (options) => (await import("./recorder.ts")).recordCapture(options);

export interface RecordJobOptions {
  /** Queue a rebuild once the recording is done (KINETIC_AUTO_REBUILD=1 in claude-cli or api mode). */
  autoRebuild?: boolean;
}

export function createRecordJob(record: Recorder = loadRecorder, { autoRebuild = false }: RecordJobOptions = {}) {
  return async function recordJob({ dir, setStatus, enqueue }: JobContext): Promise<JobStatus> {
    await setStatus("recording");
    const capture = await readCapture(dir);
    const { drafts, recording } = await record({ capture, dir });
    // Merge into capture.json as it is now, in case a new capture arrived while recording.
    const updated = await updateCapture(dir, async (current) => {
      const motion = mergeSampledMotion(current.motion, drafts);
      await writeJson(path.join(dir, "motion.json"), motion);
      return { ...current, motion, recording, media: { ...current.media, original: recording.file, motion: "motion.json" } };
    });
    await writeRebuildPrompt(dir, updated);
    if (autoRebuild) await enqueue("rebuild");
    return "awaiting-rebuild";
  };
}

export type Previewer = (dir: string) => Promise<Preview>;

/** Previews run in the job queue so they never overlap a recording of the same capture. */
export function createPreviewJob(preview: Previewer) {
  return async function previewJob({ dir, setStatus }: JobContext): Promise<JobStatus> {
    await setStatus("previewing");
    await preview(dir);
    return "done";
  };
}
