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
  // `npm run dev` serves only the SPA; the relative /api calls it makes need a
  // running workplace API (node ../api/server.mjs) or every request falls
  // through to index.html and the SPA reports "not signed in".
  server: {
    proxy: {
      "/api": {
        target: process.env.API_PROXY ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
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
