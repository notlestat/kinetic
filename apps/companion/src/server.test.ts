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

function post(body: unknown, headers: Record<string, string> = {}) {
  return createApp({ libraryDir }).request("/capture", {
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
