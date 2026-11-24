import { describe, expect, it } from "vitest";
import { camelToKebab, listItem, parseCssTime, parseKeyText, splitCssList } from "./css-list.ts";

describe("splitCssList", () => {
  it("splits on top-level commas only", () => {
    expect(splitCssList("ease-out, cubic-bezier(0.2, 0, 0, 1), steps(4, end)")).toEqual([
      "ease-out",
      "cubic-bezier(0.2, 0, 0, 1)",
      "steps(4, end)",
    ]);
    expect(splitCssList("none")).toEqual(["none"]);
    expect(splitCssList("")).toEqual([]);
  });
});

describe("parseCssTime", () => {
  it("converts seconds and milliseconds to milliseconds", () => {
    expect(parseCssTime("1.2s")).toBe(1200);
    expect(parseCssTime("0.15s")).toBe(150);
    expect(parseCssTime("150ms")).toBe(150);
    expect(parseCssTime("-0.5s")).toBe(-500);
    expect(parseCssTime("auto")).toBe(0);
  });
});

describe("listItem", () => {
  it("wraps around like CSS lists do", () => {
    expect(listItem(["1s", "2s"], 3, "0s")).toBe("2s");
    expect(listItem([], 0, "0s")).toBe("0s");
  });
});

describe("parseKeyText", () => {
  it("reads percentages, from and to", () => {
    expect(parseKeyText("0%, 100%")).toEqual([0, 1]);
    expect(parseKeyText("from")).toEqual([0]);
    expect(parseKeyText("to")).toEqual([1]);
    expect(parseKeyText("37.5%")).toEqual([0.375]);
  });
});

describe("camelToKebab", () => {
  it("converts IDL property names", () => {
    expect(camelToKebab("backgroundColor")).toBe("background-color");
    expect(camelToKebab("transform")).toBe("transform");
    expect(camelToKebab("cssFloat")).toBe("float");
  });
});
