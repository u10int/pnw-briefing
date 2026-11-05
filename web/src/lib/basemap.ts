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
