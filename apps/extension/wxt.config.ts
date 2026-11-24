import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Kinetic",
    description: "Capture a component's structure, styles, states and motion.",
    // debugger: CDP for forced states, animations and screenshots. storage, unlimitedStorage and
    // alarms: keep captures while the companion is offline and retry them every minute.
    permissions: ["debugger", "storage", "unlimitedStorage", "alarms"],
    host_permissions: ["http://127.0.0.1:4517/*"],
    action: { default_title: "Kinetic: pick a component (Alt+Shift+K)" },
    commands: {
      "toggle-picker": {
        suggested_key: { default: "Alt+Shift+K" },
        description: "Toggle the component picker",
      },
    },
  },
});
