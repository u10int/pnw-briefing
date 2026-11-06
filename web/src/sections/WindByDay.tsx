import * as React from "react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GUST, type Ramp, WIND } from "@/lib/ramps"
import { DayMatrix, dayLabel, dayStats, MEDIAN, type MatrixRow, ModelPick, modelDays, modelsWith, RampStrip, rampCell, regionDays, usePick } from "@/sections/DayMatrix"
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
export function WindByDayCard({ data }: { data: Briefing }) {
  const nd = data.dates.length
  const avail = React.useMemo(() => (["gust", "wind"] as Var[]).filter((x) => modelsWith(data, KEY[x]).length), [data])
  const [sel, setV] = React.useState<Var>("gust")
  const v = avail.includes(sel) ? sel : avail[0]
  const models = React.useMemo(() => (v ? modelsWith(data, KEY[v]) : []), [data, v])
  const { pick, model, setPick } = usePick(models)
  const stats = React.useMemo(() => (v ? dayStats(data, KEY[v]) : {}), [data, v])
  if (!v) return null
  const ramp = RAMP[v]
  const byPoint = Object.fromEntries(data.points.map((p) =>
    [p.name, model ? modelDays(model, p.name, KEY[v], nd) : stats[p.name].map((s) => s.med)])) as Record<string, N[]>
  const rows: MatrixRow[] = [
    ...data.regions.map((r) => { const days = regionDays(data, r.id, byPoint, "max"); return { name: r.name, group: true, days, lead: peak(days) } }),
    ...data.points.map((p) => ({ name: p.name, point: p.name, days: byPoint[p.name], lead: peak(byPoint[p.name]) })),
  ]
  const span = model ? Math.min(model.days, nd) : nd

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
        <CardTitle>{v === "gust" ? "Gusts by day" : "Wind by day"}</CardTitle>
        <CardDescription>
          {model ? `${model.label}'s` : "Each location's multi-model median"} {WORD[v]} for each 12Z – 12Z day, in mph
          {model && `, out to day ${model.days}`}. Region rows show their windiest location.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {avail.length > 1 && (
            <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
              <TabsList><TabsTrigger value="gust">Gusts</TabsTrigger><TabsTrigger value="wind">Sustained wind</TabsTrigger></TabsList>
            </Tabs>
          )}
          <ModelPick models={models} value={pick} onChange={setPick} />
          <div className="sm:ml-auto"><RampStrip ramp={ramp} range={[6.9, 69.05]} extra={<span>mph</span>} /></div>
        </div>
        <DayMatrix dates={data.dates} rows={rows} leadHead="Peak" leadSub={`${span} days`} dimFrom={model ? model.days : undefined}
          style={(x) => rampCell(x, ramp)} fmt={mph} tip={tip} />
        <p className="text-xs text-muted-foreground">
          {pick === MEDIAN
            ? "The median uses whichever models reach that day. Point values are the nearest model cell, which on coarse global grids smooths out terrain-driven winds."
            : `Days past ${model!.label}'s range are blank. Point values are the nearest model cell.`}
          {v === "gust" && " Some models (ECMWF AIFS among them) have no gust field and are left out."}
        </p>
      </CardContent>
    </Card>
  )
}
