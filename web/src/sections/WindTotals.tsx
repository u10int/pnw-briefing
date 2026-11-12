import * as React from "react"

import { Takeaway } from "@/components/Takeaway"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GUST, WIND } from "@/lib/ramps"
import { median } from "@/lib/format"
import { rampCell } from "@/sections/DayMatrix"
import { ChangeNote, ModelName, MPH, type RegionPanel, RegionModelsCard } from "@/sections/Totals"
import type { Briefing, N } from "@/types"

type Var = "gust" | "wind"
const KEY = { gust: "wind_gusts_10m_max", wind: "wind_speed_10m_max" } as const
// a region's peak gust uses its lowland and coastal locations, as the trends table does
const REGION_KINDS = new Set(["lowland", "coast"])

/** Each model's strongest value over the first `days` days at each location, and at each region
 *  (the strongest of its lowland and coastal locations). A model counts only where it covers
 *  every day of the window, and for a region only with all of the region's locations. */
function windowPeaks(data: Briefing, v: Var, days: number) {
  const n = Math.min(days, data.dates.length)
  return data.models.map((m) => {
    const points: Record<string, N> = {}
    for (const p of data.points) {
      const s = (m.data[p.name]?.[KEY[v]] ?? []).slice(0, n)
      points[p.name] = s.length === n && s.every((x) => x != null && Number.isFinite(x)) ? Math.max(...(s as number[])) : null
    }
    const regions: Record<string, N> = {}
    for (const r of data.regions) {
      const xs = data.points.filter((p) => p.region === r.id && REGION_KINDS.has(p.kind)).map((p) => points[p.name])
      regions[r.id] = xs.length && xs.every((x) => x != null) ? Math.max(...(xs as number[])) : null
    }
    return { model: m.label, source: m.source, tier: m.tier, points, regions }
  }).filter((r) => Object.values(r.points).some((x) => x != null))
}

/** The strongest gust in each region for each window, and each model's. */
export function WindPeaks({ data }: { data: Briefing }) {
  const tw = data.trends?.windows ?? []
  if (!tw.length) return null
  const scale = Math.max(...tw.flatMap((w) => data.regions.map((r) => w.regions[r.id]?.gust?.hi ?? 0)))
  const nice = [40, 50, 60, 70, 80, 90, 100, 120].find((s) => s >= scale * 1.05) ?? Math.ceil(scale)
  const panels: RegionPanel[] = tw.map((w) => {
    const c = data.change?.trends?.windows.find((x) => x.days === w.days)
    const summary = data.regions.flatMap((r) => {
      const s = w.regions[r.id]?.gust
      return s ? [{ rid: r.id, name: r.name, median: s.median, lo: s.lo, hi: s.hi, scale: nice,
                    right: c && <ChangeNote c={c.regions[r.id]?.gust} overlap={c.overlapDays} unit={MPH} tone="neutral" /> }] : []
    })
    return {
      key: w.days, label: w.label, nModels: w.regions[data.regions[0]?.id]?.gust?.n ?? 0, summary,
      rows: windowPeaks(data, "gust", w.days).map((r) => ({ model: r.model, regions: r.regions })).filter((r) => Object.values(r.regions).some((x) => x != null)),
    }
  })
  return (
    <RegionModelsCard data={data} title="Region peaks" unit={MPH} panels={panels}
      description="Each region's strongest gust across models, for each window."
      about="The strongest gust in each region and window: the median across models, with their range and the change since yesterday; below, each model's own peak."
      byModel="strongest gust at the region's lowland and coastal locations"
      note={<>Range bars span the models, with the median marked. Passes are left out of a region's peak, as their gusts run far stronger than where people live. A model appears only in windows it fully covers.{data.meta.hasSupplement && " * from Open-Meteo; all other models are read from GRIB."}</>} />
  )
}

/** Model × location table of the strongest gust (or sustained wind) in a window. */
export function WindByLocation({ data, switcher }: { data: Briefing; switcher?: React.ReactNode }) {
  const tw = data.trends?.windows ?? []
  const wins = tw.length ? tw.map((w) => ({ days: w.days, label: w.label })) : data.totals.map((t) => ({ days: t.days, label: t.label }))
  const [win, setWin] = React.useState(String(wins[Math.min(1, wins.length - 1)]?.days ?? 7))
  const [v, setV] = React.useState<Var>("gust")
  const days = Number(win)
  const rows = React.useMemo(() => windowPeaks(data, v, days), [data, v, days])
  if (!wins.length) return null
  const pts = data.points.map((p) => p.name)
  const meds = pts.map((p) => median(rows.map((r) => r.points[p])))
  const chg = v === "gust" ? data.change?.trends?.windows.find((x) => x.days === days) : undefined
  const ramp = v === "gust" ? GUST : WIND
  const cell = (x: N) => ({ style: rampCell(x, ramp), text: x == null ? "–" : String(Math.round(x)) })
  return (
    <Card>
      <CardHeader>
        <CardTitle>By location</CardTitle>
        {(() => {
          const k = meds.reduce<number>((b, x, i) => (x != null && (b < 0 || x > meds[b]!) ? i : b), -1)
          if (k < 0) return null
          const xs = rows.map((r) => r.points[pts[k]]).filter((x): x is number => x != null)
          return <Takeaway>Strongest: {pts[k]}, a median {Math.round(meds[k]!)} mph {v === "gust" ? "gust" : "sustained"}; models range {Math.round(Math.min(...xs))} – {Math.round(Math.max(...xs))} mph.</Takeaway>
        })()}
        <CardDescription info={<>
          Each model's strongest {v === "gust" ? "gust" : "sustained wind"} at each location over the window, in mph. The Median row is the median across models
          {chg ? "; the row below it is the change in that median since yesterday" : ""}.</>}>
          Each model's strongest {v === "gust" ? "gust" : "sustained wind"}, in mph.
        </CardDescription>
        {switcher && <CardAction>{switcher}</CardAction>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Tabs value={v} onValueChange={(x) => setV(x as Var)}>
            <TabsList>
              <TabsTrigger value="gust">Gust</TabsTrigger>
              <TabsTrigger value="wind">Sustained</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={win} onValueChange={setWin}>
            <TabsList>{wins.map((x) => <TabsTrigger key={x.days} value={String(x.days)}>{x.label.replace("Next ", "")}</TabsTrigger>)}</TabsList>
          </Tabs>
        </div>
        {rows.length ? (
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
              {rows.map((r) => (
                <TableRow key={r.model} className="hover:bg-transparent border-0">
                  <TableCell className="sticky left-0 z-10 bg-card py-1 pr-3">
                    <ModelName label={r.model} tier={r.tier} source={r.source} />
                  </TableCell>
                  {pts.map((p) => {
                    const c = cell(r.points[p])
                    return <TableCell key={p} className="rounded-[3px] px-1 py-1.5 text-center tabular-nums" style={c.style}>{c.text}</TableCell>
                  })}
                </TableRow>
              ))}
              <TableRow className="hover:bg-transparent border-0">
                <TableCell className="sticky left-0 z-10 bg-card py-1 pr-3 font-semibold">Median</TableCell>
                {meds.map((x, i) => {
                  const c = cell(x)
                  return <TableCell key={pts[i]} className="rounded-[3px] px-1 py-1.5 text-center font-semibold tabular-nums outline-2 -outline-offset-2 outline-foreground/70" style={c.style}>{c.text}</TableCell>
                })}
              </TableRow>
              {chg && (
                <TableRow className="hover:bg-transparent border-0">
                  <TableCell className="sticky left-0 z-10 bg-card py-1 pr-3 text-muted-foreground">
                    Since yesterday
                    {chg.overlapDays < chg.days && <span className="block text-[11px]">same {chg.overlapDays} days</span>}
                  </TableCell>
                  {pts.map((p) => {
                    const d = chg.points[p]?.gust?.delta
                    return (
                      <TableCell key={p} className="px-0.5 py-1.5 text-center text-[11.5px] tabular-nums">
                        {d == null ? "–" : Math.abs(d) < 0.5 ? <span className="text-muted-foreground">0</span> : <>{d > 0 ? "+" : "−"}{Math.abs(Math.round(d))}</>}
                      </TableCell>
                    )
                  })}
                </TableRow>
              )}
            </TableBody>
          </Table>
        ) : <p className="text-sm text-muted-foreground">No model covers this whole window.</p>}
      </CardContent>
    </Card>
  )
}
