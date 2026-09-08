import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs so the built index.html works when served from any
  // path (nginx root here), not just the site root.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    // Emit straight into the Flux kustomize base so configMapGenerator can
    // bake the files into the served ConfigMap. Flat, deterministic names
    // (no content hashes) keep the ConfigMap keys stable across rebuilds.
    outDir: path.resolve(import.meta.dirname, "../base/www"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "index.js",
        assetFileNames: "index.css",
      },
    },
  },
})
