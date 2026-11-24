import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, HOST, PORT } from "./server.ts";

// src/index.ts and dist/index.js both sit one level inside apps/companion, so this reaches the repo root.
const libraryDir = process.env.KINETIC_LIBRARY_DIR ?? fileURLToPath(new URL("../../../library", import.meta.url));

serve({ fetch: createApp({ libraryDir }).fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[kinetic] companion listening on http://${HOST}:${info.port}`);
  console.log(`[kinetic] writing captures to ${libraryDir}`);
});
