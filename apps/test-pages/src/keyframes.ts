// WAAPI motion for keyframes.html: an endless spinner started on load, and a card that lifts on hover or focus.

const spinner = document.querySelector<HTMLElement>(".spinner");
spinner?.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
  duration: 1000,
  iterations: Number.POSITIVE_INFINITY,
  easing: "linear",
});

const card = document.querySelector<HTMLElement>(".card");
function lift(up: boolean) {
  card?.animate([{ transform: up ? "translateY(0px)" : "translateY(-6px)" }, { transform: up ? "translateY(-6px)" : "translateY(0px)" }], {
    duration: 250,
    easing: "cubic-bezier(0.3, 0, 0, 1)",
    fill: "forwards",
  });
}
card?.addEventListener("mouseenter", () => lift(true));
card?.addEventListener("mouseleave", () => lift(false));
card?.addEventListener("focus", () => lift(true));
card?.addEventListener("blur", () => lift(false));
