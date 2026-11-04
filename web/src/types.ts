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
export interface EventChange { label: string; start: string; end: string; level: "likely" | "possible" | null; prevLevel: "likely" | "possible" | null }
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
  path: string; model: string; tier: string; var: "precip" | "snow" | "mean" | "spread" | "pct" | ExtremeVar
  days: number; units: string; run?: string | null; members?: string[]
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
  maps: { short: string | null; snow_short: string | null; long: string | null; snow_long: string | null }
    & Partial<Record<`${ExtremeVar}_${"short" | "long"}`, string | null>>
  cogs: Cog[]
  domain: { lat_min: number; lat_max: number; lon_min: number; lon_max: number }
  regionShapes: Record<string, [number, number][]>
  normals: Normals | null
  alerts: Alerts | null
  change: Change | null
}

/** data/fields.json: time-stepped grids for the interactive map (latest briefing only). */
export type FieldVar = "t2m" | "gust" | "u10" | "v10" | "mslp" | "frz" | "refc" | "ptype"
export interface FieldEntry {
  path: string; model: string; tier: string; var: FieldVar; units: string
  scale: number; nodata: number; times: string[]; run: string; init: string
  categories?: Record<string, string>
}
export interface FieldsManifest { fields: FieldEntry[] }
