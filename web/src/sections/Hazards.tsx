import * as React from "react"

import { Anchor, ArrowLeftRight, CalendarDays, ChevronRight, CircleCheck, CloudRain, CloudSnow, type LucideIcon, Mountain, MountainSnow, OctagonAlert,
  Snowflake, Thermometer, ThermometerSnowflake, ThermometerSun, TriangleAlert, Waves, Wind } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { gradLevel, pairName } from "@/lib/gradients"
import { hazardVisuals, SparkBars } from "@/sections/HazardVisuals"
import type { Briefing, Point, WindLevels } from "@/types"
import { dateRange, ptDay } from "@/lib/format"
import { dayStats } from "@/sections/DayMatrix"

export type HazardTab = "precip" | "flood" | "wind" | "coast" | "snow" | "temp"
export type Tone = "quiet" | "watch" | "alert"
interface Item { icon: LucideIcon; text: string }
/** `lead` is the short phrase the overview headline uses when this hazard is the one to lead with. */
export interface Summary { tab: HazardTab; title: string; icon: LucideIcon; items: Item[]; tone: Tone; lead?: string }

const PT = "America/Los_Angeles"
const day = (t: number | string) => ptDay(t)
/** A plain YYYY-MM-DD date read at midday UTC, so it stays on the same calendar day in Pacific time. */
const midday = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T20:00:00Z` : d)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const AR_SHORT = ["Below scale", "AR1", "AR2", "AR3", "AR4", "AR5"]
const AR_WORD = ["", "weak", "moderate", "strong", "extreme", "exceptional"]
const AVY = ["", "Low", "Moderate", "Considerable", "High", "Extreme"]

function precip(d: Briefing): Summary {
  const items: Item[] = []
  const w = d.windows.find((x) => x.days === 7) ?? d.windows[d.windows.length - 1]
  const norm = d.normals?.windows.find((x) => x.days === w?.days)
  let topPct = 0, topRegion = ""
  if (w) {
    for (const r of w.regions) {
      const pct = norm?.regions[r.rid]?.pct
      if (pct != null && pct > topPct) { topPct = pct; topRegion = r.region }
      items.push({ icon: CloudRain, text: `${r.region}: ${r.median.toFixed(1)} in over ${w.label.toLowerCase().replace("next ", "the next ")}${pct != null ? `, ${Math.round(pct)}% of normal` : ""}` })
    }
  }
  if (d.wettest) items.push({ icon: CalendarDays, text: `Wettest stretch ${day(midday(d.wettest.start))} – ${day(midday(d.wettest.end))}, about ${d.wettest.amount.toFixed(1)} in across the locations` })
  const tone: Tone = topPct >= 200 ? "alert" : topPct >= 130 ? "watch" : "quiet"
  const lead = tone !== "quiet" && w ? `${topRegion} rain near ${Math.round(topPct / 10) * 10}% of normal over ${w.label.toLowerCase().replace("next ", "the next ")}` : undefined
  return { tab: "precip", title: "Precip", icon: CloudRain, items, tone, lead }
}

export interface Episode { point: string; start: number; end: number; ranks: [string, number][]; agreed: number; top: number }
/** AR events grouped into episodes: at one coastal point, events from any model that overlap in
 *  time (within 12 h) are the same episode. Each model's peak rank over the episode (0 if it has
 *  none), the rank every model reaches (the lowest of those), and the highest. */
export function arEpisodes(d: Briefing): Episode[] {
  const ar = d.ar
  if (!ar) return []
  const models = ar.models.map((m) => m.model)
  const out: Episode[] = []
  for (const pt of ar.points) {
    const evs = ar.events.filter((e) => e.point === pt && e.rank >= 1)
      .map((e) => ({ ...e, s: Date.parse(e.start), t: Date.parse(e.end) })).sort((a, b) => a.s - b.s)
    let cur: (typeof evs)[number][] = [], curEnd = -Infinity
    const flush = () => {
      if (!cur.length) return
      const ranks = models.map((m) => [m, Math.max(0, ...cur.filter((e) => e.model === m).map((e) => e.rank))] as [string, number])
      const rs = ranks.map(([, r]) => r)
      out.push({ point: pt, start: Math.min(...cur.map((e) => e.s)), end: Math.max(...cur.map((e) => e.t)), ranks,
                 agreed: Math.min(...rs), top: Math.max(...rs) })
      cur = []
    }
    for (const e of evs) {
      if (e.s > curEnd + 12 * 36e5) { flush(); curEnd = -Infinity }
      cur.push(e); curEnd = Math.max(curEnd, e.t)
    }
    flush()
  }
  return out
}

function flood(d: Briefing): Summary {
  const lines: Item[] = []
  let tone: Tone = "quiet"
  let lead: string | undefined
  const eps = arEpisodes(d)
  if (eps.length) {
    // lead with what the models agree on; a split never sets the severity
    const best = [...eps].sort((a, b) => b.agreed - a.agreed || b.top - a.top || a.start - b.start)[0]
    const split = eps.filter((x) => x.top - x.agreed >= 2 && x.top > best.agreed).sort((a, b) => b.top - a.top || a.start - b.start)[0]
    const when = (x: Episode) => `${day(x.start)} – ${day(x.end)}`
    const byModel = (x: Episode) => x.ranks.map(([m, r]) => `${m.replace("ECMWF ", "")} ${r ? AR_SHORT[r] : "none"}`).join(", ")
    if (best.agreed >= 1 && best.top - best.agreed <= 1) {
      const rank = best.agreed === best.top ? `${AR_SHORT[best.agreed]} (${AR_WORD[best.agreed]})` : `${AR_SHORT[best.agreed]} – ${AR_SHORT[best.top]} (${AR_WORD[best.agreed]} to ${AR_WORD[best.top]})`
      lines.push({ icon: Waves, text: `${rank} atmospheric river at ${best.point}, ${when(best)}: ${best.ranks.length > 2 ? `all ${best.ranks.length}` : "both"} models` })
      if (best.agreed >= 3) { tone = "watch"; lead = `${cap(AR_WORD[best.agreed])} atmospheric river at ${best.point} ${when(best)}` }
      if (best.agreed >= 4) tone = "alert"
    } else {
      lines.push({ icon: Waves, text: `Atmospheric river at ${best.point}, ${when(best)}; models split on strength (${byModel(best)})` })
    }
    if (split && split !== best) lines.push({ icon: Waves, text: `Models split at ${split.point}, ${when(split)}: ${byModel(split)}` })
    // one model alone at AR3+ is worth watching, but doesn't name a severity
    const splitTop = Math.max(best.top, split?.top ?? 0)
    if (tone === "quiet" && splitTop >= 3) {
      tone = "watch"
      lead ??= `Atmospheric river at ${(split ?? best).point} ${when(split ?? best)}, models split on strength`
    }
  } else if (d.ar) lines.push({ icon: Waves, text: "No atmospheric river reaches the coast" })
  // river forecasts (NWRFC): the worst forecast crest leads when it reaches minor flood or worse
  const gs = d.rivers?.gauges ?? []
  const worst = [...gs].filter((g) => (g.crest.level ?? 0) >= 1).sort((a, b) => (b.crest.level ?? 0) - (a.crest.level ?? 0) || a.crest.time.localeCompare(b.crest.time))
  if (worst.length) {
    const g = worst[0], lv = g.crest.level ?? 0
    const more = worst.filter((x) => (x.crest.level ?? 0) >= 2).length - (lv >= 2 ? 1 : 0)
    const word = ["", "action stage", "minor flood", "moderate flood", "major flood"][lv]
    lines.unshift({ icon: Waves, text: `${g.name} forecast to crest at ${g.crest.stage.toFixed(1)} ft (${word}) ${day(g.crest.time)}${more > 0 ? `; ${more} more ${more === 1 ? "river reaches" : "rivers reach"} flood stage` : ""}` })
    if (lv >= 3) tone = "alert"
    else if (lv >= 2 && tone === "quiet") tone = "watch"
    if (lv >= 2) lead = `${g.name.replace(/ (near|at|below|above) .*/, "")} forecast to reach ${word} ${day(g.crest.time)}`
  } else if (gs.length) lines.push({ icon: Waves, text: `No river is forecast to reach action stage (${gs.length} gauges)` })
  const ls = d.landslide
  if (ls) {
    let best: { name: string; k: number; n: number; day: number } | null = null
    for (const p of ls.points) {
      ls.days.forEach((_, k) => {
        const vals = p.models.map((m) => m.index[k]).filter((v): v is number => v != null)
        const over = vals.filter((v) => v >= ls.threshold).length
        if (over && (!best || over > best.k)) best = { name: p.name, k: over, n: vals.length, day: k }
      })
    }
    const b = best as { name: string; k: number; n: number; day: number } | null
    if (b) {
      lines.push({ icon: Mountain, text: `Landslide threshold reached at ${b.name} in ${b.k} of ${b.n} models (${day(Date.parse(ls.days[b.day].start) + 12 * 36e5)})` })
      tone = tone === "alert" ? "alert" : "watch"
      lead ??= `Landslide threshold reached at ${b.name} by ${day(Date.parse(ls.days[b.day].start) + 12 * 36e5)}`
    } else lines.push({ icon: Mountain, text: "Landslide threshold not reached" })
  }
  const w7 = d.windows.find((w) => w.days === 7) ?? d.windows[d.windows.length - 1]
  if (w7 && !lines.length) lines.push({ icon: Waves, text: "No flooding signals in this briefing" })
  return { tab: "flood", title: "Flooding", icon: Waves, items: lines, tone, lead }
}

/** Gust levels (config.yaml `impacts`; these defaults match it, for briefings built before the
 *  page carried them): worth watching where scattered outages start, significant at NWS High
 *  Wind Warning strength, or advisory strength at several lowland locations at once. */
const WIND_DEFAULT: WindLevels = {
  wind_gust_mph: { lowland: 40, coast: 50, pass: 60 },
  wind_gust_leaf_mph: { lowland: 35, coast: 50, pass: 60 },
  wind_gust_severe_mph: { lowland: 58, coast: 65, pass: 75 },
  wind_widespread_mph: 45, wind_widespread_points: 3,
  leaf_season: ["09-01", "11-15"], wind_wet_soil_drop_mph: 5,
}
export const windLevels = (d: Briefing): WindLevels => ({ ...WIND_DEFAULT, ...(d.windLevels ?? {}) })
const inLeaf = (L: WindLevels, iso: string) => !!L.leaf_season && L.leaf_season[0] <= iso.slice(5, 10) && iso.slice(5, 10) <= L.leaf_season[1]
/** The "worth watching" gust for a kind of location on a day (the leaf-on level in season). */
export const watchGust = (L: WindLevels, kind: Point["kind"], iso: string) =>
  (inLeaf(L, iso) ? L.wind_gust_leaf_mph ?? L.wind_gust_mph : L.wind_gust_mph)[kind]

/** Wind: the gust events the models agree on (these catch strong lows passing offshore into BC
 *  as well as gradient-driven wind), any location whose median gust reaches outage strength,
 *  and the pressure gradients. Gusts lead; the gradients explain the pattern. */
function wind(d: Briefing): Summary {
  const items: Item[] = []
  let tone = "quiet" as Tone, lead: string | undefined
  const raise = (t: Tone) => { if (t === "alert" || (t === "watch" && tone === "quiet")) tone = t }

  // 1. gust events with model agreement, likely first, then the strongest
  const L = windLevels(d)
  const kindOf = Object.fromEntries(d.points.map((p) => [p.name, p.kind])) as Record<string, Point["kind"]>
  const ev = (d.events ?? []).filter((e) => e.hazard === "wind" && e.points.length)
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "likely" ? -1 : 1) || b.points[0].peak - a.points[0].peak || a.start.localeCompare(b.start))
  for (const e of ev.slice(0, 2)) {
    const p = e.points[0], more = e.points.length - 1
    const where = `${p.name}${more ? ` and ${more} more` : ""}`
    items.push({ icon: Wind, text: `Gusts to ${Math.round(p.peak)} mph at ${where}, ${dateRange(e.start, e.end)}: ${Math.round(100 * e.agreement)}% of ${e.n_models} models` })
  }
  if (ev.length) {
    // significant: a likely event at warning strength somewhere, or at advisory strength at
    // several lowland locations at once (widespread outages rather than scattered ones)
    const severe = (e: (typeof ev)[number]) => e.level === "likely" && (
      e.points.some((x) => kindOf[x.name] && x.peak >= L.wind_gust_severe_mph[kindOf[x.name]]) ||
      e.points.filter((x) => kindOf[x.name] === "lowland" && x.peak >= L.wind_widespread_mph).length >= L.wind_widespread_points)
    const e = ev.find(severe) ?? ev[0], p = e.points[0]
    raise(severe(e) ? "alert" : "watch")
    lead = `Gusts to ${Math.round(p.peak)} mph at ${p.name} ${dateRange(e.start, e.end)}`
  }

  // 2. the median alone reaching outage strength (when fewer models agree than an event needs)
  const gust = dayStats(d, "wind_gusts_10m_max")
  let best: { name: string; v: number; k: number } | null = null
  let bestOver = 0
  for (const p of d.points) {
    gust[p.name]?.forEach((s, k) => {
      const over = s.med == null ? -1 : s.med - watchGust(L, p.kind, d.dates[k])
      if (over >= 0 && (!best || over > bestOver)) { best = { name: p.name, v: s.med!, k }; bestOver = over }
    })
  }
  const b = best as { name: string; v: number; k: number } | null
  if (b && !ev.length) {
    items.push({ icon: Wind, text: `Median gust ${Math.round(b.v)} mph at ${b.name}, ${day(midday(d.dates[b.k]))}, strong enough for scattered outages` })
    raise("watch")
    lead ??= `Gusts near ${Math.round(b.v)} mph at ${b.name} ${day(midday(d.dates[b.k]))}`
  }

  // 3. pressure gradients
  const gs = (d.gradients ?? []).filter((g) => g.series.length)
  type Hit = { g: (typeof gs)[number]; level: number; label: string; t: number; models: Set<string>; n: number }
  const hits: Hit[] = []
  for (const g of gs) {
    let h: Hit | null = null
    for (const s of g.series) {
      s.values.forEach((v, i) => {
        const { level, label } = gradLevel(g, v)
        if (!level) return
        const t = Date.parse(s.times[i])
        // models that reach this time at all (the regional ones stop after a few days)
        const n = g.series.filter((x) => x.times.length && Date.parse(x.times[x.times.length - 1]) >= t - 3 * 36e5).length
        if (!h || level > h.level || (level === h.level && t < h.t)) h = { g, level, label: label!, t, models: h?.level === level ? h.models : new Set(), n }
        if (h.level === level) h.models.add(s.model)
      })
    }
    if (h) hits.push(h)
  }
  hits.sort((a, b) => b.level - a.level || a.t - b.t)
  for (const h of hits.slice(0, items.length >= 2 ? 1 : 2))
    items.push({ icon: ArrowLeftRight, text: `${h.label} (${pairName(h.g)}), ${day(h.t)}: ${h.models.size} of ${h.n} models` })
  const top = hits[0]?.level ?? 0
  if (top) raise(top >= 2 ? "alert" : "watch")
  const h0 = hits[0]
  if (h0 && (!lead || (top >= 2 && tone === "alert" && !ev.some((e) => e.level === "likely"))))
    lead = `${cap(h0.label)} ${day(h0.t)} (${h0.g.codes?.length === 2 && h0.g.codes.every(Boolean) ? h0.g.codes.join("–") : pairName(h0.g)})`

  if (!items.length) items.push({ icon: Wind, text: `No location's gusts reach outage strength (${watchGust(L, "lowland", d.dates[0] ?? "")} mph in the lowlands)` })
  return { tab: "wind", title: "Wind", icon: Wind, items, tone, lead }
}

function snow(d: Briefing): Summary {
  const lines: Item[] = []
  let tone: Tone = "quiet"
  let lead: string | undefined
  const sl = d.snowLevel
  if (sl) {
    const t0 = Date.parse(d.dates[0] + "T12:00:00Z"), t7 = t0 + 7 * 864e5
    let best: { pass: string; elev: number; t: number; models: Set<string>; n: number } | null = null
    for (const p of sl.passes) {
      const models = new Set<string>()
      let first = Infinity
      for (const s of p.series) {
        s.values.forEach((v, i) => {
          const t = Date.parse(s.times[i])
          if (v != null && t <= t7 && v <= p.elev_ft) { models.add(s.model); first = Math.min(first, t) }
        })
      }
      if (models.size && (!best || models.size > best.models.size || (models.size === best.models.size && first < best.t)))
        best = { pass: p.name, elev: p.elev_ft, t: first, models, n: p.series.length }
    }
    const b = best as { pass: string; elev: number; t: number; models: Set<string>; n: number } | null
    if (b) {
      lines.push({ icon: CloudSnow, text: `Snow level reaches ${b.pass} (${b.elev.toLocaleString("en-US")} ft) by ${day(b.t)}: ${b.models.size} of ${b.n} models` })
      tone = "watch"
      lead = `Snow level down to ${b.pass} by ${day(b.t)}`
    } else lines.push({ icon: CloudSnow, text: "Snow level stays above the passes for the next 7 days" })
  }
  const av = d.avalanche
  if (av) {
    if (!av.inSeason) lines.push({ icon: MountainSnow, text: `Avalanche ratings start after ${av.until ? day(av.until + "T20:00:00Z") : "the early season"}` })
    else {
      const top = Math.max(...av.zones.map((z) => z.level))
      const zones = av.zones.filter((z) => z.level === top).length
      lines.push({ icon: MountainSnow, text: `Avalanche danger ${AVY[top] ?? "—"} in ${zones} of ${av.zones.length} zones` })
      if (top >= 3) { tone = "watch"; lead = `${AVY[top]} avalanche danger in the mountains` }
      if (top >= 4) tone = "alert"
    }
  }
  return { tab: "snow", title: "Snow & mountains", icon: Snowflake, items: lines, tone, lead }
}

function temp(d: Briefing): Summary {
  const td = d.tempDeparture
  if (!td) return { tab: "temp", title: "Temperature", icon: Thermometer, items: [{ icon: Thermometer, text: "No normals in this briefing" }], tone: "quiet" }
  const w = td.windows.find((x) => x.days === 7) ?? td.windows[0]
  const avg = (k: "tmax" | "tmin") => {
    const v = Object.values(w.regions).map((r) => r[k]).filter((x): x is number => x != null)
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
  }
  const hi = avg("tmax"), lo = avg("tmin")
  const word = (v: number | null, what: string) =>
    v == null ? null : Math.abs(v) < 1.5 ? `${what} near normal` : `${what} ${Math.round(Math.abs(v))}° ${v > 0 ? "above" : "below"} normal`
  const mean = ((hi ?? 0) + (lo ?? 0)) / 2
  const lines: Item[] = [{ icon: mean > 1.5 ? ThermometerSun : mean < -1.5 ? ThermometerSnowflake : Thermometer,
                           text: [word(hi, "Highs"), word(lo, "lows")].filter(Boolean).join(", ") + ` over ${w.label.toLowerCase()}` }]
  const m = Math.max(Math.abs(hi ?? 0), Math.abs(lo ?? 0))
  const tone: Tone = m >= 8 ? "alert" : m >= 4 ? "watch" : "quiet"
  return { tab: "temp", title: "Temperature", icon: Thermometer, items: lines, tone,
           lead: tone === "quiet" ? undefined : `${word(Math.abs(hi ?? 0) >= Math.abs(lo ?? 0) ? hi : lo, Math.abs(hi ?? 0) >= Math.abs(lo ?? 0) ? "Highs" : "Lows")} this week` }
}

/** Severity lives only in the badge (icon + label), in the impacts table's Likely and Possible
 *  colours; the hazard icon itself stays neutral. */
const TONE: Record<Tone, { label: string; icon: LucideIcon; badge: "secondary" | "possible" | "likely" }> = {
  quiet: { label: "Quiet", icon: CircleCheck, badge: "secondary" },
  watch: { label: "Worth watching", icon: TriangleAlert, badge: "possible" },
  alert: { label: "Significant", icon: OctagonAlert, badge: "likely" },
}

/** Marine warnings, the biggest waves forecast off the coast and the tide closest to flooding. */
function coast(d: Briefing): Summary | null {
  const c = d.coast
  if (!c) return null
  const items: Item[] = []
  let tone = "quiet" as Tone, lead: string | undefined
  const raise = (t: Tone) => { if (t === "alert" || (t === "watch" && tone === "quiet")) tone = t }
  const alerts = [...(c.marineAlerts ?? [])].sort((a, b) => sev(a.event) - sev(b.event))
  for (const a of alerts.slice(0, 1)) {
    const where = (a.areaDesc ?? "").split(";")[0].replace(/^(U\.S\. )?Waters? /i, "").trim()
    items.push({ icon: Anchor, text: `${a.event}${where ? `: ${where}${(a.areaDesc ?? "").includes(";") ? " and more" : ""}` : ""}` })
    if (sev(a.event) <= 1) raise("alert"); else if (sev(a.event) <= 3) raise("watch")
    lead ??= `${a.event.replace(/ (Warning|Advisory|Watch)$/, (m) => m.toLowerCase())} on the water`
  }
  const wave = c.waves.filter((w) => w.area === "Outer coast").flatMap((w) => w.daily.map((x) => ({ w, x }))).sort((a, b) => b.x.max - a.x.max)[0]
  if (wave && wave.x.max >= 12) {
    items.push({ icon: Waves, text: `Seas to ${Math.round(wave.x.max)} ft ${wave.w.name.replace(/^Off /, "off ")}, ${day(midday(wave.x.date))}` })
    if (wave.x.max >= 20) raise("watch")
    lead ??= `Seas to ${Math.round(wave.x.max)} ft on the coast ${day(midday(wave.x.date))}`
  }
  const tide = c.tides.flatMap((g) => g.highs.filter((h) => h.margin != null).map((h) => ({ g, h }))).sort((a, b) => a.h.margin! - b.h.margin!)[0]
  if (tide && tide.h.margin! <= 1) {
    const m = tide.h.margin!
    items.push({ icon: Waves, text: `High tide at ${tide.g.name} ${day(midday(tide.h.time.slice(0, 10)))} ${m <= 0 ? `${Math.abs(m).toFixed(1)} ft over` : `within ${m.toFixed(1)} ft of`} minor flooding` })
    raise(m <= 0 ? "alert" : "watch")
    lead ??= `High tide near flood stage at ${tide.g.name}`
  }
  if (!items.length) items.push({ icon: CircleCheck, text: "No marine warnings, and tides stay well below flood levels" })
  return { tab: "coast", title: "Coast & marine", icon: Anchor, items, tone, lead }
}
const sev = (e: string) => (/hurricane/i.test(e) ? 0 : /storm/i.test(e) && /warning/i.test(e) ? 1 : /gale warning|hazardous seas warning|high surf warning/i.test(e) ? 2 : /warning/i.test(e) ? 3 : 4)

/** The hazard summaries, in tab order. The overview headline and the cards both read these. */
export const summarize = (d: Briefing): Summary[] => [precip(d), flood(d), wind(d), coast(d), snow(d), temp(d)].filter((x): x is Summary => !!x)

/** One summary per hazard tab; each opens its tab. */
export function HazardStrip({ data, onOpen }: { data: Briefing; onOpen: (tab: HazardTab) => void }) {
  const items = React.useMemo(() => summarize(data), [data])
  const vis = React.useMemo(() => hazardVisuals(data), [data])
  return (
    // each card spans five shared rows (header, badge, figure, chart, notes) through subgrid, so the
    // charts and notes line up across a row of cards whatever the caption lengths
    // on phones the cards are a row you swipe through, a peek of the next one showing
    <div className={`grid gap-x-3 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 ${items.length > 5 ? "2xl:grid-cols-6" : "xl:grid-cols-5"} max-sm:-mx-4 max-sm:auto-cols-[82%] max-sm:grid-flow-col max-sm:grid-rows-[repeat(5,auto)] max-sm:snap-x max-sm:snap-mandatory max-sm:scroll-px-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-2`}>
      {items.map((h) => {
        const tone = TONE[h.tone]
        const Icon = h.icon, ToneIcon = tone.icon
        const v = vis[h.tab]
        return (
          <button key={h.tab} type="button" onClick={() => onOpen(h.tab)} aria-label={`${h.title}: ${tone.label}. Open the ${h.title} tab`}
                  className="group row-span-5 grid snap-start grid-rows-subgrid gap-y-0 rounded-xl border bg-card p-4 text-left shadow-xs transition-[background-color,box-shadow] hover:bg-muted/30 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <div className="flex items-center gap-2">
              <Icon className="size-[18px] shrink-0 text-foreground" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 font-medium leading-tight">{h.title}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </div>
            <div className="mt-2.5"><Badge variant={tone.badge} className="gap-1"><ToneIcon />{tone.label}</Badge></div>
            <div className="mt-4">
              {v && (
                <>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[2rem] leading-none font-semibold tracking-tight tabular-nums">{v.value}</span>
                    {v.unit && <span className="text-sm font-medium text-muted-foreground">{v.unit}</span>}
                  </div>
                  <p className="mt-1.5 text-xs leading-snug text-muted-foreground">
                    <span className="text-foreground">{v.caption}</span>{v.aside && <span className="block">{v.aside}</span>}
                  </p>
                </>
              )}
            </div>
            <div>{v?.spark && <SparkBars spark={v.spark} dates={data.dates} />}</div>
            <ul className="mt-4 space-y-2 self-start border-t pt-3 text-sm">
              {h.items.slice(0, v ? 2 : 3).map((it, k) => {
                const ItIcon = it.icon
                return (
                  <li key={it.text} className={`flex gap-2 ${k === 0 ? "text-foreground" : "text-muted-foreground"}`}>
                    <ItIcon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
                    <span className="leading-snug">{it.text}</span>
                  </li>
                )
              })}
            </ul>

          </button>
        )
      })}
    </div>
  )
}
