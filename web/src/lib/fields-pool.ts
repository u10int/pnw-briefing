import type { Grid } from "./grid"

type Lines = GeoJSON.FeatureCollection<GeoJSON.MultiLineString, { value: number }>
type Centres = GeoJSON.FeatureCollection<GeoJSON.Point, { kind: "H" | "L"; value: number }>

export type FieldJob =
  | { id: number; op: "decode"; url: string; first?: boolean }
  | { id: number; op: "contour"; grid: Grid; data: Float32Array; thresholds: number[]; passes: number }
  | { id: number; op: "isobars"; grid: Grid; data: Float32Array; thresholds: number[]; passes: number; centrePasses: number }
export type Decoded = Grid & { bands: ArrayLike<number>[] }
export type FieldReply =
  | ({ id: number; op: "decode" } & Decoded)
  | { id: number; op: "contour"; lines: Lines }
  | { id: number; op: "isobars"; lines: Lines; centers: Centres }
  | { id: number; op: "error"; error: string }

/* A small pool of field workers. Jobs go to the worker with the fewest waiting, so a big file's
 * decode doesn't hold up the contours for the step on screen. */
let pool: { w: Worker; busy: number; dead?: boolean }[] | null = null
let seq = 0
const WORKER_FAILED = "field worker failed"
const waiting = new Map<number, { ok: (r: FieldReply) => void; fail: (e: Error) => void; slot: { busy: number } }>()

function workers() {
  if (pool) return pool
  pool = []
  if (typeof Worker === "undefined") return pool
  const n = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))
  for (let k = 0; k < n; k++) {
    try {
      const w = new Worker(new URL("./fields.worker.ts", import.meta.url), { type: "module" })
      const slot: { w: Worker; busy: number; dead?: boolean } = { w, busy: 0 }
      // a worker that can't start (no module workers) fails its jobs, which then run on the page
      w.onerror = () => {
        slot.dead = true
        for (const [id, p] of waiting) if (p.slot === slot) { waiting.delete(id); p.fail(new Error(WORKER_FAILED)) }
      }
      w.onmessage = (ev: MessageEvent<FieldReply>) => {
        const r = ev.data, p = waiting.get(r.id)
        if (!p) return
        waiting.delete(r.id)
        p.slot.busy--
        if (r.op === "error") p.fail(new Error(r.error))
        else p.ok(r)
      }
      pool.push(slot)
    } catch { /* no module workers: decode on the page */ }
  }
  return pool
}

type NewJob = FieldJob extends infer J ? (J extends FieldJob ? Omit<J, "id"> : never) : never
function run<R extends FieldReply>(job: NewJob): Promise<R> | null {
  const ws = workers().filter((w) => !w.dead)
  if (!ws.length) return null
  const slot = ws.reduce((a, b) => (b.busy < a.busy ? b : a))
  const id = ++seq
  slot.busy++
  return new Promise<R>((ok, fail) => {
    waiting.set(id, { ok: ok as (r: FieldReply) => void, fail, slot })
    slot.w.postMessage({ ...job, id })
  })
}

/** Fetch and decode a GeoTIFF (every band, or only the first) in a worker; on the page if workers aren't available. */
export async function decodeTiff(url: string, first = false): Promise<Decoded> {
  const abs = url.startsWith("data:") ? url : new URL(url, location.href).href
  const p = run<Extract<FieldReply, { op: "decode" }>>({ op: "decode", url: abs, first })
  if (p) { try { return await p } catch (e) { if ((e as Error).message !== WORKER_FAILED) throw e } }
  const { fromArrayBuffer } = await import("geotiff")
  const res = await fetch(abs)
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage()
  const [west, south, east, north] = img.getBoundingBox()
  const bands = (await img.readRasters({ interleave: false, samples: first ? [0] : undefined })) as unknown as ArrayLike<number>[]
  return { width: img.getWidth(), height: img.getHeight(), west, south, east, north, bands: Array.from(bands) }
}

const plain = (g: Grid): Grid => ({ width: g.width, height: g.height, west: g.west, south: g.south, east: g.east, north: g.north })

/** Contour lines for a band, worked out in a worker. */
export async function contourAsync(g: Grid, data: Float32Array, thresholds: number[], passes: number): Promise<Lines> {
  const p = run<Extract<FieldReply, { op: "contour" }>>({ op: "contour", grid: plain(g), data, thresholds, passes })
  if (p) { try { return (await p).lines } catch (e) { if ((e as Error).message !== WORKER_FAILED) throw e } }
  const { contourLines } = await import("./contours")
  return contourLines(g, data, thresholds, passes)
}

/** Isobars and pressure centres for a sea-level pressure band, worked out in a worker. */
export async function isobarsAsync(g: Grid, data: Float32Array, thresholds: number[], passes: number): Promise<{ lines: Lines; centers: Centres }> {
  const centrePasses = g.width > 120 ? 4 : 2
  const p = run<Extract<FieldReply, { op: "isobars" }>>({ op: "isobars", grid: plain(g), data, thresholds, passes, centrePasses })
  if (p) { try { return await p } catch (e) { if ((e as Error).message !== WORKER_FAILED) throw e } }
  const { contourLines, pressureCenters } = await import("./contours")
  return { lines: contourLines(g, data, thresholds, passes), centers: pressureCenters(g, data) }
}
