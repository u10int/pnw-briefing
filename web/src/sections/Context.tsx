import * as React from "react"
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { dateRange, dayShort, inch } from "@/lib/format"
import { pctCell } from "@/sections/Totals"
import type { ArEvent, Briefing, ModelSeries, N, PointOdds } from "@/types"

// ------------------------------------------------------------------ shared: multi-model time series

/** One colour per model, stable across charts. */
const MODEL_COLORS: Record<string, string> = {
  HRRR: "#2a78d6", RRFS: "#1baf7a", "NAM 3 km": "#8b5cf6", NBM: "#0ea5b7",
  GFS: "#eb6834", "ECMWF IFS": "#b45309", "ECMWF AIFS": "#be185d",
}
const colorOf = (m: string, i: number) => MODEL_COLORS[m] ?? ["#64748b", "#a16207", "#0f766e"][i % 3]

const PT = "America/Los_Angeles"
// "Thu 5", built by hand: Intl orders weekday and day differently across engines
const tickDay = (t: number) =>
  `${new Date(t).toLocaleDateString("en-US", { weekday: "short", timeZone: PT })} ${new Date(t).toLocaleDateString("en-US", { day: "numeric", timeZone: PT })}`
const tipTime = (t: number) =>
  new Date(t).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", timeZone: PT })

/** Rows keyed by time (ms) with one column per model, for a shared tooltip. */
function rowsOf(series: { model: string; times: string[]; values: N[] }[]) {
  const byT = new Map<number, Record<string, number | null>>()
  series.forEach((s, k) => s.times.forEach((iso, i) => {
    const t = Date.parse(iso)
    if (!byT.has(t)) byT.set(t, { t })
    byT.get(t)![`m${k}`] = s.values[i]
  }))
  return [...byT.values()].sort((a, b) => (a.t as number) - (b.t as number))
}

/** Midnight (Pacific) ticks across the data's range; every other day when the range is long. */
const ptHourFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: PT })
const ptHour = (t: number) => Number(ptHourFmt.formatToParts(t).find((x) => x.type === "hour")?.value) % 24
function dayTicks(rows: Record<string, number | null>[]) {
  if (!rows.length) return []
  const a = Math.ceil((rows[0].t as number) / 36e5) * 36e5, b = rows[rows.length - 1].t as number
  const out: number[] = []
  for (let t = a; t <= b; t += 36e5) if (ptHour(t) === 0) out.push(t)
  return out.length > 8 ? out.filter((_, i) => i % 2 === 0) : out
}

/** Evenly spaced ticks from lo to hi. */
const ticksOf = (lo: number, hi: number, step: number) => {
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

function SeriesChart({ series, unit, height = 220, children, domain, format, yTicks }: {
  series: ModelSeries[]; unit: string; height?: number; children?: React.ReactNode
  domain?: [number, number]
  format?: (v: number) => string
  yTicks?: number[]
}) {
  const rows = React.useMemo(() => rowsOf(series), [series])
  const config: ChartConfig = Object.fromEntries(series.map((s, k) => [`m${k}`, { label: s.model, color: colorOf(s.model, k) }]))
  const fmt = format ?? ((v: number) => `${v}`)
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={dayTicks(rows)}
               tickFormatter={tickDay} tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickLine={false} axisLine={false} width={52} domain={domain} ticks={yTicks} allowDataOverflow
               tickFormatter={(v) => `${fmt(v)}`} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => tipTime(Number(p?.[0]?.payload?.t))}
          formatter={(v, name) => (
            <div className="flex w-full items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-[2px]" style={{ background: config[String(name)]?.color }} />
                {config[String(name)]?.label}
              </span>
              <span className="font-mono tabular-nums">{fmt(Number(v))} {unit}</span>
            </div>
          )} />} />
        {children}
        {series.map((s, k) => (
          <Line key={s.model} isAnimationActive={false} dataKey={`m${k}`} type="monotone" dot={false} connectNulls
                stroke={`var(--color-m${k})`} strokeWidth={s.tier === "regional" ? 1.6 : 2} />
        ))}
      </LineChart>
    </ChartContainer>
  )
}

function ModelLegend({ models }: { models: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {models.map((m, k) => (
        <span key={m} className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded" style={{ background: colorOf(m, k) }} />{m}
        </span>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ already fallen (MRMS)

function wetWords(pct: N) {
  if (pct == null) return null
  if (pct >= 150) return "much wetter than normal"
  if (pct >= 115) return "wetter than normal"
  if (pct >= 85) return "near normal"
  if (pct >= 60) return "drier than normal"
  return "much drier than normal"
}

export function ObservedCard({ data }: { data: Briefing }) {
  const o = data.observed
  if (!o) return null
  const w7 = o.windows.find((w) => w.days === 7), w30 = o.windows.find((w) => w.days === 30)
  if (!w7 || !w30) return null
  const missing = [...new Set([...w7.missingDays, ...w30.missingDays])]
  const rows: { name: string; group?: boolean; s7: typeof w7.points[string]; s30: typeof w30.points[string] }[] = [
    ...data.regions.map((r) => ({ name: r.name, group: true, s7: w7.regions[r.id], s30: w30.regions[r.id] })),
    ...data.points.map((p) => ({ name: p.name, s7: w7.points[p.name], s30: w30.points[p.name] })),
  ]
  const src = data.maps.observed ? (data.maps.observed.startsWith("data:") ? data.maps.observed : `data/${data.maps.observed}`) : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>How wet it's been</CardTitle>
        <CardDescription>
          Observed precipitation through {dateRange(w30.to, w30.to)}, from NOAA's radar-and-gauge analysis (MRMS),
          against 1991–2020 normals. Wet ground turns the same rain into more runoff.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="space-y-3">
          <ul className="space-y-1 text-sm">
            {data.regions.map((r) => {
              const s = w30.regions[r.id]
              return s?.obs != null && (
                <li key={r.id}><span className="font-medium">{r.name}:</span>{" "}
                  {inch(s.obs)} in over 30 days{s.pct != null && <>, {Math.round(s.pct)}% of normal, {wetWords(s.pct)}</>}.</li>
              )
            })}
          </ul>
          <div className="max-h-[420px] overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">7 days</TableHead>
                  <TableHead className="text-right">% normal</TableHead>
                  <TableHead className="text-right">30 days</TableHead>
                  <TableHead className="text-right">% normal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.name} className={r.group ? "bg-muted/40 font-medium" : ""}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{inch(r.s7?.obs ?? null, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums" style={pctCell(r.s7?.pct ?? null)}>{r.s7?.pct == null ? "–" : Math.round(r.s7.pct)}</TableCell>
                    <TableCell className="text-right tabular-nums">{inch(r.s30?.obs ?? null, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums" style={pctCell(r.s30?.pct ?? null)}>{r.s30?.pct == null ? "–" : Math.round(r.s30.pct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Region rows average every grid cell in the region. MRMS tends to run low in the mountains, where terrain
            blocks the radar beam and gauges are sparse, so mountain and region totals are likely underestimates.
            Percent of normal is blank outside the US (no PRISM normals).
            {missing.length > 0 && ` MRMS had no data for ${missing.map((d) => dayShort(d)).join(", ")}; those days are left out of the totals and the normals.`}
          </p>
        </div>
        {src && (
          <a href={src} target="_blank" rel="noopener" title="Open full size" className="block self-start">
            <img src={src} alt="Observed precipitation over the past 7 and 30 days, and percent of normal" className="w-full rounded-md" loading="lazy" />
          </a>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ atmospheric rivers

const AR_COLORS = ["#9ca3af", "#4f9fd8", "#3fae6a", "#e9b625", "#f08a24", "#d9342b"]
const AR_SHORT = ["Below scale", "AR1 Weak", "AR2 Moderate", "AR3 Strong", "AR4 Extreme", "AR5 Exceptional"]

function ArBadge({ rank }: { rank: number }) {
  return (
    <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium"
          style={{ background: AR_COLORS[rank], color: rank >= 3 ? "#1b1f24" : "#fff" }}>{AR_SHORT[rank]}</span>
  )
}

/** Events at one place from different models, merged where their times overlap. */
function clusters(events: ArEvent[]) {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start))
  const out: { start: string; end: string; byModel: Record<string, ArEvent> }[] = []
  for (const e of sorted) {
    const last = out[out.length - 1]
    if (last && e.start <= last.end) {
      if (e.end > last.end) last.end = e.end
      const prev = last.byModel[e.model]
      if (!prev || e.rank > prev.rank) last.byModel[e.model] = e
    } else out.push({ start: e.start, end: e.end, byModel: { [e.model]: e } })
  }
  return out
}

export function ArCard({ data }: { data: Briefing }) {
  const ar = data.ar
  const [point, setPoint] = React.useState(ar?.points[0] ?? "")
  if (!ar) return null
  const series: ModelSeries[] = ar.models.map((m) => ({ model: m.model, tier: m.tier, times: m.times, values: m.ivt[point] ?? [] }))
  const events = ar.events.filter((e) => e.rank >= 1)
  const rows = ar.points.flatMap((p) => clusters(events.filter((e) => e.point === p)).map((c) => ({ point: p, ...c })))
    .sort((a, b) => a.start.localeCompare(b.start))
  const peakAt = (p: string) => Math.max(0, ...events.filter((e) => e.point === p).map((e) => e.rank))
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: PT })
  const arMax = Math.max(0, ...series.flatMap((s) => s.values).filter((v): v is number => v != null))
  const arTop = Math.max(750, Math.ceil((arMax + 50) / 250) * 250)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Atmospheric rivers</CardTitle>
        <CardDescription>
          Water vapor transport (IVT) at the coast from {ar.models.map((m) => m.model).join(" and ")}, ranked on the
          CW3E AR scale: peak IVT sets the category, lasting 48 hours or more raises it one step and under 24 hours lowers it one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {ar.points.map((p) => (
            <div key={p} className="flex items-center gap-2 text-sm"><span className="font-medium">{p}</span>
              {peakAt(p) ? <ArBadge rank={peakAt(p)} /> : <span className="text-muted-foreground">no AR</span>}</div>
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">IVT at {point} (kg m⁻¹ s⁻¹)</p>
              <Tabs value={point} onValueChange={setPoint}>
                <TabsList>{ar.points.map((p) => <TabsTrigger key={p} value={p}>{p}</TabsTrigger>)}</TabsList>
              </Tabs>
            </div>
            <SeriesChart series={series} unit="kg/m/s" height={240} domain={[0, arTop]} yTicks={ticksOf(0, arTop, 250)}
                         format={(v) => `${Math.round(v)}`}>
              {ar.breaks.map((b, k) => (
                <ReferenceArea key={b} y1={b} y2={ar.breaks[k + 1] ?? 3000} fill={AR_COLORS[Math.min(k + 1, 5)]} fillOpacity={0.09} ifOverflow="hidden" />
              ))}
              <ReferenceLine y={250} stroke="#6b7280" strokeDasharray="4 3" label={{ value: "AR threshold 250", position: "insideTopLeft", fontSize: 10, fill: "#6b7280" }} />
            </SeriesChart>
            <ModelLegend models={series.map((s) => s.model)} />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">AR events at the coast</p>
            {rows.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Where</TableHead><TableHead>By model</TableHead></TableRow></TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="whitespace-nowrap">{dateRange(day(r.start), day(r.end))}</TableCell>
                      <TableCell>{r.point}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {Object.values(r.byModel).map((e) => (
                            <span key={e.model} className="flex flex-wrap items-center gap-1.5 text-xs">
                              <ArBadge rank={e.rank} /><span className="text-muted-foreground">{e.model}, peak {e.peak}, {e.hours} h</span>
                            </span>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <p className="text-sm text-muted-foreground">No atmospheric river (IVT of 250 or more) reaches the coastal locations in these runs.</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ ensemble odds

type OddsKey = "rain24" | "rain72" | "snow24"
const ODDS: { key: OddsKey; label: string; what: string }[] = [
  { key: "rain24", label: "Heavy rain, 24 h", what: "24-hour precipitation at or above the location's heavy-rain threshold" },
  { key: "rain72", label: "Multi-day rain, 72 h", what: "3-day precipitation ending that day at or above the multi-day threshold" },
  { key: "snow24", label: "Snow, 24 h", what: "24-hour snowfall at or above the location's snow threshold (ECMWF ENS, 10:1)" },
]
const PROB = ["#f4f1fb", "#e2daf5", "#c9b9ec", "#a993df", "#8a6fd0", "#6b4fbc", "#4f3799"]
function probCell(v: N) {
  if (v == null) return { background: "transparent", color: "var(--muted-foreground)" }
  if (v < 5) return { background: "transparent", color: "var(--muted-foreground)" }
  const i = Math.min(PROB.length - 1, Math.floor(v / 15))
  return { background: PROB[i], color: i >= 4 ? "#fff" : "var(--foreground)" }
}

export function OddsCard({ data }: { data: Briefing }) {
  const o = data.odds
  const [key, setKey] = React.useState<OddsKey>("rain24")
  if (!o) return null
  const avail = ODDS.filter((d) => Object.values(o.points).some((p) => p[d.key]?.some((v) => v != null && v > 0) || (d.key !== "snow24" && p[d.key])))
  const def = ODDS.find((d) => d.key === key) ?? ODDS[0]
  const groups = [
    ...data.regions.map((r) => ({ name: r.name, pts: data.points.filter((p) => p.region === r.id) })),
    { name: "Other locations", pts: data.points.filter((p) => !data.regions.some((r) => r.id === p.region)) },
  ].filter((g) => g.pts.length)
  const rowOf = (p: PointOdds | undefined) => p?.[key]
  const total = o.ensembles.map((e) => `${e.label}, ${e.members} members`).join(" and ")
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ensemble odds</CardTitle>
        <CardDescription>
          Share of ensemble members ({total}, pooled) reaching each location's impact threshold: {def.what}.
        </CardDescription>
        <CardAction>
          <Tabs value={key} onValueChange={(v) => setKey(v as OddsKey)}>
            <TabsList>{avail.map((d) => <TabsTrigger key={d.key} value={d.key}>{d.label}</TabsTrigger>)}</TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Threshold</TableHead>
              {o.dates.map((d) => <TableHead key={d} className="px-1 text-center text-xs">{dayShort(d)}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.flatMap((g) => [
              <TableRow key={g.name} className="hover:bg-transparent"><TableCell colSpan={o.dates.length + 2} className="pt-3 text-xs font-medium text-muted-foreground">{g.name}</TableCell></TableRow>,
              ...g.pts.map((p) => {
                const po = o.points[p.name]
                const vals = rowOf(po)
                const thr = po?.thresholds[key]
                return (
                  <TableRow key={p.name}>
                    <TableCell className="whitespace-nowrap">{p.name}</TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">{thr == null ? "–" : `${thr}″`}</TableCell>
                    {o.dates.map((d, i) => {
                      const v = vals?.[i] ?? null
                      return <TableCell key={d} className="px-1 text-center text-xs tabular-nums" style={probCell(v)}>{v == null ? "" : v < 5 ? "" : `${v}`}</TableCell>
                    })}
                  </TableRow>
                )
              }),
            ])}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          Percent of members; blank under 5%. Thresholds are the impacts table's for lowland, coast and pass locations.
          {key === "rain72" && " The first two days have no complete 3-day total."}
          {key === "snow24" && " GEFS has no snowfall field, so snow odds come from ECMWF ENS alone."}
          {" "}The interactive map's Summary mode has gridded odds for fixed amounts.
        </p>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ pressure gradients

export function GradientsCard({ data }: { data: Briefing }) {
  const gs = (data.gradients ?? []).filter((g) => g.series.length)
  if (!gs.length) return null
  const models = [...new Set(gs.flatMap((g) => g.series.map((s) => s.model)))]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pressure gradients</CardTitle>
        <CardDescription>
          Sea-level pressure difference between station pairs (hPa), from each model's grid. Dashed lines are rules of thumb
          for where impacts usually start.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ModelLegend models={models} />
        <div className="grid gap-6 lg:grid-cols-2">
          {gs.map((g) => {
            const series = models.map((m) => g.series.find((s) => s.model === m)).filter(Boolean) as ModelSeries[]
            const vals = series.flatMap((s) => s.values).filter((v): v is number => v != null)
            const lim = Math.max(4, ...vals.map(Math.abs), ...g.thresholds.map((t) => Math.abs(t.value)))
            const gtop = Math.ceil((lim + 1) / 4) * 4
            return (
              <div key={g.id}>
                <p className="text-sm font-medium">{g.a} − {g.b}</p>
                <p className="mb-2 text-xs text-muted-foreground">{g.meaning}</p>
                <SeriesChart series={series} unit="hPa" domain={[-gtop, gtop]} yTicks={ticksOf(-gtop, gtop, 4)} format={(v) => v.toFixed(0)}>
                  <ReferenceLine y={0} stroke="#9ca3af" />
                  {g.thresholds.map((t) => (
                    <ReferenceLine key={t.value} y={t.value} stroke="#b45309" strokeDasharray="5 4"
                                   label={{ value: t.label, position: t.value >= 0 ? "insideTopLeft" : "insideBottomLeft", fontSize: 10, fill: "#b45309" }} />
                  ))}
                </SeriesChart>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ snow level at the passes

export function SnowLevelCard({ data }: { data: Briefing }) {
  const sl = data.snowLevel
  const passes = (sl?.passes ?? []).filter((p) => p.series.length)
  const [name, setName] = React.useState(passes[0]?.name ?? "")
  if (!sl || !passes.length) return null
  const p = passes.find((x) => x.name === name) ?? passes[0]
  const vals = p.series.flatMap((s) => s.values).filter((v): v is number => v != null)
  const top = Math.ceil(Math.max(p.elev_ft + 2000, ...vals) / 1000) * 1000
  return (
    <Card>
      <CardHeader>
        <CardTitle>Snow level at the passes</CardTitle>
        <CardDescription>
          Each model's freezing level minus {sl.offset_ft.toLocaleString("en-US")} ft, where snow usually starts reaching the
          ground. Below the pass elevation (shaded), precipitation at the pass falls as snow.
        </CardDescription>
        <CardAction>
          <Tabs value={p.name} onValueChange={setName}>
            <TabsList>{passes.map((x) => <TabsTrigger key={x.name} value={x.name}>{x.name.replace(" Pass", "")}</TabsTrigger>)}</TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <SeriesChart series={p.series} unit="ft" height={260} domain={[0, top]} yTicks={ticksOf(0, top, top > 8000 ? 2000 : 1000)}
                     format={(v) => v.toLocaleString("en-US")}>
          <ReferenceArea y1={0} y2={p.elev_ft} fill="#3f80dc" fillOpacity={0.08} />
          <ReferenceLine y={p.elev_ft} stroke="#1b1f24" strokeDasharray="5 4"
                         label={{ value: `${p.name} ${p.elev_ft.toLocaleString("en-US")} ft`, position: "insideTopLeft", fontSize: 11, fill: "#1b1f24" }} />
        </SeriesChart>
        <ModelLegend models={p.series.map((s) => s.model)} />
        <p className="text-xs text-muted-foreground">
          From models with a freezing-level field (HRRR, RRFS, NAM and GFS). The 1,000 ft offset is a rule of thumb; in
          heavy precipitation or with cold air trapped in the passes, snow can fall lower.
        </p>
      </CardContent>
    </Card>
  )
}



// ------------------------------------------------------------------ snowpack (SNOTEL)

export function SnowpackCard({ data }: { data: Briefing }) {
  const sp = data.snowpack
  const [open, setOpen] = React.useState<string | null>(null)
  if (!sp || !sp.areas.length) return null
  const signed = (v: N) => (v == null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Snowpack</CardTitle>
        <CardDescription>
          Snow water equivalent (SWE) at SNOTEL stations near each area{sp.asOf ? `, as of ${dateRange(sp.asOf, sp.asOf)}` : ""},
          against each station's median for the date. Select an area to see its stations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Area</TableHead>
              <TableHead className="text-right">Stations</TableHead>
              <TableHead className="text-right">SWE (in)</TableHead>
              <TableHead className="text-right">Median (in)</TableHead>
              <TableHead className="text-right">% of median</TableHead>
              <TableHead className="text-right">7-day change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sp.areas.flatMap((a) => [
              <TableRow key={a.name} className="cursor-pointer" onClick={() => setOpen(open === a.name ? null : a.name)}
                        aria-expanded={open === a.name}>
                <TableCell className="font-medium">
                  <span className="mr-1.5 inline-block w-3 text-muted-foreground">{open === a.name ? "▾" : "▸"}</span>{a.name}
                </TableCell>
                <TableCell className="text-right tabular-nums">{a.stations.length}</TableCell>
                <TableCell className="text-right tabular-nums">{inch(a.swe)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{inch(a.median)}</TableCell>
                <TableCell className="text-right tabular-nums" style={pctCell(a.pct)}>{a.pct == null ? "–" : a.pct}</TableCell>
                <TableCell className="text-right tabular-nums">{signed(a.change7)}</TableCell>
              </TableRow>,
              ...(open === a.name ? a.stations.map((s) => (
                <TableRow key={`${a.name}-${s.triplet}`} className="bg-muted/30 text-xs">
                  <TableCell className="pl-9">{s.name}<span className="ml-1.5 text-muted-foreground">{s.elev_ft ? `${s.elev_ft.toLocaleString("en-US")} ft` : ""}</span></TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{s.depth == null ? "" : `${s.depth}″ deep`}</TableCell>
                  <TableCell className="text-right tabular-nums">{inch(s.swe)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{inch(s.median)}</TableCell>
                  <TableCell className="text-right tabular-nums" style={pctCell(s.pct)}>{s.pct == null ? "–" : s.pct}</TableCell>
                  <TableCell className="text-right tabular-nums">{signed(s.change7)}</TableCell>
                </TableRow>
              )) : []),
            ])}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          {sp.source}. Area percent of median is total SWE over total median SWE, as NRCS builds basin indices; it's left
          blank until the median reaches {sp.minMedian}″, since early-season medians near zero make percentages meaningless.
        </p>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ NWS discussions and outlooks

const issuedAt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: PT, timeZoneName: "short" }) : ""

export function DiscussionsCard({ data }: { data: Briefing }) {
  const ds = data.outlooks?.discussions ?? []
  if (!ds.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>From the forecast discussions</CardTitle>
        <CardDescription>The synopsis, key messages and hydrology notes from each NWS office's latest Area Forecast Discussion.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        {ds.map((d) => (
          <div key={d.office} className="space-y-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{d.name}</span>
              <a className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" href={d.url} target="_blank" rel="noopener">
                Issued {issuedAt(d.issued)} · full discussion
              </a>
            </div>
            {d.keyMessages && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">Key messages</p>
                <ul className="list-disc space-y-1 pl-5">{d.keyMessages.map((k, i) => <li key={i}>{k.replace(/^\*\s*/, "")}</li>)}</ul>
              </div>
            )}
            {d.synopsis && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">Synopsis</p>
                {d.synopsis.map((p, i) => <p key={i} className="leading-relaxed">{p}</p>)}
              </div>
            )}
            {d.hydrology && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">Hydrology</p>
                {d.hydrology.map((p, i) => <p key={i} className="leading-relaxed">{p}</p>)}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

const ERO_COLORS = ["transparent", "#7cc47c", "#f6e05e", "#e9502e", "#d62fd6"]
const CPC_COLOR: Record<string, Record<string, string>> = {
  temperature: { Above: "#f4a582", Below: "#92c5de", Normal: "#e5e7eb", Near: "#e5e7eb", EC: "#f3f4f6" },
  precipitation: { Above: "#80cdc1", Below: "#dfc27d", Normal: "#e5e7eb", Near: "#e5e7eb", EC: "#f3f4f6" },
}

export function OutlooksCard({ data }: { data: Briefing }) {
  const o = data.outlooks
  if (!o || (!o.ero && !o.cpc)) return null
  const groups = [
    ...data.regions.map((r) => ({ name: r.name, pts: data.points.filter((p) => p.region === r.id).map((p) => p.name) })),
    { name: "Other locations", pts: data.points.filter((p) => !data.regions.some((r) => r.id === p.region)).map((p) => p.name) },
  ].filter((g) => g.pts.length)
  const today = data.dates[0]
  const dayLabel = (d: number) => {
    const t = new Date(`${today}T12:00:00`)
    t.setDate(t.getDate() + d - 1)
    return dayShort(t.toISOString())
  }
  const eroDays = (o.ero?.days ?? []).filter(Boolean) as { day: number; points: Record<string, number> }[]
  const anyEro = eroDays.some((d) => Object.values(d.points).some((v) => v > 0))
  /** The most common category across a group's locations, and its highest probability. */
  const cpcGroup = (pts: string[], vals: Record<string, { cat: string | null; prob: number | null } | null>) => {
    const got = pts.map((p) => vals[p]).filter((v): v is { cat: string | null; prob: number | null } => !!v?.cat)
    if (!got.length) return null
    const counts = new Map<string, number>()
    got.forEach((v) => counts.set(v.cat!, (counts.get(v.cat!) ?? 0) + 1))
    const cat = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const prob = Math.max(...got.filter((v) => v.cat === cat).map((v) => v.prob ?? 0))
    return { cat, prob }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>National outlooks</CardTitle>
        <CardDescription>
          WPC's Excessive Rainfall Outlook (days 1–5) and CPC's 6–10 and 8–14 day outlooks at the forecast locations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        {o.ero && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Excessive rainfall risk</p>
            {anyEro ? (
              <Table>
                <TableHeader><TableRow><TableHead>Location</TableHead>{eroDays.map((d) => <TableHead key={d.day} className="text-center text-xs">Day {d.day}<span className="block font-normal text-muted-foreground">{dayLabel(d.day)}</span></TableHead>)}</TableRow></TableHeader>
                <TableBody>
                  {data.points.filter((p) => eroDays.some((d) => (d.points[p.name] ?? 0) > 0)).map((p) => (
                    <TableRow key={p.name}>
                      <TableCell>{p.name}</TableCell>
                      {eroDays.map((d) => {
                        const v = d.points[p.name] ?? 0
                        return <TableCell key={d.day} className="text-center text-xs" style={{ background: ERO_COLORS[v] }}>{v ? o.ero!.names[String(v)] : ""}</TableCell>
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <p className="text-sm text-muted-foreground">No excessive rainfall risk at any forecast location for days 1–5.</p>}
            <a className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" href={o.ero.url} target="_blank" rel="noopener">WPC Excessive Rainfall Outlook</a>
          </div>
        )}
        {o.cpc && o.cpc.outlooks.length > 0 && (
          <div className="space-y-2 overflow-x-auto">
            <p className="text-sm font-medium">CPC extended outlooks</p>
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Area</TableHead>
                  {o.cpc.outlooks.map((x) => (
                    <TableHead key={`${x.period}-${x.var}`} className="text-center text-xs">
                      {x.period} day {x.var === "temperature" ? "temp" : "precip"}
                      {x.start && x.end && <span className="block font-normal text-muted-foreground">{dateRange(x.start, x.end)}</span>}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.name}>
                    <TableCell>{g.name}</TableCell>
                    {o.cpc!.outlooks.map((x) => {
                      const v = cpcGroup(g.pts, x.points)
                      return (
                        <TableCell key={`${x.period}-${x.var}`} className="text-center text-xs"
                                   style={{ background: v ? CPC_COLOR[x.var][v.cat] ?? "#f3f4f6" : "transparent" }}>
                          {v ? <>{v.cat === "EC" ? "Equal chances" : v.cat}{v.prob ? <span className="block text-muted-foreground">{Math.round(v.prob)}%</span> : null}</> : "–"}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">
              The most common category across each area's locations, with its probability. CPC outlooks cover the US only.{" "}
              <a className="underline underline-offset-2 hover:text-foreground" href={o.cpc.url} target="_blank" rel="noopener">CPC outlooks</a>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
