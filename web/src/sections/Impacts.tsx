import * as React from "react"
import { DayHead } from "@/components/DayHead"

import { Card, CardContent } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dateRange, dayShort, issuedLabel, peak, redCell } from "@/lib/format"
import type { Briefing, EventChange, ImpactEvent } from "@/types"

/** Rain first, then winter hazards, then wind and heat (the order of impacts.HAZARDS); anything else after, by first date. */
const HAZARD_ORDER = ["heavy_rain_24h", "heavy_rain_72h", "snow_24h", "freezing_precip", "hard_freeze", "wind", "heat"]

/** What the chips' numbers are, said once per hazard in its header. */
const UNIT_WORD: Record<string, string> = {
  "in/24h": "peak 24-hour total", "in/72h": "peak 72-hour total", "mph": "peak gust",
}
/** A peak, short for a chip: 2.3″, 58 mph, 24°. */
const short = (v: number, unit: string) =>
  unit.startsWith("in") ? `${v.toFixed(1)}″` : unit === "mph" ? `${Math.round(v)} mph` : unit === "°F" ? `${Math.round(v)}°` : peak(v, unit)

type Level = "likely" | "possible"
const LEVEL: Record<Level, { word: string; bar: string; text: string; tint: string }> = {
  likely: { word: "Likely", bar: "var(--likely-bar)", text: "#fff", tint: "var(--likely)" },
  possible: { word: "Possible", bar: "var(--possible-bar)", text: "#3b2400", tint: "var(--possible)" },
}
const LABEL_OF: Record<string, string> = {
  heavy_rain_24h: "Heavy rain", heavy_rain_72h: "Multi-day rain, flood risk", snow_24h: "Snow",
  freezing_precip: "Possible icy precipitation", hard_freeze: "Hard freeze", wind: "Strong gusts", heat: "Heat",
}
const UNIT_OF: Record<string, string> = {
  heavy_rain_24h: "in/24h", heavy_rain_72h: "in/72h", snow_24h: "in/24h", freezing_precip: "°F", hard_freeze: "°F", wind: "mph", heat: "°F",
}
const dayN = (d: string) => Math.round(Date.parse(`${d}T12:00:00Z`) / 864e5)
const nDays = (k: number) => `${Math.abs(k)} day${Math.abs(k) === 1 ? "" : "s"}`
const pct = (v: number) => `${Math.round(v * 100)}%`
/** The event's locations, worst first (the lowest for temperatures). */
const worst = (e: { unit: string; points: { name: string; peak: number }[] }) =>
  [...e.points].sort((a, b) => (e.unit === "°F" ? a.peak - b.peak : b.peak - a.peak))

type Status = { tag: string; tone: "new" | "up" | "down" | "moved" | "same"; detail: string; prev?: [string, string] }
/** How a current event compares with yesterday's briefing. */
function statusOf(e: ImpactEvent, ch: EventChange | undefined, hasPrev: boolean): Status | null {
  if (!hasPrev) return null
  if (!ch) return { tag: "New", tone: "new", detail: "New since yesterday's briefing." }
  const was = ch.prevLevel ? LEVEL[ch.prevLevel].word.toLowerCase() : "flagged"
  let mv: string | null = null
  if (ch.shifted && ch.prevStart && ch.prevEnd) {
    const ds = dayN(e.start) - dayN(ch.prevStart), de = dayN(e.end) - dayN(ch.prevEnd)
    mv = ds === de ? `${nDays(ds)} ${ds > 0 ? "later" : "earlier"}` : ds === 0 ? `ends ${nDays(de)} ${de > 0 ? "later" : "earlier"}`
      : de === 0 ? `starts ${nDays(ds)} ${ds > 0 ? "later" : "earlier"}` : de - ds > 0 ? "longer" : "shorter"
  }
  const prev = ch.shifted && ch.prevStart && ch.prevEnd ? ([ch.prevStart, ch.prevEnd] as [string, string]) : undefined
  const moved = mv ? ` Dates moved ${mv} (yesterday ${dateRange(ch.prevStart!, ch.prevEnd!)}).` : ""
  if (ch.prevLevel && ch.prevLevel !== e.level)
    return e.level === "likely"
      ? { tag: "Upgraded", tone: "up", detail: `Upgraded from ${was}.${moved}`, prev }
      : { tag: "Downgraded", tone: "down", detail: `Downgraded from ${was}.${moved}`, prev }
  if (mv) return { tag: "Moved", tone: "moved", detail: `Same confidence as yesterday.${moved}`, prev }
  return { tag: "", tone: "same", detail: "Unchanged since yesterday." }
}
const TAG: Record<Status["tone"], string> = {
  new: "bg-foreground text-background", up: "border border-[var(--likely-bar)] text-[var(--likely)]",
  down: "border border-dashed border-muted-foreground/60 text-muted-foreground", moved: "border text-muted-foreground", same: "",
}
const Tag = ({ s }: { s: Status }) =>
  s.tag ? <span className={`shrink-0 rounded px-1.5 py-px text-[10px] leading-4 font-semibold whitespace-nowrap ${TAG[s.tone]}`}>
    {s.tone === "up" ? "↑ " : s.tone === "down" ? "↓ " : ""}{s.tag}</span> : null

/** One card for everything about impacts: each hazard's share of models over its threshold day
 *  by day (the agreement strip), the periods where enough agree as bars coloured by confidence
 *  with their worst-hit locations beside them, and what changed since yesterday: a tag on each
 *  period, yesterday's dates as a dashed outline when they moved, and dropped periods as
 *  outlines alone. */
export function ImpactBoard({ data }: { data: Briefing }) {
  const dates = data.dates
  const nd = dates.length
  const minAg = data.meta.minAgreement
  const ch = data.change
  const hasPrev = !!ch
  const changes = ch ? [...ch.events.new, ...ch.events.upgraded, ...ch.events.downgraded, ...ch.events.same] : []
  const dropped = ch?.events.dropped ?? []
  const col = (iso: string) => Math.max(0, Math.min(nd, dayN(iso) - dayN(dates[0])))
  const span = (a: string, b: string) => {
    const s = col(a), e = Math.min(nd, col(b) + 1)
    return { left: `${(100 * s) / nd}%`, width: `${(100 * Math.max(e - s, 0.4)) / nd}%`, cells: e - s }
  }

  // hazards: those with periods, then those whose agreement strip shows a building signal
  const strip = new Map(data.timeline.labels.map((l, i) => [l, data.timeline.matrix[i]]))
  const stripDetail = new Map(data.timeline.labels.map((l, i) => [l, data.timeline.detail?.[i]]))
  const ids = new Set<string>([...data.events.map((e) => e.hazard), ...dropped.map((e) => e.hazard ?? ""),
    ...Object.entries(LABEL_OF).filter(([, l]) => (strip.get(l) ?? []).some((v) => v >= 0.15)).map(([h]) => h)])
  ids.delete("")
  const rank = (h: string) => (HAZARD_ORDER.indexOf(h) + HAZARD_ORDER.length + 1) % (HAZARD_ORDER.length + 1)
  const groups = [...ids].sort((a, b) => rank(a) - rank(b)).map((h) => {
    const evs = data.events.filter((e) => e.hazard === h).sort((a, b) => a.start.localeCompare(b.start))
    const label = evs[0]?.label ?? LABEL_OF[h] ?? h
    return { h, label, unit: evs[0]?.unit ?? UNIT_OF[h] ?? "", evs, drops: dropped.filter((e) => e.hazard === h),
      strip: strip.get(label), detail: stripDetail.get(label) }
  })
  if (!groups.length) {
    return <Card><CardContent className="text-muted-foreground">No hazard reaches the agreement threshold in the next {data.meta.days} days.</CardContent></Card>
  }

  const counts: [number, string][] = hasPrev ? [
    [data.events.filter((e) => statusOf(e, matchChange(e, changes), true)?.tone === "new").length, "new"],
    [ch!.events.upgraded.length, "upgraded"], [ch!.events.downgraded.length, "downgraded"],
    [changes.filter((c) => c.shifted && c.prevLevel === c.level).length, "moved"], [dropped.length, "dropped"],
  ] : []

  const grid = "grid grid-cols-[130px_1fr] sm:grid-cols-[minmax(160px,230px)_1fr] items-center gap-x-4"
  // the label column stays put while the days scroll sideways on a phone
  const pin = "sticky left-0 z-10 bg-card"
  const dayLines = (
    <div className="pointer-events-none absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${nd}, 1fr)` }} aria-hidden>
      {dates.map((d, k) => <div key={d} className={`${k ? "border-l" : ""} border-border/60 ${[0, 6].includes(new Date(`${d}T12:00:00`).getDay()) ? "bg-muted/40" : ""}`} />)}
    </div>
  )
  return (
    <Card>
      <CardContent className="space-y-4">
        {hasPrev && (
          <p className="text-sm text-muted-foreground">
            Since the briefing issued {ch!.prevIssued ? issuedLabel(ch!.prevIssued) : "yesterday"}:{" "}
            {counts.some(([n]) => n) ? counts.filter(([n]) => n > 0).map(([n, w], i) => (
              <span key={w}>{i > 0 && " · "}<span className="font-semibold text-foreground tabular-nums">{n}</span> {w}</span>
            )) : "no changes"}
          </p>
        )}
        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            {/* day header */}
            <div className={`${grid} border-b pb-1.5`}>
              <div className={`self-stretch ${pin}`} />
              <div className="grid text-center text-xs font-medium leading-tight" style={{ gridTemplateColumns: `repeat(${nd}, 1fr)` }}>
                {dates.map((d) => <div key={d}><DayHead day={d} /></div>)}
              </div>
            </div>

            {groups.map((g) => (
              <div key={g.h} className="border-b py-2 last:border-b-0">
                {/* hazard row: name, and each day's share of models over the threshold */}
                <div className={grid}>
                  <div className={`min-w-0 self-stretch py-1 ${pin}`}>
                    <p className="font-semibold leading-tight">{g.label}</p>
                    <p className="text-xs text-muted-foreground">{UNIT_WORD[g.unit] ?? (g.unit ? `peak, ${g.unit}` : "models over the threshold")}</p>
                  </div>
                  <div className="relative h-7">
                    {dayLines}
                    <div className="absolute inset-0 grid items-end" style={{ gridTemplateColumns: `repeat(${nd}, 1fr)` }}>
                      {dates.map((d, k) => {
                        const v = g.strip?.[k] ?? 0
                        const cell = g.detail?.[k]
                        // each model at the most affected location: those over the threshold first, then by value
                        const mods = [...(cell?.models ?? [])].sort((a, b) => Number(b[2]) - Number(a[2]) ||
                          (g.unit === "°F" ? (a[1] ?? 1e9) - (b[1] ?? 1e9) : (b[1] ?? -1e9) - (a[1] ?? -1e9)))
                        return (
                          <Tooltip key={d}>
                            <TooltipTrigger asChild>
                              <div className="flex h-full items-end justify-center px-[18%] outline-none" tabIndex={v > 0 ? 0 : -1}>
                                <div className="w-full rounded-t-[2px]" style={{ height: `${Math.max(v > 0 ? 8 : 0, v * 100)}%`, background: redCell(v).background }} />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="font-semibold">{g.label} · {dayShort(d)}</p>
                              <p>{pct(v)} of {mods.length || "the"} models over the threshold{cell ? ` at ${cell.point}` : " at the most affected location"}</p>
                              {mods.length > 0 && (
                                <div className="mt-1.5 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
                                  {mods.map(([m, val, hit]) => (
                                    <React.Fragment key={m}>
                                      <span className={`flex items-center gap-1.5 ${hit ? "" : "opacity-60"}`}>
                                        <span className={`size-1.5 rounded-full ${hit ? "bg-current" : "border border-current"}`} aria-hidden />{m}
                                      </span>
                                      <span className={`text-right ${hit ? "font-semibold" : "opacity-60"}`}>
                                        {val == null ? "–" : g.unit ? short(val, g.unit) : hit ? "yes" : "no"}
                                      </span>
                                    </React.Fragment>
                                  ))}
                                </div>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        )
                      })}
                    </div>
                    {/* a baseline for the columns to stand on, and the agreement needed to flag a period */}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-muted-foreground/50" />
                    <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted-foreground/50" style={{ bottom: `${minAg * 100}%` }} />
                  </div>
                </div>

                {/* one lane per period */}
                {g.evs.map((e, i) => {
                  const c = matchChange(e, changes)
                  const st = statusOf(e, c, hasPrev)
                  const lv = LEVEL[e.level]
                  const pts = worst(e)
                  const b = span(e.start, e.end)
                  const label = `${lv.word} ${pct(e.agreement)}`
                  return (
                    <div key={i} className={grid}>
                      <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 self-stretch py-1 text-[13px] ${pin}`}>
                        <span className="truncate">
                          {pts[0].name} <span className="font-semibold tabular-nums">{short(pts[0].peak, e.unit)}</span>
                          {pts.length > 1 && <span className="text-muted-foreground"> +{pts.length - 1}</span>}
                        </span>
                        {st && <Tag s={st} />}
                      </div>
                      <div className="relative h-8">
                        {dayLines}
                        {st?.prev && (() => { const p = span(st.prev[0], st.prev[1]); return (
                          <div className="absolute top-1 bottom-1 rounded-[4px] border border-dashed border-muted-foreground/60" style={{ left: p.left, width: p.width }} aria-hidden />
                        ) })()}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div tabIndex={0} aria-label={`${e.label}, ${dateRange(e.start, e.end)}: ${label}`}
                              className="absolute top-1 bottom-1 flex items-center overflow-hidden rounded-[4px] px-1.5 text-[11px] font-semibold whitespace-nowrap tabular-nums shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] outline-offset-1 hover:brightness-105 focus-visible:outline-2 focus-visible:outline-ring"
                              style={{ left: b.left, width: b.width, background: lv.bar, color: lv.text }}>
                              {b.cells >= 2 ? label : b.cells >= 1 ? pct(e.agreement) : ""}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs space-y-1">
                            <p className="font-semibold">{e.label} · {dateRange(e.start, e.end)}</p>
                            <p>{lv.word}: {pct(e.agreement)} of {e.n_models} models over the threshold</p>
                            {st && <p>{st.detail}</p>}
                            <p className="opacity-80">{pts.slice(0, 6).map((p) => `${p.name} ${short(p.peak, e.unit)}`).join(" · ")}{pts.length > 6 ? ` · +${pts.length - 6}` : ""}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  )
                })}

                {/* dropped since yesterday */}
                {g.drops.map((e, i) => {
                  const b = span(e.start, e.end)
                  const was = e.prevLevel ? LEVEL[e.prevLevel].word : "Flagged"
                  return (
                    <div key={`d${i}`} className={grid}>
                      <div className={`flex min-w-0 items-center gap-2 self-stretch py-1 text-[13px] text-muted-foreground ${pin}`}>
                        <span className="truncate">{e.where?.[0]?.name ?? "—"}</span>
                        <span className="shrink-0 rounded border border-dashed border-muted-foreground/60 px-1.5 py-px text-[10px] leading-4 font-semibold">Dropped</span>
                      </div>
                      <div className="relative h-8">
                        {dayLines}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div tabIndex={0} aria-label={`${e.label}, ${dateRange(e.start, e.end)}: dropped`}
                              className="absolute top-1 bottom-1 flex items-center overflow-hidden rounded-[4px] border border-dashed border-muted-foreground/60 px-1.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
                              style={{ left: b.left, width: b.width }}>
                              {b.cells >= 2 ? `was ${was.toLowerCase()}` : ""}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="font-semibold">{e.label} · {dateRange(e.start, e.end)}</p>
                            <p>Dropped: yesterday's briefing had it as {was.toLowerCase()}; today fewer than {pct(minAg)} of models reach the threshold.</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  )
                })}
                {!g.evs.length && !g.drops.length && (
                  <p className="pl-1 text-xs text-muted-foreground">Some models show it, but fewer than {pct(minAg)} at any location.</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* key */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px]" style={{ background: LEVEL.likely.bar }} />Likely (60%+ of models)</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px]" style={{ background: LEVEL.possible.bar }} />Possible ({pct(minAg)}+)</span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-3 items-end gap-px border-b border-muted-foreground/50">{[0.3, 0.7, 1, 0.5].map((h, i) => <span key={i} className="w-1 rounded-t-[1px]" style={{ height: `${h * 100}%`, background: redCell(h).background }} />)}</span>
            Share of models over the threshold each day; dashed line at {pct(minAg)}
          </span>
          {hasPrev && <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px] border border-dashed border-muted-foreground/60" />Yesterday's dates, or dropped</span>}
          <span>Locations: worst first, peak value</span>
        </div>
      </CardContent>
    </Card>
  )
}

/** The change record for a current event (same hazard and dates). */
function matchChange(e: ImpactEvent, changes: EventChange[]) {
  return changes.find((c) => (c.hazard ?? LABEL_OF_REV[c.label]) === e.hazard && c.start === e.start && c.end === e.end)
}
const LABEL_OF_REV = Object.fromEntries(Object.entries(LABEL_OF).map(([h, l]) => [l, h]))
