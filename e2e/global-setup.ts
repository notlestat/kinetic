import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { E2E_LIBRARY_DIR, REPO_ROOT } from "./paths.ts";

export default async function globalSetup(): Promise<void> {
  await rm(E2E_LIBRARY_DIR, { recursive: true, force: true });
  await mkdir(E2E_LIBRARY_DIR, { recursive: true });
  // The test build keeps the capture hooks that production builds strip out.
  execFileSync("pnpm", ["--filter", "@kinetic/extension", "exec", "wxt", "build", "--mode", "test"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}
