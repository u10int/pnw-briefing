import * as React from "react"

import { MapIcon } from "lucide-react"

import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { issuedLabel } from "@/lib/format"
import { type MapRequest, onOpenMap, openOnMap } from "@/lib/maplink"
import { HazardStrip } from "@/sections/Hazards"
import { NwsAlerts } from "@/sections/Alerts"
import { SinceYesterday } from "@/sections/Changes"
import { AgreementGrid, ImpactsTable } from "@/sections/Impacts"
import { ArCard, AvalancheCard, DiscussionsCard, GradientsCard, LandslideCard, ObservedCard, OddsCard, OutlooksCard, SnowLevelCard, SnowpackCard } from "@/sections/Context"
import { DayByDay, EnsemblePlume, EnsembleTable, LocationPicker, RunningTotal } from "@/sections/Location"
import { extremeTabs, MapCard } from "@/sections/Maps"
import { Headline, RunStatus, WindowCard } from "@/sections/Overview"
import { ByLocation, GribAreaMeans, RegionTotals } from "@/sections/Totals"
import { RainByDayCard } from "@/sections/RainByDay"
import { TempDepartureCard } from "@/sections/TempDeparture"
import type { Briefing } from "@/types"

// MapLibre is large; load it only when the Map tab is first opened.
const InteractiveMap = React.lazy(() => import("@/sections/InteractiveMap").then((m) => ({ default: m.InteractiveMap })))

const TABS = [
  { id: "precip", label: "Precip" },
  { id: "flood", label: "Flooding" },
  { id: "wind", label: "Wind" },
  { id: "snow", label: "Snow & mountains" },
  { id: "temp", label: "Temperature" },
  { id: "map", label: "Map" },
  { id: "locations", label: "Locations" },
] as const
type Tab = (typeof TABS)[number]["id"]
const tabFromHash = (): Tab | null => {
  let h = location.hash.replace("#", "")
  if (h === "rain") h = "precip"           // links from before the precip/flooding split
  return TABS.some((t) => t.id === h) ? (h as Tab) : null
}

/** Small link that opens the Map tab with a given mode and layer. */
function MapLink({ req, label }: { req: MapRequest; label: string }) {
  return (
    <button type="button" onClick={() => openOnMap(req)}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-sm font-medium shadow-xs hover:bg-muted">
      <MapIcon className="size-4" />{label}
    </button>
  )
}

/** Extreme-value map tabs for the given variables, labelled with their window. */
function pickExtremes(data: Briefing, horizon: "short" | "long", over: string, vars: string[], suffix: string) {
  return extremeTabs(data, horizon, over).filter((t) => vars.includes(t.id)).map((t) => ({ ...t, id: `${t.id}-${horizon}`, label: t.label + suffix }))
}

function Section({ title, description, action, children, first }: {
  title: string; description: string; action?: React.ReactNode; children: React.ReactNode; first?: boolean
}) {
  return (
    <section className={`${first ? "mt-8" : "mt-12"} space-y-4`}>
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
  const [tab, setTab] = React.useState<Tab>(() => tabFromHash() ?? "precip")
  const [mapSeen, setMapSeen] = React.useState(tab === "map")
  const [mapReq, setMapReq] = React.useState<(MapRequest & { nonce: number }) | null>(null)
  const tabsTop = React.useRef<HTMLDivElement>(null)

  /** Switch tabs (kept in the URL so a link opens the same tab); optionally scroll to the tab bar. */
  const openTab = React.useCallback((t: Tab, scroll = true) => {
    setTab(t)
    if (t === "map") setMapSeen(true)
    history.replaceState(null, "", `#${t}`)
    if (scroll) requestAnimationFrame(() => tabsTop.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }, [])
  React.useEffect(() => {
    const onHash = () => { const t = tabFromHash(); if (t) { setTab(t); if (t === "map") setMapSeen(true) } }
    window.addEventListener("hashchange", onHash)
    const off = onOpenMap((req) => { setMapReq({ ...req, nonce: Date.now() }); openTab("map") })
    return () => { window.removeEventListener("hashchange", onHash); off() }
  }, [openTab])

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
          <HazardStrip data={data} onOpen={(t) => openTab(t)} />
          <ImpactsTable data={data} />
          <AgreementGrid data={data} />
        </Section>

        {data.outlooks && (
          <Section title="What NWS forecasters say"
            description="The latest discussions from the Seattle and Portland offices, and the national rainfall and extended outlooks.">
            <DiscussionsCard data={data} />
            <OutlooksCard data={data} />
          </Section>
        )}

        <Tabs value={tab} onValueChange={(v) => openTab(v as Tab, false)} className="mt-14 gap-0">
          <div ref={tabsTop} className="sticky top-0 z-30 -mx-8 border-b bg-background/95 px-8 py-2.5 backdrop-blur max-sm:-mx-4 max-sm:px-4">
            <div className="overflow-x-auto">
              <TabsList className="h-10">
                {TABS.map((t) => <TabsTrigger key={t.id} value={t.id} className="px-3.5">{t.label}</TabsTrigger>)}
              </TabsList>
            </div>
          </div>

          <TabsContent value="precip">
            <Section title="Precipitation" first
              description="How much falls, when and where: each location and day, the regional and per-location totals for every model, and the model maps."
              action={<MapLink req={{ mode: "totals", variable: "precip", days: 7 }} label="Precipitation totals on the map" />}>
              <RainByDayCard data={data} />
              <RegionTotals data={data} />
              <ByLocation data={data} />
              <MapCard title="Precipitation maps" description="Each model on its own grid, then the mean and spread on a common grid."
                tabs={[
                  { id: "p48", label: "Next 48 hours", src: data.maps.short, alt: "48-hour precipitation by model, with mean and spread", note: "Liquid equivalent. Spread is the highest minus the lowest model at each grid cell. Regional models next to the blend and the global models, over the same two 12Z–12Z days." },
                  { id: "pl", label: `Through day ${meta.days}`, src: data.maps.long, alt: "Full-range precipitation by model", note: "Each panel is labeled with the number of days the model covers; mean and spread use only the days every model covers." },
                ]} />
              <GribAreaMeans data={data} />
            </Section>
          </TabsContent>

          <TabsContent value="flood">
            <Section title="Flooding" first
              description="What turns rain into a problem: how wet it has already been, how close that puts the Seattle area to the landslide threshold, whether an atmospheric river is coming, and how many ensemble members reach the heavy-rain thresholds."
              action={<MapLink req={{ mode: "hourly", layer: "ivt", isobars: true }} label="Moisture transport (IVT) on the map" />}>
              <ObservedCard data={data} />
              <LandslideCard data={data} />
              <ArCard data={data} />
              <OddsCard data={data} />
            </Section>
          </TabsContent>

          <TabsContent value="wind">
            <Section title="Wind" first
              description="Pressure gradients behind the region's classic wind events (south wind, Gorge and Fraser outflow, onshore pushes), and the strongest winds and gusts in each model."
              action={<MapLink req={{ mode: "hourly", layer: "pgrad", isobars: true, pairs: true }} label="Pressure gradients on the map" />}>
              <GradientsCard data={data} />
              <MapCard title="Wind and gust maps" description="The strongest sustained wind and gust in each model."
                tabs={[...pickExtremes(data, "short", "the next 48 hours", ["gust", "wind"], " (48 h)"),
                       ...pickExtremes(data, "long", "each model's full range", ["gust", "wind"], ` (to day ${meta.days})`)]} />
            </Section>
          </TabsContent>

          <TabsContent value="snow">
            <Section title="Snow and mountains" first
              description="Where the snow level sits against the passes, how much snow the models put down, the snowpack so far, and avalanche danger."
              action={<MapLink req={{ mode: "hourly", layer: "frz" }} label="Freezing level on the map" />}>
              <SnowLevelCard data={data} />
              <MapCard title="Snowfall maps" description="From each model's own snow field; models without one are left out."
                tabs={[
                  { id: "s48", label: "Next 48 hours", src: data.maps.snow_short, alt: "48-hour snowfall by model", note: "Model snowfall over the next two 12Z–12Z days." },
                  { id: "s7", label: "7 days", src: data.maps.snow_long, alt: "7-day snowfall by model", note: "Models with their own snow field." },
                ]} />
              <SnowpackCard data={data} />
              <AvalancheCard data={data} />
            </Section>
          </TabsContent>

          <TabsContent value="temp">
            <Section title="Temperature" first
              description="Daily highs and lows against normal for each location, and the warmest and coldest each model gets."
              action={<MapLink req={{ mode: "totals", variable: "tmaxdep", days: 7 }} label="Departures on the map" />}>
              <TempDepartureCard data={data} />
              <MapCard title="High and low temperature maps" description="The highest and lowest 2 m temperature in each model."
                tabs={[...pickExtremes(data, "short", "the next 48 hours", ["tmax", "tmin"], " (48 h)"),
                       ...pickExtremes(data, "long", "each model's full range", ["tmax", "tmin"], ` (to day ${meta.days})`)]} />
            </Section>
          </TabsContent>

          <TabsContent value="map" forceMount className={tab === "map" ? "" : "hidden"}>
            {mapSeen && (
              <Section title="Map" first
                description="Every gridded model and the multi-model products for each window, and the forecast through time, drawn from the same GeoTIFFs this briefing publishes.">
                <React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading the map…</p>}>
                  <InteractiveMap data={data} request={mapReq} active={tab === "map"} />
                </React.Suspense>
              </Section>
            )}
          </TabsContent>

          <TabsContent value="locations">
            <Section title={`At ${point}`} first description="Running total, ensemble spread and daily detail for one forecast location."
              action={<LocationPicker data={data} value={point} onChange={setPoint} />}>
              <div className="grid gap-4 lg:grid-cols-2">
                <RunningTotal data={data} point={point} />
                <EnsemblePlume data={data} point={point} />
              </div>
              <DayByDay data={data} point={point} />
              <EnsembleTable data={data} />
            </Section>
          </TabsContent>
        </Tabs>

        <Separator className="mt-14 mb-6" />
        <footer className="grid gap-6 text-sm text-muted-foreground md:grid-cols-3">
          <div>
            <h3 className="mb-1.5 font-medium text-foreground">Sources</h3>
            <p>GRIB2 from NOAA NODD ({meta.sources.ncep.join(", ")}) and ECMWF open data ({meta.sources.ecmwf.join(", ")}), read with Herbie.
              {meta.hasSupplement && " Models marked * come from Open-Meteo."}</p>
            <p className="mt-2">Observed precipitation from NOAA MRMS; snowpack from USDA NRCS SNOTEL; avalanche danger from the
              Northwest Avalanche Center (avalanche.org); landslide threshold from USGS; forecast discussions,
              alerts and outlooks from NWS, WPC and CPC.</p>
          </div>
          <div>
            <h3 className="mb-1.5 font-medium text-foreground">Definitions</h3>
            <p>Days run 12Z to 12Z, 4 AM to 4 AM Pacific Standard Time. Precipitation is liquid equivalent. Daily highs, lows and peak gusts use each model's max/min-since-last-output fields where it publishes them, otherwise its output at each step.</p>
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
