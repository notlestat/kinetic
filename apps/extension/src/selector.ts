// Unique CSS selectors for captured elements.
//
// The content script and the MAIN world both import this module, and both must
// produce the same selector for the same element, so motion entries found in the
// MAIN world line up with the style nodes found in the content script.

const READABLE_CLASS = /^[a-z][a-z0-9_-]{1,30}$/i;
// Classes with long digit runs or hash-like tails (css-1x2y3z, sc-AxjAm) change between builds.
const UNSTABLE_CLASS = /\d{3,}|^(css|sc|jsx|svelte|emotion)-|__[a-z0-9]{5,}$/i;

function readableClass(el: Element): string | undefined {
  for (const name of Array.from(el.classList)) {
    if (READABLE_CLASS.test(name) && !UNSTABLE_CLASS.test(name)) return name;
  }
  return undefined;
}

function isUnique(doc: Document, selector: string): boolean {
  try {
    return doc.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/** One path step: tag, an optional readable class, and :nth-of-type when siblings share the tag. */
function step(el: Element, withClass: boolean): string {
  const tag = CSS.escape(el.localName);
  const cls = withClass ? readableClass(el) : undefined;
  let part = cls ? `${tag}.${CSS.escape(cls)}` : tag;
  const parent = el.parentElement;
  if (parent) {
    const sameTag = Array.from(parent.children).filter((c) => c.localName === el.localName);
    if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
  }
  return part;
}

function idSelector(el: Element): string | undefined {
  const id = el.getAttribute("id");
  if (!id || /\s/.test(id)) return undefined;
  const sel = `#${CSS.escape(id)}`;
  return isUnique(el.ownerDocument, sel) ? sel : undefined;
}

function pathSelector(el: Element, withClass: boolean): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== current.ownerDocument.documentElement) {
    const id = idSelector(current);
    if (id) {
      parts.unshift(id);
      return parts.join(" > ");
    }
    parts.unshift(step(current, withClass));
    current = current.parentElement;
  }
  parts.unshift("html");
  return parts.join(" > ");
}

/** A selector that matches exactly this element in its document. */
export function uniqueSelector(el: Element): string {
  const id = idSelector(el);
  if (id) return id;
  const readable = pathSelector(el, true);
  if (isUnique(el.ownerDocument, readable)) return readable;
  return pathSelector(el, false);
}
