// The repair price the client shows is the price the server charges (shared quote in world/repair.ts).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import { repairQuote } from '../src/world/repair';
import { econOf, shipWorth } from '../src/world/hullops';
import { legacyView } from '../src/server/sync';
import { opsOf } from '../src/world/operations';

function docked(sim: WorldSim, p: string, cls: string, hp: number, station = 'astra') {
  const st = sim.st.stations[station];
  const g = sim.newGroup(p, '수리 시험');
  const s = sim.spawnShip(p, cls, 'std', g.id, { x: st.pos.x + 200, y: 0, z: st.pos.z });
  expect(sim.dockShip(s, st)).toBe(true);
  s.hp = hp;
  return s;
}

describe('repair quote = server charge', () => {
  for (const [name, make] of [['growth (contentV 4)', () => WorldSim.create(41)], ['legacy c0', () => new WorldSim(newWorld(41))]] as const) {
    it(`${name}: different hulls and damage, client view quote equals the charge`, () => {
      const sim = make();
      const p = sim.addPlayer('수리 회사'); sim.st.companies[p].credits = 5e6;
      for (const [cls, hp] of [['corvette', .4], ['destroyer', .75], ['hauler', .1], ['miner', .99]] as const) {
        if (!sim.st.stations.astra.services.repair) throw new Error('astra has no repair');
        const s = docked(sim, p, cls, hp);
        const view = legacyView(sim.st, { company: p }, 'astra') as any;
        const q = repairQuote(view, view.ships[s.id], view.companies[p]);
        expect(q.why).toBeNull();
        const before = sim.st.companies[p].credits;
        expect(sim.command(p, { c: 'repair', ship: s.id, quote: q.cost })).toBeNull();
        expect(before - sim.st.companies[p].credits).toBe(q.cost);
        expect(s.hp).toBe(1);
        expect(q.cost).toBe(Math.round((1 - hp) * shipWorth(sim.st, s) * .3));
      }
    });
  }

  it('growth hull worth differs from the old class price (the original mismatch)', () => {
    const sim = WorldSim.create(42); const p = sim.addPlayer('x');
    const s = docked(sim, p, 'destroyer', .5);
    expect(shipWorth(sim.st, s)).not.toBe(econOf(s).price);
  });

  it('repair research lowers the quote and the charge identically', () => {
    const sim = WorldSim.create(43); const p = sim.addPlayer('연구'); const co = sim.st.companies[p]; co.credits = 5e6;
    const a = docked(sim, p, 'destroyer', .5), base = repairQuote(sim.st, a, co).cost;
    co.tech = [...(co.tech ?? []), 'damage_control'];
    const q = repairQuote(sim.st, a, co);
    expect(q.cost).toBe(Math.round(base / 1.5));
    const before = co.credits;
    expect(sim.command(p, { c: 'repair', ship: a.id, quote: q.cost })).toBeNull();
    expect(before - co.credits).toBe(q.cost);
  });

  it('a stale quote is refused with both numbers; no money moves', () => {
    const sim = WorldSim.create(44); const p = sim.addPlayer('견적'); const co = sim.st.companies[p]; co.credits = 5e6;
    const s = docked(sim, p, 'destroyer', .5), q = repairQuote(sim.st, s, co);
    s.hp = .3;
    const before = co.credits;
    const err = sim.command(p, { c: 'repair', ship: s.id, quote: q.cost });
    expect(err).toContain('수리비가 바뀌었습니다');
    expect(co.credits).toBe(before); expect(s.hp).toBe(.3);
  });

  it('insufficient funds and missing facilities give exact reasons', () => {
    const sim = WorldSim.create(45); const p = sim.addPlayer('가난'); const co = sim.st.companies[p];
    const s = docked(sim, p, 'destroyer', .2);
    co.credits = 10;
    const q = repairQuote(sim.st, s, co);
    expect(q.why).toMatch(/^자금 부족 — 수리비 [\d,]+ cr, 보유 10 cr$/);
    expect(sim.command(p, { c: 'repair', ship: s.id })).toBe(q.why);
    const g = sim.newGroup(p, '우주'); const free = sim.spawnShip(p, 'corvette', 'std', g.id, { x: 0, y: 0, z: 0 }); free.hp = .5;
    expect(repairQuote(sim.st, free, co).why).toBe('정박 중인 함선만 수리 가능');
    s.hp = 1; co.credits = 1e6;
    expect(repairQuote(sim.st, s, co).why).toBe('손상 없음');
  });

  it('the repair work and the finance ledger record the real cost', () => {
    const sim = WorldSim.create(46); const p = sim.addPlayer('장부'); const co = sim.st.companies[p]; co.credits = 5e6;
    const s = docked(sim, p, 'cruiser', .6), q = repairQuote(sim.st, s, co);
    expect(sim.command(p, { c: 'repair', ship: s.id, quote: q.cost })).toBeNull();
    const w = Object.values(sim.st.works ?? {}).find(x => x.kind === 'repair');
    expect(w?.result).toContain(q.cost.toLocaleString());
    const led = opsOf(co).ledger.at(-1)!;
    expect(led.exp.repair).toBe(q.cost);
  });
});
