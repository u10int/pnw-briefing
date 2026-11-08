/**
 * GOES satellite imagery as a map overlay, from NOAA nowCOAST's WMS: the GOES East/West layers
 * (every 5 minutes, about the last 7 hours), which stop near 49.6°N, over nowCOAST's hourly global
 * mosaic of the same channel, which fills southern B.C. One image per layer covers the briefing's
 * whole domain per frame, so playback swaps already-decoded pictures instead of re-requesting tiles.
 */

const WMS = "https://nowcoast.noaa.gov/geoserver/satellite/wms"
export type SatKind = "ir" | "wv" | "vis"
export const SAT_KINDS: Record<SatKind, { layer: string; fill: string; label: string }> = {
  ir: { layer: "goes_longwave_imagery", fill: "global_longwave_imagery_mosaic", label: "Infrared" },
  wv: { layer: "goes_water_vapor_imagery", fill: "global_water_vapor_imagery_mosaic", label: "Water vapor" },
  vis: { layer: "goes_visible_imagery", fill: "global_visible_imagery_mosaic", label: "Visible" },
}
export type SatTimes = Record<string, string[]>          // by WMS layer name
export interface Box { west: number; south: number; east: number; north: number }

/** Available frame times (ISO) for every layer used, from the service's capabilities. */
export async function satTimes(): Promise<SatTimes> {
  const xml = await (await fetch(`${WMS}?service=WMS&version=1.3.0&request=GetCapabilities`, { cache: "no-cache" })).text()
  const out: SatTimes = {}
  for (const name of Object.values(SAT_KINDS).flatMap((v) => [v.layer, v.fill])) {
    const i = xml.indexOf(`<Name>${name}</Name>`)
    const m = i < 0 ? null : xml.slice(i, i + 20000).match(/<Dimension name="time"[^>]*>([^<]*)</)
    out[name] = m ? m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => new Date(s).toISOString()) : []
  }
  return out
}

const R = 6378137
const mercX = (lon: number) => (R * lon * Math.PI) / 180
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

/** GetMap URL for the whole box at one time, in web Mercator so it lines up with the map. */
export function satUrl(layer: string, iso: string, box: Box, width = 1024): string {
  const [x0, y0, x1, y1] = [mercX(box.west), mercY(box.south), mercX(box.east), mercY(box.north)]
  const height = Math.round((width * (y1 - y0)) / (x1 - x0))
  const q = new URLSearchParams({
    service: "WMS", version: "1.3.0", request: "GetMap", layers: layer, styles: "", format: "image/png",
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
