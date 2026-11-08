import * as React from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DayHead } from "@/components/DayHead"
import { ptDayHour } from "@/lib/format"
import { openLocation } from "@/lib/locationlink"
import { liveReports } from "@/lib/obsreports"
import { GUST, PRECIP, SNOW } from "@/lib/ramps"
import { rampCell } from "@/sections/DayMatrix"
import type { Briefing, N, ObsReport } from "@/types"

type V = "precip" | "gust" | "snow"
const TITLE: Record<V, string> = { precip: "Observed precipitation", gust: "Observed peak gusts", snow: "Observed new snow" }
const WHAT: Record<V, string> = {
  precip: "Precipitation measured at each location's station, by day",
  gust: "The strongest gust measured at each location's station, by day, in mph",
  snow: "New snow at the pass SNOTEL stations (the rise in snow depth) and any station snowfall reports, by day",
}
/** Which storm report kinds go with each card. */
const KINDS: Record<V, ObsReport["kind"][]> = { precip: ["rain", "flood", "ice"], gust: ["gust", "damage"], snow: ["snow", "ice"] }
const RAMP = { precip: PRECIP, gust: GUST, snow: SNOW }

export function fmt(v: V, x: N) {
  if (x == null) return "–"
  if (v === "precip") return x > 0 && x < 0.005 ? "T" : x.toFixed(2)
  return String(Math.round(x))
}

/** "10:00 AM" from IEM's local timestamp ("2026-11-06T10:00"). */
function clock(s: string | null | undefined) {
  if (!s) return null
  const m = s.match(/T(\d{2}):(\d{2})/)
  if (!m) return null
  const h = +m[1]
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`
}

/** NWS's abbreviated report types in plain words. */
export function typeName(t: string) {
  const x = t.toLowerCase()
  if (x.includes("wnd gst") || x === "wind") return "wind gust"
  if (x.includes("wnd dmg")) return "wind damage"
  return x
}

export function reportMag(r: ObsReport) {
  if (r.mag == null) return null
  const u = r.unit ?? ""
  if (u === "mph") return `${Math.round(r.mag)} mph`
  if (u.startsWith("inch")) return `${r.mag.toFixed(r.kind === "snow" ? 1 : 2).replace(/\.0$/, "")} in`
  return `${r.mag}${u ? ` ${u}` : ""}`
}

/** Observed values by location and day (stations), then the NWS storm reports of the same kind. */
export function ObsReportsCard({ data, v }: { data: Briefing; v: V }) {
  const o = data.obsReports
  if (!o) return null
  const rows = data.points.map((p) => ({ name: p.name, rec: o.points[p.name] }))
    .filter((r) => r.rec && r.rec[v].some((x) => x != null))
  const reports = liveReports(o).filter((r) => KINDS[v].includes(r.kind))
  if (!rows.length && !reports.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLE[v]}</CardTitle>
        <CardDescription>
          {WHAT[v]} over the last {o.days.length - 1} days and today so far (Pacific time){reports.length ? `, then what's been reported to NWS Seattle and Portland in the last ${o.reportHours ?? 48} hours` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <Table className="w-auto border-separate border-spacing-[2px] text-[12.5px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="sticky left-0 z-10 bg-card">Location</TableHead>
                  {o.days.map((d) => (
                    <TableHead key={d} className="h-auto w-[52px] px-1 pb-2 text-center align-bottom text-[11.5px] sm:w-[84px]">
                      {d === o.today ? <>Today<span className="block font-normal text-muted-foreground">so far</span></> : <DayHead day={d} />}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ name, rec }) => (
                  <TableRow key={name} className="border-0 hover:bg-transparent">
                    <TableCell className="sticky left-0 z-10 max-w-[124px] bg-card py-1 pr-2 sm:max-w-[220px] sm:pr-4">
                      <button type="button" onClick={() => openLocation(name)} className="text-left hover:underline">{name}</button>
                      <span className="block truncate text-[11px] text-muted-foreground" title={rec!.stations.join("; ")}>{rec!.stations.join("; ")}</span>
                    </TableCell>
                    {rec![v].map((x, i) => {
                      const t = v === "gust" ? clock(rec!.gustTime[i]) : null
                      return (
                        <TableCell key={i} className="rounded-[3px] px-1 py-1 text-center tabular-nums" style={rampCell(x, RAMP[v], true)}
                          title={t ? `at ${t}` : undefined}>
                          {fmt(v, x)}
                          {t && <span className="block text-[10px] leading-tight opacity-75">{t}</span>}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-2 text-xs text-muted-foreground">
              {v === "precip" ? "Inches; T is a trace. " : v === "snow" ? "Inches. " : ""}
              Days run midnight to midnight; a dash means the station didn't report.
              {v === "gust" ? " Passes have no wind station." : ""}
            </p>
          </div>
        )}

        {reports.length > 0 && <ReportList reports={reports} />}
      </CardContent>
    </Card>
  )
}

const SHOW = 8

/** Every NWS report of the card's kind: single storm reports and the rows of the offices' report
 *  summaries, the largest first (reports without an amount, like wind damage, after), the top
 *  few shown until expanded. */
function ReportList({ reports }: { reports: ObsReport[] }) {
  const [all, setAll] = React.useState(false)
  const sorted = React.useMemo(() => [...reports].sort((a, b) => (b.mag ?? -1) - (a.mag ?? -1) || (b.time ?? "").localeCompare(a.time ?? "")), [reports])
  const shown = all ? sorted : sorted.slice(0, SHOW)
  const sums = [...new Map(reports.filter((r) => r.summary).map((r) => [`${r.summary!.office}${r.summary!.issued}`, r.summary!])).values()]
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Reported to NWS</h3>
      <p className="mb-2.5 text-xs text-muted-foreground">
        {reports.length} report{reports.length === 1 ? "" : "s"} from spotters, mesonets, ski areas and other stations
        {sums.length > 0 && <>, including {sums.map((x) => `NWS ${x.office === "SEW" ? "Seattle" : x.office === "PQR" ? "Portland" : x.office}'s ${x.title.toLowerCase()} (${ptDayHour(x.issued)})`).join(" and ")}</>}.
        {" "}Not all are official.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] max-w-3xl text-sm">
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-b border-border/60 align-top last:border-b-0">
                <td className="w-[88px] py-1.5 pr-3 font-semibold whitespace-nowrap tabular-nums">
                  {reportMag(r) ?? <span className="font-normal">{typeName(r.type).replace(/^./, (c) => c.toUpperCase())}</span>}
                </td>
                <td className="py-1.5 pr-3">
                  {r.place}{r.state ? `, ${r.state}` : ""}
                  <span className="block text-xs text-muted-foreground">
                    {[r.county, r.elev_ft != null ? `${r.elev_ft.toLocaleString()} ft` : null, r.source, r.measured === false && r.mag != null ? "estimated" : null].filter(Boolean).join(" · ")}
                    {r.remark && <> · {r.remark}</>}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">{r.time ? ptDayHour(r.time) : ""}</td>
                <td className="py-1.5 text-xs whitespace-nowrap text-muted-foreground">
                  {r.near && <>near <button type="button" onClick={() => openLocation(r.near!)} className="text-foreground hover:underline">{r.near}</button></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > SHOW && (
        <Button variant="ghost" size="sm" className="mt-1 -ml-2" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </Button>
      )}
    </section>
  )
}

/** One location's observations in its side panel: the station's last few days, then the NWS
 *  reports tied to it. */
export function LocationObserved({ data, name }: { data: Briefing; name: string }) {
  const o = data.obsReports
  const rec = o?.points[name]
  const reports = React.useMemo(() => liveReports(o).filter((r) => r.near === name)
    .sort((a, b) => (b.mag ?? -1) - (a.mag ?? -1)), [o, name])
  if (!o || (!rec && !reports.length)) return null
  const rows = rec ? (["precip", "gust", "snow"] as V[]).filter((v) => rec[v].some((x) => x != null)) : []
  const label = { precip: "Precip (in)", gust: "Peak gust (mph)", snow: "New snow (in)" }
  return (
    <div>
      <p className="mb-2 text-sm font-medium">Observed</p>
      {rows.length > 0 && (
        <>
          <table className="w-full max-w-md text-[13px] tabular-nums">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="pb-1 text-left font-normal" />
                {o.days.map((d) => (
                  <th key={d} className="pb-1 text-right font-normal">{d === o.today ? "Today" : new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v} className="border-t border-border/60">
                  <td className="py-1 pr-2 text-xs text-muted-foreground">{label[v]}</td>
                  {rec![v].map((x, i) => (
                    <td key={i} className={`py-1 text-right ${x == null ? "text-muted-foreground" : ""}`}>{fmt(v, x)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted-foreground">{rec!.stations.join("; ")}. Today is so far.</p>
        </>
      )}
      {reports.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[13px]">
          {reports.slice(0, 6).map((r, i) => (
            <li key={i}>
              <span className="font-semibold tabular-nums">{reportMag(r) ?? typeName(r.type).replace(/^./, (c) => c.toUpperCase())}</span>
              {reportMag(r) && <span className="text-muted-foreground"> {typeName(r.type)}</span>} at {r.place}
              <span className="block text-xs text-muted-foreground">{[r.time ? ptDayHour(r.time) : null, r.county, r.source].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
          {reports.length > 6 && <li className="text-xs text-muted-foreground">and {reports.length - 6} more reported to NWS nearby</li>}
        </ul>
      )}
    </div>
  )
}

/** The standout observations of the last day or two, for the top of the page: the strongest
 *  gust and the most rain and snow, from NWS reports and the locations' stations. */
export function ObservedHighlights({ data }: { data: Briefing }) {
  const o = data.obsReports
  const items = React.useMemo(() => {
    if (!o) return []
    const reps = liveReports(o)
    const recent = o.days.slice(-2)                                // yesterday and today at the stations
    type Item = { what: string; value: number; text: string; where: string; when: string | null; loc: string | null }
    const best = (kind: ObsReport["kind"], v: V, what: string, min: number): Item | null => {
      let out: Item | null = null
      for (const r of reps) {
        if (r.kind !== kind || r.mag == null || r.mag < min) continue
        if (!out || r.mag > out.value) out = { what, value: r.mag, text: reportMag(r)!, where: r.place ?? "", when: r.time, loc: r.near }
      }
      for (const [name, rec] of Object.entries(o.points)) {
        rec[v].forEach((x, i) => {
          const day = o.days[i]
          if (x == null || x < min || !recent.includes(day)) return
          if (!out || x > out.value) out = { what, value: x, text: v === "gust" ? `${Math.round(x)} mph` : `${x.toFixed(v === "snow" ? 0 : 2)} in`, where: name, when: null, loc: name }
        })
      }
      return out
    }
    return [best("gust", "gust", "Strongest gust", 30), best("rain", "precip", "Most rain", 0.25), best("snow", "snow", "Most new snow", 1)]
      .filter((x): x is NonNullable<typeof x> => !!x)
  }, [o])
  if (!items.length) return null
  return (
    <p className="max-w-[68ch] text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">Observed lately: </span>
      {items.map((x, i) => (
        <span key={x.what}>
          {i > 0 && " · "}
          {x.what} <span className="font-semibold text-foreground tabular-nums">{x.text}</span>{" "}
          {x.loc ? <button type="button" onClick={() => openLocation(x.loc!)} className="hover:underline">at {x.where}</button> : `at ${x.where}`}
          {x.when && <> ({ptDayHour(x.when)})</>}
        </span>
      ))}
    </p>
  )
}
