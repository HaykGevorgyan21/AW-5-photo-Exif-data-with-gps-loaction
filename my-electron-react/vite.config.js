// ============================================================================
// FILE: vite.config.ts
// ============================================================================
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // why: avoid pre-bundling @arcgis/core; it breaks dynamic workers/assets
    exclude: ["@arcgis/core"]
  },
  build: {
    sourcemap: false,
    commonjsOptions: { include: [] }
  },
  server: {
    hmr: { overlay: true }
  }
});
