import * as React from "react"
import * as maplibregl from "maplibre-gl"
import type { GeoJSONSource, MapMouseEvent, StyleSpecification } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
// MapLibre runs a web worker for vector/GeoJSON work; have Vite bundle it and tell MapLibre where it is.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { Pause, Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { loadCog } from "@/lib/cog"
import { bicubicAt, contourLines, fieldUrl, gridPos, loadField, nearestAt, nearestTime, windArrows, windFrom } from "@/lib/fields"
import { GridLayer, type GridDraw } from "@/lib/gl/grid-layer"
import { ParticleLayer, type WindDraw } from "@/lib/gl/particle-layer"
import { type Grid, sameGrid } from "@/lib/gl/util"
import { FRZ, GUST, PCT, PRECIP, PTYPE_COLORS, PTYPE_NAMES, type Ramp, REFC, SNOW, SPREAD, TEMP, WIND } from "@/lib/ramps"
import type { Briefing, Cog, ExtremeVar, FieldEntry, FieldsManifest, FieldVar } from "@/types"

// ------------------------------------------------------------------ map plumbing

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] }

// CARTO's Positron vector basemap. The weather layers go under its first label layer, so place
// names stay readable on top. Vector styles load without a key today; set the CARTO_KEY repository
// variable to send one (CARTO's raster tiles already require it).
const CARTO_KEY = (import.meta.env.VITE_CARTO_KEY as string | undefined) || ""
const STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
const withKey = (url: string) =>
  CARTO_KEY && url.includes("cartocdn.com") && !/[?&]key=/.test(url)
    ? { url: `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(CARTO_KEY)}` }
    : undefined
// If the basemap can't load (offline, blocked), the data still shows on a plain background.
const FALLBACK: StyleSpecification = {
  version: 8, sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef0f3" } }],
}

// A standalone (single-file) copy carries the worker inline; turn it into a blob URL. The bundled
// worker is a classic script, and MapLibre runs URLs ending in ".cjs" as classic workers, which is
// what lets it start from a file:// page. The fragment changes nothing about what is fetched.
const inlineWorker = (window as unknown as { __MAPLIBRE_WORKER__?: string }).__MAPLIBRE_WORKER__
maplibregl.setWorkerUrl(inlineWorker
  ? URL.createObjectURL(new Blob([Uint8Array.from(atob(inlineWorker), (c) => c.charCodeAt(0))], { type: "text/javascript" })) + "#worker.cjs"
  : workerUrl)

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
  private subs = new Set<() => void>()
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
  sample: (lon: number, lat: number, t: number, smooth: boolean) => string | null
}
interface Overlays { isobars?: FC | null; freezing?: FC | null; arrows?: FC | null; sample?: (lon: number, lat: number, smooth: boolean) => string | null }
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
  constructor(private apply: (v: T | null, t: number) => void, private setT: (t: number) => void, private fail?: () => void) {}
  push(c: Choice<T> | null) {
    if (!c) {
      if (this.key !== "") { this.seq++; this.key = ""; this.pending = null; this.apply(null, 0) }
      return
    }
    this.t = c.t
    if (c.key === this.key) {
      if (this.pending) { this.seq++; this.pending = null }
      this.setT(c.t)
      return
    }
    if (c.key === this.pending) return
    const s = ++this.seq
    this.pending = c.key
    c.load().then(
      (v) => { if (s === this.seq) { this.key = c.key; this.pending = null; this.apply(v, this.t) } },
      () => { if (s === this.seq) { this.key = c.key; this.pending = null; this.fail?.() } },
    )
  }
  cancel() { this.seq++; this.pending = null }
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

type Status = { kind: "loading" | "ready" | "error" | "empty"; note?: string }

function MapPane({ data, view, clock, opacity, smooth, particles, particleColor, sync }: {
  data: Briefing; view: View | null; clock: Clock; opacity: number; smooth: boolean
  particles: boolean; particleColor: [number, number, number, number]; sync: ReturnType<typeof useCameraSync>
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
  const [hover, setHover] = React.useState<{ x: number; y: number; text: string | null; place: string | null } | null>(null)
  const [status, setStatus] = React.useState<Status>({ kind: "loading" })
  const [sub, setSub] = React.useState<string | undefined>()

  React.useEffect(() => {
    // open on the whole grid crop, not just the comparison regions, so the surroundings show too
    const d = data.domain
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
      m.addLayer(grid, labels)
      m.addSource("isobars", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "isobars", type: "line", source: "isobars", paint: { "line-color": "#3a3f47", "line-width": ["case", ["==", ["%", ["get", "value"], 8], 0], 1.4, 0.8], "line-opacity": 0.75 } }, labels)
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
      resolve(m)
    }))
    sync.add(m)

    m.on("mousemove", (e: MapMouseEvent) => {
      const near = m.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ["points"] })
      const { v, t } = loaded.current
      const parts = [v?.sample(e.lngLat.lng, e.lngLat.lat, t, smoothRef.current), overlays.current?.sample?.(e.lngLat.lng, e.lngLat.lat, smoothRef.current)]
      setHover({ x: e.point.x, y: e.point.y, text: parts.filter(Boolean).join(", ") || null, place: near.length ? String(near[0].properties?.name) : null })
    })
    m.on("mouseout", () => setHover(null))
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
        setStatus(v?.draw ? { kind: "ready" } : { kind: "empty", note: v?.note })
      },
      (t) => { loaded.current.t = t; grid.setT(t) },
      () => { first = false; setStatus({ kind: "error" }) },
    )
    const ovCh = new Channel<Overlays>(
      (o) => {
        overlays.current = o
        ready.current?.then((m) => {
          ;(m.getSource("isobars") as GeoJSONSource).setData(o?.isobars ?? EMPTY)
          ;(m.getSource("freezing") as GeoJSONSource).setData(o?.freezing ?? EMPTY)
          ;(m.getSource("arrows") as GeoJSONSource).setData(o?.arrows ?? EMPTY)
        })
      },
      () => {},
    )
    const windCh = new Channel<WindDraw>((w, t) => pl.setWind(w, t), (t) => pl.setT(t))
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

  return (
    <div className="relative overflow-hidden rounded-lg border">
      <div ref={el} className="h-[520px] w-full max-sm:h-[420px]" role="region" aria-label={`Map: ${view?.title ?? ""}`} />
      <div className="pointer-events-none absolute top-2 left-2 max-w-[70%] rounded-md bg-card/95 px-2.5 py-1.5 text-xs shadow-sm ring-1 ring-border">
        <div className="font-medium">{view?.title}</div>
        {sub && <div className="text-muted-foreground">{sub}</div>}
      </div>
      {status.kind !== "ready" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
          {status.kind === "loading" ? "Loading grid…" : status.kind === "error" ? "This grid could not be loaded." : (status.note ?? "Nothing to show for this choice.")}
        </div>
      )}
      {hover && (hover.text || hover.place) && (
        <div className="pointer-events-none absolute z-10 rounded-md bg-popover px-2 py-1 text-xs shadow-md ring-1 ring-border"
             style={{ left: Math.min(hover.x + 14, (el.current?.clientWidth ?? 0) - 170), top: hover.y + 14 }}>
          {hover.place && <div className="font-medium">{hover.place}</div>}
          <div className="tabular-nums">{hover.text ?? "No data"}</div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ legends

function RampLegend({ ramp, every = 1, note }: { ramp: Ramp; every?: number; note?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">{ramp.label} ({ramp.units})</div>
      <div className="flex">
        {ramp.colors.map((c, i) => (
          <div key={i} className="min-w-0 flex-1">
            <div className="h-2.5" style={{ background: c, borderRadius: i === 0 ? "3px 0 0 3px" : i === ramp.colors.length - 1 ? "0 3px 3px 0" : 0 }} />
            <div className="pt-1 text-[10.5px] tabular-nums text-muted-foreground">{i % every === 0 ? ramp.levels[i].toLocaleString("en-US") : ""}</div>
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
          <div className="flex h-2.5 overflow-hidden rounded-[3px]">{r.colors.map((c, i) => <div key={i} className="flex-1" style={{ background: c }} />)}</div>
        </div>
      ))}
      <div className="grid grid-cols-[96px_1fr] gap-2">
        <span />
        <div className="flex text-[10.5px] tabular-nums text-muted-foreground">{REFC.rain.levels.map((l, i) => <div key={i} className="flex-1">{i % 2 === 0 ? l : ""}</div>)}</div>
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

type TotVar = "precip" | "snow" | "spread" | "pct" | ExtremeVar
/** Window products: precipitation totals, and extremes over the window. `digits` for hover values. */
const TOT_VARS: { id: TotVar; label: string; group: "Totals" | "Extremes"; ramp: Ramp; perModel: boolean; digits: number }[] = [
  { id: "precip", label: "Precipitation", group: "Totals", ramp: PRECIP, perModel: true, digits: 2 },
  { id: "snow", label: "Snowfall", group: "Totals", ramp: SNOW, perModel: true, digits: 1 },
  { id: "spread", label: "Model spread", group: "Totals", ramp: SPREAD, perModel: false, digits: 2 },
  { id: "pct", label: "% of normal", group: "Totals", ramp: PCT, perModel: false, digits: 0 },
  { id: "tmax", label: "Highest temperature", group: "Extremes", ramp: { ...TEMP, label: "Highest temperature at 2 m" }, perModel: true, digits: 0 },
  { id: "tmin", label: "Lowest temperature", group: "Extremes", ramp: { ...TEMP, label: "Lowest temperature at 2 m" }, perModel: true, digits: 0 },
  { id: "wind", label: "Strongest wind", group: "Extremes", ramp: { ...WIND, label: "Strongest sustained wind at 10 m" }, perModel: true, digits: 0 },
  { id: "gust", label: "Strongest gust", group: "Extremes", ramp: { ...GUST, label: "Strongest gust" }, perModel: true, digits: 0 },
]
const MEAN = "Model mean"

function totalsView(c: Cog | undefined, ramp: Ramp, windowLabel: string, digits = 2): View | null {
  if (!c) return null
  return {
    key: `tot|${c.path.slice(0, 120)}|${ramp.label}`,
    title: `${c.model}, ${windowLabel}`,
    sub: () => (c.run ? `${c.run} run` : c.members ? `${c.members.length} models` : undefined),
    grid: () => ({
      key: "total", t: 0,
      load: async () => {
        const r = await loadCog(cogUrl(c))
        return {
          draw: { grid: r, a: r.data, paint: { kind: "ramp", ramp } },
          sample: (lon, lat, _t, smooth) => {
            const v = valueAt(r, r.data, lon, lat, smooth)
            if (!Number.isFinite(v)) return null
            if (ramp.units === "%") return `${Math.round(v)}% of normal`
            return `${v.toFixed(digits)}${ramp.units === "°F" ? "°F" : ` ${ramp.units}`}`
          },
        }
      },
    }),
  }
}

// ------------------------------------------------------------------ hourly mode

type HLayer = "radar" | "t2m" | "gust" | "wind" | "frz"
const HLAYERS: { id: HLayer; label: string; primary: (e: Record<string, FieldEntry>) => FieldEntry | undefined }[] = [
  { id: "radar", label: "Precipitation", primary: (e) => e.refc ?? e.ptype },
  { id: "t2m", label: "Temperature", primary: (e) => e.t2m },
  { id: "gust", label: "Gusts", primary: (e) => e.gust },
  { id: "wind", label: "Wind", primary: (e) => (e.u10 && e.v10 ? e.u10 : undefined) },
  { id: "frz", label: "Freezing level", primary: (e) => e.frz },
]
const ISOBARS = Array.from({ length: 31 }, (_, i) => 940 + 4 * i)

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", timeZone: "America/Los_Angeles", timeZoneName: "short" })

/** Band `i` of a field, or null if it has no band within `tol` hours of `iso`. */
async function bandNear(e: FieldEntry | undefined, iso: string, tol = 0.6) {
  if (!e) return null
  const i = nearestTime(e.times, iso, tol)
  if (i < 0) return null
  const f = await loadField(e)
  return { f, i, data: await f.band(i) }
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

function hourlyView(model: string, entries: Record<string, FieldEntry>, layer: HLayer, isobars: boolean): View | null {
  const def = HLAYERS.find((l) => l.id === layer)!
  const prim = def.primary(entries)
  if (!prim) return null
  const iso = isobars && !!entries.mslp
  const name = def.label.toLowerCase()
  const nearest = (time: number | null) => (time == null ? null : bracket(prim.times, time, false, 3.1))
  const ramp = layer === "t2m" ? TEMP : layer === "gust" ? GUST : layer === "wind" ? WIND : FRZ

  return {
    key: `hr|${model}|${layer}|${iso ? 1 : 0}`,
    title: `${model}, ${name}`,
    sub(time) {
      const b = nearest(time)
      if (!b) return undefined
      const valid = prim.times[b.i0]
      return `${timeLabel(valid)} (hour ${Math.round((Date.parse(valid) - Date.parse(prim.init)) / 3600e3)} of the ${prim.run} run)`
    },
    grid(time, interp) {
      const b = time == null ? null : bracket(prim.times, time, interp, 3.1)
      if (!b) {
        const when = time == null ? "" : ` within 3 hours of ${timeLabel(new Date(time).toISOString())}`
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
          } else if (layer === "radar") {
            draw = { grid: f, a: A, b: B, paint: { kind: "ptype" } }
            describe = (lon, lat, t) => {
              const tn = PTYPE_NAMES[categoryAt(f, A, B, t, lon, lat)] ?? "none"
              return tn === "none" ? "No precipitation" : cap(tn)
            }
          } else if (layer === "wind") {
            const va = await bandNear(entries.v10, isoA), vb = B ? await bandNear(entries.v10, isoB) : null
            if (!va || (B && !vb)) return { draw: null, note: `${model} has no matching wind components at this time.`, sample: () => null }
            const SA = speedOf(A, va.data), SB = B && vb ? speedOf(B, vb.data) : null
            draw = { grid: f, a: SA, b: SB, paint: { kind: "ramp", ramp } }
            describe = (lon, lat, t, smooth) => {
              const s = blendAt(f, SA, SB, t, lon, lat, smooth)
              if (!Number.isFinite(s)) return null
              const u = blendAt(f, A, B, t, lon, lat, smooth), v = blendAt(f, va.data, vb?.data ?? null, t, lon, lat, smooth)
              return `${windFrom(u, v)} ${Math.round(s)} mph`
            }
          } else {
            draw = { grid: f, a: A, b: B, paint: { kind: "ramp", ramp } }
            describe = (lon, lat, t, smooth) => {
              const v = blendAt(f, A, B, t, lon, lat, smooth)
              if (!Number.isFinite(v)) return null
              if (layer === "t2m") return `${Math.round(v)}°F`
              if (layer === "gust") return `Gusts ${Math.round(v)} mph`
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
        load: () => cachedOverlay(`${model}|${layer}|${i}|${iso ? 1 : 0}`, async () => {
          const out: Overlays = {}
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
              out.isobars = contourLines(p.f, p.data, ISOBARS, p.f.width > 120 ? 3 : 1)
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
      const u = entries.u10, v = entries.v10
      if (!u || !v || time == null) return null
      const b = bracket(u.times, time, interp, 3.1)
      if (!b) return null
      return {
        key: `${b.i0}|${b.i1}`, t: b.t,
        load: async () => {
          const f = await loadField(u)
          const u0 = await f.band(b.i0)
          const v0 = await bandNear(v, u.times[b.i0])
          if (!v0 || !sameGrid(v0.f, f)) throw new Error("no matching v component")
          if (b.i1 === b.i0) return { grid: f, u0, v0: v0.data }
          const u1 = await f.band(b.i1)
          const v1 = await bandNear(v, u.times[b.i1])
          return v1 ? { grid: f, u0, v0: v0.data, u1, v1: v1.data } : { grid: f, u0, v0: v0.data }
        },
      }
    },
    prefetch(time) {
      // decode the next few steps ahead of playback
      const i = Math.floor(posOf(msOf(prim.times), time))
      for (const e of [prim, entries.ptype, entries.v10, entries.u10]) {
        if (!e) continue
        for (let k = 1; k <= 3; k++) {
          const iso = prim.times[i + k]
          if (!iso) break
          const j = nearestTime(e.times, iso, 0.6)
          if (j >= 0) loadField(e).then((f) => f.band(j)).catch(() => {})
        }
      }
    },
  }
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

const TIERS = [["consensus", "Consensus"], ["regional", "Regional"], ["blend", "Blend"], ["global", "Global"]] as const

function ModelSelect({ options, value, onChange, label }: { options: { model: string; tier: string }[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[170px]" aria-label={label}><SelectValue /></SelectTrigger>
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
      <Slider className="min-w-[200px] flex-1" value={[pos]} min={0} max={times.length - 1} step={1}
              onValueChange={([i]) => { setPlaying(false); clock.set(ms[Math.round(i)], false) }} aria-label="Forecast time"
              getAriaValueText={(i) => (times[Math.round(i)] ? timeLabel(times[Math.round(i)]) : "")} />
      <div className="w-[190px] text-right text-sm tabular-nums">{label ? timeLabel(label) : ""}</div>
    </div>
  )
}

// Wind speed has the lightest colours where the wind is calm and the darkest where it's strongest,
// so its particles are a mid ink; other layers get a darker one.
const DARK_INK: [number, number, number, number] = [24, 28, 34, 0.62]
const WIND_INK: [number, number, number, number] = [24, 28, 34, 0.5]

// ------------------------------------------------------------------ the card

export function InteractiveMap({ data }: { data: Briefing }) {
  const sync = useCameraSync()
  const cogs = data.cogs ?? []
  const fields = useFields(data)
  const [mode, setMode] = React.useState<"totals" | "hourly">("totals")
  const [opacity, setOpacity] = React.useState(0.85)
  const [smooth, setSmooth] = useStoredFlag("pnw-briefing.map.smooth", false)
  const [particles, setParticles] = useStoredFlag("pnw-briefing.map.particles", true)
  const [compare, setCompare] = React.useState(false)
  const clock = React.useMemo(() => new Clock(), [])

  // totals state
  const [variable, setVariable] = React.useState<TotVar>("precip")
  const [days, setDays] = React.useState(2)
  const [model, setModel] = React.useState(MEAN)
  const [other, setOther] = React.useState("GFS")

  // hourly state
  const byModel = React.useMemo(() => {
    const m = new Map<string, { tier: string; entries: Record<string, FieldEntry> }>()
    for (const e of fields) {
      if (!m.has(e.model)) m.set(e.model, { tier: e.tier, entries: {} })
      m.get(e.model)!.entries[e.var as FieldVar] = e
    }
    return m
  }, [fields])
  const [layer, setLayer] = React.useState<HLayer>("radar")
  const [hModel, setHModel] = React.useState("HRRR")
  const [hOther, setHOther] = React.useState("GFS")
  const [isobars, setIsobars] = React.useState(true)
  const [playing, setPlaying] = React.useState(false)

  // ---- totals
  const varOf = (c: Cog): TotVar => c.var as TotVar
  const totAvail = TOT_VARS.filter((v) => cogs.some((c) => varOf(c) === v.id))
  const windows = [...new Set(cogs.filter((c) => varOf(c) === variable).map((c) => c.days))].sort((a, b) => a - b)
  const d = windows.includes(days) ? days : windows[0]
  const options = cogs.filter((c) => varOf(c) === variable && c.days === d)
  const pick = (name: string) => options.find((o) => o.model === name) ?? options.find((o) => o.model === MEAN) ?? options[0]
  // the compare pane never shows the same model as the main one
  const pickOther = (name: string) => {
    const main = pick(model)?.model
    const rest = options.filter((o) => o.model !== main)
    return rest.find((o) => o.model === name) ?? rest.find((o) => o.model === MEAN) ?? rest[0]
  }
  const totDef = TOT_VARS.find((v) => v.id === variable)!
  const totRamp = totDef.ramp
  const winLabel = (n: number) => data.windows.find((w) => w.days === n)?.label.toLowerCase() ?? `${n} days`
  const perModel = totDef.perModel

  // ---- hourly
  const layerModels = [...byModel.entries()].filter(([, v]) => HLAYERS.find((l) => l.id === layer)!.primary(v.entries))
    .map(([model, v]) => ({ model, tier: v.tier }))
  const hA = layerModels.find((m) => m.model === hModel)?.model ?? layerModels[0]?.model
  const hB = layerModels.find((m) => m.model === hOther && m.model !== hA)?.model ?? layerModels.find((m) => m.model !== hA)?.model
  const primA = hA ? HLAYERS.find((l) => l.id === layer)!.primary(byModel.get(hA)!.entries) : undefined
  const times = React.useMemo(() => primA?.times ?? [], [primA])

  // Keep the clock on one of the main model's steps when the model or layer changes.
  React.useEffect(() => {
    if (!times.length || clock.playing) return
    const ms = msOf(times)
    clock.set(ms[Math.round(posOf(ms, clock.time ?? ms[0]))], false)
  }, [times])

  // Playback moves the clock continuously; the maps blend between forecast steps as it does.
  React.useEffect(() => {
    if (!playing || times.length < 2 || mode !== "hourly") return
    const ms = msOf(times)
    let pos = posOf(ms, clock.time ?? ms[0])
    if (pos >= ms.length - 1) pos = 0
    let last = performance.now(), raf = 0
    const step = (now: number) => {
      pos += Math.min(0.1, (now - last) / 1000) / SEC_PER_STEP
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
    ? totalsView(pick(model), totRamp, winLabel(d), totDef.digits)
    : hA ? hourlyView(hA, byModel.get(hA)!.entries, layer, isobars) : null
  const showB = compare && (mode === "hourly" || perModel)
  const viewB = !showB ? null : mode === "totals"
    ? totalsView(pickOther(other), totRamp, winLabel(d), totDef.digits)
    : hB ? hourlyView(hB, byModel.get(hB)!.entries, layer, isobars) : null

  if (!cogs.length && !fields.length) return null
  const hasHourly = fields.length > 0
  const entriesA = hA ? byModel.get(hA)!.entries : {}
  const hasWind = mode === "hourly" && [hA, showB ? hB : undefined].some((m) => m && byModel.get(m)?.entries.u10 && byModel.get(m)?.entries.v10)
  const showParticles = particles && hasWind
  const ink = layer === "wind" ? WIND_INK : DARK_INK

  return (
    <Card>
      <CardHeader>
        <CardTitle>Explore the grids</CardTitle>
        <CardDescription>
          {mode === "totals"
            ? "Totals and extremes for each window, from each model's own grid. Model spread and percent of normal use the multi-model mean; extremes come from each model's 3- or 6-hourly output."
            : "Forecast maps through time. Regional models step hourly for precipitation and every 3 hours otherwise; global models every 6 hours. Playback blends smoothly between forecast steps."}
          {" "}Hover for values; drag and zoom to look closer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {hasHourly && (
            <Tabs value={mode} onValueChange={(v) => { setMode(v as "totals" | "hourly"); setPlaying(false) }}>
              <TabsList>
                <TabsTrigger value="totals">Summary</TabsTrigger>
                <TabsTrigger value="hourly">Through time</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {mode === "totals" ? (
            <>
              <Select value={variable} onValueChange={(v) => setVariable(v as TotVar)}>
                <SelectTrigger className="w-[190px]" aria-label="Variable"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["Totals", "Extremes"] as const).map((g) => [g, totAvail.filter((v) => v.group === g)] as const).filter(([, vs]) => vs.length).map(([g, vs]) => (
                    <SelectGroup key={g}>
                      <SelectLabel>{g === "Totals" ? "Totals" : "Extremes over the window"}</SelectLabel>
                      {vs.map((v) => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              <Tabs value={String(d)} onValueChange={(v) => setDays(Number(v))}>
                <TabsList>{windows.map((w) => <TabsTrigger key={w} value={String(w)}>{winLabel(w).replace("next ", "")}</TabsTrigger>)}</TabsList>
              </Tabs>
              {perModel && <ModelSelect options={options} value={pick(model)?.model ?? ""} onChange={setModel} label="Model" />}
              {perModel && <Toggle id="compare-t" label="Compare" checked={compare} onChange={setCompare} />}
              {perModel && compare && <ModelSelect options={options.filter((o) => o.model !== pick(model)?.model)} value={pickOther(other)?.model ?? ""} onChange={setOther} label="Compare with" />}
            </>
          ) : (
            <>
              <Tabs value={layer} onValueChange={(v) => setLayer(v as HLayer)}>
                <TabsList>
                  {HLAYERS.filter((l) => [...byModel.values()].some((v) => l.primary(v.entries))).map((l) => (
                    <TabsTrigger key={l.id} value={l.id}>{l.label}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {hA && <ModelSelect options={layerModels} value={hA} onChange={setHModel} label="Model" />}
              <Toggle id="compare-h" label="Compare" checked={compare} onChange={setCompare} />
              {compare && hB && <ModelSelect options={layerModels.filter((m) => m.model !== hA)} value={hB} onChange={setHOther} label="Compare with" />}
              {entriesA.mslp && <Toggle id="isobars" label="Isobars" checked={isobars} onChange={setIsobars} />}
              {hasWind && <Toggle id="particles" label="Wind particles" checked={particles} onChange={setParticles} />}
            </>
          )}
          <div className="ml-auto flex items-center gap-5">
            <Toggle id="smooth" label="Smooth" checked={smooth} onChange={setSmooth} />
            <div className="flex w-[180px] items-center gap-3">
              <Label className="text-xs text-muted-foreground">Opacity</Label>
              <Slider value={[opacity]} min={0.2} max={1} step={0.05} onValueChange={([v]) => setOpacity(v)} aria-label="Grid opacity" />
            </div>
          </div>
        </div>

        {mode === "hourly" && times.length > 0 && <TimeBar times={times} clock={clock} playing={playing} setPlaying={setPlaying} />}

        <div className={`grid gap-3 ${showB ? "lg:grid-cols-2" : ""}`}>
          <MapPane data={data} view={viewA} clock={clock} opacity={opacity} smooth={smooth} particles={showParticles} particleColor={ink} sync={sync} />
          {showB && <MapPane data={data} view={viewB} clock={clock} opacity={opacity} smooth={smooth} particles={showParticles} particleColor={ink} sync={sync} />}
        </div>

        {mode === "totals" ? <RampLegend ramp={totRamp} every={totRamp.levels.length > 16 ? 2 : 1} /> : (
          <div className="space-y-2">
            {layer === "radar" && <RadarLegend withRefc={!!entriesA.refc} />}
            {smooth && layer === "radar" && !entriesA.refc && <p className="text-xs text-muted-foreground">Precipitation type is a category, so it isn't smoothed.</p>}
            {smooth && layer === "radar" && entriesA.refc && entriesA.ptype && <p className="text-xs text-muted-foreground">Reflectivity is smoothed; precipitation type keeps each model cell's category.</p>}
            {layer === "t2m" && <RampLegend ramp={TEMP} every={2} note="The dashed blue line marks 32°F." />}
            {layer === "gust" && <RampLegend ramp={GUST} />}
            {layer === "wind" && <RampLegend ramp={WIND} note={showParticles ? "Particles trace the 10 m wind; faster particles mean stronger wind." : "Arrows point the way the wind is blowing; longer arrows are stronger winds."} />}
            {layer === "frz" && <RampLegend ramp={FRZ} every={2} note="Snow usually reaches the ground about 1,000 ft below the freezing level." />}
            {showParticles && layer !== "wind" && <p className="text-xs text-muted-foreground">Moving particles trace the 10 m wind.</p>}
            {isobars && entriesA.mslp && <p className="text-xs text-muted-foreground">Gray lines are sea-level pressure every 4 hPa; heavier lines every 8 hPa.</p>}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Download as GeoTIFF:{" "}
          {mode === "totals"
            ? options.slice(0, 12).map((c, i) => (
                <React.Fragment key={c.path}>{i > 0 && ", "}<a className="underline underline-offset-2 hover:text-foreground" href={cogUrl(c)} download>{c.model}</a></React.Fragment>
              ))
            : Object.values(entriesA).map((e, i) => (
                <React.Fragment key={e.path}>{i > 0 && ", "}<a className="underline underline-offset-2 hover:text-foreground" href={fieldUrl(e)} download>{hA} {e.var}</a></React.Fragment>
              ))}
          {mode === "hourly" && " (one band per forecast time)"}.
        </p>
      </CardContent>
    </Card>
  )
}
