// Builds one preview run: an untrusted Component.tsx plus the harness that mounts it.
// The companion starts this build in a child process with KINETIC_PREVIEW_RUN set to
// the run folder (sandbox/.runs/<id>/). Nothing in the run is executed here: Vite only
// parses and bundles it, and the bundle runs later in a locked-down Playwright page.
//
// Component.tsx may import only the packages below. It may not import files, use
// import.meta (which reaches files through import.meta.glob and new URL()), or pull
// any file into the bundle through a CSS url().

import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const sandboxDir = path.dirname(fileURLToPath(import.meta.url));
const runDir = process.env.KINETIC_PREVIEW_RUN;
if (!runDir) throw new Error("KINETIC_PREVIEW_RUN is not set; the companion starts this build");
const run = path.resolve(runDir);
const runsDir = path.join(sandboxDir, ".runs");
if (path.dirname(run) !== runsDir) throw new Error("KINETIC_PREVIEW_RUN must be a folder inside sandbox/.runs");

const componentFile = path.join(run, "Component.tsx");
/** The run's own entry files, which the companion writes. Vite names the bundled CSS after them. */
const entryFiles = new Set(["index.html", "index.css", "main.tsx"].map((name) => path.join(run, name)));

/** Packages Component.tsx may import, with any subpath (gsap/ScrollTrigger, three/addons/...). */
export const ALLOWED_PACKAGES = ["react", "react-dom", "framer-motion", "gsap", "three", "@react-three/fiber", "@react-three/drei"] as const;

/** motion/react is Framer Motion's newer name; the sandbox ships framer-motion, which exports the same API. */
const ALIASES: Readonly<Record<string, string>> = { motion: "framer-motion", "motion/react": "framer-motion" };

const stripQuery = (id: string) => id.replace(/[?#].*$/, "");
const isAllowed = (source: string) => ALLOWED_PACKAGES.some((name) => source === name || source.startsWith(`${name}/`));
// pnpm keeps package files in the repo's node_modules/.pnpm, so "from a package" means a node_modules segment.
const fromPackage = (file: string) => file.split(path.sep).includes("node_modules");

function guardComponent(): Plugin {
  return {
    name: "kinetic:guard-component",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || stripQuery(importer) !== componentFile) return null;
      // Virtual helpers Vite adds itself (the preload helper) start with \0.
      if (source.startsWith("\0")) return null;
      const alias = ALIASES[source];
      if (alias) return this.resolve(alias, importer, { skipSelf: true });
      if (isAllowed(source)) return null;
      this.error(`Component.tsx imports "${source}". It may import only: ${ALLOWED_PACKAGES.join(", ")}.`);
    },
    moduleParsed(info) {
      // Vite resolves some ids (Node builtins such as node:fs) before resolveId runs,
      // so check what the component's imports actually resolved to.
      if (stripQuery(info.id) !== componentFile) return;
      for (const id of [...info.importedIds, ...info.dynamicallyImportedIds]) {
        if (!id.startsWith("\0") && !fromPackage(stripQuery(id))) this.error(`Component.tsx imports "${id}". It may import only: ${ALLOWED_PACKAGES.join(", ")}.`);
      }
    },
    transform(code, id) {
      if (stripQuery(id) !== componentFile) return null;
      if (/\bimport\s*\.\s*meta\b/.test(code)) this.error("Component.tsx may not use import.meta.");
      return null;
    },
    generateBundle(_options, bundle) {
      // assetsInlineLimit is 0, so every file a url() reached is an emitted asset. Only
      // files from the sandbox's own packages may be bundled.
      for (const item of Object.values(bundle)) {
        if (item.type !== "asset") continue;
        const sources = item.originalFileNames ?? [];
        const outside = sources.map((name) => path.resolve(run, name)).filter((file) => !entryFiles.has(file) && !fromPackage(file));
        if (outside.length > 0) this.error(`The build tried to include a file from outside the sandbox (${item.fileName} from ${outside.join(", ")}). Component.tsx may not reference files.`);
      }
    },
  };
}

export default defineConfig({
  root: run,
  base: "./",
  publicDir: false,
  logLevel: "warn",
  clearScreen: false,
  plugins: [guardComponent(), react(), tailwindcss()],
  build: {
    outDir: path.join(run, "dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 4096,
  },
});
