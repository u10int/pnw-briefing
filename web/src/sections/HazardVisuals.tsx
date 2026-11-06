import * as React from "react"

import { dayStats } from "@/sections/DayMatrix"
import type { Briefing, N } from "@/types"
import { arEpisodes, type HazardTab } from "@/sections/Hazards"

/** The figure and 14-day sketch at the top of each hazard card. Colours are the data's own (rain
 *  blue, snow violet, warm red / cool blue); severity stays in the badge. */

export interface Spark {
  series: { values: N[]; color: string; label?: string }[]
  diverging?: boolean                  // bars up and down from zero (temperature departure)
  threshold?: { value: number; label: string }
  unit?: string
}
export interface Visual { value: string; unit?: string; caption: string; aside?: string; spark?: Spark }

const PT = "America/Los_Angeles"
// "Thu 5", built by hand: Intl orders weekday and day differently across engines
const day = (t: number) => {
  const d = new Date(t)
  return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: PT })} ${d.toLocaleDateString("en-US", { day: "numeric", timeZone: PT })}`
}
const dayOf = (d: Briefing, k: number) => new Date(`${d.dates[k]}T20:00:00Z`).getTime()
const fin = (x: N): x is number => x != null && Number.isFinite(x)
const maxOf = (xs: N[]) => { const ys = xs.filter(fin); return ys.length ? Math.max(...ys) : null }

/** Per day, the max (or mean) across `names` of each location's multi-model median. */
function across(d: Briefing, stats: Record<string, { med: N }[]>, names: string[], how: "max" | "mean") {
  return d.dates.map((_, k) => {
    const xs = names.map((n) => stats[n]?.[k]?.med).filter(fin)
    if (!xs.length) return null
    return how === "max" ? Math.max(...xs) : xs.reduce((a, b) => a + b, 0) / xs.length
  })
}
/** Where and when a per-location daily series peaks. */
function peakAt(d: Briefing, stats: Record<string, { med: N }[]>, names: string[], k0 = 0, k1 = d.dates.length) {
  let best: { v: number; name: string; k: number } | null = null
  for (const n of names) for (let k = k0; k < k1; k++) {
    const v = stats[n]?.[k]?.med
    if (fin(v) && (!best || v > best.v)) best = { v, name: n, k }
  }
  return best
}
const inch = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1))

export function hazardVisuals(d: Briefing): Partial<Record<HazardTab, Visual>> {
  const names = d.points.map((p) => p.name)
  const inRegion = (rid: string) => d.points.filter((p) => p.region === rid).map((p) => p.name)
  const passes = d.points.filter((p) => p.kind === "pass").map((p) => p.name)
  const out: Partial<Record<HazardTab, Visual>> = {}
  const rain = dayStats(d, "precipitation_sum")

  // precip: the 7-day regional medians, and each region's daily rain
  const w7 = d.windows.find((w) => w.days === 7) ?? d.windows[d.windows.length - 1]
  const regs = w7?.regions ?? []
  if (regs.length) {
    const [a, ...rest] = regs
    out.precip = {
      value: inch(a.median), unit: "in", caption: `${a.region}, ${w7.label.toLowerCase()}`,
      aside: rest.map((r) => `${r.region} ${inch(r.median)} in`).join(" · ") || undefined,
      spark: { unit: "in", series: d.regions.map((r, i) => ({ values: across(d, rain, inRegion(r.id), "mean"), color: i === 0 ? "var(--wwa)" : "var(--nwor)", label: r.short })) },
    }
  }

  // flooding: the atmospheric river the models agree on, else the wettest 3 days at one place
  const eps = arEpisodes(d).filter((e) => e.agreed >= 1).sort((a, b) => b.agreed - a.agreed || a.start - b.start)
  const daily = across(d, rain, names, "max")
  const sparkFlood: Spark = { unit: "in", series: [{ values: daily, color: "var(--wwa)" }], threshold: { value: 1.25, label: "1.25″ heavy rain" } }
  if (eps.length) {
    const e = eps[0]
    out.flood = { value: `AR${e.agreed}`, caption: `${e.point}, ${day(e.start)}–${day(e.end)}`, aside: "Atmospheric river both models reach", spark: sparkFlood }
  } else {
    let best: { v: number; name: string; k: number } | null = null
    for (const n of names) for (let k = 0; k + 2 < d.dates.length; k++) {
      const xs = [0, 1, 2].map((j) => rain[n]?.[k + j]?.med)
      if (xs.every(fin)) { const v = (xs as number[]).reduce((a, b) => a + b, 0); if (!best || v > best.v) best = { v, name: n, k } }
    }
    if (best) out.flood = { value: inch(best.v), unit: "in", caption: `3 days at ${best.name} from ${day(dayOf(d, best.k))}`, aside: "Wettest 3 days at one location", spark: sparkFlood }
  }

  // wind: the strongest median gust anywhere, and each day's strongest
  const gust = dayStats(d, "wind_gusts_10m_max")
  const g = peakAt(d, gust, names)
  if (g) out.wind = {
    value: Math.round(g.v).toString(), unit: "mph", caption: `${g.name}, ${day(dayOf(d, g.k))}`, aside: "Strongest gust, model median",
    spark: { unit: "mph", series: [{ values: across(d, gust, names, "max"), color: "#4b98b8" }], threshold: { value: 45, label: "45 mph" } },
  }

  // snow: the snowiest pass over the period, and each day's snowiest pass
  const snow = dayStats(d, "snowfall_sum")
  if (passes.length) {
    // the whole period, matching the chart (pass snow often comes late in the two weeks)
    const tot = passes.map((n) => ({ n, v: (snow[n] ?? []).map((s) => s.med).filter(fin).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.v - a.v)[0]
    out.snow = {
      value: inch(tot.v), unit: "in", caption: `${tot.n}, next ${d.dates.length} days`, aside: "Most snow at a pass, model median",
      spark: { unit: "in", series: [{ values: across(d, snow, passes, "max"), color: "#6553cf" }] },
    }
  }

  // temperature: the first region's highs vs normal, and its daily departure
  const td = d.tempDeparture
  const r0 = d.regions[0]
  if (td && r0) {
    const w = td.windows.find((x) => x.days === 7) ?? td.windows[0]
    const hi = w?.regions[r0.id]?.tmax, lo = w?.regions[r0.id]?.tmin
    if (fin(hi)) {
      const sgn = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v))}`
      out.temp = {
        value: `${sgn(hi)}°`, caption: `${r0.name} highs vs normal, ${w.label.toLowerCase()}`, aside: fin(lo) ? `Lows ${sgn(lo)}°` : undefined,
        spark: { unit: "°F", diverging: true, series: [{ values: (td.regions[r0.id]?.tmax ?? []).slice(0, d.dates.length), color: "" }] },
      }
    }
  }
  return out
}

/** 14 small bars (one series, or side by side), an optional dashed threshold, first and last day. */
export function SparkBars({ spark, dates }: { spark: Spark; dates: string[] }) {
  const n = dates.length
  const W = 100, H = 34
  const all = spark.series.flatMap((s) => s.values).filter(fin)
  if (!all.length) return null
  const ns = spark.series.length
  const slot = W / n, gap = slot * 0.22, bw = (slot - gap) / ns
  let bars: React.ReactNode[] = []
  if (spark.diverging) {
    // zero sits where the data needs it: at the bottom when nothing is below normal (so the bars
    // stand on the same baseline as the other cards'), in the middle when it's split evenly
    const up = Math.max(0, ...all), down = Math.max(0, ...all.map((v) => -v))
    const m = Math.max(4, up + down)                  // the span drawn, top to bottom
    const y0 = (H * (m - down)) / m                    // zero: the bottom edge when nothing is below normal
    bars = spark.series[0].values.map((v, k) => {
      if (!fin(v)) return null
      const h = Math.max(0.6, (Math.abs(v) / m) * (H - 1))
      return <rect key={k} x={k * slot + gap / 2} y={v >= 0 ? y0 - h : y0} width={slot - gap} height={h} rx={0.6}
                   fill={v >= 0 ? "#d6604d" : "#4393c3"} opacity={Math.abs(v) < 2 ? 0.45 : 0.9} />
    })
    bars.push(<line key="z" x1={0} x2={W} y1={y0} y2={y0} stroke="var(--border)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />)
  } else {
    const top = Math.max(...all, spark.threshold ? spark.threshold.value * 1.15 : 0) || 1
    bars = spark.series.flatMap((s, i) => s.values.map((v, k) => {
      if (!fin(v)) return null
      const h = Math.max(v > 0 ? 0.8 : 0, (v / top) * (H - 1))
      return <rect key={`${i}-${k}`} x={k * slot + gap / 2 + i * bw} y={H - h} width={bw} height={h} rx={0.6} fill={s.color} />
    }))
    if (spark.threshold) {
      const y = H - (spark.threshold.value / top) * (H - 1)
      bars.push(<line key="t" x1={0} x2={W} y1={y} y2={y} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" opacity={0.7} />)
    }
  }
  const lab = (iso: string) => day(Date.parse(`${iso}T20:00:00Z`))
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-9 w-full overflow-visible" aria-hidden>{bars}</svg>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>{lab(dates[0])}</span>
        {spark.threshold && <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed border-muted-foreground/70" />{spark.threshold.label}</span>}
        {spark.series.length > 1 && (
          <span className="flex items-center gap-2">
            {spark.series.map((s) => <span key={s.label} className="flex items-center gap-1"><span className="size-2 rounded-[2px]" style={{ background: s.color }} />{s.label}</span>)}
          </span>
        )}
        <span>{lab(dates[n - 1])}</span>
      </div>
    </div>
  )
}
