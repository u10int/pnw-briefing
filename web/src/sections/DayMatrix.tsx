import * as React from "react"
import { contrastTextColor } from "@/lib/contrast"
import { DayHead } from "@/components/DayHead"

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { fmtLevel, legendBins, type Ramp } from "@/lib/ramps"
import type { Briefing, DailyVars, Model, N } from "@/types"
import { dayMD } from "@/lib/format"
import { openLocation } from "@/lib/locationlink"

/** Location × day tables (rain and snow, temperatures, wind): the model picker, the per-model or
 *  multi-model values behind them, cell colouring and the table itself. */

export const MEDIAN = "median"
/** The median of a few chosen models only (config core_models), every day the same set. */
export const CORE = "core"
const CORE_DEFAULT = ["GFS", "ECMWF IFS", "ECMWF AIFS"]
/** The core models among `models`, in config order. */
export function coreModels(data: Briefing, models: Model[]): Model[] {
  const want = data.meta.coreModels?.length ? data.meta.coreModels : CORE_DEFAULT
  return want.map((l) => models.find((m) => m.label === l)).filter((m): m is Model => !!m)
}
/** "GFS, ECMWF IFS and ECMWF AIFS". */
export const listNames = (ms: Model[]) => ms.length < 2 ? ms.map((m) => m.label).join("") : `${ms.slice(0, -1).map((m) => m.label).join(", ")} and ${ms[ms.length - 1].label}`
export type DailyKey = keyof DailyVars

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)

/** Models with at least one value of `key` at any location. */
export function modelsWith(data: Briefing, key: DailyKey): Model[] {
  return data.models.filter((m) => Object.values(m.data).some((d) => (d[key] ?? []).some(finite)))
}

/** A model's values for one location, one per briefing day (null past the model's range). */
export function modelDays(m: Model | undefined, point: string, key: DailyKey, nd: number): N[] {
  const xs = m?.data[point]?.[key] ?? []
  return Array.from({ length: nd }, (_, k) => (finite(xs[k]) ? xs[k] : null))
}

export interface DayStat { med: N; lo: N; hi: N; n: number }
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), k = s.length >> 1
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2
}
/** Each location's multi-model median per day, with the range across models. */
export function dayStats(data: Briefing, key: DailyKey, only?: Model[]): Record<string, DayStat[]> {
  const nd = data.dates.length, out: Record<string, DayStat[]> = {}
  for (const p of data.points) {
    out[p.name] = Array.from({ length: nd }, (_, k) => {
      const xs = (only ?? data.models).map((m) => m.data[p.name]?.[key]?.[k]).filter(finite)
      return { med: median(xs), lo: xs.length ? Math.min(...xs) : null, hi: xs.length ? Math.max(...xs) : null, n: xs.length }
    })
  }
  return out
}

/** Mean (or max, or min) across a region's locations, per day. */
export function regionDays(data: Briefing, region: string, byPoint: Record<string, N[]>, how: "mean" | "max" | "min" = "mean"): N[] {
  const names = data.points.filter((p) => p.region === region).map((p) => p.name)
  return data.dates.map((_, k) => {
    const xs = names.map((n) => byPoint[n]?.[k]).filter(finite)
    if (!xs.length) return null
    return how === "max" ? Math.max(...xs) : how === "min" ? Math.min(...xs) : xs.reduce((a, b) => a + b, 0) / xs.length
  })
}

const TIER_LABEL: Record<string, string> = { regional: "Regional", blend: "Blend", global: "Global" }

/** "Model median", then each model with data, grouped by tier, with how many days it covers. */
export function ModelPick({ models, value, onChange, core }: { models: Model[]; value: string; onChange: (v: string) => void; core?: Model[] }) {
  const tiers = ["regional", "blend", "global"].map((t) => [t, models.filter((m) => m.tier === t)] as const).filter(([, ms]) => ms.length)
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-[210px]" aria-label="Model"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={MEDIAN}>Model median</SelectItem>
        {core && core.length >= 2 && (
          <SelectItem value={CORE}>Core median<span className="text-muted-foreground"> · {core.map((m) => m.label.replace(/^ECMWF /, "")).join(", ")}</span></SelectItem>
        )}
        <SelectSeparator />
        {tiers.map(([t, ms]) => (
          <SelectGroup key={t}>
            <SelectLabel>{TIER_LABEL[t]}</SelectLabel>
            {ms.map((m) => (
              <SelectItem key={m.label} value={m.label}>
                {m.label}<span className="text-muted-foreground"> · {m.days} days</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The picked model, falling back to the median when it isn't in this briefing (or has no data). */
export function usePick(models: Model[], core?: Model[]) {
  const [pick, setPick] = React.useState(MEDIAN)
  const model = models.find((m) => m.label === pick)
  const useCore = pick === CORE && (core?.length ?? 0) >= 2
  return { pick: model ? pick : useCore ? CORE : MEDIAN, model, setPick, only: useCore ? core : undefined }
}

/** Text that stays legible on a cell colour. */
const inkOn = contrastTextColor

/** A cell coloured by a ramp. `floor`: values under the first level stay uncoloured (rain, snow). */
export function rampCell(v: N, ramp: Ramp, floor = false): React.CSSProperties {
  if (v == null) return { color: "var(--muted-foreground)" }
  if (floor && v < ramp.levels[0]) return { color: "var(--muted-foreground)" }
  let i = ramp.levels.length - 1
  while (i > 0 && v < ramp.levels[i]) i--
  return { background: ramp.colors[i], color: inkOn(ramp.colors[i]) }
}

/** A compact strip of a ramp over `range`, labelled at its ends (the top end means "and up"). */
export function RampStrip({ ramp, range, unit = "", from, extra }: { ramp: Ramp; range: [number, number]; unit?: string; from?: string; extra?: React.ReactNode }) {
  const bins = legendBins(ramp, range)
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{from ?? `${fmtLevel(range[0])}${unit}`}</span>
      <span className="flex h-2.5 w-36 overflow-hidden rounded-[3px]">
        {bins.map((b, i) => <span key={i} className="min-w-0 flex-1" style={{ background: b.color }} />)}
      </span>
      <span>{fmtLevel(range[1])}{unit}+</span>
      {extra}
    </div>
  )
}

export interface MatrixRow { name: string; group?: boolean; point?: string; days: N[]; lead: N }

export const dayLabel = (iso: string) => dayMD(iso)

/** Locations down the side, days across, a summary column first. Region rows are shaded. Cells
 *  for locations get a tooltip from `tip`. Days at or past `dimFrom` get a muted header. */
export function DayMatrix({ dates, rows, leadHead, leadSub, style, fmt, tip, dimFrom }: {
  dates: string[]; rows: MatrixRow[]; leadHead: string; leadSub: string
  style: (v: N) => React.CSSProperties; fmt: (v: N) => string
  tip?: (row: MatrixRow, k: number) => React.ReactNode; dimFrom?: number
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs tabular-nums">
        <thead>
          <tr className="border-b">
            <th className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">Location</th>
            <th className="px-2 py-1.5 text-center font-medium whitespace-nowrap">{leadHead}<span className="block font-normal text-muted-foreground">{leadSub}</span></th>
            {dates.map((d, k) => (
              <th key={d} className={`min-w-10 px-1 py-1.5 text-center font-medium ${dimFrom != null && k >= dimFrom ? "text-muted-foreground" : ""}`}>
                <DayHead day={d} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={`border-b last:border-b-0 ${r.group ? "font-medium" : ""}`}>
              <td className={`sticky left-0 z-10 px-2 py-1 whitespace-nowrap ${r.group ? "bg-muted" : "bg-card"}`}>
                {r.point ? <button type="button" onClick={() => openLocation(r.point!)} className="rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring">{r.name}</button> : r.name}
              </td>
              <td className="border-r px-2 py-1 text-center font-medium" style={style(r.lead)}>{fmt(r.lead)}</td>
              {dates.map((_, k) => {
                const x = r.days[k] ?? null
                const td = <td key={k} className="px-1 py-1 text-center" style={style(x)}>{fmt(x)}</td>
                const body = r.point && x != null ? tip?.(r, k) : null
                if (!body) return td
                return (
                  <Tooltip key={k}>
                    <TooltipTrigger asChild>{td}</TooltipTrigger>
                    <TooltipContent side="top"><div className="space-y-0.5 py-0.5">{body}</div></TooltipContent>
                  </Tooltip>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
