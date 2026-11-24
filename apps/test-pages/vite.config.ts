import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
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
  plugins: [react()],
  // Vue's esm-bundler build reads these flags. The Vue page uses render functions, so no Vue plugin is needed.
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
  // three.js alone is about 740 kB; these pages are only served locally.
  build: { rollupOptions: { input }, chunkSizeWarningLimit: 1000 },
  server: { host: "127.0.0.1", port: TEST_PAGES_PORT, strictPort: true },
  preview: { host: "127.0.0.1", port: TEST_PAGES_PORT, strictPort: true },
});
