import * as React from "react"

import * as maplibregl from "maplibre-gl"
import { MapIcon } from "lucide-react"
import "maplibre-gl/dist/maplibre-gl.css"

import { Button } from "@/components/ui/button"
import { FALLBACK, STYLE_URL, withKey } from "@/lib/basemap"
import { loadCog } from "@/lib/cog"
import { GridLayer } from "@/lib/gl/grid-layer"
import { headlineFocus } from "@/lib/headline-focus"
import { openOnMap } from "@/lib/maplink"
import { leadEvent } from "@/sections/OverviewStrip"
import type { Briefing } from "@/types"

const cogUrl = (path: string) => (path.startsWith("data:") ? path : `data/${path}`)
// room for the Open map button above and the attribution below
const PAD = { top: 50, bottom: 40, left: 24, right: 24 }

type Box = { west: number; south: number; east: number; north: number }

/**
 * Frames the bounds, then zooms in as far as the marks allow while the card is wider (or taller)
 * than the grid, and slides the view back inside the grid, so as little as possible of the card
 * is basemap beyond the data.
 */
function frame(m: maplibregl.Map, b: [[number, number], [number, number]], marks: [number, number][], box: Box) {
  m.fitBounds(b, { padding: PAD, animate: false })
  const v = m.getBounds()
  // how many zoom steps until the grid spans the card's width (the card is wider than it is tall)
  const short = Math.log2((v.getEast() - v.getWest()) / (box.east - box.west))
  if (short > 0) {
    // as far as the marks still fit (with a little room), up to filling the card's width
    const tight = marks.length
      ? m.cameraForBounds([[Math.min(...marks.map((x) => x[0])), Math.min(...marks.map((x) => x[1]))],
                           [Math.max(...marks.map((x) => x[0])), Math.max(...marks.map((x) => x[1]))]],
                          { padding: { top: 46, bottom: 36, left: 40, right: 40 }, maxZoom: 9 })?.zoom ?? m.getZoom()
      : Infinity
    m.jumpTo({ zoom: Math.max(m.getZoom(), Math.min(m.getZoom() + short, tight)) })
  }
  const u = m.getBounds()
  const span = (lo: number, hi: number, dlo: number, dhi: number) =>
    hi - lo >= dhi - dlo ? (dlo + dhi) / 2 - (lo + hi) / 2 : lo < dlo ? dlo - lo : hi > dhi ? dhi - hi : 0
  const dx = span(u.getWest(), u.getEast(), box.west, box.east)
  const dy = span(u.getSouth(), u.getNorth(), box.south, box.north)
  if (dx || dy) { const c = m.getCenter(); m.jumpTo({ center: [c.lng + dx, c.lat + dy] }) }
}

/**
 * A small map under the headline: the grid behind its main hazard (strongest gust, rain total…),
 * framed on the places it's about, with those places marked and labelled. It's a preview, so it
 * doesn't pan or zoom; it and its button open the full map on the same layer.
 */
export function HeadlineMap({ data }: { data: Briefing }) {
  const focus = React.useMemo(() => headlineFocus(data, leadEvent(data)?.hazard), [data])
  const el = React.useRef<HTMLDivElement>(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!focus || !el.current) return
    let gone = false
    const m = new maplibregl.Map({
      container: el.current, style: STYLE_URL, transformRequest: withKey, interactive: false,
      attributionControl: { compact: true },
    })
    const marks = focus.marks.map((k) => [k.lon, k.lat] as [number, number])
    let box: Box = { west: data.domain.lon_min, south: data.domain.lat_min, east: data.domain.lon_max, north: data.domain.lat_max }
    frame(m, focus.bounds, marks, box)
    let loaded = false, fellBack = false
    m.on("error", () => { if (!loaded && !fellBack && !m.isStyleLoaded()) { fellBack = true; m.setStyle(FALLBACK) } })
    const grid = new GridLayer("hl-grid")
    m.on("load", () => {
      loaded = true
      // the attribution starts folded to its (i) button, so it doesn't cover the marks
      el.current?.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show")
      const labels = m.getStyle().layers.find((l) => l.type === "symbol")?.id
      // the basemap's own label font (glyphs for any other font may not exist)
      const font = (m.getStyle().layers.find((l) => l.type === "symbol" && (l.layout as Record<string, unknown> | undefined)?.["text-font"])
        ?.layout as Record<string, unknown> | undefined)?.["text-font"] as string[] | undefined
      m.addLayer(grid, labels)
      if (focus.cog && focus.ramp) {
        const ramp = focus.ramp
        loadCog(cogUrl(focus.cog.path)).then((r) => {
          if (gone) return
          grid.setDraw({ grid: r, a: r.data, paint: { kind: "ramp", ramp } })
          box = r                                            // frame within the grid itself
          frame(m, focus.bounds, marks, box)
        },
          () => { if (!gone) setFailed(true) })
      }
      m.addSource("hl-marks", { type: "geojson", data: { type: "FeatureCollection", features: focus.marks.map((k) => ({
        type: "Feature", properties: { label: k.label }, geometry: { type: "Point", coordinates: [k.lon, k.lat] } })) } })
      m.addLayer({ id: "hl-marks", type: "circle", source: "hl-marks",
                   paint: { "circle-radius": 4.5, "circle-color": "#fff", "circle-stroke-color": "#1b1f24", "circle-stroke-width": 2 } })
      m.addLayer({ id: "hl-labels", type: "symbol", source: "hl-marks",
                   layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, -1.15], "text-anchor": "bottom",
                             ...(font ? { "text-font": font } : {}), "text-padding": 2 },
                   paint: { "text-color": "#1b1f24", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.6 } })
    })
    // keep the framing when the card changes width
    const ro = new ResizeObserver(() => { m.resize(); frame(m, focus.bounds, marks, box) })
    ro.observe(el.current)
    return () => { gone = true; ro.disconnect(); m.remove() }
  }, [focus, data.domain])

  if (!focus) return null
  const open = () => openOnMap(focus.req)
  return (
    <figure className="relative overflow-hidden rounded-xl border">
      <div ref={el} role="img" aria-label={`Map: ${focus.title}${focus.markNote ? `. ${focus.markNote}` : ""}`} onClick={open}
           className="h-[220px] w-full cursor-pointer max-sm:h-[200px]" />
      <Button variant="outline" size="sm" onClick={open} className="absolute top-2.5 right-2.5 bg-background/95 shadow-xs">
        <MapIcon className="size-4" />Open map
      </Button>
      <figcaption className="pointer-events-none absolute bottom-2.5 left-2.5 max-w-[calc(100%-60px)] rounded-md bg-background/90 px-2 py-1 text-xs shadow-xs">
        <span className="font-medium">{focus.title}</span>
        {focus.marks.length > 0 && focus.markLabel && <span className="text-muted-foreground"> · {focus.markLabel} labelled</span>}
        {failed && <span className="text-muted-foreground"> (couldn't load)</span>}
      </figcaption>
    </figure>
  )
}
