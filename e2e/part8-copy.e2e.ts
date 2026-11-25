import { captureSelector, expect, openTestPage, test, TEST_PAGES_ORIGIN } from "./fixtures.ts";

test("a pick copies a screenshot and a Markdown reference to the clipboard", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: TEST_PAGES_ORIGIN });
  await openTestPage(page, "button.html");
  await page.bringToFront();

  const outcome = await captureSelector(page, "button.cta", "copy-button");
  expect(outcome).toMatchObject({ ok: true, saved: "companion" });

  const clip = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    if (!item) return undefined;
    const text = await (await item.getType("text/plain")).text();
    const image = item.types.includes("image/png") ? await item.getType("image/png") : undefined;
    const size = image ? await createImageBitmap(image).then((b) => ({ width: b.width, height: b.height })) : undefined;
    const button = document.querySelector("button.cta")?.getBoundingClientRect();
    return { types: item.types, text, size, button: button && { width: button.width, height: button.height } };
  });

  expect(clip?.types).toEqual(expect.arrayContaining(["text/plain", "image/png"]));
  expect(clip?.text).toContain("# Component reference: `button.cta`");
  expect(clip?.text).toContain("- Source: http://127.0.0.1:5180/button.html");
  expect(clip?.text).toContain("`library/127.0.0.1/copy-button`");
  expect(clip?.text).toContain("```html\n<button");
  expect(clip?.text).toMatch(/## CSS[\s\S]*button\.cta \{[\s\S]*background-color: rgb\(99, 91, 255\)/);
  // Transition timing comes through as CSS. What hover changes to needs the state pass, which only the library capture has.
  expect(clip?.text).toMatch(/button\.cta \{[\s\S]*transition-duration: 0\.15s, 0\.15s, 0\.2s/);

  // The shot is the button plus 8px padding on each side, in device pixels.
  const button = clip?.button;
  expect(button).toBeDefined();
  expect(clip?.size?.width).toBeCloseTo((button?.width ?? 0) + 16, -1);
  expect(clip?.size?.height).toBeCloseTo((button?.height ?? 0) + 16, -1);
});
