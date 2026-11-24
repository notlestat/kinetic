import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CaptureSchema } from "@kinetic/schema";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

export const PORT = 4517;
export const HOST = "127.0.0.1";

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

export interface AppOptions {
  /** Absolute path of the library/ folder captures are written into. */
  libraryDir: string;
}

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

  app.post(
    "/capture",
    bodyLimit({ maxSize: 50 * 1024 * 1024, onError: (c) => c.json({ error: "capture too large" }, 413) }),
    async (c) => {
      // Requiring JSON also forces browsers into a CORS preflight, which this server never approves.
      if (!c.req.header("content-type")?.startsWith("application/json")) {
        return c.json({ error: "content-type must be application/json" }, 415);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "body is not valid JSON" }, 400);
      }

      const parsed = CaptureSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "invalid capture", issues: z.treeifyError(parsed.error) }, 400);
      }

      const capture = parsed.data;
      const dir = path.resolve(libraryDir, capture.meta.site, capture.meta.slug);
      // The schema already limits site and slug to safe names. This second check guards the filesystem itself.
      if (path.relative(libraryDir, dir).startsWith("..")) {
        return c.json({ error: "capture path escapes the library" }, 400);
      }

      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "capture.json");
      // Write to a temp file, then rename, so a crash never leaves a half-written capture.json.
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(capture, null, 2)}\n`);
      await rename(tmp, file);

      return c.json({ ok: true, path: path.relative(libraryDir, file) }, 201);
    },
  );

  return app;
}
