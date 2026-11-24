// Reads React's fiber tree into a TreeNode tree. Pure: fibers are plain objects,
// so tests pass hand-built fiber fixtures. The MAIN world finds the starting fiber
// on the selected DOM node (its __reactFiber$ key) and calls readReactTree.

import { sanitizeProps } from "./component-props.ts";
import type { TreeNode } from "./component-tree.ts";

/** The parts of a React fiber Kinetic reads. Field names are React's own. */
export interface FiberLike {
  tag: number;
  type: unknown;
  key: string | null;
  memoizedProps: unknown;
  child: FiberLike | null;
  sibling: FiberLike | null;
  return: FiberLike | null;
  /** The DOM node for host fibers. */
  stateNode: unknown;
}

// React's work tags (react-reconciler/src/ReactWorkTags.js). Stable since React 16.
export const FUNCTION_COMPONENT = 0;
export const CLASS_COMPONENT = 1;
export const INDETERMINATE_COMPONENT = 2; // React 16–17 before first render.
export const HOST_ROOT = 3;
export const HOST_COMPONENT = 5;
export const FORWARD_REF = 11;
export const MEMO_COMPONENT = 14;
export const SIMPLE_MEMO_COMPONENT = 15;
export const HOST_HOISTABLE = 26; // React 19: <link>, <meta>, <style> hoisted into <head>.
export const HOST_SINGLETON = 27; // React 19: <html>, <head>, <body>.

/** Fibers that are user components. MemoComponent is left out: its child fiber is the wrapped component. */
const COMPOSITE_TAGS = new Set([FUNCTION_COMPONENT, CLASS_COMPONENT, INDETERMINATE_COMPONENT, FORWARD_REF, SIMPLE_MEMO_COMPONENT]);
const HOST_TAGS = new Set([HOST_COMPONENT, HOST_HOISTABLE, HOST_SINGLETON]);

export function isComposite(fiber: FiberLike): boolean {
  return COMPOSITE_TAGS.has(fiber.tag);
}

export function isHost(fiber: FiberLike): boolean {
  return HOST_TAGS.has(fiber.tag);
}

/** Framer Motion marks its motion components with this symbol (framer-motion/src/motion/utils/symbol.ts). */
const MOTION_SYMBOL = Symbol.for("motionComponentSymbol");

function nameOf(type: unknown): string | undefined {
  if (typeof type === "function") {
    const fn = type as { displayName?: unknown; name?: unknown };
    if (typeof fn.displayName === "string" && fn.displayName) return fn.displayName;
    return typeof fn.name === "string" && fn.name ? fn.name : undefined;
  }
  if (type && typeof type === "object") {
    const obj = type as { displayName?: unknown; render?: unknown; type?: unknown };
    if (typeof obj.displayName === "string" && obj.displayName) return obj.displayName;
    if (obj.render) return nameOf(obj.render); // forwardRef
    if (obj.type) return nameOf(obj.type); // memo
  }
  return undefined;
}

/** The name React DevTools shows for a composite fiber, or undefined when it has none. */
export function componentName(fiber: FiberLike): string | undefined {
  return nameOf(fiber.type);
}

/** True when the fiber is a Framer Motion component (motion.div, motion.create(Card)). */
export function isMotionComponent(fiber: FiberLike): boolean {
  const type = fiber.type as Record<symbol, unknown> | null;
  if (type && (typeof type === "object" || typeof type === "function") && MOTION_SYMBOL in type) return true;
  return componentName(fiber)?.startsWith("motion.") ?? false;
}

/** Finds the fiber React keeps on a DOM node, under a key like "__reactFiber$x7k2". */
export function fiberFromNode(node: object): FiberLike | undefined {
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return (node as Record<string, FiberLike>)[key];
    }
  }
  return undefined;
}

/** Finds the HostRoot fiber on a createRoot container, under a key like "__reactContainer$x7k2". */
export function containerFiber(node: object): FiberLike | undefined {
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactContainer$")) {
      const value = (node as Record<string, unknown>)[key];
      // React 18+: the container key holds the HostRoot fiber.
      if (value && typeof value === "object" && "tag" in value) return value as FiberLike;
    }
  }
  const legacy = (node as { _reactRootContainer?: { _internalRoot?: { current?: FiberLike } } })._reactRootContainer;
  return legacy?._internalRoot?.current; // React 17 ReactDOM.render
}

export interface ReadOptions<E> {
  /** True when the host node is the capture root or inside it. */
  isInside(node: unknown): node is E;
  /** True for the capture root itself. */
  isRoot?(node: unknown): boolean;
  /** How many components above the selection to start from. */
  ancestors?: number;
  /** Stops a runaway walk on a huge app. */
  maxFibers?: number;
  /** Describes values only the caller can recognise, such as DOM elements, for props. */
  describe?: (value: object) => string | undefined;
}

/**
 * Picks the fiber to build the tree from. Walking up from a fiber inside the
 * selection: components below the selection's own element are inside it, the
 * first component at or above it owns it, and `ancestors` more components above
 * the owner are kept for context.
 */
export function startFiber<E>(from: FiberLike, options: ReadOptions<E>): FiberLike {
  const { isInside, isRoot, ancestors = 2 } = options;
  let start: FiberLike = from;
  let reached = false;
  let owner = false;
  let above = 0;
  for (let fiber: FiberLike | null = from; fiber; fiber = fiber.return) {
    if (fiber.tag === HOST_ROOT) break;
    if (isHost(fiber) && (!isInside(fiber.stateNode) || isRoot?.(fiber.stateNode))) reached = true;
    if (!isComposite(fiber)) continue;
    if (reached && owner) {
      if (above === ancestors) break;
      above++;
    }
    if (reached) owner = true;
    start = fiber;
  }
  return start;
}

/**
 * Builds the component tree under `start`. Host elements are attached to their
 * nearest composite ancestor. Hosts above the first component (under the HostRoot)
 * become children of a nameless wrapper only when there is no component at all.
 */
export function readReactTree<E>(start: FiberLike, options: ReadOptions<E>): TreeNode<E>[] {
  const { isInside, maxFibers = 20_000, describe } = options;
  let budget = maxFibers;
  const roots: TreeNode<E>[] = [];

  const newNode = (fiber: FiberLike): TreeNode<E> => {
    const node: TreeNode<E> = {
      name: componentName(fiber),
      props: sanitizeProps(fiber.memoizedProps, describe),
      key: fiber.key ?? null,
      elements: [],
      children: [],
    };
    if (isMotionComponent(fiber) && fiber.memoizedProps && typeof fiber.memoizedProps === "object") {
      node.motionProps = fiber.memoizedProps as Record<string, unknown>;
    }
    return node;
  };

  // Iterative depth-first walk, so a deep tree cannot overflow the stack.
  const stack: { fiber: FiberLike; owner: TreeNode<E> | undefined }[] = [{ fiber: start, owner: undefined }];
  while (stack.length > 0 && budget-- > 0) {
    const { fiber, owner } = stack.pop() as { fiber: FiberLike; owner: TreeNode<E> | undefined };
    let next = owner;
    if (isComposite(fiber)) {
      const node = newNode(fiber);
      if (owner) owner.children.push(node);
      else roots.push(node);
      next = node;
    } else if (isHost(fiber) && owner && isInside(fiber.stateNode)) {
      owner.elements.push(fiber.stateNode);
    }
    // Push children in reverse so they pop in document order.
    const children: FiberLike[] = [];
    for (let c = fiber.child; c; c = c.sibling) children.push(c);
    for (let i = children.length - 1; i >= 0; i--) stack.push({ fiber: children[i] as FiberLike, owner: next });
  }
  return roots;
}

/** Walks up to the HostRoot fiber, the top of a React root. */
export function hostRootOf(fiber: FiberLike): FiberLike | undefined {
  let node: FiberLike | null = fiber;
  for (let guard = 0; node && guard < 10_000; guard++) {
    if (node.tag === HOST_ROOT) return node;
    node = node.return;
  }
  return undefined;
}

/**
 * The current HostRoot. A fiber read off a DOM node can belong to the alternate
 * (previous) tree after re-renders; the FiberRoot's `current` is always live.
 */
export function currentHostRoot(hostRoot: FiberLike): FiberLike {
  const current = (hostRoot.stateNode as { current?: FiberLike } | null)?.current;
  return current && typeof current === "object" ? current : hostRoot;
}

/** Depth-first search for the first host fiber whose DOM node matches, in document order. */
export function findHostFiber(start: FiberLike, matches: (node: unknown) => boolean, maxFibers = 50_000): FiberLike | undefined {
  const stack: FiberLike[] = [start];
  let budget = maxFibers;
  while (stack.length > 0 && budget-- > 0) {
    const fiber = stack.pop() as FiberLike;
    if (isHost(fiber) && matches(fiber.stateNode)) return fiber;
    const children: FiberLike[] = [];
    for (let c = fiber.child; c; c = c.sibling) children.push(c);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as FiberLike);
  }
  return undefined;
}
