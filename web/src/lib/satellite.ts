/**
 * GOES satellite imagery as a map overlay, from NOAA nowCOAST's WMS (GOES East and West, every
 * 5 minutes, about the last 7 hours). One image covers the briefing's whole domain per frame, so
 * playback swaps a single, already-decoded picture instead of re-requesting tiles.
 */

const WMS = "https://nowcoast.noaa.gov/geoserver/satellite/wms"
export type SatKind = "ir" | "wv" | "vis"
export const SAT_KINDS: Record<SatKind, { layer: string; label: string }> = {
  ir: { layer: "goes_longwave_imagery", label: "Infrared" },
  wv: { layer: "goes_water_vapor_imagery", label: "Water vapor" },
  vis: { layer: "goes_visible_imagery", label: "Visible" },
}
export interface Box { west: number; south: number; east: number; north: number }

/** Available frame times (ISO) for each kind, from the service's capabilities. */
export async function satTimes(): Promise<Record<SatKind, string[]>> {
  const xml = await (await fetch(`${WMS}?service=WMS&version=1.3.0&request=GetCapabilities`, { cache: "no-cache" })).text()
  const out = {} as Record<SatKind, string[]>
  for (const [k, v] of Object.entries(SAT_KINDS) as [SatKind, { layer: string }][]) {
    const i = xml.indexOf(`<Name>${v.layer}</Name>`)
    const m = i < 0 ? null : xml.slice(i, i + 20000).match(/<Dimension name="time"[^>]*>([^<]*)</)
    out[k] = m ? m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => new Date(s).toISOString()) : []
  }
  return out
}

const R = 6378137
const mercX = (lon: number) => (R * lon * Math.PI) / 180
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

/** GetMap URL for the whole box at one time, in web Mercator so it lines up with the map. */
export function satUrl(kind: SatKind, iso: string, box: Box, width = 1024): string {
  const [x0, y0, x1, y1] = [mercX(box.west), mercY(box.south), mercX(box.east), mercY(box.north)]
  const height = Math.round((width * (y1 - y0)) / (x1 - x0))
  const q = new URLSearchParams({
    service: "WMS", version: "1.3.0", request: "GetMap", layers: SAT_KINDS[kind].layer, styles: "", format: "image/png",
    transparent: "true", crs: "EPSG:3857", width: String(width), height: String(height), bbox: [x0, y0, x1, y1].join(","),
    time: iso.replace(/\.\d{3}Z$/, "Z"),
  })
  return `${WMS}?${q}`
}

const ready = new Map<string, Promise<void>>()
/** Download and decode an image ahead of showing it, so swapping it in doesn't flash. */
export function preload(url: string): Promise<void> {
  if (!ready.has(url)) {
    if (ready.size > 80) ready.delete(ready.keys().next().value!)
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.src = url
    const p = img.decode().catch(() => { ready.delete(url); throw new Error(`satellite image failed: ${url}`) })
    ready.set(url, p)
  }
  return ready.get(url)!
}

/** The frame nearest `time` within `tolMin` minutes, or -1. */
export function nearestFrame(times: string[], time: number, tolMin = 20): number {
  let best = -1, d = Infinity
  for (let i = 0; i < times.length; i++) {
    const x = Math.abs(Date.parse(times[i]) - time)
    if (x < d) { d = x; best = i }
  }
  return d <= tolMin * 60e3 ? best : -1
}
