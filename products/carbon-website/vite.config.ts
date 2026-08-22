// A plain DOM-targeting web app — nothing to do with the carbon runtime's own
// rendering pipeline (that's solutions/integrations/bundler/vite, which
// compiles carbon apps for carbon-mini/carbon-blitz). This is an ordinary
// marketing site a browser renders directly, so it uses Vite the ordinary
// way: @vitejs/plugin-react, no carbon-specific transforms.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
