import * as React from "react"

import { ChevronDown, CircleCheck, CircleDashed, Layers, TriangleAlert } from "lucide-react"
import { Popover } from "radix-ui"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { dateRange } from "@/lib/format"
import { summarize } from "@/sections/Hazards"
import { ChangedSince } from "@/sections/ChangedSince"
import { ObservedHighlights } from "@/sections/ObsReports"
import { AgreementBar, OverviewStrip } from "@/sections/OverviewStrip"
import type { Briefing } from "@/types"

const REGION_VAR: Record<string, string> = { wwa: "var(--wwa)", nwor: "var(--nwor)" }
const RANK = { alert: 2, watch: 1, quiet: 0 } as const

/** Leads with whichever hazards the summary cards flag, most severe first, so the headline and
 *  the cards below it never disagree. A quiet briefing leads with the rain totals instead. */
export function Headline({ data }: { data: Briefing }) {
  if (data.summary?.headline) return <Overview data={data} />
  return <LegacyHeadline data={data} />
}

/** The headline and lead written when the briefing was built (see briefing/summary.py). */
function Overview({ data }: { data: Briefing }) {
  const s = data.summary!
  return (
    <Hero data={data}>
      <h1 className="max-w-[24ch] text-[2.75rem] leading-[1.08] font-semibold tracking-tight text-balance max-sm:text-3xl">{s.headline}</h1>
      {s.lede && <p className="max-w-[62ch] text-[17px] leading-relaxed text-pretty text-muted-foreground">{s.lede}</p>}
    </Hero>
  )
}

/** The headline and lead on the left; what changed since the last update and what's been
 *  observed beside them on wide screens (below on narrow ones). */
function Hero({ data, children }: { data: Briefing; children: React.ReactNode }) {
  // the panel only when there's an earlier briefing to compare with or station observations
  const hasSide = !!data.change?.prevIssued || !!data.obsReports
  const side = [<ChangedSince key="c" data={data} />, <ObservedHighlights key="o" data={data} />]
  return (
    // the left column stretches to the panel's height with the strip at its foot, so the two
    // columns end together instead of leaving a gap under the strip
    <div className={`grid gap-x-14 gap-y-8 ${hasSide ? "lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]" : ""}`}>
      <div className="flex flex-col gap-4">
        {children}
        {data.meta.demo && <div><Badge variant="possible">Demo data, rendered from synthetic fields</Badge></div>}
        <div className="space-y-3 lg:mt-auto lg:pt-4">
          <AgreementBar data={data} />
          <OverviewStrip data={data} />
        </div>
      </div>
      {hasSide && <aside className="space-y-5 self-start rounded-xl border bg-card p-5">{side}</aside>}
    </div>
  )
}

/** Briefings built before the overview was written at build time. */
function LegacyHeadline({ data }: { data: Briefing }) {
  const sums = React.useMemo(() => summarize(data), [data])
  const notable = sums.filter((s) => s.tone !== "quiet" && s.lead).sort((a, b) => RANK[b.tone] - RANK[a.tone])
  const quiet = sums.filter((s) => s.tone === "quiet").map((s) => s.title.toLowerCase())
  const long = [...data.windows].reverse().find((w) => w.regions.length) ?? data.windows[0]
  const w = data.wettest
  const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)
  return (
    <Hero data={data}>
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
    </Hero>
  )
}

/** Which model cycle this edition is built on, and, after a 18Z, 00Z or 06Z cycle, that the first
 *  day's figures only cover the rest of that day. */
export function EditionNote({ data }: { data: Briefing }) {
  const c = data.meta.cycle
  if (!c) return null
  const t = new Date(c)
  const local = t.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric" })
  const partial = (data.meta.firstDayHours ?? 24) < 24
  return (
    <span>
      {String(t.getUTCHours()).padStart(2, "0")}Z run{partial && <span className="max-2xl:hidden"> · first day from {local}</span>}
    </span>
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

