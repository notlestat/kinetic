// Filesystem access to library/<site>/<slug>/. Every path goes through these
// checks, so no request can read or write outside the library folder.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Capture, CaptureSchema, PathSegmentSchema, RelativeFilePathSchema } from "@kinetic/schema";

export class LibraryPathError extends Error {}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Absolute path of library/<site>/<slug>, after validating both segments. */
export function captureDir(libraryDir: string, site: string, slug: string): string {
  if (!PathSegmentSchema.safeParse(site).success || !PathSegmentSchema.safeParse(slug).success) {
    throw new LibraryPathError("site and slug must each be a single safe path segment");
  }
  const root = path.resolve(libraryDir);
  const dir = path.resolve(root, site, slug);
  if (!inside(root, dir)) throw new LibraryPathError("capture path escapes the library");
  return dir;
}

/** Absolute path of a file inside a capture folder, after validating the relative path. */
export function captureFile(libraryDir: string, site: string, slug: string, relativePath: string): string {
  if (!RelativeFilePathSchema.safeParse(relativePath).success || relativePath.includes("\0")) {
    throw new LibraryPathError("path must be a relative path inside the capture folder");
  }
  const dir = captureDir(libraryDir, site, slug);
  const file = path.resolve(dir, relativePath);
  if (!inside(dir, file)) throw new LibraryPathError("file path escapes the capture folder");
  return file;
}

/** Writes through a temp file and a rename, so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readCapture(dir: string): Promise<Capture> {
  return CaptureSchema.parse(JSON.parse(await readFile(path.join(dir, "capture.json"), "utf8")));
}

/**
 * Writes capture.json (the source of truth) plus one file per section, as SPEC.md
 * lists them: dom.html, styles.json, motion.json and framework.json. The media
 * block records which of those files exist.
 */
export async function writeCapture(dir: string, capture: Capture): Promise<Capture> {
  const media = { ...capture.media };
  if (capture.dom) {
    await writeFileAtomic(path.join(dir, "dom.html"), `${capture.dom.html}\n`);
    media.dom = "dom.html";
  }
  if (capture.styles) {
    await writeJson(path.join(dir, "styles.json"), capture.styles);
    media.styles = "styles.json";
  }
  if (capture.motion) {
    await writeJson(path.join(dir, "motion.json"), capture.motion);
    media.motion = "motion.json";
  }
  if (capture.framework) {
    await writeJson(path.join(dir, "framework.json"), capture.framework);
    media.framework = "framework.json";
  }
  const saved: Capture = { ...capture, media };
  await writeJson(path.join(dir, "capture.json"), saved);
  return saved;
}
