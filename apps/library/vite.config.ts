import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The companion allows CORS from exactly these origins (127.0.0.1:5173 and
// localhost:5173), so both servers keep port 5173 and fail rather than move.
const local = { host: "127.0.0.1", port: 5173, strictPort: true };

export default defineConfig({
  plugins: [react()],
  server: local,
  preview: local,
});
