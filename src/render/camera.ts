import * as THREE from 'three';

export type CamMode = 'tactical' | 'follow' | 'director';

export interface FollowTarget { pos: THREE.Vector3; fwd: THREE.Vector3; length: number; alive: boolean; vel?: THREE.Vector3 }

export interface ShotRequest {
  kind: 'chase' | 'orbit' | 'flyby' | 'low' | 'wide' | 'impact';
  subject: () => FollowTarget | null;
  look?: () => THREE.Vector3 | null;
  duration: number;
  priority: number;
  slowmo?: number;
}

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CamMode = 'tactical';
  // tactical / orbit state
  focus = new THREE.Vector3(0, 0, 0);
  yaw = 0.35; pitch = 0.95; dist = 3600;
  private cur = { focus: new THREE.Vector3(), yaw: 0.35, pitch: 0.95, dist: 3600 };
  follow: (() => FollowTarget | null) | null = null;
  shake = 0;
  private shakeT = 0;
  // director
  shot: (ShotRequest & { t: number; anchor: THREE.Vector3; side: number; start: number }) | null = null;
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
    if (m === 'tactical') { this.pitch = Math.max(this.pitch, 0.7); this.dist = Math.max(this.dist, 1800); }
    if (m === 'follow') { this.dist = 0; }
    if (m === 'director') { this.shot = null; this.lastCut = -99; }
  }

  addShake(a: number) { this.shake = Math.min(3, this.shake + a); }

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
    const minHold = this.shot ? Math.min(this.shot.duration * 0.6, 3.5) : 0;
    const since = this.elapsed - this.lastCut;
    if (this.shot && (req.priority <= this.shot.priority || since < minHold) && !(req.priority >= 9 && since > 1)) return;
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
    this.shot = { ...req, t: 0, anchor, side, start: this.elapsed };
    this.timeScaleRequest = req.slowmo ?? 1;
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
      this.cur.focus.lerp(t.pos, 1 - Math.exp(-realDt * 8));
      this.cur.yaw += (this.yaw - this.cur.yaw) * k; this.cur.pitch += (THREE.MathUtils.clamp(this.pitch, -1.2, 1.4) - this.cur.pitch) * k;
      this.cur.dist += (d - this.cur.dist) * k;
      this.placeOrbit(this.cur.focus, this.cur.yaw, this.cur.pitch * 0.5, this.cur.dist);
      this.timeScaleRequest = 1;
    } else {
      this.updateDirector(dt, realDt);
    }
    // shake
    if (this.shake > 0.001) {
      this.shakeT += realDt * 40;
      const a = this.shake * this.shake * (this.mode === 'tactical' ? 0.6 : 1.4);
      cam.position.x += Math.sin(this.shakeT * 1.3) * a; cam.position.y += Math.sin(this.shakeT * 1.7 + 1) * a; cam.position.z += Math.sin(this.shakeT * 1.1 + 2) * a;
      this.shake *= Math.exp(-realDt * 3.5);
    }
  }

  private placeOrbit(focus: THREE.Vector3, yaw: number, pitch: number, dist: number) {
    const cp = Math.cos(pitch);
    this.camera.position.set(focus.x + Math.sin(yaw) * cp * dist, focus.y + Math.sin(pitch) * dist, focus.z + Math.cos(yaw) * cp * dist);
    this.camera.lookAt(focus);
  }

  private updateDirector(dt: number, realDt: number) {
    const shotDone = !this.shot || this.elapsed - this.shot.start > this.shot.duration;
    if (shotDone) {
      const next = this.directorPick?.();
      if (next) this.cut(next);
    }
    const sh = this.shot;
    const s = sh?.subject();
    if (!sh || !s) {
      // fallback wide shot on the battle centre
      this.cur.yaw += realDt * 0.03;
      this.placeOrbit(this.focus, this.cur.yaw, 0.45, 2200);
      return;
    }
    if (sh.slowmo && this.elapsed - sh.start > 2.2) this.timeScaleRequest = 1;
    sh.t += realDt;
    const L = Math.max(s.length, 14);
    const look = sh.look?.() ?? null;
    const want = this.camPos;
    const lookAt = this.lookAt;
    switch (sh.kind) {
      case 'chase': {
        // behind and above the subject, looking past it at its target
        const back = s.fwd.clone().multiplyScalar(-L * 2.3);
        want.copy(s.pos).add(back).add(new THREE.Vector3(0, L * 0.55, 0)).addScaledVector(new THREE.Vector3().crossVectors(s.fwd, new THREE.Vector3(0, 1, 0)).normalize(), sh.side * L * 0.8);
        if (look) lookAt.copy(look).lerp(s.pos, 0.7); else lookAt.copy(s.pos).addScaledVector(s.fwd, L * 3);
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
        const right = new THREE.Vector3().crossVectors(s.fwd, new THREE.Vector3(0, 1, 0)).normalize();
        want.copy(s.pos).addScaledVector(right, sh.side * L * 1.7).addScaledVector(s.fwd, L * (0.9 - sh.t * 0.06)).add(new THREE.Vector3(0, -L * 0.35, 0));
        lookAt.copy(s.pos).addScaledVector(s.fwd, -L * 0.2);
        break;
      }
      case 'flyby': case 'impact': {
        want.copy(sh.anchor);
        lookAt.copy(s.pos);
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
