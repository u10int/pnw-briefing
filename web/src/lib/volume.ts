import * as React from "react"

import { FRZ, type Ramp, TEMP, WIND } from "@/lib/ramps"

/** One model's pressure-level volume (data/volume.json). */
export interface VolumeVar {
  path: string; min: number; max: number; scale: "linear" | "sqrt"; units: string; label: string; note?: string
  /** a view worked out in the page from other fields (path is then only a cache key) */
  make?: () => Promise<Uint8Array>
  /** hgt only: its pressure levels (the data's level order) and their mean heights (m) */
  hPa?: number[]; meanM?: number[]
}
export interface VolumeEntry {
  model: string; run: string; times: string[]
  nx: number; ny: number; nz: number; topKm: number; dzKm: number
  lat: [number, number]; lon: [number, number]
  levels: { hPa: number; km: number }[]
  vars: Record<string, VolumeVar>
}
export type VolVar = "cloud" | "rh" | "temp" | "wind" | "water" | "ice" | "frz" | "mflux" | "w" | "pv" | "dgz" | "icing"
export const VOL_ORDER: VolVar[] = ["cloud", "water", "ice", "rh", "dgz", "icing", "mflux", "w", "pv", "frz", "temp", "wind"]
/** The data file each view draws from: the freezing level is the temperature field's 32°F surface;
 *  the snow growth zone and icing are worked out in the page (DERIVED). */
export const SOURCE: Record<VolVar, string> = { cloud: "cloud", rh: "rh", temp: "temp", wind: "wind", water: "water", ice: "ice", frz: "temp", mflux: "mflux", w: "w",
  pv: "pv", dgz: "rh", icing: "water" }
export const VIEW_LABEL: Partial<Record<VolVar, string>> = { frz: "Freezing level", pv: "Tropopause (PV)", dgz: "Snow growth zone", icing: "Icing (supercooled water)" }

/** A smooth 0 – 1 weight for x inside [lo, hi], easing over `edge` at each end. */
const inside = (x: number, lo: number, hi: number, edge: number) => Math.min(1, Math.max(0, (x - lo + edge) / (2 * edge)), Math.max(0, (hi + edge - x) / (2 * edge)))
const repack = (x: number, v: Omit<VolumeVar, "path">) => {
  let f = Math.min(1, Math.max(0, (x - v.min) / (v.max - v.min)))
  if (v.scale === "sqrt") f = Math.sqrt(f)
  return Math.round(f * 254)
}
/** Views worked out from two fields, cell by cell: [the fields needed, the result's scale, the rule]. */
const DERIVED: Partial<Record<VolVar, { needs: [string, string]; spec: Omit<VolumeVar, "path">; at: (a: number, temp: number) => number }>> = {
  // humidity in the layer between -12 and -18 °C (10 and 0 °F), where snowflakes grow fastest as
  // dendrites: saturated air there makes the big, fluffy, high-ratio snow
  dgz: { needs: ["rh", "temp"], spec: { min: 0, max: 100, scale: "linear", units: "%", label: "Snow growth zone" },
         at: (rh, t) => rh * inside(t, 0.4, 10.4, 1.2) },
  // liquid water colder than freezing (to -20 °C, -4 °F): it freezes onto aircraft
  icing: { needs: ["water", "temp"], spec: { min: 0, max: 2, scale: "sqrt", units: "g/kg", label: "Supercooled water" },
           at: (w, t) => w * inside(t, -4, 31, 1) },
}

/** A view's data description for a model: its own file, or a view worked out from two others. */
export function viewVar(e: VolumeEntry, n: VolVar): VolumeVar | undefined {
  const d = DERIVED[n]
  if (!d) return e.vars[SOURCE[n]]
  const [va, vt] = d.needs.map((k) => e.vars[k])
  if (!va || !vt) return undefined
  return { ...d.spec, path: `derived/${e.model}/${e.run}/${n}`,
    make: () => Promise.all([loadVolume(va), loadVolume(vt)]).then(([a, t]) => {
      const lutA = new Float32Array(256), lutT = new Float32Array(256)
      for (let b = 0; b < 255; b++) { lutA[b] = unpack(b, va); lutT[b] = unpack(b, vt) }
      const out = new Uint8Array(a.length)
      for (let i = 0; i < a.length; i++) out[i] = a[i] === 255 || t[i] === 255 ? 255 : repack(d.at(lutA[a[i]], lutT[t[i]]), d.spec)
      return out
    }) }
}

/** The manifest, fetched the first time the 3D view is turned on. */
export function useVolumes(on: boolean): VolumeEntry[] | null {
  const [list, setList] = React.useState<VolumeEntry[] | null>(null)
  React.useEffect(() => {
    if (!on || list) return
    let live = true
    fetch("data/volume.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : { volumes: [] }))
      .then((js) => { if (live) setList(js.volumes ?? []) })
      .catch(() => { if (live) setList([]) })
    return () => { live = false }
  }, [on, list])
  return list
}

const cache = new Map<string, Promise<Uint8Array>>()
/** One variable's bytes for every time step (gzip, unpacked in the browser). */
export function loadVolume(v: VolumeVar): Promise<Uint8Array> {
  if (!cache.has(v.path) && v.make) cache.set(v.path, v.make().catch((e) => { cache.delete(v.path); throw e }))
  if (!cache.has(v.path)) {
    cache.set(v.path, fetch(`data/${v.path}`).then(async (r) => {
      if (!r.ok || !r.body) throw new Error(`volume ${r.status}`)
      const body = r.body.pipeThrough(new DecompressionStream("gzip"))
      return new Uint8Array(await new Response(body).arrayBuffer())
    }).catch((e) => { cache.delete(v.path); throw e }))
  }
  return cache.get(v.path)!
}

/** The value a packed byte stands for. */
export function unpack(b: number, v: VolumeVar) {
  let x = b / 254
  if (v.scale === "sqrt") x *= x
  return v.min + x * (v.max - v.min)
}

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.replace("#", ""), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const rampRgb = (r: Ramp, x: number) => {
  let i = 0
  while (i < r.levels.length - 1 && x >= r.levels[i + 1]) i++
  return hex(r.colors[i])
}
const lerp = (stops: [number, [number, number, number]][], x: number): [number, number, number] => {
  if (x <= stops[0][0]) return stops[0][1]
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1]
    if (x <= b) { const t = (x - a) / (b - a); return [0, 1, 2].map((k) => ca[k] + t * (cb[k] - ca[k])) as [number, number, number] }
  }
  return stops[stops.length - 1][1]
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// humidity: dry browns through gray to moist greens and blues (as the usual RH tables)
const RH_STOPS: [number, [number, number, number]][] = [
  [0, [214, 150, 70]], [20, [196, 112, 72]], [40, [205, 205, 205]], [60, [196, 214, 120]], [80, [70, 178, 120]], [100, [118, 186, 245]],
]
// moisture flow: teal through green and yellow to the reds of an atmospheric river's core
const MFLUX_STOPS: [number, [number, number, number]][] = [
  [0, [190, 228, 220]], [50, [120, 200, 172]], [100, [64, 168, 96]], [200, [236, 206, 58]], [300, [240, 138, 40]], [400, [208, 52, 42]], [500, [150, 28, 112]],
]
const UP: [number, [number, number, number]][] = [[0, [255, 214, 170]], [0.3, [244, 132, 64]], [1, [196, 40, 26]]]
const DOWN: [number, [number, number, number]][] = [[0, [196, 220, 248]], [0.3, [82, 140, 220]], [1, [26, 72, 178]]]
const WATER_STOPS: [number, [number, number, number]][] = [[0, [170, 230, 240]], [0.2, [80, 200, 220]], [0.6, [40, 140, 210]], [2, [30, 80, 170]]]
const ICE_STOPS: [number, [number, number, number]][] = [[0, [245, 245, 255]], [0.2, [225, 215, 255]], [0.6, [190, 170, 250]], [2, [150, 120, 230]]]
// potential vorticity: tropospheric air pale, the stratosphere's from the tropopause up in greens and yellows
const PV_STOPS: [number, [number, number, number]][] = [[0, [200, 205, 215]], [1.5, [120, 190, 170]], [2, [150, 205, 60]], [4, [225, 215, 40]], [8, [235, 140, 40]]]
// the snow growth zone: snowflake blues, whiter where it's saturated
const DGZ_STOPS: [number, [number, number, number]][] = [[60, [150, 195, 235]], [85, [110, 170, 240]], [100, [225, 240, 255]]]
// icing: amber to the deep reds of heavy icing
const ICING_STOPS: [number, [number, number, number]][] = [[0, [250, 210, 120]], [0.1, [245, 160, 60]], [0.4, [220, 80, 40]], [1, [170, 30, 60]]]
/** Colours for the surface's height (km, 0 – 12): low purples and blues through teal to the high yellows. */
const HEIGHT_STOPS: [number, [number, number, number]][] = [[0, [72, 40, 130]], [2, [60, 90, 175]], [4, [40, 140, 170]], [6, [60, 175, 120]], [8, [160, 200, 60]], [10, [240, 200, 50]], [12, [250, 150, 60]]]
export const heightRgb = (km: number) => lerp(HEIGHT_STOPS, km)

/**
 * Colour and extinction for each value: what shows and how thick it looks. Clouds, water and ice
 * thicken with the amount; humidity shows moist air (dry air faintly); wind shows the jet; the
 * temperature field is a faint wash with a bright shell at the freezing level.
 */
export function transfer(name: VolVar, x: number): [number, number, number, number] {
  switch (name) {
    case "cloud": { const c = 252 - 30 * smooth(40, 100, x); return [c, c + 1, Math.min(255, c + 4), 1.4 * smooth(8, 100, x) ** 1.4] }
    case "rh": return [...lerp(RH_STOPS, x), 0.025 + 1.2 * smooth(55, 100, x) ** 2] as [number, number, number, number]
    // temperature and wind read as shells (ISOS) over the faintest of washes; the jet's core hazes
    case "temp": return [...rampRgb(TEMP, x), 0.004] as [number, number, number, number]
    case "wind": return [...rampRgb(WIND, x), 0.6 * smooth(120, 190, x) ** 2] as [number, number, number, number]
    case "frz": return [0, 0, 0, 0]
    case "water": return [...lerp(WATER_STOPS, x), 2.5 * smooth(0.003, 0.5, x) ** 0.8] as [number, number, number, number]
    case "ice": return [...lerp(ICE_STOPS, x), 2.0 * smooth(0.003, 0.5, x) ** 0.8] as [number, number, number, number]
    // the plume: invisible in dry or still air, thickening through an atmospheric river's core
    case "mflux": return [...lerp(MFLUX_STOPS, x), 1.6 * smooth(30, 280, x) ** 1.2] as [number, number, number, number]
    // rising air warm, sinking air cool; still air clear
    case "w": return [...lerp(x >= 0 ? UP : DOWN, Math.abs(x)), 1.8 * smooth(0.04, 0.6, Math.abs(x)) ** 1.3] as [number, number, number, number]
    // the volume itself stays clear: the tropopause reads as its 2 PVU surface (ISOS)
    case "pv": return [...lerp(PV_STOPS, x), 0] as [number, number, number, number]
    case "dgz": return [...lerp(DGZ_STOPS, x), 1.5 * smooth(70, 100, x) ** 1.5] as [number, number, number, number]
    case "icing": return [...lerp(ICING_STOPS, x), 2.2 * smooth(0.005, 0.4, x) ** 0.8] as [number, number, number, number]
  }
}

/** 256 RGBA bytes: colour, and extinction scaled into the alpha channel (shader: a / 255 × 4). */
export function lutFor(name: VolVar, v: VolumeVar): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let b = 0; b < 256; b++) {
    const [r, g, bl, e] = b === 255 ? [0, 0, 0, 0] : transfer(name, unpack(b, v))
    out.set([r, g, bl, Math.round(255 * Math.min(1, e / 4))], b * 4)
  }
  return out
}

/** Surfaces drawn where the field crosses a value (lit, crisp at any step size): the value, its
 *  colour and how solid. The freezing level's colour comes from its height instead. */
export const ISOS: Partial<Record<VolVar, { at: number; color: string; alpha: number; label: string }[]>> = {
  temp: [
    { at: 50, color: "#e4772e", alpha: 0.32, label: "50°F" },
    { at: 32, color: "#1f78d1", alpha: 0.7, label: "32°F (freezing)" },
    { at: 0, color: "#6a4bc4", alpha: 0.32, label: "0°F" },
    { at: -40, color: "#b0459f", alpha: 0.3, label: "−40°F" },
  ],
  wind: [
    { at: 50, color: "#6fa8c9", alpha: 0.2, label: "50 mph" },
    { at: 80, color: "#3f8f5a", alpha: 0.3, label: "80 mph" },
    { at: 110, color: "#d39a1d", alpha: 0.42, label: "110 mph" },
    { at: 140, color: "#c8352b", alpha: 0.6, label: "140 mph" },
  ],
  frz: [{ at: 32, color: "#1f78d1", alpha: 0.92, label: "32°F" }],
  pv: [{ at: 2, color: "#9bcf3c", alpha: 0.9, label: "2 PVU (tropopause)" }],
}
/** Views whose surfaces take their colour from their height. */
export const ISO_BY_HEIGHT: Partial<Record<VolVar, "frz" | "km">> = { frz: "frz", pv: "km" }
/** The packed fraction (0 – 1) a value sits at, as the shader samples it. */
export function frac(x: number, v: VolumeVar) {
  const f = Math.min(1, Math.max(0, (x - v.min) / (v.max - v.min)))
  return ((v.scale === "sqrt" ? Math.sqrt(f) : f) * 254) / 255
}
export const hexRgb = hex

/** The freezing level's colour at a height: the 2D map's freezing-level scale (1,000 ft bands), so
 *  the surface reads like contours. */
export function frzColor(ft: number): [number, number, number] { return rampRgb(FRZ, ft) }
export function heightLut(topKm: number, scale: "frz" | "km" = "frz"): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const km = (i / 255) * topKm
    out.set([...(scale === "frz" ? frzColor((km * 1000) / 0.3048) : heightRgb(km)).map(Math.round), 255], i * 4)
  }
  return out
}
// smooth scales for colouring a volume or surface by temperature or wind (the map's banded ones
// would stripe it): cold purples and blues through white at freezing to warm oranges; calm blues
// through yellows and oranges to the jet's reds and magentas
const TEMP_SMOOTH: [number, [number, number, number]][] = [[-70, [59, 15, 112]], [-40, [88, 76, 196]], [-15, [63, 135, 210]], [10, [138, 196, 232]],
  [32, [240, 244, 246]], [45, [247, 205, 128]], [60, [233, 120, 64]], [80, [178, 24, 43]]]
const WIND_SMOOTH: [number, [number, number, number]][] = [[0, [170, 205, 230]], [30, [120, 190, 210]], [60, [245, 220, 110]], [90, [240, 150, 60]],
  [120, [215, 60, 80]], [150, [185, 40, 170]], [200, [110, 30, 140]]]
/** 256 RGB(A) entries of a view's own colours, for colouring another field's volume by it. */
export function colorLut(name: VolVar, v: VolumeVar): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let b = 0; b < 255; b++) {
    const x = unpack(b, v)
    const rgb = name === "temp" || name === "frz" ? lerp(TEMP_SMOOTH, x) : name === "wind" ? lerp(WIND_SMOOTH, x) : transfer(name, x).slice(0, 3)
    out.set([...rgb.map(Math.round), 255], b * 4)
  }
  return out
}

/** Colours across a variable's useful range, for the legend: [value, css colour, how opaque]. */
export function legendStops(name: VolVar, v: VolumeVar): { show: [number, number]; ticks: number[] } {
  const show: Record<VolVar, [number, number]> = { cloud: [0, 100], rh: [0, 100], temp: [-60, 70], wind: [0, 180], water: [0, 1], ice: [0, 1], frz: [0, 12000],
    mflux: [0, 500], w: [-1, 1], pv: [0, 8], dgz: [50, 100], icing: [0, 1] }
  const ticks: Record<VolVar, number[]> = { cloud: [0, 25, 50, 75, 100], rh: [0, 20, 40, 60, 80, 100], temp: [-60, -40, -20, 0, 20, 32, 50, 70],
    wind: [0, 40, 80, 120, 160], water: [0, 0.25, 0.5, 0.75, 1], ice: [0, 0.25, 0.5, 0.75, 1], frz: [0, 2000, 4000, 6000, 8000, 10000, 12000],
    mflux: [0, 100, 200, 300, 400, 500], w: [-1, -0.5, 0, 0.5, 1], pv: [0, 1, 2, 4, 6, 8], dgz: [50, 60, 70, 80, 90, 100], icing: [0, 0.25, 0.5, 0.75, 1] }
  return { show: show[name] ?? [v.min, v.max], ticks: ticks[name] }
}

/** The moisture-flow colour for a value, a little deeper, for particles over a light map. */
export function mfluxRgb(x: number): [number, number, number] {
  return lerp(MFLUX_STOPS, x).map((c) => (c / 255) * 0.85) as [number, number, number]
}
