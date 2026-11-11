import * as React from "react"
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { contrastTextColor } from "@/lib/contrast"
import { alertColor } from "@/lib/nwsColors"
import type { Alert, Alerts, Briefing, EcccAlerts } from "@/types"
import { DayHead } from "@/components/DayHead"

const zoneId = (u: string) => u.replace(/\/$/, "").split("/").pop()!
/** A location's hazards page: from the briefing (`pages`), or, for briefings built before it was
 *  recorded, rebuilt from the location's zone list: its county (C) and two zones (Z), the forecast
 *  zone numbered below the fire weather zone in this region. */
function locationPage(snap: Alerts | null | undefined, point: string) {
  if (snap?.pages?.[point]) return snap.pages[point]
  const ids = snap?.zones?.[point] ?? []
  const zs = ids.filter((z) => /^[A-Z]{2}Z\d{3}$/.test(z)).sort(), county = ids.find((z) => /^[A-Z]{2}C\d{3}$/.test(z))
  if (!zs.length) return null
  return `https://forecast.weather.gov/showsigwx.php?warnzone=${zs[0]}${county ? `&warncounty=${county}` : ""}${zs[1] ? `&firewxzone=${zs[1]}` : ""}`
}
/** Where an alert links (as briefing/alerts.py): the hazards page of the first forecast location it
 *  covers, which shows the alert in full; else the page for the alert's first forecast zone. */
const alertUrl = (snap: Alerts | null | undefined, points: string[], ids: string[]) => {
  for (const p of points) { const u = locationPage(snap, p); if (u) return u }
  const zone = ids.find((z) => /^[A-Z]{2}Z\d{3}$/.test(z))
  return zone ? `https://forecast.weather.gov/showsigwx.php?warnzone=${zone}` : null
}

/** Environment Canada's colour-coded risk levels, as on weather.gc.ca. */
const RISK: Record<string, string> = { yellow: "#ffe11a", orange: "#ff8c1a", red: "#e3262b" }
const RISK_WORD: Record<string, string> = { yellow: "its lowest risk level", orange: "its middle risk level", red: "its highest risk level" }
/** An alert's colour: Environment Canada's risk colour for its alerts, else the NWS hazard colour. */
function colorOf(a: Alert) {
  if (a.source === "eccc") { const bg = RISK[a.colour ?? ""] ?? "#e8e8e8"; return { bg, fg: contrastTextColor(bg) } }
  return alertColor(a.event)
}
const rankOf = (a: Alert) => { const e = (a.type ?? a.event).toLowerCase(); return /warning/.test(e) ? 0 : /watch/.test(e) ? 1 : /advisory/.test(e) ? 2 : 3 }
const byRank = (a: Alert, b: Alert) => rankOf(a) - rankOf(b) || (a.onset ?? "").localeCompare(b.onset ?? "")

// ------------------------------------------------ Environment Canada, live (as briefing/eccc_alerts.py)
type Ring = number[][]
const inRing = (x: number, y: number, r: Ring) => {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function contains(g: { type: string; coordinates: unknown } | null, x: number, y: number) {
  if (!g) return false
  const polys = (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) as Ring[][]
  return polys.some((rs) => rs.length && inRing(x, y, rs[0]) && !rs.slice(1).some((h) => inRing(x, y, h)))
}
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
/** Environment Canada's features (one per alert per forecast region) as alert records for the
 *  locations, an alert's regions joined into one. */
function ecccItems(features: { properties?: Record<string, string | null>; geometry: { type: string; coordinates: unknown } | null }[], snap: EcccAlerts): Alert[] {
  const names = Object.keys(snap.points)
  const groups = new Map<string, Alert & { areas: string[] }>()
  for (const f of features) {
    const a = f.properties ?? {}
    if (/^(ended|cancelled)$/i.test(a.status_en ?? "")) continue
    const hit = names.filter((n) => contains(f.geometry, ...snap.points[n]))
    if (!hit.length) continue
    const key = [a.alert_code, a.risk_colour_en, a.validity_datetime, a.event_end_datetime].join("|")
    let g = groups.get(key)
    if (!g) {
      g = { id: `eccc-${key}`, event: titleCase(a.alert_name_en ?? "Alert"), type: a.alert_type, colour: (a.risk_colour_en ?? "").toLowerCase() || null,
        severity: a.impact_en, certainty: a.confidence_en, urgency: null, headline: (a.alert_text_en ?? "").trim().split("\n")[0] || null,
        onset: a.validity_datetime ?? a.publication_datetime, ends: a.event_end_datetime ?? a.expiration_datetime, issued: a.publication_datetime,
        status: a.status_en, sender: "Environment Canada", areaDesc: null, points: [], source: "eccc", areas: [], url: null }
      groups.set(key, g)
    }
    if (a.feature_name_en && !g.areas.includes(a.feature_name_en)) g.areas.push(a.feature_name_en)
    for (const n of hit) if (!g.points.includes(n)) g.points.push(n)
  }
  return [...groups.values()].map(({ areas, ...g }) => {
    const points = names.filter((n) => g.points.includes(n))
    const [lon, lat] = snap.points[points[0]]      // its page on weather.gc.ca shows the alert in full
    return { ...g, areaDesc: areas.join("; "), points, url: `https://weather.gc.ca/en/location/index.html?coords=${lat.toFixed(3)},${lon.toFixed(3)}` }
  })
}

const PT = "America/Los_Angeles"
const HOUR = 3600e3, DAY = 24 * HOUR
const parts = (t: number) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: PT, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
}).formatToParts(t).map((p) => [p.type, Number(p.value)]))
/** The Pacific midnight at or before t (shifted by `days`). */
function midnight(t: number, days = 0) {
  const p = parts(t)
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  const off = wall - Math.floor(t / 60e3) * 60e3                 // Pacific offset at t
  return Date.UTC(p.year, p.month - 1, p.day + days) - off
}
const dayMD = (t: number) => { const p = parts(t + 12 * HOUR); return `${new Date(t + 12 * HOUR).toLocaleDateString("en-US", { weekday: "short", timeZone: PT })} ${p.month}/${p.day}` }
const hour = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: PT }).replace(":00", "")
const full = (t: number) => `${dayMD(midnight(t))} ${hour(t)}`

/** The badge in the official NWS colour for the event. */
export function AlertBadge({ event }: { event: string }) {
  const c = alertColor(event)
  return <Badge className="border-black/10 font-semibold" style={{ background: c.bg, color: c.fg }}>{event}</Badge>
}

/** Each alert as a bar on a shared Pacific-time axis: whole days from today (or the earliest
 *  onset) to the last end, at most 14 days, with day lines and a "now" marker. */
function AlertTimeline({ items }: { items: Alert[] }) {
  const now = Date.now()
  // the track's width decides how much text fits in a day and in a bar
  const ref = React.useRef<HTMLDivElement>(null)
  const [px, setPx] = React.useState(800)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setPx(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const span = items.map((a) => {
    const s = a.onset ? Date.parse(a.onset) : now
    return { a, s, e: a.ends ? Date.parse(a.ends) : null }
  })
  const t0 = midnight(Math.min(now, ...span.map((x) => x.s)))
  const last = Math.max(now + HOUR, ...span.map((x) => x.e ?? x.s + DAY))
  let nd = Math.max(2, Math.ceil((midnight(last, 1) - t0) / DAY - 0.01))
  nd = Math.min(nd, 14)
  const days = Array.from({ length: nd + 1 }, (_, k) => midnight(t0 + k * DAY + 2 * HOUR))
  const t1 = days[nd]
  const pct = (t: number) => (100 * (Math.min(Math.max(t, t0), t1) - t0)) / (t1 - t0)
  const nowAt = now >= t0 && now <= t1 ? pct(now) : null

  const grid = (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {days.slice(1, -1).map((t) => <div key={t} className="absolute inset-y-0 border-l border-dashed border-border" style={{ left: `${pct(t)}%` }} />)}
      {nowAt != null && <div className="absolute inset-y-0 border-l-2 border-foreground/60" style={{ left: `${nowAt}%` }} />}
    </div>
  )
  return (
    <div className="space-y-1">
      {/* day axis */}
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-4">
        <div className="max-sm:hidden" />
        <div ref={ref} className="relative h-9 text-xs font-medium leading-tight">
          {days.slice(0, -1).map((t, k) => (
            <span key={t} className={`absolute truncate tabular-nums ${px / nd >= 30 ? "px-1.5" : "text-center"}`} style={{ left: `${pct(t)}%`, width: `${pct(days[k + 1]) - pct(t)}%` }}>
              {px / nd >= 34 ? <DayHead day={t + 12 * HOUR} /> : dayMD(t)[0]}
            </span>
          ))}
          {nowAt != null && <span className="absolute -top-0.5 -translate-x-1/2 rounded bg-foreground/80 px-1 text-[10px] font-medium text-background max-sm:hidden" style={{ left: `${nowAt}%`, top: "100%" }}>Now</span>}
        </div>
      </div>
      {span.map(({ a, s, e }) => {
        const c = colorOf(a)
        const l = pct(s), r = e != null ? pct(e) : 100, w = Math.max(r - l, 0.8)
        const cut = e == null || e > t1
        const sameDay = e != null && midnight(s) === midnight(e)
        const label = e == null ? `${full(s)} onward` : sameDay ? `${dayMD(midnight(s))} ${hour(s)} – ${hour(e)}` : `${full(s)} – ${full(e)}`
        const a0 = hour(s), a1 = e == null ? "no end" : hour(e)
        const fits = (w / 100) * px >= (a0.length + a1.length) * 6.5 + 32     // both ends, else just the start
        const fitsOne = (w / 100) * px >= a0.length * 6.5 + 18
        return (
          <div key={a.id} className="grid grid-cols-1 items-center gap-x-4 gap-y-1 border-t py-2 sm:grid-cols-[minmax(0,15rem)_1fr]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/15" style={{ background: c.bg }} aria-hidden />
                <span className="text-sm leading-tight font-medium">{a.event}</span>
                {a.url && (
                  <a href={a.url} target="_blank" rel="noopener" className="text-muted-foreground hover:text-foreground" aria-label={`Open ${a.event} on ${a.source === "eccc" ? "weather.gc.ca" : "weather.gov"}`}>
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {a.points.join(", ")}{a.source === "eccc" && <> · Environment Canada{a.colour ? `, ${a.colour}` : ""}</>}
              </p>
              <p className="mt-0.5 text-xs font-medium tabular-nums sm:hidden">{label}</p>
            </div>
            <div className="relative h-8">
              {grid}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div tabIndex={0} aria-label={`${a.event}: ${label}`}
                    className={`absolute top-1/2 flex h-7 -translate-y-1/2 items-center justify-between gap-2 overflow-hidden px-1.5 text-xs font-medium whitespace-nowrap tabular-nums shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] outline-offset-1 hover:brightness-105 focus-visible:outline-2 focus-visible:outline-ring ${cut ? "rounded-l-[4px]" : "rounded-[4px]"}`}
                    style={{ left: `${l}%`, width: `${w}%`, background: c.bg, color: c.fg }}>
                    {(fits || fitsOne) && <span>{a0}</span>}
                    {fits && <span>{a1}</span>}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs space-y-1">
                  <p className="font-semibold">{a.event}</p>
                  <p>{e == null ? `From ${full(s)}, no end time given` : `${full(s)} to ${full(e)} Pacific`}</p>
                  {a.source === "eccc" && a.colour && <p>{titleCase(a.colour)} {(a.type ?? "alert").toLowerCase()}: Environment Canada's {RISK_WORD[a.colour] ?? "risk level"}{a.severity ? `; impact ${a.severity.toLowerCase()}` : ""}{a.certainty ? `, confidence ${a.certainty.toLowerCase()}` : ""}</p>}
                  {a.sender && <p>Issued by {a.sender}{a.source === "eccc" && a.areaDesc ? ` for ${a.areaDesc}` : ""}</p>}
                  <p>Covers {a.points.join(", ")}</p>
                  {a.headline && <p className="opacity-80">{a.headline}</p>}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )
      })}
      <span className="sr-only">Times are Pacific.</span>
    </div>
  )
}

/**
 * Active alerts for the forecast locations: NWS for Washington and Oregon, Environment Canada for
 * the B.C. locations. The build-time snapshots render first; the page then repeats the same
 * requests (api.weather.gov, api.weather.gc.ca) so the list is current when you read it.
 */
export function NwsAlerts({ data }: { data: Briefing }) {
  const snap = data.alerts
  const ec = data.ecccAlerts ?? null
  // briefings built before the hazards-page links carry dead alerts.weather.gov URLs: re-point those
  const fixed = React.useMemo(() => (snap?.items ?? []).map((a) => (a.url?.includes("alerts.weather.gov")
    ? { ...a, url: alertUrl(snap, a.points, []) } : a)), [snap])
  const [nws, setNws] = React.useState<Alert[]>(fixed)
  const [eccc, setEccc] = React.useState<Alert[]>(ec?.items ?? [])
  const [state, setState] = React.useState<{ live: boolean; at: string | null; error: string | null }>(
    { live: false, at: snap?.fetched ?? ec?.fetched ?? null, error: null })
  const [ecLive, setEcLive] = React.useState(false)

  React.useEffect(() => {
    const zones = snap?.zones ?? {}
    if (!snap || snap.demo || !Object.keys(zones).length) return
    const ctl = new AbortController()
    fetch(`https://api.weather.gov/alerts/active?area=${snap.areas.join(",")}`, {
      headers: { Accept: "application/geo+json" }, signal: ctl.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`NWS returned ${r.status}`))))
      .then((js) => {
        const out: Alert[] = []
        for (const f of js.features ?? []) {
          const p = f.properties ?? {}
          const affected = new Set<string>((p.affectedZones ?? []).map(zoneId))
          const pts = Object.entries(zones).filter(([, zs]) => zs.some((z) => affected.has(z))).map(([n]) => n)
          if (!pts.length) continue
          out.push({ id: p.id, event: p.event, severity: p.severity, certainty: p.certainty, urgency: p.urgency,
            headline: p.headline, onset: p.onset ?? p.effective, ends: p.ends ?? p.expires, sender: p.senderName,
            areaDesc: p.areaDesc, points: pts, url: alertUrl(snap, pts, [...affected]) })
        }
        setNws(out)
        setState({ live: true, at: new Date().toISOString(), error: null })
      })
      .catch((e) => { if (e.name !== "AbortError") setState((s) => ({ ...s, error: `NWS: ${String(e.message ?? e)}` })) })
    return () => ctl.abort()
  }, [snap])

  React.useEffect(() => {
    if (!ec || ec.demo || !Object.keys(ec.points).length) return
    const ctl = new AbortController()
    fetch(`https://api.weather.gc.ca/collections/weather-alerts/items?f=json&lang=en&limit=1000&bbox=${ec.bbox.join(",")}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Environment Canada returned ${r.status}`))))
      .then((js) => { setEccc(ecccItems(js.features ?? [], ec)); setEcLive(true) })
      .catch((e) => { if (e.name !== "AbortError") setState((s) => ({ ...s, error: [s.error, `Environment Canada: ${String(e.message ?? e)}`].filter(Boolean).join("; ") })) })
    return () => ctl.abort()
  }, [ec])

  if (!snap && !ec) return null
  const items = [...nws, ...eccc].sort(byRank)
  const demo = !!(snap?.demo || ec?.demo)
  const live = (!snap || state.live) && (!ec || ecLive)
  const stamp = (
    <span>
      {demo ? "Demo alerts" : live ? "Live" : "As of the briefing"}
      {!live && !demo && (state.live || ecLive) ? ` (${state.live ? "NWS" : "Environment Canada"} live)` : ""}
      {state.at && `, ${new Date(state.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })}`}
    </span>
  )
  const who = ec ? "NWS or Environment Canada" : "NWS"
  const down = [snap && !snap.ok && !state.live ? "NWS" : null, ec && !ec.ok && !ecLive ? "Environment Canada" : null].filter(Boolean) as string[]
  const anyEccc = items.some((a) => a.source === "eccc")
  // nothing in effect: one line rather than a card
  if (!items.length && !down.length) {
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm shadow-xs">
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
        <span>No active {who} watches, warnings or advisories for the forecast locations.</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><RefreshCw className="size-3" aria-hidden />{stamp}</span>
      </div>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{ec ? "Watches, warnings and advisories" : "NWS watches, warnings and advisories"}</CardTitle>
        <CardDescription>
          Official alerts covering the forecast locations{ec ? ": the NWS for Washington and Oregon, Environment Canada for the B.C. locations" : ""}, alongside the automated flags below. Times are Pacific; hover a bar for the details and who issued it.
        </CardDescription>
        <CardAction className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="size-3" aria-hidden />
          {stamp}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {down.length > 0 && <p className="text-sm text-muted-foreground">{down.join(" and ")}'s alert service didn't answer when this briefing was built. Check {down.map((d) => (d === "NWS" ? "weather.gov" : "weather.gc.ca")).join(" and ")} directly.</p>}
        {items.length ? (
          <AlertTimeline items={items} />
        ) : !down.length ? (
          <p className="text-sm text-muted-foreground">No active {who} alerts for the forecast locations.</p>
        ) : null}
        {anyEccc && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Environment Canada alerts are coloured by its risk level:</span>
            {Object.entries(RISK).map(([k, c]) => <span key={k} className="flex items-center gap-1.5"><span className="size-2.5 rounded-full ring-1 ring-black/15" style={{ background: c }} aria-hidden />{k}</span>)}
          </p>
        )}
        {state.error && <p className="text-xs text-muted-foreground">Live refresh failed ({state.error}); showing the list from when the briefing was built.</p>}
      </CardContent>
    </Card>
  )
}
