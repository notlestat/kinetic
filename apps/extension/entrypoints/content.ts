import { startContent } from "../src/content.ts";

// Isolated world: shares the page's DOM but not its JavaScript globals.
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    startContent();
  },
});
