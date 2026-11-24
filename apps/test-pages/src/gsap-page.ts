// GSAP motion for gsap.html: a staggered load timeline, a hover tween, an endless marquee,
// a scrubbed ScrollTrigger, a pinned section, and Lenis smooth scrolling synced with ScrollTrigger.
// Plus one scroll-linked element GSAP knows nothing about, for the recorder's scroll sampling.

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);
// The CDN build of GSAP sets window.gsap and window.ScrollTrigger. A bundled build keeps them private
// (only window.gsapVersions shows it is there), so this page exposes them the way a CDN site would.
Object.assign(window, { gsap, ScrollTrigger });

const lenis = new Lenis({ duration: 1.2, wheelMultiplier: 1, smoothWheel: true });
Object.assign(window, { lenis });
lenis.on("scroll", ScrollTrigger.update);
gsap.ticker.add((time) => lenis.raf(time * 1000));
gsap.ticker.lagSmoothing(0);

gsap.timeline().from(".hero-item", { y: 40, opacity: 0, duration: 0.6, ease: "power2.out", stagger: 0.1 });

const card = document.querySelector(".hover-card");
card?.addEventListener("mouseenter", () => gsap.to(card, { scale: 1.04, duration: 0.3, ease: "back.out(1.7)" }));
card?.addEventListener("mouseleave", () => gsap.to(card, { scale: 1, duration: 0.3, ease: "power1.out" }));

gsap.to(".marquee-track", { xPercent: -50, duration: 8, ease: "none", repeat: -1 });

gsap.to(".scrub-box", {
  x: 300,
  rotation: 90,
  ease: "none",
  scrollTrigger: { trigger: ".scrub-section", start: "top 80%", end: "bottom 20%", scrub: 1 },
});

ScrollTrigger.create({ trigger: ".pin-section", start: "top top", end: "+=600", pin: true });
gsap.from(".pin-title", {
  opacity: 0,
  y: 30,
  duration: 0.5,
  ease: "power3.out",
  scrollTrigger: { trigger: ".pin-section", start: "top center", toggleActions: "play none none reverse" },
});

// Parallax by hand: translateY follows how far the section has crossed the viewport.
const orb = document.querySelector<HTMLElement>(".parallax-orb");
const section = document.querySelector<HTMLElement>(".scrub-section");
function updateOrb(): void {
  if (!orb || !section) return;
  const rect = section.getBoundingClientRect();
  const progress = Math.min(1, Math.max(0, (window.innerHeight - rect.top) / (window.innerHeight + rect.height)));
  orb.style.transform = `translateY(${(-160 * progress).toFixed(2)}px)`;
}
window.addEventListener("scroll", updateOrb, { passive: true });
updateOrb();
