import { defineConfig } from "wxt";

export default defineConfig({
  manifest: ({ mode }) => ({
    name: "Kinetic",
    description: "Capture a component's structure, styles, states and motion.",
    // debugger: CDP for forced states, animations and screenshots. storage, unlimitedStorage and
    // alarms: keep captures while the companion is offline and retry them every minute.
    // activeTab: a quick screenshot of the picked component for the clipboard.
    // clipboardWrite: copy on http pages, where navigator.clipboard is missing.
    permissions: ["debugger", "storage", "unlimitedStorage", "alarms", "activeTab", "clipboardWrite"],
    // Playwright cannot click the toolbar icon to grant activeTab, so the test build asks for
    // <all_urls> instead. captureVisibleTab accepts nothing narrower.
    host_permissions: ["http://127.0.0.1:4517/*", ...(mode === "test" ? ["<all_urls>"] : [])],
    action: { default_title: "Kinetic: pick a component (Alt+Shift+K)" },
    commands: {
      "toggle-picker": {
        suggested_key: { default: "Alt+Shift+K" },
        description: "Toggle the component picker",
      },
    },
  }),
});
