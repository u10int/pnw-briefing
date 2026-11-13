import { contours } from "d3-contour"

import type { Grid } from "./grid"

/* Contouring and pressure centres: pure work on a grid, shared by the page and the fields worker. */

type Line = GeoJSON.Feature<GeoJSON.MultiLineString, { value: number }>

/**
 * Contour lines in lon/lat. Missing cells are filled for the contouring, then any line segment
 * that touches a missing cell or the grid edge is dropped, so no false lines trace the data edge.
 */
export function contourLines(g: Grid, raw: Float32Array, thresholds: number[], smoothPasses = 0, smoothed?: Float32Array): GeoJSON.FeatureCollection<GeoJSON.MultiLineString, { value: number }> {
  const data = smoothed ?? (smoothPasses ? smooth(g, raw, smoothPasses) : raw)
  let sum = 0, n = 0, lo = Infinity, hi = -Infinity
  for (const v of data) if (Number.isFinite(v)) { sum += v; n++; if (v < lo) lo = v; if (v > hi) hi = v }
  if (!n) return { type: "FeatureCollection", features: [] }
  // only the levels the field crosses (each one is a full pass over the grid)
  thresholds = thresholds.filter((t) => t > lo && t <= hi)
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

/** Pressure centres: cells that are the lowest (L) or highest (H) within about a sixth of the grid
 *  in every direction, away from the edges (an edge extreme is usually a gradient, not a centre),
 *  and stand out from their surroundings by at least \`prominence\`. Windowed minimum and maximum
 *  (van Herk–Gil–Werman) and summed-area tables keep this linear in the grid size. */
export function pressureCenters(g: Grid, raw: Float32Array, prominence = 1.5, smoothed?: Float32Array): GeoJSON.FeatureCollection<GeoJSON.Point, { kind: "H" | "L"; value: number }> {
  const data = smoothed ?? smooth(g, raw, g.width > 120 ? 4 : 2)
  const W = g.width, H = g.height
  const r = Math.max(3, Math.round(Math.min(W, H) / 6))
  const feats: GeoJSON.Feature<GeoJSON.Point, { kind: "H" | "L"; value: number }>[] = []
  if (W <= 2 * r || H <= 2 * r) return { type: "FeatureCollection", features: feats }
  // summed-area tables of the values (missing as 0) and of the missing cells
  const S = new Float64Array((W + 1) * (H + 1)), M = new Int32Array((W + 1) * (H + 1))
  for (let y = 0; y < H; y++) {
    let rs = 0, rm = 0
    for (let x = 0; x < W; x++) {
      const v = data[y * W + x]
      if (Number.isFinite(v)) rs += v; else rm++
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + rs
      M[(y + 1) * (W + 1) + x + 1] = M[y * (W + 1) + x + 1] + rm
    }
  }
  const box = (T: Float64Array | Int32Array, x0: number, y0: number, x1: number, y1: number) =>
    T[y1 * (W + 1) + x1] - T[y0 * (W + 1) + x1] - T[y1 * (W + 1) + x0] + T[y0 * (W + 1) + x0]
  const lo = windowed(data, W, H, r, Math.min, Infinity), hi = windowed(data, W, H, r, Math.max, -Infinity)
  for (let y = r; y < H - r; y++) {
    for (let x = r; x < W - r; x++) {
      const i = y * W + x, v = data[i]
      if (!Number.isFinite(v) || (v !== lo[i] && v !== hi[i])) continue
      if (box(M, x - r, y - r, x + r + 1, y + r + 1)) continue
      // strictly lower (or higher) than every other cell in the window
      let ties = 0
      for (let dy = -r; dy <= r && ties < 2; dy++) for (let dx = -r; dx <= r; dx++) if (data[i + dy * W + dx] === v) ties++
      if (ties > 1) continue
      const n = (2 * r + 1) ** 2 - 1
      const mean = (box(S, x - r, y - r, x + r + 1, y + r + 1) - v) / n
      if (Math.abs(mean - v) < prominence) continue
      const lon = g.west + ((x + 0.5) / W) * (g.east - g.west)
      const lat = g.north - ((y + 0.5) / H) * (g.north - g.south)
      feats.push({ type: "Feature", properties: { kind: v === lo[i] ? "L" : "H", value: Math.round(raw[i]) },
                   geometry: { type: "Point", coordinates: [lon, lat] } })
    }
  }
  return { type: "FeatureCollection", features: feats }
}

/** The minimum (or maximum) over the (2r+1)² window around each cell, in two separable passes;
 *  missing cells count as \`empty\` (they are ruled out separately). */
function windowed(data: Float32Array, W: number, H: number, r: number, pick: (a: number, b: number) => number, empty: number) {
  const w = 2 * r + 1
  const run = (get: (k: number) => number, set: (k: number, v: number) => void, n: number) => {
    const f = new Float64Array(n), b = new Float64Array(n)
    for (let k = 0; k < n; k++) { const v = get(k); f[k] = k % w === 0 ? v : pick(f[k - 1], v) }
    for (let k = n - 1; k >= 0; k--) { const v = get(k); b[k] = k % w === w - 1 || k === n - 1 ? v : pick(b[k + 1], v) }
    for (let k = 0; k < n; k++) set(k, pick(b[Math.max(0, k - r)], f[Math.min(n - 1, k + r)]))
  }
  const val = (k: number) => (Number.isFinite(data[k]) ? data[k] : empty)
  const rows = new Float32Array(W * H), out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) run((x) => val(y * W + x), (x, v) => { rows[y * W + x] = v }, W)
  for (let x = 0; x < W; x++) run((y) => rows[y * W + x], (y, v) => { out[y * W + x] = v }, H)
  return out
}
