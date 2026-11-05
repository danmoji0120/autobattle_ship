// Scenery of one star system: star, planets, moons, rings, orbits, jump gates, trade lanes and the
// security map. Built in global coordinates and parented to the view's world root.
import * as THREE from 'three';
import type { StarSystem, Station, Lair, V } from '../../world/types';
import { secAt } from '../../world/security';

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
  private secTex: THREE.DataTexture;
  private secMat: THREE.MeshBasicMaterial;
  private secKey = '';
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
    // security map: a soft colour wash on the ecliptic plane
    const N = 192;
    this.secTex = new THREE.DataTexture(new Uint8Array(N * N * 4), N, N, THREE.RGBAFormat);
    this.secTex.magFilter = THREE.LinearFilter; this.secTex.minFilter = THREE.LinearFilter;
    this.secMat = new THREE.MeshBasicMaterial({ map: this.secTex, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.secPlane = new THREE.Mesh(new THREE.PlaneGeometry(sys.radius * 2.1, sys.radius * 2.1), this.secMat);
    this.secPlane.rotation.x = -Math.PI / 2; this.secPlane.position.set(o.x, -200, o.z);
    this.secPlane.renderOrder = -4;
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

  /** recompute the security wash when stations, lairs or system heat change */
  updateSecurity(w: { systems: Record<string, StarSystem>; stations: Record<string, Station>; lairs: Record<string, Lair> }) {
    const sys = w.systems[this.sys.id]; if (!sys) return;
    const key = `${Math.round(sys.heat)}|${Object.values(w.lairs).map(l => l.alive ? 1 : 0).join('')}|${Object.keys(w.stations).length}|${Object.values(w.stations).reduce((a, s) => a + s.modules.filter(m => m.built).length, 0)}`;
    if (key === this.secKey) return;
    this.secKey = key;
    const N = this.secTex.image.width, d = this.secTex.image.data as Uint8Array;
    const R = sys.radius * 1.05;
    const col = (v: number): [number, number, number] => v >= 90 ? [60, 200, 255] : v >= 70 ? [70, 230, 140] : v >= 40 ? [230, 190, 70] : v >= 15 ? [240, 110, 50] : [240, 40, 40];
    const band = (v: number) => v >= 90 ? 4 : v >= 70 ? 3 : v >= 40 ? 2 : v >= 15 ? 1 : 0;
    const vals = new Float32Array(N * N), rrs = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = sys.origin.x + (i / (N - 1) * 2 - 1) * R, z = sys.origin.z - (j / (N - 1) * 2 - 1) * R;
      rrs[j * N + i] = Math.hypot(x - sys.origin.x, z - sys.origin.z) / sys.radius;
      vals[j * N + i] = rrs[j * N + i] > 1.02 ? -1 : secAt(w, { x, y: 0, z }, sys);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 4, v = vals[j * N + i], rr = rrs[j * N + i];
      if (v < 0) { d[k] = d[k + 1] = d[k + 2] = 0; d[k + 3] = 255; continue; }
      const b = band(v);
      // contour where a neighbour falls in another band: the readable part of the map
      let edge = false;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue; const nv = vals[jj * N + ii]; if (nv >= 0 && band(nv) !== b) edge = true; }
      const [r, g, bl] = col(v);
      const fade = 1 - Math.min(1, Math.max(0, (rr - 0.92) / 0.1));
      // safe space is only tinted; dangerous space glows
      const a = fade * (edge ? 0.75 : b >= 3 ? 0.03 : b === 2 ? 0.07 : b === 1 ? 0.13 : 0.17);
      d[k] = r * a; d[k + 1] = g * a; d[k + 2] = bl * a; d[k + 3] = 255;
    }
    this.secTex.needsUpdate = true;
  }

  setSecurityOpacity(o: number) { this.secMat.opacity = o; this.secPlane.visible = o > 0.003; }

  update(dt: number, time: number) {
    this.starMat.uniforms.uTime.value = time;
    for (const s of this.spin) s.rotation.y += dt * 0.004;
    for (const g of this.gates) { (g.disc.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.12 * Math.sin(time * 2 + g.pos.x); g.disc.rotation.z += dt * 0.3; }
  }

  dispose() { this.group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); }); }
}
