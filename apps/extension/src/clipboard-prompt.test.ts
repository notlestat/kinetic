import { readFileSync } from "node:fs";
import { CaptureSchema } from "@kinetic/schema";
import sample from "@kinetic/schema/fixtures/sample-capture.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { buildClipboardPrompt, PROMPT_LIMITS, relativeSelector } from "./clipboard-prompt.ts";

const base = CaptureSchema.parse(sample);
const example = (name: string) =>
  CaptureSchema.parse(JSON.parse(readFileSync(new URL(`../../../examples/127.0.0.1/${name}/capture.json`, import.meta.url), "utf8")));

describe("relativeSelector", () => {
  it("replaces the root with &", () => {
    expect(relativeSelector("main > a.cta", "main > a.cta")).toBe("&");
    expect(relativeSelector("main > a.cta > span", "main > a.cta")).toBe("& > span");
    expect(relativeSelector("body > footer", "main > a.cta")).toBe("body > footer");
  });
});

describe("buildClipboardPrompt", () => {
  it("is self-contained: task, motion, states, tokens, markup and styles inline, with no file links", () => {
    const { text, truncated } = buildClipboardPrompt(base);
    expect(truncated).toBe(false);
    expect(text).toContain(base.meta.url);
    expect(text).toContain("## Task");
    expect(text).toContain("## Motion");
    expect(text).toContain("## States");
    expect(text).toContain("## Tokens");
    expect(text).toContain("```html");
    expect(text).toContain("## Computed styles");
    expect(text).not.toMatch(/\]\([^)]*\.(json|png|webm|html)\)/);
    expect(text).not.toContain("pnpm kinetic");
  });

  it("picks the motion library from the capture", () => {
    expect(buildClipboardPrompt(example("gsap-scrub")).text).toContain("Library: **GSAP + ScrollTrigger**");
    expect(buildClipboardPrompt(example("three-stage")).text).toContain("Library: **React Three Fiber + drei**");
  });

  it("includes shader text and skips other files", () => {
    const { text } = buildClipboardPrompt(example("three-stage"), [
      { path: "three/shaders/0.frag.glsl", text: "void main() { gl_FragColor = vec4(1.0); }" },
      { path: "three/scene.json", text: "{}" },
    ]);
    expect(text).toContain("## Shaders");
    expect(text).toContain("gl_FragColor");
    expect(text).not.toContain("three/scene.json");
  });

  it("cuts long markup and styles to their budgets and says so", () => {
    const html = `<div>${"x".repeat(PROMPT_LIMITS.markup * 2)}</div>`;
    const node = base.styles?.nodes[0];
    if (!node) throw new Error("fixture has no styled nodes");
    const nodes = Array.from({ length: 2000 }, (_, i) => ({ ...node, selector: `${base.meta.selector} > div:nth-child(${i + 1})` }));
    const big = { ...base, dom: { html }, styles: { ...base.styles, nodes } };
    const { text, truncated } = buildClipboardPrompt(big);
    expect(truncated).toBe(true);
    expect(text).toContain("<!-- cut:");
    expect(text).toMatch(/\d+ more elements were left out/);
    expect(text.length).toBeLessThan(PROMPT_LIMITS.markup + PROMPT_LIMITS.styles + 20_000);
  });
});
