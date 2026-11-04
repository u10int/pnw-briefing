import * as React from "react"
import * as maplibregl from "maplibre-gl"
import type { GeoJSONSource, ImageSource, MapMouseEvent, StyleSpecification } from "maplibre-gl"
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
import { loadCog, renderImage, sample } from "@/lib/cog"
import {
  type Coords, cellIndex, contourLines, fieldUrl, loadField, nearestTime, ptypeColor, rampColor, refcColor,
  renderGrid, windArrows, windFrom,
} from "@/lib/fields"
import { FRZ, GUST, PCT, PRECIP, PTYPE_COLORS, PTYPE_NAMES, type Ramp, REFC, SNOW, SPREAD, TEMP, WIND } from "@/lib/ramps"
import type { Briefing, Cog, FieldEntry, FieldsManifest, FieldVar } from "@/types"

// ------------------------------------------------------------------ map plumbing

const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] }

// CARTO light basemap: unlabelled tiles under the data, labels on top so place names stay readable.
const carto = (layer: string) => ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/${layer}/{z}/{x}/{y}@2x.png`)
const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    base: { type: "raster", tiles: carto("light_nolabels"), tileSize: 256, attribution: "© OpenStreetMap contributors © CARTO" },
    labels: { type: "raster", tiles: carto("light_only_labels"), tileSize: 256 },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#eef0f3" } },
    { id: "base", type: "raster", source: "base" },
    { id: "labels", type: "raster", source: "labels" },
  ],
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

/** What one map pane shows: a coloured grid, optional overlays, and a hover readout. */
interface Frame {
  image: { url: string; coordinates: Coords } | null
  sample: (lon: number, lat: number) => string | null
  isobars?: GeoJSON.FeatureCollection | null
  freezing?: GeoJSON.FeatureCollection | null
  arrows?: GeoJSON.FeatureCollection | null
  note?: string
}
interface FrameSpec { key: string; title: string; sub?: string; load: () => Promise<Frame> }

// Rendered frames are cached so scrubbing back and forth, and playback, don't redo work.
const frameCache = new Map<string, Promise<Frame>>()
function getFrame(spec: FrameSpec): Promise<Frame> {
  if (!frameCache.has(spec.key)) {
    if (frameCache.size > 160) frameCache.delete(frameCache.keys().next().value!)
    const p = spec.load()
    p.catch(() => frameCache.delete(spec.key))
    frameCache.set(spec.key, p)
  }
  return frameCache.get(spec.key)!
}

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

function MapPane({ data, spec, opacity, sync }: {
  data: Briefing; spec: FrameSpec | null; opacity: number; sync: ReturnType<typeof useCameraSync>
}) {
  const el = React.useRef<HTMLDivElement>(null)
  const ready = React.useRef<Promise<maplibregl.Map> | null>(null)
  const frame = React.useRef<Frame | null>(null)
  const [hover, setHover] = React.useState<{ x: number; y: number; text: string | null; place: string | null } | null>(null)
  const [status, setStatus] = React.useState<{ kind: "loading" | "ready" | "error" | "empty"; note?: string }>({ kind: "loading" })

  React.useEffect(() => {
    const d = data.domain
    const ring = Object.values(data.regionShapes).flat()
    const lons = ring.map((c) => c[0]), lats = ring.map((c) => c[1])
    const m = new maplibregl.Map({
      container: el.current!, style: STYLE, attributionControl: { compact: true },
      bounds: [[Math.min(...lons) - 0.4, Math.min(...lats) - 0.25], [Math.max(...lons) + 0.4, Math.max(...lats) + 0.25]],
      fitBoundsOptions: { padding: 16 },
      dragRotate: false, pitchWithRotate: false, maxZoom: 11,
    })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right")
    ready.current = new Promise((resolve) => m.on("load", () => {
      m.addImage("arrow", arrowImage(), { sdf: true })
      m.addSource("grid", { type: "image", url: BLANK, coordinates: [[d.lon_min, d.lat_max], [d.lon_max, d.lat_max], [d.lon_max, d.lat_min], [d.lon_min, d.lat_min]] })
      m.addLayer({ id: "grid", type: "raster", source: "grid", paint: { "raster-opacity": opacity, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, "labels")
      m.addSource("isobars", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "isobars", type: "line", source: "isobars", paint: { "line-color": "#3a3f47", "line-width": ["case", ["==", ["%", ["get", "value"], 8], 0], 1.4, 0.8], "line-opacity": 0.75 } }, "labels")
      m.addSource("freezing", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "freezing", type: "line", source: "freezing", paint: { "line-color": "#1d3f9c", "line-width": 1.6, "line-dasharray": [2, 1.5] } }, "labels")
      m.addSource("arrows", { type: "geojson", data: EMPTY })
      m.addLayer({ id: "arrows", type: "symbol", source: "arrows",
        // more candidates than fit; collision detection keeps an even spread at any pane size or zoom
        layout: { "icon-image": "arrow", "icon-rotate": ["get", "dir"], "icon-rotation-alignment": "map",
                  "icon-allow-overlap": false, "icon-padding": 3, "symbol-sort-key": ["-", 0, ["get", "speed"]],
                  "icon-size": ["interpolate", ["linear"], ["get", "speed"], 2, 0.35, 20, 0.55, 50, 0.8] },
        paint: { "icon-color": "#1b1f24", "icon-halo-color": "rgba(255,255,255,0.9)", "icon-halo-width": 1.2 } })
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
      setHover({ x: e.point.x, y: e.point.y, text: frame.current?.sample(e.lngLat.lng, e.lngLat.lat) ?? null,
        place: near.length ? String(near[0].properties?.name) : null })
    })
    m.on("mouseout", () => setHover(null))
    return () => { sync.remove(m); m.remove() }
  }, [])

  React.useEffect(() => {
    if (!spec) { setStatus({ kind: "empty" }); return }
    let cancelled = false
    // only show "loading" if the frame isn't instant (avoids flicker while playing)
    const t = setTimeout(() => !cancelled && setStatus((s) => (s.kind === "ready" ? s : { kind: "loading" })), 150)
    getFrame(spec).then(async (f) => {
      if (cancelled) return
      const m = await ready.current!
      if (cancelled) return
      frame.current = f
      if (f.image) (m.getSource("grid") as ImageSource).updateImage(f.image)
      else (m.getSource("grid") as ImageSource).updateImage({ url: BLANK })
      ;(m.getSource("isobars") as GeoJSONSource).setData(f.isobars ?? EMPTY)
      ;(m.getSource("freezing") as GeoJSONSource).setData(f.freezing ?? EMPTY)
      ;(m.getSource("arrows") as GeoJSONSource).setData(f.arrows ?? EMPTY)
      setStatus(f.image ? { kind: "ready" } : { kind: "empty", note: f.note })
    }).catch(() => !cancelled && setStatus({ kind: "error" }))
    return () => { cancelled = true; clearTimeout(t) }
  }, [spec?.key])

  React.useEffect(() => {
    ready.current?.then((m) => m.setPaintProperty("grid", "raster-opacity", opacity))
  }, [opacity])

  return (
    <div className="relative overflow-hidden rounded-lg border">
      <div ref={el} className="h-[520px] w-full max-sm:h-[420px]" role="region" aria-label={`Map: ${spec?.title ?? ""}`} />
      <div className="pointer-events-none absolute top-2 left-2 max-w-[70%] rounded-md bg-card/95 px-2.5 py-1.5 text-xs shadow-sm ring-1 ring-border">
        <div className="font-medium">{spec?.title}</div>
        {spec?.sub && <div className="text-muted-foreground">{spec.sub}</div>}
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

// ------------------------------------------------------------------ totals mode

type TotVar = "precip" | "snow" | "spread" | "pct"
const TOT_VARS: { id: TotVar; label: string; ramp: Ramp }[] = [
  { id: "precip", label: "Precipitation", ramp: PRECIP },
  { id: "snow", label: "Snowfall", ramp: SNOW },
  { id: "spread", label: "Model spread", ramp: SPREAD },
  { id: "pct", label: "% of normal", ramp: PCT },
]
const MEAN = "Model mean"

function totalsSpec(c: Cog | undefined, ramp: Ramp, windowLabel: string): FrameSpec | null {
  if (!c) return null
  return {
    key: `tot|${c.path.slice(0, 120)}|${ramp.label}`,
    title: `${c.model}, ${windowLabel}`,
    sub: c.run ? `${c.run} run` : c.members ? `${c.members.length} models` : undefined,
    load: async () => {
      const r = await loadCog(cogUrl(c))
      return {
        image: renderImage(r, ramp),
        sample: (lon, lat) => {
          const v = sample(r, lon, lat)
          return v == null ? null : ramp.units === "%" ? `${Math.round(v)}% of normal` : `${v.toFixed(2)} ${ramp.units}`
        },
      }
    },
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

function hourlySpec(model: string, entries: Record<string, FieldEntry>, layer: HLayer, time: string, isobars: boolean): FrameSpec | null {
  const def = HLAYERS.find((l) => l.id === layer)!
  const prim = def.primary(entries)
  if (!prim) return null
  const idx = nearestTime(prim.times, time, 3.1)
  const valid = idx >= 0 ? prim.times[idx] : null
  const lead = valid ? Math.round((Date.parse(valid) - Date.parse(prim.init)) / 3600e3) : null
  const iso = isobars && entries.mslp
  return {
    key: `hr|${model}|${layer}|${valid ?? "none:" + time}|${iso ? 1 : 0}`,
    title: `${model}, ${def.label.toLowerCase()}`,
    sub: valid ? `${timeLabel(valid)} (hour ${lead} of the ${prim.run} run)` : undefined,
    load: async () => {
      if (idx < 0) return { image: null, sample: () => null, note: `${model} has no ${def.label.toLowerCase()} within 3 hours of ${timeLabel(time)}.` }
      const f = await loadField(prim)
      const band = await f.band(idx)
      const at = (e: FieldEntry | undefined, tol = 0.6) => (e ? nearestTime(e.times, valid!, tol) : -1)
      let color: (i: number) => [number, number, number, number] | null
      let freezing: GeoJSON.FeatureCollection | null = null
      let arrows: GeoJSON.FeatureCollection | null = null
      let extra: Float32Array | null = null, extra2: Float32Array | null = null
      if (layer === "radar") {
        if (prim.var === "refc") {
          const pi = at(entries.ptype)
          extra = pi >= 0 ? await (await loadField(entries.ptype!)).band(pi) : null
          color = refcColor(band, extra)
        } else color = ptypeColor(band)
      } else if (layer === "t2m") {
        color = rampColor(TEMP, band)
        freezing = contourLines(f, band, [32], 1)
      } else if (layer === "gust") {
        color = rampColor(GUST, band)
      } else if (layer === "wind") {
        extra = await (await loadField(entries.v10!)).band(at(entries.v10))
        const speed = band.map((u, i) => Math.hypot(u, extra![i]))
        extra2 = speed
        color = rampColor(WIND, speed)
        arrows = windArrows(f, band, extra)
      } else {
        color = rampColor(FRZ, band)
      }
      let pressure: Float32Array | null = null, pfile: Awaited<ReturnType<typeof loadField>> | null = null
      let isobarLines: GeoJSON.FeatureCollection | null = null
      if (iso) {
        const mi = at(entries.mslp, 1.6)
        if (mi >= 0) {
          pfile = await loadField(entries.mslp!)
          pressure = await pfile.band(mi)
          isobarLines = contourLines(pfile, pressure, ISOBARS, pfile.width > 120 ? 3 : 1)
        }
      }
      const describe = (i: number): string | null => {
        const v = band[i]
        if (layer === "radar") {
          if (prim.var === "refc") {
            if (!(v >= 5)) return "No precipitation"
            const t = extra ? PTYPE_NAMES[extra[i]] : null
            return `${t && t !== "none" ? t[0].toUpperCase() + t.slice(1) + ", " : ""}${Math.round(v)} dBZ`
          }
          const t = PTYPE_NAMES[v] ?? "none"
          return t === "none" ? "No precipitation" : t[0].toUpperCase() + t.slice(1)
        }
        if (!Number.isFinite(v)) return null
        if (layer === "t2m") return `${Math.round(v)}°F`
        if (layer === "gust") return `Gusts ${Math.round(v)} mph`
        if (layer === "wind") return `${windFrom(v, extra![i])} ${Math.round(extra2![i])} mph`
        return `Freezing level ${(Math.round(v / 100) * 100).toLocaleString("en-US")} ft`
      }
      return {
        image: renderGrid(f, color),
        isobars: isobarLines, freezing, arrows,
        sample: (lon, lat) => {
          const i = cellIndex(f, lon, lat)
          const main = i >= 0 ? describe(i) : null
          let p: string | null = null
          if (pressure && pfile) {
            const k = cellIndex(pfile, lon, lat)
            if (k >= 0 && Number.isFinite(pressure[k])) p = `${pressure[k].toFixed(0)} hPa`
          }
          return [main, p].filter(Boolean).join(", ") || null
        },
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

// ------------------------------------------------------------------ the card

export function InteractiveMap({ data }: { data: Briefing }) {
  const sync = useCameraSync()
  const cogs = data.cogs ?? []
  const fields = useFields(data)
  const [mode, setMode] = React.useState<"totals" | "hourly">("totals")
  const [opacity, setOpacity] = React.useState(0.85)
  const [compare, setCompare] = React.useState(false)

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
  const [time, setTime] = React.useState<string | null>(null)
  const [playing, setPlaying] = React.useState(false)

  // ---- totals
  const varOf = (c: Cog): TotVar => c.var as TotVar
  const totAvail = TOT_VARS.filter((v) => cogs.some((c) => varOf(c) === v.id))
  const windows = [...new Set(cogs.filter((c) => varOf(c) === variable).map((c) => c.days))].sort((a, b) => a - b)
  const d = windows.includes(days) ? days : windows[0]
  const options = cogs.filter((c) => varOf(c) === variable && c.days === d)
  const pick = (name: string) => options.find((o) => o.model === name) ?? options.find((o) => o.model === MEAN) ?? options[0]
  const totRamp = TOT_VARS.find((v) => v.id === variable)!.ramp
  const winLabel = (n: number) => data.windows.find((w) => w.days === n)?.label.toLowerCase() ?? `${n} days`
  const perModel = variable === "precip" || variable === "snow"

  // ---- hourly
  const layerModels = [...byModel.entries()].filter(([, v]) => HLAYERS.find((l) => l.id === layer)!.primary(v.entries))
    .map(([model, v]) => ({ model, tier: v.tier }))
  const hA = layerModels.find((m) => m.model === hModel)?.model ?? layerModels[0]?.model
  const hB = layerModels.find((m) => m.model === hOther && m.model !== hA)?.model ?? layerModels.find((m) => m.model !== hA)?.model
  const primA = hA ? HLAYERS.find((l) => l.id === layer)!.primary(byModel.get(hA)!.entries) : undefined
  const times = primA?.times ?? []
  const tIdx = times.length ? Math.max(0, nearestTime(times, time ?? times[0], 1e6)) : 0
  const curTime = times[tIdx]

  React.useEffect(() => {
    if (!playing || times.length < 2) return
    const id = setInterval(() => setTime((t) => times[(Math.max(0, nearestTime(times, t ?? times[0], 1e6)) + 1) % times.length]), 650)
    return () => clearInterval(id)
  }, [playing, times])

  const specA = mode === "totals"
    ? totalsSpec(pick(model), totRamp, winLabel(d))
    : hA && curTime ? hourlySpec(hA, byModel.get(hA)!.entries, layer, curTime, isobars) : null
  const showB = compare && (mode === "hourly" || perModel)
  const specB = !showB ? null : mode === "totals"
    ? totalsSpec(pick(other), totRamp, winLabel(d))
    : hB && curTime ? hourlySpec(hB, byModel.get(hB)!.entries, layer, curTime, isobars) : null

  // warm the cache for the next frames so playback stays smooth
  React.useEffect(() => {
    if (mode !== "hourly" || !hA || !times.length) return
    for (const k of [1, 2]) {
      const t = times[(tIdx + k) % times.length]
      const s = hourlySpec(hA, byModel.get(hA)!.entries, layer, t, isobars)
      if (s) getFrame(s).catch(() => {})
    }
  }, [mode, hA, layer, tIdx, isobars])

  if (!cogs.length && !fields.length) return null
  const hasHourly = fields.length > 0
  const entriesA = hA ? byModel.get(hA)!.entries : {}

  return (
    <Card>
      <CardHeader>
        <CardTitle>Explore the grids</CardTitle>
        <CardDescription>
          {mode === "totals"
            ? "Totals for each window, from each model's own grid. Model spread and percent of normal use the multi-model mean."
            : "Forecast maps through time. Regional models step hourly for precipitation and every 3 hours otherwise; global models every 6 hours."}
          {" "}Hover for values; drag and zoom to look closer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {hasHourly && (
            <Tabs value={mode} onValueChange={(v) => { setMode(v as "totals" | "hourly"); setPlaying(false) }}>
              <TabsList>
                <TabsTrigger value="totals">Totals</TabsTrigger>
                <TabsTrigger value="hourly">Through time</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {mode === "totals" ? (
            <>
              <Tabs value={variable} onValueChange={(v) => setVariable(v as TotVar)}>
                <TabsList>{totAvail.map((v) => <TabsTrigger key={v.id} value={v.id}>{v.label}</TabsTrigger>)}</TabsList>
              </Tabs>
              <Tabs value={String(d)} onValueChange={(v) => setDays(Number(v))}>
                <TabsList>{windows.map((w) => <TabsTrigger key={w} value={String(w)}>{winLabel(w).replace("next ", "")}</TabsTrigger>)}</TabsList>
              </Tabs>
              {perModel && <ModelSelect options={options} value={pick(model)?.model ?? ""} onChange={setModel} label="Model" />}
              {perModel && <Toggle id="compare-t" label="Compare" checked={compare} onChange={setCompare} />}
              {perModel && compare && <ModelSelect options={options} value={pick(other)?.model ?? ""} onChange={setOther} label="Compare with" />}
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
            </>
          )}
          <div className="ml-auto flex w-[180px] items-center gap-3">
            <Label className="text-xs text-muted-foreground">Opacity</Label>
            <Slider value={[opacity]} min={0.2} max={1} step={0.05} onValueChange={([v]) => setOpacity(v)} aria-label="Grid opacity" />
          </div>
        </div>

        {mode === "hourly" && times.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/40 px-3 py-2.5">
            <Button size="icon" variant="outline" className="size-8 shrink-0" onClick={() => setPlaying((p) => !p)}
                    aria-label={playing ? "Pause" : "Play through time"}>
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <Slider className="min-w-[200px] flex-1" value={[tIdx]} min={0} max={times.length - 1} step={1}
                    onValueChange={([i]) => { setPlaying(false); setTime(times[i]) }} aria-label="Forecast time"
                    getAriaValueText={(i) => (times[i] ? timeLabel(times[i]) : "")} />
            <div className="w-[190px] text-right text-sm tabular-nums">{curTime ? timeLabel(curTime) : ""}</div>
          </div>
        )}

        <div className={`grid gap-3 ${showB ? "lg:grid-cols-2" : ""}`}>
          <MapPane data={data} spec={specA} opacity={opacity} sync={sync} />
          {showB && <MapPane data={data} spec={specB} opacity={opacity} sync={sync} />}
        </div>

        {mode === "totals" ? <RampLegend ramp={totRamp} /> : (
          <div className="space-y-2">
            {layer === "radar" && <RadarLegend withRefc={!!entriesA.refc} />}
            {layer === "t2m" && <RampLegend ramp={TEMP} every={2} note="The dashed blue line marks 32°F." />}
            {layer === "gust" && <RampLegend ramp={GUST} />}
            {layer === "wind" && <RampLegend ramp={WIND} note="Arrows point the way the wind is blowing; longer arrows are stronger winds." />}
            {layer === "frz" && <RampLegend ramp={FRZ} every={2} note="Snow usually reaches the ground about 1,000 ft below the freezing level." />}
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
