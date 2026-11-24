import type { FrameworkComponent } from "@kinetic/schema";
import { describe, expect, it } from "vitest";
import { type DomChild, splitFromComponents, splitFromDom } from "./component-split.ts";

const c = (id: string, name: string, parentId: string | null, domNodes: string[] = [], minified = false): FrameworkComponent => ({
  id,
  name,
  parentId,
  minified,
  props: {},
  domNodes,
});

describe("splitFromComponents", () => {
  it("splits the owner's children, looks through wrappers and merges repeated components", () => {
    const split = splitFromComponents([
      c("1", "Layout", null),
      c("2", "PricingSection", "1", ["section"]),
      c("3", "motion.h2", "2", ["h2"]),
      c("4", "motion.div", "2", ["div.plans"]),
      c("5", "PlanCard", "4", []),
      c("6", "motion.article", "5", ["article-1"]),
      c("7", "PlanCard", "4", []),
      c("8", "motion.article", "7", ["article-2"]),
    ]);
    expect(split).toEqual([
      { name: "MotionH2", domNodes: ["h2"] },
      { name: "PlanCard", domNodes: ["article-1", "article-2"] },
    ]);
  });

  it("names minified children generically and gives up below two parts", () => {
    expect(splitFromComponents([c("1", "Card", null, ["div"]), c("2", "t", "1", ["p"], true), c("3", "e", "1", ["span"], true)])).toEqual([
      { name: "Part", domNodes: ["p"] },
      { name: "Part2", domNodes: ["span"] },
    ]);
    expect(splitFromComponents([c("1", "Card", null, ["div"]), c("2", "Title", "1", ["h3"])])).toEqual([]);
    expect(splitFromComponents([])).toEqual([]);
  });
});

const box = (y: number, x = 0) => ({ x, y, width: 100, height: 40 });
const child = (selector: string, tag: string, classes: string[], b = box(0), children?: DomChild[]): DomChild => ({
  selector,
  tag,
  classes,
  box: b,
  ...(children ? { children } : {}),
});

describe("splitFromDom", () => {
  it("names parts by class or tag and merges repeated siblings", () => {
    expect(
      splitFromDom([
        child("h2", "h2", [], box(0)),
        child("a1", "article", ["plan"], box(60, 0)),
        child("a2", "article", ["plan"], box(60, 120)),
        child("btn", "button", ["css-1x2y3z"], box(200)),
      ]),
    ).toEqual([
      { name: "Heading", domNodes: ["h2"] },
      { name: "PlanItem", domNodes: ["a1", "a2"] },
      { name: "Button", domNodes: ["btn"] },
    ]);
  });

  it("looks through a lone wrapper and skips invisible children", () => {
    const split = splitFromDom([
      child("wrap", "div", ["inner"], box(0), [child("logo", "img", [], box(0)), child("links", "ul", ["nav-links"], box(0, 200)), child("hidden", "div", [], { x: 0, y: 0, width: 0, height: 0 })]),
    ]);
    expect(split).toEqual([
      { name: "Image", domNodes: ["logo"] },
      { name: "NavLinks", domNodes: ["links"] },
    ]);
  });

  it("groups many unrelated children into rows", () => {
    const kids = ["h1", "p", "img", "a", "span", "button", "svg"].map((tag, i) => child(tag, tag, [], box(i < 3 ? 0 : i < 5 ? 100 : 200, i * 10)));
    expect(splitFromDom(kids).map((p) => p.name)).toEqual(["Row1", "Row2", "Row3"]);
  });

  it("returns nothing for a single leaf", () => {
    expect(splitFromDom([child("p", "p", [])])).toEqual([]);
  });
});
