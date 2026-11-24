import { defineConfig } from "@playwright/test";
import { E2E_LIBRARY_DIR } from "./e2e/paths.ts";

// End-to-end tests: Chromium with the test build of the extension, the local test
// pages, and a companion that writes to a temp library. One worker, because the
// companion owns port 4517 and the tests share its library folder.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  webServer: [
    {
      command: "pnpm --filter @kinetic/test-pages build && pnpm --filter @kinetic/test-pages preview",
      url: "http://127.0.0.1:5180/index.html",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @kinetic/companion exec tsx src/index.ts",
      port: 4517,
      // Never reuse a companion that writes to the real library.
      reuseExistingServer: false,
      env: { KINETIC_LIBRARY_DIR: E2E_LIBRARY_DIR },
      timeout: 60_000,
    },
  ],
});
