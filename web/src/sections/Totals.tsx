import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { blueCell, inch, median } from "@/lib/format"
import type { Briefing, N, Tier, Window } from "@/types"
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
  return [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50].find((s) => s >= v * 1.05) ?? Math.ceil(v)
}

function ModelName({ label, tier, source }: { label: string; tier: Tier; source: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {label}{source === "open-meteo" ? " *" : ""}
      <Badge variant={tier} className="px-1.5 py-0 text-[10.5px]">{tier}</Badge>
    </span>
  )
}

function RangeBar({ lo, hi, median, scale, color }: { lo: number; hi: number; median: number; scale: number; color: string }) {
  const pct = (v: number) => `${Math.min(100, (100 * v) / scale)}%`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative mt-1.5 h-4 w-full cursor-default" aria-label={`Range ${lo.toFixed(1)} to ${hi.toFixed(1)} in`}>
          <div className="absolute top-[7px] h-0.5 w-full rounded bg-border" />
          <div className="absolute top-1 h-2 rounded-full opacity-30" style={{ left: pct(lo), width: `max(4px, ${pct(hi - lo)})`, background: color }} />
          <div className="absolute top-0 h-4 w-[3px] -translate-x-1/2 rounded-sm" style={{ left: pct(median), background: color }} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Models range {lo.toFixed(1)} – {hi.toFixed(1)} in; median {median.toFixed(1)} in
      </TooltipContent>
    </Tooltip>
  )
}

/** One window's headline: each region's model median, the range across models, its share of
 *  normal and the change since yesterday. */
function WindowSummary({ w, data }: { w: Window; data: Briefing }) {
  const norm = data.normals?.windows.find((x) => x.days === w.days)
  const chg = data.change?.windows.find((x) => x.days === w.days)
  return (
    <div className="space-y-3">
      {w.regions.map((r) => (
        <div key={r.rid}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: REGION_VAR[r.rid] }} />
              <span className="truncate">{r.region}</span>
            </span>
            <span className="text-2xl font-semibold tracking-tight tabular-nums">
              {r.median.toFixed(1)}<span className="ml-0.5 text-sm font-medium text-muted-foreground">in</span>
            </span>
          </div>
          <RangeBar lo={r.lo} hi={r.hi} median={r.median} scale={w.scale} color={REGION_VAR[r.rid]} />
          {(norm || chg) && (
            <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs">
              <PctNormal pct={norm?.regions[r.rid]?.pct} />
              {chg?.regions[r.rid] && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default"><Delta value={chg.regions[r.rid].delta} /></span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Same {chg.overlapDays} days in yesterday's briefing: {chg.regions[r.rid].prev.toFixed(1)} in → {chg.regions[r.rid].now.toFixed(1)} in
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

type Panel = { t: Briefing["totals"][number]; w: Window | undefined; rows: { model: string; regions: Record<string, N> }[] }

/** Region totals for every window in one place: the headline per window (median, model range,
 *  share of normal, change since yesterday), then each model's total as a dumbbell, averaged
 *  over the region's forecast locations. */
export function RegionTotals({ data }: { data: Briefing }) {
  const [win, setWin] = React.useState(String(data.totals[Math.min(1, data.totals.length - 1)].days))
  const info: Record<string, { tier: Tier; source: string }> = Object.fromEntries(data.models.map((m) => [m.label, { tier: m.tier, source: m.source }]))
  const panels: Panel[] = data.totals.map((t) => ({
    t, w: data.windows.find((w) => w.days === t.days),
    rows: t.rows.map((r) => ({ model: r.model, regions: r.regions })),
  }))
  const order = data.models.map((m) => m.label).filter((m) => panels.some((p) => p.rows.some((r) => r.model === m)))
  const ROW = 30
  const chg = data.change?.windows[0]
  const labels = (
    <div>
      {order.map((m) => (
        <div key={m} className="flex items-center text-[13px]" style={{ height: ROW }}>
          <ModelName label={m} tier={info[m]?.tier ?? "global"} source={info[m]?.source ?? "grib"} />
        </div>
      ))}
    </div>
  )
  const byModel = (
    <p className="text-[13px] font-medium">
      By model <span className="font-normal text-muted-foreground">· average of the region's forecast locations</span>
    </p>
  )
  const sel = panels.find((p) => String(p.t.days) === win) ?? panels[0]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Region totals</CardTitle>
        <CardDescription>
          The median across models for each region and window, with the range across models, the share of normal and the change since yesterday; below, each model's own total.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* wide: every window side by side */}
        <div className="grid grid-cols-[170px_repeat(3,minmax(0,1fr))] gap-x-6 max-md:hidden">
          <div />
          {panels.map(({ t, w }) => (
            <div key={t.days} className="flex items-baseline justify-between gap-2 border-b pb-2">
              <span className="text-sm font-semibold">{t.label}</span>
              <span className="text-xs text-muted-foreground">{w?.regions[0]?.n ?? 0} models</span>
            </div>
          ))}
          <div />
          {panels.map(({ t, w }) => <div key={t.days} className="pt-3">{w && <WindowSummary w={w} data={data} />}</div>)}
          <div className="col-span-full mt-5 mb-2">{byModel}</div>
          {labels}
          {panels.map((p) => <DumbbellPanel key={p.t.days} rows={p.rows} order={order} regions={data.regions} row={ROW} label={p.t.label} />)}
        </div>
        {/* narrow: one window at a time */}
        <div className="space-y-4 md:hidden">
          <Tabs value={win} onValueChange={setWin}>
            <TabsList>{panels.map(({ t }) => <TabsTrigger key={t.days} value={String(t.days)}>{t.label.replace("Next ", "")}</TabsTrigger>)}</TabsList>
          </Tabs>
          {sel.w && <WindowSummary w={sel.w} data={data} />}
          {byModel}
          <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3">
            {labels}
            <DumbbellPanel rows={sel.rows} order={order} regions={data.regions} row={ROW} label={sel.t.label} />
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Range bars span the models, with the median marked.
          {chg && <> Changes compare the same days in yesterday's briefing.</>}
          {data.meta.hasSupplement && <> * from Open-Meteo; all other models are read from GRIB.</>}
          {" "}A model appears only in windows it fully covers.
        </p>
      </CardContent>
    </Card>
  )
}

function DumbbellPanel({ rows: list, order, regions, row: ROW, label }: {
  rows: Panel["rows"]; order: string[]; regions: Briefing["regions"]; row: number; label: string
}) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const PAD = 8
  const rows = Object.fromEntries(list.map((r) => [r.model, r]))
  const vmax = niceMax(Math.max(0.1, ...list.flatMap((r) => Object.values(r.regions).map((v) => v ?? 0))))
  const x = (v: number) => PAD + ((W - 2 * PAD) * v) / vmax
  const H = order.length * ROW
  return (
    <div ref={ref} className="min-w-0">
      <svg width={W} height={H + 22} className="block overflow-visible" role="img" aria-label={`${label} totals by model`}>
        {[0, vmax / 2, vmax].map((tk) => (
          <g key={tk}>
            <line x1={x(tk)} x2={x(tk)} y1={0} y2={H} stroke="var(--border)" />
            <text x={x(tk)} y={H + 16} textAnchor="middle" className="fill-muted-foreground text-[11px]">
              {tk}{tk === vmax ? " in" : ""}
            </text>
          </g>
        ))}
        {order.map((m, i) => {
          const r = rows[m]
          const cy = i * ROW + ROW / 2
          if (!r) return <line key={m} x1={PAD} x2={W - PAD} y1={cy} y2={cy} stroke="var(--border)" strokeDasharray="2 4" />
          const a = r.regions.wwa, b = r.regions.nwor
          return (
            <g key={m}>
              {a != null && b != null && <line x1={x(a)} x2={x(b)} y1={cy} y2={cy} stroke="#c3c7ce" strokeWidth={2} />}
              {regions.map((reg) => {
                const v = r.regions[reg.id]
                if (v == null) return null
                return (
                  <Tooltip key={reg.id}>
                    <TooltipTrigger asChild>
                      <circle cx={x(v)} cy={cy} r={5.5} fill={REGION_VAR[reg.id]} stroke="white" strokeWidth={2} className="cursor-default" />
                    </TooltipTrigger>
                    <TooltipContent>{m}, {reg.name}: {v.toFixed(2)} in</TooltipContent>
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
export function ByLocation({ data }: { data: Briefing }) {
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
  const ensPts = data.points.filter((p) => p.plume).map((p) => p.name)
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
          {ens.length > 0 && <> Ensemble medians are computed for {ensPts.join(", ")}; hover one for the 10th – 90th percentile range.</>}
        </CardDescription>
        <CardAction className="flex flex-wrap justify-start gap-2 @xl/card-header:justify-end">
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

