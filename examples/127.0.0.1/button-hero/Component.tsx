import type { CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";

// Tokens from styles.json, plus the brand colours the states use.
const tokens = {
  "--color-1": "rgb(255, 255, 255)",
  "--ink": "rgb(10, 37, 64)",
  "--brand": "rgb(99, 91, 255)",
  "--chip": "rgb(246, 249, 252)",
  "--live": "rgb(0, 217, 36)",
  "--focus": "rgb(128, 233, 255)",
  "--space-1": "6px",
  "--space-2": "8px",
  "--space-3": "12px",
  "--space-4": "16px",
  "--space-5": "24px",
  "--space-6": "48px",
  "--radius-1": "16px",
  "--radius-2": "50%",
  "--radius-3": "999px",
} as CSSProperties;

function Text() {
  return <p className="my-[var(--space-4)] leading-6">Primary call to action with hover, focus and active transitions.</p>;
}

// css-transition-1..4: background 150 ms ease-out, shadow 200 ms cubic-bezier(0.2, 0, 0, 1),
// lift 150 ms ease-out, arrow nudge 150 ms ease-out. Plain CSS transitions match these exactly.
function Cta() {
  return (
    <button
      type="button"
      className="group inline-flex cursor-pointer items-center gap-[var(--space-2)] rounded-[var(--radius-3)] border-0 bg-[var(--brand)] px-[var(--space-5)] py-[var(--space-3)] text-base leading-[1.2] font-semibold text-[var(--color-1)] shadow-[0_1px_2px_rgba(10,37,64,0.2)] [transition:background-color_150ms_cubic-bezier(0,0,0.58,1),transform_150ms_cubic-bezier(0,0,0.58,1),box-shadow_200ms_cubic-bezier(0.2,0,0,1)] hover:-translate-y-[2px] hover:bg-[var(--ink)] hover:shadow-[0_8px_24px_rgba(10,37,64,0.25)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[var(--focus)] focus-visible:outline-solid active:translate-y-0 max-[480px]:w-full max-[480px]:justify-center motion-reduce:transition-none"
    >
      Start now
      <span aria-hidden="true" className="inline-block [transition:transform_150ms_cubic-bezier(0,0,0.58,1)] group-hover:translate-x-[3px] motion-reduce:transition-none">
        →
      </span>
    </button>
  );
}

// sampled-2: a 4 px lift over about 300 ms on a power2.out-like curve.
// sampled-1: the live dot pulses opacity on a 1.2 s loop.
function Chip() {
  const reduce = useReducedMotion();
  return (
    <motion.a
      href="#pricing"
      className="inline-flex items-center gap-[var(--space-2)] rounded-[var(--radius-3)] bg-[var(--chip)] px-[var(--space-3)] py-[var(--space-1)] text-sm leading-[1.2] font-medium text-[var(--ink)] no-underline"
      whileHover={reduce ? {} : { y: -4 }}
      transition={{ duration: 0.3, ease: [0.29, 0.784, 0.43, 0.976] }}
    >
      See pricing
      <motion.span
        aria-hidden="true"
        className="block size-[var(--space-2)] rounded-[var(--radius-2)] bg-[var(--live)]"
        animate={reduce ? { opacity: 1 } : { opacity: [1, 0.2, 1] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
      />
    </motion.a>
  );
}

export default function Hero() {
  return (
    <section
      style={tokens}
      className="grid justify-items-start gap-[var(--space-4)] rounded-[var(--radius-1)] bg-[var(--color-1)] p-[var(--space-6)] font-[Inter,system-ui,sans-serif] text-[var(--ink)]"
    >
      <Text />
      <Cta />
      <Chip />
    </section>
  );
}
