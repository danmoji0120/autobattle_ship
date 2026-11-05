// Scenery of one star system: star, planets, moons, rings, orbits, jump gates, trade lanes and the
// security map. Built in global coordinates and parented to the view's world root.
import * as THREE from 'three';
import type { StarSystem, Station, Lair, V } from '../../world/types';
import { secField } from '../../world/security';

const SEC_MAX = 48;
const SEC_VS = /* glsl */`
varying vec2 vP;
// plane local (x, y) → system-local (x, z): the plane is rotated -90° about X
void main() { vP = vec2(position.x, -position.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SEC_FS = /* glsl */`
uniform float uEff; uniform float uRim; uniform float uR; uniform int uN; uniform vec4 uSrc[${SEC_MAX}]; uniform float uAlpha;
varying vec2 vP;
vec3 bandCol(float v) {
  // core / settled / frontier / danger / lawless, blended across a few points at each border
  vec3 c = vec3(1.00, 0.20, 0.16);
  c = mix(c, vec3(1.00, 0.48, 0.18), smoothstep(13.0, 17.0, v));
  c = mix(c, vec3(1.00, 0.80, 0.25), smoothstep(37.0, 43.0, v));
  c = mix(c, vec3(0.35, 1.00, 0.58), smoothstep(67.0, 73.0, v));
  c = mix(c, vec3(0.30, 0.85, 1.00), smoothstep(88.0, 92.0, v));
  return c;
}
float iso(float v, float t, float w) { float d = abs(v - t) / max(fwidth(v), 1e-4); return 1.0 - smoothstep(w * 0.5, w * 0.5 + 1.0, d); }
void main() {
  float r = length(vP) / uR;
  if (r > 1.02) discard;
  float v = uEff - clamp((r - 0.5) / 0.5, 0.0, 1.0) * uRim;
  for (int i = 0; i < ${SEC_MAX}; i++) { if (i >= uN) break; vec4 s = uSrc[i]; v += s.z * max(0.0, 1.0 - length(vP - s.xy) / s.w); }
  v = clamp(v, 0.0, 100.0);
  vec3 col = bandCol(v);
  // danger glows, safety is a light tint; band borders are crisp anti-aliased lines
  float fill = mix(0.36, 0.17, smoothstep(10.0, 70.0, v));
  float major = max(max(iso(v, 15.0, 2.2), iso(v, 40.0, 2.2)), max(iso(v, 70.0, 2.2), iso(v, 90.0, 2.2)));
  float edge = 1.0 - smoothstep(0.96, 1.02, r);
  float a = clamp(fill + major * 0.9, 0.0, 1.0) * edge * uAlpha;
  gl_FragColor = vec4(mix(col, vec3(1.0), major * 0.25) * (0.85 + major * 0.25), a);
}`;

const PLANET_VS = /* glsl */`
varying vec3 vN; varying vec3 vW; varying vec3 vL;
void main() { vN = normalize(mat3(modelMatrix) * normal); vL = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const PLANET_FS = /* glsl */`
uniform vec3 uColor; uniform vec3 uAtmo; uniform vec3 uStar; uniform float uSeed; uniform float uGas;
varying vec3 vN; varying vec3 vW; varying vec3 vL;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.1; a *= 0.5; } return s; }
void main() {
  vec3 n = normalize(vN);
  vec3 p = normalize(vL) + uSeed;
  float bands = sin((normalize(vL).y * 14.0 + fbm(p * 3.0) * 3.0)) * 0.5 + 0.5;
  float land = smoothstep(0.45, 0.6, fbm(p * 2.5));
  float detail = fbm(p * 9.0);
  vec3 gas = uColor * (0.6 + 0.4 * bands) * (0.8 + 0.3 * detail);
  vec3 rock = mix(uColor * 0.55, uColor * 1.15 + 0.05, land) * (0.75 + 0.4 * detail);
  vec3 base = mix(rock, gas, uGas);
  vec3 L = normalize(uStar - vW);
  float diff = max(dot(n, L), 0.0);
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 col = base * (diff * 1.25 + 0.025);
  col += uAtmo * rim * (0.08 + smoothstep(-0.2, 0.6, dot(n, L)) * 1.1);
  gl_FragColor = vec4(col, 1.0);
}`;

const STAR_FS = /* glsl */`
uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vW; varying vec3 vL;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
void main() {
  vec3 p = normalize(vL) * 5.0;
  float g = noise(p + uTime * 0.05) * 0.5 + noise(p * 2.3 - uTime * 0.08) * 0.35;
  vec3 V = normalize(cameraPosition - vW);
  float limb = pow(max(dot(normalize(vN), V), 0.0), 0.45);
  gl_FragColor = vec4(uColor * (1.6 + g * 1.4) * (0.55 + 0.45 * limb), 1.0);
}`;

function glowTex(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.45)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function ringTex(seed: number): THREE.Texture {
  const c = document.createElement('canvas'); c.width = 256; c.height = 4;
  const g = c.getContext('2d')!;
  let r = seed; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let x = 0; x < 256; x++) { const a = (0.15 + rnd() * 0.6) * Math.sin(x / 256 * Math.PI); g.fillStyle = `rgba(255,240,220,${a.toFixed(3)})`; g.fillRect(x, 0, 1, 4); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

let GLOW: THREE.Texture | null = null;

export interface GateView { id: string; obj: THREE.Group; disc: THREE.Mesh; pos: V }

export class SystemScene {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  gates: GateView[] = [];
  private star: THREE.Mesh;
  private starMat: THREE.ShaderMaterial;
  private planetMats: THREE.ShaderMaterial[] = [];
  private secPlane: THREE.Mesh;
  private secMat: THREE.ShaderMaterial;
  private spin: THREE.Object3D[] = [];
  readonly sys: StarSystem;

  constructor(sys: StarSystem) {
    this.sys = sys;
    GLOW ??= glowTex();
    const o = sys.origin;
    const starCol = new THREE.Color(sys.star.color);
    // star with corona sprites (bloom does the rest)
    this.starMat = new THREE.ShaderMaterial({ vertexShader: PLANET_VS, fragmentShader: STAR_FS, uniforms: { uColor: { value: starCol.clone() }, uTime: { value: 0 } } });
    this.star = new THREE.Mesh(new THREE.SphereGeometry(sys.star.size, 64, 32), this.starMat);
    this.star.position.set(o.x, o.y, o.z);
    this.group.add(this.star);
    for (const [k, a] of [[5, 0.7], [11, 0.25], [24, 0.08]] as [number, number][]) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: starCol.clone().multiplyScalar(1.6), transparent: true, opacity: a, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.scale.setScalar(sys.star.size * k); sp.position.copy(this.star.position);
      this.group.add(sp);
    }
    this.light = new THREE.PointLight(starCol, 3.2, 0, 0);
    this.light.position.copy(this.star.position);
    this.group.add(this.light);

    const orbitMat = new THREE.LineBasicMaterial({ color: 0x6aa0d0, transparent: true, opacity: 0.12, depthWrite: false });
    const circle = (r: number, mat: THREE.Material, cx = o.x, cz = o.z, y = 0) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 128; i++) { const a = i / 128 * Math.PI * 2; pts.push(new THREE.Vector3(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r)); }
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    };
    for (const pl of sys.planets) {
      this.group.add(circle(Math.hypot(pl.pos.x - o.x, pl.pos.z - o.z), orbitMat));
      const mat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VS, fragmentShader: PLANET_FS,
        uniforms: { uColor: { value: new THREE.Color(pl.color) }, uAtmo: { value: new THREE.Color(pl.atmo) }, uStar: { value: this.star.position.clone() }, uSeed: { value: (pl.id.length * 1.7) % 5 }, uGas: { value: pl.size > 2500 ? 1 : 0 } },
      });
      this.planetMats.push(mat);
      const m = new THREE.Mesh(new THREE.SphereGeometry(pl.size, 64, 40), mat);
      m.position.set(pl.pos.x, pl.pos.y, pl.pos.z); m.rotation.z = 0.25;
      this.group.add(m); this.spin.push(m);
      if (pl.ring) {
        const rg = new THREE.RingGeometry(pl.size * 1.35, pl.size * 2.3, 128, 1);
        // map the ring texture radially
        const uv = rg.attributes.uv as THREE.BufferAttribute, pos = rg.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) { const r = Math.hypot(pos.getX(i), pos.getY(i)); uv.setXY(i, (r - pl.size * 1.35) / (pl.size * 0.95), 0.5); }
        const ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ map: ringTex(pl.id.length * 97), color: new THREE.Color(pl.atmo).multiplyScalar(0.55), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
        ring.position.copy(m.position); ring.rotation.x = -Math.PI / 2 + 0.18;
        this.group.add(ring);
      }
      for (const mo of pl.moons) {
        const mm = new THREE.Mesh(new THREE.SphereGeometry(mo.size, 32, 20), new THREE.ShaderMaterial({ vertexShader: PLANET_VS, fragmentShader: PLANET_FS, uniforms: { uColor: { value: new THREE.Color('#8a8a8a') }, uAtmo: { value: new THREE.Color('#202020') }, uStar: { value: this.star.position.clone() }, uSeed: { value: mo.name.length } , uGas: { value: 0 } } }));
        mm.position.set(mo.pos.x, mo.pos.y, mo.pos.z);
        this.group.add(mm);
      }
    }
    // jump gates
    const gateMetal = new THREE.MeshStandardMaterial({ color: 0x6a7480, roughness: 0.4, metalness: 0.85 });
    for (const g of sys.gates) {
      const obj = new THREE.Group();
      obj.position.set(g.pos.x, g.pos.y, g.pos.z);
      obj.lookAt(o.x, g.pos.y, o.z);
      obj.add(new THREE.Mesh(new THREE.TorusGeometry(240, 22, 12, 64), gateMetal));
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        const pyl = new THREE.Mesh(new THREE.BoxGeometry(30, 90, 50), gateMetal);
        pyl.position.set(Math.cos(a) * 262, Math.sin(a) * 262, 0); pyl.rotation.z = a;
        obj.add(pyl);
        const l = new THREE.Mesh(new THREE.SphereGeometry(9, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x60d8ff).multiplyScalar(2.5) }));
        l.position.set(Math.cos(a) * 300, Math.sin(a) * 300, 0); obj.add(l);
      }
      const disc = new THREE.Mesh(new THREE.CircleGeometry(220, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3aa0ff).multiplyScalar(0.9), transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
      obj.add(disc);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: 0x60c0ff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.scale.setScalar(1400); obj.add(halo);
      this.group.add(obj);
      this.gates.push({ id: g.id, obj, disc, pos: g.pos });
    }
    // security map: evaluated per pixel in a shader from the same formula as secAt (no texture, so
    // band borders stay sharp and smooth at any zoom); hidden unless the player turns it on
    this.secMat = new THREE.ShaderMaterial({
      vertexShader: SEC_VS, fragmentShader: SEC_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uEff: { value: 0 }, uRim: { value: 0 }, uR: { value: sys.radius }, uN: { value: 0 }, uSrc: { value: Array.from({ length: SEC_MAX }, () => new THREE.Vector4()) }, uAlpha: { value: 0 } },
    });
    this.secPlane = new THREE.Mesh(new THREE.PlaneGeometry(sys.radius * 2.1, sys.radius * 2.1), this.secMat);
    this.secPlane.rotation.x = -Math.PI / 2; this.secPlane.position.set(o.x, -200, o.z);
    this.secPlane.renderOrder = -4; this.secPlane.visible = false;
    this.group.add(this.secPlane);
    // system boundary
    this.group.add(circle(sys.radius, new THREE.LineBasicMaterial({ color: 0x40a0ff, transparent: true, opacity: 0.18 }), o.x, o.z, -200));
  }

  /** trade lanes between stations and gates */
  setLanes(stations: Record<string, Station>) {
    const node = (id: string) => stations[id]?.pos ?? this.sys.gates.find(g => g.id === id)?.pos;
    const pts: THREE.Vector3[] = [];
    for (const [a, b] of this.sys.lanes) { const pa = node(a), pb = node(b); if (pa && pb) pts.push(new THREE.Vector3(pa.x, pa.y - 20, pa.z), new THREE.Vector3(pb.x, pb.y - 20, pb.z)); }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const lines = new THREE.LineSegments(geo, new THREE.LineDashedMaterial({ color: 0x7fd0ff, dashSize: 400, gapSize: 300, transparent: true, opacity: 0.32, depthWrite: false }));
    lines.computeLineDistances();
    this.group.add(lines);
  }

  /** push the current security field (heat, garrisons, defences, lairs) into the shader */
  updateSecurity(w: { systems: Record<string, StarSystem>; stations: Record<string, Station>; lairs: Record<string, Lair> }) {
    const sys = w.systems[this.sys.id]; if (!sys) return;
    const f = secField(w, sys), u = this.secMat.uniforms;
    u.uEff.value = f.eff; u.uRim.value = f.rim; u.uR.value = f.radius;
    // the strongest sources first if a system ever has more than the shader holds
    const src = f.src.length > SEC_MAX ? [...f.src].sort((a, b) => Math.abs(b[2]) * b[3] - Math.abs(a[2]) * a[3]).slice(0, SEC_MAX) : f.src;
    u.uN.value = src.length;
    src.forEach(([x, z, amp, r], i) => (u.uSrc.value[i] as THREE.Vector4).set(x, z, amp, r));
  }

  setSecurityOpacity(o: number) { this.secMat.uniforms.uAlpha.value = o; this.secPlane.visible = o > 0.003; }

  update(dt: number, time: number) {
    this.starMat.uniforms.uTime.value = time;
    for (const s of this.spin) s.rotation.y += dt * 0.004;
    for (const g of this.gates) { (g.disc.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.12 * Math.sin(time * 2 + g.pos.x); g.disc.rotation.z += dt * 0.3; }
  }

  dispose() { this.group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); }); }
}
