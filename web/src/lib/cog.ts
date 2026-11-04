import { fromArrayBuffer } from "geotiff"

import { colorizer, type Ramp } from "@/lib/ramps"

export interface Raster {
  width: number; height: number; data: Float32Array
  west: number; south: number; east: number; north: number
}

const cache = new Map<string, Promise<Raster>>()

/** Read a single-band EPSG:4326 COG (url or data: URI). Files are small, so read whole. */
export function loadCog(url: string): Promise<Raster> {
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      const buf = await (await fetch(url)).arrayBuffer()
      const tiff = await fromArrayBuffer(buf)
      const img = await tiff.getImage()
      const [west, south, east, north] = img.getBoundingBox()
      const [band] = (await img.readRasters({ samples: [0] })) as unknown as Float32Array[]
      return { width: img.getWidth(), height: img.getHeight(), data: Float32Array.from(band), west, south, east, north }
    })())
  }
  return cache.get(url)!
}

/** Value at a longitude/latitude, or null outside the grid or where there is no data. */
export function sample(r: Raster, lon: number, lat: number): number | null {
  if (lon < r.west || lon >= r.east || lat <= r.south || lat > r.north) return null
  const col = Math.floor(((lon - r.west) / (r.east - r.west)) * r.width)
  const row = Math.floor(((r.north - lat) / (r.north - r.south)) * r.height)
  const v = r.data[row * r.width + col]
  return Number.isFinite(v) ? v : null
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const invMercY = (y: number) => (Math.atan(Math.sinh(y)) * 180) / Math.PI

/**
 * Colour the raster into an image whose rows are evenly spaced in Web Mercator, so that a MapLibre
 * image source (which interpolates linearly between its corners in Mercator) puts every cell edge
 * in the right place. Columns are already linear in both projections.
 */
export function renderImage(r: Raster, ramp: Ramp): { url: string; coordinates: [[number, number], [number, number], [number, number], [number, number]] } {
  const color = colorizer(ramp)
  const outH = Math.max(512, r.height * 4)
  const canvas = document.createElement("canvas")
  canvas.width = r.width
  canvas.height = outH
  const ctx = canvas.getContext("2d")!
  const img = ctx.createImageData(r.width, outH)
  const yN = mercY(r.north), yS = mercY(r.south)
  for (let oy = 0; oy < outH; oy++) {
    const lat = invMercY(yN - ((oy + 0.5) / outH) * (yN - yS))
    const row = Math.min(r.height - 1, Math.max(0, Math.floor(((r.north - lat) / (r.north - r.south)) * r.height)))
    for (let x = 0; x < r.width; x++) {
      const c = color(r.data[row * r.width + x])
      if (!c) continue
      const k = (oy * r.width + x) * 4
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = c[3]
    }
  }
  ctx.putImageData(img, 0, 0)
  return {
    url: canvas.toDataURL("image/png"),
    coordinates: [[r.west, r.north], [r.east, r.north], [r.east, r.south], [r.west, r.south]],
  }
}
