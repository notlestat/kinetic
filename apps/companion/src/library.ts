// Filesystem access to library/<site>/<slug>/. Every path goes through these
// checks, so no request can read or write outside the library folder.

import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Capture, CaptureSchema, PathSegmentSchema, RelativeFilePathSchema } from "@kinetic/schema";

export class LibraryPathError extends Error {}

export function inside(parent: string, child: string): boolean {
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

// ─── one writer per capture ──────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after every earlier call for the same folder has finished, so the job
 * queue and new captures never interleave their read-modify-write of capture.json.
 */
export function withCaptureLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(dir) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(dir, tail);
  void tail.then(() => {
    if (locks.get(dir) === tail) locks.delete(dir);
  });
  return run;
}

/** Reads capture.json, applies `update` and writes the result back, under the folder's lock. */
export function updateCapture(dir: string, update: (capture: Capture) => Capture | Promise<Capture>): Promise<Capture> {
  return withCaptureLock(dir, async () => {
    const next = CaptureSchema.parse(await update(await readCapture(dir)));
    await writeJson(path.join(dir, "capture.json"), next);
    return next;
  });
}

// ─── listing ─────────────────────────────────────────────────────────────────

export interface CaptureRef {
  site: string;
  slug: string;
  dir: string;
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && PathSegmentSchema.safeParse(e.name).success).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Every library/<site>/<slug>/ folder that holds a capture.json. */
export async function listCaptureRefs(libraryDir: string): Promise<CaptureRef[]> {
  const refs: CaptureRef[] = [];
  for (const site of await subfolders(libraryDir)) {
    for (const slug of await subfolders(path.join(libraryDir, site))) {
      const dir = captureDir(libraryDir, site, slug);
      if (await stat(path.join(dir, "capture.json")).then((s) => s.isFile(), () => false)) refs.push({ site, slug, dir });
    }
  }
  return refs;
}

export interface CaptureFileInfo {
  /** Relative to the capture folder, with forward slashes. */
  path: string;
  size: number;
}

/** Files in a capture folder, recursively, leaving out temp files and anything that is not a plain file. */
export async function listCaptureFiles(dir: string, limit = 2000): Promise<CaptureFileInfo[]> {
  const out: CaptureFileInfo[] = [];
  const walk = async (folder: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") || entry.name.endsWith(".tmp")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), rel);
      else if (entry.isFile()) out.push({ path: rel, size: (await stat(path.join(folder, entry.name))).size });
    }
  };
  await walk(dir, "");
  return out;
}

/**
 * The real path of a file inside a capture folder, or undefined when it does not
 * exist. Resolves symlinks, so a link inside the library cannot point outside it.
 */
export async function resolveCaptureFile(libraryDir: string, site: string, slug: string, relativePath: string): Promise<string | undefined> {
  const file = captureFile(libraryDir, site, slug, relativePath);
  let real: string;
  let realDir: string;
  try {
    [real, realDir] = await Promise.all([realpath(file), realpath(captureDir(libraryDir, site, slug))]);
  } catch {
    return undefined;
  }
  if (!inside(realDir, real)) throw new LibraryPathError("file path escapes the capture folder");
  return (await stat(real)).isFile() ? real : undefined;
}
