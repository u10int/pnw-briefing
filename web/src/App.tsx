import * as React from "react"

import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import { issuedLabel } from "@/lib/format"
import { NwsAlerts } from "@/sections/Alerts"
import { SinceYesterday } from "@/sections/Changes"
import { AgreementGrid, ImpactsTable } from "@/sections/Impacts"
import { DayByDay, EnsemblePlume, EnsembleTable, LocationPicker, RunningTotal } from "@/sections/Location"
import { extremeTabs, MapCard } from "@/sections/Maps"
import { Headline, RunStatus, WindowCard } from "@/sections/Overview"
import { ByLocation, GribAreaMeans, RegionTotals } from "@/sections/Totals"
import type { Briefing } from "@/types"

// MapLibre is large; load it only when the map section renders.
const InteractiveMap = React.lazy(() => import("@/sections/InteractiveMap").then((m) => ({ default: m.InteractiveMap })))

function Section({ title, description, action, children }: {
  title: string; description: string; action?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section className="mt-12 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="max-w-3xl space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
          <p className="text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export default function App() {
  const [data, setData] = React.useState<Briefing | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [point, setPoint] = React.useState("Seattle")

  React.useEffect(() => {
    // A self-contained copy carries its data inline; the site fetches it from data/.
    const inline = (window as unknown as { __BRIEFING__?: Briefing }).__BRIEFING__
    if (inline) { setData(inline); return }
    fetch("data/briefing.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`briefing.json returned ${r.status}`))))
      .then((d: Briefing) => { setData(d); document.title = `${d.meta.title}, ${new Date(d.meta.issued).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` })
      .catch((e) => setError(String(e.message ?? e)))
  }, [])

  if (error) {
    return <p className="p-8 text-muted-foreground">The briefing data could not be loaded: {error}. Check that data/briefing.json was published with this page.</p>
  }
  if (!data) return <p className="p-8 text-muted-foreground">Loading the briefing…</p>

  const { meta } = data
  return (
    <TooltipProvider delayDuration={100}>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-baseline justify-between gap-3 px-8 py-3.5 max-sm:px-4">
          <div className="font-semibold">
            {meta.title}<span className="ml-2.5 font-normal text-muted-foreground max-sm:hidden">Western Washington and Northwest Oregon</span>
          </div>
          <div className="text-sm text-muted-foreground">Issued {issuedLabel(meta.issued)}</div>
        </div>
      </header>

      <main className="mx-auto max-w-[1320px] px-8 pb-16 max-sm:px-4">
        <div className="grid items-end gap-6 pt-10 pb-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Headline data={data} />
          <RunStatus data={data} />
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {data.windows.map((w) => <WindowCard key={w.days} w={w} data={data} />)}
        </div>
        <div className="mt-4"><SinceYesterday data={data} /></div>

        <Section title="Impacts to watch"
          description={`Listed when at least ${Math.round(meta.minAgreement * 100)}% of models cross a threshold at a forecast location. Thresholds differ for lowland, coast and pass locations; regional models count for the days they cover.`}>
          <NwsAlerts data={data} />
          <ImpactsTable data={data} />
          <AgreementGrid data={data} />
        </Section>

        <Section title="Interactive map"
          description="Every gridded model and the multi-model products for each window, drawn from the same GeoTIFFs this briefing publishes.">
          <React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading the map…</p>}>
            <InteractiveMap data={data} />
          </React.Suspense>
        </Section>

        <Section title="Next 48 hours"
          description="Regional convection-allowing models next to the blend and the global models, summed over the same two 12Z–12Z days. Dashed outlines mark the comparison regions, west of the Cascade crest.">
          <MapCard title="Gridded maps" description="Each model on its own grid, then the mean (and spread, for precipitation) on a common grid."
            tabs={[
              { id: "p", label: "Precipitation", src: data.maps.short, alt: "48-hour precipitation by model, with mean and spread", note: "Liquid equivalent. Spread is the highest minus the lowest model at each grid cell." },
              { id: "s", label: "Snowfall", src: data.maps.snow_short, alt: "48-hour snowfall by model", note: "From each model's own snow field; models without one are left out." },
              ...extremeTabs(data, "short", "the next 48 hours"),
            ]} />
        </Section>

        <Section title="Totals by model"
          description="Every model side by side. Short-range models only appear in the windows they fully cover, so they are never compared with 14-day totals.">
          <RegionTotals data={data} />
          <ByLocation data={data} />
          <GribAreaMeans data={data} />
        </Section>

        <Section title={`Through day ${meta.days}`}
          description="The longer-range models over their full runs. Mean and spread use only the days every one of them covers.">
          <MapCard title="Gridded maps" description="Totals and extremes over each model's full range."
            tabs={[
              { id: "p", label: "Precipitation", src: data.maps.long, alt: "Full-range precipitation by model", note: "Each panel is labeled with the number of days the model covers." },
              { id: "s", label: "Snowfall, 7 days", src: data.maps.snow_long, alt: "7-day snowfall by model", note: "Models with their own snow field." },
              ...extremeTabs(data, "long", "each model's full range"),
            ]} />
        </Section>

        <Section title={`At ${point}`} description="Running total, ensemble spread and daily detail for one forecast location."
          action={<LocationPicker data={data} value={point} onChange={setPoint} />}>
          <div className="grid gap-4 lg:grid-cols-2">
            <RunningTotal data={data} point={point} />
            <EnsemblePlume data={data} point={point} />
          </div>
          <DayByDay data={data} point={point} />
          <EnsembleTable data={data} />
        </Section>

        <Separator className="mt-14 mb-6" />
        <footer className="grid gap-6 text-sm text-muted-foreground md:grid-cols-3">
          <div>
            <h3 className="mb-1.5 font-medium text-foreground">Sources</h3>
            <p>GRIB2 from NOAA NODD ({meta.sources.ncep.join(", ")}) and ECMWF open data ({meta.sources.ecmwf.join(", ")}), read with Herbie.
              {meta.hasSupplement && " Models marked * come from Open-Meteo."}</p>
          </div>
          <div>
            <h3 className="mb-1.5 font-medium text-foreground">Definitions</h3>
            <p>Days run 12Z to 12Z, 4 AM to 4 AM Pacific Standard Time. Precipitation is liquid equivalent. Daily highs and lows come from 3- or 6-hourly samples, so true extremes may be a degree or two beyond them.</p>
            {data.normals && <p className="mt-2">Normals: {data.normals.source}, spread into daily values. Changes since yesterday compare the same days in both briefings.</p>}
          </div>
          <div>
            <h3 className="mb-1.5 font-medium text-foreground">Use</h3>
            <p>Automated screening, not official warnings. Check NWS Seattle and NWS Portland for watches and warnings.</p>
            <p className="mt-2"><a className="text-[var(--chart-1)] underline underline-offset-4" href={/\/archive\/\d{4}-\d{2}-\d{2}\/?$/.test(location.pathname) ? "../" : "archive/"}>Past briefings</a></p>
          </div>
        </footer>
      </main>
    </TooltipProvider>
  )
}
