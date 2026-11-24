import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CaptureSchema } from "@kinetic/schema";
import sample from "@kinetic/schema/fixtures/sample-capture.json" with { type: "json" };
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./server.ts";

let libraryDir: string;

beforeEach(async () => {
  libraryDir = await mkdtemp(path.join(tmpdir(), "kinetic-library-"));
});

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true });
});

function post(body: unknown, headers: Record<string, string> = {}, route = "/capture") {
  return createApp({ libraryDir }).request(route, {
    method: "POST",
    headers: { host: "127.0.0.1:4517", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /capture", () => {
  it("writes a valid capture to library/<site>/<slug>/capture.json", async () => {
    const res = await post(sample);
    expect(res.status).toBe(201);

    const written = JSON.parse(await readFile(path.join(libraryDir, "example.com", "cta-button", "capture.json"), "utf8"));
    expect(CaptureSchema.parse(written)).toEqual(CaptureSchema.parse(sample));
  });

  it("accepts requests from the extension", async () => {
    const res = await post(sample, { origin: "chrome-extension://abcdefghijklmnop" });
    expect(res.status).toBe(201);
  });

  it("rejects an invalid capture with the validation issues", async () => {
    const res = await post({ ...sample, meta: { ...sample.meta, url: "not a url" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid capture" });
  });

  it("rejects a site name that would escape the library", async () => {
    const res = await post({ ...sample, meta: { ...sample.meta, site: ".." } });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    expect((await post("{nope")).status).toBe(400);
  });

  it("rejects bodies that are not JSON", async () => {
    expect((await post(sample, { "content-type": "text/plain" })).status).toBe(415);
  });

  it("rejects requests from web pages", async () => {
    expect((await post(sample, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("rejects a rebound Host header", async () => {
    expect((await post(sample, { host: "evil.example:4517" })).status).toBe(403);
  });
});

describe("POST /capture section files", () => {
  it("writes dom.html, styles.json and motion.json next to capture.json", async () => {
    expect((await post(sample)).status).toBe(201);
    const dir = path.join(libraryDir, "example.com", "cta-button");
    expect(await readFile(path.join(dir, "dom.html"), "utf8")).toContain('class="cta"');
    expect(JSON.parse(await readFile(path.join(dir, "styles.json"), "utf8"))).toEqual(sample.styles);
    expect(JSON.parse(await readFile(path.join(dir, "motion.json"), "utf8"))).toEqual(sample.motion);
  });
});

describe("POST /capture/file", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const file = (overrides: Record<string, unknown> = {}) => ({
    site: "example.com",
    slug: "cta-button",
    path: "states/hover-0.png",
    contentBase64: png,
    ...overrides,
  });
  const postFile = (body: unknown, headers: Record<string, string> = {}) => post(body, headers, "/capture/file");

  it("writes the decoded file inside the capture folder", async () => {
    const res = await postFile(file());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, path: "example.com/cta-button/states/hover-0.png" });
    const written = await readFile(path.join(libraryDir, "example.com", "cta-button", "states", "hover-0.png"));
    expect([...written]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it.each([
    ["a parent directory", { path: "../other/x.png" }],
    ["an absolute path", { path: "/etc/passwd" }],
    ["a backslash path", { path: "states\\..\\..\\x" }],
    ["a site that climbs out", { site: ".." }],
    ["a slug with a slash", { slug: "a/b" }],
    ["capture.json itself", { path: "capture.json" }],
    ["content that is not base64", { contentBase64: "not base64!" }],
  ])("rejects %s", async (_label, overrides) => {
    expect((await postFile(file(overrides))).status).toBe(400);
  });

  it("uses the same guard as POST /capture", async () => {
    expect((await postFile(file(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await postFile(file(), { host: "evil.example:4517" })).status).toBe(403);
    expect((await postFile(file(), { "content-type": "text/plain" })).status).toBe(415);
    expect((await postFile(file(), { origin: "chrome-extension://abcdefghijklmnop" })).status).toBe(201);
  });
});
