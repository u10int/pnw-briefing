import * as React from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DayHead } from "@/components/DayHead"
import { ptDayHour } from "@/lib/format"
import { openLocation } from "@/lib/locationlink"
import { WAVE } from "@/lib/ramps"
import { AlertBadge } from "@/sections/Alerts"
import { rampCell } from "@/sections/DayMatrix"
import type { Alert, Briefing, Buoy, MarineAlert, N, TideGauge, WavePoint } from "@/types"

const AREAS = ["Outer coast", "Strait and Puget Sound", "B.C. waters"]
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
const compass = (d: N) => (d == null ? "" : COMPASS[Math.round(d / 22.5) % 16])
/** "Tue 1:36 PM" from a local wall time ("2026-11-10T13:36"). */
function wall(s: string, withDay = true) {
  const [d, t] = s.split("T")
  const [h, m] = t.split(":").map(Number)
  const day = new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })
  return `${withDay ? `${day} ` : ""}${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`
}
const groupBy = <T extends { area: string }>(xs: T[]) =>
  AREAS.map((a) => [a, xs.filter((x) => x.area === a)] as const).filter(([, v]) => v.length)
const SectionRow = ({ label, span }: { label: string; span: number }) => (
  <TableRow className="border-0 hover:bg-transparent">
    <TableCell colSpan={span} className="border-b border-border/70 px-0 pt-4 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</TableCell>
  </TableRow>
)

// ------------------------------------------------------------------ marine warnings

const COASTAL_EVENTS = /surf|beach|coastal flood|sneaker|rip current|tsunami|lakeshore/i

/** Marine alerts for the Seattle and Portland marine zones, refreshed from api.weather.gov when the
 *  page opens (the briefing's copy until then, or if that fails). */
function useMarineAlerts(data: Briefing): { items: MarineAlert[] | null; live: boolean } {
  const c = data.coast
  const [live, setLive] = React.useState<MarineAlert[] | null>(null)
  React.useEffect(() => {
    if (!c) return
    const ctl = new AbortController()
    fetch("https://api.weather.gov/alerts/active?area=PZ", { signal: ctl.signal, headers: { Accept: "application/geo+json" } })
      .then((r) => r.json())
      .then((js) => setLive((js.features ?? []).flatMap((f: { properties: Record<string, unknown> }) => {
        const a = f.properties
        const zones = (((a.geocode as Record<string, string[]>) ?? {}).UGC ?? []).filter((z) => c.zonePrefixes.some((p) => z.startsWith(p)))
        return zones.length ? [{ id: a.id, event: a.event, severity: a.severity, headline: a.headline, onset: a.onset ?? a.effective,
          ends: a.ends ?? a.expires, areaDesc: a.areaDesc, zones, sender: a.senderName, url: null } as MarineAlert] : []
      })))
      .catch(() => {})
    return () => ctl.abort()
  }, [c])
  return { items: live ?? c?.marineAlerts ?? null, live: live != null }
}

const RANK = (e: string) => (/hurricane/i.test(e) ? 0 : /storm/i.test(e) ? 1 : /gale/i.test(e) ? 2 : /hazardous seas/i.test(e) ? 3 : /warning/i.test(e) ? 4 : /watch/i.test(e) ? 5 : 6)

export function MarineWarningsCard({ data }: { data: Briefing }) {
  const { items, live } = useMarineAlerts(data)
  const coastal: Alert[] = (data.alerts?.items ?? []).filter((a) => COASTAL_EVENTS.test(a.event))
  const marine = [...(items ?? [])].sort((a, b) => RANK(a.event) - RANK(b.event))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Marine and coastal warnings</CardTitle>
        <CardDescription>
          Active NWS marine alerts for the coastal waters, the Strait, the San Juans and Puget Sound (Seattle and Portland's marine zones){live ? ", as of now" : ", as of this briefing"}, then surf, beach hazard and coastal flood alerts for the coast.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!marine.length && !coastal.length ? <p className="text-sm text-muted-foreground">No marine or coastal alerts right now.</p> : (
          <ul className="divide-y divide-border/70 text-sm">
            {[...marine.map((a) => ({ key: a.id, event: a.event, where: a.areaDesc, ends: a.ends, by: a.sender })),
              ...coastal.map((a) => ({ key: a.id, event: a.event, where: a.points.join(", ") || a.areaDesc, ends: a.ends, by: a.sender }))].map((a) => (
              <li key={a.key} className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[220px_1fr]">
                <div><AlertBadge event={a.event} /></div>
                <div className="min-w-0">
                  <p className="text-pretty">{(a.where ?? "").split(";").map((s) => s.trim()).filter(Boolean).join(" · ")}</p>
                  <p className="text-xs text-muted-foreground">{[a.ends && `until ${ptDayHour(a.ends)}`, a.by].filter(Boolean).join(" · ")}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ buoys

function Spark({ xs }: { xs: number[] }) {
  if (xs.length < 2) return null
  const hi = Math.max(...xs, 1), w = 56, h = 18
  const pts = xs.map((x, i) => `${(i / (xs.length - 1)) * w},${h - 1 - (x / hi) * (h - 2)}`).join(" ")
  return <svg width={w} height={h} className="text-muted-foreground" aria-hidden><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
}

export function BuoysCard({ data }: { data: Briefing }) {
  const bs = data.coast?.buoys ?? []
  if (!bs.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Buoys now</CardTitle>
        <CardDescription>The latest reading at each buoy, the highest waves and strongest gust of the last 24 hours, and the waves over that time (left to right).</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table className="w-auto min-w-[640px] border-separate border-spacing-x-0 border-spacing-y-[2px] text-[13px] [&_td]:pr-5 [&_th]:pr-5">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="md:min-w-[260px]">Buoy</TableHead>
              <TableHead className="text-center">Waves</TableHead>
              <TableHead className="text-center">24 h high</TableHead>
              <TableHead>Wind</TableHead>
              <TableHead className="text-right">Water</TableHead>
              <TableHead className="text-right">Last day</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupBy(bs).map(([area, xs]) => (
              <React.Fragment key={area}>
                <SectionRow label={area} span={6} />
                {xs.map((b: Buoy) => (
                  <TableRow key={b.id} className="border-0 hover:bg-transparent">
                    <TableCell className="py-1 pr-3 md:min-w-[260px]">
                      {b.name}
                      <span className="block text-[11px] text-muted-foreground">{b.id} · {ptDayHour(b.time)}</span>
                    </TableCell>
                    <TableCell className="rounded-[3px] px-2 py-1 text-center tabular-nums" style={rampCell(b.wave, WAVE, true)}>
                      {b.wave == null ? "–" : <><span className="font-semibold">{b.wave} ft</span>{b.period != null && <span className="block text-[11px] opacity-80">{b.period} s {compass(b.waveDir)}</span>}</>}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-center tabular-nums">{b.waveMax24 == null ? "–" : `${b.waveMax24} ft`}</TableCell>
                    <TableCell className="py-1 pr-3 tabular-nums">
                      {b.wind == null ? "–" : <>{compass(b.windDir)} {b.wind}{b.gust != null && <span className="text-muted-foreground"> g{b.gust}</span>} mph</>}
                      {b.gustMax24 != null && <span className="block text-[11px] text-muted-foreground">24 h gust {b.gustMax24}</span>}
                    </TableCell>
                    <TableCell className="py-1 text-right tabular-nums">{b.water == null ? "–" : `${b.water}°`}</TableCell>
                    <TableCell className="py-1 text-right"><Spark xs={b.spark} /></TableCell>
                  </TableRow>
                ))}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ wave forecast

const LINE_COLORS = ["#1f5bd6", "#d62d20", "#1e9e4a", "#8e3fb5", "#e08a0b", "#0b7a75", "#6b7280"]

export function WaveForecastCard({ data }: { data: Briefing }) {
  const ws = data.coast?.waves ?? []
  const groups = groupBy(ws)
  const [area, setArea] = React.useState<string>(groups[0]?.[0] ?? AREAS[0])
  if (!ws.length) return null
  const days = [...new Set(ws.flatMap((w) => w.daily.map((d) => d.date)))].sort()
  const shown = ws.filter((w) => w.area === area)
  const keys = shown.map((_, i) => `w${i}`)
  const config: ChartConfig = Object.fromEntries(shown.map((w, i) => [keys[i], { label: w.name, color: LINE_COLORS[i % LINE_COLORS.length] }]))
  const rows = (shown[0]?.hourly.time ?? []).map((t, k) => ({ t, ...Object.fromEntries(shown.map((w, i) => [keys[i], w.hourly.height[k]])) }))
    .filter((_, k) => k % 3 === 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Wave forecast</CardTitle>
        <CardDescription>The highest significant wave height each day, in feet, with its period and direction underneath; the chart shows it through the week.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="overflow-x-auto">
          <Table className="w-auto border-separate border-spacing-[2px] text-[12.5px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky left-0 z-10 bg-card md:min-w-[230px]">Where</TableHead>
                {days.map((d) => <TableHead key={d} className="h-auto w-[60px] px-1 pb-2 text-center align-bottom text-[11.5px]"><DayHead day={d} /></TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map(([a, xs]) => (
                <React.Fragment key={a}>
                  <SectionRow label={a} span={days.length + 1} />
                  {xs.map((w: WavePoint) => (
                    <TableRow key={w.name} className="border-0 hover:bg-transparent">
                      <TableCell className="sticky left-0 z-10 max-w-[150px] bg-card py-1 pr-3 whitespace-normal md:max-w-none md:min-w-[230px] md:whitespace-nowrap">
                        {w.name}
                        {w.near && <button type="button" onClick={() => openLocation(w.near!)} className="block text-left text-[11px] text-muted-foreground hover:underline">near {w.near}</button>}
                      </TableCell>
                      {days.map((d) => {
                        const x = w.daily.find((y) => y.date === d)
                        return (
                          <TableCell key={d} className="rounded-[3px] px-1 py-1 text-center tabular-nums" style={rampCell(x?.max ?? null, WAVE, true)}>
                            {x ? <><span className="font-semibold">{Math.round(x.max)}</span><span className="block text-[10px] leading-tight opacity-80">{x.period != null ? `${Math.round(x.period)}s` : ""} {compass(x.dir)}</span></> : "–"}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
        <div>
          {groups.length > 1 && (
            <Tabs value={area} onValueChange={setArea} className="mb-3">
              <TabsList>{groups.map(([a]) => <TabsTrigger key={a} value={a}>{a}</TabsTrigger>)}</TabsList>
            </Tabs>
          )}
          <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
            <LineChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="t" tickLine={false} axisLine={false} tickMargin={8} ticks={rows.map((r) => r.t).filter((t) => t.endsWith("T00:00"))} interval="preserveStartEnd"
                tickFormatter={(v: string) => new Date(`${v.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" })} />
              <YAxis tickLine={false} axisLine={false} tickMargin={8} width={44} tickFormatter={(v) => `${v} ft`} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => wall(String(v))} />} />
              <ChartLegend content={<ChartLegendContent />} />
              {keys.map((k) => <Line key={k} isAnimationActive={false} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={false} />)}
            </LineChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ tides

/** The flag on a high tide close to flooding: within a foot, or over. */
function TideFlag({ m }: { m: N }) {
  if (m == null || m > 1) return null
  return <Badge variant={m <= 0 ? "likely" : "possible"} className="mt-0.5 px-1.5 py-0 text-[10px]">{m <= 0 ? `${Math.abs(m).toFixed(1)} ft over` : `${m.toFixed(1)} ft below`}</Badge>
}

export function TidesCard({ data }: { data: Briefing }) {
  const ts = data.coast?.tides ?? []
  if (!ts.length) return null
  const days = [...new Set(ts.flatMap((g) => g.highs.map((h) => h.time.slice(0, 10))))].sort().slice(0, 7)
  const top = (g: TideGauge, d: string) => g.highs.filter((h) => h.time.startsWith(d)).sort((a, b) => b.height - a.height)[0]
  const close = ts.flatMap((g) => g.highs.filter((h) => h.margin != null && h.margin <= 1).map((h) => ({ g, h })))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tides and coastal flooding</CardTitle>
        <CardDescription>
          Each day's highest high tide at each gauge (feet above mean lower low water, local time), against the gauge's minor flood level, with the water's current running above or below the tide prediction (a rough storm surge) added on. Tides within a foot of flooding are flagged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {close.length > 0 && (
          <p className="text-sm">
            <span className="font-medium">Closest to flooding: </span>
            {close.sort((a, b) => a.h.margin! - b.h.margin!).slice(0, 3).map(({ g, h }, i) => (
              <span key={g.id + h.time}>{i > 0 && "; "}{g.name} {wall(h.time)}, {h.margin! <= 0 ? `${Math.abs(h.margin!).toFixed(1)} ft over` : `${h.margin!.toFixed(1)} ft below`} minor flood</span>
            ))}
          </p>
        )}
        <div className="overflow-x-auto">
          <Table className="w-auto border-separate border-spacing-x-[2px] border-spacing-y-[2px] text-[12.5px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky left-0 z-10 bg-card md:min-w-[230px]">Gauge</TableHead>
                <TableHead className="px-2 text-right text-[11.5px] font-normal">Flood<span className="block">level</span></TableHead>
                <TableHead className="px-2 text-right text-[11.5px] font-normal">Running<span className="block">vs tide</span></TableHead>
                {days.map((d) => <TableHead key={d} className="h-auto w-[72px] px-1 pb-2 text-center align-bottom text-[11.5px]"><DayHead day={d} /></TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupBy(ts).map(([a, xs]) => (
                <React.Fragment key={a}>
                  <SectionRow label={a} span={days.length + 3} />
                  {xs.map((g: TideGauge) => (
                    <TableRow key={g.id} className="border-0 hover:bg-transparent">
                      <TableCell className="sticky left-0 z-10 max-w-[160px] bg-card py-1 pr-3 whitespace-normal md:max-w-none md:min-w-[230px] md:whitespace-nowrap">
                        {g.name}
                        {g.near && <button type="button" onClick={() => openLocation(g.near!)} className="block text-left text-[11px] text-muted-foreground hover:underline">near {g.near}</button>}
                      </TableCell>
                      <TableCell className="px-2 py-1 text-right tabular-nums text-muted-foreground">{g.flood == null ? "–" : g.flood.toFixed(1)}</TableCell>
                      <TableCell className="px-2 py-1 text-right tabular-nums">{g.surge == null ? "–" : Math.abs(g.surge) < 0.05 ? "0.0" : `${g.surge > 0 ? "+" : "−"}${Math.abs(g.surge).toFixed(1)}`}</TableCell>
                      {days.map((d) => {
                        const h = top(g, d)
                        return (
                          <TableCell key={d} className="rounded-[3px] bg-muted/50 px-1 py-1 text-center tabular-nums">
                            {h ? <><span className="font-semibold">{h.height.toFixed(1)}</span><span className="block text-[10px] leading-tight text-muted-foreground">{wall(h.time, false)}</span><TideFlag m={h.margin} /></> : "–"}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          Flood levels are NOAA's minor (nuisance) flooding thresholds; a dash means the gauge has none. The surge is today's: storms can raise it well beyond that by the time a high tide arrives.
        </p>
      </CardContent>
    </Card>
  )
}

export function CoastSection({ data }: { data: Briefing }) {
  if (!data.coast) return <p className="text-sm text-muted-foreground">Coast and marine data aren't in this briefing.</p>
  return (
    <div className="space-y-6">
      <MarineWarningsCard data={data} />
      <BuoysCard data={data} />
      <WaveForecastCard data={data} />
      <TidesCard data={data} />
      <p className="text-xs text-muted-foreground">Sources: {data.coast.source}.</p>
    </div>
  )
}

/** Biggest number for the overview: the highest waves forecast off the outer coast, and how close
 *  the week's tides come to flooding. */
export function coastHeadline(data: Briefing) {
  const c = data.coast
  if (!c) return null
  const wave = c.waves.filter((w) => w.area === "Outer coast").flatMap((w) => w.daily.map((d) => ({ w, d })))
    .sort((a, b) => b.d.max - a.d.max)[0]
  const tide = c.tides.flatMap((g) => g.highs.filter((h) => h.margin != null).map((h) => ({ g, h })))
    .sort((a, b) => a.h.margin! - b.h.margin!)[0]
  const alerts = (c.marineAlerts ?? []).map((a) => a.event)
  return { wave, tide, alerts }
}

