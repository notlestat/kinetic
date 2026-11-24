// Message shapes shared by the content script, the background worker and the MAIN world.

import type { BoundingBox, Capture } from "@kinetic/schema";
import type { CssMotionReport, MainWorldMotion } from "./motion-records.ts";
import type { StyleMap } from "./style-diff.ts";

export const KINETIC_SOURCE = "kinetic";

// ─── window.postMessage (MAIN world ↔ content script ↔ test pages) ──────────

/** Every window message Kinetic sends or accepts carries source "kinetic" and a "<feature>:<event>" type. */
export interface WindowMessage {
  source: typeof KINETIC_SOURCE;
  type: string;
  [key: string]: unknown;
}

export function isKineticMessage(data: unknown): data is WindowMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === KINETIC_SOURCE &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

/** Posts to the same window. Both worlds share it, so the content script and the MAIN world both see the message. */
export function postToWindow(type: string, payload: Record<string, unknown> = {}): void {
  window.postMessage({ ...payload, source: KINETIC_SOURCE, type }, window.location.origin === "null" ? "*" : window.location.origin);
}

/** The attribute the content script puts on the capture root so the MAIN world can find the same element. */
export const ROOT_ATTRIBUTE = "data-kinetic-capture-root";

// ─── runtime messages (content script ↔ background) ─────────────────────────

export interface CaptureOptions {
  /** Reload the page with the Animation domain on, to catch load animations. Off by default. */
  reloadForLoadAnimations?: boolean;
}

/** The trigger the background is firing while it asks the MAIN world for running motion. */
export type MotionPassTrigger = "hover" | "focus" | "load";

/** A file saved next to capture.json through POST /capture/file. */
export interface CaptureFile {
  /** Relative path inside the capture folder, e.g. "states/hover-0.png". */
  path: string;
  contentBase64: string;
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * What the MAIN world returns for a capture: finished capture sections (motion,
 * framework, three, assets) and text files such as three/scene.json.
 */
export interface MainWorldReport {
  sections: Partial<Pick<Capture, "framework" | "three" | "assets">>;
  /** Text files, or binary files (downloaded assets) as base64. */
  files: ({ path: string; text: string } | { path: string; base64: string })[];
  /** Raw motion records. The background normalises them together with the Animation domain's. */
  motion?: MainWorldMotion;
}

/** What the content script hands to the background after collecting DOM and styles. */
export interface CaptureSubmission {
  capture: Capture;
  /** Files collected in the page, sent after capture.json. */
  files: CaptureFile[];
  /** The capture root, the same as capture.meta.selector. */
  rootSelector: string;
  /** Interactive elements inside the selection, in document order. */
  interactive: string[];
  options: CaptureOptions;
  /** Motion the MAIN world saw when the capture started. */
  motion: MainWorldMotion | undefined;
  /** @keyframes and transitions from the stylesheets. */
  cssMotion: CssMotionReport;
}

export interface StyleSnapshot {
  /** Selector → full computed styles of every node in the selection. */
  styles: Record<string, StyleMap>;
  /** Root bounding box in document coordinates. */
  box: BoundingBox;
}

export type CaptureOutcome = (
  | { ok: true; saved: "companion"; path: string }
  | { ok: true; saved: "queued"; reason: string }
  | { ok: false; error: string }
) & {
  /** Test builds only: raw inputs for recording fixtures. */
  debug?: unknown;
};

export type RuntimeMessage =
  | { type: "picker:toggle" }
  | { type: "capture:submit"; submission: CaptureSubmission }
  | { type: "capture:snapshot" }
  | { type: "capture:collect-motion"; rootSelector: string }
  | { type: "capture:watch"; trigger: MotionPassTrigger }
  | { type: "capture:ping" }
  // Test builds only.
  | { type: "test:companion"; url?: string }
  | { type: "test:retry" };
