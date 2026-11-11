// Shape of data/briefing.json written by briefing/main.py. Numbers may be null where a model
// does not cover a day or a field.

export type N = number | null
export type Tier = "regional" | "blend" | "global"

export interface Region { id: string; name: string; short: string }
export interface Point {
  name: string; kind: "lowland" | "coast" | "pass"; region: string | null; plume: boolean; lat: number; lon: number
  area?: string | null; zone?: string | null   // "Northern Puget Sound" in "Puget Sound"; absent in briefings built before they were added
}

export interface WindowRegion {
  rid: string; region: string; median: number; lo: number; hi: number
  wettest: string; driest: string; n: number
}
export interface Window { days: number; label: string; scale: number; regions: WindowRegion[] }

type ByKind = Record<"lowland" | "coast" | "pass", number>
export interface WindLevels {
  wind_gust_mph: ByKind; wind_gust_leaf_mph?: ByKind; wind_gust_severe_mph: ByKind
  wind_widespread_mph: number; wind_widespread_points: number
  leaf_season?: [string, string]; wind_wet_soil_drop_mph?: number
}

export interface ImpactEvent {
  hazard: string; label: string; unit: string; start: string; end: string
  level: "likely" | "possible"; agreement: number; n_models: number
  points: { name: string; frac: number; peak: number }[]
}

export interface DailyVars {
  precipitation_sum: N[]; rain_sum: N[]; snowfall_sum: N[]
  temperature_2m_max: N[]; temperature_2m_min: N[]; wind_gusts_10m_max: N[]
  wind_speed_10m_max?: N[]            // absent in briefings built before it was added
  relative_humidity_2m_min?: N[]; hdw_max?: N[]; smoke_max?: N[]    // fire weather; absent in older briefings
}

export interface Model {
  label: string; tier: Tier; source: "grib" | "open-meteo"; run: string | null; days: number
  data: Record<string, DailyVars>
}

export interface Ensemble {
  label: string; members: number; source: string; dates: string[]
  points: Record<string, { p10: number[]; p50: number[]; p90: number[] }>
}

export interface ChangeWindow {
  days: number; label: string; overlapDays: number; from: string; to: string
  regions: Record<string, { now: number; prev: number; delta: number }>
  points: Record<string, { now: N; prev: N; delta: N }>
  models: Record<string, Record<string, number>>
}
export interface EventChange {
  label: string; start: string; end: string; level: "likely" | "possible" | null; prevLevel: "likely" | "possible" | null
  // added with the timeline; absent in briefings built before it
  hazard?: string; prevStart?: string | null; prevEnd?: string | null; shifted?: boolean
  agreement?: number | null; where?: { name: string; peak: number | null }[]; unit?: string | null
}
export type TrendVar = "precip" | "snow" | "gust" | "tmax" | "tmin"
export interface TrendStat { median: number; lo: number; hi: number; n: number }
export interface TrendChangeVar { now: number; prev: number; delta: number }
export type ByVar<T> = Partial<Record<TrendVar, T>>
export interface TrendWindow { days: number; label: string; points: Record<string, ByVar<TrendStat>>; regions: Record<string, ByVar<TrendStat>> }
export interface TrendChange {
  days: number; label: string; overlapDays: number
  points: Record<string, ByVar<TrendChangeVar>>; regions: Record<string, ByVar<TrendChangeVar>>
}

export interface RiverGauge {
  lid: string; name: string; lat: number; lon: number; wfo: string; state: string; units: string
  categories: Partial<Record<"action" | "minor" | "moderate" | "major", number>>
  observed: [string, number][]; forecast: [string, number][]; issued: string | null
  now: { stage: number | null; time: string | null; level: number | null }
  crest: { stage: number; time: string; level: number | null }
  record: { stage: number; time: string } | null; url: string
}
export interface Rivers { source: string; gauges: RiverGauge[] }
export interface VerifyScore { mae: number; bias: number | null; pod: number | null; far: number | null; n: number; days: number; obs: number; fc: number }
export interface Verification {
  from: string; to: string; nDays: number; wet: number
  leads: { id: string; label: string; leads: number[] }[]
  models: { model: string; tier: string | null; scores: Record<string, VerifyScore> }[]
  chart: { dates: string[]; observed: Record<string, (number | null)[]>; day1: Record<string, Record<string, (number | null)[]>> }
}

export interface TempScore { mae: number; maeHi: number; maeLo: number; biasHi: number; biasLo: number; within: number; n: number; days: number }
type HiLo = { hi: (number | null)[]; lo: (number | null)[] }
export interface TempVerification {
  from: string; to: string; nDays: number; within: number; source: string
  leads: { id: string; label: string; leads: number[] }[]
  models: { model: string; tier: string | null; scores: Record<string, TempScore> }[]
  chart: { dates: string[]; observed: Record<string, HiLo>; day1: Record<string, Record<string, HiLo>> }
}

export interface ConvArea {
  kind: "cat" | "tornado" | "hail" | "wind" | "severe"; label: string; name: string; dn: number; rank: number; sig: boolean
  fill: string | null; stroke: string | null; points: string[]; geometry: GeoJSON.MultiPolygon
}
export interface StormReport { type: "tornado" | "wind" | "hail"; time: string; lat: number; lon: number; mag: string; location: string; county: string; state: string; comments: string }
export interface Convective {
  source: string
  outlooks: { day: number; issued: string | null; valid: string | null; expire: string | null; areas: ConvArea[] }[]
  reports: StormReport[]
}
export interface PeakPeriod {
  start: string; end: string; peak: number; peakTime: string; models: number; of: number
  peakFrom: string | null; peakTo: string | null; total?: number; heavy?: boolean
}
/** A stretch with any measurable precipitation or snow (median rate over the floor), drawn light. */
export interface LightPeriod { start: string; end: string; peak: number; peakTime: string; total: number }
export interface Buoy {
  id: string; name: string; lat: number; lon: number; area: string; time: string
  wave: N; period: N; waveDir: N; wind: N; gust: N; windDir: N; water: N
  waveMax24: N; gustMax24: N; spark: number[]                 // feet, seconds, mph, °F
}
export interface WavePoint {
  name: string; lat: number; lon: number; near: string | null; area: string
  hourly: { time: string[]; height: N[]; period: N[]; dir: N[] }     // local times, feet
  daily: { date: string; max: number; period: N; dir: N; time: string }[]
}
export interface TideGauge {
  id: string; name: string; near: string | null; area: string
  flood: N; surge: N                                           // minor flood level (ft MLLW); observed − predicted now
  highs: { time: string; height: number; margin: N }[]         // local times; margin = flood − height − surge
}
export interface MarineAlert {
  id: string; event: string; severity: string | null; headline: string | null; onset: string | null; ends: string | null
  areaDesc: string | null; zones: string[]; sender: string | null; url: string | null
}
export interface Coast {
  fetched: string; source: string; buoys: Buoy[]; waves: WavePoint[]; tides: TideGauge[]
  marineAlerts: MarineAlert[] | null; zonePrefixes: string[]
}

export interface ObsReport {
  kind: "rain" | "snow" | "ice" | "gust" | "damage" | "flood"; type: string; time: string | null
  lat: number; lon: number; mag: number | null; unit: string | null; measured: boolean | null
  place: string | null; county: string | null; state: string | null; source: string | null; remark: string | null
  near: string | null                                   // the forecast location within 30 km
  elev_ft?: number | null
  /** set on rows from an office's Public Information Statement report summary */
  summary?: { office: string; title: string; issued: string }
}
/** Observed values at each location's station by local day (the last is today so far), and NWS
 *  local storm reports. */
export interface ObsReports {
  days: string[]; today: string; source: string
  points: Record<string, { precip: N[]; gust: N[]; gustTime: (string | null)[]; snow: N[]; stations: string[] }>
  reports: ObsReport[]
  reportHours?: number                                  // how long after the event a report is shown
}

export interface FrontFrame {
  kind: "analysis" | "forecast"; valid: string; day?: number
  fronts: { type: "cold" | "warm" | "stationary" | "occluded" | "trough" | "dryline" | "squall"; coords: [number, number][] }[]
}
/** WPC surface fronts: the last day's analyses (every 3 h), then the forecast chart's days 1 – 3. */
export interface Fronts { source: string; frames: FrontFrame[] }

export interface PeakTiming {
  hours: number; models: string[]
  weighted?: string[]                                  // the high-resolution models, counted double
  thresholds: { gust_mph: Record<string, number>; rate_in_per_h: number; heavy_in_per_h: number
    snow_in_per_h?: number; heavy_snow_in_per_h?: number; any_rate_in_per_h?: number; any_snow_in_per_h?: number }
  points: Record<string, { gust?: PeakPeriod[]; precip?: PeakPeriod[]; snow?: PeakPeriod[]; precipAny?: LightPeriod[]; snowAny?: LightPeriod[] }>
}

export interface ArCoastRank { rank: number; peak: number | null; start: string | null }
export interface ArCoast {
  points: { name: string; lat: number; lon: number }[]
  names: Record<string, string>; tiers: Record<string, string | null>
  windows: { days: number; label: string; models: Record<string, Record<string, ArCoastRank>>
             median: Record<string, { rank: number; max: number; peak: number | null; n: number; atLeast1: number }> }[]
}

export interface Change {
  prevIssued: string | null
  windows: ChangeWindow[]
  trends?: { windows: TrendChange[] }                  // absent before the trends table was added
  events: { new: EventChange[]; upgraded: EventChange[]; downgraded: EventChange[]; dropped: EventChange[]; same: EventChange[] }
}

export interface Normals {
  source: string
  points: Record<string, number[]>
  windows: {
    days: number; label: string
    regions: Record<string, { normal: number; median: N; pct: N }>
    points: Record<string, { normal: number; median: N; pct: N }>
  }[]
}

export interface Alert {
  id: string; event: string; severity: string | null; certainty: string | null; urgency: string | null
  headline: string | null; onset: string | null; ends: string | null; sender: string | null
  areaDesc: string | null; points: string[]; url: string | null
}
/** `pages`: each location's weather.gov hazards page (forecast zone, county, fire weather zone). */
export interface Alerts { fetched: string; areas: string[]; zones: Record<string, string[]>; pages?: Record<string, string>; items: Alert[]; ok: boolean; demo?: boolean }

/** Window extremes: highest/lowest 2 m temperature (°F), strongest sustained wind and gust (mph). */
export type ExtremeVar = "tmax" | "tmin" | "wind" | "gust"

export interface Cog {
  path: string; model: string; tier: string
  var: "precip" | "snow" | "mean" | "spread" | "pct" | ExtremeVar | "p24" | "p72" | "obs" | "obspct" | "tmaxdep" | "tmindep" | "ar" | "rivers" | "storms"
  days: number; units: string; run?: string | null; members?: string[]; threshold?: number
}

/** A value per time from one model. */
export interface ModelSeries { model: string; tier: Tier; times: string[]; values: N[] }

export interface ArEvent {
  model: string; point: string; rank: number; name: string; peak: number; hours: number
  start: string; end: string; peakTime: string
}
export interface AtmosphericRivers {
  points: string[]; breaks: number[]
  models: { model: string; tier: Tier; times: string[]; ivt: Record<string, N[]> }[]
  events: ArEvent[]
}
export interface Gradient {
  id: string; a: string; b: string; meaning: string
  codes?: (string | null)[]
  locs?: [number, number][]           // [lon, lat] of station A and B
  thresholds: { value: number; label: string }[]
  series: ModelSeries[]
}
export interface SnowLevel { offset_ft: number; passes: { name: string; elev_ft: number; series: ModelSeries[] }[] }
export interface PointOdds {
  thresholds: { rain24: N; rain72: N; snow24: N }
  rain24?: N[]; rain72?: N[]; snow24?: N[]; rain24N?: number[]; rain72N?: number[]; snow24N?: number[]
}
/** Each location's station history: the wettest 1-, 3- and 7-day stretch in each past year over
 *  the same part of the year (from – to, MM-DD). */
export interface ClimoPoint { station: string; sid: string; elev_ft: N; years: number[]; max: Record<string, N[]> }
/** Each station's daily observed and normal precipitation since October 1, through yesterday. */
export interface WaterYear { start: string; dates: string[]; points: Record<string, { obs: N[]; normal: N[] }> }
export interface Climo { from: string; to: string; spans: number[]; source: string; points: Record<string, ClimoPoint>; waterYear?: WaterYear | null }
/** NBM's own exceedance chances (percent) at fixed amounts: per variable, one row per threshold, one value per day. */
export interface NbmOdds {
  run: string; dates: string[]; source: string
  variables: { key: "rain24" | "rain72" | "gust"; label: string; unit: "in" | "mph"; thresholds: number[] }[]
  points: Record<string, Partial<Record<"rain24" | "rain72" | "gust", N[][]>>>
}
export interface Odds { dates: string[]; ensembles: { label: string; members: number; snow: boolean }[]; points: Record<string, PointOdds> }
export interface ObservedStat { obs: N; normal: N; pct: N }
export interface Observed {
  source: string; dates: string[]
  windows: { days: number; label: string; from: string; to: string; missingDays: string[];
             regions: Record<string, ObservedStat>; points: Record<string, ObservedStat> }[]
  daily: Record<string, N[]>
}

export interface Briefing {
  meta: {
    title: string; issued: string; demo: boolean; days: number; minAgreement: number
    coreModels?: string[]                               // the models behind the "core median" choice
    cycle?: string; firstDayHours?: number          // the edition's model cycle; hours of the first 12Z day it covers
    hasSupplement: boolean; sources: { ncep: string[]; ecmwf: string[] }
  }
  regions: Region[]
  points: Point[]
  status: { label: string; kind: "model" | "ensemble"; ok: boolean; source: string; run: string | null; reason?: string | null }[]
  windows: Window[]
  wettest: { start: string; end: string; amount: number }
  events: ImpactEvent[]
  windLevels?: WindLevels              // absent in briefings built before it was added
  timeline: {
    labels: string[]; dates: string[]; matrix: number[][]
    // per row and day: the most affected location and each model's [label, value, crossed]; absent before it was added
    detail?: ({ point: string; models: [string, number | null, boolean][] } | null)[][]
  }
  totals: {
    days: number; label: string
    rows: { model: string; tier: Tier; source: string; regions: Record<string, N>; points: Record<string, N> }[]
  }[]
  gribAreaMeans: { model: string; tier: Tier; run: string; windows: Record<string, N>[] }[]
  dates: string[]
  models: Model[]
  ensembles: Ensemble[]
  maps: { short: string | null; snow_short: string | null; long: string | null; snow_long: string | null; observed?: string | null }
    & Partial<Record<`${ExtremeVar}_${"short" | "long"}`, string | null>>
  cogs: Cog[]
  domain: { lat_min: number; lat_max: number; lon_min: number; lon_max: number }
  regionShapes: Record<string, [number, number][]>
  normals: Normals | null
  alerts: Alerts | null
  change: Change | null
  trends?: { windows: TrendWindow[] }                  // the trends table above the tabs
  arCoast?: ArCoast | null                              // the coastal AR outlook (map layer); absent before it was added
  rivers?: Rivers | null                                // NWRFC river forecasts; absent before they were added
  // the headline and lead, written at build time from the briefing's facts; absent before it was added
  summary?: { headline: string; lede: string; source: "openai" | "rules"; model?: string } | null
  coast?: Coast | null                                 // buoys, wave forecast, tides and marine warnings
  obsReports?: ObsReports | null                       // station observations and NWS storm reports
  fronts?: Fronts | null                               // WPC surface fronts for the map; absent before it was added
  timing?: PeakTiming | null                           // when gusts and heavy precipitation peak, by location; absent before it was added
  verification?: Verification | null                   // recent forecasts scored against MRMS; absent before it was added
  tempVerification?: TempVerification | null           // recent highs and lows scored against URMA; absent before it was added
  // each region's value over the last few briefings, on dates they all share (oldest run first)
  trendHistory?: { windows: { days: number; from: string; to: string; nDays: number; runs: (string | null)[]; regions: Record<string, ByVar<(number | null)[]>>
    points?: Record<string, ByVar<(TrendStat | null)[]>> }[] }   // points: added with the run-to-run cards
  ar?: AtmosphericRivers | null
  gradients?: Gradient[]
  snowLevel?: SnowLevel | null
  odds?: Odds | null
  climo?: Climo | null                                 // absent before station histories were added
  nbmOdds?: NbmOdds | null                             // absent before NBM probabilities were added
  observed?: Observed | null
  snowpack?: Snowpack | null
  outlooks?: Outlooks | null
  landslide?: Landslide | null
  avalanche?: Avalanche | null
  tempDeparture?: TempDeparture | null
  wildfire?: Wildfire | null
  convective?: Convective | null                       // SPC outlooks and storm reports; absent before it was added
}

export interface FireAlert {
  id: string; event: string; headline: string | null; onset: string | null; ends: string | null
  sender: string | null; areaDesc: string | null; points: string[]; description?: string; url: string | null
}
export interface SpcArea { kind: "windrh" | "dryt"; dn: number; label: string; probability: boolean; points: string[]; geometry: GeoJSON.MultiPolygon }
export interface SpcDay { day: number; valid: string | null; expire: string | null; date: string | null; areas: SpcArea[] }
/** NWCC 7-day level: 0 none, 1 moist, 2 dry, 3 very dry, 4 high-risk day. */
export interface PsaDay { code: number; short: string; label: string; level: number }
export interface PsaArea { code: string; name: string; points: string[]; days: (PsaDay | null)[]; geometry: GeoJSON.MultiPolygon }
export interface Incident {
  id: string | null; name: string; type: "Wildfire" | "Prescribed fire" | "Complex"; acres: N; contained: N
  discovered: string | null; updated: string | null; cause: string | null; state: string; county: string | null
  lon: number; lat: number
}
export interface DroughtCategory { dm: number; label: string; geometry: GeoJSON.MultiPolygon }
export interface Wildfire {
  fetched: string; demo?: boolean; sources: Record<string, boolean>
  alerts: FireAlert[] | null
  spc: SpcDay[] | null
  psa: { dates: string[]; areas: PsaArea[] } | null
  incidents: Incident[] | null
  perimeters: GeoJSON.FeatureCollection | null
  drought: { released: string | null; mapDate: string | null; validEnd: string | null; points: Record<string, number | null>; categories: DroughtCategory[] } | null
}

export interface TempDepartureVar { forecast: N[]; low: N[]; high: N[]; models: number[]; departure: N[] }
export interface TempDeparture {
  source: string; dates: string[]
  normals: Record<string, { tmax: N[]; tmin: N[] }>
  points: Record<string, { tmax: TempDepartureVar; tmin: TempDepartureVar }>
  regions: Record<string, { tmax: N[]; tmin: N[] }>
  windows: { days: number; label: string; points: Record<string, { tmax: N; tmin: N }>; regions: Record<string, { tmax: N; tmin: N }> }[]
}

export interface Landslide {
  threshold: number; p15Factor: number; source: string
  days: { start: string; end: string }[]
  points: { name: string
            observed: { p3: N; p15: N; index: N; needed3: N }
            models: { model: string; tier?: Tier; p3: N[]; p15: N[]; index: N[] }[] }[]
}

export interface AvalancheDanger { lower: number | null; middle: number | null; upper: number | null }
export interface AvalancheZone {
  id: number; name: string; state: string; level: number; label: string; color: string; link: string
  travelAdvice: string | null; start: string | null; end: string | null; offSeason: boolean
  today?: AvalancheDanger | null; tomorrow?: AvalancheDanger | null
  bottomLine?: string | null; problems?: string[]; warning?: string | null
}
export interface Avalanche { center: string; url: string; zones: AvalancheZone[]; inSeason: boolean; until: string | null }

export interface SnowStation {
  name: string; triplet: string; elev_ft: number | null; lat: number; lon: number; date: string
  swe: number; median: N; pct: N; change7: N; depth: N
}
export interface Snowpack {
  asOf: string | null; minMedian: number; source: string
  areas: { name: string; stations: SnowStation[]; swe: N; median: N; pct: N; change7: N }[]
}
export interface Discussion {
  office: string; name: string; issued: string | null; url: string
  synopsis: string[] | null; keyMessages: string[] | null; hydrology: string[] | null
  sections?: { title: string; paragraphs: string[] }[] | null     // the whole discussion; absent before it was added
}
export interface Outlooks {
  discussions: Discussion[]
  ero?: { names: Record<string, string>; url: string; days: ({ day: number; points: Record<string, number> } | null)[] }
  cpc?: { url: string; outlooks: { period: string; var: "temperature" | "precipitation"; start: string | null; end: string | null
                                   points: Record<string, { cat: string | null; prob: number | null } | null> }[] }
}

/** data/fields.json: time-stepped grids for the interactive map (latest briefing only). */
export type FieldVar = "t2m" | "gust" | "u10" | "v10" | "mslp" | "frz" | "refc" | "ptype" | "ivtu" | "ivtv" | "apcp" | "asnow" | "rh" | "smoke"
export interface FieldEntry {
  path: string; model: string; tier: string; var: FieldVar; units: string
  scale: number; nodata: number; times: string[]; run: string; init: string
  categories?: Record<string, string>
  keys?: string[]          // observed radar: the MRMS file for each time (see lib/mrms.ts)
}
export interface FieldsManifest { fields: FieldEntry[] }
