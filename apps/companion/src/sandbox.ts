// Builds an untrusted Component.tsx in the Vite sandbox (apps/companion/sandbox) and
// serves the result on a random 127.0.0.1 port for the preview recorder.
//
// The companion never imports or runs Component.tsx. It copies the file into a fresh
// run folder, starts the sandbox's own Vite build in a child process (argument array,
// no shell, with a timeout), and serves only the built files. The page that loads them
// is locked down by the preview recorder (preview.ts).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inside } from "./library.ts";

/** Packages Component.tsx may import. Kept in step with ALLOWED_PACKAGES in sandbox/vite.config.ts. */
export const SANDBOX_PACKAGES = ["react", "react-dom", "framer-motion", "gsap", "three", "@react-three/fiber", "@react-three/drei"] as const;

const BUILD_TIMEOUT_MS = 120_000;
const MAX_COMPONENT_BYTES = 2 * 1024 * 1024;

/** src/ and dist/ both sit one level inside apps/companion. KINETIC_SANDBOX_DIR overrides it. */
export function sandboxDir(): string {
  return process.env.KINETIC_SANDBOX_DIR ?? fileURLToPath(new URL("../sandbox", import.meta.url));
}

export interface SandboxBuild {
  /** The built page's folder. */
  distDir: string;
  /** Removes the run folder. */
  cleanup(): Promise<void>;
}

export interface HarnessConfig {
  rootWidth: number | null;
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kinetic preview</title>
    <style>html, body { margin: 0; }</style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
`;

// Tailwind scans Component.tsx only, never the sandbox's packages.
const INDEX_CSS = `@import "tailwindcss" source(none);\n@source "./Component.tsx";\n`;

function mainSource(config: HarnessConfig): string {
  return [
    `import "./index.css";`,
    `import * as mod from "./Component.tsx";`,
    `import { mount } from "../../src/harness.tsx";`,
    `mount(mod, ${JSON.stringify(config)});`,
    "",
  ].join("\n");
}

/** The build output without stack frames or blank lines, so the job's error says what went wrong. */
export function buildErrorSummary(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && !/^\s*at\s/.test(line) && !/^\s*errors: \[Getter/.test(line) && line.trim() !== "}");
  return lines.slice(0, 24).join("\n");
}

/** Runs the sandbox's Vite build for one run folder, rejecting with the end of its output on failure. */
function runViteBuild(sandbox: string, run: string, timeoutMs: number): Promise<void> {
  const vite = path.join(sandbox, "node_modules", "vite", "bin", "vite.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vite, "build", "--config", path.join(sandbox, "vite.config.ts")], {
      cwd: sandbox,
      env: { ...process.env, KINETIC_PREVIEW_RUN: run, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not start the sandbox build: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`the sandbox build took longer than ${timeoutMs / 1000} s and was stopped`));
      else if (code === 0) resolve();
      else reject(new Error(`Component.tsx did not build:\n${buildErrorSummary(output)}`));
    });
  });
}

/** Copies Component.tsx into a new run folder and builds it. */
export async function buildSandbox(componentSource: string, config: HarnessConfig, { timeoutMs = BUILD_TIMEOUT_MS } = {}): Promise<SandboxBuild> {
  if (Buffer.byteLength(componentSource) > MAX_COMPONENT_BYTES) throw new Error("Component.tsx is larger than 2 MB");
  const sandbox = sandboxDir();
  if (!(await stat(path.join(sandbox, "node_modules", "vite")).then(() => true, () => false))) {
    throw new Error(`the sandbox has no dependencies installed at ${sandbox}. Run: pnpm install`);
  }
  const run = path.join(sandbox, ".runs", randomUUID());
  await mkdir(run, { recursive: true });
  const cleanup = () => rm(run, { recursive: true, force: true });
  try {
    await Promise.all([
      writeFile(path.join(run, "Component.tsx"), componentSource),
      writeFile(path.join(run, "index.html"), INDEX_HTML),
      writeFile(path.join(run, "index.css"), INDEX_CSS),
      writeFile(path.join(run, "main.tsx"), mainSource(config)),
    ]);
    await runViteBuild(sandbox, run, timeoutMs);
    return { distDir: path.join(run, "dist"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const STATIC_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

/** Serves a folder on 127.0.0.1 at a random port. GET and HEAD only, and nothing outside the folder. */
export async function serveStatic(root: string): Promise<StaticServer> {
  const base = path.resolve(root);
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const file = path.resolve(base, `.${pathname === "/" ? "/index.html" : pathname}`);
      const info = inside(base, file) ? await stat(file).catch(() => undefined) : undefined;
      if (!info?.isFile() || pathname.includes("\0")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": STATIC_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).pipe(res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
