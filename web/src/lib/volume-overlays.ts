import { mercY } from "@/lib/gl/util"
import { heightRgb, unpack, type VolumeEntry, type VolumeVar } from "@/lib/volume"
import { isolines } from "@/lib/xsection"

/** Lines drawn in the 3D box: [x, y, z, r, g, b, a] per vertex (box coordinates, premultiplied
 *  colour), in pairs; and labels to place on screen at box points. */
export interface Overlay { verts: Float32Array; tris?: Float32Array; labels: { x: number; y: number; z: number; text: string }[] }

const R_E = 6371008.8

/** Box coordinates for the grid's rows and columns: x is linear in longitude, y in Web Mercator. */
function boxOf(e: VolumeEntry) {
  const yN = mercY(e.lat[1]), yS = mercY(e.lat[0])
  return {
    bx: (lon: number) => (lon - e.lon[0]) / (e.lon[1] - e.lon[0]),
    by: (lat: number) => (mercY(lat) - yN) / (yS - yN),
    latOfRow: (r: number) => e.lat[0] + (r / (e.ny - 1)) * (e.lat[1] - e.lat[0]),
  }
}

/** A field's value at fractional grid coordinates (column, row, height index) at one step, trilinear. */
function sampler(e: VolumeEntry, data: Uint8Array, v: VolumeVar, fill = 0) {
  const { nx, ny, nz } = e
  const per = nx * ny * nz
  const lut = new Float32Array(256)
  for (let b = 0; b < 256; b++) lut[b] = b === 255 ? fill : unpack(b, v)
  return (step: number, fx: number, fy: number, fz: number) => {
    const x0 = Math.max(0, Math.min(nx - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(ny - 2, Math.floor(fy))), z0 = Math.max(0, Math.min(nz - 2, Math.floor(fz)))
    const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0)), az = Math.min(1, Math.max(0, fz - z0))
    const base = Math.min(step, e.times.length - 1) * per
    let s = 0
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1
      s += lut[data[base + (z0 + dz) * nx * ny + (y0 + dy) * nx + x0 + dx]] * (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az)
    }
    return s
  }
}

/**
 * A pressure level as a map in the box: its height contours (from the level's own heights, every
 * 30 m at 850 and 700 mb, 60 m above) at its average height, labelled in decametres, and wind arrows.
 */
export function levelOverlay(e: VolumeEntry, hPa: number, hgt: Uint8Array, wind: { u: Uint8Array; v: Uint8Array } | null,
                             i0: number, i1: number, t: number): Overlay | null {
  const hv = e.vars.hgt
  const L = hv?.hPa?.indexOf(hPa) ?? -1
  if (!hv || L < 0 || !hv.meanM) return null
  const { nx, ny } = e
  const nL = hv.hPa!.length
  const per = nx * ny
  const mean = hv.meanM[L]
  const z = mean / 1000 / e.topKm
  if (z <= 0 || z >= 1) return null
  const f = new Float32Array(per)
  const a0 = (Math.min(i0, e.times.length - 1) * nL + L) * per, a1 = (Math.min(i1, e.times.length - 1) * nL + L) * per
  let lo = Infinity, hi = -Infinity
  for (let k = 0; k < per; k++) {
    const b0 = hgt[a0 + k], b1 = hgt[a1 + k]
    const x = b0 === 255 || b1 === 255 ? NaN : mean + unpack(b0, hv) * (1 - t) + unpack(b1, hv) * t
    f[k] = x
    if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x) }
  }
  const { bx, by, latOfRow } = boxOf(e)
  const lonOf = (c: number) => e.lon[0] + (c / (nx - 1)) * (e.lon[1] - e.lon[0])
  const out: number[] = []
  const labels: Overlay["labels"] = []
  const tris: number[] = []
  const step = hPa >= 700 ? 30 : 60
  const line = [0.12, 0.16, 0.24, 0.85]
  for (let lev = Math.ceil(lo / step) * step; lev <= hi; lev += step) {
    const seg = isolines(f, ny, nx, lev)
    let best = -1, bestD = Infinity
    for (let s = 0; s < seg.length; s += 4) {
      const [c0, r0, c1, r1] = [seg[s], seg[s + 1], seg[s + 2], seg[s + 3]]
      const p0 = [bx(lonOf(c0)), by(latOfRow(r0))], p1 = [bx(lonOf(c1)), by(latOfRow(r1))]
      out.push(p0[0], p0[1], z, ...line, p1[0], p1[1], z, ...line)
      // label each line once, near the box's west-centre
      const d = Math.hypot((p0[0] + p1[0]) / 2 - 0.25, (p0[1] + p1[1]) / 2 - 0.5)
      if (d < bestD) { bestD = d; best = s }
    }
    if (best >= 0) {
      const c = (seg[best] + seg[best + 2]) / 2, r = (seg[best + 1] + seg[best + 3]) / 2
      labels.push({ x: bx(lonOf(c)), y: by(latOfRow(r)), z, text: String(Math.round(lev / 10)) })
    }
  }
  // wind arrows every few cells, from the wind at the level's height
  if (wind && e.vars.u && e.vars.v) {
    const su = sampler(e, wind.u, e.vars.u), sv = sampler(e, wind.v, e.vars.v)
    const fz = z * (e.nz - 1)
    const midLat = (e.lat[0] + e.lat[1]) / 2
    const wM = (e.lon[1] - e.lon[0]) * 111320 * Math.cos((midLat * Math.PI) / 180), hM = (e.lat[1] - e.lat[0]) * 110540
    const every = Math.max(2, Math.round(Math.max(nx, ny) / 13))
    const cell = every / (nx - 1)
    for (let r = Math.floor(every / 2); r < ny; r += every) {
      for (let c = Math.floor(every / 2); c < nx; c += every) {
        const u = su(i0, c, r, fz) * (1 - t) + su(i1, c, r, fz) * t, v = sv(i0, c, r, fz) * (1 - t) + sv(i1, c, r, fz) * t
        const sp = Math.hypot(u, v)
        if (sp < 2) continue
        // in box units (east, south) with true proportions: its length grows with speed
        const Lm = cell * wM * (0.35 + 0.65 * Math.min(1, sp / 60))
        const dx = ((u / sp) * Lm) / wM, dy = (-(v / sp) * Lm) / hM
        const x0 = bx(lonOf(c)) - dx / 2, y0 = by(latOfRow(r)) - dy / 2, x1 = x0 + dx, y1 = y0 + dy
        const k = Math.min(1, sp / 70)
        const col = [0.3 + 0.35 * k, 0.25 * (1 - k) + 0.12, 0.75 - 0.3 * k].map((x) => x * 0.95)
        // a solid arrow (a shaft and a barbed head), shaped in metres so it keeps its proportions;
        // the widths follow the spacing rather than the length, so slow arrows stay slim
        const ex = dx * wM / Lm, ey = dy * hM / Lm          // unit vector along the wind, in metres
        const nxm = -ey, nym = ex                           // and across it
        const cw = cell * wM
        const shaft = cw * 0.025, half = cw * 0.1, head = Math.min(Lm * 0.45, cw * 0.2)
        const P = (along: number, across: number): number[] =>
          [x0 + (ex * along + nxm * across) / wM, y0 + (ey * along + nym * across) / hM, z, ...col, 1]
        // a swept-back head: the wings trail behind a notch on the shaft, so their back edges angle in to it
        const notch = Lm - head * 0.65, wing = Lm - head
        tris.push(...P(0, shaft), ...P(0, -shaft), ...P(notch, shaft),
                  ...P(notch, shaft), ...P(0, -shaft), ...P(notch, -shaft),
                  ...P(Lm, 0), ...P(wing, half), ...P(notch, 0),
                  ...P(Lm, 0), ...P(notch, 0), ...P(wing, -half))
      }
    }
  }
  return { verts: Float32Array.from(out), tris: Float32Array.from(tris), labels }
}

/**
 * Where the air arriving over each location at the map's time came from: backward trajectories
 * through the model's wind (u, v and, when it's there, w) over up to `hours`, from about 1.5 and
 * 3 km, coloured by height and fading into the past.
 */
export function trajectories(e: VolumeEntry, points: { lat: number; lon: number }[], wind: { u: Uint8Array; v: Uint8Array },
                             w: Uint8Array | null, timeMs: number, hours = 24, startsKm = [1.5, 3]): Overlay {
  const ms = e.times.map((x) => Date.parse(x))
  const su = sampler(e, wind.u, e.vars.u), sv = sampler(e, wind.v, e.vars.v)
  const sw = w && e.vars.w ? sampler(e, w, e.vars.w) : null
  const { bx, by } = boxOf(e)
  const out: number[] = []
  const at = (tm: number, lon: number, lat: number, km: number): [number, number, number] => {
    let k = 0
    while (k < ms.length - 2 && tm > ms[k + 1]) k++
    const tt = ms.length > 1 ? Math.min(1, Math.max(0, (tm - ms[k]) / (ms[k + 1] - ms[k]))) : 0
    const k1 = Math.min(k + 1, ms.length - 1)
    const fx = ((lon - e.lon[0]) / (e.lon[1] - e.lon[0])) * (e.nx - 1), fy = ((lat - e.lat[0]) / (e.lat[1] - e.lat[0])) * (e.ny - 1)
    const fz = (km / e.topKm) * (e.nz - 1)
    const one = (s: (st: number, a: number, b: number, c: number) => number) => s(k, fx, fy, fz) * (1 - tt) + s(k1, fx, fy, fz) * tt
    return [one(su), one(sv), sw ? one(sw) : 0]
  }
  const DT = 900                                                     // s
  const t0 = Math.max(ms[0], timeMs - hours * 3600e3)
  for (const p of points) {
    if (p.lon < e.lon[0] || p.lon > e.lon[1] || p.lat < e.lat[0] || p.lat > e.lat[1]) continue
    for (const km0 of startsKm) {
      const path: [number, number, number][] = [[p.lon, p.lat, km0]]
      let lon = p.lon, lat = p.lat, km = km0
      for (let tm = timeMs; tm - DT * 1000 >= t0; tm -= DT * 1000) {
        // midpoint (RK2) step backwards
        const [u1, v1, w1] = at(tm, lon, lat, km)
        const mlon = lon - (u1 * DT / 2) / (R_E * Math.cos((lat * Math.PI) / 180)) * (180 / Math.PI)
        const mlat = lat - (v1 * DT / 2) / R_E * (180 / Math.PI)
        const mkm = Math.max(0.05, km - (w1 * DT / 2) / 1000)
        const [u2, v2, w2] = at(tm - DT * 500, mlon, mlat, mkm)
        lon -= (u2 * DT) / (R_E * Math.cos((lat * Math.PI) / 180)) * (180 / Math.PI)
        lat -= (v2 * DT) / R_E * (180 / Math.PI)
        km = Math.min(e.topKm, Math.max(0.05, km - (w2 * DT) / 1000))
        if (lon < e.lon[0] || lon > e.lon[1] || lat < e.lat[0] || lat > e.lat[1]) break
        path.push([lon, lat, km])
      }
      const n = path.length
      for (let i = 0; i < n - 1; i++) {
        const a = path[i], b = path[i + 1]
        const fa = 0.95 - 0.7 * (i / Math.max(1, n - 1)), fb = 0.95 - 0.7 * ((i + 1) / Math.max(1, n - 1))
        const ca = heightRgb(a[2]).map((c) => c / 255), cb = heightRgb(b[2]).map((c) => c / 255)
        out.push(bx(a[0]), by(a[1]), a[2] / e.topKm, ca[0] * fa, ca[1] * fa, ca[2] * fa, fa,
                 bx(b[0]), by(b[1]), b[2] / e.topKm, cb[0] * fb, cb[1] * fb, cb[2] * fb, fb)
      }
      // a short stalk down from the arrival point, so it reads against the location
      const g = [0.2, 0.22, 0.28, 0.6]
      out.push(bx(p.lon), by(p.lat), 0, ...g, bx(p.lon), by(p.lat), km0 / e.topKm, ...g)
    }
  }
  return { verts: Float32Array.from(out), labels: [] }
}

/** A small, fixed hash of two integers to [0, 1): the same cell keeps the same dots as time moves. */
function hash01(a: number, b: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/**
 * The field as a cloud of dots: each cell gets dots in proportion to how thick it draws (the
 * view's opacity table), scattered through the cell and coloured by `rgb` (0–1 for a cell and the
 * blended value's byte). At most about `cap` dots; returns [x, y, z, r, g, b, a] per dot.
 */
export function pointCloud(e: VolumeEntry, data: Uint8Array, lut: Uint8Array, i0: number, i1: number, t: number,
                           range: [number, number], rgb: (cell: number, b: number, km: number) => [number, number, number], cap = 120000): Float32Array {
  const { nx, ny, nz } = e
  const per = nx * ny * nz
  const a0 = Math.min(i0, e.times.length - 1) * per, a1 = Math.min(i1, e.times.length - 1) * per
  const k0 = Math.max(0, Math.ceil((range[0] / e.topKm) * (nz - 1))), k1 = Math.min(nz - 1, Math.floor((range[1] / e.topKm) * (nz - 1)))
  const pr = new Float32Array(per), bb = new Uint8Array(per)
  let sum = 0
  for (let k = k0; k <= k1; k++) {
    for (let i = k * nx * ny, end = i + nx * ny; i < end; i++) {
      const b0 = data[a0 + i], b1 = data[a1 + i]
      if (b0 === 255 || b1 === 255) continue
      const b = Math.round(b0 * (1 - t) + b1 * t)
      const ext = (lut[b * 4 + 3] / 255) * 4
      if (ext <= 0) continue
      const p = 1 - Math.exp(-ext * 1.5)
      pr[i] = p; bb[i] = b; sum += p
    }
  }
  if (!sum) return new Float32Array(0)
  const K = Math.min(14, cap / sum)                       // dots for a fully thick cell
  const out = new Float32Array(Math.ceil(sum * K + per) * 7)
  let o = 0
  const yN = mercY(e.lat[1]), yS = mercY(e.lat[0])
  const rowY = new Float32Array(ny * 2 + 1)                // box y at half-row steps
  for (let h = 0; h <= ny * 2; h++) rowY[h] = (mercY(e.lat[0] + ((h / 2 - 0.5) / (ny - 1)) * (e.lat[1] - e.lat[0])) - yN) / (yS - yN)
  for (let i = 0; i < per; i++) {
    const p = pr[i]
    if (!p) continue
    const n = p * K
    const c = i % nx, r = Math.floor(i / nx) % ny, k = Math.floor(i / (nx * ny))
    for (let j = 0; j < Math.ceil(n); j++) {
      if (j >= Math.floor(n) && hash01(i, j * 4) >= n - Math.floor(n)) break
      const jx = hash01(i, j * 4 + 1) - 0.5, jy = hash01(i, j * 4 + 2) - 0.5, jz = hash01(i, j * 4 + 3) - 0.5
      const x = Math.min(1, Math.max(0, (c + jx) / (nx - 1)))
      const fy = Math.min(ny * 2, Math.max(0, (r + 0.5 + jy) * 2))
      const y = rowY[Math.floor(fy)] + (rowY[Math.min(ny * 2, Math.floor(fy) + 1)] - rowY[Math.floor(fy)]) * (fy - Math.floor(fy))
      const z = Math.min(1, Math.max(0, (k + jz) / (nz - 1)))
      const km = z * e.topKm
      if (km < range[0] || km > range[1]) continue
      const col = rgb(i, bb[i], km)
      const a = 0.2 + 0.75 * p
      out[o++] = x; out[o++] = Math.min(1, Math.max(0, y)); out[o++] = z
      out[o++] = col[0] * a; out[o++] = col[1] * a; out[o++] = col[2] * a; out[o++] = a
    }
  }
  return out.subarray(0, o)
}
