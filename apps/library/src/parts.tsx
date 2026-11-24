import type { Capture, Framework, Tokens as TokenGroups } from "@kinetic/schema";
import { funnelFirstFileName, toFunnelFirstTokens } from "@kinetic/schema/export-funnel-first";
import { type ReactNode, useState } from "react";
import { tokenize } from "./highlight.ts";
import { copyText } from "./hooks.ts";
import { parseInline, parseMarkdown } from "./markdown.ts";
import { lastPart } from "./timeline.ts";

/** A button that copies text and says so for two seconds. */
export function CopyButton({ text, label, className = "button" }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        setState((await copyText(text)) ? "copied" : "failed");
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}</span>
    </button>
  );
}

interface Shot {
  key: string;
  label: string;
  original: string;
  score?: { value?: number; preview?: string; diff?: string; error?: string; over: boolean };
}

export function StateShots({ capture, fileUrl }: { capture: Capture; fileUrl: (path: string) => string | undefined }) {
  const scores = new Map((capture.preview?.scores ?? []).map((s) => [s.original, s]));
  const threshold = capture.preview?.threshold ?? 0.1;
  const shots: Shot[] = [];
  const add = (key: string, label: string, original: string | undefined) => {
    if (!original) return;
    const s = scores.get(original);
    shots.push({
      key,
      label,
      original,
      ...(s
        ? {
            score: {
              ...(s.score !== undefined ? { value: s.score } : {}),
              ...(s.preview ? { preview: s.preview } : {}),
              ...(s.diff ? { diff: s.diff } : {}),
              ...(s.error ? { error: s.error } : {}),
              over: s.score !== undefined && s.score > threshold,
            },
          }
        : {}),
    });
  };
  add("default", "Default", capture.media?.screenshot);
  (capture.states ?? []).forEach((state, i) => add(`${state.name}-${i}`, state.name === "mobile" ? "Mobile" : `${state.name} · ${lastPart(state.target)}`, state.screenshot));

  return (
    <section aria-labelledby="states-title">
      <h2 id="states-title">States</h2>
      {capture.preview && (
        <p className="muted">
          Pixel difference against the rebuild; over {(threshold * 100).toFixed(0)}% is flagged. {capture.preview.passed ? "Every scored state passes." : "See DIFF.md for the fix pass."}
        </p>
      )}
      {shots.length === 0 ? (
        <p className="muted">No state screenshots.</p>
      ) : (
        <ul className="shots">
          {shots.map((shot) => (
            <li key={shot.key} className="shot">
              <h3>
                <span>{shot.label}</span>
                {shot.score?.value !== undefined && (
                  <span className={`score ${shot.score.over ? "score-over" : "score-ok"}`}>
                    {(shot.score.value * 100).toFixed(1)}%{shot.score.over ? " over" : ""}
                  </span>
                )}
              </h3>
              <div className="shot-images">
                <ShotImage src={fileUrl(shot.original)} caption="Original" />
                {shot.score?.preview && <ShotImage src={fileUrl(shot.score.preview)} caption="Rebuild" />}
                {shot.score?.diff && <ShotImage src={fileUrl(shot.score.diff)} caption="Difference" />}
              </div>
              {shot.score?.error && <p className="muted">Not scored: {shot.score.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ShotImage({ src, caption }: { src: string | undefined; caption: string }) {
  if (!src) return null;
  return (
    <figure>
      <a href={src} target="_blank" rel="noreferrer">
        <img src={src} alt={`${caption} screenshot`} loading="lazy" />
      </a>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

// Captured values come from other sites, so a swatch is drawn only for plain colour syntax (never url()).
const SAFE_COLOUR = /^(#[\da-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([-\d\s.,%/+a-z]*\)|[a-z]+)$/i;

const TOKEN_GROUPS: [keyof TokenGroups, string][] = [
  ["colors", "Colours"],
  ["fontSizes", "Font sizes"],
  ["spacing", "Spacing"],
  ["radii", "Radii"],
  ["shadows", "Shadows"],
];

export function Tokens({ capture }: { capture: Capture }) {
  const tokens = capture.styles?.tokens;
  const fonts = capture.styles?.fonts ?? [];
  const groups = TOKEN_GROUPS.map(([key, label]) => [key, label, Object.entries(tokens?.[key] ?? {})] as const).filter(([, , list]) => list.length > 0);

  return (
    <section aria-labelledby="tokens-title">
      <div className="section-head">
        <h2 id="tokens-title">Tokens</h2>
        <ExportButton capture={capture} />
      </div>
      {groups.length === 0 && fonts.length === 0 && <p className="muted">No tokens were captured.</p>}
      {groups.map(([key, label, list]) => (
        <div key={key} className="token-group">
          <h3>{label}</h3>
          <dl className="tokens">
            {list.map(([name, value]) => (
              <div key={name} className="token">
                <dt>
                  <code>--{name}</code>
                </dt>
                <dd>
                  {key === "colors" && SAFE_COLOUR.test(value) && <span className="swatch" style={{ background: value }} aria-hidden="true" />}
                  <code>{value}</code>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {fonts.length > 0 && (
        <div className="token-group">
          <h3>Fonts</h3>
          <ul className="plain-list">
            {[...new Set(fonts.map((f) => `${f.family} ${f.weight} ${f.style}`))].map((font) => (
              <li key={font}>
                <code>{font}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Downloads the tokens in funnel-first's format. The adapter is a placeholder until that format is provided. */
function ExportButton({ capture }: { capture: Capture }) {
  const download = () => {
    const blob = new Blob([`${JSON.stringify(toFunnelFirstTokens(capture), null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = funnelFirstFileName(capture);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <button type="button" className="button" onClick={download} title="Placeholder format until the funnel-first format file is added">
      Export for funnel-first
    </button>
  );
}

type TreeNode = { id: string; name: string; minified: boolean; domNodes: number; children: TreeNode[] };

function buildTree(framework: Framework): TreeNode[] {
  const nodes = new Map<string, TreeNode>(framework.components.map((c) => [c.id, { id: c.id, name: c.name, minified: c.minified, domNodes: c.domNodes.length, children: [] }]));
  const roots: TreeNode[] = [];
  for (const c of framework.components) {
    const node = nodes.get(c.id);
    const parent = c.parentId === null ? undefined : nodes.get(c.parentId);
    if (!node) continue;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function TreeList({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <li key={node.id}>
          <code>{node.name}</code>
          {node.minified && <span className="muted"> (minified)</span>}
          {node.domNodes > 0 && <span className="muted"> · {node.domNodes} DOM</span>}
          {node.children.length > 0 && <TreeList nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}

export function ComponentTree({ capture }: { capture: Capture }) {
  const framework = capture.framework;
  const roots = framework ? buildTree(framework) : [];
  const split = framework?.suggestedSplit ?? [];
  return (
    <section aria-labelledby="tree-title">
      <h2 id="tree-title">Component tree</h2>
      {framework && framework.kind !== "none" && <p className="muted">From the page's {framework.kind === "react" ? "React" : "Vue"} tree.</p>}
      {roots.length > 0 && <TreeList nodes={roots} />}
      {split.length > 0 && (
        <>
          <h3>Suggested split</h3>
          <ul className="tree">
            {split.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code>
                <span className="muted"> · {s.domNodes.map(lastPart).join(", ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {roots.length === 0 && split.length === 0 && <p className="muted">No component structure was captured.</p>}
    </section>
  );
}

function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.kind === "code" ? <code key={i}>{part.text}</code> : part.kind === "strong" ? <strong key={i}>{part.text}</strong> : part.kind === "em" ? <em key={i}>{part.text}</em> : part.text,
      )}
    </>
  );
}

/** NOTES.md as headings, paragraphs and lists, rendered as text. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      {parseMarkdown(source).map((block, i): ReactNode => {
        switch (block.kind) {
          case "heading": {
            // The page already has h1 and h2, so note headings start at h3.
            const Tag = (["h3", "h4", "h5", "h6"] as const)[block.level - 1] ?? "h6";
            return (
              <Tag key={i}>
                <InlineText text={block.text} />
              </Tag>
            );
          }
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <InlineText text={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "quote":
            return (
              <blockquote key={i}>
                <InlineText text={block.text} />
              </blockquote>
            );
          case "code":
            return (
              <pre key={i}>
                <code>{block.text}</code>
              </pre>
            );
          default:
            return (
              <p key={i}>
                <InlineText text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}

/** Component.tsx as highlighted text. It is never imported, evaluated or rendered here. */
export function CodeView({ source }: { source: string }) {
  return (
    <pre className="code" tabIndex={0} aria-label="Component.tsx source">
      <code>
        {tokenize(source).map((token, i) =>
          token.kind === "plain" ? (
            token.text
          ) : (
            <span key={i} className={`tok-${token.kind}`}>
              {token.text}
            </span>
          ),
        )}
      </code>
    </pre>
  );
}
