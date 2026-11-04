import path from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// base "./" so the same build works at the site root and inside archive/<date>/
// `vite build --mode single` makes one self-contained HTML file (used for previews / email);
// the normal build keeps assets separate for the site.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), tailwindcss(), ...(mode === "single" ? [viteSingleFile()] : [])],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  worker: { format: "es" },
  build: { chunkSizeWarningLimit: 1200, ...(mode === "single" ? { outDir: "dist-single", copyPublicDir: false } : {}) },
}))
