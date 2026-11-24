import { type CSSProperties, useLayoutEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const tokens = {
  "--color-1": "rgb(10, 37, 64)",
  "--orb": "rgb(128, 233, 255)",
  "--surface": "rgb(255, 255, 255)",
  "--space-1": "24px",
  "--space-2": "48px",
  "--radius-1": "16px",
  "--radius-2": "50%",
} as CSSProperties;

function ScrubBox() {
  return <div data-scrub-box className="size-24 rounded-[var(--radius-1)] bg-[var(--color-1)] will-change-transform" />;
}

function ParallaxOrb() {
  return <div data-parallax-orb className="mt-[var(--space-2)] ml-[240px] size-16 rounded-[var(--radius-2)] bg-[var(--orb)] will-change-transform" />;
}

export default function ScrubSection() {
  const root = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const section = root.current;
    if (!section) return;
    const ctx = gsap.context(() => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        // scrolltrigger-1 (exact): x 0 → 300 and rotation 0 → 90, linear, scrubbed with 1 s of smoothing
        // from the section's top at 80% of the viewport to its bottom at 20%.
        gsap.to("[data-scrub-box]", {
          x: 300,
          rotation: 90,
          ease: "none",
          scrollTrigger: { trigger: section, start: "top 80%", end: "bottom 20%", scrub: 1 },
        });
        // sampled-1 (near): y 0 → -160 while the section crosses the whole viewport, locked to scroll.
        gsap.to("[data-parallax-orb]", {
          y: -160,
          ease: "none",
          scrollTrigger: { trigger: section, start: "top bottom", end: "bottom top", scrub: true },
        });
      });
    }, section);
    return () => ctx.revert();
  }, []);

  return (
    <section
      ref={root}
      style={tokens}
      className="h-[120vh] bg-[var(--surface)] px-[var(--space-1)] py-[var(--space-2)] font-[Inter,system-ui,sans-serif] text-[var(--color-1)]"
    >
      <ScrubBox />
      <ParallaxOrb />
    </section>
  );
}
