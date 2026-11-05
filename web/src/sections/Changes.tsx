import * as React from "react"

import { Delta } from "@/components/Delta"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { dateRange, issuedLabel } from "@/lib/format"
import { H, ptMidnight, Timeline, type TimelineBar, type TimelineGroup, type TimelineRow } from "@/sections/Context"
import type { Briefing, EventChange } from "@/types"

const since = (c: NonNullable<Briefing["change"]>) => (c.prevIssued ? issuedLabel(c.prevIssued) : "yesterday")

type Kind = "new" | "upgraded" | "downgraded" | "same" | "dropped"
/** Hue is confidence; weight is what changed: a solid fill for new or upgraded, the pale fill for
 *  unchanged, a faded fill for moved, light stripes for downgraded, gray and dashed for yesterday's dates. */
const LEVEL = {
  likely: { word: "Likely", bg: "var(--likely-bg)", fg: "var(--likely)", bold: "var(--likely-bar)", boldText: "#fff" },
  possible: { word: "Possible", bg: "var(--possible-bg)", fg: "var(--possible)", bold: "var(--possible-bar)", boldText: "#3b2400" },
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

/** A legend swatch in both confidence colors (likely left, possible right), drawn like the bars. */
function Swatch({ kind }: { kind: "bold" | "same" | "moved" | "down" }) {
  const half = (l: (typeof LEVEL)["likely" | "possible"]) => {
    const fill = kind === "bold" ? l.bold : kind === "moved" ? `color-mix(in srgb, ${l.bg} 45%, var(--card))`
      : kind === "down" ? `color-mix(in srgb, ${l.bold} 18%, var(--card))` : l.bg
    return {
      background: kind === "down" ? `repeating-linear-gradient(135deg, ${fill} 0 3px, var(--card) 3px 6px)` : fill,
    }
  }
  const edge = "shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]"
  return (
    <span className="flex h-3 gap-px">
      <span className={`w-3 rounded-l-[3px] ${edge}`} style={half(LEVEL.likely)} />
      <span className={`w-3 rounded-r-[3px] ${edge}`} style={half(LEVEL.possible)} />
    </span>
  )
}

const Key = ({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) => (
  <span className="flex items-center gap-1.5">{swatch}{children}</span>
)

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
  const span = (a: string, b: string) => ({ start: ptMidnight(a), end: ptMidnight(b) + 24 * H })
  const groups: TimelineGroup[] = [...byHazard.entries()].sort((a, b) => a[1].first - b[1].first).map(([id, g]) => {
    // one lane per event: the row label says what changed, the bar shows today's dates and
    // confidence; a moved event also shows yesterday's dates (dashed) in its own lane
    const lanes = g.items.map(({ k, e }, i) => {
      const when = dateRange(e.start, e.end)
      if (k === "dropped") {
        const bar: TimelineBar = { key: `d${i}`, ...span(e.start, e.end), color: "", ghost: true,
          label: e.prevLevel ? LEVEL[e.prevLevel].word : "", short: e.prevLevel ? LEVEL[e.prevLevel].word[0] : "",
          aria: `${e.label}, ${when}: dropped since yesterday`,
          tip: <><p className="font-semibold">{e.label} · {when}</p>
                 <p>Dropped: yesterday's briefing had it as {e.prevLevel ? LEVEL[e.prevLevel].word.toLowerCase() : "a flag"}; today no longer reaches the threshold.</p>
                 <Where e={e} /></> }
        return { sort: dayN(e.start), row: { key: `r${i}`, label: "Dropped", bars: [bar] } as TimelineRow }
      }
      const lv = LEVEL[e.level ?? "possible"]
      const mv = moved(e)
      const kind = k === "new" ? "New" : k === "upgraded" ? "Upgraded" : k === "downgraded" ? "Downgraded" : mv ? "Moved" : "Unchanged"
      const bold = k === "new" || k === "upgraded"
      const status = k === "new" ? "New: not in yesterday's briefing."
        : k === "upgraded" || k === "downgraded" ? `${k === "upgraded" ? "Upgraded" : "Downgraded"} from ${e.prevLevel ? LEVEL[e.prevLevel].word.toLowerCase() : "–"} to ${lv.word.toLowerCase()}.`
        : mv ? "Same confidence as yesterday." : "Unchanged since yesterday."
      const bars: TimelineBar[] = []
      const now = span(e.start, e.end)
      if (mv && e.prevStart && e.prevEnd) {
        const was = span(e.prevStart, e.prevEnd)
        const apart = was.end <= now.start || now.end <= was.start
        // yesterday's confidence, muted; only when the bar doesn't cover the start of the old dates
        const prevWord = LEVEL[e.prevLevel ?? e.level ?? "possible"].word
        bars.push({ key: `p${i}`, ...was, color: "", ghost: true, label: apart ? prevWord : "", short: apart ? prevWord[0] : "",
          aria: `${e.label}: yesterday's dates ${dateRange(e.prevStart, e.prevEnd)}`,
          tip: <><p className="font-semibold">{e.label} · yesterday {dateRange(e.prevStart, e.prevEnd)}</p><p>Now {when}, {mv}.</p></> })
        // a gap between the old and new dates gets an arrow from one to the other
        if (was.end < now.start) bars.push({ key: `l${i}`, start: was.end, end: now.start, color: "", link: "right", label: "", aria: "", tip: null })
        else if (now.end < was.start) bars.push({ key: `l${i}`, start: now.end, end: was.start, color: "", link: "left", label: "", aria: "", tip: null })
      }
      // downgraded stripes use a light mix of the strong color: the pale fill alone barely shows
      const fill = bold ? lv.bold : kind === "Downgraded" ? `color-mix(in srgb, ${lv.bold} 18%, var(--card))` : lv.bg
      bars.push({ key: `t${i}`, ...now, color: fill, text: bold ? lv.boldText : lv.fg,
        faded: kind === "Moved", hatch: kind === "Downgraded",
        label: lv.word, short: lv.word[0],
        aria: `${e.label}, ${when}: ${kind.toLowerCase()}, ${lv.word.toLowerCase()}`,
        tip: <><p className="font-semibold">{e.label} · {when}</p>
               <p>{status}{mv && e.prevStart && e.prevEnd && ` Moved ${mv} (yesterday: ${dateRange(e.prevStart, e.prevEnd)}).`}</p>
               <p>{lv.word}{e.agreement != null ? `, ${Math.round(e.agreement * 100)}% of models agree` : ""}</p>
               <Where e={e} /></> })
      return { sort: dayN(e.start), row: { key: `r${i}`, label: kind, bars } as TimelineRow }
    })
    return { key: id, label: g.label, rows: lanes.sort((a, b) => a.sort - b.sort).map((l) => l.row) }
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
              <p className="text-sm text-muted-foreground">
                {counts.filter(([n]) => n > 0).map(([n, w], i) => (
                  <span key={w}>{i > 0 && " · "}<span className="font-semibold text-foreground tabular-nums">{n}</span> {w}</span>
                ))}
              </p>
              <Timeline t0={t0} t1={t1} groups={groups} groupW={150} rowW={84} />
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <Key swatch={<Swatch kind="bold" />}>New or upgraded</Key>
                <Key swatch={<Swatch kind="same" />}>Unchanged</Key>
                <Key swatch={<Swatch kind="moved" />}>Moved</Key>
                <Key swatch={<Swatch kind="down" />}>Downgraded</Key>
                <Key swatch={<span className="h-3 w-5 rounded-[3px] border border-dashed border-muted-foreground/60" />}>Yesterday's dates, or dropped</Key>
                <span>Red: likely · Amber: possible</span>
              </div>
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
