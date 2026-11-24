import { mkdir } from "node:fs/promises";
import { type Capture, CaptureSchema, PathSegmentSchema, RelativeFilePathSchema } from "@kinetic/schema";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { contentTypeFor, fileResponse } from "./files.ts";
import { JobQueue } from "./jobs.ts";
import {
  captureDir,
  captureFile,
  LibraryPathError,
  listCaptureFiles,
  listCaptureRefs,
  readCapture,
  resolveCaptureFile,
  withCaptureLock,
  writeCapture,
  writeFileAtomic,
} from "./library.ts";
import { createRecordJob } from "./record-job.ts";

export const PORT = 4517;
export const HOST = "127.0.0.1";

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MAX_BODY = 50 * 1024 * 1024;

export interface AppOptions {
  /** Absolute path of the library/ folder captures are written into. */
  libraryDir: string;
  /** The job queue. Defaults to one that records with Playwright. */
  jobs?: JobQueue;
  /** Queue a recording as soon as a capture arrives. Off unless the caller turns it on. */
  autoRecord?: boolean;
}

const CaptureFileBodySchema = z.object({
  site: PathSegmentSchema,
  slug: PathSegmentSchema,
  path: RelativeFilePathSchema.refine((p) => p !== "capture.json", "capture.json is written by POST /capture only"),
  contentBase64: z.base64(),
});

/** Reads a JSON body, answering 415 for other content types and 400 for malformed JSON. */
async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  // Requiring JSON also forces browsers into a CORS preflight, which this server never approves for these routes.
  if (!c.req.header("content-type")?.startsWith("application/json")) {
    return { ok: false, response: c.json({ error: "content-type must be application/json" }, 415) };
  }
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, response: c.json({ error: "body is not valid JSON" }, 400) };
  }
}

const jsonBodyLimit = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "body too large" }, 413) });

/** "/files/<site>/<slug>/<path>" with each segment encoded. */
export function fileUrl(origin: string, site: string, slug: string, relativePath: string): string {
  return `${origin}/files/${[site, slug, ...relativePath.split("/")].map(encodeURIComponent).join("/")}`;
}

/** The media block's files as URLs. */
function mediaUrls(origin: string, capture: Capture): Record<string, string> {
  const { site, slug } = capture.meta;
  return Object.fromEntries(Object.entries(capture.media ?? {}).flatMap(([key, file]) => (file ? [[key, fileUrl(origin, site, slug, file)]] : [])));
}

export function createApp({ libraryDir, jobs = new JobQueue({ libraryDir, handlers: { record: createRecordJob() } }), autoRecord = false }: AppOptions) {
  const app = new Hono();
  // The Host header has passed the guard by the time this is used, so it is one of ALLOWED_HOSTS.
  const originOf = (c: Context) => `http://${c.req.header("host")}`;

  // Any web page can send requests to localhost, so only the extension and local tools get in.
  app.use("*", async (c, next) => {
    // A Host check blocks DNS rebinding, where evil.example resolves to 127.0.0.1.
    if (!ALLOWED_HOSTS.has(c.req.header("host") ?? "")) {
      return c.json({ error: "host not allowed" }, 403);
    }
    // Browsers attach Origin to cross-site requests. No Origin means curl, scripts or tests.
    const origin = c.req.header("origin");
    if (origin !== undefined && !origin.startsWith("chrome-extension://")) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof LibraryPathError) return c.json({ error: error.message }, 400);
    console.error("[kinetic] request failed", error);
    return c.json({ error: "internal error" }, 500);
  });

  app.post("/capture", jsonBodyLimit, async (c) => {
    const read = await readJson(c);
    if (!read.ok) return read.response;

    const parsed = CaptureSchema.safeParse(read.body);
    if (!parsed.success) {
      return c.json({ error: "invalid capture", issues: z.treeifyError(parsed.error) }, 400);
    }

    const capture = parsed.data;
    // The schema already limits site and slug to safe names. captureDir checks the filesystem path again.
    const dir = captureDir(libraryDir, capture.meta.site, capture.meta.slug);
    await mkdir(dir, { recursive: true });
    await withCaptureLock(dir, () => writeCapture(dir, capture));

    const job = autoRecord && jobs.handles("record") ? await jobs.enqueue(capture.meta.site, capture.meta.slug, "record") : undefined;
    return c.json({ ok: true, path: `${capture.meta.site}/${capture.meta.slug}/capture.json`, ...(job ? { job } : {}) }, 201);
  });

  app.post("/capture/file", jsonBodyLimit, async (c) => {
    const read = await readJson(c);
    if (!read.ok) return read.response;

    const parsed = CaptureFileBodySchema.safeParse(read.body);
    if (!parsed.success) {
      return c.json({ error: "invalid file", issues: z.treeifyError(parsed.error) }, 400);
    }

    const { site, slug, path: relativePath, contentBase64 } = parsed.data;
    const file = captureFile(libraryDir, site, slug, relativePath);
    await writeFileAtomic(file, Buffer.from(contentBase64, "base64"));
    return c.json({ ok: true, path: `${site}/${slug}/${relativePath}` }, 201);
  });

  // Every capture in the library, newest first, with what a library grid needs.
  app.get("/captures", async (c) => {
    const origin = originOf(c);
    const captures = [];
    for (const ref of await listCaptureRefs(libraryDir)) {
      let capture: Capture;
      try {
        capture = await readCapture(ref.dir);
      } catch {
        captures.push({ site: ref.site, slug: ref.slug, error: "capture.json is not a valid capture" });
        continue;
      }
      captures.push({
        site: ref.site,
        slug: ref.slug,
        meta: { url: capture.meta.url, title: capture.meta.title, timestamp: capture.meta.timestamp, selector: capture.meta.selector },
        ...(capture.job ? { job: capture.job } : {}),
        ...(capture.motion?.summary ? { motion: capture.motion.summary } : {}),
        framework: { kind: capture.framework?.kind ?? "none", detected: capture.framework?.detected ?? [] },
        hasThree: capture.three !== undefined,
        media: mediaUrls(origin, capture),
      });
    }
    captures.sort((a, b) => ("meta" in b && "meta" in a ? b.meta.timestamp.localeCompare(a.meta.timestamp) : 0));
    return c.json({ captures });
  });

  // One capture, with a URL for every file in its folder.
  app.get("/captures/:site/:slug", async (c) => {
    const { site, slug } = c.req.param();
    const dir = captureDir(libraryDir, site, slug);
    let capture: Capture;
    try {
      capture = await readCapture(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "capture not found" }, 404);
      throw error;
    }
    const origin = originOf(c);
    const files = (await listCaptureFiles(dir)).map((f) => ({ ...f, url: fileUrl(origin, site, slug, f.path), contentType: contentTypeFor(f.path) }));
    return c.json({ capture, media: mediaUrls(origin, capture), files });
  });

  // A file inside a capture folder. Every segment is decoded and checked, then the real path must stay inside the folder.
  app.get("/files/:site/:slug/*", async (c) => {
    let segments: string[];
    try {
      segments = c.req.path.split("/").slice(2).map(decodeURIComponent);
    } catch {
      return c.json({ error: "malformed path" }, 400);
    }
    const [site = "", slug = "", ...rest] = segments;
    if (rest.length === 0 || segments.some((s) => s === "" || s.includes("/") || s.includes("\\") || s.includes("\0"))) {
      return c.json({ error: "path must be a relative path inside the capture folder" }, 400);
    }
    const file = await resolveCaptureFile(libraryDir, site, slug, rest.join("/"));
    if (!file) return c.json({ error: "file not found" }, 404);
    return fileResponse(file, c.req.header("range"), c.req.method);
  });

  // Queues a recording. JSON-only like every POST route, which keeps browsers behind a preflight.
  app.post("/captures/:site/:slug/record", async (c) => {
    const read = await readJson(c);
    if (!read.ok) return read.response;
    const { site, slug } = c.req.param();
    const dir = captureDir(libraryDir, site, slug);
    try {
      await readCapture(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "capture not found" }, 404);
      throw error;
    }
    const job = await jobs.enqueue(site, slug, "record");
    return c.json({ ok: true, job }, 202);
  });

  return app;
}
