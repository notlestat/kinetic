// The suggested component split in framework.json: how the rebuild should break
// the selection into sub-components. From the framework's own component tree when
// there is one, otherwise from DOM structure and visual grouping. Pure.

import type { FrameworkComponent } from "@kinetic/schema";

export interface SplitPart {
  name: string;
  domNodes: string[];
}

/** Library wrappers that add behaviour, not structure: the split looks through them. */
function isTransparent(name: string): boolean {
  return name.startsWith("motion.") || /^(Fragment|Suspense|StrictMode|Profiler|Transition|TransitionGroup|KeepAlive|Teleport|AnimatePresence|LayoutGroup|LazyMotion|MotionConfig)$/.test(name) || /(Provider|Context|Consumer|Boundary)$/.test(name);
}

function pascal(text: string): string {
  const out = text
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Z]/.test(out) ? out : `Part${out}`;
}

/** Gives repeated names a number: Card, Card2, Card3. */
function uniqueNames(parts: SplitPart[]): SplitPart[] {
  const seen = new Map<string, number>();
  return parts.map((part) => {
    const n = (seen.get(part.name) ?? 0) + 1;
    seen.set(part.name, n);
    return n === 1 ? part : { ...part, name: `${part.name}${n}` };
  });
}

/**
 * Splits along the component tree: the direct child components of the component
 * that owns the selection, looking through library wrappers. Repeated components
 * (a list of Card) become one part. Returns [] when the tree gives fewer than two
 * parts, so the caller falls back to the DOM split.
 */
export function splitFromComponents(components: readonly FrameworkComponent[]): SplitPart[] {
  if (components.length === 0) return [];
  const children = new Map<string | null, FrameworkComponent[]>();
  for (const c of components) {
    const list = children.get(c.parentId) ?? [];
    list.push(c);
    children.set(c.parentId, list);
  }
  const subtreeNodes = (c: FrameworkComponent): string[] => [
    ...c.domNodes,
    ...(children.get(c.id) ?? []).flatMap(subtreeNodes),
  ];
  // Children seen through transparent wrappers.
  const visibleChildren = (id: string): FrameworkComponent[] =>
    (children.get(id) ?? []).flatMap((c) => (isTransparent(c.name) && (children.get(c.id)?.length ?? 0) > 0 ? visibleChildren(c.id) : [c]));

  // The owner: walk down from the top while there is exactly one visible child and no DOM of its own.
  let owner = (children.get(null) ?? [])[0];
  while (owner) {
    const kids = visibleChildren(owner.id);
    if (kids.length === 1 && owner.domNodes.length === 0) owner = kids[0];
    else break;
  }
  if (!owner) return [];

  // Grouped by the component's own name, so a list of Card is one part.
  const groups = new Map<string, SplitPart>();
  for (const child of visibleChildren(owner.id)) {
    const nodes = subtreeNodes(child);
    if (nodes.length === 0) continue;
    const group = groups.get(child.name);
    if (group) {
      group.domNodes.push(...nodes);
      continue;
    }
    // A minified name ("t", "Xe") means nothing to the rebuild.
    const name = child.minified ? "Part" : pascal(child.name.replace(/^motion\./, "Motion "));
    groups.set(child.name, { name, domNodes: nodes });
  }
  const parts = uniqueNames([...groups.values()]);
  return parts.length >= 2 ? parts : [];
}

/** What the DOM split needs to know about each element child of the selection. */
export interface DomChild {
  selector: string;
  tag: string;
  classes: string[];
  /** Bounding box in page pixels. */
  box: { x: number; y: number; width: number; height: number };
  /** Element children of this child, for looking through single wrappers. */
  children?: DomChild[];
}

const TAG_NAMES: Record<string, string> = {
  header: "Header",
  nav: "Nav",
  footer: "Footer",
  main: "Main",
  aside: "Aside",
  section: "Section",
  article: "Article",
  form: "Form",
  ul: "List",
  ol: "List",
  li: "ListItem",
  button: "Button",
  a: "Link",
  img: "Image",
  picture: "Image",
  video: "Video",
  svg: "Icon",
  input: "Input",
  label: "Label",
  p: "Text",
  span: "Text",
  h1: "Heading",
  h2: "Heading",
  h3: "Heading",
  h4: "Heading",
  h5: "Heading",
  h6: "Heading",
  figure: "Figure",
  table: "Table",
  canvas: "Canvas",
};

const READABLE_CLASS = /^[a-z][a-z0-9_-]{1,30}$/i;
const UNSTABLE_CLASS = /\d{3,}|^(css|sc|jsx|svelte|emotion)-|__[a-z0-9]{5,}$/i;

function partName(child: DomChild): string {
  const cls = child.classes.find((c) => READABLE_CLASS.test(c) && !UNSTABLE_CLASS.test(c));
  if (cls) return pascal(cls.split("__").pop() ?? cls);
  return TAG_NAMES[child.tag] ?? pascal(child.tag);
}

function signature(child: DomChild): string {
  const classes = child.classes.filter((c) => !UNSTABLE_CLASS.test(c)).sort();
  return `${child.tag}.${classes.join(".")}`;
}

/** Splits children into rows: consecutive children whose tops are within `tolerance` px of each other. */
function rows(children: readonly DomChild[], tolerance = 4): DomChild[][] {
  const out: DomChild[][] = [];
  for (const child of children) {
    const row = out[out.length - 1];
    const first = row?.[0];
    if (row && first && Math.abs(first.box.y - child.box.y) <= tolerance) row.push(child);
    else out.push([child]);
  }
  return out;
}

/**
 * Splits by DOM structure and visual grouping: looks through single wrappers,
 * names each child by its class or tag, merges children that share a tag and
 * classes into one repeated part, and groups many unrelated children into rows.
 */
export function splitFromDom(children: readonly DomChild[]): SplitPart[] {
  let level = children.filter((c) => c.box.width > 0 && c.box.height > 0);
  // A lone wrapper div says nothing about structure; look inside it.
  for (let depth = 0; depth < 4 && level.length === 1 && level[0]?.children?.length; depth++) {
    level = (level[0].children ?? []).filter((c) => c.box.width > 0 && c.box.height > 0);
  }
  if (level.length < 2) return [];

  const bySignature = new Map<string, DomChild[]>();
  for (const child of level) {
    const list = bySignature.get(signature(child)) ?? [];
    list.push(child);
    bySignature.set(signature(child), list);
  }
  const repeated = [...bySignature.values()].some((list) => list.length > 1);

  // Many children with nothing repeated: a grid of unrelated pieces reads best as rows.
  if (!repeated && level.length > 6) {
    const grouped = rows(level);
    if (grouped.length > 1 && grouped.length < level.length) {
      return grouped.map((row, i) => ({
        name: row.length === 1 ? partName(row[0] as DomChild) : `Row${i + 1}`,
        domNodes: row.map((c) => c.selector),
      }));
    }
  }

  const parts: SplitPart[] = [];
  const done = new Set<string>();
  for (const child of level) {
    const sig = signature(child);
    if (done.has(sig)) continue;
    done.add(sig);
    const group = bySignature.get(sig) ?? [child];
    const base = partName(child);
    parts.push({ name: group.length > 1 && !/Item$/.test(base) ? `${base}Item` : base, domNodes: group.map((c) => c.selector) });
  }
  return uniqueNames(parts);
}
