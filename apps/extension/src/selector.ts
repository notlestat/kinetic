// Unique CSS selectors for captured elements.
//
// The content script and the MAIN world must produce the same selector for the
// same element, so motion entries line up with style nodes. One self-contained
// function (no module-level helpers) also lets other tools inject its source
// text into a page as is.

/** A selector that matches exactly this element in its document. */
export function uniqueSelector(el: Element): string {
  const readableClassPattern = /^[a-z][a-z0-9_-]{1,30}$/i;
  // Classes with long digit runs or hash-like tails (css-1x2y3z, sc-AxjAm) change between builds.
  const unstableClassPattern = /\d{3,}|^(css|sc|jsx|svelte|emotion)-|__[a-z0-9]{5,}$/i;
  const doc = el.ownerDocument;

  const isUnique = (selector: string): boolean => {
    try {
      return doc.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  const idSelector = (node: Element): string | undefined => {
    const id = node.getAttribute("id");
    if (!id || /\s/.test(id)) return undefined;
    const sel = `#${CSS.escape(id)}`;
    return isUnique(sel) ? sel : undefined;
  };

  // One path step: tag, an optional readable class, and :nth-of-type when siblings share the tag.
  const step = (node: Element, withClass: boolean): string => {
    let cls: string | undefined;
    if (withClass) {
      cls = Array.from(node.classList).find((n) => readableClassPattern.test(n) && !unstableClassPattern.test(n));
    }
    const tag = CSS.escape(node.localName);
    let part = cls ? `${tag}.${CSS.escape(cls)}` : tag;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.localName === node.localName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    return part;
  };

  const pathSelector = (withClass: boolean): string => {
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== doc.documentElement) {
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
  };

  const own = idSelector(el);
  if (own) return own;
  const readable = pathSelector(true);
  return isUnique(readable) ? readable : pathSelector(false);
}
