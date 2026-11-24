# Kinetic: component and motion capture tool

Working name: Kinetic (placeholder, rename freely).

## What it is

A Chrome extension plus a local companion app. You browse any site, hover a component, click it, and Kinetic captures everything needed to rebuild it: structure, styles, every state, and every kind of motion, including GSAP timelines, scroll animations and Three.js scenes. A rebuild step then turns the capture into a clean React component with real motion code, a video of the original for comparison, and a short taste note.

It saves to a shared library and token format so funnel-first and creative-intelligence can pull from it later.

## What one capture produces

```
library/<site>/<component-slug>/
  capture.json        everything below, in one schema (source of truth)
  dom.html            cleaned outer HTML of the component
  styles.json         computed styles per node, mapped to tokens where possible
  states/             hover, focus, active, open, mobile: styles + screenshot each
  motion.json         every animation found, normalised (see Motion schema)
  framework.json      React or Vue component tree, names, props (if detected)
  three/              scene.json, shaders/*.glsl, camera-path.json (if WebGL)
  assets/             lottie.json, .riv, spline urls, fonts list (if found)
  original.webm       video of the component moving (states + scroll)
  Component.tsx       the rebuild (React + Framer Motion or GSAP)
  Component.preview.webm  video of the rebuild, for side by side
  NOTES.md            taste note: why it feels good, in plain words
```

## Motion coverage and how each type is captured

| Motion type | Detection | Capture method | Output quality |
|---|---|---|---|
| CSS transitions and keyframes | always | Chrome DevTools Protocol Animation domain, plus stylesheet keyframe parsing | exact |
| Web Animations API (incl. Motion / Framer Motion when it uses WAAPI) | always | CDP Animation domain, `document.getAnimations()` | exact |
| Hover, focus, active states | always | CDP `CSS.forcePseudoState`, then diff computed styles | exact |
| GSAP tweens and timelines | `window.gsap` | `gsap.globalTimeline.getChildren(true, true, true)`, read `vars`, duration, ease, targets | exact or near |
| GSAP ScrollTrigger | `window.ScrollTrigger` | `ScrollTrigger.getAll()`, read trigger, start, end, scrub, pin | exact or near |
| Lenis / smooth scroll | `window.lenis` or `html.lenis` class | read options | exact |
| Framer Motion (JS driven) | React fiber props named `animate`, `variants`, `transition`, `whileHover` | read props from fiber | near |
| Any other JS motion | fallback | frame sampling: record transform, opacity, size per frame, fit keyframes and easing curve | approximate |
| Scroll-linked motion | always | controlled scroll in steps, sample element values per scroll position | near |
| Three.js | `window.__THREE__` | define `window.__THREE_DEVTOOLS__` at document_start; three.js registers each Scene and WebGLRenderer with it. Serialise with `scene.toJSON()`, pull ShaderMaterial source, wrap `renderer.render` to sample object and camera transforms per frame | scene and shaders exact, animation sampled |
| Other WebGL (OGL, Babylon, raw) | canvas with webgl context | hook `gl.shaderSource` and `getContext` to collect shaders; video for the rest | shaders only + video |
| Lottie, Rive, Spline | network requests and globals | save the animation file or scene URL | exact (file) |

## Framework capture

- React: install a fake `__REACT_DEVTOOLS_GLOBAL_HOOK__` at document_start (only if real DevTools are not present) to get fiber roots. From the clicked DOM node, walk the fiber up to its component boundaries. Record component names (often minified in production), props, and children structure. Use it to decide where to split the rebuild into sub-components.
- Vue: read `__vue_app__` on the root and `__vueParentComponent` on elements. Record component names, props and the tree.
- Neither: split by DOM structure and visual grouping, with Claude doing the final split.

## Architecture

```
apps/extension     Chrome MV3 extension (WXT + TypeScript)
  main-world.ts    runs at document_start in the page's MAIN world: installs React,
                   Vue, Three.js and WebGL hooks before the site loads
  content.ts       picker UI (hover highlight, click to capture), DOM + style capture
  background.ts    chrome.debugger (CDP): Animation domain, forcePseudoState,
                   screenshots; sends finished captures to the companion
apps/companion     local Node app (Playwright + Anthropic SDK), localhost API
                   receives captures, records video, runs frame sampling and scroll
                   sampling, runs the Claude rebuild, writes to library/
apps/library       local web UI to browse, search and compare captures (phase 3)
packages/schema    capture.json types + zod validation, shared by all apps
```

Note: chrome.debugger shows a "this extension is debugging the browser" bar while capturing. That is expected.

## Rebuild step

The companion sends Claude: the screenshots, `dom.html`, `styles.json`, `states/`, `motion.json`, `framework.json` and any Three.js data. Claude returns:

- `Component.tsx` in React + Tailwind, using shared tokens, not hardcoded values
- Motion as Framer Motion by default, GSAP when the original used GSAP or ScrollTrigger, React Three Fiber when the original was Three.js
- `NOTES.md` taste note

Then the companion renders the rebuild in a headless page, records `Component.preview.webm`, and runs a visual diff against the original. If it is too far off, it sends the diff back to Claude for one fix pass.

## Phases

- Phase 1: scaffold and schema, picker, DOM and styles, states, CSS and WAAPI motion, basic React rebuild.
- Phase 2: GSAP and ScrollTrigger, React and Vue framework capture, video recording, scroll sampling, Three.js capture, Lottie, Rive, Spline.
- Phase 3: frame sampling fallback, visual diff and fix loop, library UI, export to funnel-first token format.

## Honest limits

- Rebuilds are close recreations, not the original source code.
- Minified production builds hide real component names.
- Custom shaders are captured as source, but complex post-processing pipelines need manual work.
- Heavily scroll-hijacked sites will come out roughly right and need a polish pass.

## Use rules

Captures are for reference and learning. Rebuild with your own or the client's assets: do not ship scraped 3D models, textures, Lottie files, fonts or copy in client work. Respect sites that block automation, and never capture anything behind a login you do not own.
