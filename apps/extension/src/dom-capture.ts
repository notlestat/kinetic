// DOM capture: a cleaned copy of the selected element's outerHTML.
//
// Scripts, inline event handlers and tracking attributes are removed. Classes,
// aria and other data attributes stay. Relative URLs become absolute so dom.html
// still points at the right images and assets when opened elsewhere.

const REMOVED_ELEMENTS = "script, noscript";
const TRACKING_ATTRIBUTE =
  /^data-(gtm|ga|gtag|analytics|track|tracking|tracker|segment|amplitude|mixpanel|heap|hj|hotjar|fbq|pixel|clarity|optimizely|kinetic)(-|$)|^(ping|nonce|integrity)$/i;
const URL_ATTRIBUTES = ["src", "href", "poster", "action", "formaction", "data", "background", "data-src", "xlink:href"];
const SRCSET_ATTRIBUTES = ["srcset", "data-srcset", "imagesrcset"];
const JAVASCRIPT_URL = /^\s*javascript:/i;

function absolute(value: string, base: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("#") || /^(data|blob|mailto|tel):/i.test(trimmed)) return value;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return value;
  }
}

function absoluteSrcset(value: string, base: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      return url ? [absolute(url, base), ...descriptor].join(" ") : "";
    })
    .filter(Boolean)
    .join(", ");
}

function absoluteCssUrls(value: string, base: string): string {
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_m, quote: string, url: string) => `url(${quote}${absolute(url, base)}${quote})`);
}

function cleanElement(el: Element, base: string): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on") || TRACKING_ATTRIBUTE.test(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRIBUTES.includes(name)) {
      if (JAVASCRIPT_URL.test(attr.value)) el.removeAttribute(attr.name);
      else el.setAttribute(attr.name, absolute(attr.value, base));
    } else if (SRCSET_ATTRIBUTES.includes(name)) {
      el.setAttribute(attr.name, absoluteSrcset(attr.value, base));
    } else if (name === "style") {
      el.setAttribute(attr.name, absoluteCssUrls(attr.value, base));
    }
  }
}

/** Cleaned outerHTML of `root`. The live page is never modified. */
export function captureDom(root: Element, base = document.baseURI): string {
  const clone = root.cloneNode(true) as Element;
  for (const el of Array.from(clone.querySelectorAll(REMOVED_ELEMENTS))) el.remove();
  cleanElement(clone, base);
  for (const el of Array.from(clone.querySelectorAll("*"))) cleanElement(el, base);
  return clone.outerHTML;
}
