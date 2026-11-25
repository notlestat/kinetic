<img src="assets/icon.svg" width="64" height="64" alt="">

# Kinetic

Kinetic captures a component from a web page and helps you rebuild it as React. A Chrome extension records the component's DOM, styles, states and motion, and copies a screenshot and a Markdown description of the component to your clipboard the moment you pick it. A local companion app saves the capture, records a video of the component moving, writes a rebuild brief, and checks your rebuild against the original. A small web app lets you browse and compare everything you have captured.

No API key is needed. The default rebuild hands a brief to the coding agent you already use. The Claude API is an optional mode and is off unless you turn it on.

[SPEC.md](SPEC.md) describes the full design. [PROMPTS.md](PROMPTS.md) splits the build into steps.

## Requirements

- Node.js 20.19 or later
- pnpm 12
- Google Chrome or Chrome for Testing
- Playwright's Chromium, for recording and previews: `pnpm exec playwright install chromium`

The companion crops videos with the ffmpeg binary from `ffmpeg-static`. To use another ffmpeg, set `KINETIC_FFMPEG` to its path.

## Set up the workspace

Install the dependencies from the repository root:

```sh
pnpm install
```

The install also runs `wxt prepare`, which generates the extension's TypeScript config in `apps/extension/.wxt/`. `pnpm-workspace.yaml` allows the install scripts of `esbuild` and `ffmpeg-static`. pnpm blocks every other package's install script.

## Capture a component

1. Start the companion:

	```sh
	pnpm dev:companion
	```

	It listens on `http://127.0.0.1:4517` and writes captures to `library/` in the repository root. Git ignores that folder. To write somewhere else, set `KINETIC_LIBRARY_DIR` to an absolute path.

2. Build the extension:

	```sh
	pnpm --filter @kinetic/extension build
	```

3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `apps/extension/.output/chrome-mv3`.
4. Open a page and press Alt+Shift+K, or click the Kinetic icon, to start the picker.
5. Point at the component. Arrow Up selects the parent and Arrow Down selects the first child.
6. Click or press Enter to copy the component and capture it. To also record animations that run on page load, hold Shift: the page reloads once while Kinetic watches. Esc closes the picker.

The copy lands first, in under a tenth of a second, and the toolbar icon shows a green tick. The full capture then runs for a few seconds and goes to the library. When it finishes, the picker label shows `Saved to library/<site>/<slug>`. If the companion is not running, the extension keeps the capture and sends it when the companion is back.

For development, run `pnpm dev:extension` instead of step 2. WXT opens Chrome with the extension loaded and reloads it when files change.

## Paste a component into an agent or a canvas

Each pick puts one clipboard item with two formats on the clipboard. The app you paste into takes the format it reads:

- A PNG of the component as it looks on screen, with 8 px of room around it, for canvases and image tools.
- Markdown text for a coding agent. It has the source URL, the size, the tokens as CSS variables, the fonts, the cleaned HTML, the computed CSS of each element, the motion running when you clicked, and the folder the full capture goes to.

In Claude Code on macOS, Cmd+V pastes the text and Ctrl+V pastes the image.

The copy uses only what the page shows at the moment you click, so it is fast but partial. Transition timing is in the CSS, but the values a hover or focus changes to come from the state pass, which only the library capture has. The screenshot covers the part of the component inside the viewport. Kinetic copies text only, without the image, in two cases: on `http` pages other than localhost, which have no clipboard API, and when Chrome does not let it capture the tab. Chrome allows the capture after you open the picker from the Kinetic icon or Alt+Shift+K.

## Record the component moving

The companion records each capture as it arrives. It opens the same URL in Playwright's Chromium at the same viewport, finds the component, and records idle time, a hover and a focus on up to six interactive elements, and a scroll pass. The result is `original.webm`, cropped to the component. Motion that no other source explained, such as scroll-linked transforms and JavaScript loops, becomes sampled motion entries.

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

With `KINETIC_REBUILD_MODE=claude-cli`, the companion runs `claude -p "Follow REBUILD.md"` in the capture folder. The CLI may only read and write files in that folder, and the companion stops it after 15 minutes (`KINETIC_REBUILD_TIMEOUT_MS` changes the limit). If the CLI is missing or fails, the job fails with the CLI's error output. Start a rebuild from the library, with `pnpm kinetic rebuild <site>/<slug>`, or with `POST /captures/<site>/<slug>/rebuild`. Set `KINETIC_AUTO_REBUILD=1` to rebuild after every recording.

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

The preview records `Component.preview.webm` with the same script as `original.webm` and screenshots each state. pixelmatch compares each screenshot with the original, and `capture.json` gets the scores. When a state differs by more than 10% of its pixels, the companion writes `DIFF.md` with the numbers and diff images, and adds a "Fix pass" section to `REBUILD.md`. CLI and API modes run one fix pass on their own. In handoff mode, ask your agent to follow the Fix pass section. `KINETIC_DIFF_THRESHOLD` changes the threshold (0 to 1).

If the companion is running, `pnpm kinetic` asks it to do the work. Otherwise the command runs the preview itself.

## Browse the library

Start the library UI with the companion running:

```sh
pnpm dev:library
```

Open `http://127.0.0.1:5173`. The grid shows each capture's video, site, component name, motion sources, frameworks and whether it has a 3D scene. Filter by site, motion source (GSAP, ScrollTrigger, Framer Motion, CSS, three and Lottie) or trigger (hover, scroll and load), or search names, URLs and taste notes.

A capture's page plays the original and the rebuild side by side on one clock. It also shows the state screenshots with their scores, a motion timeline with one bar and easing curve per property, the tokens, the component tree, the taste note and `Component.tsx`. The page shows `Component.tsx` as text and never runs it. The rebuild panel copies the handoff instruction, or starts a rebuild in CLI and API modes, and runs the preview.

**Export for funnel-first** downloads the tokens as JSON. The format is a placeholder in `packages/schema/src/export-funnel-first.ts` until the funnel-first token format is available.

To browse the committed examples, point the companion at them:

```sh
KINETIC_LIBRARY_DIR="$PWD/examples" KINETIC_AUTO_RECORD=0 pnpm dev:companion
```

## Examples and checks

`examples/127.0.0.1/` holds three captures of the local test pages, each with `REBUILD.md`, a `Component.tsx` and `NOTES.md`, the preview video, and the scores:

| Capture | Test page | Motion library | Worst state |
| --- | --- | --- | --- |
| `button-hero` | `button.html` | Framer Motion | mobile, 18.4% |
| `gsap-scrub` | `gsap.html` | GSAP and ScrollTrigger | default, 22.4% |
| `three-stage` | `three.html` | React Three Fiber and drei | mobile, 91.0% |

The end-to-end tests capture every page in `apps/test-pages`: a button with hover and focus transitions, a navigation bar, CSS keyframes and WAAPI, GSAP with ScrollTrigger and Lenis, React with Framer Motion, a Vue production build, a three.js scene, a React Three Fiber scene, and a Lottie animation.

Two public pages were captured and recorded once, on 24 November 2026, with the test build of the extension. Neither capture is in the repository.

- `https://gsap.com/`, the `header` element: 324 styled nodes, 24 forced states plus mobile, 32 motion entries (17 GSAP, 10 CSS transitions and 5 sampled), and a 22-second recording.
- `https://motion.dev/`, the `header` element: a React 19 tree with 5 components, no motion found in that element, and a 6-second recording.

No rebuild or preview has been run against a real site.

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
    entrypoints/  Manifest config for each entry point.
    src/          Picker, capture code and the MAIN-world hooks.
  library/      Vite and React app for browsing captures.
  test-pages/   Local pages the end-to-end tests capture.
e2e/            Playwright tests, one file per part.
examples/       Committed captures of the test pages.
packages/
  schema/       Zod schema and TypeScript types for capture.json.
```

`packages/schema/src/capture.ts` defines one block per capture section. Every section except `meta` is optional. `MotionEntrySchema` is the one motion shape that every capture method writes.

## Companion request rules

Any web page in the browser can send requests to localhost, so the companion checks every request:

- The `Host` header must be `127.0.0.1:4517` or `localhost:4517`. The check blocks DNS rebinding.
- The `Origin` header must be missing or start with `chrome-extension://`. Browsers send `Origin` on cross-site requests, and curl and Node scripts do not.
- The library UI's origins, `http://127.0.0.1:5173` and `http://localhost:5173`, get CORS headers on the read routes (`GET /captures`, `GET /captures/:site/:slug` and `GET /files/...`) and on the rebuild and preview routes. `POST /capture`, `POST /capture/file` and the record route accept the extension only.
- `POST` bodies must be `application/json` and 50 MB or smaller. Browsers send a CORS preflight before a cross-site JSON request, and the companion approves one only for the library's routes.

The companion rejects a capture that fails schema validation with status 400 and the list of issues. Site and slug names must each be one path segment, and every file path must resolve inside `library/`. The recorder opens only `http` and `https` URLs.

## Use rules

Captures are for reference and learning. Rebuild with your own or your client's assets. Do not ship scraped 3D models, textures, Lottie files, fonts or copy in client work. Respect sites that block automation, and never capture a page behind a login you do not own. Keep captures of real sites out of the repository: `library/` is ignored for that reason, and `examples/` holds only captures of the local test pages.
