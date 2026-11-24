import { mkdir } from "node:fs/promises";
import { CaptureSchema, PathSegmentSchema, RelativeFilePathSchema } from "@kinetic/schema";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { captureDir, captureFile, LibraryPathError, writeCapture, writeFileAtomic } from "./library.ts";

export const PORT = 4517;
export const HOST = "127.0.0.1";

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MAX_BODY = 50 * 1024 * 1024;

export interface AppOptions {
  /** Absolute path of the library/ folder captures are written into. */
  libraryDir: string;
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

export function createApp({ libraryDir }: AppOptions) {
  const app = new Hono();

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
    await writeCapture(dir, capture);

    return c.json({ ok: true, path: `${capture.meta.site}/${capture.meta.slug}/capture.json` }, 201);
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

  return app;
}
