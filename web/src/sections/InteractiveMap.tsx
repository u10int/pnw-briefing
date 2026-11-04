import * as React from "react"
import * as maplibregl from "maplibre-gl"
import type { ImageSource, MapMouseEvent, StyleSpecification } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
// MapLibre runs a web worker for vector/GeoJSON work; have Vite bundle it and tell MapLibre where it is.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { loadCog, type Raster, renderImage, sample } from "@/lib/cog"
import { PCT, PRECIP, type Ramp, SNOW, SPREAD } from "@/lib/ramps"
import type { Briefing, Cog } from "@/types"

type Var = "precip" | "snow" | "spread" | "pct"
const VARS: { id: Var; label: string; ramp: Ramp }[] = [
  { id: "precip", label: "Precipitation", ramp: PRECIP },
  { id: "snow", label: "Snowfall", ramp: SNOW },
  { id: "spread", label: "Model spread", ramp: SPREAD },
  { id: "pct", label: "% of normal", ramp: PCT },
]
const MEAN = "Model mean"
const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

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

function MapPane({ data, cog, ramp, opacity, sync, title }: {
  data: Briefing; cog: Cog | undefined; ramp: Ramp; opacity: number; sync: ReturnType<typeof useCameraSync>; title: string
}) {
  const el = React.useRef<HTMLDivElement>(null)
  const map = React.useRef<maplibregl.Map | null>(null)
  const ready = React.useRef<Promise<maplibregl.Map> | null>(null)
  const raster = React.useRef<Raster | null>(null)
  const [hover, setHover] = React.useState<{ x: number; y: number; v: number | null; place: string | null } | null>(null)
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")

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
    map.current = m
    ready.current = new Promise((resolve) => m.on("load", () => {
      m.addSource("grid", { type: "image", url: BLANK, coordinates: [[d.lon_min, d.lat_max], [d.lon_max, d.lat_max], [d.lon_max, d.lat_min], [d.lon_min, d.lat_min]] })
      m.addLayer({ id: "grid", type: "raster", source: "grid", paint: { "raster-opacity": opacity, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, "labels")
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
      const r = raster.current
      const near = m.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ["points"] })
      setHover({ x: e.point.x, y: e.point.y, v: r ? sample(r, e.lngLat.lng, e.lngLat.lat) : null,
        place: near.length ? String(near[0].properties?.name) : null })
    })
    m.on("mouseout", () => setHover(null))
    return () => { sync.remove(m); m.remove() }
  }, [])

  React.useEffect(() => {
    if (!cog) return
    let cancelled = false
    setStatus("loading")
    loadCog(cogUrl(cog)).then(async (r) => {
      if (cancelled) return
      raster.current = r
      const { url, coordinates } = renderImage(r, ramp)
      const m = await ready.current!
      ;(m.getSource("grid") as ImageSource).updateImage({ url, coordinates })
      setStatus("ready")
    }).catch(() => !cancelled && setStatus("error"))
    return () => { cancelled = true }
  }, [cog?.path, ramp])

  React.useEffect(() => {
    ready.current?.then((m) => m.setPaintProperty("grid", "raster-opacity", opacity))
  }, [opacity])

  return (
    <div className="relative overflow-hidden rounded-lg border">
      <div ref={el} className="h-[520px] w-full max-sm:h-[420px]" role="region" aria-label={`Map: ${title}`} />
      <div className="pointer-events-none absolute top-2 left-2 rounded-md bg-card/95 px-2.5 py-1.5 text-xs shadow-sm ring-1 ring-border">
        <div className="font-medium">{title}</div>
        {cog?.run && <div className="text-muted-foreground">{cog.run} run</div>}
        {cog?.members && <div className="text-muted-foreground">{cog.members.length} models</div>}
      </div>
      {status !== "ready" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">
          {status === "loading" ? "Loading grid…" : "This grid could not be loaded."}
        </div>
      )}
      {hover && (
        <div className="pointer-events-none absolute z-10 rounded-md bg-popover px-2 py-1 text-xs shadow-md ring-1 ring-border"
             style={{ left: Math.min(hover.x + 14, (el.current?.clientWidth ?? 0) - 140), top: hover.y + 14 }}>
          {hover.place && <div className="font-medium">{hover.place}</div>}
          <div className="tabular-nums">
            {hover.v == null ? "No data" : ramp.units === "%" ? `${Math.round(hover.v)}% of normal` : `${hover.v.toFixed(2)} ${ramp.units}`}
          </div>
        </div>
      )}
    </div>
  )
}

function Legend({ ramp }: { ramp: Ramp }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">{ramp.label} ({ramp.units})</div>
      <div className="flex">
        {ramp.colors.map((c, i) => (
          <div key={i} className="min-w-0 flex-1">
            <div className="h-2.5" style={{ background: c, borderRadius: i === 0 ? "3px 0 0 3px" : i === ramp.colors.length - 1 ? "0 3px 3px 0" : 0 }} />
            <div className="pt-1 text-[10.5px] tabular-nums text-muted-foreground">{ramp.levels[i]}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelSelect({ options, value, onChange, label }: { options: Cog[]; value: string; onChange: (v: string) => void; label: string }) {
  const groups: [string, Cog[]][] = [
    ["Consensus", options.filter((o) => o.tier === "consensus")],
    ["Regional", options.filter((o) => o.tier === "regional")],
    ["Blend", options.filter((o) => o.tier === "blend")],
    ["Global", options.filter((o) => o.tier === "global")],
  ]
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[170px]" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        {groups.filter(([, o]) => o.length).map(([g, o]) => (
          <SelectGroup key={g}>
            <SelectLabel>{g}</SelectLabel>
            {o.map((c) => <SelectItem key={c.model} value={c.model}>{c.model}</SelectItem>)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

export function InteractiveMap({ data }: { data: Briefing }) {
  const sync = useCameraSync()
  const cogs = data.cogs ?? []
  const varOf = (c: Cog): Var => (c.var === "precip" && c.model === MEAN ? "precip" : (c.var as Var))
  const available = VARS.filter((v) => cogs.some((c) => varOf(c) === v.id))
  const [variable, setVariable] = React.useState<Var>("precip")
  const windows = [...new Set(cogs.filter((c) => varOf(c) === variable).map((c) => c.days))].sort((a, b) => a - b)
  const [days, setDays] = React.useState(2)
  const d = windows.includes(days) ? days : windows[0]
  const options = cogs.filter((c) => varOf(c) === variable && c.days === d)
  const [model, setModel] = React.useState(MEAN)
  const [other, setOther] = React.useState("GFS")
  const [compare, setCompare] = React.useState(false)
  const [opacity, setOpacity] = React.useState(0.85)
  const pick = (name: string) => options.find((o) => o.model === name) ?? options.find((o) => o.model === MEAN) ?? options[0]
  const a = pick(model)
  const b = pick(other)
  const ramp = VARS.find((v) => v.id === variable)!.ramp
  const perModel = variable === "precip" || variable === "snow"
  const label = (c?: Cog) => (c ? `${c.model}, ${data.windows.find((w) => w.days === c.days)?.label.toLowerCase() ?? `${c.days} days`}` : "")

  if (!cogs.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Explore the grids</CardTitle>
        <CardDescription>
          Each model's own grid, read straight from the published Cloud-Optimized GeoTIFFs. Hover for values; drag and zoom
          to look closer. Model spread and percent of normal use the multi-model mean.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Tabs value={variable} onValueChange={(v) => setVariable(v as Var)}>
            <TabsList>{available.map((v) => <TabsTrigger key={v.id} value={v.id}>{v.label}</TabsTrigger>)}</TabsList>
          </Tabs>
          <Tabs value={String(d)} onValueChange={(v) => setDays(Number(v))}>
            <TabsList>
              {windows.map((w) => <TabsTrigger key={w} value={String(w)}>{data.windows.find((x) => x.days === w)?.label.replace("Next ", "") ?? `${w} d`}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          {perModel && <ModelSelect options={options} value={a?.model ?? ""} onChange={setModel} label="Model" />}
          {perModel && (
            <div className="flex items-center gap-2">
              <Switch id="compare" checked={compare} onCheckedChange={setCompare} />
              <Label htmlFor="compare">Compare</Label>
            </div>
          )}
          {perModel && compare && <ModelSelect options={options} value={b?.model ?? ""} onChange={setOther} label="Compare with" />}
          <div className="ml-auto flex w-[180px] items-center gap-3">
            <Label className="text-xs text-muted-foreground">Opacity</Label>
            <Slider value={[opacity]} min={0.2} max={1} step={0.05} onValueChange={([v]) => setOpacity(v)} aria-label="Grid opacity" />
          </div>
        </div>
        <div className={`grid gap-3 ${perModel && compare ? "lg:grid-cols-2" : ""}`}>
          <MapPane data={data} cog={a} ramp={ramp} opacity={opacity} sync={sync} title={label(a)} />
          {perModel && compare && <MapPane data={data} cog={b} ramp={ramp} opacity={opacity} sync={sync} title={label(b)} />}
        </div>
        <Legend ramp={ramp} />
        <p className="text-xs text-muted-foreground">
          Download any grid as a GeoTIFF:{" "}
          {options.slice(0, 12).map((c, i) => (
            <React.Fragment key={c.path}>{i > 0 && ", "}<a className="underline underline-offset-2 hover:text-foreground" href={cogUrl(c)} download>{c.model}</a></React.Fragment>
          ))}.
        </p>
      </CardContent>
    </Card>
  )
}
