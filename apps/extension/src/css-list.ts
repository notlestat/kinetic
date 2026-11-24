// Small parsers for computed CSS values. Pure, so they are unit tested in Node.

/** Splits a comma-separated CSS list, leaving commas inside parentheses alone: "a, cubic-bezier(0, 0, 1, 1)". */
export function splitCssList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last !== "" || parts.length > 0) parts.push(last);
  return parts;
}

/** "1.2s" → 1200, "150ms" → 150. Unknown units give 0. */
export function parseCssTime(value: string): number {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(value.trim());
  if (!m?.[1]) return 0;
  const n = Number(m[1]);
  return m[2] === "s" ? Math.round(n * 1000 * 1000) / 1000 : n;
}

/** CSS lists repeat to cover every item, so the i-th value of a shorter list wraps around. */
export function listItem(list: readonly string[], index: number, fallback: string): string {
  if (list.length === 0) return fallback;
  return list[index % list.length] ?? fallback;
}

/** "0%, 100%" → [0, 1]; "from" → [0]; "to" → [1]. */
export function parseKeyText(keyText: string): number[] {
  return keyText.split(",").flatMap((part) => {
    const key = part.trim().toLowerCase();
    if (key === "from") return [0];
    if (key === "to") return [1];
    const n = Number.parseFloat(key);
    return Number.isNaN(n) ? [] : [n / 100];
  });
}

/** "backgroundColor" → "background-color". getKeyframes() uses camelCase IDL names. */
export function camelToKebab(name: string): string {
  if (name === "cssFloat") return "float";
  if (name === "cssOffset") return "offset";
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
