import * as React from "react"
import { Area, Bar, CartesianGrid, ComposedChart, ErrorBar, Line, LineChart, XAxis, YAxis } from "recharts"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { dayShort, maxOf, median, minOf } from "@/lib/format"
import type { Briefing, N } from "@/types"

const ENS_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"]

export function LocationPicker({ data, value, onChange }: { data: Briefing; value: string; onChange: (v: string) => void }) {
  const groups = data.regions.map((r) => ({ r, pts: data.points.filter((p) => p.region === r.id) }))
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[220px] bg-card" aria-label="Location">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {groups.map(({ r, pts }) => (
          <SelectGroup key={r.id}>
            <SelectLabel>{r.name}</SelectLabel>
            {pts.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

const axis = { tickLine: false, axisLine: false, tickMargin: 8 } as const

/** Running total per model, and the accumulated median of daily amounts (monotonic by construction). */
export function RunningTotal({ data, point }: { data: Briefing; point: string }) {
  const keys = data.models.map((_, i) => `m${i}`)
  const config: ChartConfig = Object.fromEntries([
    ...data.models.map((m, i) => [keys[i], { label: m.label + (m.source === "open-meteo" ? " *" : ""),
      color: m.tier === "regional" ? "#8fb6e8" : "#c3c7ce" }]),
    ["median", { label: "Median", color: "var(--foreground)" }],
  ])
  const rows = React.useMemo(() => {
    const cum = data.models.map(() => 0)
    let medCum = 0
    return data.dates.map((d, t) => {
      const row: Record<string, N | string> = { date: d }
      const daily = data.models.map((m) => m.data[point].precipitation_sum[t])
      data.models.forEach((m, i) => {
        const v = daily[i]
        if (v == null) { row[keys[i]] = null; return }
        cum[i] += v
        row[keys[i]] = +cum[i].toFixed(2)
      })
      medCum += median(daily) ?? 0
      row.median = +medCum.toFixed(2)
      return row
    })
  }, [data, point])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Running total</CardTitle>
        <CardDescription>Light blue lines are regional models, gray are global, the dark line is the median.</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
          <LineChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickFormatter={dayShort} {...axis} minTickGap={24} />
            <YAxis {...axis} width={44} tickFormatter={(v) => `${v} in`} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => dayShort(String(v))} />} />
            {keys.map((k) => (
              <Line isAnimationActive={false} key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={1.5} dot={false} connectNulls={false} />
            ))}
            <Line isAnimationActive={false} dataKey="median" type="monotone" stroke="var(--color-median)" strokeWidth={3} dot={false} />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

export function EnsemblePlume({ data, point }: { data: Briefing; point: string }) {
  const ens = data.ensembles.filter((e) => e.points[point])
  const plumePoints = data.points.filter((p) => p.plume).map((p) => p.name)
  const config: ChartConfig = Object.fromEntries(ens.map((e, i) => [`e${i}`, { label: `${e.label} (${e.members})`, color: ENS_COLORS[i % 3] }]))
  const rows = (ens[0]?.dates ?? []).map((d, t) => {
    const row: Record<string, unknown> = { date: d }
    ens.forEach((e, i) => {
      const p = e.points[point]
      row[`e${i}`] = p.p50[t]
      row[`b${i}`] = [p.p10[t], p.p90[t]]
    })
    return row
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ensembles</CardTitle>
        <CardDescription>Median and the 10th–90th percentile range of accumulated precipitation across members.</CardDescription>
      </CardHeader>
      <CardContent>
        {ens.length ? (
          <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
            <ComposedChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickFormatter={dayShort} {...axis} minTickGap={24} />
              <YAxis {...axis} width={44} tickFormatter={(v) => `${v} in`} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => dayShort(String(v))} />} />
              {ens.map((_, i) => (
                <Area isAnimationActive={false} key={`b${i}`} dataKey={`b${i}`} type="monotone" stroke="none" fill={`var(--color-e${i})`}
                      fillOpacity={0.12} tooltipType="none" legendType="none" />
              ))}
              {ens.map((_, i) => (
                <Line isAnimationActive={false} key={`e${i}`} dataKey={`e${i}`} type="monotone" stroke={`var(--color-e${i})`} strokeWidth={2.5}
                      strokeDasharray={i === 2 ? "6 4" : undefined} dot={false} />
              ))}
              <ChartLegend content={<ChartLegendContent />} />
            </ComposedChart>
          </ChartContainer>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ensembles are computed for {plumePoints.join(", ")}. Pick one of those to see the spread.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export function EnsembleTable({ data }: { data: Briefing }) {
  if (!data.ensembles.length) return null
  const pts = data.points.filter((p) => p.plume).map((p) => p.name)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.meta.days}-day ensemble totals</CardTitle>
        <CardDescription>Median, with the 10th–90th percentile range (in).</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Location</TableHead>
              {data.ensembles.map((e) => <TableHead key={e.label} className="text-right">{e.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pts.map((p) => (
              <TableRow key={p}>
                <TableCell>{p}</TableCell>
                {data.ensembles.map((e) => {
                  const s = e.points[p]
                  const last = s ? s.p50.length - 1 : -1
                  return (
                    <TableCell key={e.label} className="text-right tabular-nums">
                      {s ? (<><span className="font-semibold">{s.p50[last].toFixed(1)}</span>{" "}
                        <span className="text-muted-foreground">{s.p10[last].toFixed(1)}–{s.p90[last].toFixed(1)}</span></>) : "–"}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/** Precipitation, temperature and gusts on a shared date axis: model median with the model range. */
export function DayByDay({ data, point }: { data: Briefing; point: string }) {
  const rows = data.dates.map((d, t) => {
    const col = (k: keyof (typeof data.models)[0]["data"][string]) => data.models.map((m) => m.data[point][k][t])
    const pr = col("precipitation_sum"), tx = col("temperature_2m_max"), tn = col("temperature_2m_min"), gu = col("wind_gusts_10m_max")
    const pm = median(pr) ?? 0
    return {
      date: d,
      precip: +pm.toFixed(2), precipErr: [+(pm - (minOf(pr) ?? pm)).toFixed(2), +((maxOf(pr) ?? pm) - pm).toFixed(2)],
      high: median(tx), highRange: [minOf(tx), maxOf(tx)],
      low: median(tn), lowRange: [minOf(tn), maxOf(tn)],
      gust: median(gu), gustMax: maxOf(gu),
    }
  })
  const pConf: ChartConfig = { precip: { label: "Median precip (in)", color: "var(--chart-1)" } }
  const tConf: ChartConfig = { high: { label: "High °F", color: "var(--chart-2)" }, low: { label: "Low °F", color: "var(--chart-1)" } }
  const gConf: ChartConfig = { gust: { label: "Median gust (mph)", color: "var(--foreground)" }, gustMax: { label: "Highest model (mph)", color: "#9ca3af" } }
  const x = <XAxis dataKey="date" tickFormatter={dayShort} {...axis} minTickGap={16} />
  return (
    <Card>
      <CardHeader>
        <CardTitle>Day by day</CardTitle>
        <CardDescription>Model median, with the full range across models as whiskers or shading.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-3">
        <div>
          <p className="mb-2 text-sm font-medium">Precipitation</p>
          <ChartContainer config={pConf} className="aspect-auto h-[220px] w-full">
            <ComposedChart data={rows} margin={{ left: 0, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} />{x}
              <YAxis {...axis} width={40} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => dayShort(String(v))} />} />
              <Bar isAnimationActive={false} dataKey="precip" fill="var(--color-precip)" radius={[3, 3, 0, 0]}>
                <ErrorBar isAnimationActive={false} dataKey="precipErr" direction="y" stroke="#1b1f24" strokeWidth={1.25} width={4} />
              </Bar>
            </ComposedChart>
          </ChartContainer>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">High and low</p>
          <ChartContainer config={tConf} className="aspect-auto h-[220px] w-full">
            <ComposedChart data={rows} margin={{ left: 0, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} />{x}
              <YAxis {...axis} width={40} domain={[(m: number) => Math.floor((m - 3) / 5) * 5, (m: number) => Math.ceil((m + 3) / 5) * 5]} tickFormatter={(v) => `${v}°`} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => dayShort(String(v))} />} />
              <Area isAnimationActive={false} dataKey="highRange" stroke="none" fill="var(--color-high)" fillOpacity={0.12} tooltipType="none" />
              <Area isAnimationActive={false} dataKey="lowRange" stroke="none" fill="var(--color-low)" fillOpacity={0.12} tooltipType="none" />
              <Line isAnimationActive={false} dataKey="high" stroke="var(--color-high)" strokeWidth={2} dot={{ r: 2.5 }} />
              <Line isAnimationActive={false} dataKey="low" stroke="var(--color-low)" strokeWidth={2} dot={{ r: 2.5 }} />
            </ComposedChart>
          </ChartContainer>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Peak gust</p>
          <ChartContainer config={gConf} className="aspect-auto h-[220px] w-full">
            <LineChart data={rows} margin={{ left: 0, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} />{x}
              <YAxis {...axis} width={40} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => dayShort(String(v))} />} />
              <Line isAnimationActive={false} dataKey="gustMax" stroke="var(--color-gustMax)" strokeWidth={1.5} strokeDasharray="3 3" dot={false} />
              <Line isAnimationActive={false} dataKey="gust" stroke="var(--color-gust)" strokeWidth={2} dot={{ r: 2.5 }} />
            </LineChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  )
}
