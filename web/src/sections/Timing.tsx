import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ptDayHour, ptParts } from "@/lib/format"
import { openLocation } from "@/lib/locationlink"
import type { Briefing, PeakPeriod } from "@/types"

type Var = "gust" | "precip"

const hourOnly = (t: string) => ptDayHour(t).replace(/^\S+ \S+ /, "")
/** "Sat 11/7 4 – 10 PM", "Sat 11/7 10 PM – Sun 11/8 3 AM". */
export function hourRange(a: string, b: string) {
  if (a === b) return ptDayHour(a)
  const same = ptParts(a).md === ptParts(b).md
  return same ? `${ptDayHour(a)} – ${hourOnly(b)}` : `${ptDayHour(a)} – ${ptDayHour(b)}`
}
const peakText = (v: Var, e: PeakPeriod) =>
  v === "gust" ? `${Math.round(e.peak)} mph` : `${e.peak.toFixed(2)} in/h${e.heavy ? " (heavy)" : ""}`
/** When the models put their own peaks, if they differ. */
const spread = (e: PeakPeriod) =>
  e.peakFrom && e.peakTo && e.peakFrom !== e.peakTo ? `models peak ${hourRange(e.peakFrom, e.peakTo)}` : null

/** The peak hour, with its day when the period runs over more than one. */
const peakAt = (e: PeakPeriod) => (ptParts(e.start).md === ptParts(e.end).md ? hourOnly(e.peakTime) : ptDayHour(e.peakTime))

/** One line for a period: "Sat 11/7 4 – 10 PM, peaking near 7 PM at 48 mph". */
export function periodLine(v: Var, e: PeakPeriod) {
  return `${hourRange(e.start, e.end)}, peaking near ${peakAt(e)} at ${peakText(v, e)}`
}

/** Locations where gusts or precipitation reach their threshold in the next two days: when, how
 *  strong at the peak, and how well the hourly models agree on timing. */
export function PeakTimingCard({ data, v }: { data: Briefing; v: Var }) {
  const t = data.timing
  if (!t) return null
  const rows = data.points.flatMap((p) => (t.points[p.name]?.[v] ?? []).map((e) => ({ p, e })))
  const th = t.thresholds
  const what = v === "gust"
    ? `gusts reach ${th.gust_mph.lowland} mph in the lowlands, ${th.gust_mph.coast} on the coast or ${th.gust_mph.pass} at the passes`
    : `precipitation falls at ${th.rate_in_per_h} in an hour or more (moderate; ${th.heavy_in_per_h}+ is heavy)`
  return (
    <Card>
      <CardHeader>
        <CardTitle>{v === "gust" ? "When the strongest gusts come" : "When the heaviest precipitation comes"}</CardTitle>
        <CardDescription>
          Over the next {t.hours} hours, the locations where {what}, in the median of the hourly models ({t.models.join(", ")}): the hours it lasts, the peak, and how many models reach it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!rows.length ? <p className="text-sm text-muted-foreground">No location reaches that in the next {t.hours} hours.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Location</th>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Peak</th>
                  <th className="py-2 pl-3 font-medium">Models</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, e }, i) => (
                  <tr key={`${p.name}-${i}`} className="border-b border-border/60 align-top last:border-b-0">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <button type="button" onClick={() => openLocation(p.name)} className="hover:underline">{p.name}</button>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">{hourRange(e.start, e.end)}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {peakText(v, e)} <span className="text-muted-foreground">near {peakAt(e)}</span>
                      {v === "precip" && e.total != null && <span className="block text-xs text-muted-foreground">about {e.total.toFixed(2)} in over the period</span>}
                    </td>
                    <td className="py-2 pl-3 text-xs text-muted-foreground">
                      {e.models} of {e.of} reach it{spread(e) && <span className="block">{spread(e)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The location panel's lines: only the periods it has. */
export function PeakTimingLines({ data, name }: { data: Briefing; name: string }) {
  const r = data.timing?.points[name]
  if (!r || (!r.gust?.length && !r.precip?.length)) return null
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">Peak timing, next {data.timing!.hours} hours</p>
      <ul className="space-y-1 text-sm">
        {(r.gust ?? []).map((e, i) => <li key={`g${i}`}><span className="text-muted-foreground">Strongest gusts:</span> {periodLine("gust", e)}</li>)}
        {(r.precip ?? []).map((e, i) => <li key={`p${i}`}><span className="text-muted-foreground">Heaviest {e.heavy ? "rain, heavy at times" : "rain"}:</span> {periodLine("precip", e)}</li>)}
      </ul>
    </div>
  )
}
