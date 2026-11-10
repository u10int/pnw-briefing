import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dayLabel, dayStats, regionDays } from "@/sections/DayMatrix"
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
const REGION_COLOR = ["var(--wwa)", "var(--nwor)"]
const inDay = (e: ImpactEvent, d: string) => e.start <= d && d <= e.end
const lvl = (es: ImpactEvent[]) => (es.some((e) => e.level === "likely") ? "likely" : es.length ? "possible" : null)

/** The headline's hazard as an impact event: the family the headline names (wind, rain, snow…),
 *  else the summary cards' most severe that has one; within it, likely first, then the most models. */
export function leadEvent(data: Briefing): ImpactEvent | null {
  const RANK = { alert: 2, watch: 1, quiet: 0 } as const
  const fam: Record<string, string[]> = { wind: ["wind"], coast: ["wind"], precip: ["rain"], flood: ["flood", "rain"], snow: ["snow"], temp: ["temp"] }
  const h = (data.summary?.headline ?? "").toLowerCase()
  const named = /wind|gust/.test(h) ? ["wind"] : /atmospheric river|flood/.test(h) ? ["flood", "rain"] : /rain/.test(h) ? ["rain", "flood"]
    : /snow/.test(h) ? ["snow"] : /freez|heat|cold|warm/.test(h) ? ["temp"] : []
  const order = [...named, ...summarize(data).filter((s) => s.tone !== "quiet").sort((a, b) => RANK[b.tone] - RANK[a.tone]).flatMap((s) => fam[s.tab] ?? [])]
  for (const k of order) {
    const row = ROWS.find((r) => r.key === k)!
    const es = data.events.filter((e) => row.match(e.hazard))
      .sort((a, b) => (a.level === b.level ? 0 : a.level === "likely" ? -1 : 1) || a.start.localeCompare(b.start))
    if (es[0]) return es[0]
  }
  return null
}

/** The two weeks at a glance: each region's daily rain (model median, averaged over its
 *  locations) as paired bars, and above them a row per hazard with a mark on each day it's
 *  flagged (filled: likely, ring: possible). The headline's hazard days are shaded. */
export function OverviewStrip({ data }: { data: Briefing }) {
  const rain = React.useMemo(() => {
    const st = dayStats(data, "precipitation_sum")
    const byPoint = Object.fromEntries(data.points.map((p) => [p.name, st[p.name].map((s) => s.med)]))
    return data.regions.map((r) => regionDays(data, r.id, byPoint))
  }, [data])
  const lead = React.useMemo(() => leadEvent(data), [data])
  const dates = data.dates
  const rows = ROWS.map((r) => ({ ...r, es: data.events.filter((e) => r.match(e.hazard)) })).filter((r) => r.es.length)
  const top = Math.max(0.25, ...rain.flat().map((x) => x ?? 0))
  const H = 44
  const cols = `var(--lab) repeat(${dates.length}, minmax(0, 1fr))`
  const isLead = (d: string) => !!lead && inDay(lead, d)
  const SHADE = "bg-foreground/[0.06]"

  return (
    <div className="space-y-1.5 pt-2" role="img" aria-label="The next two weeks: daily rain by region and the days each hazard is flagged">
      <div className="grid items-center gap-x-[3px] [--lab:76px] sm:[--lab:92px]" style={{ gridTemplateColumns: cols }}>
        {rows.map((r) => (
          <React.Fragment key={r.key}>
            <div className="truncate pr-2 text-[11px] leading-5 text-muted-foreground">{r.label}</div>
            {dates.map((d) => {
              const l = lvl(r.es.filter((e) => inDay(e, d)))
              return (
                <div key={d} className={`flex h-5 items-center justify-center ${isLead(d) ? SHADE : ""}`}>
                  {l && <span className={`size-2 rounded-full ${l === "likely" ? "bg-foreground" : "border-[1.5px] border-foreground/70"}`} />}
                </div>
              )
            })}
          </React.Fragment>
        ))}
        <div className="pr-2 text-[11px] leading-tight text-muted-foreground">Rain
          <span className="mt-0.5 flex flex-col gap-0.5">{data.regions.map((r, i) => (
            <span key={r.id} className="inline-flex items-center gap-1"><span className="size-2 rounded-[2px]" style={{ background: REGION_COLOR[i] }} />{r.short}</span>
          ))}</span>
        </div>
        {dates.map((d, k) => (
          <Tooltip key={d}>
            <TooltipTrigger asChild>
              <div tabIndex={0} className={`flex items-end justify-center gap-px border-b outline-none focus-visible:bg-muted ${isLead(d) ? SHADE : ""}`} style={{ height: H }}>
                {rain.map((xs, i) => (
                  <span key={i} className="w-full max-w-[9px] rounded-t-[2px]" style={{ height: `${Math.max(xs[k] ? 1.5 : 0, (H * (xs[k] ?? 0)) / top)}px`, background: REGION_COLOR[i] }} />
                ))}
              </div>
            </TooltipTrigger>
            <TooltipContent className="space-y-0.5">
              <p className="font-semibold">{dayLabel(d)}</p>
              {data.regions.map((r, i) => <p key={r.id}>{r.name}: {(rain[i][k] ?? 0).toFixed(2)}″</p>)}
              {rows.map((r) => { const l = lvl(r.es.filter((e) => inDay(e, d))); return l && <p key={r.key}>{r.label}: {l}</p> })}
            </TooltipContent>
          </Tooltip>
        ))}
        <div />
        {dates.map((d, k) => {
          const t = new Date(`${d}T20:00:00Z`)
          const wd = t.toLocaleDateString("en-US", { weekday: "narrow", timeZone: "America/Los_Angeles" })
          return (
            <div key={d} className="pt-1 text-center text-[10.5px] leading-tight text-muted-foreground tabular-nums">
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
        <span className="ml-3">Rain is each region's daily model median, up to {top.toFixed(top < 1 ? 2 : 1)}″.</span>
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
