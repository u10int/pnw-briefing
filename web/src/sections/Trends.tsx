import * as React from "react"
import { ArrowDownRight, ArrowUpRight, ChevronRight, ChevronsUpDown } from "lucide-react"

import { pctColor } from "@/components/Delta"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ptDay } from "@/lib/format"
import type { Briefing, ByVar, TrendChangeVar, TrendStat, TrendVar } from "@/types"

type Tab = "precip" | "snow" | "wind" | "temp"
const COLS: { k: TrendVar; tab: Tab; head: string; sub: string }[] = [
  { k: "precip", tab: "precip", head: "Precip", sub: "total" },
  { k: "snow", tab: "snow", head: "Snow", sub: "total" },
  { k: "gust", tab: "wind", head: "Wind", sub: "strongest gust, mph" },
  { k: "tmax", tab: "temp", head: "High", sub: "average" },
  { k: "tmin", tab: "temp", head: "Low", sub: "average" },
]
const WHAT: Record<TrendVar, string> = { precip: "Precipitation", snow: "Snowfall", gust: "Strongest gust", tmax: "Average high", tmin: "Average low" }
const inches = (k: TrendVar) => k === "precip" || k === "snow"
export const fmt = (v: number, k: TrendVar) =>
  inches(k) ? `${v >= 10 ? v.toFixed(0) : v.toFixed(v < 1 && k === "precip" ? 2 : 1).replace(/^0\./, ".")}″`
    : k === "gust" ? `${Math.round(v)}` : `${Math.round(v)}°`
export const fmtU = (v: number, k: TrendVar) => `${fmt(v, k)}${k === "gust" ? " mph" : ""}`
// below these a change is noise and isn't shown
export const FLAT: Record<TrendVar, number> = { precip: 0.05, snow: 0.2, gust: 1, tmax: 0.5, tmin: 0.5 }
/** A change worth noticing: the cell gets a faint tint in the change's colour. */
const big = (k: TrendVar, c: TrendChangeVar) =>
  k === "precip" ? Math.abs(c.delta) >= Math.max(0.1, 0.25 * Math.max(c.now, c.prev))
    : k === "snow" ? Math.abs(c.delta) >= 3 : k === "gust" ? Math.abs(c.delta) >= 5 : Math.abs(c.delta) >= 3
/** Models far apart: precip or snow spread over 1.5× the median (and at least half an inch),
 *  gusts 15 mph apart, temperatures 8° apart. */
const unsure = (k: TrendVar, s: TrendStat) =>
  inches(k) ? s.hi - s.lo >= Math.max(0.5, 1.5 * s.median) : k === "gust" ? s.hi - s.lo >= 15 : s.hi - s.lo >= 8
export const UP_COLOR: Record<TrendVar, [string, string]> = {          // [up, down]
  precip: ["var(--wetter)", "var(--drier)"], snow: ["var(--wetter)", "var(--drier)"],
  gust: ["#c2410c", "#0f766e"], tmax: ["#c0392b", "#2c6fbb"], tmin: ["#c0392b", "#2c6fbb"],   // gust: stronger orange, calmer teal
}
const SPARK_SPAN: Record<TrendVar, number> = { precip: 0.5, snow: 2, gust: 10, tmax: 6, tmin: 6 }
const REGION_VAR: Record<string, string> = { wwa: "var(--wwa)", nwor: "var(--nwor)" }
const BAR_COLOR = (k: TrendVar, rid?: string) =>
  k === "tmax" ? "#d6604d" : k === "tmin" ? "#4393c3" : (rid && REGION_VAR[rid]) || "var(--muted-foreground)"
const ask = <T,>(f: () => T, fallback: T): T => { try { return f() } catch { return fallback } }
const STORE = "pnw-trends"

/** The change since yesterday, compact: arrow and signed amount, coloured by direction. */
export function Chg({ c, k }: { c: TrendChangeVar | undefined; k: TrendVar }) {
  if (!c || Math.abs(c.delta) < FLAT[k]) return null
  const up = c.delta > 0
  const Icon = up ? ArrowUpRight : ArrowDownRight
  const d = inches(k) ? Math.abs(c.delta).toFixed(Math.abs(c.delta) < 1 ? (k === "precip" ? 2 : 1) : 1).replace(/^0\./, ".")
    : Math.round(Math.abs(c.delta)).toString()
  return (
    <span className="text-xs font-medium tabular-nums" style={{ color: UP_COLOR[k][up ? 0 : 1] }}>
      {/* plain inline text, so it sits on the value's baseline; the arrow rides on the text */}
      <Icon className="mr-px inline size-3 align-[-1px]" aria-hidden />{up ? "+" : "−"}{d}{k === "tmax" || k === "tmin" ? "°" : ""}
    </span>
  )
}

/** The models' range as a faint band with the median as a mark, on [min, max]. */
function Band({ s, min, max, color }: { s: TrendStat; min: number; max: number; color: string }) {
  const x = (v: number) => Math.max(0, Math.min(100, (100 * (v - min)) / (max - min || 1)))
  return (
    <div className="relative h-3 w-full" aria-hidden>
      <div className="absolute top-[5px] h-0.5 w-full rounded bg-border" />
      <div className="absolute top-[3px] h-1.5 rounded-full opacity-30" style={{ left: `${x(s.lo)}%`, width: `max(4px, ${x(s.hi) - x(s.lo)}%)`, background: color }} />
      <div className="absolute top-0 h-3 w-[3px] -translate-x-1/2 rounded-sm" style={{ left: `${x(s.median)}%`, background: color }} />
    </div>
  )
}

/** The region's value in each recent briefing (oldest left, today right), over dates they all share. */
function Spark({ vals, color, minSpan }: { vals: (number | null)[]; color: string; minSpan: number }) {
  const xs = vals.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null)
  if (xs.length < 2) return null
  // at least `minSpan` tall, so small wobbles stay small instead of filling the line's height
  const a = Math.min(...xs.map((p) => p[1])), b = Math.max(...xs.map((p) => p[1])), mid = (a + b) / 2
  const lo = Math.min(a, mid - minSpan / 2), hi = Math.max(b, mid + minSpan / 2)
  const W = 112, H = 16, pad = 2
  const px = (i: number) => pad + ((W - 2 * pad) * i) / Math.max(1, vals.length - 1)
  const py = (v: number) => (hi - lo < 1e-9 ? H / 2 : pad + (H - 2 * pad) * (1 - (v - lo) / (hi - lo)))
  const d = xs.map(([i, v], j) => `${j ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join("")
  const [li, lv] = xs[xs.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-4 w-28" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.8} />
      <circle cx={px(li)} cy={py(lv)} r={2.2} fill={color} />
    </svg>
  )
}

type Hist = NonNullable<Briefing["trendHistory"]>["windows"][number]

function Cell({ name, w, k, s, c, overlap, region, scale, rid, note, pct, hist }: {
  name: string; w: string; k: TrendVar; s: TrendStat | undefined; c: TrendChangeVar | undefined; overlap?: number
  region?: boolean; scale?: [number, number]; rid?: string; note?: React.ReactNode; pct?: number | null
  hist?: { h: Hist; vals: (number | null)[] }
}) {
  if (!s) return <td className="px-3 py-2 text-right text-muted-foreground">–</td>
  // snow that rounds to nothing is left blank, unless it changed
  const blank = k === "snow" && s.median < 0.05 && !(c && Math.abs(c.delta) >= FLAT.snow)
  if (blank) return <td className="px-3 py-2" />
  const shown = c && Math.abs(c.delta) >= FLAT[k] ? c : undefined
  const tint = shown && big(k, shown) ? `color-mix(in srgb, ${UP_COLOR[k][shown.delta > 0 ? 0 : 1]} 9%, transparent)` : undefined
  const wide = unsure(k, s)
  return (
    <td className="px-3 py-2 align-top" style={{ background: tint }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div tabIndex={0} className="cursor-default outline-none focus-visible:underline">
            {/* the change in a fixed-width slot before the value, so values line up along the right */}
            <div className="flex items-baseline justify-end tabular-nums whitespace-nowrap">
              <span className="w-14 shrink-0 pr-2 text-right"><Chg c={shown} k={k} /></span>
              <span className={`${region ? "font-semibold" : "font-medium"} ${wide ? "underline decoration-muted-foreground/60 decoration-dotted underline-offset-4" : ""}`}>
                {fmt(s.median, k)}
              </span>
            </div>
            {scale && (
              <div className="mt-1.5 ml-auto w-28 space-y-0.5">
                <Band s={s} min={scale[0]} max={scale[1]} color={BAR_COLOR(k, rid)} />
                {hist && <Spark vals={hist.vals} color={BAR_COLOR(k, rid)} minSpan={SPARK_SPAN[k]} />}
              </div>
            )}
            {note && <div className="mt-0.5 text-right text-[11px] font-normal whitespace-nowrap">{note}</div>}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-1">
          <p className="font-semibold">{name} · {w}</p>
          <p>{WHAT[k]}: {fmtU(s.median, k)}, median of {s.n} models (range {fmt(s.lo, k)} – {fmtU(s.hi, k)})</p>
          {wide && <p>The models are far apart here, so treat the median loosely.</p>}
          {pct != null && <p>{Math.round(pct)}% of normal for these days</p>}
          {c && <p>Yesterday {fmtU(c.prev, k)} over the same {overlap} days{shown ? "" : " (no real change)"}</p>}
          {hist && hist.vals.filter((v) => v != null).length > 1 && (
            <div className="pt-1">
              <p className="opacity-80">Last {hist.vals.length} briefings, over {hist.h.nDays} shared day{hist.h.nDays === 1 ? "" : "s"}:</p>
              <div className="grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
                {hist.vals.map((v, i) => (
                  <React.Fragment key={i}>
                    <span className="opacity-80">{hist.h.runs[i] ? (i === hist.vals.length - 1 ? "Today" : ptDay(hist.h.runs[i]!)) : "–"}</span>
                    <span className="text-right">{v == null ? "–" : fmtU(v, k)}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </td>
  )
}

/** Forecast trends: every location, grouped by region, for precipitation, snow, wind and the
 *  average high and low over a chosen window. Each value is the median across models with the
 *  change since yesterday's briefing before it; a tinted cell is a change worth noticing and a
 *  dotted underline a value the models disagree on. Region rows add the models' range, a
 *  sparkline over the last few briefings and the departure from normal; they open to show their
 *  locations. Column headings open their tabs and location names the Locations tab. */
export function TrendsCard({ data, onOpen, onLocation }: { data: Briefing; onOpen: (t: Tab) => void; onLocation: (name: string) => void }) {
  const wins = data.trends?.windows ?? []
  // the chosen window and open regions are remembered in this browser
  const saved = ask(() => JSON.parse(localStorage.getItem(STORE) ?? "{}") as { days?: number; open?: string[] }, {})
  const [days, setDays] = React.useState(saved.days ?? wins[1]?.days ?? wins[0]?.days ?? 7)
  const [open, setOpen] = React.useState<Set<string>>(new Set(saved.open ?? []))
  React.useEffect(() => { ask(() => localStorage.setItem(STORE, JSON.stringify({ days, open: [...open] })), undefined) }, [days, open])
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  if (!wins.length) return null
  const w = wins.find((x) => x.days === days) ?? wins[0]
  const c = data.change?.trends?.windows.find((x) => x.days === w.days)
  const h = data.trendHistory?.windows.find((x) => x.days === w.days)

  // `rid` keys the group's own row: a region id, or "zone:<name>" for locations outside every region
  const groups: { key: string; name: string; rid: string; points: string[] }[] = data.regions.map((r) => ({
    key: r.id, name: r.name, rid: r.id, points: data.points.filter((p) => p.region === r.id).map((p) => p.name),
  }))
  for (const p of data.points.filter((p) => !p.region)) {
    const z = p.zone ?? "Other"
    const g = groups.find((x) => x.key === z) ?? (groups.push({ key: z, name: z, rid: `zone:${z}`, points: [] }), groups[groups.length - 1])
    g.points.push(p.name)
  }
  const allOpen = groups.every((g) => open.has(g.key))

  // one scale per column across the region rows, so the bars compare between regions
  const regionStats = Object.values(w.regions)
  const scaleFor = (k: TrendVar): [number, number] | undefined => {
    const both = k === "tmax" || k === "tmin" ? (["tmax", "tmin"] as TrendVar[]) : [k]   // highs and lows share one, so they compare
    const xs = regionStats.flatMap((r) => both.flatMap((v) => (r[v] ? [r[v]!.lo, r[v]!.hi] : [])))
    if (!xs.length) return undefined
    if (k === "tmax" || k === "tmin") return [Math.floor((Math.min(...xs) - 2) / 5) * 5, Math.ceil((Math.max(...xs) + 2) / 5) * 5]
    const top = Math.max(...xs, k === "gust" ? 30 : 0.1)
    const steps = k === "gust" ? [30, 40, 50, 60, 70, 80, 90, 100] : [0.5, 1, 2, 3, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100]
    return [0, steps.find((x) => x >= top * 1.05) ?? Math.ceil(top * 1.05)]
  }
  const norm = data.normals?.windows.find((x) => x.days === w.days)
  const dep = data.tempDeparture?.windows.find((x) => x.days === w.days)
  const sgn = (v: number) => { const n = Math.round(v); return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}°` }
  const noteFor = (k: TrendVar, rid: string) => {
    if (k === "precip") {
      const p = norm?.regions[rid]?.pct
      return p != null ? <span style={{ color: pctColor(p) }}>{Math.round(p)}% of normal</span> : null
    }
    if (k === "tmax" || k === "tmin") {
      const v = dep?.regions[rid]?.[k]
      return v != null ? <span className="text-muted-foreground">{sgn(v)} vs normal</span> : null
    }
    return null
  }
  const pctFor = (k: TrendVar, point: string) => (k === "precip" ? norm?.points[point]?.pct ?? null : null)

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={String(w.days)} onValueChange={(v) => setDays(Number(v))}>
              <TabsList>{wins.map((x) => <TabsTrigger key={x.days} value={String(x.days)}>{x.label.replace(/^Next /, "")}</TabsTrigger>)}</TabsList>
            </Tabs>
            <Button variant="ghost" size="sm" onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}>
              <ChevronsUpDown aria-hidden />{allOpen ? "Collapse all" : "Expand all"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {c ? <>Arrows: change since yesterday's briefing over the same {c.overlapDays} days.</> : "Changes appear once there's an earlier briefing to compare with."}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] table-fixed border-collapse text-sm">
            <colgroup><col className="w-[150px] sm:w-[190px]" /><col /><col /><col /><col /><col /></colgroup>
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 z-10 bg-card py-2 pr-3 pl-2 text-left font-medium text-muted-foreground">Location</th>
                {COLS.map((col) => (
                  <th key={col.k} className="px-3 py-2 text-right font-medium">
                    <button type="button" onClick={() => onOpen(col.tab)}
                      className="group inline-flex items-center gap-0.5 rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                      {col.head}<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </button>
                    <span className="block text-xs font-normal text-muted-foreground">{col.sub}</span>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key} className="border-b last:border-b-0">
                <tr className="cursor-pointer bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))] hover:bg-muted" onClick={() => toggle(g.key)}>
                  <th scope="row" className="sticky left-0 z-10 bg-inherit py-2 pr-3 pl-1 text-left align-top font-semibold">
                    <button type="button" aria-expanded={open.has(g.key)} onClick={(e) => { e.stopPropagation(); toggle(g.key) }}
                      className="inline-flex items-center gap-1 rounded text-left focus-visible:outline-2 focus-visible:outline-ring">
                      <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open.has(g.key) ? "rotate-90" : ""}`} aria-hidden />
                      {g.name}
                    </button>
                    <span className="block pl-5 text-xs font-normal text-muted-foreground">{g.points.length} locations</span>
                  </th>
                  {COLS.map((col) => (
                    <Cell key={col.k} name={g.name} w={w.label} k={col.k} s={w.regions[g.rid]?.[col.k]} c={c?.regions[g.rid]?.[col.k]}
                      overlap={c?.overlapDays} region scale={scaleFor(col.k)} rid={g.rid} note={noteFor(col.k, g.rid)}
                      pct={col.k === "precip" ? norm?.regions[g.rid]?.pct ?? null : null}
                      hist={h?.regions[g.rid]?.[col.k] ? { h, vals: h.regions[g.rid][col.k]! } : undefined} />
                  ))}
                </tr>
                {open.has(g.key) && g.points.map((n) => {
                  const ps: ByVar<TrendStat> | undefined = w.points[n]
                  return (
                    <tr key={n} className="border-t border-border/50">
                      <th scope="row" className="sticky left-0 z-10 bg-card py-2 pr-3 pl-5 text-left font-normal whitespace-nowrap">
                        <button type="button" onClick={() => onLocation(n)}
                          className="rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring">{n}</button>
                      </th>
                      {COLS.map((col) => <Cell key={col.k} name={n} w={w.label} k={col.k} s={ps?.[col.k]} c={c?.points[n]?.[col.k]}
                        overlap={c?.overlapDays} pct={pctFor(col.k, n)} />)}
                    </tr>
                  )
                })}
              </tbody>
            ))}
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px] bg-[color-mix(in_srgb,var(--wetter)_14%,transparent)]" />A change worth noticing</span>
          <span><span className="font-medium text-foreground underline decoration-muted-foreground/60 decoration-dotted underline-offset-4">2.6″</span> Models far apart</span>
          <span className="flex items-center gap-1.5"><svg viewBox="0 0 28 12" className="h-3 w-7" aria-hidden><path d="M2,9 L10,6 L18,7 L26,3" fill="none" stroke="currentColor" strokeWidth={1.5} /><circle cx={26} cy={3} r={2} fill="currentColor" /></svg>
            Last {h?.runs.length ?? "few"} briefings{h ? `, over the ${h.nDays} day${h.nDays === 1 ? "" : "s"} they share` : ""}</span>
        </div>
      </CardContent>
    </Card>
  )
}
