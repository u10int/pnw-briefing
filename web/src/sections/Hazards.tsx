import * as React from "react"

import { gradLevel, pairName } from "@/lib/gradients"
import type { Briefing } from "@/types"

export type HazardTab = "rain" | "wind" | "snow" | "temp"
type Tone = "quiet" | "watch" | "alert"
interface Summary { tab: HazardTab; title: string; lines: string[]; tone: Tone }

const PT = "America/Los_Angeles"
// "Wed 4", built by hand: Intl orders weekday and day differently across engines
const day = (t: number | string) => {
  const d = new Date(typeof t === "string" ? Date.parse(t) : t)
  return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: PT })} ${d.toLocaleDateString("en-US", { day: "numeric", timeZone: PT })}`
}
const AR_SHORT = ["Below scale", "AR1", "AR2", "AR3", "AR4", "AR5"]
const AR_WORD = ["", "weak", "moderate", "strong", "extreme", "exceptional"]
const AVY = ["", "Low", "Moderate", "Considerable", "High", "Extreme"]

function rain(d: Briefing): Summary {
  const lines: string[] = []
  let tone: Tone = "quiet"
  const evs = (d.ar?.events ?? []).filter((e) => e.rank >= 1)
  if (evs.length) {
    const top = Math.max(...evs.map((e) => e.rank))
    const e = evs.filter((x) => x.rank === top).sort((a, b) => a.start.localeCompare(b.start))[0]
    const models = new Set(evs.filter((x) => x.rank >= top - 1 && Math.abs(Date.parse(x.start) - Date.parse(e.start)) < 2 * 864e5).map((x) => x.model))
    lines.push(`${AR_SHORT[top]} (${AR_WORD[top]}) atmospheric river at ${e.point}, ${day(e.start)}–${day(e.end)} (${[...models].join(", ")})`)
    if (top >= 3) tone = "watch"
    if (top >= 4) tone = "alert"
  } else if (d.ar) lines.push("No atmospheric river reaches the coast")
  const ls = d.landslide
  if (ls) {
    let best: { name: string; k: number; n: number; day: number } | null = null
    for (const p of ls.points) {
      ls.days.forEach((_, k) => {
        const vals = p.models.map((m) => m.index[k]).filter((v): v is number => v != null)
        const over = vals.filter((v) => v >= ls.threshold).length
        if (over && (!best || over > best.k)) best = { name: p.name, k: over, n: vals.length, day: k }
      })
    }
    const b = best as { name: string; k: number; n: number; day: number } | null
    if (b) {
      lines.push(`Landslide threshold reached at ${b.name} in ${b.k} of ${b.n} models (${day(Date.parse(ls.days[b.day].start) + 12 * 36e5)})`)
      tone = tone === "alert" ? "alert" : "watch"
    } else lines.push("Landslide threshold not reached")
  }
  const w7 = d.windows.find((w) => w.days === 7) ?? d.windows[d.windows.length - 1]
  if (w7 && !lines.length) lines.push(`${w7.label}: see totals`)
  return { tab: "rain", title: "Rain & flooding", lines, tone }
}

function wind(d: Briefing): Summary {
  const gs = (d.gradients ?? []).filter((g) => g.series.length)
  type Hit = { g: (typeof gs)[number]; level: number; label: string; t: number; models: Set<string>; n: number }
  const hits: Hit[] = []
  for (const g of gs) {
    let h: Hit | null = null
    for (const s of g.series) {
      s.values.forEach((v, i) => {
        const { level, label } = gradLevel(g, v)
        if (!level) return
        const t = Date.parse(s.times[i])
        // models that reach this time at all (the regional ones stop after a few days)
        const n = g.series.filter((x) => x.times.length && Date.parse(x.times[x.times.length - 1]) >= t - 3 * 36e5).length
        if (!h || level > h.level || (level === h.level && t < h.t)) h = { g, level, label: label!, t, models: h?.level === level ? h.models : new Set(), n }
        if (h.level === level) h.models.add(s.model)
      })
    }
    if (h) hits.push(h)
  }
  hits.sort((a, b) => b.level - a.level || a.t - b.t)
  const lines = hits.slice(0, 2).map((h) => `${h.label} (${pairName(h.g)}), ${day(h.t)}: ${h.models.size} of ${h.n} models`)
  if (!lines.length) lines.push(gs.length ? "No pressure gradient reaches its threshold" : "No gradient data")
  const top = hits[0]?.level ?? 0
  return { tab: "wind", title: "Wind", lines, tone: top >= 2 ? "alert" : top ? "watch" : "quiet" }
}

function snow(d: Briefing): Summary {
  const lines: string[] = []
  let tone: Tone = "quiet"
  const sl = d.snowLevel
  if (sl) {
    const t0 = Date.parse(d.dates[0] + "T12:00:00Z"), t7 = t0 + 7 * 864e5
    let best: { pass: string; elev: number; t: number; models: Set<string>; n: number } | null = null
    for (const p of sl.passes) {
      const models = new Set<string>()
      let first = Infinity
      for (const s of p.series) {
        s.values.forEach((v, i) => {
          const t = Date.parse(s.times[i])
          if (v != null && t <= t7 && v <= p.elev_ft) { models.add(s.model); first = Math.min(first, t) }
        })
      }
      if (models.size && (!best || models.size > best.models.size || (models.size === best.models.size && first < best.t)))
        best = { pass: p.name, elev: p.elev_ft, t: first, models, n: p.series.length }
    }
    const b = best as { pass: string; elev: number; t: number; models: Set<string>; n: number } | null
    if (b) {
      lines.push(`Snow level reaches ${b.pass} (${b.elev.toLocaleString("en-US")} ft) by ${day(b.t)}: ${b.models.size} of ${b.n} models`)
      tone = "watch"
    } else lines.push("Snow level stays above the passes for the next 7 days")
  }
  const av = d.avalanche
  if (av) {
    if (!av.inSeason) lines.push(`Avalanche ratings start after ${av.until ? day(av.until + "T20:00:00Z") : "the early season"}`)
    else {
      const top = Math.max(...av.zones.map((z) => z.level))
      const zones = av.zones.filter((z) => z.level === top).length
      lines.push(`Avalanche danger ${AVY[top] ?? "—"} in ${zones} of ${av.zones.length} zones`)
      if (top >= 3) tone = "watch"
      if (top >= 4) tone = "alert"
    }
  }
  return { tab: "snow", title: "Snow & mountains", lines, tone }
}

function temp(d: Briefing): Summary {
  const td = d.tempDeparture
  if (!td) return { tab: "temp", title: "Temperature", lines: ["No normals for this run"], tone: "quiet" }
  const w = td.windows.find((x) => x.days === 7) ?? td.windows[0]
  const avg = (k: "tmax" | "tmin") => {
    const v = Object.values(w.regions).map((r) => r[k]).filter((x): x is number => x != null)
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
  }
  const hi = avg("tmax"), lo = avg("tmin")
  const word = (v: number | null, what: string) =>
    v == null ? null : Math.abs(v) < 1.5 ? `${what} near normal` : `${what} ${Math.round(Math.abs(v))}° ${v > 0 ? "above" : "below"} normal`
  const lines = [[word(hi, "Highs"), word(lo, "lows")].filter(Boolean).join(", ") + ` over ${w.label.toLowerCase()}`]
  const m = Math.max(Math.abs(hi ?? 0), Math.abs(lo ?? 0))
  return { tab: "temp", title: "Temperature", lines, tone: m >= 8 ? "alert" : m >= 4 ? "watch" : "quiet" }
}

const TONE: Record<Tone, { bar: string; dot: string; word: string }> = {
  quiet: { bar: "bg-border", dot: "#9ca3af", word: "Quiet" },
  watch: { bar: "bg-[#f0a830]", dot: "#f0a830", word: "Worth watching" },
  alert: { bar: "bg-[#d9342b]", dot: "#d9342b", word: "Significant" },
}

/** One summary per hazard tab; each opens its tab. */
export function HazardStrip({ data, onOpen }: { data: Briefing; onOpen: (tab: HazardTab) => void }) {
  const items = React.useMemo(() => [rain(data), wind(data), snow(data), temp(data)], [data])
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((h) => (
        <button key={h.tab} type="button" onClick={() => onOpen(h.tab)}
                className="group relative overflow-hidden rounded-xl border bg-card p-4 pl-5 text-left shadow-xs transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring">
          <span className={`absolute inset-y-0 left-0 w-1 ${TONE[h.tone].bar}`} />
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="font-medium">{h.title}</span>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: TONE[h.tone].dot }} />{TONE[h.tone].word}
            </span>
          </div>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {h.lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
          <span className="mt-2 inline-block text-xs font-medium text-foreground/80 group-hover:underline">Details →</span>
        </button>
      ))}
    </div>
  )
}
