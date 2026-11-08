/**
 * Decode one MRMS GRIB2 file (gzipped, PNG-packed: template 5.41) into a cropped grid of values.
 * Plain functions with no DOM, so they run in a worker (mrms.worker.ts) or anywhere else.
 *
 * GRIB2 sections read: 3 (lat/lon grid: size, first point, increments, scan order), 5 (packing:
 * reference value R, binary scale E, decimal scale D) and 7 (a 16-bit greyscale PNG of the packed
 * integers X; value = (R + X·2^E) / 10^D). Only the PNG rows down to the crop's southern edge are
 * inflated and unfiltered, since the Pacific Northwest sits near the top of the CONUS grid.
 */

export interface Bbox { west: number; south: number; east: number; north: number }
export interface Decoded { width: number; height: number; west: number; south: number; east: number; north: number; data: Float32Array }

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
/** GRIB2 signed integers are sign-and-magnitude, not two's complement. */
const s32 = (b: Uint8Array, o: number) => { const v = u32(b, o); return v & 0x80000000 ? -(v & 0x7fffffff) : v }
const s16 = (b: Uint8Array, o: number) => { const v = (b[o] << 8) | b[o + 1]; return v & 0x8000 ? -(v & 0x7fff) : v }

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

/** The first `need` bytes of a zlib stream, stopping the inflate there. */
async function inflatePrefix(parts: Uint8Array[], need: number): Promise<Uint8Array> {
  const reader = new Blob(parts as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate")).getReader()
  const out = new Uint8Array(need)
  let n = 0
  while (n < need) {
    const { value, done } = await reader.read()
    if (done) break
    const take = Math.min(value.length, need - n)
    out.set(value.subarray(0, take), n)
    n += take
  }
  reader.cancel().catch(() => {})
  if (n < need) throw new Error(`PNG data ended after ${n} of ${need} bytes`)
  return out
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Undo PNG row filters in place for rows 0..rows-1 (bpp bytes per pixel). */
function unfilter(raw: Uint8Array, rowBytes: number, rows: number, bpp: number) {
  const stride = rowBytes + 1
  for (let r = 0; r < rows; r++) {
    const o = r * stride, f = raw[o], prev = o - stride
    for (let i = 1; i <= rowBytes; i++) {
      const a = i > bpp ? raw[o + i - bpp] : 0
      const b = r > 0 ? raw[prev + i] : 0
      const c = r > 0 && i > bpp ? raw[prev + i - bpp] : 0
      let x = raw[o + i]
      if (f === 1) x += a
      else if (f === 2) x += b
      else if (f === 3) x += (a + b) >> 1
      else if (f === 4) x += paeth(a, b, c)
      raw[o + i] = x & 0xff
    }
  }
}

/**
 * Values in `box` from one file, as a grid (row 0 north), reduced `factor`× by taking the highest
 * value in each block so storm cores survive. Values below `floor` (MRMS uses -99 for no echo and
 * -999 for no coverage) become NaN.
 */
export async function decodeMrms(gz: ArrayBuffer, box: Bbox, factor = 2, floor = -30): Promise<Decoded> {
  const b = await gunzip(gz)
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== "GRIB") throw new Error("not a GRIB file")
  let p = 16, s3 = -1, s5 = -1, s7 = -1
  while (p < b.length - 4) {
    if (b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37) break   // "7777"
    const len = u32(b, p), num = b[p + 4]
    if (num === 3) s3 = p
    else if (num === 5) s5 = p
    else if (num === 7) { s7 = p; break }
    p += len
  }
  if (s3 < 0 || s5 < 0 || s7 < 0) throw new Error("missing GRIB sections")
  if (((b[s3 + 12] << 8) | b[s3 + 13]) !== 0) throw new Error("not a lat/lon grid")
  if (((b[s5 + 9] << 8) | b[s5 + 10]) !== 41) throw new Error("not PNG packing")
  const ni = u32(b, s3 + 30), nj = u32(b, s3 + 34)
  const la1 = s32(b, s3 + 46) / 1e6
  let lo1 = s32(b, s3 + 50) / 1e6
  if (lo1 > 180) lo1 -= 360
  const di = u32(b, s3 + 63) / 1e6, dj = u32(b, s3 + 67) / 1e6
  const scan = b[s3 + 71]
  // only west→east, north→south rows (the MRMS layout) are handled
  if (scan & 0x80 || scan & 0x40) throw new Error(`unexpected scanning mode ${scan}`)
  const R = new DataView(b.buffer, b.byteOffset + s5 + 11, 4).getFloat32(0)
  const E = s16(b, s5 + 15), D = s16(b, s5 + 17)
  const k2 = 2 ** E, k10 = 10 ** -D

  // PNG inside section 7
  const len7 = u32(b, s7)
  const png = b.subarray(s7 + 5, s7 + len7)
  const w = u32(png, 16), h = u32(png, 20), depth = png[24], color = png[25]
  if (w !== ni || h !== nj || color !== 0 || (depth !== 16 && depth !== 8)) throw new Error("unexpected PNG layout")
  const bpp = depth / 8
  const parts: Uint8Array[] = []
  for (let q = 8; q < png.length;) {
    const l = u32(png, q)
    const t = String.fromCharCode(png[q + 4], png[q + 5], png[q + 6], png[q + 7])
    if (t === "IDAT") parts.push(png.subarray(q + 8, q + 8 + l))
    if (t === "IEND") break
    q += 12 + l
  }

  // crop, in whole cells, snapped to the reduction factor
  const r0 = Math.max(0, Math.floor((la1 - box.north) / dj / factor) * factor)
  const r1 = Math.min(nj, Math.ceil((la1 - box.south) / dj / factor) * factor)
  const c0 = Math.max(0, Math.floor((box.west - lo1) / di / factor) * factor)
  const c1 = Math.min(ni, Math.ceil((box.east - lo1) / di / factor) * factor)
  if (r1 <= r0 || c1 <= c0) throw new Error("crop is outside the grid")
  const rowBytes = ni * bpp
  const raw = await inflatePrefix(parts, r1 * (rowBytes + 1))
  unfilter(raw, rowBytes, r1, bpp)

  const W = Math.floor((c1 - c0) / factor), H = Math.floor((r1 - r0) / factor)
  const out = new Float32Array(W * H).fill(NaN)
  for (let r = r0; r < r0 + H * factor; r++) {
    const o = r * (rowBytes + 1) + 1
    const orow = Math.floor((r - r0) / factor) * W
    for (let c = c0; c < c0 + W * factor; c++) {
      const x = bpp === 2 ? (raw[o + 2 * c] << 8) | raw[o + 2 * c + 1] : raw[o + c]
      const v = (R + x * k2) * k10
      if (!(v >= floor)) continue
      const k = orow + Math.floor((c - c0) / factor)
      if (!(out[k] >= v)) out[k] = v
    }
  }
  // cell edges: grid points are cell centres
  return {
    width: W, height: H, data: out,
    west: lo1 + c0 * di - di / 2, east: lo1 + (c0 + W * factor) * di - di / 2,
    north: la1 - r0 * dj + dj / 2, south: la1 - (r0 + H * factor) * dj + dj / 2,
  }
}
