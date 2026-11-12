import * as React from "react"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { dayOf, extreme, Takeaway } from "@/components/Takeaway"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GUST, type Ramp, WIND } from "@/lib/ramps"
import { coreModels, DayMatrix, type DayStat, HatchKey, dayLabel, dayStats, listNames, MEDIAN, type MatrixRow, ModelPick, modelDays, modelsWith, RampStrip, rampCell, regionDays, usePick } from "@/sections/DayMatrix"
import type { Briefing, N } from "@/types"

type Var = "gust" | "wind"
const KEY = { gust: "wind_gusts_10m_max", wind: "wind_speed_10m_max" } as const
const RAMP: Record<Var, Ramp> = { gust: GUST, wind: WIND }
const WORD: Record<Var, string> = { gust: "strongest gust", wind: "strongest sustained wind" }
const mph = (v: N) => (v == null ? "–" : String(Math.round(v)))
const peak = (xs: N[]) => {
  const ys = xs.filter((x): x is number => x != null)
  return ys.length ? Math.max(...ys) : null
}

/** Each location's strongest gust or sustained wind per day, as a multi-model median or one model. */
export function WindByDayCard({ data, switcher }: { data: Briefing; switcher?: React.ReactNode }) {
  const nd = data.dates.length
  const avail = React.useMemo(() => (["gust", "wind"] as Var[]).filter((x) => modelsWith(data, KEY[x]).length), [data])
  const [sel, setV] = React.useState<Var>("gust")
  const v = avail.includes(sel) ? sel : avail[0]
  const models = React.useMemo(() => (v ? modelsWith(data, KEY[v]) : []), [data, v])
  const core = React.useMemo(() => coreModels(data, models), [data, models])
  const { pick, model, setPick, only } = usePick(models, core)
  const stats = React.useMemo(() => (v ? dayStats(data, KEY[v], only) : {}), [data, v, only])
  if (!v) return null
  const ramp = RAMP[v]
  const byPoint = Object.fromEntries(data.points.map((p) =>
    [p.name, model ? modelDays(model, p.name, KEY[v], nd) : stats[p.name].map((s) => s.med)])) as Record<string, N[]>
  const rows: MatrixRow[] = [
    ...data.regions.map((r) => { const days = regionDays(data, r.id, byPoint, "max"); return { name: r.name, group: true, region: r.id, days, lead: peak(days) } }),
    ...data.points.map((p) => ({ name: p.name, point: p.name, region: p.region ?? undefined, days: byPoint[p.name], lead: peak(byPoint[p.name]) })),
  ]
  const span = model ? Math.min(model.days, nd) : nd
  const top = extreme(rows.map((r) => ({ ...r, lead: peak(r.days.slice(0, span)) })), false, span)
  const takeaway = top && <>Strongest: {top.row.name}, {v === "gust" ? "gusting to" : "sustained"} {Math.round(top.value)} mph{top.day >= 0 && <> {dayOf(data.dates[top.day])}</>}.</>

  const farApart = (r: MatrixRow, k: number) => {
    const s = (stats as Record<string, DayStat[]>)[r.point!]?.[k]
    return !!s && s.n >= 3 && s.lo != null && s.hi != null && s.hi - s.lo >= (v === "gust" ? 20 : 15)
  }
  const tip = (r: MatrixRow, k: number) => {
    const x = r.days[k]!, s = stats[r.point!][k]
    return <>
      <p className="font-semibold">{r.name} · {dayLabel(data.dates[k])}</p>
      {model
        ? <p>{model.label} {Math.round(x)} mph (model median {mph(s.med)}, range {mph(s.lo)} – {mph(s.hi)} mph)</p>
        : <p>Median {Math.round(x)} mph of {s.n} models (range {mph(s.lo)} – {mph(s.hi)} mph)</p>}
    </>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{switcher ? "By location" : v === "gust" ? "Gusts by day" : "Wind by day"}</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription info={<>
          {model ? `${model.label}'s` : only ? `Each location's median of ${listNames(only)}` : "Each location's multi-model median"} {WORD[v]} for each day (4 AM – 4 AM), in mph
          {model && `, out to day ${model.days}`}. Region rows show their windiest location.{" "}
          {only ? `The core median uses only ${listNames(only)} on every day. Point values are the nearest model cell, which on coarse global grids smooths out terrain-driven winds.`
            : pick === MEDIAN
            ? "The median uses whichever models reach that day. Point values are the nearest model cell, which on coarse global grids smooths out terrain-driven winds."
            : `Days past ${model!.label}'s range are blank. Point values are the nearest model cell.`}
          {v === "gust" && " Some models (ECMWF AIFS among them) have no gust field and are left out."}</>}>
          {model ? `${model.label}'s` : "The median"} {WORD[v]} for each day, in mph.
        </CardDescription>
        {switcher && <CardAction>{switcher}</CardAction>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {avail.length > 1 && (
            <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
              <TabsList><TabsTrigger value="gust">Gusts</TabsTrigger><TabsTrigger value="wind">Sustained wind</TabsTrigger></TabsList>
            </Tabs>
          )}
          <ModelPick models={models} value={pick} onChange={setPick} core={core} />
          <div className="sm:ml-auto"><RampStrip ramp={ramp} range={[6.9, 69.05]} extra={<span>mph</span>} /></div>
        </div>
        <DayMatrix dates={data.dates} rows={rows} leadHead="Peak" leadSub={`${span} days`} dimFrom={model ? model.days : undefined}
          style={(x) => rampCell(x, ramp)} fmt={mph} tip={tip} flag={model ? undefined : farApart} />
        <p className="text-xs text-muted-foreground">
          <HatchKey what={`Hatched: models ${v === "gust" ? 20 : 15}+ mph apart`} />
        </p>
      </CardContent>
    </Card>
  )
}
