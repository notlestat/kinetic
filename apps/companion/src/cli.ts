// `pnpm kinetic <command> <site>/<slug>`, run from the repo root.
//
//   preview  renders Component.tsx in the sandbox, records Component.preview.webm and
//            scores each state against the original
//   rebuild  starts a rebuild in the configured mode (handoff writes REBUILD.md)
//
// When the companion is running, the command goes through its job queue, so it never
// overlaps a recording. Otherwise it runs here, against the same library folder.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Capture, type JobStatus, PathSegmentSchema, type Preview } from "@kinetic/schema";
import { loadCompanionEnv, rebuildSettings } from "./env.ts";
import { type JobContext, setJob } from "./jobs.ts";
import { captureDir, readCapture } from "./library.ts";
import { componentExists, DIFF_REPORT, REBUILD_FILE } from "./rebuild-prompt.ts";

const COMPANION = "http://127.0.0.1:4517";
const POLL_MS = 1000;
const WAIT_MS = 20 * 60_000;
const FINISHED: readonly JobStatus[] = ["done", "failed", "awaiting-rebuild"];

const USAGE = `Usage: pnpm kinetic <command> <site>/<slug>

Commands:
  preview   Render Component.tsx in the sandbox, record Component.preview.webm,
            and score each state against the original (writes DIFF.md when over the threshold)
  rebuild   Start a rebuild in KINETIC_REBUILD_MODE (handoff writes REBUILD.md)

Example: pnpm kinetic preview 127.0.0.1/hero`;

class CliError extends Error {}

/** KINETIC_LIBRARY_DIR is relative to where pnpm was run (INIT_CWD), not to apps/companion. */
function libraryDir(): string {
  const value = process.env.KINETIC_LIBRARY_DIR;
  if (value) return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
  return fileURLToPath(new URL("../../../library", import.meta.url));
}

function parseRef(value: string | undefined): { site: string; slug: string } {
  const [site, slug, ...rest] = (value ?? "").split("/");
  if (!site || !slug || rest.length > 0 || !PathSegmentSchema.safeParse(site).success || !PathSegmentSchema.safeParse(slug).success) {
    throw new CliError(`expected <site>/<slug>, for example 127.0.0.1/hero, not "${value ?? ""}"\n\n${USAGE}`);
  }
  return { site, slug };
}

function percent(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

export function formatPreview(ref: string, preview: Preview): string {
  const width = Math.max(5, ...preview.scores.map((s) => s.state.length));
  const lines = [`Preview of ${ref}`];
  for (const s of preview.scores) {
    const result = s.score === undefined ? `not scored: ${s.error ?? "unknown"}` : `${percent(s.score).padStart(6)}  ${s.score <= preview.threshold ? "ok" : "over"}`;
    lines.push(`  ${s.state.padEnd(width)}  ${result}`);
  }
  const over = preview.scores.filter((s) => s.score !== undefined && s.score > preview.threshold).length;
  lines.push("");
  lines.push(
    over > 0
      ? `Threshold ${percent(preview.threshold)}. Over in ${over} state${over === 1 ? "" : "s"}: see ${DIFF_REPORT} and the Fix pass section in ${REBUILD_FILE}.`
      : preview.passed
        ? `Threshold ${percent(preview.threshold)}. Every state passes.`
        : "No state could be scored.",
  );
  if (preview.file) lines.push(`Video: ${preview.file}`);
  for (const warning of preview.warnings ?? []) lines.push(`Note: ${warning}`);
  return lines.join("\n");
}

/** POSTs to the companion. Undefined when it is not running. */
async function post(route: string): Promise<Response | undefined> {
  try {
    return await fetch(`${COMPANION}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } catch {
    return undefined;
  }
}

/** Waits for the capture's job to finish after `since`, reading capture.json through the companion. */
async function waitForJob(site: string, slug: string, since: string): Promise<Capture> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const res = await fetch(`${COMPANION}/captures/${site}/${slug}`);
    if (!res.ok) throw new CliError(`the companion answered ${res.status} while waiting`);
    const { capture } = (await res.json()) as { capture: Capture };
    const job = capture.job;
    if (job && job.updatedAt >= since && FINISHED.includes(job.status)) return capture;
  }
  throw new CliError("timed out waiting for the companion");
}

async function failIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new CliError(`the companion answered ${res.status}: ${body.error ?? res.statusText}`);
}

async function preview(site: string, slug: string): Promise<string> {
  const ref = `${site}/${slug}`;
  const since = new Date().toISOString();
  const res = await post(`/captures/${site}/${slug}/preview`);
  if (res) {
    await failIfNotOk(res);
    console.log(`Previewing ${ref} through the companion…`);
    const capture = await waitForJob(site, slug, since);
    if (capture.job?.status === "failed") throw new CliError(`the preview failed:\n${capture.job.error ?? "no error message"}`);
    if (!capture.preview) throw new CliError("the companion finished without a preview block");
    return formatPreview(ref, capture.preview);
  }

  const dir = captureDir(libraryDir(), site, slug);
  await readCapture(dir).catch(() => {
    throw new CliError(`no capture at ${dir}`);
  });
  if (!(await componentExists(dir))) throw new CliError(`Component.tsx not found in ${dir}. Write it first: see ${REBUILD_FILE}.`);
  console.log(`Previewing ${ref} (the companion is not running, so this runs here)…`);
  const [{ runPreview }, { diffThreshold }] = await Promise.all([import("./preview.ts"), import("./diff.ts")]);
  await setJob(dir, "previewing");
  try {
    const result = await runPreview(dir, { threshold: diffThreshold() });
    await setJob(dir, "done");
    return `${formatPreview(ref, result)}\nFolder: ${dir}`;
  } catch (error) {
    await setJob(dir, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function rebuild(site: string, slug: string): Promise<string> {
  const ref = `${site}/${slug}`;
  const since = new Date().toISOString();
  const res = await post(`/captures/${site}/${slug}/rebuild`);
  if (res) {
    await failIfNotOk(res);
    const { mode } = (await res.json()) as { mode: string };
    console.log(`Rebuilding ${ref} in ${mode} mode through the companion…`);
    const capture = await waitForJob(site, slug, since);
    if (capture.job?.status === "failed") throw new CliError(`the rebuild failed:\n${capture.job.error ?? "no error message"}`);
    return capture.job?.status === "awaiting-rebuild"
      ? `Wrote ${REBUILD_FILE}. Hand it to your coding agent, then run: pnpm kinetic preview ${ref}`
      : capture.preview
        ? formatPreview(ref, capture.preview)
        : `Rebuild finished: ${capture.job?.status ?? "unknown"}`;
  }

  loadCompanionEnv();
  const settings = rebuildSettings();
  const dir = captureDir(libraryDir(), site, slug);
  await readCapture(dir).catch(() => {
    throw new CliError(`no capture at ${dir}`);
  });
  console.log(`Rebuilding ${ref} in ${settings.mode} mode (the companion is not running, so this runs here)…`);
  const { createRebuildJob } = await import("./rebuild.ts");
  const context: JobContext = {
    site,
    slug,
    dir,
    setStatus: async (status) => {
      await setJob(dir, status);
    },
    enqueue: async () => undefined,
  };
  try {
    const status = await createRebuildJob({ settings })(context);
    await setJob(dir, status);
    if (status === "awaiting-rebuild") return `Wrote ${path.join(dir, REBUILD_FILE)}. Hand it to your coding agent, then run: pnpm kinetic preview ${ref}`;
    const capture = await readCapture(dir);
    return capture.preview ? formatPreview(ref, capture.preview) : `Rebuild finished: ${status}`;
  } catch (error) {
    await setJob(dir, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, refArg] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      console.log(USAGE);
      return command ? 0 : 1;
    }
    const { site, slug } = parseRef(refArg);
    if (command === "preview") console.log(await preview(site, slug));
    else if (command === "rebuild") console.log(await rebuild(site, slug));
    else throw new CliError(`unknown command "${command}"\n\n${USAGE}`);
    return 0;
  } catch (error) {
    console.error(`kinetic: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run only when started as a script, not when a test imports formatPreview.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // pnpm passes a literal "--" through when it is used to separate arguments.
  process.exitCode = await main(process.argv.slice(2).filter((a) => a !== "--"));
}
