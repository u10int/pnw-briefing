import * as React from "react"
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Alert, Alerts, Briefing } from "@/types"

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

/** Warning red, watch amber, advisory blue, statements gray: the usual NWS reading order. */
function variantFor(event: string): "likely" | "possible" | "regional" | "secondary" {
  const e = event.toLowerCase()
  if (e.includes("warning")) return "likely"
  if (e.includes("watch")) return "possible"
  if (e.includes("advisory")) return "regional"
  return "secondary"
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", timeZone: "America/Los_Angeles" }) : "–"

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
          Official alerts covering the forecast locations, alongside the automated flags below.
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
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Alert</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Until</TableHead>
                <TableHead>Forecast locations</TableHead>
                <TableHead>Issued by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant={variantFor(a.event)}>{a.event}</Badge>
                      {a.url && (
                        <a href={a.url} target="_blank" rel="noopener" className="text-muted-foreground hover:text-foreground" aria-label={`Open ${a.event} on weather.gov`}>
                          <ExternalLink className="size-3.5" />
                        </a>
                      )}
                    </div>
                    {a.headline && <p className="mt-1 max-w-[52ch] text-xs whitespace-normal text-muted-foreground">{a.headline}</p>}
                  </TableCell>
                  <TableCell className="tabular-nums">{when(a.onset)}</TableCell>
                  <TableCell className="tabular-nums">{when(a.ends)}</TableCell>
                  <TableCell className="whitespace-normal">{a.points.join(", ")}</TableCell>
                  <TableCell className="text-muted-foreground">{a.sender?.replace(/^NWS /, "") ?? "–"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No active NWS alerts for the forecast locations.</p>
        )}
        {state.error && <p className="mt-2 text-xs text-muted-foreground">Live refresh failed ({state.error}); showing the list from when the briefing was built.</p>}
      </CardContent>
    </Card>
  )
}
