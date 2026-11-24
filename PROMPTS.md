# Kinetic: Codex prompts

Run each prompt in its own git worktree. Read SPEC.md first and keep it in the repo root so every prompt can reference it.

Order and dependencies:
- Prompt 0 must be merged first (scaffold and schema). Everything else builds on it.
- Prompts 1, 2, 3 and 4 can run in parallel after 0.
- Prompt 5 needs 1 merged (it receives captures from the extension).
- Prompt 6 needs 1 and 5 merged.
- Prompt 7 is phase 3, run last.

Expect small merge conflicts in `packages/schema/src/capture.ts` and `apps/extension/src/main-world.ts`, since several branches add to them. Each prompt tells Codex to add its own section rather than rewrite the file, which keeps conflicts small.

---

## Prompt 0: scaffold and schema

```
Read SPEC.md in the repo root. It describes Kinetic, a Chrome extension plus local companion app that captures a website component's structure, styles, states and motion, then rebuilds it as React.

Your job: set up the monorepo and the shared schema. Do not build features yet.

1. pnpm workspace with TypeScript strict mode everywhere:
   - apps/extension: Chrome MV3 extension using WXT. Entry points: background, content script (isolated world), and a MAIN world content script at document_start called main-world.ts. Each entry point just logs that it loaded.
   - apps/companion: Node 20 app with a small HTTP server on localhost:4517 (use Hono). One route: POST /capture that validates the body with the schema and writes it to library/<site>/<slug>/capture.json.
   - apps/library: empty Vite + React app, placeholder page only.
   - packages/schema: zod schemas and exported types for capture.json.
2. The schema in packages/schema/src/capture.ts must cover every section in the "What one capture produces" part of SPEC.md: meta (url, site, timestamp, viewport, selector), dom, styles, states, motion, framework, three, assets, media file paths. Make each feature section optional so other branches can fill them in later. Put each section in its own clearly commented block so later branches can extend one block without touching the others.
3. Define the normalised motion entry type exactly once, used by every capture method:
   { id, source: "css-transition" | "css-keyframes" | "waapi" | "gsap" | "scrolltrigger" | "framer-motion" | "sampled" | "three" | "lottie" | "rive" | "spline",
     target (selector), trigger: "load" | "hover" | "focus" | "click" | "scroll" | "loop" | "unknown",
     properties: [{ name, keyframes: [{ offset, value }] }],
     duration ms, delay ms, easing (css string or cubic-bezier numbers), iterations, direction, stagger?, scroll?: { start, end, scrub, pin }, confidence: "exact" | "near" | "approximate", raw (unknown, original data kept for debugging) }
4. Add a library/ folder to .gitignore.
5. Root scripts: pnpm dev:extension, pnpm dev:companion, pnpm build, pnpm typecheck, pnpm test (vitest).
6. README with setup steps: how to load the unpacked extension in Chrome and start the companion.

Done when: pnpm typecheck and pnpm build pass, the extension loads in Chrome with no errors, and posting a sample capture to the companion writes a valid capture.json. Include that sample capture as a test fixture.
```

---

## Prompt 1: picker, DOM, styles and states

```
Read SPEC.md. The scaffold and schema already exist (packages/schema). Build the core capture flow in apps/extension.

1. Picker (content.ts): a toggle from the extension icon or Alt+Shift+K. When on, hovering highlights the element under the cursor with an outline and a small label (tag, size). Arrow Up/Down moves the selection to the parent or first child so the user can grab a whole section. Click captures. Esc exits. The picker UI must live in a shadow root so site CSS cannot break it.
2. DOM capture: cleaned outerHTML of the selected element. Remove scripts, tracking attributes and inline event handlers. Keep classes, aria and data attributes. Convert relative image and asset URLs to absolute.
3. Style capture: for the element and every descendant, record computed styles but only the properties that differ from the browser default for that tag, so the output stays small. Record bounding boxes too. Collect the fonts actually used (family, weight, style, and the @font-face source URL if found).
4. Token mapping: cluster colours, font sizes, spacing, radii and shadows across the captured nodes and replace raw values with token names where a value repeats. Output a tokens block in styles.json.
5. States (background.ts, using chrome.debugger and CDP): for each interactive element inside the selection (links, buttons, inputs, anything with a cursor:pointer), use CSS.forcePseudoState to force hover, focus and active one at a time. Diff computed styles against the default and save only the changes, plus a screenshot of the selection in each state (Page.captureScreenshot clipped to the bounding box). Also capture a mobile state by emulating a 390px viewport with Emulation.setDeviceMetricsOverride, then restore.
6. Send the finished capture to the companion at POST localhost:4517/capture. If the companion is not running, show a clear message in the picker label and keep the capture in extension storage to retry.

Only edit the dom, styles and states blocks of the schema if you need to extend them. Do not rewrite other blocks.

Done when: capturing a button and a nav bar on stripe.com and linear.app produces valid capture.json files with styles, tokens, hover states and screenshots. Add unit tests for the token clustering and the default-style diffing.
```

---

## Prompt 2: CSS, WAAPI, GSAP and ScrollTrigger motion

```
Read SPEC.md, especially the motion coverage table. The scaffold and the normalised motion entry type exist in packages/schema. Build motion capture for CSS, Web Animations API, GSAP, ScrollTrigger and Lenis.

1. CDP Animation domain (background.ts): when capture starts, enable Animation, listen for animationCreated and animationStarted, and record each animation that targets a node inside the selection. Trigger the component's states (hover each interactive element via Input.dispatchMouseEvent, focus, and a page reload for load animations if the user opts in) so animations actually fire. Use Animation.getCurrentTime and the animation's source data to get keyframes, duration, delay, easing and iterations. Normalise into motion entries with confidence "exact".
2. Stylesheet parsing: in the page, collect @keyframes rules and transition declarations that apply to nodes in the selection, as a cross-check and to catch animations that did not fire during capture.
3. document.getAnimations() in the MAIN world as a second source for WAAPI animations (Motion and Framer Motion often use WAAPI). Deduplicate against CDP results.
4. GSAP (main-world.ts): if window.gsap exists, read gsap.globalTimeline.getChildren(true, true, true). For each tween whose targets are inside the selection, record vars, duration, delay, ease name, stagger, repeat, yoyo and the timeline position. Convert GSAP ease names to cubic-bezier where a known mapping exists, and keep the original name too.
5. ScrollTrigger: if window.ScrollTrigger exists, read ScrollTrigger.getAll(). For triggers related to the selection, record trigger element, start, end, scrub, pin, toggleActions and the linked animation. Set trigger "scroll" and fill the scroll block.
6. Lenis: detect window.lenis or html.lenis, record its options in meta, since smooth scroll changes how motion feels.
7. Write a small motion summary into capture.json: count by source and the overall trigger types, so the rebuild step can quickly decide between Framer Motion and GSAP.

Hooks that read page globals must run in the MAIN world (main-world.ts) and pass data to the content script with window.postMessage using a unique message type. Add your code as a clearly marked section in main-world.ts. Only extend the motion block of the schema.

Done when: on a site with CSS hover transitions, a site using GSAP and a site using ScrollTrigger (pick well-known public examples and list them in the README), captures contain correct motion entries. Add tests for normalisation using recorded fixtures.
```

---

## Prompt 3: React and Vue framework capture

```
Read SPEC.md, the "Framework capture" section. Build framework detection and component tree capture.

1. React (main-world.ts, runs at document_start): if window.__REACT_DEVTOOLS_GLOBAL_HOOK__ is not already defined, install a minimal fake hook that supports inject, onCommitFiberRoot and getFiberRoots so React registers its renderer and roots with it. If the real React DevTools hook exists, read from it without replacing it.
2. From the selected DOM node, find its fiber (the __reactFiber$ property), then walk up and down to build the component tree for the selection: component display names (note when they look minified), props (strip functions to "[function]", truncate big objects, drop anything that looks like a token or secret), key, and which DOM nodes each component owns.
3. Framer Motion: when a fiber's props include animate, initial, exit, variants, transition, whileHover, whileTap, whileInView or layout, extract them as motion entries with source "framer-motion" and confidence "near". Add these to the motion block.
4. Vue 3: detect __vue_app__ on the root element or __VUE__ on window. From the selected element read __vueParentComponent, walk up the instance tree, record component names (type.name or __name), props and the tree. Also detect Vue 2 via __vue__ and capture names and props where possible.
5. Also record detected frameworks and versions in meta (React, Next.js via __NEXT_DATA__, Vue, Nuxt via __NUXT__, Svelte, Astro islands via astro-island elements).
6. Output framework.json content through the framework block of the schema, including a suggested component split: a list of proposed sub-components with the DOM nodes they cover, which the rebuild step will use.

Add your code as a clearly marked section in main-world.ts. Never break the site: wrap every hook in try/catch and never throw into page code.

Done when: captures on a Next.js site, a Vue or Nuxt site and a site using Framer Motion produce a sensible component tree and Framer Motion props. Add tests with fixture fiber trees.
```

---

## Prompt 4: Three.js, WebGL, Lottie, Rive and Spline

```
Read SPEC.md, the Three.js and other WebGL rows of the motion table. Build 3D and animation-file capture.

1. Three.js hook (main-world.ts, document_start): define window.__THREE_DEVTOOLS__ as an EventTarget before page scripts run. three.js dispatches "register" (with the revision) and "observe" events to it, where event.detail is a Scene or WebGLRenderer. Keep references to every scene and renderer.
2. When the user captures a selection that contains or overlaps a canvas used by a registered renderer:
   - Serialise the scene with scene.toJSON(). Strip large binary buffers above a size limit (keep geometry type, parameters and counts) so the file stays manageable, and record what was stripped.
   - Extract ShaderMaterial and RawShaderMaterial vertexShader, fragmentShader and uniform names and current values into three/shaders/*.glsl plus a json index.
   - Record the camera type, fov, position, rotation and target, lights, fog, tone mapping and renderer settings (pixel ratio, output colour space, shadow settings).
   - Animation sampling: wrap renderer.render for 3 seconds, and on each frame record position, rotation, scale of every named or top-level object and the camera. Then do the same while scrolling the page in steps, to get a camera-path.json linked to scroll position. Restore the original render method afterwards.
   - Detect post-processing (EffectComposer passes) and list the pass types.
   - Detect React Three Fiber (a canvas inside a fiber with the r3f root) and note it in meta.
3. Other WebGL: patch HTMLCanvasElement.prototype.getContext to track webgl and webgl2 contexts, and patch shaderSource on those contexts to collect shader source for any engine (OGL, Babylon, PixiJS, raw WebGL). Detect window.BABYLON and window.PIXI and note them.
4. Lottie: detect lottie-web and dotlottie players, find the animation JSON or .lottie URL from player config or network requests (chrome.debugger Network domain in background.ts), save to assets/.
5. Rive: detect rive canvases and save the .riv URL. Spline: detect spline-viewer elements or Spline runtime and save the scene URL.
6. Add three, assets and matching motion entries (source "three", "lottie", "rive", "spline") to capture.json.

Add your code as a clearly marked section in main-world.ts. All hooks must be wrapped in try/catch and must not change rendering output.

Done when: captures on three.js official examples (threejs.org/examples), a React Three Fiber demo and a site with a Lottie animation produce scene.json, shaders, a camera path and asset files. Document which sites you tested in the README.
```

---

## Prompt 5: companion recorder, scroll sampling and frame sampling

```
Read SPEC.md. The extension already posts captures to apps/companion at POST localhost:4517/capture. Build the recording side in the companion with Playwright.

1. After a capture arrives, open the same URL in a Playwright Chromium page with the same viewport. Find the component by the selector in meta (fall back to matching by text and bounding box if the selector fails).
2. Record original.webm of the component: idle for 1.5s, then each hover and focus state from states, then a scroll pass through the component's scroll range. Crop the video to the component's box plus padding using ffmpeg.
3. Scroll sampling: scroll in small steps through the range where the component is in view. At each step record transform, opacity, clip-path and bounding box for every node in the selection. Turn the results into motion entries with trigger "scroll" and confidence "near", and merge them with existing scroll entries (do not duplicate ScrollTrigger entries that already exist).
4. Frame sampling fallback: for animations that are visible but have no motion entry yet (compare before and after states), use requestAnimationFrame in the page to record transform, opacity and size of each moving node for every frame. Fit keyframes by simplifying the curve, and fit the easing to the closest cubic-bezier. Save as source "sampled" with confidence "approximate".
5. Add a GET /captures route listing captures, and GET /captures/:site/:slug returning one capture with file URLs, for the library UI later.
6. Make all of this a job queue so captures process one at a time, with status written to capture.json (queued, recording, done, failed plus error).

Done when: a capture of a component with hover motion and a scroll animation produces a cropped original.webm and scroll and sampled motion entries. Add tests for the keyframe simplification and easing fit.
```

---

## Prompt 6: Claude rebuild

```
Read SPEC.md, the "Rebuild step" section. Build the rebuild in apps/companion using the Anthropic SDK. The API key comes from ANTHROPIC_API_KEY in a local .env, never committed.

1. After recording finishes, build a rebuild request: state screenshots, dom.html, styles.json with tokens, states, motion.json, framework.json (and its suggested component split), and the three block if present. Keep the request under a size budget: summarise styles to the most important properties per node if needed.
2. Prompt Claude to output:
   - Component.tsx: React + TypeScript + Tailwind, using the captured tokens as CSS variables, split into sub-components following the suggested split.
   - Motion: Framer Motion by default. GSAP plus ScrollTrigger when the motion summary shows GSAP or ScrollTrigger as the main source. React Three Fiber plus drei when a three block exists, recreating the scene structure, camera path and shaders from the capture.
   - Every animation must use the exact durations, delays, easing and stagger from motion.json when confidence is exact or near.
   - NOTES.md: a short plain-language taste note: what makes this component feel good, the key motion values, and anything the rebuild could not match.
   Use structured output (a JSON object with files) so the result is easy to parse.
3. Render the rebuild in a Vite sandbox page with Playwright, record Component.preview.webm with the same state and scroll script as the original, and screenshot each state.
4. Visual diff: compare original and rebuild screenshots per state with pixelmatch. If the difference is above a threshold, send Claude the diff images and the numbers for one fix pass, then re-render.
5. Save everything to the capture folder and update status.

Done when: a captured button with hover motion, a GSAP section and a three.js example each produce a working Component.tsx that renders in the sandbox, a preview video and NOTES.md. Include those three outputs as examples.
```

---

## Prompt 7: library UI (phase 3)

```
Read SPEC.md. The companion exposes GET /captures and GET /captures/:site/:slug. Build apps/library, a local Vite + React app.

1. Grid of captures with a looping muted preview of original.webm, the site, component name and tags (motion sources, frameworks, has-3D).
2. Search and filters: by site, motion source (GSAP, ScrollTrigger, Framer Motion, CSS, three, Lottie), trigger (hover, scroll, load), and free text across NOTES.md.
3. Detail page: original and rebuild videos side by side and in sync, state screenshots, the motion timeline drawn as bars per property with easing curves, tokens, the component tree, the taste note, and a copy button for Component.tsx.
4. Export button: write the tokens in the funnel-first token format (ask me for the format file and put a placeholder adapter in packages/schema/src/export-funnel-first.ts until I provide it).

Done when: the library lists real captures, filters work, and the side by side videos stay in sync.
```
