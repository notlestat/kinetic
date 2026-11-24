// JavaScript motion for button.html that no CSS or WAAPI entry describes, so only the
// companion's frame sampling can see it: the chip lifts on hover with an ease-out
// (cubic-bezier(0.215, 0.61, 0.355, 1), GSAP's power2.out) over 300 ms, and its dot
// pulses on a 1200 ms loop.

const chip = document.querySelector<HTMLElement>(".chip");
const dot = document.querySelector<HTMLElement>(".chip .dot");

/** cubic-bezier(0.215, 0.61, 0.355, 1) solved for progress at time x. */
function easeOut(x: number): number {
  const [x1, y1, x2, y2] = [0.215, 0.61, 0.355, 1];
  const sample = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (sample(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return sample(y1, y2, (lo + hi) / 2);
}

let lift = 0;
let frame = 0;
function tweenLift(to: number): void {
  if (!chip) return;
  cancelAnimationFrame(frame);
  const from = lift;
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / 300);
    lift = from + (to - from) * easeOut(p);
    chip.style.transform = lift === 0 ? "" : `translateY(${lift}px)`;
    if (p < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}
chip?.addEventListener("mouseenter", () => tweenLift(-4));
chip?.addEventListener("mouseleave", () => tweenLift(0));

function pulse(now: number): void {
  if (dot) dot.style.opacity = (0.6 + 0.4 * Math.cos((2 * Math.PI * now) / 1200)).toFixed(3);
  requestAnimationFrame(pulse);
}
requestAnimationFrame(pulse);

// A module, so its names stay out of the global scope the other page scripts share.
export {};
