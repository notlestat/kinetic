// Reads Vue component trees into TreeNode trees. Pure: vnodes and instances are
// plain objects here, so tests pass hand-built fixtures.
//
// Vue 3 only puts __vueParentComponent on elements in development builds (or with
// __VUE_PROD_DEVTOOLS__), but the app container always keeps its root vnode as
// container._vnode, so the walk starts there and works on production sites too.

import { sanitizeProps } from "./component-props.ts";
import type { TreeNode } from "./component-tree.ts";

// Vue 3 ShapeFlags (packages/shared/src/shapeFlags.ts).
const ELEMENT = 1;
const COMPONENT = 2 | 4; // FUNCTIONAL_COMPONENT | STATEFUL_COMPONENT
const ARRAY_CHILDREN = 16;
const TELEPORT = 64;
const SUSPENSE = 128;

export interface VNodeLike {
  type: unknown;
  shapeFlag: number;
  el: unknown;
  key: unknown;
  children: unknown;
  component: InstanceLike | null;
  suspense?: { activeBranch?: VNodeLike | null } | null;
}

export interface InstanceLike {
  type: unknown;
  props: unknown;
  subTree: VNodeLike | null;
  parent: InstanceLike | null;
  vnode?: VNodeLike;
}

/** A Vue 3 component's name: name, then the SFC compiler's __name, then the file name. */
export function vueComponentName(type: unknown): string | undefined {
  if (!type || (typeof type !== "object" && typeof type !== "function")) return undefined;
  const t = type as { name?: unknown; __name?: unknown; displayName?: unknown; __file?: unknown };
  for (const value of [t.name, t.__name, t.displayName]) {
    if (typeof value === "string" && value) return value;
  }
  if (typeof t.__file === "string") {
    const match = /([^/\\]+)\.vue$/.exec(t.__file);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export interface VueReadOptions<E> {
  isElement(node: unknown): node is E;
  /** Describes values only the caller can recognise, such as DOM elements, for props. */
  describe?: (value: object) => string | undefined;
  maxVNodes?: number;
}

/** Walks a Vue 3 vnode tree from the app's root vnode (container._vnode). */
export function readVue3Tree<E>(rootVNode: VNodeLike, options: VueReadOptions<E>): TreeNode<E>[] {
  const { isElement, describe, maxVNodes = 20_000 } = options;
  let budget = maxVNodes;
  const roots: TreeNode<E>[] = [];
  const stack: { vnode: VNodeLike; owner: TreeNode<E> | undefined }[] = [{ vnode: rootVNode, owner: undefined }];

  while (stack.length > 0 && budget-- > 0) {
    const { vnode, owner } = stack.pop() as { vnode: VNodeLike; owner: TreeNode<E> | undefined };
    if (!vnode || typeof vnode !== "object") continue;
    const children: VNodeLike[] = [];
    let next = owner;

    if (vnode.shapeFlag & COMPONENT && vnode.component) {
      const instance = vnode.component;
      const node: TreeNode<E> = {
        name: vueComponentName(instance.type),
        props: sanitizeProps(instance.props, describe),
        key: typeof vnode.key === "string" || typeof vnode.key === "number" ? String(vnode.key) : null,
        elements: [],
        children: [],
      };
      if (owner) owner.children.push(node);
      else roots.push(node);
      next = node;
      if (instance.subTree) children.push(instance.subTree);
    } else if (vnode.shapeFlag & SUSPENSE) {
      const active = vnode.suspense?.activeBranch;
      if (active) children.push(active);
    } else {
      if (vnode.shapeFlag & ELEMENT && owner && isElement(vnode.el)) owner.elements.push(vnode.el);
      // Elements, fragments and teleports keep child vnodes in an array.
      if ((vnode.shapeFlag & ARRAY_CHILDREN || vnode.shapeFlag & TELEPORT || Array.isArray(vnode.children)) && Array.isArray(vnode.children)) {
        for (const child of vnode.children) if (child && typeof child === "object") children.push(child as VNodeLike);
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ vnode: children[i] as VNodeLike, owner: next });
  }
  return roots;
}

/** The parts of a Vue 2 component instance Kinetic reads. */
export interface Vue2InstanceLike {
  $options: { name?: unknown; _componentTag?: unknown };
  $props?: unknown;
  $el: unknown;
  $parent: Vue2InstanceLike | null;
  $children: Vue2InstanceLike[];
  $vnode?: { key?: unknown } | null;
}

/** Walks a Vue 2 tree down from an instance through $children. Each component owns its $el. */
export function readVue2Tree<E>(top: Vue2InstanceLike, options: VueReadOptions<E>): TreeNode<E>[] {
  const { isElement, describe, maxVNodes = 5_000 } = options;
  let budget = maxVNodes;
  const build = (vm: Vue2InstanceLike): TreeNode<E> => {
    const name = vm.$options.name ?? vm.$options._componentTag;
    const key = vm.$vnode?.key;
    const node: TreeNode<E> = {
      name: typeof name === "string" && name ? name : undefined,
      props: sanitizeProps(vm.$props, describe),
      key: typeof key === "string" || typeof key === "number" ? String(key) : null,
      // A parent's $el is also its child's $el when the child is the root of its template; the child owns it.
      elements: isElement(vm.$el) && !vm.$children.some((c) => c.$el === vm.$el) ? [vm.$el] : [],
      children: [],
    };
    for (const child of vm.$children) {
      if (budget-- <= 0) break;
      node.children.push(build(child));
    }
    return node;
  };
  return [build(top)];
}

/** Walks up from a Vue 2 instance `levels` parents, stopping at the root. */
export function vue2Ancestor(vm: Vue2InstanceLike, levels: number): Vue2InstanceLike {
  let current = vm;
  for (let i = 0; i < levels && current.$parent; i++) current = current.$parent;
  return current;
}
