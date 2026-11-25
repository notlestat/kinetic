import { describe, expect, it } from "vitest";
import sample from "../fixtures/sample-capture.json" with { type: "json" };
import { type Capture, CaptureSchema } from "./capture.ts";
import { referenceMarkdown, relativeSelector } from "./reference.ts";

const capture: Capture = CaptureSchema.parse(sample);

describe("relativeSelector", () => {
  it("starts child selectors at the root element", () => {
    expect(relativeSelector("html > body > main > section.hero > p", "html > body > main > section.hero")).toBe("section.hero > p");
    expect(relativeSelector("main > section.hero a.cta > span", "main > section.hero a.cta")).toBe("a.cta > span");
  });

  it("leaves selectors outside the root alone", () => {
    expect(relativeSelector("#other", "main > a.cta")).toBe("#other");
  });
});

describe("referenceMarkdown", () => {
  const text = referenceMarkdown(capture);

  it("names the source and the library folder", () => {
    expect(text).toContain("# Component reference: `a.cta`");
    expect(text).toContain("- Source: https://example.com/pricing");
    expect(text).toContain("`library/example.com/cta-button`");
  });

  it("turns tokens into CSS variables and uses them in the CSS", () => {
    expect(text).toContain("  --color-1: rgb(99, 91, 255);");
    expect(text).toMatch(/a\.cta \{\n[^}]*var\(--color-1\)/);
  });

  it("lists motion with trigger, values, duration and easing", () => {
    expect(text).toContain(
      "- hover · css-transition · `a.cta` · background-color rgb(99, 91, 255) → rgb(10, 37, 64), transform none → translateY(-1px) · 150ms · cubic-bezier(0, 0, 0.58, 1)",
    );
  });

  it("cuts long HTML and says so", () => {
    const long = { ...capture, dom: { html: `<div>${"x".repeat(500)}</div>` } };
    const cut = referenceMarkdown(long, { html: 100, nodes: 10, motion: 10 });
    expect(cut).toContain("<!-- cut at 100 of 511 characters -->");
  });

  it("works for a capture with only DOM", () => {
    const bare: Capture = { schemaVersion: 1, meta: capture.meta, dom: { html: "<b>hi</b>" } };
    const out = referenceMarkdown(bare);
    expect(out).toContain("```html\n<b>hi</b>\n```");
    expect(out).not.toContain("## CSS");
    expect(out).not.toContain("## Motion");
  });
});
