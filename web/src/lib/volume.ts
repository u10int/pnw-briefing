import * as React from "react"

import { elevationFor } from "@/lib/fields"
import { FRZ, type Ramp, TEMP, WIND } from "@/lib/ramps"

/** One model's pressure-level volume (data/volume.json). */
export interface VolumeVar {
  path: string; min: number; max: number; scale: "linear" | "sqrt"; units: string; label: string; note?: string
  /** a view worked out in the page from other fields (path is then only a cache key) */
  make?: () => Promise<Uint8Array>
  /** observed radar: the steps arrive one at a time; \`load(step)\` fills that step of the buffer
   *  \`make\` returned (all clear until then) and resolves when it's in */
  lazy?: { load: (step: number) => Promise<void>; ready: (step: number) => boolean }
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
  | "wbz" | "thetae" | "theta" | "oro" | "turb" | "dbz"
export const VOL_ORDER: VolVar[] = ["dbz", "cloud", "water", "ice", "rh", "dgz", "icing", "mflux", "w", "oro", "turb", "pv", "frz", "wbz", "temp", "thetae", "theta", "wind"]
/** The data file each view draws from: the freezing level is the temperature field's 32°F surface;
 *  the snow growth zone and icing are worked out in the page (DERIVED). */
export const SOURCE: Record<VolVar, string> = { cloud: "cloud", rh: "rh", temp: "temp", wind: "wind", water: "water", ice: "ice", frz: "temp", mflux: "mflux", w: "w",
  pv: "pv", dgz: "rh", icing: "water", wbz: "temp", thetae: "temp", theta: "temp", oro: "u", turb: "u", dbz: "dbz" }
export const VIEW_LABEL: Partial<Record<VolVar, string>> = { frz: "Freezing level", pv: "Tropopause (PV)", dgz: "Snow growth zone", icing: "Icing (supercooled water)",
  wbz: "Snow level (wet-bulb 32°F)", thetae: "Equivalent potential temperature (θe)", theta: "Isentropic surfaces (θ)", oro: "Orographic lift",
  turb: "Turbulence (Richardson number)", dbz: "Radar reflectivity (observed)" }
/** Views drawn as one surface coloured by its height in feet, like the freezing level. */
export const LEVEL_VIEWS: VolVar[] = ["frz", "wbz"]

/** A smooth 0 – 1 weight for x inside [lo, hi], easing over `edge` at each end. */
const inside = (x: number, lo: number, hi: number, edge: number) => Math.min(1, Math.max(0, (x - lo + edge) / (2 * edge)), Math.max(0, (hi + edge - x) / (2 * edge)))
const repack = (x: number, v: Omit<VolumeVar, "path">) => {
  let f = Math.min(1, Math.max(0, (x - v.min) / (v.max - v.min)))
  if (v.scale === "sqrt") f = Math.sqrt(f)
  return Math.round(f * 254)
}
/** What a derived view's rule gets: the inputs unpacked (NaN where missing), every step, laid out
 *  [t, z, y, x] like the files; the grid; each height's pressure (hPa) and height (m); the cell
 *  spacing (m) east-west for each row and north-south; and the terrain (km, [y, x], rows south to
 *  north) when the view asks for it. It writes `out` (NaN for missing). */
interface DeriveCtx {
  e: VolumeEntry; inputs: Float32Array[]; out: Float32Array
  pHpa: Float32Array; zM: Float32Array; dxM: Float32Array; dyM: number; ground: Float32Array | null
}
interface Derived { needs: string[]; spec: Omit<VolumeVar, "path">; terrain?: boolean; pressure?: boolean; run: (c: DeriveCtx) => void }

const fToC = (f: number) => ((f - 32) * 5) / 9
const cToF = (c: number) => (c * 9) / 5 + 32
/** Saturation vapour pressure over water (hPa), Bolton. */
const esat = (tc: number) => 6.112 * Math.exp((17.67 * tc) / (tc + 243.5))
/** Each height's pressure (hPa): log-pressure interpolated between the model's levels at their mean heights. */
function pressureAt(e: VolumeEntry): Float32Array {
  const lv = [...e.levels].sort((a, b) => a.km - b.km)
  const out = new Float32Array(e.nz)
  for (let k = 0; k < e.nz; k++) {
    const km = (k / (e.nz - 1)) * e.topKm
    let i = 0
    while (i < lv.length - 2 && km > lv[i + 1].km) i++
    const a = lv[i], b = lv[Math.min(i + 1, lv.length - 1)]
    const f = b.km === a.km ? 0 : (km - a.km) / (b.km - a.km)
    out[k] = Math.exp(Math.log(a.hPa) + f * (Math.log(b.hPa) - Math.log(a.hPa)))
  }
  return out
}
/** The pressure (hPa) at a height (km), from the model's levels at their mean heights. */
export function pressureAtKm(e: VolumeEntry, km: number): number {
  const lv = [...e.levels].sort((a, b) => a.km - b.km)
  if (lv.length < 2) return NaN
  let i = 0
  while (i < lv.length - 2 && km > lv[i + 1].km) i++
  const a = lv[i], b = lv[i + 1]
  return Math.exp(Math.log(a.hPa) + ((km - a.km) / (b.km - a.km)) * (Math.log(b.hPa) - Math.log(a.hPa)))
}
/** Every cell's value from one rule of the inputs at the same cell (and its height's pressure). */
const perCell = (rule: (x: number[], pHpa: number) => number) => (c: DeriveCtx) => {
  const { e, inputs, out, pHpa } = c
  const nxy = e.nx * e.ny, per = nxy * e.nz
  const x = new Array<number>(inputs.length)
  for (let i = 0; i < out.length; i++) {
    let bad = false
    for (let k = 0; k < inputs.length; k++) { x[k] = inputs[k][i]; if (Number.isNaN(x[k])) bad = true }
    out[i] = bad ? NaN : rule(x, pHpa[Math.floor((i % per) / nxy)])
  }
}
/** Potential temperature (K) from °F and hPa. */
const thetaK = (tF: number, p: number) => (fToC(tF) + 273.15) * (1000 / p) ** 0.2857

/** Views worked out in the page from fields already published, cell by cell or with their neighbours. */
const DERIVED: Partial<Record<VolVar, Derived>> = {
  // humidity in the layer between -12 and -18 °C (10 and 0 °F), where snowflakes grow fastest as
  // dendrites: saturated air there makes the big, fluffy, high-ratio snow
  dgz: { needs: ["rh", "temp"], spec: { min: 0, max: 100, scale: "linear", units: "%", label: "Snow growth zone" },
         run: perCell(([rh, t]) => rh * inside(t, 0.4, 10.4, 1.2)) },
  // liquid water colder than freezing (to -20 °C, -4 °F): it freezes onto aircraft
  icing: { needs: ["water", "temp"], spec: { min: 0, max: 2, scale: "sqrt", units: "g/kg", label: "Supercooled water" },
           run: perCell(([w, t]) => w * inside(t, -4, 31, 1)) },
  // the wet-bulb temperature (Stull 2011, from temperature and humidity): falling snow cools the air
  // toward it as it melts, so its 32 °F surface is close to where snow turns to rain
  wbz: { needs: ["temp", "rh"], spec: { min: -80, max: 90, scale: "linear", units: "°F", label: "Wet-bulb temperature" },
         run: perCell(([tF, rh0]) => {
           const t = fToC(tF), rh = Math.min(100, Math.max(1, rh0))
           return cToF(t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(t + rh) - Math.atan(rh - 1.676331)
             + 0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) - 4.686035)
         }) },
  // equivalent potential temperature (Bolton 1980): the temperature air would have if all its
  // vapour condensed and it were brought to 1000 hPa; it follows air through rising and sinking,
  // so warm, moist conveyors stand out from dry intrusions, and fronts as sharp changes
  thetae: { needs: ["temp", "rh"], pressure: true, spec: { min: 250, max: 370, scale: "linear", units: "K", label: "Equivalent potential temperature" },
            run: perCell(([tF, rh0], p) => {
              const tc = fToC(tF), tk = tc + 273.15, rh = Math.min(100, Math.max(1, rh0))
              const e = (rh / 100) * esat(tc), r = (622 * e) / Math.max(1, p - e)                    // g/kg
              const tl = 1 / (1 / (tk - 55) - Math.log(rh / 100) / 2840) + 55
              return tk * (1000 / p) ** (0.2854 * (1 - 0.00028 * r)) * Math.exp((3.376 / tl - 0.00254) * r * (1 + 0.00081 * r))
            }) },
  // potential temperature: surfaces of constant θ are the ones air moves along when it isn't rising
  // through cloud; where they slope up, air sliding north along them is lifted
  theta: { needs: ["temp"], pressure: true, spec: { min: 250, max: 400, scale: "linear", units: "K", label: "Potential temperature" },
           run: perCell(([tF], p) => thetaK(tF, p)) },
  // the wind blowing up (or down) the terrain: wind times the slope, fading with height above the
  // ground over about 2 km; positive where air is forced up the windward side
  oro: { needs: ["u", "v"], terrain: true, spec: { min: -2, max: 2, scale: "linear", units: "m/s", label: "Orographic lift" },
         run: ({ e, inputs: [u, v], out, zM, dxM, dyM, ground }) => {
           const { nx, ny, nz } = e, nxy = nx * ny, per = nxy * nz, steps = out.length / per
           const g = ground!
           // the terrain's slope on the model grid (central differences)
           const sx = new Float32Array(nxy), sy = new Float32Array(nxy)
           for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
             const i = y * nx + x, xa = Math.max(0, x - 1), xb = Math.min(nx - 1, x + 1), ya = Math.max(0, y - 1), yb = Math.min(ny - 1, y + 1)
             sx[i] = ((g[y * nx + xb] - g[y * nx + xa]) * 1000) / ((xb - xa) * dxM[y])
             sy[i] = ((g[yb * nx + x] - g[ya * nx + x]) * 1000) / ((yb - ya) * dyM)            // rows run south to north
           }
           for (let t = 0; t < steps; t++) for (let k = 0; k < nz; k++) for (let i = 0; i < nxy; i++) {
             const o = t * per + k * nxy + i, agl = zM[k] - g[i] * 1000
             if (agl < 0) { out[o] = 0; continue }
             if (Number.isNaN(u[o]) || Number.isNaN(v[o])) { out[o] = NaN; continue }
             out[o] = (u[o] * sx[i] + v[o] * sy[i]) * Math.exp(-agl / 2000)
           }
         } },
  // the Richardson number: stability (from θ's change with height) over the wind shear squared.
  // Below about 1 the shear can overturn the layer (Kelvin–Helmholtz waves, clear-air turbulence);
  // below 0.25 it usually does. Stored as Ri, 0 – 2; shown above 1.5 km, where it means clear air
  // packed high to low (byte 0 is Ri 2), so missing and calm air read as clear
  turb: { needs: ["temp", "u", "v"], pressure: true, spec: { min: 2, max: 0, scale: "linear", units: "Ri", label: "Richardson number" },
          run: ({ e, inputs: [T, u, v], out, pHpa, zM }) => {
            const { nx, ny, nz } = e, nxy = nx * ny, per = nxy * nz, steps = out.length / per
            for (let t = 0; t < steps; t++) for (let k = 0; k < nz; k++) for (let i = 0; i < nxy; i++) {
              const o = t * per + k * nxy + i
              if (zM[k] < 1500 || k === 0 || k === nz - 1) { out[o] = NaN; continue }
              const a = o - nxy, b = o + nxy, dz = zM[k + 1] - zM[k - 1]
              const th0 = thetaK(T[a], pHpa[k - 1]), th1 = thetaK(T[b], pHpa[k + 1]), th = thetaK(T[o], pHpa[k])
              const n2 = (9.81 / th) * ((th1 - th0) / dz)
              const s2 = ((u[b] - u[a]) / dz) ** 2 + ((v[b] - v[a]) / dz) ** 2
              const ri = n2 / Math.max(s2, 1e-7)
              out[o] = Number.isNaN(ri) ? NaN : Math.min(2, Math.max(0, ri))
            }
          } },
}

/** Whether a view is worked out in the page rather than read from its own file. */
export const isDerived = (n: VolVar) => !!DERIVED[n]

/** A view's data description for a model: its own file, or a view worked out from others. */
export function viewVar(e: VolumeEntry, n: VolVar): VolumeVar | undefined {
  const d = DERIVED[n]
  if (!d) return e.vars[SOURCE[n]]
  const vs = d.needs.map((k) => e.vars[k])
  if (vs.some((x) => !x) || (d.pressure && e.levels.length < 2)) return undefined
  return { ...d.spec, path: `derived/${e.model}/${e.run}/${n}`,
    make: async () => {
      const raw = await Promise.all(vs.map((x) => loadVolume(x!)))
      const inputs = raw.map((r, k) => {
        const lut = new Float32Array(256)
        for (let b = 0; b < 256; b++) lut[b] = b === 255 ? NaN : unpack(b, vs[k]!)
        const f = new Float32Array(r.length)
        for (let i = 0; i < r.length; i++) f[i] = lut[r[i]]
        return f
      })
      const out = new Float32Array(raw[0].length).fill(NaN)
      const zM = Float32Array.from({ length: e.nz }, (_, k) => (k / (e.nz - 1)) * e.topKm * 1000)
      const dLat = (e.lat[1] - e.lat[0]) / (e.ny - 1), dLon = (e.lon[1] - e.lon[0]) / (e.nx - 1)
      const dxM = Float32Array.from({ length: e.ny }, (_, y) => dLon * 111320 * Math.cos(((e.lat[0] + y * dLat) * Math.PI) / 180))
      let ground: Float32Array | null = null
      if (d.terrain) {
        // the terrain's mean height over each model cell (rows north to south from the tiles; flipped)
        const el = await elevationFor({ width: e.nx, height: e.ny, west: e.lon[0] - dLon / 2, east: e.lon[1] + dLon / 2,
                                        south: e.lat[0] - dLat / 2, north: e.lat[1] + dLat / 2 })
        ground = new Float32Array(e.nx * e.ny)
        for (let y = 0; y < e.ny; y++) for (let x = 0; x < e.nx; x++) {
          const m = el.mean[(e.ny - 1 - y) * e.nx + x]
          ground[y * e.nx + x] = Number.isFinite(m) ? Math.max(0, m) / 1000 : 0
        }
      }
      d.run({ e, inputs, out, pHpa: pressureAt(e), zM, dxM, dyM: dLat * 110540, ground })
      const bytes = new Uint8Array(out.length)
      for (let i = 0; i < out.length; i++) bytes[i] = Number.isNaN(out[i]) ? 255 : repack(out[i], d.spec)
      return bytes
    } }
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
// θe: the cold, dry air in blues to the warm, moist air in oranges and reds
const THETAE_STOPS: [number, [number, number, number]][] = [[270, [70, 80, 170]], [290, [90, 150, 210]], [305, [140, 200, 170]], [315, [240, 210, 110]], [330, [235, 120, 60]], [350, [180, 30, 60]]]
const THETA_STOPS: [number, [number, number, number]][] = [[270, [90, 90, 180]], [290, [80, 160, 200]], [300, [120, 190, 140]], [310, [230, 200, 90]], [330, [230, 120, 60]], [380, [170, 40, 90]]]
// turbulence: deep purple at the most unstable through amber to clear
const TURB_STOPS: [number, [number, number, number]][] = [[0, [120, 30, 120]], [0.25, [200, 50, 90]], [0.5, [240, 140, 50]], [1, [250, 220, 120]], [2, [250, 240, 200]]]
// reflectivity: the radar layer's greens, yellows, reds and magentas, as a smooth scale (its greys
// for the weakest echoes would read as murk in 3D, so they start pale green)
const DBZ_STOPS: [number, [number, number, number]][] = [[5, [176, 218, 176]], [15, [96, 196, 96]], [20, [30, 200, 40]], [30, [40, 160, 40]], [35, [220, 229, 3]],
  [40, [238, 210, 100]], [45, [238, 125, 39]], [50, [255, 52, 47]], [55, [176, 48, 96]], [60, [179, 59, 131]], [65, [231, 29, 240]], [70, [255, 146, 255]]]
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
    case "wbz": return [0, 0, 0, 0]
    // θe and θ read as surfaces (ISOS) over a faint wash
    case "thetae": return [...lerp(THETAE_STOPS, x), 0.004] as [number, number, number, number]
    case "theta": return [...lerp(THETA_STOPS, x), 0] as [number, number, number, number]
    // lift up the slopes warm, sinking down them cool, like rising and sinking air
    case "oro": return [...lerp(x >= 0 ? UP : DOWN, Math.min(1, Math.abs(x) * 2.5)), 2.4 * smooth(0.02, 0.35, Math.abs(x)) ** 1.1] as [number, number, number, number]
    // the lower the Richardson number, the likelier the overturning: clear above 1, solid near 0.25
    case "turb": return [...lerp(TURB_STOPS, x), 1.6 * smooth(1.0, 0.2, x) ** 1.5] as [number, number, number, number]
    // the radar's own colours, thickening with the echo
    case "dbz": return [...lerp(DBZ_STOPS, x), 2.8 * smooth(5, 45, x) ** 1.1] as [number, number, number, number]
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
  wbz: [{ at: 32, color: "#1f78d1", alpha: 0.92, label: "Wet-bulb 32°F" }],
  thetae: [
    { at: 290, color: "#5a96d2", alpha: 0.3, label: "290 K" },
    { at: 300, color: "#8cc8aa", alpha: 0.34, label: "300 K" },
    { at: 310, color: "#e6c864", alpha: 0.4, label: "310 K" },
    { at: 320, color: "#e67a3c", alpha: 0.45, label: "320 K" },
  ],
  theta: [
    { at: 290, color: "#50a0c8", alpha: 0.5, label: "290 K" },
    { at: 300, color: "#78be8c", alpha: 0.5, label: "300 K" },
    { at: 310, color: "#e6c85a", alpha: 0.5, label: "310 K" },
    { at: 320, color: "#e6783c", alpha: 0.5, label: "320 K" },
  ],
}
/** Views whose surfaces take their colour from their height. */
export const ISO_BY_HEIGHT: Partial<Record<VolVar, "frz" | "km">> = { frz: "frz", pv: "km", wbz: "frz", theta: "km" }
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
    const rgb = name === "temp" || name === "frz" || name === "wbz" ? lerp(TEMP_SMOOTH, x) : name === "wind" ? lerp(WIND_SMOOTH, x) : transfer(name, x).slice(0, 3)
    // no echo shows as nothing (a scan's slice through clear air stays clear)
    out.set([...rgb.map(Math.round), name === "dbz" && x < 5 ? 0 : 255], b * 4)
  }
  return out
}

/** Colours across a variable's useful range, for the legend: [value, css colour, how opaque]. */
export function legendStops(name: VolVar, v: VolumeVar): { show: [number, number]; ticks: number[] } {
  const show: Record<VolVar, [number, number]> = { cloud: [0, 100], rh: [0, 100], temp: [-60, 70], wind: [0, 180], water: [0, 1], ice: [0, 1], frz: [0, 12000],
    mflux: [0, 500], w: [-1, 1], pv: [0, 8], dgz: [50, 100], icing: [0, 1], wbz: [0, 12000], thetae: [270, 350], theta: [270, 380], oro: [-1, 1],
    turb: [0, 1.5], dbz: [5, 70] }
  const ticks: Record<VolVar, number[]> = { cloud: [0, 25, 50, 75, 100], rh: [0, 20, 40, 60, 80, 100], temp: [-60, -40, -20, 0, 20, 32, 50, 70],
    wind: [0, 40, 80, 120, 160], water: [0, 0.25, 0.5, 0.75, 1], ice: [0, 0.25, 0.5, 0.75, 1], frz: [0, 2000, 4000, 6000, 8000, 10000, 12000],
    mflux: [0, 100, 200, 300, 400, 500], w: [-1, -0.5, 0, 0.5, 1], pv: [0, 1, 2, 4, 6, 8], dgz: [50, 60, 70, 80, 90, 100], icing: [0, 0.25, 0.5, 0.75, 1],
    wbz: [0, 2000, 4000, 6000, 8000, 10000, 12000], thetae: [270, 290, 310, 330, 350], theta: [270, 300, 330, 360], oro: [-1, -0.5, 0, 0.5, 1],
    turb: [0, 0.25, 0.5, 1, 1.5], dbz: [10, 20, 30, 40, 50, 60, 70] }
  return { show: show[name] ?? [v.min, v.max], ticks: ticks[name] }
}

/** The moisture-flow colour for a value, a little deeper, for particles over a light map. */
export function mfluxRgb(x: number): [number, number, number] {
  return lerp(MFLUX_STOPS, x).map((c) => (c / 255) * 0.85) as [number, number, number]
}
