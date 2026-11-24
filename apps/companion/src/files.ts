// Serving capture files: content types and byte ranges (video seeking needs them).
// Captured files come from other sites, so nothing is ever served in a form the
// browser would run: HTML, SVG and source files go out as plain text, with nosniff
// and a sandboxing CSP on every response.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".json": "application/json; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // Captured markup and vector art are shown as text, never rendered on the companion's origin.
  ".html": "text/plain; charset=utf-8",
  ".svg": "text/plain; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Headers every file response carries. */
export const FILE_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cache-Control": "no-cache",
  "Accept-Ranges": "bytes",
};

/**
 * Parses a single "bytes=" range. Returns undefined to serve the whole file (no
 * header, or several ranges, which this server does not combine) and "invalid" when
 * the range cannot be satisfied.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.includes(",") ? undefined : "invalid";
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return "invalid";
  if (a === "") {
    // Suffix range: the last N bytes.
    const length = Number(b);
    if (length === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

/** A Response for a file on disk, honouring a Range header. */
export async function fileResponse(file: string, rangeHeader: string | undefined, method: string): Promise<Response> {
  const { size } = await stat(file);
  const headers = new Headers({ ...FILE_HEADERS, "Content-Type": contentTypeFor(file) });
  const range = parseRange(rangeHeader, size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  headers.set("Content-Length", String(length));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  const status = range ? 206 : 200;
  if (method === "HEAD" || length === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}
