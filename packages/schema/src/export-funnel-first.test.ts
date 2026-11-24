import { describe, expect, it } from "vitest";
import sample from "../fixtures/sample-capture.json" with { type: "json" };
import { CaptureSchema } from "./capture.ts";
import { FUNNEL_FIRST_FORMAT, funnelFirstFileName, toFunnelFirstTokens } from "./export-funnel-first.ts";

const capture = CaptureSchema.parse(sample);

describe("toFunnelFirstTokens (placeholder format)", () => {
  it("copies every token group and the source, and marks the file as the placeholder", () => {
    expect(toFunnelFirstTokens(capture)).toEqual({
      format: FUNNEL_FIRST_FORMAT,
      version: 0,
      source: { url: capture.meta.url, site: "example.com", slug: "cta-button", capturedAt: capture.meta.timestamp },
      tokens: {
        color: { "color-1": "rgb(99, 91, 255)", "color-2": "rgb(255, 255, 255)" },
        fontSize: { "font-size-1": "16px" },
        space: {},
        radius: { "radius-1": "999px" },
        shadow: {},
      },
      fonts: [{ family: "Inter", weight: "600", style: "normal" }],
    });
  });

  it("works for a capture without styles, and drops duplicate fonts and font URLs", () => {
    const bare = CaptureSchema.parse({ schemaVersion: sample.schemaVersion, meta: sample.meta });
    expect(toFunnelFirstTokens(bare).tokens).toEqual({ color: {}, fontSize: {}, space: {}, radius: {}, shadow: {} });
    const font = { family: "Inter", weight: "400", style: "normal", src: "https://example.com/inter.woff2" };
    const styled = { ...capture, styles: { nodes: [], fonts: [font, font] } };
    expect(toFunnelFirstTokens(styled).fonts).toEqual([{ family: "Inter", weight: "400", style: "normal" }]);
    expect(funnelFirstFileName(capture)).toBe("example.com-cta-button.funnel-first.json");
  });
});
