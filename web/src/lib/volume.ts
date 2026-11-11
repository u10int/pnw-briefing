import * as React from "react"

import { FRZ, type Ramp, TEMP, WIND } from "@/lib/ramps"

/** One model's pressure-level volume (data/volume.json). */
export interface VolumeVar {
  path: string; min: number; max: number; scale: "linear" | "sqrt"; units: string; label: string; note?: string
}
export interface VolumeEntry {
  model: string; run: string; times: string[]
  nx: number; ny: number; nz: number; topKm: number; dzKm: number
  lat: [number, number]; lon: [number, number]
  levels: { hPa: number; km: number }[]
  vars: Record<string, VolumeVar>
}
export type VolVar = "cloud" | "rh" | "temp" | "wind" | "water" | "ice" | "frz"
export const VOL_ORDER: VolVar[] = ["cloud", "water", "ice", "rh", "frz", "temp", "wind"]
/** The data file each view draws from: the freezing level is the temperature field's 32°F surface. */
export const SOURCE: Record<VolVar, string> = { cloud: "cloud", rh: "rh", temp: "temp", wind: "wind", water: "water", ice: "ice", frz: "temp" }
export const VIEW_LABEL: Partial<Record<VolVar, string>> = { frz: "Freezing level" }

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
const WATER_STOPS: [number, [number, number, number]][] = [[0, [170, 230, 240]], [0.2, [80, 200, 220]], [0.6, [40, 140, 210]], [2, [30, 80, 170]]]
const ICE_STOPS: [number, [number, number, number]][] = [[0, [245, 245, 255]], [0.2, [225, 215, 255]], [0.6, [190, 170, 250]], [2, [150, 120, 230]]]

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
}
/** The packed fraction (0 – 1) a value sits at, as the shader samples it. */
export function frac(x: number, v: VolumeVar) {
  const f = Math.min(1, Math.max(0, (x - v.min) / (v.max - v.min)))
  return ((v.scale === "sqrt" ? Math.sqrt(f) : f) * 254) / 255
}
export const hexRgb = hex

/** The freezing level's colour at a height: the 2D map's freezing-level scale (1,000 ft bands), so
 *  the surface reads like contours. */
export function frzColor(ft: number): [number, number, number] { return rampRgb(FRZ, ft) }
export function heightLut(topKm: number): Uint8Array {
  const out = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) out.set([...frzColor(((i / 255) * topKm * 1000) / 0.3048), 255], i * 4)
  return out
}

/** Colours across a variable's useful range, for the legend: [value, css colour, how opaque]. */
export function legendStops(name: VolVar, v: VolumeVar): { show: [number, number]; ticks: number[] } {
  const show: Record<VolVar, [number, number]> = { cloud: [0, 100], rh: [0, 100], temp: [-60, 70], wind: [0, 180], water: [0, 1], ice: [0, 1], frz: [0, 12000] }
  const ticks: Record<VolVar, number[]> = { cloud: [0, 25, 50, 75, 100], rh: [0, 20, 40, 60, 80, 100], temp: [-60, -40, -20, 0, 20, 32, 50, 70],
    wind: [0, 40, 80, 120, 160], water: [0, 0.25, 0.5, 0.75, 1], ice: [0, 0.25, 0.5, 0.75, 1], frz: [0, 2000, 4000, 6000, 8000, 10000, 12000] }
  return { show: show[name] ?? [v.min, v.max], ticks: ticks[name] }
}
