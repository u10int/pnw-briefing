import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { blueCell, inch, median } from "@/lib/format"
import type { Briefing, N, Tier } from "@/types"
import { Delta, PctNormal } from "@/components/Delta"
import { contrastTextColor } from "@/lib/contrast"

const REGION_VAR: Record<string, string> = { wwa: "var(--wwa)", nwor: "var(--nwor)" }

/** Width of an element in CSS pixels, kept current with a ResizeObserver. */
function useWidth<T extends HTMLElement>() {
  const ref = React.useRef<T>(null)
  const [w, setW] = React.useState(280)
  React.useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e.contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function niceMax(v: number) {
  return [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 70, 80, 100, 120].find((s) => s >= v * 1.05) ?? Math.ceil(v)
}

export function ModelName({ label, tier, source }: { label: string; tier: Tier; source: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {label}{source === "open-meteo" ? " *" : ""}
      <Badge variant={tier} className="px-1.5 py-0 text-[10.5px]">{tier}</Badge>
    </span>
  )
}

function RangeBar({ lo, hi, median, scale, color, unit }: { lo: number; hi: number; median: number; scale: number; color: string; unit: Unit }) {
  const pct = (v: number) => `${Math.min(100, (100 * v) / scale)}%`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative mt-1.5 h-4 w-full cursor-default" aria-label={`Range ${unit.fmt(lo)} to ${unit.fmt(hi)} ${unit.word}`}>
          <div className="absolute top-[7px] h-0.5 w-full rounded bg-border" />
          <div className="absolute top-1 h-2 rounded-full opacity-30" style={{ left: pct(lo), width: `max(4px, ${pct(hi - lo)})`, background: color }} />
          <div className="absolute top-0 h-4 w-[3px] -translate-x-1/2 rounded-sm" style={{ left: pct(median), background: color }} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Models range {unit.fmt(lo)} – {unit.fmt(hi)} {unit.word}; median {unit.fmt(median)} {unit.word}
      </TooltipContent>
    </Tooltip>
  )
}

/** How values are written: "1.6 in", "52 mph". */
export type Unit = { word: string; fmt: (v: number) => string; tip: (v: number) => string; zero: boolean }
export const INCHES: Unit = { word: "in", fmt: (v) => v.toFixed(1), tip: (v) => v.toFixed(2), zero: true }
export const MPH: Unit = { word: "mph", fmt: (v) => String(Math.round(v)), tip: (v) => String(Math.round(v)), zero: false }

/** One region's headline in a window: the median across models, their range, and up to two notes
 *  under the bar (share of normal; change since yesterday). */
export type SummaryRow = { rid: string; name: string; median: number; lo: number; hi: number; scale: number; left?: React.ReactNode; right?: React.ReactNode }

function RegionSummary({ rows, unit }: { rows: SummaryRow[]; unit: Unit }) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.rid}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: REGION_VAR[r.rid] }} />
              <span className="truncate">{r.name}</span>
            </span>
            <span className="text-2xl font-semibold tracking-tight tabular-nums">
              {unit.fmt(r.median)}<span className="ml-0.5 text-sm font-medium text-muted-foreground">{unit.word}</span>
            </span>
          </div>
          <RangeBar lo={r.lo} hi={r.hi} median={r.median} scale={r.scale} color={REGION_VAR[r.rid]} unit={unit} />
          {(r.left || r.right) && (
            <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs">
              <span>{r.left}</span>{r.right}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Change since yesterday, with the before and after on hover. */
export function ChangeNote({ c, overlap, unit, tone }: { c: { delta: number; prev: number; now: number } | undefined; overlap: number; unit: Unit; tone: "wet" | "neutral" }) {
  if (!c) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">
          <Delta value={c.delta} unit={unit.word} digits={unit === MPH ? 0 : 1} flatBelow={unit === MPH ? 0.5 : 0.02} tone={tone} />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Same {overlap} days in yesterday's briefing: {unit.fmt(c.prev)} {unit.word} → {unit.fmt(c.now)} {unit.word}
      </TooltipContent>
    </Tooltip>
  )
}

export type ModelRows = { model: string; regions: Record<string, N> }[]
export type RegionPanel = { key: number; label: string; nModels: number; summary: SummaryRow[]; rows: ModelRows }

/** Each window as a column: the region headline, then each model's value as a dumbbell (one dot
 *  per region). Phones get one window at a time. */
export function RegionModelsCard({ data, title, description, panels, unit, byModel, note }: {
  data: Briefing; title: string; description: React.ReactNode; panels: RegionPanel[]; unit: Unit; byModel: string; note: React.ReactNode
}) {
  const [win, setWin] = React.useState(String(panels[Math.min(1, panels.length - 1)]?.key))
  if (!panels.length) return null
  const info: Record<string, { tier: Tier; source: string }> = Object.fromEntries(data.models.map((m) => [m.label, { tier: m.tier, source: m.source }]))
  const order = data.models.map((m) => m.label).filter((m) => panels.some((p) => p.rows.some((r) => r.model === m)))
  const ROW = 30
  const labels = (
    <div>
      {order.map((m) => (
        <div key={m} className="flex items-center text-[13px]" style={{ height: ROW }}>
          <ModelName label={m} tier={info[m]?.tier ?? "global"} source={info[m]?.source ?? "grib"} />
        </div>
      ))}
    </div>
  )
  const heading = <p className="text-[13px] font-medium">By model <span className="font-normal text-muted-foreground">· {byModel}</span></p>
  const sel = panels.find((p) => String(p.key) === win) ?? panels[0]
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* wide: every window side by side */}
        <div className="grid gap-x-6 max-md:hidden" style={{ gridTemplateColumns: `170px repeat(${panels.length}, minmax(0, 1fr))` }}>
          <div />
          {panels.map((p) => (
            <div key={p.key} className="flex items-baseline justify-between gap-2 border-b pb-2">
              <span className="text-sm font-semibold">{p.label}</span>
              <span className="text-xs text-muted-foreground">{p.nModels} models</span>
            </div>
          ))}
          <div />
          {panels.map((p) => <div key={p.key} className="pt-3"><RegionSummary rows={p.summary} unit={unit} /></div>)}
          <div className="col-span-full mt-5 mb-2">{heading}</div>
          {labels}
          {panels.map((p) => <DumbbellPanel key={p.key} rows={p.rows} order={order} regions={data.regions} row={ROW} label={p.label} unit={unit} />)}
        </div>
        {/* narrow: one window at a time */}
        <div className="space-y-4 md:hidden">
          <Tabs value={String(sel.key)} onValueChange={setWin}>
            <TabsList>{panels.map((p) => <TabsTrigger key={p.key} value={String(p.key)}>{p.label.replace("Next ", "")}</TabsTrigger>)}</TabsList>
          </Tabs>
          <RegionSummary rows={sel.summary} unit={unit} />
          {heading}
          <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3">
            {labels}
            <DumbbellPanel rows={sel.rows} order={order} regions={data.regions} row={ROW} label={sel.label} unit={unit} />
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  )
}

/** Precipitation totals for each region and window, and each model's. */
export function RegionTotals({ data }: { data: Briefing }) {
  const chg = data.change?.windows[0]
  const panels: RegionPanel[] = data.totals.map((t) => {
    const w = data.windows.find((x) => x.days === t.days)
    const norm = data.normals?.windows.find((x) => x.days === t.days)
    const c = data.change?.windows.find((x) => x.days === t.days)
    return {
      key: t.days, label: t.label, nModels: w?.regions[0]?.n ?? 0,
      summary: (w?.regions ?? []).map((r) => ({
        rid: r.rid, name: r.region, median: r.median, lo: r.lo, hi: r.hi, scale: w!.scale,
        left: <PctNormal pct={norm?.regions[r.rid]?.pct} />,
        right: c && <ChangeNote c={c.regions[r.rid]} overlap={c.overlapDays} unit={INCHES} tone="wet" />,
      })),
      rows: t.rows.map((r) => ({ model: r.model, regions: r.regions })),
    }
  })
  return (
    <RegionModelsCard data={data} title="Region totals" unit={INCHES} panels={panels}
      description="The median across models for each region and window, with the range across models, the share of normal and the change since yesterday; below, each model's own total."
      byModel="average of the region's forecast locations"
      note={<>Range bars span the models, with the median marked.{chg && " Changes compare the same days in yesterday's briefing."}{data.meta.hasSupplement && " * from Open-Meteo; all other models are read from GRIB."} A model appears only in windows it fully covers.</>} />
  )
}

function DumbbellPanel({ rows: list, order, regions, row: ROW, label, unit }: {
  rows: ModelRows; order: string[]; regions: Briefing["regions"]; row: number; label: string; unit: Unit
}) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const PAD = 8
  const rows = Object.fromEntries(list.map((r) => [r.model, r]))
  const vals = list.flatMap((r) => Object.values(r.regions).filter((v): v is number => v != null))
  const vmax = niceMax(Math.max(0.1, ...vals))
  const vmin = unit.zero || !vals.length ? 0 : Math.max(0, Math.floor((Math.min(...vals) - 2) / 10) * 10)
  const x = (v: number) => PAD + ((W - 2 * PAD) * (v - vmin)) / (vmax - vmin)
  const H = order.length * ROW
  const ticks = [vmin, (vmin + vmax) / 2, vmax]
  return (
    <div ref={ref} className="min-w-0">
      <svg width={W} height={H + 22} className="block overflow-visible" role="img" aria-label={`${label} by model`}>
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={x(tk)} x2={x(tk)} y1={0} y2={H} stroke="var(--border)" />
            <text x={x(tk)} y={H + 16} textAnchor="middle" className="fill-muted-foreground text-[11px]">
              {tk}{tk === vmax ? ` ${unit.word}` : ""}
            </text>
          </g>
        ))}
        {order.map((m, i) => {
          const r = rows[m]
          const cy = i * ROW + ROW / 2
          if (!r) return <line key={m} x1={PAD} x2={W - PAD} y1={cy} y2={cy} stroke="var(--border)" strokeDasharray="2 4" />
          const vs = regions.map((reg) => r.regions[reg.id]).filter((v): v is number => v != null)
          return (
            <g key={m}>
              {vs.length > 1 && <line x1={x(Math.min(...vs))} x2={x(Math.max(...vs))} y1={cy} y2={cy} stroke="#c3c7ce" strokeWidth={2} />}
              {regions.map((reg) => {
                const v = r.regions[reg.id]
                if (v == null) return null
                return (
                  <Tooltip key={reg.id}>
                    <TooltipTrigger asChild>
                      <circle cx={x(v)} cy={cy} r={5.5} fill={REGION_VAR[reg.id]} stroke="white" strokeWidth={2} className="cursor-default" />
                    </TooltipTrigger>
                    <TooltipContent>{m}, {reg.name}: {unit.tip(v)} {unit.word}</TooltipContent>
                  </Tooltip>
                )
              })}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** Model × location table with a window switch; cells shaded by amount. */
export function ByLocation({ data, switcher }: { data: Briefing; switcher?: React.ReactNode }) {
  const [win, setWin] = React.useState(String(data.totals[data.totals.length - 1].days))
  const [mode, setMode] = React.useState<"in" | "pct">("in")
  const t = data.totals.find((x) => String(x.days) === win)!
  const pts = data.points.map((p) => p.name)
  const normal = data.normals?.windows.find((x) => String(x.days) === win)?.points
  const chg = data.change?.windows.find((x) => String(x.days) === win)
  const showPct = mode === "pct" && !!normal
  const value = (v: N, p: string) => (showPct ? (v == null || !normal![p]?.normal ? null : (100 * v) / normal![p].normal) : v)
  const vals = t.rows.flatMap((r) => pts.map((p) => r.points[p] ?? 0))
  const max = Math.max(0.1, ...vals) * 0.95
  const meds = pts.map((p) => median(t.rows.map((r) => r.points[p])))
  const models = Object.fromEntries(data.models.map((m) => [m.label, m]))
  const ens = data.ensembles.filter((e) => e.dates.length >= t.days)
  const ensPts = pts.filter((p) => ens.some((e) => e.points[p]))
  const cell = (v: N, p: string) => {
    const x = value(v, p)
    return { style: showPct ? pctCell(x) : blueCell(x, max), text: x == null ? "–" : showPct ? `${Math.round(x)}` : inch(x) }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>By location</CardTitle>
        <CardDescription>
          {showPct ? "Each model's total as a percent of the 1991 – 2020 normal for the same days." : "Totals in inches."} The
          Median row is the median across models{chg ? "; the row below it is the change in that median since yesterday" : ""}.
          {ens.length > 0 && <> Hover an ensemble median for the 10th – 90th percentile range{ensPts.length < pts.length ? ` (ensembles are computed for ${ensPts.join(", ")})` : ""}.</>}
        </CardDescription>
        <CardAction className="flex flex-wrap justify-start gap-2 @xl/card-header:justify-end">
          {switcher}
          {data.normals && (
            <Tabs value={mode} onValueChange={(v) => setMode(v as "in" | "pct")}>
              <TabsList>
                <TabsTrigger value="in">Inches</TabsTrigger>
                <TabsTrigger value="pct">% of normal</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          <Tabs value={win} onValueChange={setWin}>
            <TabsList>
              {data.totals.map((x) => <TabsTrigger key={x.days} value={String(x.days)}>{x.label.replace("Next ", "")}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table className="border-separate border-spacing-[2px] text-[12.5px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="sticky left-0 z-10 bg-card">Model</TableHead>
              {pts.map((p) => (
                <TableHead key={p} className="h-auto px-1 pb-2 align-bottom text-[11.5px] font-normal">
                  <span className="block max-w-[64px] whitespace-normal leading-tight">{p}</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.rows.map((r) => (
              <TableRow key={r.model} className="hover:bg-transparent border-0">
                <TableCell className="sticky left-0 z-10 bg-card py-1 pr-3">
                  <ModelName label={r.model} tier={models[r.model].tier} source={r.source} />
                </TableCell>
                {pts.map((p) => {
                  const c = cell(r.points[p], p)
                  return <TableCell key={p} className="rounded-[3px] px-1 py-1.5 text-center tabular-nums" style={c.style}>{c.text}</TableCell>
                })}
              </TableRow>
            ))}
            <TableRow className="hover:bg-transparent border-0">
              <TableCell className="sticky left-0 z-10 bg-card py-1 pr-3 font-semibold">Median</TableCell>
              {meds.map((v, i) => {
                const c = cell(v, pts[i])
                return (
                  <TableCell key={i} className="rounded-[3px] px-1 py-1.5 text-center font-semibold tabular-nums outline-2 -outline-offset-2 outline-foreground/70"
                             style={c.style}>{c.text}</TableCell>
                )
              })}
            </TableRow>
            {chg && (
              <TableRow className="hover:bg-transparent border-0">
                <TableCell className="sticky left-0 z-10 bg-card py-1 pr-3 text-muted-foreground">
                  Since yesterday
                  {chg.overlapDays < chg.days && <span className="block text-[11px]">same {chg.overlapDays} days</span>}
                </TableCell>
                {pts.map((p) => {
                  const d = chg.points[p]?.delta
                  return (
                    <TableCell key={p} className="px-0.5 py-1.5 text-center text-[11.5px]">
                      {d == null ? "–" : Math.abs(d) < 0.05 ? <span className="text-muted-foreground">0</span> :
                        <span className={d > 0 ? "text-[var(--wetter)]" : "text-[var(--drier)]"}>{d > 0 ? "+" : "−"}{Math.abs(d).toFixed(1)}</span>}
                    </TableCell>
                  )
                })}
              </TableRow>
            )}
            {ens.length > 0 && (
              <TableRow className="hover:bg-transparent border-0">
                <TableCell colSpan={pts.length + 1} className="sticky left-0 bg-card px-0 pt-3 pb-1 text-xs font-medium text-muted-foreground">Ensemble medians</TableCell>
              </TableRow>
            )}
            {ens.map((e) => (
              <TableRow key={e.label} className="hover:bg-transparent border-0">
                <TableCell className="sticky left-0 z-10 bg-card py-1 pr-3 whitespace-nowrap">
                  {e.label} <span className="text-muted-foreground">({e.members})</span>
                </TableCell>
                {pts.map((p) => {
                  const s = e.points[p]
                  if (!s) return <TableCell key={p} />
                  const k = t.days - 1
                  const c = cell(s.p50[k], p)
                  const lo = value(s.p10[k], p), hi = value(s.p90[k], p)
                  return (
                    <TableCell key={p} className="rounded-[3px] p-0 text-center tabular-nums" style={c.style}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0} className="block cursor-default px-1 py-1.5 outline-none focus-visible:outline-2 focus-visible:outline-ring">{c.text}</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {e.label} at {p}: median {c.text}{showPct ? "%" : " in"}
                          {lo != null && hi != null && <>, 10th – 90th percentile {showPct ? `${Math.round(lo)} – ${Math.round(hi)}%` : `${inch(lo)} – ${inch(hi)} in`}</>}
                        </TooltipContent>
                      </Tooltip>
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

/** Diverging cell colour for percent of normal: brown below, neutral near 100%, teal above. */
const BRBG = ["#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"]
const BRBG_EDGES = [25, 50, 70, 90, 110, 130, 160, 200, 300]
export function pctCell(v: N) {
  if (v == null) return { background: "transparent", color: "var(--muted-foreground)" }
  const i = BRBG_EDGES.findIndex((e) => v < e)
  const k = i === -1 ? BRBG.length - 1 : i
  return { background: BRBG[k], color: contrastTextColor(BRBG[k]) }
}

