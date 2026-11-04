import * as React from "react"
import { ExternalLink, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Alert, Briefing } from "@/types"

const zoneId = (u: string) => u.replace(/\/$/, "").split("/").pop()!

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
  const [items, setItems] = React.useState<Alert[]>(snap?.items ?? [])
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
            areaDesc: p.areaDesc, points: pts, url: p.id ? `https://alerts.weather.gov/search?id=${p.id}` : null })
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>NWS watches, warnings and advisories</CardTitle>
        <CardDescription>
          Official alerts covering the forecast locations, alongside the automated flags below.
        </CardDescription>
        <CardAction className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="size-3" aria-hidden />
          <span>
            {snap.demo ? "Demo alerts" : state.live ? "Live" : "As of the briefing"}
            {state.at && `, ${new Date(state.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })}`}
          </span>
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
