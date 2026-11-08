/**
 * WPC surface fronts on the map: the frame for a time, as GeoJSON, and the pip images drawn
 * along each front. Pips go on the left of a front walking along it in point order (WPC's
 * convention), so each image is drawn in its top half: with symbol-placement "line", an icon's
 * top faces the left of the line's direction.
 */
import type * as maplibregl from "maplibre-gl"

import type { FrontFrame, Fronts } from "@/types"

const HOUR = 3600e3
/** How far from a frame's valid time it still stands for the map's time. */
const TOL = { analysis: 2 * HOUR, forecast: 9 * HOUR }

export const FRONT_COLORS = { cold: "#1f5bd6", warm: "#d62d20", occluded: "#8e3fb5", trough: "#9a6a2f", dryline: "#b5651d", squall: "#1b1f24" } as const

/** The frame for a time: the nearest analysis within 2 hours or forecast within 9; with no time
 *  (the totals views), the latest analysis. */
export function frontFrame(f: Fronts, time: number | null): FrontFrame | null {
  if (time == null) return [...f.frames].reverse().find((x) => x.kind === "analysis") ?? f.frames[0] ?? null
  let best: FrontFrame | null = null, d = Infinity
  for (const x of f.frames) {
    const dx = Math.abs(Date.parse(x.valid) - time)
    if (dx <= TOL[x.kind] && dx < d) { d = dx; best = x }
  }
  return best
}

export function frontGeoJSON(fr: FrontFrame | null): GeoJSON.FeatureCollection {
  if (!fr) return { type: "FeatureCollection", features: [] }
  return {
    type: "FeatureCollection",
    features: [
      ...fr.fronts.map((x) => ({ type: "Feature" as const, properties: { type: x.type }, geometry: { type: "LineString" as const, coordinates: x.coords } })),
    ],
  }
}

// ------------------------------------------------------------------ pip images

const R = 2                                    // pixel ratio the images are drawn at
const H = 24                                   // image height (CSS px); the line runs across its middle

function image(w: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas")
  c.width = w * R; c.height = H * R
  const g = c.getContext("2d")!
  g.scale(R, R)
  draw(g)
  return g.getImageData(0, 0, c.width, c.height)
}
const mid = H / 2
/** A triangle on the line at x, pointing up (to the line's left). */
function tri(g: CanvasRenderingContext2D, x: number, color: string, up = true) {
  const s = up ? -1 : 1
  g.beginPath(); g.moveTo(x - 8, mid); g.lineTo(x, mid + s * 11); g.lineTo(x + 8, mid); g.closePath()
  g.fillStyle = color; g.fill()
}
/** A half circle on the line at x. */
function semi(g: CanvasRenderingContext2D, x: number, color: string, up = true) {
  g.beginPath(); g.arc(x, mid, 8, up ? Math.PI : 0, up ? 2 * Math.PI : Math.PI); g.closePath()
  g.fillStyle = color; g.fill()
}

/** Add the pip images to a map (once). */
export function addFrontImages(m: maplibregl.Map) {
  const add = (id: string, w: number, draw: (g: CanvasRenderingContext2D) => void) => {
    if (!m.hasImage(id)) m.addImage(id, image(w, draw), { pixelRatio: R })
  }
  add("pip-cold", 20, (g) => tri(g, 10, FRONT_COLORS.cold))
  add("pip-warm", 20, (g) => semi(g, 10, FRONT_COLORS.warm))
  add("pip-occluded", 40, (g) => { tri(g, 10, FRONT_COLORS.occluded); semi(g, 30, FRONT_COLORS.occluded) })
  // stationary: cold pips toward the warm side, warm pips toward the cold side
  add("pip-stationary", 40, (g) => { tri(g, 10, FRONT_COLORS.cold, false); semi(g, 30, FRONT_COLORS.warm) })
}

/** The fronts' layers, above the data and below the basemap's labels. */
export function addFrontLayers(m: maplibregl.Map, before: string | undefined) {
  addFrontImages(m)
  m.addSource("fronts", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
  const line = ["==", ["geometry-type"], "LineString"] as maplibregl.ExpressionSpecification
  const vis = { visibility: "none" as const }
  m.addLayer({ id: "fronts-casing", type: "line", source: "fronts", filter: line, layout: { ...vis, "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "rgba(255,255,255,0.85)", "line-width": 5.5 } }, before)
  const solid = ["!", ["in", ["get", "type"], ["literal", ["trough", "dryline", "squall"]]]] as maplibregl.ExpressionSpecification
  m.addLayer({ id: "fronts-line", type: "line", source: "fronts", filter: ["all", line, solid], layout: { ...vis, "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "type"], "cold", FRONT_COLORS.cold, "occluded", FRONT_COLORS.occluded, FRONT_COLORS.warm],
      "line-width": 3,
    } }, before)
  // troughs and drylines dashed, squall lines dash-dot
  m.addLayer({ id: "fronts-dashed", type: "line", source: "fronts", filter: ["all", line, ["in", ["get", "type"], ["literal", ["trough", "dryline"]]]],
    layout: { ...vis, "line-join": "round" },
    paint: { "line-color": ["match", ["get", "type"], "dryline", FRONT_COLORS.dryline, FRONT_COLORS.trough], "line-width": 1.7, "line-dasharray": [3, 2.5] } }, before)
  m.addLayer({ id: "fronts-squall", type: "line", source: "fronts", filter: ["all", line, ["==", ["get", "type"], "squall"]],
    layout: { ...vis, "line-join": "round" }, paint: { "line-color": FRONT_COLORS.squall, "line-width": 1.8, "line-dasharray": [4, 1.5, 1, 1.5] } }, before)
  // stationary fronts alternate red and blue
  m.addLayer({ id: "fronts-stationary", type: "line", source: "fronts", filter: ["all", line, ["==", ["get", "type"], "stationary"]],
    layout: { ...vis, "line-join": "round" }, paint: { "line-color": FRONT_COLORS.cold, "line-width": 3, "line-dasharray": [5, 5] } }, before)
  m.addLayer({ id: "fronts-pips", type: "symbol", source: "fronts",
    filter: ["all", line, ["in", ["get", "type"], ["literal", ["cold", "warm", "occluded", "stationary"]]]],
    layout: { ...vis, "symbol-placement": "line", "symbol-spacing": 56,
              "icon-image": ["concat", "pip-", ["get", "type"]], "icon-rotation-alignment": "map", "icon-pitch-alignment": "map",
              "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-keep-upright": false } }, before)
}

export const FRONT_LAYERS = ["fronts-casing", "fronts-line", "fronts-dashed", "fronts-squall", "fronts-stationary", "fronts-pips"]
