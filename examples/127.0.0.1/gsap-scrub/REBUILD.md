# Rebuild "GSAP, ScrollTrigger and Lenis test page"

Captured from <http://127.0.0.1:5180/gsap.html> on 2026-11-24T21:20:56.352Z at 1280×800 (device scale 1).
Component root: `html > body > section.scrub-section:nth-of-type(2)`

## Task

Rebuild this component as `Component.tsx` in React + TypeScript + Tailwind CSS.

- Export the component as the default export. It takes no required props.
- Put the design tokens below in CSS variables on the component's root (a `style` object or a `<style>` element) and use them through Tailwind arbitrary values such as `bg-[var(--color-1)]`. Do not hard-code token values.
- Split it into these sub-components, all inside Component.tsx: `ScrubBox`, `ParallaxOrb`.
  - `ScrubBox`: `html > body > section.scrub-section:nth-of-type(2) > div.scrub-box:nth-of-type(1)`
  - `ParallaxOrb`: `html > body > section.scrub-section:nth-of-type(2) > div.parallax-orb:nth-of-type(2)`
- Use placeholder copy and images of the same length and size. Do not reuse the site's fonts, images, 3D models or text in client work.
- Write `NOTES.md`: a short taste note, three to six sentences in plain words, on why this component feels good (spacing, type, colour, motion character) and what you changed or could not match.

## Motion

Library: **GSAP + ScrollTrigger**. The original's main motion source is GSAP, so animate with `gsap` and `gsap/ScrollTrigger`: register the plugin once, create tweens and triggers inside `useLayoutEffect` with `gsap.context()`, and revert the context on unmount.

Use the exact durations, delays, easing curves and stagger from the table for every `exact` and `near` entry. Treat `approximate` entries (frame-sampled) as the feel to match, not exact values. Respect `prefers-reduced-motion` by switching large movement off.

| id | target | trigger | properties | duration | delay | easing | stagger | iterations | confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| scrolltrigger-1 | `html > body > section.scrub-section:nth-of-type(2) > div.scrub-box:nth-of-type(1)` | scroll · scroll top 80% → bottom 20%, scrub 1 | x: 0 → 300; rotation: 0 → 90 | 500 ms | 0 ms | `linear` |  | 1 | exact |
| sampled-1 | `html > body > section.scrub-section:nth-of-type(2) > div.parallax-orb:nth-of-type(2)` | scroll · scroll 127 → 1887, scrub true | y: 0 → -160 | 0 ms | 0 ms | `linear` |  | 1 | near |

The page used lenis smooth scrolling with options `{"wrapper":"[node]","content":"html","eventsTarget":"[node]","smoothWheel":true,"syncTouch":false,"syncTouchLerp":0.075,"touchInertiaExponent":1.7,"duration":1.2,"easing":"[function]","lerp":0.1,"infinite":false,"gestureOrientation":"vertical","orientation":"vertical","touchMultiplier":1,"wheelMultiplier":1,"autoResize":true,"prevent":"undefined","virtualScroll":"undefined","overscroll":true,"autoRaf":false,"anchors":false,"autoToggle":false,"allowNestedScroll":false,"naiveDimensions":false,"stopInertiaOnNavigate":false,"respectReducedMotion":true}`; scroll motion should feel that smooth.

## States

- **mobile** on `html > body > section.scrub-section:nth-of-type(2)` · [states/mobile.png](states/mobile.png) · `div.scrub-box:nth-of-type(1)` transform: matrix(0.673831, 0.738886, -0.738886, 0.673831, 158.789, 0); `div.parallax-orb:nth-of-type(2)` transform: matrix(1, 0, 0, 1, 0, -83.86)

## Tokens

```css
:root {
  --color-1: rgb(10, 37, 64);
  --space-1: 24px;
  --space-2: 48px;
  --radius-1: 16px;
  --radius-2: 50%;
}
```

## Files

- [states/default.png](states/default.png)
- [states/mobile.png](states/mobile.png)
- [original.webm](original.webm): the recording, idle, then each hover and focus target, then a scroll pass
- [dom.html](dom.html): the cleaned markup
- [styles.json](styles.json): computed styles per node, with token names
- [motion.json](motion.json): every motion entry
- [framework.json](framework.json): the component tree and suggested split

## Output contract

1. Write only `Component.tsx` and `NOTES.md`, in this folder. Do not change any other file.
2. Import only `react`, `react-dom`, `framer-motion`, `gsap`, `three`, `@react-three/fiber`, `@react-three/drei` (subpaths such as `gsap/ScrollTrigger` are fine). No CSS files, other packages, `import.meta` or network requests: the preview sandbox rejects them.
3. Then run, from the repo root: `pnpm kinetic preview 127.0.0.1/gsap-scrub`
   It renders Component.tsx in a sandbox, records `Component.preview.webm` with the same script as the original, screenshots each state and writes the diff scores to capture.json. If a state is over the threshold it writes `DIFF.md` and adds a Fix pass section to this file.

## Canvas target (Blueprint or Paper)

When asked to build on a canvas instead of in code: make one artboard per state, **default**, **hover**, **focus** and **mobile** (390 px wide), in HTML and CSS using the CSS variables above. Beside each artboard, add a note with that state's motion values from the table: property, duration, delay, easing and stagger.

## Fix pass

The preview is over the 10.0% threshold in 1 state:

- `default`: 22.4% of pixels differ

Read [DIFF.md](DIFF.md) and the images it links, then edit Component.tsx (and NOTES.md if the note changes) to close the gap. Keep to the output contract above, then run the preview again.
