import { describe, expect, it } from "vitest";
import { flattenTree, type TreeNode, toFrameworkComponents } from "./component-tree.ts";
import { readVue2Tree, readVue3Tree, type VNodeLike, type Vue2InstanceLike, vue2Ancestor, vueComponentName } from "./vue-tree.ts";

interface El {
  id: string;
}
const isElement = (n: unknown): n is El => typeof n === "object" && n !== null && "id" in n;

// Vue 3 vnode builders. ShapeFlags: ELEMENT 1, STATEFUL_COMPONENT 4, ARRAY_CHILDREN 16.
const element = (id: string, children: VNodeLike[] = []): VNodeLike => ({
  type: id.split(".")[0],
  shapeFlag: 1 | (children.length ? 16 : 0),
  el: { id },
  key: null,
  children,
  component: null,
});
const component = (type: object, props: Record<string, unknown>, subTree: VNodeLike, key: string | null = null): VNodeLike => ({
  type,
  shapeFlag: 4,
  el: subTree.el,
  key,
  children: null,
  component: { type, props, subTree, parent: null },
});
const fragment = (children: VNodeLike[]): VNodeLike => ({ type: Symbol("Fragment"), shapeFlag: 16, el: null, key: null, children, component: null });

describe("vueComponentName", () => {
  it("reads name, __name and the SFC file name", () => {
    expect(vueComponentName({ name: "PlanCard" })).toBe("PlanCard");
    expect(vueComponentName({ __name: "PriceTag" })).toBe("PriceTag");
    expect(vueComponentName({ __file: "/src/components/FeatureList.vue" })).toBe("FeatureList");
    expect(vueComponentName({})).toBeUndefined();
  });
});

describe("readVue3Tree", () => {
  // App > PricingGrid > section.pricing > [h2, div.plans > PlanCard×2 > article > (PriceTag > p, button)]
  const card = (n: number) =>
    component(
      { name: "PlanCard" },
      { plan: { id: `p${n}` }, sessionToken: "abc", onChoose: () => 0 },
      element(`article.plan-${n}`, [component({ name: "PriceTag" }, { amount: n * 10 }, element(`p.price-${n}`)), element(`button.cta-${n}`)]),
      `p${n}`,
    );
  const app = component(
    { name: "App" },
    {},
    fragment([component({ name: "PricingGrid" }, { plans: [] }, element("section.pricing", [element("h2.title"), element("div.plans", [card(1), card(2)])]))]),
  );

  it("walks components and the elements each renders, from the root vnode", () => {
    const inside = new Set(["section.pricing", "h2.title", "div.plans", "article.plan-1", "p.price-1", "button.cta-1", "article.plan-2", "p.price-2", "button.cta-2"]);
    const roots = readVue3Tree(app, { isElement });
    const flat = toFrameworkComponents(flattenTree(roots, { idPrefix: "vue", isInside: (e) => inside.has(e.id), selectorFor: (e) => e.id }));
    expect(flat.map((c) => c.name)).toEqual(["App", "PricingGrid", "PlanCard", "PriceTag", "PlanCard", "PriceTag"]);
    expect(flat[1]?.domNodes).toEqual(["section.pricing", "h2.title", "div.plans"]);
    expect(flat[2]).toMatchObject({ domNodes: ["article.plan-1", "button.cta-1"], props: { plan: { id: "p1" }, onChoose: "[function]" } });
    expect(flat[3]?.domNodes).toEqual(["p.price-1"]);
  });

  it("keeps only components that reach the selection, plus two ancestors", () => {
    const roots = readVue3Tree(app, { isElement });
    const flat = flattenTree(roots, { idPrefix: "vue", isInside: (e) => e.id.endsWith("-2"), selectorFor: (e) => e.id });
    // App and PricingGrid only lead to the selection: they are the two ancestors kept. PlanCard 1 is left out.
    expect(flat.map((c) => c.name)).toEqual(["App", "PricingGrid", "PlanCard", "PriceTag"]);
    expect(flat.find((c) => c.name === "PlanCard")?.domNodes).toEqual(["article.plan-2", "button.cta-2"]);
  });
});

describe("readVue2Tree", () => {
  it("walks $children and gives each component its $el", () => {
    const leaf: Vue2InstanceLike = { $options: { name: "PriceTag" }, $props: { amount: 9 }, $el: { id: "p.price" }, $parent: null, $children: [] };
    const cardVm: Vue2InstanceLike = { $options: { _componentTag: "plan-card" }, $props: { token: "x", plan: "a" }, $el: { id: "article" }, $parent: null, $children: [leaf] };
    const root: Vue2InstanceLike = { $options: {}, $el: { id: "div.app" }, $parent: null, $children: [cardVm] };
    leaf.$parent = cardVm;
    cardVm.$parent = root;
    expect(vue2Ancestor(leaf, 2)).toBe(root);
    const [tree] = readVue2Tree(root, { isElement });
    expect(tree?.name).toBeUndefined();
    expect(tree?.children[0]).toMatchObject({ name: "plan-card", props: { plan: "a" }, elements: [{ id: "article" }] });
    expect(tree?.children[0]?.children[0]).toMatchObject({ name: "PriceTag", props: { amount: 9 } });
  });
});

describe("flattenTree ancestor limit", () => {
  it("drops wrappers more than two levels above the selection", () => {
    const leaf: TreeNode<El> = { name: "Leaf", props: {}, key: null, elements: [{ id: "in" }], children: [] };
    const wrap = (name: string, child: TreeNode<El>): TreeNode<El> => ({ name, props: {}, key: null, elements: [], children: [child] });
    const tree = wrap("Root", wrap("Providers", wrap("Layout", wrap("Page", leaf))));
    const flat = flattenTree([tree], { idPrefix: "x", isInside: (e) => e.id === "in", selectorFor: (e) => e.id });
    expect(flat.map((c) => c.name)).toEqual(["Layout", "Page", "Leaf"]);
    expect(flat[0]?.parentId).toBeNull();
  });
});
