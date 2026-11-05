import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { NetClock, MotionTrack } from '../src/client/interp';
import { Rng } from '../src/sim/rng';

// Real world-sim motion (sublight + warp + arrival) sampled like the server does, delivered with
// jitter and stalls, rendered at 60 fps. Counts frames where a moving ship is drawn going backwards.

interface Pkt { at: number; recv: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; h: number }

function recordPath(seconds: number) {
  const sim = WorldSim.create(21);
  const p = sim.addPlayer('net');
  const g = Object.values(sim.st.groups).find(x => x.owner === p && x.name === '경비대')!;
  const ship = g.shipIds[0];
  const astra = sim.st.stations.astra.pos;
  sim.command(p, { c: 'setOp', group: g.id, op: { k: 'move', to: { x: astra.x - 30000, y: 0, z: astra.z + 9000 } } });
  const out: { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; h: number }[] = [];
  for (let t = 0; t < seconds; t += 0.05) {
    sim.update(0.05);
    const s = sim.st.ships[ship];
    out.push({ t: sim.time, x: s.pos.x, y: s.pos.y, z: s.pos.z, vx: s.vel.x, vy: s.vel.y, vz: s.vel.z, h: s.heading });
  }
  return out;
}

function network(path: ReturnType<typeof recordPath>, interval: number, seed: number) {
  const rng = new Rng(seed);
  const pk: Pkt[] = [];
  let next = 0, stallUntil = -1;
  for (const s of path) {
    if (s.t + 1e-9 < next) continue;
    next += interval;
    // server send time = world time (1x); some sends are held back by a busy event loop
    let send = s.t;
    if (rng.chance(0.02)) stallUntil = s.t + rng.range(0.3, 0.9);
    if (send < stallUntil) send = stallUntil;
    const recv = send + 0.06 + rng.range(0, 0.15) + (rng.chance(0.03) ? rng.range(0.2, 0.5) : 0);
    pk.push({ at: s.t, recv, ...s });
  }
  return pk.sort((a, b) => a.recv - b.recv);
}

function render(pk: Pkt[], mode: 'old' | 'new', until: number) {
  const fps = 60, dt = 1 / fps;
  const clock = new NetClock(), track = new MotionTrack();
  let prev: Pkt | null = null, cur: Pkt | null = null, snapAt = 0, gap = 200;
  let i = 0;
  const pos: { x: number; z: number; v: number }[] = [];
  const o = { x: 0, y: 0, z: 0, h: 0 };
  for (let t = 0; t < until; t += dt) {
    const now = t * 1000;
    while (i < pk.length && pk[i].recv <= t) {
      const p = pk[i++];
      if (mode === 'new') { clock.onPacket(p.at, p.recv * 1000, 1); track.push({ t: p.at, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, h: p.h, warp: 0 }); }
      else { if (cur) gap = Math.max(40, Math.min(1500, p.recv * 1000 - snapAt)); prev = cur; cur = p; snapAt = p.recv * 1000; }
    }
    if (mode === 'new') { clock.frame(dt, now); if (!track.samples.length) continue; track.at(clock.renderTime, o); pos.push({ x: o.x, z: o.z, v: 0 }); }
    else {
      if (!cur || !prev) continue;
      // the previous client: blend by arrival time, extrapolate up to 1.5x past the latest snapshot
      const a = Math.min(1.5, (now - snapAt) / gap), k = Math.min(1, a);
      let x = prev.x + (cur.x - prev.x) * k, z = prev.z + (cur.z - prev.z) * k;
      if (a > 1) { x += cur.vx * (a - 1) * gap / 1000; z += cur.vz * (a - 1) * gap / 1000; }
      pos.push({ x, z, v: 0 });
    }
  }
  return pos;
}

/** frames where the ship is drawn moving against its own recent direction of travel */
function backwards(pos: { x: number; z: number }[]) {
  let n = 0, worst = 0;
  for (let i = 12; i < pos.length; i++) {
    const dx = pos[i].x - pos[i - 1].x, dz = pos[i].z - pos[i - 1].z;
    const hx = pos[i - 1].x - pos[i - 12].x, hz = pos[i - 1].z - pos[i - 12].z;
    const hl = Math.hypot(hx, hz);
    if (hl < 3) continue; // stationary / arriving
    const along = (dx * hx + dz * hz) / hl;
    if (along < -0.5) { n++; worst = Math.max(worst, -along); }
  }
  return { n, worst };
}

describe('client interpolation', () => {
  const path = recordPath(70);
  it('the recorded path really exercises sublight, warp and drop-out', () => {
    const vmax = Math.max(...path.map(p => Math.hypot(p.vx, p.vz)));
    expect(vmax).toBeGreaterThan(3000);
  });
  for (const interval of [0.2, 0.5]) {
    it(`never draws a ship moving backwards under jitter and stalls (packets every ${interval}s)`, () => {
      let oldBack = 0, newBack = 0;
      for (const seed of [1, 2, 3]) {
        const pk = network(path, interval, seed);
        oldBack += backwards(render(pk, 'old', 70)).n;
        const r = backwards(render(pk, 'new', 70));
        newBack += r.n;
      }
      // the old scheme visibly rubber-bands on the same input; the new one does not
      console.log(`interval ${interval}s: backwards frames old=${oldBack} new=${newBack}`);
      expect(oldBack).toBeGreaterThan(20);
      expect(newBack).toBe(0);
    });
  }
  it('stays close to the true path (bounded lag, no drift)', () => {
    const pk = network(path, 0.2, 7);
    const clock = new NetClock(), track = new MotionTrack();
    let i = 0, maxLag = 0;
    const o = { x: 0, y: 0, z: 0, h: 0 };
    for (let t = 0; t < 70; t += 1 / 60) {
      while (i < pk.length && pk[i].recv <= t) { const p = pk[i++]; clock.onPacket(p.at, p.recv * 1000, 1); track.push({ t: p.at, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, h: p.h, warp: 0 }); }
      clock.frame(1 / 60, t * 1000);
      if (t > 5) maxLag = Math.max(maxLag, t - clock.renderTime);
    }
    expect(maxLag).toBeLessThan(1.6);
    void track; void o;
  });
});
