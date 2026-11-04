import { fromArrayBuffer } from "geotiff"

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
