import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served from GitHub Pages; the API is the Cloudflare Worker.
// Override with VITE_API_BASE when running locally (e.g. http://127.0.0.1:8787).
const apiBase = process.env.VITE_API_BASE ?? "";

// Inject a CSP <meta> that allows fetch() to the API origin (worker).
// On GitHub Pages, _headers is ignored, so the meta tag is the only CSP mechanism.
function cspMeta(): Plugin {
  let connectSrc = "'self'";
  if (apiBase) {
    try {
      connectSrc += " " + new URL(apiBase).origin;
    } catch {
      // leave it at 'self'
    }
  }
  return {
    name: "csp-meta",
    transformIndexHtml(html) {
      const csp =
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ` +
        `img-src 'self' data:; font-src 'self'; connect-src ${connectSrc}; ` +
        `base-uri 'self'; form-action 'none'`;
      return html.replace(
        /<meta http-equiv="Content-Security-Policy" content="[^"]*"/,
        `<meta http-equiv="Content-Security-Policy" content="${csp}"`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), cspMeta()],
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiBase || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
