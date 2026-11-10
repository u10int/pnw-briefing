/** A card's answer in one line, under its title and above the methods text, so the card can be
 *  skimmed without reading the table. */
export function Takeaway({ children }: { children: React.ReactNode }) {
  if (!children) return null
  return <p data-slot="card-takeaway" className="col-start-1 text-sm leading-snug text-pretty text-foreground">{children}</p>
}

/** "Fri 11/13" for a briefing date ("2026-11-13"). */
export const dayOf = (d: string) => new Date(`${d}T20:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "America/Los_Angeles" }).replace(",", "")

/** The point row with the largest (or smallest) lead value, and the day of its own peak. */
export function extreme<R extends { point?: string; name: string; days: (number | null)[]; lead?: number | null }>(rows: R[], low = false, span?: number) {
  let best: R | null = null
  for (const r of rows) {
    if (!r.point || r.lead == null) continue
    if (!best || (low ? r.lead < best.lead! : r.lead > best.lead!)) best = r
  }
  if (!best) return null
  const ds = best.days.slice(0, span ?? best.days.length)
  let k = -1
  ds.forEach((x, i) => { if (x != null && (k < 0 || (low ? x < ds[k]! : x > ds[k]!))) k = i })
  return { row: best, value: best.lead!, day: k, dayValue: k >= 0 ? ds[k]! : null }
}
