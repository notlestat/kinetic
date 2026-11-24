import { startMainWorld } from "../src/main-world.ts";

// MAIN world at document_start: runs inside the page's own JavaScript before any site script,
// so hooks such as __REACT_DEVTOOLS_GLOBAL_HOOK__ and __THREE_DEVTOOLS__ exist when the site loads.
// No extension APIs are available here. Talk to content.ts with window.postMessage.
export default defineContentScript({
  matches: ["<all_urls>"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    startMainWorld();
  },
});
