import * as React from "react"

import { dayOf } from "@/components/Takeaway"
import { ptDayHour } from "@/lib/format"
import type { Briefing, EventChange } from "@/types"

const when = (e: EventChange) => (e.start === e.end ? dayOf(e.start) : `${dayOf(e.start)} – ${dayOf(e.end)}`)
const LEVEL = { likely: "likely", possible: "possible" }

/** One line under the headline: what's different from the previous briefing, so a returning
 *  reader can tell at a glance whether anything moved. */
export function ChangedSince({ data }: { data: Briefing }) {
  const c = data.change
  if (!c?.prevIssued) return null
  const ev = c.events
  const rank = (e: EventChange) => (e.level === "likely" ? 0 : 1)
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
  const rows: [string, string][] = []
  for (const e of [...ev.new].sort((a, b) => rank(a) - rank(b) || a.start.localeCompare(b.start)).slice(0, 2))
    rows.push(["New", `${cap(e.label)}, ${when(e)}${e.level ? ` (${LEVEL[e.level]})` : ""}`])
  for (const e of ev.upgraded.slice(0, 2)) rows.push(["Raised", `${cap(e.label)}, ${when(e)}, now ${e.level}`])
  for (const e of ev.downgraded.slice(0, 1)) rows.push(["Lowered", `${cap(e.label)}, ${when(e)}, now ${e.level ?? "unlikely"}`])
  for (const e of ev.dropped.slice(0, 1)) rows.push(["Dropped", `${cap(e.label)}, ${when(e)}`])
  for (const e of ev.same.filter((x) => x.shifted).slice(0, 1)) rows.push(["Moved", `${cap(e.label)}, now ${when(e)}`])
  // a region's week total that moved by a quarter inch and 15% or more
  const w = c.windows.find((x) => x.days === 7) ?? c.windows[1] ?? c.windows[0]
  if (w) for (const r of data.regions) {
    const x = w.regions[r.id]
    if (x && Math.abs(x.delta) >= 0.25 && Math.abs(x.delta) >= 0.15 * Math.max(x.prev, 0.01))
      rows.push([x.delta > 0 ? "Wetter" : "Drier", `${r.name}, ${w.label.toLowerCase().replace(/^next /, "")}: ${x.prev.toFixed(2)}″ → ${x.now.toFixed(2)}″`])
  }
  const more = ev.new.length + ev.upgraded.length + ev.downgraded.length + ev.dropped.length - Math.min(ev.new.length, 2) - Math.min(ev.upgraded.length, 2) - Math.min(ev.downgraded.length, 1) - Math.min(ev.dropped.length, 1)
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Since the last update <span className="font-normal text-muted-foreground">· {ptDayHour(c.prevIssued)}</span></h2>
      {rows.length ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
          {rows.map(([k, v], i) => (
            <React.Fragment key={i}><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></React.Fragment>
          ))}
        </dl>
      ) : <p className="text-[13px] text-muted-foreground">No meaningful changes.</p>}
      {more > 0 && <p className="text-xs text-muted-foreground">{more} more change{more > 1 ? "s" : ""} in Impacts to watch.</p>}
    </section>
  )
}
