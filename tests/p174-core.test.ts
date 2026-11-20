// P17.4.0 — core risks from the P17 system audit: AUD-01 (unreachable stock deadlocks a stockpile goal) and
// AUD-02 (recurring trade: purchase and shipment registration are not atomic → duplicate purchases).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { opsOf } from '../src/world/operations';
import type { Cmd } from '../src/world/sim';
import { fixture, run, approvals, goal } from './helpers/opsFixture';

describe('AUD-01 — a stockpile goal does not count stock it cannot reach', () => {
  it('stock at a station the company cannot dock at is reported as unreachable; the shortfall goes to purchase', () => {
    const f = fixture();
    f.b.storage[f.p].alloy = 1000;
    f.b.modules = f.b.modules.filter(m => m.kind !== 'core');              // no core: nobody can dock there
    expect(f.sim.canDock(f.b, f.p)).toBe(false);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 500, maintain: false, buy: true, produce: false } })).toBeNull();
    run(f.sim, 10);
    const g = goal(f.sim, f.p);
    // the unreachable 1000 do not cover the 500 shortfall: a purchase approval for the whole 500 is raised
    const ap = approvals(f.sim, f.p).find(a => a.work === g.id);
    expect(ap?.kind).toBe('purchase');
    expect(ap!.items[0].amount).toBe(500);
    expect(g.reason).toMatch(/도달 불가/);
  });

  it('reachable stock waiting for a hauler is counted for a while, then no longer blocks the purchase', () => {
    const f = fixture();
    f.b.storage[f.p].alloy = 1000;
    // no pool haulers at all: the stock is reachable but nothing can carry it
    expect(f.sim.command(f.p, { c: 'poolShips', ships: f.ships.map(s => s.id), on: false })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 500, maintain: false, buy: true, produce: false } })).toBeNull();
    const g = goal(f.sim, f.p);
    run(f.sim, 30);
    expect(approvals(f.sim, f.p).filter(a => a.work === g.id)).toHaveLength(0);   // waiting for dispatch: no buying yet
    expect(g.reason).toMatch(/이송 대기/);
    run(f.sim, 1900);   // past the grace period: no hauler is coming — the stock no longer holds the goal back,
    // and the goal names the real blocker (a remote purchase could not be carried either)
    expect(g.reason).toMatch(/계획에서 제외/);
    expect(g.reason).toMatch(/수송선이 없어 구매품을 옮길 수 없음/);
    // a hauler joins the pool: the reachable stock is used again (no purchase)
    expect(f.sim.command(f.p, { c: 'poolShips', ships: f.ships.map(s => s.id), on: true })).toBeNull();
    run(f.sim, 10);
    expect(g.reason).not.toMatch(/계획에서 제외/);
    expect(approvals(f.sim, f.p).filter(a => a.work === g.id && a.kind === 'purchase')).toHaveLength(0);
  }, 60000);

  it('stock only reachable through space beyond the risk limit is not counted; the purchase goes ahead', () => {
    const f = fixture(1201, 0);
    f.b.storage[f.p].alloy = 1000;
    // move the remote store into a dangerous system (beyond the default risk limit)
    const danger = Object.values(f.sim.st.systems).filter(x => x.id !== f.sim.sysOf(f.home.pos)!.id).sort((a, b) => a.security - b.security)[0];
    danger.security = 0; danger.heat = 0; f.b.pos = { ...danger.origin };
    expect(f.sim.sysOf(f.b.pos)?.id).toBe(danger.id);
    expect(f.sim.canDock(f.b, f.p)).toBe(true);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 500, maintain: false, buy: true, produce: false } })).toBeNull();
    run(f.sim, 10);
    const g = goal(f.sim, f.p);
    expect(g.reason).toMatch(/도달 불가 재고 1,000 \(ops_b 경로 위험 허용치 초과\)/);
    expect(approvals(f.sim, f.p).some(a => a.work === g.id && (a.kind === 'purchase' || a.kind === 'risk'))).toBe(true);
  });
});

describe('AUD-02 — a recurring trade never buys the same cycle twice', () => {
  it('a failed shipment registration keeps the purchase; the next pass re-dispatches it instead of buying again', () => {
    const sim = WorldSim.create(21, { ...STANDARD_WORLD });
    const me = sim.addPlayer('반복 무역', 'hauler'), co = sim.st.companies[me];
    opsOf(co).policy.maxRisk = 100;
    // the logistics pool refuses the first few sale shipments (e.g. no slot / transient refusal)
    let refuse = 3;
    const orig = sim.command.bind(sim);
    (sim as unknown as { command: (p: string, c: Cmd) => string | null }).command = (p: string, c: Cmd) => {
      if (c.c === 'poolCreate' && c.request.kind === 'sell' && refuse > 0) { refuse--; return '시험: 운송 등록 거부'; }
      return orig(p, c);
    };
    const stock0 = sim.st.stations.astra.market!.alloy.stock;
    expect(sim.command(me, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 100, maxBuy: 1000, minSell: 0, minProfit: 0, cycles: 1 }, budget: 1e6 })).toBeNull();
    const w = Object.values(sim.st.works!).find(x => x.owner === me && x.goal?.k === 'trade')!;
    const buys = () => Object.values(sim.st.works!).filter(x => x.parent === w.id && x.kind === 'buy');
    for (let i = 0; i < 400 && refuse > 0; i++) sim.update(0.25);
    for (let i = 0; i < 40; i++) sim.update(0.25);
    // exactly one purchase for the cycle, even though registering its shipment failed three times
    expect(refuse).toBe(0);
    expect(buys()).toHaveLength(1);
    expect(buys()[0].progress.done).toBeLessThanOrEqual(100);
    expect(['move', 'buy']).toContain(w.rt!.phase);
    const job = Object.values(sim.st.logisticsJobs!).filter(j => j.owner === me && j.kind === 'sell');
    expect(job).toHaveLength(1);
    expect(job[0].amount).toBe(buys()[0].progress.done);
    expect(w.cost).toBeCloseTo(w.rt!.cycleCost!, 3);
  });

  it('the bought-but-not-shipped state survives save / restore without a second purchase', () => {
    const sim = WorldSim.create(21, { ...STANDARD_WORLD });
    const me = sim.addPlayer('반복 무역', 'hauler'), co = sim.st.companies[me];
    opsOf(co).policy.maxRisk = 100;
    let refuse = 1;
    const patch = (s: WorldSim) => { const orig = s.command.bind(s); (s as unknown as { command: (p: string, c: Cmd) => string | null }).command = (p: string, c: Cmd) => (c.c === 'poolCreate' && c.request.kind === 'sell' && refuse-- > 0) ? '시험: 운송 등록 거부' : orig(p, c); };
    patch(sim);
    expect(sim.command(me, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 100, maxBuy: 1000, minSell: 0, minProfit: 0, cycles: 1 }, budget: 1e6 })).toBeNull();
    const w0 = Object.values(sim.st.works!).find(x => x.owner === me && x.goal?.k === 'trade')!;
    expect(w0.rt!.phase).toBe('bought');
    const sim2 = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const w = sim2.st.works![w0.id];
    for (let i = 0; i < 80; i++) sim2.update(0.25);
    expect(Object.values(sim2.st.works!).filter(x => x.parent === w.id && x.kind === 'buy')).toHaveLength(1);
    expect(w.rt!.phase).not.toBe('bought');
    expect(Object.values(sim2.st.logisticsJobs!).filter(j => j.owner === me && j.kind === 'sell')).toHaveLength(1);
  });
});
