import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GameClient } from '../net';
import type { WShip, V, Station } from '../../world/types';
import { SHIP_CLASSES, getLoadout } from '../../sim/data/ships';
import { buildShip, type ShipModel } from '../../render/shipMesh';
import { Environment } from '../../render/environment';
import { CameraRig } from '../../render/camera';
import { ParticleSystem, TrailBatch, Shockwaves } from '../../render/effects';
import { buildStation, buildPlayerStation, syncPlayerStation, buildLair, buildField, updateField, type StationView, type FieldView } from './meshes';
import { rockPos, modulePos, sysAt } from '../../world/geom';
import { ECON } from '../../world/data';
import { SystemScene } from './system';
import type { StarSystem } from '../../world/types';

interface ShipView { model: ShipModel; pos: THREE.Vector3; raw: THREE.Vector3; heading: number; roll: number; key: string; cls: string; seen: number; speed: number; warp: number; sys: string; jumpT: number }

export type Pick = { kind: 'ship' | 'station' | 'field' | 'lair' | 'battle' | 'gate' | 'planet'; id: string; pos: THREE.Vector3 };

const lerpAngle = (a: number, b: number, t: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; };

export class StrategicView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  private composer: EffectComposer;
  readonly env: Environment;
  readonly glow = new ParticleSystem(14000, 'glow');
  readonly smoke = new ParticleSystem(5000, 'smoke');
  readonly trails = new TrailBatch(5000);
  readonly rings = new Shockwaves();
  ships = new Map<string, ShipView>();
  stations = new Map<string, StationView>();
  fields = new Map<string, FieldView>();
  lairs = new Map<string, { obj: THREE.Group; alive: boolean }>();
  private battleFx = new Map<string, { t: number }>();
  private time = 0;
  active = true;
  /** everything in world (global) coordinates hangs off this, offset by -origin of the viewed system */
  readonly world = new THREE.Group();
  sys: StarSystem | null = null;
  private sysScene: SystemScene | null = null;
  showSecurity = false;
  private secFade = 0;
  /** frame timing for diagnostics */
  frameMs: number[] = [];
  onSystemChange: ((id: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, private client: GameClient) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig = new CameraRig(w / h);
    this.rig.maxDist = 150000; this.rig.minDist = 150; this.rig.minPitch = 0.25;
    this.rig.dist = 5200; this.rig.pitch = 0.9; this.rig.yaw = 0.5;
    this.rig.camera.near = 5; this.rig.camera.far = 600000; this.rig.camera.updateProjectionMatrix();
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    this.env = new Environment({ planet: '#b86a3e', nebula: ['#33204f', '#123850'], sun: '#ffe2b8' });
    this.env.strategic();
    this.scene.add(this.env.group, this.world);
    this.world.add(this.glow.mesh, this.smoke.mesh, this.trails.mesh, this.rings.group);
    for (const m of [this.glow.mesh, this.smoke.mesh, this.trails.mesh]) m.frustumCulled = false;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.8, 0.5, 0.82));
    this.composer.addPass(new OutputPass());
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    this.rig.camera.aspect = w / h; this.rig.camera.updateProjectionMatrix();
  }

  dispose() { this.renderer.dispose(); this.renderer.forceContextLoss(); }

  /** jump the camera to a world position, switching the viewed system if needed */
  focusOn(p: V, dist?: number) {
    const s = this.client.state ? sysAt(this.client.state.systems, p) : undefined;
    if (s && s.id !== this.sys?.id) this.setSystem(s.id, false);
    const o = this.origin;
    this.rig.focus.set(p.x - o.x, p.y - o.y, p.z - o.z); if (dist) this.rig.dist = dist;
  }

  get origin(): V { return this.sys?.origin ?? { x: 0, y: 0, z: 0 }; }
  /** is a world position inside the viewed system? */
  inView(p: V): boolean { return !!this.sys && Math.abs(p.x - this.sys.origin.x) < 125000; }

  setSystem(id: string, frame = true) {
    const st = this.client.state; if (!st?.systems[id]) return;
    if (this.sys?.id === id && this.sysScene) return;
    const sys = st.systems[id];
    if (this.sysScene) { this.world.remove(this.sysScene.group); this.sysScene.dispose(); }
    this.sys = sys;
    this.sysScene = new SystemScene(sys);
    this.sysScene.setLanes(st.stations);
    this.sysScene.updateSecurity(st);
    this.world.add(this.sysScene.group);
    this.world.position.set(-sys.origin.x, -sys.origin.y, -sys.origin.z);
    this.env.setNebula(sys.nebula[0], sys.nebula[1]);
    this.client.setView(id);
    // hide the other systems' static objects
    for (const v of this.stations.values()) v.root.visible = this.inView(v.station.pos);
    for (const v of this.fields.values()) v.group.visible = this.inView(v.field.pos);
    for (const [lid, v] of this.lairs) v.obj.visible = this.inView(st.lairs[lid]?.pos ?? { x: 1e9, y: 0, z: 0 });
    // a fresh view: no stale particles from the last system
    if (frame) { this.rig.focus.set(0, 0, 0); this.rig.dist = sys.radius * 1.15; this.rig.pitch = 0.95; }
    this.onSystemChange?.(id);
  }

  // ---------------------------------------------------------------- sync

  private syncStatic() {
    const st = this.client.state!;
    for (const s of Object.values(st.stations)) {
      let v = this.stations.get(s.id);
      if (!v) { v = s.public ? buildStation(s) : buildPlayerStation(s); this.world.add(v.root); this.stations.set(s.id, v); v.root.visible = this.inView(s.pos); }
      v.station = s;
      if (!s.public) syncPlayerStation(v, s);
    }
    for (const [id, v] of this.fields) if (!st.fields[id]) { this.world.remove(v.group); this.fields.delete(id); }
    for (const f of Object.values(st.fields)) {
      let v = this.fields.get(f.id);
      if (!v) { v = buildField(f); this.world.add(v.group); this.fields.set(f.id, v); v.group.visible = this.inView(f.pos); }
      v.field = f;
      updateField(v, f);
    }
    for (const l of Object.values(st.lairs)) {
      let v = this.lairs.get(l.id);
      if (!v) { v = { obj: buildLair(l), alive: l.alive }; this.world.add(v.obj); this.lairs.set(l.id, v); v.obj.visible = this.inView(l.pos); }
      if (v.alive && !l.alive) {
        // lair destroyed: big blast, then it smoulders darkly
        this.blast(new THREE.Vector3(l.pos.x, l.pos.y, l.pos.z), 3);
        v.obj.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as any).isMeshBasicMaterial) m.visible = false; });
      } else if (!v.alive && l.alive) v.obj.traverse(o => { o.visible = true; });
      v.alive = l.alive;
      v.obj.visible = this.inView(l.pos);
    }
    this.sysScene?.updateSecurity(st);
  }

  blast(p: THREE.Vector3, s: number) {
    this.glow.emit(p, { life: 0.6, size: 120 * s, size1: 300 * s, color: 0xfff0d0, alpha: 1.4 });
    for (let i = 0; i < 40 * s; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.glow.emit(p, { life: 1 + Math.random() * 1.5, size: 30 * s, size1: 70 * s, color: 0xffa040, color1: 0x401000, vel: d.multiplyScalar(60 * s), drag: 1 });
      this.smoke.emit(p, { life: 6, size: 30 * s, size1: 120 * s, color: 0x262220, alpha: 0.5, vel: d.multiplyScalar(0.4), drag: 0.3 });
    }
    this.rings.spawn(p, 600 * s, 2, 0xffb070);
  }

  /** where to draw a ship this frame: time-buffered server motion (interp.ts) */
  private shipPos(s: WShip, out: THREE.Vector3): number {
    const tr = s.state === 'space' ? this.client.tracks.get(s.id) : undefined;
    if (tr && tr.samples.length) { tr.at(this.client.clock.renderTime, this.tmpP); out.set(this.tmpP.x, this.tmpP.y, this.tmpP.z); return this.tmpP.h; }
    out.set(s.pos.x, s.pos.y, s.pos.z);
    return s.heading;
  }
  private tmpP = { x: 0, y: 0, z: 0, h: 0 };

  // ---------------------------------------------------------------- frame

  frame(realDt: number) {
    const st = this.client.state;
    if (!st || !this.active) return;
    const f0 = performance.now();
    this.time += realDt;
    this.client.frame(realDt);
    if (!this.sys) { const co = st.companies[this.client.company]; const home = co && st.stations[co.homeStation]; const s0 = home ? sysAt(st.systems, home.pos) : Object.values(st.systems)[0]; if (s0) this.setSystem(s0.id, false); }
    if (Math.floor(this.time * 2) !== Math.floor((this.time - realDt) * 2)) this.syncStatic();
    if (!this.stations.size) this.syncStatic();
    const simDt = realDt * this.client.speed;
    // ships
    const seen = new Set<string>();
    for (const s of Object.values(st.ships)) {
      seen.add(s.id);
      let v = this.ships.get(s.id);
      const key = `${s.classId}:${s.loadoutId}`;
      if (!v || v.key !== key) {
        if (v) this.scene.remove(v.model.root);
        const model = buildShip(SHIP_CLASSES[s.classId], getLoadout(s.classId, s.loadoutId), s.owner === 'pirates' ? 1 : 0);
        this.world.add(model.root);
        model.root.rotation.order = 'YXZ';
        v = { model, pos: new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z), raw: new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z), heading: s.heading, roll: 0, key, cls: s.classId, seen: 0, speed: 0, warp: 0, sys: '', jumpT: s.jumpT ?? 0 };
        this.ships.set(s.id, v);
      }
      const tgtHead = this.shipPos(s, v.raw);
      // light smoothing on top of interpolation; teleports (gate jumps, docking) snap
      const gap = v.pos.distanceTo(v.raw);
      if (gap > 2500 || s.state !== 'space') {
        if (gap > 2500 && s.state === 'space' && v.model.root.visible && (s.jumpT ?? 0) !== v.jumpT) { this.gateFlash(v.pos.clone()); this.gateFlash(v.raw.clone()); }
        v.pos.copy(v.raw);
      } else v.pos.lerp(v.raw, 1 - Math.exp(-realDt * 18));
      v.jumpT = s.jumpT ?? 0;
      const tr = this.client.tracks.get(s.id);
      v.warp = tr?.samples.length ? tr.samples[tr.samples.length - 1].warp : 0;
      const vis = s.state !== 'battle' && this.inView(v.pos);
      v.model.root.visible = vis;
      if (!vis) continue;
      const dh = lerpAngle(v.heading, tgtHead, Math.min(1, realDt * 3)) - v.heading;
      v.heading += dh;
      v.roll += (THREE.MathUtils.clamp(-dh / Math.max(realDt, 1e-3) * 0.8, -0.5, 0.5) - v.roll) * Math.min(1, realDt * 2);
      v.model.root.position.copy(v.pos);
      v.model.root.rotation.set(0, v.heading, 0);
      v.model.bank.rotation.z = v.roll;
      v.speed = Math.hypot(s.vel.x, s.vel.z);
      const thr = s.state === 'docked' ? 0.05 : v.warp === 1 ? 0.6 + 0.4 * Math.sin(this.time * 20) : Math.min(1, v.speed / Math.max(30, ECON[s.classId].cruise));
      if (v.warp === 2) {
        // warp streak: a long blue-white tail along the direction of travel
        const back = new THREE.Vector3(-Math.sin(v.heading), 0, -Math.cos(v.heading));
        const L = SHIP_CLASSES[s.classId].length;
        const tail = v.pos.clone().addScaledVector(back, Math.min(2200, 120 + v.speed * 0.18));
        this.trails.seg(v.pos.x, v.pos.y, v.pos.z, tail.x, tail.y, tail.z, L * 0.18, 0.5, 1.2, 2.2, 3.4, 0.9, 0);
        if (Math.random() < 0.3) this.glow.emit(v.pos, { life: 0.25, size: L * 0.6, size1: L * 0.2, color: 0xa0d8ff, alpha: 0.8 });
      }
      for (const e of v.model.engines) { e.plume.scale.z = e.base * (1 + thr * 12) * (0.9 + Math.random() * 0.2); e.glow.scale.setScalar(e.base * (0.6 + thr * 0.6)); }
      const blink = Math.sin(this.time * 3 + s.id.length) > 0.6 ? 1 : 0.2;
      for (const l of v.model.lights) l.scale.setScalar(blink);
      if (s.hp < 0.5 && Math.random() < (0.5 - s.hp) * 8 * realDt) {
        const wp = v.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 10, 4, (Math.random() - 0.5) * 20));
        this.glow.emit(wp, { life: 0.5, size: 4, size1: 9, color: 0xff8030, color1: 0x401000, alpha: 0.8 });
        this.smoke.emit(wp, { life: 3, size: 5, size1: 18, color: 0x1e1c1c, alpha: 0.35, drag: 0.3 });
      }
      // engine dust trail when cruising (adds sense of motion at map scale)
      if (v.speed > 20 && v.warp !== 2 && Math.random() < 0.4) this.glow.emit(v.pos.clone().addScaledVector(new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading)), -SHIP_CLASSES[s.classId].length * 0.7), { life: 1.2, size: SHIP_CLASSES[s.classId].length * 0.15, size1: 0.5, color: s.owner === 'pirates' ? 0xff6030 : 0x60b8ff, alpha: 0.35 });
    }
    for (const [id, v] of this.ships) if (!seen.has(id)) {
      // a ship disappearing outside battle cleanup = destroyed or sold: brief flash if it was in space
      if (v.model.root.visible && st.engagements && Object.values(st.engagements).some(e => e.done && Math.hypot(e.pos.x - v.pos.x, e.pos.z - v.pos.z) < 2000)) this.blast(v.pos.clone(), 0.25);
      this.scene.remove(v.model.root); this.ships.delete(id);
    }

    this.trails.begin(cam(this));
    // the trail batch orients ribbons toward the camera in its own (world-root) space
    (this.trails as any).camPos.add(new THREE.Vector3(this.origin.x, this.origin.y, this.origin.z));
    // activity effects
    for (const s of Object.values(st.ships)) {
      if (!s.fx || s.state === 'battle') continue;
      const v = this.ships.get(s.id)!;
      if (!v.model.root.visible) continue;
      const fwd = new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading));
      if (s.fx.mining) {
        const f = st.fields[s.fx.mining];
        if (f) {
          const r = rockPos(f, s.fx.rock ?? 0);
          const from = v.pos.clone().addScaledVector(fwd, SHIP_CLASSES[s.classId].length * 0.5 + 8);
          const to = new THREE.Vector3(r.x, r.y, r.z).lerp(from, Math.min(0.9, r.size / Math.max(1, from.distanceTo(new THREE.Vector3(r.x, r.y, r.z)))));
          const pulse = 0.7 + 0.3 * Math.sin(this.time * 18 + s.id.length);
          const c = f.res === 'crystal' ? [0.8, 2.2, 3] : f.salvage ? [3, 1.6, 0.6] : [3, 1.4, 0.5];
          this.trails.seg(from.x, from.y, from.z, to.x, to.y, to.z, 1.4 * pulse, 2.4 * pulse, c[0], c[1], c[2], 0.9, 1);
          if (Math.random() < 14 * realDt) this.glow.emit(to, { life: 0.4, size: 3, size1: 0.5, color: 0xffd090, vel: new THREE.Vector3((Math.random() - 0.5) * 40, (Math.random()) * 30, (Math.random() - 0.5) * 40), drag: 2 });
          if (Math.random() < 3 * realDt) this.glow.emit(to, { life: 1.6, size: 1.6, size1: 1.2, color: f.res === 'crystal' ? 0x80e0ff : 0xe0a060, vel: from.clone().sub(to).multiplyScalar(0.55), alpha: 1 });
          if (Math.random() < 1.5 * realDt) this.smoke.emit(to, { life: 3, size: 6, size1: 20, color: 0x5a4a40, alpha: 0.25, drag: 0.5 });
        }
      }
      if (s.fx.transfer) {
        const d = this.ships.get(s.fx.transfer);
        if (d) {
          const w = 0.6 + 0.3 * Math.sin(this.time * 9);
          this.trails.seg(d.pos.x, d.pos.y + 4, d.pos.z, v.pos.x, v.pos.y - 2, v.pos.z, w * 3, w * 3, 0.4, 1.4, 2.4, 0.5, 0.5);
          if (Math.random() < 10 * realDt) this.glow.emit(d.pos, { life: 0.9, size: 1.5, size1: 1, color: 0xe0a060, vel: v.pos.clone().sub(d.pos).multiplyScalar(1.1) });
        }
      }
      if (s.fx.welding) {
        const [sid, slot] = s.fx.welding.split(':');
        const sta = st.stations[sid];
        if (sta) {
          const mp = modulePos(sta, Number(slot));
          const target = new THREE.Vector3(mp.x + (Math.random() - 0.5) * 60, mp.y + (Math.random() - 0.3) * 50, mp.z + (Math.random() - 0.5) * 60);
          if (Math.random() < 0.5) this.trails.seg(v.pos.x, v.pos.y + 10, v.pos.z, target.x, target.y, target.z, 0.6, 0.6, 1.2, 2.4, 3, 0.7, 0.7);
          if (Math.random() < 20 * realDt) {
            this.glow.emit(target, { life: 0.12, size: 6, size1: 10, color: 0xc0f0ff, alpha: 1.5 });
            for (let i = 0; i < 3; i++) this.glow.emit(target, { life: 0.6, size: 1.6, size1: 0.3, color: 0xffe0a0, color1: 0xff6000, vel: new THREE.Vector3((Math.random() - 0.5) * 60, Math.random() * 40, (Math.random() - 0.5) * 60), drag: 1.5 });
          }
        }
      }
    }
    // stations: rotating rings, docking guide lights
    for (const v of this.stations.values()) for (const r of v.spin) r.rotation.y += realDt * 0.05;
    // battles in progress: a churning cloud of tracers and flashes
    for (const e of Object.values(st.engagements)) {
      if (e.done || !this.inView(e.pos)) continue;
      const c = new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z);
      for (let i = 0; i < 3; i++) {
        const a1 = new THREE.Vector3((Math.random() - 0.5) * 900, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 900).add(c);
        const a2 = new THREE.Vector3((Math.random() - 0.5) * 900, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 900).add(c);
        if (Math.random() < 0.5) this.trails.seg(a1.x, a1.y, a1.z, a1.x + (a2.x - a1.x) * 0.15, a1.y + (a2.y - a1.y) * 0.15, a1.z + (a2.z - a1.z) * 0.15, 0.3, 2, 3, 1.8, 0.8, 0, 1);
      }
      if (Math.random() < 6 * realDt) {
        const p = new THREE.Vector3((Math.random() - 0.5) * 800, (Math.random() - 0.5) * 100, (Math.random() - 0.5) * 800).add(c);
        this.glow.emit(p, { life: 0.4, size: 30, size1: 70, color: 0xffb060, color1: 0x401000, alpha: 1.2 });
        this.smoke.emit(p, { life: 4, size: 20, size1: 60, color: 0x2a2624, alpha: 0.35, drag: 0.3 });
      }
      if (!this.battleFx.has(e.id)) { this.battleFx.set(e.id, { t: this.time }); this.rings.spawn(c, 900, 1.5, 0xff6040, new THREE.Vector3(0, 1, 0)); }
    }
    this.trails.end();
    this.glow.update(Math.max(simDt, realDt * 0.3));
    this.smoke.update(Math.max(simDt, realDt * 0.3));
    this.rings.update(realDt);
    this.rig.update(simDt, realDt);
    this.env.group.position.copy(this.rig.camera.position);
    this.env.update(this.rig.camera);
    if (this.sysScene) {
      this.sysScene.update(realDt, this.time);
      // the security map only exists while the player has it switched on (never auto-shown by zoom)
      const want = this.showSecurity ? 1 : 0;
      this.secFade += (want - this.secFade) * Math.min(1, realDt * 8);
      if (!this.showSecurity && this.secFade < 0.02) this.secFade = 0;
      this.sysScene.setSecurityOpacity(this.secFade);
    }
    this.composer.render();
    this.frameMs.push(performance.now() - f0);
    if (this.frameMs.length > 120) this.frameMs.shift();
  }

  gateFlash(p: THREE.Vector3) {
    this.glow.emit(p, { life: 0.5, size: 80, size1: 260, color: 0x80d0ff, alpha: 1.6 });
    for (let i = 0; i < 16; i++) { const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(); this.glow.emit(p, { life: 0.8, size: 12, size1: 2, color: 0xc0f0ff, vel: d.multiplyScalar(220), drag: 1.5 }); }
    this.rings.spawn(p, 500, 0.8, 0x60c0ff);
  }

  // ---------------------------------------------------------------- picking

  project(p: { x: number; y: number; z: number }, out: THREE.Vector3): boolean {
    if (!this.inView(p)) return false;
    const o = this.origin;
    out.set(p.x - o.x, p.y - o.y, p.z - o.z).project(this.rig.camera);
    const vis = out.z < 1 && out.z > -1;
    out.x = (out.x * 0.5 + 0.5) * innerWidth; out.y = (-out.y * 0.5 + 0.5) * innerHeight;
    return vis;
  }

  pick(x: number, y: number): Pick | null {
    const st = this.client.state; if (!st) return null;
    const o = new THREE.Vector3();
    let best: Pick | null = null, bd = 30;
    const test = (kind: Pick['kind'], id: string, p: V, r: number, pxMin: number) => {
      if (!this.project(p, o)) return;
      const d = Math.hypot(o.x - x, o.y - y);
      const og = this.origin;
      const dist = this.rig.camera.position.distanceTo(new THREE.Vector3(p.x - og.x, p.y - og.y, p.z - og.z));
      const radPx = Math.max(pxMin, r / dist * innerHeight * 1.1);
      if (d < radPx && d - radPx * 0.5 < bd) { bd = d - radPx * 0.5; best = { kind, id, pos: new THREE.Vector3(p.x, p.y, p.z) }; }
    };
    for (const s of Object.values(st.ships)) if (s.state !== 'battle') { const v = this.ships.get(s.id); if (v) test('ship', s.id, v.pos, SHIP_CLASSES[s.classId].length * 0.6, 12); }
    for (const e of Object.values(st.engagements)) if (!e.done) test('battle', e.id, e.pos, 700, 26);
    for (const s of Object.values(st.stations)) test('station', s.id, s.pos, s.radius, 22);
    for (const l of Object.values(st.lairs)) test('lair', l.id, l.pos, 200, 22);
    for (const f of Object.values(st.fields)) test('field', f.id, f.pos, f.radius * 0.8, 26);
    for (const g of this.sys?.gates ?? []) test('gate', g.id, g.pos, 300, 22);
    for (const pl of this.sys?.planets ?? []) if (!best) test('planet', pl.id, pl.pos, pl.size, 18);
    return best;
  }

  screenToPlane(x: number, y: number, h = 0): THREE.Vector3 | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1), this.rig.camera);
    const o = this.origin;
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(h - o.y)), new THREE.Vector3());
    return hit ? hit.add(new THREE.Vector3(o.x, o.y, o.z)) : null;
  }

  stationOf(id: string): Station | undefined { return this.client.state?.stations[id]; }
}

function cam(v: StrategicView) { return v.rig.camera; }
