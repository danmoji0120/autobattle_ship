import * as THREE from 'three';

const SKY_VS = /* glsl */`
varying vec3 vDir;
void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;

const SKY_FS = /* glsl */`
uniform vec3 uNebA; uniform vec3 uNebB; uniform vec3 uSunDir; uniform vec3 uSun;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float band = exp(-pow(d.y * 2.2 + 0.25 * sin(d.x * 3.0), 2.0));
  float n1 = fbm(d * 2.2 + vec3(3.1, 0.0, 1.7));
  float n2 = fbm(d * 4.5 + vec3(n1 * 2.0));
  float dust = smoothstep(0.35, 0.95, n2) * band;
  vec3 col = vec3(0.004, 0.006, 0.012);
  col += uNebA * pow(n1, 2.5) * 1.4 * (0.35 + band);
  col += uNebB * pow(n2, 3.0) * 1.6 * band;
  col *= 1.0 - dust * 0.7;
  // dense star dust in the band
  float sd = hash(floor(d * 900.0));
  col += vec3(0.8, 0.85, 1.0) * step(0.9975, sd) * (0.4 + band);
  // sun halo
  float sd2 = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSun * (pow(sd2, 900.0) * 30.0 + pow(sd2, 40.0) * 0.25 + pow(sd2, 6.0) * 0.06);
  gl_FragColor = vec4(col, 1.0);
}`;

const PLANET_VS = /* glsl */`
varying vec3 vN; varying vec3 vP; varying vec3 vL;
void main() { vN = normalize(normalMatrix * normal); vL = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vP = mv.xyz; gl_Position = projectionMatrix * mv; }`;
const PLANET_FS = /* glsl */`
uniform vec3 uColor; uniform vec3 uSunDirV; uniform vec3 uAtmo;
varying vec3 vN; varying vec3 vP; varying vec3 vL;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
void main() {
  vec3 n = normalize(vN);
  vec3 p = normalize(vL);
  float bands = sin(p.y * 22.0 + noise(p * 6.0) * 4.0) * 0.5 + 0.5;
  float detail = noise(p * 18.0) * 0.5 + noise(p * 40.0) * 0.25;
  vec3 base = uColor * (0.55 + 0.35 * bands + 0.25 * detail);
  float diff = max(dot(n, normalize(uSunDirV)), 0.0);
  float term = smoothstep(0.0, 0.25, diff);
  vec3 col = base * (diff * 1.3) + base * 0.015;
  float rim = pow(1.0 - max(dot(n, normalize(-vP)), 0.0), 3.0);
  col += uAtmo * rim * (0.2 + term * 1.6);
  gl_FragColor = vec4(col, 1.0);
}`;

export interface Backdrop { planet: string; nebula: [string, string]; sun: string }

export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly sunDir: THREE.Vector3;
  private planetMat: THREE.ShaderMaterial;
  readonly grid: THREE.Mesh;
  private gridMat: THREE.ShaderMaterial;

  constructor(b: Backdrop) {
    this.sunDir = new THREE.Vector3(-0.6, 0.35, -0.7).normalize();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(50000, 48, 24), new THREE.ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uNebA: { value: new THREE.Color(b.nebula[0]) }, uNebB: { value: new THREE.Color(b.nebula[1]) },
        uSunDir: { value: this.sunDir }, uSun: { value: new THREE.Color(b.sun) },
      },
    }));
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.group.add(sky);

    // stars
    const N = 6000;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 30000;
      const s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
      const t = Math.random();
      const c = t < 0.2 ? [1, 0.8, 0.6] : t < 0.5 ? [0.7, 0.8, 1] : [1, 1, 1];
      const br = 0.15 + Math.pow(Math.random(), 4) * 0.75;
      col.set([c[0] * br, c[1] * br, c[2] * br], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true }));
    stars.frustumCulled = false;
    this.group.add(stars);

    // planet
    this.planetMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VS, fragmentShader: PLANET_FS,
      uniforms: { uColor: { value: new THREE.Color(b.planet) }, uSunDirV: { value: new THREE.Vector3() }, uAtmo: { value: new THREE.Color(b.planet).lerp(new THREE.Color(0x88bbff), 0.6) } },
    });
    const planet = new THREE.Mesh(new THREE.SphereGeometry(11000, 64, 48), this.planetMat);
    planet.position.set(-52000, -14000, 18000);
    planet.rotation.z = 0.3;
    this.group.add(planet);

    // asteroid dust ring far below for depth cues
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x2e2a28, roughness: 1, metalness: 0 });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 140);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < 140; i++) {
      const a = Math.random() * Math.PI * 2, r = 5200 + Math.random() * 4000;
      p.set(Math.cos(a) * r, -900 - Math.random() * 1600, Math.sin(a) * r);
      q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      const s = 6 + Math.pow(Math.random(), 3) * 90;
      sc.set(s, s * (0.5 + Math.random() * 0.5), s * (0.6 + Math.random() * 0.6));
      m.compose(p, q, sc); rocks.setMatrixAt(i, m);
    }
    this.group.add(rocks);

    this.sun = new THREE.DirectionalLight(new THREE.Color(b.sun), 2.6);
    this.sun.position.copy(this.sunDir).multiplyScalar(5000);
    this.group.add(this.sun);
    this.group.add(new THREE.HemisphereLight(0x3a4a6a, 0x0a0608, 0.55));
    const fill = new THREE.DirectionalLight(0x5070c0, 0.9);
    fill.position.copy(this.sunDir).multiplyScalar(-5000).setY(1500);
    this.group.add(fill);
    this.group.add(new THREE.AmbientLight(0x202838, 0.35));

    // tactical grid
    this.gridMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uOpacity: { value: 0.15 }, uCam: { value: new THREE.Vector3() } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uOpacity; uniform vec3 uCam; varying vec3 vW;
        float line(float v, float s){ float f = abs(fract(v / s - 0.5) - 0.5) * s; float w = fwidth(v) * 1.2; return 1.0 - smoothstep(0.0, w, f); }
        void main(){
          float g = max(line(vW.x, 250.0), line(vW.z, 250.0)) * 0.25 + max(line(vW.x, 1000.0), line(vW.z, 1000.0)) * 0.7;
          float r = length(vW.xz);
          float fade = (1.0 - smoothstep(2600.0, 4200.0, r));
          float ring = (1.0 - smoothstep(0.0, 12.0, abs(r - 3600.0)));
          vec3 c = vec3(0.25, 0.6, 0.9) * g * fade + vec3(0.9, 0.3, 0.2) * ring * 0.6;
          gl_FragColor = vec4(c * uOpacity, 1.0);
        }`,
      extensions: { derivatives: true } as any,
    });
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 1, 1), this.gridMat);
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.position.y = -120;
    this.grid.renderOrder = -5;
    this.group.add(this.grid);
  }

  setGridOpacity(o: number) { this.gridMat.uniforms.uOpacity.value = o; }

  update(camera: THREE.Camera) {
    // planet lighting in view space
    const v = this.sunDir.clone().transformDirection(camera.matrixWorldInverse);
    this.planetMat.uniforms.uSunDirV.value.copy(v);
    this.gridMat.uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
  }
}
