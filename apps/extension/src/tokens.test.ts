import { describe, expect, it } from "vitest";
import { buildTokens, groupFor, parseRgb } from "./tokens.ts";

const node = (styles: Record<string, string>) => ({ selector: "x", styles });

describe("buildTokens", () => {
  it("turns repeated values into tokens and replaces them in the nodes", () => {
    const { tokens, nodes } = buildTokens([
      node({ color: "rgb(10, 37, 64)", "font-size": "16px", "padding-top": "12px" }),
      node({ "background-color": "rgb(10, 37, 64)", "font-size": "16px", "padding-left": "12px" }),
    ]);
    expect(tokens.colors).toEqual({ "color-1": "rgb(10, 37, 64)" });
    expect(tokens.fontSizes).toEqual({ "font-size-1": "16px" });
    expect(tokens.spacing).toEqual({ "space-1": "12px" });
    expect(nodes[0]?.styles).toEqual({ color: "color-1", "font-size": "font-size-1", "padding-top": "space-1" });
    expect(nodes[1]?.styles["background-color"]).toBe("color-1");
  });

  it("keeps values that appear only once as raw values", () => {
    const { tokens, nodes } = buildTokens([node({ color: "rgb(1, 2, 3)", "border-top-left-radius": "8px" })]);
    expect(tokens.colors).toEqual({});
    expect(tokens.radii).toEqual({});
    expect(nodes[0]?.styles).toEqual({ color: "rgb(1, 2, 3)", "border-top-left-radius": "8px" });
  });

  it("clusters near-identical colours under the most used one", () => {
    const { tokens, nodes } = buildTokens([
      node({ color: "rgb(99, 91, 255)" }),
      node({ color: "rgb(99, 91, 255)" }),
      node({ color: "rgb(100, 92, 254)" }),
      node({ color: "rgb(20, 20, 20)" }),
    ]);
    expect(tokens.colors).toEqual({ "color-1": "rgb(99, 91, 255)" });
    expect(nodes.map((n) => n.styles.color)).toEqual(["color-1", "color-1", "color-1", "rgb(20, 20, 20)"]);
  });

  it("does not cluster colours with different alpha", () => {
    const { tokens } = buildTokens([
      node({ color: "rgba(0, 0, 0, 0.5)" }),
      node({ color: "rgba(0, 0, 0, 0.5)" }),
      node({ color: "rgb(0, 0, 0)" }),
      node({ color: "rgb(0, 0, 0)" }),
    ]);
    expect(Object.values(tokens.colors).sort()).toEqual(["rgb(0, 0, 0)", "rgba(0, 0, 0, 0.5)"]);
  });

  it("orders colours by use and sizes as an ascending scale", () => {
    const { tokens } = buildTokens([
      node({ color: "rgb(1, 1, 1)", "font-size": "32px", "padding-top": "24px" }),
      node({ color: "rgb(200, 0, 0)", "font-size": "32px", "padding-top": "24px" }),
      node({ color: "rgb(200, 0, 0)", "font-size": "14px", "padding-top": "8px" }),
      node({ color: "rgb(1, 1, 1)", "font-size": "14px", "padding-top": "8px" }),
      node({ color: "rgb(200, 0, 0)" }),
    ]);
    expect(tokens.colors).toEqual({ "color-1": "rgb(200, 0, 0)", "color-2": "rgb(1, 1, 1)" });
    expect(tokens.fontSizes).toEqual({ "font-size-1": "14px", "font-size-2": "32px" });
    expect(tokens.spacing).toEqual({ "space-1": "8px", "space-2": "24px" });
  });

  it("collects radii and shadows, and skips zero, none and transparent", () => {
    const shadow = "rgba(0, 0, 0, 0.1) 0px 4px 12px 0px";
    const { tokens, nodes } = buildTokens([
      node({ "border-top-left-radius": "8px", "box-shadow": shadow, "margin-top": "0px", "background-color": "rgba(0, 0, 0, 0)" }),
      node({ "border-bottom-right-radius": "8px", "box-shadow": shadow, "margin-top": "0px", "background-color": "rgba(0, 0, 0, 0)" }),
      node({ "box-shadow": "none" }),
      node({ "box-shadow": "none" }),
    ]);
    expect(tokens.radii).toEqual({ "radius-1": "8px" });
    expect(tokens.shadows).toEqual({ "shadow-1": shadow });
    expect(tokens.spacing).toEqual({});
    expect(tokens.colors).toEqual({});
    expect(nodes[0]?.styles["margin-top"]).toBe("0px");
  });

  it("does not modify its input", () => {
    const input = [node({ color: "rgb(1, 1, 1)" }), node({ color: "rgb(1, 1, 1)" })];
    buildTokens(input);
    expect(input[0]?.styles.color).toBe("rgb(1, 1, 1)");
  });
});

describe("groupFor", () => {
  it("maps properties to token groups", () => {
    expect(groupFor("border-left-color", "rgb(0, 0, 0)")).toBe("colors");
    expect(groupFor("row-gap", "16px")).toBe("spacing");
    expect(groupFor("gap", "16px")).toBe("spacing");
    expect(groupFor("border-top-right-radius", "4px")).toBe("radii");
    expect(groupFor("text-shadow", "rgb(0, 0, 0) 1px 1px 0px")).toBe("shadows");
    expect(groupFor("display", "flex")).toBeUndefined();
  });
});

describe("parseRgb", () => {
  it("parses rgb, rgba and space-separated syntax", () => {
    expect(parseRgb("rgb(1, 2, 3)")).toEqual([1, 2, 3, 1]);
    expect(parseRgb("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 0.5]);
    expect(parseRgb("rgb(1 2 3 / 50%)")).toEqual([1, 2, 3, 0.5]);
    expect(parseRgb("oklch(0.7 0.1 200)")).toBeUndefined();
  });
});
