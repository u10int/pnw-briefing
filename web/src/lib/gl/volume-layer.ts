import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl"

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
uniform bool uLit;              // shade by what lies above (clouds and the like); else flat colour
out vec4 fragColor;
const float PI = 3.141592653589793;

vec3 texPos(vec3 p) {
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * mix(uMercY.x, uMercY.y, p.y)))));
  vec3 f = vec3(p.x, (lat - uLat.x) / (uLat.y - uLat.x), p.z);
  return (f * (uSize - 1.0) + 0.5) / uSize;               // cell centres span the box
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
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
  vec3 t0 = (vec3(0.0) - ro) * inv, t1 = (vec3(1.0) - ro) * inv;
  vec3 tlo = min(t0, t1), thi = max(t0, t1);
  float tn = max(max(tlo.x, tlo.y), max(tlo.z, 0.0));
  float tf = min(min(thi.x, thi.y), thi.z);
  if (tf <= tn) discard;
  // steps sized in box units across its diagonal; the opacity of each follows its true length
  float dt = 1.7320508 / float(uSteps) / length(rd);
  float worldStep = length(rd * dt * uScale) / uScale.x;   // in box widths
  vec4 acc = vec4(0.0);
  float t = tn + dt * hash(gl_FragCoord.xy);
  for (int i = 0; i < 512; i++) {
    if (t > tf || acc.a > 0.97) break;
    vec3 p = ro + rd * t;
    vec3 q = texPos(p);
    if (q.y >= 0.0 && q.y <= 1.0) {
      float v = mix(texture(uA, q).r, texture(uB, q).r, uT);
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
  private opacity = 1
  private moving = false
  private dataChanged = false
  private levels: { hPa: number; km: number }[] = []
  onAxis: ((pts: AxisPoint[]) => void) | null = null

  constructor(readonly id: string) {}

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map
    this.gl = gl
    this.prog = program(gl, VS, FS)
    this.lineProg = program(gl, LINE_VS, LINE_FS)
    this.blitProg = program(gl, VS, BLIT_FS)
    this.fbo = gl.createFramebuffer()!
    this.fboTex = gl.createTexture()!
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
    const key = [Array.from(mvp, (x) => x.toPrecision(9)).join(","), fw, fh, this.i0, this.i1, this.t.toFixed(4), this.exaggeration, this.opacity, d.key].join("|")
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

    if (this.lineProg && this.lineVao) {
      gl.useProgram(this.lineProg.program)
      gl.uniformMatrix4fv(this.lineProg.u("uMVP"), false, Float32Array.from(mvp))
      gl.uniform4f(this.lineProg.u("uColor"), 0.55, 0.6, 0.68, 0.55)
      gl.bindVertexArray(this.lineVao)
      gl.drawArrays(gl.LINES, 0, EDGES.length / 3)
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
    gl.uniform1i(p.u("uLit"), d.lit ? 1 : 0)

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
