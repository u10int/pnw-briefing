import * as React from "react"
import { Line, LineChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts"

import { Takeaway } from "@/components/Takeaway"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { dayStats } from "@/sections/DayMatrix"
import type { Briefing, N } from "@/types"

const COLOR = ["var(--wwa)", "var(--nwor)"]
const day = (d: string) => Date.parse(`${d}T20:00:00Z`)
const tick = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" })
const mean = (xs: N[]) => { const ys = xs.filter((x): x is number => x != null); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null }

/** Each region's precipitation since October 1, added up day by day (the average across its
 *  locations' stations), against the stations' normal for the same days, carried on through the
 *  forecast (the model median) so you can see where the next two weeks would leave it. */
export function WaterYearCard({ data }: { data: Briefing }) {
  const wy = data.climo?.waterYear
  const stats = React.useMemo(() => dayStats(data, "precipitation_sum"), [data])
  const built = React.useMemo(() => {
    if (!wy) return null
    const regs = data.regions.map((r) => ({ r, names: data.points.filter((p) => p.region === r.id && wy.points[p.name]).map((p) => p.name) })).filter((x) => x.names.length)
    if (!regs.length) return null
    const nObs = wy.dates.length
    // the forecast days that come after the observations
    const fc = data.dates.map((d, k) => ({ d, k })).filter((x) => x.d > wy.dates[nObs - 1])
    const rows: Record<string, number | null>[] = []
    const run = regs.map(() => ({ obs: 0, nrm: 0, fcs: 0, ended: false }))
    const lastNormal = regs.map(({ names }) => mean(names.map((n) => wy.points[n].normal[nObs - 1])) ?? 0)
    wy.dates.forEach((d, i) => {
      const row: Record<string, number | null> = { t: day(d) }
      regs.forEach(({ names }, j) => {
        const ob = names.map((n) => wy.points[n].obs[i])
        const reporting = ob.filter((x) => x != null).length
        const nm = mean(names.map((n) => wy.points[n].normal[i])) ?? 0
        run[j].nrm += nm
        // a day counts once at least half the region's stations have reported it
        if (reporting * 2 >= names.length) run[j].obs += mean(ob) ?? 0
        else if (i >= nObs - 7) run[j].ended = true
        row[`o${j}`] = run[j].ended ? null : run[j].obs
        row[`n${j}`] = run[j].nrm
      })
      rows.push(row)
    })
    const pct = regs.map((_, j) => (run[j].nrm > 0 ? (100 * run[j].obs) / run[j].nrm : null))
    const now = run.map((x) => x.obs)
    // the forecast: start where the observations end
    regs.forEach((_, j) => { rows[rows.length - 1][`f${j}`] = now[j] })
    fc.forEach(({ d, k }) => {
      const row: Record<string, number | null> = { t: day(d) }
      regs.forEach(({ names }, j) => {
        run[j].fcs += mean(names.map((n) => stats[n]?.[k]?.med ?? null)) ?? 0
        run[j].nrm += lastNormal[j]
        row[`f${j}`] = now[j] + run[j].fcs
        row[`n${j}`] = run[j].nrm
      })
      rows.push(row)
    })
    const end = regs.map((_, j) => ({ fc: now[j] + run[j].fcs, nrm: run[j].nrm }))
    return { regs, rows, pct, now, end, todayT: day(wy.dates[nObs - 1]), nObs }
  }, [wy, data, stats])
  if (!wy || !built) return null
  const { regs, rows, pct, now, end, todayT } = built
  const config: ChartConfig = Object.fromEntries(regs.flatMap(({ r }, j) => [
    [`o${j}`, { label: `${r.short} observed`, color: COLOR[j] }], [`f${j}`, { label: `${r.short} with the forecast`, color: COLOR[j] }],
    [`n${j}`, { label: `${r.short} normal`, color: COLOR[j] }]]))
  const takeaway = <>{regs.map(({ r }, j) => <span key={r.id}>{j > 0 && "; "}{r.name} {now[j].toFixed(1)}″ since Oct 1{pct[j] != null && ` (${Math.round(pct[j]!)}% of normal)`}</span>)}.</>
  const fmt = (v: number) => `${v.toFixed(1)}″`

  return (
    <Card>
      <CardHeader>
        <CardTitle>Water year so far</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription>
          Precipitation since October 1 added up day by day, the average of each region's location stations (solid), against those stations' 1991 – 2020 normal (thin). The dashed line carries on with the forecast's model median for the next two weeks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
          <LineChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={tick} tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} />
            <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}″`} />
            <ReferenceLine x={todayT} stroke="var(--muted-foreground)" strokeDasharray="2 3" label={{ value: "Today", position: "insideTopRight", fontSize: 11, fill: "var(--muted-foreground)" }} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => tick(Number(p?.[0]?.payload?.t))}
              formatter={(v, name) => (
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                  <span className="font-mono tabular-nums">{fmt(Number(v))}</span>
                </div>
              )} />} />
            {regs.map((_, j) => <Line key={`n${j}`} isAnimationActive={false} dataKey={`n${j}`} dot={false} stroke={COLOR[j]} strokeWidth={1.2} strokeOpacity={0.55} />)}
            {regs.map((_, j) => <Line key={`f${j}`} isAnimationActive={false} dataKey={`f${j}`} dot={false} stroke={COLOR[j]} strokeWidth={2} strokeDasharray="5 4" connectNulls={false} />)}
            {regs.map((_, j) => <Line key={`o${j}`} isAnimationActive={false} dataKey={`o${j}`} dot={false} stroke={COLOR[j]} strokeWidth={2.4} connectNulls={false} />)}
          </LineChart>
        </ChartContainer>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {regs.map(({ r }, j) => (
            <span key={r.id} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: COLOR[j] }} />
              <span><span className="text-foreground">{r.name}</span>: with the forecast, {end[j].fc.toFixed(1)}″ against a normal {end[j].nrm.toFixed(1)}″ by {tick(rows[rows.length - 1].t as number)}</span>
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Thin lines are normal, solid observed, dashed the forecast added on. Stations: {regs.map(({ r, names }) => `${r.short} ${names.length}`).join(", ")}; a day counts once half a region's stations have reported it, and stations that stopped reporting are left out. ACIS (NOAA Regional Climate Centers).
        </p>
      </CardContent>
    </Card>
  )
}
