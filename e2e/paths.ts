import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Fixed, so the Playwright runner and the companion it starts agree on it. Emptied by global setup. */
export const E2E_LIBRARY_DIR = path.join(tmpdir(), "kinetic-e2e-library");
export const EXTENSION_DIR = path.join(REPO_ROOT, "apps/extension/.output/chrome-mv3-test");
export const TEST_PAGES = "http://127.0.0.1:5180";
