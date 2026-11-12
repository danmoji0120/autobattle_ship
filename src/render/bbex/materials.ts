// BB-EX — shader materials and batches for its effects. All additive, depth-tested, depth-write off;
// each batch is one draw call however many elements it holds.
import * as THREE from 'three';

const NOISE = /* glsl */`
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm2(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n2(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
// distance to the nearest hexagon edge (0 at the edge), and the cell id
vec4 hexc(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}
float hexEdge(vec2 q) { q = abs(q); return max(dot(q, vec2(0.5, 0.8660254)), q.x); }
`;

const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide } as const;

// ───────────────────────────────────────────────────────────────────────── beams
// Camera-facing ribbons with an along-beam coordinate in world units: a white-hot core, a violet
// sheath with energy flowing down it, and filaments. Used for the DCP-Ω lattice and funnel fire.

const BEAM_VS = /* glsl */`
attribute vec4 bcolor; attribute vec3 bparam; // x = core strength, y = flow speed, z = seed
varying vec4 vColor; varying vec2 vUv; varying vec3 vParam;
void main() { vColor = bcolor; vUv = uv; vParam = bparam; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BEAM_FS = /* glsl */`
uniform float uTime;
varying vec4 vColor; varying vec2 vUv; varying vec3 vParam;
${NOISE}
void main() {
  float e = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float along = vUv.x;
  float flow = along * 0.03 - uTime * vParam.y + vParam.z;
  float fil = fbm2(vec2(flow, vUv.y * 5.0 + vParam.z));
  float pulse = 0.82 + 0.18 * sin(along * 0.16 - uTime * 46.0 + vParam.z * 6.0);
  if (vParam.x < 0.0) {
    // cut boundary: not light but a wound — broken hairline cracks running beside the beam, and
    // shards of light flaking off them
    float yy = abs(vUv.y * 2.0 - 1.0);
    float wander = fbm2(vec2(along * 0.018 + vParam.z, vParam.z * 3.0 + floor(uTime * 9.0) * 0.37));
    float crack = exp(-pow((yy - (0.34 + 0.5 * wander)) * 15.0, 2.0));
    float crack2 = exp(-pow((yy - (0.12 + 0.3 * fbm2(vec2(along * 0.031 - vParam.z, 7.0)))) * 22.0, 2.0)) * 0.6;
    float gaps = step(0.42, n2(vec2(along * 0.011 + vParam.z * 5.0, floor(uTime * 14.0))));
    float branch = pow(n2(vec2(along * 0.06 + vParam.z, yy * 5.0 - uTime * 2.0)), 7.0) * smoothstep(1.0, 0.3, yy) * 5.0;
    vec3 c = vColor.rgb * ((crack + crack2) * gaps * 1.5 + branch);
    gl_FragColor = vec4(c * vColor.a * smoothstep(1.0, 0.85, yy), 1.0);
    return;
  }
  float sheath = pow(e, 1.9) * (0.45 + 1.0 * fil) * pulse;
  // hot knots travelling down the beam
  float knots = pow(max(0.0, sin(along * 0.045 - uTime * vParam.y * 3.0 + vParam.z * 3.0)), 14.0) * pow(e, 3.0);
  // the core keeps a hard outline: a thin, almost solid line rather than a glow
  float core = smoothstep(0.80, 0.93, e) * vParam.x;
  vec3 col = vColor.rgb * (sheath + knots * 1.2) + vec3(1.0, 0.95, 1.0) * core * 1.5;
  gl_FragColor = vec4(col * vColor.a, 1.0);
}`;

export class BeamBatch {
  readonly mesh: THREE.Mesh;
  private n = 0;
  private posA: THREE.BufferAttribute; private colA: THREE.BufferAttribute; private uvA: THREE.BufferAttribute; private parA: THREE.BufferAttribute;
  private geom = new THREE.BufferGeometry();
  private cam = new THREE.Vector3(); private d = new THREE.Vector3(); private side = new THREE.Vector3(); private toCam = new THREE.Vector3();
  readonly mat: THREE.ShaderMaterial;
  constructor(private max = 420) {
    this.posA = new THREE.BufferAttribute(new Float32Array(max * 12), 3).setUsage(THREE.DynamicDrawUsage);
    this.colA = new THREE.BufferAttribute(new Float32Array(max * 16), 4).setUsage(THREE.DynamicDrawUsage);
    this.uvA = new THREE.BufferAttribute(new Float32Array(max * 8), 2).setUsage(THREE.DynamicDrawUsage);
    this.parA = new THREE.BufferAttribute(new Float32Array(max * 12), 3).setUsage(THREE.DynamicDrawUsage);
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    this.geom.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geom.setAttribute('position', this.posA); this.geom.setAttribute('bcolor', this.colA); this.geom.setAttribute('uv', this.uvA); this.geom.setAttribute('bparam', this.parA);
    this.mat = new THREE.ShaderMaterial({ vertexShader: BEAM_VS, fragmentShader: BEAM_FS, uniforms: { uTime: { value: 0 } }, ...additive });
    this.mesh = new THREE.Mesh(this.geom, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6;
  }
  begin(camera: THREE.Camera, time: number) { this.n = 0; this.cam.setFromMatrixPosition(camera.matrixWorld); this.mat.uniforms.uTime.value = time; }
  /** a→b, half-widths wa/wb (world units; grown with distance so far beams stay visible), colour ×alpha,
   *  core = white-hot centre strength, flow = energy speed, u0 = along-beam offset so chained segments flow on */
  seg(a: THREE.Vector3, b: THREE.Vector3, wa: number, wb: number, r: number, g: number, bl: number, alpha: number, core: number, flow: number, seed: number, u0 = 0, far = 700) {
    if (this.n >= this.max || alpha <= 0.002) return;
    this.d.subVectors(b, a);
    const len = this.d.length(); if (len < 1e-3) return;
    this.toCam.set(this.cam.x - (a.x + b.x) * 0.5, this.cam.y - (a.y + b.y) * 0.5, this.cam.z - (a.z + b.z) * 0.5);
    this.side.crossVectors(this.d, this.toCam);
    const l = this.side.length(); if (l < 1e-6) return;
    this.side.multiplyScalar(1 / l);
    // looking almost straight down a beam from beside it would fill the screen with light: it thins out
    alpha *= Math.max(0.18, Math.min(1, (l / len) / (Math.max(wa, wb) * 20)));
    // far beams are widened so they stay visible, but only so much: the lattice must stay a set of lines
    const boost = Math.min(2.4, Math.max(1, this.toCam.length() / far));
    wa *= boost; wb *= boost;
    const p = this.posA.array as Float32Array, c = this.colA.array as Float32Array, uv = this.uvA.array as Float32Array, q = this.parA.array as Float32Array;
    const i = this.n * 12, j = this.n * 16, k = this.n * 8;
    const sx = this.side.x, sy = this.side.y, sz = this.side.z;
    p[i] = a.x - sx * wa; p[i + 1] = a.y - sy * wa; p[i + 2] = a.z - sz * wa;
    p[i + 3] = a.x + sx * wa; p[i + 4] = a.y + sy * wa; p[i + 5] = a.z + sz * wa;
    p[i + 6] = b.x - sx * wb; p[i + 7] = b.y - sy * wb; p[i + 8] = b.z - sz * wb;
    p[i + 9] = b.x + sx * wb; p[i + 10] = b.y + sy * wb; p[i + 11] = b.z + sz * wb;
    for (let v = 0; v < 4; v++) { c[j + v * 4] = r; c[j + v * 4 + 1] = g; c[j + v * 4 + 2] = bl; c[j + v * 4 + 3] = alpha; q[i + v * 3] = core; q[i + v * 3 + 1] = flow; q[i + v * 3 + 2] = seed; }
    uv[k] = u0; uv[k + 1] = 0; uv[k + 2] = u0; uv[k + 3] = 1; uv[k + 4] = u0 + len; uv[k + 5] = 0; uv[k + 6] = u0 + len; uv[k + 7] = 1;
    this.n++;
  }
  end() {
    for (const a of [this.posA, this.colA, this.uvA, this.parA]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.n * 4 * a.itemSize); }
    this.geom.setDrawRange(0, this.n * 6);
  }
  get count() { return this.n; }
}

// ───────────────────────────────────────────────────────────────────────── instanced quads
// One instanced plane per element, each with its own transform and four free parameters. The fragment
// shader decides what it is: a PARADOX panel, a mirror facet, a halo ring, a rift, a gravity lens.

const QUAD_VS = /* glsl */`
attribute vec4 qparam; attribute vec4 qcolor;
varying vec2 vUv; varying vec4 vP; varying vec4 vC; varying vec3 vN; varying vec3 vV;
void main() {
  vUv = uv * 2.0 - 1.0; vP = qparam; vC = qcolor;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix * instanceMatrix) * vec3(0.0, 0.0, 1.0));
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export class QuadBatch {
  readonly mesh: THREE.InstancedMesh;
  private par: THREE.InstancedBufferAttribute; private col: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private s = new THREE.Vector3();
  private n = 0;
  readonly mat: THREE.ShaderMaterial;
  constructor(private max: number, fragment: string, order = 5, blending: THREE.Blending = THREE.AdditiveBlending) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.par = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('qparam', this.par); geo.setAttribute('qcolor', this.col);
    this.mat = new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: fragment, uniforms: { uTime: { value: 0 } }, transparent: true, depthWrite: false, blending, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = order;
  }
  begin(time: number) { this.n = 0; this.mat.uniforms.uTime.value = time; }
  /** a quad of `size` at pos; `quat` orients its +z normal */
  add(pos: THREE.Vector3, quat: THREE.Quaternion, sx: number, sy: number, p0: number, p1: number, p2: number, p3: number, r: number, g: number, b: number, a: number) {
    if (this.n >= this.max) return;
    this.s.set(sx, sy, 1);
    this.m.compose(pos, quat, this.s);
    this.mesh.setMatrixAt(this.n, this.m);
    const p = this.par.array as Float32Array, c = this.col.array as Float32Array, i = this.n * 4;
    p[i] = p0; p[i + 1] = p1; p[i + 2] = p2; p[i + 3] = p3;
    c[i] = r; c[i + 1] = g; c[i + 2] = b; c[i + 3] = a;
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true; this.par.needsUpdate = true; this.col.needsUpdate = true;
    this.par.clearUpdateRanges(); this.par.addUpdateRange(0, this.n * 4); this.col.clearUpdateRanges(); this.col.addUpdateRange(0, this.n * 4);
  }
  /** quaternion that turns the quad's +z toward n */
  static look(n: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion { return out.setFromUnitVectors(Z, n); }
}
const Z = new THREE.Vector3(0, 0, 1);

/** PARADOX panel — p: (age 0..1, seed, mode 0 displace / 1 absorb, heavy 0..1). A hexagonal ward that
 *  flares where the hit arrived, ripples outward and breaks up. */
export const PARADOX_FS = /* glsl */`
uniform float uTime; varying vec2 vUv; varying vec4 vP; varying vec4 vC; varying vec3 vN; varying vec3 vV;
${NOISE}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float t = vP.x;
  vec4 h = hexc(vUv * (3.2 + vP.w * 1.2) + vP.y * 7.0);
  float edge = hexEdge(h.xy);
  float line = smoothstep(0.5, 0.44, edge) - smoothstep(0.44, 0.36, edge);
  float cell = h21(h.zw + vP.y);
  // the ward lights up from the impact point outward, cells flicker out one by one
  float front = t * 1.5;
  float lit = smoothstep(front, front - 0.5, r) * smoothstep(1.0, 0.75, r);
  float alive = step(t * 1.15, cell * 0.7 + 0.42);
  float ring = exp(-pow((r - front * 0.85) * 7.0, 2.0)) * (1.0 - t);
  float flash = exp(-r * r * 14.0) * exp(-t * 9.0) * (0.9 + vP.w * 0.8);
  float body = (line * 1.7 + (1.0 - smoothstep(0.0, 0.44, edge)) * 0.06 + cell * 0.1 * smoothstep(0.46, 0.2, edge)) * lit * alive;
  vec3 col = mix(vC.rgb, vec3(1.0, 0.62, 0.95), vP.z * 0.6);
  float a = (body * (1.0 - t * t) + ring * 1.3 + flash) * vC.a;
  gl_FragColor = vec4(col * a + vec3(1.0, 0.95, 1.0) * flash * 0.7 * vC.a, 1.0);
}`;

/** mirror facet — p: (unfold 0..1, flash 0..1, split count, seed). A translucent hexagonal pane of folded
 *  space: fresnel rim, faint lattice, and when the beam strikes it, a white node with glass cracks. */
export const FACET_FS = /* glsl */`
uniform float uTime; varying vec2 vUv; varying vec4 vP; varying vec4 vC; varying vec3 vN; varying vec3 vV;
${NOISE}
void main() {
  float hx = hexEdge(vUv * 0.5);
  float open = vP.x;
  float inside = smoothstep(0.5 * open, 0.5 * open - 0.02, hx);
  if (inside < 0.01) discard;
  float rim = smoothstep(0.5 * open - 0.07, 0.5 * open - 0.01, hx);
  float r = length(vUv);
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  vec4 h = hexc(vUv * 5.0 + vP.w);
  float lattice = smoothstep(0.5, 0.46, hexEdge(h.xy)) - smoothstep(0.46, 0.42, hexEdge(h.xy));
  float sheen = n2(vUv * 2.0 + vec2(uTime * 0.7, vP.w)) * 0.5 + 0.5 * n2(vUv * 6.0 - uTime * 0.4);
  // cracks radiate from the strike point when the beam splits
  float ang = atan(vUv.y, vUv.x);
  float k = max(vP.z, 1.0) * 2.0 + 3.0;
  float crack = pow(abs(sin(ang * k + n2(vec2(r * 5.0, vP.w)) * 2.4 + vP.w * 9.0)), 30.0) * smoothstep(0.02, 0.2, r) * smoothstep(1.0, 0.3, r);
  float node = exp(-r * r * 26.0);
  float fl = vP.y;
  // the edge of folded space splits light: three rims, slightly apart
  float e0 = 0.5 * open;
  vec3 iris = vec3(smoothstep(e0 - 0.085, e0 - 0.03, hx) * smoothstep(e0 + 0.0, e0 - 0.02, hx),
                   smoothstep(e0 - 0.07, e0 - 0.018, hx),
                   smoothstep(e0 - 0.05, e0 - 0.006, hx)) * vec3(1.5, 0.9, 1.7);
  // after the strike the pane keeps ringing
  float ring = pow(0.5 + 0.5 * sin(r * 26.0 - uTime * 17.0), 4.0) * smoothstep(1.0, 0.1, r) * fl;
  float a = lattice * (0.14 + 0.5 * fl) + sheen * 0.08 + fres * 0.28 + ring * 0.5 + (crack * 1.5 + node * 2.6 + exp(-r * 3.0) * 0.5) * fl;
  vec3 col = vC.rgb * a + iris * (0.9 + 0.8 * fl) + vec3(1.0, 0.96, 1.0) * (node * 1.6 + crack * 0.7) * fl;
  gl_FragColor = vec4(col * inside * vC.a, 1.0);
}`;

/** halo ring — p: (spin, rings 1..3, seed, energy). Concentric rune rings behind the hull. */
export const HALO_FS = /* glsl */`
uniform float uTime; varying vec2 vUv; varying vec4 vP; varying vec4 vC; varying vec3 vN; varying vec3 vV;
${NOISE}
float band(float r, float r0, float w) { return exp(-pow((r - r0) / w, 2.0)); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = atan(vUv.y, vUv.x);
  float e = 0.0;
  float rings = vP.y;
  // main ring: a thin bright line with a dashed companion
  e += band(r, 0.9, 0.012) * 2.2;
  e += band(r, 0.84, 0.007) * step(0.5, fract(a * 9.5493 + vP.x * 0.7)) * 1.3;
  // rune blocks
  float seg = floor(a * 11.459 + vP.x * 2.0);
  float rune = step(0.45, h21(vec2(seg, vP.z))) * step(0.2, fract(a * 11.459 + vP.x * 2.0)) * band(r, 0.76, 0.03);
  e += rune * 0.9;
  // inner rings appear with more energy
  if (rings > 1.5) { e += band(r, 0.6, 0.009) * 1.5 + band(r, 0.55, 0.02) * step(0.6, fract(a * 6.366 - vP.x * 1.3)) * 0.9; }
  if (rings > 2.5) { e += band(r, 0.36, 0.008) * 1.4 + pow(abs(sin(a * 6.0 + vP.x * 3.0)), 40.0) * smoothstep(0.36, 0.6, r) * smoothstep(0.6, 0.5, r) * 1.2; }
  // spokes of light toward the hull
  e += pow(abs(sin(a * 12.0 - vP.x)), 60.0) * smoothstep(0.92, 0.3, r) * smoothstep(0.1, 0.5, r) * 0.25 * vP.w;
  e += exp(-r * 4.0) * 0.12 * vP.w;
  gl_FragColor = vec4(vC.rgb * e * vC.a + vec3(1.0, 0.95, 1.0) * band(r, 0.9, 0.006) * vC.a, 1.0);
}`;

/** rift — p: (open 0..1.4, seed, collapse 0..1, -). A tear in space seen face-on: a jagged bright wound,
 *  dark inside with a glimpse of somewhere else, light bleeding out along the tear. */
export const RIFT_FS = /* glsl */`
uniform float uTime; varying vec2 vUv; varying vec4 vP; varying vec4 vC; varying vec3 vN; varying vec3 vV;
${NOISE}
void main() {
  vec2 p = vUv;
  float open = vP.x, col = vP.z;
  // the tear is a vertical wound that zig-zags
  float zig = (fbm2(vec2(p.y * 2.6 + vP.y, vP.y)) - 0.5) * 0.5 + (n2(vec2(p.y * 11.0, vP.y * 3.0)) - 0.5) * 0.12;
  float x = p.x - zig * (1.0 - 0.5 * abs(p.y));
  float halfw = open * 0.3 * pow(max(0.0, 1.0 - p.y * p.y / (0.15 + open * 0.75)), 0.7) * (1.0 - col);
  float d = abs(x) - halfw;
  float inside = smoothstep(0.012, -0.012, d) * step(0.0001, halfw);
  float edge = exp(-abs(d) * 26.0) * step(0.0001, halfw);
  float bleed = exp(-abs(d) * 4.5) * step(0.0001, halfw) * 0.5;
  // side fractures
  float fr = pow(max(0.0, 1.0 - abs(fract(p.y * 5.0 + n2(vec2(p.y * 3.0, vP.y)) * 2.0) - 0.5) * 9.0), 3.0) * exp(-abs(d) * 7.0) * step(0.0, d) * open;
  // what is on the other side: deep violet with cold stars drifting
  vec2 q = p * 3.0 + vec2(uTime * 0.05, vP.y);
  float stars = step(0.985, h21(floor(q * 14.0))) * (0.5 + 0.5 * sin(uTime * 3.0 + h21(floor(q * 14.0)) * 40.0));
  vec3 beyond = vec3(0.16, 0.03, 0.32) * (0.5 + fbm2(q * 0.7)) + vec3(0.9, 0.8, 1.0) * stars;
  vec3 c = beyond * inside * 0.9 + vC.rgb * (edge * 1.5 + bleed * 0.28 + fr * 0.9) + vec3(1.0, 0.95, 1.0) * edge * edge * 1.1;
  float glow = exp(-dot(p, p) * 5.0) * open * 0.06;
  c += vC.rgb * glow;
  float fade = smoothstep(1.0, 0.82, length(p));
  gl_FragColor = vec4(c * vC.a * fade, 1.0);
}`;

/** gravity well — p: (age 0..1, seed, -, -). An accretion spiral falling into a point. */
export const WELL_FS = /* glsl */`
uniform float uTime; varying vec2 vUv; varying vec4 vP; varying vec4 vC; varying vec3 vN; varying vec3 vV;
${NOISE}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = atan(vUv.y, vUv.x);
  float t = vP.x;
  float env = smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.8, t);
  float swirl = a + 3.2 / (r + 0.16) - uTime * 2.2 + vP.y;
  float arms = pow(0.5 + 0.5 * sin(swirl * 3.0), 3.0);
  float dust = fbm2(vec2(swirl * 1.3, r * 6.0 - uTime * 0.8));
  float disc = smoothstep(1.0, 0.55, r) * smoothstep(0.1, 0.24, r);
  float rim = exp(-pow((r - 0.9) * 16.0, 2.0)) * 0.8 + exp(-pow((r - 0.2) * 22.0, 2.0)) * 2.4;
  float e = (arms * (0.35 + dust) * disc * (0.5 + 0.9 * (1.0 - r)) + rim) * env;
  vec3 c = mix(vec3(0.34, 0.08, 0.72), vC.rgb, 1.0 - r) * e + vec3(1.0, 0.9, 1.0) * exp(-pow((r - 0.2) * 30.0, 2.0)) * env;
  gl_FragColor = vec4(c * vC.a, 1.0);
}`;

/** a soft dark lens (normal blending): the eye of a gravity well / the mouth of a rift */
export const DARK_FS = /* glsl */`
uniform float uTime; varying vec2 vUv; varying vec4 vP; varying vec4 vC; varying vec3 vN; varying vec3 vV;
void main() { float r = length(vUv); float a = smoothstep(1.0, 0.35, r) * vC.a; gl_FragColor = vec4(vC.rgb, a); }`;

/** glyph disc flat on the battle plane — p: (spin, age 0..1, seed, -). Dimension-lock seal / arrival sigil. */
export const SIGIL_FS = /* glsl */`
uniform float uTime; varying vec2 vUv; varying vec4 vP; varying vec4 vC; varying vec3 vN; varying vec3 vV;
${NOISE}
float band(float r, float r0, float w) { return exp(-pow((r - r0) / w, 2.0)); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = atan(vUv.y, vUv.x) + vP.x;
  float e = band(r, 0.94, 0.008) * 2.0 + band(r, 0.7, 0.006) * 1.2 + band(r, 0.42, 0.006);
  // hexagram
  vec2 p = vec2(cos(a), sin(a)) * r;
  float tri = 10.0;
  for (int k = 0; k < 6; k++) { float an = float(k) * 1.0471976; vec2 n = vec2(cos(an), sin(an)); tri = min(tri, abs(dot(p, n) - 0.35)); }
  e += exp(-tri * 90.0) * step(r, 0.7) * 0.9;
  float seg = floor(a * 7.6394);
  e += step(0.5, h21(vec2(seg, vP.z))) * band(r, 0.82, 0.035) * step(0.25, fract(a * 7.6394)) * 0.7;
  float env = smoothstep(0.0, 0.1, vP.y) * smoothstep(1.0, 0.75, vP.y);
  gl_FragColor = vec4(vC.rgb * e * env * vC.a, 1.0);
}`;

// ───────────────────────────────────────────────────────────────────────── wings

const WING_VS = /* glsl */`
attribute vec2 wuv;
varying vec2 vW;
void main() { vW = wuv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const WING_FS = /* glsl */`
uniform float uTime; uniform float uPower; uniform vec3 uColor;
varying vec2 vW;
${NOISE}
void main() {
  float u = vW.x, v = vW.y;                 // u: along the span (root → tip), v: leading edge → feather tip
  // feathers: long barbs that fan out along the span, each with a bright shaft
  float n = 34.0;
  float f = fract(u * n);
  float id = floor(u * n);
  float len = 0.55 + 0.45 * h21(vec2(id, 3.0));
  float shaft = pow(1.0 - abs(f - 0.5) * 2.0, 5.0);
  float vane = pow(1.0 - abs(f - 0.5) * 2.0, 0.8);
  float along = smoothstep(len, len * 0.2, v);
  float flow = 0.6 + 0.4 * sin(v * 9.0 - uTime * 5.0 + id * 0.9);
  float lead = exp(-v * 16.0);
  float sparkle = step(0.93, n2(vec2(u * 60.0, v * 22.0 - uTime * 1.6))) * along;
  float e = (shaft * 1.3 + vane * 0.22) * along * flow + lead * 1.5 + sparkle * 0.9;
  float tip = smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.94, u);
  vec3 col = mix(uColor, vec3(1.0, 0.86, 1.0), lead * 0.8 + shaft * 0.3 * along);
  gl_FragColor = vec4(col * e * tip * uPower, 1.0);
}`;
export function wingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: WING_VS, fragmentShader: WING_FS, uniforms: { uTime: { value: 0 }, uPower: { value: 1 }, uColor: { value: new THREE.Color(0.62, 0.3, 1.0) } }, ...additive });
}

// ───────────────────────────────────────────────────────────────────────── shells (shield, blackout)

const SHELL_VS = /* glsl */`
varying vec3 vN; varying vec3 vV; varying vec3 vL;
void main() { vL = position; vec4 wp = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`;
/** PARADOX standing field: barely there, brighter with load, torn when overloaded */
const SHIELD_FS = /* glsl */`
uniform float uTime; uniform float uLevel; uniform float uOver; uniform vec3 uColor;
varying vec3 vN; varying vec3 vV; varying vec3 vL;
${NOISE}
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
  vec2 uv = vec2(atan(vL.x, vL.z) * 2.2, vL.y * 3.2);
  vec4 h = hexc(uv * 2.6);
  float line = smoothstep(0.5, 0.46, hexEdge(h.xy)) - smoothstep(0.46, 0.42, hexEdge(h.xy));
  float wave = 0.5 + 0.5 * sin(vL.z * 3.0 - uTime * 2.4);
  float tear = mix(1.0, step(0.45, fbm2(uv * 1.4 + uTime * 3.0)), uOver);
  float flick = mix(1.0, 0.4 + 0.6 * step(0.5, fract(uTime * 17.0 + h21(h.zw))), uOver);
  // at rest it is almost nothing — a hint of an edge; it only shows itself where and while it works
  float e = (fres * 0.2 + line * (0.08 + 0.4 * wave * uLevel)) * (0.06 + 0.5 * uLevel) * tear * flick;
  vec3 col = mix(uColor, vec3(1.0, 0.3, 0.75), uOver * 0.7);
  gl_FragColor = vec4(col * e, 1.0);
}`;
export function shieldMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: SHELL_VS, fragmentShader: SHIELD_FS, uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uOver: { value: 0 }, uColor: { value: new THREE.Color(0.55, 0.3, 1.0) } }, ...additive });
}
/** BLACKOUT wavefront: an expanding shell of interference */
const WAVE_FS = /* glsl */`
uniform float uTime; uniform float uAge; uniform vec3 uColor;
varying vec3 vN; varying vec3 vV; varying vec3 vL;
${NOISE}
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
  float lat = vL.y;
  float scan = pow(0.5 + 0.5 * sin(lat * 60.0 - uTime * 14.0), 6.0);
  float glitch = step(0.82, n2(vec2(floor(lat * 26.0), floor(uTime * 22.0))));
  float lon = pow(abs(sin(atan(vL.x, vL.z) * 12.0)), 50.0);
  float e = (fres * 1.3 + scan * 0.18 + glitch * 0.3 * fres + lon * 0.12) * pow(1.0 - uAge, 1.4);
  gl_FragColor = vec4(uColor * e, 1.0);
}`;
export function waveMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: SHELL_VS, fragmentShader: WAVE_FS, uniforms: { uTime: { value: 0 }, uAge: { value: 0 }, uColor: { value: new THREE.Color(0.5, 0.22, 1.0) } }, ...additive });
}

// ───────────────────────────────────────────────────────────────────────── screen-space distortion
// A post pass: up to MAX_LENS lenses pull or ripple the image around projected world points (gravity
// well, rift, PARADOX overload, facets under the beam). Costs one full-screen pass only while a lens is active.

export const MAX_LENS = 8;
export const DistortShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uLens: { value: Array.from({ length: MAX_LENS }, () => new THREE.Vector4()) }, uAspect: { value: 1 }, uFlash: { value: new THREE.Vector4(0, 0, 0, 0) }, uTime: { value: 0 }, uFold: { value: new THREE.Vector4(0.5, 0.5, 0, 0) } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec4 uLens[${MAX_LENS}]; uniform float uAspect; uniform vec4 uFlash; uniform float uTime; uniform vec4 uFold;
    varying vec2 vUv;
    void main() {
      vec2 off = vec2(0.0); float ca = 0.0;
      // causality fold: reality creases along a line through the point and springs back — the two
      // sides slide against each other for an instant, colours come apart
      if (uFold.z > 0.001) {
        vec2 d = vUv - uFold.xy; d.x *= uAspect;
        float side = sign(d.y * 0.94 + d.x * 0.34);
        float near = exp(-pow(length(d) * 2.4, 2.0));
        off += vec2(0.94, -0.34) * side * uFold.z * 0.022 * near;
        ca += uFold.z * 0.5 * near + uFold.z * 0.05;
        off += vec2(uFold.z * 0.004, 0.0);
      }
      for (int i = 0; i < ${MAX_LENS}; i++) {
        vec4 L = uLens[i];
        if (L.z <= 0.0) continue;
        vec2 d = vUv - L.xy; d.x *= uAspect;
        float r = length(d) / L.z;
        if (r >= 1.0) continue;
        float f = (1.0 - r); f *= f;
        vec2 dir = d / max(length(d), 1e-5); dir.x /= uAspect;
        // w > 0: gravitational pull (image drawn toward the centre); w < 0: a ripple travelling outward
        float k = L.w > 0.0 ? L.w * f * smoothstep(0.0, 0.2, r) : -L.w * sin(r * 22.0 - uTime * 16.0) * f * 0.35;
        off -= dir * k * L.z;
        ca += abs(k);
      }
      vec3 c;
      if (ca > 0.0005) {
        c.r = texture2D(tDiffuse, vUv + off * 1.12).r;
        c.g = texture2D(tDiffuse, vUv + off).g;
        c.b = texture2D(tDiffuse, vUv + off * 0.88).b;
      } else c = texture2D(tDiffuse, vUv).rgb;
      c += uFlash.rgb * uFlash.a;
      gl_FragColor = vec4(c, 1.0);
    }`,
};
