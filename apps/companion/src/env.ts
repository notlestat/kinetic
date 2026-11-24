// Settings for the rebuild step, read from the environment, plus apps/companion/.env
// for the optional api mode's key. Values from .env never override the real
// environment, and no value is ever logged.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { type RebuildMode, RebuildModeSchema } from "@kinetic/schema";

/** The model api mode uses unless KINETIC_REBUILD_MODEL names another. */
export const DEFAULT_REBUILD_MODEL = "claude-opus-5-5";
const DEFAULT_CLI_TIMEOUT_MS = 15 * 60_000;

/** Names (never values) of the variables loadCompanionEnv set from .env. */
const fromFile = new Set<string>();

/** src/ and dist/ both sit one level inside apps/companion. */
export function companionEnvFile(): string {
  return fileURLToPath(new URL("../.env", import.meta.url));
}

/** Loads apps/companion/.env when it exists. Returns the names it set. */
export function loadCompanionEnv(file = companionEnvFile(), env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] !== undefined || value === undefined) continue;
    env[name] = value;
    fromFile.add(name);
    loaded.push(name);
  }
  return loaded;
}

/** True when the variable came from apps/companion/.env rather than the shell. */
export function loadedFromEnvFile(name: string): boolean {
  return fromFile.has(name);
}

export interface RebuildSettings {
  mode: RebuildMode;
  /** KINETIC_AUTO_REBUILD=1 starts a rebuild after each recording (claude-cli and api modes only). */
  autoRebuild: boolean;
  model: string;
  /** How long the claude CLI may run, in ms. */
  cliTimeoutMs: number;
}

export function rebuildSettings(env: NodeJS.ProcessEnv = process.env): RebuildSettings {
  const rawMode = env.KINETIC_REBUILD_MODE?.trim() || "handoff";
  const mode = RebuildModeSchema.safeParse(rawMode);
  if (!mode.success) throw new Error(`KINETIC_REBUILD_MODE must be handoff, claude-cli or api, not "${rawMode}"`);
  const timeout = env.KINETIC_REBUILD_TIMEOUT_MS ? Number(env.KINETIC_REBUILD_TIMEOUT_MS) : DEFAULT_CLI_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("KINETIC_REBUILD_TIMEOUT_MS must be a positive number of milliseconds");
  return {
    mode: mode.data,
    autoRebuild: env.KINETIC_AUTO_REBUILD === "1",
    model: env.KINETIC_REBUILD_MODEL?.trim() || DEFAULT_REBUILD_MODEL,
    cliTimeoutMs: timeout,
  };
}
