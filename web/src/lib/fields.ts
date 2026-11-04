import { contours } from "d3-contour"
import { fromArrayBuffer, type GeoTIFFImage } from "geotiff"

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

// ------------------------------------------------------------------ smoothing

/** Fractional grid position of a lon/lat, in cell units with cell centres at whole numbers. */
export function gridPos(g: Grid, lon: number, lat: number): [number, number] | null {
  if (lon < g.west || lon >= g.east || lat <= g.south || lat > g.north) return null
  return [((lon - g.west) / (g.east - g.west)) * g.width - 0.5, ((g.north - lat) / (g.north - g.south)) * g.height - 0.5]
}

/** Value of the nearest cell to a fractional position (for categories, which can't be interpolated). */
export function nearestAt(g: Grid, data: Float32Array, fx: number, fy: number): number {
  const c = Math.min(g.width - 1, Math.max(0, Math.round(fx)))
  const r = Math.min(g.height - 1, Math.max(0, Math.round(fy)))
  return data[r * g.width + c]
}

const cr = (t: number): [number, number, number, number] => {
  const t2 = t * t, t3 = t2 * t
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]
}

/**
 * Bicubic (Catmull-Rom) value at a fractional grid position.
 *
 * - Clamped to the range of the four surrounding cells, so it can't overshoot: no negative
 *   rain at the edge of a shower, no reflectivity peak higher than any model cell.
 * - Missing data: if any of the 16 cells it needs is missing, falls back to bilinear over the
 *   surrounding cells that exist, so regional grids keep a clean edge.
 */
export function bicubicAt(g: Grid, data: Float32Array, fx: number, fy: number): number {
  const W = g.width, H = g.height
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const tx = fx - x0, ty = fy - y0
  const at = (c: number, r: number) => data[Math.min(H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, c))]
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1)
  let lo = Infinity, hi = -Infinity, ok = 0
  for (const v of [a, b, c, d]) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); ok++ }
  if (!ok) return NaN
  const wx = cr(tx), wy = cr(ty)
  let sum = 0
  for (let j = 0; j < 4; j++) {
    let row = 0
    for (let i = 0; i < 4; i++) {
      const v = at(x0 - 1 + i, y0 - 1 + j)
      if (!Number.isFinite(v)) { sum = NaN; break }
      row += wx[i] * v
    }
    if (Number.isNaN(sum)) break
    sum += wy[j] * row
  }
  if (Number.isFinite(sum)) return Math.min(hi, Math.max(lo, sum))
  // bilinear over whichever of the four surrounding cells exist
  let s = 0, w = 0
  for (const [v, ww] of [[a, (1 - tx) * (1 - ty)], [b, tx * (1 - ty)], [c, (1 - tx) * ty], [d, tx * ty]] as const) {
    if (Number.isFinite(v)) { s += v * ww; w += ww }
  }
  return w > 0 ? s / w : NaN
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
/** Compass direction the wind blows *from*. */
export const windFrom = (u: number, v: number) => COMPASS[Math.round((((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360) / 22.5) % 16]

/** Pressure centres: cells that are the lowest (L) or highest (H) within about a sixth of the grid
 *  in every direction, away from the edges (an edge extreme is usually a gradient, not a centre),
 *  and stand out from their surroundings by at least `prominence`. */
export function pressureCenters(g: Grid, raw: Float32Array, prominence = 1.5): GeoJSON.FeatureCollection<GeoJSON.Point, { kind: "H" | "L"; value: number }> {
  const data = smooth(g, raw, g.width > 120 ? 4 : 2)
  const r = Math.max(3, Math.round(Math.min(g.width, g.height) / 6))
  const feats: GeoJSON.Feature<GeoJSON.Point, { kind: "H" | "L"; value: number }>[] = []
  for (let y = r; y < g.height - r; y++) {
    for (let x = r; x < g.width - r; x++) {
      const v = data[y * g.width + x]
      if (!Number.isFinite(v)) continue
      let lo = true, hi = true, sum = 0, n = 0
      for (let dy = -r; dy <= r && (lo || hi); dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!dx && !dy) continue
          const w = data[(y + dy) * g.width + x + dx]
          if (!Number.isFinite(w)) { lo = hi = false; break }
          if (w <= v) lo = false
          if (w >= v) hi = false
          sum += w; n++
        }
      }
      if (!(lo || hi) || !n) continue
      if (Math.abs(sum / n - v) < prominence) continue
      const lon = g.west + ((x + 0.5) / g.width) * (g.east - g.west)
      const lat = g.north - ((y + 0.5) / g.height) * (g.north - g.south)
      feats.push({ type: "Feature", properties: { kind: lo ? "L" : "H", value: Math.round(raw[y * g.width + x]) },
                   geometry: { type: "Point", coordinates: [lon, lat] } })
    }
  }
  return { type: "FeatureCollection", features: feats }
}

/** Horizontal pressure gradient magnitude (hPa per 100 km) from a sea-level pressure band, after
 *  smoothing (sea-level reduction over terrain is noisy on fine grids). Central differences;
 *  NaN on the edges. */
export function pressureGradient(g: Grid, raw: Float32Array, passes: number): Float32Array {
  const p = smooth(g, raw, passes)
  const out = new Float32Array(p.length).fill(NaN)
  const dLon = (g.east - g.west) / g.width, dLat = (g.north - g.south) / g.height
  const ky = 2 * dLat * 110.57
  for (let y = 1; y < g.height - 1; y++) {
    const lat = g.north - ((y + 0.5) / g.height) * (g.north - g.south)
    const kx = 2 * dLon * 111.32 * Math.cos((lat * Math.PI) / 180)
    for (let x = 1; x < g.width - 1; x++) {
      const i = y * g.width + x
      const gx = (p[i + 1] - p[i - 1]) / kx, gy = (p[i - g.width] - p[i + g.width]) / ky
      out[i] = 100 * Math.hypot(gx, gy)
    }
  }
  return out
}
