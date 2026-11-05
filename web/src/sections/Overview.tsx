import * as React from "react"

import { ChevronDown, CircleCheck, CircleDashed, Layers, TriangleAlert } from "lucide-react"
import { Popover } from "radix-ui"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Delta, PctNormal } from "@/components/Delta"
import { dateRange } from "@/lib/format"
import { summarize } from "@/sections/Hazards"
import type { Briefing, Window } from "@/types"

const REGION_VAR: Record<string, string> = { wwa: "var(--wwa)", nwor: "var(--nwor)" }
const RANK = { alert: 2, watch: 1, quiet: 0 } as const

/** Leads with whichever hazards the summary cards flag, most severe first, so the headline and
 *  the cards below it never disagree. A quiet briefing leads with the rain totals instead. */
export function Headline({ data }: { data: Briefing }) {
  const sums = React.useMemo(() => summarize(data), [data])
  const notable = sums.filter((s) => s.tone !== "quiet" && s.lead).sort((a, b) => RANK[b.tone] - RANK[a.tone])
  const quiet = sums.filter((s) => s.tone === "quiet").map((s) => s.title.toLowerCase())
  const long = [...data.windows].reverse().find((w) => w.regions.length) ?? data.windows[0]
  const w = data.wettest
  const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)
  return (
    <div className="space-y-4">
      <h1 className="max-w-[26ch] text-[2.75rem] leading-[1.08] font-semibold tracking-tight text-balance max-sm:text-3xl">
        {notable.length ? `${notable[0].lead}.` : "A quiet two weeks: nothing stands out across the region."}
      </h1>
      <p className="max-w-[68ch] text-base text-muted-foreground">
        {notable.length > 1 && <>Also worth watching: {notable.slice(1).map((s) => s.lead!.charAt(0).toLowerCase() + s.lead!.slice(1)).join("; ")}. </>}
        {long && long.regions.length > 0 && (
          <>
            Over the {long.label.toLowerCase().replace(/^next /, "next ")},{" "}
            {long.regions.map((r, i) => (
              <span key={r.rid}>
                {i > 0 && (i === long.regions.length - 1 ? " and " : ", ")}
                <span className="font-medium" style={{ color: REGION_VAR[r.rid] }}>{r.region}</span>{" "}
                <span className="font-semibold text-foreground">{r.median.toFixed(1)}&nbsp;in</span>
              </span>
            ))}
            {w && <>, wettest <span className="font-semibold text-foreground">{dateRange(w.start, w.end)}</span></>}.{" "}
          </>
        )}
        {quiet.length > 0 && notable.length > 0 && <>Quiet: {list(quiet)}.</>}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <RunStatus data={data} />
        {data.meta.demo && <Badge variant="possible">Demo data, rendered from synthetic fields</Badge>}
      </div>
    </div>
  )
}

/** One line ("16 of 16 model runs"); the per-model list sits in a popover. */
export function RunStatus({ data }: { data: Briefing }) {
  const ok = data.status.filter((s) => s.ok).length
  const missing = data.status.filter((s) => !s.ok)
  return (
    <>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 rounded-full px-3 text-[13px] font-normal">
            <Layers className="size-3.5 text-muted-foreground" />
            {ok} of {data.status.length} model runs
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} collisionPadding={16}
            className="z-50 w-[min(420px,calc(100vw-32px))] rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-hidden">
            <p className="mb-2.5 text-sm font-medium">Model runs in this briefing</p>
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
            {missing.some((s) => s.reason) && (
              <ul className="mt-3 space-y-1 border-t pt-2.5 text-xs text-muted-foreground">
                {missing.filter((s) => s.reason).map((s) => <li key={s.label}><span className="font-medium text-foreground">{s.label}:</span> {s.reason}</li>)}
              </ul>
            )}
            {data.status.some((s) => s.source === "open-meteo") && <p className="mt-2.5 text-xs text-muted-foreground">* from the Open-Meteo API rather than GRIB</p>}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {missing.length > 0 && (
        <Badge variant="possible" className="gap-1"><TriangleAlert />{list2(missing.map((s) => s.label))} missing</Badge>
      )}
    </>
  )
}
const list2 = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.length} models`)

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
        <CardAction className="col-start-2 row-start-1 mt-0 justify-self-end text-sm text-muted-foreground">{w.regions[0]?.n ?? 0} models</CardAction>
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
