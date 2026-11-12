import { PTYPE_COLORS, PTYPE_NAMES } from "@/lib/ramps"

import type { GridDraw } from "./grid-layer"
import { MISSING, mercY, program, type Program } from "./util"

/**
 * Falling precipitation for the 3D view, from the map's radar layer: where the model's precipitation
 * rate (or, without one, its simulated reflectivity or precipitation type) shows precipitation,
 * streaks of rain or drifting flakes of snow fall from a few kilometres up to the ground, as many as
 * the intensity calls for, coloured by precipitation type
 * (the radar legend's colours). Rain falls fast in streaks; snow slowly, wobbling; sleet and
 * freezing rain in between. Positions are in the volume box's coordinates (0 – 1 each way, z up).
 */

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
uniform mat4 uMVP;
uniform float uPoint;
out vec4 vCol;
void main() { vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = uPoint; }`
const FS = /* glsl */ `#version 300 es
precision highp float;
uniform bool uRound;
in vec4 vCol;
out vec4 fragColor;
void main() {
  if (uRound) { vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; }
  fragColor = vCol;
}`

const MAX = 7000            // drops and flakes at most
const PER_CELL = 3          // per cell with precipitation, before weighting by intensity
const START_KM = 3.5        // where they appear (roughly cloud base and below)

type Kind = "rain" | "snow" | "freezing rain" | "sleet" | "mix"
/** Seconds to fall from START_KM, streak length (km) and wobble, by type. */
const FALL: Record<Kind, { secs: number; streak: number; wobble: number }> = {
  rain: { secs: 1.4, streak: 0.35, wobble: 0 },
  "freezing rain": { secs: 1.5, streak: 0.3, wobble: 0 },
  sleet: { secs: 2.0, streak: 0.12, wobble: 0.002 },
  mix: { secs: 3.0, streak: 0.08, wobble: 0.004 },
  snow: { secs: 6.0, streak: 0, wobble: 0.006 },
}
const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) }
const COL: Record<Kind, number[]> = Object.fromEntries(Object.entries(PTYPE_COLORS).map(([k, v]) => [k, rgb(v)])) as Record<Kind, number[]>

/** Rain rate (mm/h) from reflectivity (dBZ), Marshall – Palmer. */
const rate = (dbz: number) => Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6)

interface Source { x: Float32Array; y: Float32Array; w: Float32Array; kind: Uint8Array; cdf: Float32Array; total: number }

export interface PrecipBox { lon: [number, number]; lat: [number, number]; topKm: number }

export class PrecipFx {
  private prog: Program
  private vao: WebGLVertexArrayObject
  private buf: WebGLBuffer
  private draw: GridDraw | null = null
  private gen = 0             // bumped with each new radar grid, so the sources are rebuilt
  private t = 0
  private srcKey = ""
  private src: Source | null = null
  private box: PrecipBox | null = null
  // particles
  private px = new Float32Array(MAX); private py = new Float32Array(MAX); private pz = new Float32Array(MAX)
  private top = new Float32Array(MAX); private kind = new Uint8Array(MAX); private inten = new Float32Array(MAX)
  private phase = new Float32Array(MAX)
  private n = 0
  private last = 0
  private lines = new Float32Array(MAX * 2 * 7)
  private points = new Float32Array(MAX * 7)

  constructor(gl: WebGL2RenderingContext) {
    this.prog = program(gl, VS, FS)
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    this.buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12)
    gl.bindVertexArray(null)
  }

  dispose(gl: WebGL2RenderingContext) {
    gl.deleteProgram(this.prog.program)
    gl.deleteVertexArray(this.vao)
    gl.deleteBuffer(this.buf)
  }

  /** The radar layer's grid (reflectivity with precipitation type, or type alone), or null. */
  setSource(d: GridDraw | null, t = 0) {
    const next = d && (d.paint.kind === "refc" || d.paint.kind === "ptype") ? d : null
    if (next !== this.draw || next?.a !== this.draw?.a || next?.b !== this.draw?.b) this.gen++
    this.draw = next
    this.t = t
  }
  setT(t: number) { this.t = t }
  get active() { return !!this.draw }

  /** Where precipitation falls in the box, weighted by intensity, at the nearer of the two times. */
  private source(box: PrecipBox): Source | null {
    const d = this.draw!
    const later = this.t >= 0.5 && !!d.b
    const key = `${this.gen}|${box.lon}|${box.lat}|${later}`
    if (this.src && key === this.srcKey) return this.src
    const vals = later ? d.b! : d.a
    const types = d.paint.kind === "ptype" ? vals : (later ? d.auxB : d.auxA) ?? null
    const rates = (later ? d.rateB : d.rateA) ?? null
    const g = d.grid
    const dLon = (g.east - g.west) / g.width, dLat = (g.north - g.south) / g.height
    const yN = mercY(box.lat[1]), yS = mercY(box.lat[0])
    const xs: number[] = [], ys: number[] = [], ws: number[] = [], ks: number[] = []
    for (let r = 0; r < g.height; r++) {
      const lat = g.north - (r + 0.5) * dLat
      if (lat < box.lat[0] || lat > box.lat[1]) continue
      const y = (mercY(lat) - yN) / (yS - yN)
      for (let c = 0; c < g.width; c++) {
        const lon = g.west + (c + 0.5) * dLon
        if (lon < box.lon[0] || lon > box.lon[1]) continue
        const i = r * g.width + c
        const v = vals[i]
        if (!(v > MISSING / 2)) continue
        let w: number
        if (rates) {
          // the model's own rate: from 0.01 in/h (a quarter of a millimetre an hour)
          const r = rates[i]
          if (!(r >= 0.01)) continue
          w = Math.min(40, r * 25.4)                 // mm/h
        } else if (d.paint.kind === "refc") {
          if (v < 15) continue                       // below about 0.5 mm/h: too light to show
          w = Math.min(40, rate(v))
        } else {
          if (!(v >= 1)) continue
          w = 2                                      // type alone: a moderate fall everywhere it's flagged
        }
        const code = types ? Math.round(types[i]) : 1
        const name = (PTYPE_NAMES[code] ?? "rain") as string
        const kind = name === "none" ? 0 : Math.max(0, (["rain", "snow", "freezing rain", "sleet", "mix"] as string[]).indexOf(name))
        xs.push((lon - box.lon[0]) / (box.lon[1] - box.lon[0])); ys.push(y); ws.push(Math.sqrt(w)); ks.push(kind)
      }
    }
    const cdf = new Float32Array(ws.length)
    let s = 0
    for (let i = 0; i < ws.length; i++) { s += ws[i]; cdf[i] = s }
    this.src = { x: Float32Array.from(xs), y: Float32Array.from(ys), w: Float32Array.from(ws), kind: Uint8Array.from(ks), cdf, total: s }
    this.srcKey = key
    // how many: a few per wet cell, more where it's heavier
    this.n = Math.min(MAX, Math.round(s * PER_CELL))
    for (let i = 0; i < this.n; i++) this.spawn(i, box, true)
    return this.src
  }

  private spawn(i: number, box: PrecipBox, scatter = false) {
    const s = this.src!
    if (!s.total) return
    const u = Math.random() * s.total
    let lo = 0, hi = s.cdf.length - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (s.cdf[m] < u) lo = m + 1; else hi = m }
    const g = this.draw!.grid
    const cw = (g.east - g.west) / g.width / (box.lon[1] - box.lon[0])
    const ch = (g.north - g.south) / g.height / (box.lat[1] - box.lat[0])
    this.px[i] = s.x[lo] + (Math.random() - 0.5) * cw
    this.py[i] = s.y[lo] + (Math.random() - 0.5) * ch
    this.top[i] = (START_KM * (0.7 + 0.3 * Math.random())) / box.topKm
    this.pz[i] = scatter ? Math.random() * this.top[i] : this.top[i]
    this.kind[i] = s.kind[lo]
    this.inten[i] = Math.min(1, s.w[lo] / 4)
    this.phase[i] = Math.random() * Math.PI * 2
  }

  /** Step and draw. `zr` is the slab of the box being drawn (fractions of its height). */
  render(gl: WebGL2RenderingContext, mvp: Float32Array, box: PrecipBox, zr: [number, number], dpr: number): boolean {
    if (!this.draw) return false
    if (!this.box || this.box.lon[0] !== box.lon[0] || this.box.lat[0] !== box.lat[0] || this.box.topKm !== box.topKm) { this.srcKey = ""; this.box = box }
    const s = this.source(box)
    if (!s || !s.total || !this.n) return false
    const now = performance.now()
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60
    this.last = now
    const kinds: Kind[] = ["rain", "snow", "freezing rain", "sleet", "mix"]
    let nl = 0, np = 0
    for (let i = 0; i < this.n; i++) {
      const k = kinds[this.kind[i]], f = FALL[k]
      this.pz[i] -= (this.top[i] / f.secs) * dt
      if (f.wobble) { this.phase[i] += dt * 2.2; this.px[i] += Math.cos(this.phase[i]) * f.wobble * dt }
      if (this.pz[i] <= 0) { this.spawn(i, box); continue }
      const z = this.pz[i]
      if (z < zr[0] || z > zr[1]) continue
      const c = COL[k] ?? COL.rain
      const a = 0.35 + 0.6 * this.inten[i]
      if (f.streak > 0) {
        const z1 = Math.min(zr[1], z + (f.streak * (0.6 + 0.6 * this.inten[i])) / box.topKm)
        this.lines.set([this.px[i], this.py[i], z, c[0] * a, c[1] * a, c[2] * a, a,
                        this.px[i], this.py[i], z1, 0, 0, 0, 0], nl * 14)
        nl++
      } else {
        this.points.set([this.px[i], this.py[i], z, c[0] * a, c[1] * a, c[2] * a, a], np * 7)
        np++
      }
    }
    gl.useProgram(this.prog.program)
    gl.uniformMatrix4fv(this.prog.u("uMVP"), false, mvp)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    if (nl) {
      gl.uniform1i(this.prog.u("uRound"), 0)
      gl.uniform1f(this.prog.u("uPoint"), 1)
      gl.bufferData(gl.ARRAY_BUFFER, this.lines.subarray(0, nl * 14), gl.STREAM_DRAW)
      gl.drawArrays(gl.LINES, 0, nl * 2)
    }
    if (np) {
      gl.uniform1i(this.prog.u("uRound"), 1)
      gl.uniform1f(this.prog.u("uPoint"), 2.6 * dpr)
      gl.bufferData(gl.ARRAY_BUFFER, this.points.subarray(0, np * 7), gl.STREAM_DRAW)
      gl.drawArrays(gl.POINTS, 0, np)
    }
    gl.bindVertexArray(null)
    return true
  }
}
