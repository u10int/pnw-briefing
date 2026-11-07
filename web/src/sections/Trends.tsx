import * as React from "react"
import { ArrowDownRight, ArrowUpRight, ChevronRight } from "lucide-react"

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
  gust: ["var(--foreground)", "var(--foreground)"], tmax: ["#c0392b", "#2c6fbb"], tmin: ["#c0392b", "#2c6fbb"],
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

function Cell({ name, w, ks, stats, chg, overlap, region }: {
  name: string; w: string; ks: TrendVar[]; stats: Partial<Record<TrendVar, TrendStat>> | undefined
  chg: Partial<Record<TrendVar, TrendChangeVar>> | undefined; overlap?: number; region?: boolean
}) {
  const have = ks.filter((k) => stats?.[k])
  if (!have.length) return <td className="px-3 py-2 text-center text-muted-foreground">–</td>
  // snow that rounds to nothing stays quiet, unless it changed
  const quiet = ks[0] === "snow" && (stats!.snow!.median < 0.05) && !(chg?.snow && Math.abs(chg.snow.delta) >= FLAT.snow)
  return (
    <td className="px-3 py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <div tabIndex={0} className="flex cursor-default flex-wrap items-baseline justify-end gap-x-1.5 tabular-nums outline-none focus-visible:underline">
            {quiet ? <span className="text-muted-foreground">0</span> : have.map((k, i) => (
              <span key={k} className="inline-flex items-baseline gap-1 whitespace-nowrap">
                {i > 0 && <span className="text-muted-foreground">/</span>}
                <span className={region ? "font-semibold" : "font-medium"}>{fmt(stats![k]!.median, k)}</span>
                <Chg c={chg?.[k]} k={k} />
              </span>
            ))}
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
  if (!wins.length) return null
  const w = wins.find((x) => x.days === days) ?? wins[0]
  const c = data.change?.trends?.windows.find((x) => x.days === w.days)

  // regions in order, then anything outside them grouped by zone (e.g. Southwest BC)
  const groups: { key: string; name: string; rid?: string; points: string[] }[] = data.regions.map((r) => ({
    key: r.id, name: r.name, rid: r.id, points: data.points.filter((p) => p.region === r.id).map((p) => p.name),
  }))
  for (const p of data.points.filter((p) => !p.region)) {
    const z = p.zone ?? "Other"
    const g = groups.find((x) => x.key === z) ?? (groups.push({ key: z, name: z, points: [] }), groups[groups.length - 1])
    g.points.push(p.name)
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
          <table className="w-full min-w-[640px] border-collapse text-sm">
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
                <tr className="bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]">
                  <th scope="row" className="sticky left-0 z-10 bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))] py-2 pr-3 pl-2 text-left font-semibold">{g.name}</th>
                  {COLS.map((col) => g.rid
                    ? <Cell key={col.id} name={g.name} w={w.label} ks={col.vars} stats={w.regions[g.rid]} chg={c?.regions[g.rid]} overlap={c?.overlapDays} region />
                    : <td key={col.id} />)}
                </tr>
                {g.points.map((n) => (
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
          Each value is the median across the models that cover the whole window. Region rows combine their locations within each model:
          precipitation and temperature averaged, snow at the passes, wind as the strongest lowland or coastal gust. Hover a value for the range across models.
        </p>
      </CardContent>
    </Card>
  )
}
