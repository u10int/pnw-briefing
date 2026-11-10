import * as React from "react"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Takeaway } from "@/components/Takeaway"
import { extreme } from "@/components/Takeaway"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TDEP, TEMP } from "@/lib/ramps"
import { coreModels, skillNote, skillWeights, weightedMedian, DayMatrix, HatchKey, dayLabel, listNames, MEDIAN, type MatrixRow, ModelPick, modelDays, modelsWith, RampStrip, rampCell, regionDays, usePick } from "@/sections/DayMatrix"
import type { Briefing, N } from "@/types"
import { MapButton } from "@/components/MapButton"

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
  const core = React.useMemo(() => coreModels(data, models), [data, models])
  const skillAll = React.useMemo(() => skillWeights(data, "temp"), [data])
  const { pick, model, setPick, only, skill } = usePick(models, core, skillAll)
  if (!td) return null
  const w = td.windows.find((x) => x.days === win) ?? td.windows[0]
  const nd = td.dates.length
  const normal = (p: string, k: number) => td.normals[p]?.[v]?.[k] ?? null

  // each location's values: the multi-model median (as computed for the briefing) or one model
  const coreMedian = (p: string): N[] => Array.from({ length: nd }, (_, k) => {
    const xs = (only ?? []).map((m) => modelDays(m, p, KEY[v], nd)[k]).filter((x): x is number => x != null).sort((a, b) => a - b)
    if (!xs.length) return null
    const h = xs.length >> 1
    return xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2
  })
  const skillMedian = (p: string): N[] => Array.from({ length: nd }, (_, k) =>
    weightedMedian(models.flatMap((m) => { const x = modelDays(m, p, KEY[v], nd)[k]; return x == null ? [] : [[x, skill!.weight(m.label, k)] as [number, number]] })))
  const actual = (p: string): N[] => model ? modelDays(model, p, KEY[v], nd) : only ? coreMedian(p) : skill ? skillMedian(p) : (td.points[p]?.[v]?.forecast ?? []).slice(0, nd)
  const byPoint = Object.fromEntries(data.points.map((p) => {
    if (show === "actual") return [p.name, actual(p.name)]
    if (!model && !only && !skill) return [p.name, td.points[p.name]?.[v]?.departure ?? []]
    return [p.name, actual(p.name).map((x, k) => { const n = normal(p.name, k); return x != null && n != null ? x - n : null })]
  })) as Record<string, N[]>
  const lead = (days: N[]) => mean(days.slice(0, w.days))
  const rows: MatrixRow[] = [
    ...data.regions.map((r) => { const days = regionDays(data, r.id, byPoint); return { name: r.name, group: true, region: r.id, days, lead: lead(days) } }),
    ...data.points.map((p) => ({ name: p.name, point: p.name, region: p.region ?? undefined, days: byPoint[p.name], lead: lead(byPoint[p.name]) })),
  ]
  const hi = extreme(rows), lo = extreme(rows, true)
  const fmtT = (x: number) => show === "dep" ? signed(x) : deg(x)
  const regLines = data.regions.map((r) => {
    const a = w.regions[r.id]?.tmax ?? null, b = w.regions[r.id]?.tmin ?? null
    return a == null && b == null ? null : `${r.name}: ${[words(a, "highs"), words(b, "lows")].filter(Boolean).join(", ")}`
  }).filter(Boolean)
  const takeaway = pick === MEDIAN && show === "dep" && regLines.length ? <>{regLines.join("; ")}, on average over {w.label.toLowerCase()}.</>
    : hi && lo && <>{show === "dep" ? (hi.value < 0 ? "Least cold vs normal" : "Warmest vs normal") : `Highest ${WORD[v]}`}: {hi.row.name} ({fmtT(hi.value)}); {show === "dep" ? (lo.value > 0 ? "least warm" : "coolest") : "lowest"}: {lo.row.name} ({fmtT(lo.value)}), averaged over {w.days} days.</>
  // the spread of the models' own values at a location and day
  const farApart = (r: MatrixRow, k: number) => {
    const xs = (only ?? models).map((m) => modelDays(m, r.point!, KEY[v], nd)[k]).filter((x): x is number => x != null)
    return xs.length >= 3 && Math.max(...xs) - Math.min(...xs) >= 10
  }
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
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription>
          {model ? `${model.label}'s` : skill ? "Each location's skill-weighted median" : only ? `Each location's median of ${listNames(only)}` : "Each location's multi-model median"} daily {WORD[v]}{" "}
          {show === "dep" ? "against its 1991 – 2020 normal for the date (PRISM)" : "temperature"}{model && `, out to day ${model.days}`}.
          {" "}Region rows average their locations.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2"><MapButton req={{ mode: "totals", variable: "tmaxdep", days: 7 }} label="Highs vs normal on the map" /><MapButton req={{ mode: "totals", variable: "tmindep", days: 7 }} label="Lows vs normal on the map" /></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
            <TabsList><TabsTrigger value="tmax">Highs</TabsTrigger><TabsTrigger value="tmin">Lows</TabsTrigger></TabsList>
          </Tabs>
          <Tabs value={show} onValueChange={(x) => setShow(x as Show)}>
            <TabsList><TabsTrigger value="dep">Vs normal</TabsTrigger><TabsTrigger value="actual">Actual</TabsTrigger></TabsList>
          </Tabs>
          <ModelPick models={models} value={pick} onChange={setPick} core={core} skill={skillAll} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs value={String(w.days)} onValueChange={(x) => setWin(Number(x))}>
            <TabsList>{td.windows.map((x) => <TabsTrigger key={x.days} value={String(x.days)}>{x.label.replace(/^Next /, "")}</TabsTrigger>)}</TabsList>
          </Tabs>
          {show === "dep" ? <RampStrip ramp={TDEP} range={[-20, 20]} unit="°" /> : <RampStrip ramp={TEMP} range={[20, 95]} unit="°" />}
        </div>
        <DayMatrix dates={td.dates} rows={rows} leadHead="Avg" leadSub={w.label} dimFrom={w.days}
          style={show === "dep" ? depCell : (x) => rampCell(x, TEMP)} fmt={show === "dep" ? (x) => signed(x) : deg} tip={tip} flag={model ? undefined : farApart} />
        <p className="text-xs text-muted-foreground">
          <HatchKey what="Hatched: models 10°F+ apart" />{" "}
          {skill && <>{skillNote(skill)} </>}Days past the selected window are shown too; the average covers only the window. Each day runs 4 AM to 4 AM
          Pacific, which holds the day's afternoon high and early-morning low.
          {show === "dep" && noNormal.length > 0 && ` PRISM normals cover the US only, so ${noNormal.join(", ")} ${noNormal.length > 1 ? "have" : "has"} no departure.`}
          {" "}The interactive map's Summary mode has the gridded version under “Temperature vs normal”.
        </p>
      </CardContent>
    </Card>
  )
}
