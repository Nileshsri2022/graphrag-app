import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served from GitHub Pages; the API is the Cloudflare Worker.
// Override with VITE_API_BASE when running locally (e.g. http://127.0.0.1:8787).
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_BASE ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
