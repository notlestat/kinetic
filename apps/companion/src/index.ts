import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { failInterruptedJobs } from "./jobs.ts";
import { createApp, HOST, PORT } from "./server.ts";

// src/index.ts and dist/index.js both sit one level inside apps/companion, so this reaches the repo root.
const libraryDir = process.env.KINETIC_LIBRARY_DIR ?? fileURLToPath(new URL("../../../library", import.meta.url));
// Each capture is recorded as soon as it arrives unless KINETIC_AUTO_RECORD=0.
const autoRecord = process.env.KINETIC_AUTO_RECORD !== "0";

const interrupted = await failInterruptedJobs(libraryDir);

serve({ fetch: createApp({ libraryDir, autoRecord }).fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[kinetic] companion listening on http://${HOST}:${info.port}`);
  console.log(`[kinetic] writing captures to ${libraryDir}`);
  console.log(`[kinetic] recording new captures: ${autoRecord ? "on" : "off (KINETIC_AUTO_RECORD=0)"}`);
  if (interrupted > 0) console.log(`[kinetic] marked ${interrupted} interrupted job(s) as failed`);
});
