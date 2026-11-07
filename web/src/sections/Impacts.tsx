import * as React from "react"
import { DayHead } from "@/components/DayHead"

import { Card, CardContent } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dateRange, dayShort, issuedLabel, peak, redCell } from "@/lib/format"
import { type MapRequest, openOnMap } from "@/lib/maplink"
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
const LEVEL: Record<Level, { word: string; bar: string; text: string; tint: string; pale: string }> = {
  likely: { word: "Likely", bar: "var(--likely-bar)", text: "#fff", tint: "var(--likely)", pale: "var(--likely-bg)" },
  possible: { word: "Possible", bar: "var(--possible-bar)", text: "#3b2400", tint: "var(--possible)", pale: "var(--possible-bg)" },
}
type Fill = "bold" | "same" | "moved" | "down"
/** Hue is confidence; the fill is what changed since yesterday: solid for new or upgraded (or
 *  with no earlier briefing), the pale fill for unchanged, fainter still for moved, light
 *  stripes for downgraded. Dropped periods are a dashed gray outline. */
function fillStyle(lv: (typeof LEVEL)[Level], f: Fill): React.CSSProperties {
  if (f === "bold") return { background: lv.bar, color: lv.text }
  if (f === "moved") return { background: `color-mix(in srgb, ${lv.pale} 45%, var(--card))`, color: lv.tint }
  if (f === "down") return { background: `repeating-linear-gradient(135deg, color-mix(in srgb, ${lv.bar} 18%, var(--card)) 0 3px, var(--card) 3px 6px)`, color: lv.tint }
  return { background: lv.pale, color: lv.tint }
}
const fillOf = (st: Status | null): Fill =>
  !st || st.tone === "new" || st.tone === "up" ? "bold" : st.tone === "down" ? "down" : st.tone === "moved" ? "moved" : "same"
/** A key swatch in both confidence colours (likely left, possible right), filled like the bars. */
function Swatch({ fill }: { fill: Fill }) {
  const edge = "shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]"
  return (
    <span className="flex h-3 gap-px">
      <span className={`w-3 rounded-l-[3px] ${edge}`} style={fillStyle(LEVEL.likely, fill)} />
      <span className={`w-3 rounded-r-[3px] ${edge}`} style={fillStyle(LEVEL.possible, fill)} />
    </span>
  )
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

/** Area and zone for briefings built before points carried them (config.yaml has the same). */
const AREA_FALLBACK: Record<string, [string, string]> = {
  "Bellingham": ["Northern Puget Sound", "Puget Sound"],
  "Everett": ["Northern Puget Sound", "Puget Sound"],
  "Seattle": ["Central Puget Sound", "Puget Sound"],
  "Tacoma": ["Southern Puget Sound", "Puget Sound"],
  "Olympia": ["Southern Puget Sound", "Puget Sound"],
  "Forks": ["Northern WA coast", "WA coast"],
  "Aberdeen": ["Central WA coast", "WA coast"],
  "Stevens Pass": ["Central WA Cascades", "WA Cascades"],
  "Snoqualmie Pass": ["Central WA Cascades", "WA Cascades"],
  "White Pass": ["Southern WA Cascades", "WA Cascades"],
  "Vancouver WA": ["Portland metro", "Willamette Valley"],
  "Portland": ["Portland metro", "Willamette Valley"],
  "Salem": ["Central Willamette Valley", "Willamette Valley"],
  "Corvallis": ["Southern Willamette Valley", "Willamette Valley"],
  "Astoria": ["Northern OR coast", "OR coast"],
  "Tillamook": ["Northern OR coast", "OR coast"],
  "Government Camp": ["Northern OR Cascades", "OR Cascades"],
  "Vancouver BC": ["Lower Mainland BC", "Southwest BC"],
  "Whistler BC": ["Sea to Sky BC", "Southwest BC"],
}

/** Where a period hit, said briefly: the location when there's one; otherwise the area when they
 *  share one ("Northern Puget Sound"), the zone when they share that ("Puget Sound"), the two zones
 *  ("Puget Sound & WA coast"), the region when they're all in one ("Western Washington"), or the
 *  worst zone and how many more. The count of locations and the worst value follow; hovering
 *  lists every location with its value. */
function WhereLabel({ data, pts, unit, muted }: { data: Briefing; pts: { name: string; peak: number | null }[]; unit: string; muted?: boolean }) {
  if (!pts.length) return <span className="truncate">—</span>
  const byName = new Map(data.points.map((p) => [p.name, p]))
  const area = (n: string) => byName.get(n)?.area ?? AREA_FALLBACK[n]?.[0] ?? n
  const zone = (n: string) => byName.get(n)?.zone ?? AREA_FALLBACK[n]?.[1] ?? area(n)
  const uniq = (f: (n: string) => string) => [...new Set(pts.map((p) => f(p.name)))]   // worst first, as pts are
  const areas = uniq(area), zones = uniq(zone)
  const regions = uniq((n) => byName.get(n)?.region ?? "")
  const regionName = regions.length === 1 && regions[0] ? data.regions.find((r) => r.id === regions[0])?.name : undefined
  // across regions: their short names ("W WA & NW OR"), with a location outside them by its zone
  const broad = uniq((n) => {
    const id = byName.get(n)?.region
    return id ? data.regions.find((r) => r.id === id)?.short ?? id : zone(n).replace(/^Southwest /, "SW ")   // matches "W WA", "NW OR"
  })
  const place = pts.length === 1 ? pts[0].name
    : areas.length === 1 ? areas[0]
    : zones.length === 1 ? zones[0]
    : zones.length === 2 && (zones[0] + zones[1]).length <= 22 ? `${zones[0]} & ${zones[1]}`
    : regionName ?? broad.join(" & ")
  const top = pts[0].peak
  // the place gives way (truncates) before the worst value does
  const text = (
    <span className={`flex min-w-0 items-baseline gap-1 ${muted ? "text-muted-foreground" : ""}`}>
      <span className="truncate">{place}</span>
      {top != null && unit && <span className="shrink-0 font-semibold tabular-nums">{short(top, unit)}</span>}
    </span>
  )
  if (pts.length === 1) return text
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="min-w-0 cursor-default outline-none focus-visible:underline">{text}</span></TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
          {pts.map((p) => (
            <React.Fragment key={p.name}>
              <span>{p.name} <span className="opacity-60">{area(p.name)}</span></span>
              <span className="text-right font-semibold">{p.peak != null && unit ? short(p.peak, unit) : ""}</span>
            </React.Fragment>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

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
                        <WhereLabel data={data} pts={pts} unit={e.unit} />
                        {st && <Tag s={st} />}
                      </div>
                      <div className="relative h-8">
                        {dayLines}
                        {st?.prev && (() => { const p = span(st.prev[0], st.prev[1]); return (
                          <div className="absolute top-1 bottom-1 rounded-[4px] border border-dashed border-muted-foreground/60" style={{ left: p.left, width: p.width }} aria-hidden />
                        ) })()}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button type="button" aria-label={`${e.label}, ${dateRange(e.start, e.end)}: ${label}. Show it on the map`}
                              onClick={() => openOnMap(mapRequestFor(e))}
                              className="absolute top-1 bottom-1 flex cursor-pointer items-center overflow-hidden rounded-[4px] px-1.5 text-[11px] font-semibold whitespace-nowrap tabular-nums shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] outline-offset-1 hover:brightness-105 focus-visible:outline-2 focus-visible:outline-ring"
                              style={{ left: b.left, width: b.width, ...fillStyle(lv, fillOf(st)) }}>
                              {b.cells >= 2 ? label : b.cells >= 1 ? pct(e.agreement) : ""}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs space-y-1">
                            <p className="font-semibold">{e.label} · {dateRange(e.start, e.end)}</p>
                            <p>{lv.word}: {pct(e.agreement)} of {e.n_models} models over the threshold</p>
                            {st && <p>{st.detail}</p>}
                            <p className="opacity-80">{pts.slice(0, 6).map((p) => `${p.name} ${short(p.peak, e.unit)}`).join(" · ")}{pts.length > 6 ? ` · +${pts.length - 6}` : ""}</p>
                            <p className="pt-0.5 opacity-80">Click to see it on the map</p>
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
                        <WhereLabel data={data} pts={e.where ?? []} unit={e.unit ?? ""} muted />
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
          <span>Red: likely (60%+ of models) · Amber: possible ({pct(minAg)}+)</span>
          {hasPrev ? <>
            <span className="flex items-center gap-1.5"><Swatch fill="bold" />New or upgraded</span>
            <span className="flex items-center gap-1.5"><Swatch fill="same" />Unchanged</span>
            <span className="flex items-center gap-1.5"><Swatch fill="moved" />Moved</span>
            <span className="flex items-center gap-1.5"><Swatch fill="down" />Downgraded</span>
          </> : <span className="flex items-center gap-1.5"><Swatch fill="bold" />Period</span>}
          <span className="flex items-center gap-1.5">
            <span className="flex h-3 items-end gap-px border-b border-muted-foreground/50">{[0.3, 0.7, 1, 0.5].map((h, i) => <span key={i} className="w-1 rounded-t-[1px]" style={{ height: `${h * 100}%`, background: redCell(h).background }} />)}</span>
            Share of models over the threshold each day; dashed line at {pct(minAg)}
          </span>
          {hasPrev && <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px] border border-dashed border-muted-foreground/60" />Yesterday's dates, or dropped</span>}
          <span>Where: the area hit and its worst value; hover for each location</span>
          <span>Click a bar to see it on the map</span>
        </div>
      </CardContent>
    </Card>
  )
}

/** Where a period shows best on the hourly map, and when: the layer for its hazard (with fallbacks
 *  for days only the global models reach) on the afternoon of its first day, or the early morning
 *  for a freeze. */
const MAP_LAYER: Record<string, { layer: NonNullable<MapRequest["layer"]>; fallback: NonNullable<MapRequest["layer"]>[]; hourZ: number }> = {
  heavy_rain_24h: { layer: "radar", fallback: ["ivt", "apcp"], hourZ: 24 },
  heavy_rain_72h: { layer: "ivt", fallback: ["radar", "apcp"], hourZ: 24 },
  snow_24h: { layer: "asnow", fallback: ["frz"], hourZ: 24 },
  wind: { layer: "gust", fallback: ["wind", "pgrad"], hourZ: 24 },
  freezing_precip: { layer: "radar", fallback: ["t2m"], hourZ: 18 },
  hard_freeze: { layer: "t2m", fallback: [], hourZ: 38 },     // 6 AM Pacific the next morning
  heat: { layer: "t2m", fallback: [], hourZ: 24 },
}
function mapRequestFor(e: ImpactEvent): MapRequest {
  const m = MAP_LAYER[e.hazard] ?? { layer: "radar" as const, fallback: [], hourZ: 24 }
  const t = Date.parse(`${e.start}T00:00:00Z`) + m.hourZ * 3600e3     // 24Z = 4 PM Pacific on the start day
  return { mode: "hourly", layer: m.layer, fallback: m.fallback, time: new Date(t).toISOString() }
}

/** The change record for a current event (same hazard and dates). */
function matchChange(e: ImpactEvent, changes: EventChange[]) {
  return changes.find((c) => (c.hazard ?? LABEL_OF_REV[c.label]) === e.hazard && c.start === e.start && c.end === e.end)
}
const LABEL_OF_REV = Object.fromEntries(Object.entries(LABEL_OF).map(([h, l]) => [l, h]))
