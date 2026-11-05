import * as React from "react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PRECIP, type Ramp, SNOW } from "@/lib/ramps"
import { DayMatrix, dayLabel, dayStats, MEDIAN, type MatrixRow, ModelPick, modelDays, modelsWith, RampStrip, rampCell, regionDays, usePick } from "@/sections/DayMatrix"
import type { Briefing, N } from "@/types"

type Var = "precip" | "snow"
const KEY = { precip: "precipitation_sum", snow: "snowfall_sum" } as const
const RAMP: Record<Var, Ramp> = { precip: PRECIP, snow: SNOW }

const amt = (v: N, ramp: Ramp) => {
  if (v == null) return "–"
  if (v <= 0) return "0"
  if (v < 0.01 && ramp !== SNOW) return "T"          // a trace: measurable rain starts at 0.01″
  if (v < 0.05 && ramp === SNOW) return "T"
  if (v >= 10) return v.toFixed(1)
  return v.toFixed(ramp === SNOW ? 1 : 2).replace(/^0\./, ".")
}
const total = (xs: N[]) => (xs.some((x) => x != null) ? xs.reduce<number>((a, b) => a + (b ?? 0), 0) : null)

export function RainByDayCard({ data }: { data: Briefing }) {
  const [v, setV] = React.useState<Var>("precip")
  const nd = data.dates.length
  const ramp = RAMP[v]
  const models = React.useMemo(() => modelsWith(data, KEY[v]), [data, v])
  const { pick, model, setPick } = usePick(models)
  const hasSnow = React.useMemo(() => data.models.some((m) => Object.values(m.data).some((d) => d.snowfall_sum?.some((x) => (x ?? 0) > 0))), [data])

  const stats = React.useMemo(() => dayStats(data, KEY[v]), [data, v])
  const byPoint = React.useMemo(() => Object.fromEntries(data.points.map((p) =>
    [p.name, model ? modelDays(model, p.name, KEY[v], nd) : stats[p.name].map((s) => s.med)])), [data, v, model, stats, nd])

  const rows: MatrixRow[] = [
    ...data.regions.map((r) => { const days = regionDays(data, r.id, byPoint); return { name: r.name, group: true, days, lead: total(days) } }),
    ...data.points.map((p) => ({ name: p.name, point: p.name, days: byPoint[p.name], lead: total(byPoint[p.name]) })),
  ]
  const span = model ? Math.min(model.days, nd) : nd
  const what = v === "precip" ? "liquid equivalent, so melted snow counts" : "model snowfall"

  const tip = (r: MatrixRow, k: number) => {
    const x = r.days[k]!, s = stats[r.point!][k]
    const nrm = v === "precip" ? data.normals?.points?.[r.point!]?.[k] ?? null : null
    return <>
      <p className="font-semibold">{r.name} · {dayLabel(data.dates[k])}</p>
      {model
        ? <p>{model.label} {x.toFixed(2)}″ (model median {(s.med ?? 0).toFixed(2)}″, range {(s.lo ?? 0).toFixed(2)}–{(s.hi ?? 0).toFixed(2)}″)</p>
        : <p>Median {x.toFixed(2)}″ of {s.n} models (range {(s.lo ?? 0).toFixed(2)}–{(s.hi ?? 0).toFixed(2)}″)</p>}
      {nrm != null && nrm > 0 && <p>Normal for the day {nrm.toFixed(2)}″ ({Math.round((100 * x) / nrm)}% of normal)</p>}
    </>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{v === "precip" ? "Rain by day" : "Snow by day"}</CardTitle>
        <CardDescription>
          {model ? <>{model.label}'s forecast for each 12Z–12Z day ({what}), out to day {model.days}.</>
                 : <>Each location's multi-model median for each 12Z–12Z day ({what}).</>}
          {" "}Region rows average their locations. Hover for the range across models{v === "precip" && " and the normal for the day"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {hasSnow && (
            <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
              <TabsList><TabsTrigger value="precip">Rain</TabsTrigger><TabsTrigger value="snow">Snow</TabsTrigger></TabsList>
            </Tabs>
          )}
          <ModelPick models={models} value={pick} onChange={setPick} />
          <div className="sm:ml-auto">
            <RampStrip ramp={ramp} from={`${ramp.levels[0]}″`} to={`${ramp.levels[7]}″+`} extra={<span className="ml-2">T = trace</span>} />
          </div>
        </div>
        <DayMatrix dates={data.dates} rows={rows} leadHead="Total" leadSub={`${span} days`} dimFrom={model ? model.days : undefined}
          style={(x) => rampCell(x, ramp, true)} fmt={(x) => amt(x, ramp)} tip={tip} />
        <p className="text-xs text-muted-foreground">
          {pick === MEDIAN
            ? "The median uses whichever models reach that day, so the first two days include the high-resolution regional models and later days only the global ones."
            : `Days past ${model!.label}'s range are blank; the total covers its ${span} days.`}
        </p>
      </CardContent>
    </Card>
  )
}
