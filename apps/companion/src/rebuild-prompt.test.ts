import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Capture, CaptureSchema, type MotionEntry } from "@kinetic/schema";
import sample from "@kinetic/schema/fixtures/sample-capture.json" with { type: "json" };
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJson } from "./library.ts";
import { buildRebuildPrompt, chooseMotionLibrary, LARGE_STYLES_BYTES, withFixPass, withoutFixPass, writeRebuildPrompt } from "./rebuild-prompt.ts";
import { SANDBOX_PACKAGES } from "./sandbox.ts";

const base = CaptureSchema.parse(sample);

function entry(overrides: Partial<MotionEntry>): MotionEntry {
  return {
    id: "gsap-1",
    source: "gsap",
    target: "#box",
    trigger: "load",
    properties: [{ name: "x", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: 120 }] }],
    duration: 800,
    delay: 100,
    easing: "power2.out",
    iterations: 1,
    direction: "normal",
    confidence: "exact",
    raw: null,
    ...overrides,
  };
}

const files = [
  { path: "capture.json", size: 10 },
  { path: "dom.html", size: 10 },
  { path: "styles.json", size: 10 },
  { path: "motion.json", size: 10 },
  { path: "framework.json", size: 10 },
  { path: "original.webm", size: 10 },
  { path: "states/default.png", size: 10 },
  { path: "states/hover.png", size: 10 },
  { path: "three/scene.json", size: 10 },
];

describe("chooseMotionLibrary", () => {
  it("uses Framer Motion by default, GSAP when GSAP is the main source, R3F when there is a three block", () => {
    expect(chooseMotionLibrary(base)).toBe("framer-motion");
    const gsap: Capture = { ...base, motion: { entries: [entry({}), entry({ id: "st-1", source: "scrolltrigger", trigger: "scroll" })] } };
    expect(chooseMotionLibrary(gsap)).toBe("gsap");
    // A three block wins even when GSAP is the main source.
    expect(chooseMotionLibrary({ ...gsap, three: { shaderFiles: [] } })).toBe("react-three-fiber");
    // One GSAP entry among more CSS entries: CSS is the main source.
    const mostlyCss: Capture = { ...base, motion: { entries: [...(base.motion?.entries ?? []), { ...(base.motion?.entries[0] as MotionEntry), id: "css-2" }, entry({})] } };
    expect(chooseMotionLibrary(mostlyCss)).toBe("framer-motion");
  });
});

describe("buildRebuildPrompt", () => {
  const capture: Capture = {
    ...base,
    motion: {
      entries: [
        ...(base.motion?.entries ?? []),
        entry({ id: "gsap-1", stagger: 60 }),
        entry({ id: "gsap-2", source: "scrolltrigger", trigger: "scroll", scroll: { start: "top bottom", end: "bottom top", scrub: 1, pin: false } }),
        entry({ id: "sampled-1", source: "sampled", trigger: "loop", easing: "linear", iterations: "infinite", confidence: "approximate" }),
      ],
    },
    framework: {
      kind: "react",
      components: [
        { id: "1", name: "Hero", parentId: null, minified: false, props: {}, domNodes: ["main > section.hero"] },
        { id: "2", name: "Cta", parentId: "1", minified: false, props: {}, domNodes: ["main > section.hero a.cta"] },
      ],
      suggestedSplit: [{ name: "Cta", domNodes: ["main > section.hero a.cta"] }],
    },
  };
  const markdown = buildRebuildPrompt({ capture, files, stylesSummary: false });

  it("states the task, the split and the taste note", () => {
    expect(markdown).toContain("Rebuild this component as `Component.tsx` in React + TypeScript + Tailwind CSS.");
    expect(markdown).toContain("Split it into these sub-components, all inside Component.tsx: `Cta`.");
    expect(markdown).toContain("Write `NOTES.md`: a short taste note");
    expect(markdown).toContain("- Hero\n  - Cta");
  });

  it("puts the tokens in CSS variables", () => {
    expect(markdown).toContain("```css\n:root {\n  --color-1: rgb(99, 91, 255);\n  --color-2: rgb(255, 255, 255);\n  --font-size-1: 16px;\n  --radius-1: 999px;\n}\n```");
  });

  it("lists exact motion values with the library rule, exact entries first", () => {
    expect(markdown).toContain("Library: **GSAP + ScrollTrigger**");
    expect(markdown).toContain("| css-transition-1 | `main > section.hero a.cta` | hover | background-color: rgb(99, 91, 255) → rgb(10, 37, 64); transform: none → translateY(-1px) | 150 ms | 0 ms | `cubic-bezier(0, 0, 0.58, 1)` |  | 1 | exact |");
    expect(markdown).toContain("| gsap-1 | `#box` | load | x: 0 → 120 | 800 ms | 100 ms | `power2.out` | 60 ms | 1 | exact |");
    expect(markdown).toContain("| gsap-2 | `#box` | scroll · scroll top bottom → bottom top, scrub 1 |");
    expect(markdown.indexOf("| sampled-1 ")).toBeGreaterThan(markdown.indexOf("| gsap-2 "));
    expect(markdown).toContain("Use the exact durations, delays, easing curves and stagger from the table for every `exact` and `near` entry.");
  });

  it("links the capture files relatively", () => {
    for (const link of ["(states/default.png)", "(states/hover.png)", "(dom.html)", "(styles.json)", "(motion.json)", "(framework.json)", "(original.webm)", "(three/)"]) {
      expect(markdown).toContain(link);
    }
    expect(markdown).not.toContain("styles.summary.json");
    expect(markdown).not.toMatch(/\]\(\//);
  });

  it("ends with the output contract and the canvas target", () => {
    expect(markdown).toContain("1. Write only `Component.tsx` and `NOTES.md`, in this folder.");
    expect(markdown).toContain("`pnpm kinetic preview example.com/cta-button`");
    for (const name of SANDBOX_PACKAGES) expect(markdown).toContain(`\`${name}\``);
    expect(markdown).toContain("## Canvas target (Blueprint or Paper)");
    expect(markdown).toContain("**default**, **hover**, **focus** and **mobile** (390 px wide)");
    expect(markdown.indexOf("## Output contract")).toBeLessThan(markdown.indexOf("## Canvas target"));
  });

  it("uses React Three Fiber and lists the scene when there is a three block", () => {
    const three = buildRebuildPrompt({
      capture: { ...capture, three: { shaderFiles: [], camera: { type: "PerspectiveCamera", fov: 45, position: [0, 0, 5], rotation: [0, 0, 0], direction: [0, 0, -1], target: [0, 0, 0] } } },
      files,
      stylesSummary: false,
    });
    expect(three).toContain("Library: **React Three Fiber + drei**");
    expect(three).toContain("- Camera: PerspectiveCamera, fov 45, position [0, 0, 5], looking at [0, 0, 0]");
    expect(three).toContain("- [three/scene.json](three/scene.json)");
  });

  it("escapes pipes inside table cells", () => {
    const md = buildRebuildPrompt({ capture: { ...capture, motion: { entries: [entry({ target: "a|b" })] } }, files, stylesSummary: false });
    expect(md).toContain("`a\\|b`");
  });
});

describe("Fix pass section", () => {
  it("is added once, replaced on the next failure and removed when the preview passes", () => {
    const md = "# Rebuild\n\n## Output contract\n\n1. Write only Component.tsx\n";
    const once = withFixPass(md, [{ state: "hover-0", score: 0.234 }], 0.1);
    expect(once).toContain("## Fix pass\n\nThe preview is over the 10.0% threshold in 1 state:\n\n- `hover-0`: 23.4% of pixels differ");
    expect(once).toContain("[DIFF.md](DIFF.md)");
    const twice = withFixPass(once, [{ state: "default", score: 0.5 }, { state: "mobile", score: 0.2 }], 0.1);
    expect(twice.match(/## Fix pass/g)).toHaveLength(1);
    expect(twice).toContain("in 2 states");
    expect(twice).not.toContain("hover-0");
    expect(withoutFixPass(twice)).toBe(md);
    expect(withoutFixPass(md)).toBe(md);
  });
});

describe("writeRebuildPrompt", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kinetic-prompt-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes REBUILD.md and no summary when styles.json is small", async () => {
    await writeJson(path.join(dir, "capture.json"), base);
    await writeJson(path.join(dir, "styles.json"), base.styles);
    await writeRebuildPrompt(dir);
    const md = await readFile(path.join(dir, "REBUILD.md"), "utf8");
    expect(md).toContain("[styles.json](styles.json)");
    expect(await stat(path.join(dir, "styles.summary.json")).catch(() => undefined)).toBeUndefined();
  });

  it("writes styles.summary.json and links it when styles.json is very large", async () => {
    const node = base.styles?.nodes[0];
    if (!node) throw new Error("fixture has no styled node");
    const nodes = Array.from({ length: 800 }, (_, i) => ({ ...node, selector: `${node.selector} > span:nth-child(${i + 1})`, styles: { ...node.styles, "--padding": "x".repeat(300) } }));
    const capture: Capture = { ...base, styles: { ...(base.styles as NonNullable<Capture["styles"]>), nodes } };
    await writeJson(path.join(dir, "capture.json"), capture);
    await writeJson(path.join(dir, "styles.json"), capture.styles);
    expect((await stat(path.join(dir, "styles.json"))).size).toBeGreaterThan(LARGE_STYLES_BYTES);
    await mkdir(path.join(dir, "states"));
    await writeFile(path.join(dir, "states", "hover.png"), "png");
    await writeRebuildPrompt(dir);
    const md = await readFile(path.join(dir, "REBUILD.md"), "utf8");
    expect(md).toContain("[styles.summary.json](styles.summary.json)");
    expect(md).toContain("[states/hover.png](states/hover.png)");
    const summary = JSON.parse(await readFile(path.join(dir, "styles.summary.json"), "utf8"));
    expect(summary.nodeCount).toBe(800);
    expect(summary.nodes).toHaveLength(60);
    expect(summary.tokens).toEqual(base.styles?.tokens);
  });
});

describe("sandbox allowlist", () => {
  it("matches the packages the sandbox's Vite config allows", async () => {
    const config = await readFile(fileURLToPath(new URL("../sandbox/vite.config.ts", import.meta.url)), "utf8");
    const listed = /ALLOWED_PACKAGES = \[([^\]]+)\]/.exec(config)?.[1]?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1));
    expect(listed).toEqual([...SANDBOX_PACKAGES]);
  });
});
