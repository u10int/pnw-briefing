import * as React from "react"
import { DayHead } from "@/components/DayHead"
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChevronDown, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dateRange, dayShort, inch, issuedLabel, ptDay, ptDayHour } from "@/lib/format"
import { pctCell } from "@/sections/Totals"
import type { ArEvent, Avalanche, AvalancheDanger, Briefing, Gradient, Landslide, ModelSeries, N, NbmOdds, Tier } from "@/types"
import { Takeaway } from "@/components/Takeaway"
import { GRAD_COLORS, gradLevel, pairName, seriesAt } from "@/lib/gradients"
import { arEpisodes, type Episode } from "@/sections/Hazards"
import { contrastTextColor } from "@/lib/contrast"
import { AR_COLORS } from "@/lib/ramps"
import { MapButton } from "@/components/MapButton"

// ------------------------------------------------------------------ shared: multi-model time series

/** One colour per model, stable across charts. */
const MODEL_COLORS: Record<string, string> = {
  HRRR: "#2a78d6", RRFS: "#1baf7a", "NAM 3 km": "#8b5cf6", NBM: "#0ea5b7",
  GFS: "#eb6834", "ECMWF IFS": "#b45309", "ECMWF AIFS": "#be185d",
}
const colorOf = (m: string, i: number) => MODEL_COLORS[m] ?? ["#64748b", "#a16207", "#0f766e"][i % 3]

const PT = "America/Los_Angeles"
const tickDay = (t: number) => ptDay(t)
const tipTime = (t: number) => ptDayHour(t)

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
        <CardDescription info={<>From NOAA's radar-and-gauge analysis (MRMS), against 1991 – 2020 normals. Wet ground turns the same rain into more runoff.
          {" "}Region rows average every grid cell in the region. MRMS tends to run low in the mountains, where terrain blocks the radar beam and gauges are sparse, so mountain and region totals are likely underestimates.
          In B.C. MRMS is radar only (no gauges), so treat percent of normal there loosely.
          {missing.length > 0 && ` MRMS had no data for ${missing.map((d) => dayShort(d)).join(", ")}; those days are left out of the totals and the normals.`}</>}>
          Observed precipitation through {dateRange(w30.to, w30.to)}, against normal.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2"><MapButton req={{ mode: "totals", variable: "obs", days: 7 }} label="Observed rain on the map" /></CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="min-w-0 space-y-3">
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
              <TableHeader className="sticky top-0 z-20 bg-card">
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-card">Location</TableHead>
                  <TableHead className="text-right">7 days</TableHead>
                  <TableHead className="text-right">% normal</TableHead>
                  <TableHead className="text-right">30 days</TableHead>
                  <TableHead className="text-right">% normal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.name} className={r.group ? "bg-muted/40 font-medium" : ""}>
                    <TableCell className={`sticky left-0 z-10 ${r.group ? "bg-[color-mix(in_oklab,var(--muted)_40%,var(--card))]" : "bg-card"}`}>{r.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{inch(r.s7?.obs ?? null, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums" style={pctCell(r.s7?.pct ?? null)}>{r.s7?.pct == null ? "–" : Math.round(r.s7.pct)}</TableCell>
                    <TableCell className="text-right tabular-nums">{inch(r.s30?.obs ?? null, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums" style={pctCell(r.s30?.pct ?? null)}>{r.s30?.pct == null ? "–" : Math.round(r.s30.pct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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

// ------------------------------------------------------------------ landslide threshold (USGS, Seattle area)

const SLIDE_OVER = "#d9342b", SLIDE_NEAR = "#f0a830"

export function LandslideCard({ data }: { data: Briefing }) {
  const ls = data.landslide
  const [point, setPoint] = React.useState(ls?.points[0]?.name ?? "")
  if (!ls || !ls.points.length) return null
  const thr = ls.threshold, near = 0.8 * thr
  const day = (k: number) => ls.days[k]
  const dayName = (k: number) => ptDay(Date.parse(day(k).start) + 12 * H)
  const t0 = Date.parse(ls.days[0].start), t1 = Date.parse(ls.days[ls.days.length - 1].end)

  const perDay = (p: Landslide["points"][number]) => ls.days.map((_, k) => {
    const vals = p.models.map((m) => ({ m, v: m.index[k] })).filter((x): x is { m: typeof x.m; v: number } => x.v != null)
    return { k, vals, over: vals.filter((x) => x.v >= thr), max: Math.max(0, ...vals.map((x) => x.v)) }
  })

  const groups: TimelineGroup[] = ls.points.map((p) => ({
    key: p.name, label: p.name, title: `Chart ${p.name}`, onClick: () => setPoint(p.name), selected: p.name === point,
    rows: [{
      key: "models", label: <span className="truncate">Models over</span>,
      bars: perDay(p).filter((d) => d.vals.length && (d.over.length || d.max >= near)).map((d) => {
        const share = d.over.length / d.vals.length
        const color = d.over.length
          ? `color-mix(in srgb, ${SLIDE_OVER} ${Math.round(35 + 65 * share)}%, transparent)`
          : `color-mix(in srgb, ${SLIDE_NEAR} 45%, transparent)`
        return {
          key: String(d.k), start: Date.parse(day(d.k).start), end: Date.parse(day(d.k).end), color,
          text: d.over.length && share >= 0.5 ? "#fff" : undefined,
          label: d.over.length ? `${d.over.length}/${d.vals.length}` : "near", short: d.over.length ? `${d.over.length}` : "",
          onClick: () => setPoint(p.name),
          aria: `${p.name}, ${dayName(d.k)}: ${d.over.length} of ${d.vals.length} models at or over the landslide threshold`,
          tip: <>
            <p className="font-semibold">{p.name} · {dayName(d.k)}</p>
            <p>{d.over.length ? `${d.over.length} of ${d.vals.length} models reach the threshold` : `No model reaches it; the highest is ${d.max.toFixed(1)} of ${thr}`}</p>
            <div className="grid grid-cols-[auto_auto_auto] gap-x-3 pt-1 opacity-85">
              <span className="opacity-70">Model</span><span className="text-right opacity-70">3-day</span><span className="text-right opacity-70">Index</span>
              {[...d.vals].sort((a, b) => b.v - a.v).map(({ m, v }) => (
                <React.Fragment key={m.model}>
                  <span>{m.model}</span>
                  <span className="text-right tabular-nums">{inch(m.p3[d.k], 2)}″</span>
                  <span className={`text-right tabular-nums ${v >= thr ? "font-semibold" : ""}`}>{v.toFixed(2)}</span>
                </React.Fragment>
              ))}
            </div>
          </>,
        }
      }),
    }],
  }))

  const cur = ls.points.find((p) => p.name === point) ?? ls.points[0]
  const series: ModelSeries[] = cur.models.map((m) => ({ model: m.model, tier: m.tier ?? ("global" as Tier), times: ls.days.map((d) => d.end), values: m.index }))
  const top = Math.max(thr + 1, ...series.flatMap((s) => s.values).filter((v): v is number => v != null)) * 1.05
  const status = (p: Landslide["points"][number]) => {
    const days = perDay(p).filter((d) => d.over.length)
    if (!days.length) return <span className="text-muted-foreground">not reached in any model</span>
    const most = days.reduce((a, b) => (b.over.length > a.over.length ? b : a))
    const first = days[0].k, last = days[days.length - 1].k
    const when = first === last ? dayName(first) : `${dayName(first)} to ${dayName(last)}`
    return <span>reached <span className="font-medium">{when}</span> in {days.length > 1 ? "up to " : ""}{most.over.length} of {most.vals.length} models</span>
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Landslide threshold</CardTitle>
        <CardDescription info={<>The USGS rainfall threshold for the Seattle area: landslides become likely once the last 3 days' rain reaches
          {" "}{thr}″ minus {ls.p15Factor} × the 15 days before. The index (3-day rain + {ls.p15Factor} × the 15 days before)
          runs from observed rain into each model's forecast and reaches the threshold at {thr}. Calibrated on landslides in Seattle and along the nearby Puget Sound bluffs,
          it says when landslides become likely across the area, not where. Observed rain is MRMS; days it's missing count as dry.</>}>
          How close recent and forecast rain come to the Seattle-area landslide threshold.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2"><MapButton req={{ mode: "totals", variable: "obs", days: 3 }} label="Recent rain on the map" /></CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="space-y-1 text-sm">
          {ls.points.map((p) => (
            <li key={p.name}>
              <span className="font-medium">{p.name}:</span>{" "}
              {p.observed.p15 != null && <>{inch(p.observed.p15, 2)}″ in the past 15 days, so {inch(p.observed.needed3, 1)}″ over the next 3 days would reach the threshold; </>}
              {status(p)}.
            </li>
          ))}
        </ul>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Days at or over the threshold</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px]" style={{ background: SLIDE_OVER }} />models over (deeper = more of them)</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px]" style={{ background: `color-mix(in srgb, ${SLIDE_NEAR} 45%, transparent)` }} />within 20%</span>
            </div>
          </div>
          <Timeline t0={t0} t1={t1} groups={groups} groupW={96} rowW={88} />
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Landslide index at {cur.name}</p>
            <Tabs value={cur.name} onValueChange={setPoint}>
              <TabsList>{ls.points.map((p) => <TabsTrigger key={p.name} value={p.name}>{p.name}</TabsTrigger>)}</TabsList>
            </Tabs>
          </div>
          <SeriesChart series={series} unit="" height={220} domain={[0, Math.ceil(top)]} yTicks={ticksOf(0, Math.ceil(top), 1)} format={(v) => v.toFixed(1)}>
            <ReferenceArea y1={thr} y2={Math.ceil(top)} fill={SLIDE_OVER} fillOpacity={0.07} ifOverflow="hidden" />
            <ReferenceLine y={thr} stroke={SLIDE_OVER} strokeDasharray="5 4" label={{ value: `Threshold ${thr}`, position: "insideTopLeft", fontSize: 10, fill: SLIDE_OVER }} />
          </SeriesChart>
          <ModelLegend models={series.map((s) => s.model)} />
        </div>
        <p className="text-xs text-muted-foreground">
          From Chleborad, Baum and Godt (2006),{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="https://pubs.usgs.gov/of/2006/1064/" target="_blank" rel="noopener">USGS Open-File Report 2006-1064</a>,
.
        </p>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ atmospheric rivers

// AR_COLORS: lib/ramps (shared with the map's coastal outlook)
const AR_SHORT = ["Below scale", "AR1 Weak", "AR2 Moderate", "AR3 Strong", "AR4 Extreme", "AR5 Exceptional"]

function ArBadge({ rank }: { rank: number }) {
  return (
    <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium"
          style={{ background: AR_COLORS[rank], color: contrastTextColor(AR_COLORS[rank]) }}>{AR_SHORT[rank]}</span>
  )
}

/** A location's AR summary: the rank every model reaches, then how far a model goes beyond it. */
function PointAr({ ep }: { ep?: Episode }) {
  if (!ep) return <span className="text-muted-foreground">no AR</span>
  const above = ep.ranks.filter(([, r]) => r > ep.agreed)
  const short = (m: string) => m.replace("ECMWF ", "")
  const when = `${dayShort(new Date(ep.start).toISOString())}`
  const tip = ep.ranks.map(([m, r]) => `${short(m)} ${r ? AR_SHORT[r] : "no AR"}`).join(" · ")
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1.5">
          {ep.agreed > 0 && <ArBadge rank={ep.agreed} />}
          {above.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {ep.agreed > 0 ? "up to " : ""}{AR_SHORT[ep.top].split(" ")[0]} in {above.filter(([, r]) => r === ep.top).map(([m]) => short(m)).join(", ")}{ep.agreed === 0 ? " only" : ""}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>From {when}: {tip}</TooltipContent>
    </Tooltip>
  )
}

const AR_RANGE = "kg m⁻¹ s⁻¹"
export const H = 36e5

/** Pacific midnights between two times (ms). */
function midnights(t0: number, t1: number) {
  const out: number[] = []
  for (let t = Math.ceil(t0 / H) * H; t <= t1; t += H) if (ptHour(t) === 0) out.push(t)
  return out
}

function useWidth<T extends HTMLElement>() {
  const ref = React.useRef<T>(null)
  const [w, setW] = React.useState(0)
  React.useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** What the peak alone would rank, and how duration moved it, in words. */
function rankNote(e: ArEvent, breaks: number[]) {
  const base = breaks.filter((b) => e.peak >= b).length
  if (e.rank > base) return `Peak alone is ${AR_SHORT[base]}; lasting 48 h or more raises it one step.`
  if (e.rank < base) return `Peak alone is ${AR_SHORT[base]}; lasting under 24 h lowers it one step.`
  return null
}

// ------------------------------------------------------------------ shared: horizontal timeline

export interface TimelineBar {
  key: string; start: number; end: number          // ms
  color: string; text?: string
  ghost?: boolean                                  // muted, dashed: a past or withdrawn position
  faded?: boolean                                  // fill drawn at reduced strength
  border?: string                                  // a dashed border in this color
  hatch?: boolean                                  // diagonal stripes of the fill color instead of a solid fill
  link?: "right" | "left"                          // not a bar: a dashed arrow joining two bars, pointing this way
  label: string; short?: string                    // full label, and a shorter one for narrow bars
  aria: string; tip: React.ReactNode; onClick?: () => void
}
export interface TimelineRow { key: string; label: React.ReactNode; bars: TimelineBar[] }
export interface TimelineGroup { key: string; label: string; title?: string; onClick?: () => void; selected?: boolean; rows: TimelineRow[] }

/** Fill, text and border for a non-ghost bar. A faded fill mixes the color toward the card so the
 *  border and label stay at full strength. */
function barFill(e: TimelineBar): React.CSSProperties {
  const fill = e.faded ? `color-mix(in srgb, ${e.color} 45%, var(--card))` : e.color
  return {
    background: e.hatch ? `repeating-linear-gradient(135deg, ${fill} 0 4px, var(--card) 4px 8px)` : fill,
    color: e.text ?? "var(--foreground)",
    ...(e.border ? { borderColor: e.border } : {}),
  }
}

/** One bar. Hover or focus opens the tooltip; a tap or click opens it too, since touch screens
 *  have no hover. */
function TimelineBarView({ e, left, w, label }: { e: TimelineBar; left: number; w: number; label: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button type="button" onClick={() => { setTimeout(() => setOpen(true), 0); e.onClick?.() }} aria-label={e.aria}
                className={`absolute top-1 bottom-1 flex items-center overflow-hidden rounded-[4px] px-1.5 font-medium whitespace-nowrap outline-offset-1 focus-visible:outline-2 focus-visible:outline-ring ${e.ghost ? "border border-dashed border-muted-foreground/60 bg-card/80 text-muted-foreground hover:bg-card" : e.border ? "border border-dashed hover:brightness-105" : "shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] hover:brightness-105"} ${e.onClick ? "" : "cursor-default"}`}
                style={{ left: `${left}%`, width: `${w}%`, ...(e.ghost ? {} : barFill(e)) }}>
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-left">
        <div className="space-y-1 py-0.5">{e.tip}</div>
      </TooltipContent>
    </Tooltip>
  )
}

/** Groups (a place) with child rows (a model, an outlook), each row a track of bars placed by
 *  start and duration on a shared day axis. Hover or focus a bar for its tooltip.
 *  Each day keeps at least MIN_DAY px: on a narrow screen the track scrolls sideways under labels
 *  pinned to the left, rather than squeezing two weeks into the width of a phone. */
const MIN_DAY = 48
export function Timeline({ t0, t1, groups, groupW = 96, rowW = 88 }: {
  t0: number; t1: number; groups: TimelineGroup[]; groupW?: number; rowW?: number
}) {
  const [trackRef, width] = useWidth<HTMLDivElement>()
  const [outerRef, outerW] = useWidth<HTMLDivElement>()
  // narrow screens: place names on their own line above their rows, and fit the width
  const compact = outerW > 0 && outerW < 640
  const gW = compact ? 0 : groupW
  const span = t1 - t0 || 1
  const x = (t: number) => ((t - t0) / span) * 100
  const days = midnights(t0, t1)
  const pxPerDay = width ? (width * 24 * H) / span : 60
  const labelEvery = pxPerDay >= 46 ? 1 : pxPerDay >= 24 ? 2 : 3
  const rW = rowW
  // fade the right edge while there's more timeline to scroll to
  const [more, setMore] = React.useState(false)
  const onScroll = React.useCallback(() => {
    const el = outerRef.current
    if (el) setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [outerRef])
  React.useEffect(onScroll, [onScroll, outerW, groups])
  const labelW = gW + rW
  const nDays = Math.max(1, Math.round(span / (24 * H)))
  const sticky = "sticky left-0 z-10 bg-card"
  return (
    <div className="relative">
    <div ref={outerRef} onScroll={onScroll} className="overflow-x-auto overscroll-x-contain">
      <div className="relative text-xs" style={{ minWidth: labelW + nDays * MIN_DAY }}>
        {/* day shading and midnight lines behind every row */}
        <div ref={trackRef} className="pointer-events-none absolute inset-y-0 right-0" style={{ left: labelW }}>
          {days.map((d, i) => (
            <React.Fragment key={d}>
              <div className="absolute inset-y-0 border-l border-border/70" style={{ left: `${x(d)}%` }} />
              {i % 2 === 0 && (
                <div className="absolute inset-y-0 bg-muted/50"
                     style={{ left: `${x(d)}%`, width: `${x(Math.min(days[i + 1] ?? t1, t1)) - x(d)}%` }} />
              )}
            </React.Fragment>
          ))}
        </div>

        <div className="relative flex h-10 items-end border-b">
          <div style={{ width: labelW }} className={`shrink-0 self-stretch ${sticky}`} />
          <div className="relative h-full flex-1">
            {days.map((d, i) => i % labelEvery === 0 && x(d) < 96 && (
              <span key={d} className="absolute bottom-1.5 whitespace-nowrap pl-1 font-medium leading-tight" style={{ left: `${x(d)}%` }}>
                <DayHead day={d + 12 * H} />
              </span>
            ))}
          </div>
        </div>

        {groups.map((g) => (
          <div key={g.key} className={`relative border-b last:border-b-0 ${compact ? "" : "flex"}`}>
            {compact ? (
              <div className={`relative w-fit pt-1.5 pr-2 text-sm font-medium ${sticky}`}>
                {g.onClick ? <button type="button" onClick={g.onClick} className={`hover:underline ${g.selected ? "underline decoration-2 underline-offset-4" : ""}`}>{g.label}</button> : g.label}
              </div>
            ) : g.onClick ? (
              <button type="button" onClick={g.onClick} title={g.title}
                      className={`shrink-0 py-1.5 pr-2 text-left text-sm font-medium hover:underline ${sticky} ${g.selected ? "underline decoration-2 underline-offset-4" : ""}`}
                      style={{ width: groupW }}>
                {g.label}
              </button>
            ) : <div className={`shrink-0 py-1.5 pr-2 text-sm font-medium ${sticky}`} style={{ width: groupW }}>{g.label}</div>}
            <div className="flex-1">
              {g.rows.map((r) => (
                <div key={r.key} className="flex h-7 items-center">
                  <span className={`flex shrink-0 items-center gap-1.5 self-stretch truncate pr-2 text-muted-foreground ${sticky}`} style={{ width: rW, left: gW }}>{r.label}</span>
                  <div className="relative h-full flex-1">
                    {r.bars.map((e) => {
                      const a = Math.max(t0, e.start), b = Math.min(t1, e.end)
                      if (b <= a) return null
                      const left = x(a), w = Math.max(0.6, x(b) - x(a))
                      if (e.link) return (
                        <div key={e.key} aria-hidden className="pointer-events-none absolute top-1/2 h-0 border-t border-dashed border-muted-foreground/70"
                             style={{ left: `${left}%`, width: `${w}%` }}>
                          <span className={`absolute -top-[4.5px] size-0 border-y-4 border-y-transparent ${e.link === "right" ? "right-0 border-l-[6px] border-l-muted-foreground/70" : "left-0 border-r-[6px] border-r-muted-foreground/70"}`} />
                        </div>
                      )
                      const px = (w / 100) * width
                      const fits = (s: string) => px >= s.length * 6.4 + 14
                      const label = fits(e.label) ? e.label : e.short && fits(e.short) ? e.short : ""
                      return <TimelineBarView key={e.key} e={e} left={left} w={w} label={label} />
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
    <div aria-hidden className={`pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card to-transparent transition-opacity ${more ? "opacity-100" : "opacity-0"}`} />
    </div>
  )
}

const ModelRowLabel = ({ model, k }: { model: string; k: number }) => (
  <><span className="h-0.5 w-2.5 shrink-0 rounded" style={{ background: colorOf(model, k) }} />
    <span className="truncate">{model.replace("ECMWF ", "")}</span></>
)

/** AR events on the shared timeline: a row per model under each coastal location, each event
 *  drawn from its start for its duration. Click a location or bar to chart it. */
function ArTimeline({ ar, onPick, picked }: {
  ar: NonNullable<Briefing["ar"]>; onPick: (p: string) => void; picked: string
}) {
  const times = ar.models.flatMap((m) => m.times.map((t) => Date.parse(t)))
  const t0 = Math.min(...times), t1 = Math.max(...times)
  const events = ar.events.filter((e) => e.rank >= 1)
  // bars cover each 6-hourly sample's own slot, so a bar's length is the event's duration
  const span = (e: ArEvent) => {
    const s = Date.parse(e.start), en = Date.parse(e.end)
    const pad = Math.max(0, (e.hours * H - (en - s)) / 2)
    return [s - pad, en + pad]
  }
  const groups: TimelineGroup[] = ar.points.map((p) => ({
    key: p, label: p, title: `Chart IVT at ${p}`, onClick: () => onPick(p), selected: p === picked,
    rows: ar.models.map((m, k) => ({
      key: m.model, label: <ModelRowLabel model={m.model} k={k} />,
      bars: events.filter((e) => e.point === p && e.model === m.model).map((e) => {
        const [a, b] = span(e)
        const note = rankNote(e, ar.breaks)
        return {
          key: e.start, start: a, end: b, color: AR_COLORS[e.rank], text: contrastTextColor(AR_COLORS[e.rank]),
          label: AR_SHORT[e.rank], short: AR_SHORT[e.rank].split(" ")[0], onClick: () => onPick(p),
          aria: `${AR_SHORT[e.rank]} at ${p} in ${m.model}, ${tipTime(Date.parse(e.start))} for ${e.hours} hours`,
          tip: <>
            <p className="font-semibold">{AR_SHORT[e.rank]} · {p}</p>
            <p>{m.model}</p>
            <p>{tipTime(Date.parse(e.start))} – {tipTime(Date.parse(e.end))} ({e.hours} h)</p>
            <p>Peak IVT {e.peak} {AR_RANGE}{e.peakTime ? `, ${tipTime(Date.parse(e.peakTime))}` : ""}</p>
            {note && <p className="opacity-75">{note}</p>}
          </>,
        }
      }),
    })),
  }))
  return <Timeline t0={t0} t1={t1} groups={groups} />
}

function ArKey() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {AR_SHORT.slice(1).map((n, k) => (
        <span key={n} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[3px]" style={{ background: AR_COLORS[k + 1] }} />{n}
        </span>
      ))}
    </div>
  )
}

export function ArCard({ data }: { data: Briefing }) {
  const ar = data.ar
  const [point, setPoint] = React.useState(ar?.points[0] ?? "")
  if (!ar) return null
  const series: ModelSeries[] = ar.models.map((m) => ({ model: m.model, tier: m.tier, times: m.times, values: m.ivt[point] ?? [] }))
  const events = ar.events.filter((e) => e.rank >= 1)
  // per location, the episode the models agree on most: the rank both reach, and how far one goes beyond it
  const eps = arEpisodes(data)
  const bestAt = (p: string) => eps.filter((x) => x.point === p).sort((a, b) => b.agreed - a.agreed || b.top - a.top || a.start - b.start)[0]
  const arMax = Math.max(0, ...series.flatMap((s) => s.values).filter((v): v is number => v != null))
  const arTop = Math.max(750, Math.ceil((arMax + 50) / 250) * 250)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Atmospheric rivers</CardTitle>
        <CardDescription info={<>Water vapor transport (IVT) at the coast from {ar.models.map((m) => m.model).join(" and ")}, ranked on the
          CW3E AR scale: peak IVT sets the category, lasting 48 hours or more raises it one step and under 24 hours lowers it one.</>}>
          Moisture transport at the coast, on the AR scale.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2"><MapButton req={{ mode: "totals", variable: "ar", days: 7 }} label="AR outlook on the map" /><MapButton req={{ mode: "hourly", layer: "ivt", isobars: true }} label="Moisture transport (IVT) on the map" /></CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {ar.points.map((p) => (
            <div key={p} className="flex items-center gap-2 text-sm"><span className="font-medium">{p}</span>
              <PointAr ep={bestAt(p)} /></div>
          ))}
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">AR events at the coast</p>
            <ArKey />
          </div>
          {events.length ? <ArTimeline ar={ar} onPick={setPoint} picked={point} />
            : <p className="text-sm text-muted-foreground">No atmospheric river (IVT of 250 or more) reaches the coastal locations in these runs.</p>}
          {events.length > 0 && <p className="text-xs text-muted-foreground">Hover a bar for timing and peak IVT; click a location or bar to chart it below.</p>}
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">IVT at {point} ({AR_RANGE})</p>
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
  return { background: PROB[i], color: contrastTextColor(PROB[i]) }
}

type OddsSource = "ens" | "nbm"
type NbmKey = NbmOdds["variables"][number]["key"]
const NBM_WHAT: Record<NbmKey, string> = {
  rain24: "24-hour precipitation (4 AM – 4 AM) of at least",
  rain72: "3-day precipitation ending that day of at least",
  gust: "a gust of at least",
}
const amount = (v: number, unit: "in" | "mph") => (unit === "in" ? `${v}″` : `${v} mph`)

/** Chances of reaching impact amounts at each location: the share of ensemble members reaching
 *  the location's own thresholds, or NBM's calibrated probabilities at the amounts it publishes. */
export function OddsCard({ data, vars, title = "Odds of impacts" }: { data: Briefing; vars?: (OddsKey | NbmKey)[]; title?: string }) {
  const o = data.odds, nb = data.nbmOdds
  const ensKeys = o ? ODDS.filter((d) => (!vars || vars.includes(d.key)) && Object.values(o.points).some((p) => p[d.key]?.some((v) => v != null && v > 0) || (d.key !== "snow24" && p[d.key]))) : []
  const nbmVars = (nb?.variables ?? []).filter((v) => (!vars || vars.includes(v.key)) && v.thresholds.length && Object.values(nb!.points).some((p) => p[v.key]?.some((row) => row.some((x) => x != null))))
  const sources = ([ensKeys.length ? "ens" : null, nbmVars.length ? "nbm" : null].filter(Boolean)) as OddsSource[]
  const [srcSel, setSrc] = React.useState<OddsSource>("ens")
  const [ensSel, setEns] = React.useState<OddsKey>("rain24")
  const [nbmSel, setNbm] = React.useState<NbmKey>("rain24")
  const [thrSel, setThr] = React.useState<Record<string, number>>({})
  if (!sources.length) return null
  const src = sources.includes(srcSel) ? srcSel : sources[0]
  const groups = [
    ...data.regions.map((r) => ({ name: r.name, pts: data.points.filter((p) => p.region === r.id) })),
    { name: "Other locations", pts: data.points.filter((p) => !data.regions.some((r) => r.id === p.region)) },
  ].filter((g) => g.pts.length)

  // the table's rows and columns for the chosen source
  let dates: string[], cell: (name: string, i: number) => N, thrText: (name: string) => string | null, what: React.ReactNode, note: React.ReactNode
  let mapReq: { variable: "p24" | "p72" } | null = null
  let varTabs: React.ReactNode = null, thrTabs: React.ReactNode = null, label: string
  if (src === "ens") {
    const key = ensKeys.some((d) => d.key === ensSel) ? ensSel : ensKeys[0].key
    const def = ODDS.find((d) => d.key === key)!
    dates = o!.dates
    cell = (n, i) => o!.points[n]?.[key]?.[i] ?? null
    thrText = (n) => { const t = o!.points[n]?.thresholds[key]; return t == null ? "–" : `${t}″` }
    label = def.label.toLowerCase()
    what = <>Share of ensemble members ({o!.ensembles.map((e) => `${e.label}, ${e.members} members`).join(" and ")}, pooled) reaching each location's impact threshold: {def.what}.</>
    note = <>Percent of members; blank under 5%. Thresholds are the impacts table's for lowland, coast and pass locations.
      {key === "rain72" && " The first two days have no complete 3-day total."}
      {key === "snow24" && " GEFS has no snowfall field, so snow odds come from ECMWF ENS alone."}
      {" "}The interactive map's Summary mode has gridded odds for fixed amounts.</>
    if (key !== "snow24") mapReq = { variable: key === "rain72" ? "p72" : "p24" }
    if (ensKeys.length > 1) varTabs = (
      <Tabs value={key} onValueChange={(v) => setEns(v as OddsKey)}>
        <TabsList>{ensKeys.map((d) => <TabsTrigger key={d.key} value={d.key}>{d.label}</TabsTrigger>)}</TabsList>
      </Tabs>
    )
  } else {
    const v = nbmVars.find((x) => x.key === nbmSel) ?? nbmVars[0]
    const ti = Math.min(thrSel[v.key] ?? (v.key === "gust" ? 1 : 0), v.thresholds.length - 1)
    const t = v.thresholds[ti]
    dates = nb!.dates
    cell = (n, i) => nb!.points[n]?.[v.key]?.[ti]?.[i] ?? null
    thrText = () => null
    label = `${amount(t, v.unit)} ${v.key === "gust" ? "gusts" : v.key === "rain24" ? "in 24 h" : "in 72 h"}`
    what = <>The National Blend of Models' own chance of {NBM_WHAT[v.key]} {amount(t, v.unit)} at each location ({ptDayHour(nb!.run)} run). NBM calibrates its blend against observations, so these are probabilities rather than a count of model runs.</>
    note = <>Percent; blank under 5%. NBM publishes chances at fixed amounts, so these are the same for every location, unlike the ensemble tab's thresholds by kind of place.
      {v.key === "gust" ? " Gust chances are for a single moment (sampled every 3 hours, then 6), the day's highest; the chance of a gust that strong at some point in the day runs higher."
        : " NBM has no 24-hour snowfall chances."}
      {v.key === "rain72" && " The first days without a complete 3-day total are blank."}</>
    if (nbmVars.length > 1) varTabs = (
      <Tabs value={v.key} onValueChange={(x) => setNbm(x as NbmKey)}>
        <TabsList>{nbmVars.map((x) => <TabsTrigger key={x.key} value={x.key}>{x.label}</TabsTrigger>)}</TabsList>
      </Tabs>
    )
    if (v.thresholds.length > 1) thrTabs = (
      <Tabs value={String(ti)} onValueChange={(x) => setThr((s) => ({ ...s, [v.key]: Number(x) }))}>
        <TabsList>{v.thresholds.map((x, i) => <TabsTrigger key={x} value={String(i)}>{v.unit === "in" ? `${x}″+` : `${x}+ mph`}</TabsTrigger>)}</TabsList>
      </Tabs>
    )
  }
  const showThr = src === "ens"
  // NBM runs out at day 11 (gusts are read for the first week): leave off the empty days
  const lastDay = dates.reduce((n, _d, i) => (data.points.some((p) => cell(p.name, i) != null) ? i : n), -1)
  dates = dates.slice(0, lastDay + 1)

  // the takeaway: the best chance in the first week
  let best: { n: string; v: number; i: number } | null = null
  for (const p of data.points) for (let i = 0; i < Math.min(7, dates.length); i++) {
    const x = cell(p.name, i)
    if (x != null && (!best || x > best.v)) best = { n: p.name, v: x, i }
  }
  const dayName = (d: string) => ptDay(`${d}T20:00:00Z`)
  const takeaway = !best || best.v < 10 ? <>Under a 10% chance of {label} anywhere in the next week.</>
    : <>Best chance: {best.n}, {best.v}% for {label}{src === "ens" ? ` (its ${thrText(best.n)} threshold)` : ""} {dayName(dates[best.i])}.</>

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription>{what}</CardDescription>
        {mapReq && (
          <CardAction>
            <MapButton req={{ mode: "totals", variable: mapReq.variable, days: 7 }} label="Chances on the map" />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {(sources.length > 1 || varTabs || thrTabs) && (
          <div className="flex flex-wrap items-center gap-2">
            {sources.length > 1 && (
              <Tabs value={src} onValueChange={(x) => setSrc(x as OddsSource)}>
                <TabsList><TabsTrigger value="ens">Ensembles</TabsTrigger><TabsTrigger value="nbm">NBM</TabsTrigger></TabsList>
              </Tabs>
            )}
            {varTabs}
            {thrTabs}
          </div>
        )}
        <div className="overflow-x-auto">
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead>Location</TableHead>
              {showThr && <TableHead className="text-right">Threshold</TableHead>}
              {dates.map((d) => <TableHead key={d} className="h-auto px-1 py-1.5 text-center text-xs"><DayHead day={d} /></TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.flatMap((g) => [
              <TableRow key={g.name} className="hover:bg-transparent"><TableCell colSpan={dates.length + 2} className="pt-3 text-xs font-medium text-muted-foreground">{g.name}</TableCell></TableRow>,
              ...g.pts.map((p) => (
                <TableRow key={p.name}>
                  <TableCell className="whitespace-nowrap">{p.name}</TableCell>
                  {showThr && <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">{thrText(p.name)}</TableCell>}
                  {dates.map((d, i) => {
                    const v = cell(p.name, i)
                    return <TableCell key={d} className="px-1 text-center text-xs tabular-nums" style={probCell(v)}>{v == null ? "" : v < 5 ? "" : `${v}`}</TableCell>
                  })}
                </TableRow>
              )),
            ])}
          </TableBody>
        </Table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ pressure gradients

/** One row per pair: 3-hour bins where any model passes a threshold, merged into runs at the same
 *  level, shaded by the share of models that agree. Per-model peaks are in the tooltip. */
function GradientTimeline({ gs }: { gs: Gradient[] }) {
  const all = gs.flatMap((g) => g.series.flatMap((s) => s.times.map((x) => Date.parse(x))))
  const t0 = Math.min(...all), t1 = Math.max(...all)
  const BIN = 3 * H
  const groups: TimelineGroup[] = gs.map((g) => {
    type Run = { start: number; end: number; level: number; label: string; most: number; n: number; peaks: Map<string, { v: number; at: number }> }
    const runs: Run[] = []
    for (let t = t0; t <= t1; t += BIN) {
      const lv = g.series.map((s) => ({ s, v: seriesAt(s, t, s.times.length > 60 ? 1.6 : 3.5) }))
        .filter((x): x is { s: ModelSeries; v: number } => x.v != null)
        .map((x) => ({ ...x, ...gradLevel(g, x.v) }))
      const top = Math.max(0, ...lv.map((x) => x.level))
      if (!top) continue
      const over = lv.filter((x) => x.level >= 1)
      const label = lv.find((x) => x.level === top)!.label!
      const last = runs[runs.length - 1]
      const run = last && last.level === top && last.label === label && last.end >= t - BIN / 2 ? last
        : (runs.push({ start: t - BIN / 2, end: t + BIN / 2, level: top, label, most: 0, n: 0, peaks: new Map() }), runs[runs.length - 1])
      run.end = t + BIN / 2
      run.most = Math.max(run.most, over.length)
      run.n = Math.max(run.n, lv.length)
      for (const x of over) {
        const p = run.peaks.get(x.s.model)
        if (!p || Math.abs(x.v) > Math.abs(p.v)) run.peaks.set(x.s.model, { v: x.v, at: t })
      }
    }
    return {
      key: g.id, label: pairName(g), title: g.meaning,
      rows: [{
        key: "models", label: <span className="truncate">{g.thresholds.length ? "Models past" : ""}</span>,
        bars: runs.map((r, k) => {
          const share = r.n ? r.most / r.n : 0
          return {
            key: String(k), start: Math.max(t0, r.start), end: Math.min(t1, r.end),
            color: `color-mix(in srgb, ${GRAD_COLORS[r.level]} ${Math.round(40 + 60 * share)}%, transparent)`,
            text: r.level >= 2 && share >= 0.5 ? "#fff" : "#1b1f24",
            label: `${r.label} · ${r.most}/${r.n}`, short: `${r.most}/${r.n}`,
            aria: `${pairName(g)}: ${r.label} in up to ${r.most} of ${r.n} models, ${tipTime(r.start)} to ${tipTime(r.end)}`,
            tip: <>
              <p className="font-semibold">{pairName(g)} · {r.label}</p>
              <p>{tipTime(r.start + BIN / 2)} – {tipTime(r.end - BIN / 2)}, up to {r.most} of {r.n} models</p>
              <div className="grid grid-cols-[auto_auto_auto] gap-x-3 pt-1 opacity-85">
                {[...r.peaks.entries()].sort((a, b) => Math.abs(b[1].v) - Math.abs(a[1].v)).map(([m, p]) => (
                  <React.Fragment key={m}><span>{m}</span><span className="text-right tabular-nums">{p.v > 0 ? "+" : ""}{p.v.toFixed(1)} hPa</span><span className="opacity-75">{tipTime(p.at)}</span></React.Fragment>
                ))}
              </div>
              <p className="opacity-75">{g.meaning}</p>
            </>,
          }
        }),
      }],
    }
  })
  return <Timeline t0={t0} t1={t1} groups={groups} groupW={96} rowW={88} />
}

export function GradientsCard({ data }: { data: Briefing }) {
  const gs = (data.gradients ?? []).filter((g) => g.series.length)
  if (!gs.length) return null
  const models = [...new Set(gs.flatMap((g) => g.series.map((s) => s.model)))]
  const anyPast = gs.some((g) => g.series.some((s) => s.values.some((v) => gradLevel(g, v).level > 0)))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pressure gradients</CardTitle>
        <CardDescription info="Sea-level pressure difference between station pairs (hPa), from each model's grid. Dashed lines are rules of thumb for where impacts usually start.">
          Pressure differences behind the region's wind events.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2"><MapButton req={{ mode: "hourly", layer: "pgrad", isobars: true, pairs: true }} label="Pressure gradients on the map" /></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">When each pair passes its thresholds</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px]" style={{ background: GRAD_COLORS[1] }} />first threshold</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px]" style={{ background: GRAD_COLORS[2] }} />second</span>
              <span>· deeper = more models agree</span>
            </div>
          </div>
          <GradientTimeline gs={gs} />
          {!anyPast && <p className="text-xs text-muted-foreground">No pair reaches a threshold in any model through this forecast.</p>}
        </div>
        <ModelLegend models={models} />
        <div className="grid gap-6 lg:grid-cols-2">
          {gs.map((g) => {
            const series = models.map((m) => g.series.find((s) => s.model === m)).filter(Boolean) as ModelSeries[]
            const vals = series.flatMap((s) => s.values).filter((v): v is number => v != null)
            const lim = Math.max(4, ...vals.map(Math.abs), ...g.thresholds.map((t) => Math.abs(t.value)))
            const gtop = Math.ceil((lim + 1) / 4) * 4
            return (
              <div key={g.id}>
                <p className="text-sm font-medium">{g.a} − {g.b}{g.codes?.[0] && g.codes?.[1] && (
                  <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">({g.codes[0]}–{g.codes[1]})</span>)}</p>
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
        <CardDescription info={<>Each model's freezing level minus {sl.offset_ft.toLocaleString("en-US")} ft, where snow usually starts reaching the
          ground. Below the pass elevation (shaded), precipitation at the pass falls as snow. From models with a freezing-level field (HRRR, RRFS, NAM and GFS).
          The offset is a rule of thumb; in heavy precipitation or with cold air trapped in the passes, snow can fall lower.</>}>
          Each model's snow level against the passes.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2"><MapButton req={{ mode: "hourly", layer: "frz" }} label="Freezing level on the map" /></CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="overflow-x-auto">
          <Tabs value={p.name} onValueChange={setName}>
            <TabsList>{passes.map((x) => <TabsTrigger key={x.name} value={x.name}>{x.name.replace(" Pass", "")}</TabsTrigger>)}</TabsList>
          </Tabs>
        </div>
        <SeriesChart series={p.series} unit="ft" height={260} domain={[0, top]} yTicks={ticksOf(0, top, top > 8000 ? 2000 : 1000)}
                     format={(v) => v.toLocaleString("en-US")}>
          <ReferenceArea y1={0} y2={p.elev_ft} fill="#3f80dc" fillOpacity={0.08} />
          <ReferenceLine y={p.elev_ft} stroke="#1b1f24" strokeDasharray="5 4"
                         label={{ value: `${p.name} ${p.elev_ft.toLocaleString("en-US")} ft`, position: "insideTopLeft", fontSize: 11, fill: "#1b1f24" }} />
        </SeriesChart>
        <ModelLegend models={p.series.map((s) => s.model)} />
      </CardContent>
    </Card>
  )
}



// ------------------------------------------------------------------ snowpack (SNOTEL)

// ------------------------------------------------------------------ avalanche danger (NWAC)

/** North American Public Avalanche Danger Scale colours. */
const AVY = ["#9ca3af", "#50b848", "#fff200", "#f7941e", "#ed1c24", "#231f20"]
const AVY_LABEL = ["No rating", "Low", "Moderate", "Considerable", "High", "Extreme"]
const avyText = (l: number) => contrastTextColor(AVY[l] ?? AVY[0])

function AvyCell({ level }: { level: number | null }) {
  const l = level ?? 0
  return (
    <span className="flex h-6 items-center justify-center rounded-[3px] text-[11px] font-medium"
          style={{ background: l ? AVY[l] : "transparent", color: l ? avyText(l) : "var(--muted-foreground)",
                   boxShadow: l ? "inset 0 0 0 1px rgb(0 0 0 / 0.08)" : "inset 0 0 0 1px var(--border)" }}>
      {l ? AVY_LABEL[l] : "–"}
    </span>
  )
}

function AvyBands({ today, tomorrow }: { today?: AvalancheDanger | null; tomorrow?: AvalancheDanger | null }) {
  const rows: [keyof AvalancheDanger, string][] = [["upper", "Above treeline"], ["middle", "Near treeline"], ["lower", "Below treeline"]]
  return (
    <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-1.5 gap-y-1 text-xs">
      <span /><span className="text-center text-muted-foreground">Today</span><span className="text-center text-muted-foreground">Tomorrow</span>
      {rows.map(([k, label]) => (
        <React.Fragment key={k}>
          <span className="pr-1 text-muted-foreground">{label}</span>
          <AvyCell level={today?.[k] ?? null} />
          <AvyCell level={tomorrow?.[k] ?? null} />
        </React.Fragment>
      ))}
    </div>
  )
}

export function AvalancheCard({ data }: { data: Briefing }) {
  const av = data.avalanche as Avalanche | null | undefined
  if (!av || !av.zones.length) return null
  const advice = [...new Set(av.zones.map((z) => z.travelAdvice).filter(Boolean))] as string[]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Avalanche danger</CardTitle>
        <CardDescription info="Northwest Avalanche Center forecasts by zone, by elevation band for today and tomorrow. Check the full forecast before heading into avalanche terrain.">
          Avalanche danger by zone, today and tomorrow.
        </CardDescription>
        <CardAction>
          <a className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" href={av.url} target="_blank" rel="noopener">NWAC forecasts</a>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {!av.inSeason ? (
          <div className="space-y-2 text-sm">
            <p>
              NWAC hasn't started daily danger ratings for the season yet
              {av.until && <> (the early-season summary runs through {dayShort(av.until)})</>}. Until then:
            </p>
            {advice.map((a) => <p key={a} className="text-muted-foreground">{a}</p>)}
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {av.zones.map((z) => <a key={z.name} className="text-muted-foreground underline underline-offset-2 hover:text-foreground" href={z.link} target="_blank" rel="noopener">{z.name}</a>)}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {av.zones.map((z) => (
              <div key={z.name} className="space-y-2.5 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <a className="text-sm font-medium hover:underline" href={z.link} target="_blank" rel="noopener">{z.name}</a>
                  <span className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium"
                        style={{ background: AVY[Math.max(0, z.level)], color: avyText(z.level) }}>{z.level >= 1 ? z.label : "No rating"}</span>
                </div>
                {z.warning && <p className="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200">{z.warning}</p>}
                {(z.today || z.tomorrow) && <AvyBands today={z.today} tomorrow={z.tomorrow} />}
                {z.problems && z.problems.length > 0 && (
                  <p className="text-xs"><span className="text-muted-foreground">Problems:</span> {z.problems.join(", ")}</p>
                )}
                {z.bottomLine && <p className="line-clamp-3 text-xs text-muted-foreground" title={z.bottomLine}>{z.bottomLine}</p>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Snow water against the median for the date: a bar filled to today's SWE with a tick at the
 *  median, on a scale shared by the rows in view so areas compare. */
function SweBar({ swe, median, max }: { swe: N; median: N; max: number }) {
  if (swe == null) return <span className="text-muted-foreground">–</span>
  return (
    <span className="relative block h-2 w-full rounded-full bg-border/70">
      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, (100 * swe) / max)}%`, background: SNOW_HUE }} />
      {median != null && median > 0 && <span className="absolute -inset-y-1 w-[2px] -translate-x-1/2 rounded bg-foreground" style={{ left: `${Math.min(100, (100 * median) / max)}%` }} />}
    </span>
  )
}
const SNOW_HUE = "#6553cf"

/** Snow depth over the last 30 days, with the latest value dotted. */
function DepthLine({ h, max }: { h?: { depth: N[] }; max: number }) {
  const xs = (h?.depth ?? []).map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null)
  if (xs.length < 2) return <span className="text-[11px] text-muted-foreground">–</span>
  const n = h!.depth.length, W = 120, H = 22
  const x = (i: number) => (W * i) / (n - 1), y = (v: number) => H - 2 - ((H - 4) * v) / Math.max(1, max)
  const line = xs.map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("")
  const area = `${line}L${x(xs[xs.length - 1][0]).toFixed(1)},${H}L${x(xs[0][0]).toFixed(1)},${H}Z`
  const [li, lv] = xs[xs.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[22px] w-full overflow-visible" preserveAspectRatio="none" aria-hidden>
      <path d={area} fill={SNOW_HUE} opacity="0.12" />
      <path d={line} fill="none" stroke={SNOW_HUE} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx={x(li)} cy={y(lv)} r="2.2" fill={SNOW_HUE} />
    </svg>
  )
}

export function SnowpackCard({ data }: { data: Briefing }) {
  const sp = data.snowpack
  const [open, setOpen] = React.useState<string | null>(null)
  if (!sp || !sp.areas.length) return null
  const signed = (v: N) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)}″`)
  // one scale for every bar and every depth line, so areas and stations compare
  const all = sp.areas.flatMap((a) => [a, ...a.stations] as { swe: N; median: N; hist?: { depth: N[] } }[])
  const sweMax = Math.max(1, ...all.flatMap((x) => [x.swe ?? 0, x.median ?? 0])) * 1.1
  const depthMax = Math.max(6, ...all.flatMap((x) => (x.hist?.depth ?? []).filter((v): v is number => v != null)))
  const hasHist = all.some((x) => x.hist)
  // the takeaway: the area furthest from its median, or the deepest if percentages are blank
  const withPct = sp.areas.filter((a) => a.pct != null)
  const takeaway = withPct.length
    ? (() => { const lo = [...withPct].sort((a, b) => a.pct! - b.pct!)[0], hi = [...withPct].sort((a, b) => b.pct! - a.pct!)[0]
        return <>{hi.name} {hi.pct}% of median{hi !== lo && <>; {lo.name} {lo.pct}%</>}.</> })()
    : (() => { const top = [...sp.areas].sort((a, b) => (b.swe ?? 0) - (a.swe ?? 0))[0]
        return top && top.swe != null ? <>Early season: {top.name} leads with {inch(top.swe)}″ of snow water{top.median != null ? ` (median ${inch(top.median)}″)` : ""}.</> : null })()
  const cols = `grid-cols-[minmax(130px,1.2fr)_minmax(110px,2fr)_56px_minmax(80px,1fr)_52px]`
  const Row = ({ name, sub, swe, median, pct, change7, hist, depth, onClick, opened, small }: {
    name: React.ReactNode; sub?: string; swe: N; median: N; pct: N; change7: N; hist?: { depth: N[] }; depth?: N
    onClick?: () => void; opened?: boolean; small?: boolean }) => (
    <div className={`grid ${cols} items-center gap-x-3 py-1.5 ${small ? "text-xs" : "text-[13px]"} ${onClick ? "cursor-pointer hover:bg-muted/40" : ""}`}
         onClick={onClick} role={onClick ? "button" : undefined} aria-expanded={onClick ? opened : undefined} tabIndex={onClick ? 0 : undefined}
         onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick() } } : undefined}>
      <div className={`min-w-0 ${small ? "pl-5" : ""}`}>
        <span className={`block truncate ${small ? "" : "font-medium"}`}>{onClick && <span className="mr-1.5 inline-block w-3 text-muted-foreground">{opened ? "▾" : "▸"}</span>}{name}</span>
        {sub && <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="flex items-center gap-2 outline-none">
            <span className="w-10 shrink-0 text-right tabular-nums">{swe == null ? "–" : `${inch(swe)}″`}</span>
            <SweBar swe={swe} median={median} max={sweMax} />
          </span>
        </TooltipTrigger>
        <TooltipContent>Snow water {swe == null ? "–" : `${inch(swe)}″`} against a median {median == null ? "–" : `${inch(median)}″`} for the date{pct != null ? ` (${pct}%)` : ""}</TooltipContent>
      </Tooltip>
      {/* percent of median in a coloured cell with the 3 px corners of the briefing's other value cells */}
      <span className="flex justify-end">
        {pct == null ? <span className="text-muted-foreground">–</span>
          : <span className="min-w-12 rounded-[3px] px-1.5 py-1 text-center text-xs font-medium tabular-nums" style={pctCell(pct)}>{pct}%</span>}
      </span>
      {hasHist ? (
        <Tooltip>
          <TooltipTrigger asChild><span tabIndex={0} className="block outline-none"><DepthLine h={hist} max={depthMax} /></span></TooltipTrigger>
          <TooltipContent>Snow depth over the last 30 days{depth != null ? `; ${Math.round(depth)}″ now` : ""}</TooltipContent>
        </Tooltip>
      ) : <span className="text-right text-muted-foreground tabular-nums">{depth == null ? "" : `${Math.round(depth)}″`}</span>}
      <span className="text-right tabular-nums">{signed(change7)}</span>
    </div>
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Snowpack</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription info={<>Snow water equivalent (SWE) at SNOTEL stations near each area{sp.asOf ? `, as of ${dateRange(sp.asOf, sp.asOf)}` : ""}:
          the bar is today's SWE and the tick the station's median for the date, with snow depth over the last 30 days. Select an area to see its stations.
          {" "}Area values are averages across their stations; area percent of median is total SWE over total median SWE, as NRCS builds basin indices. It's left
          blank until the median reaches {sp.minMedian}″, since early-season medians near zero make percentages meaningless.</>}>
          Snow water at SNOTEL stations against the median.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div className={`grid ${cols} gap-x-3 border-b pb-1.5 text-xs text-muted-foreground`}>
              <span>Area</span><span className="pl-12">Snow water vs median</span><span className="text-right">% of median</span>
              <span>{hasHist ? "Depth, 30 days" : "Depth"}</span><span className="text-right">7 days</span>
            </div>
            {sp.areas.map((a) => (
              <div key={a.name} className="border-b last:border-b-0">
                <Row name={a.name} sub={`${a.stations.length} station${a.stations.length === 1 ? "" : "s"}`} swe={a.swe} median={a.median} pct={a.pct}
                     change7={a.change7} hist={a.hist} onClick={() => setOpen(open === a.name ? null : a.name)} opened={open === a.name} />
                {open === a.name && a.stations.map((s) => (
                  <Row key={s.triplet} small name={s.name} sub={[s.elev_ft ? `${s.elev_ft.toLocaleString("en-US")} ft` : null, s.depth != null ? `${s.depth}″ deep` : null].filter(Boolean).join(" · ")}
                       swe={s.swe} median={s.median} pct={s.pct} change7={s.change7} hist={s.hist} depth={s.depth} />
                ))}
              </div>
            ))}
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="relative inline-block h-2 w-10 rounded-full bg-border/70"><span className="absolute inset-y-0 left-0 w-6 rounded-full" style={{ background: SNOW_HUE }} /><span className="absolute -inset-y-1 left-8 w-[2px] rounded bg-foreground" /></span>SWE, with the median as the tick (one scale for all rows)</span>
          {hasHist && <span>Depth lines share one scale, up to {Math.round(depthMax)}″</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {sp.source}.
        </p>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ NWS discussions and outlooks

const issuedAt = (iso: string | null) => (iso ? issuedLabel(iso) : "")     // "Sat 11/7 3:28 AM PST"

/** Collapsed to each office's key messages (or the synopsis's opening paragraph when there are
 *  none); one toggle opens the full synopsis and hydrology for both offices. */
const OFFICE_NAME: Record<string, string> = { SEW: "NWS Seattle", PQR: "NWS Portland", OTX: "NWS Spokane", PDT: "NWS Pendleton", MFR: "NWS Medford" }
/** A paragraph as sentences (the AFD synopsis is a few plain sentences). */
const sentences = (p: string) => p.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((x) => x.trim()).filter(Boolean)
const BRIEF = 3      // synopsis sentences shown as bullets before "show more"

export function DiscussionsCard({ data, defaultFull = false }: { data: Briefing; defaultFull?: boolean }) {
  const ds = data.outlooks?.discussions ?? []
  const [full, setFull] = React.useState(defaultFull)
  if (!ds.length) return null
  // without key messages (most days: offices write them for significant weather), the synopsis
  // sentences stand in as the bullets
  const sents = (d: (typeof ds)[number]) => (d.synopsis ?? []).flatMap(sentences)
  const more = ds.some((d) => (d.keyMessages ? sents(d).length > 0 : sents(d).length > BRIEF) || (d.hydrology?.length ?? 0) > 0)
  const head = (t: string) => <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">{t}</p>
  const bullets = (xs: string[]) => <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{xs.map((k, i) => <li key={i} className="leading-snug">{k}</li>)}</ul>
  return (
    <Card>
      <CardHeader>
        <CardTitle>From the forecast discussions</CardTitle>
        <CardDescription info={<>The key messages from each NWS office's latest Area Forecast Discussion, or the main points of its synopsis when it has none
          {more && "; the rest of the synopsis and the hydrology notes are a click away"}.</>}>
          The key messages from each NWS office.
        </CardDescription>
        {more && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setFull((x) => !x)} aria-expanded={full}>
              {full ? "Show less" : "Show synopsis and hydrology"}
              <ChevronDown className={`transition-transform ${full ? "rotate-180" : ""}`} />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        {ds.map((d) => {
          const syn = sents(d)
          const km = d.keyMessages?.map((k) => k.replace(/^\*\s*/, ""))
          const showSyn = km ? (full ? syn : []) : full ? syn : syn.slice(0, BRIEF)
          return (
            <div key={d.office} className="space-y-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{OFFICE_NAME[d.office] ?? d.name}</span>
                <a className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" href={d.url} target="_blank" rel="noopener">
                  Issued {issuedAt(d.issued)} · full discussion
                </a>
              </div>
              {km && <div>{head("Key messages")}{bullets(km)}</div>}
              {showSyn.length > 0 && <div>{head(km ? "Synopsis" : "From the synopsis")}{bullets(showSyn)}</div>}
              {full && d.hydrology && (
                <div>
                  {head("Hydrology")}
                  <div className="space-y-2">{d.hydrology.map((p, i) => <p key={i} className="leading-relaxed">{p}</p>)}</div>
                </div>
              )}
              {!km && !syn.length && <p className="text-muted-foreground">No synopsis in the latest discussion.</p>}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

/** The forecast discussions in brief, under the hazard cards: each office's key messages, or the
 *  first few sentences of its synopsis, with a link to the full text in the Outlooks tab. */
export function ForecasterNotes({ data, onFull }: { data: Briefing; onFull: () => void }) {
  const ds = data.outlooks?.discussions ?? []
  if (!ds.length) return null
  return (
    <Card className="gap-0 py-4">
      <CardContent className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        {ds.map((d) => {
          const km = d.keyMessages?.map((k) => k.replace(/^\*\s*/, ""))
          const pts = (km?.length ? km : (d.synopsis ?? []).flatMap(sentences)).slice(0, BRIEF)
          return (
            <div key={d.office} className="min-w-0 text-sm">
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">{OFFICE_NAME[d.office] ?? d.name} forecasters</span>
                <span className="text-xs text-muted-foreground">{issuedAt(d.issued)}</span>
              </div>
              {pts.length ? (
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground marker:text-muted-foreground/60">
                  {pts.map((k, i) => <li key={i} className="leading-snug"><span className="text-foreground">{k}</span></li>)}
                </ul>
              ) : <p className="text-muted-foreground">No synopsis in the latest discussion.</p>}
            </div>
          )
        })}
        <div className="md:col-span-2">
          <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground hover:text-foreground" onClick={onFull}>
            Full discussions and outlooks<ChevronRight aria-hidden />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** The full forecast discussions, one office at a time: every section in order (synopsis, short
 *  and long term, aviation, marine, hydrology…) as readable paragraphs. Falls back to the summary
 *  card for briefings that only kept the synopsis. */
export function FullDiscussions({ data }: { data: Briefing }) {
  const ds = data.outlooks?.discussions ?? []
  const [office, setOffice] = React.useState(ds[0]?.office ?? "")
  if (!ds.length) return null
  if (!ds.some((d) => d.sections?.length)) return <DiscussionsCard data={data} defaultFull />
  const d = ds.find((x) => x.office === office) ?? ds[0]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Area forecast discussions</CardTitle>
        <CardDescription full>The latest discussion from each NWS office, in full.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={d.office} onValueChange={setOffice}>
            <TabsList>{ds.map((x) => <TabsTrigger key={x.office} value={x.office}>{OFFICE_NAME[x.office] ?? x.name}</TabsTrigger>)}</TabsList>
          </Tabs>
          <a className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" href={d.url} target="_blank" rel="noopener">
            Issued {issuedAt(d.issued)} · on weather.gov
          </a>
        </div>
        {d.sections?.length ? (
          <article className="max-w-3xl space-y-6 text-[15px] leading-relaxed">
            {d.sections.map((sec, i) => (
              <section key={i}>
                <h3 className="mb-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">{sec.title}</h3>
                <div className="space-y-3">
                  {sec.paragraphs.map((p, j) => {
                    const item = /^[-*]\s/.test(p)
                    return item
                      ? <p key={j} className="relative pl-5 before:absolute before:left-1.5 before:text-muted-foreground before:content-['•']">{p.replace(/^[-*]\s+/, "")}</p>
                      : <p key={j}>{p}</p>
                  })}
                </div>
              </section>
            ))}
          </article>
        ) : <p className="text-muted-foreground">The full text of this discussion wasn't kept; it's on weather.gov.</p>}
      </CardContent>
    </Card>
  )
}

const ERO_COLORS = ["transparent", "#7cc47c", "#f6e05e", "#e9502e", "#d62fd6"]
const CPC_BASE: Record<string, Record<string, string>> = {
  temperature: { Above: "#e4572e", Below: "#2b7bba" },
  precipitation: { Above: "#1a9e85", Below: "#b07d2b" },
}
const CPC_NEAR = "#9ca3af", CPC_EC = "#d1d5db"
const cpcWords = (cat: string) => cat === "EC" ? "Equal chances" : cat === "Normal" || cat === "Near" ? "Near normal" : cat
/** CPC category colour, deeper as the probability rises (33% → light, 80%+ → full). */
function cpcColor(v: "temperature" | "precipitation", cat: string, prob: number | null) {
  const base = CPC_BASE[v][cat] ?? (cat === "EC" ? CPC_EC : CPC_NEAR)
  const k = cat === "EC" ? 60 : Math.round(30 + 60 * Math.min(1, Math.max(0, ((prob ?? 33) - 33) / 47)))
  return `color-mix(in srgb, ${base} ${k}%, transparent)`
}
/** Midnight Pacific at the start of a YYYY-MM-DD date. */
export const ptMidnight = (d: string) => {
  const t = Date.parse(`${d}T00:00:00-08:00`)
  return ptHour(t) === 1 ? t - H : t                      // daylight time
}

function CpcKey() {
  const sw = (c: string, label: string) => (
    <span key={label} className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-4 rounded-[3px]" style={{ background: c }} />{label}
    </span>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {sw(CPC_BASE.temperature.Above, "Warmer")}{sw(CPC_BASE.temperature.Below, "Cooler")}
      {sw(CPC_BASE.precipitation.Above, "Wetter")}{sw(CPC_BASE.precipitation.Below, "Drier")}
      {sw(CPC_NEAR, "Near normal")}{sw(CPC_EC, "Equal chances")}
      <span>· deeper = more likely</span>
    </div>
  )
}

export function OutlooksCard({ data }: { data: Briefing }) {
  const o = data.outlooks
  if (!o || (!o.ero && !o.cpc)) return null
  const groupsAll = [
    ...data.regions.map((r) => ({ name: r.name, pts: data.points.filter((p) => p.region === r.id).map((p) => p.name) })),
    { name: "Other locations", pts: data.points.filter((p) => !data.regions.some((r) => r.id === p.region)).map((p) => p.name) },
  ].filter((g) => g.pts.length)
  const today = data.dates[0]
  const dayIso = (d: number) => {
    const t = new Date(`${today}T12:00:00`)
    t.setDate(t.getDate() + d - 1)
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`
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
  const cpc = (() => {
    const outs = (o.cpc?.outlooks ?? []).filter((x) => x.start && x.end)
    if (!outs.length) return null
    const order = (x: (typeof outs)[number]) => (x.var === "temperature" ? 0 : 2) + (x.period === "6-10" ? 0 : 1)
    outs.sort((a, b) => order(a) - order(b))
    const t0 = ptMidnight(data.dates[0])
    const t1 = Math.max(...outs.map((x) => ptMidnight(x.end!) + 24 * H), t0 + 14 * 24 * H)
    const covered = (p: string) => outs.some((x) => x.points[p]?.cat)
    const uncovered = data.points.map((p) => p.name).filter((p) => !covered(p))
    const groups: TimelineGroup[] = groupsAll.map((g) => ({ ...g, pts: g.pts.filter(covered) })).filter((g) => g.pts.length).map((g) => ({
      key: g.name, label: g.name,
      rows: outs.map((x) => {
        const v = cpcGroup(g.pts, x.points)
        const what = x.var === "temperature" ? "temperature" : "precipitation"
        const per = g.pts.map((p) => [p, x.points[p]] as const).filter(([, q]) => q?.cat)
        return {
          key: `${x.period}-${x.var}`,
          label: <span className="truncate">{x.var === "temperature" ? "Temp" : "Precip"} · {x.period.replace("-", "–")} d</span>,
          bars: v ? [{
            key: "o", start: ptMidnight(x.start!), end: ptMidnight(x.end!) + 24 * H,
            color: cpcColor(x.var, v.cat, v.prob),
            label: v.cat === "EC" ? "Equal chances" : `${cpcWords(v.cat)}${v.prob ? ` ${Math.round(v.prob)}%` : ""}`,
            short: v.prob ? `${Math.round(v.prob)}%` : "EC",
            aria: `${g.name}, ${x.period} day ${what} outlook, ${dateRange(x.start!, x.end!)}: ${cpcWords(v.cat)}${v.prob ? `, ${Math.round(v.prob)}%` : ""}`,
            tip: <>
              <p className="font-semibold">{g.name} · {x.period.replace("-", "–")} day {what}</p>
              <p>{dateRange(x.start!, x.end!)}</p>
              <p>{v.cat === "EC" ? "Equal chances of above, near or below normal" : `${cpcWords(v.cat)}${v.cat === "Above" || v.cat === "Below" ? " normal" : ""}, ${Math.round(v.prob ?? 0)}% chance`}</p>
              {per.length > 1 && per.every(([, q]) => q!.cat === v.cat && q!.prob === v.prob) && (
                <p className="opacity-80">The same at all {per.length} locations.</p>
              )}
              {per.length > 1 && !per.every(([, q]) => q!.cat === v.cat && q!.prob === v.prob) && (
                <div className="grid grid-cols-[auto_auto] gap-x-3 pt-1 opacity-80">
                  {per.map(([p, q]) => (
                    <React.Fragment key={p}><span>{p}</span><span className="text-right tabular-nums">{cpcWords(q!.cat!)}{q!.prob ? ` ${Math.round(q!.prob)}%` : ""}</span></React.Fragment>
                  ))}
                </div>
              )}
            </>,
          }] : [],
        }
      }),
    }))
    return groups.length ? { t0, t1, groups, uncovered } : null
  })()
  return (
    <Card>
      <CardHeader>
        <CardTitle>National outlooks</CardTitle>
        <CardDescription info="WPC's Excessive Rainfall Outlook (days 1 – 5) and CPC's 6 – 10 and 8 – 14 day outlooks at the forecast locations.">
          Excessive rainfall and extended outlooks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        {o.ero && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Excessive rainfall risk</p>
            {anyEro ? (
              <Table>
                <TableHeader><TableRow><TableHead>Location</TableHead>{eroDays.map((d) => <TableHead key={d.day} className="h-auto py-1.5 text-center text-xs"><DayHead day={dayIso(d.day)} /></TableHead>)}</TableRow></TableHeader>
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
            ) : <p className="text-sm text-muted-foreground">No excessive rainfall risk at any forecast location for days 1 – 5.</p>}
            <a className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" href={o.ero.url} target="_blank" rel="noopener">WPC Excessive Rainfall Outlook</a>
          </div>
        )}
        {cpc && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">CPC extended outlooks</p>
              <CpcKey />
            </div>
            <Timeline t0={cpc.t0} t1={cpc.t1} groups={cpc.groups} groupW={150} rowW={100} />
            <p className="text-xs text-muted-foreground">
              Each bar is the most common category across the area's locations, over the days the outlook covers; hover
              for each location's category and probability.
              {cpc.uncovered.length > 0 && ` CPC outlooks cover the US only, so ${cpc.uncovered.join(", ")} ${cpc.uncovered.length > 1 ? "are" : "is"} left out.`}{" "}
              <a className="underline underline-offset-2 hover:text-foreground" href={o.cpc!.url} target="_blank" rel="noopener">CPC 6 – 10 and 8 – 14 day outlooks</a>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
