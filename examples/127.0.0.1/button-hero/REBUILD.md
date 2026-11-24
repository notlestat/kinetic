# Rebuild "Button test page"

Captured from <http://127.0.0.1:5180/button.html> on 2026-11-24T21:20:23.322Z at 1280×800 (device scale 1).
Component root: `html > body > main > section.hero`

## Task

Rebuild this component as `Component.tsx` in React + TypeScript + Tailwind CSS.

- Export the component as the default export. It takes no required props.
- Put the design tokens below in CSS variables on the component's root (a `style` object or a `<style>` element) and use them through Tailwind arbitrary values such as `bg-[var(--color-1)]`. Do not hard-code token values.
- Split it into these sub-components, all inside Component.tsx: `Text`, `Cta`, `Chip`.
  - `Text`: `html > body > main > section.hero > p`
  - `Cta`: `html > body > main > section.hero > button.cta`
  - `Chip`: `html > body > main > section.hero > a.chip`
- Use placeholder copy and images of the same length and size. Do not reuse the site's fonts, images, 3D models or text in client work.
- Write `NOTES.md`: a short taste note, three to six sentences in plain words, on why this component feels good (spacing, type, colour, motion character) and what you changed or could not match.

## Motion

Library: **Framer Motion**. Animate with Framer Motion (`framer-motion`): `motion.*` elements with `whileHover`, `whileFocus`, `animate` and `transition`; `useScroll` and `useTransform` for scroll-linked motion. Plain CSS transitions are fine for simple colour changes.

Use the exact durations, delays, easing curves and stagger from the table for every `exact` and `near` entry. Treat `approximate` entries (frame-sampled) as the feel to match, not exact values. Respect `prefers-reduced-motion` by switching large movement off.

| id | target | trigger | properties | duration | delay | easing | stagger | iterations | confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| css-transition-1 | `html > body > main > section.hero > button.cta` | hover | background-color: rgb(99, 91, 255) → rgb(10, 37, 64) | 150 ms | 0 ms | `cubic-bezier(0, 0, 0.58, 1)` |  | 1 | exact |
| css-transition-2 | `html > body > main > section.hero > button.cta` | hover | box-shadow: rgba(10, 37, 64, 0.2) 0px 1px 2px 0px → rgba(10, 37, 64, 0.25) 0px 8px 24px 0px | 200 ms | 0 ms | `cubic-bezier(0.2, 0, 0, 1)` |  | 1 | exact |
| css-transition-3 | `html > body > main > section.hero > button.cta` | hover | transform: none → translateY(-2px) | 150 ms | 0 ms | `cubic-bezier(0, 0, 0.58, 1)` |  | 1 | exact |
| css-transition-4 | `html > body > main > section.hero > button.cta > span.arrow` | hover | transform: none → translate(3px) | 150 ms | 0 ms | `cubic-bezier(0, 0, 0.58, 1)` |  | 1 | exact |
| css-transition-5 | `html > body > main > section.hero > button.cta` | click | background-color: rgb(99, 91, 255) → rgb(10, 37, 64) | 150 ms | 0 ms | `cubic-bezier(0, 0, 0.58, 1)` |  | 1 | exact |
| css-transition-6 | `html > body > main > section.hero > button.cta` | click | box-shadow: rgba(10, 37, 64, 0.2) 0px 1px 2px 0px → rgba(10, 37, 64, 0.25) 0px 8px 24px 0px | 200 ms | 0 ms | `cubic-bezier(0.2, 0, 0, 1)` |  | 1 | exact |
| css-transition-7 | `html > body > main > section.hero > button.cta` | click | transform: none → matrix(1, 0, 0, 1, 0, 0) | 150 ms | 0 ms | `cubic-bezier(0, 0, 0.58, 1)` |  | 1 | exact |
| css-transition-8 | `html > body > main > section.hero > button.cta > span.arrow` | click | transform: none → matrix(1, 0, 0, 1, 3, 0) | 150 ms | 0 ms | `cubic-bezier(0, 0, 0.58, 1)` |  | 1 | exact |
| sampled-1 | `html > body > main > section.hero > a.chip > span.dot` | loop | opacity: 0.994 → 0.986 (12 keyframes) | 1200 ms | 0 ms | `linear` |  | infinite | approximate |
| sampled-2 | `html > body > main > section.hero > a.chip` | hover | y: 0 → -4 | 300 ms | 0 ms | `cubic-bezier(0.29, 0.791, 0.438, 0.978)` |  | 1 | approximate |

## States

- **hover** on `html > body > main > section.hero > button.cta` · [states/hover-0.png](states/hover-0.png) · background-color: rgb(10, 37, 64); box-shadow: rgba(10, 37, 64, 0.25) 0px 8px 24px 0px; transform: matrix(1, 0, 0, 1, 0, -2); `span.arrow` transform: matrix(1, 0, 0, 1, 3, 0); `span.dot` opacity: 0.731
- **focus** on `html > body > main > section.hero > button.cta` · [states/focus-0.png](states/focus-0.png) · outline-color: rgb(128, 233, 255); outline-offset: 3px; outline-style: solid; `span.dot` opacity: 0.559
- **active** on `html > body > main > section.hero > button.cta` · [states/active-0.png](states/active-0.png) · background-color: rgb(10, 37, 64); box-shadow: rgba(10, 37, 64, 0.25) 0px 8px 24px 0px; transform: matrix(1, 0, 0, 1, 0, 0); `span.arrow` transform: matrix(1, 0, 0, 1, 3, 0); `span.dot` opacity: 0.395
- **hover** on `html > body > main > section.hero > a.chip` · [states/hover-1.png](states/hover-1.png) · `span.dot` opacity: 0.269
- **focus** on `html > body > main > section.hero > a.chip` · [states/focus-1.png](states/focus-1.png) · outline-color: rgb(0, 95, 204); outline-offset: 1px; outline-style: auto; outline-width: 1px; `span.dot` opacity: 0.205
- **active** on `html > body > main > section.hero > a.chip` · [states/active-1.png](states/active-1.png) · `span.dot` opacity: 0.215
- **mobile** on `html > body > main > section.hero` · [states/mobile.png](states/mobile.png) · grid-template-columns: 246px; grid-template-rows: 104px 43.1875px 28.7969px; `button.cta` justify-content: center; `span.dot` opacity: 0.91

## Tokens

```css
:root {
  --color-1: rgb(255, 255, 255);
  --space-1: 6px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 48px;
  --radius-1: 16px;
  --radius-2: 50%;
  --radius-3: 999px;
}
```

## Files

- [states/active-0.png](states/active-0.png)
- [states/active-1.png](states/active-1.png)
- [states/default.png](states/default.png)
- [states/focus-0.png](states/focus-0.png)
- [states/focus-1.png](states/focus-1.png)
- [states/hover-0.png](states/hover-0.png)
- [states/hover-1.png](states/hover-1.png)
- [states/mobile.png](states/mobile.png)
- [original.webm](original.webm): the recording, idle, then each hover and focus target, then a scroll pass
- [dom.html](dom.html): the cleaned markup
- [styles.json](styles.json): computed styles per node, with token names
- [motion.json](motion.json): every motion entry
- [framework.json](framework.json): the component tree and suggested split

## Output contract

1. Write only `Component.tsx` and `NOTES.md`, in this folder. Do not change any other file.
2. Import only `react`, `react-dom`, `framer-motion`, `gsap`, `three`, `@react-three/fiber`, `@react-three/drei` (subpaths such as `gsap/ScrollTrigger` are fine). No CSS files, other packages, `import.meta` or network requests: the preview sandbox rejects them.
3. Then run, from the repo root: `pnpm kinetic preview 127.0.0.1/button-hero`
   It renders Component.tsx in a sandbox, records `Component.preview.webm` with the same script as the original, screenshots each state and writes the diff scores to capture.json. If a state is over the threshold it writes `DIFF.md` and adds a Fix pass section to this file.

## Canvas target (Blueprint or Paper)

When asked to build on a canvas instead of in code: make one artboard per state, **default**, **hover**, **focus** and **mobile** (390 px wide), in HTML and CSS using the CSS variables above. Beside each artboard, add a note with that state's motion values from the table: property, duration, delay, easing and stagger.

## Fix pass

The preview is over the 10.0% threshold in 1 state:

- `mobile`: 18.4% of pixels differ

Read [DIFF.md](DIFF.md) and the images it links, then edit Component.tsx (and NOTES.md if the note changes) to close the gap. Keep to the output contract above, then run the preview again.
