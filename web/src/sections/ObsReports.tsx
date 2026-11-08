import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DayHead } from "@/components/DayHead"
import { ptDayHour } from "@/lib/format"
import { openLocation } from "@/lib/locationlink"
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

function fmt(v: V, x: N) {
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
function typeName(t: string) {
  const x = t.toLowerCase()
  if (x.includes("wnd gst")) return "wind gust"
  if (x.includes("wnd dmg")) return "wind damage"
  return x
}

function reportMag(r: ObsReport) {
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
  const reports = o.reports.filter((r) => KINDS[v].includes(r.kind))
  if (!rows.length && !reports.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLE[v]}</CardTitle>
        <CardDescription>
          {WHAT[v]} over the last {o.days.length - 1} days and today so far (Pacific time){reports.length ? ", and the storm reports NWS offices have issued" : ""}.
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

        {reports.length > 0 && (
          <section>
            <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">NWS storm reports</h3>
            <ul className="divide-y divide-border/70 text-sm">
              {reports.map((r, i) => (
                <li key={i} className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[120px_1fr]">
                  <span className="text-xs text-muted-foreground tabular-nums sm:pt-0.5">{r.time ? ptDayHour(r.time) : ""}</span>
                  <div className="min-w-0">
                    <p>
                      <span className="font-semibold tabular-nums">{reportMag(r) ?? typeName(r.type).replace(/^./, (c) => c.toUpperCase())}</span>
                      {reportMag(r) && <span className="text-muted-foreground"> {typeName(r.type)}</span>}
                      {" "}at {r.place}{r.state ? `, ${r.state}` : ""}
                      {r.near && r.near !== r.place && <> · near <button type="button" onClick={() => openLocation(r.near!)} className="hover:underline">{r.near}</button></>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[r.source, r.measured ? "measured" : r.mag != null ? "estimated" : null].filter(Boolean).join(", ")}
                      {r.remark && <> · {r.remark}</>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  )
}
