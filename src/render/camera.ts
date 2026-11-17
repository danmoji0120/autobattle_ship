import * as THREE from 'three';

export type CamMode = 'tactical' | 'follow' | 'director';

export interface FollowTarget { pos: THREE.Vector3; fwd: THREE.Vector3; length: number; alive: boolean; vel?: THREE.Vector3 }

export interface ShotRequest {
  kind: 'chase' | 'orbit' | 'flyby' | 'low' | 'wide' | 'impact' | 'vista';
  subject: () => FollowTarget | null;
  /** 'vista': where the camera stands (a fixed vantage chosen by whoever asks for the shot) */
  at?: () => THREE.Vector3;
  look?: () => THREE.Vector3 | null;
  duration: number;
  priority: number;
  slowmo?: number;
}

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
/** the cinematic camera never cuts twice within this many seconds */
const MIN_CUT = 2.2;

// ── screen shake ─────────────────────────────────────────────────────────────────────────────────────────────
// One viewer setting for every battle screen (live spectating, replays, the combat lab), kept in the browser.
export type ShakeLevel = 'off' | 'low' | 'mid' | 'high';
export const SHAKE_LEVELS: { id: ShakeLevel; name: string }[] = [{ id: 'off', name: '끄기' }, { id: 'low', name: '약하게' }, { id: 'mid', name: '보통' }, { id: 'high', name: '강하게' }];
const SHAKE_KEY = 'siderarium.battle.shake';
export function loadShakeLevel(): ShakeLevel {
  try { const v = globalThis.localStorage?.getItem(SHAKE_KEY); if (v === 'off' || v === 'low' || v === 'mid' || v === 'high') return v; } catch { /* storage blocked */ }
  return 'low';
}
export function saveShakeLevel(l: ShakeLevel) { try { globalThis.localStorage?.setItem(SHAKE_KEY, l); } catch { /* storage blocked */ } }
/** what makes the screen shake: a gun firing, a hit landing, a ship blowing up, a scripted special effect */
export type ShakeKind = 'fire' | 'hit' | 'blast' | 'special';
/**
 * The shake is a rotation of the camera, not a movement: a rotation of θ moves the picture by θ × focal length on
 * screen whatever the distance to the subject, so a close zoom cannot turn a small camera offset into a violent
 * picture shake. MAX_DEG is the largest rotation (at the strongest setting, full trauma): ~0.6° ≈ 10 px at 900 px
 * height and 50° FOV. Per setting: the overall strength and the smallest event that may shake at all.
 */
const MAX_DEG = 0.6;
const LEVEL: Record<ShakeLevel, { gain: number; min: number }> = { off: { gain: 0, min: Infinity }, low: { gain: 0.45, min: 0.75 }, mid: { gain: 0.7, min: 0.5 }, high: { gain: 1, min: 0.3 } };
/** per camera mode: the tactical map never shakes; following a ship barely; the cinematic camera for big events */
const MODE_GAIN: Record<CamMode, number> = { tactical: 0, follow: 0.35, director: 1 };
/** smooth value noise (no high-frequency buzz): a few incommensurate low frequencies, 2–5 Hz */
const wobble = (t: number, seed: number) => (Math.sin(t * 13.1 + seed) * 0.5 + Math.sin(t * 21.7 + seed * 1.7) * 0.32 + Math.sin(t * 31.3 + seed * 2.3) * 0.18);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CamMode = 'tactical';
  // tactical / orbit state
  focus = new THREE.Vector3(0, 0, 0);
  yaw = 0.35; pitch = 0.95; dist = 3600;
  private cur = { focus: new THREE.Vector3(), yaw: 0.35, pitch: 0.95, dist: 3600 };
  follow: (() => FollowTarget | null) | null = null;
  /** shake "trauma" 0..1; the picture moves by trauma² (gentle small events, firm big ones) */
  shake = 0;
  private shakeT = 0;
  /** the trauma as actually shown: rises over ~40 ms instead of popping in a single frame */
  private shakeEnv = 0;
  shakeLevel: ShakeLevel = loadShakeLevel();
  /** what the last frame applied (for the HUD / checks): screen offset in px and roll in degrees */
  shakeOut = { px: 0, rollDeg: 0 };
  /** director cut log (elapsed seconds) — for checks */
  cuts: number[] = [];
  private lastInterrupt = -99;
  private followRef: THREE.Vector3 | null = null;
  private followBlend = 1;
  private viewH = 900;
  // director
  shot: (ShotRequest & { t: number; anchor: THREE.Vector3; side: number; start: number; fwd: THREE.Vector3; last: FollowTarget; lost: number }) | null = null;
  private lastCut = -99;
  timeScaleRequest = 1;
  private elapsed = 0;
  private camPos = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private smoothedLook = new THREE.Vector3();
  directorPick: (() => ShotRequest | null) | null = null;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(50, aspect, 2, 120000);
    this.cur.focus.copy(this.focus);
  }

  setMode(m: CamMode) {
    if (m === this.mode) return;
    this.mode = m;
    if (m === 'tactical') { this.pitch = Math.max(this.pitch, 0.7); this.dist = Math.max(this.dist, 1800); this.shake = 0; this.shakeEnv = 0; }
    if (m === 'follow') { this.dist = 0; }
    if (m === 'director') { this.shot = null; this.lastCut = -99; }
  }

  /**
   * an event near the camera wants the screen to shake. `a` is the old 0..3 strength already reduced by distance.
   * Gun fire never shakes except at the strongest setting; small events below the setting's floor do not shake;
   * repeated events do not pile up — the strongest wins and others add only a little.
   */
  addShake(a: number, kind: ShakeKind = 'hit') {
    const L = LEVEL[this.shakeLevel], m = MODE_GAIN[this.mode];
    if (!L.gain || !m || a < L.min) return;
    if (kind === 'fire' && this.shakeLevel !== 'high') return;
    if (this.mode === 'follow' && kind !== 'blast' && kind !== 'special') return;
    const t = Math.min(1, (a / 3) * (kind === 'fire' ? 0.4 : 1));
    // saturating combination: max of the two plus a quarter of the smaller (a barrage feels heavier, never runaway)
    this.shake = Math.min(1, Math.max(this.shake, t) + 0.25 * Math.min(this.shake, t));
  }
  setShakeLevel(l: ShakeLevel) { this.shakeLevel = l; if (l === 'off') { this.shake = 0; this.shakeEnv = 0; this.shakeOut.px = 0; this.shakeOut.rollDeg = 0; } }
  setViewHeight(h: number) { this.viewH = Math.max(200, h); }
  /** a brief hitch in time (seconds of real time at `scale`); only local, free-running battles slow down */
  slowPulse = 0; slowScale = 1;
  hitch(seconds: number, scale: number) { this.slowPulse = Math.max(this.slowPulse, seconds); this.slowScale = scale; }

  orbit(dx: number, dy: number) {
    this.yaw -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, this.mode === 'tactical' ? this.minPitch : -1.2, 1.52);
  }
  zoom(f: number) {
    if (this.mode === 'follow') { this.followZoom = THREE.MathUtils.clamp(this.followZoom * f, 0.35, 6); return; }
    this.dist = THREE.MathUtils.clamp(this.dist * f, this.minDist, this.maxDist);
  }
  followZoom = 1;
  minDist = 120;
  maxDist = 9000;
  minPitch = 0.12;
  pan(dx: number, dy: number) {
    const s = this.dist * 0.0011;
    const right = tmp.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fwd = tmp2.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.focus.addScaledVector(right, -dx * s).addScaledVector(fwd, dy * s);
  }

  /** request a director shot (only used in director mode) */
  offer(req: ShotRequest) {
    if (this.mode !== 'director') return;
    const since = this.elapsed - this.lastCut;
    if (this.shot) {
      const cur = this.shot;
      // never two cuts within MIN_CUT seconds; a shot holds at least ~60 % of its length (max 3.5 s) unless something
      // more important happens; ordinary interest (a torpedo launch, a hit) may interrupt at most every 8 s
      if (since < MIN_CUT) return;
      const minHold = Math.min(cur.duration * 0.6, 3.5);
      if (req.priority < 9 && (req.priority <= cur.priority || since < minHold || this.elapsed - this.lastInterrupt < 8)) return;
      if (req.priority >= 9 && (req.priority < cur.priority || (req.priority === cur.priority && since < minHold))) return;
    }
    this.lastInterrupt = this.elapsed;
    this.cut(req);
  }

  private cut(req: ShotRequest) {
    const s = req.subject();
    if (!s) return;
    this.lastCut = this.elapsed;
    const side = Math.random() < 0.5 ? -1 : 1;
    const anchor = new THREE.Vector3();
    if (req.kind === 'flyby' || req.kind === 'impact') {
      // a fixed camera placed ahead of the subject's path
      const v = s.vel && s.vel.lengthSq() > 1 ? s.vel.clone().normalize() : s.fwd.clone();
      const right = new THREE.Vector3().crossVectors(v, new THREE.Vector3(0, 1, 0)).normalize();
      const L = Math.max(s.length, 14);
      anchor.copy(s.pos).addScaledVector(v, L * (req.kind === 'impact' ? 1.5 : 4)).addScaledVector(right, side * L * 2.2).add(new THREE.Vector3(0, L * 0.5 * (Math.random() < 0.5 ? 1 : -0.4), 0));
      if (req.kind === 'impact') anchor.copy(s.pos).addScaledVector(right, side * L * 3.5).add(new THREE.Vector3(0, L * 1.2, 0)).addScaledVector(v, -L);
    }
    this.shot = { ...req, t: 0, anchor, side, start: this.elapsed, fwd: s.fwd.clone(), last: { pos: s.pos.clone(), fwd: s.fwd.clone(), length: s.length, alive: s.alive }, lost: -1 };
    this.timeScaleRequest = req.slowmo ?? 1;
    this.cuts.push(this.elapsed); if (this.cuts.length > 200) this.cuts.shift();
  }

  update(dt: number, realDt: number) {
    this.elapsed += realDt;
    const cam = this.camera;
    const k = 1 - Math.exp(-realDt * 4);
    if (this.mode === 'tactical') {
      this.cur.focus.lerp(this.focus, k); this.cur.yaw += (this.yaw - this.cur.yaw) * k; this.cur.pitch += (this.pitch - this.cur.pitch) * k; this.cur.dist += (this.dist - this.cur.dist) * k;
      this.placeOrbit(this.cur.focus, this.cur.yaw, this.cur.pitch, this.cur.dist);
      this.timeScaleRequest = 1;
    } else if (this.mode === 'follow') {
      const t = this.follow?.();
      if (!t) { this.setMode('tactical'); return; }
      this.focus.copy(t.pos);
      const L = Math.max(t.length, 14) * this.followZoom;
      const d = L * 3.2 + 30;
      // a new target (the followed ship died, or another was picked): glide over instead of snapping across
      if (t.pos !== this.followRef) { if (this.followRef) this.followBlend = 0; this.followRef = t.pos; }
      this.followBlend = Math.min(1, this.followBlend + realDt / 1.2);
      this.cur.focus.lerp(t.pos, 1 - Math.exp(-realDt * (1.5 + 6.5 * this.followBlend * this.followBlend)));
      this.cur.yaw += (this.yaw - this.cur.yaw) * k; this.cur.pitch += (THREE.MathUtils.clamp(this.pitch, -1.2, 1.4) - this.cur.pitch) * k;
      this.cur.dist += (d - this.cur.dist) * k;
      this.placeOrbit(this.cur.focus, this.cur.yaw, this.cur.pitch * 0.5, this.cur.dist);
      this.timeScaleRequest = 1;
    } else {
      this.updateDirector(dt, realDt);
    }
    if (this.slowPulse > 0) { this.slowPulse -= realDt; this.timeScaleRequest = Math.min(this.timeScaleRequest, this.slowScale); }
    this.applyShake(realDt);
  }

  /** rotate the already placed camera by the shake (after lookAt, so the smoothed camera state is never disturbed) */
  private applyShake(realDt: number) {
    const L = LEVEL[this.shakeLevel], m = MODE_GAIN[this.mode];
    if (!L.gain || !m || (this.shake <= 0.002 && this.shakeEnv <= 0.002)) { this.shake = 0; this.shakeEnv = 0; this.shakeOut.px = 0; this.shakeOut.rollDeg = 0; return; }
    this.shakeT += realDt;
    this.shakeEnv = this.shake > this.shakeEnv ? this.shakeEnv + (this.shake - this.shakeEnv) * (1 - Math.exp(-realDt * 25)) : this.shake;
    const amp = this.shakeEnv * this.shakeEnv * L.gain * m;           // 0..1
    const maxRad = THREE.MathUtils.degToRad(MAX_DEG) * amp;
    let yaw = wobble(this.shakeT, 0.3) * maxRad, pitch = wobble(this.shakeT, 2.1) * maxRad;
    const roll = wobble(this.shakeT, 4.7) * maxRad * 0.5;
    const r = Math.hypot(yaw, pitch); if (r > maxRad) { yaw *= maxRad / r; pitch *= maxRad / r; }   // radial cap
    this.camera.rotateY(yaw); this.camera.rotateX(pitch); this.camera.rotateZ(roll);
    // what that rotation is on screen: px = angle × focal length (independent of zoom / distance)
    const focal = this.viewH / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.shakeOut.px = Math.hypot(yaw, pitch) * focal; this.shakeOut.rollDeg = THREE.MathUtils.radToDeg(roll);
    // linear decay of the trauma: a full shake fades out in ~0.9 s, a light one in a fraction of that
    this.shake = Math.max(0, this.shake - realDt * 1.1);
  }

  private placeOrbit(focus: THREE.Vector3, yaw: number, pitch: number, dist: number) {
    const cp = Math.cos(pitch);
    this.camera.position.set(focus.x + Math.sin(yaw) * cp * dist, focus.y + Math.sin(pitch) * dist, focus.z + Math.cos(yaw) * cp * dist);
    this.camera.lookAt(focus);
  }

  private updateDirector(dt: number, realDt: number) {
    const shotDone = !this.shot || this.elapsed - this.shot.start > this.shot.duration;
    if (shotDone && this.elapsed - this.lastCut >= MIN_CUT) {
      const next = this.directorPick?.();
      if (next) this.cut(next);
    }
    let sh = this.shot;
    let s = sh?.subject() ?? null;
    if (sh) {
      if (s) { sh.last.pos.copy(s.pos); sh.last.fwd.copy(s.fwd); sh.last.length = s.length; sh.last.alive = s.alive; sh.lost = -1; }
      else {
        // the subject vanished (destroyed / despawned): hold on where it was for a beat instead of jumping away
        if (sh.lost < 0) sh.lost = this.elapsed;
        if (this.elapsed - sh.lost < 1.2) s = sh.last;
        else { this.shot = null; sh = null; }
      }
    }
    if (!sh || !s) {
      // fallback wide shot on the battle centre — glide into it, never snap
      this.cur.yaw += realDt * 0.03;
      const cp = Math.cos(0.45);
      tmp.set(this.focus.x + Math.sin(this.cur.yaw) * cp * 2200, this.focus.y + Math.sin(0.45) * 2200, this.focus.z + Math.cos(this.cur.yaw) * cp * 2200);
      const kf = 1 - Math.exp(-realDt * 1.5);
      this.camera.position.lerp(tmp, kf); this.smoothedLook.lerp(this.focus, kf);
      this.camera.lookAt(this.smoothedLook);
      return;
    }
    // heading used for framing: eased toward the hull's real heading so a hard turn swings the camera gently
    sh.fwd.lerp(s.fwd, 1 - Math.exp(-realDt * 2)); if (sh.fwd.lengthSq() < 1e-6) sh.fwd.copy(s.fwd); sh.fwd.normalize();
    const fwd = sh.fwd;
    if (sh.slowmo && this.elapsed - sh.start > 2.2) this.timeScaleRequest = 1;
    sh.t += realDt;
    const L = Math.max(s.length, 14);
    const look = sh.look?.() ?? null;
    const want = this.camPos;
    const lookAt = this.lookAt;
    switch (sh.kind) {
      case 'chase': {
        // behind and above the subject, looking past it at its target
        const back = fwd.clone().multiplyScalar(-L * 2.3);
        want.copy(s.pos).add(back).add(new THREE.Vector3(0, L * 0.55, 0)).addScaledVector(new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(), sh.side * L * 0.8);
        if (look) lookAt.copy(look).lerp(s.pos, 0.7); else lookAt.copy(s.pos).addScaledVector(fwd, L * 3);
        break;
      }
      case 'orbit': {
        const a = sh.side * sh.t * 0.12 + sh.start;
        const d = L * 3.4 + 40;
        want.set(s.pos.x + Math.sin(a) * d, s.pos.y + L * 0.6, s.pos.z + Math.cos(a) * d);
        lookAt.copy(s.pos);
        if (look) lookAt.lerp(look, 0.15);
        break;
      }
      case 'low': {
        // low broadside angle, looking up at the hull
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        want.copy(s.pos).addScaledVector(right, sh.side * L * 1.7).addScaledVector(fwd, L * (0.9 - sh.t * 0.06)).add(new THREE.Vector3(0, -L * 0.35, 0));
        lookAt.copy(s.pos).addScaledVector(fwd, -L * 0.2);
        break;
      }
      case 'flyby': case 'impact': {
        want.copy(sh.anchor);
        lookAt.copy(s.pos);
        break;
      }
      case 'vista': {
        // a slow drift around the vantage so the picture is never frozen
        const p = sh.at ? sh.at() : s.pos;
        want.copy(p).add(tmp.set(Math.sin(sh.t * 0.22) * L * 0.25, sh.t * L * 0.03, Math.cos(sh.t * 0.22) * L * 0.25));
        lookAt.copy(look ?? s.pos);
        break;
      }
      case 'wide': {
        const a = sh.start * 0.7 + sh.t * 0.04;
        want.set(s.pos.x + Math.sin(a) * 1500, s.pos.y + 450, s.pos.z + Math.cos(a) * 1500);
        lookAt.copy(look ?? s.pos);
        break;
      }
    }
    const fresh = this.elapsed - sh.start < realDt * 1.5;
    if (fresh) { this.camera.position.copy(want); this.smoothedLook.copy(lookAt); }
    else {
      const kk = sh.kind === 'flyby' || sh.kind === 'impact' ? 1 : 1 - Math.exp(-realDt * 3);
      this.camera.position.lerp(want, kk);
      this.smoothedLook.lerp(lookAt, 1 - Math.exp(-realDt * 6));
    }
    this.camera.lookAt(this.smoothedLook);
    void dt;
  }
}
