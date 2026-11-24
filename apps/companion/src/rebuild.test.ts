import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Capture, CaptureSchema, type Preview } from "@kinetic/schema";
import sample from "@kinetic/schema/fixtures/sample-capture.json" with { type: "json" };
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REBUILD_MODEL, loadCompanionEnv, type RebuildSettings, rebuildSettings } from "./env.ts";
import { type JobContext, JobQueue } from "./jobs.ts";
import { writeJson } from "./library.ts";
import { API_MAX_TOKENS, buildApiRequest, CLI_FIX_PROMPT, CLI_PROMPT, type CliRunOptions, claudeCliArgs, createRebuildJob, type RebuildClient, runClaudeCli } from "./rebuild.ts";

let libraryDir: string;
let dir: string;

beforeEach(async () => {
  libraryDir = await mkdtemp(path.join(tmpdir(), "kinetic-rebuild-"));
  dir = path.join(libraryDir, "example.com", "cta-button");
  await mkdir(path.join(dir, "states"), { recursive: true });
  await writeJson(path.join(dir, "capture.json"), sample);
  await writeFile(path.join(dir, "dom.html"), `${sample.dom.html}\n`);
  const image = new PNG({ width: 4, height: 4 });
  await writeFile(path.join(dir, "states", "hover.png"), PNG.sync.write(image));
});

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true });
});

const settings = (mode: RebuildSettings["mode"], overrides: Partial<RebuildSettings> = {}): RebuildSettings => ({ mode, autoRebuild: false, model: DEFAULT_REBUILD_MODEL, cliTimeoutMs: 5000, ...overrides });

function context(statuses: string[] = []): JobContext {
  return {
    site: "example.com",
    slug: "cta-button",
    dir,
    setStatus: async (status) => {
      statuses.push(status);
    },
    enqueue: async () => undefined,
  };
}

const passing: Preview = { threshold: 0.1, scores: [{ state: "hover", original: "states/hover.png", score: 0.02 }], passed: true, renderedAt: "2026-11-24T12:00:00.000Z" };
const failing: Preview = { ...passing, scores: [{ state: "hover", original: "states/hover.png", score: 0.4 }], passed: false, diffReport: "DIFF.md" };

async function readCaptureJson(): Promise<Capture> {
  return CaptureSchema.parse(JSON.parse(await readFile(path.join(dir, "capture.json"), "utf8")));
}

const writeComponent = async (options: CliRunOptions) => {
  await writeFile(path.join(options.cwd, "Component.tsx"), "export default function C() { return null; }\n");
  await writeFile(path.join(options.cwd, "NOTES.md"), "Calm.\n");
  return "";
};

describe("rebuildSettings", () => {
  it("defaults to handoff with no auto-rebuild and the default model", () => {
    expect(rebuildSettings({})).toEqual({ mode: "handoff", autoRebuild: false, model: "claude-opus-5-5", cliTimeoutMs: 900_000 });
  });

  it("reads the mode, KINETIC_AUTO_REBUILD=1 only, and a model override", () => {
    expect(rebuildSettings({ KINETIC_REBUILD_MODE: "claude-cli", KINETIC_AUTO_REBUILD: "1" })).toMatchObject({ mode: "claude-cli", autoRebuild: true });
    expect(rebuildSettings({ KINETIC_REBUILD_MODE: "api", KINETIC_AUTO_REBUILD: "true" }).autoRebuild).toBe(false);
    expect(rebuildSettings({ KINETIC_REBUILD_MODEL: "claude-sonnet-5-5" }).model).toBe("claude-sonnet-5-5");
  });

  it("refuses an unknown mode and a bad timeout", () => {
    expect(() => rebuildSettings({ KINETIC_REBUILD_MODE: "magic" })).toThrow("KINETIC_REBUILD_MODE");
    expect(() => rebuildSettings({ KINETIC_REBUILD_TIMEOUT_MS: "-5" })).toThrow("KINETIC_REBUILD_TIMEOUT_MS");
  });
});

describe("loadCompanionEnv", () => {
  it("sets missing variables from the file, never overrides the shell, and returns names only", async () => {
    const file = path.join(libraryDir, ".env");
    await writeFile(file, "ANTHROPIC_API_KEY=sk-test-value\nKINETIC_REBUILD_MODE=api\n");
    const env: NodeJS.ProcessEnv = { KINETIC_REBUILD_MODE: "handoff" };
    expect(loadCompanionEnv(file, env)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(env).toEqual({ KINETIC_REBUILD_MODE: "handoff", ANTHROPIC_API_KEY: "sk-test-value" });
    expect(loadCompanionEnv(path.join(libraryDir, "missing.env"), env)).toEqual([]);
  });
});

describe("handoff mode", () => {
  it("writes REBUILD.md, records the mode and waits, without running anything", async () => {
    const runCli = vi.fn(writeComponent);
    const createClient = vi.fn();
    const preview = vi.fn(async () => passing);
    const status = await createRebuildJob({ settings: settings("handoff"), runCli, createClient, preview })(context());
    expect(status).toBe("awaiting-rebuild");
    expect(runCli).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(await readFile(path.join(dir, "REBUILD.md"), "utf8")).toContain("## Output contract");
    expect((await readCaptureJson()).rebuild).toMatchObject({ mode: "handoff", prompt: "REBUILD.md", fixPasses: 0 });
  });
});

describe("claude-cli mode", () => {
  it("runs the CLI in the capture folder, previews, and finishes without a fix pass when the preview passes", async () => {
    const runCli = vi.fn(writeComponent);
    const preview = vi.fn(async () => passing);
    const statuses: string[] = [];
    const status = await createRebuildJob({ settings: settings("claude-cli"), runCli, preview })(context(statuses));
    expect(status).toBe("done");
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli).toHaveBeenCalledWith({ cwd: dir, prompt: CLI_PROMPT, timeoutMs: 5000 });
    expect(preview).toHaveBeenCalledWith(dir);
    expect(statuses).toEqual(["rebuilding", "previewing"]);
    expect((await readCaptureJson()).rebuild).toMatchObject({ mode: "claude-cli", fixPasses: 0 });
    expect((await readCaptureJson()).rebuild?.model).toBeUndefined();
  });

  it("runs one automatic fix pass when the preview is over the threshold, and only one", async () => {
    const runCli = vi.fn(writeComponent);
    const preview = vi.fn(async () => failing);
    const statuses: string[] = [];
    const status = await createRebuildJob({ settings: settings("claude-cli"), runCli, preview })(context(statuses));
    expect(status).toBe("done");
    expect(runCli.mock.calls.map(([o]) => o.prompt)).toEqual([CLI_PROMPT, CLI_FIX_PROMPT]);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(["rebuilding", "previewing", "rebuilding", "previewing"]);
    expect((await readCaptureJson()).rebuild?.fixPasses).toBe(1);
  });

  it("fails the job with the CLI's error output, and when the CLI writes no Component.tsx", async () => {
    const queue = new JobQueue({
      libraryDir,
      onError: () => undefined,
      handlers: { rebuild: createRebuildJob({ settings: settings("claude-cli"), runCli: async () => Promise.reject(new Error("the claude CLI exited with 1:\nnot signed in")), preview: async () => passing }) },
    });
    await queue.enqueue("example.com", "cta-button", "rebuild");
    await queue.idle();
    expect((await readCaptureJson()).job).toMatchObject({ status: "failed", error: "the claude CLI exited with 1:\nnot signed in" });

    const silent = createRebuildJob({ settings: settings("claude-cli"), runCli: async () => "done", preview: async () => passing });
    await expect(silent(context())).rejects.toThrow("finished without writing Component.tsx");
  });
});

describe("runClaudeCli", () => {
  async function stub(script: string): Promise<string> {
    const file = path.join(libraryDir, "fake-claude.mjs");
    await writeFile(file, `#!/usr/bin/env node\n${script}\n`);
    await chmod(file, 0o755);
    return file;
  }

  it("passes the prompt and flags as an argument array and runs in the capture folder", async () => {
    const bin = await stub(`import { writeFileSync } from "node:fs"; writeFileSync("args.json", JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); console.log("ok");`);
    expect(await runClaudeCli({ cwd: dir, prompt: CLI_PROMPT, timeoutMs: 10_000, bin })).toContain("ok");
    const { args, cwd } = JSON.parse(await readFile(path.join(dir, "args.json"), "utf8"));
    expect(args).toEqual(claudeCliArgs(CLI_PROMPT));
    expect(args.slice(0, 2)).toEqual(["-p", "Follow REBUILD.md"]);
    expect(await import("node:fs/promises").then((fs) => fs.realpath(cwd))).toBe(await import("node:fs/promises").then((fs) => fs.realpath(dir)));
  });

  it("limits the CLI to file tools inside the folder and refuses anything else", () => {
    const args = claudeCliArgs(CLI_PROMPT);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Write,Edit,Glob,Grep");
    expect(args).not.toContain("Bash");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args.slice(args.indexOf("--allowedTools") + 1)).toEqual(["Read(./**)", "Edit(./**)"]);
    expect(args).toContain("--strict-mcp-config");
  });

  it("rejects with stderr on a non-zero exit, with a hint when the CLI is missing, and on timeout", async () => {
    const failingBin = await stub(`console.error("Invalid API key · Please run /login"); process.exit(2);`);
    await expect(runClaudeCli({ cwd: dir, prompt: CLI_PROMPT, timeoutMs: 10_000, bin: failingBin })).rejects.toThrow("the claude CLI exited with 2:\nInvalid API key · Please run /login");
    await expect(runClaudeCli({ cwd: dir, prompt: CLI_PROMPT, timeoutMs: 10_000, bin: path.join(libraryDir, "no-such-claude") })).rejects.toThrow("the claude CLI was not found");
    const slowBin = await stub(`setTimeout(() => {}, 60_000);`);
    await expect(runClaudeCli({ cwd: dir, prompt: CLI_PROMPT, timeoutMs: 300, bin: slowBin })).rejects.toThrow("did not finish within 0 s");
  });
});

describe("api mode", () => {
  type Parse = RebuildClient["messages"]["parse"];
  function mockClient(response: { stop_reason: string | null; parsed_output: unknown }) {
    const parse = vi.fn(async () => response);
    const client = { messages: { parse: parse as unknown as Parse } };
    return { parse, createClient: async () => client };
  }
  const output = { componentTsx: "export default function C() { return <div />; }", notesMd: "Soft and quick." };

  it("sends REBUILD.md, the files and screenshots with explicit effort and no thinking settings, then writes the files", async () => {
    const { parse, createClient } = mockClient({ stop_reason: "end_turn", parsed_output: output });
    const status = await createRebuildJob({ settings: settings("api"), createClient, preview: async () => passing })(context());
    expect(status).toBe("done");
    expect(parse).toHaveBeenCalledTimes(1);
    const [params] = parse.mock.calls[0] as unknown as [Record<string, unknown> & { messages: { content: { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] }[] }];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(API_MAX_TOKENS);
    expect(params.output_config).toMatchObject({ effort: "high", format: { type: "json_schema" } });
    expect(params).not.toHaveProperty("thinking");
    expect(JSON.stringify(params)).not.toContain("budget_tokens");
    const content = params.messages[0]?.content ?? [];
    expect(content[0]?.text).toContain('<file path="REBUILD.md">');
    expect(content[0]?.text).toContain('<file path="dom.html">');
    const image = content.find((b) => b.type === "image");
    expect(image?.source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(Buffer.from(image?.source?.data ?? "", "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(await readFile(path.join(dir, "Component.tsx"), "utf8")).toBe(`${output.componentTsx}\n`);
    expect(await readFile(path.join(dir, "NOTES.md"), "utf8")).toBe(`${output.notesMd}\n`);
    expect((await readCaptureJson()).rebuild).toMatchObject({ mode: "api", model: "claude-opus-5-5", fixPasses: 0 });
  });

  it("uses KINETIC_REBUILD_MODEL and sends a fix pass with the diff when the preview fails", async () => {
    const { parse, createClient } = mockClient({ stop_reason: "end_turn", parsed_output: output });
    await writeFile(path.join(dir, "DIFF.md"), "# Preview diff\n");
    await createRebuildJob({ settings: settings("api", { model: "claude-sonnet-5-5" }), createClient, preview: async () => failing })(context());
    expect(parse).toHaveBeenCalledTimes(2);
    const calls = parse.mock.calls as unknown as [{ model: string; messages: { content: { text?: string }[] }[] }][];
    expect(calls.map(([p]) => p.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    const fixText = calls[1]?.[0].messages[0]?.content[0]?.text ?? "";
    expect(fixText).toContain(CLI_FIX_PROMPT);
    expect(fixText).toContain('<file path="DIFF.md">');
    expect(fixText).toContain('<file path="Component.tsx">');
  });

  it("refuses a refusal, a max_tokens cut-off and a missing parsed output", async () => {
    for (const [response, message] of [
      [{ stop_reason: "refusal", parsed_output: null }, "declined"],
      [{ stop_reason: "max_tokens", parsed_output: null }, "max_tokens"],
      [{ stop_reason: "end_turn", parsed_output: null }, "no parsed output"],
      [{ stop_reason: "end_turn", parsed_output: { componentTsx: "  ", notesMd: "" } }, "empty"],
    ] as const) {
      const { createClient } = mockClient(response);
      await expect(createRebuildJob({ settings: settings("api"), createClient, preview: async () => passing })(context())).rejects.toThrow(message);
    }
  });

  it("needs ANTHROPIC_API_KEY only in api mode", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(createRebuildJob({ settings: settings("api"), preview: async () => passing })(context())).rejects.toThrow("api mode needs ANTHROPIC_API_KEY");
      await expect(createRebuildJob({ settings: settings("handoff") })(context())).resolves.toBe("awaiting-rebuild");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("builds a request the SDK's types accept", async () => {
    const request = await buildApiRequest(dir, CaptureSchema.parse(sample), "claude-opus-5-5", false);
    expect(request.output_config.format.type).toBe("json_schema");
    expect(typeof request.output_config.format.parse).toBe("function");
  });
});
