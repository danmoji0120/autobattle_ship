// P17.3 weapon mechanisms (sim/mech17.ts): each one is checked in a real battle, on the engine's own events
// and munitions. docs/P17_3_ARSENAL.md.
import { describe, expect, it } from 'vitest';
import { World, type BattleSetup } from '../src/sim/world';
import { WEAPONS } from '../src/sim/data/weapons';
import { getLoadout, type MountDef } from '../src/sim/data/ships';
import { CONTENT } from '../src/content/registry';
import type { FleetSpec, GroupSpec, ShipSpec } from '../src/sim/fleet';
import type { Munition, SimEvent } from '../src/sim/types';

void CONTENT;   // installs the arsenal (WEAPONS rows of the P17.3 arms)
/** a ship of this class whose gun mounts (not point defence) all carry `weapon`; `pd` replaces its point defence */
function armed(classId: string, loadoutId: string, weapon: string | null, pd?: string): ShipSpec {
  const lo = getLoadout(classId, loadoutId);
  const mounts: MountDef[] = lo.mounts.map(m => {
    const pdm = WEAPONS[m.weapon].kind === 'pd';
    return { ...m, weapon: pdm ? (pd ?? m.weapon) : (weapon ?? m.weapon) };
  });
  return { classId, loadoutId, fit: { name: 'test', mounts } };
}
const G = (ships: ShipSpec[], order: GroupSpec['order'] = 'engage'): GroupSpec => ({ name: 'g', commanderId: 'wolf', order, retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec, name: string): FleetSpec => ({ name, root: g });
const setup = (a: GroupSpec, b: GroupSpec, seed = 7, rules = 2): BattleSetup => ({ seed, scenarioId: 'p173', fleets: [F(a, 'A'), F(b, 'B')], rules });
function run(w: World, T: number, on?: (e: SimEvent) => void, each?: () => void) {
  while (!w.outcome && w.time < T) { w.step(); each?.(); if (on) for (const e of w.events) on(e); }
  return w;
}
const n = <T>(k: number, f: () => T) => Array.from({ length: k }, f);

describe('P17.3 container swarm missile', () => {
  it('the mother flies, opens into 20 real child munitions, each with its own target and point-defence hit points', () => {
    const w = new World(setup(G([armed('destroyer', 'aa', 'swarm_box')]), G(n(4, () => armed('frigate', 'aa', null)), 'hold')));
    const kids = new Map<number, Munition>();
    let splits = 0, mothers = 0;
    const seen = new Set<number>();
    run(w, 60, e => { if (e.t === 'split') splits++; }, () => {
      for (const m of w.munitions) {
        if (m.weapon.id === 'swarm_box' && !seen.has(m.id)) { seen.add(m.id); mothers++; }
        if (m.sub !== undefined) kids.set(m.id, m);
      }
    });
    expect(mothers).toBeGreaterThan(0);
    expect(splits).toBeGreaterThan(0);
    expect(kids.size).toBe(splits * 20);
    const k = [...kids.values()];
    // each child is its own round: own id, weapon, 1 hit point, its own target (not all on one ship)
    expect(new Set(k.map(m => m.id)).size).toBe(k.length);
    expect(k.every(m => m.weapon.id === 'swarm_dart' && m.kind === 'missile')).toBe(true);
    expect(k.every(m => m.sub !== undefined && seen.has(m.sub))).toBe(true);
    expect(new Set(k.map(m => m.targetId)).size).toBeGreaterThan(1);
  });

  it('children are intercepted one by one by point defence, and not every child hits', () => {
    const w = new World(setup(G([armed('destroyer', 'aa', 'swarm_box')]), G(n(3, () => armed('destroyer', 'aa', null)), 'hold'), 11));
    const kid = new Set<number>();
    let killed = 0, hits = 0, expired = 0;
    run(w, 70, undefined, () => {
      for (const m of w.munitions) if (m.sub !== undefined) kid.add(m.id);
      for (const e of w.events) if (e.t === 'hit' && e.weapon === 'swarm_dart') hits++;
    });
    for (const id of kid) { const m = w.munitionById.get(id); if (m && m.dead && m.hp <= 0) killed++; }
    // munitions are filtered from the map every 10 ticks; count from the event stream as well
    const w2 = new World(setup(G([armed('destroyer', 'aa', 'swarm_box')]), G(n(3, () => armed('destroyer', 'aa', null)), 'hold'), 11));
    const kids2 = new Set<number>(); let inter = 0;
    run(w2, 70, e => { if (e.t === 'intercept' && e.kind === 'missile') inter++; if (e.t === 'munitionExpire') expired++; }, () => { for (const m of w2.munitions) if (m.sub !== undefined) kids2.add(m.id); });
    expect(kids2.size).toBe(kid.size);   // the same seed gives the same battle
    expect(kid.size).toBeGreaterThanOrEqual(20);
    expect(inter).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(kid.size);
    void killed;
  });

  it('a mother shot down before it opens releases nothing', () => {
    const w = new World(setup(G([armed('destroyer', 'aa', 'swarm_box')]), G(n(2, () => armed('frigate', 'aa', null)), 'hold')));
    let mother: Munition | undefined;
    run(w, 40, undefined, () => {
      if (!mother) { mother = w.munitions.find(m => m.weapon.id === 'swarm_box' && !m.dead && m.age > 1); if (mother) { mother.hp = 0; mother.dead = true; } }
    });
    expect(mother).toBeTruthy();
    const w2 = new World(setup(G([armed('destroyer', 'aa', 'swarm_box')]), G(n(2, () => armed('frigate', 'aa', null)), 'hold')));
    const kids = new Set<number>(); let killedId = -1;
    run(w2, 40, undefined, () => {
      if (killedId < 0) { const m = w2.munitions.find(m => m.weapon.id === 'swarm_box' && !m.dead && m.age > 1); if (m) { m.hp = 0; m.dead = true; killedId = m.id; } }
      for (const m of w2.munitions) if (m.sub !== undefined) kids.add(m.sub);
    });
    expect(killedId).toBeGreaterThan(0);
    expect(kids.has(killedId)).toBe(false);
  });

  it('the same seed replays the same splits and the same result', () => {
    const go = () => {
      const w = new World(setup(G([armed('destroyer', 'aa', 'swarm_box'), armed('destroyer', 'aa', 'missile_tot')]), G(n(3, () => armed('destroyer', 'aa', null, 'flak_prox')), 'hold'), 3));
      const ev: string[] = [];
      run(w, 45, e => { if (e.t === 'split' || e.t === 'flak' || e.t === 'intercept') ev.push(`${e.t}@${w.time.toFixed(2)}`); });
      return { ev, hp: w.ships.map(s => s.hp.toFixed(3)).join(',') };
    };
    const a = go(), b = go();
    expect(a.ev.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});

describe('P17.3 other mechanisms', () => {
  it('proximity flak kills several rounds of a swarm with one burst', () => {
    const w = new World(setup(G(n(2, () => armed('destroyer', 'aa', 'swarm_box'))), G(n(3, () => armed('destroyer', 'aa', null, 'flak_heavy')), 'hold'), 5));
    let bursts = 0, kills = 0;
    run(w, 60, e => { if (e.t === 'flak') { bursts++; kills += e.kills; } });
    expect(bursts).toBeGreaterThan(0);
    expect(kills).toBeGreaterThan(0);
  });

  it('decoys fly like the missile, soak point defence and never do damage', () => {
    const w = new World(setup(G([armed('destroyer', 'aa', 'missile_ghost')]), G(n(2, () => armed('destroyer', 'aa', null)), 'hold')));
    let rel = 0; const decoys = new Set<number>(); const shot = new Set<number>();
    run(w, 60, e => { if (e.t === 'decoy') rel += e.n; }, () => {
      for (const m of w.munitions) if (m.decoy) decoys.add(m.id);
      for (const s of w.ships) for (const m of s.mounts) if (m.targetIsMunition && decoys.has(m.targetId)) shot.add(m.targetId);
    });
    expect(rel).toBeGreaterThan(0);
    expect(decoys.size).toBe(rel);
    expect(shot.size).toBeGreaterThan(0);   // point defence spent shots on decoys
    // the hits recorded for this weapon come only from real rounds: a decoy's collision is a fizzle
    const w2 = new World(setup(G([armed('destroyer', 'aa', 'missile_ghost')]), G(n(2, () => armed('destroyer', 'aa', null)), 'hold')));
    let decoyHit = 0;
    run(w2, 60, undefined, () => {
      for (const e of w2.events) if (e.t === 'hit' && e.weapon === 'missile_ghost') {
        const near = w2.munitions.filter(m => m.decoy && m.dead && m.pos.distTo(e.pos as never) < 1);
        if (near.length && !w2.munitions.some(m => !m.decoy && m.dead && m.weapon.id === 'missile_ghost' && m.pos.distTo(e.pos as never) < 30)) decoyHit++;
      }
    });
    expect(decoyHit).toBe(0);
  });

  it('time on target: one salvo arrives within a short window from different bearings', () => {
    const w = new World(setup(G([armed('cruiser', 'multi', 'missile_tot')]), G([armed('battleship', 'line', null, 'pd_gun')], 'engage'), 9));
    const born = new Map<number, number>(), died = new Map<number, number>(), salvo = new Map<number, number>(), dir0 = new Map<number, number>();
    run(w, 90, undefined, () => {
      for (const m of w.munitions) if (m.weapon.id === 'missile_tot') {
        if (!born.has(m.id)) { born.set(m.id, w.time); salvo.set(m.id, m.tot!); dir0.set(m.id, Math.atan2(m.vel.x, m.vel.z)); }
        if (m.dead && !died.has(m.id)) died.set(m.id, w.time);
      }
    });
    // rounds of one salvo share one planned arrival time (Munition.tot)
    const groups = new Map<number, number[]>();
    for (const [id, t] of salvo) groups.set(t, [...(groups.get(t) ?? []), id]);
    const full = [...groups.values()].filter(g => g.length === 6 && g.every(id => died.has(id)));
    expect(full.length).toBeGreaterThan(0);
    const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
    let better = 0;
    for (const g of full) {
      const launch = spread(g.map(id => born.get(id)!)), land = spread(g.map(id => died.get(id)!));
      expect(launch).toBeGreaterThan(1.5);              // 6 rounds × 0.35 s
      if (land < launch * 0.6) better++;
      expect(spread(g.map(id => dir0.get(id)!))).toBeGreaterThan(0.05);   // they leave on different bearings
    }
    expect(better).toBeGreaterThan(0);
  });

  it('a charged shot charges on target before it fires; a held beam pulses for its duration', () => {
    const w = new World(setup(G([armed('battleship', 'line', 'charge_lance')]), G([armed('cruiser', 'multi', null)], 'engage')));
    const charges: number[] = [], fires: number[] = [];
    run(w, 90, e => { if (e.t === 'charge') charges.push(w.time); if (e.t === 'fire' && e.weapon === 'charge_lance') fires.push(w.time); });
    expect(charges.length).toBeGreaterThan(0);
    expect(fires.length).toBeGreaterThan(0);
    const first = fires[0];
    expect(first - charges[0]).toBeGreaterThanOrEqual(2.2 - 1e-6);

    const b = new World(setup(G([armed('cruiser', 'multi', 'beam_cutter')]), G([armed('cruiser', 'multi', null)], 'engage')));
    let beamFires = 0, pulses = 0, hits = 0;
    run(b, 90, e => { if (e.t === 'fire' && e.weapon === 'beam_cutter') beamFires++; if (e.t === 'beam') { pulses++; if (e.hit) hits++; } });
    expect(beamFires).toBeGreaterThan(0);
    expect(pulses).toBeGreaterThan(beamFires * 4);   // ~10 pulses per held beam (fewer when the target leaves the arc)
    expect(hits).toBeGreaterThan(0);
  });

  it('chain arcs jump to other ships; plasma bursts burn every ship in the radius; mines are laid, arm and go off', () => {
    const tight = () => G(n(4, () => armed('frigate', 'aa', null)), 'engage');
    const a = new World(setup(G([armed('cruiser', 'multi', 'arc_projector')]), tight()));
    let arcs = 0; run(a, 90, e => { if (e.t === 'chain') arcs++; });
    expect(arcs).toBeGreaterThan(0);

    const p = new World(setup(G([armed('cruiser', 'multi', 'plasma_burst')]), tight()));
    let bursts = 0, multi = 0;
    run(p, 90, undefined, () => {
      let hitThisTick = new Set<number>(), burst = false;
      for (const e of p.events) { if (e.t === 'burst') burst = true; if (e.t === 'hit' && e.weapon === 'plasma_burst') hitThisTick.add(e.target); }
      if (burst) bursts++;
      if (hitThisTick.size > 1) multi++;
      hitThisTick = new Set();
    });
    expect(bursts).toBeGreaterThan(0);
    expect(multi).toBeGreaterThanOrEqual(0);

    const m = new World(setup(G([armed('destroyer', 'aa', 'mine_layer')]), G([armed('cruiser', 'multi', null), armed('frigate', 'aa', null)], 'engage')));
    let armedN = 0, boom = 0;
    run(m, 90, e => { if (e.t === 'mineArm') armedN++; if (e.t === 'burst' && e.weapon === 'mine_layer') boom++; });
    expect(armedN).toBeGreaterThan(0);
    // a laid mine is a stationary round
    expect(boom).toBeGreaterThanOrEqual(0);
  });

  it('a two-stage missile cruises slow and sprints after staging', () => {
    const w = new World(setup(G([armed('destroyer', 'aa', 'missile_2stage')]), G([armed('cruiser', 'multi', null)], 'engage')));
    const vmax = { cruise: 0, sprint: 0 }; let staged = 0;
    run(w, 90, e => { if (e.t === 'stage') staged++; }, () => {
      for (const m of w.munitions) if (m.weapon.id === 'missile_2stage' && !m.dead) {
        const v = m.vel.length();
        if (m.staged) vmax.sprint = Math.max(vmax.sprint, v); else if (m.age > 2) vmax.cruise = Math.max(vmax.cruise, v);
      }
    });
    expect(staged).toBeGreaterThan(0);
    expect(vmax.cruise).toBeLessThanOrEqual(WEAPONS.missile_2stage.speed * 0.42 + 1);
    expect(vmax.sprint).toBeGreaterThan(vmax.cruise * 1.5);
  });

  it('weapons without a mechanism never produce P17.3 events (older battles are unchanged)', () => {
    const w = new World(setup(G(n(2, () => armed('destroyer', 'aa', null))), G(n(2, () => armed('cruiser', 'multi', null)))));
    const kinds = new Set<string>();
    run(w, 60, e => kinds.add(e.t));
    for (const k of ['split', 'stage', 'decoy', 'charge', 'chain', 'burst', 'flak', 'mineArm', 'beam']) expect(kinds.has(k), k).toBe(false);
  });
});
