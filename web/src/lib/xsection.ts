import { type Grid } from "@/lib/gl/util"
import { elevationFor } from "@/lib/fields"
import { WIND } from "@/lib/ramps"
import { transfer, unpack, type VolumeEntry, type VolumeVar, type VolVar } from "@/lib/volume"

/** A vertical slice through a model's volume along a straight line on the map. */
export type LonLat = [number, number]
export interface SectionLine { id: string; label: string; a: LonLat; b: LonLat; aName: string; bName: string }

/** Lines that cross the region's terrain and weather the usual ways. */
export const SECTION_PRESETS: SectionLine[] = [
  // straight lines through the places named (to within a few miles)
  { id: "seattle", label: "Coast – Olympics – Seattle – Snoqualmie Pass", a: [-124.9, 48.14], b: [-120.3, 47.19], aName: "Pacific", bName: "Kittitas Valley" },
  { id: "gorge", label: "Coast – Portland – Columbia Gorge", a: [-124.05, 45.45], b: [-121.0, 45.61], aName: "Pacific", bName: "The Dalles" },
  { id: "santiam", label: "Coast – Corvallis – Santiam Pass", a: [-124.3, 44.66], b: [-121.2, 44.35], aName: "Pacific", bName: "Central Oregon" },
  { id: "sound", label: "North – south through Puget Sound", a: [-122.48, 49.0], b: [-122.29, 46.6], aName: "Canada", bName: "Lewis County" },
]

const R_MI = 3958.8
export function miles(a: LonLat, b: LonLat) {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2
  return 2 * R_MI * Math.asin(Math.sqrt(h))
}

/**
 * The volume's values along the line: [height][column] in display units, NaN where missing.
 * Bilinear between grid points, blended between the two time steps either side of the clock.
 */
export function sampleSection(e: VolumeEntry, v: VolumeVar, data: Uint8Array, line: { a: LonLat; b: LonLat }, i0: number, i1: number, t: number, n = 240): Float32Array {
  const { nx, ny, nz } = e
  const per = nx * ny * nz
  const lut = new Float32Array(256)
  for (let k = 0; k < 256; k++) lut[k] = k === 255 ? NaN : unpack(k, v)
  const out = new Float32Array(nz * n)
  const s0 = Math.min(i0, e.times.length - 1) * per, s1 = Math.min(i1, e.times.length - 1) * per
  for (let c = 0; c < n; c++) {
    const f = c / (n - 1)
    const lon = line.a[0] + f * (line.b[0] - line.a[0]), lat = line.a[1] + f * (line.b[1] - line.a[1])
    const fx = ((lon - e.lon[0]) / (e.lon[1] - e.lon[0])) * (nx - 1), fy = ((lat - e.lat[0]) / (e.lat[1] - e.lat[0])) * (ny - 1)
    if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) { for (let z = 0; z < nz; z++) out[z * n + c] = NaN; continue }
    const x0 = Math.min(nx - 2, Math.floor(fx)), y0 = Math.min(ny - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0
    for (let z = 0; z < nz; z++) {
      const base = z * nx * ny + y0 * nx + x0
      const at = (s: number) => {
        const a = lut[data[s + base]], b = lut[data[s + base + 1]], cc = lut[data[s + base + nx]], d = lut[data[s + base + nx + 1]]
        return (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + d * ax) * ay
      }
      const va = at(s0)
      out[z * n + c] = t > 0 && s1 !== s0 ? va * (1 - t) + at(s1) * t : va
    }
  }
  return out
}

/** Terrain height (km) along the line, from the same terrain tiles as the map's hillshade. */
const terrainCache = new Map<string, Promise<Float32Array>>()
export function terrainProfile(e: VolumeEntry, line: { a: LonLat; b: LonLat }, n = 240): Promise<Float32Array> {
  const key = `${line.a}|${line.b}|${n}`
  if (!terrainCache.has(key)) {
    const g: Grid = { west: e.lon[0], east: e.lon[1], south: e.lat[0], north: e.lat[1],
                      width: Math.round((e.lon[1] - e.lon[0]) / 0.025), height: Math.round((e.lat[1] - e.lat[0]) / 0.025) }
    const p = elevationFor(g).then(({ mean }) => {
      const out = new Float32Array(n)
      for (let c = 0; c < n; c++) {
        const f = c / (n - 1)
        const lon = line.a[0] + f * (line.b[0] - line.a[0]), lat = line.a[1] + f * (line.b[1] - line.a[1])
        const x = Math.floor(((lon - g.west) / (g.east - g.west)) * g.width), y = Math.floor(((g.north - lat) / (g.north - g.south)) * g.height)
        const m = x >= 0 && y >= 0 && x < g.width && y < g.height ? mean[y * g.width + x] : NaN
        out[c] = Number.isFinite(m) ? Math.max(0, m) / 1000 : 0
      }
      return out
    })
    p.catch(() => terrainCache.delete(key))
    terrainCache.set(key, p)
  }
  return terrainCache.get(key)!
}

// ------------------------------------------------------------------ colours and contours

const hex = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const rampAt = (levels: number[], colors: string[], x: number) => {
  let i = 0
  while (i < levels.length - 1 && x >= levels[i + 1]) i++
  return hex(colors[i])
}
const SKY: [number, number, number] = [236, 242, 249]
/** A smooth temperature scale for slices (the map's 1° bands would stripe a section): purples and
 *  blues below freezing, near white at 32°F, oranges and reds above; contours carry the detail. */
const TEMP_STOPS: [number, [number, number, number]][] = [
  [-70, [59, 15, 112]], [-40, [88, 76, 196]], [-15, [63, 135, 210]], [10, [138, 196, 232]], [32, [240, 244, 246]],
  [45, [247, 205, 128]], [60, [233, 120, 64]], [80, [178, 24, 43]],
]
const smoothRamp = (stops: [number, [number, number, number]][], x: number): [number, number, number] => {
  if (x <= stops[0][0]) return stops[0][1]
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1]
    if (x <= b) { const t = (x - a) / (b - a); return [0, 1, 2].map((k) => ca[k] + t * (cb[k] - ca[k])) as [number, number, number] }
  }
  return stops[stops.length - 1][1]
}

/** A cell's colour in the slice: temperature and wind on the map's scales; humidity on its own;
 *  cloud, water and ice painted over a pale sky in proportion to the amount. */
export function sliceColor(name: VolVar, x: number): [number, number, number] {
  if (!Number.isFinite(x)) return [228, 228, 228]
  if (name === "temp" || name === "frz") return smoothRamp(TEMP_STOPS, x)
  if (name === "wind") return x < 10 ? SKY : rampAt(WIND.levels, WIND.colors, x) as [number, number, number]
  const [r, g, b, e] = transfer(name, x)
  if (name === "rh") return [r, g, b]
  if (name === "pv") return x < 0 ? SKY : [r, g, b]                   // the scale itself: the tropopause stands out
  if (name === "w") {                                   // diverging: white where the air is still
    const a = Math.min(1, Math.abs(x) / 0.6)
    return [255 + (r - 255) * a, 255 + (g - 255) * a, 255 + (b - 255) * a]
  }
  const a = Math.min(1, e / (name === "cloud" ? 1.0 : 1.2))
  const shade = name === "cloud" ? 0.82 : 1             // clouds a little gray, so white reads on the sky
  return [SKY[0] + (r * shade - SKY[0]) * a, SKY[1] + (g * shade - SKY[1]) * a, SKY[2] + (b * shade - SKY[2]) * a]
}

/** Contour values for each field, and which one to draw heavy. */
export function contourLevels(name: VolVar): { at: number[]; bold?: number; unit: string } {
  switch (name) {
    case "temp": case "frz": return { at: [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70], bold: 32, unit: "°F" }
    case "wind": return { at: [20, 40, 60, 80, 100, 120, 140, 160, 180], unit: " mph" }
    case "rh": return { at: [70, 90], unit: "%" }
    case "cloud": return { at: [50], unit: "%" }
    case "mflux": return { at: [100, 200, 300, 400], unit: "" }
    case "w": return { at: [-0.5, -0.2, 0.2, 0.5], unit: " m/s" }
    case "pv": return { at: [1, 2, 4], bold: 2, unit: " PVU" }
    case "dgz": return { at: [80, 90], unit: "%" }
    default: return { at: [0.05, 0.2, 0.5], unit: " g/kg" }
  }
}

/** Marching squares on a [rows][cols] field: line segments [x0, y0, x1, y1] in cell units. */
export function isolines(v: Float32Array, rows: number, cols: number, level: number): number[] {
  const out: number[] = []
  const lerp = (a: number, b: number) => (level - a) / (b - a)
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = v[r * cols + c], b = v[r * cols + c + 1], d = v[(r + 1) * cols + c], e = v[(r + 1) * cols + c + 1]
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(d) && Number.isFinite(e))) continue
      const idx = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (e >= level ? 2 : 0) | (d >= level ? 1 : 0)
      if (idx === 0 || idx === 15) continue
      // edge points: top (a-b), right (b-e), bottom (d-e), left (a-d)
      const T = [c + lerp(a, b), r], Rt = [c + 1, r + lerp(b, e)], B = [c + lerp(d, e), r + 1], L = [c, r + lerp(a, d)]
      const seg = (p: number[], q: number[]) => out.push(p[0], p[1], q[0], q[1])
      switch (idx) {
        case 1: case 14: seg(L, B); break
        case 2: case 13: seg(B, Rt); break
        case 3: case 12: seg(L, Rt); break
        case 4: case 11: seg(T, Rt); break
        case 6: case 9: seg(T, B); break
        case 7: case 8: seg(L, T); break
        case 5: seg(L, T); seg(B, Rt); break
        case 10: seg(T, Rt); seg(L, B); break
      }
    }
  }
  return out
}

/**
 * Paints the slice's fill into `img` (cols × rows of the section, any size): bilinear in the
 * section, rows bottom (0 km) to top. Used for the 3D curtain's texture and the panel's fill.
 */
export function paintSlice(img: ImageData, sec: Float32Array, rows: number, cols: number, name: VolVar, alpha = 255) {
  const W = img.width, H = img.height
  for (let py = 0; py < H; py++) {
    const fz = ((H - 1 - py) / (H - 1)) * (rows - 1)
    const z0 = Math.min(rows - 2, Math.floor(fz)), az = fz - z0
    for (let px = 0; px < W; px++) {
      const fc = (px / (W - 1)) * (cols - 1)
      const c0 = Math.min(cols - 2, Math.floor(fc)), ac = fc - c0
      const a = sec[z0 * cols + c0], b = sec[z0 * cols + c0 + 1], c = sec[(z0 + 1) * cols + c0], d = sec[(z0 + 1) * cols + c0 + 1]
      const x = (a * (1 - ac) + b * ac) * (1 - az) + (c * (1 - ac) + d * ac) * az
      const [r, g, bl] = sliceColor(name, x)
      const o = (py * W + px) * 4
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bl; img.data[o + 3] = Number.isFinite(x) ? alpha : 0
    }
  }
}
