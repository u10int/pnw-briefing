import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl"

import { WIND } from "@/lib/ramps"

import type { GridDraw } from "./grid-layer"
import { PrecipFx } from "./precip-fx"
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
  /** Colours by height (256 RGBA over 0 – topKm): the surfaces' when isoByHeight, the volume's or the
   *  solid's when colorMode is "height". */
  heightLut?: Uint8Array
  isoByHeight?: boolean
  /** The volume's (and solid's) colour: its own, by height, or by a second field (colorBy). */
  colorMode?: "own" | "height" | "field"
  colorBy?: { data: Uint8Array; lut: Uint8Array }
  /** An opaque surface where the field reaches `at` (packed fraction), in `rgb` (0 – 1) unless coloured. */
  solid?: { at: number; rgb: [number, number, number] } | null
  /** Shadows on the ground from the solid, or from the lit field. */
  shadow?: boolean
  /** No field to draw: only the box and what goes in it (particles, precipitation, overlays). */
  empty?: boolean
}

/** Wind for the particles: u and v (m/s) packed like the other fields, every time step. */
export interface VolumeWind {
  u: Uint8Array; v: Uint8Array
  range: [number, number]
  /** The heights (km) to release particles at, one layer each. */
  heightsKm: number[]
  /** Colour particles by the drawn field's value at them (its packed byte) instead of their speed. */
  tint?: (byte: number) => [number, number, number]
}

/** Screen positions (CSS px) of the height and pressure ticks, for the page to label. */
export interface AxisPoint { x: number; y: number; label: string; side: "left" | "right" | "mid" }
/** Lines for the box (a level's contours and arrows, trajectories): xyz + premultiplied rgba per
 *  vertex, in pairs; with labels at box points. */
export interface BoxOverlay { verts: Float32Array; labels: { x: number; y: number; z: number; text: string }[] }

const EARTH_CIRC = 2 * Math.PI * 6371008.8
const GROUND_KM = 5             // the ground texture's range (above the region's highest peak)

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
uniform bool uLit;              // shade by what lies towards the light (clouds and the like); else flat
uniform bool uHasGround;        // the terrain: rays stop where they reach it
uniform sampler2D uGround;      // terrain height over the box (rows north to south), as a fraction of GROUND_KM
uniform float uGroundScale;     // GROUND_KM / the box's top (km)
// surfaces where the field crosses set values (isotherms, isotachs, the freezing level), lit by
// the field's gradient; coloured by height (uHeight) when uIsoByHeight
uniform int uIsoN;
uniform float uIso[6];
uniform vec4 uIsoCol[6];
uniform bool uIsoByHeight;
uniform sampler2D uHeight;      // colours by height over the box (0 – 1)
// colour: 0 the field's own, 1 by height, 2 by a second field (uC0, uC1 through uCLut)
uniform int uColorMode;
uniform sampler3D uC0, uC1;
uniform sampler2D uCLut;
// a solid surface where the field reaches uSolidAt: opaque, lit, self-shadowed
uniform bool uSolid;
uniform float uSolidAt;
uniform vec3 uSolidCol;
// shadows on the ground, from the solid surface or the lit field
uniform bool uShadow;
out vec4 fragColor;
const float PI = 3.141592653589793;
// the light: from the south-west and fairly high, in the box's true proportions (x east, y south, z up)
const vec3 LW = vec3(-0.5, 0.42, 0.76);

vec3 texPos(vec3 p) {
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * mix(uMercY.x, uMercY.y, p.y)))));
  vec3 f = vec3(p.x, (lat - uLat.x) / (uLat.y - uLat.x), p.z);
  return (f * (uSize - 1.0) + 0.5) / uSize;               // cell centres span the box
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float val(vec3 q) { return mix(texture(uA, q).r, texture(uB, q).r, uT); }
float valAt(vec3 p) { vec3 q = texPos(p); return (q.y < 0.0 || q.y > 1.0 || p.x < 0.0 || p.x > 1.0) ? 0.0 : val(q); }
// the field's gradient in the box's true proportions (texture rows run north, the box's y south)
vec3 gradAt(vec3 p) {
  vec3 q = texPos(p), e = 1.0 / uSize;
  vec3 g = vec3(val(q + vec3(e.x, 0, 0)) - val(q - vec3(e.x, 0, 0)),
                -(val(q + vec3(0, e.y, 0)) - val(q - vec3(0, e.y, 0))),
                val(q + vec3(0, 0, e.z)) - val(q - vec3(0, 0, e.z)));
  return g / (uScale / uSize);
}
vec3 normalAt(vec3 p) { vec3 g = gradAt(p); float l = length(g); return l > 0.0 ? g / l : vec3(0, 0, 1); }
float extinction(vec3 p) {
  vec3 q = texPos(p);
  if (q.y < 0.0 || q.y > 1.0 || p.x < 0.0 || p.x > 1.0 || p.z > 1.0) return 0.0;
  return texture(uLut, vec2((val(q) * 255.0 + 0.5) / 256.0, 0.5)).a;
}
// the light's direction in box units, scaled to climb one box height
vec3 lightBox() { vec3 l = LW / uScale; return l / l.z; }
float groundZ(vec2 xy) {
  if (!uHasGround || xy.x < 0.0 || xy.x > 1.0 || xy.y < 0.0 || xy.y > 1.0) return 0.0;
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * mix(uMercY.x, uMercY.y, xy.y)))));
  float fy = (lat - uLat.x) / (uLat.y - uLat.x);
  return texture(uGround, vec2(xy.x, 1.0 - fy)).r * uGroundScale;
}
vec3 colourAt(vec3 p, vec3 own) {
  if (uColorMode == 1) return texture(uHeight, vec2(clamp(p.z, 0.0, 1.0), 0.5)).rgb;
  if (uColorMode == 2) {
    vec3 q = texPos(p);
    float c = mix(texture(uC0, q).r, texture(uC1, q).r, uT);
    return texture(uCLut, vec2((c * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  }
  return own;
}
// how much of the light reaches p: the lit field's thickness, or the solid surface, towards the light
float lightAt(vec3 p, float d0) {
  vec3 L = lightBox();
  float od = 0.0;
  for (int k = 1; k <= 6; k++) {
    float dz = d0 * float(k * k);                              // taps further apart further out
    vec3 s = p + L * dz;
    if (s.z > uZr.y || s.z > 1.0) break;
    if (uSolid) od += step(uSolidAt, valAt(s)) * 2.5;
    else od += extinction(s) * 4.0 * uDensity * length(L * d0 * float(2 * k - 1) * uScale) / uScale.x;
  }
  return exp(-od);
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
  bool inBox = tf > tn;
  if (!inBox && !uShadow) discard;
  vec4 acc = vec4(0.0);
  vec3 Lw = normalize(LW);
  bool hitGround = false, hitSolid = false;
  vec3 pg = vec3(0.0);
  if (inBox) {
    // steps sized in box units across its diagonal; the opacity of each follows its true length
    float dt = 1.7320508 / float(uSteps) / length(rd);
    float worldStep = length(rd * dt * uScale) / uScale.x;   // in box widths
    float t = tn + dt * hash(gl_FragCoord.xy);
    float prev = -1.0;
    vec3 prevP = ro + rd * t;
    for (int i = 0; i < 512; i++) {
      if (t > tf || acc.a > 0.97) break;
      vec3 p = ro + rd * t;
      vec3 q = texPos(p);
      if (uHasGround && p.z < groundZ(p.xy)) { hitGround = true; pg = p; break; }   // into the mountains
      if (q.y >= 0.0 && q.y <= 1.0) {
        float v = val(q);
        // the solid surface: find where the ray crosses it, light it and stop
        if (uSolid && v >= uSolidAt) {
          vec3 a = prevP, b = p;
          if (prev >= 0.0 && prev < uSolidAt) {
            for (int k = 0; k < 6; k++) { vec3 m = (a + b) * 0.5; if (valAt(m) >= uSolidAt) b = m; else a = m; }
          }
          vec3 ps = b;
          vec3 nrm = -normalAt(ps);
          vec3 V = -normalize(rd * uScale);
          if (dot(nrm, V) < 0.0) nrm = -nrm;                     // the side facing us
          float sh = lightAt(ps + nrm * 0.004, 0.012);
          float diff = max(dot(nrm, Lw), 0.0);
          float spec = pow(max(dot(nrm, normalize(Lw + V)), 0.0), 40.0) * 0.22;
          vec3 base = uColorMode == 0 ? uSolidCol : colourAt(ps, uSolidCol);
          vec3 col = base * (0.36 + 0.14 * (nrm.z * 0.5 + 0.5) + 0.62 * diff * sh) + spec * sh;
          acc.rgb += (1.0 - acc.a) * col;
          acc.a = 1.0;
          hitSolid = true;
          break;
        }
        // a surface between the last sample and this one: composite it first, where it falls
        if (prev >= 0.0) {
          for (int k = 0; k < 6; k++) {
            if (k >= uIsoN) break;
            float iso = uIso[k];
            if ((prev - iso) * (v - iso) < 0.0) {
              float fr = (iso - prev) / (v - prev);
              vec3 ph = p - rd * dt * (1.0 - fr);
              float lam = 0.5 + 0.5 * abs(dot(normalAt(ph), Lw));
              vec4 ic = uIsoCol[k];
              vec3 col = uIsoByHeight ? texture(uHeight, vec2(clamp(ph.z, 0.0, 1.0), 0.5)).rgb : ic.rgb;
              acc.rgb += (1.0 - acc.a) * ic.a * col * lam;
              acc.a += (1.0 - acc.a) * ic.a;
            }
          }
        }
        prev = v;
        prevP = p;
        vec4 c = texture(uLut, vec2((v * 255.0 + 0.5) / 256.0, 0.5));
        float a = 1.0 - exp(-c.a * 4.0 * uDensity * worldStep);
        if (a > 0.002) {
          vec3 col = colourAt(p, c.rgb);
          if (uLit) {
            // light that gets through the field towards the sun, a sky fill from above, and
            // forward scattering where we look towards the light (bright cloud edges)
            float L = lightAt(p, 0.008);
            float fwd = pow(max(dot(normalize(rd * uScale), Lw), 0.0), 6.0);
            col *= 0.34 + 0.16 * p.z + 0.62 * L + 0.25 * fwd * L;
          } else {
            col *= mix(0.72, 1.0, p.z);                        // a little darker low down, for depth
          }
          acc.rgb += (1.0 - acc.a) * a * col;
          acc.a += (1.0 - acc.a) * a;
        }
      }
      t += dt;
    }
  }
  // the shadow on the ground (or the map), where the light passes through the field or the solid
  if (uShadow && !hitSolid && acc.a < 0.97) {
    if (!hitGround) {
      if (rd.z >= 0.0) { if (!inBox) discard; fragColor = acc * uOpacity; return; }
      float tg = -ro.z / rd.z;
      pg = ro + rd * tg;
      for (int k = 0; k < 2; k++) { float gz = groundZ(pg.xy); tg = (gz - ro.z) / rd.z; pg = ro + rd * tg; }
    }
    vec3 L = lightBox();
    float od = 0.0;
    float z0 = max(pg.z, uZr.x);
    float jit = hash(gl_FragCoord.yx);                           // dithered, so the steps don't band
    for (int k = 0; k < 56; k++) {
      float z = mix(z0, uZr.y, (float(k) + jit) / 56.0);
      vec3 s = pg + L * (z - pg.z);
      if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) continue;
      if (uSolid) od += smoothstep(uSolidAt - 0.015, uSolidAt + 0.015, valAt(s)) * 0.5;
      else od += extinction(s) * 4.0 * uDensity * length(L * (uZr.y - z0) / 56.0 * uScale) / uScale.x;
    }
    float sa = 0.36 * (1.0 - exp(-od));
    acc.a += (1.0 - acc.a) * sa;                                 // black, premultiplied
  }
  if (acc.a <= 0.0) discard;
  fragColor = acc * uOpacity;
}`

// the cached volume image, drawn over the map each frame
// the cross-section's curtain: a vertical quad along the line, textured with the slice
const CURTAIN_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;          // along the line, up
uniform mat4 uMVP;
uniform vec4 uLine;                         // box x, y of the line's two ends
uniform vec2 uZr;                           // the heights drawn
out vec2 vUv;
void main() {
  float z = mix(uZr.x, uZr.y, aPos.y);
  vUv = vec2(aPos.x, z);
  gl_Position = uMVP * vec4(mix(uLine.xy, uLine.zw, aPos.x), z, 1.0);
}`
const CURTAIN_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImg;
uniform float uAlpha;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 c = texture(uImg, vec2(vUv.x, 1.0 - vUv.y));
  fragColor = vec4(c.rgb * c.a, c.a) * uAlpha;
}`

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
  // ---- the terrain, when the map shows it in 3D
  private groundTex?: WebGLTexture
  private ground: { width: number; height: number; km: Float32Array; fresh: boolean } | null = null
  private heightKey = ""
  private vao?: WebGLVertexArrayObject
  private lineVao?: WebGLVertexArrayObject
  private lut?: WebGLTexture
  private lutKey = ""
  private draw: VolumeDraw | null = null
  private textures = new Map<number, WebGLTexture>()
  private colorTextures = new Map<number, WebGLTexture>()
  private cLut?: WebGLTexture
  private cLutData: Uint8Array | null = null
  private i0 = 0
  private i1 = 0
  private t = 0
  private exaggeration = 25
  private zr: [number, number] = [0, 1]
  private precip?: PrecipFx
  private precipDraw: GridDraw | null = null
  private precipT = 0
  private precipOn = false
  // ---- cross-section curtain
  private curtainProg?: Program
  private curtainTex?: WebGLTexture
  private curtain: { a: [number, number]; b: [number, number]; img: TexImageSource | null; fresh: boolean } | null = null
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
  private overlays: Record<string, BoxOverlay | null> = {}
  private ovVao?: WebGLVertexArrayObject
  private ovBuf?: WebGLBuffer
  private ovCount = 0
  private ovDirty = false
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
    this.curtainProg = program(gl, CURTAIN_VS, CURTAIN_FS)
    this.curtainTex = gl.createTexture()!
    this.fbo = gl.createFramebuffer()!
    this.fboTex = gl.createTexture()!
    this.heightTex = gl.createTexture()!
    this.groundTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    this.trailProg = program(gl, TRAIL_VS, TRAIL_FS)
    this.precip = new PrecipFx(gl)
    this.precip.setSource(this.precipDraw, this.precipT)
    if (this.ground) this.precip.setGround((x, y) => this.groundAt(x, y))
    this.trailVao = gl.createVertexArray()!
    gl.bindVertexArray(this.trailVao)
    this.trailBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12)
    gl.bindVertexArray(null)
    this.ovVao = gl.createVertexArray()!
    gl.bindVertexArray(this.ovVao)
    this.ovBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ovBuf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12)
    gl.bindVertexArray(null)
    this.ovDirty = true
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
    this.cLut = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.cLut)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v)
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
    this.precip?.dispose(gl)
    this.clearTextures()
    if (this.prog) gl.deleteProgram(this.prog.program)
    if (this.lineProg) gl.deleteProgram(this.lineProg.program)
    if (this.blitProg) gl.deleteProgram(this.blitProg.program)
    if (this.curtainProg) gl.deleteProgram(this.curtainProg.program)
    if (this.curtainTex) gl.deleteTexture(this.curtainTex)
    if (this.trailProg) gl.deleteProgram(this.trailProg.program)
    if (this.trailBuf) gl.deleteBuffer(this.trailBuf)
    if (this.ovBuf) gl.deleteBuffer(this.ovBuf)
    if (this.ovVao) gl.deleteVertexArray(this.ovVao)
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    if (this.fboTex) gl.deleteTexture(this.fboTex)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.lineVao) gl.deleteVertexArray(this.lineVao)
    if (this.lut) gl.deleteTexture(this.lut)
    if (this.cLut) gl.deleteTexture(this.cLut)
  }

  private clearTextures(which: "main" | "color" | "both" = "both") {
    if (which !== "color") { for (const t of this.textures.values()) this.gl?.deleteTexture(t); this.textures.clear() }
    if (which !== "main") { for (const t of this.colorTextures.values()) this.gl?.deleteTexture(t); this.colorTextures.clear() }
  }

  setDraw(d: VolumeDraw | null, levels: { hPa: number; km: number }[] = []) {
    if (d?.data !== this.draw?.data) this.clearTextures("main")
    if (d?.colorBy?.data !== this.draw?.colorBy?.data) this.clearTextures("color")
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
  /** The drawn field's packed value at a point of the box (nearest step, trilinear). */
  private fieldByte(x: number, y: number, z: number, latOf: (y: number) => number) {
    const d = this.draw!, g = d.grid
    const fx = x * (g.nx - 1), fy = ((latOf(y) - g.lat[0]) / (g.lat[1] - g.lat[0])) * (g.ny - 1), fz = z * (g.nz - 1)
    const x0 = Math.max(0, Math.min(g.nx - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(g.ny - 2, Math.floor(fy))), z0 = Math.max(0, Math.min(g.nz - 2, Math.floor(fz)))
    const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0)), az = Math.min(1, Math.max(0, fz - z0))
    const base = Math.min(this.t >= 0.5 ? this.i1 : this.i0, d.steps - 1) * g.nx * g.ny * g.nz
    let s = 0
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1
      const b = d.data[base + (z0 + dz) * g.nx * g.ny + (y0 + dy) * g.nx + x0 + dx]
      s += (b === 255 ? 0 : b) * (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az)
    }
    return Math.round(s)
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
      if (this.ground && z < this.groundAt(x, y)) { this.spawn(i); continue }    // under the mountains
      const [u, v] = this.sampleWind(x, y, z, latOf)
      this.speed[i] = Math.hypot(u, v) * 2.23694
      P.copyWithin(b + 3, b, b + (TRAIL - 1) * 3)          // shift the history back one
      const nx = x + (u * SIM_SECONDS * dtf) / wM, ny = y - (v * SIM_SECONDS * dtf) / hM
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) { this.spawn(i); continue }
      P[b] = nx; P[b + 1] = ny
      // fade in and out over the particle's life, and along the trail
      const life = Math.min(1, this.age[i] / 12, (this.life[i] - this.age[i]) / 12)
      const [r, gg, bb] = this.wind!.tint ? this.wind!.tint(this.fieldByte(nx, ny, z, latOf)) : WIND_RGB(this.speed[i])
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

  /** Lines in the box under a name ("level", "traj"), or null to remove them. */
  setOverlay(name: string, o: BoxOverlay | null) {
    this.overlays[name] = o
    this.ovDirty = true
    this.map?.triggerRepaint()
  }
  private drawOverlays(gl: WebGL2RenderingContext, mvp: M4) {
    if (!this.trailProg || !this.ovVao || !this.ovBuf) return
    if (this.ovDirty) {
      const parts = Object.values(this.overlays).filter((o): o is BoxOverlay => !!o && o.verts.length > 0)
      const n = parts.reduce((a, o) => a + o.verts.length, 0)
      const all = new Float32Array(n)
      let k = 0
      for (const o of parts) { all.set(o.verts, k); k += o.verts.length }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ovBuf)
      gl.bufferData(gl.ARRAY_BUFFER, all, gl.STATIC_DRAW)
      this.ovCount = n / 7
      this.ovDirty = false
    }
    if (!this.ovCount) return
    gl.useProgram(this.trailProg.program)
    gl.uniformMatrix4fv(this.trailProg.u("uMVP"), false, Float32Array.from(mvp))
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.ovVao)
    gl.drawArrays(gl.LINES, 0, this.ovCount)
    gl.bindVertexArray(null)
  }

  /** Draw only between these heights (km); the full box by default. */
  setHeightRange(loKm: number, hiKm: number) {
    const top = this.draw?.grid.topKm ?? 12
    const zr: [number, number] = [Math.max(0, loKm / top), Math.min(1, hiKm / top)]
    if (zr[0] === this.zr[0] && zr[1] === this.zr[1]) return
    this.zr = zr
    this.map?.triggerRepaint()
  }
  /** Falling precipitation from the map's radar layer (its grid, or null), and whether to show it. */
  setPrecip(d: GridDraw | null, t = 0) {
    this.precipDraw = d; this.precipT = t
    this.precip?.setSource(d, t)
    this.map?.triggerRepaint()
  }
  setPrecipT(t: number) { this.precipT = t; this.precip?.setT(t) }
  setPrecipOn(on: boolean) { this.precipOn = on; this.map?.triggerRepaint() }
  /** The cross-section's line (lon, lat of its ends) and its slice image, or null for none. */
  setCurtain(a: [number, number] | null, b?: [number, number], img?: TexImageSource | null) {
    if (!a || !b) this.curtain = null
    else this.curtain = { a, b, img: img ?? this.curtain?.img ?? null, fresh: !!img || !!this.curtain?.fresh }
    this.map?.triggerRepaint()
  }
  /** Terrain heights (km) over the box (rows north to south), or null: rays, particles and falling
   *  precipitation stop at the ground. */
  setGround(gr: { width: number; height: number; km: Float32Array } | null) {
    this.ground = gr ? { ...gr, fresh: true } : null
    this.precip?.setGround(gr ? (x, y) => this.groundAt(x, y) : null)
    this.lastKey = ""
    this.map?.triggerRepaint()
  }
  /** Terrain height at a point of the box, as a fraction of the box's height (0 without terrain). */
  groundAt(x: number, y: number) {
    const G = this.ground, d = this.draw
    if (!G || !d) return 0
    const g = d.grid
    const yN = mercY(g.lat[1]), yS = mercY(g.lat[0])
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (yN + y * (yS - yN))))) * 180) / Math.PI
    const gx = Math.min(G.width - 1, Math.max(0, Math.floor(x * G.width)))
    const gy = Math.min(G.height - 1, Math.max(0, Math.floor(((g.lat[1] - lat) / (g.lat[1] - g.lat[0])) * G.height)))
    return G.km[gy * G.width + gx] / g.topKm
  }
  setExaggeration(x: number) {
    this.exaggeration = x
    this.map?.triggerRepaint()
  }
  setOpacity(o: number) {
    this.opacity = o
    this.map?.triggerRepaint()
  }

  private stepTexture(gl: WebGL2RenderingContext, d: VolumeDraw, i: number, color = false) {
    const k = Math.max(0, Math.min(d.steps - 1, i))
    const cache = color ? this.colorTextures : this.textures
    let tex = cache.get(k)
    if (tex) return tex
    const { nx, ny, nz } = d.grid
    const n = nx * ny * nz
    const slice = (color ? d.colorBy!.data : d.data).slice(k * n, (k + 1) * n)
    for (let j = 0; j < slice.length; j++) if (slice[j] === 255) slice[j] = 0     // missing: clear
    tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_3D, tex)
    resetUnpack(gl)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, nx, ny, nz, 0, gl.RED, gl.UNSIGNED_BYTE, slice)
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
                          [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_3D, p, v)
    cache.set(k, tex)
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
      if (!d.empty) this.march(gl, d, mvp, inv, fw, fh, x1 - x0, yS - yN, zTop, yN, yS)
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

    this.drawCurtain(gl, mvp, g)
    this.drawOverlays(gl, mvp)
    this.drawParticles(gl, mvp)
    if (this.precipOn && this.precip?.render(gl, Float32Array.from(mvp), { lon: g.lon, lat: g.lat, topKm: g.topKm }, this.zr, window.devicePixelRatio || 1))
      this.map?.triggerRepaint()                             // keep it falling

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
    gl.uniform1i(p.u("uIsoByHeight"), d.heightLut && d.isoByHeight ? 1 : 0)
    const mode = d.colorMode === "height" && d.heightLut ? 1 : d.colorMode === "field" && d.colorBy ? 2 : 0
    gl.uniform1i(p.u("uColorMode"), mode)
    // the colouring field (or the main one again, so the 3D samplers always have a texture)
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(gl.TEXTURE_3D, mode === 2 ? this.stepTexture(gl, d, this.i0, true) : this.stepTexture(gl, d, this.i0))
    gl.uniform1i(p.u("uC0"), 5)
    gl.activeTexture(gl.TEXTURE6)
    gl.bindTexture(gl.TEXTURE_3D, mode === 2 ? this.stepTexture(gl, d, this.i1, true) : this.stepTexture(gl, d, this.i1))
    gl.uniform1i(p.u("uC1"), 6)
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(gl.TEXTURE_2D, this.cLut!)
    if (d.colorBy && d.colorBy.lut !== this.cLutData) {
      resetUnpack(gl)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, d.colorBy.lut)
      this.cLutData = d.colorBy.lut
    }
    gl.uniform1i(p.u("uCLut"), 7)
    gl.uniform1i(p.u("uSolid"), d.solid ? 1 : 0)
    gl.uniform1f(p.u("uSolidAt"), d.solid?.at ?? 2)
    gl.uniform3f(p.u("uSolidCol"), ...(d.solid?.rgb ?? [1, 1, 1]))
    gl.uniform1i(p.u("uShadow"), d.shadow ? 1 : 0)
    // always bound to its own unit: a 2D sampler left on unit 0 would share it with uA's 3D texture,
    // which WebGL refuses to draw
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex!)
    gl.uniform1i(p.u("uHeight"), 3)
    // the terrain (its own unit too)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, this.groundTex!)
    gl.uniform1i(p.u("uGround"), 4)
    const G = this.ground
    if (G?.fresh) {
      const bytes = new Uint8Array(G.km.length)
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, G.km[i] / GROUND_KM) * 255)
      resetUnpack(gl)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, G.width, G.height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes)
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
        gl.texParameteri(gl.TEXTURE_2D, k, v)
      G.fresh = false
    }
    gl.uniform1i(p.u("uHasGround"), G ? 1 : 0)
    gl.uniform1f(p.u("uGroundScale"), GROUND_KM / g.topKm)
    if (d.heightLut) {
      if (this.heightKey !== d.key) {
        gl.activeTexture(gl.TEXTURE3)                          // its own unit (the ground's is active here)
        gl.bindTexture(gl.TEXTURE_2D, this.heightTex!)
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

  private drawCurtain(gl: WebGL2RenderingContext, mvp: M4, g: VolumeGrid) {
    const c = this.curtain
    if (!c || !c.img || !this.curtainProg || !this.curtainTex) return
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.curtainTex)
    if (c.fresh) {
      resetUnpack(gl)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c.img)
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
        gl.texParameteri(gl.TEXTURE_2D, k, v)
      c.fresh = false
    }
    const bx = (lon: number) => (lon - g.lon[0]) / (g.lon[1] - g.lon[0])
    const yN = mercY(g.lat[1]), yS = mercY(g.lat[0])
    const by = (lat: number) => (mercY(lat) - yN) / (yS - yN)
    const p = this.curtainProg
    gl.useProgram(p.program)
    gl.uniformMatrix4fv(p.u("uMVP"), false, Float32Array.from(mvp))
    gl.uniform4f(p.u("uLine"), bx(c.a[0]), by(c.a[1]), bx(c.b[0]), by(c.b[1]))
    gl.uniform2f(p.u("uZr"), this.zr[0], this.zr[1])
    gl.uniform1i(p.u("uImg"), 0)
    gl.uniform1f(p.u("uAlpha"), 0.93)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
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
    for (const o of Object.values(this.overlays)) for (const l of o?.labels ?? []) {
      if (l.z < this.zr[0] - 1e-3 || l.z > this.zr[1] + 1e-3) continue
      const q = at(l.x, l.y, l.z)
      // skip one that would crowd a label already placed (contours bunch up around lows)
      if (q && q.x > 0 && q.y > 0 && q.x < w && q.y < h && !pts.some((o) => o.side === "mid" && Math.abs(o.x - q.x) < 34 && Math.abs(o.y - q.y) < 16))
        pts.push({ ...q, label: l.text, side: "mid" })
    }
    this.onAxis(pts)
  }
}
