
import type { FieldEntry } from "@/types"

import { contourLines, pressureCenters, smooth } from "./contours"
import { decodeTiff } from "./fields-pool"
import type { Grid } from "./grid"

export type { Grid }
export { contourLines, pressureCenters, smooth }

export interface FieldFile extends Grid {
  entry: FieldEntry
  band(i: number): Promise<Float32Array>
}

const files = new Map<string, Promise<FieldFile>>()

export const fieldUrl = (e: FieldEntry) => (e.path.startsWith("data:") ? e.path : `data/${e.path}`)

/** Open a multi-band field COG once; bands are decoded on demand and cached, in physical units. */
export function loadField(e: FieldEntry): Promise<FieldFile> {
  const url = fieldUrl(e)
  if (e.path.startsWith("mrms:")) {
    // observed radar, decoded from NOAA's files in the browser; keyed by its frames too, since the
    // list grows while the page is open
    const k = `${e.path}|${e.keys?.join() ?? ""}`
    if (!files.has(k)) files.set(k, import("./mrms").then((m) => m.mrmsField(e)))
    return files.get(k)!
  }
  if (!files.has(url)) {
    files.set(url, (async () => {
      // The files are pixel-interleaved, so every band shares the same compressed tiles: reading one
      // band decodes all of them. Decode the whole file once, in a worker, then hand out bands
      // from that, scaled to physical units as they're asked for.
      const { width, height, west, south, east, north, bands: raw } = await decodeTiff(url)
      const bands = new Map<number, Float32Array>()
      return {
        entry: e, width, height, west, south, east, north,
        band(i: number) {
          if (!bands.has(i)) {
            const r = raw[i]
            if (!r) return Promise.reject(new Error(`${url} has no band ${i}`))
            const out = new Float32Array(r.length)
            for (let k = 0; k < r.length; k++) out[k] = r[k] === e.nodata ? NaN : r[k] * e.scale
            bands.set(i, out)
          }
          return Promise.resolve(bands.get(i)!)
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

// ---- terrain elevation on a field's grid (for masking where sea-level pressure is extrapolated)

const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
export interface Elevation { mean: Float32Array; max: Float32Array }
const elevCache = new Map<string, Promise<Elevation>>()

/** Terrain height (m) over each cell of `g` from AWS Terrain Tiles at zoom 7 (~1 km): the mean of a
 *  3×3 sample per cell (roughly a model's smoothed terrain) and the highest of those samples. */
export function elevationFor(g: Grid): Promise<Elevation> {
  const key = `${g.width}x${g.height}|${g.west}|${g.south}|${g.east}|${g.north}`
  if (!elevCache.has(key)) {
    const p = loadElevation(g)
    p.catch(() => elevCache.delete(key))
    elevCache.set(key, p)
  }
  return elevCache.get(key)!
}

async function loadElevation(g: Grid): Promise<Elevation> {
  const z = 7, n = 2 ** z, size = 256
  const X = (lon: number) => ((lon + 180) / 360) * n * size
  const Y = (lat: number) => {
    const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * size
  }
  const tx0 = Math.floor(X(g.west) / size), tx1 = Math.floor(X(g.east) / size)
  const ty0 = Math.floor(Y(g.north) / size), ty1 = Math.floor(Y(g.south) / size)
  const tiles = new Map<string, Float32Array>()
  await Promise.all(Array.from({ length: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) }, async (_, k) => {
    const tx = tx0 + (k % (tx1 - tx0 + 1)), ty = ty0 + Math.floor(k / (tx1 - tx0 + 1))
    const r = await fetch(`${TERRARIUM}/${z}/${tx}/${ty}.png`)
    if (!r.ok) throw new Error(`terrain tile ${r.status}`)
    const img = await createImageBitmap(await r.blob())
    const c = new OffscreenCanvas(size, size)
    const ctx = c.getContext("2d", { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, size, size).data
    const e = new Float32Array(size * size)
    for (let i = 0; i < e.length; i++) e[i] = d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768
    tiles.set(`${tx}/${ty}`, e)
  }))
  const at = (lon: number, lat: number) => {
    const px = X(lon), py = Y(lat)
    const t = tiles.get(`${Math.floor(px / size)}/${Math.floor(py / size)}`)
    if (!t) return NaN
    return Math.max(0, t[Math.min(size - 1, Math.floor(py % size)) * size + Math.min(size - 1, Math.floor(px % size))])
  }
  const mean = new Float32Array(g.width * g.height), max = new Float32Array(g.width * g.height)
  const dLon = (g.east - g.west) / g.width, dLat = (g.north - g.south) / g.height
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      let s = 0, m = 0, hi = -Infinity
      for (const fy of [0.17, 0.5, 0.83]) for (const fx of [0.17, 0.5, 0.83]) {
        const v = at(g.west + (x + fx) * dLon, g.north - (y + fy) * dLat)
        if (Number.isFinite(v)) { s += v; m++; hi = Math.max(hi, v) }
      }
      mean[y * g.width + x] = m ? s / m : NaN
      max[y * g.width + x] = m ? hi : NaN
    }
  }
  return { mean, max }
}
