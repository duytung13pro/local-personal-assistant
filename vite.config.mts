import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Renderer only. The Electron main/preload bundles are built by scripts/build-main.mjs.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true, target: "chrome140" },
});
