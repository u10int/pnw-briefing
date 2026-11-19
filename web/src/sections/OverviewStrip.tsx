import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dayLabel, dayStats } from "@/sections/DayMatrix"
import { summarize } from "@/sections/Hazards"
import type { Briefing, ImpactEvent } from "@/types"

/** The hazard rows, in this order, and which impact events each shows. */
const ROWS: { key: string; label: string; match: (h: string) => boolean }[] = [
  { key: "wind", label: "Strong gusts", match: (h) => h === "wind" },
  { key: "rain", label: "Heavy rain", match: (h) => h === "heavy_rain_24h" },
  { key: "flood", label: "Flood risk", match: (h) => h === "heavy_rain_72h" },
  { key: "snow", label: "Snow", match: (h) => h.startsWith("snow") },
  { key: "temp", label: "Freeze or heat", match: (h) => /freez|heat|cold/.test(h) },
]
const inDay = (e: ImpactEvent, d: string) => e.start <= d && d <= e.end
const lvl = (es: ImpactEvent[]) => (es.some((e) => e.level === "likely") ? "likely" : es.length ? "possible" : null)

/** The headline's hazard as an impact event: the family the headline names (wind, rain, snow…),
 *  else the summary cards' most severe that has one. One in the next few days (as the headline
 *  is) wins over a later one in any family; within a family, likely first, then the earliest.
 *  A river-flooding headline names no impact event (it's about gauges), so it falls through to
 *  the cards, as does a high-surf one (near-term hazards only). */
export function leadEvent(data: Briefing): ImpactEvent | null {
  const RANK = { alert: 2, watch: 1, quiet: 0 } as const
  const fam: Record<string, string[]> = { wind: ["wind"], coast: ["wind"], precip: ["rain"], flood: ["flood", "rain"], snow: ["snow"], temp: ["temp"] }
  const h = (data.summary?.headline ?? "").toLowerCase()
  const named = /\brivers?\b/.test(h) && !/atmospheric river/.test(h) ? [] : /wind|gust/.test(h) ? ["wind"] : /atmospheric river|flood/.test(h) ? ["flood", "rain"] : /rain/.test(h) ? ["rain", "flood"]
    : /snow/.test(h) ? ["snow"] : /freez|heat|cold|warm/.test(h) ? ["temp"] : []
  const order = [...named, ...summarize(data).filter((s) => s.tone !== "quiet").sort((a, b) => RANK[b.tone] - RANK[a.tone]).flatMap((s) => fam[s.tab] ?? [])]
  // the headline's near term: through three days after the issue date (Pacific)
  const day0 = new Date(data.meta.issued)
  const near = new Date(day0.getTime() + 3 * 86400e3).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
  const soon = (e: ImpactEvent) => (e.start <= near ? 0 : 1)
  // a family's event in the next few days before any later one, then likely first, then earliest
  // a high-surf headline (about the coast's waves, not an impact event) only takes a hazard in the
  // same few days, so the bar never points at something a week or more out
  const passes = /surf|waves?\b/.test(h) && !named.length ? [true] : [true, false]
  for (const nearOnly of passes) for (const k of order) {
    const row = ROWS.find((r) => r.key === k)!
    const es = data.events.filter((e) => row.match(e.hazard) && (!nearOnly || soon(e) === 0))
      .sort((a, b) => soon(a) - soon(b) || (a.level === b.level ? 0 : a.level === "likely" ? -1 : 1) || a.start.localeCompare(b.start))
    if (es[0]) return es[0]
  }
  return null
}

// ------------------------------------------------------------------ model uncertainty

/** How far apart the models are on a day: at each location, the spread of the middle half of the
 *  models (interquartile range) in daily rain and in the high and low, each against a reference
 *  (0.35″ of rain, 10°F: models typically differ by 3 – 4°F even tomorrow), the larger of the two; averaged over the locations. 0 is agreement, 1 and
 *  up is a wide spread. Needs three models at a location. */
const UNC_REF = { rain: 0.35, temp: 10 }
const UNC_LEVELS: { at: number; label: string; color: string }[] = [
  { at: 0, label: "Low", color: "#f3eee4" },
  { at: 0.35, label: "Moderate", color: "#ecd3a3" },
  { at: 0.6, label: "High", color: "#dd9c4c" },
  { at: 0.9, label: "Very high", color: "#b5611c" },
]
const uncLevel = (v: number) => [...UNC_LEVELS].reverse().find((l) => v >= l.at)!
function quartiles(xs: number[]) {
  const a = [...xs].sort((x, y) => x - y), q = (p: number) => {
    const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i)
    return a[lo] + (a[hi] - a[lo]) * (i - lo)
  }
  return [q(0.25), q(0.75)] as const
}
interface DayUnc { score: number; rain: number; temp: number; models: number }
function uncertainty(data: Briefing, point?: string): (DayUnc | null)[] {
  const pts = point ? data.points.filter((p) => p.name === point) : data.points
  return data.dates.map((_, k) => {
    const per: { s: number; r: number; t: number; n: number }[] = []
    for (const p of pts) {
      const vals = (key: "precipitation_sum" | "temperature_2m_max" | "temperature_2m_min") =>
        data.models.map((m) => m.data[p.name]?.[key]?.[k]).filter((x): x is number => typeof x === "number" && Number.isFinite(x))
      const pr = vals("precipitation_sum")
      if (pr.length < 3) continue
      const [p25, p75] = quartiles(pr)
      const iqr = (xs: number[]) => (xs.length >= 3 ? (([a, b]) => b - a)(quartiles(xs)) : 0)
      const t = Math.max(iqr(vals("temperature_2m_max")), iqr(vals("temperature_2m_min")))
      const r = p75 - p25
      per.push({ s: Math.max(r / UNC_REF.rain, t / UNC_REF.temp), r, t, n: pr.length })
    }
    if (!per.length) return null
    const avg = (f: (x: (typeof per)[number]) => number) => per.reduce((a, x) => a + f(x), 0) / per.length
    return { score: avg((x) => x.s), rain: avg((x) => x.r), temp: avg((x) => x.t), models: Math.round(avg((x) => x.n)) }
  })
}

/** The two weeks at a glance: each region's daily rain (model median, averaged over its
 *  locations) as paired bars, and above them a row per hazard with a mark on each day it's
 *  flagged (filled: likely, ring: possible). The headline's hazard days are shaded. */
export function OverviewStrip({ data, point }: { data: Briefing; point?: string }) {
  const pts = React.useMemo(() => (point ? data.points.filter((p) => p.name === point) : data.points), [data, point])
  const rain = React.useMemo(() => {
    const st = dayStats(data, "precipitation_sum")
    const byPoint = Object.fromEntries(pts.map((p) => [p.name, st[p.name].map((s) => s.med)]))
    // the whole area (or the one location): the mean across its locations of the daily model median
    return data.dates.map((_, k) => {
      const xs = pts.map((p) => byPoint[p.name][k]).filter((x): x is number => x != null)
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
    })
  }, [data])
  // one location: no headline shading, and only the events that reach it
  const lead = React.useMemo(() => (point ? null : leadEvent(data)), [data, point])
  const unc = React.useMemo(() => uncertainty(data, point), [data, point])
  const dates = data.dates
  const at = (e: ImpactEvent) => !point || e.points.some((x) => x.name === point && x.frac > 0)
  const rows = ROWS.map((r) => ({ ...r, es: data.events.filter((e) => r.match(e.hazard) && at(e)) })).filter((r) => r.es.length)
  const top = Math.max(0.25, ...rain.map((x) => x ?? 0))
  // dot area grows with the amount, up to 18 px across for the wettest day
  const dot = (v: number | null) => (v == null || v < 0.01 ? 0 : 4 + 14 * Math.sqrt(v / top))
  const cols = `var(--lab) repeat(${dates.length}, minmax(0, 1fr))`
  const isLead = (d: string) => !!lead && inDay(lead, d)
  const SHADE = "bg-foreground/[0.06]"

  return (
    <div className="space-y-1.5 pt-2" role="img" aria-label="The next two weeks: daily rain, the days each hazard is flagged, and how far apart the models are each day">
      <div className="grid items-center gap-x-[3px] [--lab:80px] sm:[--lab:100px]" style={{ gridTemplateColumns: cols }}>
        <div className="truncate pr-2 text-xs leading-9 text-muted-foreground">Rain</div>
        {dates.map((d, k) => (
          <Tooltip key={d}>
            <TooltipTrigger asChild>
              <div tabIndex={0} className={`flex h-9 items-center justify-center outline-none focus-visible:bg-muted ${isLead(d) ? SHADE : ""}`}>
                {dot(rain[k]) > 0 && <span className="rounded-full bg-foreground" style={{ width: dot(rain[k]), height: dot(rain[k]) }} />}
              </div>
            </TooltipTrigger>
            <TooltipContent className="space-y-0.5">
              <p className="font-semibold">{dayLabel(d)}</p>
              <p>Rain: {(rain[k] ?? 0).toFixed(2)}″ {point ? "model median" : "on average across the locations"}</p>
              {rows.map((r) => { const l = lvl(r.es.filter((e) => inDay(e, d))); return l && <p key={r.key}>{r.label}: {l}</p> })}
            </TooltipContent>
          </Tooltip>
        ))}
        {rows.map((r) => (
          <React.Fragment key={r.key}>
            <div className="truncate pr-2 text-xs leading-7 text-muted-foreground">{r.label}</div>
            {dates.map((d) => {
              const l = lvl(r.es.filter((e) => inDay(e, d)))
              return (
                <div key={d} className={`flex h-7 items-center justify-center ${isLead(d) ? SHADE : ""}`}>
                  {l && <span className={`size-2.5 rounded-full ${l === "likely" ? "bg-foreground" : "border-[1.5px] border-foreground/70"}`} />}
                </div>
              )
            })}
          </React.Fragment>
        ))}
        {/* model uncertainty: a coloured cell a day, darker where the models are further apart */}
        <div className="truncate pr-2 text-xs leading-8 text-muted-foreground">Uncertainty</div>
        {dates.map((d, k) => {
          const u = unc[k], l = u ? uncLevel(u.score) : null
          return (
            <Tooltip key={d}>
              <TooltipTrigger asChild>
                <div tabIndex={0} className={`flex h-8 items-center outline-none focus-visible:bg-muted ${isLead(d) ? SHADE : ""}`}>
                  <span className="h-5 w-full rounded-[3px]" style={l ? { background: l.color } : { background: "repeating-linear-gradient(135deg, var(--border) 0 2px, transparent 2px 5px)" }} />
                </div>
              </TooltipTrigger>
              <TooltipContent className="space-y-0.5">
                <p className="font-semibold">{dayLabel(d)}</p>
                {u && l ? <>
                  <p>{l.label} uncertainty: the models are {l.at >= 0.6 ? "far apart" : l.at >= 0.35 ? "somewhat apart" : "close"}</p>
                  <p>Rain: the middle half of the models span {u.rain.toFixed(2)}″ on average</p>
                  {u.temp > 0 && <p>Temperature: the middle half span {Math.round(u.temp)}°F</p>}
                  <p className="text-muted-foreground">About {u.models} models a location</p>
                </> : <p>Too few models this far out to judge</p>}
              </TooltipContent>
            </Tooltip>
          )
        })}
        <div />
        {dates.map((d, k) => {
          const t = new Date(`${d}T20:00:00Z`)
          const wd = t.toLocaleDateString("en-US", { weekday: "narrow", timeZone: "America/Los_Angeles" })
          return (
            <div key={d} className="border-t pt-1.5 text-center text-[11px] leading-tight text-muted-foreground tabular-nums">
              {k === 0 ? <span className="font-medium text-foreground"><span className="sm:hidden">{wd}</span><span className="max-sm:hidden">Today</span></span> : wd}
              <span className="block max-sm:hidden">{t.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "America/Los_Angeles" })}</span>
            </div>
          )
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        <span className="mr-1 inline-block size-2 rounded-full bg-foreground align-middle" /> likely
        <span className="mr-1 ml-3 inline-block size-2 rounded-full border-[1.5px] border-foreground/70 align-middle" /> possible
        {lead && <><span className={`mr-1 ml-3 inline-block h-2.5 w-3 align-middle ${SHADE}`} /> the headline's days</>}
        <span className="ml-3 inline-flex items-center gap-1 align-middle">
          Uncertainty {UNC_LEVELS.map((l) => <span key={l.label} className="inline-block h-2.5 w-3 rounded-[2px]" style={{ background: l.color }} title={l.label} />)}
          <span>low to very high</span>
        </span>
        <span className="ml-3">Rain dots grow with the day's amount ({point ? "the model median" : "the average of every location's model median"}; largest {top.toFixed(2)}″).</span>
      </p>
    </div>
  )
}

/** How many models agree on the headline's hazard: one segment per model, filled for each that
 *  reaches the threshold. */
export function AgreementBar({ data }: { data: Briefing }) {
  const e = leadEvent(data)
  if (!e || !e.n_models) return null
  const k = Math.round(e.agreement * e.n_models)
  const when = e.start === e.end ? dayLabel(e.start) : `${dayLabel(e.start)} – ${dayLabel(e.end)}`
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
      <span className="text-muted-foreground">Model agreement</span>
      <span className="flex gap-[3px]" aria-hidden>
        {Array.from({ length: e.n_models }, (_, i) => <span key={i} className={`h-2.5 w-3 rounded-[2px] ${i < k ? "bg-foreground" : "bg-border"}`} />)}
      </span>
      <span><span className="font-semibold tabular-nums">{k} of {e.n_models}</span> models reach {e.label.toLowerCase()} {when}</span>
    </div>
  )
}
