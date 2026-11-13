import * as React from "react"
import * as maplibregl from "maplibre-gl"
import type { GeoJSONSource, MapMouseEvent, StyleSpecification } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
// MapLibre runs a web worker for vector/GeoJSON work; have Vite bundle it and tell MapLibre where it is.
import { summarize } from "@/sections/Hazards"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ChevronLeft, ChevronRight, CircleHelp, ExternalLink, Maximize2, Minimize2, Pause, Play, SlidersHorizontal, X, GripHorizontal, PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { Popover } from "radix-ui"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FALLBACK, STYLE_URL, withKey } from "@/lib/basemap"
import { loadCog } from "@/lib/cog"
import { MRMS_MODEL } from "@/lib/mrms-name"
import type { Md } from "@/lib/spcmd"
import { useMds } from "@/lib/useMds"
import { REPORT_COLORS, reportMag, SPC_CAT } from "@/sections/Convective"
import { nearestFrame, preload, SAT_KINDS, type SatKind, type SatTimes, satTimes, satUrl } from "@/lib/satellite"
import { bicubicAt, fieldUrl, gridPos, loadField, nearestAt, nearestTime, type Elevation, elevationFor, pressureGradient, windArrows, windFrom } from "@/lib/fields"
import { contourAsync, isobarsAsync } from "@/lib/fields-pool"
import { GRAD_COLORS, gradLevel, pairName, seriesAt } from "@/lib/gradients"
import type { MapRequest } from "@/lib/maplink"
import { GridLayer, type GridDraw } from "@/lib/gl/grid-layer"
import { ParticleLayer, type WindDraw } from "@/lib/gl/particle-layer"
import { sunLight, VolumeLayer } from "@/lib/gl/volume-layer"
import { corners, GridDrape, groundFor, Snowline, snowLevels } from "@/lib/gl/terrain"
import { type LonLat, SECTION_PRESETS, type SectionLine } from "@/lib/xsection"
import { Profile } from "@/sections/Profile"
import { CrossSection } from "@/sections/CrossSection"
import { colorLut, frac, frzColor, heightLut, heightRgb, hexRgb, ISO_BY_HEIGHT, ISOS, legendStops, loadVolume, lutFor, mfluxRgb, SOURCE, transfer, unpack, useVolumes,
  isDerived, LEVEL_VIEWS, pressureAtKm, viewVar, VIEW_LABEL, VOL_ORDER, type VolumeEntry, type VolumeVar, type VolVar } from "@/lib/volume"
import { levelOverlay, pointCloud, trajectories } from "@/lib/volume-overlays"
import { type Grid, mercY, sameGrid } from "@/lib/gl/util"
import { AR_COLORS, AR_LABELS, FLOOD_COLORS, FLOOD_LABELS, FRZ, GUST, IVT, legendBins, PCT, PGRAD, PRECIP, PROB, PTYPE_COLORS, PTYPE_NAMES, type Ramp, REFC, RH, SMOKE, SNOW, SPREAD, TDEP, TEMP, WIND } from "@/lib/ramps"
import { contrastTextColor } from "@/lib/contrast"
import type { ArCoast, Briefing, Cog, Convective, ExtremeVar, FrontFrame, Fronts, ObsReport, RiverGauge, Wildfire, Rivers, FieldEntry, FieldsManifest, FieldVar, Gradient } from "@/types"
import { ptDayHour } from "@/lib/format"
import { liveReports } from "@/lib/obsreports"
import { addFrontLayers, FRONT_COLORS, FRONT_LAYERS, frontFrame, frontGeoJSON } from "@/lib/fronts"
import { openLocation } from "@/lib/locationlink"

// ------------------------------------------------------------------ map plumbing

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] }

/** Public AWS Terrain Tiles (Terrarium-encoded elevation), no key needed, read through a protocol
 *  that flattens everything below sea level: the tiles include bathymetry, and sea-floor relief
 *  under the ocean grids would read as weather structure. */
const DEM_TILES = "dem-land://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
let demProtocol = false
function addDemProtocol() {
  if (demProtocol) return
  demProtocol = true
  maplibregl.addProtocol("dem-land", async (params, abort) => {
    const r = await fetch(params.url.replace("dem-land://", "https://"), { signal: abort.signal })
    if (!r.ok) throw new Error(`terrain tile ${r.status}`)
    const img = await createImageBitmap(await r.blob())
    const c = new OffscreenCanvas(img.width, img.height)
    const ctx = c.getContext("2d", { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, img.width, img.height)
    const d = px.data
    for (let i = 0; i < d.length; i += 4) {
      // Terrarium: elevation = R * 256 + G + B / 256 - 32768 (m); R < 128 means below sea level
      if (d[i] < 128) { d[i] = 128; d[i + 1] = 0; d[i + 2] = 0 }
    }
    ctx.putImageData(px, 0, 0)
    return { data: await (await c.convertToBlob({ type: "image/png" })).arrayBuffer() }
  })
}


const cogUrl = (c: Cog) => (c.path.startsWith("data:") ? c.path : `data/${c.path}`)

/** Keeps several maps' cameras together. */
/** One volume variable's bytes for a model, loaded while `on` (null until then, or without it). */
function useVolData(entry: VolumeEntry | undefined, name: string, on: boolean): Uint8Array | null {
  const v = entry?.vars[name]
  const [got, setGot] = React.useState<{ path: string; data: Uint8Array } | null>(null)
  React.useEffect(() => {
    if (!v || !on || got?.path === v.path) return
    let live = true
    loadVolume(v).then((d) => { if (live) setGot({ path: v.path, data: d }) }).catch(() => {})
    return () => { live = false }
  }, [v?.path, on])
  return v && got?.path === v.path ? got.data : null
}

/** A camera: centre, zoom, tilt and turn. */
export interface Camera { lon: number; lat: number; zoom: number; pitch: number; bearing: number }
/** Keeps the panes' cameras together; opens the first on `initial` (a shared link's view) and tells
 *  `onMove` listeners when the view changes. */
function useCameraSync(initial: Camera | null = null) {
  const maps = React.useRef(new Set<maplibregl.Map>())
  const busy = React.useRef(false)
  const restore = React.useRef(initial)
  const keep3d = React.useRef(!!initial && (initial.pitch > 0 || initial.bearing !== 0))
  const listeners = React.useRef(new Set<() => void>())
  return React.useMemo(() => ({
    add(m: maplibregl.Map) {
      maps.current.add(m)
      m.on("move", () => {
        listeners.current.forEach((f) => f())
        if (busy.current) return
        busy.current = true
        for (const o of maps.current) if (o !== m) o.jumpTo({ center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() })
        busy.current = false
      })
      const c = restore.current
      if (c) {
        // again once it's loaded (the opening fit to the region lands after the first jump); kept
        // until then, in case this map is replaced before it loads
        const go = () => m.jumpTo({ center: [c.lon, c.lat], zoom: c.zoom, pitch: c.pitch, bearing: c.bearing })
        go(); m.once("load", () => { if (restore.current === c) { restore.current = null; go() } })
        return
      }
      for (const o of maps.current) if (o !== m) { m.jumpTo({ center: o.getCenter(), zoom: o.getZoom() }); break }
    },
    remove(m: maplibregl.Map) { maps.current.delete(m) },
    /** The first pane's camera, or null before there's a map. */
    camera(): Camera | null {
      const m = maps.current.values().next().value
      if (!m) return null
      const c = m.getCenter()
      return { lon: c.lng, lat: c.lat, zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() }
    },
    onMove(f: () => void) { listeners.current.add(f); return () => { listeners.current.delete(f) } },
    /** Glide every pane to a camera. */
    fly(c: Camera) {
      const m = maps.current.values().next().value
      m?.easeTo({ center: [c.lon, c.lat], zoom: c.zoom, pitch: c.pitch, bearing: c.bearing, duration: 1400 })
    },
    /** True once, when a restored view was tilted: the 3D view then keeps it rather than tilting itself. */
    keepRestored3d() { const k = keep3d.current; keep3d.current = false; return k },
  }), [])
}

// ------------------------------------------------------------------ time

/**
 * The shared forecast time (ms since epoch). Kept outside React state: during playback it changes
 * every animation frame, and the maps read it directly rather than re-rendering the card.
 */
class Clock {
  time: number | null = null
  playing = false
  version = 0
  /** Channels still loading the data for the current time; playback waits for them. */
  busy = new Set<object>()
  private subs = new Set<() => void>()
  hold(who: object, on: boolean) {
    if (on) this.busy.add(who)
    else this.busy.delete(who)
  }
  set(time: number | null, playing = this.playing) {
    this.time = time
    this.playing = playing
    this.version++
    this.subs.forEach((f) => f())
  }
  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => { this.subs.delete(f) }
  }
  snapshot = () => this.version
}

const parsed = new WeakMap<string[], number[]>()
const msOf = (times: string[]) => {
  if (!parsed.has(times)) parsed.set(times, times.map(Date.parse))
  return parsed.get(times)!
}
/** Fractional index of a time within a list of times (clamped to the ends). */
function posOf(ms: number[], time: number): number {
  if (!ms.length) return 0
  if (time <= ms[0]) return 0
  for (let i = 0; i < ms.length - 1; i++) if (time <= ms[i + 1]) return i + (time - ms[i]) / (ms[i + 1] - ms[i])
  return ms.length - 1
}
function timeAt(ms: number[], pos: number): number {
  const i = Math.min(ms.length - 1, Math.max(0, Math.floor(pos)))
  return i >= ms.length - 1 ? ms[ms.length - 1] : ms[i] + (pos - i) * (ms[i + 1] - ms[i])
}

const MAX_GAP = 6.1 * 3600e3
/**
 * Which two forecast steps to blend for a time. Playback interpolates between neighbouring steps up
 * to 6 hours apart; otherwise (and when paused) the nearest step within `tolH` is shown on its own.
 */
function bracket(times: string[], time: number, interp: boolean, tolH: number): { i0: number; i1: number; t: number } | null {
  const ms = msOf(times)
  if (interp) {
    for (let i = 0; i < ms.length - 1; i++) {
      if (time >= ms[i] && time <= ms[i + 1] && ms[i + 1] - ms[i] <= MAX_GAP) {
        const t = (time - ms[i]) / (ms[i + 1] - ms[i])
        if (t < 1e-4) return { i0: i, i1: i, t: 0 }
        if (t > 1 - 1e-4) return { i0: i + 1, i1: i + 1, t: 0 }
        return { i0: i, i1: i + 1, t }
      }
    }
  }
  const i = nearestTime(times, new Date(time).toISOString(), tolH)
  return i < 0 ? null : { i0: i, i1: i, t: 0 }
}

// ------------------------------------------------------------------ what a pane shows

type FC = GeoJSON.FeatureCollection
interface Loaded {
  draw: GridDraw | null
  note?: string
  bare?: boolean            // no grid on purpose (the AR outlook is markers only)
  sample: (lon: number, lat: number, t: number, smooth: boolean) => string | null
}
interface Overlays { spc?: FC | null; isobars?: FC | null; centers?: FC | null; pairs?: FC | null; freezing?: FC | null; arrows?: FC | null; ar?: FC | null; sample?: (lon: number, lat: number, smooth: boolean) => string | null }
/** One channel's choice for the current time: `key` identifies the data, `t` blends within it. */
/** What to show for a time: its key, the blend factor, how to load it, and (for overlays that cost
 *  real work) whether it's already worked out, or cheap enough to ask for while scrubbing. */
interface Choice<T> { key: string; t: number; load: () => Promise<T>; ready?: boolean }

interface View {
  key: string
  title: string
  sub(time: number | null): string | undefined
  grid(time: number | null, interp: boolean): Choice<Loaded>
  overlays?(time: number | null): Choice<Overlays> | null
  wind?(time: number | null, interp: boolean): Choice<WindDraw> | null
  prefetch?(time: number): void
}

/**
 * Applies a channel's choices as time moves: same data → only the blend factor changes; new data →
 * load it, and keep showing the old until it arrives. Stale loads are dropped.
 */
class Channel<T> {
  private key: string | null = null
  private pending: string | null = null
  private seq = 0
  private t = 0
  constructor(private apply: (v: T | null, t: number) => void, private setT: (t: number) => void, private fail?: () => void,
              private busy?: (on: boolean) => void) {}
  private settle() { this.pending = null; this.busy?.(false) }
  push(c: Choice<T> | null) {
    if (!c) {
      if (this.key !== "") { this.seq++; this.key = ""; this.settle(); this.apply(null, 0) }
      return
    }
    this.t = c.t
    if (c.key === this.key) {
      if (this.pending) { this.seq++; this.settle() }
      this.setT(c.t)
      return
    }
    if (c.key === this.pending) return
    const s = ++this.seq
    this.pending = c.key
    this.busy?.(true)
    c.load().then(
      (v) => { if (s === this.seq) { this.key = c.key; this.settle(); this.apply(v, this.t) } },
      () => { if (s === this.seq) { this.key = c.key; this.settle(); this.fail?.() } },
    )
  }
  cancel() { this.seq++; this.settle() }
}

// ------------------------------------------------------------------ the map pane

function arrowImage(): ImageData {
  const s = 32, c = document.createElement("canvas")
  c.width = c.height = s
  const g = c.getContext("2d")!
  g.fillStyle = "#000"
  g.beginPath()
  g.moveTo(16, 2); g.lineTo(25, 15); g.lineTo(19, 15); g.lineTo(19, 30); g.lineTo(13, 30); g.lineTo(13, 15); g.lineTo(7, 15)
  g.closePath()
  g.fill()
  return g.getImageData(0, 0, s, s)
}

/** A chevron pointing along +x, for arrows laid along a line. */
function chevronImage(): ImageData {
  const s = 24, c = document.createElement("canvas")
  c.width = c.height = s
  const g = c.getContext("2d")!
  g.fillStyle = "#000"
  g.beginPath()
  g.moveTo(6, 3); g.lineTo(20, 12); g.lineTo(6, 21); g.lineTo(9.5, 12)
  g.closePath()
  g.fill()
  return g.getImageData(0, 0, s, s)
}

type Status = { kind: "loading" | "ready" | "error" | "empty"; note?: string }

/** The 3D view's volume for a pane: one model's variable, all its time steps. */
export interface PaneVolume {
  entry: VolumeEntry; name: VolVar; data: Uint8Array | null; exaggeration: number
  /** The heights drawn (km above sea level). */
  range: [number, number]
  /** u and v for the wind particles, when they're on */
  wind: { u: Uint8Array; v: Uint8Array } | null
  /** Rain and snow falling from the radar layer. */
  precip: boolean
  /** An opaque surface at this value (display units), or none. */
  solid: number | null
  /** The volume's colours: its own, by height, or by another view (its data in colorData). */
  color: "own" | "height" | VolVar
  colorData: Uint8Array | null
  /** Shadows on the ground (from the solid, or a lit field). */
  shadow: boolean
  /** A pressure level drawn as a map in the box: height contours and wind arrows. */
  level: { hPa: number; hgt: Uint8Array } | null
  /** u and v for the level's arrows and the trajectories (loaded whenever either is on). */
  uv: { u: Uint8Array; v: Uint8Array } | null
  /** Backward trajectories from the forecast locations, with w when the model has it. */
  traj: { w: Uint8Array | null } | null
  /** No field: just the box, for the terrain, particles, falling precipitation and the rest. */
  none?: boolean
  /** The vertical profile's point, marked in the box. */
  profile?: LonLat | null
  /** How the field draws: see-through, as lit white cloud, its strongest value along each line of
   *  sight, or as dots (a solid surface is \`solid\`). */
  render?: "volume" | "cloud" | "max" | "points"
  /** The volume's opacity (×), the solid's opacity, and the byte below which nothing draws. */
  density?: number
  solidAlpha?: number
  from?: number
  /** A slice of the field across the box, with the rest dimmed; \`sink\` moves it while sweeping. */
  scan?: { axis: ScanAxis; pos: number; sink: React.RefObject<{ set?: (pos: number) => void }> } | null
  /** Light the field by the sun at the map's time, or from a fixed direction. */
  light?: "sun" | "fixed"
  /** Read out what's under the cursor in the box. */
  hover?: boolean
}
type ScanAxis = "z" | "x" | "y"
type RenderMode = "volume" | "cloud" | "max" | "solid" | "points"
const RENDER_LABEL: Record<RenderMode, string> = { volume: "Volume", cloud: "Cloud", max: "Max", solid: "Solid", points: "Points" }
const RENDER_HELP = "How the field is drawn. Volume: see-through, thicker where there's more. Cloud: the same shape, lit white like real cloud. Max: the strongest value along each line of sight, like a composite radar. Solid: an opaque, lit surface where it reaches a value. Points: dots, more where there's more."
/** Values a view's solid surface can sit at (display units); the first is the default. */
const SOLID_AT: Partial<Record<VolVar, number[]>> = {
  cloud: [50, 30, 80], rh: [90, 70, 100], water: [0.1, 0.05, 0.3], ice: [0.1, 0.05, 0.3], dgz: [85, 75, 95], icing: [0.05, 0.02, 0.2],
  mflux: [200, 100, 300, 400], w: [0.3, 0.15, 0.6], pv: [2, 1.5, 3], temp: [32, 50, 0, -40], wind: [115, 80, 140, 160],
  thetae: [310, 300, 320, 330], theta: [300, 290, 310, 320], oro: [0.3, 0.15, 0.6], turb: [0.5, 0.25, 1], dbz: [30, 20, 40, 50],
}
/** Views whose solid is everything at or below the value: θ rises with height, so the solid is the
 *  air under the surface, and the surface is its top. */
const SOLID_BELOW: VolVar[] = ["theta"]
const solidLabel = (n: VolVar, x: number, units: string) =>
  n === "wind" ? `${x} mph (${Math.round(x / 1.15078)} kt)` : n === "temp" ? `${x}°F` : n === "turb" ? `Ri ${x}` : `${x}${units === "%" ? "%" : ` ${units}`}`
/** Views drawn as a volume (the others are surfaces), the ones lit from above, and the views another
 *  volume can be coloured by. */
const VOLUME_VIEWS: VolVar[] = ["cloud", "water", "ice", "rh", "dgz", "icing", "mflux", "w", "oro", "turb", "dbz"]
const LIT_VIEWS: VolVar[] = ["cloud", "water", "ice", "rh", "mflux", "dgz", "icing"]
const COLOR_BY: VolVar[] = ["temp", "wind", "rh", "w", "pv", "cloud", "thetae"]

/** Ready-made 3D views: a field and its options, and a camera that shows them well. */
interface Preset {
  id: string; label: string; note: string; field: VolVar
  solid?: number; level?: number; wind?: boolean; traj?: boolean; terrain?: boolean; precip?: boolean; heights?: [number, number]; color?: "own" | "height" | VolVar
  cam: Camera
}
const PRESETS: Preset[] = [
  { id: "ar", label: "Atmospheric river", note: "Moisture flow off the Pacific, with particles and where the air came from.", field: "mflux", wind: true, traj: true,
    cam: { lon: -125.6, lat: 45.3, zoom: 5.2, pitch: 62, bearing: 40 } },
  { id: "jet", label: "Jet stream", note: "The jet as a solid at 100 kt with its shadow, and the 300 mb map.", field: "wind", solid: 115, level: 300, wind: false,
    cam: { lon: -123.6, lat: 46.4, zoom: 4.9, pitch: 58, bearing: -15 } },
  { id: "snow", label: "Snow levels", note: "The freezing level over the stretched Cascades and Olympics, snow above the snow level, and falling precipitation.",
    field: "frz", terrain: true, precip: true, wind: false, cam: { lon: -122.4, lat: 46.6, zoom: 6.2, pitch: 64, bearing: 55 } },
  { id: "low", label: "Upper low", note: "The tropopause (2 PVU) folding down under upper lows, coloured by height, with the 500 mb map.",
    field: "pv", solid: 2, level: 500, heights: [0, 9], wind: false, cam: { lon: -124.2, lat: 47.2, zoom: 5.0, pitch: 52, bearing: -25 } },
  { id: "clouds", label: "Clouds and precipitation", note: "Lit clouds with their shadows, falling precipitation and the terrain.", field: "cloud", terrain: true, precip: true, wind: false,
    cam: { lon: -123.2, lat: 46.2, zoom: 5.6, pitch: 60, bearing: 20 } },
  { id: "lift", label: "Mountain lift", note: "Rising air up the windward slopes and sinking in their lee, over the terrain, with the low-level wind.",
    field: "w", terrain: true, wind: true, heights: [0, 6], cam: { lon: -123.0, lat: 46.9, zoom: 6.0, pitch: 62, bearing: 75 } },
  { id: "isen", label: "Isentropic lift", note: "The 300 K surface as a solid coloured by humidity: moist air sliding up it ahead of a warm front.",
    field: "theta", solid: 300, color: "rh", wind: true, cam: { lon: -124.6, lat: 45.6, zoom: 5.1, pitch: 58, bearing: 20 } },
  { id: "snowlvl", label: "Wet-bulb snow level", note: "Where the wet-bulb temperature is 32°F over the stretched terrain, with falling precipitation.",
    field: "wbz", terrain: true, precip: true, wind: false, cam: { lon: -122.4, lat: 46.6, zoom: 6.2, pitch: 64, bearing: 55 } },
  { id: "turb", label: "Clear-air turbulence", note: "Layers where shear can overturn the air, with the jet as particles.",
    field: "turb", wind: true, heights: [3, 12], cam: { lon: -123.6, lat: 46.4, zoom: 4.9, pitch: 58, bearing: -15 } },
]
/** A 3D view's data file and label (the freezing level draws from temperature). */
const volVarOf = (e: VolumeEntry, n: VolVar): VolumeVar | undefined => viewVar(e, n)
const volLabel = (e: VolumeEntry, n: VolVar) => VIEW_LABEL[n] ?? viewVar(e, n)?.label ?? n
/** Heights to release wind particles at: the standard levels, at the model's average heights. */
const PARTICLE_HPA = [850, 700, 500, 300, 250]

/** 3D terrain: its vertical stretch (the same as the volume's), and the snow level to shade on it. */
export interface PaneTerrain { exaggeration: number; snow: { entry: VolumeEntry; levels: Float32Array[] } | null }

/** The cross-section on the map: its line (and the points picked so far while drawing one). */
interface PaneSection { line: SectionLine | null; picked: LonLat[] | null; sink: React.MutableRefObject<{ set?: (img: HTMLCanvasElement) => void }> }

function MapPane({ data, view, clock, opacity, smooth, particles, particleColor, sync, terrain, sat, fronts, reports, fires, vol = null, xsec = null, onPick = null, terrain3d = null, tall = false, insetTitle = false }: {
  data: Briefing; view: View | null; clock: Clock; opacity: number; smooth: boolean
  particles: boolean; particleColor: [number, number, number, number]; sync: ReturnType<typeof useCameraSync>
  terrain: boolean; sat: { kind: SatKind; times: SatTimes } | null; fronts: Fronts | null; reports: ObsReport[] | null
  fires: Wildfire | null; vol?: PaneVolume | null
  xsec?: PaneSection | null; onPick?: ((ll: LonLat) => void) | null
  terrain3d?: PaneTerrain | null
  /** full screen: the map takes most of the window's height */
  tall?: boolean
  /** room at the top left for the map page's Controls button */
  insetTitle?: boolean
}) {
  const el = React.useRef<HTMLDivElement>(null)
  const axisEl = React.useRef<HTMLDivElement>(null)
  const ready = React.useRef<Promise<maplibregl.Map> | null>(null)
  const layers = React.useRef<{ grid: GridLayer; particles: ParticleLayer; volume: VolumeLayer } | null>(null)
  // the 2D grid and the snow level as images MapLibre drapes over the 3D terrain (made with the map)
  const drape = React.useRef<{ grid: GridDrape; snow: Snowline } | null>(null)
  if (!layers.current) layers.current = { grid: new GridLayer("grid"), particles: new ParticleLayer("particles"), volume: new VolumeLayer("volume") }
  const loaded = React.useRef<{ v: Loaded | null; t: number }>({ v: null, t: 0 })
  const overlays = React.useRef<Overlays | null>(null)
  const smoothRef = React.useRef(smooth)
  const pickRef = React.useRef(onPick)
  pickRef.current = onPick
  smoothRef.current = smooth
  const viewRef = React.useRef(view)
  viewRef.current = view
  const terrainRef = React.useRef(terrain)
  terrainRef.current = terrain
  const [hover, setHover] = React.useState<{ x: number; y: number; text: string | null; place: string | null; vol?: string | null } | null>(null)
  const volRef = React.useRef(vol)
  volRef.current = vol
  const [status, setStatus] = React.useState<Status>({ kind: "loading" })
  const [sub, setSub] = React.useState<string | undefined>()

  React.useEffect(() => {
    // open on the whole grid crop, not just the comparison regions, so the surroundings show too
    const d = data.domain
    addDemProtocol()
    const m = new maplibregl.Map({
      container: el.current!, style: STYLE_URL, transformRequest: withKey, attributionControl: { compact: true },
      bounds: [[d.lon_min, d.lat_min], [d.lon_max, d.lat_max]],
      fitBoundsOptions: { padding: 8 },
      // flat until the 3D view: rotation and tilt are switched on there (pitchWithRotate is fixed when
      // the map is made, so it's on here and does nothing while dragRotate is off)
      dragRotate: false, pitchWithRotate: true, touchPitch: false, maxZoom: 11, maxPitch: 85,
    })
    m.touchZoomRotate.disableRotation()
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right")
    let mapLoaded = false, fellBack = false
    m.on("error", () => {
      if (!mapLoaded && !fellBack && !m.isStyleLoaded()) { fellBack = true; m.setStyle(FALLBACK) }
    })
    ready.current = new Promise((resolve) => m.on("load", () => {
      mapLoaded = true
      const { grid, particles } = layers.current!
      // first label layer of the basemap (none on the fallback, so data goes on top)
      const labels = m.getStyle().layers.find((l) => l.type === "symbol")?.id
      m.addImage("arrow", arrowImage(), { sdf: true })
      m.addImage("chevron", chevronImage(), { sdf: true })
      m.addLayer(grid, labels)
      // terrain shading over the weather colours (shadows only darken, so the colours still read)
      m.addSource("dem", { type: "raster-dem", tiles: [DEM_TILES], tileSize: 256, maxzoom: 12, encoding: "terrarium",
                           attribution: "Terrain: Mapzen / AWS Terrain Tiles" })
      // 3D terrain (its own source: MapLibre warns when terrain and hillshade share one), and the
      // images draped over it: the weather colours, then the snow level, under the hillshade
      m.addSource("dem3d", { type: "raster-dem", tiles: [DEM_TILES], tileSize: 256, maxzoom: 12, encoding: "terrarium" })
      const box = { west: d.lon_min, south: d.lat_min, east: d.lon_max, north: d.lat_max }
      drape.current = { grid: new GridDrape(box), snow: new Snowline(box) }
      m.addSource("drape", { type: "canvas", canvas: drape.current.grid.canvas, coordinates: corners(box), animate: false })
      m.addLayer({ id: "drape", type: "raster", source: "drape", layout: { visibility: "none" }, paint: { "raster-fade-duration": 0, "raster-resampling": "linear" } }, labels)
      m.addSource("snowline", { type: "canvas", canvas: drape.current.snow.canvas, coordinates: corners(box), animate: false })
      m.addLayer({ id: "snowline", type: "raster", source: "snowline", layout: { visibility: "none" }, paint: { "raster-fade-duration": 0 } }, labels)
      m.addLayer({ id: "hillshade", type: "hillshade", source: "dem",
                   layout: { visibility: terrainRef.current ? "visible" : "none" },
                   paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "rgba(20, 24, 30, 0.55)",
                            "hillshade-highlight-color": "rgba(255, 255, 255, 0.18)", "hillshade-accent-color": "rgba(0, 0, 0, 0)",
                            "hillshade-illumination-direction": 315 } }, labels)
      m.addSource("isobars", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "isobars", type: "line", source: "isobars", paint: { "line-color": "#3a3f47", "line-width": ["case", ["==", ["%", ["get", "value"], 4], 0], 1.3, 0.6], "line-opacity": ["case", ["==", ["%", ["get", "value"], 4], 0], 0.8, 0.55] } }, labels)
      m.addSource("centers", { type: "geojson", data: EMPTY })
      m.addSource("pairs", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "pairs", type: "line", source: "pairs", filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["match", ["get", "level"], 2, 5, 1, 4, 2.5],
                 "line-opacity": ["match", ["get", "level"], 0, 0.7, 0.95] } }, labels)
      // arrowheads along each pair, pointing from high to low pressure (the way gap flow blows)
      m.addLayer({ id: "pair-arrows", type: "symbol", source: "pairs", filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "flow"], 1]],
        layout: { "symbol-placement": "line", "symbol-spacing": 34, "icon-image": "chevron", "icon-rotation-alignment": "map",
                  "icon-allow-overlap": true, "icon-ignore-placement": true,
                  "icon-size": ["match", ["get", "level"], 2, 1.0, 1, 0.9, 0.75] },
        paint: { "icon-color": "#1b1f24", "icon-halo-color": "rgba(255,255,255,0.95)", "icon-halo-width": 1.5 } }, labels)
      m.addLayer({ id: "pair-ends", type: "circle", source: "pairs", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2.5 } }, labels)
      // labels need the basemap's glyphs; the plain fallback style has none
      const font = (m.getStyle().layers.find((l) => l.type === "symbol" && (l.layout as Record<string, unknown> | undefined)?.["text-font"])?.layout as Record<string, unknown> | undefined)?.["text-font"]
      if (m.getStyle().glyphs && Array.isArray(font)) {
        m.addLayer({ id: "isobar-labels", type: "symbol", source: "isobars", filter: ["==", ["%", ["get", "value"], 4], 0],
          layout: { "symbol-placement": "line", "symbol-spacing": 260, "text-field": ["to-string", ["get", "value"]],
                    "text-font": font as string[], "text-size": 10, "text-keep-upright": true, "text-max-angle": 30 },
          paint: { "text-color": "#3a3f47", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.4 } }, labels)
        m.addLayer({ id: "pair-labels", type: "symbol", source: "pairs", filter: ["==", ["geometry-type"], "LineString"],
          layout: { "symbol-placement": "line-center", "text-field": ["get", "text"], "text-font": font as string[], "text-size": 11,
                    "text-allow-overlap": true, "text-keep-upright": true, "text-offset": [0, -0.9] },
          paint: { "text-color": "#1b1f24", "text-halo-color": "rgba(255,255,255,0.95)", "text-halo-width": 1.8 } }, labels)
        m.addLayer({ id: "centers", type: "symbol", source: "centers",
          layout: { "text-field": ["format", ["get", "kind"], { "font-scale": 1.5 }, "\n", {}, ["to-string", ["get", "value"]], { "font-scale": 0.75 }],
                    "text-font": font as string[], "text-size": 14, "text-line-height": 1.0, "text-allow-overlap": true },
          paint: { "text-color": ["match", ["get", "kind"], "L", "#c0262d", "#1d4fa0"], "text-halo-color": "rgba(255,255,255,0.95)", "text-halo-width": 1.6 } }, labels)
      }
      m.addSource("freezing", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "freezing", type: "line", source: "freezing", paint: { "line-color": "#1d3f9c", "line-width": 1.6, "line-dasharray": [2, 1.5] } }, labels)
      m.addSource("arrows", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "arrows", type: "symbol", source: "arrows",
        // more candidates than fit; collision detection keeps an even spread at any pane size or zoom
        layout: { "icon-image": "arrow", "icon-rotate": ["get", "dir"], "icon-rotation-alignment": "map",
                  "icon-allow-overlap": false, "icon-padding": 3, "symbol-sort-key": ["-", 0, ["get", "speed"]],
                  "icon-size": ["interpolate", ["linear"], ["get", "speed"], 2, 0.35, 20, 0.55, 50, 0.8] },
        paint: { "icon-color": "#1b1f24", "icon-halo-color": "rgba(255,255,255,0.9)", "icon-halo-width": 1.2 } }, labels)
      m.addLayer(particles, labels)
      m.addSource("regions", { type: "geojson", data: { type: "FeatureCollection", features: Object.entries(data.regionShapes).map(([id, ring]) => ({
        type: "Feature", properties: { id }, geometry: { type: "LineString", coordinates: [...ring, ring[0]] } })) } })
      m.addLayer({ id: "regions", type: "line", source: "regions", paint: { "line-color": "#1b1f24", "line-width": 1.2, "line-dasharray": [3, 2] } })
      m.addSource("points", { type: "geojson", data: { type: "FeatureCollection", features: data.points.map((p) => ({
        type: "Feature", properties: { name: p.name }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })) } })
      m.addLayer({ id: "points", type: "circle", source: "points", paint: { "circle-radius": 3.5, "circle-color": "#fff", "circle-stroke-color": "#1b1f24", "circle-stroke-width": 1.5 } })
      // the coastal AR outlook: a marker per coastal location in its rank's colour, above everything
      // SPC outlook areas and mesoscale discussion outlines (the thunderstorm view)
      m.addSource("spc", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "spc-fill", type: "fill", source: "spc", filter: ["==", ["get", "kind"], "area"],
                   paint: { "fill-color": ["get", "fill"], "fill-opacity": 0.45 } }, labels)
      m.addLayer({ id: "spc-line", type: "line", source: "spc", filter: ["==", ["get", "kind"], "area"],
                   paint: { "line-color": ["get", "stroke"], "line-width": 1.4 } }, labels)
      m.addLayer({ id: "spc-md", type: "line", source: "spc", filter: ["==", ["get", "kind"], "md"],
                   paint: { "line-color": "#1d4ed8", "line-width": 2.2, "line-dasharray": [2, 1.2] } }, labels)
      m.addSource("ar", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "ar", type: "circle", source: "ar", paint: {
        "circle-radius": ["case", [">", ["get", "rank"], 0], 8.5, 4], "circle-color": ["get", "color"],
        "circle-stroke-color": "#fff", "circle-stroke-width": ["case", [">", ["get", "rank"], 0], 2, 1.2] } })
      // WPC fronts, over everything but the labels and markers (hidden until turned on); highs and
      // lows come from the models' own pressure fields
      addFrontLayers(m, labels)
      // current fires: perimeters and incident dots sized by acres, hidden until turned on
      m.addSource("fires", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "fire-perims", type: "fill", source: "fires", filter: ["==", ["geometry-type"], "Polygon"], layout: { visibility: "none" },
        paint: { "fill-color": "#b3261e", "fill-opacity": 0.25 } }, labels)
      m.addLayer({ id: "fire-perims-line", type: "line", source: "fires", filter: ["==", ["geometry-type"], "Polygon"], layout: { visibility: "none" },
        paint: { "line-color": "#b3261e", "line-width": 1.2 } }, labels)
      m.addLayer({ id: "fire-points", type: "circle", source: "fires", filter: ["==", ["geometry-type"], "Point"], layout: { visibility: "none" },
        paint: { "circle-radius": ["interpolate", ["linear"], ["ln", ["max", ["get", "acres"], 1]], 0, 3, 11.5, 10],
                 "circle-color": ["case", ["==", ["get", "rx"], 1], "#8a6d3b", "#e8590c"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }, labels)
      // NWS reports (storm reports and report summaries), hidden until turned on
      m.addSource("nws-reports", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "nws-reports", type: "circle", source: "nws-reports", layout: { visibility: "none" },
        paint: { "circle-radius": 5, "circle-color": ["match", ["get", "kind"], ...Object.entries(NWS_REPORT_COLORS).flat(), "#555"] as unknown as string,
                 "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }, labels)
      if (m.getStyle().glyphs && Array.isArray(font))
        m.addLayer({ id: "nws-reports-label", type: "symbol", source: "nws-reports", minzoom: 6.5, layout: { visibility: "none",
          "text-field": ["get", "label"], "text-font": font as string[], "text-size": 11, "text-offset": [0, -1.1], "text-anchor": "bottom", "text-optional": true },
          paint: { "text-color": "#1b1f24", "text-halo-color": "rgba(255,255,255,0.95)", "text-halo-width": 1.5 } }, labels)
      const arFont = (m.getStyle().layers.find((l) => l.type === "symbol" && (l.layout as Record<string, unknown> | undefined)?.["text-font"])?.layout as Record<string, unknown> | undefined)?.["text-font"]
      if (m.getStyle().glyphs && Array.isArray(arFont))
        m.addLayer({ id: "ar-rank", type: "symbol", source: "ar", filter: ["!=", ["get", "num"], ""],
          layout: { "text-field": ["get", "num"], "text-font": arFont as string[], "text-size": 11, "text-allow-overlap": true },
          paint: { "text-color": ["get", "text"] } })
      // the cross-section's line, and its ends (A, B)
      m.addSource("xsec", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "xsec-line", type: "line", source: "xsec", filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#1f2328", "line-width": 2.5, "line-dasharray": [2, 1.2] } })
      m.addLayer({ id: "xsec-ends", type: "circle", source: "xsec", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 5, "circle-color": "#1f2328", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } })
      // the 3D view's volume, over everything
      m.addLayer(layers.current!.volume)
      resolve(m)
    }))
    sync.add(m)

    m.on("mousemove", (e: MapMouseEvent) => {
      const near = m.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ["points"] })
      const { v, t } = loaded.current
      const parts = [v?.sample(e.lngLat.lng, e.lngLat.lat, t, smoothRef.current), overlays.current?.sample?.(e.lngLat.lng, e.lngLat.lat, smoothRef.current)]
      m.getCanvas().style.cursor = pickRef.current ? "crosshair" : near.length ? "pointer" : ""
      const pv = volRef.current
      const vol3d = pv && !pv.none && pv.data && pv.hover !== false && !e.originalEvent.buttons
        ? probeText(pv, layers.current!.volume, e.point.x, e.point.y, m.getCanvas().clientWidth, m.getCanvas().clientHeight) : null
      setHover({ x: e.point.x, y: e.point.y, text: parts.filter(Boolean).join(", ") || null, place: near.length ? String(near[0].properties?.name) : null, vol: vol3d })
    })
    m.on("mouseout", () => setHover(null))
    // a forecast location opens its detail panel
    m.on("click", (e: MapMouseEvent) => {
      if (pickRef.current) { pickRef.current([e.lngLat.lng, e.lngLat.lat]); return }   // drawing a cross-section
      const near = m.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ["points"] })
      if (near.length) openLocation(String(near[0].properties?.name))
    })
    return () => { sync.remove(m); m.remove() }
  }, [])

  // Follow the clock: each channel loads new data only when the steps it needs change.
  React.useEffect(() => {
    const { grid, particles: pl } = layers.current!
    if (!view) {
      grid.setDraw(null)
      pl.setWind(null)
      setStatus({ kind: "empty" })
      return
    }
    let first = true
    const slow = setTimeout(() => first && setStatus({ kind: "loading" }), 150)
    const gridCh = new Channel<Loaded>(
      (v, t) => {
        first = false
        loaded.current = { v, t }
        grid.setDraw(v?.draw ?? null, t)
        drape.current?.grid.setDraw(v?.draw ?? null, t)
        layers.current!.volume.setPrecip(v?.draw ?? null, t)
        setStatus(v?.draw || v?.bare ? { kind: "ready" } : { kind: "empty", note: v?.note })
      },
      (t) => { loaded.current.t = t; grid.setT(t); drape.current?.grid.setT(t); layers.current!.volume.setPrecipT(t) },
      () => { first = false; setStatus({ kind: "error" }) },
      (on) => clock.hold(gridCh, on),
    )
    const ovCh = new Channel<Overlays>(
      (o) => {
        overlays.current = o
        ready.current?.then((m) => {
          ;(m.getSource("isobars") as GeoJSONSource).setData(o?.isobars ?? EMPTY)
          ;(m.getSource("centers") as GeoJSONSource).setData(o?.centers ?? EMPTY)
          ;(m.getSource("pairs") as GeoJSONSource).setData(o?.pairs ?? EMPTY)
          ;(m.getSource("freezing") as GeoJSONSource).setData(o?.freezing ?? EMPTY)
          ;(m.getSource("arrows") as GeoJSONSource).setData(o?.arrows ?? EMPTY)
          ;(m.getSource("ar") as GeoJSONSource | undefined)?.setData(o?.ar ?? EMPTY)
          ;(m.getSource("spc") as GeoJSONSource | undefined)?.setData(o?.spc ?? EMPTY)
        })
      },
      () => {},
    )
    let ovWait = 0
    const windCh = new Channel<WindDraw>((w, t) => pl.setWind(w, t), (t) => pl.setT(t), undefined, (on) => clock.hold(windCh, on))
    const update = () => {
      const v = viewRef.current!
      const interp = clock.playing
      setSub(v.sub(clock.time))
      gridCh.push(v.grid(clock.time, interp))
      // overlays (contours, centres) take a worker a moment each: while scrubbing, wait until the
      // time rests before asking, so passing steps don't queue work; playing asks at once
      clearTimeout(ovWait)
      const oc = v.overlays?.(clock.time) ?? null
      if (interp || !oc || oc.ready !== false) ovCh.push(oc)
      else ovWait = window.setTimeout(() => ovCh.push(oc), 70)
      windCh.push(particles ? v.wind?.(clock.time, interp) ?? null : null)
      if (interp && clock.time != null) v.prefetch?.(clock.time)
    }
    update()
    const unsub = clock.subscribe(update)
    return () => { unsub(); clearTimeout(slow); clearTimeout(ovWait); gridCh.cancel(); ovCh.cancel(); windCh.cancel() }
  }, [view?.key, particles])

  React.useEffect(() => { layers.current!.grid.setOpacity(opacity); drape.current?.grid.setOpacity(opacity) }, [opacity])
  React.useEffect(() => { layers.current!.grid.setSmooth(smooth); drape.current?.grid.setSmooth(smooth) }, [smooth])

  // ---- 3D terrain: MapLibre's terrain at the volume's stretch, with the weather colours and the
  // snow level draped over it in place of the flat grid; the volume, particles and falling
  // precipitation stop at the ground
  const terrOn = !!terrain3d
  const terrEx = terrain3d?.exaggeration ?? 1
  React.useEffect(() => {
    let off = false
    ready.current?.then((m) => {
      if (off) return
      const D = drape.current
      // a canvas source re-reads its canvas only while "playing": play for one frame per change
      const bump = (id: string) => {
        const src = m.getSource(id) as maplibregl.CanvasSource | undefined
        if (!src) return
        src.play(); m.triggerRepaint()
        m.once("render", () => src.pause())
      }
      if (terrOn && D?.grid.ok) {
        D.grid.onFrame = () => bump("drape")
        D.grid.render()
        m.setTerrain({ source: "dem3d", exaggeration: terrEx })
        m.setLayoutProperty("grid", "visibility", "none")
        m.setLayoutProperty("drape", "visibility", "visible")
      } else {
        if (D) D.grid.onFrame = null
        if (m.getTerrain()) m.setTerrain(null)
        m.setLayoutProperty("grid", "visibility", "visible")
        m.setLayoutProperty("drape", "visibility", "none")
      }
    })
    return () => { off = true }
  }, [terrOn, terrEx])
  // the volume stops at the ground
  const volModel = vol?.entry.model
  React.useEffect(() => {
    const L = layers.current!.volume
    if (!terrOn || !vol) { L.setGround(null); return }
    let live = true
    groundFor(vol.entry).then((gr) => { if (live) L.setGround(gr) }).catch(() => {})
    return () => { live = false; L.setGround(null) }
  }, [terrOn, volModel])
  // the snow level, following the clock
  const snow = terrain3d?.snow ?? null
  React.useEffect(() => {
    let off = false
    const D = drape.current
    ready.current?.then((m) => {
      if (off) return
      m.setLayoutProperty("snowline", "visibility", terrOn && snow ? "visible" : "none")
    })
    if (!D || !terrOn || !snow) return () => { off = true }
    D.snow.setLevels(snow.entry, snow.levels)
    const ms = msOf(snow.entry.times)
    const paint = () => {
      const pos = posOf(ms, clock.time ?? ms[0]), i0 = Math.floor(pos)
      if (D.snow.render(i0, Math.min(i0 + 1, ms.length - 1), pos - i0))
        ready.current?.then((m) => {
          const src = m.getSource("snowline") as maplibregl.CanvasSource | undefined
          if (src) { src.play(); m.triggerRepaint(); m.once("render", () => src.pause()) }
        })
    }
    D.snow.loadTerrain().then(() => { if (!off) paint() }).catch(() => {})
    const un = clock.subscribe(paint)
    return () => { off = true; un() }
  }, [terrOn, snow])
  React.useEffect(() => {
    layers.current!.particles.setEnabled(particles)
    // arrows and particles both show the wind; particles replace the arrows when on
    ready.current?.then((m) => m.setLayoutProperty("arrows", "visibility", particles ? "none" : "visible"))
  }, [particles])
  React.useEffect(() => { layers.current!.particles.setColor(particleColor) }, [particleColor.join()])
  React.useEffect(() => {
    ready.current?.then((m) => m.getLayer("hillshade") && m.setLayoutProperty("hillshade", "visibility", terrain ? "visible" : "none"))
  }, [terrain])

  // ---- 3D: the volume over the map, tilting the camera in and out
  const volOn = !!vol
  const compass = React.useRef<maplibregl.NavigationControl | null>(null)
  const wasVol = React.useRef(false)
  React.useEffect(() => {
    const leaving = wasVol.current && !volOn
    wasVol.current = volOn
    ready.current?.then((m) => {
      if (volOn) {
        // free tilt and turn: right-drag (or Ctrl-drag) on a mouse, two fingers on a touch screen,
        // and a compass that shows the tilt (click to face north, drag to tilt and turn)
        m.dragRotate.enable(); m.touchPitch.enable(); m.touchZoomRotate.enableRotation(); m.keyboard.enable()
        if (!compass.current) {
          compass.current = new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true })
          m.addControl(compass.current, "top-right")
        }
        if (!sync.keepRestored3d()) m.easeTo({ pitch: 60, bearing: -18, zoom: Math.max(m.getZoom() - 0.2, 3), duration: 900 })
      } else {
        if (compass.current) { m.removeControl(compass.current); compass.current = null }
        // flat again only on leaving the 3D view (not on opening, where a shared link's tilted view
        // waits for its volumes to load)
        if (!leaving || !(m.getPitch() > 0 || m.getBearing() !== 0)) return
        m.dragRotate.disable(); m.touchPitch.disable(); m.touchZoomRotate.disableRotation()
        const d = data.domain
        m.easeTo({ pitch: 0, bearing: 0, duration: 700 })
        m.once("moveend", () => m.fitBounds([[d.lon_min, d.lat_min], [d.lon_max, d.lat_max]], { padding: 8, duration: 400 }))
      }
    })
  }, [volOn])
  const volKey = vol ? `${vol.entry.model}|${vol.none ? "none" : vol.name}|${vol.solid}|${vol.color}|${vol.colorData ? 1 : 0}|${vol.shadow}|${vol.render}|${vol.density}|${vol.solidAlpha}|${vol.from}|${vol.range}|${vol.scan ? `${vol.scan.axis}${vol.scan.pos}` : ""}` : ""
  React.useEffect(() => {
    const L = layers.current!.volume
    L.onAxis = (pts) => {
      const box = axisEl.current
      if (!box) return
      box.innerHTML = pts.map((p) => `<span style="position:absolute;left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px;transform:translate(${p.side === "left" ? "calc(-100% - 6px)" : p.side === "mid" ? "-50%" : "6px"},-50%)" class="whitespace-nowrap rounded-[3px] bg-background/75 px-1 ${p.side === "mid" ? "text-[10px] font-medium" : "text-[10.5px]"} leading-tight tabular-nums text-foreground">${p.label}</span>`).join("")
    }
    if (!vol?.data) { L.setDraw(null); return }
    const v = volVarOf(vol.entry, vol.name)!
    const isos = (ISOS[vol.name] ?? []).map((x) => ({ at: frac(x.at, v), rgba: [...hexRgb(x.color).map((c) => c / 255), x.alpha] as [number, number, number, number] }))
    const byH = ISO_BY_HEIGHT[vol.name]
    const cv = vol.color !== "own" && vol.color !== "height" ? volVarOf(vol.entry, vol.color) : undefined
    const colorMode = vol.color === "height" || (byH === "km" && vol.color === "own") ? "height" : cv && vol.colorData ? "field" : "own"
    // the solid's own colour: the view's colour at that value
    const solid = vol.solid == null ? null : (() => {
      const b = Math.round(frac(vol.solid, v) * 255), lut = colorLut(vol.name, v)
      return { at: frac(vol.solid, v), rgb: [lut[b * 4] / 255, lut[b * 4 + 1] / 255, lut[b * 4 + 2] / 255] as [number, number, number], below: SOLID_BELOW.includes(vol.name) }
    })()
    const lit = LIT_VIEWS.includes(vol.name)
    const render = solid ? "solid" : vol.render ?? "volume"
    // the view's opacity table, with nothing below "show from"
    const lut = lutFor(vol.name, v)
    for (let b = 0; b < (vol.from ?? 0); b++) lut[b * 4 + 3] = 0
    const own = colorLut(vol.name, v)
    const cLut = colorMode === "field" ? colorLut(vol.color as VolVar, cv!) : null
    const scan = vol.scan && !vol.none ? { axis: vol.scan.axis, pos: vol.scan.pos, rest: 0.15, lut: own } : null
    if (vol.none) {
      L.setDraw({ grid: vol.entry, data: vol.data, steps: vol.entry.times.length, key: volKey, lut: new Uint8Array(1024), lit: false, isos: [], empty: true }, vol.entry.levels)
    } else L.setDraw({ grid: vol.entry, data: vol.data, steps: vol.entry.times.length, key: volKey,
      // with a solid surface or dots, only they draw (and the scan's slice)
      lut: render === "solid" || render === "points" ? new Uint8Array(1024) : lut, lit, isos: render === "volume" ? isos : [],
      heightLut: heightLut(vol.entry.topKm, byH === "frz" ? "frz" : "km"), isoByHeight: !!byH,
      colorMode, colorBy: cLut ? { data: vol.colorData!, lut: cLut } : undefined,
      solid, shadow: vol.shadow && (!!solid || (lit && (render === "volume" || render === "cloud"))),
      mode: render === "cloud" || render === "max" ? render : "volume", density: vol.density ?? 1, solidAlpha: vol.solidAlpha ?? 1,
      scan, empty: render === "points" && !scan, pickLut: render === "points" ? lut : undefined }, vol.entry.levels)
    if (vol.scan) vol.scan.sink.current = { set: (p) => L.setScanPos(p) }
    const ms = msOf(vol.entry.times)
    // the dots: worked out again as the clock moves, at most every 120 ms
    const dots = render === "points" && !vol.none
    let lastDots = 0, dotTimer = 0
    const makeDots = (i0: number, i1: number, t: number) => {
      lastDots = performance.now()
      const e = vol.entry, nxy = e.nx * e.ny, per = nxy * e.nz
      const a0 = Math.min(i0, e.times.length - 1) * per, a1 = Math.min(i1, e.times.length - 1) * per
      const rgb = colorMode === "height" ? (_i: number, _b: number, km: number) => heightRgb(km).map((c) => c / 255) as [number, number, number]
        : cLut ? (i: number) => {
            const c0 = vol.colorData![a0 + i], c1 = vol.colorData![a1 + i]
            const b = c0 === 255 || c1 === 255 ? 0 : Math.round(c0 * (1 - t) + c1 * t)
            return [cLut[b * 4] / 255, cLut[b * 4 + 1] / 255, cLut[b * 4 + 2] / 255] as [number, number, number]
          }
        : (_i: number, b: number) => [own[b * 4] / 255, own[b * 4 + 1] / 255, own[b * 4 + 2] / 255] as [number, number, number]
      L.setPoints(pointCloud(e, vol.data!, lut, i0, i1, t, vol.range, rgb, 120000 * (vol.density ?? 1)))
    }
    // observed radar: download the frames either side of the clock as it reaches them
    const lazy = vol.none ? undefined : v.lazy
    let live = true
    const update = () => {
      const pos = posOf(ms, clock.time ?? ms[0])
      const i0 = Math.floor(pos), i1 = Math.min(i0 + 1, ms.length - 1)
      L.setTime(i0, i1, pos - i0)
      if (lazy) for (const k of new Set([i0, i1])) if (!lazy.ready(k)) lazy.load(k).then(() => { if (live) { L.refreshStep(k); if (dots) update() } }).catch(() => {})
      if (dots) {
        window.clearTimeout(dotTimer)
        const wait = 120 - (performance.now() - lastDots)
        if (wait <= 0) makeDots(i0, i1, pos - i0)
        else dotTimer = window.setTimeout(() => makeDots(i0, i1, pos - i0), wait)
      }
    }
    if (!dots) L.setPoints(null)
    update()
    const off = clock.subscribe(update)
    return () => { live = false; off(); window.clearTimeout(dotTimer) }
  }, [volKey, vol?.data, vol?.colorData])
  React.useEffect(() => () => layers.current?.volume.setPoints(null), [])
  // the sun over the box's middle at the map's time
  const lightMode = vol?.light ?? "fixed", lightEntry = vol?.entry
  React.useEffect(() => {
    const L = layers.current?.volume
    if (!L || !lightEntry) return
    if (lightMode === "fixed") { L.setLight(null); return }
    const lat = (lightEntry.lat[0] + lightEntry.lat[1]) / 2, lon = (lightEntry.lon[0] + lightEntry.lon[1]) / 2
    const update = () => { if (clock.time != null) { const { dir, color, ambient } = sunLight(clock.time, lat, lon); L.setLight({ dir, color, ambient }) } }
    update()
    return clock.subscribe(update)
  }, [lightMode, lightEntry])
  // a pressure level's contours and wind arrows, and the trajectories: worked out again as the clock moves
  React.useEffect(() => {
    const L = layers.current!.volume
    const e = vol?.entry, lev = vol?.level, uv = vol?.uv, tr = vol?.traj
    if (!e || !vol?.data || (!lev && !(tr && uv))) { L.setOverlay("level", null); L.setOverlay("traj", null); return }
    const ms = msOf(e.times)
    let lastTraj = NaN
    const update = () => {
      const tm = clock.time ?? ms[0]
      const pos = posOf(ms, tm), i0 = Math.floor(pos)
      L.setOverlay("level", lev ? levelOverlay(e, lev.hPa, lev.hgt, uv ?? null, i0, Math.min(i0 + 1, ms.length - 1), pos - i0) : null)
      // trajectories: again when the clock has moved 10 minutes or more
      if (tr && uv && !(Math.abs(tm - lastTraj) < 600e3)) {
        lastTraj = tm
        L.setOverlay("traj", trajectories(e, data.points, uv, tr.w, Math.min(Math.max(tm, ms[0]), ms[ms.length - 1])))
      } else if (!tr || !uv) L.setOverlay("traj", null)
    }
    update()
    return clock.subscribe(update)
  }, [vol?.entry, !!vol?.data, vol?.level?.hPa, vol?.level?.hgt, vol?.uv, vol?.traj, vol?.traj?.w])
  // the vertical profile's point: a stalk from the ground to the top, with a tick every 2 km
  const prof = vol?.profile ? vol.profile.join(",") : ""
  React.useEffect(() => {
    const L = layers.current!.volume, e = vol?.entry, pt = vol?.profile
    if (!e || !pt) { L.setOverlay("profile", null); return }
    const x = (pt[0] - e.lon[0]) / (e.lon[1] - e.lon[0])
    const yN = mercY(e.lat[1]), yS = mercY(e.lat[0]), y = (mercY(pt[1]) - yN) / (yS - yN)
    const c = [0.1, 0.11, 0.14, 0.95], v: number[] = [x, y, 0, ...c, x, y, 1, ...c]
    const dx = 0.006
    for (let km = 2; km < e.topKm; km += 2) v.push(x - dx, y, km / e.topKm, ...c, x + dx, y, km / e.topKm, ...c)
    L.setOverlay("profile", { verts: Float32Array.from(v), labels: [] })
  }, [vol?.entry, prof])
  React.useEffect(() => { layers.current!.volume.setExaggeration(vol?.exaggeration ?? 25) }, [vol?.exaggeration])
  React.useEffect(() => { layers.current!.volume.setPrecipOn(!!vol?.precip) }, [vol?.precip])
  // ---- the cross-section: its line on the map, and the slice as a curtain in the 3D view
  const xLine = xsec?.line ?? null
  const xKey = xLine ? `${xLine.a}|${xLine.b}` : ""
  const xPicked = xsec?.picked ? xsec.picked.map(String).join("|") : ""
  React.useEffect(() => {
    ready.current?.then((m) => {
      const pts: LonLat[] = xsec?.picked?.length ? xsec.picked : xLine ? [xLine.a, xLine.b] : []
      const fc = { type: "FeatureCollection" as const, features: [
        ...(pts.length === 2 ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: pts } }] : []),
        ...pts.map((p) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: p } })),
      ] }
      ;(m.getSource("xsec") as maplibregl.GeoJSONSource | undefined)?.setData(fc)
    })
    const L = layers.current!.volume
    if (xsec && xLine && !xsec.picked) {
      xsec.sink.current.set = (img) => L.setCurtain(xLine.a, xLine.b, img)
      L.setCurtain(xLine.a, xLine.b)
      L.setOpacity(0.45)                     // the volume steps back so the slice reads
    } else {
      if (xsec) xsec.sink.current.set = undefined
      L.setCurtain(null)
      L.setOpacity(1)
    }
  }, [!!xsec, xKey, xPicked])
  React.useEffect(() => { layers.current!.volume.setHeightRange(vol?.range[0] ?? 0, vol?.range[1] ?? 99) }, [vol?.range[0], vol?.range[1], vol?.data])
  React.useEffect(() => {
    const e = vol?.entry, w = vol?.wind
    layers.current!.volume.setWind(e && w && vol?.data ? {
      u: w.u, v: w.v, range: [e.vars.u.min, e.vars.u.max],
      heightsKm: PARTICLE_HPA.map((p) => e.levels.find((l) => l.hPa === p)?.km).filter((k): k is number => k != null && k < e.topKm),
      // in the moisture-flow view, particles take the plume's colours: the river shows in them too
      tint: vol?.name === "mflux" && !vol.none && e.vars.mflux ? (b) => mfluxRgb(unpack(b, e.vars.mflux)) : undefined,
    } : null)
  }, [vol?.wind, vol?.data ? vol.entry.model : null, vol?.name])

  // Satellite imagery under the data: the GOES frame nearest the clock (within 20 minutes), over
  // the hourly global mosaic (within 75 minutes) that fills in north of the GOES layer's edge. One
  // image each for the whole domain, decoded before it's swapped in; the next GOES frames load
  // ahead during playback.
  const [satLabel, setSatLabel] = React.useState<string | null>(null)
  React.useEffect(() => {
    const d = data.domain
    const box = { west: d.lon_min, south: d.lat_min, east: d.lon_max, north: d.lat_max }
    const corners: [[number, number], [number, number], [number, number], [number, number]] =
      [[box.west, box.north], [box.east, box.north], [box.east, box.south], [box.west, box.south]]
    let stop = false
    const shown: Record<string, string | null> = {}, want: Record<string, string | null> = {}
    const hide = (id: string) => ready.current?.then((m) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", "none"))
    const hideAll = () => { hide("sat"); hide("sat-fill") }
    if (!sat) { hideAll(); setSatLabel(null); return }
    const k = SAT_KINDS[sat.kind]
    // show one layer's frame for the clock; returns the frame time shown, or null
    const show = (id: string, layer: string, tol: number, below: string, ahead: boolean): string | null => {
      const times = sat.times[layer] ?? []
      const i = clock.time == null ? -1 : nearestFrame(times, clock.time, tol)
      if (i < 0) { want[id] = shown[id] = null; hide(id); return null }
      const url = satUrl(layer, times[i], box)
      if (ahead && clock.playing) for (const j of [1, 2, 3]) if (times[i + j]) preload(satUrl(layer, times[i + j], box)).catch(() => {})
      if (url !== shown[id] && url !== want[id]) {
        want[id] = url
        preload(url).then(() => ready.current!).then((m) => {
          if (stop || want[id] !== url) return
          const src = m.getSource(id) as maplibregl.ImageSource | undefined
          if (src) src.updateImage({ url, coordinates: corners })
          else {
            m.addSource(id, { type: "image", url, coordinates: corners })
            m.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.9, "raster-fade-duration": 0 } }, m.getLayer(below) ? below : "grid")
          }
          m.setLayoutProperty(id, "visibility", "visible")
          shown[id] = url
        }).catch(() => {})
      }
      return times[i]
    }
    const update = () => {
      const goes = show("sat", k.layer, 20, "grid", true)
      const fill = show("sat-fill", k.fill, 75, "sat", false)
      const t = goes ?? fill
      setSatLabel(t ? `${k.label} satellite, ${timeLabel(t)}` : null)
    }
    update()
    const unsub = clock.subscribe(update)
    return () => { stop = true; unsub(); hideAll() }
  }, [sat?.kind, sat?.times])

  // current fires, not tied to the clock
  React.useEffect(() => {
    ready.current?.then((m) => {
      const feats: GeoJSON.Feature[] = []
      for (const f of fires?.perimeters?.features ?? []) {
        const g = f.geometry
        if (g?.type === "MultiPolygon") for (const c of g.coordinates) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: c } })
        else if (g?.type === "Polygon") feats.push({ type: "Feature", properties: {}, geometry: g })
      }
      for (const x of fires?.incidents ?? [])
        feats.push({ type: "Feature", properties: { acres: x.acres ?? 0, rx: x.type === "Prescribed fire" ? 1 : 0 }, geometry: { type: "Point", coordinates: [x.lon, x.lat] } })
      const fc: GeoJSON.FeatureCollection = fires ? { type: "FeatureCollection", features: feats } : EMPTY
      ;(m.getSource("fires") as GeoJSONSource | undefined)?.setData(fc)
      for (const id of ["fire-perims", "fire-perims-line", "fire-points"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", fires ? "visible" : "none")
    })
  }, [fires])

  // NWS reports: everything from the last few days, not tied to the clock
  React.useEffect(() => {
    ready.current?.then((m) => {
      ;(m.getSource("nws-reports") as GeoJSONSource | undefined)?.setData(reports ? reportGeoJSON(reports) : EMPTY)
      for (const id of ["nws-reports", "nws-reports-label"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", reports ? "visible" : "none")
    })
  }, [reports])

  // WPC fronts: the analysis or forecast frame nearest the clock, swapped in as the clock moves
  const [frontLabel, setFrontLabel] = React.useState<string | null>(null)
  React.useEffect(() => {
    const vis = (on: boolean) => ready.current?.then((m) => FRONT_LAYERS.forEach((id) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", on ? "visible" : "none")))
    if (!fronts) { vis(false); setFrontLabel(null); return }
    vis(true)
    let shown: FrontFrame | null | undefined
    const update = () => {
      const fr = frontFrame(fronts, clock.time)
      if (fr === shown) return
      shown = fr
      ready.current?.then((m) => (m.getSource("fronts") as GeoJSONSource | undefined)?.setData(frontGeoJSON(fr)))
      setFrontLabel(fr ? `Fronts: WPC ${fr.kind === "analysis" ? "analysis" : "forecast"}, ${timeLabel(fr.valid)}` : "Fronts: none within a few hours of this time")
    }
    update()
    const unsub = clock.subscribe(update)
    return () => { unsub(); vis(false) }
  }, [fronts])

  return (
    <div className={tall ? "relative h-full overflow-hidden" : "relative overflow-hidden rounded-lg border"}>
      <div ref={el} className={tall ? "h-full w-full" : "h-[520px] w-full max-sm:h-[420px]"} role="region" aria-label={`Map: ${view?.title ?? ""}`} />
      <div ref={axisEl} className={`pointer-events-none absolute inset-0 overflow-hidden ${vol?.data ? "" : "hidden"}`} aria-hidden />
      <div className={`pointer-events-none absolute top-2 max-w-[70%] rounded-md bg-card/95 px-2.5 py-1.5 text-xs shadow-sm ring-1 ring-border ${insetTitle ? "left-[118px] max-sm:top-12 max-sm:left-2" : "left-2"}`}>
        <div className="font-medium">{view?.title}</div>
        {vol && <div className="text-muted-foreground">3D: {vol.entry.model} {vol.none ? (vol.wind ? "wind" : "box") : volLabel(vol.entry, vol.name).toLowerCase()}{vol.wind && !vol.none ? " and wind" : ""}{vol.entry.run === "observed" ? ", observed" : `, ${vol.entry.run} run`}{vol.data ? "" : " (loading…)"}</div>}
        {sub && <div className="text-muted-foreground">{sub}</div>}
        {satLabel && <div className="text-muted-foreground">{satLabel}</div>}
        {frontLabel && <div className="text-muted-foreground">{frontLabel}</div>}
      </div>
      {status.kind !== "ready" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
          {status.kind === "loading" ? "Loading grid…" : status.kind === "error" ? "This grid could not be loaded." : (status.note ?? "Nothing to show for this choice.")}
        </div>
      )}
      {hover && (hover.text || hover.place || hover.vol) && (
        <div className="pointer-events-none absolute z-10 rounded-md bg-popover px-2 py-1 text-xs shadow-md ring-1 ring-border"
             style={{ left: Math.min(hover.x + 14, (el.current?.clientWidth ?? 0) - 170), top: hover.y + 14 }}>
          {hover.place && <div className="font-medium">{hover.place} <span className="font-normal opacity-60">· click for details</span></div>}
          {hover.vol && <div className="tabular-nums"><span className="font-medium">3D</span> {hover.vol}</div>}
          {(hover.text || !hover.vol) && <div className="tabular-nums">{hover.vol ? <span className="opacity-70">Map: {hover.text ?? "no data"}</span> : hover.text ?? "No data"}</div>}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ legends

const NWS_REPORT_COLORS: Record<ObsReport["kind"], string> = { gust: "#2a6fdb", damage: "#1b1f24", rain: "#1e9e4a", snow: "#7b4fc9", ice: "#d147a3", flood: "#0b7a75", high: "#d9480f", low: "#1c7ed6" }
const NWS_REPORT_NAMES: Record<ObsReport["kind"], string> = { gust: "Wind gust", damage: "Wind damage", rain: "Rain", snow: "Snow", ice: "Ice", flood: "Flooding", high: "High temperature", low: "Low temperature" }

function reportGeoJSON(rs: ObsReport[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: rs.map((r) => ({
      type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [r.lon!, r.lat!] },
      properties: { kind: r.kind, label: r.mag == null ? "" : r.unit === "mph" ? String(Math.round(r.mag)) : r.mag < 0.005 ? "T" : `${+r.mag.toFixed(2)}″` },
    })),
  }
}

function ReportLegend({ reports, hours }: { reports: ObsReport[]; hours: number }) {
  const kinds = [...new Set(reports.map((r) => r.kind))]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {kinds.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full ring-1 ring-white" style={{ background: NWS_REPORT_COLORS[k] }} aria-hidden />{NWS_REPORT_NAMES[k]}
        </span>
      ))}
      <span>Last {hours} hours. Zoom in for values.</span>
    </div>
  )
}

/** Front symbols, drawn as on the map. */
function FrontLegend() {
  const pip = (d: string, color: string) => <path d={d} fill={color} />
  const tri = (x: number, c: string, up = true) => pip(up ? `M${x - 5.5} 8 L${x} 0.5 L${x + 5.5} 8 Z` : `M${x - 5.5} 8 L${x} 15.5 L${x + 5.5} 8 Z`, c)
  const semi = (x: number, c: string) => pip(`M${x - 5.5} 8 A5.5 5.5 0 0 1 ${x + 5.5} 8 Z`, c)
  const items: [string, React.ReactNode][] = [
    ["Cold", <>{<line x1="0" y1="8" x2="36" y2="8" stroke={FRONT_COLORS.cold} strokeWidth="2.4" />}{tri(10, FRONT_COLORS.cold)}{tri(26, FRONT_COLORS.cold)}</>],
    ["Warm", <>{<line x1="0" y1="8" x2="36" y2="8" stroke={FRONT_COLORS.warm} strokeWidth="2.4" />}{semi(10, FRONT_COLORS.warm)}{semi(26, FRONT_COLORS.warm)}</>],
    ["Occluded", <>{<line x1="0" y1="8" x2="36" y2="8" stroke={FRONT_COLORS.occluded} strokeWidth="2.4" />}{tri(10, FRONT_COLORS.occluded)}{semi(26, FRONT_COLORS.occluded)}</>],
    ["Stationary", <>{<line x1="0" y1="8" x2="36" y2="8" stroke={FRONT_COLORS.warm} strokeWidth="2.4" />}<line x1="0" y1="8" x2="18" y2="8" stroke={FRONT_COLORS.cold} strokeWidth="2.4" />{tri(9, FRONT_COLORS.cold, false)}{semi(27, FRONT_COLORS.warm)}</>],
    ["Trough", <line x1="0" y1="8" x2="36" y2="8" stroke={FRONT_COLORS.trough} strokeWidth="1.7" strokeDasharray="5 4" />],
  ]
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {items.map(([label, svg]) => <span key={label} className="flex items-center gap-1.5"><svg width="36" height="16" viewBox="0 0 36 16" aria-hidden>{svg}</svg>{label}</span>)}
      </div>
    </div>
  )
}

/** One line under the 3D legend; the longer notes are in About this view. */
const VOL_SHORT: Record<VolVar, string> = {
  cloud: "Thicker cloud looks more solid.",
  rh: "Moist air shows; dry air is a faint haze.",
  temp: "Surfaces at set temperatures; 32°F is the most solid.",
  wind: "Surfaces at set speeds, nested around the fastest air.",
  water: "Cloud droplets plus rain.",
  ice: "Cloud ice, snow and graupel.",
  mflux: "Water vapour carried by the wind: atmospheric rivers show in yellow and red.",
  w: "Rising air red, sinking air blue.",
  frz: "The freezing level, coloured by height.",
  pv: "The 2 PVU surface (the dynamic tropopause), coloured by height: it dips toward the ground under upper lows.",
  dgz: "Moist air between 10 and 0°F, where snowflakes grow fastest.",
  icing: "Liquid water below freezing: aircraft icing.",
  wbz: "Where the wet-bulb temperature is 32°F, coloured by height: about where snow turns to rain.",
  thetae: "Surfaces of equal θe: warm, moist air in oranges, cold or dry air in blues.",
  theta: "Surfaces at 290, 300, 310 and 320 K, coloured by height: outside cloud, air glides along them.",
  oro: "Wind blowing up the terrain red, down it blue.",
  turb: "Low Richardson number: shear strong enough to overturn the air (clear-air turbulence).",
  dbz: "Observed radar echoes through the depth of the storm, in the radar's colours.",
}
const VOL_NOTES: Record<VolVar, string> = {
  cloud: "Cloud cover through the depth of the atmosphere: the thicker the cloud, the more solid it looks.",
  rh: "Relative humidity: moist air (above about 60%) shows, saturated air most; dry air is a faint brown haze.",
  temp: "Temperature as surfaces at set values (isotherms): each one is where the air is at that temperature, warmer below it and colder above. The freezing surface is the most solid.",
  wind: "Wind speed as surfaces at set speeds (isotachs), nested like the layers of an onion around the fastest air; the jet stream's core also glows faintly.",
  water: "Liquid water in the air: cloud droplets plus rain, in grams per kilogram of air.",
  ice: "Frozen water in the air: cloud ice, snow and graupel, in grams per kilogram of air.",
  mflux: "Moisture flow: the water vapour the wind carries (specific humidity times wind speed). An atmospheric river shows as a plume of yellows and reds, deepest low down where the air holds the most water; summed through the column it's the IVT on the map's moisture layer. Particles take the same colours.",
  w: "Rising (red) and sinking (blue) air, in metres a second. Rising air cools and wrings out its moisture, so lift up the windward slopes of the Olympics and Cascades and along fronts is where precipitation is made; sinking air in their lee dries out (the rain shadow).",
  pv: "Potential vorticity, drawn as its 2 PVU surface: the dynamic tropopause, where the troposphere's weather meets the stratosphere's stable, high-PV air. Coloured by height, it sits near 10 – 12 km in warm air and folds down to 5 km or lower under upper-level lows and troughs, which drive storms, cold pools aloft and showers. A lobe dropping toward the ground often comes before a burst of convection or snow.",
  dgz: "The snow growth zone: relative humidity in the layer between about 10 and 0°F (−12 to −18°C), where ice crystals grow fastest as six-armed dendrites. A deep, saturated layer there, especially with rising air through it, makes big flakes and fluffy, high-ratio snow.",
  icing: "Supercooled liquid water: cloud droplets and rain still liquid between 32 and −4°F, which freeze onto anything they hit, aircraft above all. From the model's own cloud water and rain.",
  frz: "The freezing level as a surface, coloured by its height in 1,000 ft bands: below it the air is above freezing, above it below. Snow usually reaches about 1,000 ft below it; where it meets the ground, it's freezing at the surface. More than one layer means a warm layer aloft (freezing rain or sleet risk).",
  wbz: "The wet-bulb freezing level, coloured by its height in 1,000 ft bands: where the wet-bulb temperature (worked out from the model's temperature and humidity) is 32°F. Melting snow and evaporating precipitation cool the air toward its wet-bulb temperature, so in steady precipitation the snow level sits near this surface, often a few hundred feet below it, and below the dry-bulb freezing level when the air is dry.",
  thetae: "Equivalent potential temperature (θe), worked out from the model's temperature and humidity: the temperature air would reach if all its water vapour condensed and it were brought down to 1000 mb. It stays with the air as it rises and sinks, so warm conveyor belts and atmospheric rivers stand out as high θe, dry intrusions behind cold fronts as low θe, and fronts as surfaces crowding together. Where θe falls with height, the air is potentially unstable.",
  theta: "Isentropic surfaces: where the potential temperature (worked out from temperature and pressure) is 290, 300, 310 and 320 K, coloured by height. Outside cloud, air moves along these surfaces, so wind blowing toward where a surface rises is air being lifted (isentropic lift): the slow, widespread rise ahead of warm fronts. Colour the solid by humidity to see where that rising air is moist enough to make cloud.",
  oro: "Orographic lift: the model's wind times the slope of the terrain under it (on the model's grid), fading with height above the ground over about 2 km. Red where the air is forced up the windward slopes, which wrings out its moisture; blue where it's going down the lee side and drying out. It shows the terrain's part in the model's own rising and sinking air.",
  turb: "The Richardson number: how stable the air is (from how fast potential temperature rises with height) against how strongly the wind changes with height. Below about 1 the shear can overturn the layer in waves; below 0.25 it usually does, which aircraft feel as clear-air turbulence, often near the jet stream and above upper fronts. Shown above 1.5 km, on the model's 500 m spacing, so thin layers are missed.",
  dbz: "Observed radar from NOAA's Multi-Radar Multi-Sensor (MRMS) 3D mosaic: the reflectivity at heights from 0.5 to 12 km above sea level, merged from every radar that sees each point and quality-controlled. Strong echoes are heavy rain, wet snow or hail; a bright band near the freezing level is snow melting into rain. Below the lowest beams (low over the ocean and in deep valleys) there's no data. Each frame is about 10 MB from the public data bucket, so frames load as the clock reaches them; past the newest frame, it stays on screen as the clock moves into the forecast.",
}
/** How to read the 3D field: shell swatches for temperature and wind, a height scale for the freezing
 *  level, otherwise the colours over the useful range (paler where nearly see-through); then the box. */
function VolumeLegend({ vol }: { vol: PaneVolume }) {
  const { entry, name } = vol
  const v = volVarOf(entry, name)!
  const solid = vol.solid
  const byH = ISO_BY_HEIGHT[name]
  // what sets the colours: the view's own scale, its height, or another field
  const colorView = vol.color !== "own" && vol.color !== "height" && vol.colorData ? vol.color : null
  const byHeight = vol.color === "height" || (byH === "km" && solid == null) || (byH === "km" && vol.color === "own" && solid != null)
  const isos = solid != null || LEVEL_VIEWS.includes(name) || byH === "km" ? null : ISOS[name]
  const swatch = (bg: string, label: string, opacity = 1) => (
    <span key={label} className="flex items-center gap-1.5">
      <span className="h-3 w-5 rounded-[3px] ring-1 ring-black/10" style={{ background: bg, opacity }} aria-hidden />{label}
    </span>
  )
  const solidRgb = solid == null ? null : (() => { const b = Math.round(frac(solid, v) * 255), l = colorLut(name, v); return `rgb(${l[b * 4]},${l[b * 4 + 1]},${l[b * 4 + 2]})` })()
  return (
    <div className="space-y-1.5">
      {(isos || solid != null || vol.level || vol.traj) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          {isos?.map((x) => swatch(x.color, x.label, Math.min(1, 0.35 + x.alpha)))}
          {solid != null && swatch(byHeight || colorView ? "linear-gradient(90deg,#483c82,#28a0aa,#f0c832)" : solidRgb!, `Solid at ${solidLabel(name, solid, v.units)}`)}
          {vol.level && swatch("linear-gradient(#1f293b,#1f293b) center / 100% 2px no-repeat", `${vol.level.hPa} mb heights (dam) and wind`)}
          {vol.traj && swatch("linear-gradient(90deg,rgba(72,40,130,.35),#3cafa0,#f0c832)", "Trajectories, coloured by height")}
        </div>
      )}
      {byHeight ? <Scale title={name === "pv" && solid == null ? "Height of the 2 PVU surface (km)" : "Height (km)"} lo={0} hi={entry.topKm}
                         ticks={[0, 2, 4, 6, 8, 10, 12].filter((t) => t <= entry.topKm)} color={(x) => heightRgb(x)} fmt={String} />
        : colorView ? (() => {
          const cv = volVarOf(entry, colorView)!, { show, ticks } = legendStops(colorView, cv), lut = colorLut(colorView, cv)
          return <Scale title={`Coloured by ${volLabel(entry, colorView).toLowerCase()} (${cv.units})`} lo={show[0]} hi={show[1]} ticks={ticks} fmt={(x) => (Math.abs(x) < 1 && x !== 0 ? x.toFixed(1) : String(x))}
            color={(x) => { const b = Math.round(frac(x, cv) * 255); return [lut[b * 4], lut[b * 4 + 1], lut[b * 4 + 2]] }} />
        })()
        : !isos && solid == null && <OwnScale entry={entry} name={name} />}
      <p className="text-xs text-muted-foreground">{VOL_SHORT[name]}</p>
    </div>
  )
}
/** A colour bar with ticks. */
function Scale({ title, lo, hi, ticks, color, fmt }: { title: string; lo: number; hi: number; ticks: number[]; color: (x: number) => number[]; fmt: (x: number) => string }) {
  const N = 48
  return (
    <div className="max-w-xl">
      <div className="mb-1.5 text-xs text-muted-foreground">{title}</div>
      <div className="flex h-3 overflow-hidden rounded-[3px] ring-1 ring-border">
        {Array.from({ length: N }, (_, i) => { const [r, g, b] = color(lo + ((i + 0.5) / N) * (hi - lo)); return <span key={i} className="h-full flex-1" style={{ background: `rgb(${r | 0},${g | 0},${b | 0})` }} /> })}
      </div>
      <div className="relative mt-0.5 h-4 text-[11px] text-muted-foreground tabular-nums">
        {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(100 * (t - lo)) / (hi - lo)}%` }}>{fmt(t)}</span>)}
      </div>
    </div>
  )
}
/** The view's own scale: its colours over the useful range, paler where nearly see-through. */
function OwnScale({ entry, name }: { entry: VolumeEntry; name: VolVar }) {
  const v = volVarOf(entry, name)!
  const { show, ticks } = legendStops(name, v)
  const N = 48
  const cells = Array.from({ length: N }, (_, i) => {
    const x = show[0] + ((i + 0.5) / N) * (show[1] - show[0])
    if (LEVEL_VIEWS.includes(name)) { const [r, g, b] = frzColor(x); return `rgb(${r},${g},${b})` }
    const [r, g, b, e] = transfer(name, x)
    return `rgba(${r | 0},${g | 0},${b | 0},${Math.min(1, 0.25 + e / 1.2).toFixed(2)})`
  })
  const fmt = (x: number) => (Math.abs(x) < 1 && x !== 0 ? x.toFixed(2) : LEVEL_VIEWS.includes(name) ? x.toLocaleString("en-US") : String(x))
  return (
    <div className="max-w-xl">
      <div className="mb-1.5 text-xs text-muted-foreground">{name === "frz" ? "Freezing level height (ft)" : name === "wbz" ? "Wet-bulb 32°F height (ft)" : `${v.label} (${v.units})`}</div>
      <div className="flex h-3 overflow-hidden rounded-[3px] ring-1 ring-border" style={{ background: "repeating-conic-gradient(#d8dce2 0 25%, #fff 0 50%) 0 0 / 8px 8px" }}>
        {cells.map((c, i) => <span key={i} className="h-full flex-1" style={{ background: c }} />)}
      </div>
      <div className="relative mt-0.5 h-4 text-[11px] text-muted-foreground tabular-nums">
        {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(100 * (t - show[0])) / (show[1] - show[0])}%` }}>{fmt(t)}</span>)}
      </div>
    </div>
  )
}

/** One explanation in About this view: a short label and its text. */
interface Note { label: string; text: React.ReactNode }
type NoteGroup = { title: string; items: (Note | false | null | undefined)[] }

/** The 3D view's notes, for About this view. */
function volumeNotes({ entry, name, exaggeration, particles, precip, terrain, snow, vol }: {
  entry: VolumeEntry; name: VolVar; exaggeration: number; particles: boolean; precip: boolean; terrain: boolean; snow: boolean; vol?: PaneVolume
}): (Note | false | null | undefined)[] {
  const v = volVarOf(entry, name)
  const steps = entry.times.length
  const hours = steps > 1 ? Math.round((Date.parse(entry.times[1]) - Date.parse(entry.times[0])) / 3600e3) : 3
  const pk = PARTICLE_HPA.map((p) => entry.levels.find((l) => l.hPa === p)).filter((l): l is { hPa: number; km: number } => !!l)
  return [
    // the note without its own "Moisture flow: " lead-in, since the label says it
    !vol?.none && { label: VIEW_LABEL[name] ?? v?.label ?? "3D field", text: <>{VOL_NOTES[name].replace(/^[A-Z][a-z ]+: (.)/, (_, c: string) => c.toUpperCase())}{!LEVEL_VIEWS.includes(name) && v?.note ? ` ${v.note}` : ""}</> },
    entry.run === "observed"
      ? { label: "The box", text: <>Observed radar at heights from the ground to {entry.topKm} km above sea level, every 500 m, stretched ×{exaggeration}. {steps} frames through {timeLabel(entry.times[steps - 1])}, hourly and then every 10 minutes over the last hour, blended in between.</> }
      : { label: "The box", text: <>{entry.model} on pressure levels from the ground to {entry.topKm} km, heights stretched ×{exaggeration}: kilometres up one edge, the model's average pressure-level heights up the other. Steps every {hours} hours through {timeLabel(entry.times[steps - 1])}, blended in between.</> },
    { label: "Tilt and turn", text: <>Right-drag (or Ctrl-drag), or two fingers on a phone. Drag the compass to tilt; click it to face north.</> },
    particles && pk.length > 0 && { label: "Wind particles", text: <>The wind at {pk.map((l) => `${l.hPa}`).join(", ")} mb (about {pk.map((l) => l.km.toFixed(1)).join(", ")} km), coloured by {name === "mflux" ? "moisture flow" : "speed"}.</> },
    precip && { label: "Falling precipitation", text: <>From the radar layer, wherever the model's rate is 0.01 in/h or more (or its simulated radar about 15 dBZ, without a rate), thicker where it's heavier. Rain falls in streaks, snow drifts, sleet and freezing rain in between, coloured by type, from about 3 km.</> },
    terrain && { label: "3D terrain", text: <>Stretched as much as the 3D data (×{exaggeration}), so heights in the air and on the ground line up. The map's colours are draped over it; the 3D data, particles and falling precipitation stop at the ground.</> },
    snow && { label: "Snow level", text: <>Terrain above the model's snow level, about 1,000 ft below where the wet-bulb temperature reaches freezing, is shaded white.</> },
    vol?.solid != null && { label: "Solid surface", text: <>Everywhere the field reaches {solidLabel(name, vol.solid, v?.units ?? "")} or more, drawn as one opaque surface lit from the south-west, so its shape and how it folds read at a glance.{name === "pv" ? " The box is capped at 9 km at first, since the stratosphere above the tropopause is all over 2 PVU; lift the heights slider to see more." : ""}</> },
    vol && !vol.none && vol.solid == null && vol.render === "cloud" && { label: "Cloud", text: <>The field's shape lit white like real cloud: bright on the side facing the light from the south-west, grey underneath and where it's thick.</> },
    vol && !vol.none && vol.solid == null && vol.render === "max" && { label: "Max", text: <>Each pixel shows the strongest value along that line of sight, like a composite radar seen from any angle: the cores stand out, but not how deep they are.</> },
    vol && !vol.none && vol.solid == null && vol.render === "points" && { label: "Points", text: <>Dots scattered through each grid cell, more where the field draws thicker; they keep their places as time moves, so motion reads as change in the field.</> },
    vol && !vol.none && (vol.from ?? 0) > 0 && v && { label: "Show from", text: <>Values {v.min > v.max ? "above" : "below"} {fmtVal(unpack(vol.from!, v), v.units)} are hidden.</> },
    vol?.scan && !vol.none && { label: "Scan", text: <>A slice {vol.scan.axis === "z" ? "at one height" : vol.scan.axis === "x" ? "from south to north at one longitude" : "from west to east at one latitude"}, coloured by the field's own colour scale (grey where it's missing), with the rest of the field faded so the slice reads.</> },
    vol && vol.color !== "own" && { label: "Colour", text: vol.color === "height" ? <>Coloured by height, purple low through teal to yellow and orange high.</> : <>The shape comes from {(VIEW_LABEL[name] ?? v?.label ?? "the field").toLowerCase()}, the colour from {volLabel(entry, vol.color).toLowerCase()} at the same place.</> },
    vol?.shadow && (vol.solid != null || LIT_VIEWS.includes(name)) && { label: "Shadows", text: <>Cast on the ground by the light from the south-west and fairly high, through {vol.solid != null ? "the solid" : "the field, thicker where it's thicker"}.</> },
    vol?.level && { label: `${vol.level.hPa} mb map`, text: <>The {vol.level.hPa} mb level at its average height ({((entry.vars.hgt?.meanM?.[entry.vars.hgt.hPa!.indexOf(vol.level.hPa)] ?? 0) / 1000).toFixed(1)} km): contours of its height every {vol.level.hPa >= 700 ? 3 : 6} decametres (lows and troughs where they dip; the wind blows along them) and arrows for the wind at that height, longer where it's faster.</> },
    vol?.traj && { label: "Trajectories", text: <>Backward trajectories: the paths the air arriving over each forecast location at about 1.5 and 3 km took over the previous 24 hours (or since the model's first step), through the model's winds{entry.vars.w ? " including its rising and sinking air" : ""}. Coloured by height and fading into the past; a stalk marks each arrival. Lines climbing toward a location show air being lifted, as it is over the mountains and along fronts.</> },
  ]
}

/** The notes for what's on the map, grouped, and the downloads, behind one link (closed at first):
 *  two balanced columns on wider screens, each group a heading over its labelled items. */
function AboutView({ groups, downloads }: { groups: NoteGroup[]; downloads: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const shown = groups.map((g) => ({ ...g, items: g.items.filter((n): n is Note => !!n) })).filter((g) => g.items.length)
  if (!shown.length && !downloads) return null
  return (
    <div className="text-xs text-muted-foreground">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground">
        <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />About this view
      </button>
      {open && (
        <div className="mt-3 gap-x-10 md:columns-2">
          {shown.map((g) => (
            <section key={g.title} className="break-inside-avoid pb-4">
              <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">{g.title}</h4>
              <dl className="space-y-1.5">
                {g.items.map((n) => (
                  <div key={n.label}>
                    <dt className="font-medium text-foreground">{n.label}</dt>
                    <dd className="leading-relaxed">{n.text}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {downloads && (
            <section className="break-inside-avoid pb-4">
              <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">Download</h4>
              <div className="leading-relaxed">{downloads}</div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function RampLegend({ ramp, every = 1, note }: { ramp: Ramp; every?: number; note?: string }) {
  const bins = legendBins(ramp, undefined, every)
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">{ramp.label} ({ramp.units})</div>
      <div className="flex">
        {bins.map((b, i) => (
          <div key={i} className="min-w-0 flex-1">
            <div className="h-2.5" style={{ background: b.color, borderRadius: i === 0 ? "3px 0 0 3px" : i === bins.length - 1 ? "0 3px 3px 0" : 0 }} />
            <div className="pt-1 text-[10.5px] whitespace-nowrap tabular-nums text-muted-foreground">{b.label}</div>
          </div>
        ))}
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

function RadarLegend({ withRefc }: { withRefc: boolean }) {
  if (!withRefc) {
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Precipitation type where precipitation is falling:</span>
        {Object.entries(PTYPE_COLORS).map(([k, c]) => (
          <span key={k} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: c }} />{k[0].toUpperCase() + k.slice(1)}</span>
        ))}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">Simulated composite reflectivity (dBZ), coloured by precipitation type</div>
      {Object.entries(REFC).map(([k, r]) => (
        <div key={k} className="grid grid-cols-[96px_1fr] items-center gap-2">
          <span className="text-xs">{r.label}</span>
          <div className="flex h-2.5 overflow-hidden rounded-[3px]">{r.colors.map((c, i) => <div key={i} className="min-w-0 flex-1" style={{ background: c }} />)}</div>
        </div>
      ))}
      <div className="grid grid-cols-[96px_1fr] gap-2">
        <span />
        <div className="flex text-[10.5px] tabular-nums text-muted-foreground">{legendBins(REFC.rain).map((b, i) => <div key={i} className="min-w-0 flex-1 whitespace-nowrap">{b.label}</div>)}</div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ sampling helpers

/** Value at a lon/lat, nearest cell or bicubic. */
function valueAt(g: Grid, d: Float32Array, lon: number, lat: number, smooth: boolean): number {
  const p = gridPos(g, lon, lat)
  if (!p) return NaN
  return smooth ? bicubicAt(g, d, p[0], p[1]) : nearestAt(g, d, p[0], p[1])
}
/** Same, blended between two times like the shader does (a missing side falls back to the other). */
function blendAt(g: Grid, a: Float32Array, b: Float32Array | null, t: number, lon: number, lat: number, smooth: boolean): number {
  const va = valueAt(g, a, lon, lat, smooth)
  if (!b || t <= 0) return va
  const vb = valueAt(g, b, lon, lat, smooth)
  if (!Number.isFinite(va)) return vb
  if (!Number.isFinite(vb)) return va
  return va + (vb - va) * t
}
const categoryAt = (g: Grid, a: Float32Array, b: Float32Array | null, t: number, lon: number, lat: number) =>
  valueAt(g, b && t >= 0.5 ? b : a, lon, lat, false)

// ------------------------------------------------------------------ totals mode

type TotVar = "precip" | "snow" | "spread" | "pct" | ExtremeVar | "p24" | "p72" | "obs" | "obspct" | "tmaxdep" | "tmindep" | "ar" | "rivers" | "storms"
type TotGroup = "Totals" | "Extremes" | "Vs normal" | "Odds" | "Observed" | "Outlooks"
const GROUP_LABEL: Record<TotGroup, string> = {
  Totals: "Totals", Extremes: "Extremes over the window", "Vs normal": "Temperature vs normal", Odds: "Ensemble odds", Observed: "Already fallen (MRMS)",
  Outlooks: "Outlooks",
}
/** Window products: precipitation totals, extremes, ensemble odds and observed rainfall. `digits` for hover. */
const TOT_VARS: { id: TotVar; label: string; group: TotGroup; ramp: Ramp; perModel: boolean; digits: number; suffix?: string }[] = [
  { id: "precip", label: "Precipitation", group: "Totals", ramp: PRECIP, perModel: true, digits: 2 },
  { id: "snow", label: "Snowfall", group: "Totals", ramp: SNOW, perModel: true, digits: 1 },
  { id: "spread", label: "Model spread", group: "Totals", ramp: SPREAD, perModel: false, digits: 2 },
  { id: "pct", label: "% of normal", group: "Totals", ramp: PCT, perModel: false, digits: 0 },
  { id: "tmax", label: "Highest temperature", group: "Extremes", ramp: { ...TEMP, label: "Highest temperature at 2 m" }, perModel: true, digits: 0 },
  { id: "tmin", label: "Lowest temperature", group: "Extremes", ramp: { ...TEMP, label: "Lowest temperature at 2 m" }, perModel: true, digits: 0 },
  { id: "wind", label: "Strongest wind", group: "Extremes", ramp: { ...WIND, label: "Strongest sustained wind at 10 m" }, perModel: true, digits: 0 },
  { id: "gust", label: "Strongest gust", group: "Extremes", ramp: { ...GUST, label: "Strongest gust" }, perModel: true, digits: 0 },
  { id: "p24", label: "Chance of 1\" in a day", group: "Odds", ramp: { ...PROB, label: "Chance of 1\" or more in 24 hours, pooled ensembles" }, perModel: false, digits: 0, suffix: "% of members" },
  { id: "p72", label: "Chance of 3\" in 3 days", group: "Odds", ramp: { ...PROB, label: "Chance of 3\" or more in 72 hours, pooled ensembles" }, perModel: false, digits: 0, suffix: "% of members" },
  { id: "obs", label: "Observed precipitation", group: "Observed", ramp: { ...PRECIP, label: "Observed precipitation (MRMS)" }, perModel: false, digits: 2 },
  { id: "obspct", label: "Observed, % of normal", group: "Observed", ramp: { ...PCT, label: "Observed precipitation, percent of 1991 – 2020 normal" }, perModel: false, digits: 0, suffix: "% of normal" },
  { id: "tmaxdep", label: "High temp vs normal", group: "Vs normal", ramp: { ...TDEP, label: "Daily high, model-mean departure from 1991 – 2020 normal (window average)" }, perModel: false, digits: 1, suffix: "°F vs normal" },
  { id: "ar", label: "AR outlook (coast)", group: "Outlooks", ramp: { ...IVT, label: "AR scale rank" }, perModel: true, digits: 0 },
  { id: "rivers", label: "River forecasts", group: "Outlooks", ramp: { ...IVT, label: "Flood category" }, perModel: false, digits: 0 },
  { id: "storms", label: "Thunderstorm outlook (SPC)", group: "Outlooks", ramp: { ...IVT, label: "SPC category" }, perModel: false, digits: 0 },
  { id: "tmindep", label: "Low temp vs normal", group: "Vs normal", ramp: { ...TDEP, label: "Daily low, model-mean departure from 1991 – 2020 normal (window average)" }, perModel: false, digits: 1, suffix: "°F vs normal" },
]
const MEAN = "Model mean"

function totalsView(c: Cog | undefined, ramp: Ramp, windowLabel: string, digits = 2, suffix?: string): View | null {
  if (!c) return null
  return {
    key: `tot|${c.path.slice(0, 120)}|${ramp.label}`,
    title: `${c.model}, ${windowLabel}`,
    sub: () => (c.run ? `${c.run} run`
      : c.members ? (c.members.length <= 3 ? c.members.join(" + ") : `${c.members.length} models`)
      : c.tier === "observed" ? "NOAA MRMS radar + gauges" : undefined),
    grid: () => ({
      key: "total", t: 0,
      load: async () => {
        const r = await loadCog(cogUrl(c))
        return {
          draw: { grid: r, a: r.data, paint: { kind: "ramp", ramp } },
          sample: (lon, lat, _t, smooth) => {
            const v = valueAt(r, r.data, lon, lat, smooth)
            if (!Number.isFinite(v)) return null
            if (suffix?.startsWith("°")) return `${v > 0.5 ? "+" : ""}${Math.round(v)}${suffix}`   // departures carry a sign
            if (suffix) return `${Math.round(v)}${suffix}`
            if (ramp.units === "%") return `${Math.round(v)}% of normal`
            return `${v.toFixed(digits)}${ramp.units === "°F" ? "°F" : ` ${ramp.units}`}`
          },
        }
      },
    }),
  }
}

/** The coastal AR outlook as pseudo-COG entries (one per window and model, "Model mean" being the
 *  median rank), so the variable, window and model pickers treat it like any other product. */
function arCogs(ar: ArCoast | null | undefined): Cog[] {
  if (!ar) return []
  return ar.windows.flatMap((w) => [
    { path: `ar|${w.days}|${MEAN}`, model: MEAN, tier: "consensus", var: "ar" as const, days: w.days, units: "", members: Object.keys(w.models) },
    ...Object.keys(w.models).map((m) => ({ path: `ar|${w.days}|${m}`, model: m, tier: ar.tiers[m] ?? "global", var: "ar" as const, days: w.days, units: "" })),
  ])
}

/** Markers along the coast in each location's AR rank colour: the median rank across the models
 *  that reach the window's end, or one model's rank, with the peak IVT on hover. */
function arView(ar: ArCoast, c: Cog | undefined, windowLabel: string): View | null {
  const w = c && ar.windows.find((x) => x.days === c.days)
  if (!c || !w) return null
  const mean = c.model === MEAN
  const rankOf = (name: string) => (mean ? w.median[name]?.rank : w.models[c.model]?.[name]?.rank) ?? 0
  const peakOf = (name: string) => (mean ? w.median[name]?.peak : w.models[c.model]?.[name]?.peak) ?? null
  const fc = {
    type: "FeatureCollection",
    features: ar.points.map((p) => {
      const r = rankOf(p.name)
      return { type: "Feature", properties: { name: p.name, rank: r, num: r ? String(r) : "", color: AR_COLORS[r], text: contrastTextColor(AR_COLORS[r]) },
               geometry: { type: "Point", coordinates: [p.lon, p.lat] } }
    }),
  } as FC
  const sample = (lon: number, lat: number) => {
    const k = Math.cos((47 * Math.PI) / 180)
    let best: (typeof ar.points)[number] | null = null, bd = 0.09
    for (const p of ar.points) { const d = (p.lat - lat) ** 2 + ((p.lon - lon) * k) ** 2; if (d < bd) { bd = d; best = p } }
    if (!best) return null
    const r = rankOf(best.name), pk = peakOf(best.name)
    const agree = mean && w.median[best.name] ? `, ${w.median[best.name].atLeast1} of ${w.median[best.name].n} models reach AR1+` : ""
    return `${best.name}: ${AR_LABELS[r]}${pk ? ` (peak IVT ${pk})` : ""}${agree}`
  }
  return {
    key: `ar|${c.days}|${c.model}`,
    title: `${mean ? "Model median" : c.model}, ${windowLabel}`,
    sub: () => (mean ? `Median AR rank of ${c.members?.length ?? 0} models` : "Strongest AR event in the window"),
    grid: () => ({ key: "ar", t: 0, load: async () => ({ draw: null, bare: true, sample: () => null }) }),
    overlays: () => ({ key: `ar|${c.days}|${c.model}`, t: 0, load: async () => ({ ar: fc, sample }) }),
  }
}

/** River forecast gauges as pseudo-COG entries: one per window (the official forecasts run about a week). */
function riverCogs(r: Rivers | null | undefined): Cog[] {
  if (!r?.gauges.length) return []
  return [2, 7].map((days) => ({ path: `rivers|${days}`, model: "NWRFC forecast", tier: "official", var: "rivers" as const, days, units: "ft" }))
}

/** Each forecast gauge coloured by the highest flood category its forecast reaches in the window. */
function riverView(r: Rivers, c: Cog | undefined, windowLabel: string): View | null {
  if (!c) return null
  const end = Date.now() + c.days * 864e5
  const peak = (g: RiverGauge) => g.forecast.filter(([t]) => Date.parse(t) <= end).reduce<[string, number] | null>((a, x) => (!a || x[1] > a[1] ? x : a), null)
  const lvl = (g: RiverGauge, v: number) => (["action", "minor", "moderate", "major"] as const).reduce((k, n, i) => (g.categories[n] != null && v >= g.categories[n]! ? i + 1 : k), 0)
  const rows = r.gauges.map((g) => { const p = peak(g); return { g, p, l: p ? lvl(g, p[1]) : 0 } })
  const fc = { type: "FeatureCollection", features: rows.sort((a, b) => a.l - b.l).map(({ g, l }) => ({
    type: "Feature", properties: { name: g.name, rank: l, num: "", color: FLOOD_COLORS[l], text: "#fff" },
    geometry: { type: "Point", coordinates: [g.lon, g.lat] } })) } as FC
  const sample = (lon: number, lat: number) => {
    const k = Math.cos((47 * Math.PI) / 180)
    let best: (typeof rows)[number] | null = null, bd = 0.012
    for (const x of rows) { const d = (x.g.lat - lat) ** 2 + ((x.g.lon - lon) * k) ** 2; if (d < bd) { bd = d; best = x } }
    if (!best) return null
    const { g, p, l } = best
    return `${g.name}: now ${g.now.stage?.toFixed(1) ?? "–"} ft; crest ${p ? `${p[1].toFixed(1)} ft ${ptDayHour(p[0])}` : "–"} (${FLOOD_LABELS[l].toLowerCase()})`
  }
  return {
    key: `rivers|${c.days}`,
    title: `River forecasts, ${windowLabel}`,
    sub: () => "Northwest River Forecast Center",
    grid: () => ({ key: "rivers", t: 0, load: async () => ({ draw: null, bare: true, sample: () => null }) }),
    overlays: () => ({ key: `rivers|${c.days}`, t: 0, load: async () => ({ ar: fc, sample }) }),
  }
}

/** The thunderstorm outlook as pseudo-COG entries, one per outlook day with anything over the map
 *  (day 1 always, for the live discussions and the storm reports). */
function stormCogs(c: Convective | null | undefined): Cog[] {
  if (!c) return []
  const days = new Set([1, ...c.outlooks.filter((o) => o.areas.length).map((o) => o.day)])
  return [...days].sort((a, b) => a - b).map((d) => ({ path: `storms|${d}`, model: "SPC", tier: "official", var: "storms" as const, days: d, units: "" }))
}

const inRing = (ring: number[][], lon: number, lat: number) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const inMulti = (g: GeoJSON.MultiPolygon, lon: number, lat: number) =>
  g.coordinates.some((poly) => inRing(poly[0], lon, lat) && !poly.slice(1).some((h) => inRing(h, lon, lat)))

/** One outlook day: the categorical areas (or, for days 4 – 8, the severe probability areas) in
 *  SPC's colours; on day 1 also the current mesoscale discussions (dashed outlines) and the last
 *  three days' storm reports (dots by type). */
function stormView(c: Convective, cog: Cog | undefined, mds: Md[] | null): View | null {
  if (!cog) return null
  const day = cog.days
  const o = c.outlooks.find((x) => x.day === day)
  const kind = day <= 3 ? "cat" : "severe"
  const areas = (o?.areas ?? []).filter((a) => a.kind === kind).sort((a, b) => a.rank - b.rank)
  const showMds = day === 1 ? (mds ?? []) : []
  const reports = day === 1 ? c.reports : []
  const spc = { type: "FeatureCollection", features: [
    ...areas.map((a) => ({ type: "Feature", properties: { kind: "area", fill: a.fill ?? SPC_CAT[a.label]?.fill ?? "#999", stroke: a.stroke ?? "#555" }, geometry: a.geometry })),
    ...showMds.map((m) => ({ type: "Feature", properties: { kind: "md" }, geometry: { type: "LineString", coordinates: m.polygon } })),
  ] } as FC
  const dots = { type: "FeatureCollection", features: reports.map((r) => ({
    type: "Feature", properties: { rank: 1, num: "", color: REPORT_COLORS[r.type], text: "#fff" },
    geometry: { type: "Point", coordinates: [r.lon, r.lat] } })) } as FC
  const sample = (lon: number, lat: number) => {
    const parts: string[] = []
    const k = Math.cos((47 * Math.PI) / 180)
    const near = reports.filter((r) => (r.lat - lat) ** 2 + ((r.lon - lon) * k) ** 2 < 0.004)
    if (near.length) parts.push(near.map((r) => `${r.type === "tornado" ? "Tornado" : r.type === "wind" ? "Wind" : "Hail"}${reportMag(r) ? ` ${reportMag(r)}` : ""}, ${r.location} ${ptDayHour(r.time)}`).join("; "))
    const top = [...areas].reverse().find((a) => inMulti(a.geometry, lon, lat))
    if (top) parts.push(day <= 3 ? `${SPC_CAT[top.label]?.name ?? top.name}${top.label !== "TSTM" ? " risk" : ""}` : top.name)
    for (const m of showMds) if (inRing(m.polygon, lon, lat)) parts.push(`MD ${m.number}: ${m.concerning}`)
    return parts.length ? parts.join(" · ") : null
  }
  return {
    key: `storms|${day}|${showMds.map((m) => m.number).join()}`,
    title: `SPC convective outlook, day ${day}`,
    sub: () => (o?.valid ? `${ptDayHour(o.valid)} – ${o.expire ? ptDayHour(o.expire, true) : ""}${o.issued ? ` · issued ${ptDayHour(o.issued)}` : ""}` : "No thunderstorms outlooked over the region"),
    grid: () => ({ key: "storms", t: 0, load: async () => ({ draw: null, bare: true, sample: () => null }) }),
    overlays: () => ({ key: `storms|${day}|${showMds.map((m) => m.number).join()}`, t: 0, load: async () => ({ spc, ar: dots, sample }) }),
  }
}

function StormLegend({ day }: { day: number }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        {day <= 3 ? "SPC's categorical risk of severe thunderstorms" : "SPC's probability of severe thunderstorms"}
        {day === 1 && "; dashed outlines are current mesoscale discussions, dots the storm reports from the last three days"}. Hover for details.
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {day <= 3 && Object.entries(SPC_CAT).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5"><span className="size-3 rounded-[3px] ring-1 ring-black/15" style={{ background: v.fill }} />{v.name}</span>
        ))}
        {day === 1 && (["tornado", "wind", "hail"] as const).map((t) => (
          <span key={t} className="flex items-center gap-1.5"><span className="size-3 rounded-full ring-2 ring-white" style={{ background: REPORT_COLORS[t] }} />{t[0].toUpperCase() + t.slice(1)} report</span>
        ))}
      </div>
    </div>
  )
}

function RiverLegend() {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">The highest flood category each gauge's official forecast reaches in the window; hover a gauge for its stage and crest</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {FLOOD_LABELS.map((l, k) => (
          <span key={l} className="flex items-center gap-1.5">
            <span className={`rounded-full ring-2 ring-white ${k ? "size-3.5" : "size-2.5"}`} style={{ background: FLOOD_COLORS[k] }} />{l}
          </span>
        ))}
      </div>
    </div>
  )
}

function ArLegend() {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">AR scale rank at the coast: the strongest atmospheric-river event in the window (peak IVT and how long it lasts)</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {AR_LABELS.map((l, r) => (
          <span key={l} className="flex items-center gap-1.5">
            <span className={`grid place-items-center rounded-full text-[10px] font-semibold ring-2 ring-white ${r ? "size-4" : "size-2.5"}`}
              style={{ background: AR_COLORS[r], color: contrastTextColor(AR_COLORS[r]) }}>{r || ""}</span>{l}
          </span>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ hourly mode

type HLayer = "radar" | "apcp" | "asnow" | "t2m" | "gust" | "wind" | "frz" | "ivt" | "pgrad" | "rh" | "smoke"
type HGroup = "Precipitation" | "Temperature" | "Wind and pressure" | "Fire weather"
const HLAYERS: { id: HLayer; label: string; group: HGroup; primary: (e: Record<string, FieldEntry>) => FieldEntry | undefined }[] = [
  { id: "radar", label: "Radar and precip type", group: "Precipitation", primary: (e) => e.refc ?? e.ptype },
  { id: "apcp", label: "Accumulated precipitation", group: "Precipitation", primary: (e) => e.apcp },
  { id: "asnow", label: "Accumulated snowfall", group: "Precipitation", primary: (e) => e.asnow },
  { id: "ivt", label: "Moisture (IVT)", group: "Precipitation", primary: (e) => (e.ivtu && e.ivtv ? e.ivtu : undefined) },
  { id: "t2m", label: "Temperature", group: "Temperature", primary: (e) => e.t2m },
  { id: "frz", label: "Freezing level", group: "Temperature", primary: (e) => e.frz },
  { id: "wind", label: "Wind", group: "Wind and pressure", primary: (e) => (e.u10 && e.v10 ? e.u10 : undefined) },
  { id: "gust", label: "Gusts", group: "Wind and pressure", primary: (e) => e.gust },
  { id: "pgrad", label: "Pressure gradient", group: "Wind and pressure", primary: (e) => e.mslp },
  { id: "rh", label: "Relative humidity", group: "Fire weather", primary: (e) => e.rh },
  { id: "smoke", label: "Near-surface smoke", group: "Fire weather", primary: (e) => e.smoke },
]
const H_GROUPS: HGroup[] = ["Precipitation", "Temperature", "Wind and pressure", "Fire weather"]
const APCP: Ramp = { ...PRECIP, label: "Accumulated precipitation, liquid equivalent" }
const ASNOW: Ramp = { ...SNOW, label: "Accumulated snowfall" }
/** The vector pair a layer's particles follow: water vapor transport on the IVT layer, else the 10 m wind. */
const flowOf = (layer: HLayer, e: Record<string, FieldEntry>) =>
  layer === "ivt" ? (e.ivtu && e.ivtv ? { u: e.ivtu, v: e.ivtv, scale: 1 / 25 } : null)
    : (e.u10 && e.v10 ? { u: e.u10, v: e.v10, scale: 1 } : null)
// every 2 hPa: this view is only ~7° across, where 4 hPa leaves one or two lines outside a strong storm
const ISOBARS = Array.from({ length: 62 }, (_, i) => 940 + 2 * i)

const timeLabel = (iso: string) => ptDayHour(iso, true)

/** Band `i` of a field, or null if it has no band within `tol` hours of `iso`. */
async function bandNear(e: FieldEntry | undefined, iso: string, tol = 0.6) {
  if (!e) return null
  const i = nearestTime(e.times, iso, tol)
  if (i < 0) return null
  const f = await loadField(e)
  return { f, i, data: await f.band(i) }
}

/** Where sea-level pressure is an extrapolation its gradient traces the mountains, so cells whose
 *  mean height is above 600 m, or whose highest point is above 1,400 m, are left blank. */
const PGRAD_MAX_MEAN = 600, PGRAD_MAX_PEAK = 1400
const masked = (elev: Elevation, i: number) => elev.mean[i] > PGRAD_MAX_MEAN || elev.max[i] > PGRAD_MAX_PEAK
const gradCache = new WeakMap<Float32Array, Float32Array>()
const gradOf = (g: Grid, p: Float32Array, elev: Elevation | null) => {
  if (!gradCache.has(p)) {
    const out = pressureGradient(g, p, g.width > 120 ? 6 : 2)
    if (elev) {
      // one cell wider than the mountains: a cell's central difference uses its neighbours' pressure
      const W = g.width, m = new Uint8Array(out.length)
      for (let i = 0; i < out.length; i++) if (masked(elev, i)) m[i] = 1
      for (let i = 0; i < out.length; i++) {
        const x = i % W
        if (m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || m[i - W] || m[i + W]) out[i] = NaN
      }
    }
    gradCache.set(p, out)
  }
  return gradCache.get(p)!
}

const speedCache = new WeakMap<Float32Array, Float32Array>()
const speedOf = (u: Float32Array, v: Float32Array) => {
  if (!speedCache.has(u)) speedCache.set(u, u.map((x, i) => Math.hypot(x, v[i])))
  return speedCache.get(u)!
}

// overlays are vector work on the CPU; keep recent ones so scrubbing back and forth is instant
const overlayCache = new Map<string, Promise<Overlays>>()
function cachedOverlay(key: string, load: () => Promise<Overlays>) {
  if (!overlayCache.has(key)) {
    if (overlayCache.size > 160) overlayCache.delete(overlayCache.keys().next().value!)
    const p = load()
    p.catch(() => overlayCache.delete(key))
    overlayCache.set(key, p)
  }
  return overlayCache.get(key)!
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

/** The configured station pairs as lines, coloured by how far this model's difference at `time`
 *  is past each pair's thresholds, with the value as a label. */
function pairOverlay(pairs: Gradient[], model: string, time: number): FC {
  const features: GeoJSON.Feature[] = []
  for (const g of pairs) {
    const s = g.series.find((x) => x.model === model)
    if (!g.locs || !s) continue
    const v = seriesAt(s, time)
    if (v == null) continue
    const { level, label } = gradLevel(g, v)
    const r = Math.round(v)
    const text = `${pairName(g)} ${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}`
    // ordered from the higher-pressure station to the lower, so the arrowheads show the flow
    const coords = v >= 0 ? g.locs : [...g.locs].reverse()
    features.push({ type: "Feature", properties: { level, color: GRAD_COLORS[level], text, what: label ?? "", flow: Math.abs(v) >= 1 ? 1 : 0 },
                    geometry: { type: "LineString", coordinates: coords } })
    for (const [k, loc] of g.locs.entries()) {
      features.push({ type: "Feature", properties: { end: 1, color: GRAD_COLORS[level], code: g.codes?.[k] ?? "" },
                      geometry: { type: "Point", coordinates: loc } })
    }
  }
  return { type: "FeatureCollection", features } as FC
}

function hourlyView(model: string, entries: Record<string, FieldEntry>, layer: HLayer, isobars: boolean, pairs: Gradient[] | null): View | null {
  const def = HLAYERS.find((l) => l.id === layer)!
  const prim = def.primary(entries)
  if (!prim) return null
  const iso = isobars && !!entries.mslp
  const name = def.label.toLowerCase()
  // observed frames only stand for the time they were taken; model steps cover the hours around them
  const tol = prim.tier === "observed" ? 0.4 : 3.1
  const nearest = (time: number | null) => (time == null ? null : bracket(prim.times, time, false, tol))
  const ramp = layer === "t2m" ? TEMP : layer === "gust" ? GUST : layer === "wind" ? WIND : layer === "ivt" ? IVT : layer === "pgrad" ? PGRAD
    : layer === "apcp" ? APCP : layer === "asnow" ? ASNOW : layer === "rh" ? RH : layer === "smoke" ? SMOKE : FRZ

  return {
    key: `hr|${model}|${layer}|${iso ? 1 : 0}|${pairs ? 1 : 0}`,
    title: `${model}, ${name}`,
    sub(time) {
      const b = nearest(time)
      if (!b) return undefined
      const valid = prim.times[b.i0]
      if (prim.tier === "observed") return `${timeLabel(valid)} · observed`
      return `${timeLabel(valid)} (hour ${Math.round((Date.parse(valid) - Date.parse(prim.init)) / 3600e3)} of the ${prim.run} run)`
    },
    grid(time, interp) {
      const b = time == null ? null : bracket(prim.times, time, interp, tol)
      if (!b) {
        const when = time == null ? "" : prim.tier === "observed" ? ` at ${timeLabel(new Date(time).toISOString())} (observed radar covers the briefing's start to now)`
          : ` within 3 hours of ${timeLabel(new Date(time).toISOString())}`
        return { key: `none:${time}`, t: 0, load: async () => ({ draw: null, note: `${model} has no ${name}${when}.`, sample: () => null }) }
      }
      return {
        key: `${b.i0}|${b.i1}`, t: b.t,
        load: async () => {
          const f = await loadField(prim)
          const A = await f.band(b.i0)
          const B = b.i1 !== b.i0 ? await f.band(b.i1) : null
          const isoA = prim.times[b.i0], isoB = prim.times[b.i1]
          let draw: GridDraw
          let describe: (lon: number, lat: number, t: number, smooth: boolean) => string | null
          // the model's precipitation rate on the same grid (intensity for the 3D view's falling precipitation)
          let rateA: Float32Array | null = null, rateB: Float32Array | null = null
          if (layer === "radar") {
            const ra = await bandNear(entries.prate, isoA), rb = B ? await bandNear(entries.prate, isoB) : null
            rateA = ra && sameGrid(ra.f, f) ? ra.data : null
            rateB = rateA && rb && sameGrid(rb.f, f) ? rb.data : rateA
          }
          const rateText = (lon: number, lat: number, t: number) => {
            if (!rateA) return ""
            const r = blendAt(f, rateA, rateB, t, lon, lat, false)
            return r >= 0.005 ? `, ${r < 0.1 ? r.toFixed(2) : r.toFixed(1)} in/h` : ""
          }
          if (layer === "radar" && prim.var === "refc") {
            const pa = await bandNear(entries.ptype, isoA), pb = B ? await bandNear(entries.ptype, isoB) : null
            const aux = pa && sameGrid(pa.f, f) ? pa.data : null
            const auxB = aux && pb && sameGrid(pb.f, f) ? pb.data : aux
            draw = { grid: f, a: A, b: B, auxA: aux, auxB, rateA, rateB, paint: { kind: "refc" } }
            describe = (lon, lat, t, smooth) => {
              const v = blendAt(f, A, B, t, lon, lat, smooth)
              if (!(v >= 5)) return "No precipitation"
              const code = aux ? categoryAt(f, aux, auxB, t, lon, lat) : NaN
              const tn = PTYPE_NAMES[code] as string | undefined
              return `${tn && tn !== "none" ? cap(tn) + ", " : ""}${Math.round(v)} dBZ${rateText(lon, lat, t)}`
            }
          } else if (layer === "pgrad") {
            const elev = await elevationFor(f).catch(() => null)
            const GA = gradOf(f, A, elev), GB = B ? gradOf(f, B, elev) : null
            draw = { grid: f, a: GA, b: GB, paint: { kind: "ramp", ramp } }
            describe = (lon, lat, t, smooth) => {
              const v = blendAt(f, GA, GB, t, lon, lat, smooth)
              if (Number.isFinite(v)) return `Pressure gradient ${v.toFixed(1)} hPa per 100 km`
              return elev && Number.isFinite(valueAt(f, A, lon, lat, false)) ? "Mountains: not shown (sea-level pressure there is an extrapolation)" : null
            }
          } else if (layer === "radar") {
            draw = { grid: f, a: A, b: B, rateA, rateB, paint: { kind: "ptype" } }
            describe = (lon, lat, t) => {
              const tn = PTYPE_NAMES[categoryAt(f, A, B, t, lon, lat)] ?? "none"
              return tn === "none" ? "No precipitation" : cap(tn) + rateText(lon, lat, t)
            }
          } else if (layer === "wind" || layer === "ivt") {
            const vEntry = layer === "ivt" ? entries.ivtv : entries.v10
            const va = await bandNear(vEntry, isoA), vb = B ? await bandNear(vEntry, isoB) : null
            if (!va || (B && !vb)) return { draw: null, note: `${model} has no matching wind components at this time.`, sample: () => null }
            const SA = speedOf(A, va.data), SB = B && vb ? speedOf(B, vb.data) : null
            draw = { grid: f, a: SA, b: SB, paint: { kind: "ramp", ramp } }
            describe = (lon, lat, t, smooth) => {
              const s = blendAt(f, SA, SB, t, lon, lat, smooth)
              if (!Number.isFinite(s)) return null
              const u = blendAt(f, A, B, t, lon, lat, smooth), v = blendAt(f, va.data, vb?.data ?? null, t, lon, lat, smooth)
              if (layer === "ivt") return `IVT ${Math.round(s)} kg/m/s from the ${windFrom(u, v)}${s >= 250 ? " (AR conditions)" : ""}`
              return `${windFrom(u, v)} ${Math.round(s)} mph`
            }
          } else {
            draw = { grid: f, a: A, b: B, paint: { kind: "ramp", ramp } }
            describe = (lon, lat, t, smooth) => {
              const v = blendAt(f, A, B, t, lon, lat, smooth)
              if (!Number.isFinite(v)) return null
              if (layer === "t2m") return `${Math.round(v)}°F`
              if (layer === "gust") return `Gusts ${Math.round(v)} mph`
              if (layer === "apcp") return v < 0.005 ? "No precipitation yet" : `${v.toFixed(2)} in so far`
              if (layer === "asnow") return v < 0.05 ? "No snow yet" : `${v.toFixed(1)} in of snow so far`
              if (layer === "rh") return `Humidity ${Math.round(v)}%`
              if (layer === "smoke") return v < 1 ? "No smoke" : `Smoke ${Math.round(v)} µg/m³`
              return `Freezing level ${(Math.round(v / 100) * 100).toLocaleString("en-US")} ft`
            }
          }
          return { draw, sample: describe }
        },
      }
    },
    overlays(time) {
      const b = nearest(time)
      if (!b) return null
      const i = b.i0
      const valid = prim.times[i]
      const ck = `${model}|${layer}|${i}|${iso ? 1 : 0}|${pairs ? 1 : 0}`
      return {
        key: `${i}`, t: 0, ready: overlayCache.has(ck) || !(iso || layer === "t2m"),
        load: () => cachedOverlay(ck, async () => {
          const out: Overlays = {}
          if (pairs) out.pairs = pairOverlay(pairs, model, Date.parse(valid))
          if (layer === "t2m") {
            const f = await loadField(prim)
            out.freezing = await contourAsync(f, await f.band(i), [32], 1)
          }
          if (layer === "wind") {
            const f = await loadField(prim)
            const v = await bandNear(entries.v10, valid)
            if (v) out.arrows = windArrows(f, await f.band(i), v.data)
          }
          if (iso) {
            const p = await bandNear(entries.mslp, valid, 1.6)
            if (p) {
              // extra smoothing on 3 km grids, where sea-level reduction over terrain is noisy
              const { lines, centers } = await isobarsAsync(p.f, p.data, ISOBARS, p.f.width > 120 ? 4 : 1)
              out.isobars = lines
              out.centers = centers
              out.sample = (lon, lat, smooth) => {
                const v = valueAt(p.f, p.data, lon, lat, smooth)
                return Number.isFinite(v) ? `${v.toFixed(0)} hPa` : null
              }
            }
          }
          return out
        }),
      }
    },
    wind(time, interp) {
      const flow = flowOf(layer, entries)
      if (!flow || time == null) return null
      const { u, v, scale } = flow
      const sc = (a: Float32Array) => (scale === 1 ? a : a.map((x) => x * scale))
      const b = bracket(u.times, time, interp, 3.1)
      if (!b) return null
      return {
        key: `${b.i0}|${b.i1}`, t: b.t,
        load: async () => {
          const f = await loadField(u)
          const u0 = await f.band(b.i0)
          const v0 = await bandNear(v, u.times[b.i0])
          if (!v0 || !sameGrid(v0.f, f)) throw new Error("no matching v component")
          if (b.i1 === b.i0) return { grid: f, u0: sc(u0), v0: sc(v0.data) }
          const u1 = await f.band(b.i1)
          const v1 = await bandNear(v, u.times[b.i1])
          return v1 ? { grid: f, u0: sc(u0), v0: sc(v0.data), u1: sc(u1), v1: sc(v1.data) } : { grid: f, u0: sc(u0), v0: sc(v0.data) }
        },
      }
    },
    prefetch(time) {
      // decode the next few steps ahead of playback, and work out their overlays
      const i = Math.floor(posOf(msOf(prim.times), time))
      for (let k = 1; k <= 3; k++) {
        const iso = prim.times[i + k]
        if (iso) this.overlays?.(Date.parse(iso))?.load().catch(() => {})
      }
      for (const e of [prim, entries.ptype, entries.prate, entries.v10, entries.u10, entries.ivtv]) {
        if (!e) continue
        for (let k = 1; k <= 6; k++) {
          const iso = prim.times[i + k]
          if (!iso) break
          const j = nearestTime(e.times, iso, 0.6)
          if (j >= 0) loadField(e).then((f) => f.band(j)).catch(() => {})
        }
      }
    },
  }
}

/** Observed radar frames (MRMS) for the briefing's window, listed once the hourly map is open and
 *  every 5 minutes after that while the window reaches now. */
function useMrms(data: Briefing, on: boolean): FieldEntry | null {
  const [entry, setEntry] = React.useState<FieldEntry | null>(null)
  const start = Date.parse(data.meta.cycle ?? `${data.dates[0]}T12:00:00Z`)
  React.useEffect(() => {
    if (!on) return
    let stop = false
    const d = data.domain
    const load = () => import("@/lib/mrms")
      .then((m) => m.mrmsEntry(start, { west: d.lon_min, south: d.lat_min, east: d.lon_max, north: d.lat_max }))
      .then((e) => { if (!stop) setEntry((old) => (e && old && e.keys?.join() === old.keys?.join() ? old : e)) })
      .catch(() => {})
    load()
    const live = Date.now() < start + 48 * 3600e3
    const id = live ? setInterval(load, 5 * 60e3) : undefined
    return () => { stop = true; if (id) clearInterval(id) }
  }, [on, start])
  return entry
}

/** The observed 3D radar entry (MRMS), listed once the 3D view is open, refreshed every 10 minutes
 *  while the briefing's window reaches now; over the models' box (or the briefing's area). */
function useRadar3d(data: Briefing, on: boolean, like: VolumeEntry | null): VolumeEntry | null {
  const [entry, setEntry] = React.useState<VolumeEntry | null>(null)
  const start = Date.parse(data.meta.cycle ?? `${data.dates[0]}T12:00:00Z`)
  const d = data.domain
  const box = like
    ? { west: like.lon[0], east: like.lon[1], south: like.lat[0], north: like.lat[1] }
    : { west: d.lon_min, south: d.lat_min, east: d.lon_max, north: d.lat_max }
  const boxKey = `${box.west},${box.south},${box.east},${box.north}`
  React.useEffect(() => {
    if (!on) return
    let stop = false
    const load = () => import("@/lib/mrms3d").then((m) => m.mrms3dEntry(start, box))
      .then((e) => { if (!stop) setEntry((old) => (e && old && e.times.join() === old.times.join() ? old : e)) })
      .catch(() => {})
    load()
    const id = Date.now() < start + 48 * 3600e3 ? setInterval(load, 10 * 60e3) : undefined
    return () => { stop = true; if (id) clearInterval(id) }
  }, [on, start, boxKey])
  return entry
}

/** GOES frame times from nowCOAST (about the last 7 hours), refreshed every 5 minutes while the
 *  hourly map is open; null when the service can't be reached (the option is then hidden). */
function useSatTimes(on: boolean): SatTimes | null {
  const [times, setTimes] = React.useState<SatTimes | null>(null)
  React.useEffect(() => {
    if (!on) return
    let stop = false
    const load = () => satTimes().then((t) => { if (!stop && Object.values(t).some((x) => x.length)) setTimes(t) }).catch(() => {})
    load()
    const id = setInterval(load, 5 * 60e3)
    return () => { stop = true; clearInterval(id) }
  }, [on])
  return times
}

function useFields(data: Briefing): FieldEntry[] {
  const inline = (data as unknown as { _fields?: FieldsManifest })._fields
  const [list, setList] = React.useState<FieldEntry[]>(inline?.fields ?? [])
  React.useEffect(() => {
    if (inline) return
    fetch("data/fields.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((js: FieldsManifest | null) => js && setList(js.fields ?? []))
      .catch(() => {})
  }, [])
  return list
}

// ------------------------------------------------------------------ shared controls

const TIERS = [["observed", "Observed"], ["consensus", "Consensus"], ["regional", "Regional"], ["blend", "Blend"], ["global", "Global"]] as const

function ModelSelect({ options, value, onChange, label }: { options: { model: string; tier: string }[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="min-w-0 flex-1 sm:w-[170px] sm:flex-none" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        {TIERS.map(([t, name]) => [name, options.filter((o) => o.tier === t)] as const).filter(([, o]) => o.length).map(([name, o]) => (
          <SelectGroup key={name}>
            <SelectLabel>{name}</SelectLabel>
            {o.map((c) => <SelectItem key={c.model} value={c.model}>{c.model}</SelectItem>)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

function Toggle({ id, label, checked, onChange, help }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; help?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id}>{label}</Label>
      {help && <Help label={label} text={help} />}
    </div>
  )
}

/** A titled group of settings in the 3D panel. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h4 className="text-xs font-semibold text-foreground/80">{title}</h4>
      <div className="space-y-2">{children}</div>
    </section>
  )
}
/** One setting: its label (and help) in a fixed column, the control filling the rest, and its value
 *  at the end when there is one (for sliders). */
/** What the cursor is over in the 3D box, in words: the field's value (or which surface), its
 *  height in km and feet, and roughly its pressure. */
function probeText(vol: PaneVolume, L: VolumeLayer, x: number, y: number, w: number, h: number): string | null {
  const hit = L.probe(x, y, w, h)
  if (!hit) return null
  const v = volVarOf(vol.entry, vol.name)
  if (!v) return null
  const km = hit.z * vol.entry.topKm
  const where = `${km.toFixed(1)} km (${Math.round((km * 1000) / 0.3048 / 100) * 100} ft)`
  const p = pressureAtKm(vol.entry, km)
  const mb = Number.isFinite(p) ? ` · ~${Math.round(p / 10) * 10} mb` : ""
  const val = unpack(hit.byte, v)
  const label = volLabel(vol.entry, vol.name)
  const fmt = (x: number) => (vol.name === "turb" ? `Ri ${x.toFixed(2)}` : vol.name === "temp" || vol.name === "wbz" ? `${Math.round(x)}°F` : fmtVal(x, v.units))
  if (LEVEL_VIEWS.includes(vol.name) && hit.what === "surface") return `${label}: ${where}`
  if (hit.what === "surface") return `${fmt(val)} surface at ${where}${mb}`
  if (hit.what === "solid") return `${label}, solid at ${fmt(val)}: ${where}${mb}`
  return `${label} ${fmt(val)}${hit.what === "max" ? " (strongest)" : ""} at ${where}${mb}`
}

/** A value with its units, rounded to suit its size. */
function fmtVal(x: number, units: string) {
  const r = Math.abs(x) >= 10 ? Math.round(x) : Math.abs(x) >= 1 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100
  return units === "%" ? `${r}%` : `${r} ${units}`
}
/** The scan's position: a slider (in the box's own fraction, south to north for that axis) and a
 *  play button that sweeps it back and forth, moving the slice directly rather than through the page. */
function ScanSlider({ axis, entry, pos, onCommit, sink }: {
  axis: ScanAxis; entry: VolumeEntry; pos: number; onCommit: (p: number) => void; sink: React.RefObject<{ set?: (p: number) => void }>
}) {
  const [p, setP] = React.useState(pos)
  const [sweep, setSweep] = React.useState(false)
  const live = React.useRef(p)
  const move = (x: number) => { live.current = x; setP(x); sink.current?.set?.(x) }
  React.useEffect(() => {
    if (!sweep) return
    let dir = 1, last = performance.now(), raf = 0, acc = 0
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now; acc += dt
      let x = live.current + dir * dt / 6                  // six seconds across
      if (x >= 1) { x = 1; dir = -1 } else if (x <= 0) { x = 0; dir = 1 }
      live.current = x
      if (acc >= 1 / 15) { acc = 0; setP(x); sink.current?.set?.(x) }   // the raymarch at ~15 a second
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); onCommit(live.current) }
  }, [sweep])
  // p is the box's own fraction, which runs north to south in y; the slider runs south to north
  const box = p
  const label = axis === "z" ? `${(box * entry.topKm).toFixed(1)} km`
    : axis === "x" ? `${Math.abs(entry.lon[0] + box * (entry.lon[1] - entry.lon[0])).toFixed(1)}°W`
    : (() => {
        const yN = mercY(entry.lat[1]), yS = mercY(entry.lat[0]), m = yN + box * (yS - yN)
        return `${((Math.atan(Math.sinh(Math.PI * (1 - 2 * m))) * 180) / Math.PI).toFixed(1)}°N`
      })()
  return (
    <Row label="Position" value={label}>
      <div className="flex w-full items-center gap-2">
        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => setSweep((x) => !x)} aria-label={sweep ? "Stop the sweep" : "Sweep the scan"}>
          {sweep ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </Button>
        <Slider className="w-full" value={[axis === "y" ? 1 - p : p]} min={0} max={1} step={0.01}
          onValueChange={([x]) => { setSweep(false); move(axis === "y" ? 1 - x : x) }}
          onValueCommit={([x]) => onCommit(axis === "y" ? 1 - x : x)} aria-label="Scan position" />
      </div>
    </Row>
  )
}
function Row({ label, help, value, children }: { label: string; help?: string; value?: string; children: React.ReactNode }) {
  return (
    <div className={`grid items-center gap-x-3 text-sm ${value != null ? "grid-cols-[92px_minmax(0,1fr)_3.75rem]" : "grid-cols-[92px_minmax(0,1fr)]"}`}>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <Label className="font-normal">{label}</Label>
        {help && <Help label={label} text={help} />}
      </span>
      <div className="flex min-h-8 min-w-0 items-center">{children}</div>
      {value != null && <span className="text-right text-xs text-muted-foreground tabular-nums">{value}</span>}
    </div>
  )
}
/** An on/off setting: label (and help) on the left, the switch on the right, lined up with the rows. */
function SwitchRow({ id, label, checked, onChange, help, indent = false }: {
  id: string; label: string; checked: boolean; onChange: (v: boolean) => void; help?: string; indent?: boolean
}) {
  return (
    <div className={`flex min-h-8 items-center justify-between gap-3 text-sm ${indent ? "pl-4" : ""}`}>
      <span className="flex items-center gap-1.5">
        <Label htmlFor={id} className="font-normal">{label}</Label>
        {help && <Help label={label} text={help} />}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** A small help icon after a control's label: what the control does, on hover or focus. */
function Help({ label, text }: { label: string; text: string }) {
  // hover or focus on a mouse; a tap toggles it on a touch screen, which has no hover
  const [open, setOpen] = React.useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`About ${label}`} onClick={() => setOpen((o) => !o)}
          className="-ml-0.5 rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <CircleHelp className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent collisionPadding={12} className="max-w-[260px] text-xs leading-snug">{text}</TooltipContent>
    </Tooltip>
  )
}

/** A labelled control in the 3D panel: label, help icon, then the control. */
function Control({ label, help, labelClass = "", children }: { label: string; help?: string; labelClass?: string; children: React.ReactNode }) {
  return (
    <div data-control className="flex items-center gap-2.5 text-sm max-sm:w-full">
      <span className={`flex items-center gap-1.5 whitespace-nowrap max-sm:min-w-[118px] ${labelClass}`}>
        <Label className="font-normal">{label}</Label>
        {help && <Help label={label.replace(/×.*/, "stretch")} text={help} />}
      </span>
      {children}
    </div>
  )
}

/** One setting in the map options popover: label on the left, switch on the right. */
function OptionRow({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <Label htmlFor={id} className="font-normal">{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** Overlays and display settings, kept out of the main control row. */
function MapOptions({ overlays, display, active }: { overlays: React.ReactNode[]; display: React.ReactNode; active: number }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" className="gap-2 font-normal max-sm:w-full">
          <SlidersHorizontal className="size-4 text-muted-foreground" />
          Map options
          {active > 0 && <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{active}</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={16}
          className="z-50 w-[min(280px,calc(100vw-32px))] rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-hidden">
          {overlays.length > 0 && (
            <div className="mb-3 border-b pb-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Overlays</p>
              {overlays}
            </div>
          )}
          <p className="mb-1 text-xs font-medium text-muted-foreground">Display</p>
          {display}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** A boolean setting remembered in this browser (when storage is available). */
function useStoredFlag(key: string, initial: boolean, forced?: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = React.useState(() => {
    if (forced != null) return forced                     // a shared link's setting wins
    try {
      const s = localStorage.getItem(key)
      return s == null ? initial : s === "1"
    } catch { return initial }
  })
  return [v, (x: boolean) => {
    setV(x)
    try { localStorage.setItem(key, x ? "1" : "0") } catch { /* storage unavailable */ }
  }]
}

const SEC_PER_STEP = 0.7

/** Play button, time slider and label; the only part of the card that re-renders during playback. */
/**
 * A panel floating in the map's bottom-left corner (the cross-section on the map page and in full
 * screen): a title bar that folds it away or closes it, and the content under it. Open at first on
 * wider screens; on a phone it starts folded so the map shows, and spans the map's width.
 */
function FloatPanel({ title, onClose, picking, className, children, side = "left" }: {
  title: string; onClose: () => void; picking?: boolean; className: string; children: React.ReactNode; side?: "left" | "right"
}) {
  const [open, setOpen] = React.useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 640px)").matches)
  React.useEffect(() => { if (picking) setOpen(true) }, [picking])        // the instructions show while drawing
  // dragged by its title bar anywhere over the map (kept inside it); a press that doesn't move is a click
  const box = React.useRef<HTMLElement>(null)
  const [off, setOffState] = React.useState<[number, number]>([0, 0])
  const offRef = React.useRef<[number, number]>([0, 0])
  const setOff = React.useCallback((o: [number, number] | ((p: [number, number]) => [number, number])) => {
    const v = typeof o === "function" ? o(offRef.current) : o
    offRef.current = v
    setOffState(v)
  }, [])
  const drag = React.useRef<{ x: number; y: number; off: [number, number]; moved: boolean } | null>(null)
  const moved = React.useRef(false)
  const clamp = React.useCallback((o: [number, number]): [number, number] => {
    const el = box.current, parent = el?.parentElement
    if (!el || !parent) return o
    // the panel's place with no offset, then how far it may go each way within the map
    const p = parent.getBoundingClientRect(), r = el.getBoundingClientRect()
    const left = r.left - offRef.current[0], top = r.top - offRef.current[1]
    return [Math.min(p.right - 4 - (left + r.width), Math.max(p.left + 4 - left, o[0])),
            Math.min(p.bottom - 4 - (top + Math.min(r.height, 44)), Math.max(p.top + 4 - top, o[1]))]
  }, [])
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-no-drag]")) return
    const d = { x: e.clientX, y: e.clientY, off, moved: false }
    drag.current = d
    moved.current = false
    // followed on the window, so a quick drag that leaves the title bar keeps going
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      d.moved = true
      ev.preventDefault()
      setOff(clamp([d.off[0] + dx, d.off[1] + dy]))
    }
    const up = () => {
      moved.current = d.moved                       // a press that didn't move is a click on the title
      drag.current = null
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }
  // keep it on the map when the map changes size (full screen, a phone turned)
  React.useEffect(() => {
    const parent = box.current?.parentElement
    if (!parent) return
    const ro = new ResizeObserver(() => setOff((o) => (o[0] || o[1] ? clamp(o) : o)))
    ro.observe(parent)
    return () => ro.disconnect()
  }, [clamp, setOff])
  return (
    <section ref={box} aria-label={title} style={{ transform: `translate(${off[0]}px, ${off[1]}px)` }}
      className={`absolute z-10 rounded-lg border bg-card/95 shadow-lg backdrop-blur max-sm:right-2 max-sm:left-2 max-sm:w-auto ${side === "left" ? "left-3 w-[min(600px,calc(100%-24px))]" : "right-3 w-[min(430px,calc(100%-24px))]"} ${className}`}>
      <div className="flex cursor-grab touch-none items-center gap-1 py-1 pr-1 pl-2 select-none active:cursor-grabbing"
        onPointerDown={onDown} title="Drag to move">
        <button type="button" aria-expanded={open}
          onClick={() => { if (moved.current) { moved.current = false; return } setOpen((o) => !o) }}
          className="flex items-center gap-1 rounded-md px-1 py-1 text-left text-[13px] font-semibold outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />{title}
        </button>
        <GripHorizontal className="mx-auto size-4 text-muted-foreground/70" aria-hidden />
        {(off[0] !== 0 || off[1] !== 0) && (
          <Button data-no-drag variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setOff([0, 0])}>Reset</Button>
        )}
        <Button data-no-drag variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label={`Close the ${title.toLowerCase()}`}><X className="size-4" aria-hidden /></Button>
      </div>
      {open && <div className="max-h-[min(60dvh,420px)] space-y-2 overflow-y-auto px-3 pb-3">{children}</div>}
    </section>
  )
}

/** The legends over the full screen map: open on wider screens, a "Legend" button on phones. */
function MapKey({ children, below3d = false }: { children: React.ReactNode; below3d?: boolean }) {
  const [open, setOpen] = React.useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 640px)").matches)
  return (
    <div className={`absolute right-2 z-10 flex max-w-[calc(100%-16px)] flex-col items-end gap-1.5 ${below3d ? "top-[116px]" : "top-[84px]"}`}>
      <Button variant="outline" size="sm" className="h-7 gap-1 bg-card px-2 text-xs shadow-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Legend<ChevronRight className={`size-3.5 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} aria-hidden />
      </Button>
      {open && (
        <div className="max-h-[calc(100dvh-220px)] w-[340px] max-w-full space-y-2.5 overflow-y-auto rounded-lg border bg-card/95 p-3 shadow-lg backdrop-blur">
          {children}
        </div>
      )}
    </div>
  )
}

const PT_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
/** Each Pacific day's start within the times (as a fractional step) and its label, and where now falls. */
function dayMarks(ms: number[]) {
  const parts = (t: number) => Object.fromEntries(PT_PARTS.formatToParts(t).map((p) => [p.type, p.value]))
  const out: { pos: number; label: string }[] = []
  let prev = ""
  for (let i = 0; i < ms.length; i++) {
    const p = parts(ms[i])
    const day = `${p.weekday} ${p.day}`
    if (day !== prev && i > 0) {
      const midnight = ms[i] - (Number(p.hour) * 60 + Number(p.minute)) * 60e3
      out.push({ pos: posOf(ms, midnight), label: day })
    }
    prev = day
  }
  const now = Date.now()
  return { days: out, now: now >= ms[0] && now <= ms[ms.length - 1] ? posOf(ms, now) : null }
}

/** The timeline: play, a step back and forward, and the slider over a track marked with each day's
 *  start (labelled) and now. */
function TimeBar({ times, clock, playing, setPlaying, className = "border bg-muted/40" }: { times: string[]; clock: Clock; playing: boolean; setPlaying: (p: boolean) => void; className?: string }) {
  React.useSyncExternalStore(clock.subscribe, clock.snapshot)
  const ms = msOf(times)
  const pos = clock.time == null ? 0 : posOf(ms, clock.time)
  const label = times[Math.round(pos)]
  const marks = React.useMemo(() => dayMarks(ms), [ms])
  const last = Math.max(1, times.length - 1)
  const step = (d: number) => { setPlaying(false); clock.set(ms[Math.max(0, Math.min(times.length - 1, Math.round(pos) + d))], false) }
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 pt-2.5 pb-1.5 ${className}`}>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="icon" variant="outline" className="size-8" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play through time"}
                title={playing ? "Pause (space)" : "Play (space)"}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button size="icon" variant="ghost" className="size-8" onClick={() => step(-1)} aria-label="Previous step" title="Previous step (←)"><ChevronLeft className="size-4" /></Button>
        <Button size="icon" variant="ghost" className="size-8" onClick={() => step(1)} aria-label="Next step" title="Next step (→)"><ChevronRight className="size-4" /></Button>
      </div>
      <div className="relative min-w-[200px] flex-1 pb-4 max-sm:order-2 max-sm:min-w-0 max-sm:basis-full">
        {/* each day's start, labelled, and now, under the slider's track */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-[calc(50%+8px)]" aria-hidden>
          {marks.days.map((d) => (
            <span key={d.label} className="absolute" style={{ left: `${(100 * d.pos) / last}%` }}>
              <span className="absolute top-0 h-[14px] w-px -translate-x-1/2 -translate-y-1/2 bg-muted-foreground/45" />
              <span className="absolute top-[11px] -translate-x-0 pl-1 text-[10.5px] whitespace-nowrap text-muted-foreground">{d.label}</span>
            </span>
          ))}
          {marks.now != null && (
            <span className="absolute" style={{ left: `${(100 * marks.now) / last}%` }} title="Now">
              <span className="absolute top-0 h-[16px] w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500/80" />
            </span>
          )}
        </div>
        <Slider className="relative" value={[pos]} min={0} max={times.length - 1} step={1}
                onValueChange={([i]) => { setPlaying(false); clock.set(ms[Math.round(i)], false) }} aria-label="Forecast time"
                getAriaValueText={(i) => (times[Math.round(i)] ? timeLabel(times[Math.round(i)]) : "")} />
      </div>
      <div className="pb-1 text-sm tabular-nums max-sm:order-1 max-sm:flex-1 sm:w-[170px] sm:text-right">{label ? timeLabel(label) : ""}</div>
    </div>
  )
}

// Wind speed has the lightest colours where the wind is calm and the darkest where it's strongest,
// so its particles are a mid ink; other layers get a darker one.
const DARK_INK: [number, number, number, number] = [24, 28, 34, 0.62]
const WIND_INK: [number, number, number, number] = [24, 28, 34, 0.5]

// ------------------------------------------------------------------ the card

export function InteractiveMap({ data, request, active = true, standalone = false }: {
  data: Briefing; request?: (MapRequest & { nonce: number }) | null; active?: boolean
  /** The map page on its own: settings come from and go to the URL, and the map fills the window. */
  standalone?: boolean
}) {
  // a shared link's settings (the map page only)
  const q = React.useMemo(() => new URLSearchParams(standalone ? location.search : ""), [standalone])
  const qs = <T extends string = string>(k: string, d: T): T => (q.get(k) as T | null) ?? d
  const qn = (k: string, d: number) => { const x = q.get(k); return x != null && x !== "" && Number.isFinite(+x) ? +x : d }
  const qb = (k: string, d: boolean) => (q.has(k) ? q.get(k) === "1" : d)
  const qcam = ((): Camera | null => {
    const c = (q.get("c") ?? "").split(",").map(Number)
    return c.length === 5 && c.every(Number.isFinite) ? { lon: c[0], lat: c[1], zoom: c[2], pitch: c[3], bearing: c[4] } : null
  })()
  const sync = useCameraSync(qcam)
  const cogs = data.cogs ?? []
  // full screen: just the map (or the two compared) covers the window, with the timeline over it.
  // Fixed rather than the Fullscreen API, so tooltips, which open on the page's body, still show,
  // and so it works on iPhone; Escape or the button closes it
  const [full, setFull] = React.useState(false)
  // the map page's side panel: open beside the map on wider screens, closed (over the map) on phones
  const [panelOpen, setPanelOpen] = React.useState(() => standalone && typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches)
  React.useEffect(() => {
    if (!full) return
    // the page behind stays put (on the root too, or its scrollbars take a strip of the window)
    const root = document.documentElement, prev = [root.style.overflow, document.body.style.overflow]
    root.style.overflow = document.body.style.overflow = "hidden"
    const key = (e: KeyboardEvent) => {
      // leave Escape to an open menu or popover first
      if (e.key === "Escape" && !document.querySelector("[data-radix-popper-content-wrapper]")) setFull(false)
    }
    window.addEventListener("keydown", key)
    return () => { [root.style.overflow, document.body.style.overflow] = prev; window.removeEventListener("keydown", key) }
  }, [full])
  React.useEffect(() => { if (!active) setFull(false) }, [active])
  const fields = useFields(data)
  const [mode, setMode] = React.useState<"totals" | "hourly">(() => (q.get("m") === "hourly" ? "hourly" : "totals"))
  const [opacity, setOpacity] = React.useState(() => Math.min(1, Math.max(0.2, qn("op", 0.85))))
  const [smooth, setSmooth] = useStoredFlag("pnw-briefing.map.smooth", false, q.has("sm") ? qb("sm", false) : undefined)
  const [particles, setParticles] = useStoredFlag("pnw-briefing.map.particles", true, q.has("pa") ? qb("pa", true) : undefined)
  const [terrain, setTerrain] = useStoredFlag("pnw-briefing.map.terrain", true, q.has("tr") ? qb("tr", true) : undefined)
  const [satKind, setSatKind] = React.useState<SatKind | "off">(() => (q.get("sat") && q.get("sat")! in SAT_KINDS ? q.get("sat") as SatKind : "off"))
  const [showPairs, setShowPairs] = useStoredFlag("pnw-briefing.map.pairs", true, q.has("pr") ? qb("pr", true) : undefined)
  const [showFronts, setShowFronts] = useStoredFlag("pnw-briefing.map.fronts", false, q.has("fr") ? qb("fr", false) : undefined)
  const frontsOn = showFronts && data.fronts?.frames.length ? data.fronts : null
  const [showReports, setShowReports] = useStoredFlag("pnw-briefing.map.nwsReports", false, q.has("rp") ? qb("rp", false) : undefined)
  // storm reports with a position (temperature summaries stay in the Temperature tab's table)
  const live = React.useMemo(() => liveReports(data.obsReports).filter((r) => r.lat != null && r.lon != null && r.kind !== "high" && r.kind !== "low"), [data.obsReports])
  const reportsOn = showReports && live.length ? live : null
  const [showFires, setShowFires] = useStoredFlag("pnw-briefing.map.fires", false, q.has("fi") ? qb("fi", false) : undefined)
  const hasFires = !!(data.wildfire?.incidents?.length || data.wildfire?.perimeters?.features.length)
  const firesOn = showFires && hasFires ? data.wildfire! : null
  const pairList = React.useMemo(() => (data.gradients ?? []).filter((g) => g.locs && g.series.length), [data])
  const [compare, setCompare] = React.useState(() => qb("cmp", false))
  const clock = React.useMemo(() => new Clock(), [])

  // totals state
  const [variable, setVariable] = React.useState<TotVar>(() => qs<TotVar>("v", "precip"))
  const [days, setDays] = React.useState(() => qn("d", 2))
  const [model, setModel] = React.useState<string>(() => qs<string>("mo", MEAN))
  const [other, setOther] = React.useState<string>(() => qs<string>("o", "GFS"))

  // hourly state
  const mrms = useMrms(data, mode === "hourly" && active)
  const mds = useMds(data, !!data.convective && active)
  const satAll = useSatTimes(mode === "hourly" && active)
  const sat = React.useMemo(() => {
    if (!satAll || satKind === "off") return null
    const k = SAT_KINDS[satKind]
    return (satAll[k.layer]?.length || satAll[k.fill]?.length) ? { kind: satKind, times: satAll } : null
  }, [satAll, satKind])
  const byModel = React.useMemo(() => {
    const m = new Map<string, { tier: string; entries: Record<string, FieldEntry> }>()
    for (const e of mrms ? [mrms, ...fields] : fields) {
      if (!m.has(e.model)) m.set(e.model, { tier: e.tier, entries: {} })
      m.get(e.model)!.entries[e.var as FieldVar] = e
    }
    return m
  }, [fields, mrms])
  const [layer, setLayer] = React.useState<HLayer>(() => qs<HLayer>("l", "radar"))
  const [hModel, setHModel] = React.useState<string>(() => qs<string>("hm", "HRRR"))
  const [hOther, setHOther] = React.useState<string>(() => qs<string>("ho", "GFS"))
  const [isobars, setIsobars] = React.useState(() => qb("iso", true))
  const [playing, setPlaying] = React.useState(false)

  // 3D state: a model's pressure-level volume over the map, following the clock
  const [threeD, setThreeD] = React.useState(() => qb("3d", false))
  const [volVar, setVolVar] = React.useState<VolVar | "none">(() => qs<VolVar | "none">("vf", "cloud"))
  const volNone = volVar === "none"
  const [volModel, setVolModel] = React.useState<string | null>(() => q.get("vm"))
  const [exag, setExag] = React.useState(() => Math.min(60, Math.max(5, qn("ex", 25))))
  const [zRange, setZRange] = React.useState<[number, number] | null>(() => {     // null: the full height
    const z = (q.get("zr") ?? "").split(",").map(Number)
    return z.length === 2 && z.every(Number.isFinite) && z[1] > z[0] ? [z[0], z[1]] : null
  })
  const modelVols = useVolumes(threeD)
  // observed 3D radar, over the same box as the models' volumes
  const radar3d = useRadar3d(data, threeD && mode === "hourly" && active && modelVols != null, modelVols?.[0] ?? null)
  const vols = React.useMemo(() => (modelVols ? (radar3d ? [...modelVols, radar3d] : modelVols) : null), [modelVols, radar3d])

  React.useEffect(() => { if (!active) setPlaying(false) }, [active])

  // an "Open on map" link from another tab sets the mode and layer, and can ask for a moment:
  // the layer (or a fallback) from a model that reaches it, preferring the regional models
  const pendingTime = React.useRef<number | null>(q.get("t") && Number.isFinite(Date.parse(q.get("t")!)) ? Date.parse(q.get("t")!) : null)
  const handled = React.useRef<number | null>(null)
  const ready = byModel.size > 0
  React.useEffect(() => {
    if (!request || handled.current === request.nonce) return
    // a request for a moment waits for the field list (the map may have only just mounted)
    if (request.mode === "hourly" && request.time && !ready) return
    handled.current = request.nonce
    if (request.mode) setMode(request.mode)
    if (request.overlays?.fronts != null) setShowFronts(request.overlays.fronts)
    if (request.overlays?.nwsReports != null) setShowReports(request.overlays.nwsReports)
    if (request.overlays?.fires != null) setShowFires(request.overlays.fires)
    if (request.mode === "hourly" && request.time) {
      const t = Date.parse(request.time)
      const covers = (e?: FieldEntry) => !!e?.times.length && Date.parse(e.times[0]) <= t && t <= Date.parse(e.times[e.times.length - 1])
      for (const lid of [request.layer, ...(request.fallback ?? [])].filter(Boolean) as HLayer[]) {
        const L = HLAYERS.find((l) => l.id === lid)
        const ok = L ? [...byModel.entries()].filter(([, v]) => covers(L.primary(v.entries))) : []
        if (!ok.length) continue
        const named = [request.model, hModel].find((m) => ok.some(([n]) => n === m))
        const pick = named ?? (ok.find(([, v]) => v.tier === "regional") ?? ok[0])[0]
        setLayer(lid); setHModel(pick); pendingTime.current = t; setPlaying(false)
        break
      }
    } else if (request.mode === "hourly") {
      if (request.layer) setLayer(request.layer as HLayer)
      if (request.model) setHModel(request.model)
    } else if (request.mode === "totals") {
      if (request.variable) setVariable(request.variable as TotVar)
      if (request.days) setDays(request.days)
      if (request.model) setModel(request.model)
    }
    if (request.isobars != null) setIsobars(request.isobars)
    if (request.pairs != null) setShowPairs(request.pairs)
  }, [request?.nonce, ready])

  // ---- totals
  const varOf = (c: Cog): TotVar => c.var as TotVar
  const allCogs = React.useMemo(() => [...cogs, ...arCogs(data.arCoast), ...riverCogs(data.rivers), ...stormCogs(data.convective)], [cogs, data.arCoast, data.rivers, data.convective])
  const totAvail = TOT_VARS.filter((v) => allCogs.some((c) => varOf(c) === v.id))
  // open on the variable behind the briefing's top hazard, until the reader or a link picks one
  const opened = React.useRef(false)
  React.useEffect(() => {
    if (opened.current || !totAvail.length) return
    opened.current = true
    if (request) return
    const top = summarize(data).filter((x) => x.tone !== "quiet").sort((a, b) => (b.tone === "alert" ? 1 : 0) - (a.tone === "alert" ? 1 : 0))[0]
    const want: TotVar[] = !top ? [] : top.tab === "wind" || top.tab === "coast" ? ["gust"] : top.tab === "snow" ? ["snow"]
      : top.tab === "temp" ? ["tmaxdep", "tmax"] : ["precip"]
    const v = want.find((x) => totAvail.some((t) => t.id === x))
    if (v) setVariable(v)
  }, [totAvail, data, request])
  const windows = [...new Set(allCogs.filter((c) => varOf(c) === variable).map((c) => c.days))].sort((a, b) => a - b)
  const d = windows.includes(days) ? days : windows[0]
  const options = allCogs.filter((c) => varOf(c) === variable && c.days === d)
  const pick = (name: string) => options.find((o) => o.model === name) ?? options.find((o) => o.model === MEAN) ?? options[0]
  // the compare pane never shows the same model as the main one
  const pickOther = (name: string) => {
    const main = pick(model)?.model
    const rest = options.filter((o) => o.model !== main)
    return rest.find((o) => o.model === name) ?? rest.find((o) => o.model === MEAN) ?? rest[0]
  }
  const totDef = TOT_VARS.find((v) => v.id === variable)!
  const totRamp = totDef.ramp
  const winLabel = (n: number) => variable === "storms" ? `Day ${n}` : variable === "obs" || variable === "obspct" ? `past ${n} days`
    : data.windows.find((w) => w.days === n)?.label.toLowerCase() ?? `${n} days`
  const perModel = totDef.perModel

  // ---- hourly
  const layerModels = [...byModel.entries()].filter(([, v]) => HLAYERS.find((l) => l.id === layer)!.primary(v.entries))
    .map(([model, v]) => ({ model, tier: v.tier }))
  const hA = layerModels.find((m) => m.model === hModel)?.model ?? layerModels[0]?.model
  const hB = layerModels.find((m) => m.model === hOther && m.model !== hA)?.model ?? layerModels.find((m) => m.model !== hA)?.model
  const primA = hA ? HLAYERS.find((l) => l.id === layer)!.primary(byModel.get(hA)!.entries) : undefined
  const times = React.useMemo(() => primA?.times ?? [], [primA])
  // accumulated layers count from the briefing start: its model cycle (12Z on the first day for older briefings)
  const accStart = timeLabel(data.meta.cycle ?? `${data.dates[0]}T12:00:00Z`)

  // Keep the clock on one of the main model's steps when the model or layer changes (or on the
  // step nearest a moment an "Open on map" link asked for). Switching to "Hourly" starts at
  // the current hour when the forecast covers it.
  const startNow = React.useRef(true)
  const lastMode = React.useRef(mode)
  if (lastMode.current !== mode) { lastMode.current = mode; if (mode === "hourly") startNow.current = true }
  React.useEffect(() => {
    if (!times.length || clock.playing || mode !== "hourly") return
    const ms = msOf(times)
    const want = pendingTime.current
    if (want != null && want >= ms[0] && want <= ms[ms.length - 1]) pendingTime.current = null
    let target = want ?? clock.time ?? ms[0]
    if (want == null && startNow.current) {
      const now = Date.now()
      if (now >= ms[0] - 1800e3 && now <= ms[ms.length - 1] + 1800e3) target = now
    }
    startNow.current = false
    clock.set(ms[Math.round(posOf(ms, target))], false)
  }, [times, request?.nonce, mode])

  // Keys on the map page and in full screen: ← and → step through time, space plays and pauses
  // (not while typing, or on a control that uses the keys itself)
  React.useEffect(() => {
    if (!(standalone || full) || mode !== "hourly" || !times.length || !active) return
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !["ArrowLeft", "ArrowRight", " "].includes(e.key)) return
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, select, button, [role=slider], [role=combobox], [role=listbox], [role=option], [contenteditable=true]")) return
      // ahead of the map's own keys (a focused map pans with the arrows; shift-arrows still turn it)
      e.preventDefault(); e.stopPropagation()
      if (e.key === " ") { setPlaying((p) => !p); return }
      const ms = msOf(times)
      const i = Math.round(posOf(ms, clock.time ?? ms[0])) + (e.key === "ArrowRight" ? 1 : -1)
      setPlaying(false)
      clock.set(ms[Math.max(0, Math.min(ms.length - 1, i))], false)
    }
    window.addEventListener("keydown", key, true)
    return () => window.removeEventListener("keydown", key, true)
  }, [standalone, full, mode, times, active, clock])

  // Playback moves the clock continuously; the maps blend between forecast steps as it does.
  React.useEffect(() => {
    if (!playing || times.length < 2 || mode !== "hourly") return
    const ms = msOf(times)
    let pos = posOf(ms, clock.time ?? ms[0])
    if (pos >= ms.length - 1) pos = 0
    let last = performance.now(), raf = 0
    const step = (now: number) => {
      // hold while a map is still loading the step it needs, rather than skipping past it
      if (!clock.busy.size) pos += Math.min(0.1, (now - last) / 1000) / SEC_PER_STEP
      last = now
      if (pos > ms.length - 1) pos = 0
      clock.set(timeAt(ms, pos), true)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      clock.set(ms[Math.round(posOf(ms, clock.time ?? ms[0]))], false)   // settle on a real forecast step
    }
  }, [playing, times, mode])

  const viewA = mode === "totals"
    ? variable === "ar" ? (data.arCoast ? arView(data.arCoast, pick(model), winLabel(d)) : null)
    : variable === "rivers" ? (data.rivers ? riverView(data.rivers, pick(model), winLabel(d)) : null)
    : variable === "storms" ? (data.convective ? stormView(data.convective, pick(model), mds) : null)
    : totalsView(pick(model), totRamp, winLabel(d), totDef.digits, totDef.suffix)
    : hA ? hourlyView(hA, byModel.get(hA)!.entries, layer, isobars, showPairs && pairList.length ? pairList : null) : null
  const volOn = threeD && mode === "hourly"
  const volEntry = !volOn || !vols?.length ? undefined
    : vols.find((v) => v.model === volModel) ?? vols.find((v) => v.model === hA) ?? vols.find((v) => v.model === "GFS") ?? vols[0]
  // with no field, the rest still needs a view to hang off (it's never drawn or loaded)
  const volName: VolVar | undefined = volEntry ? (volVar !== "none" && volVarOf(volEntry, volVar) ? volVar : VOL_ORDER.find((v) => volVarOf(volEntry, v))) : undefined
  const volPath = volEntry && volName && !volNone ? volVarOf(volEntry, volName)!.path : null
  const [volData, setVolData] = React.useState<{ path: string; data: Uint8Array } | null>(null)
  const [volError, setVolError] = React.useState(false)
  React.useEffect(() => {
    if (!volEntry || !volName || volNone) return
    let live = true
    setVolError(false)
    loadVolume(volVarOf(volEntry, volName)!).then((d) => { if (live) setVolData({ path: volVarOf(volEntry, volName)!.path, data: d }) })
      .catch(() => { if (live) setVolError(true) })
    return () => { live = false }
  }, [volPath])
  // wind particles at each height (u and v load the first time they're asked for)
  // on by default with the wind speed view, off with the others (until switched)
  const [volWindPick, setVolWindOn] = React.useState<boolean | null>(() => (q.has("vw") ? qb("vw", false) : null))
  const [volPrecip, setVolPrecip] = React.useState(() => qb("vp", true))
  const volWindOn = volWindPick ?? (volVar === "wind" || volVar === "mflux")
  const hasUV = !!(volEntry?.vars.u && volEntry?.vars.v)
  const [volWind, setVolWind] = React.useState<{ model: string; u: Uint8Array; v: Uint8Array } | null>(null)
  // surfaces and colour: a solid at a value (per view), colour by height or another field, shadows
  const [solidPick, setSolidPick] = React.useState<Partial<Record<VolVar, number>>>(() =>
    q.has("sol") && q.get("vf") && Number.isFinite(qn("sol", NaN)) ? { [q.get("vf")!]: qn("sol", NaN) } : {})
  // how it draws (a link from before the render modes with a solid opens as one), its opacity and
  // where it starts showing, the solid's opacity, and the scan through it
  const [renderPick, setRenderPick] = React.useState<RenderMode | null>(() => (q.has("rm") ? qs<RenderMode>("rm", "volume") : q.has("sol") ? "solid" : null))
  const [density, setDensity] = React.useState(() => qn("dn", 1))
  const [showFrom, setShowFrom] = React.useState(() => qn("th", 0))
  const [solidAlpha, setSolidAlpha] = React.useState(() => qn("so", 1))
  const [scanAxis, setScanAxis] = React.useState<ScanAxis | "off">(() => qs<ScanAxis | "off">("sc", "off"))
  const [scanPos, setScanPos] = React.useState(() => qn("scp", 0.5))
  const scanSink = React.useRef<{ set?: (pos: number) => void }>({})
  const [colorPick, setColorPick] = React.useState<"own" | "height" | VolVar>(() => qs<"own" | "height" | VolVar>("col", "own"))
  const [shadowOn, setShadowOn] = React.useState(() => qb("sh", true))
  const [lightPick, setLightPick] = React.useState<"sun" | "fixed">(() => qs<"sun" | "fixed">("lt", "fixed"))
  const [hoverOn, setHoverOn] = React.useState(() => qb("hv", true))
  // a pressure level as a map (contours and arrows), and trajectories
  const [levelHPa, setLevelHPa] = React.useState<number | null>(() => (q.has("lvl") ? qn("lvl", NaN) || null : null))
  const [trajOn, setTrajOn] = React.useState(() => qb("trj", false))
  // the vertical profile: the column over a point (clicked on the map), as a simple sounding
  const [profileOn, setProfileOn] = React.useState(() => qb("pf", false))
  const [profilePt, setProfilePt] = React.useState<LonLat>(() => {
    const c = (q.get("pp") ?? "").split(",").map(Number)
    if (c.length === 2 && c.every(Number.isFinite)) return [c[0], c[1]]
    const p = data.points.find((x) => x.name === "Seattle") ?? data.points[0]
    return [p.lon, p.lat]
  })
  const [presetId, setPresetId] = React.useState<string>("")
  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)
    if (!p) return
    setPresetId(id)
    setVolVar(p.field)
    if (p.solid != null) setSolidPick((s) => ({ ...s, [p.field]: p.solid! }))
    setRenderPick(p.solid != null ? "solid" : null)
    setDensity(1); setShowFrom(0); setSolidAlpha(1); setScanAxis("off")
    setColorPick(p.color ?? "own")
    setLevelHPa(p.level ?? null)
    setVolWindOn(!!p.wind)
    setTrajOn(!!p.traj)
    setTerr3d(!!p.terrain)
    if (p.terrain) setSnowOn(true)
    setExag(p.terrain ? 8 : 25)
    setZRange(p.heights ?? null)
    if (p.precip) setVolPrecip(true)
    setShadowOn(true)
    sync.fly(p.cam)
  }
  const renderOpts: RenderMode[] = !volName || volNone ? []
    : VOLUME_VIEWS.includes(volName) ? ["volume", ...(LIT_VIEWS.includes(volName) ? ["cloud" as const] : []), "max", ...(SOLID_AT[volName] ? ["solid" as const] : []), "points"]
    : SOLID_AT[volName] ? ["volume", "solid"] : []
  const renderMode: RenderMode = renderPick && renderOpts.includes(renderPick) ? renderPick : "volume"
  const isVolume = !!volName && VOLUME_VIEWS.includes(volName)
  const solidAt = renderMode === "solid" && volName ? solidPick[volName] ?? SOLID_AT[volName]![0] : null
  const colorOpts: ("own" | "height" | VolVar)[] = !volEntry || !volName || volNone ? [] : (VOLUME_VIEWS.includes(volName) || solidAt != null)
    ? ["own", "height", ...COLOR_BY.filter((c) => c !== volName && SOURCE[c] !== SOURCE[volName] && volEntry.vars[SOURCE[c]])] : []
  const colorBy = colorOpts.includes(colorPick) ? colorPick : "own"
  const colorView = colorBy !== "own" && colorBy !== "height" ? colorBy : null
  const colorPath = volEntry && colorView ? volVarOf(volEntry, colorView)?.path ?? null : null
  const [colorData, setColorData] = React.useState<{ path: string; data: Uint8Array } | null>(null)
  React.useEffect(() => {
    if (!volEntry || !colorView || !colorPath || colorData?.path === colorPath) return
    let live = true
    loadVolume(volVarOf(volEntry, colorView)!).then((d) => { if (live) setColorData({ path: colorPath, data: d }) }).catch(() => {})
    return () => { live = false }
  }, [colorPath])
  const hgtVar = volEntry?.vars.hgt
  const levelOpts = hgtVar?.hPa ?? []
  const level = levelHPa != null && levelOpts.includes(levelHPa) ? levelHPa : null
  const [hgtData, setHgtData] = React.useState<{ path: string; data: Uint8Array } | null>(null)
  React.useEffect(() => {
    if (!hgtVar || level == null || hgtData?.path === hgtVar.path) return
    let live = true
    loadVolume(hgtVar).then((d) => { if (live) setHgtData({ path: hgtVar.path, data: d }) }).catch(() => {})
    return () => { live = false }
  }, [hgtVar?.path, level])
  const trajShown = trajOn && hasUV
  const wVar = volEntry?.vars.w
  const [wData, setWData] = React.useState<{ path: string; data: Uint8Array } | null>(null)
  React.useEffect(() => {
    if (!wVar || !trajShown || wData?.path === wVar.path) return
    let live = true
    loadVolume(wVar).then((d) => { if (live) setWData({ path: wVar.path, data: d }) }).catch(() => {})
    return () => { live = false }
  }, [wVar?.path, trajShown])
  const needUV = volWindOn || level != null || trajShown || (profileOn && threeD)
  React.useEffect(() => {
    if (!volEntry || !hasUV || !needUV || volWind?.model === volEntry.model) return
    let live = true
    Promise.all([loadVolume(volEntry.vars.u), loadVolume(volEntry.vars.v)])
      .then(([u, v]) => { if (live) setVolWind({ model: volEntry.model, u, v }) }).catch(() => {})
    return () => { live = false }
  }, [volEntry?.model, hasUV, needUV])
  const uv = React.useMemo(() => (volEntry && volWind?.model === volEntry.model ? { u: volWind.u, v: volWind.v } : null), [volWind, volEntry?.model])
  const paneWind = volWindOn ? uv : null
  const levelData = level != null && hgtVar && hgtData?.path === hgtVar.path ? hgtData.data : null
  const paneLevel = React.useMemo(() => (level != null && levelData ? { hPa: level, hgt: levelData } : null), [level, levelData])
  const wNow = wVar && wData?.path === wVar.path ? wData.data : null
  const paneTraj = React.useMemo(() => (trajShown ? { w: wNow } : null), [trajShown, wNow])
  // no field: an empty grid of the model's size stands in, so the box, particles and the rest still draw
  const emptyVol = React.useMemo(() => (volNone && volEntry ? new Uint8Array(volEntry.nx * volEntry.ny * volEntry.nz * volEntry.times.length) : null),
    [volNone, volEntry?.model, volEntry?.run])
  const paneVol: PaneVolume | null = volEntry && volName
    ? { entry: volEntry, name: volName, none: volNone, data: volNone ? emptyVol : volData?.path === volPath ? volData.data : null, exaggeration: exag, wind: paneWind, range: zRange ?? [0, volEntry.topKm], precip: layer === "radar" && volPrecip,
        solid: solidAt, color: colorView && colorData?.path !== colorPath ? "own" : colorBy, colorData: colorView && colorData?.path === colorPath ? colorData.data : null,
        shadow: shadowOn, level: paneLevel, uv, traj: paneTraj, profile: profileOn ? profilePt : null,
        render: renderMode === "solid" ? "volume" : renderMode, density, solidAlpha, from: isVolume ? showFrom : 0,
        scan: scanAxis !== "off" && !volNone ? { axis: scanAxis, pos: scanPos, sink: scanSink } : null, light: lightPick, hover: hoverOn } : null
  // the cross-section: a preset line or one drawn on the map, sliced through the 3D field
  const [xsecOn, setXsecOn] = React.useState(() => qb("xs", false))
  const [xsecLine, setXsecLine] = React.useState<SectionLine>(() => {
    const id = q.get("xl"), c = (q.get("xc") ?? "").split(",").map(Number)
    if (id === "custom" && c.length === 4 && c.every(Number.isFinite))
      return { id: "custom", label: "Your line", a: [c[0], c[1]], b: [c[2], c[3]], aName: "A", bName: "B" }
    return SECTION_PRESETS.find((x) => x.id === id) ?? SECTION_PRESETS[0]
  })
  const [picking, setPicking] = React.useState<LonLat[] | null>(null)
  const xsecSink = React.useRef<{ set?: (img: HTMLCanvasElement) => void }>({})
  const xsecShown = !!(volOn && xsecOn && !volNone && paneVol?.data)
  const needTemp = xsecShown && volEntry && volName && (SOURCE[volName] !== "temp" || isDerived(volName)) && volEntry.vars.temp ? volEntry : null
  const [volTemp, setVolTemp] = React.useState<{ model: string; data: Uint8Array } | null>(null)
  React.useEffect(() => {
    if (!needTemp || volTemp?.model === needTemp.model) return
    let live = true
    loadVolume(needTemp.vars.temp).then((d) => { if (live) setVolTemp({ model: needTemp.model, data: d }) }).catch(() => {})
    return () => { live = false }
  }, [needTemp?.model])
  const sectionTime = React.useCallback(() => {
    const ms = msOf(volEntry?.times ?? [])
    if (!ms.length) return { i0: 0, i1: 0, t: 0 }
    const pos = posOf(ms, clock.time ?? ms[0]), i0 = Math.floor(pos)
    return { i0, i1: Math.min(i0 + 1, ms.length - 1), t: pos - i0 }
  }, [volEntry, clock])
  const sectionSub = React.useCallback((fn: () => void) => clock.subscribe(fn), [clock])
  const onSectionImage = React.useCallback((img: HTMLCanvasElement) => xsecSink.current.set?.(img), [])
  const onPick = (ll: LonLat) => {
    if (!picking?.length) { setPicking([ll]); return }
    setXsecLine({ id: "custom", label: "Your line", a: picking[0], b: ll, aName: "A", bName: "B" })
    setPicking(null)
  }
  // 3D terrain, and the snow level shaded on it (from the temperature and humidity volumes)
  const [terr3d, setTerr3d] = React.useState(() => qb("t3", false))
  const [snowOn, setSnowOn] = React.useState(() => qb("sn", true))
  const terrShown = volOn && terr3d
  const snowEntry = terrShown && snowOn && volEntry?.vars.temp && volEntry?.vars.rh ? volEntry : null
  const [snowData, setSnowData] = React.useState<{ model: string; levels: Float32Array[] } | null>(null)
  React.useEffect(() => {
    if (!snowEntry || snowData?.model === snowEntry.model) return
    let live = true
    Promise.all([loadVolume(snowEntry.vars.temp), loadVolume(snowEntry.vars.rh)])
      .then(([t, h]) => { if (live) setSnowData({ model: snowEntry.model, levels: snowLevels(snowEntry, t, h) }) }).catch(() => {})
    return () => { live = false }
  }, [snowEntry?.model])
  const paneTerrain: PaneTerrain | null = terrShown
    ? { exaggeration: exag, snow: snowEntry && snowData?.model === snowEntry.model ? { entry: snowEntry, levels: snowData.levels } : null } : null
  const showB = compare && !volOn && (mode === "hourly" || perModel)
  const viewB = !showB ? null : mode === "totals"
    ? variable === "ar" ? (data.arCoast ? arView(data.arCoast, pickOther(other), winLabel(d)) : null)
    : totalsView(pickOther(other), totRamp, winLabel(d), totDef.digits, totDef.suffix)
    : hB ? hourlyView(hB, byModel.get(hB)!.entries, layer, isobars, showPairs && pairList.length ? pairList : null) : null

  if (!cogs.length && !fields.length) return null
  const hasHourly = fields.length > 0
  const entriesA = hA ? byModel.get(hA)!.entries : {}
  const hasWind = mode === "hourly" && [hA, showB ? hB : undefined].some((m) => m && flowOf(layer, byModel.get(m)!.entries))
  const showParticles = particles && hasWind && active      // no animation while the Map tab is hidden
  const ink = layer === "wind" ? WIND_INK : DARK_INK

  // ---- the settings as a query string: kept in the map page's URL (so a link opens the same view)
  // and handed to the briefing for its link to the map page
  const shareQuery = React.useRef<() => string>(() => "")
  shareQuery.current = () => {
    const p = new URLSearchParams()
    const put = (k: string, v: string | number | boolean | null | undefined, d?: string | number | boolean | null) => {
      if (v == null || v === d) return
      p.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v))
    }
    put("m", mode, "totals")
    if (mode === "totals") { put("v", variable, "precip"); put("d", days, 2); put("mo", model, MEAN) }
    else {
      put("l", layer, "radar"); put("hm", hModel, "HRRR"); put("iso", isobars, true); put("sat", satKind, "off")
      if (clock.time != null) p.set("t", new Date(clock.time).toISOString().slice(0, 16) + "Z")
    }
    if (compare) { p.set("cmp", "1"); if (mode === "totals") put("o", other); else put("ho", hOther) }
    put("op", Math.round(opacity * 100) / 100, 0.85)
    // switches that are remembered per browser go in either way, so the link opens as it looks here
    put("sm", smooth); put("pa", particles); put("tr", terrain); put("pr", showPairs); put("fr", showFronts); put("rp", showReports); put("fi", showFires)
    if (mode === "hourly" && threeD) {
      p.set("3d", "1"); put("vf", volVar, "cloud"); put("vm", volModel); put("ex", exag, 25)
      if (zRange) p.set("zr", zRange.join(","))
      put("vw", volWindPick); put("vp", volPrecip, true)
      if (solidAt != null) p.set("sol", String(solidAt))
      if (renderMode !== "solid") put("rm", renderMode, "volume")
      put("dn", density, 1); put("th", showFrom, 0); put("so", solidAlpha, 1); put("lt", lightPick, "fixed"); put("hv", hoverOn, true)
      if (scanAxis !== "off") { p.set("sc", scanAxis); p.set("scp", scanPos.toFixed(3)) }
      put("col", colorPick, "own"); put("sh", shadowOn, true); put("lvl", level); put("trj", trajOn, false)
      put("t3", terr3d, false); put("sn", snowOn, true)
      if (profileOn) { p.set("pf", "1"); p.set("pp", profilePt.map((x) => x.toFixed(3)).join(",")) }
      if (xsecOn) {
        p.set("xs", "1"); p.set("xl", xsecLine.id)
        if (xsecLine.id === "custom") p.set("xc", [...xsecLine.a, ...xsecLine.b].map((x) => x.toFixed(3)).join(","))
      }
    }
    const c = sync.camera()
    if (c) p.set("c", [c.lon.toFixed(3), c.lat.toFixed(3), c.zoom.toFixed(2), Math.round(c.pitch), Math.round(c.bearing)].join(","))
    return p.toString().replace(/%2C/g, ",").replace(/%3A/g, ":")
  }
  const shareTimer = React.useRef<number | undefined>(undefined)
  const [shareQ, setShareQ] = React.useState("")
  const scheduleShare = React.useCallback(() => {
    window.clearTimeout(shareTimer.current)
    shareTimer.current = window.setTimeout(() => {
      const query = shareQuery.current()
      if (standalone) { if (location.search.slice(1) !== query) history.replaceState(null, "", `${location.pathname}?${query}${location.hash}`) }
      else setShareQ(query)
    }, 300)
  }, [standalone])
  React.useEffect(() => { scheduleShare() })                     // after any change of settings
  React.useEffect(() => {
    const a = clock.subscribe(() => { if (!clock.playing) scheduleShare() }), b = sync.onMove(scheduleShare)
    return () => { a(); b(); window.clearTimeout(shareTimer.current) }
  }, [clock, sync, scheduleShare])

  // a click on the map moves the profile, inside the model's box
  const pickProfile = React.useCallback((ll: LonLat) => {
    const e = volEntry
    if (e && ll[0] >= e.lon[0] && ll[0] <= e.lon[1] && ll[1] >= e.lat[0] && ll[1] <= e.lat[1]) setProfilePt(ll)
  }, [volEntry])
  // ---- the vertical profile: its data (temperature, humidity, cloud and the wind) and chart
  const profOpen = !!(volOn && profileOn && volEntry)
  const pTemp = useVolData(volEntry, "temp", profOpen), pRh = useVolData(volEntry, "rh", profOpen), pCloud = useVolData(volEntry, "cloud", profOpen)
  const profPlace = React.useMemo(() => {
    const near = data.points.map((p) => ({ p, d: Math.hypot((p.lon - profilePt[0]) * Math.cos((p.lat * Math.PI) / 180), p.lat - profilePt[1]) * 69 }))
      .sort((a, b) => a.d - b.d)[0]
    const ll = `${Math.abs(profilePt[1]).toFixed(2)}°N ${Math.abs(profilePt[0]).toFixed(2)}°W`
    return near && near.d < 12 ? (near.d < 2 ? near.p.name : `near ${near.p.name}`) : ll
  }, [data.points, profilePt])
  const profChart = profOpen && (pTemp
    ? <>
        <p className="text-xs text-muted-foreground">{profPlace} · {volEntry!.model}. Click the map to move it.</p>
        <Profile entry={volEntry!} point={profilePt} place={profPlace} temp={pTemp} rh={pRh} cloud={pCloud} wind={uv} time={sectionTime} subscribe={sectionSub} />
      </>
    : <p className="text-xs text-muted-foreground">Loading the 3D data…</p>)

  // ---- the cross-section's controls and chart: under the map, or on the map page and in full screen
  // a panel floating in the map's corner
  const xsecOpen = !!(volOn && xsecOn && !volNone && volEntry && volName)
  const xsecFloat = xsecOpen && (standalone || full)
  const xsecControls = xsecOpen && (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Select value={xsecLine.id} onValueChange={(id) => { const p = SECTION_PRESETS.find((x) => x.id === id); if (p) { setXsecLine(p); setPicking(null) } }}>
        <SelectTrigger className={xsecFloat ? "h-8 min-w-0 flex-1 text-[13px]" : "w-full sm:w-[330px]"} aria-label="Cross-section line"><SelectValue /></SelectTrigger>
        <SelectContent>
          {SECTION_PRESETS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
          {xsecLine.id === "custom" && <SelectItem value="custom">Your line</SelectItem>}
        </SelectContent>
      </Select>
      {picking
        ? <><span className="text-sm">{picking.length ? "Now click the line's other end on the map." : "Click one end of the line on the map."}</span>
            <Button variant="ghost" size="sm" onClick={() => setPicking(null)}>Cancel</Button></>
        : <Button variant="outline" size="sm" className={xsecFloat ? "h-8" : ""} onClick={() => setPicking([])}>Draw a line</Button>}
    </div>
  )
  const xsecChart = xsecOpen && (
    <>
      {xsecShown && paneVol?.data ? (
        <CrossSection data={data} entry={volEntry!} name={volName!} values={paneVol.data}
          temp={SOURCE[volName!] === "temp" && !isDerived(volName!) ? paneVol.data : volTemp?.model === volEntry!.model ? volTemp.data : null}
          line={xsecLine} time={sectionTime} subscribe={sectionSub} onImage={onSectionImage} />
      ) : <p className="text-xs text-muted-foreground">Loading the 3D data…</p>}
      <p className="text-xs text-muted-foreground">Heavy blue: freezing level. Brown: terrain. Hover for values.</p>
    </>
  )

  // the legends, under the map and (compact) over it in full screen
  const legends = (
    <>
      {frontsOn && <FrontLegend />}
      {reportsOn && <ReportLegend reports={reportsOn} hours={data.obsReports?.reportHours ?? 48} />}
      {firesOn && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full ring-1 ring-white" style={{ background: "#e8590c" }} aria-hidden />Wildfire</span>
          <span className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full ring-1 ring-white" style={{ background: "#8a6d3b" }} aria-hidden />Prescribed fire</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-[2px] border border-[#b3261e] bg-[#b3261e]/25" aria-hidden />Perimeter</span>
          <span>Dots sized by acres.</span>
        </div>
      )}
      {mode === "totals" ? (variable === "ar" ? <ArLegend /> : variable === "rivers" ? <RiverLegend /> : variable === "storms" ? <StormLegend day={d} /> : <RampLegend ramp={totRamp} every={totRamp.ticks ? 1 : totRamp.levels.length > 16 ? 2 : 1} />) : (
        <div className="space-y-2">
          {volOn && vols && !vols.length && <p className="text-xs text-muted-foreground">No 3D data in this briefing.</p>}
          {volOn && volError && <p className="text-xs text-muted-foreground">The 3D data could not be loaded.</p>}
          {paneVol && !paneVol.none && <VolumeLegend vol={paneVol} />}
          {layer === "radar" && <RadarLegend withRefc={!!entriesA.refc} />}
          {layer === "apcp" && <RampLegend ramp={APCP} note={`Running total since ${accStart}.`} />}
          {layer === "asnow" && <RampLegend ramp={ASNOW} note={`Running total since ${accStart}.`} />}
          {layer === "rh" && <RampLegend ramp={RH} note="Under about 25% with wind, fires spread fastest." />}
          {layer === "smoke" && <RampLegend ramp={SMOKE} note="Above about 35 µg/m³ is unhealthy for sensitive groups." />}
          {layer === "t2m" && <RampLegend ramp={TEMP} note="Dashed blue line: 32°F." />}
          {layer === "gust" && <RampLegend ramp={GUST} />}
          {layer === "wind" && <RampLegend ramp={WIND} />}
          {layer === "frz" && <RampLegend ramp={FRZ} every={2} />}
          {layer === "pgrad" && <RampLegend ramp={PGRAD} note="1 – 2 is typical; 3 and up is windstorm-class." />}
          {layer === "ivt" && <RampLegend ramp={IVT} note="250 and up is atmospheric-river strength." />}
        </div>
      )}
    </>
  )


  // ---- the pieces: the briefing's card stacks them; the map page puts the controls in a side panel
  // and everything else over a map that fills the window
  const controlsRow = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
      {hasHourly && (
        <Tabs value={mode} onValueChange={(v) => { setMode(v as "totals" | "hourly"); setPlaying(false) }} className="max-sm:w-full">
          <TabsList className="max-sm:w-full">
            <TabsTrigger value="totals">Summary</TabsTrigger>
            <TabsTrigger value="hourly">Hourly</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {mode === "totals" ? (
        <>
          <Select value={variable} onValueChange={(v) => setVariable(v as TotVar)}>
            <SelectTrigger className="w-full sm:w-[190px]" aria-label="Variable"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["Totals", "Extremes", "Vs normal", "Odds", "Observed", "Outlooks"] as const).map((g) => [g, totAvail.filter((v) => v.group === g)] as const).filter(([, vs]) => vs.length).map(([g, vs]) => (
                <SelectGroup key={g}>
                  <SelectLabel>{GROUP_LABEL[g]}</SelectLabel>
                  {vs.map((v) => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Tabs value={String(d)} onValueChange={(v) => setDays(Number(v))} className="max-sm:w-full">
            <TabsList className="max-sm:w-full">{windows.map((w) => <TabsTrigger key={w} value={String(w)}>{winLabel(w).replace("next ", "").replace("past ", "")}</TabsTrigger>)}</TabsList>
          </Tabs>
          {perModel && (
            <div data-wide className="flex items-center gap-x-5 max-sm:w-full">
              <ModelSelect options={options} value={pick(model)?.model ?? ""} onChange={setModel} label="Model" />
              <Toggle id="compare-t" label="Compare" checked={compare} onChange={setCompare} />
            </div>
          )}
          {perModel && compare && <div className="flex max-sm:w-full"><ModelSelect options={options.filter((o) => o.model !== pick(model)?.model)} value={pickOther(other)?.model ?? ""} onChange={setOther} label="Compare with" /></div>}
        </>
      ) : (
        <>
          <Select value={layer} onValueChange={(v) => setLayer(v as HLayer)}>
            <SelectTrigger className="w-full sm:w-[230px]" aria-label="Layer"><SelectValue /></SelectTrigger>
            <SelectContent>
              {H_GROUPS.map((g) => [g, HLAYERS.filter((l) => l.group === g && [...byModel.values()].some((v) => l.primary(v.entries)))] as const)
                .filter(([, ls]) => ls.length).map(([g, ls]) => (
                  <SelectGroup key={g}>
                    <SelectLabel>{g}</SelectLabel>
                    {ls.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
                  </SelectGroup>
                ))}
            </SelectContent>
          </Select>
          <div data-wide className="flex items-center gap-x-5 max-sm:w-full">
            {hA && <ModelSelect options={layerModels} value={hA} onChange={(m) => {
              setHModel(m)
              // observed radar pairs best with a high-resolution forecast
              if (m === MRMS_MODEL && !layerModels.some((x) => x.model === hOther && x.tier === "regional")) {
                const r = layerModels.find((x) => x.tier === "regional")
                if (r) setHOther(r.model)
              }
            }} label="Model" />}
            {!threeD && <Toggle id="compare-h" label="Compare" checked={compare} onChange={setCompare} />}
            <Toggle id="three-d" label="3D" checked={threeD} onChange={(v) => { setThreeD(v); if (v) setCompare(false) }} />
          </div>
          {compare && !threeD && hB && <div className="flex max-sm:w-full"><ModelSelect options={layerModels.filter((m) => m.model !== hA)} value={hB} onChange={setHOther} label="Compare with" /></div>}
        </>
      )}
      <div data-wide className="max-sm:w-full sm:ml-auto">
        <MapOptions
          overlays={[
            !!data.fronts?.frames.length && <OptionRow key="fronts" id="fronts" label="Fronts (WPC)" checked={showFronts} onChange={setShowFronts} />,
            hasFires && <OptionRow key="fires" id="fires" label="Fires and perimeters" checked={showFires} onChange={setShowFires} />,
            live.length > 0 && <OptionRow key="reports" id="nws-reports" label={`NWS reports, last ${data.obsReports?.reportHours ?? 48} h`} checked={showReports} onChange={setShowReports} />,
          ...(mode === "hourly" ? [
            entriesA.mslp && <OptionRow key="iso" id="isobars" label="Isobars" checked={isobars} onChange={setIsobars} />,
            pairList.length > 0 && <OptionRow key="pairs" id="pairs" label="Gradient pairs" checked={showPairs} onChange={setShowPairs} />,
            hasWind && <OptionRow key="part" id="particles" label={layer === "ivt" ? "Moisture particles" : "Wind particles"} checked={particles} onChange={setParticles} />,
            satAll && (
              <div key="sat" className="flex items-center justify-between gap-4 py-1">
                <Label className="font-normal">Satellite</Label>
                <Select value={satKind} onValueChange={(v) => setSatKind(v as SatKind | "off")}>
                  <SelectTrigger size="sm" className="w-[130px]" aria-label="Satellite imagery"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    {(Object.keys(SAT_KINDS) as SatKind[]).map((k) => <SelectItem key={k} value={k}>{SAT_KINDS[k].label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ),
          ] : [])].filter(Boolean)}
          active={(frontsOn ? 1 : 0) + (reportsOn ? 1 : 0) + (firesOn ? 1 : 0) + (mode === "hourly" ? [entriesA.mslp && isobars, pairList.length > 0 && showPairs, hasWind && particles, satAll && satKind !== "off"].filter(Boolean).length : 0)}
          display={<>
            <OptionRow id="terrain" label="Terrain" checked={terrain} onChange={setTerrain} />
            <OptionRow id="smooth" label="Smooth" checked={smooth} onChange={setSmooth} />
            <div className="flex items-center justify-between gap-4 py-1.5">
              <Label className="font-normal">Opacity</Label>
              <Slider className="w-[130px]" value={[opacity]} min={0.2} max={1} step={0.05} onValueChange={([v]) => setOpacity(v)} aria-label="Grid opacity" />
            </div>
          </>}
        />
      </div>
    </div>
  )
  // the 3D view's controls in groups: what to show, how to draw it, the box, what else goes in it,
  // and the tools; each row a label on the left and its control filling the rest, switches on the right
  const vv = volEntry && volName ? volVarOf(volEntry, volName) : undefined
  const threeDPanel = mode === "hourly" && threeD && volEntry && volName && (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">3D view</div>
      {/* one column with rules between the groups in the side panel; side by side in the card */}
      <div className={`grid gap-x-8 gap-y-3 ${standalone ? "[&>section+section]:border-t [&>section+section]:pt-3" : "gap-y-5 md:grid-cols-2 xl:grid-cols-3"}`}>
        <Group title="Show">
          <Row label="Preset" help={PRESETS.find((p) => p.id === presetId)?.note ?? "A ready-made 3D view: a field, its options and a camera angle that shows it well. Change anything afterwards."}>
            <Select value={presetId} onValueChange={applyPreset}>
              <SelectTrigger className="h-8 w-full min-w-0" aria-label="3D preset"><SelectValue placeholder="Choose a view…" /></SelectTrigger>
              <SelectContent>{PRESETS.filter((p) => volVarOf(volEntry, p.field)).map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
            </Select>
          </Row>
          <Row label="Field">
            <Select value={volNone ? "none" : volName} onValueChange={(v) => { setVolVar(v as VolVar | "none"); setPresetId("") }}>
              <SelectTrigger className="h-8 w-full min-w-0" aria-label="3D field"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {VOL_ORDER.filter((v) => volVarOf(volEntry, v)).map((v) => <SelectItem key={v} value={v}>{volLabel(volEntry, v)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
          {vols!.length > 1 && (
            <Row label="Model">
              <Select value={volEntry.model} onValueChange={setVolModel}>
                <SelectTrigger className="h-8 w-full min-w-0" aria-label="3D model"><SelectValue /></SelectTrigger>
                <SelectContent>{vols!.map((v) => <SelectItem key={v.model} value={v.model}>{v.run === "observed" ? `${v.model} (observed)` : v.model}</SelectItem>)}</SelectContent>
              </Select>
            </Row>
          )}
        </Group>
        {!volNone && (renderOpts.length > 0 || colorOpts.length > 0 || LIT_VIEWS.includes(volName)) && (
          <Group title="Draw it">
            {renderOpts.length > 1 && (
              <Row label="Render" help={isVolume ? RENDER_HELP : "Surfaces where the field crosses its key values, or one opaque, lit surface at a value you choose (the jet stream at 100 kt, say). The solid's shadow falls on the map."}>
                <Select value={renderMode} onValueChange={(x) => {
                  setRenderPick(x as RenderMode)
                  // the stratosphere above the tropopause is all over 2 PVU: cap the box below it so
                  // the lobes folding down show, as they hang (the heights slider can lift it)
                  if (volName === "pv" && x === "solid" && zRange == null) setZRange([0, 9])
                }}>
                  <SelectTrigger className="h-8 w-full min-w-0" aria-label="Render mode"><SelectValue /></SelectTrigger>
                  <SelectContent>{renderOpts.map((m) => <SelectItem key={m} value={m}>{m === "volume" && !isVolume ? "Surfaces" : RENDER_LABEL[m]}</SelectItem>)}</SelectContent>
                </Select>
              </Row>
            )}
            {solidAt != null && (
              <>
                <Row label="At">
                  <Select value={String(solidAt)} onValueChange={(x) => setSolidPick((p) => ({ ...p, [volName]: Number(x) }))}>
                    <SelectTrigger className="h-8 w-full min-w-0" aria-label="Solid surface at"><SelectValue /></SelectTrigger>
                    <SelectContent>{[...SOLID_AT[volName]!].sort((a, b) => a - b).map((x) => <SelectItem key={x} value={String(x)}>{solidLabel(volName, x, vv!.units)}</SelectItem>)}</SelectContent>
                  </Select>
                </Row>
                <Row label="Opacity" value={`${Math.round(solidAlpha * 100)}%`}>
                  <Slider className="w-full" value={[solidAlpha]} min={0.2} max={1} step={0.05} onValueChange={([x]) => setSolidAlpha(x)} aria-label="Solid opacity" />
                </Row>
              </>
            )}
            {isVolume && solidAt == null && (
              <>
                <Row label={renderMode === "points" ? "Density" : "Opacity"} value={`×${density}`}>
                  <Slider className="w-full" value={[density]} min={0.25} max={3} step={0.25} onValueChange={([x]) => setDensity(x)} aria-label={renderMode === "points" ? "Point density" : "Volume opacity"} />
                </Row>
                <Row label="Show from" help="Hide everything below this value, to pick out the thickest cloud or the strongest lift."
                  value={showFrom === 0 ? "All" : fmtVal(unpack(showFrom, vv!), vv!.units)}>
                  <Slider className="w-full" value={[showFrom]} min={0} max={240} step={4} onValueChange={([x]) => setShowFrom(x)} aria-label="Show from" />
                </Row>
              </>
            )}
            {colorOpts.length > 0 && (
              <Row label="Colour" help="Colour the volume (or the solid) by its height, or by another field: humidity coloured by wind speed shows where the moist air is moving fastest.">
                <Select value={colorBy} onValueChange={(x) => setColorPick(x as typeof colorPick)}>
                  <SelectTrigger className="h-8 w-full min-w-0" aria-label="Colour by"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {colorOpts.map((c) => <SelectItem key={c} value={c}>{c === "own" ? "Its own colours" : c === "height" ? "By height" : `By ${volLabel(volEntry, c).toLowerCase()}`}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Row>
            )}
            {(solidAt != null || (LIT_VIEWS.includes(volName) && (renderMode === "volume" || renderMode === "cloud"))) && (
              <>
                <Row label="Light" help="A fixed light from the south-west, or the sun where it is over the region at the map's time (low and warm near sunrise and sunset, a dim, cool light at night).">
                  <Select value={lightPick} onValueChange={(x) => setLightPick(x as "sun" | "fixed")}>
                    <SelectTrigger className="h-8 w-full min-w-0" aria-label="Light"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed, from the south-west</SelectItem>
                      <SelectItem value="sun">Sun at the map time</SelectItem>
                    </SelectContent>
                  </Select>
                </Row>
                <SwitchRow id="vol-shadow" label="Shadows" checked={shadowOn} onChange={setShadowOn} />
              </>
            )}
          </Group>
        )}
        <Group title="The box">
          <Row label="Stretch" help="How much heights are stretched, so the atmosphere's 12 km show against a region hundreds of miles across. With 3D terrain on, the mountains stretch by the same amount."
            value={`×${exag}`}>
            <Slider className="w-full" value={[exag]} min={5} max={60} step={5} onValueChange={([v]) => setExag(v)} aria-label="Vertical stretch" />
          </Row>
          <Row label="Heights" help="Draw only the slab of the atmosphere between these heights (km above sea level), to see inside it or pick out one layer."
            value={(() => { const [lo, hi] = zRange ?? [0, volEntry.topKm]; return lo === 0 && hi === volEntry.topKm ? "All" : `${lo}–${hi} km` })()}>
            <Slider className="w-full" value={zRange ?? [0, volEntry.topKm]} min={0} max={volEntry.topKm} step={0.5} minStepsBetweenThumbs={1}
              onValueChange={(v) => setZRange(v[0] === 0 && v[1] === volEntry.topKm ? null : [v[0], v[1]])}
              getAriaValueText={(v) => `${v} km`} aria-label="Heights shown" />
          </Row>
          <SwitchRow id="vol-terrain" label="3D terrain" checked={terr3d} onChange={(v) => { setTerr3d(v); if (v && exag > 10) setExag(8) }} />
          {terr3d && <SwitchRow id="vol-snow" label="Snow level" indent checked={snowOn} onChange={setSnowOn}
            help="Shade the terrain white above the model's snow level, about 1,000 ft below the wet-bulb freezing level." />}
        </Group>
        <Group title="Add">
          {hasUV && <SwitchRow id="vol-wind" label="Wind particles" checked={volWindOn} onChange={setVolWindOn}
            help="Particles moving with the wind at 850, 700, 500, 300 and 250 mb, coloured by speed (or by moisture flow in that view)." />}
          {layer === "radar" && <SwitchRow id="vol-precip" label="Falling precip" checked={volPrecip} onChange={setVolPrecip} />}
          {hasUV && <SwitchRow id="vol-traj" label="Trajectories" checked={trajOn} onChange={setTrajOn}
            help="Where the air arriving over each forecast location at about 1.5 and 3 km came from over the previous 24 hours (or since the model's first step), coloured by height: lines climbing toward a location show air being lifted." />}
          {levelOpts.length > 0 && (
            <Row label="Level map" help="A pressure level drawn inside the box at its average height: its height contours (labelled in decametres; lows and troughs where they dip) and wind arrows.">
              <Select value={level == null ? "off" : String(level)} onValueChange={(x) => setLevelHPa(x === "off" ? null : Number(x))}>
                <SelectTrigger className="h-8 w-full min-w-0" aria-label="Level map"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  {[...levelOpts].sort((a, b) => b - a).map((h) => <SelectItem key={h} value={String(h)}>{h} mb</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
          )}
        </Group>
        <Group title="Tools">
          {!volNone && (
            <Row label="Scan" help="A slice through the field at one height, or from west to east or south to north, with the rest faded. Slide it through the box, or play to sweep it.">
              <Select value={scanAxis} onValueChange={(x) => setScanAxis(x as ScanAxis | "off")}>
                <SelectTrigger className="h-8 w-full min-w-0" aria-label="Scan"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="z">By height</SelectItem>
                  <SelectItem value="x">West to east</SelectItem>
                  <SelectItem value="y">South to north</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          )}
          {!volNone && <SwitchRow id="vol-hover" label="Readout on hover" checked={hoverOn} onChange={setHoverOn} />}
          {!volNone && scanAxis !== "off" && <ScanSlider key={scanAxis} axis={scanAxis} entry={volEntry} pos={scanPos} onCommit={setScanPos} sink={scanSink} />}
          {!volNone && <SwitchRow id="vol-xsec" label="Cross-section" checked={xsecOn} onChange={(v) => { setXsecOn(v); if (!v) setPicking(null) }}
            help="Slice the 3D field along a line, shown as a chart and as a curtain in 3D. Pick a preset line or draw your own." />}
          <SwitchRow id="vol-profile" label="Profile" checked={profileOn} onChange={setProfileOn}
            help="The column of air over one point, like a simple sounding: temperature and dewpoint by height, cloud and wind. Click the map to move it." />
        </Group>
      </div>
    </div>
  )
  const aboutView = (
    <AboutView
      groups={[
        { title: "3D view", items: mode === "totals" || !paneVol ? [] : volumeNotes({ entry: paneVol.entry, name: paneVol.name, exaggeration: exag, particles: !!paneVol.wind, precip: paneVol.precip, terrain: !!paneTerrain, snow: !!paneTerrain?.snow, vol: paneVol }) },
        { title: "Cross-section", items: [
          mode !== "totals" && volOn && xsecOn && volEntry && { label: "What it shows", text: <>The 3D field along the line from the ground to {volEntry.topKm} km, at the map's time, with contours. It also stands in the 3D view as a curtain.</> },
          mode !== "totals" && volOn && xsecOn && { label: "Lines", text: <>Heavy blue is the freezing level (32°F); brown is the terrain along the line, smoother in the model than in reality.</> },
        ] },
        { title: "Map layer", items: mode === "totals" ? [] : [
          volOn && vols && !vols.length && { label: "No 3D data", text: <>This briefing was built before the 3D view, or the models' pressure levels couldn't be read.</> },
          layer === "radar" && smooth && (entriesA.refc && entriesA.ptype
            ? { label: "Smoothing", text: <>Reflectivity is smoothed; precipitation type keeps each model cell's category.</> }
            : !entriesA.refc ? { label: "Smoothing", text: <>Precipitation type is a category, so it isn't smoothed.</> } : null),
          layer === "apcp" && { label: "Accumulated precipitation", text: <>Since {accStart}, the start of the briefing.</> },
          layer === "asnow" && { label: "Accumulated snowfall", text: <>Since {accStart}. NCEP models report their own snowfall; ECMWF's is water equivalent at 10:1.</> },
          layer === "rh" && { label: "Relative humidity", text: <>At 2 m; ECMWF's from its dewpoint.</> },
          layer === "smoke" && { label: "Smoke", text: <>HRRR and RRFS near-surface smoke (8 m). 55 µg/m³ and up is unhealthy for everyone.</> },
          layer === "wind" && { label: "Wind", text: showParticles ? <>Particles trace the 10 m wind; faster particles mean stronger wind.</> : <>Arrows point the way the wind is blowing; longer arrows are stronger winds.</> },
          layer === "frz" && { label: "Freezing level", text: <>Snow usually reaches the ground about 1,000 ft below it.</> },
          layer === "pgrad" && { label: "Pressure gradient", text: <>How fast sea-level pressure changes with distance, from the smoothed field; gap flows (Gorge, Fraser, Strait) pack tighter. Mountain cells (mean height above 600 m, or peaks above 1,400 m) are blank: sea-level pressure there is an extrapolation, and its gradient would mostly trace the terrain.</> },
          layer === "ivt" && { label: "Water vapour transport", text: <>Vertically integrated (GFS and ECMWF AIFS), the measure behind the atmospheric-river scale{showParticles ? "; particles follow the moisture flow" : ""}.</> },
        ] },
        { title: "Overlays", items: [
          mode !== "totals" && showPairs && pairList.length > 0 && { label: "Station pairs", text: <>Lines join each gradient pair, labelled with this model's pressure difference (hPa, first station minus second). Arrowheads point from high to low pressure, the way the gap flow blows; amber and red mark the pair's first and second thresholds, as on the pressure gradient card.</> },
          mode !== "totals" && showParticles && layer !== "wind" && layer !== "ivt" && { label: "Wind particles", text: <>They trace the 10 m wind.</> },
          mode !== "totals" && isobars && entriesA.mslp && { label: "Isobars", text: <>Sea-level pressure every 2 hPa; heavier, labelled lines every 4 hPa. H and L mark pressure centres.</> },
          frontsOn && { label: "Fronts", text: <>The Weather Prediction Center's surface analyses every 3 hours for the last day, then its forecast chart once a day for days 1 – 3, so they move in steps rather than with each model hour. Symbols point the way the front is moving.</> },
          reportsOn && { label: "Storm reports", text: <>NWS storm reports and report summaries from the last {data.obsReports?.reportHours ?? 48} hours; gusts in mph, amounts in inches.</> },
          firesOn && { label: "Fires", text: <>Current wildfire and prescribed-fire incidents and perimeters, from the Wildfire tab's sources.</> },
        ] },
      ]}
      downloads={!(mode === "totals" && (variable === "ar" || variable === "rivers" || variable === "storms")) && (
        <p>
          GeoTIFF:{" "}
          {mode === "totals"
            ? options.slice(0, 12).map((c, i) => (
                <React.Fragment key={c.path}>{i > 0 && ", "}<a className="underline underline-offset-2 hover:text-foreground" href={cogUrl(c)} download>{c.model}</a></React.Fragment>
              ))
            : Object.values(entriesA).filter((e) => !e.path.startsWith("mrms:")).map((e, i) => (
                <React.Fragment key={e.path}>{i > 0 && ", "}<a className="underline underline-offset-2 hover:text-foreground" href={fieldUrl(e)} download>{hA} {e.var}</a></React.Fragment>
              ))}
          {mode === "hourly" && " (one band per forecast time)"}.
        </p>
      )}
    />

  )
  const timeBarOver = mode === "hourly" && times.length > 0 && (
    <div className="pointer-events-none absolute inset-x-3 bottom-[calc(3rem+env(safe-area-inset-bottom))] z-10 flex justify-center sm:bottom-10">
      <TimeBar times={times} clock={clock} playing={playing} setPlaying={setPlaying}
        className="pointer-events-auto w-full max-w-3xl border bg-card/95 shadow-lg backdrop-blur" />
    </div>
  )
  const floating = full || standalone                // the overlays: over the map rather than around it
  const mapArea = (
    <div className={full ? `fixed inset-0 z-50 m-0! grid bg-background ${showB ? "grid-rows-2 gap-px lg:grid-cols-2 lg:grid-rows-1" : ""}` : standalone ? `relative grid h-full ${showB ? "grid-rows-2 gap-px lg:grid-cols-2 lg:grid-rows-1" : ""}` : `relative grid gap-3 ${showB ? "lg:grid-cols-2" : ""}`}
      role={full ? "dialog" : undefined} aria-modal={full || undefined} aria-label={full ? "Map, full screen" : undefined}>
      <MapPane data={data} view={viewA} clock={clock} opacity={opacity} smooth={smooth} particles={showParticles} particleColor={ink} sync={sync} terrain={terrain} sat={sat} fronts={frontsOn} reports={reportsOn} fires={firesOn} vol={paneVol}
        xsec={volOn && xsecOn ? { line: xsecLine, picked: picking, sink: xsecSink } : null} onPick={volOn && xsecOn && picking ? onPick : volOn && profileOn ? pickProfile : null} terrain3d={paneTerrain} tall={full || standalone} insetTitle={standalone && !panelOpen && !full} />
      {showB && <MapPane data={data} view={viewB} clock={clock} opacity={opacity} smooth={smooth} particles={showParticles} particleColor={ink} sync={sync} terrain={terrain} sat={sat} fronts={frontsOn} reports={reportsOn} fires={firesOn} tall={full || standalone} />}
      {/* left of the zoom buttons, so it doesn't cover them */}
      <Button variant="outline" size="icon" onClick={() => setFull((f) => !f)} aria-pressed={full}
        aria-label={full ? "Exit full screen" : "Full screen map"} title={full ? "Exit full screen (Esc)" : "Full screen"}
        className="absolute top-[10px] right-12 z-10 size-[29px] bg-card shadow-sm">
        {full ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
      </Button>
      {floating && <MapKey below3d={volOn}>{legends}</MapKey>}
      {xsecFloat && (
        <FloatPanel title="Cross-section" onClose={() => { setXsecOn(false); setPicking(null) }} picking={!!picking}
          className={mode === "hourly" ? "bottom-[calc(7.5rem+env(safe-area-inset-bottom))] sm:bottom-28" : "bottom-3 max-sm:bottom-2"}>
          {xsecControls}
          {xsecChart}
        </FloatPanel>
      )}
      {floating && profOpen && (
        <FloatPanel title="Profile" side="right" onClose={() => setProfileOn(false)}
          className={`${mode === "hourly" ? "bottom-[calc(7.5rem+env(safe-area-inset-bottom))] sm:bottom-28" : "bottom-3"} ${xsecFloat ? "max-sm:bottom-[calc(10.5rem+env(safe-area-inset-bottom))]" : ""}`}>
          {profChart}
        </FloatPanel>
      )}
      {floating && timeBarOver}
    </div>
  )

  if (standalone) return (
    <div className="relative flex h-full min-h-0">
      {/* the controls: a side panel beside the map, or over it on a phone */}
      {panelOpen && (
        <aside aria-label="Map controls"
          className="z-30 flex w-[360px] shrink-0 flex-col border-r bg-card max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:w-[min(360px,88%)] max-md:shadow-xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-[13px] font-semibold">Map controls</span>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => setPanelOpen(false)} aria-label="Hide the controls"><PanelLeftClose className="size-4" aria-hidden /></Button>
          </div>
          {/* in the panel the controls stack full width, as on a phone */}
          <div className={"min-h-0 flex-1 space-y-4 overflow-y-auto p-3 [&_[data-control]]:w-full [&_[data-control]>span]:min-w-[112px] [&_[data-slot=select-trigger]]:min-w-0 "
            + "[&_[data-slot=select-trigger]]:w-full [&_[data-slot=select-trigger]]:flex-1 [&_[data-control]_[data-slot=slider]]:w-auto [&_[data-control]_[data-slot=slider]]:flex-1 "
            + "[&_[data-wide]]:w-full [&_[data-wide]>button]:w-full [&_[data-slot=tabs]]:w-full [&_[data-slot=tabs-list]]:w-full"}>
            {controlsRow}
            {threeDPanel}
            {aboutView}
          </div>
        </aside>
      )}
      <div className="relative min-w-0 flex-1">
        {mapArea}
        {!panelOpen && (
          <Button variant="outline" size="sm" onClick={() => setPanelOpen(true)} className="absolute top-2 left-2 z-20 h-8 bg-card shadow-sm">
            <PanelLeftOpen aria-hidden />Controls
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Explore the grids</CardTitle>
        <CardDescription info={<>{mode === "totals"
            ? "Totals, extremes, ensemble odds and observed rainfall for each window, from each model's own grid. Model spread and percent of normal use the multi-model mean; ensemble odds pool GEFS and ECMWF ENS members."
            : "Forecast maps through time. HRRR, RRFS and NAM step hourly for the first 48 hours (RRFS every 3 hours after that); NBM and the global models every 6 hours. Playback blends smoothly between forecast steps. MRMS radar (under Observed) is NOAA's multi-radar composite reflectivity, loaded live: hourly since the briefing's start and every 10 minutes for the last 3 hours, so you can compare it with the forecast radar for the same times."}
          {" "}Drawn from the same GeoTIFFs this briefing publishes.</>}>
          {mode === "totals" ? "Totals and extremes for each window." : "The forecast hour by hour."} Hover for values; drag and zoom to look closer.
        </CardDescription>
        <CardAction>
          {/* the map on its own page, opening with these settings (and keeping them in its address) */}
          <Button variant="outline" size="sm" asChild>
            <a href={`map.html${shareQ ? `?${shareQ}` : ""}`} target="_blank" rel="noopener">
              <ExternalLink aria-hidden />Open map page
            </a>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {controlsRow}


        {threeDPanel}

        {mode === "hourly" && times.length > 0 && <TimeBar times={times} clock={clock} playing={playing} setPlaying={setPlaying} />}

        {mapArea}

        {xsecOpen && !xsecFloat && (
          <div className="space-y-2">
            {xsecControls}
            {xsecChart}
          </div>
        )}
        {profOpen && !floating && (
          <div className="max-w-xl space-y-1.5">
            <div className="text-sm font-medium">Profile</div>
            {profChart}
          </div>
        )}

        {legends}

        {aboutView}
      </CardContent>
    </Card>
  )
}
