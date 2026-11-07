/** "Open on map" links: any card can ask the page to switch to the Map tab with a given mode and
 *  layer. The page listens, switches tabs, and hands the request to the map. */
export interface MapRequest {
  mode: "totals" | "hourly"
  layer?: "radar" | "apcp" | "asnow" | "t2m" | "gust" | "wind" | "frz" | "ivt" | "pgrad" | "rh" | "smoke"
  variable?: string
  days?: number
  isobars?: boolean
  pairs?: boolean
  model?: string
  /** hourly mode: the moment to show (ISO). The map picks a model whose forecast reaches it,
   *  trying `fallback` layers in turn when no model has `layer` that far out. */
  time?: string
  fallback?: NonNullable<MapRequest["layer"]>[]
}

const EVENT = "briefing:open-map"

export function openOnMap(req: MapRequest) {
  window.dispatchEvent(new CustomEvent<MapRequest>(EVENT, { detail: req }))
}

export function onOpenMap(fn: (req: MapRequest) => void) {
  const h = (e: Event) => fn((e as CustomEvent<MapRequest>).detail)
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}
