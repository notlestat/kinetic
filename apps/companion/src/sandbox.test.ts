import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSandbox, sandboxDir, serveStatic } from "./sandbox.ts";

// Real Vite builds in the sandbox package: each takes well under a second.
describe("buildSandbox", () => {
  it("builds a component that uses the allowed packages, with motion/react mapped to framer-motion", { timeout: 60_000 }, async () => {
    const source = [
      'import { motion } from "motion/react";',
      'import gsap from "gsap";',
      'import { ScrollTrigger } from "gsap/ScrollTrigger";',
      "gsap.registerPlugin(ScrollTrigger);",
      'export default function Card() { return <motion.div whileHover={{ y: -4 }} className="rounded-[var(--radius-1)] bg-[var(--color-1)] p-6">Card</motion.div>; }',
    ].join("\n");
    const build = await buildSandbox(source, { rootWidth: 320 });
    try {
      const assets = await readdir(path.join(build.distDir, "assets"));
      expect(assets.some((f) => f.endsWith(".js"))).toBe(true);
      const css = await readFile(path.join(build.distDir, "assets", assets.find((f) => f.endsWith(".css")) as string), "utf8");
      // Tailwind generated the component's arbitrary-value classes.
      expect(css).toContain("var(--radius-1)");
      expect(await readFile(path.join(build.distDir, "index.html"), "utf8")).toContain('<div id="app">');
    } finally {
      await build.cleanup();
    }
  });

  const rejected: [string, string, string][] = [
    ["a relative file import", 'import pkg from "../../package.json";\nexport default () => <div>{String(pkg)}</div>;', 'imports "../../package.json"'],
    ["a Node builtin", 'import fs from "node:fs";\nexport default () => <div>{String(fs.readFileSync)}</div>;', 'imports "node:fs"'],
    ["a package outside the allowlist", 'import express from "express";\nexport default () => <div>{String(express)}</div>;', 'imports "express"'],
    ["import.meta.glob", 'const files = import.meta.glob("/**");\nexport default () => <div>{Object.keys(files).length}</div>;', "may not use import.meta"],
    ["a CSS url() that reaches a file", 'export default () => <div className="h-4 bg-[url(../../package.json)]" />;', "outside the sandbox"],
  ];
  for (const [name, source, message] of rejected) {
    it(`rejects ${name}`, { timeout: 60_000 }, async () => {
      await expect(buildSandbox(source, { rootWidth: null })).rejects.toThrow(message);
    });
  }

  it("removes every run folder, after success and after failure", { timeout: 60_000 }, async () => {
    const runs = path.join(sandboxDir(), ".runs");
    const before = await readdir(runs).catch(() => []);
    await buildSandbox('import fs from "node:fs"; export default () => <div>{String(fs)}</div>;', { rootWidth: null }).catch(() => undefined);
    const ok = await buildSandbox("export default () => <div />;", { rootWidth: null });
    await ok.cleanup();
    expect(await readdir(runs).catch(() => [])).toEqual(before);
  });
});

describe("serveStatic", () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kinetic-static-"));
    outside = await mkdtemp(path.join(tmpdir(), "kinetic-static-outside-"));
    await writeFile(path.join(root, "index.html"), "<p>hi</p>");
    await writeFile(path.join(outside, "secret.txt"), "secret");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("serves files in the folder on 127.0.0.1 and nothing outside it", async () => {
    const server = await serveStatic(root);
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const index = await fetch(`${server.origin}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await index.text()).toBe("<p>hi</p>");
      const escape = `/..%2F${path.basename(outside)}%2Fsecret.txt`;
      expect((await fetch(`${server.origin}${escape}`)).status).toBe(404);
      expect((await fetch(`${server.origin}/missing.js`)).status).toBe(404);
      expect((await fetch(`${server.origin}/index.html`, { method: "POST" })).status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
