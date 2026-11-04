import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { blueCell, inch, median } from "@/lib/format"
import type { Briefing, N, Tier } from "@/types"

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

/** Dumbbells: one row per model, one panel per window, W WA and NW OR joined by a line. */
export function RegionTotals({ data }: { data: Briefing }) {
  const order = data.models.map((m) => m.label)
  const tiers = Object.fromEntries(data.models.map((m) => [m.label, m]))
  const ROW = 30
  return (
    <Card>
      <CardHeader>
        <CardTitle>Region totals for each window</CardTitle>
        <CardDescription>
          Average of the forecast locations in each region. A model appears only in windows it fully covers.
        </CardDescription>
        <CardAction className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {data.regions.map((r) => (
            <span key={r.id} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: REGION_VAR[r.id] }} />{r.name}
            </span>
          ))}
        </CardAction>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <div className="grid min-w-[880px] grid-cols-[180px_repeat(3,minmax(0,1fr))] gap-x-6">
          <div />
          {data.totals.map((t) => <div key={t.days} className="pb-2 text-sm font-medium">{t.label}</div>)}
          <div>
            {order.map((m) => (
              <div key={m} className="flex items-center text-[13px]" style={{ height: ROW }}>
                <ModelName label={m} tier={tiers[m].tier} source={tiers[m].source} />
              </div>
            ))}
          </div>
          {data.totals.map((t) => (
            <DumbbellPanel key={t.days} t={t} order={order} regions={data.regions} row={ROW} />
          ))}
        </div>
        {data.meta.hasSupplement && (
          <p className="mt-3 text-xs text-muted-foreground">* from Open-Meteo; all other models are read from GRIB.</p>
        )}
      </CardContent>
    </Card>
  )
}

function DumbbellPanel({ t, order, regions, row: ROW }: {
  t: Briefing["totals"][number]; order: string[]; regions: Briefing["regions"]; row: number
}) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const PAD = 8
  const rows = Object.fromEntries(t.rows.map((r) => [r.model, r]))
  const vmax = niceMax(Math.max(0.1, ...t.rows.flatMap((r) => Object.values(r.regions).map((v) => v ?? 0))))
  const x = (v: number) => PAD + ((W - 2 * PAD) * v) / vmax
  const H = order.length * ROW
  return (
    <div ref={ref} className="min-w-0">
      <svg width={W} height={H + 22} className="block overflow-visible" role="img" aria-label={`${t.label} totals by model`}>
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
  const cell = (v: N, p: string) => {
    const x = value(v, p)
    return { style: showPct ? pctCell(x) : blueCell(x, max), text: x == null ? "–" : showPct ? `${Math.round(x)}` : inch(x) }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>By location</CardTitle>
        <CardDescription>
          {showPct ? "Each model's total as a percent of the 1991–2020 normal for the same days." : "Totals in inches."} The
          Median row is the median across models{chg ? "; the row below it is the change in that median since yesterday" : ""}.
        </CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-2">
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
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/** Diverging cell colour for percent of normal: brown below, neutral near 100%, teal above. */
const BRBG = ["#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"]
const BRBG_EDGES = [25, 50, 70, 90, 110, 130, 160, 200, 300]
function pctCell(v: N) {
  if (v == null) return { background: "transparent", color: "var(--muted-foreground)" }
  const i = BRBG_EDGES.findIndex((e) => v < e)
  const k = i === -1 ? BRBG.length - 1 : i
  return { background: BRBG[k], color: k <= 1 || k >= 7 ? "#fff" : "var(--foreground)" }
}

export function GribAreaMeans({ data }: { data: Briefing }) {
  if (!data.gribAreaMeans.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Gridded area means</CardTitle>
        <CardDescription>Mean over every grid cell inside each region, from the GRIB fields (in).</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead colSpan={2} />
              {data.windows.map((w) => (
                <TableHead key={w.days} colSpan={data.regions.length} className="border-l text-center font-semibold text-foreground">
                  {w.label}
                </TableHead>
              ))}
            </TableRow>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Run</TableHead>
              {data.windows.flatMap((w) => data.regions.map((r, i) => (
                <TableHead key={`${w.days}-${r.id}`} className={`text-right ${i === 0 ? "border-l" : ""}`}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: REGION_VAR[r.id] }} />{r.short}
                  </span>
                </TableHead>
              )))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.gribAreaMeans.map((row) => (
              <TableRow key={row.model}>
                <TableCell><ModelName label={row.model} tier={row.tier} source="grib" /></TableCell>
                <TableCell className="text-muted-foreground tabular-nums">{row.run}</TableCell>
                {row.windows.flatMap((w, wi) => data.regions.map((r, i) => (
                  <TableCell key={`${wi}-${r.id}`} className={`text-right tabular-nums ${i === 0 ? "border-l" : ""} ${w[r.id] == null ? "text-muted-foreground" : ""}`}>
                    {w[r.id] == null ? "–" : w[r.id]!.toFixed(2)}
                  </TableCell>
                )))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
