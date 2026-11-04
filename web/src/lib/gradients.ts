import type { Gradient, ModelSeries } from "@/types"

/** Colours for a gradient past its first and second rule-of-thumb threshold. */
export const GRAD_COLORS = ["#9ca3af", "#f0a830", "#d9342b"]

/** How far a pressure difference is past the pair's thresholds: level 0 (none), 1 (first) or 2 (second),
 *  and the label of the strongest threshold passed. Thresholds of each sign rank by size. */
export function gradLevel(g: Gradient, v: number | null | undefined): { level: number; label: string | null } {
  if (v == null || !Number.isFinite(v)) return { level: 0, label: null }
  const same = g.thresholds.filter((t) => (v >= 0 ? t.value > 0 : t.value < 0)).sort((a, b) => Math.abs(a.value) - Math.abs(b.value))
  let level = 0, label: string | null = null
  same.forEach((t, k) => { if (Math.abs(v) >= Math.abs(t.value)) { level = Math.min(2, k + 1); label = t.label } })
  return { level, label }
}

/** A series' value at `time` (ms): the nearest sample within `tolH` hours, else null. */
export function seriesAt(s: ModelSeries, time: number, tolH = 3.5): number | null {
  let best = -1, bestD = Infinity
  for (let i = 0; i < s.times.length; i++) {
    const d = Math.abs(Date.parse(s.times[i]) - time)
    if (d < bestD) { bestD = d; best = i }
  }
  return best >= 0 && bestD <= tolH * 36e5 ? s.values[best] : null
}

export const pairName = (g: Gradient) =>
  g.codes?.[0] && g.codes?.[1] ? `${g.codes[0]}–${g.codes[1]}` : `${g.a} − ${g.b}`
