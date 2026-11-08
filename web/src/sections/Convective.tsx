import { ExternalLink } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ptDay, ptDayHour } from "@/lib/format"
import { openLocation } from "@/lib/locationlink"
import { useMds } from "@/lib/useMds"
import type { Briefing, ConvArea, StormReport } from "@/types"

/** SPC's categorical colours, for days whose areas carry none. */
export const SPC_CAT: Record<string, { name: string; fill: string }> = {
  TSTM: { name: "General thunderstorms", fill: "#C1E9C1" },
  MRGL: { name: "Marginal", fill: "#66A366" },
  SLGT: { name: "Slight", fill: "#FFE066" },
  ENH: { name: "Enhanced", fill: "#FFA366" },
  MDT: { name: "Moderate", fill: "#E06666" },
  HIGH: { name: "High", fill: "#EE99EE" },
}
export const REPORT_COLORS: Record<StormReport["type"], string> = { tornado: "#d1272e", wind: "#2a6fdb", hail: "#1e9e4a" }

const dayLabel = (day: number, valid: string | null) => (valid ? `Day ${day} · ${ptDay(valid)}` : `Day ${day}`)

/** "62 mph", "1.75 in", "EF1"; SPC writes UNK when it isn't known. */
export function reportMag(r: StormReport) {
  if (!r.mag || r.mag === "UNK") return ""
  if (r.type === "hail") return `${(+r.mag / 100).toFixed(2)} in`
  if (r.type === "wind") return `${r.mag} mph`
  return r.mag.startsWith("EF") ? r.mag : `EF${r.mag}`
}

function Places({ names }: { names: string[] }) {
  if (!names.length) return <span className="text-muted-foreground">no forecast locations, but the area reaches the map</span>
  return (
    <>
      {names.map((n, i) => (
        <span key={n}>{i > 0 && ", "}
          <button type="button" onClick={() => openLocation(n)} className="hover:underline">{n}</button>
        </span>
      ))}
    </>
  )
}

/** Thunderstorms: SPC's mesoscale discussions for the area right now (fetched live), its
 *  convective outlook for each day, and the storm reports from the last three days. */
export function ConvectiveCard({ data }: { data: Briefing }) {
  const c = data.convective
  const mds = useMds(data)
  if (!c) return null
  const days = c.outlooks.filter((o) => o.areas.length)
  const cats = (areas: ConvArea[]) => areas.filter((a) => a.kind === "cat").sort((a, b) => b.rank - a.rank)
  const probs = (areas: ConvArea[]) => areas.filter((a) => a.kind !== "cat" && a.dn > 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Thunderstorms</CardTitle>
        <CardDescription>
          The Storm Prediction Center's mesoscale discussions for the area right now, its convective outlook for each day, and storm reports from the last three days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section>
          <h3 className="mb-2 text-sm font-medium">Mesoscale discussions</h3>
          {mds == null ? <p className="text-sm text-muted-foreground">Checking SPC for current discussions…</p>
            : !mds.length ? <p className="text-sm text-muted-foreground">No mesoscale discussions for the region right now.</p>
            : (
              <ul className="space-y-3">
                {mds.map((m) => (
                  <li key={m.number} className="text-sm">
                    <p className="font-medium">
                      MD {m.number}: {m.concerning}
                      <a href={m.url} target="_blank" rel="noopener" className="ml-1.5 inline-flex align-[-2px] text-muted-foreground hover:text-foreground" aria-label={`Open MD ${m.number} on spc.noaa.gov`}>
                        <ExternalLink className="size-3.5" />
                      </a>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {m.areas}{m.start && m.end && <> · valid {ptDayHour(m.start)} – {ptDayHour(m.end, true).replace(/^\S+ \S+ /, "")}</>}
                      {m.watch && <> · watch {m.watch}% likely</>}
                    </p>
                    {m.summary && <p className="mt-1 text-pretty">{m.summary}</p>}
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium">Convective outlook</h3>
          {!days.length ? <p className="text-sm text-muted-foreground">No thunderstorms in SPC's outlook for the region.</p> : (
            <ul className="space-y-2.5 text-sm">
              {days.map((o) => {
                const top = cats(o.areas)
                const p = probs(o.areas)
                return (
                  <li key={o.day} className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[150px_1fr]">
                    <span className="text-muted-foreground">{o.day <= 3 ? dayLabel(o.day, o.valid) : `Day ${o.day}`}</span>
                    <div className="space-y-1">
                      {top.map((a) => (
                        <p key={a.label}>
                          <span className="mr-1.5 inline-block size-2.5 rounded-full align-[1px] ring-1 ring-black/15" style={{ background: a.fill ?? SPC_CAT[a.label]?.fill }} aria-hidden />
                          <span className="font-medium">{SPC_CAT[a.label]?.name ?? a.name}</span>
                          {a.label !== "TSTM" && " risk"}: <Places names={a.points} />
                        </p>
                      ))}
                      {p.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {p.map((a) => `${a.sig ? "Significant " : ""}${a.name}`).join(" · ")}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium">Storm reports, last three days</h3>
          {!c.reports.length ? <p className="text-sm text-muted-foreground">No tornado, wind or hail reports in the region.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <tbody>
                  {c.reports.map((r, i) => (
                    <tr key={i} className="border-b border-border/60 align-top last:border-b-0">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground tabular-nums">{ptDayHour(r.time)}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        <span className="mr-1.5 inline-block size-2.5 rounded-full align-[1px]" style={{ background: REPORT_COLORS[r.type] }} aria-hidden />
                        {r.type === "tornado" ? "Tornado" : r.type === "wind" ? "Wind" : "Hail"}{reportMag(r) && <span className="tabular-nums"> {reportMag(r)}</span>}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{r.location}, {r.state}</td>
                      <td className="py-1.5 text-xs text-muted-foreground">{r.comments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
