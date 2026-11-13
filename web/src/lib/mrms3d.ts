/**
 * Observed radar in 3D: NOAA's MRMS merged reflectivity at fixed heights (MergedReflectivityQC,
 * 0.5 to 19 km above sea level), read from the public AWS bucket like the 2D composite. Each frame
 * takes the levels every 500 m from 0.5 to 9 km and at 10, 11 and 12 km (21 files, about 10 MB),
 * decodes them in workers at 0.04° (taking each block's strongest echo, as the 2D layer does), and
 * packs them onto the 3D view's heights (0 – 12 km every 500 m), filling 9.5, 10.5 and 11.5 km
 * between their neighbours and copying 0.5 km to the ground.
 *
 * The frames are listed up front (hourly over the last 6 hours of the briefing's window and every
 * 10 minutes over the last hour), but each is only downloaded when the clock reaches it.
 */
import { decode, listDay } from "./mrms"
import type { VolumeEntry, VolumeVar } from "./volume"

const HOUR = 3600e3
const FACTOR = 4                                       // 0.01° → 0.04°
const NZ = 25, TOP_KM = 12, DZ = 0.5
/** The file levels (km) to read, and the folder name for each. */
const FILE_KM = [...Array.from({ length: 18 }, (_, i) => 0.5 + i * 0.5), 10, 11, 12]
const product = (km: number) => `CONUS/MergedReflectivityQC_${km.toFixed(2).padStart(5, "0")}`
const MAX_DBZ = 75

export const MRMS3D_MODEL = "MRMS radar"

/** The frames to offer and a volume entry for them, or null when there are none. */
export async function mrms3dEntry(start: number, box: { west: number; south: number; east: number; north: number }, now = Date.now()): Promise<VolumeEntry | null> {
  const end = Math.min(now, start + 48 * HOUR)
  if (end <= start) return null
  const from = Math.max(start, end - 6 * HOUR)
  const days = new Set([new Date(from).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10)])
  // the scan times, from one level's folder (every level shares them)
  const files = (await Promise.all([...days].map((d) => listDay(d, product(3)).catch(() => [])))).flat().sort((a, b) => a.t - b.t)
  if (!files.length) return null
  const want: number[] = []
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= end; t += HOUR) want.push(t)
  for (let t = Math.ceil(Math.max(from, end - HOUR) / 600e3) * 600e3; t <= end; t += 600e3) want.push(t)
  const picked = new Map<number, number>()             // scan time → wanted time
  for (const t of [...new Set(want)].sort((a, b) => a - b)) {
    let best: { t: number } | null = null
    for (const f of files) if (Math.abs(f.t - t) <= 5 * 60e3 && (!best || Math.abs(f.t - t) < Math.abs(best.t - t))) best = f
    if (best && !picked.has(best.t)) picked.set(best.t, t)
  }
  const last = files[files.length - 1]
  if (last.t > from && last.t <= end + 60e3) picked.set(last.t, last.t)
  const scans = [...picked.keys()].sort((a, b) => a - b)
  if (!scans.length) return null
  const keyOf = (t: number, km: number) => {
    const iso = new Date(t).toISOString(), ymd = iso.slice(0, 10).replace(/-/g, ""), hms = iso.slice(11, 19).replace(/:/g, "")
    const lv = km.toFixed(2).padStart(5, "0")
    return `${product(km)}/${ymd}/MRMS_MergedReflectivityQC_${lv}_${ymd}-${hms}.grib2.gz`
  }
  // the grid: from the smallest file (12 km) of the newest scan
  const g = await decode(keyOf(scans[scans.length - 1], 12), box, FACTOR)
  const nx = g.width, ny = g.height, nxy = nx * ny, per = nxy * NZ
  const cw = (g.east - g.west) / nx, ch = (g.north - g.south) / ny
  const data = new Uint8Array(per * scans.length)
  const state = new Map<number, Promise<void>>()
  const done = new Set<number>()
  const load = (step: number) => {
    if (!state.has(step)) {
      const t = scans[step]
      const p = Promise.all(FILE_KM.map((km) => decode(keyOf(t, km), box, FACTOR).then((d) => d.data, () => null))).then((levels) => {
        if (levels.every((l) => !l)) throw new Error("no levels for this scan")
        const byKm = new Map(FILE_KM.map((km, i) => [km, levels[i]]))
        const level = (km: number): ((i: number) => number) => {
          const at = (a: Float32Array | null | undefined, i: number) => (a && a.length === nxy && a[i] === a[i] ? a[i] : NaN)
          if (km < 0.5) return (i) => at(byKm.get(0.5), i)
          if (byKm.has(km)) { const a = byKm.get(km); return (i) => at(a, i) }
          const lo = byKm.get(Math.floor(km)), hi = byKm.get(Math.ceil(km))
          return (i) => { const x = at(lo, i), y = at(hi, i); return x === x && y === y ? (x + y) / 2 : x === x ? x : y }
        }
        const base = step * per
        for (let k = 0; k < NZ; k++) {
          const f = level(k * DZ)
          for (let r = 0; r < ny; r++) {
            const src = (ny - 1 - r) * nx                       // decoded rows run north to south; the volume's south to north
            for (let c = 0; c < nx; c++) {
              const v = f(src + c)
              data[base + k * nxy + r * nx + c] = v === v && v > 0 ? Math.round(Math.min(1, v / MAX_DBZ) * 254) : 0
            }
          }
        }
        done.add(step)
      })
      p.catch(() => state.delete(step))
      state.set(step, p)
    }
    return state.get(step)!
  }
  const v: VolumeVar = {
    path: `mrms3d/${scans[0]}-${scans[scans.length - 1]}`, min: 0, max: MAX_DBZ, scale: "linear", units: "dBZ", label: "Reflectivity",
    note: "From NOAA's MRMS 3D mosaic; each frame downloads when the clock reaches it.",
    make: async () => data,
    lazy: { load, ready: (s) => done.has(s) },
  }
  return {
    model: MRMS3D_MODEL, run: "observed", times: scans.map((t) => new Date(t).toISOString()),
    nx, ny, nz: NZ, topKm: TOP_KM, dzKm: DZ,
    lat: [g.south + ch / 2, g.north - ch / 2], lon: [g.west + cw / 2, g.east - cw / 2],
    levels: [], vars: { dbz: v },
  }
}
