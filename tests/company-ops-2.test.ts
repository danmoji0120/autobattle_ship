// Company operations, second pass: continuous fleet operations, adoption of engine work from older saves,
// company-wide production planning, approval alternatives, restart and multi-company operation.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type Station } from '../src/world/types';
import { terminal, type Work } from '../src/world/operations';
import { fixture, run, until, works, approvals } from './helpers/opsFixture';

const ops = (sim: WorldSim, p: string) => works(sim, p).filter(w => w.kind === 'operation');

describe('continuous fleet operations are company works', () => {
  it('mining, patrol and idle orders open, switch and close operation works; pause/resume restores the order', () => {
    const f = fixture();
    const field = Object.values(f.sim.st.fields).find(x => x.res === 'ore')!;
    const g = f.sim.newGroup(f.p, '채굴대'); const miner = f.sim.spawnShip(f.p, 'miner', 'std', g.id, field.pos);
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'mine', field: field.id, deliver: 'astra', sell: true } })).toBeNull();
    let live = ops(f.sim, f.p).filter(w => !terminal(w));
    expect(live).toHaveLength(1); expect(live[0].mode).toBe('continuous'); expect(live[0].ref.op).toBe('mine'); expect(live[0].title).toContain('채굴');
    run(f.sim, 4); expect(['running', 'waiting']).toContain(live[0].state);
    // pause → the group stands by, the work remembers the order; resume → the same order again
    const id = live[0].id;
    expect(f.sim.command(f.p, { c: 'workOp', work: id, op: 'pause' })).toBeNull();
    expect(f.sim.st.groups[g.id].op.k).toBe('idle'); run(f.sim, 3);
    expect(f.sim.st.works![id].state).toBe('paused'); expect(ops(f.sim, f.p).filter(w => !terminal(w))).toHaveLength(1);
    expect(f.sim.command(f.p, { c: 'workOp', work: id, op: 'resume' })).toBeNull();
    expect(f.sim.st.groups[g.id].op.k).toBe('mine'); run(f.sim, 3);
    expect(f.sim.st.works![id].state).not.toBe('paused'); expect(ops(f.sim, f.p).filter(w => !terminal(w))).toHaveLength(1);
    // a new order on the same group closes the mining work and opens a patrol work
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'patrol', at: { ...f.a.pos }, radius: 3000 } })).toBeNull();
    live = ops(f.sim, f.p).filter(w => !terminal(w));
    expect(live).toHaveLength(1); expect(live[0].ref.op).toBe('patrol'); expect(f.sim.st.works![id].state).toBe('done');
    // idle ends it; cancelling from the work list does the same through the ordinary order
    expect(f.sim.command(f.p, { c: 'workOp', work: live[0].id, op: 'cancel' })).toBeNull();
    expect(f.sim.st.groups[g.id].op.k).toBe('idle'); expect(ops(f.sim, f.p).filter(w => !terminal(w))).toHaveLength(0);
    expect(miner.hp).toBeGreaterThan(0);
  });
  it('an escort order is an open-ended work; a finished move is recorded as done', () => {
    const f = fixture();
    const g1 = f.sim.newGroup(f.p, '호위대'), g2 = f.sim.newGroup(f.p, '이동대');
    f.sim.spawnShip(f.p, 'frigate', 'std', g1.id, f.a.pos); f.sim.spawnShip(f.p, 'hauler', 'std', g2.id, f.a.pos);
    expect(f.sim.command(f.p, { c: 'setOp', group: g1.id, op: { k: 'escort', group: f.ships[0].groupId } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'setOp', group: g2.id, op: { k: 'move', to: { ...f.a.pos, x: f.a.pos.x + 300 } } })).toBeNull();
    const esc = ops(f.sim, f.p).find(w => w.ref.op === 'escort')!, mv = ops(f.sim, f.p).find(w => w.ref.op === 'move')!;
    expect(esc.mode).toBe('continuous'); expect(mv.mode).toBe('once');
    run(f.sim, 120);
    expect(esc.state).not.toBe('done'); expect(mv.state).toBe('done');
  });
});

describe('engine work from an older save is adopted, never duplicated', () => {
  it('orders, builds, construction, research, shipments, routes and fleet orders each get exactly one work', () => {
    const f = fixture();
    f.home.storage[f.p].ore = 400; f.b.storage[f.p].alloy = 300;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.home.id, recipe: 'alloy_direct', mode: 'count', n: 3 })).toBeNull();
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.b.id, kind: 'warehouse' })).toBeNull();
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.home.id, item: 'alloy', kind: 'transfer', amount: 100, priority: 5, repeat: false } })).toBeNull();
    const field = Object.values(f.sim.st.fields).find(x => x.res === 'ore')!;
    const g = f.sim.newGroup(f.p, '채굴대'); f.sim.spawnShip(f.p, 'miner', 'std', g.id, field.pos);
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'mine', field: field.id, deliver: 'astra', sell: true } })).toBeNull();
    // an older save: none of this was ever recorded as work
    delete f.sim.st.works; delete f.sim.st.approvals;
    const engine = JSON.stringify({ orders: f.home.orders, modules: f.b.modules.map(m => m.id), jobs: Object.keys(f.sim.st.logisticsJobs ?? {}), op: f.sim.st.groups[g.id].op });
    run(f.sim, 3);
    expect(JSON.stringify({ orders: f.home.orders?.map(o => ({ ...o, done: 0, why: undefined })), modules: f.b.modules.map(m => m.id), jobs: Object.keys(f.sim.st.logisticsJobs ?? {}), op: f.sim.st.groups[g.id].op }))
      .toBe(JSON.stringify({ orders: JSON.parse(engine).orders.map((o: any) => ({ ...o, done: 0, why: undefined })), modules: JSON.parse(engine).modules, jobs: JSON.parse(engine).jobs, op: JSON.parse(engine).op }));
    const ws = works(f.sim, f.p);
    expect(ws.filter(w => w.kind === 'production')).toHaveLength(1);
    expect(ws.filter(w => w.kind === 'facility' && w.ref.station === f.b.id)).toHaveLength(1);
    expect(ws.filter(w => w.kind === 'transport' && !w.ref.job?.startsWith('x'))).not.toHaveLength(0);
    expect(ws.filter(w => w.kind === 'operation' && !terminal(w))).toHaveLength(1);
    expect(ws.every(w => w.adopted)).toBe(true);
    // repeated passes add nothing
    const n = ws.length; run(f.sim, 40);
    const keys = works(f.sim, f.p).filter(w => !terminal(w)).map(w => JSON.stringify([w.kind, w.ref.station, w.ref.order, w.ref.module, w.ref.job, w.ref.group, w.ref.op]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(works(f.sim, f.p).filter(w => w.adopted && w.kind !== 'transport').length).toBeLessThanOrEqual(n);
    // the engines kept running normally: the transfer and the production finished
    expect(qty(f.home.storage[f.p], 'alloy')).toBeGreaterThan(0);
  });
  it('procurement shipments appear under the work they supply', () => {
    const f = fixture(); f.b.storage[f.p].alloy = 900;
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.home.id, kind: 'warehouse' })).toBeNull();
    run(f.sim, 25);
    const fac = works(f.sim, f.p).find(w => w.kind === 'facility')!;
    const supply = works(f.sim, f.p).filter(w => w.kind === 'transport' && w.parent === fac.id);
    expect(supply.length).toBeGreaterThan(0); expect(supply.every(w => w.auto && w.title.startsWith('조달'))).toBe(true);
  });
});

export type { Work };
export { approvals };

describe('company-wide production planning', () => {
  const addStation = (f: ReturnType<typeof fixture>, id: string, dx: number, modules: string[]) => {
    const s: Station = { ...structuredClone(f.b), id, name: id, pos: { ...f.a.pos, x: f.a.pos.x + dx, z: f.a.pos.z + 300 }, storage: { [f.p]: {} }, orders: [], jobs: [], builds: [], modules: modules.map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
    f.sim.st.stations[id] = s; return s;
  };
  const purchases = (f: ReturnType<typeof fixture>) => f.co.ops?.ledger.reduce((n, h) => n + (h.exp.purchase ?? 0), 0) ?? 0;
  it('a station goal is made at another own station, with the intermediate made at a third, then delivered — no purchases, no excess', () => {
    const f = fixture(); f.co.tech = [];
    const c = addStation(f, 'ops_c', 1300, ['core', 'power', 'power', 'machine_shop', 'warehouse']);
    f.home.storage[f.p].ore = 2000; f.b.storage[f.p].alloy = 200;
    const mach = f.sim.st.stations; void mach;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.b.id, item: 'machinery', target: 30, maintain: false, buy: true, produce: true } })).toBeNull();
    const g = works(f.sim, f.p).find(w => w.goal?.k === 'stockpile')!;
    const prod = () => works(f.sim, f.p).filter(w => w.kind === 'production' && w.parent === g.id);
    run(f.sim, 25);
    const mOrders = prod().filter(w => w.ref.station === c.id), metal = prod().filter(w => w.ref.station === f.home.id);
    expect(mOrders).toHaveLength(1); expect(c.orders![0].recipe).toBe('machinery'); expect(c.orders![0].n).toBe(5);
    expect(metal.length).toBeGreaterThanOrEqual(1); // the intermediate (metal) is planned at the refinery station
    const metalBatches = () => f.home.orders!.filter(o => o.recipe.startsWith('metal')).reduce((n, o) => n + o.n, 0);
    expect(metalBatches()).toBe(4); // 5 machinery batches × 16 metal = 80 = 4 refinery batches
    if (approvals(f.sim, f.p).length) console.log(JSON.stringify(approvals(f.sim, f.p).map(a => [a.title, a.reason, a.situation, a.items])));
    expect(approvals(f.sim, f.p)).toHaveLength(0); // everything comes from own stock — nothing to approve
    run(f.sim, 60); expect(metalBatches()).toBeLessThanOrEqual(4); expect(c.orders!.reduce((n, o) => n + o.n, 0)).toBeLessThanOrEqual(5);
    const done = (() => { for (let t = 0; t < 9000 && g.state !== 'done'; t += .25) f.sim.update(.25); return g.state === 'done'; })();
    if (!done) console.log(JSON.stringify({ g: [g.state, g.reason], kids: works(f.sim, f.p).filter(w => w.parent === g.id).map(w => [w.kind, w.state, w.reason, w.ref.station]) }));
    expect(done).toBe(true);
    expect(qty(f.b.storage[f.p], 'machinery')).toBeGreaterThanOrEqual(30);
    // made exactly what was needed: 30 machinery in all, metal fully consumed
    const machAll = Object.values(f.sim.st.stations).reduce((n, s) => n + qty(s.storage[f.p], 'machinery'), 0);
    expect(machAll).toBe(30);
    expect(purchases(f)).toBe(0);
  }, 120000);
  it('a company-wide goal spreads batches over every station with the lines and counts stock wherever it is', () => {
    const f = fixture(); f.co.tech = [];
    const c = addStation(f, 'ops_c', 1300, ['core', 'power', 'power', 'refinery', 'warehouse']);
    f.home.storage[f.p].ore = 3000; c.storage[f.p].ore = 3000; f.b.storage[f.p].metal = 100;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', scope: 'company', station: f.home.id, item: 'metal', target: 600, maintain: false, buy: false, produce: true } })).toBeNull();
    const g = works(f.sim, f.p).find(w => w.goal?.k === 'stockpile')!;
    expect(g.title).toContain('회사 전체');
    const batches = () => [f.home, c].map(s => (s.orders ?? []).filter(o => o.recipe.startsWith('metal')).reduce((n, o) => n + o.n, 0));
    const [h0, c0] = batches(); expect(h0).toBeGreaterThan(0); expect(c0).toBeGreaterThan(0);
    expect(h0 + c0).toBe(Math.ceil((600 - 100) / 20)); // the 100 metal at ops_b counts — no transfer, no extra batches
    expect(Object.keys(f.sim.st.logisticsJobs ?? {})).toHaveLength(0);
    run(f.sim, 60); const [h1, c1] = batches(); expect(h1 + c1).toBe(h0 + c0);
    expect(until(f.sim, () => g.state === 'done', 6000)).toBe(true);
    const total = Object.values(f.sim.st.stations).reduce((n, s) => n + qty(s.storage[f.p], 'metal'), 0);
    expect(total).toBeGreaterThanOrEqual(600); expect(total).toBeLessThan(600 + 20 * 2);
    expect(purchases(f)).toBe(0);
  }, 120000);
  it('a company-wide and a station goal for the same item may coexist; a second identical goal is refused', () => {
    const f = fixture();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', scope: 'company', station: f.home.id, item: 'metal', target: 100, maintain: true, buy: false, produce: false } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'metal', target: 100, maintain: true, buy: false, produce: false } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', scope: 'company', station: f.b.id, item: 'metal', target: 50, maintain: true, buy: false, produce: false } })).toMatch(/회사 전체/);
  });
});

describe('approvals offer real alternatives and review them after a rejection', () => {
  it('a purchase approval lists other markets and making the item, each with its expected effect', () => {
    const f = fixture();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.b.id, item: 'machinery', target: 60, maintain: false, buy: true, produce: true } })).toBeNull();
    run(f.sim, 3);
    const ap = approvals(f.sim, f.p)[0]; expect(ap).toBeTruthy();
    const ids = ap.options.map(o => o.id);
    expect(ids).toContain('approve'); expect(ids.some(i => i.startsWith('market:'))).toBe(true);
    expect(ids).toContain('facility:machine_shop'); // no own machine shop anywhere → build one is an option
    for (const o of ap.options.filter(o => o.id.startsWith('market:') || o.id.startsWith('facility:'))) expect(o.detail).toContain('추정');
    expect(ap.options.find(o => o.id === 'wait')!.detail).toContain('영향');
  });
  it('rejecting leads to one follow-up with the alternatives only; rejecting that ends asking for 6 hours', () => {
    const f = fixture();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.b.id, item: 'machinery', target: 60, maintain: false, buy: true, produce: true } })).toBeNull();
    run(f.sim, 3);
    const first = approvals(f.sim, f.p)[0];
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: first.id, option: 'reject' })).toBeNull();
    const alt = approvals(f.sim, f.p); expect(alt).toHaveLength(1); expect(alt[0].key).toBe('alt');
    expect(alt[0].options.some(o => o.id === 'approve')).toBe(false); // the rejected proposal is not asked again
    expect(alt[0].options.some(o => o.id.startsWith('market:') || o.id.startsWith('facility:'))).toBe(true);
    const g = works(f.sim, f.p).find(w => w.goal)!; expect(g.log.some(l => l.text.includes('거절 후 대안 검토'))).toBe(true);
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: alt[0].id, option: 'reject' })).toBeNull();
    const credits = f.co.credits; run(f.sim, 2 * 3600);
    expect(approvals(f.sim, f.p)).toHaveLength(0); expect(approvals(f.sim, f.p, false).length).toBe(2);
    expect(f.co.ops!.ledger.reduce((n, h) => n + (h.exp.purchase ?? 0), 0)).toBe(0); expect(f.co.credits).toBeLessThanOrEqual(credits);
  }, 120000);
  it('choosing another market buys there; choosing to build the facility opens a facility goal with that budget', () => {
    const f = fixture();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'machinery', target: 30, maintain: false, buy: true, produce: true } })).toBeNull();
    run(f.sim, 3);
    let ap = approvals(f.sim, f.p)[0]; const m = ap.options.find(o => o.id.startsWith('market:'))!;
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: ap.id, option: m.id, scope: 'work' })).toBeNull();
    run(f.sim, 15);
    const buys = works(f.sim, f.p).filter(w => w.kind === 'buy'); expect(buys.length).toBeGreaterThan(0);
    expect(buys.every(w => w.ref.station === m.id.slice(7))).toBe(true);
    // second company: build instead of buying
    const g2 = f.sim.addPlayer('대안 건설'); const co2 = f.sim.st.companies[g2]; co2.credits = 5e6;
    const own = { ...structuredClone(f.b), id: 'ops_x', name: 'ops_x', owner: g2, storage: { [g2]: {} }, orders: [], jobs: [], builds: [] };
    f.sim.st.stations.ops_x = own;
    const hg = f.sim.newGroup(g2, '수송'), hs = f.sim.spawnShip(g2, 'hauler', 'std', hg.id, f.a.pos); (f.sim as any).dockShip(hs, f.a);
    expect(f.sim.command(g2, { c: 'poolShips', ships: [hs.id], on: true })).toBeNull();
    expect(f.sim.command(g2, { c: 'workCreate', goal: { k: 'stockpile', station: 'ops_x', item: 'machinery', target: 30, maintain: false, buy: true, produce: true } })).toBeNull();
    run(f.sim, 3);
    ap = approvals(f.sim, g2)[0]; const fac = ap.options.find(o => o.id === 'facility:machine_shop')!;
    expect(f.sim.command(g2, { c: 'approvalDecide', approval: ap.id, option: fac.id })).toBeNull();
    const fg = works(f.sim, g2).find(w => w.goal?.k === 'facilities')!;
    expect(fg).toBeTruthy(); expect(fg.budget!.limit).toBeCloseTo(fac.cost!, 6);
    run(f.sim, 15); expect(own.modules.some(m => m.kind === 'machine_shop')).toBe(true);
    expect(works(f.sim, g2).filter(w => w.kind === 'buy')).toHaveLength(0); // the stockpile does not buy while the shop is being built
  }, 120000);
});

describe('default policy in an ordinary session: no needless approvals, a blocked work never stalls the rest', () => {
  it('two hours of mixed play raise only the one approval that is really needed', () => {
    const f = fixture(); f.co.tech = [];
    // own stock for what the player builds and makes
    f.b.storage[f.p].alloy = 3000; f.b.storage[f.p].structure = 300; f.b.storage[f.p].machinery = 100; f.home.storage[f.p].ore = 3000;
    const field = Object.values(f.sim.st.fields).find(x => x.res === 'ore')!;
    const mg = f.sim.newGroup(f.p, '채굴대'); f.sim.spawnShip(f.p, 'miner', 'std', mg.id, field.pos);
    expect(f.sim.command(f.p, { c: 'setOp', group: mg.id, op: { k: 'mine', field: field.id, deliver: 'astra', sell: true } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'crystal', amount: 20 })).toBeNull();
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.home.id, kind: 'warehouse' })).toBeNull();
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.home.id, recipe: 'metal', mode: 'count', n: 10 })).toBeNull();
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.home.id, item: 'alloy', kind: 'transfer', amount: 400, priority: 5, repeat: false } })).toBeNull();
    // a goal ordered with a budget runs without asking; one without budget that must buy asks once
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'electronics', target: 40, maintain: false, buy: true, produce: false }, budget: 200000 })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.b.id, item: 'titanium', target: 200, maintain: true, buy: true, produce: false } })).toBeNull();
    const raised: string[] = [];
    for (let t = 0; t < 2 * 3600; t += .25) { f.sim.update(.25); for (const a of approvals(f.sim, f.p)) if (!raised.includes(a.id)) raised.push(a.id); }
    const all = approvals(f.sim, f.p, false);
    if (raised.length !== 1) console.log(JSON.stringify(all.map(a => [a.title, a.kind, a.key, a.reason, a.situation, a.state, a.note])));
    expect(raised).toHaveLength(1); expect(all).toHaveLength(1);
    const ti = works(f.sim, f.p).find(w => w.goal?.k === 'stockpile' && w.goal.item === 'titanium')!;
    expect(all[0].work).toBe(ti.id); expect(ti.state).toBe('waiting');
    // everything else carried on meanwhile
    const el = works(f.sim, f.p).find(w => w.goal?.k === 'stockpile' && w.goal.item === 'electronics')!;
    expect(el.state).toBe('done');
    expect(works(f.sim, f.p).filter(w => w.kind === 'facility')[0].state).toBe('done');
    expect(works(f.sim, f.p).find(w => w.kind === 'production')!.state).toBe('done');
    expect(works(f.sim, f.p).find(w => w.kind === 'transport' && !w.parent)!.state).toBe('done');
    expect(works(f.sim, f.p).find(w => w.kind === 'operation')!.state).toBe('running');
  }, 300000);
});
