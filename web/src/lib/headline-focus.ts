/** What the headline is about, as a map: the grid to show (a window total or extreme), the
 *  places to mark, and the area to frame. Worked out from the headline's wording (the same way the
 *  overview strip finds the headline's hazard), so the preview map always matches the text. */
import type { MapRequest } from "@/lib/maplink"
import { GUST, PRECIP, type Ramp, SNOW, TEMP, WAVE } from "@/lib/ramps"
import type { Briefing, Cog, ImpactEvent } from "@/types"

export interface Mark { lon: number; lat: number; label: string }
export interface Focus {
  /** what the colours show, and over which window: "Strongest gust, through tomorrow" */
  title: string
  cog: Cog | null
  ramp: Ramp | null
  marks: Mark[]
  /** what the labels on the marks are: a sentence (for screen readers) and a few words (on the map) */
  markNote: string | null
  markLabel: string | null
  /** the area to frame, [[west, south], [east, north]] */
  bounds: [[number, number], [number, number]]
  req: MapRequest
}

type Fam = "wind" | "surf" | "rain" | "snow" | "heat" | "cold" | "river"
const GRID: Partial<Record<Fam, { v: Cog["var"]; ramp: Ramp; label: string }>> = {
  wind: { v: "gust", ramp: { ...GUST, label: "Strongest gust" }, label: "Strongest gust" },
  surf: { v: "waves", ramp: { ...WAVE, label: "Highest waves" }, label: "Highest waves" },
  rain: { v: "precip", ramp: PRECIP, label: "Precipitation" },
  snow: { v: "snow", ramp: SNOW, label: "Snowfall" },
  heat: { v: "tmax", ramp: { ...TEMP, label: "Highest temperature" }, label: "Highest temperature" },
  cold: { v: "tmin", ramp: { ...TEMP, label: "Lowest temperature" }, label: "Lowest temperature" },
}
const EVENTS: Partial<Record<Fam, (h: string) => boolean>> = {
  wind: (h) => h === "wind",
  rain: (h) => h.startsWith("heavy_rain"),
  snow: (h) => h.startsWith("snow"),
  heat: (h) => /heat/.test(h),
  cold: (h) => /freez|cold/.test(h),
}
const FAMS: [Fam, RegExp][] = [
  ["wind", /\b(wind|winds|windy|gusts?|gusty)\b/], ["surf", /\b(surf|waves?|seas)\b/],
  ["rain", /\b(rain|rainy|atmospheric river|downpours?|flood risk)\b/], ["snow", /\bsnow/],
  ["heat", /\b(heat|hot|warm)/], ["cold", /\b(cold|freez|frost|chill)/], ["river", /\brivers?\b|\bflooding\b/],
]

/** The headline's families in the order it mentions them ("atmospheric river" is rain, not a river). */
function families(headline: string): Fam[] {
  const h = headline.toLowerCase()
  const bare = h.replace(/atmospheric rivers?/g, (m) => " ".repeat(m.length))   // same positions
  return FAMS.map(([f, re]) => ({ f, m: (f === "river" ? bare : h).match(re) }))
    .filter((x) => x.m).sort((a, b) => a.m!.index! - b.m!.index!).map((x) => x.f)
}

const pacificDay = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })

export function headlineFocus(data: Briefing, fallbackHazard?: string | null): Focus | null {
  const fams = families(data.summary?.headline ?? "")
  if (!fams.length && fallbackHazard) {
    const f = (Object.keys(EVENTS) as Fam[]).find((k) => EVENTS[k]!(fallbackHazard))
    if (f) fams.push(f)
  }
  const issued = Date.parse(data.meta.issued)
  const near = pacificDay(issued + 3 * 86400e3)
  const soonEvents = (f: Fam) => data.events.filter((e) => EVENTS[f]?.(e.hazard) && e.start <= near)
  const pts = new Map(data.points.map((p) => [p.name, p]))
  const marks: Mark[] = []
  const seen = new Set<string>()
  const add = (m: Mark) => {
    const k = `${m.lon.toFixed(3)},${m.lat.toFixed(3)}`
    if (!seen.has(k)) { seen.add(k); marks.push(m) }
  }
  const fmt = (e: ImpactEvent, peak: number) =>
    e.unit === "mph" ? `${Math.round(peak)} mph` : e.unit === "in" ? `${peak.toFixed(1)}″` : e.unit === "°F" ? `${Math.round(peak)}°` : `${Math.round(peak)} ${e.unit}`

  // the places behind each family the headline names
  let lastDay = data.dates[0]
  for (const f of fams) {
    if (f === "surf") {
      for (const w of data.coast?.waves ?? []) {
        const big = w.daily.filter((d) => d.date <= near && d.date >= pacificDay(issued) && d.max >= 12)
        if (big.length) add({ lon: w.lon, lat: w.lat, label: `${Math.round(Math.max(...big.map((d) => d.max)))} ft` })
      }
    } else if (f === "river") {
      for (const g of data.rivers?.gauges ?? []) if ((g.crest?.level ?? 0) >= 2) add({ lon: g.lon, lat: g.lat, label: g.name.replace(/ (near|at|above|below) .*/, "") })
    } else {
      for (const e of soonEvents(f)) {
        if (e.end > lastDay) lastDay = e.end
        for (const p of e.points) {
          const at = pts.get(p.name)
          if (at && p.frac > 0) add({ lon: at.lon, lat: at.lat, label: fmt(e, p.peak) })
        }
      }
    }
  }

  // the grid: the first family the headline names that has one (high surf: the wave forecast,
  // else the wind behind it)
  const cands = fams.flatMap((f) => (f === "surf" ? ["surf", "wind"] : [f])).filter((f) => GRID[f as Fam]) as Fam[]
  let cog: Cog | null = null
  let g: (typeof GRID)[Fam] | null = null
  for (const f of cands) {
    const gg = GRID[f]!
    const need = Math.max(1, data.dates.indexOf(lastDay) + 1)
    const of = (data.cogs ?? []).filter((c) => c.var === gg.v)
    if (!of.length) continue
    const days = [...new Set(of.map((c) => c.days))].sort((a, b) => a - b)
    const d = days.find((x) => x >= need) ?? days[days.length - 1]
    const at = of.filter((c) => c.days === d)
    cog = at.find((c) => c.model === "Model mean") ?? at.find((c) => c.tier === "regional") ?? at[0] ?? null
    g = gg
    if (cog) break
  }
  if (!cog && !marks.length) return null

  // frame the marks with a little room around them, never tighter than a degree or two
  const dom = data.domain
  let bounds: Focus["bounds"] = [[dom.lon_min, dom.lat_min], [dom.lon_max, dom.lat_max]]
  if (marks.length) {
    let w = Math.min(...marks.map((m) => m.lon)), e = Math.max(...marks.map((m) => m.lon))
    let s = Math.min(...marks.map((m) => m.lat)), n = Math.max(...marks.map((m) => m.lat))
    const padX = Math.max(0.3, (2.0 - (e - w)) / 2), padY = Math.max(0.2, (1.2 - (n - s)) / 2)
    w = Math.max(dom.lon_min, w - padX); e = Math.min(dom.lon_max, e + padX)
    s = Math.max(dom.lat_min, s - padY); n = Math.min(dom.lat_max, n + padY)
    bounds = [[w, s], [e, n]]
  }
  const win = cog ? data.windows.find((w) => w.days === cog!.days)?.label.toLowerCase() ?? `next ${cog.days} days` : null
  const title = g && cog ? `${g.label}, ${win}${g.v === "waves" ? ` (${cog.model})` : ""}` : fams.includes("river") ? "Rivers forecast to flood" : "High surf"
  const req: MapRequest = cog ? { mode: "totals", variable: cog.var, days: cog.days, model: cog.model } : { mode: "totals", variable: "rivers" }
  const NOTE: Partial<Record<Fam, string>> = {
    surf: "Labels: highest waves at the offshore forecast points", river: "Marked: rivers forecast to flood",
    wind: "Labels: peak gust at each affected location", rain: "Labels: heaviest rain at each affected location",
    snow: "Labels: most snow at each affected location", heat: "Labels: highest temperature", cold: "Labels: lowest temperature",
  }
  const SHORT: Partial<Record<Fam, string>> = { surf: "highest waves", river: "rivers in flood", wind: "peak gusts", rain: "heaviest rain", snow: "most snow" }
  const markNote = marks.length ? (fams.map((f) => NOTE[f]).find(Boolean) ?? null) : null
  const markLabel = marks.length ? (fams.map((f) => SHORT[f]).find(Boolean) ?? null) : null
  return { title, cog, ramp: g?.ramp ?? null, marks, markNote, markLabel, bounds, req }
}
