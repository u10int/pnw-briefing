import * as React from "react"
import { ChevronRight } from "lucide-react"

import { Takeaway } from "@/components/Takeaway"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ptDay } from "@/lib/format"
import { useNarrow } from "@/sections/DayMatrix"
import { Chg, FLAT, fmt, fmtU, UP_COLOR } from "@/sections/Trends"
import type { Briefing, TrendStat, TrendVar } from "@/types"

const WHAT: Record<TrendVar, string> = { precip: "precipitation total", snow: "snowfall total", gust: "strongest gust", tmax: "average high", tmin: "average low" }
/** One hue per variable: a cell's tint grows with its value against the table's largest. */
const HUE: Record<TrendVar, string> = { precip: "#2563c9", snow: "#6142c4", gust: "#c2410c", tmax: "#c0392b", tmin: "#2c6fbb" }
const temp = (k: TrendVar) => k === "tmax" || k === "tmin"

type Row = { key: string; name: string; group?: boolean; region?: string; vals: (TrendStat | null)[] }

/** How each location's value over a window has moved across the last few briefings, on the dates
 *  they all share: one column per briefing, oldest first, then the change from the oldest. */
export function RunTrendCard({ data, vars }: { data: Briefing; vars: TrendVar[] }) {
  const wins = (data.trendHistory?.windows ?? []).filter((w) => w.points && w.runs.length >= 2)
  const [days, setDays] = React.useState(() => wins.find((w) => w.days === 7)?.days ?? wins[0]?.days ?? 7)
  const [sel, setSel] = React.useState<TrendVar>(vars[0])
  const [open, setOpen] = React.useState<Set<string>>(new Set())
  const narrow = useNarrow()
  const w = wins.find((x) => x.days === days) ?? wins[0]
  const avail = vars.filter((k) => w && Object.values(w.points ?? {}).some((p) => p[k]?.some((s) => s != null && (k !== "snow" || s.median >= 0.1))))
  const k = avail.includes(sel) ? sel : avail[0]
  if (!w || !k) return null
  const nr = w.runs.length

  // region rows: the median across the region's locations isn't stored per run, so use the stored
  // region value (built the same way the trends table's is)
  const rows: Row[] = []
  for (const r of data.regions) {
    const rv = w.regions[r.id]?.[k]
    const pts = data.points.filter((p) => p.region === r.id && w.points?.[p.name]?.[k])
    if (!pts.length) continue
    rows.push({ key: r.id, name: r.name, group: true, vals: (rv ?? []).map((x) => (x == null ? null : { median: x, lo: x, hi: x, n: 0 })) })
    for (const p of pts) rows.push({ key: p.name, name: p.name, region: r.id, vals: w.points![p.name][k]! })
  }
  for (const p of data.points.filter((p) => !p.region && w.points?.[p.name]?.[k])) rows.push({ key: p.name, name: p.name, vals: w.points![p.name][k]! })

  const all = rows.flatMap((r) => r.vals.flatMap((s) => (s ? [s.median] : [])))
  const lo = temp(k) ? Math.min(...all) : 0, hi = Math.max(...all, k === "gust" ? 30 : 0.1)
  const tint = (v: number) => {
    const f = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)))
    return `color-mix(in srgb, ${HUE[k]} ${Math.round(6 + 34 * f)}%, transparent)`
  }
  const first = (r: Row) => r.vals.find((s) => s != null) ?? null
  const last = (r: Row) => r.vals[nr - 1] ?? null
  const change = (r: Row) => { const a = first(r), b = last(r); return a && b ? { now: b.median, prev: a.median, delta: b.median - a.median } : undefined }

  // the takeaway: the biggest move at a location, against how big the value is
  const movers = rows.filter((r) => !r.group).map((r) => ({ r, c: change(r) })).filter((x) => x.c)
    .sort((a, b) => Math.abs(b.c!.delta) - Math.abs(a.c!.delta))
  const top = movers[0]
  const since = w.runs[0] ? ptDay(w.runs[0]) : "the first run"
  const steady = !top || Math.abs(top.c!.delta) < FLAT[k] * (temp(k) ? 4 : k === "gust" ? 5 : 3)
  const takeaway = steady ? <>Steady: no location's {WHAT[k]} has moved much since {since}.</>
    : <>Biggest move: {top.r.name}, {top.c!.delta > 0 ? (temp(k) ? "warmer" : k === "gust" ? "stronger" : "wetter") : (temp(k) ? "cooler" : k === "gust" ? "calmer" : "drier")} by {fmtU(Math.abs(top.c!.delta), k).replace(/^\+/, "")} since {since} ({fmtU(top.c!.prev, k)} → {fmtU(top.c!.now, k)}).</>

  const shown = rows.filter((r) => !narrow || r.group || !r.region || open.has(r.region))
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const runHead = (t: string | null, i: number) => (i === nr - 1 ? "Now" : t ? ptDay(t) : "–")

  return (
    <Card>
      <CardHeader>
        <CardTitle>How the forecast has moved</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription info={<>Each location's {WHAT[k]} in the last {nr} briefings (the median across models), over the {w.nDays} day{w.nDays === 1 ? "" : "s"} they
          all cover ({ptDay(`${w.from}T20:00:00Z`)} – {ptDay(`${w.to}T20:00:00Z`)}), so every column compares the same days. A steady row is a forecast the models have stuck with. Region rows are the region's value as in the trends table. Earlier briefings are each day's 12Z edition.</>}>
          How the forecast has changed over the last {nr} briefings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {avail.length > 1 && (
            <Tabs value={k} onValueChange={(x) => setSel(x as TrendVar)}>
              <TabsList>{avail.map((x) => <TabsTrigger key={x} value={x}>{x === "precip" ? "Rain" : x === "snow" ? "Snow" : x === "gust" ? "Gusts" : x === "tmax" ? "Highs" : "Lows"}</TabsTrigger>)}</TabsList>
            </Tabs>
          )}
          {wins.length > 1 && (
            <Tabs value={String(w.days)} onValueChange={(x) => setDays(Number(x))}>
              <TabsList>{wins.map((x) => <TabsTrigger key={x.days} value={String(x.days)}>{x.days === 2 ? "48 hours" : `${x.days} days`}</TabsTrigger>)}</TabsList>
            </Tabs>
          )}
        </div>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium">Location</th>
                {w.runs.map((t, i) => <th key={i} className={`px-2 py-2 text-center font-medium ${i === nr - 1 ? "text-foreground" : ""}`}>{runHead(t, i)}</th>)}
                <th className="px-2 py-2 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key} className={r.group ? "bg-muted/50" : ""}>
                  <th scope="row" className={`sticky left-0 z-10 border-t px-2 py-1.5 text-left whitespace-nowrap ${r.group ? "bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))] font-semibold" : "bg-card font-normal"} ${narrow && r.region ? "pl-5" : ""}`}>
                    {narrow && r.group ? (
                      <button type="button" aria-expanded={open.has(r.key)} onClick={() => toggle(r.key)} className="inline-flex items-center gap-1">
                        <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${open.has(r.key) ? "rotate-90" : ""}`} aria-hidden />{r.name}
                      </button>
                    ) : r.name}
                  </th>
                  {r.vals.map((s, i) => (
                    <td key={i} className="border-t border-l border-l-card px-1 py-1 text-center tabular-nums" style={s ? { background: tint(s.median) } : undefined}>
                      {s == null ? <span className="text-muted-foreground">–</span> : r.group ? <span className="font-semibold">{fmt(s.median, k)}</span> : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span tabIndex={0} className={`cursor-default outline-none ${i === nr - 1 ? "font-semibold" : ""}`}>{fmt(s.median, k)}</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="font-semibold">{r.name} · {i === nr - 1 ? "this briefing" : `briefing of ${runHead(w.runs[i], i)}`}</p>
                            <p>Median {fmtU(s.median, k)} of {s.n} models (range {fmt(s.lo, k)} – {fmtU(s.hi, k)})</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </td>
                  ))}
                  <td className="border-t px-2 py-1 text-right whitespace-nowrap"><Chg c={change(r)} k={k} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Darker cells are larger values. Change is now against the oldest briefing shown, coloured {k === "precip" || k === "snow" ? "by wetter or drier" : k === "gust" ? "by stronger or calmer" : "by warmer or cooler"}
          {" "}(<span style={{ color: UP_COLOR[k][0] }}>up</span>, <span style={{ color: UP_COLOR[k][1] }}>down</span>).
        </p>
      </CardContent>
    </Card>
  )
}
