// Records the raw motion inputs of real captures as unit-test fixtures.
// Run with: KINETIC_RECORD_FIXTURES=1 pnpm test:e2e e2e/record-fixtures.e2e.ts

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { captureSelector, expect, openTestPage, test } from "./fixtures.ts";
import { REPO_ROOT } from "./paths.ts";

const FIXTURES = path.join(REPO_ROOT, "apps/extension/src/fixtures");

interface Inputs {
  baseline: Record<string, Record<string, string>>;
  states: { changes: Record<string, Record<string, string>> }[];
  css: { transitions: { selector: string }[] };
}

/** Keeps only the resting values the transition normaliser reads, so fixtures stay small. */
function trim(inputs: Inputs): Inputs {
  const baseline: Inputs["baseline"] = {};
  for (const { selector } of inputs.css.transitions) {
    const props = new Set(inputs.states.flatMap((s) => Object.keys(s.changes[selector] ?? {})));
    const full = inputs.baseline[selector] ?? {};
    baseline[selector] = Object.fromEntries([...props].filter((p) => p in full).map((p) => [p, full[p] ?? ""]));
  }
  return { ...inputs, baseline };
}

test.skip(!process.env.KINETIC_RECORD_FIXTURES, "set KINETIC_RECORD_FIXTURES=1 to record fixtures");

for (const [page_, selector, name] of [
  ["keyframes.html", "section.panel", "motion-keyframes"],
  ["gsap.html", "body", "motion-gsap"],
] as const) {
  test(`records ${name}`, async ({ page }) => {
    await openTestPage(page, page_);
    const outcome = (await captureSelector(page, selector, `fixture-${name}`)) as { debug?: { motionInputs: Inputs } };
    expect(outcome.debug).toBeDefined();
    const inputs = trim(outcome.debug?.motionInputs as Inputs);
    await writeFile(path.join(FIXTURES, `${name}.json`), `${JSON.stringify(inputs, null, 1)}\n`);
  });
}
