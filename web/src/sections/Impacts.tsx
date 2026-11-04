import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dateRange, dayShort, peak, redCell } from "@/lib/format"
import type { Briefing } from "@/types"

export function ImpactsTable({ data }: { data: Briefing }) {
  if (!data.events.length) {
    return (
      <Card>
        <CardContent className="text-muted-foreground">
          No hazard reaches the agreement threshold in the next {data.meta.days} days.
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="gap-0 py-2">
      <CardContent className="px-2">
        <Table className="min-w-[760px] table-fixed">
          <colgroup>
            <col className="w-[22%]" /><col className="w-[110px]" /><col className="w-[15%]" /><col className="w-[180px]" /><col />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>Hazard</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Models agreeing</TableHead>
              <TableHead>Where, with peak value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.events.map((e, i) => (
              <TableRow key={i}>
                <TableCell className="font-semibold">{e.label}</TableCell>
                <TableCell><Badge variant={e.level}>{e.level === "likely" ? "Likely" : "Possible"}</Badge></TableCell>
                <TableCell className="tabular-nums">{dateRange(e.start, e.end)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="w-[74px] tabular-nums">{Math.round(e.agreement * 100)}% of {e.n_models}</span>
                    <Progress
                      value={e.agreement * 100}
                      aria-label={`${Math.round(e.agreement * 100)}% of models agree`}
                      className={`h-1.5 w-16 bg-muted ${e.level === "likely"
                        ? "[&>[data-slot=progress-indicator]]:bg-[var(--likely-bar)]"
                        : "[&>[data-slot=progress-indicator]]:bg-[var(--possible-bar)]"}`}
                    />
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal">
                  {e.points.slice(0, 4).map((p, k) => (
                    <React.Fragment key={p.name}>
                      {k > 0 && ", "}
                      <span className="whitespace-nowrap">
                        {p.name} <span className="text-muted-foreground tabular-nums">{peak(p.peak, e.unit)}</span>
                      </span>
                    </React.Fragment>
                  ))}{" "}
                  {e.points.length > 4 && <span className="text-muted-foreground">and {e.points.length - 4} more</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function AgreementGrid({ data }: { data: Briefing }) {
  const { labels, dates, matrix } = data.timeline
  if (!labels.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agreement by day</CardTitle>
        <CardDescription>Percent of models over the threshold at the most affected location.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="min-w-[760px] table-fixed border-separate border-spacing-[2px]">
          <colgroup><col className="w-[200px]" />{dates.map((d) => <col key={d} />)}</colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-0">
              <TableHead />
              {dates.map((d) => <TableHead key={d} className="h-7 px-0 text-center text-xs font-normal">{dayShort(d)}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {labels.map((lab, i) => (
              <TableRow key={lab} className="hover:bg-transparent border-0">
                <TableCell className="py-0 pr-3 text-[13px]">{lab}</TableCell>
                {matrix[i].map((v, j) => {
                  const c = redCell(v)
                  return (
                    <TableCell key={j} className="h-8 rounded-[4px] p-0 text-center text-[11px] tabular-nums" style={c}>
                      {v >= 0.1 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block h-full w-full cursor-default leading-8">{Math.round(v * 100)}</span>
                          </TooltipTrigger>
                          <TooltipContent>{lab}, {dayShort(dates[j])}: {Math.round(v * 100)}% of models</TooltipContent>
                        </Tooltip>
                      ) : null}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
