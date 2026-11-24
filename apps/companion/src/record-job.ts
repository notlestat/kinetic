// The "record" job: records original.webm and merges the scroll and frame-sampled
// entries into motion.json and capture.json.

import path from "node:path";
import type { JobContext } from "./jobs.ts";
import { readCapture, updateCapture, writeJson } from "./library.ts";
import type { RecordOptions, RecordResult } from "./recorder.ts";
import { mergeSampledMotion } from "./sampling.ts";

export type Recorder = (options: RecordOptions) => Promise<RecordResult>;

/** Playwright loads only when the first recording starts, so the server starts fast and tests can swap the recorder. */
const loadRecorder: Recorder = async (options) => (await import("./recorder.ts")).recordCapture(options);

export function createRecordJob(record: Recorder = loadRecorder) {
  return async function recordJob({ dir, setStatus }: JobContext) {
    await setStatus("recording");
    const capture = await readCapture(dir);
    const { drafts, recording } = await record({ capture, dir });
    // Merge into capture.json as it is now, in case a new capture arrived while recording.
    await updateCapture(dir, async (current) => {
      const motion = mergeSampledMotion(current.motion, drafts);
      await writeJson(path.join(dir, "motion.json"), motion);
      return { ...current, motion, recording, media: { ...current.media, original: recording.file, motion: "motion.json" } };
    });
    return "done" as const;
  };
}
