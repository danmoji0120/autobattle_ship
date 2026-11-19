import * as THREE from 'three';
import { WEAPONS, SUBMUNITIONS } from '../sim/data/weapons';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { World } from '../sim/world';
import type { Ship, SimEvent, Munition } from '../sim/types';
import { worldDirToLocal, Vec3 } from '../sim/math';
import { ParticleSystem, TrailBatch, Shockwaves, FlashLights, Debris } from './effects';
import { buildShip, wreckMaterial, engineColor, type ShipModel } from './shipMesh';
import { Environment, type Backdrop } from './environment';
import { CameraRig, type FollowTarget, type ShotRequest, type ShakeKind } from './camera';
import { BbexFx, type FxHost } from './bbex/fx';
import { CraftView } from './craftView';
import { Mech17Fx } from './mech17Fx';

export interface AudioSink { play(name: string, pos: THREE.Vector3 | null, vol?: number, rate?: number): void }

interface ShipView {
  ship: Ship;
  model: ShipModel;
  roll: number;
  burns: { local: THREE.Vector3; life: number; size: number }[];
  damagePts: THREE.Vector3[];
  wpos: THREE.Vector3; wfwd: THREE.Vector3; wvel: THREE.Vector3;
  gone: boolean;
  flicker: number;
  hitFlash: number;
}

interface Wreck { obj: THREE.Object3D; vel: THREE.Vector3; spin: THREE.Vector3; life: number; burn: THREE.Vector3[]; size: number }

interface TrailRec { pts: THREE.Vector3[]; kind: string; team: number; dead: number; head: THREE.Vector3; col?: [number, number, number]; wmul?: number; max?: number }

const V = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y, v.z);
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
const shakeTmp = new THREE.Vector3();
const C = (hex: number) => new THREE.Color(hex);

export class BattleView implements FxHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  /** BB-EX effects (only when the battle has one) */
  ex: BbexFx | null = null;
  readonly env: Environment;
  readonly glow = new ParticleSystem(26000, 'glow');
  readonly smoke = new ParticleSystem(9000, 'smoke');
  readonly trails = new TrailBatch(9000);
  readonly rings = new Shockwaves();
  readonly flashes = new FlashLights(10);
  readonly debris = new Debris(700);
  views = new Map<number, ShipView>();
  private wrecks: Wreck[] = [];
  private trailRecs = new Map<number, TrailRec>();
  private beams: { a: THREE.Vector3; b: THREE.Vector3; life: number; max: number; w: number; c: THREE.Color }[] = [];
  private world: World | null = null;
  audio: AudioSink | null = null;
  /** P17.3 weapon-mechanism effects (display only) */
  private readonly m17 = new Mech17Fx(this, () => this.world);
  selectedShipIds = new Set<number>();
  private time = 0;
  /** director interest bookkeeping */
  private interest: { shipId: number; score: number; t: number; kind: string; target?: number }[] = [];

  constructor(canvas: HTMLCanvasElement, backdrop: Backdrop) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig = new CameraRig(w / h); this.rig.setViewHeight(h);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    this.env = new Environment(backdrop);
    this.scene.add(this.env.group, this.glow.mesh, this.smoke.mesh, this.trails.mesh, this.rings.group, this.flashes.group, this.debris.mesh);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.85, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.debris.onHot = (p, v, hot) => {
      if (Math.random() < 0.6) this.glow.emit(p, { life: 0.5 + hot, size: 2 + hot * 4, size1: 0.5, color: 0xffa040, color1: 0x601000, alpha: hot, vel: v.clone().multiplyScalar(0.2) });
      if (Math.random() < 0.15) this.smoke.emit(p, { life: 2.5, size: 3, size1: 9, color: 0x2a2624, alpha: 0.35 * hot });
    };
    this.rig.directorPick = () => this.pickShot();
    this.craftView = new CraftView(this);
    this.scene.add(this.craftView.group);
  }
  /** P16.4 strike craft (reads World.craft; display only) */
  readonly craftView: CraftView;

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
    this.rig.setViewHeight(h);
  }

  /** P11: whose point of view (side index; null = spectator). Hull designs and effect colours follow it. */
  private viewer: number | null = 0;
  setViewer(me: number | null) { this.viewer = me; }
  /** 0 = our/allied look, 1 = hostile look (a spectator sees side 0 vs the rest, as before) */
  friendly(team: number): boolean {
    const me = this.viewer, w = this.world;
    if (me === null || !w) return team === 0;
    return team === me || w.relation(me, team) === 1;
  }
  private addShipView(s: Ship) {
    const model = buildShip(s.cls, s.loadout, this.friendly(s.team) ? 0 : 1);
    this.scene.add(model.root);
    const dp: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) dp.push(new THREE.Vector3((Math.random() - 0.5) * s.radius * 1.4, Math.random() * s.radius * 0.6, (Math.random() - 0.5) * s.cls.length * 0.8));
    this.views.set(s.id, { ship: s, model, roll: 0, burns: [], damagePts: dp, wpos: new THREE.Vector3(), wfwd: new THREE.Vector3(0, 0, 1), wvel: new THREE.Vector3(), gone: false, flicker: 0, hitFlash: 0 });
  }
  /** ships that joined the battle after it started (P11 reinforcements) get their models here — also
   *  when a fast catch-up skipped the join event itself */
  private syncShipViews() {
    const w = this.world!;
    if (this.views.size === w.ships.length) return;
    for (const s of w.ships) if (!this.views.has(s.id)) this.addShipView(s);
    if (w.exShips.length && !this.ex) this.ex = new BbexFx(this, w);
    else this.ex?.sync();
  }

  attach(world: World) {
    this.world = world;
    for (const s of world.ships) this.addShipView(s);
    if (world.exShips.length) this.ex = new BbexFx(this, world);
    // centre camera on the player fleet
    const c = world.centroid(world.ships.filter(s => this.viewer === null ? s.team === 0 : s.team === this.viewer));
    this.rig.focus.set(c.x * 0.5, 0, c.z * 0.5 + 400);
  }

  // ── FxHost (what the BB-EX effects need from the view)
  shipPose(id: number) { const v = this.views.get(id); return v && !v.gone ? { pos: v.wpos, fwd: v.wfwd, root: v.model.root as THREE.Object3D, front: v.model.front as THREE.Object3D, rear: v.model.rear as THREE.Object3D, ship: v.ship } : null; }
  beam(a: THREE.Vector3, b: THREE.Vector3, life: number, w: number, color: number) { this.beams.push({ a, b, life, max: life, w, c: C(color) }); }
  shake(p: THREE.Vector3, amount: number, range = 1200) { this.shakeNear(p, amount, range, 'special'); }

  dispose() {
    this.ex?.dispose();
    this.craftView.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.scene.traverse(o => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose?.(); });
  }

  followTarget(id: number): FollowTarget | null {
    const v = this.views.get(id);
    if (!v || v.gone) return null;
    return { pos: v.wpos, fwd: v.wfwd, length: v.ship.cls.length, alive: v.ship.state === 'alive', vel: v.wvel };
  }

  // ------------------------------------------------------------------------- events

  handleEvents(events: SimEvent[]) {
    const w = this.world!;
    for (const e of events) {
      if (this.m17.handle(e)) continue;
      switch (e.t) {
        case 'fire': this.onFire(e.ship, e.mount, e.weapon, V(e.pos), V(e.dir)); break;
        case 'pd': {
          const from = V(e.from), to = V(e.to);
          const src = w.shipById.get(e.ship)!;
          if (src.ex) {
            // PURPLE RAIN: every emitter's shot is drawn — a net of violet light around the hull
            this.beams.push({ a: from, b: to, life: 0.06, max: 0.06, w: 0.3, c: C(0xc9a0ff) });
            if (e.hit && Math.random() < 0.6) this.glow.emit(to, { life: 0.14, size: 3, size1: 7, color: 0xe6c8ff, alpha: 0.9 });
            if (Math.random() < 0.04) this.audio?.play('ex_rain', from, 0.3, 0.9 + Math.random() * 0.4);
            break;
          }
          if (Math.random() < 0.55) this.beams.push({ a: from, b: to, life: 0.07, max: 0.07, w: 0.35, c: C(this.friendly(src.team) ? 0xa0e8ff : 0xffb070) });
          if (e.hit && Math.random() < 0.5) this.glow.emit(to, { life: 0.15, size: 3, size1: 6, color: 0xffd080, alpha: 0.8 });
          if (Math.random() < 0.08) this.audio?.play('pd', from, 0.35);
          break;
        }
        case 'hit': if (!(this.ex && this.ex.onHit(e))) this.onHit(e); break;
        case 'intercept': {
          const p = V(e.pos);
          const big = e.kind === 'torpedo';
          this.burst(p, big ? 14 : 8, 0xffc070, 0x803010, big ? 10 : 6, 30);
          this.glow.emit(p, { life: 0.25, size: big ? 22 : 12, size1: big ? 30 : 18, color: 0xffe0b0, alpha: 1 });
          this.smoke.emit(p, { life: 2.5, size: big ? 8 : 5, size1: big ? 22 : 14, color: 0x3a3532, alpha: 0.45, drag: 1 });
          this.audio?.play('intercept', p, big ? 0.7 : 0.4);
          break;
        }
        case 'munitionExpire': this.burst(V(e.pos), 5, 0xffb060, 0x401000, 4, 20); break;
        case 'crit': {
          const p = V(e.pos);
          this.explosion(p, 0.6);
          if (e.crit === 'engine') {
            // P17.3: an engine hit visibly — a gout of burning fuel and sparks blown out of the stern
            const v = this.views.get(e.ship);
            if (v) for (const en of v.model.engines) {
              const ep = en.glow.getWorldPosition(new THREE.Vector3());
              this.burst(ep, 6, 0xffe0a0, 0xff4000, 3, 60, v.wfwd.clone().multiplyScalar(-1));
              this.smoke.emit(ep, { life: 4, size: en.base * 3, size1: en.base * 10, color: 0x1e1c1c, alpha: 0.5, drag: 0.4 });
            }
          }
          break;
        }
        case 'secondary': this.explosion(V(e.pos), 0.8 + Math.random() * 0.6); break;
        case 'dying': {
          const v = this.views.get(e.ship); if (!v) break;
          v.flicker = 1;
          // a hull the DCP-Ω cut through is not blown up: it comes apart along the cut (bbex/fx.ts)
          if (!(this.ex && this.ex.onDying(e.ship))) this.explosion(v.wpos.clone(), v.ship.role === 'raider' ? 1.2 : 1.4);
          this.noteInterest(e.ship, 9, 'dying');
          break;
        }
        case 'destroyed': this.onDestroyed(e.ship, e.magazine); break;
        case 'escaped': {
          const v = this.views.get(e.ship); if (!v) break;
          this.glow.emit(v.wpos, { life: 0.6, size: v.ship.cls.length * 2, size1: v.ship.cls.length * 0.5, color: 0xaaddff, alpha: 1 });
          this.beams.push({ a: v.wpos.clone(), b: v.wpos.clone().addScaledVector(v.wfwd, 600), life: 0.5, max: 0.5, w: v.ship.radius, c: C(0x99ccff) });
          this.removeView(v);
          break;
        }
        case 'highlight': break;
        case 'craftLaunch': this.craftView.launch(V(e.pos), w.shipById.get(e.ship)?.team ?? 0); break;
        case 'craftDown': this.craftView.down(V(e.pos), e.team); break;
        case 'repair': {
          // P16.7: a combat repair rig's work — a soft green link and a brief glow on the patient
          const to = V(e.to);
          this.beams.push({ a: V(e.from), b: to, life: 0.5, max: 0.5, w: 0.45, c: C(0x7dffb0) });
          this.glow.emit(to, { life: 0.6, size: 4, size1: 9, color: 0x9dffc8, alpha: 0.7 });
          break;
        }
        case 'craftLeave': this.glow.emit(V(e.pos), { life: 0.3, size: 2.5, size1: 0.5, color: 0xa0c0ff, alpha: 0.6 }); break;
        default: if (this.ex && e.t.startsWith('ex')) this.ex.handle(e as never);
      }
    }
  }

  private onFire(shipId: number, mountIdx: number, weapon: string, pos: THREE.Vector3, dir: THREE.Vector3) {
    const v = this.views.get(shipId);
    if (!v) return;
    const t = v.model.turrets[mountIdx];
    if (t) t.recoil = 1;
    const team = v.ship.team;
    if (this.ex && v.ship.ex && this.ex.onFire(v.ship, weapon, pos, dir)) {
      if (weapon === 'seraph_ex') this.noteInterest(shipId, 2.5, 'missile');
      return;
    }
    switch (weapon) {
      case 'heavy_cannon': case 'rail_cannon': {
        const rail = weapon === 'rail_cannon';
        const mp = pos.clone().addScaledVector(dir, rail ? 16 : 10);
        this.glow.emit(mp, { life: 0.22, size: rail ? 18 : 26, size1: rail ? 6 : 40, color: rail ? 0xc0f0ff : 0xffe0a0, alpha: 1.4 });
        for (let i = 0; i < 10; i++) {
          const vv = dir.clone().multiplyScalar(60 + Math.random() * 120).add(new THREE.Vector3((Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50));
          this.glow.emit(mp, { life: 0.3 + Math.random() * 0.3, size: 4 + Math.random() * 5, size1: 1, color: rail ? 0x80e0ff : 0xffb050, color1: 0x802000, vel: vv, drag: 4 });
        }
        for (let i = 0; i < 5; i++) this.smoke.emit(mp, { life: 3 + Math.random() * 2, size: 6, size1: 22 + Math.random() * 10, color: 0x6a6460, alpha: 0.35, vel: dir.clone().multiplyScalar(20 + Math.random() * 25).add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(12)), drag: 1.2 });
        if (rail) this.beams.push({ a: mp, b: mp.clone().addScaledVector(dir, 400), life: 0.12, max: 0.12, w: 1.4, c: C(0x9fe8ff) });
        this.flashes.flash(mp, 60, 300, 0.25, rail ? 0x9fe0ff : 0xffc080);
        this.audio?.play(rail ? 'rail' : 'heavy', mp, 1);
        this.shakeNear(mp, 0.9, 1200, 'fire');
        this.noteInterest(shipId, 4, 'salvo', v.ship.mounts[mountIdx]?.targetId);
        break;
      }
      case 'medium_gun': {
        const mp = pos.clone().addScaledVector(dir, 4.5);
        this.glow.emit(mp, { life: 0.12, size: 9, size1: 14, color: 0xffd090, alpha: 1.2 });
        this.smoke.emit(mp, { life: 1.8, size: 3, size1: 9, color: 0x6a6460, alpha: 0.25, vel: dir.clone().multiplyScalar(15), drag: 1 });
        if (Math.random() < 0.6) this.audio?.play('medium', mp, 0.55);
        this.shakeNear(mp, 0.2, 1200, 'fire');
        break;
      }
      case 'autocannon': {
        const mp = pos.clone().addScaledVector(dir, 2.6);
        this.glow.emit(mp, { life: 0.06, size: 3.5, size1: 5, color: 0xffd080, alpha: 1 });
        if (Math.random() < 0.35) this.audio?.play('auto', mp, 0.3);
        break;
      }
      case 'missile_rack': {
        this.glow.emit(pos, { life: 0.3, size: 8, size1: 3, color: 0xfff0c0, alpha: 1 });
        for (let i = 0; i < 4; i++) this.smoke.emit(pos, { life: 2.2, size: 3, size1: 12, color: 0x7a7470, alpha: 0.4, vel: new THREE.Vector3((Math.random() - 0.5) * 20, 10 + Math.random() * 15, (Math.random() - 0.5) * 20), drag: 1.5 });
        this.audio?.play('missile', pos, 0.55, 0.9 + Math.random() * 0.2);
        this.noteInterest(shipId, 2.5, 'missile');
        break;
      }
      case 'torpedo': {
        this.glow.emit(pos, { life: 0.4, size: 12, size1: 4, color: this.friendly(team) ? 0xa0c8ff : 0xff90c0, alpha: 1.2 });
        this.audio?.play('torpedo', pos, 0.8);
        this.noteInterest(shipId, 7, 'torpedo', v.ship.mounts[mountIdx]?.targetId);
        break;
      }
      default: {
        // P5 arsenal weapons: muzzle flash and (energy) beam in the weapon's own colour, sized by tier
        const w = WEAPONS[weapon]; if (!w) break;
        const col = w.vis?.color ?? (w.kind === 'torpedo' ? (this.friendly(team) ? 0xa0c8ff : 0xff90c0) : 0xffd090);
        const big = (w.tier ?? 1) >= 4 || w.caliber >= 2;
        const mp = pos.clone().addScaledVector(dir, 2 + w.caliber * 2);
        this.glow.emit(mp, { life: w.kind === 'shell' ? 0.12 : 0.3, size: 4 + w.caliber * 5, size1: 2 + w.caliber * 4, color: col, alpha: 1.2 });
        if (w.vis?.beam) this.beams.push({ a: mp, b: mp.clone().addScaledVector(dir, Math.min(w.range, 260 + w.vis.len * 3)), life: big ? 0.2 : 0.09, max: big ? 0.2 : 0.09, w: w.vis.wid, c: C(col) });
        if (w.kind === 'missile' || w.kind === 'torpedo') this.noteInterest(shipId, w.kind === 'torpedo' ? 7 : 2.5, w.kind, v.ship.mounts[mountIdx]?.targetId);
        if (big) { this.flashes.flash(mp, 50, 260, 0.2, col); this.shakeNear(mp, 0.5, 1200, 'fire'); }
        if (Math.random() < (big ? 1 : 0.4)) this.audio?.play(w.sound as never, mp, big ? 0.9 : 0.4);
        break;
      }
    }
  }

  private onHit(e: Extract<SimEvent, { t: 'hit' }>) {
    const p = V(e.pos), dir = V(e.dir);
    const v = this.views.get(e.target);
    const heavy = e.weapon === 'heavy_cannon' || e.weapon === 'rail_cannon' || e.weapon === 'torpedo' || e.weapon === 'blast';
    if (e.result === 'shield') {
      // the hit splashes on the shield bubble: a blue ripple off the hull, no sparks
      const out = v ? p.clone().addScaledVector(dir, -Math.max(4, v.ship.radius * 0.6)) : p;
      this.glow.emit(out, { life: 0.35, size: 10, size1: 26, color: 0x6fc8ff, alpha: 0.9 });
      this.flashes.flash(out, 30, 120, 0.15, 0x6fc8ff);
      if (Math.random() < 0.3) this.audio?.play('ricochet', out, 0.25, 1.4);
      return;
    }
    if (e.result === 'ricochet') {
      // deflected spark streak
      const refl = dir.clone().reflect(new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5).normalize()).normalize();
      this.burst(p, heavy ? 16 : 5, 0xfff0c0, 0xff6020, heavy ? 6 : 3, heavy ? 140 : 70, refl);
      this.beams.push({ a: p.clone(), b: p.clone().addScaledVector(refl, heavy ? 120 : 30), life: 0.25, max: 0.25, w: heavy ? 1.2 : 0.4, c: C(0xffe0a0) });
      if (heavy || Math.random() < 0.15) this.audio?.play('ricochet', p, heavy ? 0.9 : 0.25, 0.8 + Math.random() * 0.4);
      return;
    }
    const wd = WEAPONS[e.weapon];
    if (wd?.kind === 'craft') {
      // P16.4 strike-craft cannon: small, fast sparks (the tracer itself is drawn by CraftView)
      this.glow.emit(p, { life: 0.1, size: 2.2, size1: 3.5, color: 0xffd090, alpha: 0.9 });
      if (Math.random() < 0.25) this.burst(p, 2, 0xffe0a0, 0x803000, 1.5, 35);
      if (v) v.hitFlash = Math.max(v.hitFlash, 0.3);
      return;
    }
    if (e.weapon === 'pd_gun' || e.weapon === 'autocannon') {
      this.glow.emit(p, { life: 0.12, size: 3, size1: 5, color: 0xffc070, alpha: 0.9 });
      if (Math.random() < 0.3) this.burst(p, 2, 0xffd090, 0x803000, 2, 40);
      if (Math.random() < 0.08) this.audio?.play('hitsmall', p, 0.25);
      return;
    }
    // P17.3 mechanism weapons and submunitions: the hit is sized by the damage it actually did
    const m17 = wd?.mech || SUBMUNITIONS[e.weapon];
    const scale = m17 ? THREE.MathUtils.clamp(Math.sqrt(Math.max(e.dmg, wd?.damage ?? 0) / 160), 0.35, 2.2)
      : e.weapon === 'torpedo' ? 2.6 : e.weapon === 'air_torpedo' ? 1.8 : e.weapon === 'blast' ? 1.6 : heavy ? 1.6 : e.weapon === 'missile_rack' ? 0.9 : 0.6;
    this.glow.emit(p, { life: 0.18, size: 14 * scale, size1: 22 * scale, color: 0xfff2d0, alpha: 1.4 });
    this.burst(p, Math.round(10 * scale), 0xffd080, 0xff3000, 3 * scale, 90 * scale, dir.clone().multiplyScalar(-1));
    for (let i = 0; i < 3 * scale; i++) this.glow.emit(p, { life: 0.6 + Math.random() * 0.6, size: 5 * scale, size1: 12 * scale, color: 0xff9030, color1: 0x401000, alpha: 0.9, vel: new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20).multiplyScalar(scale), drag: 1.5 });
    this.smoke.emit(p, { life: 3 + scale, size: 4 * scale, size1: 16 * scale, color: 0x3a3532, alpha: 0.5, drag: 0.8, vel: new THREE.Vector3((Math.random() - 0.5) * 6, 4, (Math.random() - 0.5) * 6) });
    if (heavy) for (let i = 0; i < 4 * scale; i++) this.debris.spawn(p, dir.clone().multiplyScalar(-30).add(new THREE.Vector3((Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60)), 0.4 + Math.random() * 0.8 * scale, 6, 1);
    this.flashes.flash(p, heavy ? 40 * scale : 12, heavy ? 260 : 120, heavy ? 0.35 : 0.15, 0xffa050);
    this.audio?.play(e.weapon === 'torpedo' ? 'torphit' : heavy ? 'hitheavy' : 'hit', p, heavy ? 1 : 0.5, 0.85 + Math.random() * 0.3);
    if (heavy) this.shakeNear(p, e.weapon === 'torpedo' ? 1.6 : 0.8, 1200, 'hit');
    if (v && v.ship.state !== 'dead') {
      v.hitFlash = 1;
      // attach a burning breach in ship-local space
      if (e.dmg > 60 && v.burns.length < 10) {
        const local = this.worldToShipLocal(v, p);
        v.burns.push({ local, life: 6 + Math.random() * 8 * scale, size: Math.min(3, scale) });
      }
      if (e.weapon === 'torpedo') this.noteInterest(v.ship.id, 8, 'torphit');
    }
  }

  private onDestroyed(shipId: number, magazine: boolean) {
    const v = this.views.get(shipId);
    if (!v) return;
    const s = v.ship;
    const p = v.wpos.clone();
    const size = s.cls.length / 64; // 1 = battleship
    const big = s.role !== 'raider';
    const k = magazine ? 2.2 : 1;
    // core flash
    this.glow.emit(p, { life: 0.5 * k, size: 90 * size * k + 20, size1: 160 * size * k + 30, color: 0xfff6e0, alpha: 1.3 });
    this.glow.emit(p, { life: 1.2 * k, size: 60 * size * k + 15, size1: 120 * size * k + 20, color: 0xffa040, color1: 0x401000, alpha: 1.2 });
    // fireball
    for (let i = 0; i < 40 * size * k + 10; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const sp = (20 + Math.random() * 80) * (0.5 + size) * k;
      this.glow.emit(p.clone().addScaledVector(dir, Math.random() * s.cls.length * 0.4), { life: 0.8 + Math.random() * 1.6, size: (8 + Math.random() * 14) * (0.5 + size), size1: (20 + Math.random() * 20) * (0.5 + size), color: 0xffb050, color1: 0x300800, alpha: 1, vel: dir.multiplyScalar(sp), drag: 1.2 });
    }
    // sparks
    for (let i = 0; i < 90 * k; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.glow.emit(p, { life: 0.8 + Math.random() * 1.8, size: 1.5 + Math.random() * 2.5, size1: 0.4, color: 0xffe0a0, color1: 0xff4000, vel: dir.multiplyScalar((120 + Math.random() * 380) * (0.6 + size)), drag: 0.6 });
    }
    // smoke
    for (let i = 0; i < 14 * size * k + 4; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.smoke.emit(p.clone().addScaledVector(dir, Math.random() * 20 * size), { life: 6 + Math.random() * 5, size: 20 * size + 6, size1: 70 * size + 20, color: 0x2c2826, alpha: 0.55, vel: dir.multiplyScalar(15 + Math.random() * 25), drag: 0.4 });
    }
    this.rings.spawn(p, 220 * size * k + 40, 1.6 * k, magazine ? 0xffd0a0 : 0xffa060, new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), (Math.random() - 0.5) * 0.6));
    if (big) this.rings.spawn(p, 140 * size * k + 30, 1.1 * k, 0x80c0ff);
    for (let i = 0; i < (big ? 30 * size * k + 10 : 8); i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.debris.spawn(p.clone().addScaledVector(dir, Math.random() * 10), dir.multiplyScalar(30 + Math.random() * 120 * k).add(v.wvel), (0.6 + Math.random() * 2.5) * (0.4 + size), 14 + Math.random() * 12, 1);
    }
    this.flashes.flash(p, 260 * k * (0.4 + size), 1400 * k, 1.4 * k, 0xffb070);
    this.audio?.play(big ? 'explode_big' : 'explode', p, big ? 1.2 : 0.7, magazine ? 0.75 : 0.9 + Math.random() * 0.2);
    this.shakeNear(p, big ? 2.4 * k : 0.8, big ? 2500 : 900, 'blast');
    // wreck halves
    if (big) {
      const root = v.model.root;
      root.updateMatrixWorld(true);
      for (const half of [v.model.front, v.model.rear]) {
        const sign = half === v.model.front ? 1 : -1;
        const obj = half;
        obj.updateMatrixWorld(true);
        const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
        obj.matrixWorld.decompose(wp, wq, ws);
        this.scene.add(obj);
        obj.position.copy(wp); obj.quaternion.copy(wq);
        obj.traverse(o => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const mat = m.material as THREE.Material;
          if ((mat as THREE.MeshBasicMaterial).blending === THREE.AdditiveBlending || (mat as any).isMeshBasicMaterial) m.visible = false;
          else m.material = wreckMaterial;
        });
        const vel = v.wvel.clone().multiplyScalar(0.6).addScaledVector(v.wfwd, sign * (6 + Math.random() * 8 * k)).add(new THREE.Vector3(0, (Math.random() - 0.5) * 6, 0));
        const spin = new THREE.Vector3((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.35).multiplyScalar(k);
        const burn = [0, 1, 2].map(() => new THREE.Vector3((Math.random() - 0.5) * s.radius, Math.random() * s.radius * 0.5, sign * Math.random() * s.cls.length * 0.15));
        this.wrecks.push({ obj, vel, spin, life: 70, burn, size });
      }
      v.model.root.visible = false;
    }
    this.removeView(v, !big);
    this.ex?.onDestroyed(shipId, p);
    this.noteInterest(shipId, big ? 12 : 3, 'destroyed');
    // director: dramatic cut for capital kills
    if (big && s.value >= 140) {
      this.rig.offer({ kind: 'impact', subject: () => ({ pos: p, fwd: v.wfwd.clone(), length: s.cls.length * 1.6, alive: false, vel: v.wvel.clone() }), duration: 4.5, priority: magazine ? 11 : 10, slowmo: 0.3 });
    }
  }

  private removeView(v: ShipView, removeMesh = true) {
    v.gone = true;
    if (removeMesh) this.scene.remove(v.model.root);
    this.selectedShipIds.delete(v.ship.id);
  }

  /** feed a nearby event to the camera shake: falls off with distance, and an event the camera is not looking at counts half.
   *  The rig decides by setting, camera mode and event kind whether it shakes at all and caps the on-screen size. */
  private shakeNear(p: THREE.Vector3, amount: number, range: number, kind: ShakeKind) {
    const cam = this.rig.camera;
    const d = p.distanceTo(cam.position);
    if (d >= range) return;
    shakeTmp.copy(p).project(cam);
    const inView = shakeTmp.z < 1 && Math.abs(shakeTmp.x) < 1.15 && Math.abs(shakeTmp.y) < 1.15;
    this.rig.addShake(amount * (1 - d / range) * (inView ? 1 : 0.5), kind);
  }

  burst(p: THREE.Vector3, n: number, c0: number, c1: number, size: number, speed: number, bias?: THREE.Vector3) {
    for (let i = 0; i < n; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      if (bias) d.addScaledVector(bias, 1.2).normalize();
      this.glow.emit(p, { life: 0.3 + Math.random() * 0.6, size: size * (0.4 + Math.random() * 0.6), size1: size * 0.15, color: c0, color1: c1, vel: d.multiplyScalar(speed * (0.3 + Math.random())), drag: 2.5 });
    }
  }

  explosion(p: THREE.Vector3, s: number) {
    this.glow.emit(p, { life: 0.25, size: 20 * s, size1: 32 * s, color: 0xfff0d0, alpha: 1.3 });
    for (let i = 0; i < 8 * s; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.glow.emit(p, { life: 0.6 + Math.random() * 0.8, size: 7 * s, size1: 16 * s, color: 0xffa040, color1: 0x401000, vel: d.multiplyScalar(25 * s), drag: 1.5 });
    }
    this.burst(p, 10 * s, 0xffe0a0, 0xff4000, 2.5, 120 * s);
    this.smoke.emit(p, { life: 4, size: 8 * s, size1: 26 * s, color: 0x302c2a, alpha: 0.5, drag: 0.6 });
    this.flashes.flash(p, 50 * s, 300 * s, 0.35, 0xffa050);
    this.audio?.play('explode', p, 0.5 * s, 1.1 + Math.random() * 0.3);
    this.shakeNear(p, 0.5 * s, 1200, 'blast');
  }

  private worldToShipLocal(v: ShipView, p: THREE.Vector3): THREE.Vector3 {
    v.model.root.updateMatrixWorld();
    return v.model.root.worldToLocal(p.clone());
  }

  // ------------------------------------------------------------------------- frame

  frame(alpha: number, simDt: number, realDt: number, render = true) {
    const w = this.world!;
    this.syncShipViews();
    this.time += realDt;
    const cam = this.rig.camera;
    // ships
    for (const v of this.views.values()) {
      if (v.gone) continue;
      const s = v.ship;
      const r = v.model.root;
      if (s.ex && this.ex) { r.visible = this.ex.visible(s.id) && !v.gone; r.scale.setScalar(this.ex.emergeScale(s.id)); if (!r.visible) { v.wpos.set(s.pos.x, s.pos.y, s.pos.z); continue; } }
      r.position.set(s.prevPos.x + (s.pos.x - s.prevPos.x) * alpha, s.prevPos.y + (s.pos.y - s.prevPos.y) * alpha, s.prevPos.z + (s.pos.z - s.prevPos.z) * alpha);
      let dyaw = s.yaw - s.prevYaw; if (dyaw > Math.PI) dyaw -= Math.PI * 2; if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const yaw = s.prevYaw + dyaw * alpha, pitch = s.prevPitch + (s.pitch - s.prevPitch) * alpha;
      r.rotation.order = 'YXZ';
      r.rotation.set(-pitch, yaw, 0);
      const targetRoll = THREE.MathUtils.clamp(-(dyaw / w.dt) * (s.role === 'raider' ? 0.9 : 2.2), -0.6, 0.6);
      v.roll += (targetRoll - v.roll) * Math.min(1, realDt * 3);
      v.model.bank.rotation.z = v.roll + (s.state === 'dying' ? Math.sin(this.time * 2 + s.id) * 0.1 : 0);
      v.wpos.copy(r.position);
      v.wfwd.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      v.wvel.set(s.vel.x, s.vel.y, s.vel.z);
      // turrets
      for (let i = 0; i < v.model.turrets.length; i++) {
        const t = v.model.turrets[i];
        const m = s.mounts[i];
        if (t.rotates && m && m.aim.lengthSq() > 0.5) {
          const local = worldDirToLocal(m.aim, s.yaw, s.pitch, new Vec3());
          const ty = Math.atan2(local.x, local.z);
          const tp = Math.atan2(local.y, Math.hypot(local.x, local.z));
          let dy = ty - t.root.rotation.y; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
          t.root.rotation.y += dy * Math.min(1, realDt * 12);
          if (t.barrels) t.barrels.rotation.x = -THREE.MathUtils.clamp(tp, -0.25, 1.0);
        }
        if (t.barrels) {
          t.recoil = Math.max(0, t.recoil - realDt * 2.2);
          t.barrels.position.z = (t.barrels.userData.z0 ??= t.barrels.position.z) - t.recoil * t.recoil * (m?.weapon.caliber ?? 1) * 1.3;
        }
      }
      // engines
      const thr = s.state === 'alive' ? 0.25 + s.throttle * 0.95 : 0.1;
      // P17.3 engine damage: a crippled drive (engine crit) or a hull near death sputters — the plume cuts out
      // and coughs back, sparks and black smoke leak from the nozzles
      const sick = s.state === 'alive' && (s.crit.engine > 0 || s.hp < s.maxHp * 0.3);
      for (const e of v.model.engines) {
        const cough = sick ? (Math.random() < 0.25 ? 0.05 : 0.35 + Math.random() * 0.4) : 1;
        e.plume.scale.z = e.base * (3 + thr * 9) * (0.92 + Math.random() * 0.16) * cough;
        (e.plume.material as THREE.MeshBasicMaterial).opacity = sick ? 0.25 + cough * 0.3 : 0.5;
        e.glow.scale.setScalar(e.base * (0.8 + thr * 0.4) * (sick ? 0.4 + cough * 0.6 : 1));
        if (sick && Math.random() < realDt * (s.crit.engine > 0 ? 9 : 3)) {
          const ep = e.glow.getWorldPosition(tmp2);
          this.glow.emit(ep, { life: 0.3 + Math.random() * 0.3, size: e.base * 1.4, size1: 0.3, color: 0xffc070, color1: 0x601000, vel: v.wfwd.clone().multiplyScalar(-20).add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(30)), drag: 2 });
          this.smoke.emit(ep, { life: 2.5, size: e.base * 1.5, size1: e.base * 6, color: 0x1a1818, alpha: 0.4, vel: v.wvel.clone().multiplyScalar(0.6), drag: 0.4 });
        }
      }
      // nav lights blink
      const blink = (Math.sin(this.time * 3 + s.id) > 0.7) ? 1 : 0.15;
      for (const l of v.model.lights) l.scale.setScalar(blink);
      // damage effects
      const hpf = s.hp / s.maxHp;
      if (s.state === 'dying' || hpf < 0.6) {
        const rate = s.state === 'dying' ? 30 : (0.6 - hpf) * 18;
        for (const dp of v.damagePts) {
          if (Math.random() < rate * realDt) {
            const wp = dp.clone().applyMatrix4(r.matrixWorld);
            this.glow.emit(wp, { life: 0.5 + Math.random() * 0.5, size: s.radius * 0.6, size1: s.radius * 1.4, color: 0xff8030, color1: 0x401000, alpha: 0.9, vel: new THREE.Vector3(0, 6, 0).addScaledVector(v.wvel, 0.85) });
            this.smoke.emit(wp, { life: 3 + Math.random() * 2, size: s.radius * 0.8, size1: s.radius * 3.5, color: 0x1e1c1c, alpha: 0.4, vel: new THREE.Vector3((Math.random() - 0.5) * 4, 5, (Math.random() - 0.5) * 4).addScaledVector(v.wvel, 0.7), drag: 0.3 });
          }
        }
      }
      for (let bi = v.burns.length - 1; bi >= 0; bi--) {
        const b = v.burns[bi];
        b.life -= realDt;
        if (b.life <= 0) { v.burns.splice(bi, 1); continue; }
        if (Math.random() < 14 * realDt) {
          const wp = b.local.clone().applyMatrix4(r.matrixWorld);
          this.glow.emit(wp, { life: 0.35 + Math.random() * 0.3, size: 2 * b.size + 1, size1: 4 * b.size + 2, color: 0xffa040, color1: 0x501000, alpha: 0.9, vel: tmp.copy(v.wvel).multiplyScalar(0.9).add(tmp2.set(0, 3, 0)) });
          if (Math.random() < 0.4) this.smoke.emit(wp, { life: 2.5, size: 2 * b.size, size1: 8 * b.size, color: 0x222020, alpha: 0.35, vel: tmp.copy(v.wvel).multiplyScalar(0.8), drag: 0.4 });
        }
      }
      // hull emissive flicker when dying / hit
      v.hitFlash = Math.max(0, v.hitFlash - realDt * 4);
    }
    // wrecks
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const wk = this.wrecks[i];
      wk.life -= realDt;
      wk.obj.position.addScaledVector(wk.vel, simDt);
      tmpQ.setFromEuler(new THREE.Euler(wk.spin.x * simDt, wk.spin.y * simDt, wk.spin.z * simDt));
      wk.obj.quaternion.multiply(tmpQ);
      if (wk.life > 45 && Math.random() < 6 * realDt) {
        const wp = wk.burn[Math.floor(Math.random() * wk.burn.length)].clone().applyMatrix4(wk.obj.matrixWorld);
        this.glow.emit(wp, { life: 0.6, size: 4 * wk.size + 2, size1: 9 * wk.size + 3, color: 0xff8030, color1: 0x401000, alpha: 0.8, vel: wk.vel });
        this.smoke.emit(wp, { life: 4, size: 6 * wk.size + 2, size1: 22 * wk.size + 6, color: 0x1e1c1c, alpha: 0.35, vel: wk.vel, drag: 0.2 });
        if (Math.random() < 0.02) this.explosion(wp, 0.5);
      }
      if (wk.life <= 0) { this.scene.remove(wk.obj); this.wrecks.splice(i, 1); }
    }
    // munitions → trails
    this.trails.begin(cam);
    for (const m of w.munitions) {
      if (m.dead) continue;
      const px = m.prevPos.x + (m.pos.x - m.prevPos.x) * alpha, py = m.prevPos.y + (m.pos.y - m.prevPos.y) * alpha, pz = m.prevPos.z + (m.pos.z - m.prevPos.z) * alpha;
      if (m.kind === 'shell') this.drawShell(m, px, py, pz);
      else this.trackGuided(m, px, py, pz);
    }
    this.drawGuidedTrails(realDt);
    this.m17.frame();
    if (this.beams.length > 800) this.beams.splice(0, this.beams.length - 800);
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= realDt;
      if (b.life <= 0) { this.beams.splice(i, 1); continue; }
      const a = b.life / b.max;
      this.trails.seg(b.a.x, b.a.y, b.a.z, b.b.x, b.b.y, b.b.z, b.w, b.w * 0.6, b.c.r * 2, b.c.g * 2, b.c.b * 2, a, a * 0.5);
    }
    this.ex?.frame(alpha, simDt, realDt);
    this.trails.end();
    this.craftView.frame(w, alpha, realDt, cam, render);

    this.glow.update(simDt > 0 ? Math.max(simDt, realDt * 0.25) : realDt * 0.25);
    this.smoke.update(simDt > 0 ? Math.max(simDt, realDt * 0.25) : realDt * 0.1);
    this.debris.update(simDt);
    this.rings.update(realDt);
    this.flashes.update(realDt);
    this.env.setGridOpacity(this.rig.mode === 'tactical' ? 0.12 : 0.025);
    this.rig.update(simDt, realDt);
    this.env.update(cam);
    if (render) this.composer.render();
    // decay interest
    this.interest = this.interest.filter(i => this.time - i.t < 8);
  }

  private drawShell(m: Munition, x: number, y: number, z: number) {
    const sp = m.vel.length();
    const w = m.weapon;
    const team = m.team;
    let len: number, wid: number, r: number, g: number, b: number;
    switch (w.id) {
      case 'heavy_cannon': len = 45; wid = 2.2; r = 3; g = 2.1; b = 1.2; break;
      case 'rail_cannon': len = 140; wid = 1.4; r = 1.2; g = 2.6; b = 3.2; break;
      case 'medium_gun': len = 22; wid = 1.0; r = 2.6; g = 1.9; b = 0.9; break;
      case 'autocannon': len = 14; wid = 0.45; r = 2.4; g = 1.4; b = 0.6; break;
      default: {
        const vc = w.vis;
        if (vc) { len = vc.len; wid = vc.wid; r = ((vc.color >> 16) & 255) / 85; g = ((vc.color >> 8) & 255) / 85; b = (vc.color & 255) / 85; }
        else { len = 10; wid = 0.5; r = 2; g = 2; b = 2; }
      }
    }
    if (!this.friendly(team) && w.id !== 'rail_cannon') { g *= 0.75; b *= 0.6; }
    const k = len / Math.max(sp, 1);
    this.trails.seg(x - m.vel.x * k, y - m.vel.y * k, z - m.vel.z * k, x, y, z, wid * 0.2, wid, r, g, b, 0, 1);
    if (w.pierce) {
      // ABYSS-LANCE: a blue-white spear inside a violet wake, shedding motes
      this.trails.seg(x - m.vel.x * k * 0.55, y - m.vel.y * k * 0.55, z - m.vel.z * k * 0.55, x, y, z, wid * 0.1, wid * 0.5, 2.4, 2.8, 3.2, 0.2, 1);
      this.trails.seg(x - m.vel.x * k * 1.6, y - m.vel.y * k * 1.6, z - m.vel.z * k * 1.6, x, y, z, wid * 0.4, wid * 2.2, 0.7, 0.2, 1.6, 0, 0.6);
      if (Math.random() < 0.35) this.glow.emit(tmp.set(x, y, z), { life: 0.35, size: 3.2, size1: 0.4, color: 0xbfd8ff, color1: 0x5a1fd0, alpha: 1 });
    }
    if (w.id === 'heavy_cannon' || w.id === 'rail_cannon') {
      // bright head
      this.trails.seg(x - m.vel.x * k * 0.12, y - m.vel.y * k * 0.12, z - m.vel.z * k * 0.12, x, y, z, wid * 1.3, wid * 1.3, r, g, b, 0.8, 0.8);
    }
  }

  private trackGuided(m: Munition, x: number, y: number, z: number) {
    let rec = this.trailRecs.get(m.id);
    if (!rec) {
      const st = m.weapon.mech || m.sub !== undefined ? this.m17.trail(m) : null;
      rec = { pts: [], kind: m.kind, team: m.team, dead: 0, head: new THREE.Vector3(), ...(m.weapon.phase ? { col: [2.0, 0.85, 3.0] as [number, number, number] } : {}), ...(st ?? {}) };
      this.trailRecs.set(m.id, rec);
    }
    if (m.mine !== undefined) this.m17.munition(m, tmp.set(x, y, z), this.time);
    // SERAPH-EX skipped through space: the trail does not bridge the gap
    if (rec.col && rec.pts.length && rec.pts[rec.pts.length - 1].distanceToSquared(tmp.set(x, y, z)) > 200 * 200) rec.pts.length = 0;
    rec.head.set(x, y, z);
    const last = rec.pts[rec.pts.length - 1];
    if (!last || last.distanceToSquared(rec.head) > (m.kind === 'torpedo' ? 30 : 60)) {
      rec.pts.push(rec.head.clone());
      if (rec.pts.length > (rec.max ?? (m.kind === 'torpedo' ? 26 : 36))) rec.pts.shift();
      if (m.kind === 'missile' && !rec.col && Math.random() < 0.3) this.smoke.emit(rec.head, { life: 1.4, size: 1.6, size1: 5, color: 0x8a8480, alpha: 0.09, drag: 0.5 });
    }
  }

  private drawGuidedTrails(realDt: number) {
    const w = this.world!;
    for (const [id, rec] of this.trailRecs) {
      const alive = w.munitionById.get(id);
      if (!alive || alive.dead) { rec.dead += realDt; if (rec.dead > 1.2) { this.trailRecs.delete(id); continue; } }
      const fade = 1 - rec.dead / 1.2;
      const torp = rec.kind === 'torpedo';
      const col = rec.col ?? (torp ? (this.friendly(rec.team) ? [0.8, 1.4, 3.2] : [3.0, 0.8, 2.0]) : [1.8, 1.1, 0.6]);
      const n = rec.pts.length, wd = (torp ? 2.2 : 0.7) * (rec.wmul ?? 1), hs = rec.wmul ?? 1;
      for (let i = 1; i < n; i++) {
        const a = rec.pts[i - 1], b = rec.pts[i];
        const t0 = (i - 1) / n, t1 = i / n;
        this.trails.seg(a.x, a.y, a.z, b.x, b.y, b.z, wd * t0, wd * t1, col[0], col[1], col[2], t0 * 0.5 * fade, t1 * 0.5 * fade);
      }
      if (rec.dead === 0) {
        const tail = rec.pts[n - 1] ?? rec.head;
        this.trails.seg(tail.x, tail.y, tail.z, rec.head.x, rec.head.y, rec.head.z, wd, wd, col[0], col[1], col[2], 0.5, 0.5);
        if (Math.random() < 0.7) this.glow.emit(rec.head, { life: 0.05, size: (torp ? 9 : 4) * hs, size1: (torp ? 7 : 3) * hs, color: rec.col ? 0xe0b8ff : torp ? (this.friendly(rec.team) ? 0x80b0ff : 0xff70c0) : 0xfff0c0, alpha: 1.3 });
      }
    }
  }

  // ------------------------------------------------------------------------- director

  private noteInterest(shipId: number, score: number, kind: string, target?: number) {
    this.interest.push({ shipId, score, t: this.time, kind, target });
    if (this.rig.mode !== 'director') return;
    const s = this.world!.shipById.get(shipId);
    if (!s) return;
    if (kind === 'torpedo' && Math.random() < 0.7) {
      this.rig.offer({ kind: 'chase', subject: () => this.followTarget(shipId), look: () => { const t = this.views.get(target ?? -1); return t && !t.gone ? t.wpos : null; }, duration: 5, priority: 6 });
    } else if (kind === 'torphit') {
      this.rig.offer({ kind: 'orbit', subject: () => this.followTarget(shipId), duration: 4, priority: 7 });
    }
  }

  private pickShot(): ShotRequest | null {
    const w = this.world!;
    const alive = w.ships.filter(s => s.state === 'alive' && !this.views.get(s.id)?.gone);
    if (!alive.length) return null;
    // aggregate recent interest per ship
    const scores = new Map<number, number>();
    for (const i of this.interest) {
      const s = w.shipById.get(i.shipId);
      if (!s || s.state !== 'alive') continue;
      scores.set(i.shipId, (scores.get(i.shipId) ?? 0) + i.score * Math.exp(-(this.time - i.t) / 4));
    }
    let best: Ship | null = null, bs = 0;
    for (const [id, sc] of scores) {
      const s = w.shipById.get(id)!;
      const jitter = sc * (0.6 + Math.random() * 0.8) + (this.selectedShipIds.has(id) ? 4 : 0);
      if (jitter > bs) { bs = jitter; best = s; }
    }
    if (!best || Math.random() < 0.18) {
      // establishing wide shot centred on the battle
      const c = w.centroid(alive, new Vec3());
      const focus = new THREE.Vector3(c.x, c.y, c.z);
      const s0 = alive[Math.floor(Math.random() * alive.length)];
      return { kind: 'wide', subject: () => ({ pos: focus, fwd: new THREE.Vector3(0, 0, 1), length: 200, alive: true }), look: () => this.views.get(s0.id)?.wpos ?? focus, duration: 6, priority: 1 };
    }
    const id = best.id;
    const tgtId = best.ai.targetId;
    const kinds: ShotRequest['kind'][] = best.role === 'raider' ? ['chase', 'chase', 'flyby', 'orbit'] : ['low', 'orbit', 'chase', 'flyby'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    return {
      kind, subject: () => this.followTarget(id),
      look: () => { const t = this.views.get(tgtId); return t && !t.gone ? t.wpos : null; },
      duration: kind === 'flyby' ? 4 : 6 + Math.random() * 2, priority: 2,
    };
  }

  // ------------------------------------------------------------------------- picking / projection

  project(p: { x: number; y: number; z: number }, out: THREE.Vector3, w: number, h: number): boolean {
    out.set(p.x, p.y, p.z).project(this.rig.camera);
    const vis = out.z < 1 && out.z > -1;
    out.x = (out.x * 0.5 + 0.5) * w; out.y = (-out.y * 0.5 + 0.5) * h;
    return vis;
  }

  pickShip(sx: number, sy: number, w: number, h: number, radiusPx = 26): Ship | null {
    let best: Ship | null = null, bd = radiusPx;
    const o = new THREE.Vector3();
    for (const v of this.views.values()) {
      if (v.gone || v.ship.state !== 'alive') continue;
      if (!this.project(v.wpos, o, w, h)) continue;
      const d = Math.hypot(o.x - sx, o.y - sy);
      if (d < bd) { bd = d; best = v.ship; }
    }
    return best;
  }

  /** intersect a screen ray with the horizontal plane at height y */
  screenToPlane(sx: number, sy: number, w: number, h: number, y = 0): THREE.Vector3 | null {
    const ndc = new THREE.Vector2(sx / w * 2 - 1, -(sy / h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.rig.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out);
  }

  get stats() { return { glow: this.glow.active, smoke: this.smoke.active, wrecks: this.wrecks.length, draw: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles }; }
}

export { engineColor };
