import * as React from "react"

import { ArrowLeftRight, ChevronRight, CircleCheck, CloudRain, CloudSnow, type LucideIcon, Mountain, MountainSnow, OctagonAlert,
  Snowflake, Thermometer, ThermometerSnowflake, ThermometerSun, TriangleAlert, Waves, Wind } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { gradLevel, pairName } from "@/lib/gradients"
import type { Briefing } from "@/types"

export type HazardTab = "rain" | "wind" | "snow" | "temp"
type Tone = "quiet" | "watch" | "alert"
interface Item { icon: LucideIcon; text: string }
interface Summary { tab: HazardTab; title: string; icon: LucideIcon; items: Item[]; tone: Tone }

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
  const lines: Item[] = []
  let tone: Tone = "quiet"
  const evs = (d.ar?.events ?? []).filter((e) => e.rank >= 1)
  if (evs.length) {
    const top = Math.max(...evs.map((e) => e.rank))
    const e = evs.filter((x) => x.rank === top).sort((a, b) => a.start.localeCompare(b.start))[0]
    const models = new Set(evs.filter((x) => x.rank >= top - 1 && Math.abs(Date.parse(x.start) - Date.parse(e.start)) < 2 * 864e5).map((x) => x.model))
    lines.push({ icon: Waves, text: `${AR_SHORT[top]} (${AR_WORD[top]}) atmospheric river at ${e.point}, ${day(e.start)}–${day(e.end)} (${[...models].join(", ")})` })
    if (top >= 3) tone = "watch"
    if (top >= 4) tone = "alert"
  } else if (d.ar) lines.push({ icon: Waves, text: "No atmospheric river reaches the coast" })
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
      lines.push({ icon: Mountain, text: `Landslide threshold reached at ${b.name} in ${b.k} of ${b.n} models (${day(Date.parse(ls.days[b.day].start) + 12 * 36e5)})` })
      tone = tone === "alert" ? "alert" : "watch"
    } else lines.push({ icon: Mountain, text: "Landslide threshold not reached" })
  }
  const w7 = d.windows.find((w) => w.days === 7) ?? d.windows[d.windows.length - 1]
  if (w7 && !lines.length) lines.push({ icon: CloudRain, text: `${w7.label}: see totals` })
  return { tab: "rain", title: "Rain & flooding", icon: CloudRain, items: lines, tone }
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
  const lines: Item[] = hits.slice(0, 2).map((h) => ({ icon: ArrowLeftRight, text: `${h.label} (${pairName(h.g)}), ${day(h.t)}: ${h.models.size} of ${h.n} models` }))
  if (!lines.length) lines.push({ icon: ArrowLeftRight, text: gs.length ? "No pressure gradient reaches its threshold" : "No gradient data" })
  const top = hits[0]?.level ?? 0
  return { tab: "wind", title: "Wind", icon: Wind, items: lines, tone: top >= 2 ? "alert" : top ? "watch" : "quiet" }
}

function snow(d: Briefing): Summary {
  const lines: Item[] = []
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
      lines.push({ icon: CloudSnow, text: `Snow level reaches ${b.pass} (${b.elev.toLocaleString("en-US")} ft) by ${day(b.t)}: ${b.models.size} of ${b.n} models` })
      tone = "watch"
    } else lines.push({ icon: CloudSnow, text: "Snow level stays above the passes for the next 7 days" })
  }
  const av = d.avalanche
  if (av) {
    if (!av.inSeason) lines.push({ icon: MountainSnow, text: `Avalanche ratings start after ${av.until ? day(av.until + "T20:00:00Z") : "the early season"}` })
    else {
      const top = Math.max(...av.zones.map((z) => z.level))
      const zones = av.zones.filter((z) => z.level === top).length
      lines.push({ icon: MountainSnow, text: `Avalanche danger ${AVY[top] ?? "—"} in ${zones} of ${av.zones.length} zones` })
      if (top >= 3) tone = "watch"
      if (top >= 4) tone = "alert"
    }
  }
  return { tab: "snow", title: "Snow & mountains", icon: Snowflake, items: lines, tone }
}

function temp(d: Briefing): Summary {
  const td = d.tempDeparture
  if (!td) return { tab: "temp", title: "Temperature", icon: Thermometer, items: [{ icon: Thermometer, text: "No normals in this briefing" }], tone: "quiet" }
  const w = td.windows.find((x) => x.days === 7) ?? td.windows[0]
  const avg = (k: "tmax" | "tmin") => {
    const v = Object.values(w.regions).map((r) => r[k]).filter((x): x is number => x != null)
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
  }
  const hi = avg("tmax"), lo = avg("tmin")
  const word = (v: number | null, what: string) =>
    v == null ? null : Math.abs(v) < 1.5 ? `${what} near normal` : `${what} ${Math.round(Math.abs(v))}° ${v > 0 ? "above" : "below"} normal`
  const mean = ((hi ?? 0) + (lo ?? 0)) / 2
  const lines: Item[] = [{ icon: mean > 1.5 ? ThermometerSun : mean < -1.5 ? ThermometerSnowflake : Thermometer,
                           text: [word(hi, "Highs"), word(lo, "lows")].filter(Boolean).join(", ") + ` over ${w.label.toLowerCase()}` }]
  const m = Math.max(Math.abs(hi ?? 0), Math.abs(lo ?? 0))
  return { tab: "temp", title: "Temperature", icon: Thermometer, items: lines, tone: m >= 8 ? "alert" : m >= 4 ? "watch" : "quiet" }
}

/** Severity, shown twice at the top of each card: in the tint of the hazard's icon tile and as a
 *  badge with its own icon. Colours match the impacts table's "Likely" and "Possible" badges. */
const TONE: Record<Tone, { label: string; icon: LucideIcon; badge: "secondary" | "possible" | "likely"; tile: string }> = {
  quiet: { label: "Quiet", icon: CircleCheck, badge: "secondary", tile: "bg-muted text-muted-foreground" },
  watch: { label: "Worth watching", icon: TriangleAlert, badge: "possible", tile: "bg-[var(--possible-bg)] text-[var(--possible)]" },
  alert: { label: "Significant", icon: OctagonAlert, badge: "likely", tile: "bg-[var(--likely-bg)] text-[var(--likely)]" },
}

/** One summary per hazard tab; each opens its tab. */
export function HazardStrip({ data, onOpen }: { data: Briefing; onOpen: (tab: HazardTab) => void }) {
  const items = React.useMemo(() => [rain(data), wind(data), snow(data), temp(data)], [data])
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((h) => {
        const tone = TONE[h.tone]
        const Icon = h.icon, ToneIcon = tone.icon
        return (
          <button key={h.tab} type="button" onClick={() => onOpen(h.tab)} aria-label={`${h.title}: ${tone.label}. Open the ${h.title} tab`}
                  className="group flex flex-col rounded-xl border bg-card p-4 text-left shadow-xs transition-[background-color,box-shadow] hover:bg-muted/30 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <div className="flex items-start gap-3">
              <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tone.tile}`}>
                <Icon className="size-[18px]" strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="font-medium leading-tight">{h.title}</div>
                <Badge variant={tone.badge} className="gap-1"><ToneIcon />{tone.label}</Badge>
              </div>
              <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </div>
            <ul className="mt-3.5 space-y-2 border-t pt-3 text-sm">
              {h.items.map((it, k) => {
                const ItIcon = it.icon
                return (
                  <li key={it.text} className={`flex gap-2 ${k === 0 ? "text-foreground" : "text-muted-foreground"}`}>
                    <ItIcon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
                    <span className="leading-snug">{it.text}</span>
                  </li>
                )
              })}
            </ul>
          </button>
        )
      })}
    </div>
  )
}
