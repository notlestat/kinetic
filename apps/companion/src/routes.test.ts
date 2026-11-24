import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Capture, CaptureSchema } from "@kinetic/schema";
import sample from "@kinetic/schema/fixtures/sample-capture.json" with { type: "json" };
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobQueue } from "./jobs.ts";
import { createRecordJob, type Recorder } from "./record-job.ts";
import { createApp } from "./server.ts";

const HOST = { host: "127.0.0.1:4517" };
let libraryDir: string;
let outside: string;

beforeEach(async () => {
  libraryDir = await mkdtemp(path.join(tmpdir(), "kinetic-library-"));
  outside = await mkdtemp(path.join(tmpdir(), "kinetic-outside-"));
});

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** A recorder that writes a fake video and one sampled entry, instead of starting Chromium. */
const fakeRecorder: Recorder = async ({ dir }) => {
  await writeFile(path.join(dir, "original.webm"), "webm");
  return {
    drafts: [
      {
        key: "sampled|loop|#dot",
        entry: {
          source: "sampled",
          target: "#dot",
          trigger: "loop",
          properties: [{ name: "opacity", keyframes: [{ offset: 0, value: 1 }, { offset: 1, value: 0.2 }] }],
          duration: 1200,
          delay: 0,
          easing: "linear",
          iterations: "infinite",
          direction: "normal",
          confidence: "approximate",
          raw: null,
        },
      },
    ],
    recording: {
      file: "original.webm",
      durationMs: 4000,
      size: { width: 320, height: 120 },
      locatedBy: "selector",
      steps: [{ kind: "idle", start: 0, end: 1500 }],
      recordedAt: "2026-11-24T12:00:00.000Z",
    },
  };
};

function app(options: { autoRecord?: boolean; recorder?: Recorder } = {}) {
  const jobs = new JobQueue({ libraryDir, handlers: { record: createRecordJob(options.recorder ?? fakeRecorder) }, onError: () => undefined });
  return { jobs, app: createApp({ libraryDir, jobs, ...(options.autoRecord !== undefined ? { autoRecord: options.autoRecord } : {}) }) };
}

async function saveSample(target: ReturnType<typeof createApp>, overrides: Partial<Capture["meta"]> = {}) {
  const body = { ...sample, meta: { ...sample.meta, ...overrides } };
  const res = await target.request("/capture", { method: "POST", headers: { ...HOST, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return res;
}

async function readCaptureFile(site = "example.com", slug = "cta-button"): Promise<Capture> {
  return CaptureSchema.parse(JSON.parse(await readFile(path.join(libraryDir, site, slug, "capture.json"), "utf8")));
}

describe("GET /captures", () => {
  it("lists captures newest first with summaries and media URLs", async () => {
    const { app: a } = app();
    await saveSample(a, { slug: "older", timestamp: "2026-01-01T00:00:00.000Z" });
    await saveSample(a, { slug: "newer", timestamp: "2026-02-01T00:00:00.000Z" });
    const res = await a.request("/captures", { headers: HOST });
    expect(res.status).toBe(200);
    const { captures } = (await res.json()) as { captures: { slug: string; media: Record<string, string>; framework: unknown }[] };
    expect(captures.map((c) => c.slug)).toEqual(["newer", "older"]);
    expect(captures[0]?.media.dom).toBe("http://127.0.0.1:4517/files/example.com/newer/dom.html");
    expect(captures[0]?.framework).toEqual({ kind: expect.any(String), detected: expect.any(Array) });
  });

  it("returns an empty list for an empty library and reports unreadable captures", async () => {
    const { app: a } = app();
    expect(await (await a.request("/captures", { headers: HOST })).json()).toEqual({ captures: [] });
    await mkdir(path.join(libraryDir, "site.com", "broken"), { recursive: true });
    await writeFile(path.join(libraryDir, "site.com", "broken", "capture.json"), "{}");
    expect(await (await a.request("/captures", { headers: HOST })).json()).toEqual({
      captures: [{ site: "site.com", slug: "broken", error: "capture.json is not a valid capture" }],
    });
  });

  it("sits behind the Host and Origin guard", async () => {
    const { app: a } = app();
    expect((await a.request("/captures", { headers: { host: "evil.example:4517" } })).status).toBe(403);
    expect((await a.request("/captures", { headers: { ...HOST, origin: "https://evil.example" } })).status).toBe(403);
  });
});

describe("GET /captures/:site/:slug", () => {
  it("returns the capture and a URL for every file in its folder", async () => {
    const { app: a } = app();
    await saveSample(a);
    await mkdir(path.join(libraryDir, "example.com", "cta-button", "states"));
    await writeFile(path.join(libraryDir, "example.com", "cta-button", "states", "hover 0.png"), "png");
    const res = await a.request("/captures/example.com/cta-button", { headers: HOST });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capture: Capture; files: { path: string; url: string; contentType: string }[] };
    expect(body.capture.meta.slug).toBe("cta-button");
    expect(body.files.map((f) => f.path)).toEqual(["capture.json", "dom.html", "motion.json", "states/hover 0.png", "styles.json"]);
    expect(body.files.find((f) => f.path.endsWith(".png"))).toMatchObject({
      url: "http://127.0.0.1:4517/files/example.com/cta-button/states/hover%200.png",
      contentType: "image/png",
    });
  });

  it("answers 404 for a missing capture and 400 for an unsafe name", async () => {
    const { app: a } = app();
    expect((await a.request("/captures/example.com/missing", { headers: HOST })).status).toBe(404);
    // URL parsing drops an encoded ".." segment before routing, so it never names a capture.
    expect((await a.request("/captures/example.com/%2e%2e", { headers: HOST })).status).toBe(404);
    // A decoded slug that is not one safe segment is refused.
    expect((await a.request("/captures/example.com/a%2Fb", { headers: HOST })).status).toBe(400);
  });
});

describe("GET /files/:site/:slug/*", () => {
  async function setup() {
    const { app: a } = app();
    await saveSample(a);
    const dir = path.join(libraryDir, "example.com", "cta-button");
    await writeFile(path.join(dir, "original.webm"), Buffer.from("0123456789"));
    await writeFile(path.join(dir, "Component.tsx"), "export default function C() {}");
    await writeFile(path.join(dir, "NOTES.md"), "# Notes");
    await mkdir(path.join(dir, "three", "shaders"), { recursive: true });
    await writeFile(path.join(dir, "three", "shaders", "glow.frag.glsl"), "void main() {}");
    return a;
  }

  it.each([
    ["original.webm", "video/webm"],
    ["dom.html", "text/plain; charset=utf-8"],
    ["motion.json", "application/json; charset=utf-8"],
    ["Component.tsx", "text/plain; charset=utf-8"],
    ["NOTES.md", "text/markdown; charset=utf-8"],
    ["three/shaders/glow.frag.glsl", "text/plain; charset=utf-8"],
  ])("serves %s as %s, never as something the browser would run", async (file, type) => {
    const a = await setup();
    const res = await a.request(`/files/example.com/cta-button/${file}`, { headers: HOST });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("serves byte ranges for video seeking", async () => {
    const a = await setup();
    const res = await a.request("/files/example.com/cta-button/original.webm", { headers: { ...HOST, range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
    const suffix = await a.request("/files/example.com/cta-button/original.webm", { headers: { ...HOST, range: "bytes=-3" } });
    expect(await suffix.text()).toBe("789");
    const bad = await a.request("/files/example.com/cta-button/original.webm", { headers: { ...HOST, range: "bytes=20-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */10");
  });

  it.each([
    ["an encoded parent directory", "/files/example.com/cta-button/%2e%2e/%2e%2e/secret.txt"],
    ["an encoded slash", "/files/example.com/cta-button/..%2f..%2fsecret.txt"],
    ["an encoded backslash", "/files/example.com/cta-button/..%5c..%5csecret.txt"],
    ["an unsafe site", "/files/%2e%2e/cta-button/dom.html"],
    ["an empty path", "/files/example.com/cta-button/"],
  ])("rejects %s", async (_label, url) => {
    const a = await setup();
    await writeFile(path.join(libraryDir, "secret.txt"), "secret");
    const res = await a.request(url, { headers: HOST });
    expect([400, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("secret\n");
  });

  it("does not follow a symlink out of the capture folder", async () => {
    const a = await setup();
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(libraryDir, "example.com", "cta-button", "link.txt"));
    const res = await a.request("/files/example.com/cta-button/link.txt", { headers: HOST });
    expect(res.status).toBe(400);
  });

  it("answers 404 for a missing file", async () => {
    const a = await setup();
    expect((await a.request("/files/example.com/cta-button/nope.png", { headers: HOST })).status).toBe(404);
  });
});

describe("recording jobs", () => {
  it("POST /captures/:site/:slug/record queues a job that records and merges entries", async () => {
    const { app: a, jobs } = app();
    await saveSample(a);
    const res = await a.request("/captures/example.com/cta-button/record", { method: "POST", headers: { ...HOST, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, job: { status: "queued" } });
    await jobs.idle();
    const capture = await readCaptureFile();
    expect(capture.job?.status).toBe("done");
    expect(capture.recording?.file).toBe("original.webm");
    expect(capture.media?.original).toBe("original.webm");
    const sampled = capture.motion?.entries.filter((e) => e.source === "sampled") ?? [];
    expect(sampled.map((e) => e.id)).toEqual(["sampled-1"]);
    expect(capture.motion?.summary?.bySource.sampled).toBe(1);
    // motion.json matches capture.json.
    const motionFile = JSON.parse(await readFile(path.join(libraryDir, "example.com", "cta-button", "motion.json"), "utf8"));
    expect(motionFile).toEqual(capture.motion);
  });

  it("recording twice replaces the sampled entries instead of adding more", async () => {
    const { app: a, jobs } = app();
    await saveSample(a);
    for (let i = 0; i < 2; i++) {
      await a.request("/captures/example.com/cta-button/record", { method: "POST", headers: { ...HOST, "content-type": "application/json" }, body: "{}" });
      await jobs.idle();
    }
    expect((await readCaptureFile()).motion?.entries.filter((e) => e.source === "sampled")).toHaveLength(1);
  });

  it("marks the job failed with the error when recording fails", async () => {
    const { app: a, jobs } = app({ recorder: async () => Promise.reject(new Error("Chromium crashed")) });
    await saveSample(a);
    await a.request("/captures/example.com/cta-button/record", { method: "POST", headers: { ...HOST, "content-type": "application/json" }, body: "{}" });
    await jobs.idle();
    expect((await readCaptureFile()).job).toMatchObject({ status: "failed", error: "Chromium crashed" });
  });

  it("POST record needs JSON, a known capture and passes the guard", async () => {
    const { app: a } = app();
    await saveSample(a);
    const url = "/captures/example.com/cta-button/record";
    expect((await a.request(url, { method: "POST", headers: HOST })).status).toBe(415);
    expect((await a.request("/captures/example.com/missing/record", { method: "POST", headers: { ...HOST, "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await a.request(url, { method: "POST", headers: { ...HOST, "content-type": "application/json", origin: "http://127.0.0.1:5173" }, body: "{}" })).status).toBe(403);
  });

  it("queues a recording when a capture arrives with autoRecord on, and not with it off", async () => {
    const off = app({ autoRecord: false });
    const offBody = await (await saveSample(off.app, { slug: "manual" })).json();
    expect(offBody).not.toHaveProperty("job");
    expect((await readCaptureFile("example.com", "manual")).job).toBeUndefined();

    const on = app({ autoRecord: true });
    const onBody = await (await saveSample(on.app, { slug: "auto" })).json();
    expect(onBody).toMatchObject({ job: { status: "queued" } });
    await on.jobs.idle();
    expect((await readCaptureFile("example.com", "auto")).job?.status).toBe("done");
  });
});
