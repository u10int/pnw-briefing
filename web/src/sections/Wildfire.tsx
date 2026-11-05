import * as React from "react"
import { contrastTextColor } from "@/lib/contrast"
import { DayHead } from "@/components/DayHead"
import { AlertBadge } from "@/sections/Alerts"
import { ExternalLink, Flame } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isActive } from "@/lib/fire"
import { FUEL, HDW, RH, type Ramp, SMOKE, spcColor, USDM } from "@/lib/ramps"
import { DayMatrix, dayLabel, dayStats, type MatrixRow, ModelPick, modelDays, modelsWith, RampStrip, rampCell, regionDays, usePick } from "@/sections/DayMatrix"
import type { Briefing, N, PsaDay, Wildfire } from "@/types"

const WildfireMap = React.lazy(() => import("@/sections/WildfireMap"))

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", timeZone: "America/Los_Angeles" }) : "–"
const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
const ink = (hex: string) => (hex.startsWith("#") ? contrastTextColor(hex) : "inherit")
const unavailable = (what: string) => <p className="text-sm text-muted-foreground">The {what} service didn't answer when this briefing was built.</p>

/** A one-line "nothing here" note in the card's place, so a quiet season stays readable. */
function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

// ------------------------------------------------------------------ alerts

export function FireAlertsCard({ wf }: { wf: Wildfire }) {
  const items = wf.alerts
  return (
    <Card>
      <CardHeader>
        <CardTitle>Red Flag Warnings and Fire Weather Watches</CardTitle>
        <CardDescription>From the Seattle and Portland NWS offices, for any of their fire weather zones, as of the briefing.</CardDescription>
      </CardHeader>
      <CardContent>
        {items == null ? unavailable("NWS alert") : !items.length ? (
          <Quiet>No Red Flag Warnings or Fire Weather Watches in effect.</Quiet>
        ) : (
          <ul className="space-y-3">
            {items.map((a) => (
              <li key={a.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AlertBadge event={a.event} />
                  <span className="text-sm tabular-nums text-muted-foreground">{when(a.onset)} – {when(a.ends)}</span>
                  {a.url && !a.url.includes("alerts.weather.gov") && <a href={a.url} target="_blank" rel="noopener" aria-label="Open on weather.gov" className="text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
                </div>
                {a.headline && <p className="text-sm">{a.headline}</p>}
                <p className="text-xs text-muted-foreground">{a.areaDesc}{a.points.length > 0 && <> · covers {a.points.join(", ")}</>}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ NWCC 7-day

const GROUPS: [string, string][] = [["W", "West of the Cascades"], ["C", "Cascades and east slopes"], ["E", "East of the Cascades"]]
const LEVEL_WORD = ["No forecast", "Moist", "Dry", "Very dry", "High risk"]

function FuelCell({ d }: { d: PsaDay | null }) {
  if (!d) return <td className="px-1 py-1 text-center text-muted-foreground">–</td>
  const bg = FUEL[d.level] ?? "transparent"
  const cell = (
    <td className="px-1 py-1 text-center text-[11px] font-medium" style={{ background: bg, color: bg.startsWith("#") ? contrastTextColor(bg) : undefined }}>
      {d.level === 4 ? d.short : ""}
    </td>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{cell}</TooltipTrigger>
      <TooltipContent side="top">{d.label}</TooltipContent>
    </Tooltip>
  )
}

export function FirePotentialCard({ wf }: { wf: Wildfire }) {
  const psa = wf.psa
  return (
    <Card>
      <CardHeader>
        <CardTitle>7-day significant fire potential</CardTitle>
        <CardDescription>
          Northwest Coordination Center Predictive Services: fuel dryness for each Predictive Service Area, and days at high risk
          of new large fires or significant growth, with the trigger (L lightning, W wind, HD hot and dry, B burn environment).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {psa == null ? unavailable("Predictive Services") : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {[1, 2, 3, 4].map((l) => (
                <span key={l} className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]" style={{ background: FUEL[l] }} />{LEVEL_WORD[l]}</span>
              ))}
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-xs tabular-nums">
                <thead>
                  <tr className="border-b">
                    <th className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">Area</th>
                    {psa.dates.map((d) => <th key={d} className="min-w-10 px-1 py-1.5 text-center font-medium"><DayHead day={d} /></th>)}
                  </tr>
                </thead>
                {GROUPS.map(([g, label]) => {
                  const rows = psa.areas.filter((a) => a.name?.startsWith(g))
                  if (!rows.length) return null
                  return (
                    <tbody key={g}>
                      <tr className="border-b bg-muted"><td colSpan={psa.dates.length + 1} className="sticky left-0 px-2 py-1 font-medium">{label}</td></tr>
                      {rows.map((a) => (
                        <tr key={a.code} className="border-b last:border-b-0">
                          <td className="sticky left-0 z-10 max-w-[220px] bg-card px-2 py-1">
                            <span className="font-medium">{a.name}</span>
                            {a.points.length > 0 && <span className="block truncate text-[11px] text-muted-foreground">{a.points.join(", ")}</span>}
                          </td>
                          {psa.dates.map((_, k) => <FuelCell key={k} d={a.days[k]} />)}
                        </tr>
                      ))}
                    </tbody>
                  )
                })}
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Fuel dryness comes from Predictive Services' fuel and fire-danger indices (energy release component and others) against
              their local history. Moist fuels mean new fires are unlikely to grow large whatever the weather.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ SPC

export function SpcFireCard({ wf }: { wf: Wildfire }) {
  const days = wf.spc
  return (
    <Card>
      <CardHeader>
        <CardTitle>SPC fire weather outlook</CardTitle>
        <CardDescription>
          The Storm Prediction Center's national outlook for critical wind and low humidity, and dry thunderstorms: categories for
          days 1 and 2, probabilities for days 3 to 8. Only areas reaching the map are listed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {days == null ? unavailable("SPC outlook") : (
          <div className="overflow-x-auto">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow><TableHead className="w-[150px]">Day</TableHead><TableHead>Outlook areas over the region</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {days.map((d) => (
                  <TableRow key={d.day}>
                    <TableCell className="align-top">
                      {d.date ? <span className="font-medium"><DayHead day={d.date} /></span> : <span className="font-medium">Day {d.day}</span>}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {d.areas.length ? (
                        <ul className="space-y-1">
                          {d.areas.map((a, i) => (
                            <li key={i} className="flex flex-wrap items-center gap-2">
                              <span className="rounded-[4px] px-1.5 py-0.5 text-xs font-medium" style={{ background: spcColor(a.kind, a.dn, a.probability), color: ink(spcColor(a.kind, a.dn, a.probability)) }}>{a.label}</span>
                              <span className="text-xs text-muted-foreground">{a.points.length ? a.points.join(", ") : "No forecast locations inside"}</span>
                            </li>
                          ))}
                        </ul>
                      ) : <span className="text-muted-foreground">None</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ fire weather by day (models)

type FVar = "rh" | "hdw" | "smoke"
const FKEY = { rh: "relative_humidity_2m_min", hdw: "hdw_max", smoke: "smoke_max" } as const
const FRAMP: Record<FVar, Ramp> = { rh: RH, hdw: HDW, smoke: SMOKE }
const FWORD: Record<FVar, string> = { rh: "lowest relative humidity", hdw: "highest surface Hot-Dry-Windy Index", smoke: "highest near-surface smoke" }

export function FireWeatherByDayCard({ data }: { data: Briefing }) {
  const nd = data.dates.length
  const avail = React.useMemo(() => (["rh", "hdw", "smoke"] as FVar[]).filter((v) => modelsWith(data, FKEY[v]).length), [data])
  const [sel, setSel] = React.useState<FVar>("rh")
  const v = avail.includes(sel) ? sel : avail[0]
  const models = React.useMemo(() => (v ? modelsWith(data, FKEY[v]) : []), [data, v])
  const { pick, model, setPick } = usePick(models)
  const stats = React.useMemo(() => (v ? dayStats(data, FKEY[v]) : {}), [data, v])
  if (!v) {
    return (
      <Card>
        <CardHeader><CardTitle>Fire weather by day</CardTitle></CardHeader>
        <CardContent><Quiet>This briefing was built before humidity and the Hot-Dry-Windy Index were added; they appear from the next run.</Quiet></CardContent>
      </Card>
    )
  }
  const ramp = FRAMP[v]
  const lowIsBad = v === "rh"
  const byPoint = Object.fromEntries(data.points.map((p) =>
    [p.name, model ? modelDays(model, p.name, FKEY[v], nd) : stats[p.name].map((s) => s.med)])) as Record<string, N[]>
  const pickOf = (xs: N[]) => { const ys = xs.filter((x): x is number => x != null); return ys.length ? (lowIsBad ? Math.min(...ys) : Math.max(...ys)) : null }
  const rows: MatrixRow[] = [
    ...data.regions.map((r) => { const days = regionDays(data, r.id, byPoint, lowIsBad ? "min" : "max"); return { name: r.name, group: true, days, lead: pickOf(days) } }),
    ...data.points.map((p) => ({ name: p.name, point: p.name, days: byPoint[p.name], lead: pickOf(byPoint[p.name]) })),
  ]
  const fmt = (x: N) => (x == null ? "–" : v === "rh" ? `${Math.round(x)}%` : String(Math.round(x)))
  const tip = (r: MatrixRow, k: number) => {
    const x = r.days[k]!, s = stats[r.point!][k]
    return <>
      <p className="font-semibold">{r.name} · {dayLabel(data.dates[k])}</p>
      {model ? <p>{model.label} {fmt(x)} (models {fmt(s.lo)}–{fmt(s.hi)}, median {fmt(s.med)})</p>
             : <p>Median {fmt(x)} of {s.n} models (range {fmt(s.lo)}–{fmt(s.hi)})</p>}
    </>
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fire weather by day</CardTitle>
        <CardDescription>
          {model ? `${model.label}'s` : "Each location's multi-model median"} {FWORD[v]} for each 12Z–12Z day
          {model && `, out to day ${model.days}`}. Region rows show their {lowIsBad ? "driest" : "worst"} location.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {avail.length > 1 && (
            <Tabs value={v} onValueChange={(x) => setSel(x as FVar)}>
              <TabsList>
                {avail.includes("rh") && <TabsTrigger value="rh">Min humidity</TabsTrigger>}
                {avail.includes("hdw") && <TabsTrigger value="hdw">Hot-Dry-Windy</TabsTrigger>}
                {avail.includes("smoke") && <TabsTrigger value="smoke">Smoke</TabsTrigger>}
              </TabsList>
            </Tabs>
          )}
          <ModelPick models={models} value={pick} onChange={setPick} />
          <div className="sm:ml-auto">
            {v === "rh" ? <RampStrip ramp={RH} range={[10, 90]} unit="%" from="10%" />
              : v === "hdw" ? <RampStrip ramp={HDW} range={[0, 400]} />
              : <RampStrip ramp={SMOKE} range={[1, 250]} extra={<span>µg/m³</span>} />}
          </div>
        </div>
        <DayMatrix dates={data.dates} rows={rows} leadHead={lowIsBad ? "Driest" : "Peak"} leadSub={`${model ? Math.min(model.days, nd) : nd} days`}
          dimFrom={model ? model.days : undefined} style={(x) => rampCell(x, ramp, v === "smoke")} fmt={fmt} tip={tip} />
        <p className="text-xs text-muted-foreground">
          {v === "rh" && <>Humidity under about 25% with wind is when fires spread fastest; west-side lows under 30% usually come with offshore (east) flow. Hover for the driest model.</>}
          {v === "hdw" && <>Vapour pressure deficit (hPa) times wind speed (m/s) from each model's 2 m temperature and humidity and 10 m wind. The published index takes the largest value in the lowest 500 m, so these surface values run lower; compare days and places rather than reading them against its thresholds.</>}
          {v === "smoke" && <>HRRR and RRFS near-surface smoke, the daily maximum. Above about 35 µg/m³ is unhealthy for sensitive groups, 55 and up unhealthy. The Map tab animates it hour by hour.</>}
        </p>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ map

export function WildfireMapCard({ data, wf }: { data: Briefing; wf: Wildfire }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fires, outlooks and drought</CardTitle>
        <CardDescription>Current fire perimeters and incidents, the outlook areas above for a chosen day, and this week's Drought Monitor. Hover for details.</CardDescription>
      </CardHeader>
      <CardContent>
        <React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading the map…</p>}>
          <WildfireMap data={data} wf={wf} />
        </React.Suspense>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ incidents

/** NWCG fire size classes, by acres; the colour steps up with the class. */
const SIZE_CLASSES = [
  { cls: "A", min: 0, typical: 0.1, range: "<¼", color: "#fde68a" }, { cls: "B", min: 0.25, typical: 4, range: "¼–10", color: "#fcc94a" },
  { cls: "C", min: 10, typical: 40, range: "10–100", color: "#f9a529" }, { cls: "D", min: 100, typical: 200, range: "100–300", color: "#f07b1d" },
  { cls: "E", min: 300, typical: 600, range: "300–1k", color: "#dc4c16" }, { cls: "F", min: 1000, typical: 2500, range: "1k–5k", color: "#b3261e" },
  { cls: "G", min: 5000, typical: 30000, range: "5k+", color: "#7a1220" },
]
const sizeClass = (acres: number) => [...SIZE_CLASSES].reverse().find((c) => acres >= c.min)!
const DOT_MAX = 20     // px diameter at 100,000 acres and up: fits the two-line row without growing it

/** A circle sized on a log scale of acres (4 px under an acre to 20 px at 100,000+) and coloured by size class. */
function SizeDot({ acres }: { acres: N }) {
  if (acres == null) return <span className="inline-block size-5" aria-hidden />
  const c = sizeClass(acres)
  const d = Math.max(4, Math.min(DOT_MAX, 4 + (16 * Math.log10(Math.max(acres, 1))) / 5))
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center" title={`Class ${c.cls} (${c.range} acres)`}>
      <span className="rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.15)]" style={{ width: d, height: d, background: c.color }} />
    </span>
  )
}

/** Percent contained as a bar and number; "Not reported" when the incident has no figure. */
function Containment({ pct }: { pct: N }) {
  if (pct == null) return <span className="text-xs text-muted-foreground">Not reported</span>
  const v = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex items-center gap-2">
      <Progress value={v} aria-label={`${Math.round(v)}% contained`} className="h-1.5 w-20 bg-muted [&>[data-slot=progress-indicator]]:bg-[var(--ok)]" />
      <span className="w-9 text-right tabular-nums">{Math.round(v)}%</span>
    </div>
  )
}

export function IncidentsCard({ wf }: { wf: Wildfire }) {
  const [all, setAll] = React.useState(false)
  const items = wf.incidents
  const active = (items ?? []).filter((r) => isActive(r))
  const shown = all ? items ?? [] : active
  const hidden = (items?.length ?? 0) - active.length
  return (
    <Card>
      <CardHeader>
        <CardTitle>Current fires</CardTitle>
        <CardDescription>
          Active wildfire incidents in the map area from the national incident feed (NIFC), largest first. The feed keeps fires
          until they're declared out, often weeks after containment, so fully contained, prescribed and long-quiet ones (no
          containment reported and found over 30 days ago) are behind the switch.
        </CardDescription>
        {items && hidden > 0 && (
          <CardAction className="flex items-center gap-2">
            <Switch id="wf-all" checked={all} onCheckedChange={setAll} />
            <Label htmlFor="wf-all" className="font-normal">Show contained, prescribed and inactive ({hidden})</Label>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {items == null ? unavailable("NIFC incident") : !shown.length ? (
          <Quiet>
            <Flame className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
            No active wildfires in the map area{hidden > 0 ? `; ${hidden} contained, prescribed or inactive fires are still listed.` : "."}
          </Quiet>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Fire</TableHead><TableHead className="text-right">Acres</TableHead><TableHead className="w-[150px]">Contained</TableHead>
                  <TableHead>Discovered</TableHead><TableHead>Cause</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.slice(0, 40).map((r, i) => (
                  <TableRow key={r.id ?? i} className={active.includes(r) ? "" : "text-muted-foreground"}>
                    <TableCell>
                      <span className="font-medium">{r.name}</span>
                      <span className="block text-xs text-muted-foreground">{r.type}{r.county ? ` · ${r.county} County` : ""}, {r.state}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className="inline-flex items-center justify-end gap-2">
                        {r.acres != null ? Math.round(r.acres).toLocaleString("en-US") : "–"}
                        <SizeDot acres={r.acres} />
                      </span>
                    </TableCell>
                    <TableCell><Containment pct={r.contained} /></TableCell>
                    <TableCell className="tabular-nums">{r.discovered ? new Date(r.discovered).toLocaleDateString("en-US", { month: "short", day: "numeric", year: new Date(r.discovered).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }) : "–"}</TableCell>
                    <TableCell>{r.cause ?? "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {shown.length > 40 && <p className="mt-2 text-xs text-muted-foreground">And {shown.length - 40} smaller fires.</p>}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>Size class</span>
              {SIZE_CLASSES.map((c) => (
                <span key={c.cls} className="flex items-center gap-1"><SizeDot acres={c.typical} />{c.cls} {c.range}</span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ drought

export function DroughtCard({ data, wf }: { data: Briefing; wf: Wildfire }) {
  const dm = wf.drought
  return (
    <Card>
      <CardHeader>
        <CardTitle>Drought by location</CardTitle>
        <CardDescription>
          The US Drought Monitor category at each forecast location
          {dm?.mapDate && <>, for the week ending {new Date(dm.mapDate).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}</>}.
          Long-term dryness that keeps heavy fuels and duff ready to burn.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {dm == null ? unavailable("Drought Monitor") : (
          <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {data.points.map((p) => {
              const c = dm.points[p.name]
              const country = /BC$/.test(p.name)
              return (
                <div key={p.name} className="flex items-center justify-between gap-3 border-b py-1 text-sm">
                  <span>{p.name}</span>
                  {c == null ? <span className="text-xs text-muted-foreground">{country ? "Not covered (US only)" : "None"}</span> : (
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className="h-3 w-5 rounded-[3px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]" style={{ background: USDM[c] }} />
                      D{c} · {["Abnormally dry", "Moderate", "Severe", "Extreme", "Exceptional"][c]}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The whole tab, in reading order. */
export function WildfireTab({ data }: { data: Briefing }) {
  const wf = data.wildfire
  if (!wf) return <Quiet>This briefing was built before the Wildfire tab existed; it fills in from the next run.</Quiet>
  return (
    <div className="space-y-4">
      {wf.demo && <Badge variant="possible">Demo wildfire data</Badge>}
      <FireAlertsCard wf={wf} />
      <FirePotentialCard wf={wf} />
      <SpcFireCard wf={wf} />
      <FireWeatherByDayCard data={data} />
      <WildfireMapCard data={data} wf={wf} />
      <IncidentsCard wf={wf} />
      <DroughtCard data={data} wf={wf} />
    </div>
  )
}
