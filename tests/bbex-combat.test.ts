// BB-EX in the deterministic battle engine: ordinary battles are untouched, a battle with BB-EX is
// reproducible and replayable, and its systems really decide the fight (trials: scripts/bbex-trials.ts).
import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import '../src/content/registry';
import { defaultPlayerFleet } from '../src/sim/fleet';
import { SCENARIOS } from '../src/sim/data/scenarios';
import { TRIALS, trialSetup, angelDescentSetup, bbexFleet, lineFleet } from '../src/sim/bbex/trials';
import { exReport } from '../src/sim/bbex/system';
import { BBEX } from '../src/sim/bbex/data';
import type { SimEvent } from '../src/sim/types';

const run = (w: World, until = Infinity) => { const ev: SimEvent[] = []; while (!w.outcome && w.time < until) { w.step(); ev.push(...w.events); } return ev; };
const trial = (id: string) => TRIALS.find(t => t.id === id)!;

describe('ordinary battles are bit-identical to before BB-EX existed', () => {
  // digests recorded on the commit before any BB-EX code (scripts/bbex-baseline.ts)
  const BASE: Record<string, string> = { 'kestrel:1': '831fddab', 'kestrel:7': 'afe6192', 'kestrel:42': 'c2d22899', 'bastion:1': '1bd18d33', 'bastion:7': 'e2c95024', 'bastion:42': '43818fcf', 'wolfpack:1': 'db5f8ed3', 'wolfpack:7': 'e3ef12e6', 'wolfpack:42': '7bb0b8c2' };
  it.each(Object.keys(BASE))('%s', key => {
    const [id, seed] = key.split(':');
    const w = new World({ seed: Number(seed), scenarioId: id, fleets: [defaultPlayerFleet(), SCENARIOS.find(s => s.id === id)!.enemy] });
    while (w.time < 150 && !w.outcome) w.step();
    expect(w.digest()).toBe(BASE[key]);
    expect(w.exShips).toHaveLength(0);
  });
});

describe('a battle with BB-EX is deterministic and replayable', () => {
  it('same seed → same state, events and lattice; different seed diverges', () => {
    const a = new World(trialSetup(trial('aa'), 5)), b = new World(trialSetup(trial('aa'), 5)), c = new World(trialSetup(trial('aa'), 6));
    const ea = run(a, 45), eb = run(b, 45); run(c, 45);
    expect(a.digest()).toBe(b.digest());
    expect(a.digest()).not.toBe(c.digest());
    const fires = (ev: SimEvent[]) => JSON.stringify(ev.filter(e => e.t === 'exDcpFire' || e.t === 'exCausal' || e.t === 'exShift' || e.t === 'exWell'));
    expect(fires(ea)).toBe(fires(eb));
    expect(ea.filter(e => e.t === 'exDcpFire').length).toBeGreaterThan(0);
    expect(a.radioLog.map(r => r.text)).toEqual(b.radioLog.map(r => r.text));
  });
  it('recorded orders replay to the same digest (lockstep spectators see the authority\'s battle)', () => {
    const live = new World(angelDescentSetup(3, { n: 60, arrive: 8 }));
    run(live, 12);
    const g = live.groups.find(x => x.team === 0 && x.shipIds.length && !live.shipById.get(x.shipIds[0])!.ex)!;
    live.issueOrder(g.id, { type: 'hold' });
    run(live, 40);
    const replay = new World(angelDescentSetup(3, { n: 60, arrive: 8 }));
    replay.scheduleReplay(JSON.parse(JSON.stringify(live.orderLog)));
    run(replay, 40);
    expect(replay.digest()).toBe(live.digest());
  });
});

describe('the systems do what they say', () => {
  it('arrives through the rift, then fights: 45 mounts, 12 funnels, every exclusive weapon scores', () => {
    const w = new World(trialSetup(trial('aa'), 2));
    const s = w.exShips[0];
    expect(s.state).toBe('inbound'); expect(s.mounts).toHaveLength(45); expect(s.ex!.funnels).toHaveLength(12);
    const ev = run(w);
    const order = ['exRift', 'exDescent', 'exDcpCharge', 'exDcpFire'].map(t => ev.findIndex(e => e.t === t));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(ev.filter(e => e.t === 'exFunnel' && e.e === 'launch').length).toBeGreaterThanOrEqual(12);
    expect(w.outcome!.winner).toBe(0);
    const r = exReport(s);
    for (const id of ['dcp_omega', 'abyss_lance', 'violet_edge', 'lilac_stinger', 'seraph_ex', 'fnl_ex']) expect(r.weapons[id]?.dmg ?? 0, id).toBeGreaterThan(0);
    expect(r.paradox.displaced).toBeGreaterThan(0);
    expect(r.blackouts).toBeGreaterThan(0);
  });
  it('the lattice that is drawn is the lattice that cuts: every DCP hit lies on an announced segment', () => {
    const w = new World(trialSetup(trial('mixed200'), 1));
    let segs: { a: any; b: any; w: number }[] = [], checked = 0, splits = 0, reflections = 0;
    while (!w.outcome && w.time < 45) {
      w.step();
      for (const e of w.events) {
        if (e.t === 'exDcpFire') { segs = e.segs; reflections += e.nodes.length; splits += e.nodes.filter(n => n.split >= 2).length; expect(Math.max(...e.segs.map(s => s.gen))).toBeGreaterThanOrEqual(2); }
        if (e.t === 'hit' && e.weapon === 'dcp_omega' && e.result === 'cut') {
          // distance from the hit point to the nearest announced segment
          let best = Infinity;
          for (const s of segs) {
            const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, dz = s.b.z - s.a.z, L2 = dx * dx + dy * dy + dz * dz;
            const t = Math.max(0, Math.min(1, ((e.pos.x - s.a.x) * dx + (e.pos.y - s.a.y) * dy + (e.pos.z - s.a.z) * dz) / L2));
            best = Math.min(best, Math.hypot(e.pos.x - s.a.x - dx * t, e.pos.y - s.a.y - dy * t, e.pos.z - s.a.z - dz * t));
          }
          expect(best).toBeLessThan(0.01); checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50); expect(reflections).toBeGreaterThan(3); expect(splits).toBeGreaterThan(0);
  });
  it('commander BB changes outcomes: vetoes a lethal blow, strikes out a landed hit, rewrites a glancing shot', () => {
    const fleet = () => lineFleet('연합', [['battleship', 'std', 12]]);
    const withBB = new World({ seed: 4, scenarioId: 'kestrel', layout: 'ranks', fleets: [bbexFleet({ paradox: 0, over: false }), fleet()] });
    const s = withBB.exShips[0];
    expect(s.ex!.causal.on).toBe(true);
    const ev = run(withBB, 30);
    expect(s.ex!.causal.rewrites).toBeGreaterThan(0);
    expect(ev.some(e => e.t === 'exCausal' && e.what === 'rewrite')).toBe(true);
    // a hit that would kill is rejected — three times, not more
    s.hp = 1; s.ex!.paradox.overload = 99; s.ex!.causal.denyNext = Infinity;
    const big = { ...withBB.ships.find(x => x.team === 1)!.mounts[0].weapon, damage: 9e5, pen: 999 };
    const veto = () => withBB.events.some(e => e.t === 'exCausal' && e.what === 'veto');
    const strike = () => { withBB.events.length = 0; for (let i = 0; i < 60 && s.state === 'alive' && !veto(); i++) withBB.applyHit(s, big, withBB.ships.find(x => x.team === 1)!.id, s.pos.clone(), s.fwd.clone().scale(-1), 'shell'); return veto(); };
    for (let k = 0; k < BBEX.cVetoes; k++) { expect(strike(), `veto ${k + 1}`).toBe(true); expect(s.state).toBe('alive'); s.ex!.causal.next = 0; s.ex!.paradox.overload = 99; s.hp = 1; }
    expect(strike()).toBe(false); expect(s.state).toBe('dying');
    // deny: a heavy hit on the bare hull is struck from the record
    const w2 = new World({ seed: 4, scenarioId: 'kestrel', layout: 'ranks', fleets: [bbexFleet({ paradox: 0, over: false }), fleet()] });
    const s2 = w2.exShips[0]; run(w2, 12);
    s2.ex!.paradox.overload = 99; const hp = s2.hp;
    let denied = false;
    for (let i = 0; i < 60 && !denied; i++) { w2.events.length = 0; w2.applyHit(s2, { ...big, damage: 800 }, w2.ships.find(x => x.team === 1)!.id, s2.pos.clone(), s2.fwd.clone().scale(-1), 'shell'); denied = w2.events.some(e => e.t === 'exCausal' && e.what === 'deny'); }
    expect(denied).toBe(true); expect(s2.ex!.causal.denies).toBe(1); expect(s2.hp).toBeLessThanOrEqual(hp);
    // without BB none of it exists
    const noBB = new World({ seed: 4, scenarioId: 'kestrel', layout: 'ranks', fleets: [bbexFleet({}, false), fleet()] });
    run(noBB, 30);
    expect(noBB.exShips[0].ex!.causal.on).toBe(false); expect(noBB.exShips[0].ex!.causal.rewrites).toBe(0); expect(noBB.exShips[0].ex!.over.n).toBe(0);
  });
  it('options isolate systems: no DCP-Ω, lost funnels, an overloaded PARADOX, the decisive protocol', () => {
    const base = trial('aa');
    const a = new World(trialSetup({ ...base, ex: { dcp: false } }, 1)); const ea = run(a, 40);
    expect(ea.some(e => e.t === 'exDcpFire')).toBe(false); expect(a.exShips[0].stats.kills).toBeGreaterThan(0);
    const b = new World(trialSetup({ ...base, ex: { funnels: 4, rebuild: false } }, 1)); run(b, 25);
    expect(b.exShips[0].ex!.funnels.filter(f => f.alive).length).toBeLessThanOrEqual(4);
    const c = new World(trialSetup({ ...base, ex: { paradox: 0 } }, 1)); const ec = run(c, 6);
    expect(ec.some(e => e.t === 'exOverload' && e.on)).toBe(true);
    const d = new World(trialSetup({ ...base, ex: { over: true } }, 1)); const ed = run(d, 30);
    expect(ed.some(e => e.t === 'exGameOver' && e.on)).toBe(true);
    const go = ed.filter(e => e.t === 'exDcpFire' && e.over);
    expect(go.length).toBeGreaterThanOrEqual(2); expect(Math.max(...go.map(e => e.t === 'exDcpFire' ? e.segs.length : 0))).toBeGreaterThan(20);
  });
});
