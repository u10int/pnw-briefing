/// <reference lib="webworker" />
import { fromArrayBuffer } from "geotiff"

import { contourLines, pressureCenters, smooth } from "./contours"
import type { FieldJob, FieldReply } from "./fields-pool"

/**
 * GeoTIFF decoding and contouring off the main thread. "decode" fetches a file and returns every
 * band as its own typed array (the buffers are transferred, not copied); "contour" and "isobars"
 * return GeoJSON for a band the page sends.
 */
const post = (r: FieldReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer)

self.onmessage = async (ev: MessageEvent<FieldJob>) => {
  const job = ev.data
  try {
    if (job.op === "decode") {
      const res = await fetch(job.url)
      if (!res.ok) throw new Error(`${job.url} returned ${res.status}`)
      const tiff = await fromArrayBuffer(await res.arrayBuffer())
      const img = await tiff.getImage()
      const [west, south, east, north] = img.getBoundingBox()
      const bands = (await img.readRasters({ interleave: false, samples: job.first ? [0] : undefined })) as unknown as ArrayLike<number>[]
      const arrays = Array.from(bands, (b) => b as unknown as Float32Array)
      const buffers = [...new Set(arrays.map((a) => a.buffer as ArrayBuffer))]
      post({ id: job.id, op: "decode", width: img.getWidth(), height: img.getHeight(), west, south, east, north, bands: arrays }, buffers)
    } else if (job.op === "contour") {
      post({ id: job.id, op: "contour", lines: contourLines(job.grid, job.data, job.thresholds, job.passes) })
    } else {
      const sm = smooth(job.grid, job.data, job.passes)
      post({ id: job.id, op: "isobars", lines: contourLines(job.grid, job.data, job.thresholds, job.passes, sm),
             centers: pressureCenters(job.grid, job.data, 1.5, job.centrePasses === job.passes ? sm : undefined) })
    }
  } catch (e) {
    post({ id: job.id, op: "error", error: String(e) })
  }
}
