import * as React from "react"

import { Takeaway, dayOf } from "@/components/Takeaway"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dayStats } from "@/sections/DayMatrix"
import type { Briefing, ClimoPoint, N } from "@/types"

export interface Rank { rank: number; of: number; since: number | null; first: number; pct: number }

/** Where a total ranks among a station's past years over the same part of the year: its place
 *  (1 = wettest), the latest year at least as wet, and the share of years it beats. */
export function rankAgainst(c: ClimoPoint, n: number, v: number): Rank | null {
  const xs = c.years.map((y, i) => [y, c.max[String(n)]?.[i] ?? null] as const).filter((x): x is readonly [number, number] => x[1] != null)
  if (xs.length < 10) return null
  const wetter = xs.filter(([, x]) => x >= v)
  return {
    rank: wetter.length + 1, of: xs.length, first: xs[0][0],
    since: wetter.length ? Math.max(...wetter.map(([y]) => y)) : null,
    pct: (100 * xs.filter(([, x]) => x < v).length) / xs.length,
  }
}

const SPAN_WORD: Record<number, string> = { 1: "day", 3: "3 days", 7: "7 days" }
/** "the most since 2007", "the most on record (since 1907)", "the 12th most of 76 years". */
export function rankText(r: Rank) {
  if (r.since == null) return `the most on record (since ${r.first})`
  if (r.pct >= 75) return `the most since ${r.since}`
  return r.pct >= 50 ? "wetter than most years" : "about typical or drier"
}
const short = (r: Rank) => (r.since == null ? "Record" : r.pct >= 75 ? `Most since ${r.since}` : r.pct >= 50 ? "Top half" : "\u00a0")
/** A faint tint for the top quarter, stronger for the top tenth and records. */
const tint = (r: Rank | null): React.CSSProperties | undefined =>
  !r || r.pct < 75 ? undefined : { background: `color-mix(in srgb, var(--wetter) ${r.since == null ? 30 : r.pct >= 90 ? 20 : 10}%, transparent)` }

/** The wettest n-day stretch in a daily series: its total and the index of its first day. */
function wettest(xs: N[], n: number) {
  let best: { v: number; i: number } | null = null
  for (let i = 0; i + n <= xs.length; i++) {
    const w = xs.slice(i, i + n)
    if (w.some((x) => x == null)) continue
    const v = (w as number[]).reduce((a, b) => a + b, 0)
    if (!best || v > best.v) best = { v, i }
  }
  return best
}
const fmt = (v: number) => `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}″`

/** How the forecast's wettest 1-, 3- and 7-day stretches, and the last two weeks' observed ones,
 *  rank against each location's station history for this part of the year. */
export function UnusualCard({ data }: { data: Briefing }) {
  const c = data.climo
  const stats = React.useMemo(() => dayStats(data, "precipitation_sum"), [data])
  if (!c) return null
  const spans = c.spans.length ? c.spans : [1, 3, 7]
  const obs = data.observed
  const odates = obs?.dates ?? []
  const recent = Math.max(0, odates.length - 14)

  const rows = data.points.filter((p) => c.points[p.name]).map((p) => {
    const h = c.points[p.name]
    const med = stats[p.name]?.map((s) => s.med) ?? []
    const fc = spans.map((n) => {
      const w = wettest(med, n)
      return w && w.v >= 0.05 ? { n, ...w, r: rankAgainst(h, n, w.v), from: data.dates[w.i], to: data.dates[w.i + n - 1] } : null
    })
    const ob = (() => {
      const xs = obs?.daily[p.name]?.slice(recent)
      const w = xs && wettest(xs, 3)
      return w && w.v >= 0.05 ? { n: 3, ...w, r: rankAgainst(h, 3, w.v), from: odates[recent + w.i], to: odates[recent + w.i + 2] } : null
    })()
    return { p, h, fc, ob }
  })
  if (!rows.length) return null

  // the takeaway: the forecast stretch that ranks highest (ties to the larger total)
  const all = rows.flatMap((r) => r.fc.filter((x) => x?.r).map((x) => ({ name: r.p.name, x: x! })))
  const top = all.sort((a, b) => b.x.r!.pct - a.x.r!.pct || b.x.v - a.x.v)[0]
  const span = (x: { from: string; to: string; n: number }) => (x.n === 1 ? dayOf(x.from) : `${dayOf(x.from)} – ${dayOf(x.to)}`)
  const takeaway = !top ? null : top.x.r!.pct < 75
    ? <>Nothing unusual: no location's forecast reaches the wettest quarter of past years for this time of year.</>
    : <>Most unusual: {top.name}'s wettest {SPAN_WORD[top.x.n]} forecast, {fmt(top.x.v)} ({span(top.x)}), would be {rankText(top.x.r!)} at this time of year.</>

  const Cell = ({ x, h }: { x: (typeof rows)[number]["fc"][number]; h: ClimoPoint }) => {
    if (!x) return <td className="border-t px-2 py-1.5 text-center text-muted-foreground">–</td>
    return (
      <td className="border-t px-2 py-1.5 text-center" style={tint(x.r)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div tabIndex={0} className="cursor-default outline-none">
              <div className="font-medium tabular-nums">{fmt(x.v)}</div>
              <div className={`text-[11px] ${x.r && x.r.pct >= 75 ? "font-medium text-foreground" : "text-muted-foreground"}`}>{x.r ? short(x.r) : "–"}</div>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs space-y-1">
            <p className="font-semibold">{span(x)}: {fmt(x.v)} over {SPAN_WORD[x.n]}</p>
            {x.r && <p>Against {h.station}'s {x.r.of} years ({x.r.first} – {h.years[h.years.length - 1]}), {c.from.replace("-", "/")} – {c.to.replace("-", "/")}: {rankText(x.r)}; wetter than {Math.round(x.r.pct)}% of them.</p>}
          </TooltipContent>
        </Tooltip>
      </td>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>How unusual is it?</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription>
          The forecast's wettest day, 3 days and 7 days at each location (the model median), and the wettest 3 days observed over the last two weeks (MRMS), against the location's station record: the wettest stretch of the same length in each past year between {c.from.replace("-", "/")} and {c.to.replace("-", "/")}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium">Location</th>
                {spans.map((n) => <th key={n} className="px-2 py-2 text-center font-medium">Forecast<span className="block font-normal">wettest {SPAN_WORD[n]}</span></th>)}
                {obs && <th className="px-2 py-2 text-center font-medium">Observed<span className="block font-normal">wettest 3 days, last 2 weeks</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, h, fc, ob }) => (
                <tr key={p.name}>
                  <th scope="row" className="sticky left-0 z-10 border-t bg-card px-2 py-1.5 text-left font-normal whitespace-nowrap">
                    {p.name}
                    <span className="block text-[11px] text-muted-foreground">{h.station}, {h.years[0]} –</span>
                  </th>
                  {fc.map((x, i) => <Cell key={i} x={x} h={h} />)}
                  {obs && <Cell x={ob} h={h} />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Unlabelled totals are in the drier half of past years. "Most since" is the latest year with a stretch at least as wet in that part of the year; tinted cells are in the wettest quarter of years, stronger for the wettest tenth and records.
          A station is a single gauge and the forecast a grid-cell median, so treat close calls loosely. Stations are listed under each location; {c.source}.
        </p>
      </CardContent>
    </Card>
  )
}
