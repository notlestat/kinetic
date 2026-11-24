// A framework-neutral component tree. The React and Vue readers both build one,
// then flattenTree keeps the part that matters for the selection and turns it into
// framework.json's flat component list. Generic over the host node type so tests
// can use plain objects instead of DOM elements.

import type { FrameworkComponent } from "@kinetic/schema";
import { isMinifiedName } from "./component-props.ts";

export interface TreeNode<E> {
  /** The display name, or undefined when the component has none. */
  name: string | undefined;
  props: Record<string, unknown>;
  key: string | null;
  /** Host elements this component renders directly, not through a child component. */
  elements: E[];
  children: TreeNode<E>[];
  /** Raw props for motion libraries (Framer Motion), read before sanitising. */
  motionProps?: Record<string, unknown>;
}

export interface FlattenOptions<E> {
  /** "react-1", "vue-1", … */
  idPrefix: string;
  /** True when the element is the capture root or inside it. */
  isInside(element: E): boolean;
  selectorFor(element: E): string;
  /** How many components above the selection to keep for context. */
  maxAncestors?: number;
  maxComponents?: number;
}

export interface FlatComponent<E> extends FrameworkComponent {
  /** The tree node this entry came from, for callers that need the elements. */
  node: TreeNode<E>;
}

function ownInside<E>(node: TreeNode<E>, isInside: (e: E) => boolean): boolean {
  return node.elements.some(isInside);
}

/**
 * Keeps components that render something inside the selection, plus up to
 * maxAncestors components above it, as a flat list linked by parentId. Each
 * component's domNodes are the selected elements it renders directly.
 */
export function flattenTree<E>(roots: readonly TreeNode<E>[], options: FlattenOptions<E>): FlatComponent<E>[] {
  const { idPrefix, isInside, selectorFor, maxAncestors = 2, maxComponents = 300 } = options;

  // Which subtrees reach the selection. Memoised, because the walk below asks for each node more than once.
  const reaches = new Map<TreeNode<E>, boolean>();
  const reachesInside = (node: TreeNode<E>): boolean => {
    const known = reaches.get(node);
    if (known !== undefined) return known;
    reaches.set(node, false); // Guards against cycles in malformed input.
    const result = ownInside(node, isInside) || node.children.some(reachesInside);
    reaches.set(node, result);
    return result;
  };

  // Skip the chain of wrappers above the selection (App, Layout, Providers…) down to the last maxAncestors.
  const start = (top: TreeNode<E>): TreeNode<E>[] => {
    const chain: TreeNode<E>[] = [];
    let node: TreeNode<E> | undefined = top;
    while (node && !ownInside(node, isInside)) {
      const next: TreeNode<E>[] = node.children.filter(reachesInside);
      if (next.length !== 1) break;
      chain.push(node);
      node = next[0];
    }
    if (!node) return [];
    // node is the first component that renders into the selection or splits into several branches.
    const kept = chain.slice(Math.max(0, chain.length - maxAncestors));
    return kept.length > 0 ? [kept[0] as TreeNode<E>] : [node];
  };

  const out: FlatComponent<E>[] = [];
  const visit = (node: TreeNode<E>, parentId: string | null) => {
    if (out.length >= maxComponents || !reachesInside(node)) return;
    const id = `${idPrefix}-${out.length + 1}`;
    const name = node.name || "Anonymous";
    out.push({
      id,
      name,
      parentId,
      minified: isMinifiedName(node.name),
      props: node.props,
      domNodes: node.elements.filter(isInside).map(selectorFor),
      node,
    });
    for (const child of node.children) visit(child, id);
  };
  for (const top of roots.filter(reachesInside)) {
    for (const first of start(top)) visit(first, null);
  }
  return out;
}

/** Drops the internal node reference so the list can go into framework.json. */
export function toFrameworkComponents<E>(flat: readonly FlatComponent<E>[]): FrameworkComponent[] {
  return flat.map(({ node: _node, ...component }) => component);
}
