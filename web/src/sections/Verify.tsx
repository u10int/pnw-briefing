import * as React from "react"
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dateRange, dayMD } from "@/lib/format"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Briefing } from "@/types"

const pct = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)}%`)
const inch = (v: number) => `${v < 1 ? v.toFixed(2).replace(/^0\./, ".") : v.toFixed(2)}″`
/** Bias as words: within 10% is about right; otherwise how much too wet or too dry. */
function Bias({ b }: { b: number | null }) {
  if (b == null) return <span className="text-muted-foreground">–</span>
  const d = Math.round((b - 1) * 100)
  if (Math.abs(d) < 10) return <span className="text-muted-foreground">about right</span>
  return <span style={{ color: d > 0 ? "var(--wetter)" : "var(--drier)" }}>{Math.abs(d)}% too {d > 0 ? "wet" : "dry"}</span>
}

/** How the models have been doing: recent briefings' precipitation forecasts at the forecast
 *  locations scored against MRMS, by lead time, best first; and a chart of the day-1 forecasts
 *  against what fell, per region. */
export function VerificationCard({ data }: { data: Briefing }) {
  const v = data.verification
  const [lead, setLead] = React.useState("d1")
  const ranked = React.useMemo(() => (v?.models ?? []).filter((m) => m.scores[lead]).sort((a, b) => a.scores[lead].mae - b.scores[lead].mae), [v, lead])
  const leads = (v?.leads ?? []).filter((l) => v?.models.some((m) => m.scores[l.id]))
  const [rid, setRid] = React.useState(data.regions[0]?.id ?? "wwa")
  const best = ranked[0]
  const chartModels = React.useMemo(() => (v ? Object.keys(v.chart.day1) : []), [v])
  const [pick, setPick] = React.useState<string>("")
  const shown = pick && chartModels.includes(pick) ? pick : (v?.models.filter((m) => m.scores.d1).sort((a, b) => a.scores.d1.mae - b.scores.d1.mae)[0]?.model ?? chartModels[0])
  if (!v || !ranked.length) return null
  const maxMae = Math.max(...ranked.map((m) => m.scores[lead].mae), 0.01)

  const rows = v.chart.dates.map((d, k) => {
    const fcs = chartModels.map((m) => v.chart.day1[m]?.[rid]?.[k]).filter((x): x is number => x != null)
    return { d, obs: v.chart.observed[rid]?.[k] ?? null, model: v.chart.day1[shown]?.[rid]?.[k] ?? null,
             lo: fcs.length ? Math.min(...fcs) : null, hi: fcs.length ? Math.max(...fcs) : null }
  }).filter((r) => r.hi != null)                    // only the days some briefing forecast
  const config = { obs: { label: "Observed (MRMS)", color: "var(--muted-foreground)" }, model: { label: shown, color: "var(--wetter)" } } satisfies ChartConfig

  return (
    <Card>
      <CardHeader>
        <CardTitle>How the models have been doing</CardTitle>
        <CardDescription>
          Each recent briefing's precipitation forecasts at the forecast locations against what MRMS measured, {dateRange(v.from, v.to)} ({v.nDays} days).
          Typical error is the average miss per location and day; a wet day is {v.wet}″ or more.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={lead} onValueChange={setLead}>
            <TabsList>{leads.map((l) => <TabsTrigger key={l.id} value={l.id}>{l.label}</TabsTrigger>)}</TabsList>
          </Tabs>
          {best && <p className="text-sm">Closest lately at this lead: <span className="font-semibold">{best.model}</span>, typical error {inch(best.scores[lead].mae)}</p>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Typical error</th>
                <th className="px-3 py-2 text-right font-medium">Totals</th>
                <th className="px-3 py-2 text-right font-medium">Wet days caught</th>
                <th className="px-3 py-2 text-right font-medium">False alarms</th>
                <th className="py-2 pl-3 text-right font-medium">Scored</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((m, i) => {
                const s = m.scores[lead]
                return (
                  <tr key={m.model} className="border-b border-border/60 last:border-b-0">
                    <td className="py-2 pr-3 whitespace-nowrap"><span className="mr-2 inline-block w-4 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>{m.model}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-28 rounded-full bg-muted">
                          <div className="h-2 rounded-full" style={{ width: `${(100 * s.mae) / maxMae}%`, background: i === 0 ? "var(--wetter)" : "var(--muted-foreground)", opacity: i === 0 ? 1 : 0.55 }} />
                        </div>
                        <span className="tabular-nums">{inch(s.mae)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Tooltip>
                        <TooltipTrigger asChild><span className="cursor-default"><Bias b={s.bias} /></span></TooltipTrigger>
                        <TooltipContent>Forecast {inch(s.fc)} against {inch(s.obs)} observed, summed over every location and day</TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(s.pod)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(s.far)}</td>
                    <td className="py-2 pl-3 text-right text-xs text-muted-foreground tabular-nums">{s.days} days</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">Day-1 forecast against what fell</p>
            <div className="flex flex-wrap items-center gap-2">
              <Tabs value={rid} onValueChange={setRid}>
                <TabsList>{data.regions.map((r) => <TabsTrigger key={r.id} value={r.id}>{r.short}</TabsTrigger>)}</TabsList>
              </Tabs>
              <Select value={shown} onValueChange={setPick}>
                <SelectTrigger className="w-full sm:w-[190px]" aria-label="Model"><SelectValue /></SelectTrigger>
                <SelectContent>{chartModels.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
            <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="d" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(d) => dayMD(d)} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={(x) => `${x}″`} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => dayMD(String(d))} formatter={(val, n, item) => (
                <span className="flex w-full justify-between gap-3">
                  <span className="text-muted-foreground">{n === "obs" ? "Observed" : shown}</span>
                  <span className="font-medium tabular-nums">{inch(Number(val))}{n === "model" && item?.payload?.lo != null ? ` (all models ${inch(item.payload.lo)} – ${inch(item.payload.hi)})` : ""}</span>
                </span>)} />} />
              <Bar dataKey="obs" fill="var(--color-obs)" fillOpacity={0.45} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Line dataKey="model" stroke="var(--color-model)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ChartContainer>
          <p className="text-xs text-muted-foreground">Bars: the region's average observed precipitation each day. Line: the model's day-1 forecast for it, from the briefing issued that morning.</p>
        </div>
      </CardContent>
    </Card>
  )
}
