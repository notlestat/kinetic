// Detects which frameworks a page runs. Pure: the MAIN world hands in a probe over
// window and document, and tests hand in a fake one.

import type { DetectedFramework } from "@kinetic/schema";

export interface FrameworkProbe {
  /** Reads a window global. */
  global(name: string): unknown;
  /** document.querySelector, returning the element or null. */
  query(selector: string): object | null;
  /** True when some element carries a React fiber (__reactFiber$ or __reactContainer$ key). */
  reactNodeFound: boolean;
  /** True when some element has a Svelte scoped class (svelte-xyz123). */
  svelteClassFound: boolean;
  /** <meta name="generator"> content, e.g. "Astro v5.1.0". */
  generator: string | null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function withVersion(name: DetectedFramework["name"], version: string | undefined): DetectedFramework {
  return version ? { name, version } : { name };
}

/** The React version from a DevTools hook: each renderer reports the React it was built with. */
export function reactVersion(hook: unknown): string | undefined {
  const renderers = (hook as { renderers?: unknown })?.renderers;
  if (!(renderers instanceof Map)) return undefined;
  for (const renderer of renderers.values()) {
    const version = str((renderer as { version?: unknown })?.version);
    if (version) return version;
  }
  return undefined;
}

export function detectFrameworks(probe: FrameworkProbe): DetectedFramework[] {
  const found: DetectedFramework[] = [];

  // React: a renderer injected into the DevTools hook, or fibers on DOM nodes.
  const hook = probe.global("__REACT_DEVTOOLS_GLOBAL_HOOK__");
  const hookRenderers = (hook as { renderers?: unknown })?.renderers;
  const react = (hookRenderers instanceof Map && hookRenderers.size > 0) || probe.reactNodeFound;
  if (react) found.push(withVersion("react", reactVersion(hook) ?? str((probe.global("React") as { version?: unknown })?.version)));

  // Next.js: pages router writes __NEXT_DATA__; both routers set window.next.
  const next = probe.global("next") as { version?: unknown } | undefined;
  if (probe.global("__NEXT_DATA__") !== undefined || next?.version !== undefined || probe.query("script#__NEXT_DATA__") || probe.global("__next_f") !== undefined) {
    found.push(withVersion("next", str(next?.version)));
  }

  // Vue 3 marks app containers with data-v-app and __vue_app__; Vue 2 puts __vue__ on the root element.
  const container = probe.query("[data-v-app]") as { __vue_app__?: { version?: unknown } } | null;
  const vue2 = probe.global("Vue") as { version?: unknown } | undefined;
  if (container?.__vue_app__ || probe.global("__VUE__") !== undefined || str(vue2?.version)) {
    found.push(withVersion("vue", str(container?.__vue_app__?.version) ?? str(vue2?.version)));
  }

  // Nuxt: __NUXT__ (Nuxt 2 and 3) or the #__nuxt mount point.
  if (probe.global("__NUXT__") !== undefined || probe.query("#__nuxt") || probe.global("useNuxtApp") !== undefined) {
    found.push({ name: "nuxt" });
  }

  // Svelte 5 registers its major version in window.__svelte.v; older builds leave svelte-xyz classes.
  const svelte = probe.global("__svelte") as { v?: unknown } | undefined;
  if (svelte !== undefined || probe.svelteClassFound) {
    const versions = svelte?.v instanceof Set ? [...svelte.v].map(String) : [];
    found.push(withVersion("svelte", versions[0]));
  }

  // Astro: islands are <astro-island> elements; the generator meta carries the version.
  const astroGenerator = probe.generator ? /^Astro v?([\d.]+)/i.exec(probe.generator) : null;
  if (probe.query("astro-island") || astroGenerator) found.push(withVersion("astro", astroGenerator?.[1]));

  return found;
}
