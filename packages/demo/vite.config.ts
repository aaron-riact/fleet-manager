import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 3001 },
  // graferse resolves to a local file: override — never prebundle it,
  // or the dev server keeps serving a stale copy after library rebuilds.
  // debug (its only CJS dep, logging-only) stays prebundled for interop.
  optimizeDeps: { exclude: ["graferse"], include: ["debug"] },
  resolve: {
    alias: {
      // vda-5050-lib requires mqtt at load; the demo only uses the
      // memory transport seam, so stub it out of browser bundles.
      mqtt: fileURLToPath(new URL("./src/mqttStub.ts", import.meta.url)),
    },
  },
});
