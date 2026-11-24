import { type ReactNode, useEffect } from "react";
import { type CaptureDetail, getCapture, getText, RUNNING_STATUSES } from "./api.ts";
import { type Load, useLoad } from "./hooks.ts";
import { CodeView, ComponentTree, CopyButton, Markdown, StateShots, Tokens } from "./parts.tsx";
import { RebuildPanel } from "./RebuildPanel.tsx";
import { SyncedVideos } from "./SyncedVideos.tsx";
import { Timeline } from "./Timeline.tsx";

const POLL_MS = 2000;

export function Detail({ site, slug }: { site: string; slug: string }) {
  const [result, reload] = useLoad(`${site}/${slug}`, (signal) => getCapture(site, slug, signal));

  // While a job runs, read the capture again every two seconds to show its progress.
  const status = result.state === "ready" ? result.data.capture.job?.status : undefined;
  useEffect(() => {
    if (!status || !RUNNING_STATUSES.has(status)) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [status, reload]);

  useEffect(() => {
    if (result.state === "ready") document.title = `${result.data.capture.meta.slug} · Kinetic library`;
  }, [result]);

  return (
    <article className="detail">
      <p>
        <a className="back" href="#/">
          ← All captures
        </a>
      </p>
      {result.state === "loading" && <p className="muted">Loading…</p>}
      {result.state === "error" && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      {result.state === "ready" && <DetailBody detail={result.data} reload={reload} />}
    </article>
  );
}

function DetailBody({ detail, reload }: { detail: CaptureDetail; reload: () => void }) {
  const { capture, media, files } = detail;
  const fileUrl = (path: string) => files.find((f) => f.path === path)?.url;
  const componentUrl = fileUrl("Component.tsx");
  const notesUrl = fileUrl("NOTES.md");
  // Keyed by size and URL, so a new Component.tsx or NOTES.md from a rebuild is read again.
  const componentKey = `${componentUrl}:${files.find((f) => f.path === "Component.tsx")?.size}`;
  const notesKey = `${notesUrl}:${files.find((f) => f.path === "NOTES.md")?.size}`;
  const [component] = useLoad(componentKey, (signal) => (componentUrl ? getText(componentUrl, signal) : Promise.resolve("")));
  const [notes] = useLoad(notesKey, (signal) => (notesUrl ? getText(notesUrl, signal) : Promise.resolve("")));
  const name = detail.componentName;

  return (
    <>
      <header className="detail-head">
        <h1>{name}</h1>
        <p className="detail-meta">
          <span>{capture.meta.site}</span>
          <a href={capture.meta.url} target="_blank" rel="noreferrer noopener">
            {capture.meta.title ?? capture.meta.url}
          </a>
          <code>{capture.meta.selector}</code>
          <time dateTime={capture.meta.timestamp}>{new Date(capture.meta.timestamp).toLocaleString()}</time>
        </p>
      </header>

      {media.original ? <SyncedVideos original={media.original} rebuild={media.preview} /> : <p className="muted">Not recorded yet, so there is no video.</p>}

      <RebuildPanel detail={detail} onStarted={reload} />
      <StateShots capture={capture} fileUrl={fileUrl} />
      <Timeline entries={capture.motion?.entries ?? []} />

      <div className="columns">
        <Tokens capture={capture} />
        <ComponentTree capture={capture} />
      </div>

      <section aria-labelledby="notes-title">
        <h2 id="notes-title">Taste note</h2>
        <TextLoad load={notes} empty="No NOTES.md yet. The rebuild writes it." render={(text) => <Markdown source={text} />} />
      </section>

      <section aria-labelledby="code-title">
        <div className="section-head">
          <h2 id="code-title">Component.tsx</h2>
          {component.state === "ready" && component.data && <CopyButton text={component.data} label="Copy Component.tsx" />}
        </div>
        <TextLoad load={component} empty="No Component.tsx yet." render={(text) => <CodeView source={text} />} />
      </section>
    </>
  );
}

function TextLoad({ load, empty, render }: { load: Load<string>; empty: string; render: (text: string) => ReactNode }) {
  if (load.state === "loading") return <p className="muted">Loading…</p>;
  if (load.state === "error") return <p className="error">{load.error}</p>;
  return load.data ? render(load.data) : <p className="muted">{empty}</p>;
}
