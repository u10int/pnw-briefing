/**
 * Observed radar from NOAA's MRMS composite reflectivity, read straight from the public AWS bucket
 * in the browser: the files are listed, then fetched and decoded in a worker when the map needs
 * them (see mrms-decode.ts). Nothing is stored with the briefing; the browser cache and a small
 * in-memory store keep frames already seen.
 *
 * Frames: every hour from the briefing's cycle (its forecast start), and every 10 minutes over
 * the last 3 hours when those fall inside the window, up to 48 hours after the cycle or now.
 */
import type { Bbox, Decoded } from "./mrms-decode"
import type { FieldFile } from "./fields"
import { MRMS_MODEL } from "./mrms-name"
import type { FieldEntry } from "@/types"

const BUCKET = "https://noaa-mrms-pds.s3.amazonaws.com/"
const PRODUCT = "CONUS/MergedReflectivityQCComposite_00.50"
const HOUR = 3600e3

/** File keys for a UTC day, with their valid times. */
async function listDay(day: string): Promise<{ t: number; key: string }[]> {
  const out: { t: number; key: string }[] = []
  let token = ""
  for (let page = 0; page < 3; page++) {
    const url = `${BUCKET}?list-type=2&prefix=${PRODUCT}/${day.replace(/-/g, "")}/${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`
    const xml = await (await fetch(url, { cache: "no-cache" })).text()
    for (const m of xml.matchAll(/<Key>([^<]+_(\d{8})-(\d{6})\.grib2\.gz)<\/Key>/g)) {
      const [, key, d, hms] = m
      out.push({ key, t: Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +hms.slice(0, 2), +hms.slice(2, 4), +hms.slice(4, 6)) })
    }
    const next = xml.match(/<NextContinuationToken>([^<]+)</)
    if (!next) break
    token = next[1]
  }
  return out
}

/** The frames to offer, as a field entry the map treats like a model's (one layer: radar). */
export async function mrmsEntry(start: number, box: Bbox, now = Date.now()): Promise<FieldEntry | null> {
  const end = Math.min(now, start + 48 * HOUR)
  if (end <= start) return null
  const days = new Set<string>()
  for (let t = start - HOUR; t <= end + HOUR; t += 6 * HOUR) days.add(new Date(t).toISOString().slice(0, 10))
  days.add(new Date(end).toISOString().slice(0, 10))
  const files = (await Promise.all([...days].map((d) => listDay(d).catch(() => [])))).flat().sort((a, b) => a.t - b.t)
  if (!files.length) return null
  const nearest = (t: number, tol: number) => {
    let best: { t: number; key: string } | null = null
    for (const f of files) if (Math.abs(f.t - t) <= tol && (!best || Math.abs(f.t - t) < Math.abs(best.t - t))) best = f
    return best
  }
  const want: number[] = []
  for (let t = Math.ceil(start / HOUR) * HOUR; t <= end; t += HOUR) want.push(t)
  const recent = Math.max(start, end - 3 * HOUR)
  for (let t = Math.ceil(recent / 600e3) * 600e3; t <= end; t += 600e3) want.push(t)
  const picked = new Map<string, number>()
  for (const t of [...new Set(want)].sort((a, b) => a - b)) {
    const f = nearest(t, 5 * 60e3)
    if (f && !picked.has(f.key)) picked.set(f.key, t)
  }
  // and the newest file, so the loop ends at the latest scan
  const last = files[files.length - 1]
  if (last.t <= end + 60e3 && last.t > start && !picked.has(last.key)) picked.set(last.key, last.t)
  const frames = [...picked.entries()].sort((a, b) => a[1] - b[1])
  if (!frames.length) return null
  const times = frames.map(([, t]) => new Date(t).toISOString())
  return {
    path: `mrms:${box.west},${box.south},${box.east},${box.north}`, model: MRMS_MODEL, tier: "observed", var: "refc",
    units: "dBZ", scale: 1, nodata: NaN, times, run: "observed", init: times[0], keys: frames.map(([k]) => k),
  }
}

// ------------------------------------------------------------------ decoding, in workers

type Reply = (Decoded & { id: number }) | { id: number; error: string }
let workers: Worker[] = []
let next = 0, seq = 0
const waiting = new Map<number, { ok: (d: Decoded) => void; fail: (e: Error) => void }>()

function worker(): Worker {
  if (!workers.length) {
    const n = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))
    workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL("./mrms.worker.ts", import.meta.url), { type: "module" })
      w.onmessage = (ev: MessageEvent<Reply>) => {
        const r = ev.data, p = waiting.get(r.id)
        if (!p) return
        waiting.delete(r.id)
        if ("error" in r) p.fail(new Error(r.error))
        else p.ok(r)
      }
      return w
    })
  }
  return workers[next++ % workers.length]
}

function decode(key: string, box: Bbox, factor: number): Promise<Decoded> {
  return new Promise((ok, fail) => {
    const id = ++seq
    waiting.set(id, { ok, fail })
    worker().postMessage({ id, url: BUCKET + key, box, factor })
  })
}

const frames = new Map<string, Promise<Decoded>>()     // by key; a few hundred KB each
const MAX_FRAMES = 120

/** The entry as a field file: band i is the decoded frame for times[i]. The grid comes from the
 *  first frame decoded; every MRMS file shares it. */
export async function mrmsField(e: FieldEntry): Promise<FieldFile> {
  const [west, south, east, north] = e.path.slice(5).split(",").map(Number)
  const box = { west, south, east, north }
  const keys = e.keys ?? []
  const get = (i: number) => {
    const k = keys[i]
    if (!frames.has(k)) {
      if (frames.size >= MAX_FRAMES) frames.delete(frames.keys().next().value!)
      const p = decode(k, box, 2)
      p.catch(() => frames.delete(k))
      frames.set(k, p)
    }
    return frames.get(k)!
  }
  const first = await get(keys.length - 1)
  return {
    entry: e, width: first.width, height: first.height, west: first.west, south: first.south, east: first.east, north: first.north,
    band: async (i: number) => (await get(i)).data,
  }
}
