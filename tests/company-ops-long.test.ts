// Company operations under load: server restart with open approvals, several companies at once,
// and (OPS_LONG=1) a 24-game-hour unattended run with production spread over several stations.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type Station } from '../src/world/types';
import { terminal, type Work } from '../src/world/operations';
import { legacyView } from '../src/server/sync';
import { fixture, run, works, approvals } from './helpers/opsFixture';

/** an own station for `owner` next to astra, with the given built modules */
function own(sim: WorldSim, owner: string, id: string, dx: number, dz: number, modules: string[]): Station {
  const a = sim.st.stations.astra;
  const s: Station = { ...structuredClone(a), id, name: id, public: false, owner, pos: { ...a.pos, x: a.pos.x + dx, z: a.pos.z + dz }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [owner]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: modules.map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
  sim.st.stations[id] = s; return s;
}
function haulers(sim: WorldSim, owner: string, n: number) {
  const a = sim.st.stations.astra, g = sim.newGroup(owner, '공용 수송');
  const ships = Array.from({ length: n }, () => { const s = sim.spawnShip(owner, 'hauler', 'std', g.id, a.pos); (sim as any).dockShip(s, a); return s; });
  expect(sim.command(owner, { c: 'poolShips', ships: ships.map(s => s.id), on: true })).toBeNull();
}
/** live works describing the same engine object (must never happen) */
function duplicates(sim: WorldSim) {
  const keys = Object.values(sim.st.works ?? {}).filter(w => !terminal(w) && !w.goal).map(w => JSON.stringify([w.owner, w.kind, w.ref.station, w.ref.order, w.ref.module, w.ref.build, w.ref.research, w.ref.job, w.ref.route, w.kind === 'operation' ? w.ref.group : undefined]));
  return keys.length - new Set(keys).size;
}
const ledgerNet = (sim: WorldSim, p: string) => sim.st.companies[p].ops!.ledger.reduce((n, h) => n + Object.values(h.inc).reduce((a, b) => a + b, 0) - Object.values(h.exp).reduce((a, b) => a + b, 0), 0);

describe('server restart with open approvals', () => {
  it('restores works, open approvals, paused operations and goal plans exactly; nothing is raised or planned twice', () => {
    const f = fixture(); f.co.tech = [];
    const c = own(f.sim, f.p, 'ops_c', 1300, 300, ['core', 'power', 'power', 'machine_shop', 'warehouse']);
    f.home.storage[f.p].ore = 2000; f.b.storage[f.p].alloy = 300;
    // open approvals: a purchase (titanium, no budget) and a production goal that also needs a purchase
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.b.id, item: 'titanium', target: 300, maintain: true, buy: true, produce: false } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.b.id, item: 'machinery', target: 30, maintain: false, buy: true, produce: true } })).toBeNull();
    const field = Object.values(f.sim.st.fields).find(x => x.res === 'ore')!;
    const mg = f.sim.newGroup(f.p, '채굴대'); f.sim.spawnShip(f.p, 'miner', 'std', mg.id, field.pos);
    expect(f.sim.command(f.p, { c: 'setOp', group: mg.id, op: { k: 'mine', field: field.id, deliver: 'astra', sell: true } })).toBeNull();
    const op = works(f.sim, f.p).find(w => w.kind === 'operation')!;
    expect(f.sim.command(f.p, { c: 'workOp', work: op.id, op: 'pause' })).toBeNull();
    run(f.sim, 30);
    const open = approvals(f.sim, f.p); expect(open.length).toBeGreaterThanOrEqual(1);
    // save exactly as the server does and require an identical round trip
    const s1 = f.sim.serialize(); const restored = new WorldSim(JSON.parse(s1), { migrateContent: false });
    expect(restored.serialize()).toBe(s1);
    const before = { works: Object.keys(restored.st.works!).length, approvals: Object.keys(restored.st.approvals!).length, orders: c.orders!.map(o => [o.id, o.n]) };
    run(restored, 60);
    // the same approvals are still open (same ids), nothing new was raised for the same decisions
    const after = approvals(restored, f.p);
    expect(after.map(a => a.id).sort()).toEqual(open.map(a => a.id).sort());
    expect(duplicates(restored)).toBe(0);
    expect(restored.st.stations.ops_c.orders!.map(o => [o.id, o.n]).filter(([id]) => before.orders.some(([b]) => b === id))).toEqual(before.orders.filter(([id]) => restored.st.stations.ops_c.orders!.some(o => o.id === id)));
    expect(Object.keys(restored.st.works!).length).toBeLessThanOrEqual(before.works + 20);
    // the paused operation is still paused and resumes into the same order
    const rop = restored.st.works![op.id]; expect(rop.state).toBe('paused'); expect(restored.st.groups[mg.id].op.k).toBe('idle');
    expect(restored.command(f.p, { c: 'workOp', work: op.id, op: 'resume' })).toBeNull(); expect(restored.st.groups[mg.id].op.k).toBe('mine');
    // a decision taken after the restart is carried out
    const ti = after.find(a => a.items[0]?.item === 'titanium')!;
    const credits = restored.st.companies[f.p].credits;
    expect(restored.command(f.p, { c: 'approvalDecide', approval: ti.id, option: 'approve', scope: 'work' })).toBeNull();
    run(restored, 30); expect(restored.st.companies[f.p].credits).toBeLessThan(credits);
    expect(works(restored, f.p).some(w => w.kind === 'buy' && w.goal === undefined && w.ref.item === 'titanium')).toBe(true);
  }, 120000);
});

describe('several companies at once', () => {
  it('each company sees and controls only its own works, approvals and ledger; one company\'s pending approval stalls nobody else', () => {
    const f = fixture(); const p2 = f.sim.addPlayer('둘째 회사'); f.sim.st.companies[p2].credits = 2e6;
    own(f.sim, p2, 'p2_home', -900, 600, ['core', 'power', 'power', 'refinery', 'warehouse']).storage[p2].ore = 3000;
    haulers(f.sim, p2, 2);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'titanium', target: 100, maintain: false, buy: true, produce: false } })).toBeNull();
    expect(f.sim.command(p2, { c: 'workCreate', goal: { k: 'stockpile', scope: 'company', station: 'p2_home', item: 'metal', target: 100, maintain: false, buy: false, produce: true } })).toBeNull();
    run(f.sim, 600);
    const g2 = works(f.sim, p2).find(w => w.goal)!; expect(g2.state).toBe('done');
    expect(approvals(f.sim, f.p)).toHaveLength(1); expect(approvals(f.sim, p2, false)).toHaveLength(0);
    // ownership: another company can neither see nor touch these
    const view = legacyView(f.sim.st, { company: p2 }, 'astra');
    expect(Object.values(view.works ?? {}).every(w => w.owner === p2)).toBe(true); expect(Object.values(view.approvals ?? {}).every(a => a.owner === p2)).toBe(true);
    expect(f.sim.command(p2, { c: 'approvalDecide', approval: approvals(f.sim, f.p)[0].id, option: 'approve' })).not.toBeNull();
    expect(f.sim.command(p2, { c: 'workOp', work: works(f.sim, f.p).find(w => w.goal)!.id, op: 'cancel' })).not.toBeNull();
    expect((view.companies[f.p] as { ops?: unknown }).ops).toBeUndefined();
    expect(duplicates(f.sim)).toBe(0);
  }, 120000);
});

describe.skipIf(!process.env.OPS_LONG)('24 game hours, three companies, production on several stations (OPS_LONG=1)', () => {
  it('runs unattended with bounded state, consistent money and no duplicated or runaway plans', () => {
    const f = fixture(1207); f.co.tech = []; f.co.credits = 3e6;
    // starting balances are taken before any command runs: creating a goal may already spend money
    const start: Record<string, number> = { [f.p]: 3e6 };
    // A: machinery made at ops_c from metal refined at ops_home, delivered to ops_b; mining; repeat trade
    const c = own(f.sim, f.p, 'ops_c', 1300, 300, ['core', 'power', 'power', 'machine_shop', 'warehouse', 'warehouse']);
    f.b.storage[f.p].alloy = 4000;
    expect(f.sim.command(f.p, { c: 'opsPolicy', policy: { autonomy: 'auto', minCredits: 1_000_000, hourlyLimit: 300_000 } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.b.id, item: 'machinery', target: 120, maintain: true, buy: false, produce: true } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'ore', target: 3000, maintain: true, buy: true, produce: false } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 300, maxBuy: 60, minSell: 30, minProfit: 0, cycles: 0 } })).toBeNull();
    const field = Object.values(f.sim.st.fields).find(x => x.res === 'ore')!;
    const mg = f.sim.newGroup(f.p, '채굴대'); f.sim.spawnShip(f.p, 'miner', 'std', mg.id, field.pos);
    expect(f.sim.command(f.p, { c: 'setOp', group: mg.id, op: { k: 'mine', field: field.id, deliver: 'astra', sell: true } })).toBeNull();
    // B: default policy, a goal that needs a purchase nobody approves for the whole day, plus self-sufficient work
    const p2 = f.sim.addPlayer('결재 미응답 회사'); f.sim.st.companies[p2].credits = 1.5e6; start[p2] = 1.5e6;
    const b2 = own(f.sim, p2, 'p2_home', -900, 600, ['core', 'power', 'power', 'refinery', 'warehouse', 'warehouse']); b2.storage[p2].ore = 6000;
    haulers(f.sim, p2, 2);
    expect(f.sim.command(p2, { c: 'workCreate', goal: { k: 'stockpile', station: 'p2_home', item: 'titanium', target: 200, maintain: true, buy: true, produce: false } })).toBeNull();
    expect(f.sim.command(p2, { c: 'workCreate', goal: { k: 'stockpile', station: 'p2_home', item: 'metal', target: 1500, maintain: true, buy: false, produce: true } })).toBeNull();
    // C: company-wide metal over two refinery stations, budgeted ore purchases for production inputs
    const p3 = f.sim.addPlayer('분산 생산 회사'); f.sim.st.companies[p3].credits = 2e6; start[p3] = 2e6;
    own(f.sim, p3, 'p3_a', 400, -900, ['core', 'power', 'power', 'refinery', 'warehouse', 'warehouse']);
    own(f.sim, p3, 'p3_b', -400, -1300, ['core', 'power', 'power', 'refinery', 'warehouse', 'warehouse']);
    haulers(f.sim, p3, 3);
    expect(f.sim.command(p3, { c: 'workCreate', goal: { k: 'stockpile', scope: 'company', station: 'p3_a', item: 'metal', target: 2000, maintain: true, buy: true, produce: true }, budget: 600_000 })).toBeNull();
    const t0 = Date.now(); let ticks = 0, worst = 0; const p2raised = new Set<string>(); let maxOrdersC = 0;
    const H = Number(process.env.OPS_LONG_H ?? 24);
    for (let t = 0; t < H * 3600; t += .25) {
      const s = performance.now(); f.sim.update(.25); worst = Math.max(worst, performance.now() - s); ticks++;
      if (ticks % 400 === 0) { for (const a of approvals(f.sim, p2)) p2raised.add(a.id); maxOrdersC = Math.max(maxOrdersC, ...['p3_a', 'p3_b'].map(id => (f.sim.st.stations[id].orders ?? []).length)); }
    }
    const ms = Date.now() - t0;
    const summary: Record<string, unknown> = { ticks, gameHours: ticks * .25 / 3600, ms, worstTickMs: Math.round(worst) };
    for (const p of [f.p, p2, p3]) {
      const ws = works(f.sim, p), co = f.sim.st.companies[p];
      expect(ws.length).toBeLessThan(500);
      expect(approvals(f.sim, p, false).length).toBeLessThan(60);
      for (const st of Object.values(f.sim.st.stations)) for (const n of Object.values(st.storage[p] ?? {})) expect(n).toBeGreaterThanOrEqual(-1e-6);
      summary[co.name] = { ledgerGap: Math.round(ledgerNet(f.sim, p) - (co.credits - start[p])), credits: Math.round(co.credits), works: ws.length, live: ws.filter(w => !terminal(w)).length, approvals: approvals(f.sim, p, false).length, open: approvals(f.sim, p).length, goals: ws.filter(w => w.goal && !w.parent).map(w => [w.title, w.state, w.reason.slice(0, 80)]) };
    }
    console.log(JSON.stringify(summary));
    // the ledger accounts for every credit over the whole day (48 hours are kept)
    for (const p of [f.p, p2, p3]) expect(Math.abs(ledgerNet(f.sim, p) - (f.sim.st.companies[p].credits - start[p]))).toBeLessThan(5);
    expect(duplicates(f.sim)).toBe(0);
    // A: delivered machinery from distributed production, never below the floor through automatic spending
    expect(qty(f.b.storage[f.p], 'machinery')).toBeGreaterThan(0);
    expect(f.co.credits).toBeGreaterThan(1_000_000 - 50_000); // upkeep may dip a little below; purchases never do
    // B: the unanswered approval was raised once and kept (no re-asking), the rest of B's work ran all day
    expect(p2raised.size).toBe(1);
    expect(qty(b2.storage[p2], 'metal')).toBeGreaterThan(1000);
    // C: plans stayed bounded — no stacking of orders on either refinery
    expect(maxOrdersC).toBeLessThanOrEqual(3);
    const metalC = Object.values(f.sim.st.stations).reduce((n, s) => n + qty(s.storage[p3], 'metal'), 0);
    expect(metalC).toBeGreaterThan(1500);
    summary.machineryAtB = qty(f.b.storage[f.p], 'machinery'); summary.machineryOrdersAtC = (c.orders ?? []).map(o => [o.recipe, o.done, o.n]); summary.metalC = Math.round(metalC); summary.maxOrdersC = maxOrdersC;
  }, 3_600_000);
});

export type { Work };
