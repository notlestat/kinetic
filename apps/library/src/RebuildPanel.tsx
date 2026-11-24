import { useState } from "react";
import { type CaptureDetail, RUNNING_STATUSES, startJob } from "./api.ts";
import { CopyButton } from "./parts.tsx";

const MODE_LABELS = { handoff: "Hand-off", "claude-cli": "Claude Code CLI", api: "Claude API" } as const;

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  recording: "Recording",
  "awaiting-rebuild": "Waiting for Component.tsx",
  rebuilding: "Rebuilding",
  previewing: "Previewing",
  done: "Done",
  failed: "Failed",
};

/**
 * Hand-off copies the instruction for the user's own agent. claude-cli and api
 * modes start the rebuild on the companion. Every mode can run a preview once
 * Component.tsx exists.
 */
export function RebuildPanel({ detail, onStarted }: { detail: CaptureDetail; onStarted: () => void }) {
  const { capture, rebuild, files } = detail;
  const { site, slug } = capture.meta;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const has = (path: string) => files.some((f) => f.path === path);
  const job = capture.job;
  const running = job !== undefined && RUNNING_STATUSES.has(job.status);

  const start = async (action: "rebuild" | "preview") => {
    setBusy(true);
    setError(undefined);
    try {
      await startJob(site, slug, action);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="rebuild-title">
      <div className="section-head">
        <h2 id="rebuild-title">Rebuild</h2>
        <span className="mode">{MODE_LABELS[rebuild.mode]} mode</span>
      </div>

      {job && (
        <p className="job" role="status">
          <span className={`status status-${job.status}`}>{STATUS_LABELS[job.status] ?? job.status}</span>
          {capture.rebuild?.fixPasses ? <span className="muted"> · {capture.rebuild.fixPasses} automatic fix pass</span> : null}
        </p>
      )}
      {job?.status === "failed" && job.error && <pre className="error-output">{job.error}</pre>}

      {rebuild.mode === "handoff" ? (
        <>
          <p>Paste this into your coding agent. It writes Component.tsx and NOTES.md, then runs the preview.</p>
          <pre className="handoff">{rebuild.handoff}</pre>
          <div className="actions">
            <CopyButton text={rebuild.handoff} label="Copy hand-off" />
            {!has("REBUILD.md") && (
              <button type="button" className="button" disabled={busy || running} onClick={() => start("rebuild")}>
                Write REBUILD.md
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="actions">
          <button type="button" className="button primary" disabled={busy || running} onClick={() => start("rebuild")}>
            {rebuild.mode === "claude-cli" ? "Start CLI rebuild" : "Start API rebuild"}
          </button>
          <span className="muted">Writes Component.tsx and NOTES.md, previews, and runs one fix pass if a state is over the threshold.</span>
        </div>
      )}

      <div className="actions">
        <button type="button" className="button" disabled={busy || running || !has("Component.tsx")} onClick={() => start("preview")}>
          Run preview
        </button>
        {!has("Component.tsx") && <span className="muted">Needs Component.tsx.</span>}
        {has("DIFF.md") && (
          <a className="button quiet" href={detail.files.find((f) => f.path === "DIFF.md")?.url} target="_blank" rel="noreferrer">
            Open DIFF.md
          </a>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
