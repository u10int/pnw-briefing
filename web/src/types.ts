// Shape of data/briefing.json written by briefing/main.py. Numbers may be null where a model
// does not cover a day or a field.

export type N = number | null
export type Tier = "regional" | "blend" | "global"

export interface Region { id: string; name: string; short: string }
export interface Point { name: string; kind: "lowland" | "coast" | "pass"; region: string | null; plume: boolean; lat: number; lon: number }

export interface WindowRegion {
  rid: string; region: string; median: number; lo: number; hi: number
  wettest: string; driest: string; n: number
}
export interface Window { days: number; label: string; scale: number; regions: WindowRegion[] }

export interface ImpactEvent {
  hazard: string; label: string; unit: string; start: string; end: string
  level: "likely" | "possible"; agreement: number; n_models: number
  points: { name: string; frac: number; peak: number }[]
}

export interface DailyVars {
  precipitation_sum: N[]; rain_sum: N[]; snowfall_sum: N[]
  temperature_2m_max: N[]; temperature_2m_min: N[]; wind_gusts_10m_max: N[]
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
export interface Change {
  prevIssued: string | null
  windows: ChangeWindow[]
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
export interface Alerts { fetched: string; areas: string[]; zones: Record<string, string[]>; items: Alert[]; ok: boolean; demo?: boolean }

/** Window extremes: highest/lowest 2 m temperature (°F), strongest sustained wind and gust (mph). */
export type ExtremeVar = "tmax" | "tmin" | "wind" | "gust"

export interface Cog {
  path: string; model: string; tier: string
  var: "precip" | "snow" | "mean" | "spread" | "pct" | ExtremeVar | "p24" | "p72" | "obs" | "obspct" | "tmaxdep" | "tmindep"
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
    hasSupplement: boolean; sources: { ncep: string[]; ecmwf: string[] }
  }
  regions: Region[]
  points: Point[]
  status: { label: string; kind: "model" | "ensemble"; ok: boolean; source: string; run: string | null; reason?: string | null }[]
  windows: Window[]
  wettest: { start: string; end: string; amount: number }
  events: ImpactEvent[]
  timeline: { labels: string[]; dates: string[]; matrix: number[][] }
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
  ar?: AtmosphericRivers | null
  gradients?: Gradient[]
  snowLevel?: SnowLevel | null
  odds?: Odds | null
  observed?: Observed | null
  snowpack?: Snowpack | null
  outlooks?: Outlooks | null
  landslide?: Landslide | null
  avalanche?: Avalanche | null
  tempDeparture?: TempDeparture | null
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
}
export interface Outlooks {
  discussions: Discussion[]
  ero?: { names: Record<string, string>; url: string; days: ({ day: number; points: Record<string, number> } | null)[] }
  cpc?: { url: string; outlooks: { period: string; var: "temperature" | "precipitation"; start: string | null; end: string | null
                                   points: Record<string, { cat: string | null; prob: number | null } | null> }[] }
}

/** data/fields.json: time-stepped grids for the interactive map (latest briefing only). */
export type FieldVar = "t2m" | "gust" | "u10" | "v10" | "mslp" | "frz" | "refc" | "ptype" | "ivtu" | "ivtv"
export interface FieldEntry {
  path: string; model: string; tier: string; var: FieldVar; units: string
  scale: number; nodata: number; times: string[]; run: string; init: string
  categories?: Record<string, string>
}
export interface FieldsManifest { fields: FieldEntry[] }
