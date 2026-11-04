// Colour ramps for gridded fields. Precipitation, snowfall and spread match briefing/maps.py so the
// interactive map and the PNG small multiples read the same way.

export interface Ramp { levels: number[]; colors: string[]; units: string; label: string }
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
    if (!Number.isFinite(v) || v < r.levels[0]) return null
    let i = r.levels.length - 1
    while (i > 0 && v < r.levels[i]) i--
    const c = rgb[Math.min(i, rgb.length - 1)]
    return [c[0], c[1], c[2], 255]
  }
}
