import * as React from "react"
import { ArrowDownRight, ArrowUpRight, ChevronRight } from "lucide-react"

import { pctColor } from "@/components/Delta"

import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Briefing, TrendChangeVar, TrendStat, TrendVar } from "@/types"

type Tab = "precip" | "snow" | "wind" | "temp"
const COLS: { id: string; vars: TrendVar[]; tab: Tab; head: string; sub: string }[] = [
  { id: "precip", vars: ["precip"], tab: "precip", head: "Precip", sub: "total" },
  { id: "snow", vars: ["snow"], tab: "snow", head: "Snow", sub: "total" },
  { id: "gust", vars: ["gust"], tab: "wind", head: "Wind", sub: "strongest gust" },
  { id: "temp", vars: ["tmax", "tmin"], tab: "temp", head: "Temperature", sub: "average high / low" },
]
const UNIT: Record<TrendVar, string> = { precip: "in", snow: "in", gust: "mph", tmax: "°", tmin: "°" }
const WHAT: Record<TrendVar, string> = { precip: "Precipitation", snow: "Snowfall", gust: "Strongest gust", tmax: "Average high", tmin: "Average low" }
const fmt = (v: number, k: TrendVar) =>
  k === "precip" || k === "snow" ? `${v >= 10 ? v.toFixed(0) : v.toFixed(v < 1 && k === "precip" ? 2 : 1).replace(/^0\./, ".")}″`
    : k === "gust" ? `${Math.round(v)}` : `${Math.round(v)}°`
// below these, a change is noise and reads as "no change"
const FLAT: Record<TrendVar, number> = { precip: 0.05, snow: 0.2, gust: 1, tmax: 0.5, tmin: 0.5 }
const UP_COLOR: Record<TrendVar, [string, string]> = {          // [up, down]
  precip: ["var(--wetter)", "var(--drier)"], snow: ["var(--wetter)", "var(--drier)"],
  gust: ["#c2410c", "#0f766e"], tmax: ["#c0392b", "#2c6fbb"], tmin: ["#c0392b", "#2c6fbb"],   // gust: stronger orange, calmer teal
}

/** The change since yesterday, compact: arrow and signed amount, coloured by direction. */
function Chg({ c, k }: { c: TrendChangeVar | undefined; k: TrendVar }) {
  if (!c || Math.abs(c.delta) < FLAT[k]) return null
  const up = c.delta > 0
  const Icon = up ? ArrowUpRight : ArrowDownRight
  const d = k === "precip" || k === "snow" ? Math.abs(c.delta).toFixed(Math.abs(c.delta) < 1 ? (k === "precip" ? 2 : 1) : 1).replace(/^0\./, ".")
    : Math.round(Math.abs(c.delta)).toString()
  return (
    <span className="inline-flex items-center text-xs font-medium tabular-nums" style={{ color: UP_COLOR[k][up ? 0 : 1] }}>
      <Icon className="size-3" aria-hidden />{up ? "+" : "−"}{d}{k === "tmax" || k === "tmin" ? "°" : ""}
    </span>
  )
}

const REGION_VAR: Record<string, string> = { wwa: "var(--wwa)", nwor: "var(--nwor)" }
const BAR_COLOR = (k: TrendVar, rid?: string) =>
  k === "tmax" ? "#d6604d" : k === "tmin" ? "#4393c3" : (rid && REGION_VAR[rid]) || "var(--muted-foreground)"

/** The models' range as a faint band with the median as a mark, on [min, max]. */
function Band({ s, min, max, color }: { s: TrendStat; min: number; max: number; color: string }) {
  const x = (v: number) => Math.max(0, Math.min(100, (100 * (v - min)) / (max - min || 1)))
  return (
    <div className="relative h-3 w-full" aria-hidden>
      <div className="absolute top-[5px] h-0.5 w-full rounded bg-border" />
      <div className="absolute top-[3px] h-1.5 rounded-full opacity-30" style={{ left: `${x(s.lo)}%`, width: `max(4px, ${x(s.hi) - x(s.lo)}%)`, background: color }} />
      <div className="absolute top-0 h-3 w-[3px] -translate-x-1/2 rounded-sm" style={{ left: `${x(s.median)}%`, background: color }} />
    </div>
  )
}

function Cell({ name, w, ks, stats, chg, overlap, region, scale, rid, note }: {
  name: string; w: string; ks: TrendVar[]; stats: Partial<Record<TrendVar, TrendStat>> | undefined
  chg: Partial<Record<TrendVar, TrendChangeVar>> | undefined; overlap?: number; region?: boolean
  /** region rows: the shared scale for the range bars, and a line under them (percent of normal, departure) */
  scale?: [number, number]; rid?: string; note?: React.ReactNode
}) {
  const have = ks.filter((k) => stats?.[k])
  if (!have.length) return <td className="px-3 py-2 text-center text-muted-foreground">–</td>
  // snow that rounds to nothing stays quiet, unless it changed
  const quiet = ks[0] === "snow" && (stats!.snow!.median < 0.05) && !(chg?.snow && Math.abs(chg.snow.delta) >= FLAT.snow)
  return (
    <td className="px-3 py-2 align-top">
      <Tooltip>
        <TooltipTrigger asChild>
          {/* each value in a right-aligned slot and its change in a fixed-width slot after it, so
              values line up down the column whether or not they changed */}
          <div tabIndex={0} className="cursor-default outline-none focus-visible:underline">
          <div className="flex items-baseline justify-end tabular-nums whitespace-nowrap">
            {ks.map((k, i) => (
              <React.Fragment key={k}>
                {i > 0 && <span className="px-1 text-muted-foreground">/</span>}
                <span className={`min-w-[2.75rem] text-right ${quiet ? "text-muted-foreground" : region ? "font-semibold" : "font-medium"}`}>
                  {quiet ? "0" : stats?.[k] ? fmt(stats[k]!.median, k) : "–"}
                </span>
                <span className="w-12 pl-1 text-left"><Chg c={quiet ? undefined : chg?.[k]} k={k} /></span>
              </React.Fragment>
            ))}
            </div>
            {scale && !quiet && (
              <div className="mt-1.5 space-y-0.5 pr-12">
                {have.map((k) => <Band key={k} s={stats![k]!} min={scale[0]} max={scale[1]} color={BAR_COLOR(k, rid)} />)}
              </div>
            )}
            {note && <div className="mt-0.5 pr-12 text-right text-[11px] font-normal whitespace-nowrap">{note}</div>}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-1">
          <p className="font-semibold">{name} · {w}</p>
          {have.map((k) => {
            const s = stats![k]!, c = chg?.[k]
            return (
              <p key={k}>
                {WHAT[k]}: {fmt(s.median, k)}{k === "gust" ? " mph" : ""}, median of {s.n} models (range {fmt(s.lo, k)} – {fmt(s.hi, k)}{k === "gust" ? " mph" : ""})
                {c && <>; yesterday {fmt(c.prev, k)}{k === "gust" ? " mph" : ""} over the same {overlap} days</>}
              </p>
            )
          })}
        </TooltipContent>
      </Tooltip>
    </td>
  )
}

/** Forecast trends: each location (grouped by region, with the region's own row) for
 *  precipitation, snow, wind and temperature over a chosen window, with the change since
 *  yesterday's briefing beside each value. Column headings open their tabs. */
export function TrendsCard({ data, onOpen }: { data: Briefing; onOpen: (t: Tab) => void }) {
  const wins = data.trends?.windows ?? []
  const [days, setDays] = React.useState(wins[1]?.days ?? wins[0]?.days ?? 7)
  const [open, setOpen] = React.useState<Set<string>>(new Set())        // regions start collapsed
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  if (!wins.length) return null
  const w = wins.find((x) => x.days === days) ?? wins[0]
  const c = data.change?.trends?.windows.find((x) => x.days === w.days)

  // regions in order, then anything outside them grouped by zone (e.g. Southwest BC)
  // `rid` keys the group's own row: a region id, or "zone:<name>" for locations outside every region
  const groups: { key: string; name: string; rid?: string; points: string[] }[] = data.regions.map((r) => ({
    key: r.id, name: r.name, rid: r.id, points: data.points.filter((p) => p.region === r.id).map((p) => p.name),
  }))
  for (const p of data.points.filter((p) => !p.region)) {
    const z = p.zone ?? "Other"
    const g = groups.find((x) => x.key === z) ?? (groups.push({ key: z, name: z, rid: `zone:${z}`, points: [] }), groups[groups.length - 1])
    g.points.push(p.name)
  }

  // one scale per column across the region rows, so the bars compare between regions
  const regionStats = Object.values(w.regions)
  const span = (ks: TrendVar[]) => regionStats.flatMap((r) => ks.flatMap((k) => (r[k] ? [r[k]!.lo, r[k]!.hi] : [])))
  const scaleFor = (col: (typeof COLS)[number]): [number, number] | undefined => {
    const xs = span(col.vars)
    if (!xs.length) return undefined
    if (col.id === "temp") return [Math.floor((Math.min(...xs) - 2) / 5) * 5, Math.ceil((Math.max(...xs) + 2) / 5) * 5]
    const top = Math.max(...xs, col.id === "gust" ? 30 : 0.1)
    const steps = col.id === "gust" ? [30, 40, 50, 60, 70, 80, 90, 100] : [0.5, 1, 2, 3, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100]
    return [0, steps.find((x) => x >= top * 1.05) ?? Math.ceil(top * 1.05)]
  }
  const scales = Object.fromEntries(COLS.map((c) => [c.id, scaleFor(c)]))
  const pctNorm = data.normals?.windows.find((x) => x.days === w.days)
  const dep = data.tempDeparture?.windows.find((x) => x.days === w.days)
  const sgn = (v: number) => { const n = Math.round(v); return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}°` }
  const noteFor = (colId: string, rid: string) => {
    if (colId === "precip") {
      const p = pctNorm?.regions[rid]?.pct
      return p != null ? <span style={{ color: pctColor(p) }}>{Math.round(p)}% of normal</span> : null
    }
    if (colId === "temp") {
      const d = dep?.regions[rid]
      return d && d.tmax != null ? <span className="text-muted-foreground">{sgn(d.tmax)}{d.tmin != null && <> / {sgn(d.tmin)}</>} vs normal</span> : null
    }
    return null
  }

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={String(w.days)} onValueChange={(v) => setDays(Number(v))}>
            <TabsList>{wins.map((x) => <TabsTrigger key={x.days} value={String(x.days)}>{x.label.replace(/^Next /, "")}</TabsTrigger>)}</TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            {c ? <>Arrows: change since yesterday's briefing over the same {c.overlapDays} days.</> : "Changes appear once there's an earlier briefing to compare with."}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] table-fixed border-collapse text-sm sm:min-w-[720px]">
            {/* equal data columns (temperature a bit wider for its two values), so the bars line up */}
            <colgroup><col className="w-[150px] sm:w-[190px]" /><col /><col /><col /><col className="w-[30%]" /></colgroup>
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 z-10 bg-card py-2 pr-3 pl-2 text-left font-medium text-muted-foreground">Location</th>
                {COLS.map((col) => (
                  <th key={col.id} className="px-3 py-2 text-right font-medium">
                    <button type="button" onClick={() => onOpen(col.tab)}
                      className="group inline-flex items-center gap-0.5 rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                      {col.head}<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </button>
                    <span className="block text-xs font-normal text-muted-foreground">{col.sub}{col.id === "gust" ? ", mph" : ""}</span>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key} className="border-b last:border-b-0">
                <tr className="cursor-pointer bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))] hover:bg-muted" onClick={() => toggle(g.key)}>
                  <th scope="row" className="sticky left-0 z-10 bg-inherit py-2 pr-3 pl-1 text-left align-top font-semibold">
                    <button type="button" aria-expanded={open.has(g.key)} onClick={(e) => { e.stopPropagation(); toggle(g.key) }}
                      className="inline-flex items-center gap-1 rounded text-left focus-visible:outline-2 focus-visible:outline-ring">
                      <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open.has(g.key) ? "rotate-90" : ""}`} aria-hidden />
                      {g.name}
                    </button>
                    <span className="block pl-5 text-xs font-normal text-muted-foreground">{g.points.length} locations</span>
                  </th>
                  {COLS.map((col) => g.rid
                    ? <Cell key={col.id} name={g.name} w={w.label} ks={col.vars} stats={w.regions[g.rid]} chg={c?.regions[g.rid]} overlap={c?.overlapDays}
                        region scale={scales[col.id]} rid={g.rid} note={noteFor(col.id, g.rid)} />
                    : <td key={col.id} />)}
                </tr>
                {open.has(g.key) && g.points.map((n) => (
                  <tr key={n} className="border-t border-border/50">
                    <th scope="row" className="sticky left-0 z-10 bg-card py-2 pr-3 pl-5 text-left font-normal whitespace-nowrap">{n}</th>
                    {COLS.map((col) => <Cell key={col.id} name={n} w={w.label} ks={col.vars} stats={w.points[n]} chg={c?.points[n]} overlap={c?.overlapDays} />)}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Each value is the median across the models that cover the whole window. Region rows combine their locations within each model
          (precipitation and temperature averaged, snow at the passes, wind as the strongest lowland or coastal gust); their bars span the models,
          with the mark at the median, on one scale per column. Click a region for its locations; hover a value for details.
        </p>
      </CardContent>
    </Card>
  )
}
