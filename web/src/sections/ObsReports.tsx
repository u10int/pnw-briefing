import * as React from "react"

import { Button } from "@/components/ui/button"
import { MapButton } from "@/components/MapButton"
import { Takeaway, dayOf } from "@/components/Takeaway"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DayHead } from "@/components/DayHead"
import { ptDayHour } from "@/lib/format"
import { openLocation } from "@/lib/locationlink"
import { liveReports } from "@/lib/obsreports"
import { GUST, PRECIP, SNOW, TEMP } from "@/lib/ramps"
import { rampCell } from "@/sections/DayMatrix"
import type { Briefing, N, ObsReport, ObsReports } from "@/types"

type V = "precip" | "gust" | "snow" | "temp"
const TITLE: Record<V, string> = { precip: "Observed precipitation", gust: "Observed peak gusts", snow: "Observed new snow", temp: "Observed highs and lows" }
const WHAT: Record<V, string> = {
  precip: "Precipitation measured at each location's station, by day",
  gust: "The strongest gust measured at each location's station, by day, in mph",
  snow: "New snow at the pass SNOTEL stations (the rise in snow depth) and any station snowfall reports, by day",
  temp: "The highest and lowest temperature measured at each location's station, by day, in °F",
}
/** Which storm report kinds go with each card. */
const KINDS: Record<V, ObsReport["kind"][]> = { precip: ["rain", "flood", "ice"], gust: ["gust", "damage"], snow: ["snow", "ice"], temp: ["high", "low"] }
const RAMP = { precip: PRECIP, gust: GUST, snow: SNOW, temp: TEMP }
/** The colour scale for each kind of report with an amount (wind damage, flooding and ice have none). */
const REPORT_RAMP: Partial<Record<ObsReport["kind"], typeof PRECIP>> = { gust: GUST, rain: PRECIP, snow: SNOW, high: TEMP, low: TEMP }
/** Temperature cells keep the colour even at low values (the other scales fade out below their first level). */
const cell = (x: N, v: V) => rampCell(x, RAMP[v], v !== "temp")

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
  if (u === "F") return `${Math.round(r.mag)}°F`
  if (u.startsWith("inch")) return `${r.mag.toFixed(r.kind === "snow" ? 1 : 2).replace(/\.0$/, "")} in`
  return `${r.mag}${u ? ` ${u}` : ""}`
}

/** Observed values by location and day (stations), then the NWS storm reports of the same kind. */
export function ObsReportsCard({ data, v }: { data: Briefing; v: V }) {
  const o = data.obsReports
  if (!o) return null
  if (v === "temp") return <ObsTempCard data={data} />
  const rows = data.points.map((p) => ({ name: p.name, rec: o.points[p.name] }))
    .filter((r) => r.rec && r.rec[v].some((x) => x != null))
  const reports = liveReports(o).filter((r) => KINDS[v].includes(r.kind))
  if (!rows.length && !reports.length) return null
  // the most at any station over the period, and the largest report with an amount
  const agg = (xs: N[]) => { const ys = xs.filter((x): x is number => x != null); return ys.length ? (v === "gust" ? Math.max(...ys) : ys.reduce((a, b) => a + b, 0)) : null }
  const st = rows.map((r) => ({ name: r.name, x: agg(r.rec[v]) })).filter((r) => r.x != null).sort((a, b) => b.x! - a.x!)[0]
  const rep = reports.filter((r) => r.mag != null && REPORT_RAMP[r.kind]).sort((a, b) => b.mag! - a.mag!)[0]
  const stText = st && st.x! > 0 && <>{v === "gust" ? "Strongest station gust" : "Most at a station"}: {st.name}, {v === "gust" ? `${Math.round(st.x!)} mph` : `${fmt(v, st.x)}″`}{v !== "gust" && ` over ${o.days.length - 1} days and today`}</>
  const repText = rep && <>largest report {reportMag(rep)}{rep.place ? ` at ${rep.place}` : ""}</>
  const takeaway = stText || repText ? <>{stText}{stText && repText ? "; " : ""}{!stText && repText ? <>Largest report: {reportMag(rep)}{rep.place ? ` at ${rep.place}` : ""}</> : repText}.</> : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLE[v]}</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription info={<>{WHAT[v]} over the last {o.days.length - 1} days and today so far (Pacific time){reports.length ? `, then what's been reported to NWS Seattle and Portland in the last ${o.reportHours ?? 48} hours` : ""}.</>}>
          The last {o.days.length - 1} days and today so far{reports.length ? ", and recent reports" : ""}.
        </CardDescription>
        {reports.length > 0 && (
          <CardAction>
            <MapButton label="Reports on the map"
              req={v === "precip" ? { mode: "totals", variable: "obs", days: 3, overlays: { nwsReports: true } } : { overlays: { nwsReports: true } }} />
          </CardAction>
        )}
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
                        <TableCell key={i} className="rounded-[3px] px-1 py-1 text-center tabular-nums" style={cell(x, v)}
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

/** Each location's observed high and low by day, two cells a day on the temperature scale, then any
 *  NWS high and low temperature summaries. */
function ObsTempCard({ data }: { data: Briefing }) {
  const o = data.obsReports!
  const rows = data.points.map((p) => ({ name: p.name, rec: o.points[p.name] }))
    .filter((r) => r.rec && [...(r.rec.tmax ?? []), ...(r.rec.tmin ?? [])].some((x) => x != null))
  const reports = liveReports(o).filter((r) => r.kind === "high" || r.kind === "low")
  if (!rows.length && !reports.length) return null
  const day = (i: number) => (o.days[i] === o.today ? "today so far" : dayOf(o.days[i]))
  // the warmest high and the coldest low at any station; the extremes among NWS's reports
  const all = (k: "tmax" | "tmin") => rows.flatMap((r) => (r.rec![k] ?? []).map((x, i) => ({ name: r.name, x, i }))).filter((y): y is { name: string; x: number; i: number } => y.x != null)
  const warm = all("tmax").sort((a, b) => b.x - a.x)[0], cold = all("tmin").sort((a, b) => a.x - b.x)[0]
  const rHi = reports.filter((r) => r.kind === "high" && r.mag != null).sort((a, b) => b.mag! - a.mag!)[0]
  const rLo = reports.filter((r) => r.kind === "low" && r.mag != null).sort((a, b) => a.mag! - b.mag!)[0]
  const parts = [
    warm && `Warmest: ${warm.name}, ${warm.x}°F ${day(warm.i)}`,
    cold && `coldest: ${cold.name}, ${cold.x}°F ${day(cold.i)}`,
    rHi && `highest reported ${reportMag(rHi)}${rHi.place ? ` at ${rHi.place}` : ""}`,
    rLo && `lowest reported ${reportMag(rLo)}${rLo.place ? ` at ${rLo.place}` : ""}`,
  ].filter(Boolean) as string[]
  const takeaway = parts.length ? <>{parts.join("; ").replace(/^./, (c) => c.toUpperCase())}.</> : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLE.temp}</CardTitle>
        <Takeaway>{takeaway}</Takeaway>
        <CardDescription info={<>{WHAT.temp} over the last {o.days.length - 1} days and today so far (Pacific time){reports.length ? ", then the high and low temperature reports NWS Seattle and Portland have summarised in the last " + (o.reportHours ?? 48) + " hours" : ""}.</>}>
          The last {o.days.length - 1} days and today so far{reports.length ? ", and recent reports" : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <Table className="w-auto border-separate border-spacing-[2px] text-[12.5px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead rowSpan={2} className="sticky left-0 z-10 bg-card align-bottom">Location</TableHead>
                  {o.days.map((d) => (
                    <TableHead key={d} colSpan={2} className="h-auto px-1 pb-1 text-center align-bottom text-[11.5px]">
                      {d === o.today ? <>Today<span className="block font-normal text-muted-foreground">so far</span></> : <DayHead day={d} />}
                    </TableHead>
                  ))}
                </TableRow>
                <TableRow className="hover:bg-transparent">
                  {o.days.map((d) => (["High", "Low"] as const).map((k) => (
                    <TableHead key={d + k} className="h-auto w-[40px] px-1 pb-1.5 text-center text-[10.5px] font-normal text-muted-foreground sm:w-[44px]">{k}</TableHead>
                  )))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ name, rec }) => (
                  <TableRow key={name} className="border-0 hover:bg-transparent">
                    <TableCell className="sticky left-0 z-10 max-w-[124px] bg-card py-1 pr-2 sm:max-w-[220px] sm:pr-4">
                      <button type="button" onClick={() => openLocation(name)} className="text-left hover:underline">{name}</button>
                      <span className="block truncate text-[11px] text-muted-foreground" title={rec!.stations.join("; ")}>{rec!.stations.join("; ")}</span>
                    </TableCell>
                    {o.days.map((d, i) => (["tmax", "tmin"] as const).map((k) => {
                      const x = rec![k]?.[i] ?? null
                      return (
                        <TableCell key={d + k} className="rounded-[3px] px-1 py-1 text-center tabular-nums" style={cell(x, "temp")}
                          title={x != null ? `${k === "tmax" ? "High" : "Low"} ${x}°F, ${day(i)}` : undefined}>
                          {fmt("temp", x)}
                        </TableCell>
                      )
                    }))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-2 text-xs text-muted-foreground">
              °F. Days run midnight to midnight, so today's high and low are so far; a dash means the station didn't report.
              The passes use their SNOTEL's hourly air temperature.
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
  // the largest first; low temperatures coldest first, after the highs
  const sorted = React.useMemo(() => [...reports].sort((a, b) => +(a.kind === "low") - +(b.kind === "low")
    || (a.kind === "low" ? (a.mag ?? 999) - (b.mag ?? 999) : (b.mag ?? -1) - (a.mag ?? -1)) || (b.time ?? "").localeCompare(a.time ?? "")), [reports])
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
              <tr key={i} className="border-b border-border/60 align-middle last:border-b-0">
                <td className="w-[96px] py-1.5 pr-3">
                  {/* the value on its data type's colour scale, as in the tables above */}
                  <div className={`rounded-[4px] px-2 py-1 text-center whitespace-nowrap tabular-nums ${r.mag != null ? "font-semibold" : "bg-muted/60"}`}
                    style={r.mag != null && REPORT_RAMP[r.kind] ? rampCell(r.mag, REPORT_RAMP[r.kind]!, true) : undefined}>
                    {reportMag(r) ?? typeName(r.type).replace(/^./, (c) => c.toUpperCase())}
                  </div>
                </td>
                <td className="py-1.5 pr-3">
                  {r.place}{r.state ? `, ${r.state}` : ""}
                  <span className="block text-xs text-muted-foreground">
                    {[r.kind === "high" ? "High temperature" : r.kind === "low" ? "Low temperature" : null, r.county, r.elev_ft != null ? `${r.elev_ft.toLocaleString()} ft` : null, r.source, r.measured === false && r.mag != null ? "estimated" : null].filter(Boolean).join(" · ")}
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
  type R = "precip" | "gust" | "snow" | "tmax" | "tmin"
  const rows = rec ? (["tmax", "tmin", "precip", "gust", "snow"] as R[]).filter((v) => rec[v]?.some((x) => x != null)) : []
  const label = { precip: "Precip (in)", gust: "Peak gust (mph)", snow: "New snow (in)", tmax: "High (°F)", tmin: "Low (°F)" }
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
                  {rec![v]!.map((x, i) => (
                    <td key={i} className={`py-1 text-right ${x == null ? "text-muted-foreground" : ""}`}>{fmt(v === "tmax" || v === "tmin" ? "temp" : v, x)}</td>
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
  const groups = React.useMemo(() => {
    if (!o) return []
    const sum = (xs: N[]) => xs.filter((x): x is number => x != null).reduce((a, b) => a + b, 0)
    // only what's worth noting: measurable rain, half an inch of snow, gusts of 25 mph or more
    const top = (f: (r: ObsReports["points"][string]) => number, min: number) =>
      Object.entries(o.points).map(([n, r]) => ({ n, v: f(r) })).filter((x) => x.v >= min).sort((a, b) => b.v - a.v).slice(0, 3)
    return [
      { key: "precip", title: "Most rain", rows: top((r) => sum(r.precip), 0.01), color: "#2563c9", fmt: (v: number) => `${v.toFixed(2)}″` },
      { key: "snow", title: "Most new snow", rows: top((r) => sum(r.snow), 0.5), color: "#6553cf", fmt: (v: number) => `${Math.round(v)}″` },
      { key: "gust", title: "Strongest gusts", rows: top((r) => Math.max(0, ...r.gust.filter((x): x is number => x != null)), 25), color: "#4b98b8", fmt: (v: number) => `${Math.round(v)} mph` },
    ].filter((g) => g.rows.length)
  }, [o])
  if (!o) return null
  return (
    <section className="space-y-2.5">
      <h2 className="text-sm font-semibold">Observed lately <span className="font-normal text-muted-foreground">· last {o.days.length - 1} days and today</span></h2>
      {!groups.length && <p className="text-[13px] text-muted-foreground">Quiet: no measurable rain or snow, and no gusts of 25 mph or more, at the locations' stations.</p>}
      {groups.map((g) => (
        <div key={g.key} className="space-y-0.5">
          <p className="text-[12px] text-muted-foreground">{g.title}</p>
          {g.rows.map((x) => (
            <div key={x.n} className="grid grid-cols-[112px_minmax(0,1fr)_56px] items-center gap-2 text-[12.5px]">
              <button type="button" onClick={() => openLocation(x.n)} className="truncate text-left hover:underline">{x.n}</button>
              <div className="h-2 rounded-full bg-border/60"><div className="h-2 rounded-full" style={{ width: `${(100 * x.v) / g.rows[0].v}%`, background: g.color }} /></div>
              <span className="text-right font-medium tabular-nums">{g.fmt(x.v)}</span>
            </div>
          ))}
        </div>
      ))}
      {groups.length > 0 && <p className="text-[11px] text-muted-foreground">At each location's station; today is so far.</p>}
    </section>
  )
}
