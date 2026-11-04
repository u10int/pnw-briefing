import * as React from "react"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PRECIP, type Ramp, SNOW } from "@/lib/ramps"
import type { Briefing, N } from "@/types"

type Var = "precip" | "snow"
const KEY: Record<Var, "precipitation_sum" | "snowfall_sum"> = { precip: "precipitation_sum", snow: "snowfall_sum" }
const RAMP: Record<Var, Ramp> = { precip: PRECIP, snow: SNOW }

function cell(v: N, ramp: Ramp): React.CSSProperties {
  if (v == null) return { color: "var(--muted-foreground)" }
  if (v < ramp.levels[0]) return { color: "var(--muted-foreground)" }
  let i = ramp.levels.length - 1
  while (i > 0 && v < ramp.levels[i]) i--
  return { background: ramp.colors[i], color: i >= 5 ? "#fff" : "#1b1f24" }
}
const amt = (v: N, ramp: Ramp) => {
  if (v == null) return "–"
  if (v <= 0) return "0"
  if (v < 0.01 && ramp !== SNOW) return "T"          // a trace: measurable rain starts at 0.01″
  if (v < 0.05 && ramp === SNOW) return "T"
  if (v >= 10) return v.toFixed(1)
  return v.toFixed(ramp === SNOW ? 1 : 2).replace(/^0\./, ".")
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), k = s.length >> 1
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2
}

interface DayStat { med: N; lo: N; hi: N; n: number }

export function RainByDayCard({ data }: { data: Briefing }) {
  const [v, setV] = React.useState<Var>("precip")
  const nd = data.dates.length
  const ramp = RAMP[v]

  // each location's multi-model median per day, with the spread across models
  const stats = React.useMemo(() => {
    const out: Record<string, DayStat[]> = {}
    for (const p of data.points) {
      out[p.name] = Array.from({ length: nd }, (_, k) => {
        const xs = data.models.map((m) => m.data[p.name]?.[KEY[v]]?.[k]).filter((x): x is number => x != null && Number.isFinite(x))
        return { med: median(xs), lo: xs.length ? Math.min(...xs) : null, hi: xs.length ? Math.max(...xs) : null, n: xs.length }
      })
    }
    return out
  }, [data, v, nd])
  const hasSnow = React.useMemo(() => data.models.some((m) => Object.values(m.data).some((d) => d.snowfall_sum?.some((x) => (x ?? 0) > 0))), [data])

  const rows = [
    ...data.regions.map((r) => {
      const names = data.points.filter((p) => p.region === r.id).map((p) => p.name)
      const days = Array.from({ length: nd }, (_, k) => {
        const xs = names.map((n) => stats[n][k].med).filter((x): x is number => x != null)
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
      })
      return { name: r.name, group: true, days, point: null as string | null }
    }),
    ...data.points.map((p) => ({ name: p.name, group: false, days: stats[p.name].map((d) => d.med), point: p.name as string | null })),
  ]
  const total = (xs: N[]) => (xs.some((x) => x != null) ? xs.reduce<number>((a, b) => a + (b ?? 0), 0) : null)
  const normalAt = (p: string, k: number) => data.normals?.points?.[p]?.[k] ?? null

  return (
    <Card>
      <CardHeader>
        <CardTitle>{v === "precip" ? "Rain by day" : "Snow by day"}</CardTitle>
        <CardDescription>
          Each location's multi-model median for each 12Z–12Z day ({v === "precip" ? "liquid equivalent, so melted snow counts" : "model snowfall"});
          region rows average their locations. Hover for the range across models{v === "precip" && " and the normal for the day"}.
        </CardDescription>
        <CardAction>
          <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
            <TabsList><TabsTrigger value="precip">Rain</TabsTrigger>{hasSnow && <TabsTrigger value="snow">Snow</TabsTrigger>}</TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-end gap-1 text-xs text-muted-foreground">
          <span>{ramp.levels[0]}″</span>
          {ramp.colors.slice(0, 8).map((c) => <span key={c} className="h-2.5 w-4 first:rounded-l-[3px] last:rounded-r-[3px]" style={{ background: c }} />)}
          <span>{ramp.levels[7]}″+</span>
          <span className="ml-2">T = trace</span>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-xs tabular-nums">
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">Location</th>
                <th className="px-2 py-1.5 text-center font-medium">Total<span className="block font-normal text-muted-foreground">{nd} days</span></th>
                {data.dates.map((d) => {
                  const t = new Date(`${d}T12:00:00`)
                  return <th key={d} className="min-w-10 px-1 py-1.5 text-center font-medium">{t.toLocaleDateString("en-US", { weekday: "short" })}<span className="block font-normal text-muted-foreground">{t.getDate()}</span></th>
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={`border-b last:border-b-0 ${r.group ? "font-medium" : ""}`}>
                  <td className={`sticky left-0 z-10 px-2 py-1 whitespace-nowrap ${r.group ? "bg-muted" : "bg-card"}`}>{r.name}</td>
                  <td className="border-r px-2 py-1 text-center font-medium">{amt(total(r.days), ramp)}</td>
                  {r.days.map((x, k) => {
                    const td = <td key={k} className="px-1 py-1 text-center" style={cell(x, ramp)}>{amt(x, ramp)}</td>
                    if (!r.point || x == null) return td
                    const s = stats[r.point][k]
                    const nrm = v === "precip" ? normalAt(r.point, k) : null
                    return (
                      <Tooltip key={k}>
                        <TooltipTrigger asChild>{td}</TooltipTrigger>
                        <TooltipContent side="top">
                          <div className="space-y-0.5 py-0.5">
                            <p className="font-semibold">{r.name} · {new Date(`${data.dates[k]}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</p>
                            <p>Median {(s.med ?? 0).toFixed(2)}″ of {s.n} models (range {(s.lo ?? 0).toFixed(2)}–{(s.hi ?? 0).toFixed(2)}″)</p>
                            {nrm != null && nrm > 0 && <p>Normal for the day {nrm.toFixed(2)}″ ({Math.round((100 * (s.med ?? 0)) / nrm)}% of normal)</p>}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          The median uses whichever models reach that day, so the first two days include the high-resolution regional models and later
          days only the global ones.
        </p>
      </CardContent>
    </Card>
  )
}
