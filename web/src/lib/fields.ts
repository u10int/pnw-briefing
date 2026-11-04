import { contours } from "d3-contour"
import { fromArrayBuffer, type GeoTIFFImage } from "geotiff"

import { colorizer, PTYPE_COLORS, PTYPE_NAMES, REFC, type Ramp } from "@/lib/ramps"
import type { FieldEntry } from "@/types"

export interface Grid {
  width: number; height: number
  west: number; south: number; east: number; north: number
}
export interface FieldFile extends Grid {
  entry: FieldEntry
  band(i: number): Promise<Float32Array>
}

const files = new Map<string, Promise<FieldFile>>()

export const fieldUrl = (e: FieldEntry) => (e.path.startsWith("data:") ? e.path : `data/${e.path}`)

/** Open a multi-band field COG once; bands are decoded on demand and cached, in physical units. */
export function loadField(e: FieldEntry): Promise<FieldFile> {
  const url = fieldUrl(e)
  if (!files.has(url)) {
    files.set(url, (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url} returned ${res.status}`)
      const tiff = await fromArrayBuffer(await res.arrayBuffer())
      const img: GeoTIFFImage = await tiff.getImage()
      const [west, south, east, north] = img.getBoundingBox()
      const bands = new Map<number, Promise<Float32Array>>()
      return {
        entry: e, width: img.getWidth(), height: img.getHeight(), west, south, east, north,
        band(i: number) {
          if (!bands.has(i)) {
            bands.set(i, img.readRasters({ samples: [i] }).then((r) => {
              const raw = (r as unknown as ArrayLike<number>[])[0]
              const out = new Float32Array(raw.length)
              for (let k = 0; k < raw.length; k++) out[k] = raw[k] === e.nodata ? NaN : raw[k] * e.scale
              return out
            }))
          }
          return bands.get(i)!
        },
      }
    })())
  }
  return files.get(url)!
}

/** Index of the time closest to `iso` within `tolHours`, or -1. */
export function nearestTime(times: string[], iso: string, tolHours = 1.5): number {
  const t = Date.parse(iso)
  let best = -1, bestD = Infinity
  times.forEach((x, i) => {
    const d = Math.abs(Date.parse(x) - t)
    if (d < bestD) { best = i; bestD = d }
  })
  return bestD <= tolHours * 3600e3 ? best : -1
}

export function cellIndex(g: Grid, lon: number, lat: number): number {
  if (lon < g.west || lon >= g.east || lat <= g.south || lat > g.north) return -1
  const col = Math.floor(((lon - g.west) / (g.east - g.west)) * g.width)
  const row = Math.floor(((g.north - lat) / (g.north - g.south)) * g.height)
  return row * g.width + col
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const invMercY = (y: number) => (Math.atan(Math.sinh(y)) * 180) / Math.PI

export type Coords = [[number, number], [number, number], [number, number], [number, number]]

/**
 * Colour a grid into a PNG whose rows are evenly spaced in Web Mercator (what a MapLibre image
 * source assumes), so cell edges land where they belong. `color(i)` returns RGBA for grid cell i.
 */
export function renderGrid(g: Grid, color: (i: number) => [number, number, number, number] | null): { url: string; coordinates: Coords } {
  const outH = Math.max(512, g.height * 4)
  const canvas = document.createElement("canvas")
  canvas.width = g.width
  canvas.height = outH
  const ctx = canvas.getContext("2d")!
  const img = ctx.createImageData(g.width, outH)
  const yN = mercY(g.north), yS = mercY(g.south)
  for (let oy = 0; oy < outH; oy++) {
    const lat = invMercY(yN - ((oy + 0.5) / outH) * (yN - yS))
    const row = Math.min(g.height - 1, Math.max(0, Math.floor(((g.north - lat) / (g.north - g.south)) * g.height)))
    for (let x = 0; x < g.width; x++) {
      const c = color(row * g.width + x)
      if (!c) continue
      const k = (oy * g.width + x) * 4
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = c[3]
    }
  }
  ctx.putImageData(img, 0, 0)
  return { url: canvas.toDataURL("image/png"), coordinates: [[g.west, g.north], [g.east, g.north], [g.east, g.south], [g.west, g.south]] }
}

export const rampColor = (ramp: Ramp, data: Float32Array) => {
  const c = colorizer(ramp)
  return (i: number) => c(data[i])
}

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Reflectivity coloured by precipitation type; without a type field everything is drawn as rain. */
export function refcColor(refc: Float32Array, ptype: Float32Array | null) {
  const byType = Object.fromEntries(Object.entries(REFC).map(([k, r]) => [k, colorizer(r)]))
  return (i: number) => {
    const v = refc[i]
    if (!(v >= 5)) return null
    const code = ptype ? ptype[i] : 1
    const name = PTYPE_NAMES[code > 0 && code < PTYPE_NAMES.length ? code : 1]
    return (byType[name] ?? byType.rain)(v)
  }
}

/** Flat precipitation-type colours where precipitation is falling. */
export function ptypeColor(ptype: Float32Array) {
  const rgb = Object.fromEntries(Object.entries(PTYPE_COLORS).map(([k, h]) => [k, hex(h)]))
  return (i: number): [number, number, number, number] | null => {
    const code = ptype[i]
    if (!(code > 0)) return null
    const c = rgb[PTYPE_NAMES[code]]
    return c ? [c[0], c[1], c[2], 205] : null
  }
}

type Line = GeoJSON.Feature<GeoJSON.MultiLineString, { value: number }>

/**
 * Contour lines in lon/lat. Missing cells are filled for the contouring, then any line segment
 * that touches a missing cell or the grid edge is dropped, so no false lines trace the data edge.
 */
export function contourLines(g: Grid, raw: Float32Array, thresholds: number[], smoothPasses = 0): GeoJSON.FeatureCollection<GeoJSON.MultiLineString, { value: number }> {
  const data = smoothPasses ? smooth(g, raw, smoothPasses) : raw
  let sum = 0, n = 0
  for (const v of data) if (Number.isFinite(v)) { sum += v; n++ }
  if (!n) return { type: "FeatureCollection", features: [] }
  const fill = sum / n
  const filled = Array.from(data, (v) => (Number.isFinite(v) ? v : fill))
  // A contour vertex lies between cell centres; it's only trustworthy if every cell around it has data.
  const valid = (x: number, y: number) => {
    if (x <= 0.5 || y <= 0.5 || x >= g.width - 0.5 || y >= g.height - 0.5) return false
    const c0 = Math.floor(x - 0.5), r0 = Math.floor(y - 0.5)
    for (const r of [r0, r0 + 1]) for (const c of [c0, c0 + 1]) {
      if (r < 0 || c < 0 || r >= g.height || c >= g.width || !Number.isFinite(raw[r * g.width + c])) return false
    }
    return true
  }
  const toLonLat = (x: number, y: number): [number, number] =>
    [g.west + (x / g.width) * (g.east - g.west), g.north - (y / g.height) * (g.north - g.south)]
  const features: Line[] = contours().size([g.width, g.height]).thresholds(thresholds)(filled).map((mp) => {
    const lines: [number, number][][] = []
    for (const poly of mp.coordinates) for (const ring of poly) {
      let cur: [number, number][] = []
      for (const [x, y] of ring) {
        if (valid(x, y)) cur.push(toLonLat(x, y))
        else { if (cur.length > 1) lines.push(cur); cur = [] }
      }
      if (cur.length > 1) lines.push(cur)
    }
    return { type: "Feature", properties: { value: mp.value }, geometry: { type: "MultiLineString", coordinates: lines } }
  })
  return { type: "FeatureCollection", features: features.filter((f) => f.geometry.coordinates.length) }
}

/** NaN-aware 3×3 box smoothing, `passes` times. Used before contouring so lines follow the
 *  field rather than the stair-steps that nearest-neighbour regridding leaves behind. */
export function smooth(g: Grid, data: Float32Array, passes: number): Float32Array {
  let a = data
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(a.length)
    for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
      const i = r * g.width + c
      if (!Number.isFinite(a[i])) { b[i] = NaN; continue }
      let s = 0, n = 0
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc
        if (rr < 0 || cc < 0 || rr >= g.height || cc >= g.width) continue
        const v = a[rr * g.width + cc]
        if (Number.isFinite(v)) { s += v; n++ }
      }
      b[i] = s / n
    }
    a = b
  }
  return a
}

/** Sparse wind arrows: points with the direction the wind blows toward and its speed. */
export function windArrows(g: Grid, u: Float32Array, v: Float32Array, across = 44): GeoJSON.FeatureCollection<GeoJSON.Point, { dir: number; speed: number }> {
  const stride = Math.max(1, Math.round(g.width / across))
  const feats: GeoJSON.Feature<GeoJSON.Point, { dir: number; speed: number }>[] = []
  for (let r = Math.floor(stride / 2); r < g.height; r += stride) {
    for (let c = Math.floor(stride / 2); c < g.width; c += stride) {
      const i = r * g.width + c
      const uu = u[i], vv = v[i]
      if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue
      const speed = Math.hypot(uu, vv)
      if (speed < 2) continue
      feats.push({
        type: "Feature",
        properties: { dir: (Math.atan2(uu, vv) * 180) / Math.PI, speed },
        geometry: { type: "Point", coordinates: [g.west + ((c + 0.5) / g.width) * (g.east - g.west), g.north - ((r + 0.5) / g.height) * (g.north - g.south)] },
      })
    }
  }
  return { type: "FeatureCollection", features: feats }
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
/** Compass direction the wind blows *from*. */
export const windFrom = (u: number, v: number) => COMPASS[Math.round((((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360) / 22.5) % 16]
