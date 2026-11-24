// Part 6: the hand-off rebuild and the preview. Each test captures a test page,
// records it (which writes REBUILD.md and leaves the capture awaiting a rebuild), then
// plays the user's agent: it drops in the example Component.tsx and NOTES.md from
// examples/, asks the companion for a preview, and checks the video, scores and DIFF.md.
//
// KINETIC_WRITE_EXAMPLES=1 also copies each finished capture folder into examples/.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Capture } from "@kinetic/schema";
import { videoInfo } from "../apps/companion/src/video.ts";
import { captureDirFor, captureSelector, expect, fileExists, openTestPage, readCaptureJson, test } from "./fixtures.ts";
import { REPO_ROOT } from "./paths.ts";

const SITE = "127.0.0.1";
const COMPANION = "http://127.0.0.1:4517";
const EXAMPLES = path.join(REPO_ROOT, "examples", SITE);
const WRITE_EXAMPLES = process.env.KINETIC_WRITE_EXAMPLES === "1";

async function post(slug: string, action: "record" | "rebuild" | "preview"): Promise<Response> {
  return fetch(`${COMPANION}/captures/${SITE}/${slug}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
}

/** Waits until the capture's job reaches one of `statuses` (or fails) and returns the capture. */
async function waitFor(slug: string, statuses: readonly string[]): Promise<Capture> {
  const pattern = new RegExp(`^(${[...statuses, "failed"].join("|")})$`);
  await expect.poll(async () => (await readCaptureJson(SITE, slug)).job?.status, { timeout: 200_000, intervals: [1000] }).toMatch(pattern);
  return readCaptureJson(SITE, slug);
}

async function captureAndRecord(pageName: string, selector: string, slug: string, page: Parameters<typeof openTestPage>[0]): Promise<Capture> {
  await openTestPage(page, pageName);
  expect(await captureSelector(page, selector, slug)).toMatchObject({ ok: true });
  expect((await post(slug, "record")).status).toBe(202);
  const capture = await waitFor(slug, ["awaiting-rebuild"]);
  expect(capture.job?.error).toBeUndefined();
  expect(capture.job?.status).toBe("awaiting-rebuild");
  return capture;
}

const cases = [
  { pageName: "button.html", selector: "section.hero", slug: "button-hero", library: "Framer Motion" },
  { pageName: "gsap.html", selector: "section.scrub-section", slug: "gsap-scrub", library: "GSAP + ScrollTrigger" },
  { pageName: "three.html", selector: "section.stage", slug: "three-stage", library: "React Three Fiber + drei" },
] as const;

for (const { pageName, selector, slug, library } of cases) {
  test(`hands off ${slug}: REBUILD.md, then a sandboxed preview with scores`, async ({ page }) => {
    test.setTimeout(420_000);
    const dir = captureDirFor(SITE, slug);
    const capture = await captureAndRecord(pageName, selector, slug, page);

    // REBUILD.md: the motion rule for this page, relative links and the preview command.
    const rebuildMd = await readFile(path.join(dir, "REBUILD.md"), "utf8");
    expect(rebuildMd).toContain(`Library: **${library}**`);
    expect(rebuildMd).toContain(`pnpm kinetic preview ${SITE}/${slug}`);
    expect(rebuildMd).toContain("[original.webm](original.webm)");
    expect(rebuildMd).toContain("## Canvas target (Blueprint or Paper)");

    // No Component.tsx yet, so the preview is refused.
    expect((await post(slug, "preview")).status).toBe(409);

    const example = path.join(EXAMPLES, slug);
    const component = await readFile(path.join(example, "Component.tsx"), "utf8").catch(() => undefined);
    const notes = await readFile(path.join(example, "NOTES.md"), "utf8").catch(() => undefined);
    if (!component) {
      // First run for a new example: save the capture so its Component.tsx can be written from REBUILD.md.
      if (WRITE_EXAMPLES) {
        await rm(example, { recursive: true, force: true });
        await cp(dir, example, { recursive: true });
      }
      test.skip(true, `examples/${SITE}/${slug}/Component.tsx does not exist yet`);
      return;
    }

    // The hand-off: the user's agent writes Component.tsx and NOTES.md, then asks for a preview.
    await writeFile(path.join(dir, "Component.tsx"), component);
    if (notes) await writeFile(path.join(dir, "NOTES.md"), notes);
    expect((await post(slug, "preview")).status).toBe(202);
    const done = await waitFor(slug, ["done"]);
    expect(done.job?.error).toBeUndefined();
    expect(done.job?.status).toBe("done");

    // The preview video uses the same script, so it has a crop and a length like the original's.
    const video = await videoInfo(path.join(dir, "Component.preview.webm"));
    expect(video.width % 2).toBe(0);
    expect(video.height % 2).toBe(0);
    expect(video.durationMs ?? 0).toBeGreaterThan(1500);
    expect(done.media).toMatchObject({ preview: "Component.preview.webm", component: "Component.tsx", ...(notes ? { notes: "NOTES.md" } : {}) });

    // Every original screenshot gets a score, and the default state is scored.
    const preview = done.preview;
    if (!preview) throw new Error("no preview block");
    expect(preview.threshold).toBe(0.1);
    const originals = [capture.media?.screenshot, ...(capture.states ?? []).map((s) => s.screenshot)].filter(Boolean);
    expect(preview.scores.map((s) => s.original).sort()).toEqual([...originals].sort());
    const scoredDefault = preview.scores.find((s) => s.state === "default");
    expect(typeof scoredDefault?.score).toBe("number");
    for (const s of preview.scores.filter((x) => x.score !== undefined)) {
      expect(await fileExists(path.join(dir, s.preview ?? ""))).toBe(true);
      expect(await fileExists(path.join(dir, s.diff ?? ""))).toBe(true);
    }

    // Over the threshold: DIFF.md plus a Fix pass section. Under it: neither.
    const over = preview.scores.some((s) => s.score !== undefined && s.score > preview.threshold);
    expect(await fileExists(path.join(dir, "DIFF.md"))).toBe(over);
    expect((await readFile(path.join(dir, "REBUILD.md"), "utf8")).includes("## Fix pass")).toBe(over);
    expect(preview.passed).toBe(!over && preview.scores.some((s) => s.score !== undefined));

    if (WRITE_EXAMPLES) {
      await rm(example, { recursive: true, force: true });
      await mkdir(path.dirname(example), { recursive: true });
      await cp(dir, example, { recursive: true });
    }
  });
}

test("the sandbox: a throwing component fails the job, a blocked import never builds, and the network is unreachable", async ({ page }) => {
  test.setTimeout(300_000);
  const slug = "broken-rebuild";
  await captureAndRecord("button.html", "section.hero", slug, page);
  const dir = captureDirFor(SITE, slug);

  await writeFile(path.join(dir, "Component.tsx"), 'export default function Broken(): never { throw new Error("rebuild exploded"); }\n');
  expect((await post(slug, "preview")).status).toBe(202);
  const thrown = await waitFor(slug, ["done"]);
  expect(thrown.job?.status).toBe("failed");
  expect(thrown.job?.error).toContain("Component.tsx failed in the preview");
  expect(thrown.job?.error).toContain("rebuild exploded");

  // An import outside the sandbox's packages never builds.
  await writeFile(path.join(dir, "Component.tsx"), 'import { readFileSync } from "node:fs";\nexport default () => <pre>{readFileSync("/etc/hosts", "utf8")}</pre>;\n');
  expect((await post(slug, "preview")).status).toBe(202);
  const blocked = await waitFor(slug, ["done"]);
  expect(blocked.job?.status).toBe("failed");
  expect(blocked.job?.error).toContain('imports "node:fs"');

  // The rebuild tries the companion, an outside site and a WebSocket. A no-cors fetch
  // resolves whenever the request is answered, so only a blocked request rejects. The
  // block turns green when all three fail and red when any gets through.
  const probe = `import { useEffect, useState } from "react";
const reached = (url: string) => fetch(url, { mode: "no-cors" }).then(() => true, () => false);
const socket = () => new Promise<boolean>((resolve) => { try { const ws = new WebSocket("ws://127.0.0.1:4517/"); ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); ws.onclose = () => resolve(false); } catch { resolve(false); } });
export default function Probe() {
  const [colour, setColour] = useState("rgb(128, 128, 128)");
  useEffect(() => {
    void Promise.all([reached("http://127.0.0.1:4517/captures"), reached("https://example.com/"), socket()]).then((results) => setColour(results.some(Boolean) ? "rgb(220, 0, 0)" : "rgb(0, 200, 0)"));
  }, []);
  return <div style={{ width: 400, height: 200, background: colour }} />;
}
`;
  await writeFile(path.join(dir, "Component.tsx"), probe);
  expect((await post(slug, "preview")).status).toBe(202);
  const probed = await waitFor(slug, ["done"]);
  expect(probed.job?.status).toBe("done");
  const shot = await readFile(path.join(dir, "preview", "default.png"));
  const centre = await page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data.slice(0, 3));
  }, shot.toString("base64"));
  expect(centre).toEqual([0, 200, 0]);
});
