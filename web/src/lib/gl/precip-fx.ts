import { PTYPE_COLORS, PTYPE_NAMES } from "@/lib/ramps"

import type { GridDraw } from "./grid-layer"
import { MISSING, mercY, program, type Program } from "./util"

/**
 * Falling precipitation for the 3D view, from the map's radar layer: where the model's precipitation
 * rate (or, without one, its simulated reflectivity or precipitation type) shows precipitation,
 * streaks of rain or drifting flakes of snow fall from a few kilometres up to the ground, as many as
 * the intensity calls for: rain as blue streaks a few pixels wide (freezing rain the same, in pink),
 * snow as soft white flakes over a faint shadow (so they show over a light map), sleet as small hard
 * ice pellets (orange), and mixes as short purple streaks. Rain falls fast in streaks; snow slowly, wobbling; sleet and
 * freezing rain in between. Positions are in the volume box's coordinates (0 – 1 each way, z up).
 */

// streaks: one quad per drop, instanced, a few pixels wide on screen whatever the zoom, bright at
// the drop's head and fading up its trail, soft at the sides
const STREAK_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;      // x: 0 head .. 1 tail; y: -1 .. 1 across
layout(location = 1) in vec3 aHead;
layout(location = 2) in vec3 aTail;
layout(location = 3) in vec4 aCol;
uniform mat4 uMVP;
uniform vec2 uViewport;
uniform float uWidth;                      // device pixels
out vec4 vCol;
out vec2 vUv;
void main() {
  vec4 h = uMVP * vec4(aHead, 1.0), t = uMVP * vec4(aTail, 1.0);
  vec2 hs = h.xy / h.w * uViewport, ts = t.xy / t.w * uViewport;
  vec2 dir = ts - hs;
  float len = length(dir);
  dir = len > 1e-3 ? dir / len : vec2(0.0, 1.0);
  vec2 n = vec2(-dir.y, dir.x);
  vec4 p = mix(h, t, aCorner.x);
  // at least a couple of pixels long, so drops seen end-on still show
  vec2 ext = (aCorner.x > 0.5 && len < 3.0 ? dir * (3.0 - len) : vec2(0.0)) + n * aCorner.y * uWidth * 0.5;
  p.xy += ext / uViewport * p.w;
  gl_Position = p;
  vCol = aCol;
  vUv = aCorner;
}`
const STREAK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vCol;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float side = 1.0 - smoothstep(0.45, 1.0, abs(vUv.y));
  float along = mix(1.0, 0.15, vUv.x);
  fragColor = vCol * side * along;
}`
// flakes and pellets: round sprites with a soft dark rim, so white snow shows on a light map
const FLAKE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
uniform mat4 uMVP;
uniform float uPoint;
out vec4 vCol;
void main() { vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = uPoint * (0.7 + 0.6 * aCol.a); }`
const FLAKE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform bool uSoft;
in vec4 vCol;
out vec4 fragColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a = vCol.a;
  if (uSoft) {
    // a snowflake: a soft, fuzzy white glow fading to nothing, over a fainter grey shadow a little
    // wider, so it still shows over a light map
    float glow = exp(-r * r * 5.0);
    float shade = exp(-r * r * 2.2) * (1.0 - glow) * 0.28;
    fragColor = vec4(vCol.rgb * glow * a + vec3(0.12, 0.15, 0.22) * shade * a, (glow + shade) * a);
    return;
  }
  // an ice pellet: a small, hard bead with a dark rim (premultiplied)
  float core = 1.0 - smoothstep(0.5, 0.68, r);
  float rim = (1.0 - smoothstep(0.82, 1.0, r)) * (1.0 - core);
  fragColor = vec4(vCol.rgb * core * a + vec3(0.16, 0.2, 0.3) * rim * 0.55 * a, (core + rim * 0.55) * a);
}`

const MAX = 14000           // drops and flakes at most
const PER_CELL = 4          // per cell with precipitation, before weighting by intensity
const START_KM = 3.5        // where they appear (roughly cloud base and below)

type Kind = "rain" | "snow" | "freezing rain" | "sleet" | "mix"
/** Seconds to fall from START_KM, how it's drawn (a streak of this length in km, a soft flake or a
 *  hard pellet) and wobble, by type. Freezing rain is rain that freezes on landing, so it falls as
 *  rain does; sleet is ice pellets, bouncing beads a little smaller than flakes. */
const FALL: Record<Kind, { secs: number; streak: number; look: "streak" | "flake" | "pellet"; wobble: number }> = {
  rain: { secs: 1.4, streak: 0.35, look: "streak", wobble: 0 },
  "freezing rain": { secs: 1.5, streak: 0.3, look: "streak", wobble: 0 },
  sleet: { secs: 2.0, streak: 0, look: "pellet", wobble: 0.001 },
  mix: { secs: 3.0, streak: 0.08, look: "streak", wobble: 0.004 },
  snow: { secs: 6.0, streak: 0, look: "flake", wobble: 0.006 },
}
const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) }
/** Rain blue and snow white, as they look; the mixed types keep the radar legend's hues. */
const COL: Record<Kind, number[]> = {
  ...(Object.fromEntries(Object.entries(PTYPE_COLORS).map(([k, v]) => [k, rgb(v)])) as Record<Kind, number[]>),
  rain: [0.16, 0.42, 0.88], snow: [1, 1, 1],
}

/** Rain rate (mm/h) from reflectivity (dBZ), Marshall – Palmer. */
const rate = (dbz: number) => Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6)

interface Source { x: Float32Array; y: Float32Array; w: Float32Array; kind: Uint8Array; cdf: Float32Array; total: number }

export interface PrecipBox { lon: [number, number]; lat: [number, number]; topKm: number }

export class PrecipFx {
  private streakProg: Program
  private flakeProg: Program
  private streakVao: WebGLVertexArrayObject
  private flakeVao: WebGLVertexArrayObject
  private cornerBuf: WebGLBuffer
  private streakBuf: WebGLBuffer
  private flakeBuf: WebGLBuffer
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
  private ground: ((x: number, y: number) => number) | null = null
  private last = 0
  private streaks = new Float32Array(MAX * 10)        // head xyz, tail xyz, rgba (premultiplied)
  private points = new Float32Array(MAX * 7)        // flakes
  private pellets = new Float32Array(MAX * 7)

  constructor(gl: WebGL2RenderingContext) {
    this.streakProg = program(gl, STREAK_VS, STREAK_FS)
    this.flakeProg = program(gl, FLAKE_VS, FLAKE_FS)
    // streaks: a unit quad per drop, the drop's ends and colour per instance
    this.streakVao = gl.createVertexArray()!
    gl.bindVertexArray(this.streakVao)
    this.cornerBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
    this.streakBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.streakBuf)
    for (const [loc, size, off] of [[1, 3, 0], [2, 3, 12], [3, 4, 24]] as const) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, off)
      gl.vertexAttribDivisor(loc, 1)
    }
    // flakes: points
    this.flakeVao = gl.createVertexArray()!
    gl.bindVertexArray(this.flakeVao)
    this.flakeBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flakeBuf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12)
    gl.bindVertexArray(null)
  }

  dispose(gl: WebGL2RenderingContext) {
    gl.deleteProgram(this.streakProg.program)
    gl.deleteProgram(this.flakeProg.program)
    gl.deleteVertexArray(this.streakVao)
    gl.deleteVertexArray(this.flakeVao)
    for (const b of [this.cornerBuf, this.streakBuf, this.flakeBuf]) gl.deleteBuffer(b)
  }

  /** The radar layer's grid (reflectivity with precipitation type, or type alone), or null. */
  setSource(d: GridDraw | null, t = 0) {
    const next = d && (d.paint.kind === "refc" || d.paint.kind === "ptype") ? d : null
    if (next !== this.draw || next?.a !== this.draw?.a || next?.b !== this.draw?.b) this.gen++
    this.draw = next
    this.t = t
  }
  setT(t: number) { this.t = t }
  /** Terrain height at a point of the box (fraction of its height): drops land on it, not at sea level. */
  setGround(f: ((x: number, y: number) => number) | null) { this.ground = f }
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
    let nl = 0, np = 0, ne = 0
    for (let i = 0; i < this.n; i++) {
      const k = kinds[this.kind[i]], f = FALL[k]
      this.pz[i] -= (this.top[i] / f.secs) * dt
      if (f.wobble) { this.phase[i] += dt * 2.2; this.px[i] += Math.cos(this.phase[i]) * f.wobble * dt }
      if (this.pz[i] <= (this.ground ? this.ground(this.px[i], this.py[i]) : 0)) { this.spawn(i, box); continue }
      const z = this.pz[i]
      if (z < zr[0] || z > zr[1]) continue
      const c = COL[k] ?? COL.rain
      // rain lighter (it's dense), flakes and pellets nearly solid
      const a = f.look === "streak" ? 0.32 + 0.4 * this.inten[i] : 0.75 + 0.25 * this.inten[i]
      if (f.look === "streak") {
        const z1 = Math.min(zr[1], z + (f.streak * (0.7 + 0.8 * this.inten[i])) / box.topKm)
        this.streaks.set([this.px[i], this.py[i], z, this.px[i], this.py[i], z1, c[0] * a, c[1] * a, c[2] * a, a], nl * 10)
        nl++
      } else if (f.look === "pellet") {
        this.pellets.set([this.px[i], this.py[i], z, c[0] * a, c[1] * a, c[2] * a, a], ne * 7)
        ne++
      } else {
        this.points.set([this.px[i], this.py[i], z, c[0] * a, c[1] * a, c[2] * a, a], np * 7)
        np++
      }
    }
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    if (nl) {
      const p = this.streakProg
      gl.useProgram(p.program)
      gl.uniformMatrix4fv(p.u("uMVP"), false, mvp)
      gl.uniform2f(p.u("uViewport"), gl.drawingBufferWidth / 2, gl.drawingBufferHeight / 2)
      gl.uniform1f(p.u("uWidth"), 1.8 * dpr)
      gl.bindVertexArray(this.streakVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.streakBuf)
      gl.bufferData(gl.ARRAY_BUFFER, this.streaks.subarray(0, nl * 10), gl.STREAM_DRAW)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, nl)
    }
    // soft flakes, larger, then small hard pellets
    for (const [arr, n, size, soft] of [[this.points, np, 6.5, true], [this.pellets, ne, 3.0, false]] as const) {
      if (!n) continue
      const p = this.flakeProg
      gl.useProgram(p.program)
      gl.uniformMatrix4fv(p.u("uMVP"), false, mvp)
      gl.uniform1f(p.u("uPoint"), size * dpr)
      gl.uniform1i(p.u("uSoft"), soft ? 1 : 0)
      gl.bindVertexArray(this.flakeVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flakeBuf)
      gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, n * 7), gl.STREAM_DRAW)
      gl.drawArrays(gl.POINTS, 0, n)
    }
    gl.bindVertexArray(null)
    return true
  }
}
