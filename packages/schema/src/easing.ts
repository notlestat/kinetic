// Easing helpers shared by the extension, the companion and the library.
// No zod here, so the extension can import it without bundling the schema.

export type Bezier = [number, number, number, number];
/** A CSS easing string or cubic-bezier control points, as stored in MotionEntry.easing. */
export type EasingValue = string | Bezier;

/** The CSS named easings as cubic-bezier control points. */
export const CSS_NAMED_EASINGS: Readonly<Record<string, Bezier>> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

/**
 * Normalises a CSS timing function: named easings and cubic-bezier() become
 * control points, "linear" stays "linear", and anything else (steps(), linear()
 * with stops) is kept as the original string.
 */
export function parseCssEasing(value: string): EasingValue {
  const easing = value.trim();
  const named = CSS_NAMED_EASINGS[easing];
  if (named) return [...named];
  const m = /^cubic-bezier\(\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*\)$/i.exec(easing);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return easing === "" ? "linear" : easing;
}

/** Writes an easing back as CSS, e.g. for a Framer Motion or CSS rebuild. */
export function easingToCss(easing: EasingValue): string {
  return typeof easing === "string" ? easing : `cubic-bezier(${easing.join(", ")})`;
}

// GSAP's power eases are the classic Penner curves: power1 = quad, power2 = cubic,
// power3 = quart, power4 = quint. These are the standard CSS approximations.
const GSAP_CURVES: Readonly<Record<string, Record<"in" | "out" | "inOut", Bezier>>> = {
  power1: { in: [0.55, 0.085, 0.68, 0.53], out: [0.25, 0.46, 0.45, 0.94], inOut: [0.455, 0.03, 0.515, 0.955] },
  power2: { in: [0.55, 0.055, 0.675, 0.19], out: [0.215, 0.61, 0.355, 1], inOut: [0.645, 0.045, 0.355, 1] },
  power3: { in: [0.895, 0.03, 0.685, 0.22], out: [0.165, 0.84, 0.44, 1], inOut: [0.77, 0, 0.175, 1] },
  power4: { in: [0.755, 0.05, 0.855, 0.06], out: [0.23, 1, 0.32, 1], inOut: [0.86, 0, 0.07, 1] },
  sine: { in: [0.47, 0, 0.745, 0.715], out: [0.39, 0.575, 0.565, 1], inOut: [0.445, 0.05, 0.55, 0.95] },
  expo: { in: [0.95, 0.05, 0.795, 0.035], out: [0.19, 1, 0.22, 1], inOut: [1, 0, 0, 1] },
  circ: { in: [0.6, 0.04, 0.98, 0.335], out: [0.075, 0.82, 0.165, 1], inOut: [0.785, 0.135, 0.15, 0.86] },
  back: { in: [0.6, -0.28, 0.735, 0.045], out: [0.175, 0.885, 0.32, 1.275], inOut: [0.68, -0.55, 0.265, 1.55] },
};

const GSAP_ALIASES: Readonly<Record<string, string>> = {
  quad: "power1",
  cubic: "power2",
  quart: "power3",
  quint: "power4",
  strong: "power4",
};

/**
 * Maps a GSAP ease name to cubic-bezier control points where a standard mapping
 * exists. Accepts "power2.out", "power2" (out by default), "Power2.easeOut",
 * "back.out(1.7)" (default overshoot only) and "none"/"linear". Returns
 * undefined for eases with no cubic-bezier equivalent, such as elastic and bounce.
 */
export function gsapEaseToBezier(name: string): Bezier | "linear" | undefined {
  const ease = name.trim();
  if (/^(none|linear(\.easeNone)?|Linear\.easeNone)$/i.test(ease)) return "linear";
  const m = /^([a-z0-9]+)(?:\.(in|out|inOut|easeIn|easeOut|easeInOut))?(?:\(([^)]*)\))?$/i.exec(ease);
  if (!m?.[1]) return undefined;
  const family = m[1].toLowerCase();
  const curves = GSAP_CURVES[GSAP_ALIASES[family] ?? family];
  if (!curves) return undefined;
  // back takes an overshoot argument. Only the default (1.7) matches the stored curve.
  if (m[3] !== undefined && m[3].trim() !== "" && !(family === "back" && Number(m[3]) === 1.7)) return undefined;
  const direction = (m[2] ?? "out").replace(/^ease/, "");
  const key = (direction.charAt(0).toLowerCase() + direction.slice(1)) as "in" | "out" | "inOut";
  const curve = curves[key];
  return curve ? [...curve] : undefined;
}

/** Progress (0 to 1) of a cubic-bezier easing at time x (0 to 1), solved with Newton's method plus bisection. */
export function bezierAt([x1, y1, x2, y2]: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const error = sampleX(t) - x;
    if (Math.abs(error) < 1e-6) return sampleY(t);
    const slope = slopeX(t);
    if (Math.abs(slope) < 1e-6) break;
    t -= error / slope;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 50; i++) {
    const value = sampleX(t);
    if (Math.abs(value - x) < 1e-6) break;
    if (value < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}
