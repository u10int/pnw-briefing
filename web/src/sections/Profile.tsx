import * as React from "react"

import { unpack, type VolumeEntry } from "@/lib/volume"
import { terrainProfile, type LonLat } from "@/lib/xsection"

import type { SectionTime } from "./CrossSection"

const FRZ_BLUE = "#1f78d1"
const TEMP_RED = "#c0392b"
const DEW_GREEN = "#2e8b57"

/** One column's values at each height: the field's bytes bilinear at the point, blended in time. */
function column(e: VolumeEntry, name: string, data: Uint8Array, pt: LonLat, { i0, i1, t }: SectionTime): Float32Array {
  const v = e.vars[name]
  const { nx, ny, nz } = e
  const out = new Float32Array(nz).fill(NaN)
  const fx = ((pt[0] - e.lon[0]) / (e.lon[1] - e.lon[0])) * (nx - 1), fy = ((pt[1] - e.lat[0]) / (e.lat[1] - e.lat[0])) * (ny - 1)
  if (!v || fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return out
  const x0 = Math.min(nx - 2, Math.floor(fx)), y0 = Math.min(ny - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0
  const per = nx * ny * nz
  const at = (step: number, z: number) => {
    const base = Math.min(step, e.times.length - 1) * per + z * nx * ny + y0 * nx + x0
    const g = (o: number) => { const b = data[base + o]; return b === 255 ? NaN : unpack(b, v) }
    return (g(0) * (1 - ax) + g(1) * ax) * (1 - ay) + (g(nx) * (1 - ax) + g(nx + 1) * ax) * ay
  }
  for (let z = 0; z < nz; z++) out[z] = t > 0 && i1 !== i0 ? at(i0, z) * (1 - t) + at(i1, z) * t : at(i0, z)
  return out
}
/** Dewpoint (°F) from temperature (°F) and relative humidity (%), Magnus. */
function dewpoint(tF: number, rh: number) {
  const tc = ((tF - 32) * 5) / 9, b = 17.62, c = 243.12
  const g = Math.log(Math.max(1, rh) / 100) + (b * tc) / (c + tc)
  return ((c * g) / (b - g)) * 9 / 5 + 32
}

/**
 * A vertical profile at one point, like a simple sounding: temperature and dewpoint by height (with
 * the freezing line), cloud down the left edge, wind arrows down the right, the ground at the bottom.
 */
export function Profile({ entry, point, place, temp, rh, cloud, wind, time, subscribe }: {
  entry: VolumeEntry; point: LonLat; place: string
  temp: Uint8Array; rh: Uint8Array | null; cloud: Uint8Array | null; wind: { u: Uint8Array; v: Uint8Array } | null
  time: () => SectionTime; subscribe: (fn: () => void) => () => void
}) {
  const cv = React.useRef<HTMLCanvasElement>(null)
  const wrap = React.useRef<HTMLDivElement>(null)
  const [ground, setGround] = React.useState(0)
  const [hover, setHover] = React.useState<{ x: number; y: number; text: string } | null>(null)
  const last = React.useRef<{ T: Float32Array; D: Float32Array | null; C: Float32Array | null; S: Float32Array | null; plot: { x: number; y: number; w: number; h: number } } | null>(null)

  // the ground under the point, from the same terrain as the cross-section
  React.useEffect(() => {
    let live = true
    terrainProfile(entry, { a: point, b: [point[0] + 0.01, point[1]] }, 2).then((t) => { if (live) setGround(t[0]) }).catch(() => {})
    return () => { live = false }
  }, [entry, point])

  const draw = React.useCallback(() => {
    const c = cv.current, box = wrap.current
    if (!c || !box) return
    const dpr = window.devicePixelRatio || 1
    const W = box.clientWidth, H = 260
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr)
      c.style.width = `${W}px`; c.style.height = `${H}px`
    }
    const ctx = c.getContext("2d")!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    const tm = time()
    const T = column(entry, "temp", temp, point, tm)
    const R = rh ? column(entry, "rh", rh, point, tm) : null
    const D = R ? T.map((t, i) => dewpoint(t, R[i])) : null
    const C = cloud ? column(entry, "cloud", cloud, point, tm) : null
    const U = wind ? column(entry, "u", wind.u, point, tm) : null, V = wind ? column(entry, "v", wind.v, point, tm) : null
    const S = U && V ? U.map((u, i) => Math.hypot(u, V[i]) * 2.23694) : null
    const m = { l: 44 * dpr, r: 58 * dpr, t: 8 * dpr, b: 24 * dpr }
    const plot = { x: m.l + 12 * dpr, y: m.t, w: c.width - m.l - m.r - 12 * dpr, h: c.height - m.t - m.b }
    last.current = { T, D, C, S, plot }
    const top = entry.topKm, nz = entry.nz
    const Yk = (km: number) => plot.y + plot.h - (km / top) * plot.h
    const Yz = (z: number) => Yk((z / (nz - 1)) * top)
    // the temperature axis: the column's range, padded, in 10° steps
    const vals = [...T, ...(D ?? [])].filter(Number.isFinite)
    const lo = Math.floor((Math.min(...vals, 20) - 5) / 10) * 10, hi = Math.ceil((Math.max(...vals, 40) + 5) / 10) * 10
    const X = (f: number) => plot.x + ((f - lo) / (hi - lo)) * plot.w
    ctx.font = `${10.5 * dpr}px ui-sans-serif, system-ui, sans-serif`
    // grid and labels
    ctx.strokeStyle = "rgba(0,0,0,0.07)"; ctx.lineWidth = dpr
    ctx.fillStyle = "#59606b"; ctx.textBaseline = "top"; ctx.textAlign = "center"
    // labels far enough apart to read (every 10, 20, 30 or 50°), on round values
    const every = [10, 20, 30, 50].find((st) => (st / (hi - lo)) * plot.w >= 40 * dpr) ?? 50
    for (let f = lo; f <= hi; f += 10) {
      ctx.beginPath(); ctx.moveTo(X(f), plot.y); ctx.lineTo(X(f), plot.y + plot.h); ctx.stroke()
      if (f % every === 0) ctx.fillText(`${f}°`, X(f), plot.y + plot.h + 5 * dpr)
    }
    ctx.textBaseline = "middle"; ctx.textAlign = "right"
    for (let km = 0; km <= top; km += 2) {
      ctx.beginPath(); ctx.moveTo(plot.x, Yk(km)); ctx.lineTo(plot.x + plot.w, Yk(km)); ctx.stroke()
      ctx.fillText(`${km} km`, m.l - 4 * dpr, Yk(km))
    }
    // cloud down the left edge: gray where the model has cloud
    if (C) for (let z = 0; z < nz - 1; z++) {
      const a = Math.max(0, Math.min(1, (C[z] + C[z + 1]) / 200))
      if (a < 0.03) continue
      ctx.fillStyle = `rgba(110,118,130,${(0.15 + 0.7 * a).toFixed(2)})`
      ctx.fillRect(m.l + 2 * dpr, Yz(z + 1), 8 * dpr, Yz(z) - Yz(z + 1))
    }
    // freezing line
    if (32 > lo && 32 < hi) {
      ctx.strokeStyle = FRZ_BLUE; ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr])
      ctx.beginPath(); ctx.moveTo(X(32), plot.y); ctx.lineTo(X(32), plot.y + plot.h); ctx.stroke(); ctx.setLineDash([])
    }
    const line = (arr: Float32Array, color: string, width: number) => {
      ctx.strokeStyle = color; ctx.lineWidth = width * dpr; ctx.lineJoin = "round"
      ctx.beginPath()
      let on = false
      for (let z = 0; z < nz; z++) {
        if (!Number.isFinite(arr[z])) { on = false; continue }
        if (on) ctx.lineTo(X(arr[z]), Yz(z)); else ctx.moveTo(X(arr[z]), Yz(z))
        on = true
      }
      ctx.stroke()
    }
    if (D) line(D, DEW_GREEN, 2)
    line(T, TEMP_RED, 2.2)
    // the ground
    if (ground > 0) {
      ctx.fillStyle = "rgba(92,84,74,0.85)"
      ctx.fillRect(plot.x, Yk(ground), plot.w, plot.y + plot.h - Yk(ground))
    }
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = dpr
    ctx.strokeRect(plot.x, plot.y, plot.w, plot.h)
    // wind arrows down the right, every kilometre: pointing the way the wind blows, with its speed
    if (U && V && S) {
      const ax = plot.x + plot.w + 14 * dpr
      ctx.textAlign = "left"; ctx.fillStyle = "#59606b"
      for (let km = 1; km <= top; km += 1) {
        const z = (km / top) * (nz - 1), z0 = Math.min(nz - 2, Math.floor(z)), f = z - z0
        const u = U[z0] * (1 - f) + U[z0 + 1] * f, v = V[z0] * (1 - f) + V[z0 + 1] * f, sp = Math.hypot(u, v) * 2.23694
        if (!Number.isFinite(sp) || km < ground) continue
        const L = (5 + Math.min(1, sp / 100) * 6) * dpr, a = Math.atan2(-v, u), y = Yk(km)
        const x1 = ax + Math.cos(a) * L, y1 = y + Math.sin(a) * L, x0 = ax - Math.cos(a) * L, y0 = y - Math.sin(a) * L
        ctx.strokeStyle = "#3b4250"; ctx.lineWidth = 1.3 * dpr
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1)
        for (const s of [0.5, -0.5]) ctx.lineTo(x1 - Math.cos(a + s) * 4 * dpr, y1 - Math.sin(a + s) * 4 * dpr), ctx.moveTo(x1, y1)
        ctx.stroke()
        ctx.fillText(`${Math.round(sp)}`, ax + 14 * dpr, y)
      }
      ctx.textAlign = "left"; ctx.textBaseline = "top"
      ctx.fillText("mph", ax + 14 * dpr, plot.y + plot.h + 5 * dpr)        // under the speeds, clear of the last degree label
    }
  }, [entry, temp, rh, cloud, wind, point, ground, time])

  React.useEffect(() => {
    draw()
    const un = subscribe(draw)
    const ro = new ResizeObserver(() => draw())
    if (wrap.current) ro.observe(wrap.current)
    return () => { un(); ro.disconnect() }
  }, [draw, subscribe])

  const onMove = (ev: React.PointerEvent) => {
    const L = last.current, c = cv.current
    if (!L || !c) return
    const dpr = window.devicePixelRatio || 1
    const r = c.getBoundingClientRect()
    const py = (ev.clientY - r.top) * dpr
    const fz = 1 - (py - L.plot.y) / L.plot.h
    if (fz < 0 || fz > 1) { setHover(null); return }
    const nz = entry.nz, z = fz * (nz - 1), z0 = Math.min(nz - 2, Math.floor(z)), f = z - z0
    const at = (a: Float32Array | null) => (a ? a[z0] * (1 - f) + a[z0 + 1] * f : NaN)
    const km = fz * entry.topKm
    const bits = [`${km.toFixed(1)} km (${Math.round(km * 3.281 * 10) / 10}k ft)`, `${Math.round(at(L.T))}°F`]
    if (L.D) bits.push(`dewpoint ${Math.round(at(L.D))}°F`)
    if (L.C) bits.push(`cloud ${Math.round(at(L.C))}%`)
    if (L.S) bits.push(`wind ${Math.round(at(L.S))} mph`)
    setHover({ x: ev.clientX - r.left, y: ev.clientY - r.top, text: km < ground ? `${bits[0]}: below the ground` : bits.join(" · ") })
  }

  return (
    <div className="space-y-1.5">
      <div ref={wrap} className="relative w-full" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <canvas ref={cv} role="img" aria-label={`Vertical profile at ${place}: temperature, dewpoint, cloud and wind by height`} />
        {hover && (
          <div className="pointer-events-none absolute z-10 rounded-md bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md ring-1 ring-border"
            style={{ left: Math.max(0, Math.min(hover.x + 12, (wrap.current?.clientWidth ?? 400) - 300)), top: Math.max(0, hover.y - 30) }}>
            {hover.text}
          </div>
        )}
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span><span className="font-semibold" style={{ color: TEMP_RED }}>—</span> temperature</span>
        {rh && <span><span className="font-semibold" style={{ color: DEW_GREEN }}>—</span> dewpoint</span>}
        <span><span style={{ color: FRZ_BLUE }}>┆</span> 32°F</span>
        {cloud && <span>gray bar: cloud</span>}
        {wind && <span>arrows: wind</span>}
      </p>
    </div>
  )
}
