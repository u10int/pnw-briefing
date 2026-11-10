import * as React from "react"

import { MapButton } from "@/components/MapButton"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ptDay, ptDayHour, ptParts } from "@/lib/format"
import { GUST } from "@/lib/ramps"
import { rampCell } from "@/sections/DayMatrix"
import { openLocation } from "@/lib/locationlink"
import type { Briefing, LightPeriod, PeakPeriod } from "@/types"

type Var = "gust" | "precip" | "snow"

const hourOnly = (t: string) => ptDayHour(t).replace(/^\S+ \S+ /, "")
/** "Sat 11/7 4 – 10 PM", "Sat 11/7 10 PM – Sun 11/8 3 AM". */
export function hourRange(a: string, b: string) {
  if (a === b) return ptDayHour(a)
  const same = ptParts(a).md === ptParts(b).md
  return same ? `${ptDayHour(a)} – ${hourOnly(b)}` : `${ptDayHour(a)} – ${ptDayHour(b)}`
}
const peakText = (v: Var, e: PeakPeriod) =>
  v === "gust" ? `${Math.round(e.peak)} mph` : v === "snow" ? `${e.peak.toFixed(1)} in/h${e.heavy ? " (heavy)" : ""}` : `${e.peak.toFixed(2)} in/h${e.heavy ? " (heavy)" : ""}`
/** When the models put their own peaks, if they differ. */
const spread = (e: PeakPeriod) =>
  e.peakFrom && e.peakTo && e.peakFrom !== e.peakTo ? `models peak ${hourRange(e.peakFrom, e.peakTo)}` : null

/** The peak hour, with its day when the period runs over more than one. */
const peakAt = (e: PeakPeriod) => (ptParts(e.start).md === ptParts(e.end).md ? hourOnly(e.peakTime) : ptDayHour(e.peakTime))

/** One line for a period: "Sat 11/7 4 – 10 PM, peaking near 7 PM at 48 mph". */
export function periodLine(v: Var, e: PeakPeriod) {
  return `${hourRange(e.start, e.end)}, peaking near ${peakAt(e)} at ${peakText(v, e)}`
}

const HOUR = 3600e3
export const WINDOW_H = 36
/** The short-term window: from the briefing's hour to 36 hours later. */
export function timingWindow(data: Briefing) {
  const t0 = Math.floor(Date.parse(data.meta.issued) / HOUR) * HOUR
  return { t0, t1: t0 + WINDOW_H * HOUR }
}
/** A period's span on the axis: precipitation rates are for the hour ending at each time, gusts
 *  are the value at it. */
const spanOf = (v: Var, e: { start: string; end: string }) => {
  const s = Date.parse(e.start), x = Date.parse(e.end)
  return v === "gust" ? [s - HOUR / 2, x + HOUR / 2] : [s - HOUR, x]
}
/** Periods that reach into the window. */
export function inWindow<T extends { start: string; end: string }>(data: Briefing, v: Var, list: T[] | undefined): T[] {
  const { t0, t1 } = timingWindow(data)
  return (list ?? []).filter((e) => { const [a, b] = spanOf(v, e); return b > t0 && a < t1 })
}

/** The current time: a red line, so it can't be mistaken for a peak marker. */
const NOW = "#e5484d"
/** Light: any measurable amount; moderate: over the threshold; heavy: heavy at its peak. */
const BARS = {
  precip: { light: "#e3eefa", moderate: "#9cc5ef", heavy: "#2563c9", ink: "#10243f" },
  snow: { light: "#ece8f8", moderate: "#b9a8ea", heavy: "#6142c4", ink: "#221446" },
}
const barStyle = (v: Var, e: PeakPeriod): React.CSSProperties =>
  v === "gust" ? rampCell(e.peak, GUST) : { background: e.heavy ? BARS[v].heavy : BARS[v].moderate, color: e.heavy ? "#fff" : BARS[v].ink }
const lightText = (v: Var, e: LightPeriod) =>
  `${hourRange(e.start, e.end)}: ${v === "snow" ? `about ${e.total.toFixed(1)}″ of snow` : `about ${e.total.toFixed(2)}″`}, peaking near ${ptDayHour(e.peakTime)} at ${v === "snow" ? e.peak.toFixed(1) : e.peak.toFixed(2)} in/h`

/** Locations where gusts or precipitation reach their threshold in the next 36 hours, as bars on
 *  a shared Pacific-time axis: how long it lasts, when it peaks (the tick), and how strong. */
export function PeakTimingCard({ data, v }: { data: Briefing; v: Var }) {
  const t = data.timing
  const ref = React.useRef<HTMLDivElement>(null)
  const [px, setPx] = React.useState(700)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([x]) => setPx(x.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [t])
  if (!t) return null
  const { t0, t1 } = timingWindow(data)
  const anyKey = v === "precip" ? "precipAny" : v === "snow" ? "snowAny" : null
  const rows = data.points.map((p) => ({ p, es: inWindow(data, v, t.points[p.name]?.[v]), light: anyKey ? inWindow(data, v, t.points[p.name]?.[anyKey]) : [] }))
    .filter((r) => r.es.length || r.light.length)
  const th = t.thresholds
  const pct = (x: number) => (100 * (Math.min(Math.max(x, t0), t1) - t0)) / (t1 - t0)
  // axis: Pacific midnights (day lines) and every 6 hours (ticks)
  const ticks: number[] = []
  for (let x = t0; x <= t1; x += HOUR) if (+ptParts(x).x.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/Los_Angeles" }) % 6 === 0) ticks.push(x)
  const isMidnight = (x: number) => ptDayHour(x).endsWith("12 AM")
  const tickLabel = (x: number) => { const h = hourOnly(new Date(x).toISOString()); return h === "12 AM" ? "Midnight" : h === "12 PM" ? "Noon" : h }
  const now = Date.now()
  const nowAt = now > t0 && now < t1 ? pct(now) : null
  const lines = (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {ticks.map((x) => <div key={x} className={`absolute inset-y-0 border-l ${isMidnight(x) ? "border-border" : "border-dashed border-border/60"}`} style={{ left: `${pct(x)}%` }} />)}
      {nowAt != null && <div className="absolute inset-y-0 border-l-2" style={{ left: `${nowAt}%`, borderColor: NOW }} />}
    </div>
  )
  const what = v === "gust"
    ? `gusts reach ${th.gust_mph.lowland} mph in the lowlands, ${th.gust_mph.coast} on the coast or ${th.gust_mph.pass} at the passes`
    : v === "snow" ? `snow falls, with the bars where it comes at ${th.snow_in_per_h ?? 0.5}″ an hour or more (${th.heavy_snow_in_per_h ?? 1}″+ is heavy)`
    : `precipitation falls, with the bars where it comes at ${th.rate_in_per_h}″ an hour or more (${th.heavy_in_per_h}″+ is heavy)`
  return (
    <Card>
      <CardHeader>
        <CardTitle>{v === "gust" ? "When the strongest gusts come" : v === "snow" ? "When the heaviest snow comes" : "When the heaviest precipitation comes"}</CardTitle>
        <CardDescription>
          The next {WINDOW_H} hours at the locations where {what}, from the median of {t.models.length} models with hourly output ({t.models.join(", ")}){t.weighted?.length && t.weighted.length < t.models.length ? `, with the high-resolution ones (${t.weighted.join(", ")}) counted double` : ""}. Each bar is how long it lasts and the dot marks the peak{v !== "gust" ? `; the pale fill is when any ${v === "snow" ? "snow" : "precipitation"} falls` : ""}; the red line is now. Hover for details.
        </CardDescription>
        <CardAction>
          {/* the hour-by-hour layer, opened at the strongest peak in the window */}
          <MapButton label={v === "gust" ? "Gusts through time" : v === "snow" ? "Snowfall through time" : "Radar through time"}
            req={{ mode: "hourly", layer: v === "gust" ? "gust" : v === "snow" ? "asnow" : "radar", fallback: v === "precip" ? ["apcp"] : undefined,
                   time: rows.flatMap((r) => r.es).sort((a, b) => b.peak - a.peak)[0]?.peakTime }} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {!rows.length ? <p className="text-sm text-muted-foreground">{v === "gust" ? "No location reaches that" : `No ${v === "snow" ? "snow" : "precipitation"} at any location`} in the next {WINDOW_H} hours.</p> : (
          <div className="space-y-1">
            <div className="grid grid-cols-[7.5rem_1fr] gap-3 sm:grid-cols-[11rem_1fr]">
              <div />
              <div ref={ref} className="relative h-[3.25rem] text-[11px] leading-tight text-muted-foreground">
                {ticks.map((x) => (
                  <span key={x} className={`absolute top-0 -translate-x-1/2 whitespace-nowrap tabular-nums ${isMidnight(x) ? "font-medium text-foreground" : ""}`}
                        style={{ left: `${pct(x)}%`, display: px < 420 && !isMidnight(x) && tickLabel(x) !== "Noon" ? "none" : undefined }}>
                    {isMidnight(x) ? <>{ptDay(x)}<span className="block text-center font-normal text-muted-foreground">Midnight</span></> : <span className="mt-[15px] block">{tickLabel(x)}</span>}
                  </span>
                ))}
                {nowAt != null && (
                  <span className="absolute bottom-0 -translate-x-1/2 rounded-sm px-1 text-[10px] font-semibold leading-4 text-white uppercase" style={{ left: `${nowAt}%`, background: NOW }}>Now</span>
                )}
              </div>
            </div>
            {rows.map(({ p, es, light }) => (
              <div key={p.name} className="grid grid-cols-[7.5rem_1fr] items-center gap-3 border-t py-1 sm:grid-cols-[11rem_1fr]">
                <button type="button" onClick={() => openLocation(p.name)} className="truncate text-left text-sm hover:underline">{p.name}</button>
                <div className="relative h-7">
                  {lines}
                  {light.map((e, i) => {
                    // any amount: a pale band the threshold bars sit on
                    const [a, b] = spanOf(v, e)
                    const l = pct(a), w = Math.max(pct(b) - l, 0)
                    return (
                      <Tooltip key={`l${i}`}>
                        <TooltipTrigger asChild>
                          <div tabIndex={0} aria-label={`${p.name}: ${lightText(v, e)}`}
                            className="absolute top-1/2 h-4 -translate-y-1/2 rounded-[3px] outline-offset-1 focus-visible:outline-2 focus-visible:outline-ring"
                            style={{ left: `${l}%`, width: `max(${w}%, 4px)`, background: BARS[v === "snow" ? "snow" : "precip"].light }} />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs"><p className="font-semibold">{p.name}</p><p>{lightText(v, e)}</p></TooltipContent>
                      </Tooltip>
                    )
                  })}
                  {es.map((e, i) => {
                    const [a, b] = spanOf(v, e)
                    const l = pct(a), w = Math.max(pct(b) - l, 0)
                    // in pixels, with a minimum width so a one-hour bar still shows
                    const lx = (l / 100) * px, wx = Math.max((w / 100) * px, 8)
                    const pkx = ((pct(Date.parse(e.peakTime)) - l) / 100) * px
                    const text = peakText(v, e).replace(" (heavy)", "")
                    const tw = text.length * 6.2
                    const fits = wx >= tw + 22
                    // otherwise the value goes beside the bar: after it, or before it near the right edge,
                    // and not at all if it would run into the next bar (the tooltip still has it)
                    const after = lx + wx + 4 + tw <= px
                    const next = es[i + 1] ? (pct(spanOf(v, es[i + 1])[0]) / 100) * px : Infinity
                    const outside = !fits && (after ? lx + wx + 4 + tw < next - 2 : lx - 4 - tw >= 0)
                    const peakLeft = pkx < wx / 2
                    return (
                      <React.Fragment key={i}>
                      {outside && (
                        <span className="pointer-events-none absolute top-1/2 z-[1] -translate-y-1/2 rounded-sm bg-card px-0.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground tabular-nums"
                          style={after ? { left: lx + wx + 4 } : { right: px - lx + 4 }}>{text}</span>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div tabIndex={0} aria-label={`${p.name}: ${periodLine(v, e)}`}
                            className={`absolute top-1/2 flex h-6 -translate-y-1/2 items-center overflow-hidden rounded-[4px] px-1.5 text-[11px] font-semibold whitespace-nowrap tabular-nums shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] outline-offset-1 focus-visible:outline-2 focus-visible:outline-ring ${peakLeft ? "justify-end" : "justify-start"}`}
                            style={{ left: lx, width: wx, ...barStyle(v, e) }}>
                            {/* the peak: a dot in the bar's text colour (the now line is a red rule) */}
                            {pkx >= 0 && pkx <= wx && (
                              <span className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" style={{ left: Math.min(Math.max(pkx, 4), wx - 4) }} aria-hidden />
                            )}
                            {fits && <span className="relative">{text}</span>}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs space-y-1">
                          <p className="font-semibold">{p.name}</p>
                          <p>{periodLine(v, e)}</p>
                          {v === "precip" && e.total != null && <p>About {e.total.toFixed(2)}″ over the period{e.heavy ? "; heavy at its peak" : ""}</p>}
                          <p className="opacity-80">{e.models} of {e.of} hourly models reach it{spread(e) ? `; ${spread(e)}` : ""}</p>
                        </TooltipContent>
                      </Tooltip>
                      </React.Fragment>
                    )
                  })}
                </div>
              </div>
            ))}
            {v !== "gust" && (
              <div className="flex flex-wrap gap-x-4 pt-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px]" style={{ background: BARS[v].light }} />Any {v === "snow" ? "snow" : "precipitation"}</span>
                <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px]" style={{ background: BARS[v].moderate }} />Moderate ({v === "snow" ? th.snow_in_per_h ?? 0.5 : th.rate_in_per_h}″+ an hour)</span>
                <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px]" style={{ background: BARS[v].heavy }} />Heavy at its peak ({v === "snow" ? th.heavy_snow_in_per_h ?? 1 : th.heavy_in_per_h}″+)</span>
              </div>
            )}
            {v === "gust" && <p className="pt-2 text-xs text-muted-foreground">Bars are coloured by the peak gust, on the same scale as the wind maps.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The location panel's lines: only the periods it has. */
export function PeakTimingLines({ data, name }: { data: Briefing; name: string }) {
  const p = data.timing?.points[name]
  const r = p && { gust: inWindow(data, "gust", p.gust), precip: inWindow(data, "precip", p.precip), snow: inWindow(data, "snow", p.snow) }
  if (!r || (!r.gust.length && !r.precip.length && !r.snow.length)) return null
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">Peak timing, next {WINDOW_H} hours</p>
      <ul className="space-y-1 text-sm">
        {(r.gust ?? []).map((e, i) => <li key={`g${i}`}><span className="text-muted-foreground">Strongest gusts:</span> {periodLine("gust", e)}</li>)}
        {(r.precip ?? []).map((e, i) => <li key={`p${i}`}><span className="text-muted-foreground">Heaviest {e.heavy ? "rain, heavy at times" : "rain"}:</span> {periodLine("precip", e)}</li>)}
        {(r.snow ?? []).map((e, i) => <li key={`s${i}`}><span className="text-muted-foreground">Heaviest {e.heavy ? "snow, heavy at times" : "snow"}:</span> {periodLine("snow", e)}</li>)}
      </ul>
    </div>
  )
}
