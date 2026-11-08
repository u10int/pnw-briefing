import * as React from "react"
import * as maplibregl from "maplibre-gl"
import type { GeoJSONSource, MapMouseEvent, StyleSpecification } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
// MapLibre runs a web worker for vector/GeoJSON work; have Vite bundle it and tell MapLibre where it is.
import { Pause, Play, SlidersHorizontal } from "lucide-react"
import { Popover } from "radix-ui"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { bicubicAt, contourLines, fieldUrl, gridPos, loadField, nearestAt, nearestTime, type Elevation, elevationFor, pressureCenters, pressureGradient, windArrows, windFrom } from "@/lib/fields"
import { GRAD_COLORS, gradLevel, pairName, seriesAt } from "@/lib/gradients"
import type { MapRequest } from "@/lib/maplink"
import { GridLayer, type GridDraw } from "@/lib/gl/grid-layer"
import { ParticleLayer, type WindDraw } from "@/lib/gl/particle-layer"
import { type Grid, sameGrid } from "@/lib/gl/util"
import { AR_COLORS, AR_LABELS, FLOOD_COLORS, FLOOD_LABELS, FRZ, GUST, IVT, legendBins, PCT, PGRAD, PRECIP, PROB, PTYPE_COLORS, PTYPE_NAMES, type Ramp, REFC, RH, SMOKE, SNOW, SPREAD, TDEP, TEMP, WIND } from "@/lib/ramps"
import { contrastTextColor } from "@/lib/contrast"
import type { ArCoast, Briefing, Cog, Convective, ExtremeVar, FrontFrame, Fronts, ObsReport, RiverGauge, Rivers, FieldEntry, FieldsManifest, FieldVar, Gradient } from "@/types"
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
function useCameraSync() {
  const maps = React.useRef(new Set<maplibregl.Map>())
  const busy = React.useRef(false)
  return React.useMemo(() => ({
    add(m: maplibregl.Map) {
      maps.current.add(m)
      m.on("move", () => {
        if (busy.current) return
        busy.current = true
        for (const o of maps.current) if (o !== m) o.jumpTo({ center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() })
        busy.current = false
      })
      for (const o of maps.current) if (o !== m) { m.jumpTo({ center: o.getCenter(), zoom: o.getZoom() }); break }
    },
    remove(m: maplibregl.Map) { maps.current.delete(m) },
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
interface Choice<T> { key: string; t: number; load: () => Promise<T> }

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

function MapPane({ data, view, clock, opacity, smooth, particles, particleColor, sync, terrain, sat, fronts, reports }: {
  data: Briefing; view: View | null; clock: Clock; opacity: number; smooth: boolean
  particles: boolean; particleColor: [number, number, number, number]; sync: ReturnType<typeof useCameraSync>
  terrain: boolean; sat: { kind: SatKind; times: SatTimes } | null; fronts: Fronts | null; reports: ObsReport[] | null
}) {
  const el = React.useRef<HTMLDivElement>(null)
  const ready = React.useRef<Promise<maplibregl.Map> | null>(null)
  const layers = React.useRef<{ grid: GridLayer; particles: ParticleLayer } | null>(null)
  if (!layers.current) layers.current = { grid: new GridLayer("grid"), particles: new ParticleLayer("particles") }
  const loaded = React.useRef<{ v: Loaded | null; t: number }>({ v: null, t: 0 })
  const overlays = React.useRef<Overlays | null>(null)
  const smoothRef = React.useRef(smooth)
  smoothRef.current = smooth
  const viewRef = React.useRef(view)
  viewRef.current = view
  const terrainRef = React.useRef(terrain)
  terrainRef.current = terrain
  const [hover, setHover] = React.useState<{ x: number; y: number; text: string | null; place: string | null } | null>(null)
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
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxZoom: 11,
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
      resolve(m)
    }))
    sync.add(m)

    m.on("mousemove", (e: MapMouseEvent) => {
      const near = m.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ["points"] })
      const { v, t } = loaded.current
      const parts = [v?.sample(e.lngLat.lng, e.lngLat.lat, t, smoothRef.current), overlays.current?.sample?.(e.lngLat.lng, e.lngLat.lat, smoothRef.current)]
      m.getCanvas().style.cursor = near.length ? "pointer" : ""
      setHover({ x: e.point.x, y: e.point.y, text: parts.filter(Boolean).join(", ") || null, place: near.length ? String(near[0].properties?.name) : null })
    })
    m.on("mouseout", () => setHover(null))
    // a forecast location opens its detail panel
    m.on("click", (e: MapMouseEvent) => {
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
        setStatus(v?.draw || v?.bare ? { kind: "ready" } : { kind: "empty", note: v?.note })
      },
      (t) => { loaded.current.t = t; grid.setT(t) },
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
    const windCh = new Channel<WindDraw>((w, t) => pl.setWind(w, t), (t) => pl.setT(t), undefined, (on) => clock.hold(windCh, on))
    const update = () => {
      const v = viewRef.current!
      const interp = clock.playing
      setSub(v.sub(clock.time))
      gridCh.push(v.grid(clock.time, interp))
      ovCh.push(v.overlays?.(clock.time) ?? null)
      windCh.push(particles ? v.wind?.(clock.time, interp) ?? null : null)
      if (interp && clock.time != null) v.prefetch?.(clock.time)
    }
    update()
    const unsub = clock.subscribe(update)
    return () => { unsub(); clearTimeout(slow); gridCh.cancel(); ovCh.cancel(); windCh.cancel() }
  }, [view?.key, particles])

  React.useEffect(() => { layers.current!.grid.setOpacity(opacity) }, [opacity])
  React.useEffect(() => { layers.current!.grid.setSmooth(smooth) }, [smooth])
  React.useEffect(() => {
    layers.current!.particles.setEnabled(particles)
    // arrows and particles both show the wind; particles replace the arrows when on
    ready.current?.then((m) => m.setLayoutProperty("arrows", "visibility", particles ? "none" : "visible"))
  }, [particles])
  React.useEffect(() => { layers.current!.particles.setColor(particleColor) }, [particleColor.join()])
  React.useEffect(() => {
    ready.current?.then((m) => m.getLayer("hillshade") && m.setLayoutProperty("hillshade", "visibility", terrain ? "visible" : "none"))
  }, [terrain])

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
    <div className="relative overflow-hidden rounded-lg border">
      <div ref={el} className="h-[520px] w-full max-sm:h-[420px]" role="region" aria-label={`Map: ${view?.title ?? ""}`} />
      <div className="pointer-events-none absolute top-2 left-2 max-w-[70%] rounded-md bg-card/95 px-2.5 py-1.5 text-xs shadow-sm ring-1 ring-border">
        <div className="font-medium">{view?.title}</div>
        {sub && <div className="text-muted-foreground">{sub}</div>}
        {satLabel && <div className="text-muted-foreground">{satLabel}</div>}
        {frontLabel && <div className="text-muted-foreground">{frontLabel}</div>}
      </div>
      {status.kind !== "ready" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
          {status.kind === "loading" ? "Loading grid…" : status.kind === "error" ? "This grid could not be loaded." : (status.note ?? "Nothing to show for this choice.")}
        </div>
      )}
      {hover && (hover.text || hover.place) && (
        <div className="pointer-events-none absolute z-10 rounded-md bg-popover px-2 py-1 text-xs shadow-md ring-1 ring-border"
             style={{ left: Math.min(hover.x + 14, (el.current?.clientWidth ?? 0) - 170), top: hover.y + 14 }}>
          {hover.place && <div className="font-medium">{hover.place} <span className="font-normal opacity-60">· click for details</span></div>}
          <div className="tabular-nums">{hover.text ?? "No data"}</div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ legends

const NWS_REPORT_COLORS: Record<ObsReport["kind"], string> = { gust: "#2a6fdb", damage: "#1b1f24", rain: "#1e9e4a", snow: "#7b4fc9", ice: "#d147a3", flood: "#0b7a75" }
const NWS_REPORT_NAMES: Record<ObsReport["kind"], string> = { gust: "Wind gust", damage: "Wind damage", rain: "Rain", snow: "Snow", ice: "Ice", flood: "Flooding" }

function reportGeoJSON(rs: ObsReport[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: rs.map((r) => ({
      type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [r.lon, r.lat] },
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
      <span>NWS storm reports and report summaries from the last {hours} hours; gusts in mph, amounts in inches. Zoom in for values.</span>
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
      <p className="text-xs text-muted-foreground">Fronts from the Weather Prediction Center: its surface analyses every 3 hours for the last day, then its forecast chart once a day for days 1 – 3, so they move in steps rather than with each model hour. Symbols point the way the front is moving.</p>
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
          if (layer === "radar" && prim.var === "refc") {
            const pa = await bandNear(entries.ptype, isoA), pb = B ? await bandNear(entries.ptype, isoB) : null
            const aux = pa && sameGrid(pa.f, f) ? pa.data : null
            const auxB = aux && pb && sameGrid(pb.f, f) ? pb.data : aux
            draw = { grid: f, a: A, b: B, auxA: aux, auxB, paint: { kind: "refc" } }
            describe = (lon, lat, t, smooth) => {
              const v = blendAt(f, A, B, t, lon, lat, smooth)
              if (!(v >= 5)) return "No precipitation"
              const code = aux ? categoryAt(f, aux, auxB, t, lon, lat) : NaN
              const tn = PTYPE_NAMES[code] as string | undefined
              return `${tn && tn !== "none" ? cap(tn) + ", " : ""}${Math.round(v)} dBZ`
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
            draw = { grid: f, a: A, b: B, paint: { kind: "ptype" } }
            describe = (lon, lat, t) => {
              const tn = PTYPE_NAMES[categoryAt(f, A, B, t, lon, lat)] ?? "none"
              return tn === "none" ? "No precipitation" : cap(tn)
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
      return {
        key: `${i}`, t: 0,
        load: () => cachedOverlay(`${model}|${layer}|${i}|${iso ? 1 : 0}|${pairs ? 1 : 0}`, async () => {
          const out: Overlays = {}
          if (pairs) out.pairs = pairOverlay(pairs, model, Date.parse(valid))
          if (layer === "t2m") {
            const f = await loadField(prim)
            out.freezing = contourLines(f, await f.band(i), [32], 1)
          }
          if (layer === "wind") {
            const f = await loadField(prim)
            const v = await bandNear(entries.v10, valid)
            if (v) out.arrows = windArrows(f, await f.band(i), v.data)
          }
          if (iso) {
            const p = await bandNear(entries.mslp, valid, 1.6)
            if (p) {
              out.isobars = contourLines(p.f, p.data, ISOBARS, p.f.width > 120 ? 4 : 1)   // extra smoothing on 3 km grids, where sea-level reduction over terrain is noisy
              out.centers = pressureCenters(p.f, p.data)
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
      // decode the next few steps ahead of playback
      const i = Math.floor(posOf(msOf(prim.times), time))
      for (const e of [prim, entries.ptype, entries.v10, entries.u10, entries.ivtv]) {
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

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id}>{label}</Label>
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
function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = React.useState(() => {
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
function TimeBar({ times, clock, playing, setPlaying }: { times: string[]; clock: Clock; playing: boolean; setPlaying: (p: boolean) => void }) {
  React.useSyncExternalStore(clock.subscribe, clock.snapshot)
  const ms = msOf(times)
  const pos = clock.time == null ? 0 : posOf(ms, clock.time)
  const label = times[Math.round(pos)]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/40 px-3 py-2.5">
      <Button size="icon" variant="outline" className="size-8 shrink-0" onClick={() => setPlaying(!playing)}
              aria-label={playing ? "Pause" : "Play through time"}>
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>
      <Slider className="min-w-[200px] flex-1 max-sm:order-2 max-sm:min-w-0 max-sm:basis-full" value={[pos]} min={0} max={times.length - 1} step={1}
              onValueChange={([i]) => { setPlaying(false); clock.set(ms[Math.round(i)], false) }} aria-label="Forecast time"
              getAriaValueText={(i) => (times[Math.round(i)] ? timeLabel(times[Math.round(i)]) : "")} />
      <div className="text-sm tabular-nums max-sm:order-1 max-sm:flex-1 sm:w-[190px] sm:text-right">{label ? timeLabel(label) : ""}</div>
    </div>
  )
}

// Wind speed has the lightest colours where the wind is calm and the darkest where it's strongest,
// so its particles are a mid ink; other layers get a darker one.
const DARK_INK: [number, number, number, number] = [24, 28, 34, 0.62]
const WIND_INK: [number, number, number, number] = [24, 28, 34, 0.5]

// ------------------------------------------------------------------ the card

export function InteractiveMap({ data, request, active = true }: { data: Briefing; request?: (MapRequest & { nonce: number }) | null; active?: boolean }) {
  const sync = useCameraSync()
  const cogs = data.cogs ?? []
  const fields = useFields(data)
  const [mode, setMode] = React.useState<"totals" | "hourly">("totals")
  const [opacity, setOpacity] = React.useState(0.85)
  const [smooth, setSmooth] = useStoredFlag("pnw-briefing.map.smooth", false)
  const [particles, setParticles] = useStoredFlag("pnw-briefing.map.particles", true)
  const [terrain, setTerrain] = useStoredFlag("pnw-briefing.map.terrain", true)
  const [satKind, setSatKind] = React.useState<SatKind | "off">("off")
  const [showPairs, setShowPairs] = useStoredFlag("pnw-briefing.map.pairs", true)
  const [showFronts, setShowFronts] = useStoredFlag("pnw-briefing.map.fronts", false)
  const frontsOn = showFronts && data.fronts?.frames.length ? data.fronts : null
  const [showReports, setShowReports] = useStoredFlag("pnw-briefing.map.nwsReports", false)
  const live = React.useMemo(() => liveReports(data.obsReports), [data.obsReports])
  const reportsOn = showReports && live.length ? live : null
  const pairList = React.useMemo(() => (data.gradients ?? []).filter((g) => g.locs && g.series.length), [data])
  const [compare, setCompare] = React.useState(false)
  const clock = React.useMemo(() => new Clock(), [])

  // totals state
  const [variable, setVariable] = React.useState<TotVar>("precip")
  const [days, setDays] = React.useState(2)
  const [model, setModel] = React.useState(MEAN)
  const [other, setOther] = React.useState("GFS")

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
  const [layer, setLayer] = React.useState<HLayer>("radar")
  const [hModel, setHModel] = React.useState("HRRR")
  const [hOther, setHOther] = React.useState("GFS")
  const [isobars, setIsobars] = React.useState(true)
  const [playing, setPlaying] = React.useState(false)

  React.useEffect(() => { if (!active) setPlaying(false) }, [active])

  // an "Open on map" link from another tab sets the mode and layer, and can ask for a moment:
  // the layer (or a fallback) from a model that reaches it, preferring the regional models
  const pendingTime = React.useRef<number | null>(null)
  const handled = React.useRef<number | null>(null)
  const ready = byModel.size > 0
  React.useEffect(() => {
    if (!request || handled.current === request.nonce) return
    // a request for a moment waits for the field list (the map may have only just mounted)
    if (request.mode === "hourly" && request.time && !ready) return
    handled.current = request.nonce
    setMode(request.mode)
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
    } else {
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
  // step nearest a moment an "Open on map" link asked for). Switching to "Through time" starts at
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
  const showB = compare && (mode === "hourly" || perModel)
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Explore the grids</CardTitle>
        <CardDescription>
          {mode === "totals"
            ? "Totals, extremes, ensemble odds and observed rainfall for each window, from each model's own grid. Model spread and percent of normal use the multi-model mean; ensemble odds pool GEFS and ECMWF ENS members."
            : "Forecast maps through time. HRRR, RRFS and NAM step hourly for the first 48 hours (RRFS every 3 hours after that); NBM and the global models every 6 hours. Playback blends smoothly between forecast steps. MRMS radar (under Observed) is NOAA's multi-radar composite reflectivity, loaded live: hourly since the briefing's start and every 10 minutes for the last 3 hours, so you can compare it with the forecast radar for the same times."}
          {" "}Hover for values; drag and zoom to look closer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {hasHourly && (
            <Tabs value={mode} onValueChange={(v) => { setMode(v as "totals" | "hourly"); setPlaying(false) }} className="max-sm:w-full">
              <TabsList className="max-sm:w-full">
                <TabsTrigger value="totals">Summary</TabsTrigger>
                <TabsTrigger value="hourly">Through time</TabsTrigger>
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
                <div className="flex items-center gap-x-5 max-sm:w-full">
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
              <div className="flex items-center gap-x-5 max-sm:w-full">
                {hA && <ModelSelect options={layerModels} value={hA} onChange={(m) => {
                  setHModel(m)
                  // observed radar pairs best with a high-resolution forecast
                  if (m === MRMS_MODEL && !layerModels.some((x) => x.model === hOther && x.tier === "regional")) {
                    const r = layerModels.find((x) => x.tier === "regional")
                    if (r) setHOther(r.model)
                  }
                }} label="Model" />}
                <Toggle id="compare-h" label="Compare" checked={compare} onChange={setCompare} />
              </div>
              {compare && hB && <div className="flex max-sm:w-full"><ModelSelect options={layerModels.filter((m) => m.model !== hA)} value={hB} onChange={setHOther} label="Compare with" /></div>}
            </>
          )}
          <div className="max-sm:w-full sm:ml-auto">
            <MapOptions
              overlays={[
                !!data.fronts?.frames.length && <OptionRow key="fronts" id="fronts" label="Fronts (WPC)" checked={showFronts} onChange={setShowFronts} />,
                live.length > 0 && <OptionRow key="reports" id="nws-reports" label={`NWS reports, last ${data.obsReports?.reportHours ?? 24} h`} checked={showReports} onChange={setShowReports} />,
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
              active={(frontsOn ? 1 : 0) + (reportsOn ? 1 : 0) + (mode === "hourly" ? [entriesA.mslp && isobars, pairList.length > 0 && showPairs, hasWind && particles, satAll && satKind !== "off"].filter(Boolean).length : 0)}
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

        {mode === "hourly" && times.length > 0 && <TimeBar times={times} clock={clock} playing={playing} setPlaying={setPlaying} />}

        <div className={`grid gap-3 ${showB ? "lg:grid-cols-2" : ""}`}>
          <MapPane data={data} view={viewA} clock={clock} opacity={opacity} smooth={smooth} particles={showParticles} particleColor={ink} sync={sync} terrain={terrain} sat={sat} fronts={frontsOn} reports={reportsOn} />
          {showB && <MapPane data={data} view={viewB} clock={clock} opacity={opacity} smooth={smooth} particles={showParticles} particleColor={ink} sync={sync} terrain={terrain} sat={sat} fronts={frontsOn} reports={reportsOn} />}
        </div>

        {frontsOn && <FrontLegend />}
        {reportsOn && <ReportLegend reports={reportsOn} hours={data.obsReports?.reportHours ?? 24} />}
        {mode === "totals" ? (variable === "ar" ? <ArLegend /> : variable === "rivers" ? <RiverLegend /> : variable === "storms" ? <StormLegend day={d} /> : <RampLegend ramp={totRamp} every={totRamp.ticks ? 1 : totRamp.levels.length > 16 ? 2 : 1} />) : (
          <div className="space-y-2">
            {layer === "radar" && <RadarLegend withRefc={!!entriesA.refc} />}
            {smooth && layer === "radar" && !entriesA.refc && <p className="text-xs text-muted-foreground">Precipitation type is a category, so it isn't smoothed.</p>}
            {smooth && layer === "radar" && entriesA.refc && entriesA.ptype && <p className="text-xs text-muted-foreground">Reflectivity is smoothed; precipitation type keeps each model cell's category.</p>}
            {layer === "apcp" && <RampLegend ramp={APCP} note={`Running total since ${accStart}, the start of the briefing.`} />}
            {layer === "asnow" && <RampLegend ramp={ASNOW} note={`Running total since ${accStart}. NCEP models report their own snowfall; ECMWF snowfall is water equivalent at 10:1.`} />}
            {layer === "rh" && <RampLegend ramp={RH} note="2 m relative humidity; ECMWF from its dewpoint. Under about 25% with wind is when fires spread fastest." />}
            {layer === "smoke" && <RampLegend ramp={SMOKE} note="HRRR and RRFS near-surface smoke (8 m). Above about 35 µg/m³ is unhealthy for sensitive groups, 55 and up unhealthy." />}
            {layer === "t2m" && <RampLegend ramp={TEMP} note="The dashed blue line marks 32°F." />}
            {layer === "gust" && <RampLegend ramp={GUST} />}
            {layer === "wind" && <RampLegend ramp={WIND} note={showParticles ? "Particles trace the 10 m wind; faster particles mean stronger wind." : "Arrows point the way the wind is blowing; longer arrows are stronger winds."} />}
            {layer === "frz" && <RampLegend ramp={FRZ} every={2} note="Snow usually reaches the ground about 1,000 ft below the freezing level." />}
            {layer === "pgrad" && <RampLegend ramp={PGRAD} note="How fast sea-level pressure changes with distance, from the smoothed field: 1 – 2 is a typical synoptic gradient, 3 and up is windstorm-class, and gap flows (Gorge, Fraser, Strait) pack tighter. Mountain cells (mean height above 600 m, or peaks above 1,400 m) are left blank: sea-level pressure there is an extrapolation, and its gradient would mostly trace the terrain." />}
            {showPairs && pairList.length > 0 && <p className="text-xs text-muted-foreground">Lines join each gradient station pair, labelled with this model's pressure difference (hPa, first station minus second); arrowheads point from high to low pressure, the way the gap flow blows; amber and red mark the pair's first and second thresholds, as on the pressure gradient card.</p>}
            {layer === "ivt" && <RampLegend ramp={IVT} note={`Vertically integrated water vapor transport (GFS and ECMWF AIFS), the measure behind the atmospheric-river scale: 250 and up is AR conditions${showParticles ? "; particles follow the moisture flow" : ""}.`} />}
            {showParticles && layer !== "wind" && layer !== "ivt" && <p className="text-xs text-muted-foreground">Moving particles trace the 10 m wind.</p>}
            {isobars && entriesA.mslp && <p className="text-xs text-muted-foreground">Gray lines are sea-level pressure every 2 hPa; heavier, labelled lines every 4 hPa. H and L mark pressure centres.</p>}
          </div>
        )}

        {!(mode === "totals" && (variable === "ar" || variable === "rivers" || variable === "storms")) && <p className="text-xs text-muted-foreground">
          Download as GeoTIFF:{" "}
          {mode === "totals"
            ? options.slice(0, 12).map((c, i) => (
                <React.Fragment key={c.path}>{i > 0 && ", "}<a className="underline underline-offset-2 hover:text-foreground" href={cogUrl(c)} download>{c.model}</a></React.Fragment>
              ))
            : Object.values(entriesA).filter((e) => !e.path.startsWith("mrms:")).map((e, i) => (
                <React.Fragment key={e.path}>{i > 0 && ", "}<a className="underline underline-offset-2 hover:text-foreground" href={fieldUrl(e)} download>{hA} {e.var}</a></React.Fragment>
              ))}
          {mode === "hourly" && " (one band per forecast time)"}.
        </p>}
      </CardContent>
    </Card>
  )
}
