import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl"

import { WIND } from "@/lib/ramps"

import { mercatorMatrix, mercX, mercY, program, type Program, resetUnpack, unitQuad } from "./util"

/** One model's volume grid, as described in data/volume.json. */
export interface VolumeGrid {
  nx: number; ny: number; nz: number
  lat: [number, number]; lon: [number, number]      // cell centres at the edges (south..north, west..east)
  topKm: number
}

export interface VolumeDraw {
  grid: VolumeGrid
  /** Every time step, packed [t, z, y, x] (one byte each, 255 = missing). */
  data: Uint8Array
  steps: number
  /** 256 RGBA entries: colour and extinction for each packed byte value. */
  lut: Uint8Array
  key: string
  /** Shade by the field above (clouds, water, ice, humidity). */
  lit: boolean
  /** Surfaces at set values: the packed fraction (0 – 1) and premultiplied-ready RGBA (0 – 1). */
  isos?: { at: number; rgba: [number, number, number, number] }[]
  /** Colour the surfaces by height instead (256 RGBA over 0 – topKm). */
  heightLut?: Uint8Array
}

/** Wind for the particles: u and v (m/s) packed like the other fields, every time step. */
export interface VolumeWind {
  u: Uint8Array; v: Uint8Array
  range: [number, number]
  /** The heights (km) to release particles at, one layer each. */
  heightsKm: number[]
}

/** Screen positions (CSS px) of the height and pressure ticks, for the page to label. */
export interface AxisPoint { x: number; y: number; label: string; side: "left" | "right" }

const EARTH_CIRC = 2 * Math.PI * 6371008.8

// ------------------------------------------------------------------ small 4×4 helpers (column-major)
type M4 = Float64Array
const mul = (a: ArrayLike<number>, b: ArrayLike<number>): M4 => {
  const o = new Float64Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
    o[c * 4 + r] = s
  }
  return o
}
function invert(m: M4): M4 | null {
  const inv = new Float64Array(16)
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
  if (!det) return null
  for (let i = 0; i < 16; i++) inv[i] /= det
  return inv
}

// ------------------------------------------------------------------ shaders
// A full-screen quad: each pixel finds its own ray through the box (pixels whose ray misses it
// stop at once), which needs no assumption about the box faces' winding after the map's matrix.
const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
uniform mat4 uInv;              // clip -> box
uniform vec2 uViewport;         // drawing buffer size
uniform sampler3D uA, uB;
uniform sampler2D uLut;
uniform float uT, uOpacity, uDensity;
uniform vec3 uScale;            // box size in Web Mercator units (x, y, exaggerated z)
uniform vec2 uMercY;            // box north and south edges, Web Mercator y
uniform vec2 uLat;              // data rows' first and last latitude
uniform vec3 uSize;             // nx, ny, nz
uniform int uSteps;
uniform vec2 uZr;               // the heights drawn, as fractions of the box's height
uniform bool uLit;              // shade by what lies above (clouds and the like); else flat colour
// surfaces where the field crosses set values (isotherms, isotachs, the freezing level), lit by
// the field's gradient; coloured by height (uHeight) when uIsoByHeight
uniform int uIsoN;
uniform float uIso[6];
uniform vec4 uIsoCol[6];
uniform bool uIsoByHeight;
uniform sampler2D uHeight;
out vec4 fragColor;
const float PI = 3.141592653589793;

vec3 texPos(vec3 p) {
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * mix(uMercY.x, uMercY.y, p.y)))));
  vec3 f = vec3(p.x, (lat - uLat.x) / (uLat.y - uLat.x), p.z);
  return (f * (uSize - 1.0) + 0.5) / uSize;               // cell centres span the box
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float val(vec3 q) { return mix(texture(uA, q).r, texture(uB, q).r, uT); }
// the field's gradient in the box's true proportions (texture rows run north, the box's y south)
vec3 normalAt(vec3 p) {
  vec3 q = texPos(p), e = 1.0 / uSize;
  vec3 g = vec3(val(q + vec3(e.x, 0, 0)) - val(q - vec3(e.x, 0, 0)),
                -(val(q + vec3(0, e.y, 0)) - val(q - vec3(0, e.y, 0))),
                val(q + vec3(0, 0, e.z)) - val(q - vec3(0, 0, e.z)));
  g /= uScale / uSize;
  float l = length(g);
  return l > 0.0 ? g / l : vec3(0, 0, 1);
}
float extinction(vec3 p) {
  vec3 q = texPos(p);
  float v = mix(texture(uA, q).r, texture(uB, q).r, uT);
  return texture(uLut, vec2((v * 255.0 + 0.5) / 256.0, 0.5)).a;
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
  vec4 n = uInv * vec4(ndc, -1.0, 1.0), f = uInv * vec4(ndc, 1.0, 1.0);
  vec3 ro = n.xyz / n.w, rd = f.xyz / f.w - ro;
  vec3 inv = 1.0 / rd;
  vec3 t0 = (vec3(0.0, 0.0, uZr.x) - ro) * inv, t1 = (vec3(1.0, 1.0, uZr.y) - ro) * inv;
  vec3 tlo = min(t0, t1), thi = max(t0, t1);
  float tn = max(max(tlo.x, tlo.y), max(tlo.z, 0.0));
  float tf = min(min(thi.x, thi.y), thi.z);
  if (tf <= tn) discard;
  // steps sized in box units across its diagonal; the opacity of each follows its true length
  float dt = 1.7320508 / float(uSteps) / length(rd);
  float worldStep = length(rd * dt * uScale) / uScale.x;   // in box widths
  vec4 acc = vec4(0.0);
  float t = tn + dt * hash(gl_FragCoord.xy);
  float prev = -1.0;
  vec3 Ldir = normalize(vec3(-0.45, 0.55, 1.0));
  for (int i = 0; i < 512; i++) {
    if (t > tf || acc.a > 0.97) break;
    vec3 p = ro + rd * t;
    vec3 q = texPos(p);
    if (q.y >= 0.0 && q.y <= 1.0) {
      float v = val(q);
      // a surface between the last sample and this one: composite it first, where it falls
      if (prev >= 0.0) {
        for (int k = 0; k < 6; k++) {
          if (k >= uIsoN) break;
          float iso = uIso[k];
          if ((prev - iso) * (v - iso) < 0.0) {
            float f = (iso - prev) / (v - prev);
            vec3 ph = p - rd * dt * (1.0 - f);
            float lam = 0.5 + 0.5 * abs(dot(normalAt(ph), Ldir));
            vec4 ic = uIsoCol[k];
            vec3 col = uIsoByHeight ? texture(uHeight, vec2(clamp(ph.z, 0.0, 1.0), 0.5)).rgb : ic.rgb;
            acc.rgb += (1.0 - acc.a) * ic.a * col * lam;
            acc.a += (1.0 - acc.a) * ic.a;
          }
        }
      }
      prev = v;
      vec4 c = texture(uLut, vec2((v * 255.0 + 0.5) / 256.0, 0.5));
      float a = 1.0 - exp(-c.a * 4.0 * uDensity * worldStep);
      vec3 col = c.rgb;
      if (uLit && a > 0.002) {
        // light from above and a little to the south-west: two taps towards it stand in for the
        // shadow of whatever lies over this point, so the undersides go gray and the tops stay bright
        vec3 L = vec3(-0.05, 0.08, 0.25);
        float od = (extinction(p + L * 0.35) + extinction(p + L)) * 4.0 * uDensity * 0.06;
        col *= mix(0.42, 1.0, exp(-od)) * mix(0.8, 1.0, p.z);
      } else {
        col *= mix(0.72, 1.0, p.z);                          // a little darker low down, for depth
      }
      acc.rgb += (1.0 - acc.a) * a * col;
      acc.a += (1.0 - acc.a) * a;
    }
    t += dt;
  }
  fragColor = acc * uOpacity;
}`

// the cached volume image, drawn over the map each frame
const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImg;
uniform vec2 uViewport;
out vec4 fragColor;
void main() { fragColor = texture(uImg, gl_FragCoord.xy / uViewport); }`

// wind particles: short trails in box coordinates, colour premultiplied per vertex
const TRAIL_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
uniform mat4 uMVP;
out vec4 vCol;
void main() { vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }`
const TRAIL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vCol;
out vec4 fragColor;
void main() { fragColor = vCol; }`

const TRAIL = 7               // positions kept per particle
const PER_LAYER = 650         // particles per height
const SIM_SECONDS = 160       // simulated seconds per 60th of a second
const WIND_RGB = (() => {     // the wind scale, a little deeper so trails read on a light map
  const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (c / 255) * 0.82) }
  return (mph: number) => {
    let i = 0
    while (i < WIND.levels.length - 1 && mph >= WIND.levels[i + 1]) i++
    return hex(WIND.colors[i])
  }
})()

// the box's edges, faintly
const LINE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`
const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }`

const EDGES = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0,
  0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1,
  0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1,
])

/**
 * Raymarches a model's 3-D field over the map. The data box spans the grid's latitudes and
 * longitudes and 0 – topKm, stretched vertically by `exaggeration`. Each pixel's ray through the box
 * samples the two forecast steps either side of the clock (linear in space, blended in time), looks
 * up colour and extinction in a transfer table, and composites front to back.
 */
export class VolumeLayer implements CustomLayerInterface {
  readonly type = "custom" as const
  readonly renderingMode = "3d" as const
  private map?: MlMap
  private gl?: WebGL2RenderingContext
  private prog?: Program
  private lineProg?: Program
  private blitProg?: Program
  private fbo?: WebGLFramebuffer
  private fboTex?: WebGLTexture
  private fboSize = [0, 0]
  private lastKey = ""
  private heightTex?: WebGLTexture
  private heightKey = ""
  private vao?: WebGLVertexArrayObject
  private lineVao?: WebGLVertexArrayObject
  private lut?: WebGLTexture
  private lutKey = ""
  private draw: VolumeDraw | null = null
  private textures = new Map<number, WebGLTexture>()
  private i0 = 0
  private i1 = 0
  private t = 0
  private exaggeration = 25
  private zr: [number, number] = [0, 1]
  private opacity = 1
  private moving = false
  private dataChanged = false
  private levels: { hPa: number; km: number }[] = []
  onAxis: ((pts: AxisPoint[]) => void) | null = null
  // ---- wind particles
  private wind: VolumeWind | null = null
  private trailProg?: Program
  private trailVao?: WebGLVertexArrayObject
  private trailBuf?: WebGLBuffer
  private pos = new Float32Array(0)       // [particle, history, xyz] in box coordinates, newest first
  private age = new Float32Array(0)
  private life = new Float32Array(0)
  private speed = new Float32Array(0)     // mph, for colour
  private verts = new Float32Array(0)
  private lastFrame = 0

  constructor(readonly id: string) {}

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map
    this.gl = gl
    this.prog = program(gl, VS, FS)
    this.lineProg = program(gl, LINE_VS, LINE_FS)
    this.blitProg = program(gl, VS, BLIT_FS)
    this.fbo = gl.createFramebuffer()!
    this.fboTex = gl.createTexture()!
    this.heightTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    this.trailProg = program(gl, TRAIL_VS, TRAIL_FS)
    this.trailVao = gl.createVertexArray()!
    gl.bindVertexArray(this.trailVao)
    this.trailBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12)
    gl.bindVertexArray(null)
    this.vao = unitQuad(gl)
    const vao = (data: Float32Array) => {
      const v = gl.createVertexArray()!
      gl.bindVertexArray(v)
      const b = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, b)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
      gl.bindVertexArray(null)
      return v
    }
    this.lineVao = vao(EDGES)
    this.lut = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.lut)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v)
    const busy = () => { this.moving = true }
    const idle = () => { this.moving = false; map.triggerRepaint() }
    map.on("movestart", busy)
    map.on("moveend", idle)
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    this.clearTextures()
    if (this.prog) gl.deleteProgram(this.prog.program)
    if (this.lineProg) gl.deleteProgram(this.lineProg.program)
    if (this.blitProg) gl.deleteProgram(this.blitProg.program)
    if (this.trailProg) gl.deleteProgram(this.trailProg.program)
    if (this.trailBuf) gl.deleteBuffer(this.trailBuf)
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    if (this.fboTex) gl.deleteTexture(this.fboTex)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.lineVao) gl.deleteVertexArray(this.lineVao)
    if (this.lut) gl.deleteTexture(this.lut)
  }

  private clearTextures() {
    for (const t of this.textures.values()) this.gl?.deleteTexture(t)
    this.textures.clear()
  }

  setDraw(d: VolumeDraw | null, levels: { hPa: number; km: number }[] = []) {
    if (d?.data !== this.draw?.data) this.clearTextures()
    this.dataChanged = true
    this.draw = d
    this.levels = levels
    if (!d) this.onAxis?.([])
    this.map?.triggerRepaint()
  }
  /** The two steps to blend and how far between them. */
  setTime(i0: number, i1: number, t: number) {
    if (i0 === this.i0 && i1 === this.i1 && t === this.t) return
    this.i0 = i0; this.i1 = i1; this.t = t
    this.map?.triggerRepaint()
  }
  /** Particles carried by the wind at a few heights (null: none). */
  setWind(w: VolumeWind | null) {
    this.wind = w
    const n = w ? w.heightsKm.length * PER_LAYER : 0
    this.pos = new Float32Array(n * TRAIL * 3)
    this.age = new Float32Array(n)
    this.life = new Float32Array(n)
    this.speed = new Float32Array(n)
    this.verts = new Float32Array(n * (TRAIL - 1) * 2 * 7)
    for (let i = 0; i < n; i++) this.spawn(i, true)
    this.map?.triggerRepaint()
  }
  private spawn(i: number, scatter = false) {
    const w = this.wind!, top = this.draw?.grid.topKm ?? 12
    const z = Math.min(1, w.heightsKm[Math.floor(i / PER_LAYER)] / top)
    const x = Math.random(), y = Math.random()
    for (let k = 0; k < TRAIL; k++) this.pos.set([x, y, z], (i * TRAIL + k) * 3)
    this.life[i] = 70 + Math.random() * 90
    this.age[i] = scatter ? Math.random() * this.life[i] : 0
  }
  /** u and v (m/s) at a point of the box, trilinear, blended between the two time steps. */
  private sampleWind(x: number, y: number, z: number, latOf: (y: number) => number): [number, number] {
    const d = this.draw!, g = d.grid, w = this.wind!
    const fx = x * (g.nx - 1), fy = ((latOf(y) - g.lat[0]) / (g.lat[1] - g.lat[0])) * (g.ny - 1), fz = z * (g.nz - 1)
    const x0 = Math.max(0, Math.min(g.nx - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(g.ny - 2, Math.floor(fy))), z0 = Math.max(0, Math.min(g.nz - 2, Math.floor(fz)))
    const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0)), az = Math.min(1, Math.max(0, fz - z0))
    const n = g.nx * g.ny * g.nz
    const one = (arr: Uint8Array, step: number) => {
      let s = 0
      for (let c = 0; c < 8; c++) {
        const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1
        const b = arr[step * n + (z0 + dz) * g.nx * g.ny + (y0 + dy) * g.nx + x0 + dx]
        s += (b === 255 ? 127 : b) * (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az)
      }
      return w.range[0] + (s / 254) * (w.range[1] - w.range[0])
    }
    const t = this.i0 === this.i1 ? 0 : this.t
    const i0 = Math.min(this.i0, d.steps - 1), i1 = Math.min(this.i1, d.steps - 1)
    return [one(w.u, i0) * (1 - t) + one(w.u, i1) * t, one(w.v, i0) * (1 - t) + one(w.v, i1) * t]
  }
  private stepParticles(now: number) {
    const d = this.draw!, g = d.grid
    const dtf = this.lastFrame ? Math.min(3, (now - this.lastFrame) / 16.7) : 1
    this.lastFrame = now
    const yN = mercY(g.lat[1]), yS = mercY(g.lat[0])
    const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * (yN + y * (yS - yN))))) * 180) / Math.PI
    const midLat = (g.lat[0] + g.lat[1]) / 2
    const wM = (g.lon[1] - g.lon[0]) * 111320 * Math.cos((midLat * Math.PI) / 180), hM = (g.lat[1] - g.lat[0]) * 110540
    const n = this.age.length, P = this.pos
    let o = 0
    for (let i = 0; i < n; i++) {
      const b = i * TRAIL * 3
      if (P[b + 2] < this.zr[0] - 1e-6 || P[b + 2] > this.zr[1] + 1e-6) continue   // a layer outside the heights shown
      if (this.age[i] > this.life[i]) this.spawn(i)
      this.age[i] += dtf
      const x = P[b], y = P[b + 1], z = P[b + 2]
      const [u, v] = this.sampleWind(x, y, z, latOf)
      this.speed[i] = Math.hypot(u, v) * 2.23694
      P.copyWithin(b + 3, b, b + (TRAIL - 1) * 3)          // shift the history back one
      const nx = x + (u * SIM_SECONDS * dtf) / wM, ny = y - (v * SIM_SECONDS * dtf) / hM
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) { this.spawn(i); continue }
      P[b] = nx; P[b + 1] = ny
      // fade in and out over the particle's life, and along the trail
      const life = Math.min(1, this.age[i] / 12, (this.life[i] - this.age[i]) / 12)
      const [r, gg, bb] = WIND_RGB(this.speed[i])
      for (let k = 0; k < TRAIL - 1; k++) {
        const a0 = 0.95 * life * (1 - k / (TRAIL - 1)), a1 = 0.95 * life * (1 - (k + 1) / (TRAIL - 1))
        const p0 = b + k * 3, p1 = b + (k + 1) * 3
        this.verts.set([P[p0], P[p0 + 1], P[p0 + 2], r * a0, gg * a0, bb * a0, a0, P[p1], P[p1 + 1], P[p1 + 2], r * a1, gg * a1, bb * a1, a1], o)
        o += 14
      }
    }
    return o / 7
  }
  private drawParticles(gl: WebGL2RenderingContext, mvp: M4) {
    if (!this.wind || !this.trailProg || !this.draw || !this.age.length) return
    const count = this.stepParticles(performance.now())
    gl.useProgram(this.trailProg.program)
    gl.uniformMatrix4fv(this.trailProg.u("uMVP"), false, Float32Array.from(mvp))
    gl.bindVertexArray(this.trailVao!)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuf!)
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.subarray(0, count * 7), gl.STREAM_DRAW)
    gl.drawArrays(gl.LINES, 0, count)
    gl.bindVertexArray(null)
    this.map?.triggerRepaint()                               // keep them moving
  }

  /** Draw only between these heights (km); the full box by default. */
  setHeightRange(loKm: number, hiKm: number) {
    const top = this.draw?.grid.topKm ?? 12
    const zr: [number, number] = [Math.max(0, loKm / top), Math.min(1, hiKm / top)]
    if (zr[0] === this.zr[0] && zr[1] === this.zr[1]) return
    this.zr = zr
    this.map?.triggerRepaint()
  }
  setExaggeration(x: number) {
    this.exaggeration = x
    this.map?.triggerRepaint()
  }
  setOpacity(o: number) {
    this.opacity = o
    this.map?.triggerRepaint()
  }

  private stepTexture(gl: WebGL2RenderingContext, d: VolumeDraw, i: number) {
    const k = Math.max(0, Math.min(d.steps - 1, i))
    let tex = this.textures.get(k)
    if (tex) return tex
    const { nx, ny, nz } = d.grid
    const n = nx * ny * nz
    const slice = d.data.slice(k * n, (k + 1) * n)
    for (let j = 0; j < slice.length; j++) if (slice[j] === 255) slice[j] = 0     // missing: clear
    tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_3D, tex)
    resetUnpack(gl)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, nx, ny, nz, 0, gl.RED, gl.UNSIGNED_BYTE, slice)
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
                          [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_3D, p, v)
    this.textures.set(k, tex)
    return tex
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const d = this.draw
    if (!d || !this.prog || !this.vao || !this.lut || !this.map) return
    const g = d.grid
    // the box in Web Mercator: grid edges (cell centres), 0 to topKm stretched
    const x0 = mercX(g.lon[0]), x1 = mercX(g.lon[1]), yN = mercY(g.lat[1]), yS = mercY(g.lat[0])
    const midLat = (g.lat[0] + g.lat[1]) / 2
    const zTop = (g.topKm * 1000 * this.exaggeration) / (EARTH_CIRC * Math.cos((midLat * Math.PI) / 180))
    const model = new Float64Array([x1 - x0, 0, 0, 0, 0, yS - yN, 0, 0, 0, 0, zTop, 0, x0, yN, 0, 1])
    const mvp = mul(mercatorMatrix(args), model)
    const inv = invert(mvp)
    if (!inv) return

    if (d.key !== this.lutKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.lut)
      resetUnpack(gl)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, d.lut)
      this.lutKey = d.key
    }
    // The raymarch is the costly part, so it renders into an offscreen image only when the view,
    // the time or the data change (at half resolution while the map moves); other frames (wind
    // particles keep the map repainting) just draw that image again.
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight
    const scale = this.moving ? 0.5 : 1
    const fw = Math.max(1, Math.round(W * scale)), fh = Math.max(1, Math.round(H * scale))
    const key = [Array.from(mvp, (x) => x.toPrecision(9)).join(","), fw, fh, this.i0, this.i1, this.t.toFixed(4), this.exaggeration, this.opacity, this.zr.join(","), d.key].join("|")
    if (fw !== this.fboSize[0] || fh !== this.fboSize[1]) {
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex!)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
        gl.texParameteri(gl.TEXTURE_2D, k, v)
      this.fboSize = [fw, fh]
      this.lastKey = ""
    }
    if (key !== this.lastKey || this.dataChanged) {
      this.dataChanged = false
      this.lastKey = key
      const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      const prevVp = gl.getParameter(gl.VIEWPORT) as Int32Array
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo!)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex!, 0)
      gl.viewport(0, 0, fw, fh)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this.march(gl, d, mvp, inv, fw, fh, x1 - x0, yS - yN, zTop, yN, yS)
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb)
      gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3])
    }
    const bp = this.blitProg!
    gl.useProgram(bp.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex!)
    gl.uniform1i(bp.u("uImg"), 0)
    gl.uniform2f(bp.u("uViewport"), W, H)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao!)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    this.drawParticles(gl, mvp)

    if (this.lineProg && this.lineVao) {
      gl.useProgram(this.lineProg.program)
      gl.uniformMatrix4fv(this.lineProg.u("uMVP"), false, Float32Array.from(mvp))
      gl.uniform4f(this.lineProg.u("uColor"), 0.55, 0.6, 0.68, 0.55)
      gl.bindVertexArray(this.lineVao)
      gl.drawArrays(gl.LINES, 0, EDGES.length / 3)
      if (this.zr[0] > 0 || this.zr[1] < 1) {
        // the slab being drawn, outlined a little stronger inside the full box
        const slab = mul(mvp, new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, this.zr[1] - this.zr[0], 0, 0, 0, this.zr[0], 1]))
        gl.uniformMatrix4fv(this.lineProg.u("uMVP"), false, Float32Array.from(slab))
        gl.uniform4f(this.lineProg.u("uColor"), 0.35, 0.4, 0.5, 0.8)
        gl.drawArrays(gl.LINES, 0, EDGES.length / 3)
      }
    }
    gl.bindVertexArray(null)
    gl.activeTexture(gl.TEXTURE0)
    this.axis(mvp, g)
  }

  private march(gl: WebGL2RenderingContext, d: VolumeDraw, mvp: M4, inv: M4, fw: number, fh: number,
                sx: number, sy: number, sz: number, yN: number, yS: number) {
    const g = d.grid
    void mvp
    const p = this.prog!
    gl.useProgram(p.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, this.stepTexture(gl, d, this.i0))
    gl.uniform1i(p.u("uA"), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.stepTexture(gl, d, this.i1))
    gl.uniform1i(p.u("uB"), 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.lut!)
    gl.uniform1i(p.u("uLut"), 2)
    gl.uniformMatrix4fv(p.u("uInv"), false, Float32Array.from(inv))
    gl.uniform2f(p.u("uViewport"), fw, fh)
    gl.uniform1f(p.u("uT"), this.i0 === this.i1 ? 0 : this.t)
    gl.uniform1f(p.u("uOpacity"), this.opacity)
    gl.uniform1f(p.u("uDensity"), 30)
    gl.uniform3f(p.u("uScale"), sx, sy, sz)
    gl.uniform2f(p.u("uMercY"), yN, yS)
    gl.uniform2f(p.u("uLat"), g.lat[0], g.lat[1])
    gl.uniform3f(p.u("uSize"), g.nx, g.ny, g.nz)
    gl.uniform1i(p.u("uSteps"), this.moving ? 96 : 192)
    gl.uniform2f(p.u("uZr"), this.zr[0], this.zr[1])
    gl.uniform1i(p.u("uLit"), d.lit ? 1 : 0)
    const isos = d.isos ?? []
    gl.uniform1i(p.u("uIsoN"), isos.length)
    if (isos.length) {
      gl.uniform1fv(p.u("uIso[0]"), Float32Array.from({ length: 6 }, (_, i) => isos[i]?.at ?? 2))
      gl.uniform4fv(p.u("uIsoCol[0]"), Float32Array.from({ length: 24 }, (_, i) => isos[i >> 2]?.rgba[i & 3] ?? 0))
    }
    gl.uniform1i(p.u("uIsoByHeight"), d.heightLut ? 1 : 0)
    // always bound to its own unit: a 2D sampler left on unit 0 would share it with uA's 3D texture,
    // which WebGL refuses to draw
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex!)
    gl.uniform1i(p.u("uHeight"), 3)
    if (d.heightLut) {
      if (this.heightKey !== d.key) {
        resetUnpack(gl)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.heightLut)
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
          gl.texParameteri(gl.TEXTURE_2D, k, v)
        this.heightKey = d.key
      }
    }

    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.BLEND)              // the image starts clear and the march composites itself
    gl.bindVertexArray(this.vao!)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

  /** Height ticks up the box's south-west edge and pressure levels up its south-east edge. */
  private axis(mvp: M4, g: VolumeGrid) {
    if (!this.onAxis || !this.map) return
    const c = this.map.getCanvas()
    const w = c.clientWidth, h = c.clientHeight
    const at = (x: number, y: number, z: number) => {
      const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]
      const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]
      const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15]
      return cw > 0 ? { x: ((cx / cw + 1) / 2) * w, y: ((1 - cy / cw) / 2) * h } : null
    }
    const pts: AxisPoint[] = []
    for (let km = 0; km <= g.topKm; km += 2) {
      const q = at(0, 1, km / g.topKm)
      if (q) pts.push({ ...q, label: `${km} km`, side: "left" })
    }
    for (const l of this.levels) {
      if (![1000, 850, 700, 500, 300, 200].includes(l.hPa) || l.km > g.topKm) continue
      const q = at(1, 1, Math.max(0, l.km) / g.topKm)
      if (q) pts.push({ ...q, label: `${l.hPa} mb`, side: "right" })
    }
    this.onAxis(pts)
  }
}
