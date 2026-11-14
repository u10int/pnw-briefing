import * as maplibregl from "maplibre-gl"
import type { StyleSpecification } from "maplibre-gl"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"

/** Shared by the interactive map and the wildfire map: the basemap style, its key, a plain
 *  fallback, and the MapLibre worker. */

// CARTO's Positron vector basemap. The weather layers go under its first label layer, so place
// names stay readable on top. Vector styles load without a key today; set the CARTO_KEY repository
// variable to send one (CARTO's raster tiles already require it).
const CARTO_KEY = (import.meta.env.VITE_CARTO_KEY as string | undefined) || ""
export const STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"

export const withKey = (url: string) =>
  CARTO_KEY && url.includes("cartocdn.com") && !/[?&]key=/.test(url)
    ? { url: `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(CARTO_KEY)}` }
    : undefined
// If the basemap can't load (offline, blocked), the data still shows on a plain background.
export const FALLBACK: StyleSpecification = {
  version: 8, sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef0f3" } }],
}

// A standalone (single-file) copy carries the worker inline; turn it into a blob URL. The bundled
// worker is a classic script, and MapLibre runs URLs ending in ".cjs" as classic workers, which is
// what lets it start from a file:// page. The fragment changes nothing about what is fetched.
const inlineWorker = (window as unknown as { __MAPLIBRE_WORKER__?: string }).__MAPLIBRE_WORKER__
maplibregl.setWorkerUrl(inlineWorker
  ? URL.createObjectURL(new Blob([Uint8Array.from(atob(inlineWorker), (c) => c.charCodeAt(0))], { type: "text/javascript" })) + "#worker.cjs"
  : workerUrl)

// CARTO's Dark Matter: the same layers, sources and filters as Positron in other colours, so the
// map can switch between them in place (setStyle would drop the weather layers).
export const DARK_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
const specs = new Map<string, Promise<StyleSpecification>>()
const spec = (url: string) => {
  if (!specs.has(url)) {
    const p = fetch(withKey(url)?.url ?? url).then((r) => r.json() as Promise<StyleSpecification>)
    p.catch(() => specs.delete(url))
    specs.set(url, p)
  }
  return specs.get(url)!
}
type Props = Record<string, unknown>
/** setPaintProperty without its per-property typing (the properties come from style JSON). */
export const setPaint = (m: maplibregl.Map, id: string, k: string, v: unknown) =>
  (m.setPaintProperty as (id: string, k: string, v: unknown) => void).call(m, id, k, v)
const propsOf = (l: unknown, k: "paint" | "layout") => ((l as Record<string, Props | undefined>)[k] ?? {})

/** Recolour the basemap's own layers to the light or dark style (the data layers are untouched). */
export async function setBasemapDark(m: maplibregl.Map, dark: boolean) {
  if (m.getLayer("bg")) {                                    // the plain fallback
    m.setPaintProperty("bg", "background-color", dark ? "#16181c" : "#eef0f3")
    return
  }
  const [to, from] = await Promise.all([spec(dark ? DARK_STYLE_URL : STYLE_URL), spec(dark ? STYLE_URL : DARK_STYLE_URL)])
  const old = new Map(from.layers.map((l) => [l.id, l]))
  for (const l of to.layers) {
    if (!m.getLayer(l.id)) continue
    const p = propsOf(l, "paint")
    for (const k of Object.keys(propsOf(old.get(l.id), "paint"))) if (!(k in p)) setPaint(m, l.id, k, undefined)
    for (const [k, v] of Object.entries(p)) setPaint(m, l.id, k, v)
    for (const [k, v] of Object.entries(propsOf(l, "layout"))) if (k !== "visibility") (m.setLayoutProperty as (id: string, k: string, v: unknown) => void).call(m, l.id, k, v)
  }
  try { if (typeof to.sprite === "string") m.setSprite(to.sprite) } catch { /* older MapLibre: keep the light icons */ }
}

/** Colours the data layers use that need to change on a dark map: dark ink to light, white halos to dark. */
const ON_DARK: Record<string, string> = {
  "#3a3f47": "#c3c8d0", "#1b1f24": "#eceef1", "#1f2328": "#eceef1", "#1d3f9c": "#8fb4ff", "#1d4fa0": "#8fb4ff", "#1d4ed8": "#8fb4ff",
  "#c0262d": "#ff8080", "#555": "#aaa",
  "rgba(255,255,255,0.95)": "rgba(20,22,26,0.9)", "rgba(255,255,255,0.9)": "rgba(20,22,26,0.88)",
}
/** A paint value (a colour or an expression with colours in it) for a dark map. */
export function forDark(v: unknown): unknown {
  if (typeof v === "string") return ON_DARK[v] ?? v
  if (Array.isArray(v)) return v.map(forDark)
  return v
}
