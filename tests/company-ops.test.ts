// Company operations (통합 회사 운영): works, goals, approvals, inventory and ledger — scenarios A–H.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type Station } from '../src/world/types';
import { companyInventory, terminal, type Work, type Approval } from '../src/world/operations';
import { recipeFor, TECHS } from '../src/world/industry';
import { grantBlueprint, hullBlueprint } from '../src/world/blueprints';
import { buildNeeds } from '../src/world/production';
import { moduleMaterials } from '../src/world/stations';
import { addFoundationFreighter } from './helpers/foundation';
import { legacyView } from '../src/server/sync';

import { fixture, run, until, works, approvals, goal, kids } from './helpers/opsFixture';

describe('A — simple purchase', () => {
  it('records a finished work immediately, spends exactly the market cost, never asks for approval', () => {
    const f = fixture(), price = f.sim.price(f.a, 'alloy', 'buy'), credits = f.co.credits, stock = f.a.market!.alloy.stock;
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 100 })).toBeNull();
    const ws = works(f.sim, f.p).filter(w => w.kind === 'buy');
    expect(ws).toHaveLength(1); expect(ws[0].state).toBe('done'); expect(ws[0].cost).toBeCloseTo(price * 100, 6);
    expect(credits - f.co.credits).toBeCloseTo(price * 100, 6); expect(stock - f.a.market!.alloy.stock).toBe(100); expect(qty(f.a.storage[f.p], 'alloy')).toBe(100);
    expect(approvals(f.sim, f.p, false)).toHaveLength(0);
    // the cash ledger books it as a purchase; a retried request with the same identity changes nothing
    expect(f.co.ops!.ledger.at(-1)!.exp.purchase).toBeCloseTo(price * 100, 6);
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 5, request: { seq: 1, id: 'retry-abcdef' } })).toBeNull();
    const after = f.co.credits; expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 5, request: { seq: 1, id: 'retry-abcdef' } })).toBeNull();
    expect(f.co.credits).toBe(after); expect(works(f.sim, f.p).filter(w => w.kind === 'buy')).toHaveLength(2);
    // inventory: one row, counted once
    const inv = companyInventory(f.sim.st, f.p).find(r => r.item === 'alloy')!; expect(inv.total).toBe(105); expect(inv.available).toBe(105);
  });
  it('a sale is recorded with its income and books sales revenue by item', () => {
    const f = fixture(); f.a.storage[f.p].alloy = 50; const before = f.co.credits;
    expect(f.sim.command(f.p, { c: 'sell', station: 'astra', res: 'alloy', amount: 50 })).toBeNull();
    const w = works(f.sim, f.p).find(x => x.kind === 'sell')!; expect(w.state).toBe('done'); expect(w.income).toBeCloseTo(f.co.credits - before, 6);
    const h = f.co.ops!.ledger.at(-1)!; expect(h.inc.sales).toBeCloseTo(f.co.credits - before, 6); expect(h.sales!.alloy).toBeCloseTo(f.co.credits - before, 6);
  });
});

describe('B — alloy stockpile goal (transfer + purchase + approval)', () => {
  it('uses company stock first, asks once for the purchase, then buys and moves the rest without duplicates', () => {
    const f = fixture(); f.b.storage[f.p].alloy = 1000;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 3000, maintain: false, buy: true, produce: false } })).toBeNull();
    const g = goal(f.sim, f.p);
    // internal transfer planned straight away, purchase needs approval (no authority by default)
    expect(kids(f.sim, g).some(k => k.kind === 'transport' && f.sim.st.logisticsJobs![k.ref.job!].from === f.b.id)).toBe(true);
    const open = approvals(f.sim, f.p); expect(open).toHaveLength(1); expect(open[0].kind).toBe('purchase');
    expect(open[0].items[0].amount).toBe(2000); expect(open[0].estimate.cost).toBeGreaterThan(0); expect(open[0].options.map(o => o.id)).toEqual(expect.arrayContaining(['approve', 'wait', 'reject']));
    const credits = f.co.credits; run(f.sim, 60); expect(f.co.ops!.ledger.reduce((n, h) => n + (h.exp.purchase ?? 0), 0)).toBe(0); expect(approvals(f.sim, f.p)).toHaveLength(1); // no repeat, no purchase (only upkeep accrues)
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: open[0].id, option: 'approve', scope: 'work' })).toBeNull();
    expect(until(f.sim, () => g.state === 'done', 4000)).toBe(true);
    expect(qty(f.home.storage[f.p], 'alloy')).toBeGreaterThanOrEqual(3000);
    const bought = works(f.sim, f.p).filter(w => w.kind === 'buy' && w.parent === g.id);
    const spent = credits - f.co.credits;
    // every credit spent went to market purchases charged to the goal (upkeep is excluded in this calm fixture via the ledger)
    const purchase = f.co.ops!.ledger.reduce((n, h) => n + (h.exp.purchase ?? 0), 0);
    expect(g.cost).toBeCloseTo(purchase, 3); expect(g.budget!.spent).toBeCloseTo(purchase, 3); expect(spent).toBeGreaterThanOrEqual(purchase - 1e-6);
    // bought exactly the shortfall (≤ one batch rounding) — nothing duplicated
    const units = bought.reduce((n, w) => n + w.progress.done, 0);
    expect(units).toBeGreaterThanOrEqual(2000); expect(units).toBeLessThanOrEqual(2000 + 2);
    expect(approvals(f.sim, f.p)).toHaveLength(0);
  }, 60000);
  it('production path: plans an order for the shortfall and asks once (on the goal) to buy its inputs', () => {
    const f = fixture(), r = recipeFor(f.sim.st, 'alloy_direct')!;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 28, maintain: true, buy: true, produce: true } })).toBeNull();
    const g = goal(f.sim, f.p); const child = kids(f.sim, g).find(k => k.kind === 'production')!; expect(child).toBeTruthy();
    const order = f.home.orders!.find(o => o.id === child.ref.order)!;
    expect(order.mode).toBe('count'); expect(order.recipe).toBe(r.id); expect(order.n).toBe(Math.ceil(28 / r.out.alloy));
    run(f.sim, 25); // procurement finds no ore, the goal raises one purchase approval for the inputs of its orders
    expect(approvals(f.sim, f.p)).toHaveLength(1);
    const ap = approvals(f.sim, f.p).find(a => a.work === g.id)!; expect(ap).toBeTruthy();
    expect(ap.items.map(x => x.item).sort()).toEqual(Object.keys(r.in).sort());
    expect(f.home.orders!.filter(o => o.recipe === r.id)).toHaveLength(1); // repeated passes never stack orders
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: ap.id, option: 'approve', scope: 'work' })).toBeNull();
    expect(until(f.sim, () => qty(f.home.storage[f.p], 'alloy') >= 28, 3000)).toBe(true);
    run(f.sim, 15); expect(g.state).toBe('running'); expect(g.reason).toContain('유지'); // maintain goal keeps going
    // the goal's authority paid for the inputs: budget spent equals purchases
    const purchase = f.co.ops!.ledger.reduce((n, h) => n + (h.exp.purchase ?? 0), 0);
    expect(g.budget?.spent ?? child.budget?.spent ?? 0).toBeCloseTo(purchase, 3);
  }, 60000);
  it('survives save/restore mid-goal without buying twice', () => {
    const f = fixture();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 900, maintain: false, buy: true, produce: false }, budget: 1e6 })).toBeNull();
    const g = goal(f.sim, f.p); run(f.sim, 4);
    const spent = g.budget!.spent; expect(spent).toBeGreaterThan(0);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    const rg = restored.st.works![g.id]; expect(rg.budget!.spent).toBeCloseTo(spent, 6);
    expect(until(restored, () => rg.state === 'done', 3000)).toBe(true);
    const total = Object.values(restored.st.works!).filter(w => w.parent === g.id && w.kind === 'buy').reduce((n, w) => n + w.cost, 0);
    expect(total).toBeCloseTo(rg.budget!.spent, 3); expect(total / restored.price(restored.st.stations.astra, 'alloy', 'buy')).toBeLessThan(900 * 1.1);
    expect(qty(restored.st.stations[f.home.id].storage[f.p], 'alloy')).toBeGreaterThanOrEqual(900);
  }, 60000);
});

describe('C — station founding from the strategic map', () => {
  it('the founding order becomes a work that follows the constructor to a finished core', () => {
    const sim = WorldSim.create(62); for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75);
    const p = sim.addPlayer('설립'); sim.st.companies[p].credits = 3_000_000;
    sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' });
    const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
    const a = sim.st.stations.astra.pos;
    expect(sim.command(p, { c: 'buy', station: 'astra', res: 'alloy', amount: 300 })).toBeNull();
    addFoundationFreighter(sim, p, cg.id);
    expect(sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '본부 기지' } })).toBeNull();
    const w = works(sim, p).find(x => x.kind === 'station')!; expect(w.state).toBe('running'); expect(w.reason).toContain('이동');
    expect(until(sim, () => w.state === 'done', 400)).toBe(true);
    expect(sim.st.stations[w.ref.station!].modules.find(m => m.kind === 'core')!.built).toBe(true);
  });
});

describe('D — ship builds', () => {
  it('a fleet goal asks once for the build cost, then builds and launches with procured parts', () => {
    const f = fixture(); f.co.tech = Object.keys(TECHS);
    const hull = 'patrol_pathfinder'; expect(grantBlueprint(f.sim.st, f.co, hullBlueprint(hull)!, 'fixture', f.sim.time)).toBe(true);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'fleet', station: f.home.id, hull, preset: 'pathfinder_patrol', count: 2 } })).toBeNull();
    const g = goal(f.sim, f.p); const ap = approvals(f.sim, f.p)[0]; expect(ap.work).toBe(g.id);
    expect(f.home.builds).toHaveLength(0); // nothing started without authority
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: ap.id, option: 'approve', scope: 'work' })).toBeNull();
    run(f.sim, 12); expect(f.home.builds!.length).toBe(2);
    const b = f.home.builds![0]; const needs = buildNeeds(b.classId, b.loadoutId, b.fit, b);
    for (const [item, n] of Object.entries(needs)) f.b.storage[f.p][item] = n * 2;
    expect(until(f.sim, () => g.state === 'done', 8000)).toBe(true);
    expect(Object.values(f.sim.st.ships).filter(s => s.owner === f.p && s.hull === hull)).toHaveLength(2);
    expect(kids(f.sim, g).filter(k => k.kind === 'ship' && k.state === 'done')).toHaveLength(2);
  }, 60000);
  it('a build ordered in the station screen is a work; cancelling it there cancels the work', () => {
    const f = fixture(); f.co.tech = Object.keys(TECHS); grantBlueprint(f.sim.st, f.co, hullBlueprint('patrol_pathfinder')!, 'fixture', 0);
    expect(f.sim.command(f.p, { c: 'buildShip', station: f.home.id, classId: 'corvette', loadoutId: '', hull: 'patrol_pathfinder', variant: 'patrol_pathfinder_std', preset: 'pathfinder_patrol' })).toBeNull();
    const w = works(f.sim, f.p).find(x => x.kind === 'ship')!; expect(w.state).not.toBe('done'); expect(w.cost).toBeGreaterThan(0);
    expect(f.sim.command(f.p, { c: 'workOp', work: w.id, op: 'cancel' })).toBeNull();
    expect(w.state).toBe('cancelled'); expect(f.home.builds).toHaveLength(0);
  });
});

describe('E — research', () => {
  it('a queued project is a work that completes when the technology is learned', () => {
    const f = fixture(); f.home.modules.push({ kind: 'lab_basic', slot: 9, built: true, progress: 1 });
    const tech = 'process_control'; expect(f.sim.command(f.p, { c: 'research', station: f.home.id, tech })).toBeNull();
    const w = works(f.sim, f.p).find(x => x.kind === 'research')!; expect(w.ref.tech).toBe(tech);
    expect(f.sim.command(f.p, { c: 'workOp', work: w.id, op: 'pause' })).toBeNull(); expect(f.co.research![0].paused).toBe(true); expect(w.state).toBe('paused');
    expect(f.sim.command(f.p, { c: 'workOp', work: w.id, op: 'resume' })).toBeNull();
    for (const [i, n] of Object.entries(TECHS[tech].cost ?? {})) f.home.storage[f.p][i] = n;
    expect(until(f.sim, () => terminal(w), 6000)).toBe(true);
    expect(w.state).toBe('done'); expect(f.co.tech).toContain(tech);
  }, 30000);
});

describe('F — recurring trade', () => {
  it('buys, carries and sells per cycle, tracks real profit, and stops after two losing cycles', () => {
    const f = fixture(1203, 60);
    const to = f.sim.st.stations.drakeout; expect(to.market?.alloy).toBeTruthy(); const credits = f.co.credits;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 200, maxBuy: 60, minSell: 30, minProfit: 0, cycles: 2 }, budget: 100000 })).toBeNull();
    const g = goal(f.sim, f.p); expect(g.rt!.phase).toBe('move'); expect(g.rt!.sellQuote).toBeGreaterThan(0);
    expect(until(f.sim, () => terminal(g), 6000)).toBe(true);
    expect(g.state).toBe('done'); expect(g.rt!.cycles).toBe(2);
    // profit is measured from real sale proceeds minus real purchase cost
    const sold = Object.values(f.sim.st.logisticsJobs!).filter(j => kids(f.sim, g).some(k => k.ref.job === j.id)).reduce((n, j) => n + j.earned, 0);
    expect(g.rt!.profit).toBeCloseTo(sold - g.cost, 3);
    expect(f.co.credits - credits).toBeLessThanOrEqual((g.rt!.profit ?? 0) + 1e-6); // upkeep/other may reduce, never inflate
  }, 60000);
  it('does not repeat at a loss: learns the realised sale price and stops buying when it no longer pays', () => {
    const f = fixture(1204, 60), d = f.sim.st.stations.drakeout, base = d.market!.alloy.stock;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 400, maxBuy: 60, minSell: 0, minProfit: 0, cycles: 0 }, budget: 1e6 })).toBeNull();
    const g = goal(f.sim, f.p);
    // a glut appears at the destination while the cargo travels: the first sale realises a loss
    expect(until(f.sim, () => { if (g.rt?.phase === 'move') d.market!.alloy.stock = d.market!.alloy.target * 2.2; return (g.rt?.cycles ?? 0) >= 1; }, 3000)).toBe(true);
    d.market!.alloy.stock = base;
    const log = g.log.map(l => l.text).join('\n'); expect(log).toContain('손실');
    expect(g.rt!.sellRatio!).toBeLessThan(0.9);
    // with the quote back to normal the learned ratio still says the trade loses money → no new purchase
    const spent = g.cost; run(f.sim, 600);
    expect(g.cost).toBe(spent); expect(g.reason).toContain('수익 조건 미충족');
    expect(f.sim.command(f.p, { c: 'workOp', work: g.id, op: 'cancel' })).toBeNull();
  }, 60000);
  it('two consecutive realised losses pause the goal and raise one loss report', () => {
    const f = fixture(1207, 60), d = f.sim.st.stations.drakeout;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 400, maxBuy: 60, minSell: 0, minProfit: 0, cycles: 0 }, budget: 1e6 })).toBeNull();
    const g = goal(f.sim, f.p), base = d.market!.alloy.stock;
    // the quote looks attractive at decision time but the market collapses during every trip
    const ok = until(f.sim, () => { if (g.rt?.phase === 'move') d.market!.alloy.stock = d.market!.alloy.target * 2.2; else { d.market!.alloy.stock = base * 0.2; if (g.rt) g.rt.sellRatio = 1; } return g.state === 'paused' || (g.rt?.cycles ?? 0) >= 5; }, 8000);
    expect(ok).toBe(true); expect(g.state).toBe('paused'); expect(g.rt!.cycles).toBe(2);
    const reps = approvals(f.sim, f.p).filter(a => a.kind === 'loss'); expect(reps).toHaveLength(1); expect(reps[0].work).toBe(g.id);
    const spent = g.cost; run(f.sim, 300); expect(g.cost).toBe(spent);
  }, 60000);
});

describe('G — over-budget approval and approval fatigue', () => {
  it('stops at the budget, asks once, honours reject (no re-ask) and a modified approval amount', () => {
    const f = fixture(), price = f.sim.price(f.a, 'alloy', 'buy');
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 1000, maintain: false, buy: true, produce: false }, budget: price * 300 })).toBeNull();
    const g = goal(f.sim, f.p);
    run(f.sim, 40);
    expect(g.budget!.spent).toBeLessThanOrEqual(price * 300 + 1e-6);
    let open = approvals(f.sim, f.p); expect(open).toHaveLength(1); expect(open[0].kind).toBe('budget');
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: open[0].id, option: 'reject' })).toBeNull();
    const spent = g.budget!.spent; run(f.sim, 120);
    expect(g.budget!.spent).toBe(spent); expect(approvals(f.sim, f.p)).toHaveLength(0); // rejection honoured, not re-asked
    expect(g.state).not.toBe('done');
    // a later decision with modified conditions (player raises the budget explicitly) resumes purchasing
    expect(f.sim.command(f.p, { c: 'workOp', work: g.id, op: 'budget', value: price * 2000 })).toBeNull();
    g.rt!.noBuyUntil = 0; // budget raised by the player = new authority; clear the hold
    expect(until(f.sim, () => g.state === 'done', 3000)).toBe(true);
    expect(g.budget!.spent).toBeLessThanOrEqual(price * 2000 * 1.2);
  }, 60000);
  it('minimum balance is never breached without approval and splitting purchases does not bypass the limit', () => {
    const f = fixture(); const price = f.sim.price(f.a, 'alloy', 'buy');
    expect(f.sim.command(f.p, { c: 'opsPolicy', policy: { autoApproveBelow: price * 200, minCredits: 0 } })).toBeNull();
    // a 1000-unit requirement is not "small" just because each batch is
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 1000, maintain: false, buy: true, produce: false } })).toBeNull();
    const credits = f.co.credits; run(f.sim, 30); expect(f.co.credits).toBe(credits); expect(approvals(f.sim, f.p)).toHaveLength(1);
    f.co.credits = 1000; expect(f.sim.command(f.p, { c: 'opsPolicy', policy: { autonomy: 'auto', minCredits: 900 } })).toBeNull();
    // purchases stop at the floor (upkeep may still lower the balance — that is not a purchase decision)
    run(f.sim, 30); const purchased = f.co.ops!.ledger.reduce((t, h) => t + (h.exp.purchase ?? 0), 0);
    expect(purchased).toBeGreaterThan(0); expect(1000 - purchased).toBeGreaterThanOrEqual(900 - 1e-6);
    expect(approvals(f.sim, f.p).some(a => a.kind === 'credits')).toBe(true);
  }, 30000);
  it('a risky cheaper market is offered against the safe one with estimates labelled as such', () => {
    const f = fixture(1205, 0); // keep real security levels
    const pick = Object.values(f.sim.st.stations).find(s => s.public && s.market?.alloy && 100 - (f.sim.sysOf(s.pos) ? f.sim.st.systems[f.sim.sysOf(s.pos)!.id].security : 100) > 60)!;
    expect(pick).toBeTruthy(); pick.market!.alloy.stock = pick.market!.alloy.target * 4; // glut → much cheaper
    const safeBest = Math.min(...Object.values(f.sim.st.stations).filter(s => s.public && s.market?.alloy && s.id !== pick.id).map(s => f.sim.price(s, 'alloy', 'buy')));
    expect(f.sim.price(pick, 'alloy', 'buy')).toBeLessThan(safeBest * 0.85); // the premise of the scenario holds
    const credits = f.co.credits;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 900, maintain: false, buy: true, produce: false }, budget: 1e6 })).toBeNull();
    run(f.sim, 5);
    const ap = approvals(f.sim, f.p).find(a => a.kind === 'risk')!;
    expect(ap).toBeTruthy(); expect(f.co.credits).toBe(credits); // nothing bought on the risky route without a decision
    expect(ap.risk!.note).toContain('추정'); expect(ap.options.some(o => o.id === 'safe')).toBe(true); expect(ap.estimate.note).toContain('추정');
    // choosing the safe alternative buys on a route within the risk limit
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: ap.id, option: 'safe' })).toBeNull();
    run(f.sim, 30);
    const bought = works(f.sim, f.p).filter(w => w.kind === 'buy'); expect(bought.length).toBeGreaterThan(0);
    expect(bought.every(w => !!w.ref.station && w.ref.station !== pick.id)).toBe(true);
  });
});

describe('cancel, ownership, sync', () => {
  it('cancelling a goal keeps loaded cargo on board and never refunds spending', () => {
    const f = fixture(); f.b.storage[f.p].alloy = 900;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 900, maintain: false, buy: false, produce: false } })).toBeNull();
    const g = goal(f.sim, f.p);
    expect(until(f.sim, () => Object.values(f.sim.st.logisticsJobs ?? {}).some(j => j.carried > 0), 400)).toBe(true);
    const loaded = Object.values(f.sim.st.logisticsJobs!).find(j => j.carried > 0)!, onShip = qty(f.sim.st.ships[loaded.ship!].cargo, 'alloy');
    expect(f.sim.command(f.p, { c: 'workOp', work: g.id, op: 'cancel' })).toBeNull();
    expect(g.state).toBe('cancelled'); expect(qty(f.sim.st.ships[loaded.ship!].cargo, 'alloy')).toBe(onShip);
    const inv = companyInventory(f.sim.st, f.p).find(r => r.item === 'alloy')!; expect(inv.total).toBeCloseTo(900, 6);
  });
  it('rejects control of another company’s work and replicates works/approvals only to the owner', () => {
    const f = fixture(), q = f.sim.addPlayer('다른 회사');
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 500, maintain: false, buy: true, produce: false } })).toBeNull();
    const g = goal(f.sim, f.p), ap = approvals(f.sim, f.p)[0];
    expect(f.sim.command(q, { c: 'workOp', work: g.id, op: 'cancel' })).not.toBeNull();
    expect(f.sim.command(q, { c: 'approvalDecide', approval: ap.id, option: 'approve' })).not.toBeNull();
    const other = legacyView(f.sim.st, { company: q }, 'astra'), mine = legacyView(f.sim.st, { company: f.p }, 'astra');
    expect(Object.keys(other.works ?? {})).toHaveLength(0); expect(Object.keys(other.approvals ?? {})).toHaveLength(0);
    expect(Object.keys(mine.works ?? {})).toContain(g.id); expect((other.companies[f.p] as any).ops).toBeUndefined();
  });
  it('facility order from the station screen becomes a work and asks to buy materials once', () => {
    const f = fixture();
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.home.id, kind: 'warehouse' })).toBeNull();
    const w = works(f.sim, f.p).find(x => x.kind === 'facility')!; expect(w.state).toBe('waiting');
    run(f.sim, 25); const ap = approvals(f.sim, f.p).find(a => a.work === w.id)!; expect(ap).toBeTruthy();
    const m = f.home.modules.find(x => x.id === w.ref.module)!; expect(ap.items.map(x => x.item).sort()).toEqual(Object.keys(moduleMaterials(m)).sort());
    run(f.sim, 60); expect(approvals(f.sim, f.p).filter(a => a.work === w.id)).toHaveLength(1);
    expect(f.sim.command(f.p, { c: 'approvalDecide', approval: ap.id, option: 'approve', scope: 'once' })).toBeNull();
    expect(until(f.sim, () => w.state === 'done', 4000)).toBe(true);
  }, 60000);
});

describe('H — long autonomous run', () => {
  it('runs goals unattended for 6 game hours with bounded state and consistent money', () => {
    const f = fixture(1206); f.co.credits = 2e6; f.b.storage[f.p].alloy = 500;
    expect(f.sim.command(f.p, { c: 'opsPolicy', policy: { autonomy: 'auto', minCredits: 500000, hourlyLimit: 400000 } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'alloy', target: 1500, maintain: true, buy: true, produce: true } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 300, maxBuy: 60, minSell: 30, minProfit: 0, cycles: 0 } })).toBeNull();
    const t0 = Date.now(); let ticks = 0, worst = 0;
    for (let t = 0; t < 6 * 3600; t += .25) { const s = performance.now(); f.sim.update(.25); worst = Math.max(worst, performance.now() - s); ticks++; }
    const ms = Date.now() - t0;
    const ws = works(f.sim, f.p);
    expect(ws.length).toBeLessThan(400);
    expect(approvals(f.sim, f.p, false).length).toBeLessThan(50);
    expect(f.co.credits).toBeGreaterThanOrEqual(500000 - 1e-6);
    for (const st of Object.values(f.sim.st.stations)) for (const n of Object.values(st.storage[f.p] ?? {})) expect(n).toBeGreaterThanOrEqual(-1e-6);
    for (const h of f.co.ops!.spend) expect(h.n).toBeGreaterThanOrEqual(0);
    const hourly = new Map<number, number>(); for (const s of f.co.ops!.spend) hourly.set(Math.floor(s.t / 3600), (hourly.get(Math.floor(s.t / 3600)) ?? 0) + s.n);
    // ledger is complete: income − expenses over the kept hours equals the balance change across them
    const ledger = f.co.ops!.ledger, net = ledger.reduce((n, h) => n + Object.values(h.inc).reduce((a, b) => a + b, 0) - Object.values(h.exp).reduce((a, b) => a + b, 0), 0);
    expect(Math.abs(net - (f.co.credits - 2e6))).toBeLessThan(2);
    console.log(JSON.stringify({ ticks, ms, worstTickMs: Math.round(worst), works: ws.length, live: ws.filter(w => !terminal(w)).length, approvals: approvals(f.sim, f.p, false).length, credits: Math.round(f.co.credits), alloyHome: Math.round(qty(f.home.storage[f.p], 'alloy')), trade: goal(f.sim, f.p).rt, hourlySpend: [...hourly.values()].map(Math.round) }));
  }, 600000);
});
