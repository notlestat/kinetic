import { describe, expect, it } from "vitest";
import { diffAgainstDefaults, diffSnapshots, isIgnoredProperty } from "./style-diff.ts";

const size = { width: 200, height: 40 };

describe("diffAgainstDefaults", () => {
  it("keeps only properties that differ from the tag's browser default", () => {
    const out = diffAgainstDefaults({
      computed: { display: "inline-flex", "padding-top": "12px", position: "static", color: "rgb(0, 0, 0)" },
      defaults: { display: "inline-block", "padding-top": "1px", position: "static", color: "rgb(0, 0, 0)" },
      parent: null,
      size,
    });
    expect(out).toEqual({ display: "inline-flex", "padding-top": "12px" });
  });

  it("drops inherited properties a child shares with its parent", () => {
    const parent = { color: "rgb(10, 37, 64)", "font-family": "Inter" };
    const out = diffAgainstDefaults({
      computed: { color: "rgb(10, 37, 64)", "font-family": "Inter", "margin-top": "4px" },
      defaults: { color: "rgb(0, 0, 0)", "font-family": "Times", "margin-top": "0px" },
      parent,
      size,
    });
    expect(out).toEqual({ "margin-top": "4px" });
  });

  it("keeps an inherited property when the child resets it to the default", () => {
    const out = diffAgainstDefaults({
      computed: { color: "rgb(0, 0, 0)" },
      defaults: { color: "rgb(0, 0, 0)" },
      parent: { color: "rgb(255, 0, 0)" },
      size,
    });
    expect(out).toEqual({ color: "rgb(0, 0, 0)" });
  });

  it("compares inherited properties on the root against the defaults", () => {
    const out = diffAgainstDefaults({
      computed: { color: "rgb(255, 0, 0)", "font-size": "16px" },
      defaults: { color: "rgb(0, 0, 0)", "font-size": "16px" },
      parent: null,
      size,
    });
    expect(out).toEqual({ color: "rgb(255, 0, 0)" });
  });

  it("does not compare non-inherited properties against the parent", () => {
    const out = diffAgainstDefaults({
      computed: { "background-color": "rgb(255, 0, 0)" },
      defaults: { "background-color": "rgba(0, 0, 0, 0)" },
      parent: { "background-color": "rgb(255, 0, 0)" },
      size,
    });
    expect(out).toEqual({ "background-color": "rgb(255, 0, 0)" });
  });

  it("skips size, logical duplicates, custom properties and a centred transform origin", () => {
    const out = diffAgainstDefaults({
      computed: {
        width: "200px",
        height: "40px",
        "inline-size": "200px",
        "padding-inline-start": "12px",
        "--brand": "red",
        "transform-origin": "100px 20px",
        "perspective-origin": "0px 0px",
      },
      defaults: { width: "auto", "transform-origin": "0px 0px", "perspective-origin": "50px 50px" },
      parent: null,
      size,
    });
    expect(out).toEqual({ "perspective-origin": "0px 0px" });
  });
});

describe("diffAgainstDefaults noise rules", () => {
  it("drops currentcolor-derived colours that just follow the text colour", () => {
    const white = "rgb(255, 255, 255)";
    const black = "rgb(0, 0, 0)";
    const out = diffAgainstDefaults({
      computed: { color: white, "border-top-color": white, "outline-color": white, "caret-color": "rgb(255, 0, 0)" },
      defaults: { color: black, "border-top-color": black, "outline-color": black, "caret-color": black },
      parent: null,
      size,
    });
    expect(out).toEqual({ color: white, "caret-color": "rgb(255, 0, 0)" });
  });

  it("keeps a border colour that is set apart from the text colour", () => {
    const out = diffAgainstDefaults({
      computed: { color: "rgb(255, 255, 255)", "border-top-color": "rgb(0, 0, 255)" },
      defaults: { color: "rgb(0, 0, 0)", "border-top-color": "rgb(0, 0, 0)" },
      parent: null,
      size,
    });
    expect(out).toEqual({ color: "rgb(255, 255, 255)", "border-top-color": "rgb(0, 0, 255)" });
  });

  it("drops logical radii, -webkit-locale and auto minimum sizes", () => {
    const out = diffAgainstDefaults({
      computed: {
        "border-start-end-radius": "8px",
        "border-top-right-radius": "8px",
        "-webkit-locale": '"en"',
        "min-width": "auto",
        "min-height": "40px",
      },
      defaults: { "border-top-right-radius": "0px", "min-width": "0px", "min-height": "0px" },
      parent: null,
      size,
    });
    expect(out).toEqual({ "border-top-right-radius": "8px", "min-height": "40px" });
  });
});

describe("diffSnapshots", () => {
  it("ignores origins and tap highlights, which follow size and device emulation", () => {
    const before = { a: { "transform-origin": "10px 10px", "-webkit-tap-highlight-color": "rgba(0, 0, 0, 0.18)" } };
    const after = { a: { "transform-origin": "20px 10px", "-webkit-tap-highlight-color": "rgba(51, 181, 229, 0.4)" } };
    expect(diffSnapshots(before, after)).toEqual({});
  });

  it("returns only the changed properties per selector", () => {
    const before = { a: { color: "red", opacity: "1" }, b: { color: "blue" } };
    const after = { a: { color: "green", opacity: "1" }, b: { color: "blue" } };
    expect(diffSnapshots(before, after)).toEqual({ a: { color: "green" } });
  });

  it("ignores size changes, which the bounding box already records", () => {
    expect(diffSnapshots({ a: { width: "10px" } }, { a: { width: "20px" } })).toEqual({});
  });
});

describe("isIgnoredProperty", () => {
  it("matches logical properties but not physical ones", () => {
    expect(isIgnoredProperty("margin-block-end")).toBe(true);
    expect(isIgnoredProperty("border-inline-start-color")).toBe(true);
    expect(isIgnoredProperty("block-size")).toBe(true);
    expect(isIgnoredProperty("margin-bottom")).toBe(false);
    expect(isIgnoredProperty("display")).toBe(false);
  });
});
