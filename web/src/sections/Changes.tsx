import { Delta } from "@/components/Delta"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { dateRange, issuedLabel } from "@/lib/format"
import type { Briefing, EventChange } from "@/types"

const KIND: Record<string, { label: string; variant: "likely" | "possible" | "secondary" | "outline" }> = {
  new: { label: "New", variant: "likely" },
  upgraded: { label: "Upgraded", variant: "likely" },
  downgraded: { label: "Downgraded", variant: "possible" },
  dropped: { label: "Dropped", variant: "outline" },
}

const levelName = (l: EventChange["level"]) => (l === "likely" ? "Likely" : l === "possible" ? "Possible" : "")

const since = (c: NonNullable<Briefing["change"]>) => (c.prevIssued ? issuedLabel(c.prevIssued) : "yesterday")

/** Hazards added, upgraded, downgraded or dropped since yesterday's briefing (overview). */
export function HazardChanges({ data }: { data: Briefing }) {
  const c = data.change
  const rows = c ? (["new", "upgraded", "downgraded", "dropped"] as const).flatMap((k) => c.events[k].map((e) => ({ k, e }))) : []
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>What changed since yesterday</CardTitle>
        <CardDescription>
          {c ? <>Impacts compared with the briefing issued {since(c)}. Changes in rain totals are in the Precip tab.</>
             : "No earlier briefing to compare with yet. This fills in from the second daily run."}
        </CardDescription>
      </CardHeader>
      {c && (
        <CardContent>
          {rows.length ? (
            <ul className="divide-y text-sm">
              {rows.map(({ k, e }, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 first:pt-0 last:pb-0">
                  <Badge variant={KIND[k].variant} className="w-[88px] justify-center">{KIND[k].label}</Badge>
                  <span className="font-medium">{e.label}</span>
                  <span className="text-muted-foreground">{dateRange(e.start, e.end)}</span>
                  {(k === "upgraded" || k === "downgraded") && (
                    <span className="text-muted-foreground">{levelName(e.prevLevel)} → {levelName(e.level)}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No impacts added, upgraded or dropped.{c.events.same.length ? ` ${c.events.same.length} carried over unchanged.` : ""}
            </p>
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
