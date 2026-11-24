import { describe, expect, it } from "vitest";
import { coversLatin } from "./style-capture.ts";

describe("coversLatin", () => {
  it("accepts faces without a range and ranges that include U+0041", () => {
    expect(coversLatin("")).toBe(true);
    expect(coversLatin("U+0000-00FF, U+0131")).toBe(true);
    expect(coversLatin("U+00??")).toBe(true);
  });

  it("rejects subsets for other scripts", () => {
    expect(coversLatin("U+0460-052F, U+1C80-1C8A")).toBe(false);
    expect(coversLatin("U+0100-02BA")).toBe(false);
  });
});
