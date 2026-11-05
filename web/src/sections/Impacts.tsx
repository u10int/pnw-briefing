import * as React from "react"
import { DayHead } from "@/components/DayHead"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dateRange, dayShort, peak, redCell } from "@/lib/format"
import type { Briefing, ImpactEvent } from "@/types"

/** Rain first, then winter hazards, then wind and heat (the order of impacts.HAZARDS); anything else after, by first date. */
const HAZARD_ORDER = ["heavy_rain_24h", "heavy_rain_72h", "snow_24h", "freezing_precip", "hard_freeze", "wind", "heat"]

/** What the chips' numbers are, said once per hazard in its header. */
const UNIT_WORD: Record<string, string> = {
  "in/24h": "peak 24-hour total", "in/72h": "peak 72-hour total", "mph": "peak gust",
}
/** A peak, short for a chip: 2.3″, 58 mph, 24°. */
const short = (v: number, unit: string) =>
  unit.startsWith("in") ? `${v.toFixed(1)}″` : unit === "mph" ? `${Math.round(v)} mph` : unit === "°F" ? `${Math.round(v)}°` : peak(v, unit)

/** The event's locations as chips, worst first (the lowest for temperatures, the highest otherwise),
 *  four shown and the rest in a "+N" chip with the full list on hover. */
function Where({ e }: { e: ImpactEvent }) {
  const low = e.unit === "°F"
  const pts = [...e.points].sort((a, b) => (low ? a.peak - b.peak : b.peak - a.peak))
  const shown = pts.slice(0, 4), rest = pts.slice(4)
  const chip = "inline-flex items-baseline gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-[13px] whitespace-nowrap"
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((p) => (
        <span key={p.name} className={chip}>
          <span>{p.name}</span>
          <span className="font-semibold tabular-nums">{short(p.peak, e.unit)}</span>
        </span>
      ))}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`${chip} cursor-default text-muted-foreground`} tabIndex={0}>+{rest.length}</span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {rest.map((p) => <p key={p.name}>{p.name} <span className="font-semibold tabular-nums">{short(p.peak, e.unit)}</span></p>)}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

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
  // one group per hazard (related hazards side by side), each group's rows by date
  const groups = new Map<string, ImpactEvent[]>()
  for (const e of [...data.events].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)))
    groups.set(e.hazard, [...(groups.get(e.hazard) ?? []), e])
  const rank = (h: string) => (HAZARD_ORDER.indexOf(h) + HAZARD_ORDER.length + 1) % (HAZARD_ORDER.length + 1)
  const ordered = [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[1][0].start.localeCompare(b[1][0].start))
  return (
    <Card>
      {/* the card's own padding, like the other cards; the outer cells drop theirs so text lines up with it */}
      <CardContent>
        <Table className="min-w-[680px] table-fixed [&_td:first-child]:pl-0 [&_th:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:last-child]:pr-0 [&_tbody:last-child_tr:last-child]:border-b-0">
          <colgroup>
            <col className="w-[170px]" /><col className="w-[110px]" /><col className="w-[180px]" /><col />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Models agreeing</TableHead>
              <TableHead>Where, worst first</TableHead>
            </TableRow>
          </TableHeader>
          {ordered.map(([hazard, evs]) => (
            <TableBody key={hazard} className="[&_tr:last-child]:border-b">
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="pt-4 pb-1.5">
                  <span className="font-semibold">{evs[0].label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {evs.length} {evs.length === 1 ? "period" : "periods"} · {UNIT_WORD[evs[0].unit] ?? `peak, ${evs[0].unit}`}
                  </span>
                </TableCell>
              </TableRow>
              {evs.map((e, i) => (
                <TableRow key={i}>
                  <TableCell className="tabular-nums">{dateRange(e.start, e.end)}</TableCell>
                  <TableCell><Badge variant={e.level}>{e.level === "likely" ? "Likely" : "Possible"}</Badge></TableCell>
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
                  <TableCell className="whitespace-normal"><Where e={e} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          ))}
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
          <colgroup><col className="w-[124px] sm:w-[200px]" />{dates.map((d) => <col key={d} />)}</colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-0">
              <TableHead className="sticky left-0 z-10 bg-card" />
              {dates.map((d) => <TableHead key={d} className="h-auto px-0 py-1 text-center text-xs font-medium leading-tight"><DayHead day={d} /></TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {labels.map((lab, i) => (
              <TableRow key={lab} className="hover:bg-transparent border-0">
                <TableCell className="sticky left-0 z-10 bg-card py-0 pr-3 text-[13px] whitespace-normal leading-tight">{lab}</TableCell>
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
