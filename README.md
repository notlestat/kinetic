<img src="assets/icon.svg" width="64" height="64" alt="">

# Kinetic

Kinetic captures a component from any website and rebuilds it as React. A Chrome extension records the component's structure, styles, states and motion. A local companion app saves each capture to `library/<site>/<slug>/capture.json`.

The repository is at the scaffold stage. Each extension entry point only logs that it loaded, and the companion accepts and saves captures. [SPEC.md](SPEC.md) describes the full tool. [PROMPTS.md](PROMPTS.md) splits the build into steps.

## Requirements

- Node.js 20.19 or later
- pnpm 12
- Google Chrome or Chrome for Testing

## Set up the workspace

Install the dependencies from the repository root:

```sh
pnpm install
```

The install also runs `wxt prepare`, which generates the extension's TypeScript config in `apps/extension/.wxt/`.

## Start the companion

Run the companion in watch mode:

```sh
pnpm dev:companion
```

It listens on `http://127.0.0.1:4517` and writes captures to `library/` in the repository root. Git ignores that folder. To write somewhere else, set `KINETIC_LIBRARY_DIR` to an absolute path.

To check the companion, post the sample capture:

```sh
curl -X POST http://127.0.0.1:4517/capture \
	-H 'content-type: application/json' \
	--data-binary @packages/schema/fixtures/sample-capture.json
```

The response is `{"ok":true,"path":"example.com/cta-button/capture.json"}`, and the file appears at `library/example.com/cta-button/capture.json`.

## Load the extension in Chrome

1. Build the extension:

	```sh
	pnpm --filter @kinetic/extension build
	```

2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select `apps/extension/.output/chrome-mv3`.
4. Open any web page and its DevTools console. You see `[kinetic] main world loaded`, then `[kinetic] content script loaded`.

To see the background log, click **service worker** on the Kinetic card in `chrome://extensions`. The worker console shows `[kinetic] background loaded`.

For development, run `pnpm dev:extension` instead. WXT builds to `apps/extension/.output/chrome-mv3-dev`, opens Chrome with the extension loaded, and reloads it when files change.

## Scripts

Run these from the repository root.

| Script | What it does |
| --- | --- |
| `pnpm dev:companion` | Runs the companion with `tsx watch` |
| `pnpm dev:extension` | Runs WXT in dev mode and opens Chrome |
| `pnpm dev:library` | Runs the library UI on Vite's dev server |
| `pnpm build` | Builds every package |
| `pnpm typecheck` | Runs `tsc --noEmit` in every package |
| `pnpm test` | Runs every `*.test.ts` file with Vitest |

## Repository layout

```
apps/
  companion/    Hono server on 127.0.0.1:4517. POST /capture validates and saves a capture.
  extension/    Chrome MV3 extension built with WXT.
    entrypoints/  Manifest config for each entry point.
    src/          Entry point code: background.ts, content.ts, main-world.ts.
  library/      Vite and React app for browsing captures. Placeholder page for now.
packages/
  schema/       Zod schema and TypeScript types for capture.json.
    fixtures/     sample-capture.json, used by the tests and the curl check above.
```

`packages/schema/src/capture.ts` defines one block per capture section: `meta`, `dom`, `styles`, `states`, `motion`, `framework`, `three`, `assets` and `media`. Every section except `meta` is optional. `MotionEntrySchema` is the one motion shape that every capture method writes.

## Companion request rules

Any web page in the browser can send requests to localhost, so the companion accepts a request only when all of these hold:

- The `Host` header is `127.0.0.1:4517` or `localhost:4517`. The check blocks DNS rebinding.
- The `Origin` header is missing or starts with `chrome-extension://`. Browsers send `Origin` on cross-site requests. curl and Node scripts do not.
- The `Content-Type` is `application/json`. Browsers send a CORS preflight before a cross-site JSON request, and the companion never approves one.
- The body is 50 MB or smaller.

The companion rejects a capture that fails schema validation with status 400 and the list of issues. `meta.site` and `meta.slug` must each be a single path segment, so a capture cannot write outside `library/`.

## Use rules

Captures are for reference and learning. Rebuild with your own or your client's assets. Do not ship scraped 3D models, textures, Lottie files, fonts or copy in client work. Respect sites that block automation, and never capture a page behind a login you do not own.
