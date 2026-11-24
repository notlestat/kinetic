import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Every .html file in this folder is a page. Tests open them at http://127.0.0.1:5180/<name>.html.
const root = fileURLToPath(new URL(".", import.meta.url));
const input = Object.fromEntries(
  readdirSync(root)
    .filter((f) => f.endsWith(".html"))
    .map((f) => [f.replace(/\.html$/, ""), fileURLToPath(new URL(f, import.meta.url))]),
);

export const TEST_PAGES_PORT = 5180;

export default defineConfig({
  build: { rollupOptions: { input } },
  server: { host: "127.0.0.1", port: TEST_PAGES_PORT, strictPort: true },
  preview: { host: "127.0.0.1", port: TEST_PAGES_PORT, strictPort: true },
});
