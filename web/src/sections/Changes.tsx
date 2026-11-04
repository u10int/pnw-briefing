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

/** Region totals now vs yesterday's briefing over the same days, plus hazard changes. */
export function SinceYesterday({ data }: { data: Briefing }) {
  const c = data.change
  if (!c) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Since yesterday</CardTitle>
          <CardDescription>No earlier briefing to compare with yet. This fills in from the second daily run.</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  const hazardRows = (["new", "upgraded", "downgraded", "dropped"] as const).flatMap((k) => c.events[k].map((e) => ({ k, e })))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Since yesterday</CardTitle>
        <CardDescription>
          Compared with the briefing issued {c.prevIssued ? issuedLabel(c.prevIssued) : "yesterday"}, over the days both cover.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
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
        <div>
          <p className="mb-2 text-sm font-medium">Hazards</p>
          {hazardRows.length ? (
            <ul className="space-y-2 text-sm">
              {hazardRows.map(({ k, e }, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <Badge variant={KIND[k].variant}>{KIND[k].label}</Badge>
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
              No hazards added, upgraded or dropped. {c.events.same.length ? `${c.events.same.length} carried over unchanged.` : ""}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
