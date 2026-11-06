import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl"

import { fieldTextures, GLSL_GRID, type Grid, mercatorMatrix, mercX, mercY, program, type Program, setGridUniforms, texture } from "./util"

export interface WindDraw {
  grid: Grid
  /** 10 m wind components (mph) at the earlier time, and optionally the later one. */
  u0: Float32Array; v0: Float32Array
  u1?: Float32Array | null; v1?: Float32Array | null
}

/** Particle state lives in an N×N float texture: xy = Web Mercator position, z = age (s), w = lifespan (s). */
const N = 128

const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const UPDATE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${GLSL_GRID}
uniform sampler2D uState, uU0, uV0, uU1, uV1;
uniform bool uHasB;
uniform float uT, uDt, uSeed, uSpeed, uDrop;
uniform vec4 uSpawn;   // area new particles start in (viewport ∩ grid), Web Mercator x0 y0 x1 y1
uniform vec4 uView;    // the viewport, with a margin
out vec4 o;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float comp(sampler2D a, sampler2D b, ivec2 p) {
  float x = tap(a, p);
  if (!uHasB) return x;
  float y = tap(b, p);
  if (miss(x) || miss(y)) return MISSING;
  return mix(x, y, uT);
}
// Bilinear wind at a grid position; x = MISSING when any surrounding cell is missing.
vec2 wind(vec2 f) {
  vec2 fl = floor(f);
  ivec2 i = ivec2(fl);
  vec2 t = f - fl;
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    ivec2 d = ivec2(k & 1, k >> 1);
    float u = comp(uU0, uU1, i + d), v = comp(uV0, uV1, i + d);
    if (miss(u) || miss(v)) return vec2(MISSING);
    float w = (d.x == 1 ? t.x : 1.0 - t.x) * (d.y == 1 ? t.y : 1.0 - t.y);
    acc += vec2(u, v) * w;
  }
  return acc;
}

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, id, 0);
  vec2 seed = vec2(id) * 1.37 + uSeed;
  bool reset = s.w <= 0.0 || s.z >= s.w || hash(seed + 0.71) < uDrop * uDt;
  if (!reset) {
    vec2 f = gridPos(s.xy);
    vec2 w = inside(f) ? wind(f) : vec2(MISSING);
    if (miss(w.x)) reset = true;
    else {
      // Web Mercator is conformal, so a constant screen speed per mph keeps directions true.
      s.xy += vec2(w.x, -w.y) * uSpeed * uDt;
      s.z += uDt;
      if (s.x < uView.x || s.x > uView.z || s.y < uView.y || s.y > uView.w) reset = true;
    }
  }
  if (reset) {
    s.xy = mix(uSpawn.xy, uSpawn.zw, vec2(hash(seed + 1.3), hash(seed + 7.9)));
    s.z = 0.0;
    s.w = 1.2 + 2.8 * hash(seed + 3.3);
  }
  o = s;
}`

// Each particle is a short quad from its previous to its current position, drawn into the trail.
const DRAW_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uPrev, uCur;
uniform mat4 uMatrix;
uniform vec2 uViewport;   // drawing buffer size in pixels
uniform float uWidth;     // line width in pixels
out float vAlpha;
out float vAcross;
void main() {
  int pid = gl_VertexID / 6, k = gl_VertexID % 6;
  ivec2 tc = ivec2(pid % ${N}, pid / ${N});
  vec4 p0 = texelFetch(uPrev, tc, 0), p1 = texelFetch(uCur, tc, 0);
  if (p1.z <= p0.z || p1.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; vAcross = 0.0; return; }
  vec4 c0 = uMatrix * vec4(p0.xy, 0.0, 1.0), c1 = uMatrix * vec4(p1.xy, 0.0, 1.0);
  vec2 s0 = c0.xy / c0.w * 0.5 * uViewport, s1 = c1.xy / c1.w * 0.5 * uViewport;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float end = (k == 1 || k == 2 || k == 4) ? 1.0 : 0.0;
  float side = (k == 2 || k == 4 || k == 5) ? 1.0 : -1.0;
  float hw = uWidth * 0.5 + 0.5;
  vec2 pos = mix(s0, s1, end) + nrm * side * hw + dir * (end * 2.0 - 1.0) * uWidth * 0.5;
  gl_Position = vec4(pos / (0.5 * uViewport), 0.0, 1.0);
  // fade in and out over a particle's life; near-calm particles barely show
  float life = min(p1.z / 0.35, 1.0) * clamp((p1.w - p1.z) / 0.6, 0.0, 1.0);
  vAlpha = life * smoothstep(0.15, 0.9, len);
  vAcross = side * hw;
}`

const DRAW_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uColor;      // premultiplied
uniform float uWidth;
in float vAlpha;
in float vAcross;
out vec4 o;
void main() {
  float edge = clamp(uWidth * 0.5 + 0.5 - abs(vAcross), 0.0, 1.0);
  o = uColor * (vAlpha * edge);
}`

const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTrail;
uniform float uFade;
out vec4 o;
void main() {
  // subtracting a little more than half a step lets 8-bit trails actually reach zero
  o = max(texelFetch(uTrail, ivec2(gl_FragCoord.xy), 0) * uFade - 0.6 / 255.0, 0.0);
}`

const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTrail;
uniform float uOpacity;
out vec4 o;
void main() { o = texelFetch(uTrail, ivec2(gl_FragCoord.xy), 0) * uOpacity; }`

/**
 * Animated wind particles advected on the GPU through the (time-blended) 10 m wind, with fading
 * screen-space trails. Trails are cleared while the camera moves, so they never smear.
 */
export class ParticleLayer implements CustomLayerInterface {
  readonly type = "custom" as const
  readonly renderingMode = "2d" as const
  private map?: MlMap
  private supported = true
  private update?: Program
  private drawP?: Program
  private fade?: Program
  private composite?: Program
  private vao?: WebGLVertexArrayObject
  private state: WebGLTexture[] = []
  private stateFb: WebGLFramebuffer[] = []
  private trail: WebGLTexture[] = []
  private trailFb: WebGLFramebuffer[] = []
  private trailSize: [number, number] = [0, 0]
  private cur = 0
  private tcur = 0
  private lastMatrix = new Float32Array(16)
  private lastTime = 0
  private wind: WindDraw | null = null
  private t = 0
  private color: [number, number, number, number] = [20, 24, 29, 0.85]
  private enabled = true
  private frame = 0

  constructor(readonly id: string) {}

  /** False when the browser can't render to float textures; the map then shows no particles. */
  get available() { return this.supported }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map
    if (!gl.getExtension("EXT_color_buffer_float")) { this.supported = false; return }
    this.update = program(gl, FULLSCREEN_VS, UPDATE_FS)
    this.drawP = program(gl, DRAW_VS, DRAW_FS)
    this.fade = program(gl, FULLSCREEN_VS, FADE_FS)
    this.composite = program(gl, FULLSCREEN_VS, COMPOSITE_FS)
    this.vao = gl.createVertexArray()!   // all vertices come from gl_VertexID
    for (let i = 0; i < 2; i++) {
      const t = texture(gl, gl.RGBA32F, N, N, gl.RGBA, gl.FLOAT, new Float32Array(N * N * 4))
      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) this.supported = false
      this.state.push(t)
      this.stateFb.push(fb)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    for (const p of [this.update, this.drawP, this.fade, this.composite]) if (p) gl.deleteProgram(p.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    for (const t of [...this.state, ...this.trail]) gl.deleteTexture(t)
    for (const f of [...this.stateFb, ...this.trailFb]) gl.deleteFramebuffer(f)
  }

  setWind(w: WindDraw | null, t = 0) {
    this.wind = w
    this.t = t
    this.map?.triggerRepaint()
  }
  setT(t: number) { this.t = t }
  setEnabled(on: boolean) {
    this.enabled = on
    this.map?.triggerRepaint()
  }
  /** Line colour, straight (not premultiplied) RGB 0 – 255 and alpha 0 – 1. */
  setColor(c: [number, number, number, number]) { this.color = c }

  private active() { return this.supported && this.enabled && !!this.wind && !!this.update }

  private ensureTrail(gl: WebGL2RenderingContext) {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    if (this.trailSize[0] === w && this.trailSize[1] === h) return
    for (const t of this.trail) gl.deleteTexture(t)
    for (const f of this.trailFb) gl.deleteFramebuffer(f)
    this.trail = []
    this.trailFb = []
    for (let i = 0; i < 2; i++) {
      const t = texture(gl, gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE, null)
      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this.trail.push(t)
      this.trailFb.push(fb)
    }
    this.trailSize = [w, h]
  }

  prerender(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.active() || !this.map) return
    const w = this.wind!
    const g = w.grid
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array
    const now = performance.now()
    const dt = this.lastTime ? Math.min(0.05, (now - this.lastTime) / 1000) : 1 / 60
    this.lastTime = now
    this.ensureTrail(gl)

    // viewport and spawn area in Web Mercator
    const b = this.map.getBounds()
    const vx0 = mercX(b.getWest()), vx1 = mercX(b.getEast()), vy0 = mercY(b.getNorth()), vy1 = mercY(b.getSouth())
    const gx0 = mercX(g.west), gx1 = mercX(g.east), gy0 = mercY(g.north), gy1 = mercY(g.south)
    const sx0 = Math.max(vx0, gx0), sx1 = Math.min(vx1, gx1), sy0 = Math.max(vy0, gy0), sy1 = Math.min(vy1, gy1)
    const visible = sx1 > sx0 && sy1 > sy0
    const mx = (vx1 - vx0) * 0.05, my = (vy1 - vy0) * 0.05

    // screen-constant speed: ~3 CSS px per second per mph
    const worldPx = 512 * Math.pow(2, this.map.getZoom())
    const speed = 3.0 / worldPx

    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.bindVertexArray(this.vao!)
    const tex = fieldTextures(gl)

    // 1. advect particles
    if (visible) {
      const p = this.update!
      const next = 1 - this.cur
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFb[next])
      gl.viewport(0, 0, N, N)
      gl.useProgram(p.program)
      const bind = (unit: number, name: string, t: WebGLTexture) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.uniform1i(p.u(name), unit)
      }
      const hasB = !!(w.u1 && w.v1)
      bind(0, "uState", this.state[this.cur])
      bind(1, "uU0", tex.get(g, w.u0))
      bind(2, "uV0", tex.get(g, w.v0))
      bind(3, "uU1", tex.get(g, hasB ? w.u1! : w.u0))
      bind(4, "uV1", tex.get(g, hasB ? w.v1! : w.v0))
      setGridUniforms(gl, p, g)
      gl.uniform1i(p.u("uHasB"), hasB ? 1 : 0)
      gl.uniform1f(p.u("uT"), hasB ? this.t : 0)
      gl.uniform1f(p.u("uDt"), dt)
      gl.uniform1f(p.u("uSeed"), (this.frame++ % 997) * 0.618)
      gl.uniform1f(p.u("uSpeed"), speed)
      gl.uniform1f(p.u("uDrop"), 0.05)
      gl.uniform4f(p.u("uSpawn"), sx0, sy0, sx1, sy1)
      gl.uniform4f(p.u("uView"), vx0 - mx, vy0 - my, vx1 + mx, vy1 + my)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      this.cur = next
    }

    // 2. fade the trail (or clear it if the camera moved), then draw this frame's segments
    const m = mercatorMatrix(args)
    let moved = false
    for (let i = 0; i < 16; i++) if (m[i] !== this.lastMatrix[i]) { moved = true; break }
    this.lastMatrix.set(m)
    const [W, H] = this.trailSize
    const tnext = 1 - this.tcur
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFb[tnext])
    gl.viewport(0, 0, W, H)
    if (moved) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    } else {
      const p = this.fade!
      gl.useProgram(p.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.trail[this.tcur])
      gl.uniform1i(p.u("uTrail"), 0)
      gl.uniform1f(p.u("uFade"), Math.pow(0.9, dt * 60))
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    if (visible) {
      const p = this.drawP!
      gl.useProgram(p.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.state[1 - this.cur])
      gl.uniform1i(p.u("uPrev"), 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.state[this.cur])
      gl.uniform1i(p.u("uCur"), 1)
      gl.uniformMatrix4fv(p.u("uMatrix"), false, m)
      gl.uniform2f(p.u("uViewport"), W, H)
      const dpr = W / Math.max(1, this.map.getCanvas().clientWidth)
      gl.uniform1f(p.u("uWidth"), 1.1 * dpr)
      const [r, gg, bb, a] = this.color
      gl.uniform4f(p.u("uColor"), (r / 255) * a, (gg / 255) * a, (bb / 255) * a, a)
      // particle count follows the visible area of the grid: ~1 per 90 CSS px²
      const cssArea = (W * H) / (dpr * dpr)
      const frac = ((sx1 - sx0) * (sy1 - sy0)) / ((vx1 - vx0) * (vy1 - vy0))
      const count = Math.min(N * N, Math.max(500, Math.round((cssArea * frac) / 90)))
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.drawArrays(gl.TRIANGLES, 0, count * 6)
    }
    this.tcur = tnext

    gl.bindVertexArray(null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb)
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3])
  }

  render(gl: WebGL2RenderingContext) {
    if (!this.active() || !this.trail.length) return
    const p = this.composite!
    gl.useProgram(p.program)
    gl.bindVertexArray(this.vao!)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.trail[this.tcur])
    gl.uniform1i(p.u("uTrail"), 0)
    gl.uniform1f(p.u("uOpacity"), 1)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    // keep animating
    this.map?.triggerRepaint()
  }
}
