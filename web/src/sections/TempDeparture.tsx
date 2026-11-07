import * as React from "react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TDEP, TEMP } from "@/lib/ramps"
import { DayMatrix, dayLabel, MEDIAN, type MatrixRow, ModelPick, modelDays, modelsWith, RampStrip, rampCell, regionDays, usePick } from "@/sections/DayMatrix"
import type { Briefing, N } from "@/types"

type Var = "tmax" | "tmin"
type Show = "dep" | "actual"
const WORD: Record<Var, string> = { tmax: "high", tmin: "low" }
const KEY = { tmax: "temperature_2m_max", tmin: "temperature_2m_min" } as const

/** A departure cell on the map's departure ramp (Maue's temperature anomaly table). */
export const depCell = (v: N): React.CSSProperties => rampCell(v, TDEP)
export const signed = (v: N, d = 0) => {
  if (v == null) return "–"
  const r = Number(v.toFixed(d))
  return r === 0 ? `${(0).toFixed(d)}°` : `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(d)}°`
}
const deg = (v: N) => (v == null ? "–" : `${Math.round(v)}°`)

function words(v: N, what: string) {
  if (v == null) return null
  const a = Math.abs(v)
  if (a < 1.5) return `${what} near normal`
  return `${what} ${Math.round(a)}° ${v > 0 ? "above" : "below"} normal`
}
const mean = (xs: N[]) => {
  const ys = xs.filter((x): x is number => x != null)
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null
}

export function TempDepartureCard({ data }: { data: Briefing }) {
  const td = data.tempDeparture
  const [v, setV] = React.useState<Var>("tmax")
  const [show, setShow] = React.useState<Show>("dep")
  const [win, setWin] = React.useState<number>(() => td?.windows.find((w) => w.days === 7)?.days ?? td?.windows[0]?.days ?? 7)
  const models = React.useMemo(() => modelsWith(data, KEY[v]), [data, v])
  const { pick, model, setPick } = usePick(models)
  if (!td) return null
  const w = td.windows.find((x) => x.days === win) ?? td.windows[0]
  const nd = td.dates.length
  const normal = (p: string, k: number) => td.normals[p]?.[v]?.[k] ?? null

  // each location's values: the multi-model median (as computed for the briefing) or one model
  const actual = (p: string): N[] => model ? modelDays(model, p, KEY[v], nd) : (td.points[p]?.[v]?.forecast ?? []).slice(0, nd)
  const byPoint = Object.fromEntries(data.points.map((p) => {
    if (show === "actual") return [p.name, actual(p.name)]
    if (!model) return [p.name, td.points[p.name]?.[v]?.departure ?? []]
    return [p.name, actual(p.name).map((x, k) => { const n = normal(p.name, k); return x != null && n != null ? x - n : null })]
  })) as Record<string, N[]>
  const lead = (days: N[]) => mean(days.slice(0, w.days))
  const rows: MatrixRow[] = [
    ...data.regions.map((r) => { const days = regionDays(data, r.id, byPoint); return { name: r.name, group: true, days, lead: lead(days) } }),
    ...data.points.map((p) => ({ name: p.name, point: p.name, days: byPoint[p.name], lead: lead(byPoint[p.name]) })),
  ]
  const noNormal = data.points.filter((p) => (td.normals[p.name]?.tmax ?? []).every((x) => x == null)).map((p) => p.name)

  const tip = (r: MatrixRow, k: number) => {
    const p = td.points[r.point!]?.[v], n = normal(r.point!, k)
    const x = actual(r.point!)[k]
    return <>
      <p className="font-semibold">{r.name} · {dayLabel(td.dates[k])}</p>
      {model
        ? <p>{model.label} {WORD[v]} {deg(x)} (model median {deg(p?.forecast[k] ?? null)}, {deg(p?.low[k] ?? null)} – {deg(p?.high[k] ?? null)})</p>
        : <p>Forecast {WORD[v]} {deg(x)} (median of {p?.models[k]} models, {deg(p?.low[k] ?? null)} – {deg(p?.high[k] ?? null)})</p>}
      {n != null && x != null && <p>Normal {WORD[v]} {deg(n)} → {signed(x - n)}</p>}
    </>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{show === "dep" ? "Temperatures vs normal" : "Daily temperatures"}</CardTitle>
        <CardDescription>
          {model ? `${model.label}'s` : "Each location's multi-model median"} daily {WORD[v]}{" "}
          {show === "dep" ? "against its 1991 – 2020 normal for the date (PRISM)" : "temperature"}{model && `, out to day ${model.days}`}.
          {" "}Region rows average their locations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pick === MEDIAN && (
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
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
            <TabsList><TabsTrigger value="tmax">Highs</TabsTrigger><TabsTrigger value="tmin">Lows</TabsTrigger></TabsList>
          </Tabs>
          <Tabs value={show} onValueChange={(x) => setShow(x as Show)}>
            <TabsList><TabsTrigger value="dep">Vs normal</TabsTrigger><TabsTrigger value="actual">Actual</TabsTrigger></TabsList>
          </Tabs>
          <ModelPick models={models} value={pick} onChange={setPick} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs value={String(w.days)} onValueChange={(x) => setWin(Number(x))}>
            <TabsList>{td.windows.map((x) => <TabsTrigger key={x.days} value={String(x.days)}>{x.label.replace(/^Next /, "")}</TabsTrigger>)}</TabsList>
          </Tabs>
          {show === "dep" ? <RampStrip ramp={TDEP} range={[-20, 20]} unit="°" /> : <RampStrip ramp={TEMP} range={[20, 95]} unit="°" />}
        </div>
        <DayMatrix dates={td.dates} rows={rows} leadHead="Avg" leadSub={w.label} dimFrom={w.days}
          style={show === "dep" ? depCell : (x) => rampCell(x, TEMP)} fmt={show === "dep" ? (x) => signed(x) : deg} tip={tip} />
        <p className="text-xs text-muted-foreground">
          Days past the selected window are shown too; the average covers only the window. Model days run 12Z – 12Z (4 AM to 4 AM
          Pacific), which holds the day's afternoon high and early-morning low.
          {show === "dep" && noNormal.length > 0 && ` PRISM normals cover the US only, so ${noNormal.join(", ")} ${noNormal.length > 1 ? "have" : "has"} no departure.`}
          {" "}The interactive map's Summary mode has the gridded version under “Temperature vs normal”.
        </p>
      </CardContent>
    </Card>
  )
}
