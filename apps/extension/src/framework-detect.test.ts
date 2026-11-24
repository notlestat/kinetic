import { describe, expect, it } from "vitest";
import { detectFrameworks, type FrameworkProbe } from "./framework-detect.ts";

function probe(globals: Record<string, unknown>, elements: Record<string, object> = {}, extra: Partial<FrameworkProbe> = {}): FrameworkProbe {
  return {
    global: (name) => globals[name],
    query: (selector) => elements[selector] ?? null,
    reactNodeFound: false,
    svelteClassFound: false,
    generator: null,
    ...extra,
  };
}

describe("detectFrameworks", () => {
  it("finds React with its version from the DevTools hook, and Next.js", () => {
    const hook = { renderers: new Map([[1, { version: "19.3.1" }]]) };
    expect(detectFrameworks(probe({ __REACT_DEVTOOLS_GLOBAL_HOOK__: hook, __NEXT_DATA__: {}, next: { version: "16.0.0" } }))).toEqual([
      { name: "react", version: "19.3.1" },
      { name: "next", version: "16.0.0" },
    ]);
  });

  it("finds React from fibers when no renderer registered", () => {
    expect(detectFrameworks(probe({ __REACT_DEVTOOLS_GLOBAL_HOOK__: { renderers: new Map() } }, {}, { reactNodeFound: true }))).toEqual([{ name: "react" }]);
    expect(detectFrameworks(probe({ __REACT_DEVTOOLS_GLOBAL_HOOK__: { renderers: new Map() } }))).toEqual([]);
  });

  it("finds Vue 3 from the app container, Vue 2 from window.Vue, and Nuxt", () => {
    expect(detectFrameworks(probe({ __NUXT__: {} }, { "[data-v-app]": { __vue_app__: { version: "3.5.46" } } }))).toEqual([
      { name: "vue", version: "3.5.46" },
      { name: "nuxt" },
    ]);
    expect(detectFrameworks(probe({ Vue: { version: "2.7.16" } }))).toEqual([{ name: "vue", version: "2.7.16" }]);
  });

  it("finds Svelte and Astro islands", () => {
    expect(detectFrameworks(probe({ __svelte: { v: new Set(["5"]) } }))).toEqual([{ name: "svelte", version: "5" }]);
    expect(detectFrameworks(probe({}, {}, { svelteClassFound: true }))).toEqual([{ name: "svelte" }]);
    expect(detectFrameworks(probe({}, { "astro-island": {} }, { generator: "Astro v5.2.1" }))).toEqual([{ name: "astro", version: "5.2.1" }]);
  });

  it("finds nothing on a plain page", () => {
    expect(detectFrameworks(probe({}))).toEqual([]);
  });
});
