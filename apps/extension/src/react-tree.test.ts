import { describe, expect, it } from "vitest";
import { flattenTree, toFrameworkComponents } from "./component-tree.ts";
import { build, classComponent, type FakeNode, findHost, fn, host, hostRoot, memo, motionFiber, named } from "./fixtures/fiber-tree.ts";
import { componentName, containerFiber, currentHostRoot, fiberFromNode, isMotionComponent, readReactTree, startFiber } from "./react-tree.ts";

/** App > Layout > Page > section.pricing > [h2, Card×2 > div.card > (p.price via t, button)] plus a Sidebar outside. */
function appTree() {
  return build(
    hostRoot([
      named("App", [
        named("Layout", [
          host("div.shell", [
            named("Sidebar", [host("aside.sidebar")]),
            named("Page", [
              named("PricingSection", [
                host("section.pricing", [
                  host("h2.title"),
                  fn("Card", [host("div.card-1", [fn("t", [host("p.price-1")]), host("button.cta-1")])], { plan: "starter", onSelect: () => 0 }, "starter"),
                  fn("Card", [host("div.card-2", [fn("t", [host("p.price-2")]), host("button.cta-2")])], { plan: "team", onSelect: () => 0 }, "team"),
                ]),
              ], { apiToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", title: "Plans", author: "Docs team" }),
            ]),
          ]),
        ]),
      ]),
    ]),
  );
}

const SECTION_IDS = new Set(["section.pricing", "h2.title", "div.card-1", "p.price-1", "button.cta-1", "div.card-2", "p.price-2", "button.cta-2"]);
const isInside = (node: unknown): node is FakeNode => !!node && SECTION_IDS.has((node as FakeNode).id);
const selectorFor = (node: FakeNode) => node.id;
const isRoot = (node: unknown) => (node as FakeNode | null)?.id === "section.pricing";

describe("componentName", () => {
  it("reads displayName, function names, forwardRef and memo wrappers", () => {
    expect(componentName(build(named("PricingSection", [])))).toBe("PricingSection");
    expect(componentName(build(fn("Card", [])))).toBe("Card");
    expect(componentName(build(fn(undefined, [])))).toBeUndefined();
    expect(componentName(build(motionFiber("div", {}, [])))).toBe("motion.div");
    expect(componentName(build(classComponent("Legacy", [])))).toBe("Legacy");
  });

  it("recognises Framer Motion components by their symbol", () => {
    expect(isMotionComponent(build(motionFiber("button", {}, [])))).toBe(true);
    expect(isMotionComponent(build(fn("Card", [])))).toBe(false);
  });
});

describe("startFiber and readReactTree", () => {
  it("starts two components above the one that owns the selection", () => {
    const root = appTree();
    const section = findHost(root, "section.pricing");
    if (!section) throw new Error("fixture");
    const start = startFiber(section, { isInside, isRoot: (n) => (n as FakeNode | null)?.id === "section.pricing" });
    // PricingSection owns section.pricing; Page and Layout are the two ancestors.
    expect(componentName(start)).toBe("Layout");
  });

  it("without isRoot, counts ancestors from the first component outside the selection", () => {
    const root = appTree();
    const price = findHost(root, "p.price-1") as NonNullable<ReturnType<typeof findHost>>;
    // Every component up to Page renders inside the selection. div.shell is the first node outside it,
    // so Layout is the owner and App the one ancestor left before the HostRoot.
    expect(componentName(startFiber(price, { isInside }))).toBe("App");
  });

  it("builds a component tree with the selected DOM nodes each component renders", () => {
    const root = appTree();
    const section = findHost(root, "section.pricing") as NonNullable<ReturnType<typeof findHost>>;
    const tree = readReactTree(startFiber(section, { isInside, isRoot }), { isInside });
    const flat = toFrameworkComponents(flattenTree(tree, { idPrefix: "react", isInside, selectorFor }));

    expect(flat.map((c) => c.name)).toEqual(["Layout", "Page", "PricingSection", "Card", "t", "Card", "t"]);
    const byName = (name: string) => flat.filter((c) => c.name === name);
    expect(byName("PricingSection")[0]?.domNodes).toEqual(["section.pricing", "h2.title"]);
    expect(byName("Card")[1]?.domNodes).toEqual(["div.card-2", "button.cta-2"]);
    expect(byName("t")[0]).toMatchObject({ minified: true, domNodes: ["p.price-1"] });
    // Sidebar renders nothing inside the selection.
    expect(byName("Sidebar")).toHaveLength(0);
    // Parent links form the tree.
    const card = byName("Card")[0];
    expect(flat.find((c) => c.id === card?.parentId)?.name).toBe("PricingSection");
    expect(flat[0]?.parentId).toBeNull();
  });

  it("sanitises props: functions become placeholders and credentials are dropped", () => {
    const root = appTree();
    const section = findHost(root, "section.pricing") as NonNullable<ReturnType<typeof findHost>>;
    const flat = flattenTree(readReactTree(startFiber(section, { isInside }), { isInside }), { idPrefix: "react", isInside, selectorFor });
    const pricing = flat.find((c) => c.name === "PricingSection");
    expect(pricing?.props).toEqual({ title: "Plans", author: "Docs team" });
    const card = flat.find((c) => c.name === "Card");
    expect(card?.props).toEqual({ plan: "starter", onSelect: "[function]" });
    expect(card?.node.key).toBe("starter");
  });

  it("looks through memo wrappers without listing the component twice", () => {
    const root = build(hostRoot([named("App", [memo(fn("Row", [host("div.row")]))])]));
    const inside = (n: unknown): n is FakeNode => (n as FakeNode | null)?.id === "div.row";
    const flat = flattenTree(readReactTree(root, { isInside: inside }), { idPrefix: "react", isInside: inside, selectorFor });
    expect(flat.map((c) => c.name)).toEqual(["App", "Row"]);
  });

  it("keeps raw motion props on Framer Motion components", () => {
    const root = build(hostRoot([named("App", [motionFiber("div", { animate: { opacity: 1 }, className: "box" }, [host("div.box")])])]));
    const inside = (n: unknown): n is FakeNode => (n as FakeNode | null)?.id === "div.box";
    const tree = readReactTree(root, { isInside: inside });
    expect(tree[0]?.children[0]?.motionProps).toEqual({ animate: { opacity: 1 }, className: "box" });
  });
});

describe("finding fibers on DOM nodes", () => {
  it("reads __reactFiber$ and __reactContainer$ keys", () => {
    const fiber = build(fn("Card", []));
    const hostRootFiber = build(hostRoot([]));
    expect(fiberFromNode({ __reactFiber$abc123: fiber })).toBe(fiber);
    expect(fiberFromNode({ other: 1 })).toBeUndefined();
    expect(containerFiber({ __reactContainer$abc123: hostRootFiber })).toBe(hostRootFiber);
  });

  it("follows the FiberRoot to the current tree", () => {
    const stale = build(hostRoot([]));
    const current = build(hostRoot([]));
    stale.stateNode = { current };
    expect(currentHostRoot(stale)).toBe(current);
    expect(currentHostRoot(current)).toBe(current);
  });
});
