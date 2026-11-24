// Content-script side of a capture: DOM, styles, tokens and the MAIN world report.

import type { Capture } from "@kinetic/schema";
import { PATH_SEGMENT_PATTERN } from "@kinetic/schema/patterns";
import { captureDom } from "./dom-capture.ts";
import { requestMainWorldReport } from "./main-world-bridge.ts";
import { type CaptureFile, type CaptureOptions, type CaptureSubmission, type StyleSnapshot, textToBase64 } from "./messages.ts";
import { uniqueSelector } from "./selector.ts";
import { type CapturedNode, captureStyles, collectNodes, computedStyleMap, DefaultStyles, documentBox } from "./style-capture.ts";
import type { StyleMap } from "./style-diff.ts";

const INTERACTIVE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])';
/** Forcing three states on many elements is slow, so only the first few are captured. */
export const MAX_INTERACTIVE = 8;

/** The capture in progress. The background asks for style snapshots of these nodes while it forces states. */
let current: { root: Element; nodes: CapturedNode[] } | undefined;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** A readable, unique folder name such as "button-get-started-m3x9k2". */
export function slugFor(el: Element): string {
  const cls = Array.from(el.classList).find((c) => /^[a-z][a-z0-9-]{2,}$/i.test(c));
  const text = (el.textContent ?? "").trim().split(/\s+/).slice(0, 4).join(" ");
  const hint = el.getAttribute("aria-label") || el.id || cls || text;
  const base = slugify(`${el.localName} ${hint}`) || "component";
  return `${base}-${Date.now().toString(36)}`;
}

export function siteFor(hostname: string): string {
  const site = hostname.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return PATH_SEGMENT_PATTERN.test(site) ? site : "local";
}

/** Interactive elements inside the selection (the root included), in document order. */
export function interactiveElements(root: Element): Element[] {
  const candidates = [root, ...Array.from(root.querySelectorAll("*"))];
  const found = candidates.filter((el) => {
    if (el.matches(INTERACTIVE)) return true;
    // cursor: pointer inherits, so only count the element where it starts.
    const cursor = getComputedStyle(el).cursor;
    const parentCursor = el.parentElement ? getComputedStyle(el.parentElement).cursor : "auto";
    return cursor === "pointer" && (el === root || parentCursor !== "pointer");
  });
  // Skip elements nested inside an interactive element already in the list (an icon inside a link).
  return found.filter((el) => !found.some((other) => other !== el && other.contains(el))).slice(0, MAX_INTERACTIVE);
}

export async function collectCapture(
  root: Element,
  options: CaptureOptions & { slug?: string } = {},
): Promise<CaptureSubmission> {
  root.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  await nextFrame();

  const nodes = collectNodes(root);
  const defaults = new DefaultStyles();
  await defaults.open();
  let styles: Capture["styles"];
  try {
    styles = captureStyles(nodes, defaults);
  } finally {
    defaults.close();
  }

  const rootSelector = nodes[0]?.selector ?? uniqueSelector(root);
  const capture: Capture = {
    // Matches CAPTURE_SCHEMA_VERSION in @kinetic/schema, kept literal so zod stays out of the content script.
    schemaVersion: 1,
    meta: {
      url: location.href,
      site: siteFor(location.hostname),
      slug: options.slug ?? slugFor(root),
      timestamp: new Date().toISOString(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio || 1,
      },
      selector: rootSelector,
      ...(document.title ? { title: document.title } : {}),
    },
    dom: { html: captureDom(root) },
    styles,
  };

  const files: CaptureFile[] = [];
  const report = await requestMainWorldReport(root, rootSelector);
  if (report) {
    Object.assign(capture, report.sections);
    for (const file of report.files) files.push({ path: file.path, contentBase64: textToBase64(file.text) });
  }

  current = { root, nodes };
  return {
    capture,
    files,
    rootSelector,
    interactive: interactiveElements(root).map(uniqueSelector),
    options: { reloadForLoadAnimations: options.reloadForLoadAnimations ?? false },
  };
}

export function finishCapture(): void {
  current = undefined;
}

/** Jumps running CSS transitions to their end so a forced state is read at rest, not mid-transition. */
function finishTransitions(root: Element): void {
  for (const animation of root.getAnimations({ subtree: true })) {
    if ("transitionProperty" in animation) animation.finish();
  }
}

/** Full computed styles of every captured node, read after the background forces a state. */
export async function snapshotCurrent(): Promise<StyleSnapshot | undefined> {
  if (!current) return undefined;
  finishTransitions(current.root);
  await nextFrame();
  const styles: Record<string, StyleMap> = {};
  for (const { el, selector } of current.nodes) styles[selector] = computedStyleMap(el);
  return { styles, box: documentBox(current.root) };
}

/** Two animation frames, or 100 ms if the tab is hidden and frames are paused. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
}
