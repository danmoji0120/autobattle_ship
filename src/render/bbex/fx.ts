// BB-EX — everything the battle renderer draws for it: funnels, wings and halo, the PARADOX wards,
// the DCP-Ω lattice and its mirror facets, the rift it arrives through, BLACKOUT, GRAVITY WELL,
// PHANTOM SHIFT, causality marks and the GAME OVER protocol.
//
// It draws only what the simulation says: funnel positions come from `Ship.ex`, beams and facets from
// the `exDcpFire` event (the same segments that deal the damage), wards from `exParadox` events. No
// gameplay is decided here. Created by BattleView only when a battle contains a BB-EX.
import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { World } from '../../sim/world';
import type { Ship, SimEvent } from '../../sim/types';
import type { ExEvent } from '../../sim/bbex/state';
import { BBEX, BBEX_WEAPON } from '../../sim/bbex/data';
import { wingLocal } from '../../sim/bbex/system';
import { Vec3 } from '../../sim/math';
import type { ParticleSystem, TrailBatch, Shockwaves, FlashLights } from '../effects';
import type { CameraRig } from '../camera';
import { BBEX_COLORS, funnelGeometry } from './hull';
import { BeamBatch, QuadBatch, PARADOX_FS, FACET_FS, HALO_FS, RIFT_FS, WELL_FS, DARK_FS, SIGIL_FS, wingMaterial, shieldMaterial, waveMaterial, DistortShader, MAX_LENS } from './materials';

export interface FxHost {
  scene: THREE.Scene;
  rig: CameraRig;
  glow: ParticleSystem; smoke: ParticleSystem; trails: TrailBatch; rings: Shockwaves; flashes: FlashLights;
  composer: EffectComposer; bloom: UnrealBloomPass;
  audio: { play(name: string, pos: THREE.Vector3 | null, vol?: number, rate?: number): void } | null;
  /** world transform of a ship as drawn this frame */
  shipPose(id: number): { pos: THREE.Vector3; fwd: THREE.Vector3; root: THREE.Object3D; ship: Ship } | null;
  beam(a: THREE.Vector3, b: THREE.Vector3, life: number, w: number, color: number): void;
  burst(p: THREE.Vector3, n: number, c0: number, c1: number, size: number, speed: number, bias?: THREE.Vector3): void;
  shake(p: THREE.Vector3, amount: number, range?: number): void;
}

// palette (linear multipliers > 1 bloom)
const VIOLET = 0xb46bff, DEEP = 0x5a1fd0, PINK = 0xff8be8, MAGENTA = 0xff4fd8, WHITE = 0xf6e8ff, LILAC = 0xd9b8ff;
const C3 = (hex: number, k = 1): [number, number, number] => [((hex >> 16) & 255) / 255 * k, ((hex >> 8) & 255) / 255 * k, (hex & 255) / 255 * k];
const V = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y, v.z);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const rdir = (out: THREE.Vector3) => out.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
const UPV = new THREE.Vector3(0, 1, 0), ZV = new THREE.Vector3(0, 0, 1);
const ease = (t: number) => t * t * (3 - 2 * t);

interface Panel { pos: THREE.Vector3; q: THREE.Quaternion; size: number; age: number; life: number; seed: number; mode: number; heavy: number }
interface Facet { pos: THREE.Vector3; n: THREE.Vector3; q: THREE.Quaternion; funnel: number; open: number; delay: number; flash: number; split: number; seed: number; size: number; live: boolean; fade: number; hitAt: number; struck: boolean }
interface Seg { a: THREE.Vector3; b: THREE.Vector3; gen: number; w: number; len: number; seed: number }
interface Lattice { segs: Seg[]; t: number; dur: number; over: boolean; ended: number }
interface Shot { a: THREE.Vector3; b: THREE.Vector3; life: number; max: number; w: number; col: [number, number, number]; core: number }
interface Scar { ship: number; a: THREE.Vector3; b: THREE.Vector3; life: number; max: number; w: number }
interface Rift { pos: THREE.Vector3; t: number; dur: number; seed: number; collapse: number; size: number; closing: boolean }
interface Well { pos: THREE.Vector3; t: number; dur: number; radius: number; seed: number }
interface Sigil { pos: THREE.Vector3; ship: number; size: number; t: number; life: number; seed: number; flat: boolean }
interface Later { at: number; run: () => void }

class ShipFx {
  readonly funBody: THREE.InstancedMesh; readonly funDark: THREE.InstancedMesh; readonly funGlow: THREE.InstancedMesh;
  readonly wing: THREE.Mesh; readonly wingPos: THREE.BufferAttribute;
  readonly shield: THREE.Mesh;
  readonly trail: THREE.Vector3[][] = []; readonly fpos: THREE.Vector3[] = []; readonly fseen: boolean[] = [];
  trailAcc = 0;
  charge = 0; chargeDur = 1; charging = false; chargeOver = false;
  emerge = 1; level = 0; over = 0; overT = 0; overDur = 1; haloSpin = 0; spread = 0; veto = 0;
  muzzle = new THREE.Vector3();
  constructor(readonly ship: Ship, scene: THREE.Scene, geo: ReturnType<typeof funnelGeometry>, mats: { body: THREE.Material; dark: THREE.Material; glow: THREE.Material }) {
    const n = BBEX.funnels;
    this.funBody = new THREE.InstancedMesh(geo.body, mats.body, n); this.funDark = new THREE.InstancedMesh(geo.dark, mats.dark, n); this.funGlow = new THREE.InstancedMesh(geo.glow, mats.glow, n);
    for (const m of [this.funBody, this.funDark, this.funGlow]) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
    for (let i = 0; i < n; i++) { this.trail.push([]); this.fpos.push(new THREE.Vector3()); this.fseen.push(false); }
    // wing membranes: four patches (upper/lower × port/starboard) in one geometry
    const g = new THREE.BufferGeometry();
    const verts = (UP_COLS + LO_COLS) * 2 * ROWS;
    this.wingPos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const wuv = new Float32Array(verts * 2); const idx: number[] = [];
    let base = 0;
    for (const cols of [UP_COLS, UP_COLS, LO_COLS, LO_COLS]) {
      for (let c = 0; c < cols; c++) for (let r = 0; r < ROWS; r++) { const k = base + c * ROWS + r; wuv[k * 2] = c / (cols - 1); wuv[k * 2 + 1] = r / (ROWS - 1); }
      for (let c = 0; c < cols - 1; c++) for (let r = 0; r < ROWS - 1; r++) { const a = base + c * ROWS + r, b = a + ROWS; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      base += cols * ROWS;
    }
    g.setAttribute('position', this.wingPos); g.setAttribute('wuv', new THREE.BufferAttribute(wuv, 2)); g.setIndex(idx);
    this.wing = new THREE.Mesh(g, wingMaterial()); this.wing.frustumCulled = false; this.wing.renderOrder = 5; this.wing.visible = false; scene.add(this.wing);
    this.shield = new THREE.Mesh(SHIELD_GEO, shieldMaterial()); this.shield.frustumCulled = false; this.shield.renderOrder = 5; scene.add(this.shield);
  }
  dispose(scene: THREE.Scene) { for (const m of [this.funBody, this.funDark, this.funGlow, this.wing, this.shield]) scene.remove(m); this.wing.geometry.dispose(); (this.wing.material as THREE.Material).dispose(); (this.shield.material as THREE.Material).dispose(); }
}
const UP_COLS = 26, LO_COLS = 14, ROWS = 5;
const SHIELD_GEO = new THREE.SphereGeometry(1, 36, 22);
const WAVE_GEO = new THREE.SphereGeometry(1, 48, 28);

export class BbexFx {
  private ships = new Map<number, ShipFx>();
  private beams = new BeamBatch(460);
  private paradox = new QuadBatch(200, PARADOX_FS, 6);
  private facetQ = new QuadBatch(72, FACET_FS, 5);
  private haloQ = new QuadBatch(16, HALO_FS, 4);
  private riftQ = new QuadBatch(10, RIFT_FS, 7);
  private wellQ = new QuadBatch(8, WELL_FS, 4);
  private darkQ = new QuadBatch(10, DARK_FS, 3, THREE.NormalBlending);
  private sigilQ = new QuadBatch(64, SIGIL_FS, 4);
  private waves: { mesh: THREE.Mesh; t: number; dur: number; radius: number; pos: THREE.Vector3 }[] = [];
  private panels: Panel[] = []; private facets: Facet[] = []; private lattices: Lattice[] = []; private shots: Shot[] = []; private scars: Scar[] = [];
  private rifts: Rift[] = []; private wells: Well[] = []; private sigils: Sigil[] = []; private later: Later[] = [];
  private lastCut = new Map<number, { t: number; dir: THREE.Vector3; pos: THREE.Vector3 }>();
  private pass: ShaderPass; private lensN = 0;
  private flash = new THREE.Vector4(0, 0, 0, 0); private bloom0: number;
  private t = 0; private wall = 0;
  private funMats: { body: THREE.Material; dark: THREE.Material; glow: THREE.Material };
  private funGeo = funnelGeometry();
  private tmp = new THREE.Vector3(); private tmp2 = new THREE.Vector3(); private tmp3 = new THREE.Vector3(); private q = new THREE.Quaternion(); private m4 = new THREE.Matrix4(); private sv = new Vec3();
  private bx = new THREE.Vector3(); private by = new THREE.Vector3(); private bz = new THREE.Vector3(); private sc = new THREE.Vector3();
  private paradoxSfx = 0;

  constructor(private host: FxHost, private world: World) {
    const B = BBEX_COLORS;
    this.funMats = {
      body: new THREE.MeshStandardMaterial({ color: B.hull, roughness: 0.3, metalness: 0.7, emissive: 0x3a2070, emissiveIntensity: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: B.dark, roughness: 0.5, metalness: 0.8 }),
      glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(B.accent).multiplyScalar(2.6) }),
    };
    for (const s of world.exShips) this.ships.set(s.id, new ShipFx(s, host.scene, this.funGeo, this.funMats));
    for (const b of [this.paradox, this.facetQ, this.haloQ, this.riftQ, this.wellQ, this.darkQ, this.sigilQ]) host.scene.add(b.mesh);
    host.scene.add(this.beams.mesh);
    for (let i = 0; i < 3; i++) { const mesh = new THREE.Mesh(WAVE_GEO, waveMaterial()); mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 4; host.scene.add(mesh); this.waves.push({ mesh, t: 1, dur: 1, radius: 1, pos: new THREE.Vector3() }); }
    // distortion pass sits between the scene render and the bloom, and is skipped when no lens is active
    this.pass = new ShaderPass(DistortShader);
    this.pass.enabled = false;
    host.composer.insertPass(this.pass, 1);
    this.pass.uniforms.uFlash.value = this.flash;
    this.bloom0 = host.bloom.strength;
  }

  dispose() {
    for (const s of this.ships.values()) s.dispose(this.host.scene);
    for (const b of [this.paradox, this.facetQ, this.haloQ, this.riftQ, this.wellQ, this.darkQ, this.sigilQ]) { this.host.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mat.dispose(); }
    this.host.scene.remove(this.beams.mesh);
    for (const w of this.waves) this.host.scene.remove(w.mesh);
  }

  /** is the hull drawn at all (false while it is still on the other side of the rift) */
  visible(shipId: number): boolean { const s = this.ships.get(shipId); return !s || s.ship.state !== 'inbound'; }
  /** scale of the hull model while it emerges */
  emergeScale(shipId: number): number { const s = this.ships.get(shipId); return s ? 0.35 + 0.65 * ease(Math.min(1, s.emerge)) : 1; }

  private sfx(name: string, pos: THREE.Vector3 | null, vol = 1, rate = 1) { this.host.audio?.play(name, pos, vol, rate); }
  private after(dt: number, run: () => void) { this.later.push({ at: this.t + dt, run }); }
  private screenFlash(hex: number, a: number) { const c = C3(hex); if (a > this.flash.w) this.flash.set(c[0], c[1], c[2], a); }
  private director() { return this.host.rig.mode === 'director'; }

  // ─────────────────────────────────────────────────────────────────────── weapon fire / hits

  /** muzzle effects of the exclusive weapons (true = handled) */
  onFire(ship: Ship, weapon: string, pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    const h = this.host;
    switch (weapon) {
      case BBEX_WEAPON.lance: {
        const mp = pos.clone().addScaledVector(dir, 9);
        h.glow.emit(mp, { life: 0.28, size: 26, size1: 5, color: WHITE, color1: DEEP, alpha: 1.5 });
        h.glow.emit(mp, { life: 0.5, size: 12, size1: 44, color: DEEP, alpha: 0.7 });
        for (let i = 0; i < 9; i++) h.glow.emit(mp, { life: rnd(0.25, 0.5), size: rnd(2.5, 5), size1: 0.6, color: 0xbfe6ff, color1: VIOLET, vel: this.tmp.copy(dir).multiplyScalar(rnd(140, 420)).add(rdir(this.tmp2).multiplyScalar(40)).clone(), drag: 3 });
        h.rings.spawn(mp, 34, 0.35, VIOLET, dir);
        h.flashes.flash(mp, 70, 320, 0.22, VIOLET);
        this.sfx('ex_lance', mp, 0.95, rnd(0.92, 1.08));
        h.shake(mp, 0.5);
        return true;
      }
      case BBEX_WEAPON.edge: {
        const mp = pos.clone().addScaledVector(dir, 3);
        h.glow.emit(mp, { life: 0.09, size: 7, size1: 2, color: LILAC, alpha: 1.3 });
        if (Math.random() < 0.3) this.sfx('ex_edge', mp, 0.4, rnd(0.9, 1.2));
        return true;
      }
      case BBEX_WEAPON.stinger: {
        if (Math.random() < 0.5) h.glow.emit(pos, { life: 0.06, size: 3.5, size1: 1.5, color: PINK, alpha: 1.1 });
        if (Math.random() < 0.12) this.sfx('ex_stinger', pos, 0.3, rnd(0.9, 1.3));
        return true;
      }
      case BBEX_WEAPON.seraph: {
        h.glow.emit(pos, { life: 0.35, size: 9, size1: 2, color: WHITE, color1: VIOLET, alpha: 1.3 });
        h.rings.spawn(pos, 14, 0.4, VIOLET, UPV);
        for (let i = 0; i < 3; i++) h.glow.emit(pos, { life: rnd(0.5, 0.9), size: 3, size1: 9, color: VIOLET, color1: DEEP, alpha: 0.5, vel: new THREE.Vector3(rnd(-12, 12), rnd(14, 30), rnd(-12, 12)), drag: 1.5 });
        if (Math.random() < 0.6) this.sfx('ex_seraph', pos, 0.55, rnd(0.9, 1.15));
        return true;
      }
    }
    return false;
  }

  /** hits by the exclusive weapons and hits on BB-EX. true = the ordinary hit effect is not drawn. */
  onHit(e: Extract<SimEvent, { t: 'hit' }>): boolean {
    const h = this.host;
    if (e.result === 'paradox') return true;                      // the ward (exParadox) is the whole effect
    const p = V(e.pos), dir = V(e.dir);
    switch (e.weapon) {
      case BBEX_WEAPON.dcp: {
        // one cut pulse on a hull: a glowing line seared along the beam, sparks thrown off the far side
        const prev = this.lastCut.get(e.target);
        if (prev && this.t - prev.t < 0.085) { prev.dir.copy(dir); prev.pos.copy(p); return true; }
        this.lastCut.set(e.target, { t: this.t, dir: dir.clone(), pos: p.clone() });
        h.glow.emit(p, { life: 0.2, size: 15, size1: 4, color: WHITE, color1: VIOLET, alpha: 1.5 });
        for (let i = 0; i < 4; i++) h.glow.emit(p, { life: rnd(0.3, 0.7), size: rnd(1.5, 3.2), size1: 0.4, color: WHITE, color1: MAGENTA, vel: this.tmp.copy(dir).multiplyScalar(rnd(60, 260)).add(rdir(this.tmp2).multiplyScalar(70)).clone(), drag: 1.6 });
        this.scar(e.target, p, dir, 2.6, 1.3);
        if (Math.random() < 0.25) h.flashes.flash(p, 60, 260, 0.2, VIOLET);
        if (Math.random() < 0.35) this.sfx('ex_cut', p, 0.5, rnd(0.85, 1.2));
        return true;
      }
      case BBEX_WEAPON.lance: {
        if (e.result !== 'pen') return false;
        // the lance goes in: a white-violet stab, then bursts walking along its path inside the hull
        h.glow.emit(p, { life: 0.22, size: 28, size1: 8, color: WHITE, color1: VIOLET, alpha: 1.6 });
        h.rings.spawn(p, 46, 0.4, VIOLET, dir.clone().multiplyScalar(-1));
        h.flashes.flash(p, 90, 300, 0.25, VIOLET);
        const pose = h.shipPose(e.target);
        const step = pose ? Math.min(14, pose.ship.radius * 1.3) : 8;
        for (let k = 1; k <= 3; k++) this.after(k * 0.07, () => {
          const q = p.clone().addScaledVector(dir, step * k);
          h.glow.emit(q, { life: 0.3, size: 13, size1: 22, color: 0xe6d0ff, color1: DEEP, alpha: 1.1 });
          h.burst(q, 5, WHITE, MAGENTA, 2.6, 110, dir);
        });
        this.scar(e.target, p, dir, 3.2, 0.8);
        return false;                                                  // plus the ordinary breach (smoke, burning hole)
      }
      case BBEX_WEAPON.edge: {
        if (e.result === 'ricochet') return false;
        h.glow.emit(p, { life: 0.12, size: 6.5, size1: 2, color: LILAC, alpha: 1.3 });
        if (Math.random() < 0.5) h.burst(p, 2, WHITE, VIOLET, 1.8, 70, this.tmp.copy(dir).multiplyScalar(-1));
        // the slice stays on the armour for a moment, skewed off the firing line so slices cross
        this.scar(e.target, p, this.tmp.copy(dir).applyAxisAngle(UPV, rnd(-1.2, 1.2)).normalize(), 1.4, 0.55);
        return true;
      }
      case BBEX_WEAPON.stinger: {
        if (Math.random() < 0.6) h.glow.emit(p, { life: 0.1, size: 3.4, size1: 1, color: PINK, alpha: 1.2 });
        return true;
      }
      case BBEX_WEAPON.funnel: {
        h.glow.emit(p, { life: 0.16, size: 9, size1: 3, color: WHITE, color1: VIOLET, alpha: 1.3 });
        h.burst(p, 3, LILAC, DEEP, 2, 80, this.tmp.copy(dir).multiplyScalar(-1));
        if (e.dmg > 0) this.scar(e.target, p, dir, 1.1, 0.5);
        return true;
      }
      case BBEX_WEAPON.rain: h.glow.emit(p, { life: 0.1, size: 3, size1: 1, color: LILAC, alpha: 1 }); return true;
      case BBEX_WEAPON.seraph: {
        if (e.result === 'ricochet') return false;
        h.glow.emit(p, { life: 0.3, size: 20, size1: 34, color: WHITE, color1: VIOLET, alpha: 1.3 });
        h.rings.spawn(p, 60, 0.6, VIOLET);
        h.burst(p, 7, PINK, DEEP, 3, 120);
        return false;
      }
    }
    return false;
  }

  /** a glowing cut left on a hull for a moment (ship-local, so it rides with the hull) */
  private scar(shipId: number, p: THREE.Vector3, dir: THREE.Vector3, life: number, w: number) {
    const pose = this.host.shipPose(shipId);
    if (!pose) return;
    let n = 0; for (const s of this.scars) if (s.ship === shipId) n++;
    if (n >= 7 || this.scars.length > 260) return;
    const r = pose.ship.radius * 1.15 + 1.5;
    pose.root.updateMatrixWorld();
    const a = pose.root.worldToLocal(p.clone().addScaledVector(dir, -r)), b = pose.root.worldToLocal(p.clone().addScaledVector(dir, r));
    this.scars.push({ ship: shipId, a, b, life, max: life, w });
  }

  /** a hull that died to the DCP-Ω: it is not blown apart, it is severed */
  onDestroyed(shipId: number, pos: THREE.Vector3): void {
    const s = this.world.shipById.get(shipId);
    if (!s || s.lastWeapon !== BBEX_WEAPON.dcp) return;
    const cut = this.lastCut.get(shipId);
    const h = this.host;
    const dir = cut ? cut.dir.clone() : rdir(new THREE.Vector3());
    const L = s.cls.length;
    h.beam(pos.clone().addScaledVector(dir, -L * 2.2), pos.clone().addScaledVector(dir, L * 2.2), 0.7, Math.max(1.4, L * 0.05), WHITE);
    h.rings.spawn(pos, L * 3.4 + 50, 1.1, VIOLET, dir);
    h.rings.spawn(pos, L * 2.2 + 30, 0.8, MAGENTA, this.tmp.crossVectors(dir, UPV).normalize().clone());
    h.glow.emit(pos, { life: 0.9, size: L * 1.6 + 20, size1: L * 3.6 + 40, color: VIOLET, color1: DEEP, alpha: 1.1 });
    // a sheet of light along the cut plane
    const side = this.tmp.crossVectors(dir, UPV).normalize().clone();
    for (let i = 0; i < 26; i++) {
      const v = dir.clone().multiplyScalar(rnd(-1, 1) * 160).addScaledVector(UPV, rnd(-1, 1) * 110).addScaledVector(side, rnd(-10, 10));
      h.glow.emit(pos, { life: rnd(0.5, 1.3), size: rnd(2, 5), size1: 0.5, color: WHITE, color1: MAGENTA, vel: v, drag: 1.2 });
    }
    h.flashes.flash(pos, 240, 900, 0.7, VIOLET);
    this.lastCut.delete(shipId);
  }

  // ─────────────────────────────────────────────────────────────────────── events

  handle(e: ExEvent) {
    const h = this.host;
    switch (e.t) {
      case 'exRift': {
        const pos = V(e.pos);
        this.rifts.push({ pos, t: 0, dur: Math.max(0.5, e.dur), seed: Math.random() * 10, collapse: 0, size: 150, closing: false });
        this.sigils.push({ pos: pos.clone(), ship: -1, size: 170, t: 0, life: e.dur + 2.2, seed: Math.random() * 9, flat: true });
        this.sfx('ex_rift', pos, 1.2);
        if (this.director()) h.rig.offer({ kind: 'vista', subject: () => ({ pos, fwd: ZV, length: 60, alive: true }), at: () => this.tmp.set(pos.x + 190, pos.y + 70, pos.z - 300).clone(), look: () => pos, duration: e.dur + 1.2, priority: 13 });
        break;
      }
      case 'exDescent': {
        const pos = V(e.pos), sf = this.ships.get(e.ship);
        if (sf) { sf.emerge = 0; for (let i = 0; i < sf.fseen.length; i++) { sf.fseen[i] = false; sf.trail[i].length = 0; } }
        for (const r of this.rifts) if (r.pos.distanceToSquared(pos) < 400 * 400) r.closing = true;
        h.glow.emit(pos, { life: 0.7, size: 60, size1: 420, color: WHITE, color1: VIOLET, alpha: 1.6 });
        h.glow.emit(pos, { life: 1.6, size: 120, size1: 260, color: VIOLET, color1: DEEP, alpha: 0.9 });
        h.rings.spawn(pos, 520, 1.5, VIOLET, UPV); h.rings.spawn(pos, 340, 1.1, WHITE, new THREE.Vector3(0.3, 0.2, 0.93).normalize()); h.rings.spawn(pos, 420, 1.9, MAGENTA, new THREE.Vector3(0.9, 0.3, 0.2).normalize());
        for (let i = 0; i < 150; i++) { const d = rdir(new THREE.Vector3()); h.glow.emit(pos, { life: rnd(0.8, 2.2), size: rnd(2, 6), size1: 0.5, color: i % 3 ? LILAC : WHITE, color1: DEEP, vel: d.multiplyScalar(rnd(80, 520)), drag: 0.9 }); }
        h.flashes.flash(pos, 520, 2200, 1.3, VIOLET);
        this.screenFlash(VIOLET, 0.42);
        h.shake(pos, 2.6, 3200);
        this.sfx('ex_descent', pos, 1.4);
        if (this.director()) h.rig.offer({ kind: 'orbit', subject: () => { const p = h.shipPose(e.ship); return p ? { pos: p.pos, fwd: p.fwd, length: 86, alive: true } : null; }, duration: e.dur + 1.5, priority: 14 });
        break;
      }
      case 'exFunnel': {
        const pos = V(e.pos);
        if (e.e === 'launch') {
          h.glow.emit(pos, { life: 0.3, size: 9, size1: 2, color: WHITE, color1: VIOLET, alpha: 1.3 });
          this.sfx('ex_funnel', pos, 0.6, 0.9 + (e.i % 6) * 0.06);
        } else if (e.e === 'lost') {
          h.glow.emit(pos, { life: 0.35, size: 18, size1: 30, color: WHITE, color1: VIOLET, alpha: 1.3 });
          h.burst(pos, 14, LILAC, DEEP, 3, 150);
          h.rings.spawn(pos, 40, 0.5, VIOLET);
          this.sfx('intercept', pos, 0.6, 1.3);
        } else {
          for (let i = 0; i < 10; i++) h.glow.emit(pos, { life: rnd(0.4, 0.8), size: 3, size1: 0.5, color: LILAC, color1: DEEP, vel: rdir(new THREE.Vector3()).multiplyScalar(40), drag: 2 });
          this.sfx('ex_funnel', pos, 0.4, 1.4);
        }
        const sf = this.ships.get(e.ship); if (sf) { sf.fseen[e.i] = false; sf.trail[e.i].length = 0; }
        break;
      }
      case 'exForm': if (e.form === 'wing') { const p = h.shipPose(e.ship); if (p) this.sfx('ex_wing', p.pos, 0.9); } break;
      case 'exBeam': {
        const a = V(e.from), b = V(e.to);
        this.shots.push({ a, b, life: 0.16, max: 0.16, w: 1.25, col: C3(LILAC, 2.2), core: 1 });
        h.glow.emit(a, { life: 0.1, size: 6, size1: 2, color: WHITE, alpha: 1.2 });
        if (Math.random() < 0.4) this.sfx('ex_fbeam', a, 0.42, rnd(0.9, 1.25));
        break;
      }
      case 'exSwat': {
        this.shots.push({ a: V(e.from), b: V(e.to), life: 0.07, max: 0.07, w: 0.5, col: C3(PINK, 2), core: 0.6 });
        break;
      }
      case 'exParadox': this.ward(e); break;
      case 'exOverload': {
        const p = h.shipPose(e.ship); if (!p) break;
        const sf = this.ships.get(e.ship);
        if (e.on) {
          // the whole ward shatters outward
          for (let i = 0; i < 16; i++) {
            const d = rdir(new THREE.Vector3());
            this.panels.push({ pos: p.pos.clone().addScaledVector(d, rnd(9, 18)), q: QuadBatch.look(d, new THREE.Quaternion()), size: rnd(9, 18), age: 0, life: rnd(0.5, 0.9), seed: Math.random() * 9, mode: 1, heavy: 1 });
          }
          h.rings.spawn(p.pos, 120, 0.8, MAGENTA); h.flashes.flash(p.pos, 200, 700, 0.5, MAGENTA);
          h.burst(p.pos, 40, PINK, DEEP, 4, 220);
          this.screenFlash(MAGENTA, 0.16);
          this.sfx('ex_overload', p.pos, 1.1);
        } else {
          if (sf) sf.level = 1.6;
          h.rings.spawn(p.pos, 70, 0.7, VIOLET);
          this.sfx('ex_restore', p.pos, 0.8);
        }
        break;
      }
      case 'exDcpCharge': this.dcpCharge(e); break;
      case 'exDcpFire': this.dcpFire(e); break;
      case 'exDcpEnd': {
        for (const l of this.lattices) if (l.ended < 0) l.ended = 0;
        for (const f of this.facets) f.live = false;
        const sf = this.ships.get(e.ship); if (sf) sf.charging = false;
        break;
      }
      case 'exBlackout': {
        const pos = V(e.pos);
        const w = this.waves.find(x => x.t >= x.dur) ?? this.waves[0];
        w.pos.copy(pos); w.t = 0; w.dur = 1.7; w.radius = e.radius; w.mesh.visible = true;
        h.flashes.flash(pos, 160, 900, 0.5, DEEP);
        this.sfx('ex_blackout', pos, 1.0);
        // interference crackles over each jammed hull as the front passes it
        let n = 0;
        for (const s of this.world.ships) {
          if (s.jamUntil === undefined || s.state !== 'alive' || n++ > 90) continue;
          const d = Math.hypot(s.pos.x - pos.x, s.pos.y - pos.y, s.pos.z - pos.z);
          if (d > e.radius) continue;
          const id = s.id;
          this.after(d / e.radius * 1.5, () => {
            const pp = h.shipPose(id); if (!pp) return;
            for (let k = 0; k < 3; k++) { const a = pp.pos.clone().add(rdir(this.tmp).multiplyScalar(pp.ship.radius * 1.6)); h.beam(a, a.clone().add(rdir(this.tmp).multiplyScalar(rnd(8, 22))), 0.14, 0.35, k ? VIOLET : WHITE); }
            h.glow.emit(pp.pos, { life: 0.25, size: pp.ship.radius * 3, size1: pp.ship.radius, color: DEEP, alpha: 0.7 });
          });
        }
        break;
      }
      case 'exWell': {
        const pos = V(e.pos);
        this.wells.push({ pos, t: 0, dur: e.dur, radius: e.radius, seed: Math.random() * 9 });
        h.rings.spawn(pos, e.radius * 1.6, 1.2, DEEP, UPV);
        h.flashes.flash(pos, 120, 900, 0.8, DEEP);
        this.sfx('ex_well', pos, 1.1);
        break;
      }
      case 'exShift': {
        const a = V(e.from), b = V(e.to);
        // where it was: an afterimage that folds into a crack; where it is: a flash and a ring
        this.rifts.push({ pos: a.clone(), t: 0.2, dur: 0.2, seed: Math.random() * 9, collapse: 0, size: 70, closing: true });
        this.rifts.push({ pos: b.clone(), t: 0.2, dur: 0.2, seed: Math.random() * 9, collapse: 0, size: 80, closing: true });
        h.beam(a, b, 0.45, 1.6, VIOLET);
        for (let i = 0; i < 40; i++) { const d = rdir(new THREE.Vector3()); const p0 = a.clone().addScaledVector(d, rnd(20, 60)); h.glow.emit(p0, { life: rnd(0.25, 0.5), size: rnd(2, 4), size1: 0.4, color: LILAC, color1: DEEP, vel: d.multiplyScalar(-rnd(80, 160)), drag: 0.5 }); }
        h.glow.emit(a, { life: 0.5, size: 50, size1: 6, color: DEEP, alpha: 0.9 });
        h.glow.emit(b, { life: 0.4, size: 20, size1: 90, color: WHITE, color1: VIOLET, alpha: 1.4 });
        h.rings.spawn(b, 150, 0.7, VIOLET); h.rings.spawn(a, 90, 0.5, DEEP);
        h.flashes.flash(b, 220, 800, 0.4, VIOLET);
        this.sfx('ex_shift', b, 1.0);
        const sf = this.ships.get(e.ship); if (sf) for (let i = 0; i < sf.fseen.length; i++) { sf.fseen[i] = false; sf.trail[i].length = 0; }
        break;
      }
      case 'exCausal': {
        const pos = V(e.pos);
        if (e.what === 'veto') {
          const sf = this.ships.get(e.ship); if (sf) sf.veto = 1;
          this.screenFlash(WHITE, 0.75);
          this.sigils.push({ pos: pos.clone(), ship: e.ship, size: 150, t: 0, life: 1.8, seed: Math.random() * 9, flat: false });
          // the explosion that was about to happen runs backwards into the hull
          for (let i = 0; i < 90; i++) { const d = rdir(new THREE.Vector3()); const p0 = pos.clone().addScaledVector(d, rnd(60, 190)); h.glow.emit(p0, { life: rnd(0.4, 0.8), size: rnd(3, 7), size1: 0.6, color: i % 2 ? WHITE : PINK, color1: VIOLET, vel: d.multiplyScalar(-rnd(160, 300)), drag: 0.2 }); }
          h.rings.spawn(pos, 260, 0.9, WHITE); h.flashes.flash(pos, 400, 1400, 0.8, WHITE);
          h.shake(pos, 1.8, 2400);
          this.sfx('ex_causal', pos, 1.3);
        } else {
          this.sigils.push({ pos: pos.clone(), ship: -1, size: 16, t: 0, life: 0.5, seed: Math.random() * 9, flat: false });
        }
        break;
      }
      case 'exGameOver': {
        const sf = this.ships.get(e.ship); const p = h.shipPose(e.ship);
        if (!sf || !p) break;
        if (e.on) {
          sf.overT = 0; sf.overDur = e.dur; sf.over = 0.001;
          this.screenFlash(VIOLET, 0.3);
          h.rings.spawn(p.pos, 600, 1.6, VIOLET, p.fwd.clone()); h.rings.spawn(p.pos, 380, 1.2, WHITE, UPV);
          h.shake(p.pos, 1.6, 3000);
          this.sfx('ex_gameover', p.pos, 1.5);
          if (this.director()) h.rig.offer({ kind: 'orbit', subject: () => { const q = h.shipPose(e.ship); return q ? { pos: q.pos, fwd: q.fwd, length: 110, alive: true } : null; }, duration: BBEX.goSpread + BBEX.goCharge, priority: 15 });
        } else {
          sf.overT = sf.overDur + 10;
          // the light that swallows the field, then quiet
          this.screenFlash(VIOLET, 0.85);
          h.glow.emit(p.pos, { life: 1.4, size: 200, size1: 900, color: VIOLET, color1: DEEP, alpha: 1.0 });
          h.rings.spawn(p.pos, 1400, 2.4, VIOLET, UPV);
          if (this.director()) h.rig.offer({ kind: 'wide', subject: () => { const q = h.shipPose(e.ship); return q ? { pos: q.pos, fwd: q.fwd, length: 200, alive: true } : null; }, duration: 7, priority: 9 });
        }
        break;
      }
      case 'exPierce': {
        const p = V(e.pos), d = V(e.dir);
        h.glow.emit(p, { life: 0.2, size: 16, size1: 5, color: 0xcfe8ff, color1: VIOLET, alpha: 1.4 });
        h.burst(p, 8, WHITE, MAGENTA, 3, 240, d);
        h.rings.spawn(p, 30, 0.3, 0xbfdcff, d);
        break;
      }
      case 'exPhase': {
        const a = V(e.from), b = V(e.to);
        h.glow.emit(a, { life: 0.2, size: 10, size1: 1, color: VIOLET, color1: DEEP, alpha: 1.1 });
        h.glow.emit(b, { life: 0.25, size: 2, size1: 16, color: WHITE, color1: VIOLET, alpha: 1.2 });
        h.beam(a, b, 0.22, 0.45, DEEP);
        for (let i = 0; i < 3; i++) { const q0 = b.clone().add(rdir(this.tmp).multiplyScalar(4)); h.beam(q0, q0.clone().add(rdir(this.tmp).multiplyScalar(rnd(6, 14))), 0.16, 0.3, WHITE); }
        break;
      }
      case 'exRegen': break;
    }
  }

  /** PARADOX: a hexagonal ward flares where the shot was displaced, and the shot's line bends away */
  private ward(e: Extract<ExEvent, { t: 'exParadox' }>) {
    const h = this.host;
    const p = V(e.pos), dir = V(e.dir);
    const pose = h.shipPose(e.ship);
    // the ward stands a little off the hull, facing the shot
    const n = dir.clone().multiplyScalar(-1);
    if (pose) { const out = this.tmp.subVectors(p, pose.pos); if (out.lengthSq() > 1) n.addScaledVector(out.normalize(), 0.8).normalize(); }
    const size = Math.min(26, 8 + Math.sqrt(e.dmg) * 0.75) * (e.heavy ? 1.25 : 1);
    if (this.panels.length >= 190) this.panels.shift();
    this.panels.push({ pos: p.clone().addScaledVector(n, 1.5), q: QuadBatch.look(n, new THREE.Quaternion()), size, age: 0, life: e.heavy ? 0.75 : 0.5, seed: Math.random() * 9, mode: e.mode === 'absorb' ? 1 : 0, heavy: e.heavy ? 1 : 0 });
    const sf = this.ships.get(e.ship); if (sf) sf.level = Math.min(2.2, sf.level + (e.heavy ? 0.5 : 0.16));
    if (e.mode === 'displace') {
      // the round leaves along a bent line: it was moved, not stopped
      const bend = this.tmp2.copy(dir).addScaledVector(n, 0.9).add(rdir(this.tmp3).multiplyScalar(0.35)).normalize();
      h.beam(p, p.clone().addScaledVector(bend, e.heavy ? 150 : 60), e.heavy ? 0.3 : 0.16, e.heavy ? 1.1 : 0.4, e.heavy ? LILAC : VIOLET);
      if (e.heavy) { h.rings.spawn(p, size * 2.6, 0.45, VIOLET, n); h.flashes.flash(p, 70, 260, 0.2, VIOLET); }
    } else {
      h.rings.spawn(p, size * 2.2, 0.4, MAGENTA, n);
      h.burst(p, e.heavy ? 8 : 3, PINK, DEEP, 2.4, 90, n);
      if (e.heavy) h.flashes.flash(p, 90, 300, 0.25, MAGENTA);
    }
    if (this.wall - this.paradoxSfx > (e.heavy ? 0.05 : 0.11)) { this.paradoxSfx = this.wall; this.sfx(e.heavy ? 'ex_paradox_heavy' : 'ex_paradox', p, e.heavy ? 0.7 : 0.35, rnd(0.85, 1.25)); }
  }

  private dcpCharge(e: Extract<ExEvent, { t: 'exDcpCharge' }>) {
    const h = this.host, sf = this.ships.get(e.ship), pose = h.shipPose(e.ship);
    if (!sf || !pose) return;
    sf.charging = true; sf.charge = 0; sf.chargeDur = e.dur; sf.chargeOver = e.over;
    // the mirrors unfold, one after another, each held by its funnel (or projected by the wing)
    for (const f of this.facets) f.live = false;
    e.nodes.forEach((nd, i) => {
      const n = V(nd.pos).sub(pose.pos).normalize().multiplyScalar(-1);
      this.facets.push({ pos: V(nd.pos), n, q: QuadBatch.look(n, new THREE.Quaternion()), funnel: e.over ? -1 : nd.funnel, open: 0, delay: 0.25 + i * (e.over ? 0.05 : 0.14), flash: 0, split: 1, seed: Math.random() * 9, size: e.over ? 96 : i === 0 ? 86 : 66, live: true, fade: 1, hitAt: -1, struck: false });
    });
    // dimension lock: a seal under every hull the lattice will touch
    let k = 0;
    for (const id of e.locked) {
      if (k++ >= 44) break;
      const s = this.world.shipById.get(id); if (!s) continue;
      this.sigils.push({ pos: new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z), ship: id, size: s.halfLen * 1.5 + 12, t: 0, life: e.dur + (e.over ? BBEX.goFire : BBEX.dcpFire) + 0.4, seed: Math.random() * 9, flat: true });
    }
    this.sfx('dcp_charge', pose.pos, 1.2, e.over ? 0.8 : 1);
    if (this.director() && !e.over) h.rig.offer({ kind: 'low', subject: () => { const q = h.shipPose(e.ship); return q ? { pos: q.pos, fwd: q.fwd, length: 54, alive: true } : null; }, duration: e.dur - 0.5, priority: 11 });
  }

  private dcpFire(e: Extract<ExEvent, { t: 'exDcpFire' }>) {
    const h = this.host, sf = this.ships.get(e.ship), pose = h.shipPose(e.ship);
    // an earlier lattice of the same shot (GAME OVER re-forms it) starts fading; the new one takes over
    for (const l of this.lattices) if (l.ended < 0) l.ended = 0;
    const segs: Seg[] = e.segs.map(s => { const a = V(s.a), b = V(s.b); return { a, b, gen: s.gen, w: s.w, len: a.distanceTo(b), seed: Math.random() * 9 }; });
    this.lattices.push({ segs, t: 0, dur: e.dur, over: e.over, ended: -1 });
    // facets: now exactly where the beam turns, with the true mirror normal
    const old = this.facets.filter(f => f.live);
    for (const f of old) f.live = false;
    e.nodes.forEach((nd, i) => {
      const prev = old.find(f => !e.over && f.funnel === nd.funnel);
      const n = V(nd.n);
      const gen = segs.find(s => s.b.distanceToSquared(V(nd.pos)) < 4)?.gen ?? 0;
      this.facets.push({ pos: V(nd.pos), n, q: QuadBatch.look(n, new THREE.Quaternion()), funnel: -1, open: prev ? prev.open : e.seq > 0 ? 0.6 : 0, delay: 0, flash: 0, split: nd.split, seed: prev?.seed ?? Math.random() * 9, size: prev?.size ?? (e.over ? 96 : i === 0 ? 86 : 66), live: true, fade: 1, hitAt: (gen + 1) * GEN_DELAY, struck: false });
    });
    if (sf) { sf.charging = false; sf.charge = 1; }
    if (pose && sf) {
      const mz = sf.muzzle.clone();
      const d0 = segs.length ? segs[0].b.clone().sub(segs[0].a).normalize() : pose.fwd.clone();
      h.glow.emit(mz, { life: 0.5, size: 90, size1: 30, color: WHITE, color1: VIOLET, alpha: 1.8 });
      h.glow.emit(mz, { life: 1.0, size: 60, size1: 190, color: VIOLET, color1: DEEP, alpha: 0.9 });
      h.rings.spawn(mz, 190, 0.7, WHITE, d0); h.rings.spawn(mz.clone().addScaledVector(d0, 40), 120, 0.5, VIOLET, d0);
      for (let i = 0; i < 46; i++) h.glow.emit(mz, { life: rnd(0.4, 1.0), size: rnd(2.5, 6), size1: 0.5, color: WHITE, color1: MAGENTA, vel: d0.clone().multiplyScalar(rnd(200, 900)).add(rdir(this.tmp).multiplyScalar(120)), drag: 1.3 });
      h.flashes.flash(mz, 520, 2000, 0.9, VIOLET);
      h.shake(mz, e.over ? 3 : 2.2, 3600);
      this.screenFlash(VIOLET, e.over ? 0.3 : 0.2);
      this.sfx('dcp_fire', mz, 1.6, e.over ? 0.85 : 1);
    }
    if (this.director() && segs.length && (e.seq === 0 || e.seq === 2)) {
      // a vantage that takes in the whole lattice: above and behind the emitter, looking at its middle
      const c = new THREE.Vector3(); let ext = 0;
      for (const s of segs) c.add(s.a).add(s.b);
      c.multiplyScalar(1 / (segs.length * 2));
      for (const s of segs) ext = Math.max(ext, s.a.distanceTo(c), s.b.distanceTo(c));
      const from = segs[0].a.clone();
      const back = from.clone().sub(c); back.y = 0; if (back.lengthSq() < 1) back.set(0, 0, -1); back.normalize();
      const side = new THREE.Vector3().crossVectors(back, UPV).multiplyScalar(e.seq ? -0.55 : 0.55);
      const at = c.clone().addScaledVector(back, ext * 0.95 + 260).addScaledVector(side, ext * 0.9).add(new THREE.Vector3(0, ext * 0.55 + 160, 0));
      h.rig.offer({ kind: 'vista', subject: () => ({ pos: c, fwd: ZV, length: 200, alive: true }), at: () => at, look: () => c, duration: e.over ? 2.6 : e.dur + 2.6, priority: 16, slowmo: e.over ? 0.6 : 0.45 });
    }
  }

  // ─────────────────────────────────────────────────────────────────────── frame

  /** called every rendered frame, between trails.begin() and trails.end() */
  frame(alpha: number, simDt: number, realDt: number) {
    const h = this.host, cam = h.rig.camera;
    const dt = simDt > 0 ? simDt : 0;
    this.t += dt; this.wall += realDt;
    const T = this.wall;
    for (let i = this.later.length - 1; i >= 0; i--) if (this.later[i].at <= this.t) { const l = this.later[i]; this.later.splice(i, 1); l.run(); }
    this.beams.begin(cam, T);
    for (const b of [this.paradox, this.facetQ, this.haloQ, this.riftQ, this.wellQ, this.darkQ, this.sigilQ]) b.begin(T);
    this.lensN = 0;
    const lens = this.pass.uniforms.uLens.value as THREE.Vector4[];
    for (const l of lens) l.set(0, 0, 0, 0);
    let bloomAdd = 0;

    for (const sf of this.ships.values()) bloomAdd = Math.max(bloomAdd, this.frameShip(sf, alpha, dt, realDt, T));
    this.frameLattice(dt, T);
    this.frameFacets(dt, alpha);
    this.framePanels(dt);
    this.frameShots(dt);
    this.frameScars(dt);
    this.frameRifts(dt, T);
    this.frameWells(dt, T);
    this.frameSigils(dt, T);
    this.frameWaves(dt, T);

    this.beams.end();
    for (const b of [this.paradox, this.facetQ, this.haloQ, this.riftQ, this.wellQ, this.darkQ, this.sigilQ]) b.end();
    // screen flash decays in real time; the pass only runs while something needs it
    this.flash.w = Math.max(0, this.flash.w - realDt * (this.flash.w > 0.4 ? 0.9 : 0.6));
    this.pass.uniforms.uAspect.value = cam.aspect; this.pass.uniforms.uTime.value = T;
    this.pass.enabled = this.lensN > 0 || this.flash.w > 0.003;
    h.bloom.strength += (this.bloom0 + bloomAdd - h.bloom.strength) * Math.min(1, realDt * 4);
  }

  private addLens(p: THREE.Vector3, radius: number, strength: number) {
    if (this.lensN >= MAX_LENS) return;
    const cam = this.host.rig.camera;
    const v = this.tmp3.copy(p).project(cam);
    if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.4 || Math.abs(v.y) > 1.4) return;
    const dist = cam.position.distanceTo(p);
    const rs = radius / (dist * Math.tan(cam.fov * Math.PI / 360) * 2);      // world radius → fraction of screen height
    if (rs < 0.004) return;
    (this.pass.uniforms.uLens.value as THREE.Vector4[])[this.lensN++].set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5, Math.min(0.6, rs), strength);
  }

  private frameShip(sf: ShipFx, alpha: number, dt: number, realDt: number, T: number): number {
    const h = this.host, s = sf.ship, ex = s.ex!;
    const pose = h.shipPose(s.id);
    const alive = !!pose && s.state === 'alive';
    const hide = () => { for (const m of [sf.funBody, sf.funDark, sf.funGlow]) m.count = 0; sf.wing.visible = false; sf.shield.visible = false; };
    if (!alive || !pose) { hide(); return 0; }
    for (const m of [sf.funBody, sf.funDark, sf.funGlow]) m.count = BBEX.funnels;
    sf.emerge = Math.min(1, sf.emerge + dt / 1.5);
    const over = ex.over.until > 0;
    sf.over += ((over ? 1 : 0) - sf.over) * Math.min(1, realDt * 2.5);
    sf.spread += (ex.spread - sf.spread) * Math.min(1, realDt * 6);
    sf.level = Math.max(0, sf.level - realDt * 1.6);
    sf.veto = Math.max(0, sf.veto - realDt * 0.7);
    sf.haloSpin += realDt * (0.25 + sf.over * 0.9 + (sf.charging ? 0.5 : 0));
    const root = pose.root;
    root.updateMatrixWorld();
    const toWorld = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(x, y, z).applyMatrix4(root.matrixWorld);
    toWorld(0, 0.4, 23.5, sf.muzzle);

    // ── funnels
    sf.trailAcc += dt;
    const sample = sf.trailAcc > 0.035; if (sample) sf.trailAcc = 0;
    for (const f of ex.funnels) {
      const out = f.alive && f.launchAt < 0;
      const p = sf.fpos[f.i];
      if (!out) { this.sc.set(0, 0, 0); this.m4.compose(pose.pos, this.q.identity(), this.sc); for (const m of [sf.funBody, sf.funDark, sf.funGlow]) m.setMatrixAt(f.i, this.m4); sf.fseen[f.i] = false; sf.trail[f.i].length = 0; continue; }
      p.set(f.prevPos.x + (f.pos.x - f.prevPos.x) * alpha, f.prevPos.y + (f.pos.y - f.prevPos.y) * alpha, f.prevPos.z + (f.pos.z - f.prevPos.z) * alpha);
      // orientation: nose along fwd, kept upright
      this.bz.set(f.fwd.x, f.fwd.y, f.fwd.z); if (this.bz.lengthSq() < 1e-6) this.bz.set(0, 0, 1);
      this.bz.normalize();
      this.bx.crossVectors(UPV, this.bz); if (this.bx.lengthSq() < 1e-4) this.bx.set(1, 0, 0); this.bx.normalize();
      this.by.crossVectors(this.bz, this.bx);
      this.m4.makeBasis(this.bx, this.by, this.bz);
      const k = FUNNEL_SCALE;
      this.m4.scale(this.sc.set(k, k, k)); this.m4.setPosition(p);
      for (const m of [sf.funBody, sf.funDark, sf.funGlow]) m.setMatrixAt(f.i, this.m4);
      // drive light and a short ribbon behind it
      const tail = this.tmp.copy(p).addScaledVector(this.bz, -4.6 * k);
      const sp = Math.hypot(f.vel.x, f.vel.y, f.vel.z);
      if (Math.random() < 0.5 + sp / 400) h.glow.emit(tail, { life: 0.16 + sp / 2600, size: 2.6 + sp / 240, size1: 0.3, color: LILAC, color1: DEEP, alpha: 1.1 });
      const tr = sf.trail[f.i];
      if (!sf.fseen[f.i] || (tr.length && tr[tr.length - 1].distanceToSquared(p) > 500 * 500)) { tr.length = 0; sf.fseen[f.i] = true; }
      if (sample && sp > 30) { tr.push(p.clone()); if (tr.length > 12) tr.shift(); }
      else if (sample && tr.length) tr.shift();
      for (let i = 1; i < tr.length; i++) { const a = tr[i - 1], b = tr[i], t0 = (i - 1) / tr.length, t1 = i / tr.length; h.trails.seg(a.x, a.y, a.z, b.x, b.y, b.z, 0.9 * t0, 0.9 * t1, 1.5, 0.75, 2.4, t0 * 0.5, t1 * 0.5); }
      if (tr.length) { const a = tr[tr.length - 1]; h.trails.seg(a.x, a.y, a.z, p.x, p.y, p.z, 0.9, 0.9, 1.5, 0.75, 2.4, 0.5, 0.5); }
    }
    for (const m of [sf.funBody, sf.funDark, sf.funGlow]) m.instanceMatrix.needsUpdate = true;

    // ── wings and halo
    const sp = sf.spread;
    const wingScale = 1 + 0.32 * sf.over;
    if (sp > 0.03) {
      sf.wing.visible = true;
      const arr = sf.wingPos.array as Float32Array;
      let base = 0;
      for (const [upper, side] of [[true, 1], [true, -1], [false, 1], [false, -1]] as const) {
        const cols = upper ? UP_COLS : LO_COLS;
        const pts = this.wingPts(sf, upper, side, sp, wingScale, toWorld);
        // skeleton ribbon
        for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; h.trails.seg(a.x, a.y, a.z, b.x, b.y, b.z, 0.7, 0.7, 2.2, 1.2, 3.2, 0.55 * sp, 0.55 * sp); }
        for (let c = 0; c < cols; c++) {
          const u = c / (cols - 1);
          const lead = catmull(pts, u, this.tmp);
          // feather direction in ship space: down and back, fanning outward toward the tip
          const fx = side * (upper ? 0.12 + 0.5 * u : 0.3 + 0.2 * u), fy = upper ? -0.86 + 0.34 * u : -0.7, fz = upper ? -0.46 - 0.2 * u : -0.64;
          const fl = (upper ? 34 + 118 * Math.pow(Math.sin(Math.min(1, u * 1.05) * Math.PI * 0.82), 0.8) : 26 + 62 * Math.sin(u * 2.6)) * sp * wingScale * (1 + 0.05 * Math.sin(T * 1.7 + u * 6 + side));
          const tip = toWorld(fx * fl, fy * fl, fz * fl, this.tmp2).sub(toWorld(0, 0, 0, this.tmp3));
          for (let r = 0; r < ROWS; r++) { const v = r / (ROWS - 1), k = (base + c * ROWS + r) * 3; arr[k] = lead.x + tip.x * v; arr[k + 1] = lead.y + tip.y * v; arr[k + 2] = lead.z + tip.z * v; }
        }
        base += cols * ROWS;
      }
      sf.wingPos.needsUpdate = true;
      const wm = (sf.wing.material as THREE.ShaderMaterial).uniforms;
      wm.uTime.value = T; wm.uPower.value = sp * (0.85 + 0.9 * sf.over) * Math.min(1, sf.emerge * 1.4);
    } else sf.wing.visible = false;
    {
      // halo: a standing rune ring behind the hull, a tilted second ring, more of them in GAME OVER
      const power = Math.max(sp, sf.charging ? 0.5 + 0.5 * sf.charge : 0, sf.veto) * Math.min(1, sf.emerge * 1.3);
      if (power > 0.03) {
        const c = toWorld(0, 6, -13, this.tmp);
        const [r, g, b] = C3(VIOLET, 1.9);
        QuadBatch.look(pose.fwd, this.q);
        const R = (88 + 26 * sf.over) * (0.35 + 0.65 * power);
        this.haloQ.add(c, this.q, R, R, sf.haloSpin, 2 + (sf.over > 0.4 ? 1 : 0), 1.3, 1 + sf.over, r, g, b, power * 0.9);
        const n2 = toWorld(0, 0.86, -0.5, this.tmp2).sub(toWorld(0, 0, 0, this.tmp3)).normalize();
        QuadBatch.look(n2, this.q);
        this.haloQ.add(c, this.q, R * 0.62, R * 0.62, -sf.haloSpin * 1.4, 1, 4.1, 0.6, r, g * 0.8, b, power * 0.6);
        if (sf.over > 0.05) {
          const n3 = toWorld(0.62, 0.3, 0.72, this.tmp2).sub(toWorld(0, 0, 0, this.tmp3)).normalize();
          QuadBatch.look(n3, this.q);
          this.haloQ.add(c, this.q, R * 1.5, R * 1.5, sf.haloSpin * 0.6, 3, 7.7, 1.6, 1.9, 0.9, 1.7, sf.over * 0.8);
          QuadBatch.look(UPV, this.q);
          this.haloQ.add(toWorld(0, -4, 0, this.tmp2), this.q, R * 2.3, R * 2.3, -sf.haloSpin * 0.4, 3, 2.2, 1.2, r, g, b, sf.over * 0.5);
        }
      }
    }

    // ── PARADOX standing field
    sf.shield.visible = true;
    sf.shield.position.copy(pose.pos); sf.shield.quaternion.copy(root.quaternion); sf.shield.scale.set(BBEX.pField * 0.9, BBEX.pField * 0.78, 30);
    const su = (sf.shield.material as THREE.ShaderMaterial).uniforms;
    su.uTime.value = T; su.uLevel.value = Math.min(1.6, 0.05 + sf.level * 0.6 + (ex.phase === 'descent' ? 0.5 : 0) + sf.over * 0.5); su.uOver.value = ex.paradox.overload > 0 ? 1 : 0;
    if (ex.paradox.overload > 0) this.addLens(pose.pos, 60, -0.012);

    // ── DCP-Ω charge at the emitter
    let bloomAdd = sf.over * 0.3;
    if (sf.charging) {
      sf.charge = Math.min(1, sf.charge + dt / sf.chargeDur);
      const c = sf.charge, mz = sf.muzzle;
      h.glow.emit(mz, { life: 0.07, size: 7 + 26 * c, size1: 5 + 20 * c, color: WHITE, color1: VIOLET, alpha: 0.9 + c });
      h.glow.emit(mz, { life: 0.1, size: 20 + 60 * c, size1: 16 + 50 * c, color: DEEP, alpha: 0.35 + 0.4 * c });
      const n = Math.floor((1.2 + 5 * c) * (dt > 0 ? 1 : 0) + Math.random());
      for (let i = 0; i < n; i++) { const d = rdir(this.tmp2); const r0 = rnd(28, 70); const p0 = this.tmp.copy(mz).addScaledVector(d, r0); h.glow.emit(p0, { life: 0.34, size: rnd(1.6, 3.6), size1: 0.4, color: i % 2 ? LILAC : PINK, color1: WHITE, vel: d.clone().multiplyScalar(-r0 / 0.34), drag: 0 }); }
      // arcs between the tines
      if (Math.random() < 0.5 + c) { const a = toWorld(rnd(-1.1, 1.1), rnd(-0.4, 1.2), rnd(12, 22), this.tmp), b = toWorld(rnd(-1.1, 1.1), rnd(-0.4, 1.2), rnd(12, 22), this.tmp2); h.trails.seg(a.x, a.y, a.z, b.x, b.y, b.z, 0.25, 0.25, 2.6, 2.0, 3.2, 1, 1); }
      if (Math.random() < 0.06) h.flashes.flash(mz, 60 + 120 * c, 500, 0.2, VIOLET);
      this.addLens(mz, 26 + 60 * c, 0.05 + 0.22 * c);
      bloomAdd = Math.max(bloomAdd, 0.12 * c);
    }
    if (ex.dcp.state === 'fire') bloomAdd = Math.max(bloomAdd, 0.2);
    // ── REGENESIS: violet motes drawn back into the hull while it rebuilds
    if (s.hp < s.maxHp * 0.995 && dt > 0 && Math.random() < 0.35) {
      const p0 = toWorld(rnd(-7, 7), rnd(-3, 5), rnd(-20, 20), this.tmp);
      h.glow.emit(p0, { life: 0.6, size: 2.4, size1: 0.3, color: LILAC, color1: VIOLET, alpha: 0.9, vel: this.tmp2.copy(pose.pos).sub(p0).multiplyScalar(0.9).clone() });
    }
    void realDt;
    return bloomAdd;
  }

  private wpts: THREE.Vector3[] = Array.from({ length: 6 }, () => new THREE.Vector3());
  /** leading edge of one wing: root, then each wing funnel (its real position if it is flying there) */
  private wingPts(sf: ShipFx, upper: boolean, side: number, spread: number, scale: number, toWorld: (x: number, y: number, z: number, out: THREE.Vector3) => THREE.Vector3): THREE.Vector3[] {
    const ex = sf.ship.ex!, out: THREE.Vector3[] = [];
    let n = 0;
    out.push(toWorld(side * (upper ? 5 : 4.4), upper ? 3.2 : -0.6, upper ? -7 : -10, this.wpts[n++]));
    for (const k of upper ? [0, 1, 2, 3] : [4, 5]) {
      const i = k * 2 + (side > 0 ? 0 : 1), f = ex.funnels[i];
      const p = this.wpts[n++];
      if (f.alive && f.launchAt < 0 && f.mode === 'wing') p.copy(sf.fpos[i]);
      else { wingLocal(i, spread, scale, this.world.time, this.sv); toWorld(this.sv.x, this.sv.y, this.sv.z, p); }
      out.push(p);
    }
    return out;
  }

  private frameLattice(dt: number, T: number) {
    const h = this.host;
    let sparks = 0;
    for (let li = this.lattices.length - 1; li >= 0; li--) {
      const L = this.lattices[li];
      L.t += dt;
      if (L.ended >= 0) L.ended += dt;
      const AFTER = 1.7;
      if (L.ended > AFTER) { this.lattices.splice(li, 1); continue; }
      const live = L.ended < 0;
      for (const s of L.segs) {
        const arrive = s.gen * GEN_DELAY;
        const k = (L.t - arrive) / GEN_DELAY;                           // 0 → 1 while the beam crosses this segment
        if (k <= 0) continue;
        const head = k >= 1 ? s.b : this.tmp.copy(s.a).lerp(s.b, k);
        if (live) {
          const flick = 0.86 + 0.14 * Math.sin(T * 61 + s.seed * 7);
          const I = Math.min(1, (L.t - arrive) * 14) * flick;
          const w = s.w;
          const main = s.gen === 0;
          // wide dark-violet mantle, the violet sheath with its white core, and for the main beam a blinding centre
          this.beams.seg(s.a, head, w * 2.9, w * 2.9, 0.42, 0.1, 1.05, 0.5 * I, 0, 5, s.seed, 0, 900);
          this.beams.seg(s.a, head, w * 1.2, w * 1.2, 1.5, 0.62, 2.4, I, main ? 1.4 : 0.9, 9, s.seed + 1, 0, 900);
          if (main || L.over) this.beams.seg(s.a, head, w * 0.42, w * 0.42, 2.4, 2.1, 2.6, I, 2, 14, s.seed + 2, 0, 900);
          // sparks streaming down the beam
          if (dt > 0 && sparks < 46 && Math.random() < Math.min(1, s.len / 1400)) {
            sparks++;
            const p0 = this.tmp2.copy(s.a).lerp(head, Math.random());
            const d = this.tmp3.subVectors(s.b, s.a).normalize();
            h.glow.emit(p0, { life: rnd(0.25, 0.6), size: rnd(2, 4.5) * (main ? 1.4 : 1), size1: 0.4, color: Math.random() < 0.5 ? WHITE : PINK, color1: VIOLET, vel: d.clone().multiplyScalar(rnd(120, 520)).add(rdir(new THREE.Vector3()).multiplyScalar(46)), drag: 1.5 });
          }
        } else {
          // the cut it left: a thin scar of light that lingers
          const f = 1 - L.ended / AFTER;
          this.beams.seg(s.a, s.b, s.w * 0.5 * f + 0.4, s.w * 0.5 * f + 0.4, 1.3, 0.35, 1.7, f * f * 0.9, 0.5 * f, 2, s.seed, 0, 900);
          this.beams.seg(s.a, s.b, s.w * 1.9, s.w * 1.9, 0.3, 0.06, 0.8, f * 0.3, 0, 1.5, s.seed + 1, 0, 900);
          if (dt > 0 && sparks < 20 && Math.random() < 0.12 * f) { sparks++; h.glow.emit(this.tmp2.copy(s.a).lerp(s.b, Math.random()), { life: rnd(0.5, 1.1), size: 2.2, size1: 0.3, color: PINK, color1: DEEP, alpha: 0.9, vel: rdir(new THREE.Vector3()).multiplyScalar(14) }); }
        }
      }
    }
  }

  private frameFacets(dt: number, alpha: number) {
    const h = this.host;
    const lat = this.lattices.find(l => l.ended < 0);
    for (let i = this.facets.length - 1; i >= 0; i--) {
      const f = this.facets[i];
      if (f.delay > 0) { f.delay -= dt; continue; }
      if (f.live) f.open = Math.min(1, f.open + dt * 3.2); else { f.fade -= dt * 1.5; if (f.fade <= 0) { this.facets.splice(i, 1); continue; } }
      // a facet carried by a funnel rides with it until the shot
      if (f.funnel >= 0) {
        for (const sf of this.ships.values()) { const fn = sf.ship.ex!.funnels[f.funnel]; if (fn && fn.alive && fn.mode === 'lock') { f.pos.copy(sf.fpos[f.funnel]); this.tmp.copy(sf.muzzle).sub(f.pos).normalize(); f.n.lerp(this.tmp, Math.min(1, dt * 5)).normalize(); QuadBatch.look(f.n, f.q); } }
      }
      // the beam reaches it: flash, shock ring in the mirror plane, glass cracks where it splits
      if (lat && f.hitAt >= 0 && !f.struck && lat.t >= f.hitAt) {
        f.struck = true; f.flash = 1;
        h.glow.emit(f.pos, { life: 0.4, size: 60, size1: 20, color: WHITE, color1: VIOLET, alpha: 1.7 });
        h.rings.spawn(f.pos, 150 + 40 * f.split, 0.6, f.split > 1 ? WHITE : VIOLET, f.n.clone());
        h.flashes.flash(f.pos, 300, 1300, 0.6, VIOLET);
        const a = this.tmp.crossVectors(f.n, Math.abs(f.n.y) > 0.9 ? ZV : UPV).normalize().clone(), b = this.tmp2.crossVectors(f.n, a).normalize().clone();
        const shards = f.split > 1 ? 30 : 12;
        for (let k = 0; k < shards; k++) { const an = Math.random() * Math.PI * 2; const d = a.clone().multiplyScalar(Math.cos(an)).addScaledVector(b, Math.sin(an)).addScaledVector(f.n, rnd(-0.25, 0.25)); h.glow.emit(f.pos, { life: rnd(0.4, 1.0), size: rnd(2, 5), size1: 0.4, color: WHITE, color1: PINK, vel: d.multiplyScalar(rnd(90, 380)), drag: 1.8 }); }
        if (f.split > 1) for (let k = 0; k < 9; k++) { const an = Math.random() * Math.PI * 2; const d = a.clone().multiplyScalar(Math.cos(an)).addScaledVector(b, Math.sin(an)); const p0 = f.pos.clone().addScaledVector(d, rnd(4, 14)); h.beam(p0, p0.clone().addScaledVector(d, rnd(24, f.size * 0.55)), rnd(0.25, 0.5), 0.5, WHITE); }
        this.sfx(f.split > 1 ? 'dcp_split' : 'dcp_mirror', f.pos, 1.1, rnd(0.9, 1.15));
        h.shake(f.pos, 0.9, 2600);
      }
      f.flash = lat && f.struck ? Math.max(0.55, f.flash - dt * 1.2) : Math.max(0, f.flash - dt * 2.5);
      const [r, g, b] = C3(VIOLET, 1.6);
      const sz = f.size * (0.5 + 0.5 * ease(f.open));
      this.facetQ.add(f.pos, f.q, sz, sz, ease(f.open), f.flash, f.split, f.seed, r, g, b, f.fade * (0.55 + 0.45 * f.open));
      if (f.flash > 0.3) this.addLens(f.pos, f.size * 1.3, -0.006 * f.flash);
    }
    void alpha;
  }

  private framePanels(dt: number) {
    const [r, g, b] = C3(VIOLET, 2.1);
    for (let i = this.panels.length - 1; i >= 0; i--) {
      const p = this.panels[i];
      p.age += dt;
      if (p.age >= p.life) { this.panels.splice(i, 1); continue; }
      this.paradox.add(p.pos, p.q, p.size, p.size, p.age / p.life, p.seed, p.mode, p.heavy, r, g, b, 1);
    }
  }

  private frameShots(dt: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.life -= dt;
      if (s.life <= 0) { this.shots.splice(i, 1); continue; }
      const a = s.life / s.max;
      this.beams.seg(s.a, s.b, s.w * (0.5 + 0.5 * a), s.w * (0.5 + 0.5 * a), s.col[0], s.col[1], s.col[2], a, s.core, 12, i * 0.37, 0, 320);
      this.beams.seg(s.a, s.b, s.w * 2.6, s.w * 2.6, 0.5, 0.15, 1.1, a * 0.5, 0, 6, i * 0.61, 0, 320);
    }
  }

  private frameScars(dt: number) {
    const h = this.host;
    for (let i = this.scars.length - 1; i >= 0; i--) {
      const s = this.scars[i];
      s.life -= dt;
      const pose = s.life > 0 ? h.shipPose(s.ship) : null;
      if (!pose || pose.ship.state === 'dead') { this.scars.splice(i, 1); continue; }
      const a = this.tmp.copy(s.a).applyMatrix4(pose.root.matrixWorld), b = this.tmp2.copy(s.b).applyMatrix4(pose.root.matrixWorld);
      const f = s.life / s.max;
      h.trails.seg(a.x, a.y, a.z, b.x, b.y, b.z, s.w * f, s.w * f, 2.6, 1.5 * f + 0.4, 3.0, f, f);
    }
  }

  private frameRifts(dt: number, T: number) {
    const h = this.host, cam = h.rig.camera;
    for (let i = this.rifts.length - 1; i >= 0; i--) {
      const r = this.rifts[i];
      r.t += dt;
      if (r.closing) { r.collapse += dt / 1.1; if (r.collapse >= 1) { this.rifts.splice(i, 1); continue; } }
      const open = Math.min(1.25, 0.06 + 1.2 * Math.pow(Math.min(1, r.t / r.dur), 1.6));
      // the wound faces the viewer
      this.tmp.copy(cam.position).sub(r.pos).normalize();
      QuadBatch.look(this.tmp, this.q);
      const sz = r.size * (0.5 + 1.1 * open);
      const [cr, cg, cb] = C3(VIOLET, 1.25);
      this.darkQ.add(r.pos, this.q, sz * 0.5 * open, sz * 0.9 * open, 0, 0, 0, 0, 0.01, 0, 0.03, 0.75 * (1 - r.collapse));
      this.riftQ.add(r.pos, this.q, sz, sz * 1.5, open, r.seed, r.collapse, 0, cr, cg, cb, 1);
      // rings of the gate turning around it
      for (let k = 0; k < 3; k++) {
        const an = T * (0.5 + k * 0.23) + k * 2.1;
        this.tmp2.set(Math.sin(an) * 0.5, Math.cos(an * 0.7) * 0.4 + (k === 1 ? 0.6 : 0), Math.cos(an) * 0.5).add(this.tmp.clone().multiplyScalar(0.7)).normalize();
        QuadBatch.look(this.tmp2, this.q);
        const R = sz * (0.9 + k * 0.42);
        this.haloQ.add(r.pos, this.q, R, R, T * (k % 2 ? -0.6 : 0.8), 1 + k, r.seed + k, 0.4, cr, cg * 0.9, cb, 0.5 * Math.min(1, open) * (1 - r.collapse));
      }
      if (dt > 0) for (let k = 0; k < 3; k++) {
        const p0 = this.tmp3.copy(r.pos).add(this.tmp2.set(rnd(-6, 6) * open, rnd(-1, 1) * sz * 0.6 * open, rnd(-6, 6) * open));
        h.glow.emit(p0, { life: rnd(0.4, 1.0), size: rnd(2, 5), size1: 0.4, color: k ? LILAC : WHITE, color1: DEEP, vel: rdir(new THREE.Vector3()).multiplyScalar(rnd(40, 200) * open), drag: 1 });
      }
      if (Math.random() < 0.06) h.flashes.flash(r.pos, 70 * open, 700, 0.3, VIOLET);
      this.addLens(r.pos, sz * 1.2, (0.1 + 0.2 * open) * (1 - r.collapse));
    }
  }

  private frameWells(dt: number, T: number) {
    const h = this.host, cam = h.rig.camera;
    for (let i = this.wells.length - 1; i >= 0; i--) {
      const w = this.wells[i];
      w.t += dt;
      if (w.t >= w.dur) { this.wells.splice(i, 1); continue; }
      const age = w.t / w.dur, env = Math.min(1, w.t * 2) * Math.min(1, (w.dur - w.t) * 1.5);
      const [r, g, b] = C3(VIOLET, 1.7);
      const R = w.radius * 2.5;
      QuadBatch.look(UPV, this.q);
      this.wellQ.add(w.pos, this.q, R, R, age, w.seed, 0, 0, r, g, b, 1);
      this.tmp.set(0.34, 0.66, 0.67).normalize(); QuadBatch.look(this.tmp, this.q);
      this.wellQ.add(w.pos, this.q, R * 0.7, R * 0.7, age, w.seed + 3, 0, 0, r, g * 0.7, b, 0.6);
      this.tmp.copy(cam.position).sub(w.pos).normalize(); QuadBatch.look(this.tmp, this.q);
      this.darkQ.add(w.pos, this.q, w.radius * 0.5, w.radius * 0.5, 0, 0, 0, 0, 0, 0, 0.02, 0.85 * env);
      // matter falling in along a spiral
      if (dt > 0) for (let k = 0; k < 2; k++) {
        const an = Math.random() * Math.PI * 2, rr = w.radius * rnd(0.6, 1.15);
        const p0 = this.tmp2.set(w.pos.x + Math.cos(an) * rr, w.pos.y + rnd(-40, 40), w.pos.z + Math.sin(an) * rr);
        const v = new THREE.Vector3(-Math.sin(an) * 150 - Math.cos(an) * 190, (w.pos.y - p0.y) * 0.9, Math.cos(an) * 150 - Math.sin(an) * 190);
        h.glow.emit(p0, { life: 1.3, size: rnd(2, 5), size1: 0.4, color: k ? LILAC : PINK, color1: DEEP, alpha: 0.9, vel: v, drag: 0.3 });
      }
      this.addLens(w.pos, w.radius * 1.5, 0.3 * env);
    }
    void T;
  }

  private frameSigils(dt: number, T: number) {
    const h = this.host, cam = h.rig.camera;
    const [r, g, b] = C3(VIOLET, 1.5);
    for (let i = this.sigils.length - 1; i >= 0; i--) {
      const s = this.sigils[i];
      s.t += dt;
      if (s.t >= s.life) { this.sigils.splice(i, 1); continue; }
      if (s.ship >= 0) { const p = h.shipPose(s.ship); if (p && p.ship.state === 'alive') s.pos.copy(p.pos); else if (s.flat) { s.t = Math.max(s.t, s.life - 0.3); } }
      if (s.flat) { QuadBatch.look(UPV, this.q); this.tmp.copy(s.pos); this.tmp.y -= 3; }
      else { this.tmp2.copy(cam.position).sub(s.pos).normalize(); QuadBatch.look(this.tmp2, this.q); this.tmp.copy(s.pos); }
      const R = s.size * 2 * (s.flat ? 1 : 0.6 + 0.4 * Math.min(1, s.t * 4));
      this.sigilQ.add(this.tmp, this.q, R, R, T * (s.flat ? 0.5 : 2.2) + s.seed, s.t / s.life, s.seed, 0, r, g, b, s.flat ? 0.8 : 1.4);
    }
  }

  private frameWaves(dt: number, T: number) {
    for (const w of this.waves) {
      if (w.t >= w.dur) { w.mesh.visible = false; continue; }
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const R = 30 + (w.radius - 30) * (1 - Math.pow(1 - k, 2.2));
      w.mesh.position.copy(w.pos); w.mesh.scale.setScalar(R);
      const u = (w.mesh.material as THREE.ShaderMaterial).uniforms; u.uTime.value = T; u.uAge.value = k;
      this.addLens(w.pos, R * 1.02, -0.004 * (1 - k));
    }
  }

  get stats() { return { panels: this.panels.length, facets: this.facets.length, beams: this.beams.count, lattices: this.lattices.length, lens: this.lensN }; }
}

const GEN_DELAY = 0.07;       // seconds the beam takes to cross one generation of the lattice (purely visual)
const FUNNEL_SCALE = 1.45;

/** point on a Catmull-Rom curve through pts at u ∈ [0,1] */
function catmull(pts: THREE.Vector3[], u: number, out: THREE.Vector3): THREE.Vector3 {
  const n = pts.length - 1;
  const x = Math.min(n - 1e-6, Math.max(0, u * n)), i = Math.floor(x), t = x - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[Math.min(n, i + 1)], p3 = pts[Math.min(n, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return out.set(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}
