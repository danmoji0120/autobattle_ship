// P17.4b: sale-destination search (AUD-04), sale strategies (AUD-06), structured wait codes (AUD-09),
// manual orders over automatic work (AUD-15).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { addc, qty } from '../src/world/types';
import { createGoal } from '../src/world/operations';
import { planSales, saleQuote } from '../src/world/procurement';
import { saleOptions, compareSale } from '../src/world/saleSearch';
import { waitCode } from '../src/world/waitCode';
import { automationHolds } from '../src/world/automationHolds';
import { econOf } from '../src/world/hullops';

const run = (sim: WorldSim, s: number) => { for (let i = 0; i < s; i++) sim.update(1); };
function start() {
  const sim = WorldSim.create(21, { ...STANDARD_WORLD });
  const me = sim.addPlayer('판매 검색', 'miner'), co = sim.st.companies[me];
  const port = sim.st.stations.p9_anvil_port;
  const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
  const hauler = sim.subtreeShips(g).find(s => s.classId === 'hauler')!;
  expect(sim.command(me, { c: 'newGroup', name: '판매 수송반', ships: [hauler.id] })).toBeNull();
  return { sim, me, co, port, g, hauler, store: () => sim.storage(port, me) };
}

describe('P17.4b AUD-04 sale-destination search', () => {
  it('every market is listed with the planner quote or the reason it is ruled out; usable ones first', () => {
    const { sim, me, port, hauler } = start();
    addc(sim.storage(port, me), 'ore', 3000);
    const opts = saleOptions(sim, me, 'ore', port, 400, { carriers: [hauler] });
    expect(opts.length).toBeGreaterThan(2);
    const firstBad = opts.findIndex(o => o.why);
    if (firstBad >= 0) expect(opts.slice(firstBad).every(o => o.why)).toBe(true);
    for (const o of opts.filter(x => !x.why)) {
      const q = saleQuote(sim, sim.st.stations[o.station], 'ore', 400, 0);
      expect(o.sold).toBe(q.sold); expect(o.net).toBeCloseTo(q.value, 6);
      expect(o.gross - o.tax).toBeCloseTo(o.net, 6);
    }
    // a floor above every bid rules everything out, with the reason and the current bid
    const hi = saleOptions(sim, me, 'ore', port, 400, { minPrice: 1e6, carriers: [hauler] });
    expect(hi.every(o => o.why)).toBe(true);
    expect(hi.some(o => /최저 단가 미달/.test(o.why!))).toBe(true);
    // an exhausted buyer budget is named
    const m = opts.find(o => !o.why && !o.local)!; sim.st.stations[m.station].funds = 0;
    expect(saleOptions(sim, me, 'ore', port, 400, { carriers: [hauler] }).find(o => o.station === m.station)!.why).toMatch(/예산/);
  });

  it('the planner ships to the market the search ranks first (same rules)', () => {
    const { sim, me, co, port, hauler } = start();
    delete port.market!.ore;   // no local buyer: the lot must be shipped
    addc(sim.storage(port, me), 'ore', 3000);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 0 } })).toBeNull();
    const lot = Math.floor(econOf(hauler).cargo);
    const best = saleOptions(sim, me, 'ore', port, Math.min(3000, lot), { carriers: [hauler] }).find(o => !o.why)!;
    planSales(sim);
    const j = Object.values(sim.st.logisticsJobs ?? {}).find(x => x.owner === me && x.kind === 'sell')!;
    expect(j).toBeTruthy(); expect(j.to).toBe(best.station);
    expect(co.procurement!.sales!.ore.strategy).toBeUndefined();   // default rule stays the original behaviour
  });
});

describe('P17.4b AUD-06 sale strategies', () => {
  const local = { net: 100, hops: 0, risk: 10, local: true, id: 'L' }, far = { net: 120, hops: 2, risk: 60, local: false, id: 'F' }, near = { net: 104, hops: 1, risk: 5, local: false, id: 'N' };
  const order = (s: Parameters<typeof compareSale>[0]) => [local, far, near].sort(compareSale(s)).map(x => x.id).join('');
  it('orders markets per strategy; local first except for max profit', () => {
    expect(order(undefined)).toBe('LFN');   // original: local, then value less 6 %/jump (120×.88=105.6 > 104×.94)
    expect(order('local')).toBe('LFN');
    expect(order('profit')).toBe('FLN');    // 120×.96=115.2 > local 100×1.05 = 105 > 104×.98
    expect(order('fast')).toBe('LNF');
    expect(order('safe')).toBe('LNF');
  });
  it('the policy stores a strategy, keeps it when only the floor changes, and refuses unknown ones', () => {
    const { sim, me, co } = start();
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 5, strategy: 'profit' } })).toBeNull();
    expect(co.procurement!.sales!.ore).toEqual({ minPrice: 5, strategy: 'profit' });
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 7 } })).toBeNull();
    expect(co.procurement!.sales!.ore).toEqual({ minPrice: 7, strategy: 'profit' });
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 7, strategy: 'local' } })).toBeNull();
    expect(co.procurement!.sales!.ore).toEqual({ minPrice: 7 });
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, strategy: 'yolo' as never } })).toMatch(/전략/);
  });
  it("'profit' ships instead of selling locally only when a market pays clearly more; nothing is sold twice", () => {
    const { sim, me, port } = start();
    addc(sim.storage(port, me), 'ore', 3000);
    const mk = port.market!.ore; mk.base = Math.max(1, mk.base * 0.3);   // the local bid collapses
    const before = qty(sim.storage(port, me), 'ore');
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 0, strategy: 'profit' } })).toBeNull();
    planSales(sim);
    const j = Object.values(sim.st.logisticsJobs ?? {}).find(x => x.owner === me && x.kind === 'sell');
    expect(j).toBeTruthy(); expect(j!.to).not.toBe(port.id);
    expect(qty(sim.storage(port, me), 'ore')).toBeCloseTo(before);   // nothing sold locally
    expect(j!.amount).toBeLessThanOrEqual(before);
  });
});

describe('P17.4b AUD-09 structured wait codes', () => {
  it('engine reasons map onto codes', () => {
    expect(waitCode('결재 대기: 자동 구매 권한 없음')).toBe('approval');
    expect(waitCode('공용 배차 수송선이 없습니다')).toBe('hauler');
    expect(waitCode('자금 부족 — 1,000 cr 필요')).toBe('credits');
    expect(waitCode('위험 허용치 안의 경로로 갈 수 있는 시장 없음')).toBe('route');
    expect(waitCode('매도 호가 12 < 최저 15')).toBe('market');
    expect(waitCode('자재 확보 중: 합금 20')).toBe('materials');
    expect(waitCode('선행 시설 완공 대기')).toBe('prereq');
    expect(waitCode('알 수 없는 이유')).toBe('other');
  });
  it('a waiting work carries its code and start time; the time holds while the block lasts and clears after', () => {
    const { sim, me, port, hauler } = start();
    // the only hauler leaves the pool: a transfer cannot be dispatched
    expect(sim.command(me, { c: 'poolShips', ships: [hauler.id], on: false })).toBeNull();
    addc(sim.storage(port, me), 'ore', 500);
    const other = Object.values(sim.st.stations).find(s => s.public && s.id !== port.id && s.market)!;
    expect(sim.command(me, { c: 'poolCreate', request: { from: port.id, to: other.id, item: 'ore', kind: 'transfer', amount: 100, priority: 5, repeat: false } })).toBeNull();
    run(sim, 30);
    const w = Object.values(sim.st.works!).find(x => x.owner === me && x.kind === 'transport')!;
    expect(w.state).toBe('waiting'); expect(w.wait?.code).toBe('hauler');
    const since = w.wait!.since; run(sim, 20); expect(w.wait!.since).toBe(since);
    expect(sim.command(me, { c: 'poolShips', ships: [hauler.id], on: true })).toBeNull();
    run(sim, 30);
    expect(w.state).not.toBe('waiting'); expect(w.wait).toBeUndefined();
  });
});

describe('P17.4b AUD-15 manual orders over automatic work', () => {
  it('lists what a manual order interrupts, records it, and the automation never takes the fleet back', () => {
    const { sim, me, g, port } = start();
    // a field goal drives the mining group
    expect(createGoal(sim, me, { k: 'develop_field', field: 'p9_anvil_ore', group: g.id, sell: true, miners: 0, deliver: port.id } as never)).toBeNull();
    run(sim, 30);
    expect(g.op.k).toBe('mine');
    const goalWork = Object.values(sim.st.works!).find(x => x.owner === me && x.kind === 'develop_field')!;
    const hs = automationHolds(sim.st, me, { group: g.id }, { k: 'dock', station: port.id });
    expect(hs.map(x => x.kind)).toContain('field');
    expect(hs.find(x => x.kind === 'field')!.effect).toMatch(/일시정지/);
    // re-issuing the same operation interrupts nothing
    expect(automationHolds(sim.st, me, { group: g.id }, { k: 'mine', field: 'p9_anvil_ore', deliver: port.id, sell: true })).toEqual([]);
    const evs = sim.st.events.length;
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'dock', station: port.id } })).toBeNull();
    expect(sim.st.events.slice(evs).some(e => /명령 우선 — 자동 업무 중단/.test(e.text))).toBe(true);
    run(sim, 120);
    expect(g.op.k).toBe('dock');                 // never re-overridden
    expect(goalWork.state).toBe('paused');
  });

  it('a pool shipment on the ship is listed; the manual order releases it with its cargo and it is not taken back', () => {
    const { sim, me, port, hauler } = start();
    const other = Object.values(sim.st.stations).find(s => s.public && s.id !== port.id && s.market?.ore)!;
    addc(sim.storage(port, me), 'ore', 500);
    expect(sim.command(me, { c: 'poolCreate', request: { from: port.id, to: other.id, item: 'ore', kind: 'sell', amount: 100, priority: 5, repeat: false } })).toBeNull();
    for (let t = 0; t < 300 && !(hauler.logisticsJob && qty(hauler.cargo, 'ore') > 0); t++) sim.update(1);
    expect(hauler.logisticsJob).toBeTruthy();
    const hs = automationHolds(sim.st, me, { group: hauler.groupId }, { k: 'dock', station: port.id });
    expect(hs.some(x => x.kind === 'pool')).toBe(true);
    const cargo = qty(hauler.cargo, 'ore');
    expect(sim.command(me, { c: 'setOp', group: hauler.groupId, op: { k: 'dock', station: port.id } })).toBeNull();
    run(sim, 60);
    expect(sim.st.groups[hauler.groupId].op.k).toBe('dock');
    expect(hauler.logisticsJob).toBeFalsy();
    expect(qty(hauler.cargo, 'ore')).toBeCloseTo(cargo);   // cargo kept aboard, nothing lost or sold behind the order
  });
});
