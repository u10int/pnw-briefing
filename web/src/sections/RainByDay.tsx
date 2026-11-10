import * as React from "react"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { dayOf, extreme, Takeaway } from "@/components/Takeaway"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PRECIP, type Ramp, SNOW } from "@/lib/ramps"
import { coreModels, DayMatrix, HatchKey, dayLabel, dayStats, listNames, MEDIAN, type MatrixRow, ModelPick, modelDays, modelsWith, RampStrip, rampCell, regionDays, usePick } from "@/sections/DayMatrix"
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

/** `only` pins the card to one variable and hides the Rain/Snow switch (the Snow tab's copy). */
/** `switcher`, when given, makes this the "By day" view of a combined By location card. */
export function RainByDayCard({ data, only, switcher }: { data: Briefing; only?: Var; switcher?: React.ReactNode }) {
  const [sel, setV] = React.useState<Var>(only ?? "precip")
  const v = only ?? sel
  const nd = data.dates.length
  const ramp = RAMP[v]
  const models = React.useMemo(() => modelsWith(data, KEY[v]), [data, v])
  const core = React.useMemo(() => coreModels(data, models), [data, models])
  const { pick, model, setPick, only: coreOnly } = usePick(models, core)
  const hasSnow = React.useMemo(() => data.models.some((m) => Object.values(m.data).some((d) => d.snowfall_sum?.some((x) => (x ?? 0) > 0))), [data])

  const stats = React.useMemo(() => dayStats(data, KEY[v], coreOnly), [data, v, coreOnly])
  const byPoint = React.useMemo(() => Object.fromEntries(data.points.map((p) =>
    [p.name, model ? modelDays(model, p.name, KEY[v], nd) : stats[p.name].map((s) => s.med)])), [data, v, model, stats, nd])

  const rows: MatrixRow[] = [
    ...data.regions.map((r) => { const days = regionDays(data, r.id, byPoint); return { name: r.name, group: true, region: r.id, days, lead: total(days) } }),
    ...data.points.map((p) => ({ name: p.name, point: p.name, region: p.region ?? undefined, days: byPoint[p.name], lead: total(byPoint[p.name]) })),
  ]
  const span = model ? Math.min(model.days, nd) : nd
  const top = extreme(rows.map((r) => ({ ...r, lead: total(r.days.slice(0, span)) })), false, span)
  const fmt = (x: number) => v === "precip" ? `${x.toFixed(2)}″` : `${x < 10 ? x.toFixed(1) : Math.round(x)}″`
  const takeaway = !top ? null
    : top.value < (v === "precip" ? 0.1 : 0.5) ? (v === "precip" ? `Mostly dry: no location tops 0.10″ over ${span} days.` : `Little or no snow at the tracked locations over ${span} days.`)
    : <>{v === "precip" ? "Wettest" : "Snowiest"}: {top.row.name} with {fmt(top.value)} over {span} days{top.day >= 0 && top.dayValue! > 0 && <>, most of it {dayOf(data.dates[top.day])} ({fmt(top.dayValue!)})</>}.</>
  const what = v === "precip" ? "liquid equivalent, so melted snow counts" : "model snowfall"

  // the models' range at a location and day is wide for its size
  const farApart = (r: MatrixRow, k: number) => {
    const s = stats[r.point!]?.[k]
    if (!s || s.n < 3 || s.lo == null || s.hi == null) return false
    return s.hi - s.lo >= Math.max(v === "precip" ? 0.5 : 4, 1.25 * (s.med ?? 0))
  }
  const tip = (r: MatrixRow, k: number) => {
    const x = r.days[k]!, s = stats[r.point!][k]
    const nrm = v === "precip" ? data.normals?.points?.[r.point!]?.[k] ?? null : null
    return <>
      <p className="font-semibold">{r.name} · {dayLabel(data.dates[k])}</p>
      {model
        ? <p>{model.label} {x.toFixed(2)}″ (model median {(s.med ?? 0).toFixed(2)}″, range {(s.lo ?? 0).toFixed(2)} – {(s.hi ?? 0).toFixed(2)}″)</p>
        : <p>Median {x.toFixed(2)}″ of {s.n} models (range {(s.lo ?? 0).toFixed(2)} – {(s.hi ?? 0).toFixed(2)}″)</p>}
      {nrm != null && nrm > 0 && <p>Normal for the day {nrm.toFixed(2)}″ ({Math.round((100 * x) / nrm)}% of normal)</p>}
    </>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{switcher ? "By location" : v === "precip" ? "Rain by day" : "Snow by day"}</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription>
          {model ? <>{model.label}'s forecast for each day (4 AM – 4 AM) ({what}), out to day {model.days}.</>
                 : coreOnly ? <>Each location's median of {listNames(coreOnly)} for each day (4 AM – 4 AM) ({what}).</>
                 : <>Each location's multi-model median for each day (4 AM – 4 AM) ({what}).</>}
          {" "}Region rows average their locations. Hover for the range across models{v === "precip" && " and the normal for the day"}.
        </CardDescription>
        {switcher && <CardAction>{switcher}</CardAction>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {hasSnow && !only && (
            <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
              <TabsList><TabsTrigger value="precip">Rain</TabsTrigger><TabsTrigger value="snow">Snow</TabsTrigger></TabsList>
            </Tabs>
          )}
          <ModelPick models={models} value={pick} onChange={setPick} core={core} />
          <div className="sm:ml-auto">
            <RampStrip ramp={ramp} range={v === "precip" ? [0.01, 4] : [0.1, 24]} unit="″" extra={<span className="ml-2">T = trace</span>} />
          </div>
        </div>
        <DayMatrix dates={data.dates} rows={rows} leadHead="Total" leadSub={`${span} days`} dimFrom={model ? model.days : undefined}
          style={(x) => rampCell(x, ramp, true)} fmt={(x) => amt(x, ramp)} tip={tip} flag={model ? undefined : farApart} />
        <p className="text-xs text-muted-foreground">
          <HatchKey what={`Hatched: models far apart (a spread of ${v === "precip" ? "½″" : "4″"} or more, and over 1¼ × the median)`} />{" "}
          {coreOnly ? `The core median uses only ${listNames(coreOnly)} on every day, so it stays the same set of models through the range; it leaves out the high-resolution regional models' detail in the first two days.`
            : pick === MEDIAN
            ? "The median uses whichever models reach that day, so the first two days include the high-resolution regional models and later days only the global ones."
            : `Days past ${model!.label}'s range are blank; the total covers its ${span} days.`}
        </p>
      </CardContent>
    </Card>
  )
}
