import * as React from "react"
import { Area, Bar, CartesianGrid, ComposedChart, ErrorBar, Line, LineChart, XAxis, YAxis } from "recharts"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { dayShort, maxOf, median, minOf } from "@/lib/format"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import type { Briefing, N, TrendVar } from "@/types"

const ENS_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"]

export function LocationPicker({ data, value, onChange }: { data: Briefing; value: string; onChange: (v: string) => void }) {
  // locations outside the comparison regions (e.g. Vancouver BC) are listed last
  const others = data.points.filter((p) => !data.regions.some((r) => r.id === p.region))
  const zones = [...new Set(others.map((p) => p.zone ?? "Other locations"))]
  const groups = [
    ...data.regions.map((r) => ({ r: { id: r.id, name: r.name }, pts: data.points.filter((p) => p.region === r.id) })),
    ...zones.map((z) => ({ r: { id: `zone:${z}`, name: z }, pts: others.filter((p) => (p.zone ?? "Other locations") === z) })),
  ]
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
function RunningTotalChart({ data, point }: { data: Briefing; point: string }) {
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
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
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
  )
}

function EnsembleChart({ data, point }: { data: Briefing; point: string }) {
  const ens = data.ensembles.filter((e) => e.points[point])
  const plumePoints = Object.keys(data.ensembles[0]?.points ?? {})
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
  return ens.length ? (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
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
      {plumePoints.length ? <>Ensembles are computed for {plumePoints.join(", ")}. Pick one of those to see the spread.</> : "No ensemble forecasts in this briefing."}
    </p>
  )
}

const PRECIP_VIEWS = {
  models: { label: "Models", desc: "Running total for each model. Light blue lines are regional models, gray are global, the dark line is the median." },
  ensembles: { label: "Ensembles", desc: "Ensemble median and the 10th – 90th percentile range of accumulated precipitation across members." },
} as const
type PrecipView = keyof typeof PRECIP_VIEWS

/** Accumulated precipitation: the deterministic models' running totals, or the ensemble spread. */
export function PrecipTotalCard({ data, point }: { data: Briefing; point: string }) {
  const [view, setView] = React.useState<PrecipView>(() => {
    try { return localStorage.getItem("location-precip-view") === "ensembles" ? "ensembles" : "models" } catch { return "models" }
  })
  const pick = (v: string) => {
    setView(v as PrecipView)
    try { localStorage.setItem("location-precip-view", v) } catch { /* storage unavailable */ }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Total precipitation</CardTitle>
        <CardDescription>{PRECIP_VIEWS[view].desc}</CardDescription>
        <CardAction>
          <Tabs value={view} onValueChange={pick}>
            <TabsList>{(Object.keys(PRECIP_VIEWS) as PrecipView[]).map((k) => <TabsTrigger key={k} value={k}>{PRECIP_VIEWS[k].label}</TabsTrigger>)}</TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        {view === "models" ? <RunningTotalChart data={data} point={point} /> : <EnsembleChart data={data} point={point} />}
      </CardContent>
    </Card>
  )
}

export function EnsembleTable({ data }: { data: Briefing }) {
  if (!data.ensembles.length) return null
  const pts = data.points.map((p) => p.name).filter((n) => data.ensembles.some((e) => e.points[n]))
  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.meta.days}-day ensemble totals</CardTitle>
        <CardDescription>Median, with the 10th – 90th percentile range (in).</CardDescription>
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
                        <span className="text-muted-foreground">{s.p10[last].toFixed(1)} – {s.p90[last].toFixed(1)}</span></>) : "–"}
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

/** A boolean setting remembered in this browser (when storage is available). */
function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = React.useState(() => {
    try {
      const s = localStorage.getItem(key)
      return s == null ? initial : s === "1"
    } catch { return initial }
  })
  return [v, (x: boolean) => {
    setV(x)
    try { localStorage.setItem(key, x ? "1" : "0") } catch { /* storage unavailable */ }
  }]
}

/** One decimal, for tooltips. */
const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10)

const MODEL_GRAY = "#bcc2ca"
const MODEL_HOVER = "#4b5563"

type Hover = { chart: "temp" | "gust"; model: number } | null
const modelOf = (k: string) => Number(k.slice(1))

/**
 * Thin gray per-model lines drawn under the medians. Hovering one highlights that model in every
 * chart and names it above the chart being hovered.
 */
function modelLines(chart: "temp" | "gust", keys: string[], hovered: Hover, setHovered: (h: Hover) => void) {
  return keys.map((k) => {
    const on = hovered?.model === modelOf(k)
    return (
      <Line isAnimationActive={false} key={k} dataKey={k} type="linear" dot={false} activeDot={false}
            stroke={on ? MODEL_HOVER : MODEL_GRAY} strokeWidth={on ? 1.75 : 1}
            strokeOpacity={hovered && !on ? 0.55 : 0.9} connectNulls={false}
            tooltipType="none" legendType="none"
            onMouseEnter={() => setHovered({ chart, model: modelOf(k) })} onMouseLeave={() => setHovered(null)} />
    )
  })
}

/** Precipitation, temperature and gusts on a shared date axis: model median with the model range. */
export function DayByDay({ data, point }: { data: Briefing; point: string }) {
  const [all, setAll] = useStoredFlag("pnw-briefing.daybyday.allModels", false)
  const [hovered, setHovered] = React.useState<Hover>(null)
  const names = data.models.map((m) => m.label + (m.source === "open-meteo" ? " *" : ""))
  // models with any value at this location, per variable
  const has = (k: "temperature_2m_max" | "temperature_2m_min" | "wind_gusts_10m_max") =>
    data.models.map((m, i) => (m.data[point]?.[k]?.some((v) => v != null) ? i : -1)).filter((i) => i >= 0)
  const hiIdx = has("temperature_2m_max"), loIdx = has("temperature_2m_min"), guIdx = has("wind_gusts_10m_max")

  const rows = data.dates.map((d, t) => {
    const col = (k: keyof (typeof data.models)[0]["data"][string]) => data.models.map((m) => m.data[point]?.[k]?.[t] ?? null)
    const pr = col("precipitation_sum"), tx = col("temperature_2m_max"), tn = col("temperature_2m_min"), gu = col("wind_gusts_10m_max")
    const pm = median(pr) ?? 0
    const row: Record<string, unknown> = {
      date: d,
      precip: +pm.toFixed(2), precipErr: [+(pm - (minOf(pr) ?? pm)).toFixed(2), +((maxOf(pr) ?? pm) - pm).toFixed(2)],
      high: r1(median(tx)), highRange: [minOf(tx), maxOf(tx)],
      low: r1(median(tn)), lowRange: [minOf(tn), maxOf(tn)],
      gust: r1(median(gu)), gustMax: r1(maxOf(gu)),
    }
    hiIdx.forEach((i) => { row[`h${i}`] = tx[i] })
    loIdx.forEach((i) => { row[`l${i}`] = tn[i] })
    guIdx.forEach((i) => { row[`g${i}`] = gu[i] })
    return row
  })
  const pConf: ChartConfig = { precip: { label: "Median precip (in)", color: "var(--chart-1)" } }
  const tConf: ChartConfig = { high: { label: "High °F", color: "var(--chart-2)" }, low: { label: "Low °F", color: "var(--chart-1)" } }
  const gConf: ChartConfig = { gust: { label: "Median gust (mph)", color: "var(--foreground)" }, gustMax: { label: "Highest model (mph)", color: "#9ca3af" } }
  const x = <XAxis dataKey="date" tickFormatter={dayShort} {...axis} minTickGap={16} />
  const hoverLabel = (chart: "temp" | "gust") =>
    all && hovered?.chart === chart ? <span className="font-normal text-muted-foreground"> · {names[hovered.model]}</span> : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Day by day</CardTitle>
        <CardDescription>
          Model median, with the full range across models as whiskers or shading.
          {all && " Gray lines are individual models; hover one to see which."}
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Switch id="daybyday-all" checked={all} onCheckedChange={setAll} />
            <Label htmlFor="daybyday-all">All models</Label>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div>
          <p className="mb-2 text-sm font-medium">Precipitation</p>
          <ChartContainer config={pConf} className="aspect-auto h-[180px] w-full">
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
          <p className="mb-2 truncate text-sm font-medium">High and low{hoverLabel("temp")}</p>
          <ChartContainer config={tConf} className="aspect-auto h-[180px] w-full">
            <ComposedChart data={rows} margin={{ left: 0, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} />{x}
              <YAxis {...axis} width={40} domain={[(m: number) => Math.floor((m - 3) / 5) * 5, (m: number) => Math.ceil((m + 3) / 5) * 5]} tickFormatter={(v) => `${v}°`} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => dayShort(String(v))} />} />
              {!all && <Area isAnimationActive={false} dataKey="highRange" stroke="none" fill="var(--color-high)" fillOpacity={0.12} tooltipType="none" />}
              {!all && <Area isAnimationActive={false} dataKey="lowRange" stroke="none" fill="var(--color-low)" fillOpacity={0.12} tooltipType="none" />}
              {all && modelLines("temp", [...hiIdx.map((i) => `h${i}`), ...loIdx.map((i) => `l${i}`)], hovered, setHovered)}
              <Line isAnimationActive={false} dataKey="high" stroke="var(--color-high)" strokeWidth={2} dot={{ r: 2.5 }} />
              <Line isAnimationActive={false} dataKey="low" stroke="var(--color-low)" strokeWidth={2} dot={{ r: 2.5 }} />
            </ComposedChart>
          </ChartContainer>
        </div>
        <div>
          <p className="mb-2 truncate text-sm font-medium">Peak gust{hoverLabel("gust")}</p>
          <ChartContainer config={gConf} className="aspect-auto h-[180px] w-full">
            <LineChart data={rows} margin={{ left: 0, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} />{x}
              <YAxis {...axis} width={40} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => dayShort(String(v))} />} />
              {all
                ? modelLines("gust", guIdx.map((i) => `g${i}`), hovered, setHovered)
                : <Line isAnimationActive={false} dataKey="gustMax" stroke="var(--color-gustMax)" strokeWidth={1.5} strokeDasharray="3 3" dot={false} />}
              <Line isAnimationActive={false} dataKey="gust" stroke="var(--color-gust)" strokeWidth={2} dot={{ r: 2.5 }} />
            </LineChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  )
}


const GLANCE: { k: TrendVar; label: string }[] = [
  { k: "precip", label: "Precip" }, { k: "snow", label: "Snow" }, { k: "gust", label: "Strongest gust" },
  { k: "tmax", label: "Average high" }, { k: "tmin", label: "Average low" },
]
const glanceFmt = (k: TrendVar, v: number) =>
  k === "precip" || k === "snow" ? `${v >= 10 ? v.toFixed(0) : v.toFixed(k === "precip" && v < 1 ? 2 : 1)}″` : k === "gust" ? `${Math.round(v)} mph` : `${Math.round(v)}°`

/** One location's detail in a panel that slides over the page: where it is, its next 7 days at a
 *  glance (with the change since yesterday), the running total, the ensemble spread and the
 *  day-by-day detail. Opened from location names anywhere on the page, and from the map. */
export function LocationPanel({ data, name, onChange, onClose }: { data: Briefing; name: string | null; onChange: (n: string) => void; onClose: () => void }) {
  const p = data.points.find((x) => x.name === name)
  const region = p?.region ? data.regions.find((r) => r.id === p.region)?.name : p?.zone
  const w = data.trends?.windows.find((x) => x.days === 7) ?? data.trends?.windows[0]
  const c = data.change?.trends?.windows.find((x) => x.days === w?.days)
  const kind = p ? { lowland: "Lowland", coast: "Coast", pass: "Pass" }[p.kind] : ""
  return (
    <Sheet open={!!p} onOpenChange={(o) => { if (!o) onClose() }}>
      {/* no focus jump to the picker on open: it would pop the keyboard-focus ring on touch */}
      <SheetContent aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
        {p && (
          <>
            <div className="border-b px-6 pt-5 pb-4 pr-14">
              <SheetTitle>{p.name}</SheetTitle>
              <SheetDescription>{[p.area, region, kind].filter(Boolean).join(" · ")}</SheetDescription>
              <div className="mt-3"><LocationPicker data={data} value={p.name} onChange={onChange} /></div>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
              {w?.points[p.name] && (
                <div>
                  <p className="mb-2 text-sm font-medium">{w.label}</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
                    {GLANCE.map(({ k, label }) => {
                      const s = w.points[p.name][k]
                      const d = c?.points[p.name]?.[k]
                      if (!s) return null
                      return (
                        <div key={k}>
                          <p className="text-xs text-muted-foreground">{label}</p>
                          <p className="text-lg font-semibold tabular-nums">{glanceFmt(k, s.median)}</p>
                          {d && Math.abs(d.delta) >= (k === "precip" ? 0.05 : k === "snow" ? 0.2 : k === "gust" ? 1 : 0.5) && (
                            <p className="text-xs text-muted-foreground tabular-nums">{d.delta > 0 ? "+" : "−"}{glanceFmt(k, Math.abs(d.delta))} since yesterday</p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              <PrecipTotalCard data={data} point={p.name} />
              <DayByDay data={data} point={p.name} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
