import * as React from "react"
import { ArrowLeft, ChevronRight, ExternalLink, Map as MapIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { issuedLabel } from "@/lib/format"
import { locationPath, slugFromAddress, slugify } from "@/lib/locpage"
import { GUST, PRECIP, type Ramp, SNOW, TEMP, WAVE } from "@/lib/ramps"
import { AlertBadge } from "@/sections/Alerts"
import { DayHead } from "@/components/DayHead"
import { dayLabel, dayStats, type DailyKey, modelDays, ModelPick, MEDIAN, modelsWith, rampCell, SUMMARY_COL } from "@/sections/DayMatrix"
import { DayByDay, LocationGlance, LocationPicker, PrecipTotalCard } from "@/sections/Location"
import { LocationObserved } from "@/sections/ObsReports"
import { OverviewStrip } from "@/sections/OverviewStrip"
import { PeakTimingLines } from "@/sections/Timing"
import type { Briefing, ImpactEvent, N, Point } from "@/types"

/**
 * One forecast location on a page of its own (location/<slug>/): the briefing's views for that
 * place, condensed. The two weeks at a glance, the next three days, one matrix of the daily
 * forecast (median or any model, each row opening to every model), then whatever applies to it:
 * waves, rivers, the snow level at a pass, recent observations, and the charts.
 */
export default function LocationPage() {
  const [data, setData] = React.useState<Briefing | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [slug, setSlug] = React.useState(slugFromAddress)

  React.useEffect(() => {
    fetch("data/briefing.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`briefing.json returned ${r.status}`))))
      .then((d: Briefing) => setData(d))
      .catch((e) => setError(String(e.message ?? e)))
    const back = () => setSlug(slugFromAddress())
    window.addEventListener("popstate", back)
    return () => window.removeEventListener("popstate", back)
  }, [])

  const p = data?.points.find((x) => slugify(x.name) === slug) ?? null
  React.useEffect(() => {
    if (data) document.title = p ? `${p.name} — ${data.meta.title}` : `Locations — ${data.meta.title}`
    window.scrollTo({ top: 0 })
  }, [data, p])

  // another location: the address changes without a reload (the back button returns)
  const go = (name: string) => {
    const s = slugify(name)
    history.pushState(null, "", new URL(locationPath(name), document.baseURI).pathname + location.hash)
    setSlug(s)
  }

  if (error) return <p className="p-8 text-muted-foreground">The forecast could not be loaded: {error}.</p>
  if (!data) return <p className="p-8 text-muted-foreground">Loading the forecast…</p>
  return (
    <TooltipProvider delayDuration={100}>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-[1320px] 2xl:max-w-[1560px] min-[1920px]:max-w-[1760px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-3 max-sm:px-4">
          <a href="./" className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"><ArrowLeft className="size-4" aria-hidden />{data.meta.title}</a>
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-muted-foreground max-sm:hidden">Issued {issuedLabel(data.meta.issued)}</span>
            <LocationPicker data={data} value={p?.name ?? ""} onChange={go} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1320px] 2xl:max-w-[1560px] min-[1920px]:max-w-[1760px] space-y-6 px-6 py-6 max-sm:px-4">
        {p ? <LocationBody data={data} p={p} onLocation={go} /> : <LocationIndex data={data} onLocation={go} />}
      </main>
    </TooltipProvider>
  )
}

/** Every location, by region (the page with no location in its address). */
function LocationIndex({ data, onLocation }: { data: Briefing; onLocation: (n: string) => void }) {
  const groups = [...new Set(data.points.map((p) => (p.region ? data.regions.find((r) => r.id === p.region)?.name : p.zone) ?? "Other locations"))]
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Locations</h1>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => (
          <div key={g}>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">{g}</h2>
            <ul className="space-y-1">
              {data.points.filter((p) => ((p.region ? data.regions.find((r) => r.id === p.region)?.name : p.zone) ?? "Other locations") === g).map((p) => (
                <li key={p.name}><a href={locationPath(p.name)} onClick={(e) => { e.preventDefault(); onLocation(p.name) }} className="hover:underline">{p.name}</a></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  )
}

const KIND = { lowland: "Lowland", coast: "Coast", pass: "Mountain pass" }
const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r
  return 6371 * Math.hypot(x, y)
}
const pacificToday = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })

function LocationBody({ data, p, onLocation }: { data: Briefing; p: Point; onLocation: (n: string) => void }) {
  const region = p.region ? data.regions.find((r) => r.id === p.region)?.name : p.zone
  const alerts = (data.alerts?.items ?? []).filter((a) => a.points.includes(p.name))
  const mapHref = `map.html?c=${p.lon.toFixed(3)},${p.lat.toFixed(3)},8.2,0,0`
  return (
    <>
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-balance max-sm:text-3xl">{p.name}</h1>
            <p className="mt-1 text-[15px] text-muted-foreground">{[p.area, region, KIND[p.kind]].filter(Boolean).join(" · ")}</p>
          </div>
          <Button variant="outline" size="sm" asChild><a href={mapHref}><MapIcon aria-hidden />Map around {p.name}</a></Button>
        </div>
        {alerts.length > 0 && (
          <ul className="space-y-1.5">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                <AlertBadge event={a.event} />
                {a.headline && <span className="text-muted-foreground">{a.headline}</span>}
                {a.url && <a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs hover:underline">Details<ExternalLink className="size-3" aria-hidden /></a>}
              </li>
            ))}
          </ul>
        )}
        <OverviewStrip data={data} point={p.name} />
      </section>

      <NextDays data={data} p={p} />
      <LocationGlance data={data} name={p.name} />

      <Card>
        <CardHeader>
          <CardTitle>Day by day</CardTitle>
          <CardDescription info={<>Each day runs 4 AM – 4 AM. The median uses whichever models reach that day: the high-resolution regional models in the first two days, the global ones after. Pick a model to see its numbers instead, or open a row to see every model's. Hover a cell for the range across models.</>}>
            The model median for each day; open a row for every model.
          </CardDescription>
        </CardHeader>
        <CardContent><LocationMatrix data={data} p={p} /></CardContent>
      </Card>

      <Extras data={data} p={p} />
      <Observed data={data} name={p.name} />
      <PrecipTotalCard data={data} point={p.name} />
      <DayByDay data={data} point={p.name} />
      <p className="text-xs text-muted-foreground">
        Nearby: {data.points.filter((q) => q.name !== p.name).sort((a, b) => km(p, a) - km(p, b)).slice(0, 5).map((q, i) => (
          <React.Fragment key={q.name}>{i > 0 && " · "}<a href={locationPath(q.name)} onClick={(e) => { e.preventDefault(); onLocation(q.name) }} className="hover:underline">{q.name}</a></React.Fragment>
        ))}
      </p>
    </>
  )
}

// ------------------------------------------------------------------ the next three days

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)
const HAZ: [RegExp, string][] = [[/^wind$/, "Strong gusts"], [/heavy_rain_24h/, "Heavy rain"], [/heavy_rain_72h/, "Flood risk"], [/^snow/, "Snow"], [/freez|cold/, "Freezing"], [/heat/, "Heat"]]
const hazName = (h: string) => HAZ.find(([re]) => re.test(h))?.[1] ?? h

function NextDays({ data, p }: { data: Briefing; p: Point }) {
  const st = React.useMemo(() => ({
    hi: dayStats(data, "temperature_2m_max")[p.name], lo: dayStats(data, "temperature_2m_min")[p.name],
    rain: dayStats(data, "precipitation_sum")[p.name], snow: dayStats(data, "snowfall_sum")[p.name],
    gust: dayStats(data, "wind_gusts_10m_max")[p.name],
  }), [data, p.name])
  const today = pacificToday(data.meta.issued)
  const k0 = Math.max(0, data.dates.indexOf(today))
  const days = [k0, k0 + 1, k0 + 2].filter((k) => k < data.dates.length)
  const events = (d: string) => data.events.filter((e: ImpactEvent) => e.start <= d && d <= e.end && e.points.some((x) => x.name === p.name && x.frac > 0))
  const rng = (s: { lo: N; hi: N }, f: (v: number) => string) => (finite(s.lo) && finite(s.hi) && s.hi - s.lo > 0 ? ` (${f(s.lo)} – ${f(s.hi)})` : "")
  const inch = (v: number) => (v < 0.005 ? "0" : v < 0.01 ? "T" : v.toFixed(2).replace(/^0\./, "."))
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Next three days</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {days.map((k, i) => {
          const d = data.dates[k], ev = events(d)
          const hi = st.hi[k], lo = st.lo[k], r = st.rain[k], sn = st.snow[k], g = st.gust[k]
          return (
            <div key={d} className="rounded-xl border bg-card p-4">
              <p className="text-sm font-medium">{i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(`${d}T20:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" })}<span className="ml-1.5 font-normal text-muted-foreground">{dayLabel(d)}</span></p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {finite(hi.med) ? `${Math.round(hi.med)}°` : "–"}<span className="ml-1 text-base font-normal text-muted-foreground">/ {finite(lo.med) ? `${Math.round(lo.med)}°` : "–"}</span>
              </p>
              <dl className="mt-2 space-y-0.5 text-[13px]">
                <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Rain</dt><dd className="tabular-nums">{finite(r.med) ? `${inch(r.med)}″` : "–"}<span className="text-muted-foreground">{rng(r, inch)}</span></dd></div>
                {finite(sn.med) && (sn.hi ?? 0) >= 0.1 && <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Snow</dt><dd className="tabular-nums">{sn.med.toFixed(1)}″<span className="text-muted-foreground">{rng(sn, (v) => v.toFixed(1))}</span></dd></div>}
                <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Peak gust</dt><dd className="tabular-nums">{finite(g.med) ? `${Math.round(g.med)} mph` : "–"}<span className="text-muted-foreground">{rng(g, (v) => String(Math.round(v)))}</span></dd></div>
              </dl>
              {ev.length > 0 && (
                <p className="mt-2 text-[13px]">{ev.map((e) => `${hazName(e.hazard)} ${e.level}`).join(" · ")}</p>
              )}
            </div>
          )
        })}
      </div>
      <PeakTimingLines data={data} name={p.name} />
    </section>
  )
}

// ------------------------------------------------------------------ the daily matrix

interface Row {
  key: string; label: string; unit: string; ramp: Ramp; floor?: boolean
  /** the model variable behind it (rows without one, waves and snow level, have no model rows) */
  v?: DailyKey
  /** a value per day, for the median view or for one model */
  days: (model: string) => N[]
  fmt: (v: number) => string
  lead: { label: string; of: (xs: number[]) => number | null }
}
const inch = (v: number) => (v <= 0 ? "0" : v < 0.01 ? "T" : v >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/^0\./, "."))
const snowIn = (v: number) => (v <= 0 ? "0" : v < 0.05 ? "T" : v.toFixed(1))
const sum = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null)
const LEAD_DAYS = 7

function LocationMatrix({ data, p }: { data: Briefing; p: Point }) {
  const nd = data.dates.length
  const models = React.useMemo(() => modelsWith(data, "precipitation_sum").filter((m) => m.data[p.name]), [data, p.name])
  const [pick, setPick] = React.useState(MEDIAN)
  const [open, setOpen] = React.useState<Set<string>>(new Set())
  const stats = React.useMemo(() => {
    const keys: DailyKey[] = ["precipitation_sum", "snowfall_sum", "temperature_2m_max", "temperature_2m_min", "wind_gusts_10m_max"]
    return Object.fromEntries(keys.map((k) => [k, dayStats(data, k)[p.name]])) as Record<string, ReturnType<typeof dayStats>[string]>
  }, [data, p.name])
  const fromModel = (v: DailyKey) => (model: string) =>
    model === MEDIAN ? stats[v].map((s) => s.med) : modelDays(data.models.find((m) => m.label === model), p.name, v, nd)

  const rows = React.useMemo(() => {
    const out: Row[] = [
      { key: "rain", label: "Rain", unit: "in", ramp: PRECIP, floor: true, v: "precipitation_sum", days: fromModel("precipitation_sum"), fmt: inch, lead: { label: "total", of: sum } },
    ]
    if (stats.snowfall_sum.some((s) => (s.hi ?? 0) >= 0.1))
      out.push({ key: "snow", label: "Snow", unit: "in", ramp: SNOW, floor: true, v: "snowfall_sum", days: fromModel("snowfall_sum"), fmt: snowIn, lead: { label: "total", of: sum } })
    out.push(
      { key: "hi", label: "High", unit: "°F", ramp: TEMP, v: "temperature_2m_max", days: fromModel("temperature_2m_max"), fmt: (v) => `${Math.round(v)}`, lead: { label: "highest", of: (xs) => (xs.length ? Math.max(...xs) : null) } },
      { key: "lo", label: "Low", unit: "°F", ramp: TEMP, v: "temperature_2m_min", days: fromModel("temperature_2m_min"), fmt: (v) => `${Math.round(v)}`, lead: { label: "lowest", of: (xs) => (xs.length ? Math.min(...xs) : null) } },
      { key: "gust", label: "Peak gust", unit: "mph", ramp: GUST, v: "wind_gusts_10m_max", days: fromModel("wind_gusts_10m_max"), fmt: (v) => `${Math.round(v)}`, lead: { label: "strongest", of: (xs) => (xs.length ? Math.max(...xs) : null) } },
    )
    // the nearest offshore wave forecast point, for coast locations
    const wave = p.kind === "coast" ? (data.coast?.waves ?? []).map((w) => ({ w, d: km(p, w) })).sort((a, b) => a.d - b.d)[0] : null
    if (wave && wave.d < 120) {
      const by = Object.fromEntries(wave.w.daily.map((x) => [x.date, x.max]))
      const days = data.dates.map((d) => (finite(by[d]) ? by[d] : null))
      out.push({ key: "waves", label: "Waves", unit: "ft", ramp: WAVE, floor: true, days: () => days, fmt: (v) => `${Math.round(v)}`, lead: { label: "highest", of: (xs) => (xs.length ? Math.max(...xs) : null) } })
    }
    // a pass: the lowest snow level each day (the models' median), against the pass
    const pass = data.snowLevel?.passes.find((x) => x.name === p.name)
    if (pass) {
      const days = data.dates.map((d) => {
        const by: Record<string, number[]> = {}
        for (const s of pass.series) s.times.forEach((t, i) => {
          const v = s.values[i]
          if (finite(v) && pacificToday(t) === d) (by[t] ??= []).push(v)
        })
        const meds = Object.values(by).filter((vs) => vs.length >= 2).map((vs) => [...vs].sort((a, b) => a - b)[vs.length >> 1])
        return meds.length ? Math.min(...meds) : null
      })
      const SL: Ramp = { label: "Snow level", units: "ft", levels: [0, pass.elev_ft + 1], colors: ["#d9e8fb", "#ffffff"] }
      out.push({ key: "sl", label: "Snow level", unit: "ft", ramp: SL, days: () => days, fmt: (v) => (v < 500 ? "SL" : `${(Math.round(v / 100) / 10).toFixed(1)}k`), lead: { label: "lowest", of: (xs) => (xs.length ? Math.min(...xs) : null) } })
    }
    return out
  }, [data, p, stats])   // eslint-disable-line react-hooks/exhaustive-deps

  const model = models.find((m) => m.label === pick)
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const cell = (r: Row, v: N) => (v == null ? { color: "var(--muted-foreground)" } : rampCell(v, r.ramp, r.floor))
  const leadOf = (r: Row, xs: N[]) => r.lead.of(xs.slice(0, LEAD_DAYS).filter(finite))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <ModelPick models={models} value={pick} onChange={setPick} />
        {model && <span className="text-xs text-muted-foreground">Out to day {model.days}; blank past it. Waves and snow level are the same in every view.</span>}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs tabular-nums">
          <thead>
            <tr className="border-b">
              <th className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">Daily<span className="block font-normal text-muted-foreground">4 AM – 4 AM</span></th>
              <th className={`px-2 py-1.5 text-center font-medium whitespace-nowrap ${SUMMARY_COL}`}>7 days<span className="block font-normal text-muted-foreground">&nbsp;</span></th>
              {data.dates.map((d) => <th key={d} className="min-w-10 px-1 py-1.5 text-center font-medium"><DayHead day={d} /></th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const xs = r.days(pick)
              const lead = leadOf(r, xs)
              const canOpen = !!r.v && models.length > 1
              const isOpen = open.has(r.key)
              const st = r.v ? stats[r.v] : null
              return (
                <React.Fragment key={r.key}>
                  <tr className="border-b">
                    <td className="sticky left-0 z-10 bg-card px-2 py-1 whitespace-nowrap font-medium">
                      {canOpen ? (
                        <button type="button" onClick={() => toggle(r.key)} aria-expanded={isOpen} className="flex items-center gap-1 text-left hover:underline">
                          <ChevronRight className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden />{r.label}<span className="font-normal text-muted-foreground">{r.unit}</span>
                        </button>
                      ) : <span className="pl-[18px]">{r.label} <span className="font-normal text-muted-foreground">{r.unit}</span></span>}
                    </td>
                    <td className={`px-2 py-1 text-center font-medium ${SUMMARY_COL}`} style={cell(r, lead)} title={r.lead.label}>{lead == null ? "–" : r.fmt(lead)}</td>
                    {xs.map((v, k) => {
                      const td = <td key={k} className="px-1 py-1 text-center" style={cell(r, v)}>{v == null ? "–" : r.fmt(v)}</td>
                      const s = st?.[k]
                      if (v == null || !s || pick !== MEDIAN || !finite(s.lo) || !finite(s.hi)) return td
                      return (
                        <Tooltip key={k}>
                          <TooltipTrigger asChild>{td}</TooltipTrigger>
                          <TooltipContent side="top"><p className="font-semibold">{r.label} · {dayLabel(data.dates[k])}</p><p>Median {r.fmt(v)} {r.unit} of {s.n} models (range {r.fmt(s.lo)} – {r.fmt(s.hi)})</p></TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </tr>
                  {isOpen && r.v && models.map((m) => {
                    const ys = modelDays(m, p.name, r.v!, nd)
                    const l = leadOf(r, ys)
                    return (
                      <tr key={m.label} className="border-b bg-muted/30">
                        <td className="sticky left-0 z-10 bg-card py-0.5 pr-2 pl-6 whitespace-nowrap text-muted-foreground">{m.label}</td>
                        <td className={`px-2 py-0.5 text-center ${SUMMARY_COL}`} style={cell(r, l)}>{l == null ? "–" : r.fmt(l)}</td>
                        {ys.map((v, k) => <td key={k} className="px-1 py-0.5 text-center" style={cell(r, v)}>{v == null ? "" : r.fmt(v)}</td>)}
                      </tr>
                    )
                  })}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">T = trace. The 7-day column is the total, or the highest or lowest, over the first seven days.{rows.some((r) => r.key === "sl") && " Snow level: shaded where it falls to the pass or below; SL is sea level."}</p>
    </div>
  )
}

// ------------------------------------------------------------------ what applies here

function Extras({ data, p }: { data: Briefing; p: Point }) {
  const gauges = (data.rivers?.gauges ?? []).map((g) => ({ g, d: km(p, g) })).filter((x) => x.d < 35).sort((a, b) => (b.g.crest?.level ?? 0) - (a.g.crest?.level ?? 0) || a.d - b.d).slice(0, 4)
  if (!gauges.length) return null
  const CAT = ["Below flood stage", "Action stage", "Minor flooding", "Moderate flooding", "Major flooding"]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rivers nearby</CardTitle>
        <CardDescription>NWS river forecast gauges within about 20 miles, with their forecast crest.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {gauges.map(({ g, d }) => (
            <li key={g.lid} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
              <span><a href={g.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">{g.name}</a><span className="ml-2 text-xs text-muted-foreground">{Math.round(d * 0.621)} mi</span></span>
              <span className="tabular-nums">
                {g.crest ? <>Crest {g.crest.stage.toFixed(1)} {g.units} {new Date(g.crest.time).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "America/Los_Angeles" })}</> : "No forecast crest"}
                <span className={`ml-2 ${g.crest?.level ? "font-medium" : "text-muted-foreground"}`}>{CAT[g.crest?.level ?? 0] ?? ""}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/** Recent observations at the location's station, in a card (nothing when there are none). */
function Observed({ data, name }: { data: Briefing; name: string }) {
  if (!data.obsReports?.points[name]) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Observed</CardTitle>
        <CardDescription>At the location's station: the last few days and today so far, coloured as the observed tables in the briefing.</CardDescription>
      </CardHeader>
      <CardContent><LocationObserved data={data} name={name} bare /></CardContent>
    </Card>
  )
}
