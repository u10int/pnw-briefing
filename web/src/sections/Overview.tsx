import { CircleCheck, CircleDashed } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Delta, PctNormal } from "@/components/Delta"
import { dateRange } from "@/lib/format"
import type { Briefing, Window } from "@/types"

const REGION_VAR: Record<string, string> = { wwa: "var(--wwa)", nwor: "var(--nwor)" }

export function Headline({ data }: { data: Briefing }) {
  const long = [...data.windows].reverse().find((w) => w.regions.length) ?? data.windows[0]
  const w = data.wettest
  return (
    <div className="space-y-4">
      <h1 className="max-w-[22ch] text-[2.75rem] leading-[1.08] font-semibold tracking-tight text-balance max-sm:text-3xl">
        {long.regions.map((r, i) => (
          <span key={r.rid}>
            {i > 0 && " and "}
            <span style={{ color: REGION_VAR[r.rid] }}>{r.region}</span> {r.median.toFixed(1)}&nbsp;in
          </span>
        ))}{" "}
        over the {long.label.toLowerCase().replace(/ (\d+) /, " $1 ")}.
      </h1>
      <p className="max-w-[62ch] text-base text-muted-foreground">
        The wettest stretch is <span className="font-semibold text-foreground">{dateRange(w.start, w.end)}</span>, with
        about {w.amount.toFixed(1)} in averaged across all forecast locations. Totals are model medians; ranges and
        every model are below.
      </p>
      {data.meta.demo && <Badge variant="possible">Demo data, rendered from synthetic fields</Badge>}
    </div>
  )
}

export function RunStatus({ data }: { data: Briefing }) {
  const ok = data.status.filter((s) => s.ok).length
  return (
    <Card className="gap-3 py-5">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Model runs in this briefing</CardTitle>
        <CardAction className="text-sm text-muted-foreground">
          {ok} of {data.status.length}
        </CardAction>
      </CardHeader>
      <CardContent className="px-5">
        <ul className="grid grid-cols-2 gap-x-5 gap-y-1 text-[13px]">
          {data.status.map((s) => (
            <li key={s.label} className={`flex items-center gap-1.5 ${s.ok ? "" : "text-muted-foreground"}`}>
              {s.ok ? <CircleCheck className="size-3.5 text-ok" aria-label="arrived" /> :
                <CircleDashed className="size-3.5" aria-label="missing" />}
              <span className="truncate">{s.label}{s.source === "open-meteo" ? " *" : ""}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">{s.ok ? (s.run?.split(" ")[0] ?? "API") : "missing"}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function RangeBar({ lo, hi, median, scale, color }: { lo: number; hi: number; median: number; scale: number; color: string }) {
  const pct = (v: number) => `${Math.min(100, (100 * v) / scale)}%`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative mt-2 h-4 w-full cursor-default" aria-label={`Range ${lo.toFixed(1)} to ${hi.toFixed(1)} in`}>
          <div className="absolute top-[7px] h-0.5 w-full rounded bg-border" />
          <div className="absolute top-1 h-2 rounded-full opacity-30" style={{ left: pct(lo), width: `max(4px, ${pct(hi - lo)})`, background: color }} />
          <div className="absolute top-0 h-4 w-[3px] -translate-x-1/2 rounded-sm" style={{ left: pct(median), background: color }} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Models range {lo.toFixed(1)}–{hi.toFixed(1)} in; median {median.toFixed(1)} in
      </TooltipContent>
    </Tooltip>
  )
}

export function WindowCard({ w, data }: { w: Window; data: Briefing }) {
  const norm = data.normals?.windows.find((x) => x.days === w.days)
  const chg = data.change?.windows.find((x) => x.days === w.days)
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{w.label}</CardTitle>
        <CardAction className="text-sm text-muted-foreground">{w.regions[0]?.n ?? 0} models</CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {w.regions.map((r) => (
          <div key={r.rid}>
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="size-2.5 rounded-[3px]" style={{ background: REGION_VAR[r.rid] }} />
                {r.region}
              </div>
              <div className="text-3xl font-semibold tracking-tight tabular-nums">
                {r.median.toFixed(1)}<span className="ml-0.5 text-sm font-medium text-muted-foreground">in</span>
              </div>
            </div>
            <RangeBar lo={r.lo} hi={r.hi} median={r.median} scale={w.scale} color={REGION_VAR[r.rid]} />
            {(norm || chg) && (
              <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-[13px]">
                <PctNormal pct={norm?.regions[r.rid]?.pct} />
                {chg && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default"><Delta value={chg.regions[r.rid]?.delta} /></span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Same {chg.overlapDays} days in yesterday's briefing: {chg.regions[r.rid].prev.toFixed(1)} in → {chg.regions[r.rid].now.toFixed(1)} in
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        ))}
      </CardContent>
      <CardDescription className="px-6 text-xs">
        Bar spans the range across models; the mark is the median. Scale 0–{w.scale} in.
        {chg && <> Arrows compare the same {chg.overlapDays} days with yesterday's briefing.</>}
      </CardDescription>
    </Card>
  )
}
