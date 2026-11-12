import type { CustomRenderMethodInput, Map as MlMap } from "maplibre-gl"

import { elevationFor } from "@/lib/fields"
import { unpack, type VolumeEntry } from "@/lib/volume"

import { type GridDraw, GridLayer } from "./grid-layer"
import { type Grid, mercX, mercY } from "./util"

export interface Bounds { west: number; south: number; east: number; north: number }

/** A canvas source's corners for a lon/lat box: top-left, top-right, bottom-right, bottom-left. */
export const corners = (b: Bounds): [[number, number], [number, number], [number, number], [number, number]] =>
  [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]]

/**
 * The map's 2D grid drawn into its own canvas, for MapLibre to drape over the 3D terrain as a canvas
 * source (a custom WebGL layer can't be draped: it would stay flat at sea level, under the
 * mountains). It runs the same GridLayer in a second WebGL context, through an orthographic Web
 * Mercator matrix over the area, so the colours, smoothing and blending match the flat map.
 */
export class GridDrape {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null
  private layer = new GridLayer("drape")
  private matrix: Float32Array
  private queued = false
  onFrame: (() => void) | null = null

  constructor(readonly bounds: Bounds, width = 1400) {
    const x0 = mercX(bounds.west), x1 = mercX(bounds.east), yN = mercY(bounds.north), yS = mercY(bounds.south)
    this.canvas = document.createElement("canvas")
    this.canvas.width = width
    this.canvas.height = Math.round((width * (yS - yN)) / (x1 - x0))
    this.gl = this.canvas.getContext("webgl2", { premultipliedAlpha: true, preserveDrawingBuffer: true })
    // Web Mercator x0..x1 to clip -1..1, north (yN) at the top
    this.matrix = new Float32Array([2 / (x1 - x0), 0, 0, 0, 0, -2 / (yS - yN), 0, 0, 0, 0, 1, 0,
                                    -(x1 + x0) / (x1 - x0), (yS + yN) / (yS - yN), 0, 1])
    if (this.gl) this.layer.onAdd({ triggerRepaint: () => this.queue() } as unknown as MlMap, this.gl)
  }
  get ok() { return !!this.gl }

  setDraw(d: GridDraw | null, t = 0) { this.layer.setDraw(d, t) }
  setT(t: number) { this.layer.setT(t) }
  setSmooth(s: boolean) { this.layer.setSmooth(s) }
  setOpacity(o: number) { this.layer.setOpacity(o) }

  private queue() {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => { this.queued = false; this.render() })
  }
  render() {
    const gl = this.gl
    if (!gl) return
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.layer.render(gl, { defaultProjectionData: { mainMatrix: this.matrix } } as unknown as CustomRenderMethodInput)
    this.onFrame?.()
  }
  dispose() {
    if (this.gl) this.layer.onRemove?.({} as MlMap, this.gl)
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext()
    this.gl = null
  }
}

// ------------------------------------------------------------------ snow level

/** Wet-bulb temperature (°C) from temperature (°C) and relative humidity (%), Stull (2011). */
export function wetBulb(t: number, rh: number) {
  const r = Math.max(5, Math.min(100, rh))
  return t * Math.atan(0.151977 * Math.sqrt(r + 8.313659)) + Math.atan(t + r) - Math.atan(r - 1.676331)
    + 0.00391838 * r ** 1.5 * Math.atan(0.023101 * r) - 4.686035
}

/** How far below the wet-bulb freezing level snow usually reaches before it has all melted (km). */
export const SNOW_BELOW_KM = 0.3

/**
 * The snow level (km above sea level) over the volume's grid for each time step: the highest height
 * where the wet-bulb temperature crosses 0°C going up, less SNOW_BELOW_KM (snow survives a little
 * way into air above freezing). Where the whole column is below 0°C, it's 0 (snow to sea level).
 */
export function snowLevels(e: VolumeEntry, temp: Uint8Array, rh: Uint8Array): Float32Array[] {
  const { nx, ny, nz } = e
  const per = nx * ny * nz, plane = nx * ny
  const tv = e.vars.temp, hv = e.vars.rh
  const T = new Float32Array(256), H = new Float32Array(256)
  for (let b = 0; b < 256; b++) { T[b] = b === 255 ? NaN : (unpack(b, tv) - 32) * 5 / 9; H[b] = b === 255 ? NaN : unpack(b, hv) }
  const dz = e.topKm / (nz - 1)
  const out: Float32Array[] = []
  for (let s = 0; s < e.times.length; s++) {
    const lv = new Float32Array(plane)
    for (let i = 0; i < plane; i++) {
      let level = 0
      let above = NaN
      for (let z = nz - 1; z >= 0; z--) {
        const k = s * per + z * plane + i
        const w = wetBulb(T[temp[k]], H[rh[k]])
        if (!Number.isFinite(w)) continue
        if (w > 0) {
          // the crossing between this height and the one above (still below 0°C)
          level = Number.isFinite(above) ? (z + w / (w - above)) * dz : z * dz
          break
        }
        above = w
      }
      lv[i] = Math.max(0, level - (level > 0 ? SNOW_BELOW_KM : 0))
    }
    out.push(lv)
  }
  return out
}

/**
 * Terrain above the snow level, shaded white, in a canvas over the area for MapLibre to drape. The
 * terrain comes from the same tiles as the hillshade (~1 km); the snow level is bilinear over the
 * model grid and blended between the time steps either side of the clock.
 */
export class Snowline {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private img: ImageData
  private elev: Float32Array | null = null       // km, per canvas pixel
  private levels: Float32Array[] | null = null
  private entry: VolumeEntry | null = null
  private lastKey = ""

  constructor(readonly bounds: Bounds, width = 784) {
    const x0 = mercX(bounds.west), x1 = mercX(bounds.east), yN = mercY(bounds.north), yS = mercY(bounds.south)
    this.canvas = document.createElement("canvas")
    this.canvas.width = width
    this.canvas.height = Math.round((width * (yS - yN)) / (x1 - x0))
    this.ctx = this.canvas.getContext("2d")!
    this.img = this.ctx.createImageData(this.canvas.width, this.canvas.height)
  }

  /** Terrain heights for each pixel (the canvas is Web Mercator, the terrain grid lon/lat). */
  async loadTerrain() {
    if (this.elev) return
    const b = this.bounds
    const g: Grid = { west: b.west, east: b.east, south: b.south, north: b.north,
                      width: Math.round((b.east - b.west) / 0.0125), height: Math.round((b.north - b.south) / 0.0125) }
    const { mean } = await elevationFor(g)
    const W = this.canvas.width, Hh = this.canvas.height
    const yN = mercY(b.north), yS = mercY(b.south)
    const e = new Float32Array(W * Hh)
    for (let py = 0; py < Hh; py++) {
      const my = yN + ((py + 0.5) / Hh) * (yS - yN)
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI
      const gy = Math.min(g.height - 1, Math.max(0, Math.floor(((b.north - lat) / (b.north - b.south)) * g.height)))
      for (let px = 0; px < W; px++) {
        const gx = Math.min(g.width - 1, Math.floor(((px + 0.5) / W) * g.width))
        const m = mean[gy * g.width + gx]
        e[py * W + px] = Number.isFinite(m) ? Math.max(0, m) / 1000 : 0
      }
    }
    this.elev = e
    this.lastKey = ""
  }

  setLevels(e: VolumeEntry | null, levels: Float32Array[] | null) {
    this.entry = e; this.levels = levels; this.lastKey = ""
  }

  /** Repaint for the time between steps i0 and i1; returns whether anything changed. */
  render(i0: number, i1: number, t: number): boolean {
    const e = this.entry, L = this.levels, elev = this.elev
    const key = `${i0}|${i1}|${t.toFixed(3)}|${!!L}|${!!elev}`
    if (key === this.lastKey) return false
    this.lastKey = key
    const d = this.img.data
    d.fill(0)
    if (e && L && elev) {
      const A = L[Math.min(i0, L.length - 1)], B = L[Math.min(i1, L.length - 1)]
      const W = this.canvas.width, Hh = this.canvas.height, b = this.bounds
      const yN = mercY(b.north), yS = mercY(b.south)
      const { nx, ny } = e
      for (let py = 0; py < Hh; py++) {
        const my = yN + ((py + 0.5) / Hh) * (yS - yN)
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI
        const fy = Math.min(ny - 1.001, Math.max(0, ((lat - e.lat[0]) / (e.lat[1] - e.lat[0])) * (ny - 1)))
        const y0 = Math.floor(fy), ay = fy - y0
        for (let px = 0; px < W; px++) {
          const h = elev[py * W + px]
          if (h < 0.15) continue                                  // lowlands and water: nothing to show
          const lon = b.west + ((px + 0.5) / W) * (b.east - b.west)
          const fx = Math.min(nx - 1.001, Math.max(0, ((lon - e.lon[0]) / (e.lon[1] - e.lon[0])) * (nx - 1)))
          const x0 = Math.floor(fx), ax = fx - x0
          const at = (G: Float32Array) => {
            const k = y0 * nx + x0
            return (G[k] * (1 - ax) + G[k + 1] * ax) * (1 - ay) + (G[k + nx] * (1 - ax) + G[k + nx + 1] * ax) * ay
          }
          const snow = t > 0 && A !== B ? at(A) * (1 - t) + at(B) * t : at(A)
          const a = Math.min(1, Math.max(0, (h - snow + 0.08) / 0.2))  // a soft edge about 200 m deep
          if (a <= 0) continue
          const o = (py * W + px) * 4
          d[o] = 250; d[o + 1] = 252; d[o + 2] = 255; d[o + 3] = Math.round(225 * a)
        }
      }
    }
    this.ctx.putImageData(this.img, 0, 0)
    return true
  }
}

/** Terrain heights (km) over a volume's box, for the volume to stop at the ground. */
export async function groundFor(e: VolumeEntry): Promise<{ width: number; height: number; km: Float32Array }> {
  const g: Grid = { west: e.lon[0], east: e.lon[1], south: e.lat[0], north: e.lat[1],
                    width: Math.round((e.lon[1] - e.lon[0]) / 0.025), height: Math.round((e.lat[1] - e.lat[0]) / 0.025) }
  const { mean } = await elevationFor(g)
  const km = new Float32Array(mean.length)
  for (let i = 0; i < km.length; i++) km[i] = Number.isFinite(mean[i]) ? Math.max(0, mean[i]) / 1000 : 0
  return { width: g.width, height: g.height, km }
}
