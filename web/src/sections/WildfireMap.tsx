import * as React from "react"
import * as maplibregl from "maplibre-gl"
import type { GeoJSONSource } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { FALLBACK, STYLE_URL, withKey } from "@/lib/basemap"
import { isActive } from "@/lib/fire"
import { FUEL, spcColor, USDM } from "@/lib/ramps"
import type { Briefing, Wildfire } from "@/types"
import { dayMD } from "@/lib/format"

type FC = GeoJSON.FeatureCollection
const fc = (features: GeoJSON.Feature[]): FC => ({ type: "FeatureCollection", features })
const shortDate = (iso: string) => dayMD(iso)

/** The day's outlook layers: NWCC fuel dryness by area (dry and worse; moist is left clear), and SPC areas (the lowest day number that
 *  covers the date, since days 2 and 3 can share a date). */
function dayLayers(wf: Wildfire, date: string) {
  const psa = wf.psa
  const k = psa ? psa.dates.indexOf(date) : -1
  const fuel = fc((psa?.areas ?? []).flatMap((a) => {
    const d = k >= 0 ? a.days[k] : null
    return d && d.level >= 2 ? [{ type: "Feature", geometry: a.geometry, properties: { color: FUEL[d.level], text: `${a.name}: ${d.label}` } }] : []
  }))
  const day = (wf.spc ?? []).filter((d) => d.date === date).sort((a, b) => a.day - b.day)[0]
  const spc = fc((day?.areas ?? []).map((a) => ({ type: "Feature", geometry: a.geometry,
    properties: { color: spcColor(a.kind, a.dn, a.probability), text: `SPC day ${day!.day}: ${a.label}`, dashed: a.kind === "dryt" ? 1 : 0 } })))
  return { fuel, spc }
}

export default function WildfireMap({ data, wf }: { data: Briefing; wf: Wildfire }) {
  const el = React.useRef<HTMLDivElement>(null)
  const map = React.useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = React.useState(false)
  const dates = React.useMemo(() => {
    const s = new Set<string>([...(wf.psa?.dates ?? []), ...((wf.spc ?? []).map((d) => d.date).filter(Boolean) as string[])])
    return [...s].sort().slice(0, 10)
  }, [wf])
  const [date, setDate] = React.useState(dates[0] ?? "")
  const [show, setShow] = React.useState({ fires: true, fuel: true, spc: true, drought: false })

  React.useEffect(() => {
    const d = data.domain
    const m = new maplibregl.Map({
      container: el.current!, style: STYLE_URL, transformRequest: withKey, attributionControl: { compact: true },
      bounds: [[d.lon_min, d.lat_min], [d.lon_max, d.lat_max]], fitBoundsOptions: { padding: 8 },
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxZoom: 12,
    })
    m.touchZoomRotate.disableRotation()
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right")
    let loaded = false, fellBack = false
    m.on("error", () => { if (!loaded && !fellBack && !m.isStyleLoaded()) { fellBack = true; m.setStyle(FALLBACK) } })
    m.on("load", () => {
      loaded = true
      const labels = m.getStyle().layers.find((l) => l.type === "symbol")?.id
      const add = (id: string, layers: maplibregl.LayerSpecification[]) => {
        m.addSource(id, { type: "geojson", data: fc([]) })
        layers.forEach((l) => m.addLayer(l, labels))
      }
      add("drought", [{ id: "drought", type: "fill", source: "drought", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.35 } }])
      add("fuel", [{ id: "fuel", type: "fill", source: "fuel", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.45 } },
                   { id: "fuel-line", type: "line", source: "fuel", paint: { "line-color": "#6b7280", "line-width": 0.6 } }])
      add("spc", [{ id: "spc", type: "fill", source: "spc", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.3 } },
                  { id: "spc-line", type: "line", source: "spc", paint: { "line-color": ["get", "color"], "line-width": 2 } }])
      add("perims", [{ id: "perims", type: "fill", source: "perims", paint: { "fill-color": "#c8322b", "fill-opacity": 0.35 } },
                     { id: "perims-line", type: "line", source: "perims", paint: { "line-color": "#8b1a14", "line-width": 1 } }])
      m.addSource("fires", { type: "geojson", data: fc([]) })
      m.addLayer({ id: "fires", type: "circle", source: "fires", paint: {
        "circle-color": ["get", "color"], "circle-stroke-color": "#fff", "circle-stroke-width": 1,
        "circle-radius": ["interpolate", ["linear"], ["sqrt", ["max", ["get", "acres"], 1]], 1, 3.5, 100, 9, 330, 14] } })
      m.addSource("points", { type: "geojson", data: fc(data.points.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { text: p.name } }))) })
      m.addLayer({ id: "points", type: "circle", source: "points", paint: { "circle-radius": 3.2, "circle-color": "#fff", "circle-stroke-color": "#1b1f24", "circle-stroke-width": 1.2 } })
      const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, className: "text-xs" })
      const hover = ["fires", "perims", "spc", "fuel", "drought", "points"]
      m.on("mousemove", (e) => {
        const f = m.queryRenderedFeatures(e.point, { layers: hover.filter((l) => m.getLayer(l)) })
        const lines = [...new Set(f.map((x) => x.properties?.text).filter(Boolean))].slice(0, 4)
        m.getCanvas().style.cursor = lines.length ? "default" : ""
        if (lines.length) pop.setLngLat(e.lngLat).setHTML(lines.map((t) => `<div>${String(t).replace(/</g, "&lt;")}</div>`).join("")).addTo(m)
        else pop.remove()
      })
      m.on("mouseout", () => pop.remove())
      setReady(true)
    })
    map.current = m
    return () => { m.remove(); map.current = null }
  }, [data])

  // static layers: drought, perimeters, incidents
  React.useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const set = (id: string, d: FC) => (m.getSource(id) as GeoJSONSource | undefined)?.setData(d)
    set("drought", fc((wf.drought?.categories ?? []).map((c) => ({ type: "Feature", geometry: c.geometry, properties: { color: USDM[c.dm], text: `Drought Monitor: D${c.dm} ${c.label}` } }))))
    set("perims", fc((wf.perimeters?.features ?? []).map((f) => ({ ...f, properties: { ...f.properties,
      text: `${f.properties?.name} perimeter, ${Math.round(f.properties?.acres ?? 0).toLocaleString("en-US")} acres${f.properties?.contained != null ? `, ${f.properties.contained}% contained` : ""}` } }))))
    set("fires", fc((wf.incidents ?? []).filter((r) => r.lon != null).map((r) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: { acres: r.acres ?? 1,
        color: r.type === "Prescribed fire" ? "#8a8f98" : isActive(r) ? "#c8322b" : "#d9a08b",
        text: `${r.name} (${r.type.toLowerCase()}): ${r.acres != null ? Math.round(r.acres).toLocaleString("en-US") + " acres" : "size unknown"}${r.contained != null ? `, ${Math.round(r.contained)}% contained` : ""}` } }))))
  }, [ready, wf])

  // the chosen day's outlook layers
  React.useEffect(() => {
    const m = map.current
    if (!m || !ready || !date) return
    const { fuel, spc } = dayLayers(wf, date)
    ;(m.getSource("fuel") as GeoJSONSource | undefined)?.setData(fuel)
    ;(m.getSource("spc") as GeoJSONSource | undefined)?.setData(spc)
  }, [ready, wf, date])

  React.useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const vis = (ids: string[], on: boolean) => ids.forEach((id) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", on ? "visible" : "none"))
    vis(["fires", "perims", "perims-line"], show.fires)
    vis(["fuel", "fuel-line"], show.fuel)
    vis(["spc", "spc-line"], show.spc)
    vis(["drought"], show.drought)
  }, [ready, show])

  const toggle = (k: keyof typeof show, label: string) => (
    <div className="flex items-center gap-2">
      <Switch id={`wfm-${k}`} checked={show[k]} onCheckedChange={(v) => setShow((s) => ({ ...s, [k]: v }))} />
      <Label htmlFor={`wfm-${k}`} className="font-normal">{label}</Label>
    </div>
  )
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {dates.length > 0 && (
          <Select value={date} onValueChange={setDate}>
            <SelectTrigger className="w-full sm:w-[180px]" aria-label="Outlook day"><SelectValue /></SelectTrigger>
            <SelectContent>{dates.map((d) => <SelectItem key={d} value={d}>{shortDate(d)}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {toggle("fires", "Fires")}
        {toggle("fuel", "Fuel dryness (NWCC)")}
        {toggle("spc", "SPC outlook")}
        {toggle("drought", "Drought")}
      </div>
      <div ref={el} className="h-[480px] w-full overflow-hidden rounded-lg border max-sm:h-[380px]" />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-[#c8322b]" />Active fire</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-[#d9a08b]" />Contained or inactive</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-[#8a8f98]" />Prescribed</span>
        {[2, 3, 4].map((l) => <span key={l} className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[2px]" style={{ background: FUEL[l] }} />{["", "Moist", "Dry", "Very dry", "High risk"][l]}</span>)}
        {USDM.map((c, i) => <span key={c} className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[2px] opacity-70" style={{ background: c }} />D{i}</span>)}
      </div>
    </div>
  )
}
