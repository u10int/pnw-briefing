import path from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import fs from "node:fs"
import { defineConfig, type Plugin } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

/** "Snoqualmie Pass" → "snoqualmie-pass" (as src/lib/locpage.ts). */
const slugify = (name: string) => name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")

/**
 * A page per forecast location, location/<slug>/index.html, written after the build from the
 * locations in public/data/briefing.json (the workflow puts the data there before building). Each
 * is the built location.html with a <base> two levels up, so its assets, data and links resolve
 * from the site root (or from a dated archive copy), and its own title and description for link
 * previews. location/index.html lists them all.
 */
function locationPages(): Plugin {
  return {
    name: "location-pages",
    apply: "build",
    closeBundle() {
      const dist = path.resolve(__dirname, "dist"), src = path.resolve(__dirname, "public/data/briefing.json")
      const tpl = path.join(dist, "location.html")
      if (!fs.existsSync(tpl) || !fs.existsSync(src)) { console.log("location pages: no data/briefing.json; skipped"); return }
      const html = fs.readFileSync(tpl, "utf8")
      const data = JSON.parse(fs.readFileSync(src, "utf8")) as { meta: { title: string }; points: { name: string; area?: string | null }[] }
      const page = (title: string, desc: string) => html
        .replace("<head>", '<head>\n    <base href="../../" />')
        .replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>\n    <meta name="description" content="${esc(desc)}" />\n    <meta property="og:title" content="${esc(title)}" />\n    <meta property="og:description" content="${esc(desc)}" />`)
      for (const p of data.points) {
        const dir = path.join(dist, "location", slugify(p.name))
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, "index.html"), page(`${p.name} — ${data.meta.title}`,
          `The two-week forecast for ${p.name}${p.area ? ` (${p.area})` : ""}: rain, snow, temperatures, wind and hazards from every model.`))
      }
      // the list: one level down, so its base is one level up
      fs.writeFileSync(path.join(dist, "location", "index.html"), page(`Locations — ${data.meta.title}`, "Every forecast location in the briefing.").replace('<base href="../../" />', '<base href="../" />'))
      console.log(`location pages: ${data.points.length} written`)
    },
  }
}

// base "./" so the same build works at the site root and inside archive/<date>/
// `vite build --mode single` makes one self-contained HTML file (used for previews / email);
// the normal build keeps assets separate for the site.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), tailwindcss(), ...(mode === "single" ? [viteSingleFile()] : [locationPages()])],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  worker: { format: "es" },
  // the site has three pages: the briefing, the map on its own (map.html) and the location pages
  // (location.html, copied per location by locationPages); the single-file copy is
  // the briefing alone
  build: { chunkSizeWarningLimit: 1200, ...(mode === "single" ? { outDir: "dist-single", copyPublicDir: false }
    : { rollupOptions: { input: { main: path.resolve(__dirname, "index.html"), map: path.resolve(__dirname, "map.html"), location: path.resolve(__dirname, "location.html") } } }) },
}))
