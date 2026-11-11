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
import { EditionNote, Headline, RunStatus } from "@/sections/Overview"
import { RunTrendCard } from "@/sections/RunTrend"
import { UnusualCard } from "@/sections/Unusual"
import { WaterYearCard } from "@/sections/WaterYear"
import { TrendsCard } from "@/sections/Trends"
import { TempVerificationCard, VerificationCard } from "@/sections/Verify"
import { ConvectiveCard } from "@/sections/Convective"
import { ObsReportsCard } from "@/sections/ObsReports"
import { BuoysCard, MarineWarningsCard, TidesCard, WaveForecastCard } from "@/sections/Coast"
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

/** One of a tab's groups (Forecast, Observed, Model verification), under a heading a step above the card titles. */
type Group = { id: string; title: string; show: unknown; children: React.ReactNode }
const GROUP_TITLES = { forecast: "Forecast", observed: "Observed", verify: "Model verification" }

/** A tab's cards in its groups, with links at the top that jump to each (when there's more than one). */
function Groups({ tab, groups }: { tab: string; groups: Group[] }) {
  const gs = groups.filter((g) => g.show)
  return (
    <>
      {gs.length > 1 && (
        <nav className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground" aria-label="Sections of this tab">
          {gs.map((g, i) => (
            <React.Fragment key={g.id}>
              {i > 0 && <span aria-hidden>·</span>}
              <a href={`#${tab}`} onClick={(e) => { e.preventDefault(); document.getElementById(`${tab}-${g.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }) }}
                className="hover:text-foreground hover:underline">{g.title}</a>
            </React.Fragment>
          ))}
        </nav>
      )}
      {gs.map((g, i) => (
        <div key={g.id} className={`space-y-4 ${i > 0 ? "pt-8" : "pt-2"}`}>
          {gs.length > 1 && (
            <h3 id={`${tab}-${g.id}`} className="scroll-mt-24 text-lg font-semibold">{g.title}</h3>
          )}
          {g.children}
        </div>
      ))}
    </>
  )
}

/** "By day" and "By model" views of one By location card. */
function LocationViews({ day, model }: { day: (s: React.ReactNode) => React.ReactNode; model: (s: React.ReactNode) => React.ReactNode }) {
  const [view, setView] = React.useState<"day" | "model">("day")
  const sw = (
    <Tabs value={view} onValueChange={(v) => setView(v as "day" | "model")}>
      <TabsList><TabsTrigger value="day">By day</TabsTrigger><TabsTrigger value="model">By model</TabsTrigger></TabsList>
    </Tabs>
  )
  return <>{view === "day" ? day(sw) : model(sw)}</>
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
        <div className="mx-auto max-w-[1320px] px-8 max-sm:px-4">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pt-3.5 pb-2.5 max-md:pb-3.5">
            <div className="font-semibold">
              {meta.title}<span className="ml-2.5 font-normal text-muted-foreground max-2xl:hidden">Western Washington and Northwest Oregon</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
              <span>Issued {issuedLabel(meta.issued)}</span>
              <span aria-hidden>·</span>
              <EditionNote data={data} />
              <RunStatus data={data} />
            </div>
          </div>
          {/* the sections, reachable from the top of the page before scrolling to the tab bar */}
          <nav aria-label="Sections" className="-ml-1.5 xl:-ml-2 flex items-center gap-0.5 overflow-x-auto pb-2 max-md:hidden">
            {TABS.map((t) => {
              const Icon = t.icon
              return (
                <button key={t.id} type="button" onClick={() => openTab(t.id)} title={t.label}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground xl:px-2 xl:text-sm hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  <Icon className="size-4" aria-hidden /><span className="max-lg:hidden">{t.label}</span>
                </button>
              )
            })}
            <button type="button" onClick={() => setPoint(lastPoint.current)} title="Locations"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground xl:px-2 xl:text-sm hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <MapPin className="size-4" aria-hidden /><span className="max-lg:hidden">Locations</span>
            </button>
          </nav>
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
              description="How much falls, when and where: region totals for each window, each location by day or by model, when the heaviest comes, and the model maps; then what has fallen lately, and how the models have been doing."
              action={<MapLink req={{ mode: "totals", variable: "precip", days: 7 }} label="Precipitation totals on the map" />}>
              <Groups tab="precip" groups={[
                { id: "forecast", title: GROUP_TITLES.forecast, show: true, children: <>
                  <RegionTotals data={data} />
                  <LocationViews day={(sw) => <RainByDayCard data={data} switcher={sw} />} model={(sw) => <ByLocation data={data} switcher={sw} />} />
                  <UnusualCard data={data} />
                  <PeakTimingCard data={data} v="precip" />
                  <RunTrendCard data={data} vars={["precip"]} />
                  <MapCard title="Precipitation maps" description="Each model on its own grid, then the mean and spread on a common grid."
                    map={{ req: { mode: "totals", variable: "spread", days: 7 }, label: "Model spread on the map" }}
                    tabs={[
                      { id: "p48", label: "Next 48 hours", src: data.maps.short, alt: "48-hour precipitation by model, with mean and spread", note: "Liquid equivalent. Spread is the highest minus the lowest model at each grid cell. Regional models next to the blend and the global models, over the same two days (4 AM – 4 AM)." },
                      { id: "pl", label: `Through day ${meta.days}`, src: data.maps.long, alt: "Full-range precipitation by model", note: "Each panel is labeled with the number of days the model covers; mean and spread use only the days every model covers." },
                    ]} />
                </> },
                { id: "observed", title: GROUP_TITLES.observed, show: data.obsReports || data.observed, children: <>
                  <ObsReportsCard data={data} v="precip" />
                  <ObservedCard data={data} />
                  <WaterYearCard data={data} />
                </> },
                { id: "verify", title: GROUP_TITLES.verify, show: data.verification, children: <VerificationCard data={data} /> },
              ]} />
            </Section>
          </TabsContent>

          <TabsContent value="flood">
            <Section title="Flooding" first
              description="What turns rain into a problem: the official river forecasts, whether an atmospheric river is coming, and how many ensemble members reach the heavy-rain thresholds; then how close recent rain puts the Seattle area to the landslide threshold. Recent rainfall itself is on the Precipitation tab."
              action={data.rivers ? <MapLink req={{ mode: "totals", variable: "rivers", days: 7 }} label="River forecasts on the map" /> : undefined}>
              <Groups tab="flood" groups={[
                { id: "forecast", title: GROUP_TITLES.forecast, show: true, children: <>
                  <RiversCard data={data} />
                  <ArCard data={data} />
                  <OddsCard data={data} vars={["rain24", "rain72", "snow24"]} title="Odds of heavy rain and snow" />
                </> },
                { id: "observed", title: GROUP_TITLES.observed, show: data.landslide?.points.length, children: <LandslideCard data={data} /> },
              ]} />
            </Section>
          </TabsContent>

          <TabsContent value="wind">
            <Section title="Wind" first
              description="The strongest gusts by region and location, by day or by model, when they come, the pressure gradients behind the region's classic wind events (south wind, Gorge and Fraser outflow, onshore pushes), and the model maps; then the gusts actually measured and reported."
              action={<MapLink req={{ mode: "totals", variable: "gust", days: 7 }} label="Strongest gusts on the map" />}>
              <Groups tab="wind" groups={[
                { id: "forecast", title: GROUP_TITLES.forecast, show: true, children: <>
                  <WindPeaks data={data} />
                  <LocationViews day={(sw) => <WindByDayCard data={data} switcher={sw} />} model={(sw) => <WindByLocation data={data} switcher={sw} />} />
                  <PeakTimingCard data={data} v="gust" />
                  <OddsCard data={data} vars={["gust"]} title="Odds of strong gusts" />
                  <RunTrendCard data={data} vars={["gust"]} />
                  <GradientsCard data={data} />
                  <MapCard title="Wind and gust maps" description="The strongest sustained wind and gust in each model."
                    map={{ req: { mode: "totals", variable: "wind", days: 7 }, label: "Strongest wind on the map" }}
                    tabs={[...pickExtremes(data, "short", "the next 48 hours", ["gust", "wind"], " (48 h)"),
                           ...pickExtremes(data, "long", "each model's full range", ["gust", "wind"], ` (to day ${meta.days})`)]} />
                </> },
                { id: "observed", title: GROUP_TITLES.observed, show: data.obsReports, children: <ObsReportsCard data={data} v="gust" /> },
              ]} />
            </Section>
          </TabsContent>

          <TabsContent value="coast">
            <Section title="Coast and marine" first
              description="The outer coast, the Strait of Juan de Fuca, the San Juans and Puget Sound: marine warnings, the wave forecast and the week's high tides against each gauge's flood level; then what the buoys are reading.">
              {data.coast ? <Groups tab="coast" groups={[
                { id: "forecast", title: GROUP_TITLES.forecast, show: true, children: <>
                  <MarineWarningsCard data={data} />
                  <WaveForecastCard data={data} />
                  <TidesCard data={data} />
                </> },
                { id: "observed", title: GROUP_TITLES.observed, show: data.coast.buoys.length, children: <BuoysCard data={data} /> },
              ]} /> : <p className="text-sm text-muted-foreground">Coast and marine data aren't in this briefing.</p>}
              {data.coast && <p className="text-xs text-muted-foreground">Sources: {data.coast.source}.</p>}
            </Section>
          </TabsContent>

          <TabsContent value="snow">
            <Section title="Snow and mountains" first
              description="Where the snow level sits against the passes, how much snow the models put down and avalanche danger; then the new snow observed and the snowpack so far."
              action={<MapLink req={{ mode: "totals", variable: "snow", days: 7 }} label="Snowfall totals on the map" />}>
              <Groups tab="snow" groups={[
                { id: "forecast", title: GROUP_TITLES.forecast, show: true, children: <>
                  <SnowLevelCard data={data} />
                  <RainByDayCard data={data} only="snow" />
                  <PeakTimingCard data={data} v="snow" />
                  <RunTrendCard data={data} vars={["snow"]} />
                  <AvalancheCard data={data} />
                  <MapCard title="Snowfall maps" description="From each model's own snow field; models without one are left out."
                    tabs={[
                      { id: "s48", label: "Next 48 hours", src: data.maps.snow_short, alt: "48-hour snowfall by model", note: "Model snowfall over the next two days (4 AM – 4 AM)." },
                      { id: "s7", label: "7 days", src: data.maps.snow_long, alt: "7-day snowfall by model", note: "Models with their own snow field." },
                    ]} />
                </> },
                { id: "observed", title: GROUP_TITLES.observed, show: data.obsReports || data.snowpack?.areas.length, children: <>
                  <ObsReportsCard data={data} v="snow" />
                  <SnowpackCard data={data} />
                </> },
              ]} />
            </Section>
          </TabsContent>

          <TabsContent value="temp">
            <Section title="Temperature" first
              description="Daily highs and lows against normal for each location, the warmest and coldest each model gets, and how the models' highs and lows have verified lately."
              action={<MapLink req={{ mode: "hourly", layer: "t2m" }} label="Temperature on the map" />}>
              <Groups tab="temp" groups={[
                { id: "forecast", title: GROUP_TITLES.forecast, show: true, children: <>
                  <TempDepartureCard data={data} />
                  <RunTrendCard data={data} vars={["tmax", "tmin"]} />
                  <MapCard title="High and low temperature maps" description="The highest and lowest 2 m temperature in each model."
                    map={{ req: { mode: "totals", variable: "tmax", days: 7 }, label: "Highs and lows on the map" }}
                    tabs={[...pickExtremes(data, "short", "the next 48 hours", ["tmax", "tmin"], " (48 h)"),
                           ...pickExtremes(data, "long", "each model's full range", ["tmax", "tmin"], ` (to day ${meta.days})`)]} />
                </> },
                { id: "verify", title: GROUP_TITLES.verify, show: data.tempVerification, children: <TempVerificationCard data={data} /> },
              ]} />
            </Section>
          </TabsContent>

          <TabsContent value="fire">
            <Section title="Wildfire" first
              description="Red Flag Warnings, the fire outlooks from Predictive Services and SPC, humidity and Hot-Dry-Windy conditions in each model, current fires, smoke and drought."
              action={data.wildfire?.incidents?.length || data.wildfire?.perimeters?.features.length
                ? <MapLink req={{ mode: "totals", overlays: { fires: true } }} label="Fires on the map" /> : undefined}>
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
              <Groups tab="outlooks" groups={[
                { id: "forecast", title: GROUP_TITLES.forecast, show: true, children: <>
                  <ConvectiveCard data={data} part="outlook" />
                  {data.outlooks ? <>
                    <OutlooksCard data={data} />
                    <FullDiscussions data={data} />
                  </> : <p className="text-muted-foreground">The outlooks and discussions weren't available for this briefing.</p>}
                </> },
                { id: "observed", title: GROUP_TITLES.observed, show: data.convective, children: <ConvectiveCard data={data} part="now" /> },
              ]} />
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
