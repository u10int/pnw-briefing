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
  const items: string[] = []
  const nw = [...ev.new].sort((a, b) => rank(a) - rank(b) || a.start.localeCompare(b.start)).slice(0, 2)
  if (nw.length) items.push(`new: ${nw.map((e) => `${e.label.toLowerCase()} ${when(e)}${e.level ? ` (${LEVEL[e.level]})` : ""}`).join(", ")}`)
  for (const e of ev.upgraded.slice(0, 2)) items.push(`${e.label.toLowerCase()} ${when(e)} up to ${e.level}`)
  for (const e of ev.downgraded.slice(0, 1)) items.push(`${e.label.toLowerCase()} ${when(e)} down to ${e.level ?? "unlikely"}`)
  for (const e of ev.dropped.slice(0, 1)) items.push(`${e.label.toLowerCase()} ${when(e)} dropped`)
  for (const e of ev.same.filter((x) => x.shifted).slice(0, 1)) items.push(`${e.label.toLowerCase()} moved to ${when(e)}`)
  // a region's week total that moved by a quarter inch and 15% or more
  const w = c.windows.find((x) => x.days === 7) ?? c.windows[1] ?? c.windows[0]
  if (w) for (const r of data.regions) {
    const x = w.regions[r.id]
    if (x && Math.abs(x.delta) >= 0.25 && Math.abs(x.delta) >= 0.15 * Math.max(x.prev, 0.01))
      items.push(`${r.name} ${w.label.toLowerCase().replace(/^next /, "")} rain ${x.delta > 0 ? "up" : "down"} ${Math.abs(x.delta).toFixed(2)}″ to ${x.now.toFixed(2)}″`)
  }
  const more = ev.new.length + ev.upgraded.length + ev.downgraded.length + ev.dropped.length - Math.min(ev.new.length, 2) - Math.min(ev.upgraded.length, 2) - Math.min(ev.downgraded.length, 1) - Math.min(ev.dropped.length, 1)
  return (
    <p className="max-w-[68ch] text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">Changed since {ptDayHour(c.prevIssued)}: </span>
      {items.length ? <>{items.map((x, i) => <span key={i}>{i > 0 && " · "}{i === 0 ? x.charAt(0).toUpperCase() + x.slice(1) : x}</span>)}{more > 0 && ` · ${more} more in the timeline`}.</> : "No meaningful changes."}
    </p>
  )
}
