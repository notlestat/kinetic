import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadCompanionEnv, rebuildSettings } from "./env.ts";
import { failInterruptedJobs } from "./jobs.ts";
import { createApp, HOST, PORT } from "./server.ts";

// apps/companion/.env holds the optional api mode's key. Only variable names are ever logged.
const fromEnvFile = loadCompanionEnv();

// src/index.ts and dist/index.js both sit one level inside apps/companion, so this reaches the repo root.
const libraryDir = process.env.KINETIC_LIBRARY_DIR ?? fileURLToPath(new URL("../../../library", import.meta.url));
// Each capture is recorded as soon as it arrives unless KINETIC_AUTO_RECORD=0.
const autoRecord = process.env.KINETIC_AUTO_RECORD !== "0";
const rebuild = rebuildSettings();

const interrupted = await failInterruptedJobs(libraryDir);

serve({ fetch: createApp({ libraryDir, autoRecord, rebuild }).fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[kinetic] companion listening on http://${HOST}:${info.port}`);
  console.log(`[kinetic] writing captures to ${libraryDir}`);
  console.log(`[kinetic] recording new captures: ${autoRecord ? "on" : "off (KINETIC_AUTO_RECORD=0)"}`);
  const auto = rebuild.mode === "handoff" ? "" : rebuild.autoRebuild ? ", rebuilds after each recording" : ", rebuilds on request (KINETIC_AUTO_REBUILD=1 to run after each recording)";
  console.log(`[kinetic] rebuild mode: ${rebuild.mode}${rebuild.mode === "api" ? ` (${rebuild.model})` : ""}${auto}`);
  if (rebuild.mode === "api" && !process.env.ANTHROPIC_API_KEY) console.log("[kinetic] api mode has no ANTHROPIC_API_KEY: add it to apps/companion/.env");
  if (fromEnvFile.length > 0) console.log(`[kinetic] loaded ${fromEnvFile.join(", ")} from apps/companion/.env`);
  if (interrupted > 0) console.log(`[kinetic] marked ${interrupted} interrupted job(s) as failed`);
});
