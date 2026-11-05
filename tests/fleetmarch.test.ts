import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { WGroup, WShip, V } from '../src/world/types';

const d = (a: V, b: V) => Math.hypot(a.x - b.x, a.z - b.z);
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const g of Object.values(sim.st.groups)) if (g.owner === 'pirates') { for (const id of g.shipIds) delete sim.st.ships[id]; g.shipIds = []; } };

/** a 17-ship, three-level mixed fleet at the free port: 2 battleships (flag), 4 cruisers, 5 destroyers, 6 corvettes */
function fleet(seed = 3) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('제독');
  const astra = sim.st.stations.astra.pos;
  const top = sim.newGroup(p, '제1 함대');
  const cru = sim.newGroup(p, '순양 전대', top.id);
  const des = sim.newGroup(p, '구축 전대', cru.id);   // three levels deep
  const cor = sim.newGroup(p, '초계 전대', top.id);
  const add = (g: WGroup, cls: string, lo: string, n: number) => { for (let i = 0; i < n; i++) sim.spawnShip(p, cls, lo, g.id, { x: astra.x + 300 + i * 40, y: 0, z: astra.z + 300 }); };
  add(top, 'battleship', 'std', 2); add(cru, 'cruiser', 'multi', 4); add(des, 'destroyer', 'aa', 5); add(cor, 'corvette', 'torp', 6);
  const all = () => [top, cru, des, cor].flatMap(g => g.shipIds.map(id => sim.st.ships[id])).filter(Boolean) as WShip[];
  return { sim, p, top, cru, des, cor, all };
}

describe('fleet moves as one', () => {
  it('17-ship mixed fleet crosses two jump gates and arrives together (no ship runs ahead)', () => {
    const { sim, p, top, all } = fleet();
    calm(sim);
    const dest = { ...sim.st.stations.drakeout.pos }; dest.x += 2500;
    expect(all().length).toBe(17);
    expect(sim.command(p, { c: 'setOp', group: top.id, op: { k: 'move', to: dest } })).toBeNull();
    const first = new Map<string, number>();
    let maxSpreadInTransit = 0;
    for (let t = 0; t < 2400 && first.size < 17; t += 0.5) {
      sim.update(0.5);
      for (const s of all()) if (!first.has(s.id) && d(s.pos, dest) < 1500) first.set(s.id, sim.time);
      // spread of the fleet while it is in normal flight (not mid-warp): how far is the leading ship from the trailing one
      const flying = all().filter(s => !s.warp);
      if (top.march?.phase === 'transit' && flying.length === 17 && new Set(flying.map(s => sim.sysOf(s.pos)?.id)).size === 1) {
        let mx = 0; for (const a of flying) for (const b of flying) mx = Math.max(mx, d(a.pos, b.pos));
        maxSpreadInTransit = Math.max(maxSpreadInTransit, mx);
      }
    }
    expect(first.size).toBe(17);
    const times = [...first.values()];
    const spread = Math.max(...times) - Math.min(...times);
    console.log(`arrival window ${spread.toFixed(0)} s, max in-flight spread ${maxSpreadInTransit.toFixed(0)} u, total ${Math.max(...times).toFixed(0)} s`);
    expect(spread).toBeLessThan(45);                    // all 17 arrive within seconds of each other
    // corvettes (cruise 150) did not arrive before the battleships (cruise 70)
    const corT = Math.min(...all().filter(s => s.classId === 'corvette').map(s => first.get(s.id)!));
    const bbT = Math.min(...all().filter(s => s.classId === 'battleship').map(s => first.get(s.id)!));
    expect(bbT - corT).toBeLessThan(30);
  });

  it('attack: the fleet stages, assembles, then the whole fleet enters the battle together', () => {
    const { sim, p, top, all } = fleet(5);
    calm(sim);
    const lair = sim.st.lairs.gravel; lair.alive = true; lair.respawnAt = 0; lair.hp = 1;
    expect(sim.command(p, { c: 'setOp', group: top.id, op: { k: 'attack', lair: 'gravel' } })).toBeNull();
    let atContact = -1, phaseLog = new Set<string>();
    for (let t = 0; t < 3000 && atContact < 0; t += 0.5) {
      sim.update(0.5);
      if (top.march) phaseLog.add(top.march.phase);
      const inBattle = all().filter(s => s.state === 'battle').length;
      if (inBattle > 0) atContact = inBattle;
    }
    console.log('phases', [...phaseLog].join('→'), 'ships in the first battle:', atContact);
    expect(phaseLog.has('ready') || phaseLog.has('engage')).toBe(true);
    expect(atContact).toBeGreaterThanOrEqual(15);       // not 2-3 corvettes alone
  });

  it('an explicitly detached vanguard moves on its own, ahead of the main body', () => {
    const { sim, p, top, cor, all } = fleet(7);
    calm(sim);
    expect(sim.command(p, { c: 'setDetached', group: cor.id, on: true })).toBeNull();
    const dest = { ...sim.st.stations.drakeout.pos }; dest.x += 2500;
    sim.command(p, { c: 'setOp', group: top.id, op: { k: 'move', to: dest } });
    const first = new Map<string, number>();
    for (let t = 0; t < 2400 && first.size < 17; t += 0.5) { sim.update(0.5); for (const s of all()) if (!first.has(s.id) && d(s.pos, dest) < 1500) first.set(s.id, sim.time); }
    const corT = Math.max(...cor.shipIds.map(id => first.get(id)!));
    const mainT = Math.min(...all().filter(s => s.classId === 'battleship').map(s => first.get(s.id)!));
    console.log(`vanguard ${corT.toFixed(0)} s, main body ${mainT.toFixed(0)} s`);
    expect(corT).toBeLessThan(mainT - 15);              // scouts got there well before the main body
  });
});
