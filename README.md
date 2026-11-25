<img src="assets/icon.svg" width="64" height="64" alt="">

# Kinetic

Kinetic copies a component from a web page as a prompt for Claude Code. You click a component, and the Chrome extension records its DOM, styles, states and motion. It then copies one self-contained prompt to your clipboard. Paste the prompt into Claude Code in your own project, and Claude Code rebuilds the component in React.

The extension works on its own. It needs no server, no API key and no saved files.

[SPEC.md](SPEC.md) describes the original design. [PROMPTS.md](PROMPTS.md) holds the step-by-step prompts the build followed.

## Requirements

- Node.js 20.19 or later
- pnpm 12
- Google Chrome or Chrome for Testing
- Claude Code, to paste the prompt into

The companion and the end-to-end tests also need Playwright's Chromium: `pnpm exec playwright install chromium`.

## Set up the workspace

Install the dependencies from the repository root:

```sh
pnpm install
```

The install also runs `wxt prepare`, which generates the extension's TypeScript config in `apps/extension/.wxt/`. `pnpm-workspace.yaml` allows the install scripts of `esbuild` and `ffmpeg-static`. pnpm blocks every other package's install script.

## Install the extension

1. Build the extension:

	```sh
	pnpm --filter @kinetic/extension build
	```

2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select `apps/extension/.output/chrome-mv3`.

After you rebuild, click **Reload** on the Kinetic card. Tabs that are already open don't need a refresh. The first time you start the picker in such a tab, Kinetic loads itself into the page. A late start can miss the React or Vue component tree and animations that began before Kinetic arrived, so refresh the page when you want the full capture.

For development, run `pnpm dev:extension` instead. WXT opens Chrome with the extension loaded and reloads it when files change.

## Copy a component

1. Open the page and press Alt+Shift+K, or click the Kinetic icon. An orange box follows your pointer.
2. Point at the component. Arrow Up selects the parent and Arrow Down selects the first child.
3. Click or press Enter. Esc closes the picker.
4. Wait for the label to say `Copied. Paste it into Claude Code.` A capture takes a few seconds, because Kinetic forces each hover, focus and active state.
5. Paste the prompt into Claude Code in the project where the component should go.

To also capture animations that run on page load, hold Shift when you click or press Enter. The page reloads once while Kinetic watches.

While Kinetic captures, Chrome shows a bar that says Kinetic started debugging the browser. The extension uses the debugger to force states and read animations, and it detaches when the capture ends.

If the Kinetic icon shows a red `!` badge, Chrome kept Kinetic out of that page. Chrome does this on its own pages, such as `chrome://extensions`, on the Chrome Web Store and in the PDF viewer.

## What the prompt contains

The prompt tells Claude Code to read your project's setup first, then build the component in React, TypeScript and Tailwind CSS with the tokens as CSS variables. If the motion library isn't installed, Claude Code asks before adding it. The prompt contains these sections, and leaves out any section the capture has no data for:

- **Motion:** the motion library to use (Framer Motion, GSAP with ScrollTrigger, or React Three Fiber with drei) and a table of every animation with its duration, delay, easing, stagger and confidence.
- **three.js scene:** camera, lights, renderer settings, fog and post-processing.
- **States:** the style changes in each hover, focus and active state.
- **Tokens:** colours, font sizes, spacing, radii and shadows as CSS variables.
- **Component tree:** how the original split its React or Vue components.
- **Markup:** the cleaned HTML of the component.
- **Computed styles:** the styles of each element that differ from the browser default.
- **Fonts** and **Shaders**, when the page has them.

Long sections are cut to fit: 24,000 characters of markup, 30,000 of styles, 12,000 of shaders and 40 motion rows. The label says so when a cut happens. Screenshots, videos and downloaded assets stay out of the prompt, because the clipboard holds text only. `apps/extension/src/clipboard-prompt.ts` builds the prompt.

## Work with saved captures

The repository also has a companion app and a library UI from the first build. They record a video of a capture, write a rebuild brief to `REBUILD.md`, score a rebuild against the original, and let you browse captures. The extension no longer sends captures to them. They work with capture folders already on disk, such as the committed examples in `examples/`, or a capture you post to `POST /capture` yourself.

Start the companion against the examples:

```sh
KINETIC_LIBRARY_DIR="$PWD/examples" KINETIC_AUTO_RECORD=0 pnpm dev:companion
```

It listens on `http://127.0.0.1:4517`. Without `KINETIC_LIBRARY_DIR`, it uses `library/` in the repository root, which Git ignores. The companion crops videos with the ffmpeg binary from `ffmpeg-static`. To use another ffmpeg, set `KINETIC_FFMPEG` to its path.

## Record the component moving

When a capture arrives at `POST /capture`, the companion records it. It opens the same URL in Playwright's Chromium at the same viewport, finds the component, and records idle time, a hover and a focus on up to six interactive elements, and a scroll pass. The result is `original.webm`, cropped to the component. Motion that no other source explained, such as scroll-linked transforms and JavaScript loops, becomes sampled motion entries.

To record only when you ask, start the companion with `KINETIC_AUTO_RECORD=0` and post to the record route:

```sh
curl -X POST http://127.0.0.1:4517/captures/example.com/cta-button/record \
	-H 'content-type: application/json' -d '{}'
```

When the recording finishes, the companion writes `REBUILD.md` and the capture waits for a rebuild.

## Rebuild the component

`KINETIC_REBUILD_MODE` picks how the rebuild runs. In every mode the rebuild writes `Component.tsx` (React, TypeScript and Tailwind, with tokens as CSS variables) and a taste note in `NOTES.md`, in the capture folder.

`REBUILD.md` picks the motion library from the capture: Framer Motion by default, GSAP and ScrollTrigger when GSAP drives the motion, and React Three Fiber with drei when the capture has a three.js scene. It lists the exact durations, delays, easing and stagger, the states, tokens and component tree, and relative links to the screenshots and data files.

### Hand off to your own agent (default)

Handoff mode needs nothing extra. After a recording, give `REBUILD.md` to your coding agent, for example: "Open library/example.com/cta-button/REBUILD.md and follow it." The agent writes `Component.tsx` and `NOTES.md`, then runs the preview from the repository root:

```sh
pnpm kinetic preview example.com/cta-button
```

To rewrite `REBUILD.md` for an existing capture, run `pnpm kinetic rebuild example.com/cta-button`.

### Run the Claude Code CLI

With `KINETIC_REBUILD_MODE=claude-cli`, the companion runs `claude -p "Follow REBUILD.md"` in the capture folder. The rebuild uses your Claude Code plan, so it needs no API key.

The CLI may read and write files only in the capture folder. The companion stops it after 15 minutes, and `KINETIC_REBUILD_TIMEOUT_MS` changes the limit. If the CLI is missing or fails, the job fails with the CLI's error output.

Start a rebuild in one of three ways: the rebuild panel in the library, `pnpm kinetic rebuild <site>/<slug>`, or `POST /captures/<site>/<slug>/rebuild`. To rebuild after every recording, set `KINETIC_AUTO_REBUILD=1`.

### Use the Claude API (optional)

API mode sends `REBUILD.md`, the capture's data files and the state screenshots to the Claude API and saves the structured reply. It is the only mode that needs a key. To set it up:

1. Copy the example file:

	```sh
	cp apps/companion/.env.example apps/companion/.env
	```

2. Set `ANTHROPIC_API_KEY` in `apps/companion/.env`. Git ignores that file, and the companion never logs the key.
3. Start the companion with `KINETIC_REBUILD_MODE=api`, or set it in the same file.

The model is `claude-opus-5-5`. `KINETIC_REBUILD_MODEL` overrides it.

### Draw it on a canvas instead

`REBUILD.md` ends with a canvas target for Blueprint or Paper. Ask your agent to follow that section instead of the output contract. The agent draws one artboard per state (default, hover, focus and mobile) in HTML and CSS with the tokens, and puts the motion values in a note beside each artboard.

## Check the rebuild

The preview runs in every mode:

```sh
pnpm kinetic preview example.com/cta-button
```

The companion builds `Component.tsx` in the sandbox at `apps/companion/sandbox` and renders it in Chromium with every outside request blocked. The rebuild may import only React, Framer Motion, GSAP, three.js, React Three Fiber and drei. The companion never imports or runs `Component.tsx` itself.

The preview records `Component.preview.webm` with the same script as `original.webm` and screenshots each state. pixelmatch compares each screenshot with the original, and the companion saves the scores in `capture.json`.

If a state differs by more than 10% of its pixels, the companion writes `DIFF.md` with the numbers and the diff images. It also adds a "Fix pass" section to `REBUILD.md`. CLI and API modes run one fix pass on their own. In handoff mode, ask your agent to follow the Fix pass section. To change the threshold, set `KINETIC_DIFF_THRESHOLD` to a number from 0 to 1.

If the companion is running, `pnpm kinetic` asks it to do the work. Otherwise the command runs the preview itself.

## Browse the library

Start the library UI with the companion running:

```sh
pnpm dev:library
```

Open `http://127.0.0.1:5173`. The grid shows each capture's video, site, component name, motion sources, frameworks and whether it has a 3D scene. Filter by site, motion source (GSAP, ScrollTrigger, Framer Motion, CSS, three and Lottie) or trigger (hover, scroll and load), or search names, URLs and taste notes.

A capture's page plays the original and the rebuild side by side on one clock. It also shows the state screenshots with their scores, a motion timeline with one bar and easing curve per property, the tokens, the component tree, the taste note and `Component.tsx`. The page shows `Component.tsx` as text and never runs it. The rebuild panel copies the handoff instruction, or starts a rebuild in CLI and API modes, and runs the preview.

**Export for funnel-first** downloads the tokens as JSON. The format is a placeholder in `packages/schema/src/export-funnel-first.ts` until the funnel-first token format is available.

To browse the committed examples, start the companion with `KINETIC_LIBRARY_DIR` set to `examples/`, as shown in [Work with saved captures](#work-with-saved-captures).

## Examples and checks

`examples/127.0.0.1/` holds three captures of the local test pages, each with `REBUILD.md`, a `Component.tsx` and `NOTES.md`, the preview video, and the scores:

| Capture | Test page | Motion library | Worst state |
| --- | --- | --- | --- |
| `button-hero` | `button.html` | Framer Motion | mobile, 18.4% |
| `gsap-scrub` | `gsap.html` | GSAP and ScrollTrigger | default, 22.4% |
| `three-stage` | `three.html` | React Three Fiber and drei | mobile, 91.0% |

The end-to-end tests capture every page in `apps/test-pages`, then save each capture through a test companion so they can check the files: a button with hover and focus transitions, a navigation bar, CSS keyframes and WAAPI, GSAP with ScrollTrigger and Lenis, React with Framer Motion, a Vue production build, a three.js scene, a React Three Fiber scene, and a Lottie animation.

On 24 November 2026, before the extension switched to the clipboard, its test build captured and recorded two public pages once. Neither capture is in the repository.

- `https://gsap.com/`, the `header` element: 324 styled nodes, 24 forced states plus mobile, 32 motion entries (17 GSAP, 10 CSS transitions and 5 sampled), and a 22-second recording.
- `https://motion.dev/`, the `header` element: a React 19 tree with 5 components, no motion found in that element, and a 6-second recording.

No rebuild or preview has been run against a real site.

## Files in a capture folder

A saved capture lives in `<library>/<site>/<slug>/`, where `<library>` is `library/` or the folder in `KINETIC_LIBRARY_DIR`. The capture, the recorder, the rebuild and the preview each add files. A capture has only the files its page needs, so a page with no three.js scene has no `three/` folder.

| File | Written by | Contents |
| --- | --- | --- |
| `capture.json` | Capture, then companion | Every capture section, plus the recording, job status and preview scores |
| `dom.html` | Capture | Cleaned HTML of the component |
| `styles.json` | Capture | Computed styles per node, tokens and fonts |
| `motion.json` | Capture and recorder | Motion entries in the `MotionEntrySchema` shape |
| `framework.json` | Capture | React or Vue component tree and suggested split |
| `states/` | Capture | One screenshot per forced state |
| `three/` | Capture | `scene.json`, `camera-path.json` and `shaders/` |
| `assets/` | Capture | Lottie, Rive and Spline files the page loaded |
| `original.webm` | Recorder | Video of the component, cropped |
| `REBUILD.md` | Rebuild | Brief for the agent that writes the rebuild |
| `Component.tsx`, `NOTES.md` | Your agent, the CLI or the API | The rebuild and its taste note |
| `Component.preview.webm`, `preview/` | Preview | Video and screenshots of the rebuild |
| `DIFF.md`, `diff/` | Preview | Scores and diff images, when a state is over the threshold |

When three.js can't serialise a scene, `three/scene.json` holds an outline of the scene instead of the full data.

## Scripts

Run these from the repository root.

| Script | What it does |
| --- | --- |
| `pnpm dev:companion` | Runs the companion with `tsx watch` |
| `pnpm dev:extension` | Runs WXT in dev mode and opens Chrome |
| `pnpm dev:library` | Runs the library UI on `127.0.0.1:5173` |
| `pnpm dev:test-pages` | Serves the local test pages |
| `pnpm kinetic preview <site>/<slug>` | Builds, records and scores `Component.tsx` |
| `pnpm kinetic rebuild <site>/<slug>` | Starts a rebuild in the current mode |
| `pnpm build` | Builds every package |
| `pnpm typecheck` | Runs `tsc --noEmit` in every package and in `e2e/` |
| `pnpm test` | Runs every `*.test.ts` file with Vitest |
| `pnpm test:e2e` | Runs the Playwright tests with the test build of the extension |

## Environment variables

The companion reads these from its environment and from `apps/companion/.env`. A variable already set in the environment wins over the file.

| Variable | Default | Effect |
| --- | --- | --- |
| `KINETIC_LIBRARY_DIR` | `library/` | Where captures are written |
| `KINETIC_AUTO_RECORD` | on | `0` records only on request |
| `KINETIC_REBUILD_MODE` | `handoff` | `handoff`, `claude-cli` or `api` |
| `KINETIC_AUTO_REBUILD` | off | `1` rebuilds after every recording (CLI and API modes) |
| `KINETIC_REBUILD_MODEL` | `claude-opus-5-5` | Model for API mode |
| `KINETIC_REBUILD_TIMEOUT_MS` | 900000 | Time limit for a CLI rebuild |
| `KINETIC_CLAUDE_BIN` | `claude` | Path of the Claude Code CLI |
| `KINETIC_DIFF_THRESHOLD` | 0.1 | Share of pixels a state may differ by |
| `KINETIC_FFMPEG` | bundled | Path of an ffmpeg binary |
| `ANTHROPIC_API_KEY` | none | Key for API mode only |

## Repository layout

```
apps/
  companion/    Hono server on 127.0.0.1:4517, recorder, rebuild and preview.
    sandbox/      Vite project that builds Component.tsx for previews.
  extension/    Chrome MV3 extension built with WXT.
    entrypoints/  Manifest config for each entry point, and the offscreen page that copies to the clipboard.
    src/          Picker, capture code, prompt builder and the MAIN-world hooks.
  library/      Vite and React app for browsing captures.
  test-pages/   Local pages the end-to-end tests capture.
e2e/            Playwright tests, one file per part.
examples/       Committed captures of the test pages.
packages/
  schema/       Zod schema and TypeScript types for capture.json, and the brief formatting
                that the clipboard prompt and REBUILD.md share.
```

`packages/schema/src/capture.ts` defines one block per capture section. Every section except `meta` is optional. `MotionEntrySchema` is the one motion shape that every capture method writes.

## Companion request rules

Any web page in the browser can send requests to localhost, so the companion checks every request:

- The `Host` header must be `127.0.0.1:4517` or `localhost:4517`. The check blocks DNS rebinding.
- The `Origin` header must be missing or start with `chrome-extension://`. Browsers send `Origin` on cross-site requests, and curl and Node scripts do not.
- The library UI's origins, `http://127.0.0.1:5173` and `http://localhost:5173`, get CORS headers on the read routes (`GET /captures`, `GET /captures/:site/:slug` and `GET /files/...`) and on the rebuild and preview routes. `POST /capture`, `POST /capture/file` and the record route get no CORS headers, so the library page can't call them.
- `POST` bodies must be `application/json` and 50 MB or smaller. Browsers send a CORS preflight before a cross-site JSON request, and the companion approves one only for the library's routes.

The companion rejects a capture that fails schema validation with status 400 and the list of issues. Site and slug names must each be one path segment, and every file path must resolve inside `library/`. The recorder opens only `http` and `https` URLs.

## Use rules

Captures are for reference and learning. Rebuild with your own or your client's assets. Do not ship scraped 3D models, textures, Lottie files, fonts or copy in client work. Respect sites that block automation, and never capture a page behind a login you do not own. Keep captures of real sites out of the repository. Git ignores `library/` for that reason, and `examples/` holds only captures of the local test pages.
