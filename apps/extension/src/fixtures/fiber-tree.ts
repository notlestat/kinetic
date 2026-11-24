// Hand-built React fiber trees for unit tests. Host nodes are plain objects
// standing in for DOM elements, named by their `id`.

import { CLASS_COMPONENT, type FiberLike, FORWARD_REF, FUNCTION_COMPONENT, HOST_COMPONENT, HOST_ROOT, MEMO_COMPONENT } from "../react-tree.ts";

export interface FakeNode {
  id: string;
}

export interface FiberSpec {
  tag: number;
  type?: unknown;
  key?: string | null;
  props?: Record<string, unknown>;
  node?: FakeNode;
  children?: FiberSpec[];
}

/** Links specs into fibers with child, sibling and return pointers. */
export function build(spec: FiberSpec, parent: FiberLike | null = null): FiberLike {
  const fiber: FiberLike = {
    tag: spec.tag,
    type: spec.type ?? null,
    key: spec.key ?? null,
    memoizedProps: spec.props ?? {},
    child: null,
    sibling: null,
    return: parent,
    stateNode: spec.node ?? null,
  };
  let previous: FiberLike | null = null;
  for (const childSpec of spec.children ?? []) {
    const child = build(childSpec, fiber);
    if (previous) previous.sibling = child;
    else fiber.child = child;
    previous = child;
  }
  return fiber;
}

export const host = (id: string, children: FiberSpec[] = [], props: Record<string, unknown> = {}): FiberSpec => ({
  tag: HOST_COMPONENT,
  type: id.split(".")[0],
  node: { id },
  props,
  children,
});

export const fn = (name: string | undefined, children: FiberSpec[], props: Record<string, unknown> = {}, key?: string): FiberSpec => {
  const type = function () {};
  Object.defineProperty(type, "name", { value: name ?? "" });
  return { tag: FUNCTION_COMPONENT, type, props, children, ...(key ? { key } : {}) };
};

export const named = (displayName: string, children: FiberSpec[], props: Record<string, unknown> = {}): FiberSpec => {
  const type = Object.assign(function () {}, { displayName });
  return { tag: FUNCTION_COMPONENT, type, props, children };
};

export const motionFiber = (tag: string, props: Record<string, unknown>, children: FiberSpec[]): FiberSpec => {
  const render = Object.assign(function () {}, { displayName: `motion.${tag}` });
  const type = { $$typeof: Symbol.for("react.forward_ref"), render, [Symbol.for("motionComponentSymbol")]: tag };
  return { tag: FORWARD_REF, type, props, children };
};

export const memo = (inner: FiberSpec): FiberSpec => ({ tag: MEMO_COMPONENT, type: { type: inner.type }, children: [inner] });

export const classComponent = (name: string, children: FiberSpec[]): FiberSpec => {
  class Component {}
  Object.defineProperty(Component, "name", { value: name });
  return { tag: CLASS_COMPONENT, type: Component, children };
};

export const hostRoot = (children: FiberSpec[]): FiberSpec => ({ tag: HOST_ROOT, children });

/** Finds the fiber for a host node by id. */
export function findHost(root: FiberLike, id: string): FiberLike | undefined {
  const stack = [root];
  while (stack.length) {
    const f = stack.pop() as FiberLike;
    if ((f.stateNode as FakeNode | null)?.id === id) return f;
    for (let c = f.child; c; c = c.sibling) stack.push(c);
  }
  return undefined;
}
