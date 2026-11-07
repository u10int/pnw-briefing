import * as React from "react"
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { alertColor } from "@/lib/nwsColors"
import type { Alert, Alerts, Briefing } from "@/types"
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
function AlertTimeline({ items, snap }: { items: Alert[]; snap: Alerts }) {
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
        const c = alertColor(a.event)
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
                  <a href={a.url} target="_blank" rel="noopener" className="text-muted-foreground hover:text-foreground" aria-label={`Open ${a.event} on weather.gov`}>
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {a.points.join(", ")}
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
                  {a.sender && <p>Issued by {a.sender}</p>}
                  <p>Covers {a.points.join(", ")}</p>
                  {a.headline && <p className="opacity-80">{a.headline}</p>}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )
      })}
      {snap && <span className="sr-only">Times are Pacific.</span>}
    </div>
  )
}

/**
 * Active NWS alerts for the forecast locations. The build-time snapshot renders first; the page
 * then repeats the same request against api.weather.gov so the list is current when you read it.
 */
export function NwsAlerts({ data }: { data: Briefing }) {
  const snap = data.alerts
  // briefings built before the hazards-page links carry dead alerts.weather.gov URLs: re-point those
  const fixed = React.useMemo(() => (snap?.items ?? []).map((a) => (a.url?.includes("alerts.weather.gov")
    ? { ...a, url: alertUrl(snap, a.points, []) } : a)), [snap])
  const [items, setItems] = React.useState<Alert[]>(fixed)
  const [state, setState] = React.useState<{ live: boolean; at: string | null; error: string | null }>(
    { live: false, at: snap?.fetched ?? null, error: null })

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
        const rank = (e: string) => (/warning/i.test(e) ? 0 : /watch/i.test(e) ? 1 : /advisory/i.test(e) ? 2 : 3)
        out.sort((a, b) => rank(a.event) - rank(b.event) || (a.onset ?? "").localeCompare(b.onset ?? ""))
        setItems(out)
        setState({ live: true, at: new Date().toISOString(), error: null })
      })
      .catch((e) => { if (e.name !== "AbortError") setState((s) => ({ ...s, error: String(e.message ?? e) })) })
    return () => ctl.abort()
  }, [snap])

  if (!snap) return null
  const stamp = (
    <span>
      {snap.demo ? "Demo alerts" : state.live ? "Live" : "As of the briefing"}
      {state.at && `, ${new Date(state.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })}`}
    </span>
  )
  // nothing in effect: one line rather than a card
  if (!items.length && (snap.ok || state.live)) {
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm shadow-xs">
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
        <span>No active NWS watches, warnings or advisories for the forecast locations.</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><RefreshCw className="size-3" aria-hidden />{stamp}</span>
      </div>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>NWS watches, warnings and advisories</CardTitle>
        <CardDescription>
          Official alerts covering the forecast locations, alongside the automated flags below. Times are Pacific; hover a bar for the details and issuing office.
        </CardDescription>
        <CardAction className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="size-3" aria-hidden />
          {stamp}
        </CardAction>
      </CardHeader>
      <CardContent>
        {!snap.ok && !state.live ? (
          <p className="text-sm text-muted-foreground">The NWS alert service didn't answer when this briefing was built. Check weather.gov directly.</p>
        ) : items.length ? (
          <AlertTimeline items={items} snap={snap} />
        ) : (
          <p className="text-sm text-muted-foreground">No active NWS alerts for the forecast locations.</p>
        )}
        {state.error && <p className="mt-2 text-xs text-muted-foreground">Live refresh failed ({state.error}); showing the list from when the briefing was built.</p>}
      </CardContent>
    </Card>
  )
}
