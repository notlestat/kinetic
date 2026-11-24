// Animation assets (Lottie, dotLottie, Rive, Spline): what the MAIN world and the
// Network domain find, how files are named in assets/, and the motion entries they
// produce. Pure, so it is unit tested without a page.

import type { Asset } from "@kinetic/schema";
import type { KeyedDraft } from "./motion-normalise.ts";

export type AnimationAssetKind = "lottie" | "dotlottie" | "rive" | "spline";

/** Playback settings read from the player, when the page exposes them. */
export interface AssetPlayback {
  loop?: boolean | number;
  autoplay?: boolean;
  /** Plays on hover (lottie-player's hover attribute). */
  hover?: boolean;
  speed?: number;
  /** 1 forward, -1 backward. */
  direction?: number;
}

/** Timing read from a Lottie file. */
export interface LottieTiming {
  frameRate: number;
  inPoint: number;
  outPoint: number;
  width: number;
  height: number;
  layers: number;
  markers: string[];
  name?: string;
}

/** One animation asset found for the selection. */
export interface AssetRecord {
  kind: AnimationAssetKind;
  /** Absolute URL, or the page URL with a #kinetic-inline-… fragment for inline animation data. */
  url: string;
  /** Selector of the element that shows the animation, or null when only the URL is known. */
  target: string | null;
  /** How it was found: "lottie-web", "lottie-player", "spline-viewer", "resource-timing", "network", … */
  foundBy: string;
  playback?: AssetPlayback;
  timing?: LottieTiming;
  /** The saved copy, relative to the capture folder. */
  file?: string;
}

/** Guesses an asset kind from a URL's path. JSON is only a Lottie once its content says so. */
export function assetKindForUrl(url: string): AnimationAssetKind | "json" | undefined {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  if (path.endsWith(".lottie")) return "dotlottie";
  if (path.endsWith(".riv")) return "rive";
  if (path.endsWith(".splinecode")) return "spline";
  if (path.endsWith(".json")) return "json";
  return undefined;
}

/** True when parsed JSON has the fields every Lottie file has: version, frame rate, in and out points, layers. */
export function isLottieJson(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.v === "string" && typeof v.fr === "number" && typeof v.ip === "number" && typeof v.op === "number" && Array.isArray(v.layers);
}

export function lottieTiming(json: Record<string, unknown>): LottieTiming {
  const markers = Array.isArray(json.markers)
    ? json.markers.map((m) => (typeof m === "object" && m !== null ? String((m as { cm?: unknown }).cm ?? "") : "")).filter(Boolean)
    : [];
  return {
    frameRate: Number(json.fr),
    inPoint: Number(json.ip),
    outPoint: Number(json.op),
    width: Number(json.w) || 0,
    height: Number(json.h) || 0,
    layers: Array.isArray(json.layers) ? json.layers.length : 0,
    markers,
    ...(typeof json.nm === "string" && json.nm ? { name: json.nm } : {}),
  };
}

const EXTENSIONS: Record<AnimationAssetKind, string> = { lottie: "json", dotlottie: "lottie", rive: "riv", spline: "splinecode" };

/** A safe file name in assets/ for an asset: the URL's base name when it has one, the kind and index otherwise. */
export function assetFileName(url: string, kind: AnimationAssetKind, index: number): string {
  let base = "";
  try {
    const parsed = new URL(url);
    if (!parsed.hash.startsWith("#kinetic-inline")) base = parsed.pathname.split("/").pop() ?? "";
  } catch {
    // Not a URL; fall back to the kind.
  }
  base = base.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `assets/${base || kind}-${index + 1}.${EXTENSIONS[kind]}`;
}

/** Merges records for the same URL, keeping the first target, file, timing and playback found. */
export function mergeAssetRecords(...groups: readonly (readonly AssetRecord[])[]): AssetRecord[] {
  const byUrl = new Map<string, AssetRecord>();
  for (const group of groups) {
    for (const record of group) {
      const existing = byUrl.get(record.url);
      if (!existing) {
        byUrl.set(record.url, { ...record });
        continue;
      }
      existing.target ??= record.target;
      if (!existing.file && record.file) existing.file = record.file;
      if (!existing.timing && record.timing) existing.timing = record.timing;
      if (!existing.playback && record.playback) existing.playback = record.playback;
    }
  }
  return [...byUrl.values()];
}

/** The assets block for capture.json. */
export function toAssetsBlock(records: readonly AssetRecord[]): Asset[] {
  return records.map((r) => ({ kind: r.kind, url: r.url, ...(r.file ? { file: r.file } : {}) }));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * One motion entry per animation asset with a target. Lottie timing is exact
 * when the file was read: duration is (out point - in point) / frame rate.
 * Rive and Spline files are not parsed, so their entries only say where the
 * animation runs and where its file is.
 */
export function fromAssetRecords(records: readonly AssetRecord[]): KeyedDraft[] {
  const drafts: KeyedDraft[] = [];
  for (const record of records) {
    if (!record.target) continue;
    const playback = record.playback ?? {};
    // Players autoplay unless told otherwise (lottie-web, lottie-player and Spline all default to playing).
    const trigger = playback.hover ? "hover" : playback.autoplay === false ? "unknown" : "load";
    const loop = playback.loop;
    const iterations = loop === true ? "infinite" : typeof loop === "number" && loop > 0 ? loop + 1 : 1;
    const raw = { url: record.url, foundBy: record.foundBy, ...(record.file ? { file: record.file } : {}), ...(record.playback ? { playback: record.playback } : {}) };

    if ((record.kind === "lottie" || record.kind === "dotlottie") && record.timing) {
      const { frameRate, inPoint, outPoint } = record.timing;
      const speed = playback.speed && playback.speed > 0 ? playback.speed : 1;
      const backward = playback.direction === -1;
      drafts.push({
        key: `lottie|${record.url}|${record.target}`,
        entry: {
          source: "lottie",
          target: record.target,
          trigger,
          properties: [{ name: "frame", keyframes: [{ offset: 0, value: backward ? outPoint : inPoint }, { offset: 1, value: backward ? inPoint : outPoint }] }],
          duration: frameRate > 0 ? round(((outPoint - inPoint) / frameRate / speed) * 1000) : 0,
          delay: 0,
          easing: "linear",
          // lottie-web loops by default.
          iterations: playback.loop === undefined ? "infinite" : iterations,
          direction: "normal",
          confidence: playback.loop === undefined ? "near" : "exact",
          raw: { ...raw, timing: record.timing },
        },
      });
      continue;
    }
    const source = record.kind === "dotlottie" ? "lottie" : record.kind;
    drafts.push({
      key: `${source}|${record.url}|${record.target}`,
      entry: {
        source,
        target: record.target,
        trigger,
        properties: [],
        duration: 0,
        delay: 0,
        easing: "linear",
        iterations: loop === undefined ? 1 : iterations,
        direction: "normal",
        confidence: "approximate",
        raw,
      },
    });
  }
  return drafts;
}
