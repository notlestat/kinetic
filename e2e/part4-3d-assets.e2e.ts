import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MotionEntry } from "@kinetic/schema";
import { captureDirFor, captureSelector, expect, fileExists, openTestPage, readCaptureJson, test } from "./fixtures.ts";

const SITE = "127.0.0.1";

async function readJson<T = Record<string, unknown>>(slug: string, file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(captureDirFor(SITE, slug), file), "utf8")) as T;
}

const threeEntries = (entries: readonly MotionEntry[], object: string) =>
  entries.filter((e) => e.source === "three" && (e.raw as { object?: string }).object === object);

test("captures a three.js scene: scene.json, shaders, camera path and renderer settings", async ({ page }) => {
  test.setTimeout(90_000);
  await openTestPage(page, "three.html");
  await page.waitForTimeout(500); // Let the render loop start.
  const outcome = await captureSelector(page, "section.stage", "three-stage");
  expect(outcome).toMatchObject({ ok: true });
  const capture = await readCaptureJson(SITE, "three-stage");
  const three = capture.three;
  if (!three) throw new Error("no three block");

  expect(three.revision).toBe("187");
  expect(three.reactThreeFiber).toBe(false);
  expect(three.canvas).toBe("#scene");
  expect(three.renderer).toMatchObject({
    toneMapping: "ACESFilmicToneMapping",
    toneMappingExposure: 1.1,
    outputColorSpace: "srgb",
    shadows: { enabled: true, type: "PCFShadowMap" },
  });
  expect(three.fog).toEqual({ type: "Fog", color: "#0a2540", near: 8, far: 20 });
  expect(three.lights?.map((l) => l.name).sort()).toEqual(["Fill", "Key"]);
  expect(three.lights?.find((l) => l.name === "Key")).toMatchObject({ type: "DirectionalLight", intensity: 2, castShadow: true, position: [3, 5, 2] });
  expect(three.camera).toMatchObject({ type: "PerspectiveCamera", fov: 50 });
  expect(three.camera?.target.map((n) => Math.round(n * 10) / 10)).toEqual([0, 0, 0]);
  expect(three.postProcessing).toEqual(expect.arrayContaining(["RenderPass", "OutputShader"]));

  // scene.json keeps geometry parameters and leaves out the 15000-number point cloud.
  expect(three.sceneFile).toBe("three/scene.json");
  // three.js writes each geometry's parameters next to its type.
  const scene = await readJson<{ geometries: ({ type: string } & Record<string, unknown>)[]; object: { children: { name: string }[] } }>(
    "three-stage",
    "three/scene.json",
  );
  expect(scene.geometries.find((g) => g.type === "TorusKnotGeometry")).toMatchObject({ radius: 1, tube: 0.32 });
  expect(scene.object.children.map((c) => c.name)).toEqual(expect.arrayContaining(["Hero", "Ground", "Stars", "Fill", "Key"]));
  expect(three.stripped).toEqual([expect.objectContaining({ path: expect.stringMatching(/attributes\.position$/), size: 15000 })]);

  // The ShaderMaterial's sources and uniforms.
  expect(three.shaderFiles).toEqual(["three/shaders/hero-glow-1.vert.glsl", "three/shaders/hero-glow-1.frag.glsl"]);
  expect(await readFile(path.join(captureDirFor(SITE, "three-stage"), three.shaderFiles[1] as string), "utf8")).toContain("uniform vec3 uColor");
  const index = await readJson<{ name: string; uniforms: Record<string, unknown>; usedBy: string[] }[]>("three-stage", "three/shaders/index.json");
  expect(index[0]).toMatchObject({ name: "HeroGlow", usedBy: ["Hero"], uniforms: { uColor: "#635bff", uResolution: [1, 1] } });

  // The camera path: per-render samples while idle, and one sample per scroll step.
  const cameraPath = await readJson<{ frames: { camera: { position: number[] } }[]; scroll?: { steps: { progress: number }[] } }>(
    "three-stage",
    "three/camera-path.json",
  );
  expect(cameraPath.frames.length).toBeGreaterThan(10);
  // The camera block is read after the scroll pass, once the scene is back where the capture started.
  expect(three.camera?.position).toEqual(cameraPath.frames[0]?.camera.position);
  expect(cameraPath.scroll?.steps.length).toBe(9);

  // Motion: the steady spin is an endless loop of one turn; the camera follows scroll.
  const entries = capture.motion?.entries ?? [];
  const [spin] = threeEntries(entries, "Hero");
  expect(spin).toMatchObject({ trigger: "loop", iterations: "infinite", easing: "linear" });
  expect(spin?.duration).toBeGreaterThan(7854 * 0.95);
  expect(spin?.duration).toBeLessThan(7854 * 1.05);
  expect(spin?.properties.map((p) => p.name)).toEqual(["rotation.y"]);
  const [cameraScroll] = threeEntries(entries, "camera").filter((e) => e.trigger === "scroll");
  expect(cameraScroll?.scroll).toMatchObject({ start: 0, scrub: true });
  expect(cameraScroll?.properties.map((p) => p.name)).toEqual(expect.arrayContaining(["position.y", "position.z"]));
  const z = cameraScroll?.properties.find((p) => p.name === "position.z")?.keyframes;
  expect(z?.[0]?.value).toBeCloseTo(6, 1);
  expect(z?.at(-1)?.value).toBeCloseTo(3, 1);
  expect(capture.motion?.summary?.suggestedLibrary).toBe("react-three-fiber");
});

test("captures a React Three Fiber scene and marks it as R3F", async ({ page }) => {
  test.setTimeout(90_000);
  await openTestPage(page, "r3f.html");
  await page.waitForSelector("section.stage canvas");
  await page.waitForTimeout(500);
  const outcome = await captureSelector(page, "section.stage", "r3f-stage");
  expect(outcome).toMatchObject({ ok: true });
  const capture = await readCaptureJson(SITE, "r3f-stage");
  expect(capture.three).toMatchObject({ reactThreeFiber: true, sceneFile: "three/scene.json", cameraPathFile: "three/camera-path.json" });
  expect(capture.three?.camera).toMatchObject({ type: "PerspectiveCamera", fov: 45, position: [0, 1.5, 4] });
  expect(capture.framework?.detected).toContainEqual(expect.objectContaining({ name: "react" }));
  const [spin] = threeEntries(capture.motion?.entries ?? [], "Box");
  expect(spin).toMatchObject({ trigger: "loop", iterations: "infinite" });
  expect(spin?.duration).toBeGreaterThan(5236 * 0.95);
  expect(spin?.duration).toBeLessThan(5236 * 1.05);
  expect(await fileExists(path.join(captureDirFor(SITE, "r3f-stage"), "three/scene.json"))).toBe(true);
});

test("saves a bundled lottie-web animation's JSON and its timing", async ({ page }) => {
  await openTestPage(page, "lottie.html");
  await page.waitForSelector(".pulse svg");
  const outcome = await captureSelector(page, "section.badge", "lottie-badge");
  expect(outcome).toMatchObject({ ok: true });
  const capture = await readCaptureJson(SITE, "lottie-badge");
  expect(capture.assets?.files).toEqual([{ kind: "lottie", url: "http://127.0.0.1:5180/lottie/pulse.json", file: "assets/pulse-1.json" }]);
  const saved = await readJson<{ nm: string; op: number }>("lottie-badge", "assets/pulse-1.json");
  expect(saved).toMatchObject({ nm: "Pulse", op: 60 });
  const [entry] = (capture.motion?.entries ?? []).filter((e) => e.source === "lottie");
  expect(entry).toMatchObject({
    target: expect.stringContaining("div.pulse"),
    trigger: "load",
    duration: 2000,
    iterations: "infinite",
    properties: [{ name: "frame", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: 60 }] }],
  });
  expect((entry?.raw as { timing?: { markers?: string[] } }).timing?.markers).toEqual(["start"]);
});
