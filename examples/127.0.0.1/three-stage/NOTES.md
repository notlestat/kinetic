# Taste note

The scene sells depth with very little: a single violet torus knot, a rim light that breathes on a sine wave, and navy fog that swallows the ground plane and stars at 8 to 20 units. The steady spin (one turn every 7.85 s) keeps it alive at rest, while scrolling lifts the camera from 1 to 2.5 and pulls it in from 6 to 3, so the page scroll feels like walking up to the object. ACES tone mapping at 1.1 exposure keeps the violet rich without clipping.

Fix pass: the first preview rendered the knot deep blue, because the original's OutputPass converted the whole frame to sRGB while this version rendered the raw shader output. The shader now applies tone mapping and the colour space itself.

Could not match: the original used an EffectComposer with a RenderPass and OutputPass, so its background is tone mapped too and reads darker. The state screenshots of this 200vh sticky section also differ in layout: the extension's beyond-viewport capture repeats the sticky canvas. The point cloud's positions were too large for scene.json, so the stars come from the test page's own generator, which this example could read; for a real site, use a placeholder pattern.
