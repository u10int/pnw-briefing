import * as React from "react"

import type { Briefing } from "@/types"
import { type VolumeEntry, type VolVar } from "@/lib/volume"
import { contourLevels, isolines, miles, paintSlice, sampleSection, type SectionLine, terrainProfile } from "@/lib/xsection"

const N = 240                    // columns along the line
const FRZ_BLUE = "#1f78d1"

export interface SectionTime { i0: number; i1: number; t: number }

/** Fill, contours and the freezing level of a slice, drawn into a rectangle of a 2D context. */
function drawSlice(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
                   sec: Float32Array, nz: number, name: VolVar, temp: Float32Array | null, labels: boolean, dpr: number) {
  // the fill at half resolution, smoothed up
  const iw = Math.max(2, Math.round(w / 2)), ih = Math.max(2, Math.round(h / 2))
  const img = new ImageData(iw, ih)
  paintSlice(img, sec, nz, N, name)
  const tmp = document.createElement("canvas")
  tmp.width = iw; tmp.height = ih
  tmp.getContext("2d")!.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(tmp, x, y, w, h)
  const X = (c: number) => x + (c / (N - 1)) * w, Y = (r: number) => y + h - (r / (nz - 1)) * h
  const stroke = (segs: number[], color: string, width: number, dash: number[] = []) => {
    ctx.beginPath()
    for (let i = 0; i < segs.length; i += 4) { ctx.moveTo(X(segs[i]), Y(segs[i + 1])); ctx.lineTo(X(segs[i + 2]), Y(segs[i + 3])) }
    ctx.setLineDash(dash.map((d) => d * dpr))
    ctx.strokeStyle = color; ctx.lineWidth = width * dpr; ctx.stroke()
    ctx.setLineDash([])
  }
  const { at, bold, unit } = contourLevels(name)
  const lab: [number, number, string][] = []
  at.forEach((lv, k) => {
    const segs = isolines(sec, nz, N, lv)
    if (!segs.length) return
    stroke(segs, "rgba(30,34,40,0.55)", 0.8)
    // one label per line, staggered along the slice so neighbouring lines' labels don't stack
    const want = [0.2, 0.45, 0.7, 0.9][k % 4] * N
    let best = -1, bd = Infinity
    for (let i = 0; i < segs.length; i += 4) { const d = Math.abs((segs[i] + segs[i + 2]) / 2 - want); if (d < bd) { bd = d; best = i } }
    if (labels && best >= 0) lab.push([X((segs[best] + segs[best + 2]) / 2), Y((segs[best + 1] + segs[best + 3]) / 2), `${lv}${unit}`])
  })
  // the freezing level: the field's own 32°F line, or from the temperature for other fields
  const frz = bold != null ? isolines(sec, nz, N, bold) : temp ? isolines(temp, nz, N, 32) : []
  if (frz.length) {
    stroke(frz, "rgba(255,255,255,0.9)", 3.4)
    stroke(frz, FRZ_BLUE, 2)
  }
  if (labels) {
    ctx.font = `${10.5 * dpr}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = "center"; ctx.textBaseline = "middle"
    for (const [lx, ly, s] of lab) {
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.strokeText(s, lx, ly)
      ctx.fillStyle = "#1f2328"; ctx.fillText(s, lx, ly)
    }
  }
  return frz.length > 0
}

/** The slice as a texture for the 3D view's curtain (no axes or labels). */
export function curtainImage(sec: Float32Array, nz: number, name: VolVar, temp: Float32Array | null): HTMLCanvasElement {
  const c = document.createElement("canvas")
  c.width = 480; c.height = 240
  drawSlice(c.getContext("2d")!, 0, 0, c.width, c.height, sec, nz, name, temp, false, 1)
  return c
}

/**
 * The cross-section under the map: the selected 3D field along the line from 0 to the volume's top,
 * with contours, the freezing level (heavy blue), the terrain along the line, the forecast
 * locations near it and a readout under the pointer. It follows the map's clock.
 */
export function CrossSection({ data, entry, name, values, temp, line, time, subscribe, onImage }: {
  data: Briefing; entry: VolumeEntry; name: VolVar
  /** The field's bytes (all steps), and the temperature's for the freezing level (may be the same). */
  values: Uint8Array; temp: Uint8Array | null
  line: SectionLine; time: () => SectionTime; subscribe: (fn: () => void) => () => void
  onImage?: (img: HTMLCanvasElement) => void
}) {
  const cv = React.useRef<HTMLCanvasElement>(null)
  const wrap = React.useRef<HTMLDivElement>(null)
  const [terrain, setTerrain] = React.useState<Float32Array | null>(null)
  const [hover, setHover] = React.useState<{ x: number; y: number; text: string } | null>(null)
  const last = React.useRef<{ sec: Float32Array; plot: { x: number; y: number; w: number; h: number } } | null>(null)
  const field = name === "frz" ? "temp" : name
  const dist = miles(line.a, line.b)
  const near = React.useMemo(() => data.points.map((p) => {
    // distance from the line (flat approximation, fine at this scale) and position along it
    const kx = Math.cos((p.lat * Math.PI) / 180)
    const ax = line.a[0] * kx, ay = line.a[1], bx = line.b[0] * kx, by = line.b[1], px = p.lon * kx, py = p.lat
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2
    const f = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2))
    const dDeg = Math.hypot(px - (ax + f * (bx - ax)), py - (ay + f * (by - ay)))
    return { name: p.name, f, mi: dDeg * 69 }
  }).filter((p) => p.mi < 9 && p.f > 0.02 && p.f < 0.98), [data.points, line])

  React.useEffect(() => {
    let live = true
    setTerrain(null)
    terrainProfile(entry, line, N).then((t) => { if (live) setTerrain(t) }).catch(() => {})
    return () => { live = false }
  }, [entry, line])

  const draw = React.useCallback(() => {
    const c = cv.current, box = wrap.current
    if (!c || !box) return
    const dpr = window.devicePixelRatio || 1
    const W = box.clientWidth, H = box.clientWidth < 640 ? 200 : 240
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr)
      c.style.width = `${W}px`; c.style.height = `${H}px`
    }
    const ctx = c.getContext("2d")!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    const { i0, i1, t } = time()
    const sec = sampleSection(entry, field, values, line, i0, i1, t, N)
    const tsec = field === "temp" ? null : temp ? sampleSection(entry, "temp", temp, line, i0, i1, t, N) : null
    const m = { l: 44 * dpr, r: 46 * dpr, t: 8 * dpr, b: 30 * dpr }
    const plot = { x: m.l, y: m.t, w: c.width - m.l - m.r, h: c.height - m.t - m.b }
    last.current = { sec, plot }
    drawSlice(ctx, plot.x, plot.y, plot.w, plot.h, sec, entry.nz, name, tsec, true, dpr)
    onImage?.(curtainImage(sec, entry.nz, name, tsec))
    // terrain along the line
    const top = entry.topKm
    if (terrain) {
      ctx.beginPath()
      ctx.moveTo(plot.x, plot.y + plot.h)
      for (let k = 0; k < N; k++) ctx.lineTo(plot.x + (k / (N - 1)) * plot.w, plot.y + plot.h - (terrain[k] / top) * plot.h)
      ctx.lineTo(plot.x + plot.w, plot.y + plot.h)
      ctx.closePath()
      ctx.fillStyle = "rgba(92,84,74,0.92)"; ctx.fill()
    }
    // axes
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = dpr
    ctx.strokeRect(plot.x, plot.y, plot.w, plot.h)
    ctx.font = `${10.5 * dpr}px ui-sans-serif, system-ui, sans-serif`
    ctx.fillStyle = "#59606b"; ctx.textBaseline = "middle"
    ctx.textAlign = "right"
    for (let km = 0; km <= top; km += 2) ctx.fillText(`${km} km`, plot.x - 5 * dpr, plot.y + plot.h - (km / top) * plot.h)
    ctx.textAlign = "left"
    for (let kft = 0; kft * 0.3048 <= top; kft += 10) ctx.fillText(`${kft}k ft`, plot.x + plot.w + 5 * dpr, plot.y + plot.h - ((kft * 0.3048) / top) * plot.h)
    ctx.textBaseline = "top"
    const by = plot.y + plot.h + 5 * dpr
    ctx.textAlign = "left"; ctx.fillText(line.aName, plot.x, by)
    ctx.textAlign = "right"; ctx.fillText(`${line.bName} · ${Math.round(dist)} mi`, plot.x + plot.w, by)
    ctx.textAlign = "center"; ctx.fillStyle = "#1f2328"
    let lastX = -1e9
    for (const p of [...near].sort((a, b) => a.f - b.f)) {
      const x = plot.x + p.f * plot.w
      if (x - lastX < 70 * dpr) continue
      lastX = x
      ctx.fillRect(x - 0.5 * dpr, plot.y + plot.h - 4 * dpr, dpr, 4 * dpr)
      ctx.fillText(p.name, x, by + 13 * dpr)
    }
  }, [entry, field, name, values, temp, line, terrain, time, near, dist, onImage])

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
    const px = (ev.clientX - r.left) * dpr, py = (ev.clientY - r.top) * dpr
    const fx = (px - L.plot.x) / L.plot.w, fz = 1 - (py - L.plot.y) / L.plot.h
    if (fx < 0 || fx > 1 || fz < 0 || fz > 1) { setHover(null); return }
    const col = Math.round(fx * (N - 1)), rz = fz * (entry.nz - 1), z0 = Math.min(entry.nz - 2, Math.floor(rz))
    const v = L.sec[z0 * N + col] * (1 - (rz - z0)) + L.sec[(z0 + 1) * N + col] * (rz - z0)
    const km = fz * entry.topKm
    const u = contourLevels(name).unit
    const val = !Number.isFinite(v) ? "no data" : name === "water" || name === "ice" || name === "w" ? `${v.toFixed(2)}${u}`
      : name === "mflux" ? `${Math.round(v)} (g/kg)(m/s)` : `${Math.round(v)}${u}`
    const ground = terrain && km < terrain[col] ? " (below the terrain)" : ""
    setHover({ x: ev.clientX - r.left, y: ev.clientY - r.top,
               text: `${Math.round(fx * dist)} mi from ${line.aName}, ${km.toFixed(1)} km (${Math.round((km * 3.281) * 10) / 10}k ft): ${val}${ground}` })
  }

  return (
    <div ref={wrap} className="relative w-full" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <canvas ref={cv} role="img" aria-label={`Cross-section of ${entry.vars[field]?.label.toLowerCase() ?? name} along ${line.label}`} />
      {hover && (
        <div className="pointer-events-none absolute z-10 rounded-md bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md ring-1 ring-border"
          style={{ left: Math.min(hover.x + 12, (wrap.current?.clientWidth ?? 600) - 280), top: Math.max(0, hover.y - 30) }}>
          {hover.text}
        </div>
      )}
    </div>
  )
}
