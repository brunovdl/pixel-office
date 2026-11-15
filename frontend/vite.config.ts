import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    // Em desenvolvimento, o backend em Python responde por /ws e /api.
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
      "/api": { target: "http://127.0.0.1:8000" },
    },
  },
});
