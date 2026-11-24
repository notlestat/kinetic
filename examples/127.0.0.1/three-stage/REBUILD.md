# Rebuild "three.js test page"

Captured from <http://127.0.0.1:5180/three.html> on 2026-11-24T21:22:41.445Z at 1280×800 (device scale 1).
Component root: `html > body > main > section.stage`

## Task

Rebuild this component as `Component.tsx` in React + TypeScript + Tailwind CSS.

- Export the component as the default export. It takes no required props.
- Put the design tokens below in CSS variables on the component's root (a `style` object or a `<style>` element) and use them through Tailwind arbitrary values such as `bg-[var(--color-1)]`. Do not hard-code token values.
- Split it into small sub-components where the structure repeats, all inside Component.tsx.
- Use placeholder copy and images of the same length and size. Do not reuse the site's fonts, images, 3D models or text in client work.
- Write `NOTES.md`: a short taste note, three to six sentences in plain words, on why this component feels good (spacing, type, colour, motion character) and what you changed or could not match.

## Motion

Library: **React Three Fiber + drei**. The capture has a three.js scene, so draw it with `@react-three/fiber` (`<Canvas>`) and `@react-three/drei` helpers. Match the camera, lights, tone mapping and fog below. Use Framer Motion for any DOM motion around the canvas.

Use the exact durations, delays, easing curves and stagger from the table for every `exact` and `near` entry. Treat `approximate` entries (frame-sampled) as the feel to match, not exact values. Respect `prefers-reduced-motion` by switching large movement off.

| id | target | trigger | properties | duration | delay | easing | stagger | iterations | confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| three-2 | `#scene` | scroll · scroll 0 → 1511, scrub true | rotation.x: -0.165 → -0.695 (9 keyframes); position.y: 1 → 2.5 (9 keyframes); position.z: 6 → 3 (9 keyframes) | 0 ms | 0 ms | `linear` |  | 1 | near |
| three-1 | `#scene` | loop | rotation.y: 0.119 → 6.402 | 7854 ms | 0 ms | `linear` |  | infinite | approximate |

## three.js scene

- Camera: PerspectiveCamera, fov 50, position [0, 1.547, 4.906], looking at [0, 0, 0]
- Light: AmbientLight #ffffff, intensity 0.4 at [0, 0, 0]
- Light: DirectionalLight #ffffff, intensity 2 at [3, 5, 2]
- Renderer: ACESFilmicToneMapping, exposure 1.1, srgb
- Fog: Fog #0a2540
- Post-processing seen: RenderPass, OutputShader
- [three/camera-path.json](three/camera-path.json)
- [three/scene.json](three/scene.json)
- [three/shaders/hero-glow-1.frag.glsl](three/shaders/hero-glow-1.frag.glsl)
- [three/shaders/hero-glow-1.vert.glsl](three/shaders/hero-glow-1.vert.glsl)
- [three/shaders/index.json](three/shaders/index.json)

## States

- **mobile** on `html > body > main > section.stage` · [states/mobile.png](states/mobile.png) · `#scene` aspect-ratio: auto 342 / 844

## Tokens

```css
:root {
  --radius-1: 16px;
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
- [three/](three/): scene, camera path and shaders

## Output contract

1. Write only `Component.tsx` and `NOTES.md`, in this folder. Do not change any other file.
2. Import only `react`, `react-dom`, `framer-motion`, `gsap`, `three`, `@react-three/fiber`, `@react-three/drei` (subpaths such as `gsap/ScrollTrigger` are fine). No CSS files, other packages, `import.meta` or network requests: the preview sandbox rejects them.
3. Then run, from the repo root: `pnpm kinetic preview 127.0.0.1/three-stage`
   It renders Component.tsx in a sandbox, records `Component.preview.webm` with the same script as the original, screenshots each state and writes the diff scores to capture.json. If a state is over the threshold it writes `DIFF.md` and adds a Fix pass section to this file.

## Canvas target (Blueprint or Paper)

When asked to build on a canvas instead of in code: make one artboard per state, **default**, **hover**, **focus** and **mobile** (390 px wide), in HTML and CSS using the CSS variables above. Beside each artboard, add a note with that state's motion values from the table: property, duration, delay, easing and stagger.

## Fix pass

The preview is over the 10.0% threshold in 2 states:

- `default`: 48.9% of pixels differ
- `mobile`: 91.0% of pixels differ

Read [DIFF.md](DIFF.md) and the images it links, then edit Component.tsx (and NOTES.md if the note changes) to close the gap. Keep to the output contract above, then run the preview again.
