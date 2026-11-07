import { Delta } from "@/components/Delta"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { issuedLabel } from "@/lib/format"
import type { Briefing } from "@/types"

const since = (c: NonNullable<Briefing["change"]>) => (c.prevIssued ? issuedLabel(c.prevIssued) : "yesterday")

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
                  if (!v) return <TableCell key={r.id} className="text-right text-muted-foreground"> – </TableCell>
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
