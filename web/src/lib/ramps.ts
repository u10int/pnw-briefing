// Colour ramps for gridded fields and the location tables. Precipitation, snowfall, temperature,
// temperature departure, wind, reflectivity and water vapour transport use Ryan Maue's GrADS tables
// (./ramps/maue.json, from forecasteagle.com/ramps); briefing/maps.py reads the same file, so the
// interactive map, the tables and the PNG small multiples read the same way. Spread, odds, percent
// of normal, pressure gradient and freezing level have no Maue table and keep their own.

import maue from "./ramps/maue.json"

/** `show`: the part of a long ramp worth drawing in a legend for this region; `ticks`: the levels
 *  a legend labels (otherwise every few). */
export interface Ramp {
  levels: number[]; colors: string[]; units: string; label: string; clampLow?: boolean
  show?: [number, number]; ticks?: number[]
}
// colors[i] fills [levels[i], levels[i+1]); the last colour fills >= the last level. Below levels[0] is clear.

type MaueName = keyof typeof maue.ramps
function fromMaue(name: MaueName, label: string, units: string, extra: Partial<Ramp> = {}): Ramp {
  const stops = maue.ramps[name].stops as [number, string][]
  return { label, units, levels: stops.map((s) => s[0]), colors: stops.map((s) => s[1]), ...extra }
}

export const PRECIP: Ramp = fromMaue("maue_precip_rgbset", "Precipitation, liquid equivalent", "in",
  { show: [0.01, 20], ticks: [0.01, 0.1, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 16] })
export const SNOW: Ramp = fromMaue("maue_snowfall", "Snowfall", "in",
  { show: [0.1, 48], ticks: [0.1, 1, 2, 4, 6, 8, 12, 18, 24, 36, 48] })
export const SPREAD: Ramp = {
  label: "Model spread, highest minus lowest", units: "in",
  levels: [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12],
  colors: ["#e6e6e6", "#d2d2d2", "#bcbcbc", "#a3a3a3", "#898989", "#6e6e6e", "#545454", "#383838", "#1c1c1c"],
}
/** Probability (% of ensemble members); below 5% is left clear. */
export const PROB: Ramp = {
  label: "Chance", units: "%",
  levels: [5, 15, 30, 45, 60, 75, 90],
  colors: ["#e2daf5", "#c9b9ec", "#a993df", "#8a6fd0", "#6b4fbc", "#4f3799", "#35226f"],
}
export const PCT: Ramp = {
  label: "Model mean, percent of 1991 – 2020 normal", units: "%",
  levels: [0, 25, 50, 70, 90, 110, 130, 160, 200, 300],
  colors: ["#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"],
}

/** Integrated water vapor transport; 250 and up is atmospheric-river conditions. */
export const IVT: Ramp = fromMaue("maue_ivt", "Water vapor transport (IVT)", "kg m⁻¹ s⁻¹",
  { show: [20, 1500], ticks: [20, 100, 250, 500, 800, 1000, 1500] })

/** Sea-level pressure gradient strength. Synoptic gradients run 1 – 2 hPa per 100 km; 3+ is a
 *  windstorm-class gradient, and gap flows (Gorge, Fraser) pack even tighter. */
export const PGRAD: Ramp = {
  label: "Pressure gradient", units: "hPa per 100 km",
  levels: [1, 1.5, 2, 2.5, 3, 4, 5, 6.5, 8],
  colors: ["#fdf0c4", "#fbd98a", "#f7b955", "#f19537", "#e5702b", "#cf4a2a", "#ad2a35", "#831a45", "#56124a"],
}

/** Departure from normal (°F). */
export const TDEP: Ramp = fromMaue("maue_temp_anomaly", "Departure from 1991 – 2020 normal", "°F",
  { clampLow: true, show: [-30, 30], ticks: [-30, -20, -10, -5, 0, 5, 10, 20, 30] })

/** A level as a legend label: whole numbers from 10 up, otherwise up to two decimals. */
export const fmtLevel = (v: number) =>
  Math.abs(v) >= 10 ? String(Math.round(v)) : String(Number(v.toFixed(Math.abs(v) >= 1 ? 1 : 2)))

/** The bins a legend draws (those inside `show`, or `range`), each with its label or "". */
export function legendBins(r: Ramp, range?: [number, number], every = 1) {
  const [lo, hi] = range ?? r.show ?? [r.levels[0], r.levels[r.levels.length - 1]]
  const idx = r.levels.map((_, i) => i).filter((i) => r.levels[i] >= lo - 1e-6 && r.levels[i] <= hi + 1e-6)
  const ticked = (v: number) => r.ticks ? r.ticks.some((t) => Math.abs(t - v) < 1e-6) : null
  return idx.map((i, k) => {
    const t = ticked(r.levels[i])
    return { color: r.colors[i], label: (t ?? k % every === 0) ? fmtLevel(r.levels[i]) : "" }
  })
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Lookup table: value -> RGBA, as a function. */
export function colorizer(r: Ramp) {
  const rgb = r.colors.map(hexToRgb)
  return (v: number): [number, number, number, number] | null => {
    if (!Number.isFinite(v)) return null
    if (v < r.levels[0]) {
      if (!r.clampLow) return null
      const c = rgb[0]
      return [c[0], c[1], c[2], 255]
    }
    let i = r.levels.length - 1
    while (i > 0 && v < r.levels[i]) i--
    const c = rgb[Math.min(i, rgb.length - 1)]
    return [c[0], c[1], c[2], 255]
  }
}

// ---- time-stepped fields

export const TEMP: Ramp = fromMaue("maue_weather_us_temp", "Temperature at 2 m", "°F",
  { clampLow: true, show: [-10, 110], ticks: [-10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110] })
// Maue's wind table is in knots (6, 7, 8, 10, 12 … 135 kt), here on a miles-per-hour axis
export const WIND: Ramp = fromMaue("maue_wind10m_mph", "Wind speed", "mph",
  { show: [6.9, 103.6], ticks: [6.904674, 11.50779, 23.01558, 34.52337, 43.729602, 57.53895, 69.04674, 92.06232] })
export const GUST: Ramp = { ...WIND, label: "Wind gust" }
export const FRZ: Ramp = {
  label: "Freezing level, above sea level", units: "ft", clampLow: true,
  levels: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000],
  colors: ["#3b2a87", "#3c4fb0", "#3f74c7", "#4e95d1", "#69b1d6", "#8cc8d8", "#b0dad5", "#d2e8cc", "#ecefb8",
           "#f6e29a", "#f6cb7a", "#f2ad5d", "#e88b47", "#d9663a", "#c03f33"],
}

// ---- fire weather (no Maue table for these)

/** 2 m relative humidity: dark red at the driest, through orange and yellow, to greens. */
export const RH: Ramp = {
  label: "Relative humidity at 2 m", units: "%", clampLow: true,
  levels: [0, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90],
  colors: ["#67000d", "#a50f15", "#d7301f", "#ef6548", "#fc8d59", "#fdbb84", "#fee8a6", "#e6f5c9", "#bfe3b4",
           "#8ccaa0", "#4fa98a", "#26806d"],
}
/** Surface Hot-Dry-Windy Index (VPD hPa x wind m/s). */
export const HDW: Ramp = {
  label: "Hot-Dry-Windy Index, surface", units: "hPa·m/s", clampLow: true,
  levels: [0, 25, 50, 75, 100, 150, 200, 300, 400],
  colors: ["#f4f4f2", "#fde9c6", "#fdd49e", "#fdbb84", "#fc8d59", "#ef6548", "#d7301f", "#b30000", "#7f0000"],
}
/** Near-surface smoke (µg/m³), breaks near the EPA PM2.5 categories; below 1 is clear. */
export const SMOKE: Ramp = {
  label: "Near-surface smoke", units: "µg/m³",
  levels: [1, 4, 9, 12, 20, 35, 55, 100, 150, 250],
  colors: ["#e9e7e4", "#d6d2cc", "#c2b9ad", "#c9a979", "#c58f4a", "#b26a2a", "#8f4419", "#6c2412", "#4f1336", "#330a2f"],
}
/** NWCC 7-day fuel dryness and high-risk days, by level (0 none, 1 moist, 2 dry, 3 very dry, 4 high risk). */
export const FUEL = ["transparent", "#cfe8c4", "#f6dc8a", "#e3a35a", "#c8322b"] as const
/** US Drought Monitor D0-D4. */
export const USDM = ["#ffff00", "#fcd37f", "#ffaa00", "#e60000", "#730000"] as const
/** SPC fire weather outlook: days 1-2 categories and dry thunderstorms; days 3-8 by probability. */
export const SPC_FIRE: Record<string, string> = {
  "windrh:5": "#ffb366", "windrh:8": "#e8302f", "windrh:10": "#c71585",
  "dryt:5": "#b88a5a", "dryt:8": "#7a4a22",
}
export const spcColor = (kind: string, dn: number, probability: boolean) =>
  probability ? (dn >= 70 ? "#e8302f" : dn >= 40 ? "#ffb366" : "#f2d27a") : SPC_FIRE[`${kind}:${dn}`] ?? "#ffb366"

/** Simulated reflectivity, coloured by precipitation type. Rain uses Maue's radar table; the other
 *  types keep their own hues, sampled onto the same dBZ levels so one set of levels serves every row. */
const RADAR = fromMaue("maue_radar", "Rain", "dBZ", { ticks: [9, 15, 21, 30, 39, 45, 51, 60, 69] })
const DBZ = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65]
const onRadar = (label: string, colors: string[]): Ramp => ({
  label, units: "dBZ", levels: RADAR.levels,
  colors: RADAR.levels.map((v) => { let i = DBZ.length - 1; while (i > 0 && v < DBZ[i]) i--; return colors[i] }),
})
export const REFC: Record<string, Ramp> = {
  rain: RADAR,
  snow: onRadar("Snow", ["#d9e9fc", "#b4d3f8", "#8dbcf3", "#67a5ed", "#468ce3", "#2f73d2", "#215cb8", "#18479d", "#133883",
                        "#0f2c6a", "#0b2154", "#081840", "#050f2c"]),
  mix: onRadar("Mix", ["#f1d6f0", "#e7b6e3", "#dd95d6", "#d273c9", "#c654bb", "#b53caa", "#9f2a97", "#881c84", "#701371",
                      "#590d5e", "#43084b", "#310538", "#220326"]),
  "freezing rain": onRadar("Freezing rain", ["#fbd3de", "#f7aac1", "#f281a4", "#ea5888", "#dd356f", "#c7205c", "#ad164d", "#921040",
                                            "#770c34", "#5e0828", "#46061e", "#320415", "#22020d"]),
  sleet: onRadar("Sleet", ["#fde2c4", "#fbc993", "#f8ae63", "#f39237", "#e97a1f", "#d86514", "#c1540f", "#a7450c", "#8c380a",
                          "#712c08", "#572106", "#401804", "#2c1003"]),
}
export const PTYPE_NAMES = ["none", "rain", "snow", "freezing rain", "sleet", "mix"] as const
/** Flat colours for precipitation type where a model has no reflectivity (global models). */
export const PTYPE_COLORS: Record<string, string> = {
  rain: "#45bf5a", snow: "#2f73d2", "freezing rain": "#dd356f", sleet: "#f39237", mix: "#b53caa",
}


/** AR scale colours, rank 0 (below the scale) to 5 (exceptional): the timeline, badges and the map's coastal outlook. */
export const AR_COLORS = ["#9ca3af", "#4f9fd8", "#3fae6a", "#e9b625", "#f08a24", "#d9342b"]
export const AR_LABELS = ["Below AR scale", "AR1 Weak", "AR2 Moderate", "AR3 Strong", "AR4 Extreme", "AR5 Exceptional"]
