// Small WebGL2 helpers shared by the grid and particle layers.

export interface Grid {
  width: number; height: number
  west: number; south: number; east: number; north: number
}

/** Sentinel for missing cells in float textures (NaN isn't reliable to test for in GLSL). */
export const MISSING = -1.0e30

export const mercX = (lon: number) => (lon + 180) / 360
export const mercY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2

export interface Program {
  program: WebGLProgram
  u: (name: string) => WebGLUniformLocation | null
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(s)
    gl.deleteShader(s)
    throw new Error(`shader: ${log}`)
  }
  return s
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const p = gl.createProgram()!
  const v = compile(gl, gl.VERTEX_SHADER, vs), f = compile(gl, gl.FRAGMENT_SHADER, fs)
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`link: ${gl.getProgramInfoLog(p)}`)
  const locs = new Map<string, WebGLUniformLocation | null>()
  return {
    program: p,
    u: (name) => {
      if (!locs.has(name)) locs.set(name, gl.getUniformLocation(p, name))
      return locs.get(name)!
    },
  }
}

/** Upload state MapLibre may have left set (flip, premultiply) would corrupt raw data uploads. */
export function resetUnpack(gl: WebGL2RenderingContext) {
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
}

export function texture(gl: WebGL2RenderingContext, internal: number, w: number, h: number, format: number, type: number,
                        data: ArrayBufferView | null, filter: number = gl.NEAREST): WebGLTexture {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  resetUnpack(gl)
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data)
  return t
}

/**
 * Raw grids as R32F textures, one per Float32Array (bands are cached upstream, so identity is a
 * good key). Shared by every layer on one GL context; least recently used textures are freed.
 */
export class FieldTextures {
  private map = new Map<Float32Array, WebGLTexture>()
  constructor(private gl: WebGL2RenderingContext, private limit = 72) {}

  get(grid: Grid, data: Float32Array): WebGLTexture {
    const hit = this.map.get(data)
    if (hit) {
      this.map.delete(data)
      this.map.set(data, hit)
      return hit
    }
    const gl = this.gl
    const clean = new Float32Array(data.length)
    for (let i = 0; i < data.length; i++) clean[i] = Number.isFinite(data[i]) ? data[i] : MISSING
    // creating the texture binds it to the active unit; put back whatever was bound there, since
    // callers fetch textures while binding others (a new band would otherwise replace the one just
    // bound for the earlier step, and the map would show the later step for a frame)
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
    const t = texture(gl, gl.R32F, grid.width, grid.height, gl.RED, gl.FLOAT, clean)
    gl.bindTexture(gl.TEXTURE_2D, prev)
    this.map.set(data, t)
    while (this.map.size > this.limit) {
      const [k, old] = this.map.entries().next().value!
      gl.deleteTexture(old)
      this.map.delete(k)
    }
    return t
  }

  dispose() {
    for (const t of this.map.values()) this.gl.deleteTexture(t)
    this.map.clear()
  }
}

const shared = new WeakMap<WebGL2RenderingContext, FieldTextures>()
export const fieldTextures = (gl: WebGL2RenderingContext) => {
  if (!shared.has(gl)) shared.set(gl, new FieldTextures(gl))
  return shared.get(gl)!
}

/** A VAO holding one attribute: the unit square as two triangles. */
export function unitQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  const buf = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return vao
}

/** GLSL shared by both layers: grid lookup from Web Mercator, with missing-value handling. */
export const GLSL_GRID = /* glsl */ `
const float PI = 3.141592653589793;
const float MISSING = -1.0e30;
bool miss(float v) { return v < -1.0e29; }
// x: west, y: north, z: degrees per column, w: degrees per row
uniform vec4 uGeo;
uniform ivec2 uSize;
// Fractional grid position (cell centres at whole numbers) of a Web Mercator point.
vec2 gridPos(vec2 merc) {
  float lon = merc.x * 360.0 - 180.0;
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * merc.y))));
  return vec2((lon - uGeo.x) / uGeo.z, (uGeo.y - lat) / uGeo.w) - 0.5;
}
bool inside(vec2 f) {
  return f.x >= -0.5 && f.y >= -0.5 && f.x < float(uSize.x) - 0.5 && f.y < float(uSize.y) - 0.5;
}
float tap(sampler2D s, ivec2 p) { return texelFetch(s, clamp(p, ivec2(0), uSize - 1), 0).r; }
`

export function setGridUniforms(gl: WebGL2RenderingContext, p: Program, g: Grid) {
  gl.uniform4f(p.u("uGeo"), g.west, g.north, (g.east - g.west) / g.width, (g.north - g.south) / g.height)
  gl.uniform2i(p.u("uSize"), g.width, g.height)
}

/** Camera matrix for Web Mercator coordinates in 0..1 (MapLibre's own `modelViewProjectionMatrix` is in world pixels). */
export const mercatorMatrix = (args: { defaultProjectionData: { mainMatrix: ArrayLike<number> } }) =>
  Float32Array.from(args.defaultProjectionData.mainMatrix)

export const sameGrid = (a: Grid, b: Grid) =>
  a.width === b.width && a.height === b.height && a.west === b.west && a.north === b.north && a.east === b.east && a.south === b.south
