import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig, type ShakeLevel, type ShotRequest, type FollowTarget } from '../src/render/camera';

const H = 900;
const rig = (mode: 'tactical' | 'follow' | 'director', level: ShakeLevel = 'low') => {
  const r = new CameraRig(16 / 9); r.setViewHeight(H); r.setShakeLevel(level);
  const ship: FollowTarget = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), length: 120, alive: true };
  r.follow = () => ship;
  r.directorPick = () => ({ kind: 'wide', subject: () => ship, duration: 6, priority: 1 });
  r.setMode(mode);
  return { r, ship };
};
/** run `seconds` at 60 fps calling `each` every frame; returns the largest screen offset seen */
const run = (r: CameraRig, seconds: number, each?: (i: number) => void) => {
  let max = 0;
  for (let i = 0; i < seconds * 60; i++) { each?.(i); r.update(1 / 60, 1 / 60); max = Math.max(max, r.shakeOut.px); }
  return max;
};
/** the strongest shake allowed on screen: 0.6° × focal length at 50° FOV */
const capPx = THREE.MathUtils.degToRad(0.6) * (H / 2 / Math.tan(THREE.MathUtils.degToRad(25)));

describe('battle camera shake', () => {
  it('ordinary gun fire never shakes at the default setting, in any mode', () => {
    for (const m of ['tactical', 'follow', 'director'] as const) {
      const { r } = rig(m, 'low');
      expect(run(r, 3, () => r.addShake(0.9, 'fire')), m).toBe(0);
    }
  });

  it('the tactical map never shakes, whatever the event or setting', () => {
    const { r } = rig('tactical', 'high');
    expect(run(r, 2, i => { if (i % 10 === 0) r.addShake(3, 'blast'); r.addShake(3, 'special'); })).toBe(0);
  });

  it('follow mode shakes very weakly and only for explosions / special weapons', () => {
    const { r } = rig('follow', 'high');
    expect(run(r, 1, () => r.addShake(1.6, 'hit'))).toBe(0);
    const px = run(r, 1.5, i => { if (i === 0) r.addShake(3, 'blast'); });
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThanOrEqual(capPx * 0.35 + 1e-6);
  });

  it('a barrage does not accumulate beyond the cap; the strongest setting peaks at ~10 px', () => {
    const { r } = rig('director', 'high');
    const px = run(r, 4, () => { r.addShake(3, 'blast'); r.addShake(3, 'special'); r.addShake(1.6, 'hit'); });
    expect(r.shake).toBeLessThanOrEqual(1);
    expect(px).toBeLessThanOrEqual(capPx + 1e-6);
    expect(capPx).toBeGreaterThan(9); expect(capPx).toBeLessThan(11.5);
  });

  it('settings scale the picture and drop small events (off < low < mid < high)', () => {
    const peak = (l: ShakeLevel) => { const { r } = rig('director', l); return run(r, 1.5, i => { if (i === 0) r.addShake(2.4, 'blast'); }); };
    const p = { off: peak('off'), low: peak('low'), mid: peak('mid'), high: peak('high') };
    expect(p.off).toBe(0);
    expect(p.low).toBeGreaterThan(0); expect(p.mid).toBeGreaterThan(p.low); expect(p.high).toBeGreaterThan(p.mid);
    // a light hit (below the default floor) does nothing at "약하게"
    const { r } = rig('director', 'low');
    expect(run(r, 1, i => { if (i === 0) r.addShake(0.6, 'hit'); })).toBe(0);
  });

  it('decays naturally to rest within about a second', () => {
    const { r } = rig('director', 'high');
    r.addShake(3, 'blast');
    run(r, 0.5); expect(r.shake).toBeGreaterThan(0);
    run(r, 0.6); expect(r.shake).toBe(0); expect(r.shakeOut.px).toBe(0);
  });

  it('is smooth: the shake offset changes little from frame to frame (no high-frequency buzz)', () => {
    const a = rig('director', 'off'), b = rig('director', 'high');
    let maxStep = 0, prev = 0;
    for (let i = 0; i < 90; i++) {
      if (i === 5) b.r.addShake(3, 'blast');
      a.r.update(1 / 60, 1 / 60); b.r.update(1 / 60, 1 / 60);
      const off = THREE.MathUtils.radToDeg(a.r.camera.quaternion.angleTo(b.r.camera.quaternion));
      if (i > 0) maxStep = Math.max(maxStep, Math.abs(off - prev)); prev = off;
    }
    // full strength is 0.6°; 2–5 Hz motion moves it at most ~0.2° per 60 fps frame
    expect(maxStep).toBeLessThan(0.22);
  });

  it('"끄기" stops a shake in progress immediately', () => {
    const { r } = rig('director', 'high');
    r.addShake(3, 'blast'); r.update(1 / 60, 1 / 60); expect(r.shakeOut.px).toBeGreaterThan(0);
    r.setShakeLevel('off'); expect(r.shake).toBe(0);
    expect(run(r, 0.5, () => r.addShake(3, 'blast'))).toBe(0);
  });

  it('does not move the camera position (rotation only), so camera smoothing is never disturbed', () => {
    const a = rig('director', 'off'), b = rig('director', 'high');
    for (let i = 0; i < 120; i++) { if (i % 20 === 0) b.r.addShake(3, 'blast'); a.r.update(1 / 60, 1 / 60); b.r.update(1 / 60, 1 / 60); }
    expect(b.r.camera.position.distanceTo(a.r.camera.position)).toBeLessThan(1e-6);
  });
});

describe('cinematic camera pacing', () => {
  const shot = (priority: number, subject: () => FollowTarget | null, duration = 6): ShotRequest => ({ kind: 'chase', subject, duration, priority });

  it('keeps at least 2.2 s between cuts even under a flood of high-priority requests', () => {
    const { r, ship } = rig('director', 'low');
    run(r, 30, () => r.offer(shot(10, () => ship)));
    const gaps = r.cuts.slice(1).map((t, i) => t - r.cuts[i]);
    expect(gaps.length).toBeGreaterThan(3);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2.2 - 1e-9);
  });

  it('ordinary interest interrupts at most every 8 s', () => {
    const { r, ship } = rig('director', 'low');
    let p = 2; run(r, 40, i => { if (i % 30 === 0) r.offer(shot(Math.min(8, p++), () => ship, 20)); });
    const gaps = r.cuts.slice(1).map((t, i) => t - r.cuts[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3.5 - 1e-9);
    expect(r.cuts.length).toBeLessThanOrEqual(7);
  });

  it('holds on a destroyed subject instead of teleporting, then moves on smoothly', () => {
    const { r } = rig('director', 'off');
    const ship: FollowTarget = { pos: new THREE.Vector3(500, 0, 0), fwd: new THREE.Vector3(1, 0, 0), length: 100, alive: true };
    let gone = false;
    r.directorPick = () => null;
    r.offer(shot(10, () => gone ? null : ship));
    run(r, 1);
    const before = r.camera.position.clone();
    gone = true;
    r.update(1 / 60, 1 / 60);
    expect(r.camera.position.distanceTo(before)).toBeLessThan(30);
    let maxJump = 0, prev = r.camera.position.clone();
    run(r, 4, () => { maxJump = Math.max(maxJump, r.camera.position.distanceTo(prev)); prev.copy(r.camera.position); });
    // the old behaviour snapped ~2000 units to the wide shot in one frame
    expect(maxJump).toBeLessThan(120);
  });

  it('eases a hard turn of the subject instead of swinging the chase camera at once', () => {
    const { r } = rig('director', 'off');
    const ship: FollowTarget = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), length: 100, alive: true };
    r.offer(shot(10, () => ship, 30)); run(r, 2);
    const before = r.camera.position.clone();
    ship.fwd.set(0, 0, -1); // instant 180° flip
    run(r, 0.1);
    expect(r.camera.position.distanceTo(before)).toBeLessThan(60);
  });
});

describe('cinematic camera aim', () => {
  it('turns toward a new look target no faster than 90°/s (a pan, not a whip)', () => {
    const { r } = rig('director', 'off');
    const ship: FollowTarget = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), length: 100, alive: true };
    const look = new THREE.Vector3(0, 0, 2000);
    r.offer({ kind: 'orbit', subject: () => ship, look: () => look, duration: 30, priority: 10 });
    run(r, 2);
    look.set(2000, 0, -2000);   // the subject retargets far to the side
    const dir = new THREE.Vector3(), prev = new THREE.Vector3(); r.camera.getWorldDirection(prev);
    let maxStep = 0;
    run(r, 2, () => { r.camera.getWorldDirection(dir); maxStep = Math.max(maxStep, dir.angleTo(prev)); prev.copy(dir); });
    // 90°/s at 60 fps = 1.5° per frame, plus the slow orbit of the camera itself
    expect(THREE.MathUtils.radToDeg(maxStep)).toBeLessThan(2);
  });
});
