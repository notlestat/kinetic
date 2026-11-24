// Component props and names as they go into framework.json. Pure, so it is unit
// tested without a page. Props come from live React fibers and Vue instances, so
// they can hold anything: functions, elements, huge objects, auth tokens.

/** Words in a prop name that mark it as a credential. Matched per word, so "author" is kept and "authToken" is dropped. */
const SECRET_WORDS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "pwd",
  "apikey",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "jwt",
  "bearer",
  "signature",
  "otp",
]);
/** Word pairs that only mark a credential together: apiKey, privateKey, accessKey, clientSecret. */
const SECRET_PAIRS: readonly [string, string][] = [
  ["api", "key"],
  ["private", "key"],
  ["access", "key"],
  ["secret", "key"],
  ["client", "secret"],
];

/** Splits a prop name into lower-case words: "x-api-key" and "xApiKey" both give ["x", "api", "key"]. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** True when a prop name looks like it holds a credential. */
export function isSecretKey(name: string): boolean {
  const parts = words(name);
  if (parts.some((w) => SECRET_WORDS.has(w))) return true;
  return SECRET_PAIRS.some(([a, b]) => parts.some((w, i) => w === a && parts[i + 1] === b));
}

/** True when a string value looks like a credential: a JWT, a long hex or base64 run, or a known key prefix. */
export function looksSecret(value: string): boolean {
  const v = value.trim();
  if (/^eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/.test(v)) return true; // JWT
  if (/^(bearer|basic)\s+\S{12,}$/i.test(v)) return true;
  if (/^(sk|pk|rk)[-_](live|test)[-_]\w{8,}$|^sk-[\w-]{20,}$|^gh[pousr]_\w{20,}$|^xox[abpr]-[\w-]{10,}$|^AKIA[0-9A-Z]{16}$/.test(v)) return true;
  if (/^[0-9a-f]{32,}$/i.test(v)) return true;
  // A long run of base64 characters with both letters and digits, and no spaces or path separators.
  return v.length >= 40 && /^[A-Za-z0-9+_=-]+$/.test(v) && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

export interface SanitizeOptions {
  /** How deep objects are copied. Deeper values become "[object]". */
  maxDepth?: number;
  maxKeys?: number;
  maxItems?: number;
  maxString?: number;
  /** Describes values only the caller can recognise, such as DOM elements. Return undefined to fall through. */
  describe?: (value: object) => string | undefined;
  /** Drop keys that look like credentials. On for component props. */
  dropSecrets?: boolean;
}

const REACT_ELEMENT_TYPES = new Set(["react.element", "react.transitional.element", "react.portal"]);

function isReactElement(value: object): boolean {
  const tag = (value as { $$typeof?: unknown }).$$typeof;
  return typeof tag === "symbol" && REACT_ELEMENT_TYPES.has(tag.description ?? "");
}

/**
 * Copies a value into plain JSON. Functions become "[function]", React elements
 * "[element]", credential-looking keys and values are dropped, and big objects are
 * cut off with a "…" key that says how much was left out.
 */
export function sanitizeValue(value: unknown, options: SanitizeOptions = {}, depth = 0): unknown {
  const { maxDepth = 3, maxKeys = 20, maxItems = 10, maxString = 200, describe, dropSecrets = false } = options;
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    if (dropSecrets && looksSecret(value)) return "[redacted]";
    return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  }
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  const described = describe?.(value);
  if (described !== undefined) return described;
  if (isReactElement(value)) return "[element]";
  if (depth >= maxDepth) return Array.isArray(value) ? "[array]" : "[object]";
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => sanitizeValue(v, options, depth + 1));
    if (value.length > maxItems) items.push(`… ${value.length - maxItems} more`);
    return items;
  }
  const out: Record<string, unknown> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return "[object]"; // A proxy or exotic object that refuses enumeration.
  }
  let kept = 0;
  for (const [key, v] of entries) {
    if (dropSecrets && (isSecretKey(key) || (typeof v === "string" && looksSecret(v)))) continue;
    if (kept === maxKeys) {
      out["…"] = `${entries.length - kept} more keys`;
      break;
    }
    out[key] = sanitizeValue(v, options, depth + 1);
    kept++;
  }
  return out;
}

/** Component props for framework.json: children are left out, credentials dropped, big values cut off. */
export function sanitizeProps(props: unknown, describe?: SanitizeOptions["describe"]): Record<string, unknown> {
  if (!props || typeof props !== "object") return {};
  const out: Record<string, unknown> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(props);
  } catch {
    return {};
  }
  for (const [key, value] of entries.slice(0, 40)) {
    if (key === "children" || isSecretKey(key)) continue;
    if (typeof value === "string" && looksSecret(value)) continue;
    out[key] = sanitizeValue(value, { dropSecrets: true, ...(describe ? { describe } : {}) }, 1);
  }
  return out;
}

/** True when a component name looks like a minifier made it: "t", "Xe", "a1", or no name at all. */
export function isMinifiedName(name: string | undefined): boolean {
  if (!name || name === "Anonymous") return true;
  return name.length <= 2 || /^[_$]?[a-zA-Z][_$]?\d*$/.test(name);
}
