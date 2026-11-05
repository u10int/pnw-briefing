import { Delta } from "@/components/Delta"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { dateRange, issuedLabel } from "@/lib/format"
import { H, ptMidnight, Timeline, type TimelineBar, type TimelineGroup, type TimelineRow } from "@/sections/Context"
import type { Briefing, EventChange } from "@/types"

const since = (c: NonNullable<Briefing["change"]>) => (c.prevIssued ? issuedLabel(c.prevIssued) : "yesterday")

type Kind = "new" | "upgraded" | "downgraded" | "same" | "dropped"
const LEVEL = {
  likely: { word: "Likely", bg: "var(--likely-bg)", fg: "var(--likely)" },
  possible: { word: "Possible", bg: "var(--possible-bg)", fg: "var(--possible)" },
} as const
const dayN = (d: string) => Date.parse(`${d}T12:00:00Z`) / 864e5
const nDays = (k: number) => `${Math.abs(k)} day${Math.abs(k) === 1 ? "" : "s"}`

/** How an event's dates moved since yesterday, in words; null when they didn't. */
function moved(e: EventChange) {
  if (!e.shifted || !e.prevStart || !e.prevEnd) return null
  const ds = dayN(e.start) - dayN(e.prevStart), de = dayN(e.end) - dayN(e.prevEnd)
  if (ds === de) return `${nDays(ds)} ${ds > 0 ? "later" : "earlier"}`
  if (ds === 0) return `ends ${nDays(de)} ${de > 0 ? "later" : "earlier"}`
  if (de === 0) return `starts ${nDays(ds)} ${ds > 0 ? "later" : "earlier"}`
  return de - ds > 0 ? "longer" : "shorter"
}

function Where({ e }: { e: EventChange }) {
  if (!e.where?.length) return null
  return (
    <p className="opacity-75">
      {e.where.map((w) => `${w.name}${w.peak != null ? ` ${w.peak.toFixed(w.peak >= 10 ? 0 : 1)}${e.unit ? ` ${e.unit}` : ""}` : ""}`).join(" · ")}
    </p>
  )
}

/** Hazards added, upgraded, downgraded, moved or dropped since yesterday's briefing, on the
 *  forecast's day axis: today's events in one row, yesterday's dates for anything that moved or
 *  dropped out in a muted, dashed row beneath. */
export function HazardChanges({ data }: { data: Briefing }) {
  const c = data.change
  const t0 = ptMidnight(data.dates[0]), t1 = t0 + data.dates.length * 24 * H
  const all = c ? (["new", "upgraded", "downgraded", "same", "dropped"] as Kind[]).flatMap((k) => c.events[k].map((e) => ({ k, e }))) : []
  const count = (f: (x: { k: Kind; e: EventChange }) => boolean) => all.filter(f).length
  const counts: [number, string][] = [
    [count((x) => x.k === "new"), "new"], [count((x) => x.k === "upgraded"), "upgraded"], [count((x) => x.k === "downgraded"), "downgraded"],
    [count((x) => x.k !== "dropped" && !!x.e.shifted), "moved"], [count((x) => x.k === "dropped"), "dropped"],
    [count((x) => x.k === "same" && !x.e.shifted), "unchanged"],
  ]

  const byHazard = new Map<string, { label: string; first: number; items: { k: Kind; e: EventChange }[] }>()
  for (const x of all) {
    const id = x.e.hazard ?? x.e.label
    const g = byHazard.get(id) ?? { label: x.e.label, first: Infinity, items: [] }
    g.first = Math.min(g.first, dayN(x.e.start))
    g.items.push(x)
    byHazard.set(id, g)
  }
  const groups: TimelineGroup[] = [...byHazard.entries()].sort((a, b) => a[1].first - b[1].first).map(([id, g]) => {
    const today: TimelineBar[] = [], before: TimelineBar[] = []
    g.items.forEach(({ k, e }, i) => {
      const span = (a: string, b: string) => ({ start: ptMidnight(a), end: ptMidnight(b) + 24 * H })
      const when = dateRange(e.start, e.end)
      if (k === "dropped") {
        before.push({ key: `d${i}`, ...span(e.start, e.end), color: "", ghost: true, label: "Dropped", short: "×",
          aria: `${e.label}, ${when}: dropped since yesterday`,
          tip: <><p className="font-semibold">{e.label} · {when}</p>
                 <p>Dropped: yesterday's briefing had it as {e.prevLevel ? LEVEL[e.prevLevel].word.toLowerCase() : "a flag"}; today no longer reaches the threshold.</p>
                 <Where e={e} /></> })
        return
      }
      const lv = LEVEL[e.level ?? "possible"]
      const mv = moved(e)
      const kind = k === "new" ? "New" : k === "upgraded" ? "Upgraded" : k === "downgraded" ? "Downgraded" : mv ? "Moved" : null
      const status = k === "new" ? "New: not in yesterday's briefing."
        : k === "upgraded" || k === "downgraded" ? `${k === "upgraded" ? "Upgraded" : "Downgraded"} from ${e.prevLevel ? LEVEL[e.prevLevel].word.toLowerCase() : "–"} to ${lv.word.toLowerCase()}.`
        : mv ? "Same confidence as yesterday." : "Unchanged since yesterday."
      today.push({ key: `t${i}`, ...span(e.start, e.end), color: lv.bg, text: lv.fg,
        label: kind ? `${kind} · ${lv.word}` : lv.word, short: kind ?? "",
        aria: `${e.label}, ${when}: ${kind ?? "unchanged"}, ${lv.word.toLowerCase()}`,
        tip: <><p className="font-semibold">{e.label} · {when}</p>
               <p>{status}{mv && e.prevStart && e.prevEnd && ` Moved ${mv} (yesterday: ${dateRange(e.prevStart, e.prevEnd)}).`}</p>
               <p>{lv.word}{e.agreement != null ? `, ${Math.round(e.agreement * 100)}% of models agree` : ""}</p>
               <Where e={e} /></> })
      if (mv && e.prevStart && e.prevEnd)
        before.push({ key: `p${i}`, ...span(e.prevStart, e.prevEnd), color: "", ghost: true, label: "Yesterday's dates", short: "Was",
          aria: `${e.label}: yesterday's dates ${dateRange(e.prevStart, e.prevEnd)}`,
          tip: <><p className="font-semibold">{e.label} · yesterday {dateRange(e.prevStart, e.prevEnd)}</p><p>Now {when}, {mv}.</p></> })
    })
    const rows: TimelineRow[] = []
    if (today.length) rows.push({ key: "now", label: "Today", bars: today })
    if (before.length) rows.push({ key: "prev", label: "Yesterday", bars: before })
    return { key: id, label: g.label, rows }
  })

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>What changed since yesterday</CardTitle>
        <CardDescription>
          {c ? <>Impacts compared with the briefing issued {since(c)}. Changes in rain totals are in the Precip tab.</>
             : "No earlier briefing to compare with yet. This fills in from the second daily run."}
        </CardDescription>
      </CardHeader>
      {c && (
        <CardContent className="space-y-3">
          {all.length ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
                <p className="text-muted-foreground">
                  {counts.filter(([n]) => n > 0).map(([n, w], i) => (
                    <span key={w}>{i > 0 && " · "}<span className="font-semibold text-foreground tabular-nums">{n}</span> {w}</span>
                  ))}
                </p>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {(["likely", "possible"] as const).map((l) => (
                    <span key={l} className="flex items-center gap-1.5">
                      <span className="h-3 w-5 rounded-[3px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]" style={{ background: LEVEL[l].bg }} />{LEVEL[l].word}
                    </span>
                  ))}
                  <span className="flex items-center gap-1.5">
                    <span className="h-3 w-5 rounded-[3px] border border-dashed border-muted-foreground/60" />Yesterday's dates, or dropped
                  </span>
                </div>
              </div>
              <Timeline t0={t0} t1={t1} groups={groups} groupW={150} rowW={76} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No impacts flagged in either briefing.</p>
          )}
        </CardContent>
      )}
    </Card>
  )
}

/** Region totals now vs yesterday's briefing over the same days (Precip tab). */
export function TotalChanges({ data }: { data: Briefing }) {
  const c = data.change
  if (!c) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Totals since yesterday</CardTitle>
        <CardDescription>Region medians compared with the briefing issued {since(c)}, over the days both cover.</CardDescription>
      </CardHeader>
      <CardContent>
        {c.windows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No totals to compare: yesterday's briefing doesn't cover the same days or locations.
          </p>
        ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Window</TableHead>
              {data.regions.map((r) => <TableHead key={r.id} className="text-right">{r.name}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.windows.map((w) => (
              <TableRow key={w.days}>
                <TableCell>
                  {w.label}
                  {w.overlapDays < w.days && <span className="block text-xs text-muted-foreground">same {w.overlapDays} days</span>}
                </TableCell>
                {data.regions.map((r) => {
                  const v = w.regions[r.id]
                  if (!v) return <TableCell key={r.id} className="text-right text-muted-foreground">–</TableCell>
                  return (
                    <TableCell key={r.id} className="text-right">
                      <Delta value={v.delta} />
                      <span className="block text-xs text-muted-foreground tabular-nums">{v.prev.toFixed(1)} → {v.now.toFixed(1)} in</span>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        )}
      </CardContent>
    </Card>
  )
}
