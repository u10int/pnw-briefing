import * as React from "react"
import { ChevronRight } from "lucide-react"
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
/** The median of values with weights: the value where the running weight passes half the total. */
export function weightedMedian(xs: [number, number][]): N {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a[0] - b[0])
  const half = s.reduce((a, x) => a + x[1], 0) / 2
  let acc = 0
  for (let i = 0; i < s.length; i++) {
    acc += s[i][1]
    if (Math.abs(acc - half) < 1e-9 && i + 1 < s.length) return (s[i][0] + s[i + 1][0]) / 2
    if (acc > half) return s[i][0]
  }
  return s[s.length - 1][0]
}

/** Each location's multi-model median per day, with the range across models; with `skill`, the
 *  median weights each model by its recent skill at that lead. */
export function dayStats(data: Briefing, key: DailyKey, only?: Model[], skill?: Skill | null): Record<string, DayStat[]> {
  const nd = data.dates.length, out: Record<string, DayStat[]> = {}
  for (const p of data.points) {
    out[p.name] = Array.from({ length: nd }, (_, k) => {
      const ms = (only ?? data.models).filter((m) => finite(m.data[p.name]?.[key]?.[k]))
      const xs = ms.map((m) => m.data[p.name]![key]![k] as number)
      const med = skill ? weightedMedian(ms.map((m, i) => [xs[i], skill.weight(m.label, k)])) : median(xs)
      return { med, lo: xs.length ? Math.min(...xs) : null, hi: xs.length ? Math.max(...xs) : null, n: xs.length }
    })
  }
  return out
}

// ------------------------------------------------------------------ skill weights

/** The median weighted by each model's recent skill. */
export const SKILL = "skill"
export interface Skill {
  /** A model's weight for briefing day k (1 is average; unscored models get 1). */
  weight: (model: string, k: number) => number
  kind: "precip" | "temp"; days: number; from: string; to: string
  /** each scored model's weight by lead group, for the explanation */
  table: { model: string; w: Record<string, number> }[]
}
const leadGroup = (k: number) => (k === 0 ? "d1" : k <= 2 ? "d23" : "d47")
/** Weights from the verification cards: a model's typical error against the median model's, at
 *  each lead group, squared (as for inverse-variance weights), pulled toward 1 when only a few
 *  days are scored, and kept within ¼ – 4. Precipitation uses MRMS verification, temperature URMA. */
export function skillWeights(data: Briefing, kind: "precip" | "temp"): Skill | null {
  const v = kind === "precip" ? data.verification : data.tempVerification
  if (!v || v.models.length < 3) return null
  const groups = ["d1", "d23", "d47"]
  const table: Skill["table"] = v.models.map((m) => ({ model: m.model, w: {} }))
  for (const g of groups) {
    const sc = v.models.map((m) => m.scores[g]).filter((x): x is NonNullable<typeof x> => !!x && x.mae > 0)
    if (sc.length < 3) continue
    const mid = median(sc.map((x) => x.mae))!
    v.models.forEach((m, i) => {
      const x = m.scores[g]
      if (!x || !(x.mae > 0)) return
      const shrink = x.days / (x.days + 5)
      table[i].w[g] = Math.min(4, Math.max(0.25, Math.pow(mid / x.mae, 2 * shrink)))
    })
  }
  if (!table.some((t) => Object.keys(t.w).length)) return null
  const at = Object.fromEntries(table.map((t) => [t.model, t.w]))
  return { weight: (m, k) => at[m]?.[leadGroup(k)] ?? 1, kind, days: v.nDays, from: v.from, to: v.to, table: table.filter((t) => Object.keys(t.w).length) }
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
export function ModelPick({ models, value, onChange, core, skill }: { models: Model[]; value: string; onChange: (v: string) => void; core?: Model[]; skill?: Skill | null }) {
  const tiers = ["regional", "blend", "global"].map((t) => [t, models.filter((m) => m.tier === t)] as const).filter(([, ms]) => ms.length)
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-[210px]" aria-label="Model"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={MEDIAN}>Model median</SelectItem>
        {core && core.length >= 2 && (
          <SelectItem value={CORE}>Core median<span className="text-muted-foreground"> · {core.map((m) => m.label.replace(/^ECMWF /, "")).join(", ")}</span></SelectItem>
        )}
        {skill && <SelectItem value={SKILL}>Skill-weighted median</SelectItem>}
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
export function usePick(models: Model[], core?: Model[], skill?: Skill | null) {
  const [pick, setPick] = React.useState(MEDIAN)
  const model = models.find((m) => m.label === pick)
  const useCore = pick === CORE && (core?.length ?? 0) >= 2
  const useSkill = pick === SKILL && !!skill
  return { pick: model ? pick : useCore ? CORE : useSkill ? SKILL : MEDIAN, model, setPick, only: useCore ? core : undefined, skill: useSkill ? skill : null }
}

/** One line on what the skill weights did: the most and least trusted models. */
export function skillNote(s: Skill) {
  const avg = s.table.map((t) => ({ m: t.model, w: Object.values(t.w).reduce((a, b) => a + b, 0) / Object.values(t.w).length })).sort((a, b) => b.w - a.w)
  const f = (x: { m: string; w: number }) => `${x.m} ×${x.w.toFixed(1)}`
  return `Weights from each model's typical error against ${s.kind === "precip" ? "MRMS precipitation" : "URMA highs and lows"} over the last ${s.days} days, by lead: most weight ${avg.slice(0, 2).map(f).join(", ")}; least ${avg.slice(-2).reverse().map(f).join(", ")}. Models not yet scored count as average.`
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

export interface MatrixRow { name: string; group?: boolean; point?: string; region?: string; days: N[]; lead: N }

/** A light diagonal hatch over a cell where the models are far apart. */
export const HATCH: React.CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, rgb(0 0 0 / 0.16) 0 1.5px, transparent 1.5px 5px)" }
/** The hatch in a shade of the cell's own colour: darker on a light cell, lighter on a dark one
 *  (the grey hatch where the cell has no colour). */
export function hatchOn(style: React.CSSProperties): React.CSSProperties {
  const bg = typeof style.background === "string" && style.background.startsWith("#") ? style.background : null
  if (!bg) return { ...style, ...HATCH }
  const dark = contrastTextColor(bg).toLowerCase() === "#ffffff"
  const line = `color-mix(in srgb, ${bg}, ${dark ? "white 12%" : "black 8%"})`
  return { ...style, backgroundImage: `repeating-linear-gradient(135deg, ${line} 0 1.25px, transparent 1.25px 5px)` }
}

/** Narrow screens: region rows start collapsed, and open to their locations. */
export function useNarrow() {
  const q = "(max-width: 639px)"
  const [narrow, setNarrow] = React.useState(() => typeof window !== "undefined" && window.matchMedia?.(q).matches)
  React.useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const f = () => setNarrow(m.matches)
    m.addEventListener("change", f)
    return () => m.removeEventListener("change", f)
  }, [])
  return narrow
}

export const dayLabel = (iso: string) => dayMD(iso)

/** Locations down the side, days across, a summary column first. Region rows are shaded. Cells
 *  for locations get a tooltip from `tip`. Days at or past `dimFrom` get a muted header. */
export function DayMatrix({ dates, rows, leadHead, leadSub, style, fmt, tip, dimFrom, flag }: {
  dates: string[]; rows: MatrixRow[]; leadHead: string; leadSub: string
  style: (v: N) => React.CSSProperties; fmt: (v: N) => string
  tip?: (row: MatrixRow, k: number) => React.ReactNode; dimFrom?: number
  /** cells to hatch: where the models are far apart */
  flag?: (row: MatrixRow, k: number) => boolean
}) {
  const narrow = useNarrow()
  const [open, setOpen] = React.useState<Set<string>>(new Set())
  const grouped = narrow && rows.some((r) => r.group && r.region) && rows.some((r) => !r.group && r.region)
  // on a phone: each region row, then its locations once opened; elsewhere as given
  const shown = !grouped ? rows : rows.filter((r) => r.group).flatMap((g) =>
    [g, ...(open.has(g.region!) ? rows.filter((r) => !r.group && r.region === g.region) : [])])
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs tabular-nums">
        <thead>
          <tr className="border-b">
            <th className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">
              Location<span className="block font-normal text-muted-foreground">days 4 AM – 4 AM</span>
            </th>
            <th className="px-2 py-1.5 text-center font-medium whitespace-nowrap">{leadHead}<span className="block font-normal text-muted-foreground">{leadSub}</span></th>
            {dates.map((d, k) => (
              <th key={d} className={`min-w-10 px-1 py-1.5 text-center font-medium ${dimFrom != null && k >= dimFrom ? "text-muted-foreground" : ""}`}>
                <DayHead day={d} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.name} className={`border-b last:border-b-0 ${r.group ? "font-medium" : ""}`}>
              <td className={`sticky left-0 z-10 px-2 py-1 whitespace-nowrap ${r.group ? "bg-muted" : "bg-card"} ${grouped && !r.group ? "pl-5" : ""}`}>
                {r.point ? <button type="button" onClick={() => openLocation(r.point!)} className="rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring">{r.name}</button>
                  : grouped && r.region ? (
                    <button type="button" onClick={() => toggle(r.region!)} aria-expanded={open.has(r.region)} className="flex items-center gap-1 text-left">
                      <ChevronRight className={`size-3.5 transition-transform ${open.has(r.region) ? "rotate-90" : ""}`} aria-hidden />{r.name}
                    </button>
                  ) : r.name}
              </td>
              <td className="border-r px-2 py-1 text-center font-medium" style={style(r.lead)}>{fmt(r.lead)}</td>
              {dates.map((_, k) => {
                const x = r.days[k] ?? null
                const hatched = x != null && flag?.(r, k)
                const td = <td key={k} className="px-1 py-1 text-center" style={hatched ? hatchOn(style(x)) : style(x)}>{fmt(x)}</td>
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

/** The legend swatch for hatched cells. */
export function HatchKey({ what = "Models far apart" }: { what?: string }) {
  return <span className="mr-3 inline-flex items-center gap-1.5 align-middle"><span className="inline-block h-3 w-5 rounded-[2px] border" style={HATCH} aria-hidden />{what}</span>
}
