import * as THREE from 'three';

// ----------------------------------------------------------------------------- particles
// Camera-facing instanced quads (no point-size limits), CPU simulated.

const PARTICLE_VS = /* glsl */`
attribute vec3 offset;
attribute vec4 pcolor;
attribute vec2 psize; // x = size, y = rotation
uniform float uDistK;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vColor = pcolor;
  vUv = position.xy + 0.5;
  vec4 mv = modelViewMatrix * vec4(offset, 1.0);
  float c = cos(psize.y), s = sin(psize.y);
  vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  float distBoost = max(1.0, -mv.z * uDistK);
  mv.xy += corner * psize.x * distBoost;
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS_GLOW = /* glsl */`
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vec2 d = vUv - 0.5;
  float r = length(d) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  a = a * a * (0.6 + 0.4 * smoothstep(0.5, 0.0, r));
  gl_FragColor = vec4(vColor.rgb * a * vColor.a, 1.0);
}`;

const PARTICLE_FS_SMOKE = /* glsl */`
varying vec4 vColor;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 d = vUv - 0.5;
  float r = length(d) * 2.0;
  float n = noise(vUv * 4.0 + vColor.a * 3.0) * 0.5 + noise(vUv * 9.0) * 0.25;
  float a = smoothstep(1.0, 0.2, r + n * 0.5);
  gl_FragColor = vec4(vColor.rgb, a * vColor.a);
}`;

export interface ParticleOpts {
  life: number; size: number; size1?: number; color: THREE.Color | number; color1?: THREE.Color | number;
  vel?: THREE.Vector3; drag?: number; alpha?: number; spin?: number; alpha1?: number;
}

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  private max: number;
  private count = 0;
  private pos: Float32Array; private vel: Float32Array; private life: Float32Array; private maxLife: Float32Array;
  private s0: Float32Array; private s1: Float32Array; private c0: Float32Array; private c1: Float32Array;
  private drag: Float32Array; private a0: Float32Array; private a1: Float32Array; private rot: Float32Array; private spin: Float32Array;
  private offsetAttr: THREE.InstancedBufferAttribute; private colorAttr: THREE.InstancedBufferAttribute; private sizeAttr: THREE.InstancedBufferAttribute;
  private geom: THREE.InstancedBufferGeometry;
  private tc = new THREE.Color(); private tc1 = new THREE.Color();

  constructor(max: number, kind: 'glow' | 'smoke') {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index; g.setAttribute('position', base.getAttribute('position'));
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3); this.c1 = new Float32Array(max * 3);
    this.drag = new Float32Array(max); this.a0 = new Float32Array(max); this.a1 = new Float32Array(max);
    this.rot = new Float32Array(max); this.spin = new Float32Array(max);
    this.offsetAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('offset', this.offsetAttr); g.setAttribute('pcolor', this.colorAttr); g.setAttribute('psize', this.sizeAttr);
    g.instanceCount = 0;
    this.geom = g;
    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS, fragmentShader: kind === 'glow' ? PARTICLE_FS_GLOW : PARTICLE_FS_SMOKE,
      transparent: true, depthWrite: false,
      uniforms: { uDistK: { value: kind === 'glow' ? 1 / 900 : 1 / 1600 } },
      blending: kind === 'glow' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = kind === 'glow' ? 3 : 2;
  }

  emit(p: THREE.Vector3 | { x: number; y: number; z: number }, o: ParticleOpts) {
    let i: number;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max); // overwrite randomly when saturated
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    const v = o.vel;
    this.vel[i3] = v ? v.x : 0; this.vel[i3 + 1] = v ? v.y : 0; this.vel[i3 + 2] = v ? v.z : 0;
    this.life[i] = o.life; this.maxLife[i] = o.life;
    this.s0[i] = o.size; this.s1[i] = o.size1 ?? o.size;
    this.tc.set(o.color as any); this.tc1.set((o.color1 ?? o.color) as any);
    this.c0[i3] = this.tc.r; this.c0[i3 + 1] = this.tc.g; this.c0[i3 + 2] = this.tc.b;
    this.c1[i3] = this.tc1.r; this.c1[i3 + 1] = this.tc1.g; this.c1[i3 + 2] = this.tc1.b;
    this.drag[i] = o.drag ?? 0; this.a0[i] = o.alpha ?? 1; this.a1[i] = o.alpha1 ?? 0;
    this.rot[i] = Math.random() * 6.28; this.spin[i] = o.spin ?? (Math.random() - 0.5);
  }

  update(dt: number) {
    const off = this.offsetAttr.array as Float32Array, col = this.colorAttr.array as Float32Array, sz = this.sizeAttr.array as Float32Array;
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        n--;
        if (i !== n) this.copy(n, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= d; this.vel[i3 + 1] *= d; this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.rot[i] += this.spin[i] * dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      off[i3] = this.pos[i3]; off[i3 + 1] = this.pos[i3 + 1]; off[i3 + 2] = this.pos[i3 + 2];
      const i4 = i * 4;
      col[i4] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      col[i4 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      col[i4 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      // fade in quickly, then toward a1
      const fin = Math.min(1, t * 12);
      col[i4 + 3] = (this.a0[i] + (this.a1[i] - this.a0[i]) * t) * fin;
      sz[i * 2] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      sz[i * 2 + 1] = this.rot[i];
    }
    this.count = n;
    this.geom.instanceCount = n;
    this.offsetAttr.needsUpdate = true; this.colorAttr.needsUpdate = true; this.sizeAttr.needsUpdate = true;
    this.offsetAttr.clearUpdateRanges(); this.offsetAttr.addUpdateRange(0, n * 3);
    this.colorAttr.clearUpdateRanges(); this.colorAttr.addUpdateRange(0, n * 4);
    this.sizeAttr.clearUpdateRanges(); this.sizeAttr.addUpdateRange(0, n * 2);
  }

  private copy(from: number, to: number) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k]; this.vel[t3 + k] = this.vel[f3 + k];
      this.c0[t3 + k] = this.c0[f3 + k]; this.c1[t3 + k] = this.c1[f3 + k];
    }
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.s0[to] = this.s0[from]; this.s1[to] = this.s1[from];
    this.drag[to] = this.drag[from]; this.a0[to] = this.a0[from]; this.a1[to] = this.a1[from];
    this.rot[to] = this.rot[from]; this.spin[to] = this.spin[from];
  }

  get active() { return this.count; }
}

// ----------------------------------------------------------------------------- trails / beams
// Camera-facing ribbons rebuilt every frame from segment lists.

const TRAIL_VS = /* glsl */`
attribute vec4 tcolor;
varying vec4 vColor;
varying vec2 vUv;
void main() { vColor = tcolor; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TRAIL_FS = /* glsl */`
varying vec4 vColor;
varying vec2 vUv;
void main() {
  float e = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float a = e * e * (0.5 + 0.5 * e);
  gl_FragColor = vec4(vColor.rgb * a * vColor.a, 1.0);
}`;

export class TrailBatch {
  readonly mesh: THREE.Mesh;
  private max: number;
  private n = 0;
  private posA: THREE.BufferAttribute; private colA: THREE.BufferAttribute; private uvA: THREE.BufferAttribute;
  private geom: THREE.BufferGeometry;
  private camPos = new THREE.Vector3();
  private d = new THREE.Vector3(); private side = new THREE.Vector3(); private toCam = new THREE.Vector3();

  constructor(max: number) {
    this.max = max;
    const g = new THREE.BufferGeometry();
    this.posA = new THREE.BufferAttribute(new Float32Array(max * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colA = new THREE.BufferAttribute(new Float32Array(max * 4 * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.uvA = new THREE.BufferAttribute(new Float32Array(max * 4 * 2), 2);
    const idx = new Uint32Array(max * 6);
    const uv = this.uvA.array as Float32Array;
    for (let i = 0; i < max; i++) {
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
      uv.set([0, 0, 0, 1, 1, 0, 1, 1], i * 8);
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setAttribute('position', this.posA); g.setAttribute('tcolor', this.colA); g.setAttribute('uv', this.uvA);
    this.geom = g;
    const mat = new THREE.ShaderMaterial({ vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  begin(camera: THREE.Camera) { this.n = 0; this.camPos.setFromMatrixPosition(camera.matrixWorld); }

  /** segment a→b with widths and rgba at each end */
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, wa: number, wb: number, r: number, g: number, b: number, aa: number, ab: number) {
    if (this.n >= this.max) return;
    this.d.set(bx - ax, by - ay, bz - az);
    this.toCam.set(this.camPos.x - (ax + bx) * 0.5, this.camPos.y - (ay + by) * 0.5, this.camPos.z - (az + bz) * 0.5);
    this.side.crossVectors(this.d, this.toCam);
    const l = this.side.length();
    if (l < 1e-6) return;
    this.side.multiplyScalar(1 / l);
    const dc = this.toCam.length();
    const boost = Math.max(1, dc / 260);
    wa *= boost; wb *= boost;
    const p = this.posA.array as Float32Array, c = this.colA.array as Float32Array;
    const i = this.n * 12, j = this.n * 16;
    const sx = this.side.x, sy = this.side.y, sz = this.side.z;
    p[i] = ax - sx * wa; p[i + 1] = ay - sy * wa; p[i + 2] = az - sz * wa;
    p[i + 3] = ax + sx * wa; p[i + 4] = ay + sy * wa; p[i + 5] = az + sz * wa;
    p[i + 6] = bx - sx * wb; p[i + 7] = by - sy * wb; p[i + 8] = bz - sz * wb;
    p[i + 9] = bx + sx * wb; p[i + 10] = by + sy * wb; p[i + 11] = bz + sz * wb;
    c[j] = r; c[j + 1] = g; c[j + 2] = b; c[j + 3] = aa;
    c[j + 4] = r; c[j + 5] = g; c[j + 6] = b; c[j + 7] = aa;
    c[j + 8] = r; c[j + 9] = g; c[j + 10] = b; c[j + 11] = ab;
    c[j + 12] = r; c[j + 13] = g; c[j + 14] = b; c[j + 15] = ab;
    this.n++;
  }

  end() {
    this.posA.needsUpdate = true; this.colA.needsUpdate = true;
    this.posA.clearUpdateRanges(); this.posA.addUpdateRange(0, this.n * 12);
    this.colA.clearUpdateRanges(); this.colA.addUpdateRange(0, this.n * 16);
    this.geom.setDrawRange(0, this.n * 6);
  }
}

// ----------------------------------------------------------------------------- shockwave rings

export class Shockwaves {
  readonly group = new THREE.Group();
  private pool: { mesh: THREE.Mesh; life: number; max: number; size: number; mat: THREE.ShaderMaterial }[] = [];
  private geo = new THREE.PlaneGeometry(2, 2);
  constructor() {
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uColor: { value: new THREE.Color() }, uT: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uT; varying vec2 vUv;
          void main(){
            float r = length(vUv);
            float w = 0.06 + uT * 0.18;
            float ring = exp(-pow((r - 0.86) / w, 2.0));
            float inner = smoothstep(0.86, 0.0, r) * 0.12 * (1.0 - uT);
            float a = (ring + inner) * pow(1.0 - uT, 1.6);
            gl_FragColor = vec4(uColor * a, 1.0);
          }`,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.pool.push({ mesh, life: 0, max: 1, size: 1, mat });
    }
  }
  spawn(pos: THREE.Vector3, size: number, life: number, color: number, normal?: THREE.Vector3) {
    const s = this.pool.find(p => p.life <= 0) ?? this.pool[0];
    s.life = life; s.max = life; s.size = size;
    s.mesh.position.copy(pos);
    s.mesh.visible = true;
    (s.mat.uniforms.uColor.value as THREE.Color).set(color).multiplyScalar(1.4);
    const n = normal ?? new THREE.Vector3(Math.random() - 0.5, 2, Math.random() - 0.5).normalize();
    s.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  }
  update(dt: number) {
    for (const s of this.pool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const t = 1 - s.life / s.max;
      s.mesh.scale.setScalar(s.size * (0.08 + Math.pow(t, 0.4)));
      s.mat.uniforms.uT.value = t;
      if (s.life <= 0) s.mesh.visible = false;
    }
  }
}

// ----------------------------------------------------------------------------- flash lights

export class FlashLights {
  readonly group = new THREE.Group();
  private lights: { l: THREE.PointLight; life: number; max: number; peak: number }[] = [];
  constructor(n = 8) {
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffaa66, 0, 400, 1.6);
      this.group.add(l);
      this.lights.push({ l, life: 0, max: 1, peak: 0 });
    }
  }
  flash(pos: THREE.Vector3, intensity: number, range: number, life: number, color = 0xffaa66) {
    // replace the weakest light
    let best = this.lights[0], bv = Infinity;
    for (const x of this.lights) { const v = x.life <= 0 ? -1 : x.peak * x.life / x.max; if (v < bv) { bv = v; best = x; } }
    if (bv > intensity) return;
    best.l.position.copy(pos); best.l.distance = range; best.l.color.set(color);
    best.life = life; best.max = life; best.peak = intensity;
  }
  update(dt: number) {
    for (const x of this.lights) {
      if (x.life <= 0) { x.l.intensity = 0; continue; }
      x.life -= dt;
      const t = Math.max(0, x.life / x.max);
      x.l.intensity = x.peak * t * t;
    }
  }
}

// ----------------------------------------------------------------------------- debris chunks

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private items: { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3; s: number; life: number; hot: number }[] = [];
  private max: number;
  private m = new THREE.Matrix4(); private dq = new THREE.Quaternion(); private sv = new THREE.Vector3(); private e = new THREE.Euler();
  onHot?: (p: THREE.Vector3, v: THREE.Vector3, hot: number) => void;
  constructor(max = 600) {
    this.max = max;
    const geo = new THREE.IcosahedronGeometry(1, 0);
    geo.scale(1, 0.4, 1.6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 0.7, metalness: 0.6, emissive: 0x220800 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }
  spawn(p: THREE.Vector3, v: THREE.Vector3, size: number, life: number, hot = 1) {
    if (this.items.length >= this.max) this.items.shift();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    const w = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(6);
    this.items.push({ p: p.clone(), v: v.clone(), q, w, s: size, life, hot });
  }
  update(dt: number) {
    let k = 0;
    for (let i = 0; i < this.items.length; i++) {
      const d = this.items[i];
      d.life -= dt;
      if (d.life <= 0) continue;
      d.p.addScaledVector(d.v, dt);
      d.v.multiplyScalar(Math.exp(-0.08 * dt));
      this.e.set(d.w.x * dt, d.w.y * dt, d.w.z * dt);
      this.dq.setFromEuler(this.e); d.q.multiply(this.dq);
      d.hot = Math.max(0, d.hot - dt * 0.35);
      if (this.onHot && d.hot > 0.15 && Math.random() < 0.5) this.onHot(d.p, d.v, d.hot);
      const s = d.s * Math.min(1, d.life / 2);
      this.sv.set(s, s, s);
      this.m.compose(d.p, d.q, this.sv);
      this.mesh.setMatrixAt(k, this.m);
      this.items[k] = d;
      k++;
    }
    this.items.length = k;
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ----------------------------------------------------------------------------- textures

export function radialTexture(size = 64, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, inner); gr.addColorStop(0.25, inner.replace(/[\d.]+\)$/, '0.6)')); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
