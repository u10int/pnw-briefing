import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl"

import { PTYPE_COLORS, PTYPE_NAMES, type Ramp, REFC } from "@/lib/ramps"
import { fieldTextures, GLSL_GRID, type Grid, mercatorMatrix, mercX, mercY, program, type Program, setGridUniforms, texture, unitQuad } from "./util"

/**
 * How a grid is coloured.
 * - ramp:  a continuous value through a stepped colour ramp
 * - ptype: precipitation-type codes (categories: never interpolated in space or time)
 * - refc:  reflectivity through the ramp for its precipitation type (from `aux`)
 */
export type Paint = { kind: "ramp"; ramp: Ramp } | { kind: "ptype" } | { kind: "refc" }

export interface GridDraw {
  grid: Grid
  paint: Paint
  /** Values at the earlier time, and (optionally) the later one to interpolate towards. */
  a: Float32Array
  b?: Float32Array | null
  /** Precipitation type at those times, for `refc`. */
  auxA?: Float32Array | null
  auxB?: Float32Array | null
}

// up to 256 levels: Maue's temperature table has 201 one-degree bands. The levels sit in a float
// texture (a uniform array that long would run past some GPUs' uniform limits)
const MAX_LEVELS = 256
const LUT_W = MAX_LEVELS, LUT_H = 6

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
uniform mat4 uMatrix;
uniform vec4 uBounds;   // Web Mercator x0, y0 (north), x1, y1 (south)
out vec2 vMerc;
void main() {
  vMerc = mix(uBounds.xy, uBounds.zw, aPos);
  gl_Position = uMatrix * vec4(vMerc, 0.0, 1.0);
}`

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${GLSL_GRID}
uniform sampler2D uA, uB, uAuxA, uAuxB, uLut, uLevelTex;
uniform bool uHasB, uHasAux, uSmooth, uClampLow;
uniform float uT, uOpacity;
uniform int uMode, uNLevels, uNColors;
in vec2 vMerc;
out vec4 fragColor;

// One cell, blended between the two times (a missing side falls back to the other).
float cell(ivec2 p) {
  float a = tap(uA, p);
  if (!uHasB || uT <= 0.0) return a;
  float b = tap(uB, p);
  if (miss(a)) return b;
  if (miss(b)) return a;
  return mix(a, b, uT);
}
// Categories take the nearer time.
float category(sampler2D a, sampler2D b, bool hasB, ivec2 p) {
  return (hasB && uT >= 0.5) ? tap(b, p) : tap(a, p);
}

vec4 cr(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4((-t3 + 2.0 * t2 - t), (3.0 * t3 - 5.0 * t2 + 2.0), (-3.0 * t3 + 4.0 * t2 + t), (t3 - t2)) * 0.5;
}

// Catmull-Rom bicubic, clamped to the four surrounding cells so it never overshoots. If any of the
// 16 taps is missing, bilinear over the surrounding cells that exist, so data edges stay clean.
float bicubic(vec2 f) {
  vec2 fl = floor(f);
  ivec2 i0 = ivec2(fl);
  vec2 t = f - fl;
  float c00 = cell(i0), c10 = cell(i0 + ivec2(1, 0)), c01 = cell(i0 + ivec2(0, 1)), c11 = cell(i0 + ivec2(1, 1));
  float lo = 1.0e38, hi = -1.0e38, ws = 0.0, s = 0.0;
  vec4 c = vec4(c00, c10, c01, c11);
  vec4 bw = vec4((1.0 - t.x) * (1.0 - t.y), t.x * (1.0 - t.y), (1.0 - t.x) * t.y, t.x * t.y);
  for (int k = 0; k < 4; k++) {
    if (!miss(c[k])) { lo = min(lo, c[k]); hi = max(hi, c[k]); s += c[k] * bw[k]; ws += bw[k]; }
  }
  if (ws <= 0.0) return MISSING;
  vec4 wx = cr(t.x), wy = cr(t.y);
  float sum = 0.0;
  for (int j = 0; j < 4; j++) {
    float row = 0.0;
    for (int i = 0; i < 4; i++) {
      float v = cell(i0 + ivec2(i - 1, j - 1));
      if (miss(v)) return s / ws;
      row += wx[i] * v;
    }
    sum += wy[j] * row;
  }
  return clamp(sum, lo, hi);
}

vec4 lut(int bin, int row) { return texelFetch(uLut, ivec2(clamp(bin, 0, uNColors - 1), row), 0); }

float level(int k) { return texelFetch(uLevelTex, ivec2(k, 0), 0).r; }

vec4 ramp(float v, int row) {
  if (v < level(0)) return uClampLow ? lut(0, row) : vec4(0.0);
  // the last level at or below v, by binary search (8 steps cover 256 levels)
  int lo = 0, hi = uNLevels - 1;
  for (int i = 0; i < 9; i++) {
    if (lo >= hi) break;
    int mid = (lo + hi + 1) / 2;
    if (v >= level(mid)) lo = mid; else hi = mid - 1;
  }
  return lut(lo, row);
}

void main() {
  vec2 f = gridPos(vMerc);
  if (!inside(f)) discard;
  ivec2 near = ivec2(floor(f + 0.5));
  vec4 color;
  if (uMode == 1) {
    int code = int(category(uA, uB, uHasB, near) + 0.5);
    if (code <= 0) discard;
    color = lut(code, 0);
  } else {
    float v = uSmooth ? bicubic(f) : cell(near);
    if (miss(v)) discard;
    if (uMode == 2) {
      if (!(v >= 5.0)) discard;
      int code = uHasAux ? int(category(uAuxA, uAuxB, uHasB, near) + 0.5) : 1;
      if (code < 1 || code > 5) code = 1;
      color = ramp(v, code - 1);
    } else {
      color = ramp(v, 0);
    }
  }
  float a = color.a * uOpacity;
  fragColor = vec4(color.rgb * a, a);
}`

const rgb = (h: string) => {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Colour table for a paint: rows of up to MAX_LEVELS bins, plus the level boundaries. */
function lutFor(p: Paint): { pixels: Uint8Array; levels: number[]; colors: number; clampLow: boolean } {
  const px = new Uint8Array(LUT_W * LUT_H * 4)
  const put = (row: number, bin: number, hex: string, alpha = 255) => {
    const [r, g, b] = rgb(hex)
    px.set([r, g, b, alpha], (row * LUT_W + bin) * 4)
  }
  if (p.kind === "ramp") {
    p.ramp.colors.forEach((c, i) => put(0, i, c))
    return { pixels: px, levels: p.ramp.levels, colors: p.ramp.colors.length, clampLow: !!p.ramp.clampLow }
  }
  if (p.kind === "ptype") {
    PTYPE_NAMES.forEach((name, code) => PTYPE_COLORS[name] && put(0, code, PTYPE_COLORS[name], 205))
    return { pixels: px, levels: [0], colors: PTYPE_NAMES.length, clampLow: false }
  }
  // refc: one row per precipitation type, in code order (rain=1 → row 0)
  PTYPE_NAMES.slice(1).forEach((name, row) => (REFC[name] ?? REFC.rain).colors.forEach((c, i) => put(row, i, c)))
  return { pixels: px, levels: REFC.rain.levels, colors: REFC.rain.colors.length, clampLow: false }
}

const paintKey = (p: Paint) => (p.kind === "ramp" ? `ramp:${p.ramp.label}:${p.ramp.levels.join(",")}` : p.kind)

/**
 * Draws one gridded field straight from its raw values: the GPU looks up each screen pixel's
 * exact lat/lon (inverse Web Mercator), samples the grid (nearest or bicubic), blends two forecast
 * times, and colours the result. Changing the time fraction, smoothing or opacity is a uniform.
 */
export class GridLayer implements CustomLayerInterface {
  readonly type = "custom" as const
  readonly renderingMode = "2d" as const
  private map?: MlMap
  private gl?: WebGL2RenderingContext
  private prog?: Program
  private vao?: WebGLVertexArrayObject
  private lut?: WebGLTexture
  private levelTex?: WebGLTexture
  private lutKey = ""
  private lutInfo?: ReturnType<typeof lutFor>
  private draw: GridDraw | null = null
  private t = 0
  private smooth = false
  private opacity = 0.85

  constructor(readonly id: string) {}

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map
    this.gl = gl
    this.prog = program(gl, VS, FS)
    this.vao = unitQuad(gl)
    this.lut = texture(gl, gl.RGBA8, LUT_W, LUT_H, gl.RGBA, gl.UNSIGNED_BYTE, null)
    this.levelTex = texture(gl, gl.R32F, MAX_LEVELS, 1, gl.RED, gl.FLOAT, null)
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    if (this.prog) gl.deleteProgram(this.prog.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.lut) gl.deleteTexture(this.lut)
    if (this.levelTex) gl.deleteTexture(this.levelTex)
  }

  setDraw(d: GridDraw | null, t = 0) {
    this.draw = d
    this.t = t
    this.map?.triggerRepaint()
  }
  setT(t: number) {
    if (t === this.t) return
    this.t = t
    this.map?.triggerRepaint()
  }
  setSmooth(s: boolean) {
    this.smooth = s
    this.map?.triggerRepaint()
  }
  setOpacity(o: number) {
    this.opacity = o
    this.map?.triggerRepaint()
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const d = this.draw
    if (!d || !this.prog || !this.vao || !this.lut || !this.levelTex) return
    const p = this.prog
    const tex = fieldTextures(gl)
    const key = paintKey(d.paint)
    if (key !== this.lutKey) {
      this.lutInfo = lutFor(d.paint)
      gl.bindTexture(gl.TEXTURE_2D, this.lut)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_W, LUT_H, gl.RGBA, gl.UNSIGNED_BYTE, this.lutInfo.pixels)
      const lv = new Float32Array(MAX_LEVELS).fill(3e38)
      lv.set(this.lutInfo.levels.slice(0, MAX_LEVELS))
      gl.bindTexture(gl.TEXTURE_2D, this.levelTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_LEVELS, 1, gl.RED, gl.FLOAT, lv)
      this.lutKey = key
    }
    const info = this.lutInfo!
    const g = d.grid
    const hasB = !!d.b && d.b !== d.a
    const hasAux = !!d.auxA

    gl.useProgram(p.program)
    const bind = (unit: number, name: string, t: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.uniform1i(p.u(name), unit)
    }
    const ta = tex.get(g, d.a)
    bind(0, "uA", ta)
    bind(1, "uB", hasB ? tex.get(g, d.b!) : ta)
    const tx = hasAux ? tex.get(g, d.auxA!) : ta
    bind(2, "uAuxA", tx)
    bind(3, "uAuxB", hasAux && d.auxB ? tex.get(g, d.auxB) : tx)
    bind(4, "uLut", this.lut)
    bind(5, "uLevelTex", this.levelTex)

    gl.uniformMatrix4fv(p.u("uMatrix"), false, mercatorMatrix(args))
    gl.uniform4f(p.u("uBounds"), mercX(g.west), mercY(g.north), mercX(g.east), mercY(g.south))
    setGridUniforms(gl, p, g)
    gl.uniform1i(p.u("uHasB"), hasB ? 1 : 0)
    gl.uniform1i(p.u("uHasAux"), hasAux ? 1 : 0)
    gl.uniform1i(p.u("uSmooth"), this.smooth && d.paint.kind !== "ptype" ? 1 : 0)
    gl.uniform1i(p.u("uClampLow"), info.clampLow ? 1 : 0)
    gl.uniform1f(p.u("uT"), hasB ? this.t : 0)
    gl.uniform1f(p.u("uOpacity"), this.opacity)
    gl.uniform1i(p.u("uMode"), d.paint.kind === "ptype" ? 1 : d.paint.kind === "refc" ? 2 : 0)
    gl.uniform1i(p.u("uNLevels"), Math.min(info.levels.length, MAX_LEVELS))
    gl.uniform1i(p.u("uNColors"), info.colors)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
    gl.activeTexture(gl.TEXTURE0)
  }
}
