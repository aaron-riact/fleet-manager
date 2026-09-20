import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Prompt-free updates: the shell is a live view onto SSE streams,
      // so a fresh worker takes over as soon as it is ready.
      registerType: "autoUpdate",
      manifest: {
        name: "Fleet Manager",
        short_name: "Fleet",
        description: "VDA5050 fleet operations",
        start_url: ".",
        display: "standalone",
        background_color: "#070b12",
        theme_color: "#070b12",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        // Hash routes never reach the server; every navigation serves the shell.
        navigateFallback: "index.html",
        // Live data stays live: API and SSE traffic is never cached.
        // Only the precached shell (JS/CSS/icon) works offline.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: { port: 3000 },
});
