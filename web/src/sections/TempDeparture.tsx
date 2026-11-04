import * as React from "react"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Briefing, N } from "@/types"

type Var = "tmax" | "tmin"
const WORD: Record<Var, string> = { tmax: "high", tmin: "low" }

// blue below normal, red above, white within ±2° (matches the map's ramp)
const EDGES = [-15, -10, -5, -2, 2, 5, 10, 15]
const COLORS = ["#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b"]

export function depCell(v: N): React.CSSProperties {
  if (v == null) return { color: "var(--muted-foreground)" }
  const i = EDGES.findIndex((e) => v < e)
  const k = i === -1 ? COLORS.length - 1 : i
  return { background: COLORS[k], color: k <= 1 || k >= 7 ? "#fff" : "#1b1f24" }
}
export const signed = (v: N, d = 0) => {
  if (v == null) return "–"
  const r = Number(v.toFixed(d))
  return r === 0 ? `${(0).toFixed(d)}°` : `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(d)}°`
}

const dayHead = (iso: string) => {
  const t = new Date(`${iso}T12:00:00`)
  return { wd: t.toLocaleDateString("en-US", { weekday: "short" }), d: t.getDate() }
}

function words(v: N, what: string) {
  if (v == null) return null
  const a = Math.abs(v)
  if (a < 1.5) return `${what} near normal`
  return `${what} ${Math.round(a)}° ${v > 0 ? "above" : "below"} normal`
}

export function TempDepartureCard({ data }: { data: Briefing }) {
  const td = data.tempDeparture
  const [v, setV] = React.useState<Var>("tmax")
  const [win, setWin] = React.useState<number>(() => td?.windows.find((w) => w.days === 7)?.days ?? td?.windows[0]?.days ?? 7)
  if (!td) return null
  const w = td.windows.find((x) => x.days === win) ?? td.windows[0]
  const nd = td.dates.length
  const rows: { name: string; group?: boolean; dep: N[]; avg: N; point?: string }[] = [
    ...data.regions.map((r) => ({ name: r.name, group: true, dep: td.regions[r.id]?.[v] ?? [], avg: w.regions[r.id]?.[v] ?? null })),
    ...data.points.map((p) => ({ name: p.name, point: p.name, dep: td.points[p.name]?.[v]?.departure ?? [], avg: w.points[p.name]?.[v] ?? null })),
  ]
  const noNormal = data.points.filter((p) => (td.normals[p.name]?.tmax ?? []).every((x) => x == null)).map((p) => p.name)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Temperatures vs normal</CardTitle>
        <CardDescription>
          Each location's multi-model median daily high and low against its 1991–2020 normal for the date (PRISM).
          Region rows average their locations.
        </CardDescription>
        <CardAction>
          <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
            <TabsList><TabsTrigger value="tmax">Highs</TabsTrigger><TabsTrigger value="tmin">Lows</TabsTrigger></TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1 text-sm">
          {data.regions.map((r) => {
            const hi = w.regions[r.id]?.tmax ?? null, lo = w.regions[r.id]?.tmin ?? null
            if (hi == null && lo == null) return null
            return (
              <li key={r.id}><span className="font-medium">{r.name}:</span>{" "}
                {[words(hi, "highs"), words(lo, "lows")].filter(Boolean).join(", ")} on average over {w.label.toLowerCase()}.</li>
            )
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs value={String(w.days)} onValueChange={(x) => setWin(Number(x))}>
            <TabsList>{td.windows.map((x) => <TabsTrigger key={x.days} value={String(x.days)}>{x.label}</TabsTrigger>)}</TabsList>
          </Tabs>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>colder</span>
            {COLORS.map((c) => <span key={c} className="h-2.5 w-4 first:rounded-l-[3px] last:rounded-r-[3px]" style={{ background: c }} />)}
            <span>warmer</span>
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-xs tabular-nums">
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">Location</th>
                <th className="px-2 py-1.5 text-center font-medium whitespace-nowrap">Avg<span className="block font-normal text-muted-foreground">{w.label}</span></th>
                {td.dates.map((d, k) => {
                  const h = dayHead(d)
                  return <th key={d} className={`min-w-10 px-1 py-1.5 text-center font-medium ${k < w.days ? "" : "text-muted-foreground"}`}>{h.wd}<span className="block font-normal text-muted-foreground">{h.d}</span></th>
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={`border-b last:border-b-0 ${r.group ? "font-medium" : ""}`}>
                  <td className={`sticky left-0 z-10 px-2 py-1 whitespace-nowrap ${r.group ? "bg-muted" : "bg-card"}`}>{r.name}</td>
                  <td className="border-r px-2 py-1 text-center font-medium" style={depCell(r.avg)}>{signed(r.avg)}</td>
                  {Array.from({ length: nd }, (_, k) => {
                    const dep = r.dep[k] ?? null
                    const cell = <td key={k} className="px-1 py-1 text-center" style={depCell(dep)}>{signed(dep)}</td>
                    if (!r.point || dep == null) return cell
                    const p = td.points[r.point][v], normal = td.normals[r.point]?.[v]?.[k]
                    return (
                      <Tooltip key={k}>
                        <TooltipTrigger asChild>{cell}</TooltipTrigger>
                        <TooltipContent side="top">
                          <div className="space-y-0.5 py-0.5">
                            <p className="font-semibold">{r.name} · {new Date(`${td.dates[k]}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</p>
                            <p>Forecast {WORD[v]} {Math.round(p.forecast[k] ?? 0)}° (median of {p.models[k]} models, {Math.round(p.low[k] ?? 0)}–{Math.round(p.high[k] ?? 0)}°)</p>
                            <p>Normal {WORD[v]} {Math.round(normal ?? 0)}° → {signed(dep)}</p>
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
          Days past the selected window are shown too; the average covers only the window. Model days run 12Z–12Z (4 AM to 4 AM
          Pacific), which holds the day's afternoon high and early-morning low.
          {noNormal.length > 0 && ` PRISM normals cover the US only, so ${noNormal.join(", ")} ${noNormal.length > 1 ? "have" : "has"} no departure.`}
          {" "}The interactive map's Summary mode has the gridded version under “Temperature vs normal”.
        </p>
      </CardContent>
    </Card>
  )
}
