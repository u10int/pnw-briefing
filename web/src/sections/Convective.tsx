import { ExternalLink } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { contrastTextColor } from "@/lib/contrast"
import { ptDayHour, ptParts } from "@/lib/format"
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

/** Short badge names for the categorical risks. */
const CAT_SHORT: Record<string, string> = { TSTM: "Thunder", MRGL: "Marginal", SLGT: "Slight", ENH: "Enhanced", MDT: "Moderate", HIGH: "High" }
const KIND_NAME: Record<string, string> = { tornado: "Tornado", wind: "Wind", hail: "Hail", severe: "Severe" }

/** One chip per hazard: its highest probability over the area, and whether a significant area is drawn. */
function probChips(areas: ConvArea[]) {
  const by = new Map<string, { kind: string; name: string; pct: number | null; sig: boolean }>()
  for (const a of areas) {
    if (a.kind === "cat" || a.dn <= 0) continue
    const c = by.get(a.kind) ?? { kind: a.kind, name: KIND_NAME[a.kind] ?? a.kind, pct: null, sig: false }
    if (a.sig) c.sig = true
    else {
      const v = parseFloat(a.label)
      const pct = Number.isFinite(v) ? Math.round(v <= 1 ? v * 100 : v) : null
      if (pct != null && (c.pct == null || pct > c.pct)) c.pct = pct
    }
    by.set(a.kind, c)
  }
  return ["tornado", "wind", "hail", "severe"].flatMap((k) => (by.has(k) ? [by.get(k)!] : []))
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>
}

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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Thunderstorms</CardTitle>
        <CardDescription>
          The Storm Prediction Center's mesoscale discussions for the area right now, its convective outlook for each day, and storm reports from the last three days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section>
          <SectionHead>Mesoscale discussions</SectionHead>
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
          <SectionHead>Convective outlook</SectionHead>
          {!days.length ? <p className="text-sm text-muted-foreground">No thunderstorms in SPC's outlook for the region.</p> : (
            <ul className="divide-y divide-border/70 rounded-md border text-sm">
              {days.map((o) => {
                const top = cats(o.areas)
                const p = probChips(o.areas)
                return (
                  <li key={o.day} className="grid gap-x-5 gap-y-2 px-3 py-3 sm:grid-cols-[88px_1fr]">
                    <div className="flex items-baseline gap-2 sm:block">
                      {o.valid ? <p className="font-semibold">{ptParts(o.valid).wd} <span className="font-normal text-muted-foreground tabular-nums">{ptParts(o.valid).md}</span></p>
                        : <p className="font-semibold">Day {o.day}</p>}
                      {o.valid && <p className="text-xs text-muted-foreground">Day {o.day}</p>}
                    </div>
                    <div className="min-w-0 space-y-2">
                      {top.map((a) => {
                        const fill = a.fill ?? SPC_CAT[a.label]?.fill ?? "#ccc"
                        return (
                          <div key={a.label} className="grid grid-cols-[auto_1fr] items-baseline gap-x-3">
                            <span className="inline-flex min-w-[84px] sm:min-w-[104px] justify-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-black/10"
                              style={{ background: fill, color: contrastTextColor(fill) }}>
                              {CAT_SHORT[a.label] ?? a.name}
                            </span>
                            <p className="min-w-0 text-pretty"><Places names={a.points} /></p>
                          </div>
                        )
                      })}
                      {p.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          <span className="mr-0.5 text-xs text-muted-foreground">Severe probability</span>
                          {p.map((c) => (
                            <Badge key={c.kind} variant="outline" className="tabular-nums">
                              {c.name} <span className="font-semibold">{c.pct != null ? `${c.pct}%` : ""}</span>
                              {c.sig && <span className="text-muted-foreground">· significant</span>}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <SectionHead>Storm reports, last three days</SectionHead>
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
