import { Delta } from "@/components/Delta"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Briefing, TrendChange, TrendWindow } from "@/types"

const REGION_VAR: Record<string, string> = { wwa: "var(--wwa)", nwor: "var(--nwor)" }
const WARM = "#d6604d", COOL = "#4393c3"
type Kind = "snow" | "gust" | "temp"

/** A round top for a 0-based scale: the smallest step at or above the largest value. */
const niceTop = (v: number, steps: number[]) => steps.find((s) => s >= v * 1.05) ?? Math.ceil((v * 1.05) / 10) * 10
const fmtIn = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1))

/** Models' range as a faint band, the median as a mark, on [min, max]. */
function Band({ lo, hi, med, min, max, color, label }: { lo: number; hi: number; med: number; min: number; max: number; color: string; label: string }) {
  const x = (v: number) => `${Math.max(0, Math.min(100, (100 * (v - min)) / (max - min)))}%`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative h-4 w-full cursor-default" aria-label={label}>
          <div className="absolute top-[7px] h-0.5 w-full rounded bg-border" />
          <div className="absolute top-1 h-2 rounded-full opacity-30" style={{ left: x(lo), width: `max(4px, calc(${x(hi)} - ${x(lo)}))`, background: color }} />
          <div className="absolute top-0 h-4 w-[3px] -translate-x-1/2 rounded-sm" style={{ left: x(med), background: color }} />
        </div>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ChangeTip({ c, rid, unit, what, children }: { c: TrendChange | undefined; rid: string; unit: string; what: string; children: React.ReactNode }) {
  const r = c?.regions[rid]
  if (!c || !r) return null
  const f = (v: number) => (unit === "in" ? `${fmtIn(v)} in` : unit === "mph" ? `${Math.round(v)} mph` : `${Math.round(v)}°`)
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="cursor-default">{children}</span></TooltipTrigger>
      <TooltipContent>{what}, same {c.overlapDays} days in yesterday's briefing: {f(r.prev)} → {f(r.now)}</TooltipContent>
    </Tooltip>
  )
}

/** The next 48 hours, 7 days and 14 days for one tab, like the precip tab's cards: each region's
 *  median across models with their range, and the change since yesterday's briefing over the
 *  same dates. Snow is the passes' average snowfall; wind the strongest lowland or coastal gust;
 *  temperature the average high and low. */
export function TrendCards({ data, kind }: { data: Briefing; kind: Kind }) {
  const t = data.trends
  const main = kind === "snow" ? t?.snow : kind === "gust" ? t?.gust : t?.tmax
  if (!main?.length) return null
  const lows = kind === "temp" ? t?.tmin : undefined
  const chg = (v: "snow" | "gust" | "tmax" | "tmin", days: number) => data.change?.trends?.[v]?.find((x) => x.days === days)

  // one scale for all three cards, so the windows compare at a glance (snow and gust grow with the window)
  const all = [...main, ...(lows ?? [])].flatMap((w) => w.regions.flatMap((r) => [r.lo, r.hi]))
  const scale: [number, number] = kind === "temp"
    ? [Math.floor((Math.min(...all) - 2) / 5) * 5, Math.ceil((Math.max(...all) + 2) / 5) * 5]
    : [0, niceTop(Math.max(...all, 0.1), kind === "snow" ? [1, 2, 4, 6, 8, 12, 18, 24, 36, 48, 60, 72, 96] : [30, 40, 50, 60, 70, 80, 90, 100])]

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {main.map((w: TrendWindow) => {
        const low = lows?.find((x) => x.days === w.days)
        const dep = kind === "temp" ? data.tempDeparture?.windows.find((x) => x.days === w.days) : undefined
        return (
          <Card key={w.days} className="gap-4">
            <CardHeader>
              <CardTitle>{w.label}</CardTitle>
              <CardAction className="col-start-2 row-start-1 mt-0 justify-self-end text-sm text-muted-foreground">{w.regions[0]?.n ?? 0} models</CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              {w.regions.map((r) => {
                const lr = low?.regions.find((x) => x.rid === r.rid)
                const color = kind === "temp" ? WARM : REGION_VAR[r.rid] ?? "var(--foreground)"
                const c1 = chg(kind === "snow" ? "snow" : kind === "gust" ? "gust" : "tmax", w.days)
                const c2 = kind === "temp" ? chg("tmin", w.days) : undefined
                const d = dep?.regions[r.rid]
                const sgn = (v: number) => { const n = Math.round(v); return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}°` }
                return (
                  <div key={r.rid}>
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span className="size-2.5 rounded-[3px]" style={{ background: REGION_VAR[r.rid] }} />
                        {r.region}{kind === "snow" ? " passes" : ""}
                      </div>
                      <div className="text-3xl font-semibold tracking-tight tabular-nums">
                        {kind === "snow" && <>{fmtIn(r.median)}<span className="ml-0.5 text-sm font-medium text-muted-foreground">in</span></>}
                        {kind === "gust" && <>{Math.round(r.median)}<span className="ml-0.5 text-sm font-medium text-muted-foreground">mph</span></>}
                        {kind === "temp" && <>{Math.round(r.median)}°{lr && <span className="text-xl text-muted-foreground"> / {Math.round(lr.median)}°</span>}</>}
                      </div>
                    </div>
                    <div className="mt-2 space-y-0.5">
                      <Band lo={r.lo} hi={r.hi} med={r.median} min={scale[0]} max={scale[1]} color={color}
                        label={kind === "snow" ? `Models range ${fmtIn(r.lo)} – ${fmtIn(r.hi)} in; median ${fmtIn(r.median)} in`
                          : kind === "gust" ? `Models range ${Math.round(r.lo)} – ${Math.round(r.hi)} mph; median ${Math.round(r.median)} mph`
                          : `Average high: models range ${Math.round(r.lo)}° – ${Math.round(r.hi)}°; median ${Math.round(r.median)}°`} />
                      {lr && <Band lo={lr.lo} hi={lr.hi} med={lr.median} min={scale[0]} max={scale[1]} color={COOL}
                        label={`Average low: models range ${Math.round(lr.lo)}° – ${Math.round(lr.hi)}°; median ${Math.round(lr.median)}°`} />}
                    </div>
                    {(c1 || (d && (d.tmax != null || d.tmin != null))) && (
                      <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-[13px]">
                        <span className="text-muted-foreground tabular-nums">
                          {d && d.tmax != null && <>Highs {sgn(d.tmax)}{d.tmin != null && <>, lows {sgn(d.tmin)}</>} vs normal</>}
                        </span>
                        <span className="flex gap-3">
                          <ChangeTip c={c1} rid={r.rid} unit={kind === "snow" ? "in" : kind === "gust" ? "mph" : "°"}
                            what={kind === "snow" ? "Pass snowfall" : kind === "gust" ? "Strongest gust" : "Average high"}>
                            <Delta value={c1?.regions[r.rid]?.delta} tone={kind === "snow" ? "wet" : kind === "gust" ? "neutral" : "warm"}
                              unit={kind === "snow" ? "in" : kind === "gust" ? "mph" : "°"} digits={kind === "snow" ? 1 : 0}
                              flatBelow={kind === "snow" ? 0.05 : 0.5} prefix={kind === "temp" ? "High " : ""} />
                          </ChangeTip>
                          <ChangeTip c={c2} rid={r.rid} unit="°" what="Average low">
                            <Delta value={c2?.regions[r.rid]?.delta} tone="warm" unit="°" digits={0} flatBelow={0.5} prefix="Low " />
                          </ChangeTip>
                        </span>
                      </div>
                    )}
                  </div>
                )
              })}
            </CardContent>
            <CardDescription className="px-(--card-pad) text-xs">
              {kind === "snow" && <>Average snowfall at the region's passes in each model. </>}
              {kind === "gust" && <>The strongest gust at any lowland or coastal location in each model. </>}
              {kind === "temp" && <>Average daily high (red) and low (blue) across lowland and coastal locations in each model. </>}
              Bars span the models; the mark is the median.
              {c1Any(data, kind) && <> Arrows compare the same days with yesterday's briefing.</>}
            </CardDescription>
          </Card>
        )
      })}
    </div>
  )
}
const c1Any = (d: Briefing, k: Kind) => !!d.change?.trends?.[k === "snow" ? "snow" : k === "gust" ? "gust" : "tmax"]?.length
