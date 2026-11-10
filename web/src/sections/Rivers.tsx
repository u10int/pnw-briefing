import * as React from "react"
import { ChevronRight, ExternalLink } from "lucide-react"
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { contrastTextColor } from "@/lib/contrast"
import { issuedLabel, ptDay, ptDayHour } from "@/lib/format"
import { FLOOD_COLORS, FLOOD_LABELS } from "@/lib/ramps"
import type { Briefing, RiverGauge } from "@/types"

const CATS = ["action", "minor", "moderate", "major"] as const
const ft = (v: number | null | undefined) => (v == null ? "–" : `${v.toFixed(1)} ft`)
/** The stage that starts minor flooding (action stage when a gauge has no minor). */
const floodStage = (g: RiverGauge) => g.categories.minor ?? g.categories.action ?? null
/** Rank for sorting: the crest's category, then how close the crest gets to flood stage. */
const severity = (g: RiverGauge) => (g.crest.level ?? 0) * 10 + (floodStage(g) ? g.crest.stage / floodStage(g)! : 0)

function Level({ level, small }: { level: number | null; small?: boolean }) {
  const l = level ?? 0
  return (
    <span className={`inline-flex items-center rounded px-1.5 font-medium whitespace-nowrap ${small ? "text-[11px] leading-4" : "text-xs leading-5"}`}
      style={l ? { background: FLOOD_COLORS[l], color: contrastTextColor(FLOOD_COLORS[l]) } : { color: "var(--muted-foreground)" }}>
      {FLOOD_LABELS[l]}
    </span>
  )
}

/** Observed (gray) and forecast (the crest's category colour, dashed) on one small chart, with
 *  the flood stage as a line, scaled so flood stage is always in view. */
function Spark({ g }: { g: RiverGauge }) {
  const W = 140, H = 34
  const all = [...g.observed, ...g.forecast]
  if (all.length < 2) return null
  const ts = all.map(([t]) => Date.parse(t)), vs = all.map(([, v]) => v)
  const fs = floodStage(g)
  const lo = Math.min(...vs), hi = Math.max(...vs, fs ?? -Infinity)
  const t0 = Math.min(...ts), t1 = Math.max(...ts)
  const x = (t: string) => ((Date.parse(t) - t0) / (t1 - t0 || 1)) * W
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)
  const path = (pts: [string, number][]) => pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("")
  const color = FLOOD_COLORS[g.crest.level ?? 0]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[34px] w-[140px]" aria-hidden>
      {fs != null && <line x1={0} x2={W} y1={y(fs)} y2={y(fs)} stroke={FLOOD_COLORS[2]} strokeDasharray="3 2" strokeWidth={1} opacity={0.8} />}
      {g.observed.length > 1 && <path d={path(g.observed)} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.6} />}
      <path d={path(g.forecast)} fill="none" stroke={(g.crest.level ?? 0) ? color : "var(--wetter)"} strokeWidth={1.8} strokeDasharray="4 2" />
    </svg>
  )
}

const chartConfig = { obs: { label: "Observed", color: "var(--muted-foreground)" }, fc: { label: "Forecast", color: "var(--wetter)" } } satisfies ChartConfig

/** The full hydrograph: observed and forecast stage over the flood category bands. */
function Hydrograph({ g }: { g: RiverGauge }) {
  const rows = [
    ...g.observed.map(([t, v]) => ({ t: Date.parse(t), obs: v as number | null, fc: null as number | null })),
    ...g.forecast.map(([t, v]) => ({ t: Date.parse(t), obs: null, fc: v })),
  ].sort((a, b) => a.t - b.t)
  // join the two lines where the forecast starts
  const lastObs = g.observed[g.observed.length - 1]
  if (lastObs) rows.push({ t: Date.parse(lastObs[0]), obs: null, fc: lastObs[1] })
  rows.sort((a, b) => a.t - b.t)
  const vs = rows.flatMap((r) => [r.obs, r.fc]).filter((v): v is number => v != null)
  const top = Math.max(...vs, (g.categories.moderate ?? g.categories.minor ?? -Infinity) + 0.5)
  const bot = Math.min(...vs) - 0.5
  const bands = CATS.map((c, k) => ({ c, k: k + 1, from: g.categories[c], to: CATS.slice(k + 1).map((n) => g.categories[n]).find((x) => x != null) ?? top + 50 }))
    .filter((b) => b.from != null)
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
      <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        {bands.map((b) => <ReferenceArea key={b.c} y1={b.from} y2={Math.min(b.to, top)} fill={FLOOD_COLORS[b.k]} fillOpacity={0.12} ifOverflow="hidden" />)}
        {bands.map((b) => <ReferenceLine key={`l${b.c}`} y={b.from} stroke={FLOOD_COLORS[b.k]} strokeDasharray="4 3"
          label={{ value: `${FLOOD_LABELS[b.k].replace(" stage", "")} ${b.from}`, position: "insideTopLeft", fontSize: 10, fill: FLOOD_COLORS[b.k] }} />)}
        <ReferenceLine x={Date.now()} stroke="var(--foreground)" strokeOpacity={0.4} />
        <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={8}
          tickFormatter={(t) => ptDay(t)} minTickGap={40} />
        <YAxis domain={[Math.floor(bot), Math.ceil(top)]} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v} ft`} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => ptDayHour(p?.[0]?.payload?.t ?? 0)} formatter={(v, n) => (
          <span className="flex w-full justify-between gap-3"><span className="text-muted-foreground">{n === "obs" ? "Observed" : "Forecast"}</span><span className="font-medium tabular-nums">{Number(v).toFixed(2)} ft</span></span>)} />} />
        <Line dataKey="obs" stroke="var(--color-obs)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        <Line dataKey="fc" stroke={(g.crest.level ?? 0) ? FLOOD_COLORS[g.crest.level!] : "var(--color-fc)"} strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  )
}

/** River gauges with official forecasts (NWRFC), worst crest first: where each stands now, the
 *  crest it's forecast to reach and when, against its flood stages. A row opens its hydrograph. */
export function RiversCard({ data }: { data: Briefing }) {
  const gs = React.useMemo(() => [...(data.rivers?.gauges ?? [])].sort((a, b) => severity(b) - severity(a)), [data])
  const [all, setAll] = React.useState(false)
  const [open, setOpen] = React.useState<string | null>(null)
  if (!gs.length) return null
  const counts = [4, 3, 2, 1].map((l) => [l, gs.filter((g) => (g.crest.level ?? 0) === l).length] as const).filter(([, n]) => n)
  const shown = all ? gs : gs.slice(0, 12)
  const issued = gs.map((g) => g.issued).filter(Boolean).sort().pop()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rivers</CardTitle>
        <CardDescription>
          Official river forecasts from the Northwest River Forecast Center at {gs.length} gauges west of the Cascades, worst forecast crest first.
          Each row shows the stage now, the forecast crest and when, and how it compares with flood stage; click a row for its hydrograph.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          {counts.length ? counts.map(([l, n], i) => (
            <span key={l}>{i > 0 && " · "}<span className="font-semibold tabular-nums">{n}</span> forecast to reach {FLOOD_LABELS[l].toLowerCase()}</span>
          )) : <span className="text-muted-foreground">No gauge is forecast to reach action stage{issued ? ` (forecasts issued ${issuedLabel(issued)})` : ""}.</span>}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Gauge</th>
                <th className="px-3 py-2 text-right font-medium">Now</th>
                <th className="px-3 py-2 text-right font-medium">Forecast crest</th>
                <th className="px-3 py-2 text-right font-medium">vs flood stage</th>
                <th className="py-2 pl-3 font-medium">Past 3 days and forecast</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const fs = floodStage(g)
                const diff = fs != null ? g.crest.stage - fs : null
                const isOpen = open === g.lid
                return (
                  <React.Fragment key={g.lid}>
                    <tr className="cursor-pointer border-b border-border/60 hover:bg-muted/40" onClick={() => setOpen(isOpen ? null : g.lid)} aria-expanded={isOpen}>
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-1.5">
                          <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden />
                          <span className="font-medium">{g.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {ft(g.now.stage)}{(g.now.level ?? 0) > 0 && <span className="ml-1.5"><Level level={g.now.level} small /></span>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <span className="tabular-nums">{ft(g.crest.stage)}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground">{ptDayHour(g.crest.time)}</span>
                        <span className="ml-1.5"><Level level={g.crest.level} small /></span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs whitespace-nowrap tabular-nums">
                        {diff == null ? "–" : (
                          <Tooltip>
                            <TooltipTrigger asChild><span className={diff >= 0 ? "font-semibold" : "text-muted-foreground"}>{Math.abs(diff).toFixed(1)} ft {diff >= 0 ? "above" : "below"}</span></TooltipTrigger>
                            <TooltipContent>
                              {CATS.filter((c) => g.categories[c] != null).map((c) => <p key={c}>{FLOOD_LABELS[CATS.indexOf(c) + 1]}: {g.categories[c]} ft</p>)}
                              {g.record && <p className="pt-1 opacity-80">Record {g.record.stage.toFixed(1)} ft, {new Date(g.record.time).getFullYear()}</p>}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </td>
                      <td className="py-1 pl-3"><Spark g={g} /></td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-border/60">
                        <td colSpan={5} className="py-3">
                          <Hydrograph g={g} />
                          <p className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                            <span>Gray: observed. Dashed: NWRFC forecast{g.issued ? `, issued ${issuedLabel(g.issued)}` : ""}. Bands: flood categories.</span>
                            <a href={g.url} target="_blank" rel="noopener" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                              Gauge on water.noaa.gov<ExternalLink className="size-3" aria-hidden />
                            </a>
                          </p>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {gs.length > 12 && (
          <Button variant="ghost" size="sm" onClick={() => setAll((x) => !x)}>{all ? "Show the worst 12" : `Show all ${gs.length} gauges`}</Button>
        )}
      </CardContent>
    </Card>
  )
}
