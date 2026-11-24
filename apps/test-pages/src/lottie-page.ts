// lottie-web bundled into the page (so window.lottie is not set), loading a small
// Lottie file written for this repository: a dot that pulses for 2 seconds.

// The light build has no expression support, so it needs no eval.
import lottie from "lottie-web/build/player/lottie_light";

const container = document.querySelector(".pulse");
if (container) {
  lottie.loadAnimation({ container, renderer: "svg", loop: true, autoplay: true, path: "/lottie/pulse.json" });
}
