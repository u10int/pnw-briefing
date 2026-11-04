// Colour ramps for gridded fields. Precipitation, snowfall and spread match briefing/maps.py so the
// interactive map and the PNG small multiples read the same way.

export interface Ramp { levels: number[]; colors: string[]; units: string; label: string; clampLow?: boolean }
// colors[i] fills [levels[i], levels[i+1]); the last colour fills >= the last level. Below levels[0] is clear.

export const PRECIP: Ramp = {
  label: "Precipitation, liquid equivalent", units: "in",
  levels: [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 15, 20, 30],
  colors: ["#d3e2f8", "#bdd3f4", "#a2c1ef", "#86afea", "#6a9ce4", "#4f88dd", "#3474d5", "#1f5fd1", "#1a50b2",
           "#164293", "#123576", "#0f2a5e", "#0b1f47", "#1c1240"],
}
export const SNOW: Ramp = {
  label: "Snowfall", units: "in",
  levels: [0.5, 1, 2, 4, 6, 8, 12, 18, 24, 36, 48, 72],
  colors: ["#e3dff8", "#cdc6f2", "#b4aaeb", "#998de3", "#7f70da", "#6553cf", "#5040b6", "#3f3299", "#30267b",
           "#221a5e", "#160f42", "#0d082c"],
}
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
  label: "Model mean, percent of 1991–2020 normal", units: "%",
  levels: [0, 25, 50, 70, 90, 110, 130, 160, 200, 300],
  colors: ["#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"],
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

export const TEMP: Ramp = {
  label: "Temperature at 2 m", units: "°F", clampLow: true,
  levels: [-10, -5, 0, 5, 10, 15, 20, 25, 30, 32, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100],
  colors: ["#4b2c7f", "#5e3a9e", "#6b4bb8", "#5867c9", "#4a7fd4", "#3f97d9", "#43acd6", "#5cc0d2", "#8ad3d4",
           "#b7e3cf", "#d6ecb4", "#e8ef9c", "#f4e98a", "#f7d872", "#f6c25e", "#f2a84f", "#ec8c45", "#e2703f",
           "#d4543a", "#c13a36", "#a62533", "#87162d", "#661026", "#4a0b1d"],
}
export const WIND: Ramp = {
  label: "Wind speed", units: "mph", clampLow: true,
  levels: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80],
  colors: ["#f2f4f7", "#dbe7f0", "#bcd7e6", "#95c3d8", "#6eaec9", "#4b98b8", "#3a8f8c", "#5a9f4f", "#a3b23a",
           "#d9a72c", "#e47c2a", "#d9482b", "#b0203f", "#7a1258"],
}
export const GUST: Ramp = { ...WIND, label: "Wind gust" }
export const FRZ: Ramp = {
  label: "Freezing level, above sea level", units: "ft", clampLow: true,
  levels: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000],
  colors: ["#3b2a87", "#3c4fb0", "#3f74c7", "#4e95d1", "#69b1d6", "#8cc8d8", "#b0dad5", "#d2e8cc", "#ecefb8",
           "#f6e29a", "#f6cb7a", "#f2ad5d", "#e88b47", "#d9663a", "#c03f33"],
}

/** Simulated reflectivity, coloured by precipitation type (rain/snow/mix/freezing rain/sleet). */
const DBZ = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65]
export const REFC: Record<string, Ramp> = {
  rain: { label: "Rain", units: "dBZ", levels: DBZ,
    colors: ["#b9ecbd", "#7fd88a", "#45bf5a", "#22993b", "#f2e33a", "#e8c22b", "#f0962a", "#e85d26", "#d6262a",
             "#b0122d", "#c21d8e", "#8f2fbf", "#f5e9ff"] },
  snow: { label: "Snow", units: "dBZ", levels: DBZ,
    colors: ["#d9e9fc", "#b4d3f8", "#8dbcf3", "#67a5ed", "#468ce3", "#2f73d2", "#215cb8", "#18479d", "#133883",
             "#0f2c6a", "#0b2154", "#081840", "#050f2c"] },
  mix: { label: "Mix", units: "dBZ", levels: DBZ,
    colors: ["#f1d6f0", "#e7b6e3", "#dd95d6", "#d273c9", "#c654bb", "#b53caa", "#9f2a97", "#881c84", "#701371",
             "#590d5e", "#43084b", "#310538", "#220326"] },
  "freezing rain": { label: "Freezing rain", units: "dBZ", levels: DBZ,
    colors: ["#fbd3de", "#f7aac1", "#f281a4", "#ea5888", "#dd356f", "#c7205c", "#ad164d", "#921040", "#770c34",
             "#5e0828", "#46061e", "#320415", "#22020d"] },
  sleet: { label: "Sleet", units: "dBZ", levels: DBZ,
    colors: ["#fde2c4", "#fbc993", "#f8ae63", "#f39237", "#e97a1f", "#d86514", "#c1540f", "#a7450c", "#8c380a",
             "#712c08", "#572106", "#401804", "#2c1003"] },
}
export const PTYPE_NAMES = ["none", "rain", "snow", "freezing rain", "sleet", "mix"] as const
/** Flat colours for precipitation type where a model has no reflectivity (global models). */
export const PTYPE_COLORS: Record<string, string> = {
  rain: "#45bf5a", snow: "#2f73d2", "freezing rain": "#dd356f", sleet: "#f39237", mix: "#b53caa",
}
