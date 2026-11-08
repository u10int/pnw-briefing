import * as React from "react"

import { Anchor, CloudRain, Flame, MapIcon, MapPin, MountainSnow, Telescope, Thermometer, Waves, Wind } from "lucide-react"

import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { issuedLabel } from "@/lib/format"
import { type MapRequest, onOpenMap, openOnMap } from "@/lib/maplink"
import { HazardStrip } from "@/sections/Hazards"
import { NwsAlerts } from "@/sections/Alerts"
import { ImpactBoard } from "@/sections/Impacts"
import { ArCard, AvalancheCard, ForecasterNotes, FullDiscussions, GradientsCard, LandslideCard, ObservedCard, OddsCard, OutlooksCard, SnowLevelCard, SnowpackCard } from "@/sections/Context"
import { LocationPanel } from "@/sections/Location"
import { onOpenLocation } from "@/lib/locationlink"
import { extremeTabs, MapCard } from "@/sections/Maps"
import { Headline } from "@/sections/Overview"
import { TrendsCard } from "@/sections/Trends"
import { TempVerificationCard, VerificationCard } from "@/sections/Verify"
import { ConvectiveCard } from "@/sections/Convective"
import { ObsReportsCard } from "@/sections/ObsReports"
import { CoastSection } from "@/sections/Coast"
import { PeakTimingCard } from "@/sections/Timing"
import { ByLocation, RegionTotals } from "@/sections/Totals"
import { WindByLocation, WindPeaks } from "@/sections/WindTotals"
import { RainByDayCard } from "@/sections/RainByDay"
import { RiversCard } from "@/sections/Rivers"
import { TempDepartureCard } from "@/sections/TempDeparture"
import { WildfireTab } from "@/sections/Wildfire"
import { WindByDayCard } from "@/sections/WindByDay"
import type { Briefing } from "@/types"

// MapLibre is large; it loads with the Map tab, which is the first tab and opens by default.
const InteractiveMap = React.lazy(() => import("@/sections/InteractiveMap").then((m) => ({ default: m.InteractiveMap })))

const TABS = [
  { id: "map", label: "Map", icon: MapIcon },
  { id: "precip", label: "Precip", icon: CloudRain },
  { id: "flood", label: "Flooding", icon: Waves },
  { id: "wind", label: "Wind", icon: Wind },
  { id: "coast", label: "Coast & marine", icon: Anchor },
  { id: "snow", label: "Snow & mountains", icon: MountainSnow },
  { id: "temp", label: "Temperature", icon: Thermometer },
  { id: "fire", label: "Wildfire", icon: Flame },
  { id: "outlooks", label: "Outlooks", icon: Telescope },
] as const
type Tab = (typeof TABS)[number]["id"]
/** "#precip" or "#precip/Seattle": the tab, and a location whose panel is open. */
const tabFromHash = (): Tab | null => {
  let h = location.hash.replace("#", "").split("/")[0]
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
  // the location whose detail panel is open (kept in the URL after the tab: "#precip/Seattle")
  const [point, setPoint] = React.useState<string | null>(() => {
    const n = decodeURIComponent(location.hash.split("/")[1] ?? "")
    return n || null
  })
  const [tab, setTab] = React.useState<Tab>(() => tabFromHash() ?? "map")
  const [mapSeen, setMapSeen] = React.useState(tab === "map")
  const [mapReq, setMapReq] = React.useState<(MapRequest & { nonce: number }) | null>(null)
  const tabsTop = React.useRef<HTMLDivElement>(null)

  /** Switch tabs (kept in the URL so a link opens the same tab); optionally scroll to the tab bar. */
  const openTab = React.useCallback((t: Tab, scroll = true) => {
    setTab(t)
    if (t === "map") setMapSeen(true)
    history.replaceState(null, "", `#${t}${location.hash.includes("/") ? location.hash.slice(location.hash.indexOf("/")) : ""}`)
    if (scroll) requestAnimationFrame(() => tabsTop.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }, [])
  React.useEffect(() => {
    const onHash = () => { const t = tabFromHash(); if (t) { setTab(t); if (t === "map") setMapSeen(true) } }
    window.addEventListener("hashchange", onHash)
    const off = onOpenMap((req) => { setMapReq({ ...req, nonce: Date.now() }); setPoint(null); openTab("map") })
    const offLoc = onOpenLocation((n) => setPoint(n))
    const onLocHash = () => setPoint(decodeURIComponent(location.hash.split("/")[1] ?? "") || null)
    window.addEventListener("hashchange", onLocHash)
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("hashchange", onLocHash); off(); offLoc() }
  }, [openTab])

  // on a phone the tab bar scrolls sideways: bring the open tab into view when it changes
  React.useEffect(() => {
    const bar = tabsTop.current?.querySelector<HTMLElement>(".overflow-x-auto")
    const on = bar?.querySelector<HTMLElement>('[role=tab][data-state=active]')
    if (!bar || !on || bar.scrollWidth <= bar.clientWidth) return
    const left = on.offsetLeft - bar.offsetLeft, right = left + on.offsetWidth
    if (left < bar.scrollLeft || right > bar.scrollLeft + bar.clientWidth)
      bar.scrollTo({ left: Math.max(0, left - 24), behavior: "smooth" })
  }, [tab, data])

  // keep the open location in the URL, after the tab
  React.useEffect(() => {
    const want = `#${tab}${point ? `/${encodeURIComponent(point)}` : ""}`
    if (location.hash !== want && (point || location.hash.includes("/"))) history.replaceState(null, "", want)
  }, [point, tab])
  const lastPoint = React.useRef("Seattle")
  if (point) lastPoint.current = point

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
            {meta.title}<span className="ml-2.5 font-normal text-muted-foreground max-2xl:hidden">Western Washington and Northwest Oregon</span>
          </div>
          {/* the sections, reachable from the top of the page before scrolling to the tab bar */}
          <nav aria-label="Sections" className="flex items-center gap-0.5 max-md:hidden">
            {TABS.map((t) => {
              const Icon = t.icon
              return (
                <button key={t.id} type="button" onClick={() => openTab(t.id)} title={t.label}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  <Icon className="size-4" aria-hidden /><span className="max-lg:hidden">{t.label}</span>
                </button>
              )
            })}
            <button type="button" onClick={() => setPoint(lastPoint.current)} title="Locations"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <MapPin className="size-4" aria-hidden /><span className="max-lg:hidden">Locations</span>
            </button>
          </nav>
          <div className="text-sm text-muted-foreground">Issued {issuedLabel(meta.issued)}</div>
        </div>
      </header>

      <main className="mx-auto max-w-[1320px] px-8 pb-16 max-sm:px-4">
        <div className="pt-10 pb-8"><Headline data={data} /></div>

        <div className="space-y-4">
          <HazardStrip data={data} onOpen={(t) => openTab(t)} />
          <ForecasterNotes data={data} onFull={() => openTab("outlooks")} />
          <NwsAlerts data={data} />
        </div>

        <Section title="Impacts to watch"
          description={`Each hazard's share of models over its threshold day by day, the periods where at least ${Math.round(meta.minAgreement * 100)}% agree at a forecast location, and what changed since yesterday. Thresholds differ for lowland, coast and pass locations; regional models count for the days they cover. Hover anything for details.`}>
          <ImpactBoard data={data} />
        </Section>

        {data.trends && (
          <Section title="Forecast trends"
            description="Each location's precipitation, snow, strongest gust and average high and low over the chosen window, and how each moved since yesterday's briefing. The column headings open the details.">
            <TrendsCard data={data} onOpen={(t) => openTab(t)} onLocation={(n) => setPoint(n)} />
          </Section>
        )}

        <Tabs value={tab} onValueChange={(v) => openTab(v as Tab, false)} className="mt-14 gap-0">
          {/* the section tabs: a full-width sticky bar of larger, icon-led tabs with an underline on the
              open one, sitting on the bar's bottom edge, rather than a segmented control */}
          <div ref={tabsTop} className="sticky top-0 z-30 -mx-8 border-b bg-background/95 px-8 backdrop-blur max-sm:-mx-4 max-sm:px-4">
            <div className="flex items-stretch overflow-x-auto overflow-y-hidden">
              <TabsList variant="line" className="max-w-none shrink-0 justify-start gap-0 p-0 group-data-[orientation=horizontal]/tabs:h-auto">
                {TABS.map((t) => {
                  const Icon = t.icon
                  return (
                    <TabsTrigger key={t.id} value={t.id}
                      className="h-auto flex-none gap-2 rounded-none px-4 pt-4 pb-3.5 text-[15px] font-medium text-muted-foreground after:bottom-0! after:h-[2.5px]! after:rounded-full hover:bg-muted/50 data-[state=active]:text-foreground max-sm:px-3 [&_svg:not([class*='size-'])]:size-[18px]">
                      <Icon aria-hidden />{t.label}
                    </TabsTrigger>
                  )
                })}
              </TabsList>
              {/* locations open in a side panel rather than a tab */}
              <button type="button" onClick={() => setPoint(lastPoint.current)}
                className="ml-auto inline-flex shrink-0 items-center gap-2 px-4 pt-4 pb-3.5 text-[15px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-sm:px-3">
                <MapPin className="size-[18px]" aria-hidden />Locations
              </button>
            </div>
          </div>

          <TabsContent value="precip">
            <Section title="Precipitation" first
              description="How much falls, when and where: region totals for each window, each location and day, every model's total at each location, the model maps, and how the models have been doing lately."
              action={<MapLink req={{ mode: "totals", variable: "precip", days: 7 }} label="Precipitation totals on the map" />}>
              <RegionTotals data={data} />
              <RainByDayCard data={data} />
              <PeakTimingCard data={data} v="precip" />
              <ObsReportsCard data={data} v="precip" />
              <ByLocation data={data} />
              <MapCard title="Precipitation maps" description="Each model on its own grid, then the mean and spread on a common grid."
                tabs={[
                  { id: "p48", label: "Next 48 hours", src: data.maps.short, alt: "48-hour precipitation by model, with mean and spread", note: "Liquid equivalent. Spread is the highest minus the lowest model at each grid cell. Regional models next to the blend and the global models, over the same two 12Z – 12Z days." },
                  { id: "pl", label: `Through day ${meta.days}`, src: data.maps.long, alt: "Full-range precipitation by model", note: "Each panel is labeled with the number of days the model covers; mean and spread use only the days every model covers." },
                ]} />
              <VerificationCard data={data} />
            </Section>
          </TabsContent>

          <TabsContent value="flood">
            <Section title="Flooding" first
              description="What turns rain into a problem: the official river forecasts, how wet it has already been, how close that puts the Seattle area to the landslide threshold, whether an atmospheric river is coming, and how many ensemble members reach the heavy-rain thresholds."
              action={<div className="flex flex-wrap gap-2">
                <MapLink req={{ mode: "totals", variable: "ar", days: 7 }} label="AR outlook on the map" />
                <MapLink req={{ mode: "hourly", layer: "ivt", isobars: true }} label="Moisture transport (IVT) on the map" />
              </div>}>
              <RiversCard data={data} />
              <ObservedCard data={data} />
              <LandslideCard data={data} />
              <ArCard data={data} />
              <OddsCard data={data} />
            </Section>
          </TabsContent>

          <TabsContent value="wind">
            <Section title="Wind" first
              description="The strongest gusts by region and location in each model, day by day, the pressure gradients behind the region's classic wind events (south wind, Gorge and Fraser outflow, onshore pushes), and the model maps."
              action={<MapLink req={{ mode: "hourly", layer: "pgrad", isobars: true, pairs: true }} label="Pressure gradients on the map" />}>
              <WindPeaks data={data} />
              <WindByDayCard data={data} />
              <PeakTimingCard data={data} v="gust" />
              <ObsReportsCard data={data} v="gust" />
              <WindByLocation data={data} />
              <GradientsCard data={data} />
              <MapCard title="Wind and gust maps" description="The strongest sustained wind and gust in each model."
                tabs={[...pickExtremes(data, "short", "the next 48 hours", ["gust", "wind"], " (48 h)"),
                       ...pickExtremes(data, "long", "each model's full range", ["gust", "wind"], ` (to day ${meta.days})`)]} />
            </Section>
          </TabsContent>

          <TabsContent value="coast">
            <Section title="Coast and marine" first
              description="The outer coast, the Strait of Juan de Fuca, the San Juans and Puget Sound: marine warnings, what the buoys are reading, the wave forecast, and the week's high tides against each gauge's flood level.">
              <CoastSection data={data} />
            </Section>
          </TabsContent>

          <TabsContent value="snow">
            <Section title="Snow and mountains" first
              description="Where the snow level sits against the passes, how much snow the models put down, the snowpack so far, and avalanche danger."
              action={<MapLink req={{ mode: "hourly", layer: "frz" }} label="Freezing level on the map" />}>
              <SnowLevelCard data={data} />
              <RainByDayCard data={data} only="snow" />
              <ObsReportsCard data={data} v="snow" />
              <MapCard title="Snowfall maps" description="From each model's own snow field; models without one are left out."
                tabs={[
                  { id: "s48", label: "Next 48 hours", src: data.maps.snow_short, alt: "48-hour snowfall by model", note: "Model snowfall over the next two 12Z – 12Z days." },
                  { id: "s7", label: "7 days", src: data.maps.snow_long, alt: "7-day snowfall by model", note: "Models with their own snow field." },
                ]} />
              <SnowpackCard data={data} />
              <AvalancheCard data={data} />
            </Section>
          </TabsContent>

          <TabsContent value="temp">
            <Section title="Temperature" first
              description="Daily highs and lows against normal for each location, the warmest and coldest each model gets, and how the models' highs and lows have verified lately."
              action={<MapLink req={{ mode: "totals", variable: "tmaxdep", days: 7 }} label="Departures on the map" />}>
              <TempDepartureCard data={data} />
              <MapCard title="High and low temperature maps" description="The highest and lowest 2 m temperature in each model."
                tabs={[...pickExtremes(data, "short", "the next 48 hours", ["tmax", "tmin"], " (48 h)"),
                       ...pickExtremes(data, "long", "each model's full range", ["tmax", "tmin"], ` (to day ${meta.days})`)]} />
              <TempVerificationCard data={data} />
            </Section>
          </TabsContent>

          <TabsContent value="fire">
            <Section title="Wildfire" first
              description="Red Flag Warnings, the fire outlooks from Predictive Services and SPC, humidity and Hot-Dry-Windy conditions in each model, current fires, smoke and drought."
              action={<MapLink req={{ mode: "hourly", layer: "smoke" }} label="Smoke on the map" />}>
              <WildfireTab data={data} />
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

          <TabsContent value="outlooks">
            <Section title="Outlooks and discussions" first
              description="Thunderstorm outlooks, mesoscale discussions and storm reports from SPC, the national excessive rainfall and extended outlooks, and the full forecast discussions from the Seattle and Portland offices."
              action={data.convective ? <MapLink req={{ mode: "totals", variable: "storms", days: 1 }} label="Thunderstorm outlook on the map" /> : undefined}>
              <ConvectiveCard data={data} />
              {data.outlooks ? <>
                <OutlooksCard data={data} />
                <FullDiscussions data={data} />
              </> : <p className="text-muted-foreground">The outlooks and discussions weren't available for this briefing.</p>}
            </Section>
          </TabsContent>

        </Tabs>

        <LocationPanel data={data} name={point} onChange={setPoint} onClose={() => setPoint(null)} />

        <Separator className="mt-14 mb-6" />
        <footer className="grid gap-6 text-sm text-muted-foreground md:grid-cols-3">
          <div>
            <h3 className="mb-1.5 font-medium text-foreground">Sources</h3>
            <p>GRIB2 from NOAA NODD ({meta.sources.ncep.join(", ")}) and ECMWF open data ({meta.sources.ecmwf.join(", ")}), read with Herbie.
              {meta.hasSupplement && " Models marked * come from Open-Meteo."}</p>
            <p className="mt-2">Observed precipitation from NOAA MRMS; snowpack from USDA NRCS SNOTEL; avalanche danger from the
              Northwest Avalanche Center (avalanche.org); landslide threshold from USGS; forecast discussions,
              alerts and outlooks from NWS, WPC and CPC; fire outlooks from SPC and NWCC Predictive Services; fire incidents
              and perimeters from NIFC; drought from the US Drought Monitor.</p>
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
