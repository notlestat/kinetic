import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Kinetic",
    description: "Copy a component's structure, styles, states and motion as a prompt for Claude Code.",
    // debugger: CDP for forced states and animations. offscreen and clipboardWrite: copy the
    // prompt from a hidden page, since a service worker has no clipboard. scripting with
    // <all_urls>: load Kinetic into a tab that was open before the extension was. The content
    // scripts already match <all_urls>, so Chrome's install warning stays the same.
    permissions: ["debugger", "offscreen", "clipboardWrite", "scripting"],
    host_permissions: ["<all_urls>"],
    action: { default_title: "Kinetic: pick a component (Alt+Shift+K)" },
    commands: {
      "toggle-picker": {
        suggested_key: { default: "Alt+Shift+K" },
        description: "Toggle the component picker",
      },
    },
  },
});
