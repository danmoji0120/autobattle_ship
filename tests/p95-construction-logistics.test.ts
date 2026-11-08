import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { FOUND_COST, MODULES } from '../src/world/data';
import { qty } from '../src/world/types';
import { jumps, sysAt } from '../src/world/geom';
import { observeWorld, type Observation } from '../src/world/observe';
import { FUNDS_INFLOW } from '../src/world/market';
import { GameServer } from '../src/server/core';
import type { RouteConfig } from '../src/world/logistics';

function quiet(sim: WorldSim) {
  (sim as any).npcSlow = () => {};
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
}
function until(sim: WorldSim, done: () => boolean, seconds = 1800) {
  for (let t = 0; t < seconds && !done(); t += .25) sim.update(.25);
  expect(done()).toBe(true);
}
function fixture() {
  const sim = WorldSim.create(951); quiet(sim);
  const p = sim.addPlayer('원정 회사'); sim.st.companies[p].credits = 1_000_000;
  const g = sim.newGroup(p, '건설반'), sys = sim.st.systems.quiet;
  const at = { x: sys.origin.x + 10000, y: 0, z: 0 };
  const constructor = sim.spawnShip(p, 'constructor', 'std', g.id, at);
  return { sim, p, g, at, constructor };
}
function createSite(f: ReturnType<typeof fixture>) {
  expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '고요 전초기지' } })).toBeNull();
  until(f.sim, () => Object.values(f.sim.st.stations).some(st => st.owner === f.p), 5);
  return Object.values(f.sim.st.stations).find(st => st.owner === f.p)!;
}
function routeTo(sim: WorldSim, p: string, site: string, amount = 150) {
  const g = sim.newGroup(p, '보급 편대');
  const ship = sim.spawnShip(p, 'hauler', 'std', g.id, sim.st.stations.astra.pos);
  const config: RouteConfig = { name: '변경 건설 자재', from: 'astra', to: site, item: 'alloy', mode: 'construction', amount, repeat: true };
  expect(sim.command(p, { c: 'putRoute', group: g.id, config })).toBeNull();
  const route = Object.values(sim.st.logistics!).find(r => r.group === g.id)!;
  return { g, ship, route, config };
}
function heldAlloy(sim: WorldSim, p: string, stationId: string) {
  const station = sim.st.stations[stationId], core = station.modules.find(m => m.kind === 'core')!;
  return qty(sim.st.stations.astra.storage[p], 'alloy') + Object.values(sim.st.ships).filter(s => s.owner === p).reduce((n, s) => n + qty(s.cargo, 'alloy'), 0) + qty(station.storage[p], 'alloy') + (core.reserved?.alloy ?? 0) + (core.used?.alloy ?? 0) + (core.built ? MODULES.core.mats.alloy : 0);
}

describe('P9.5 construction logistics', () => {
  it('pre-pays once, refunds an interrupted order, and never buys remotely or charges twice for multiple constructors', () => {
    const f = fixture(), co = f.sim.st.companies[f.p], before = co.credits;
    const stocks = Object.fromEntries(Object.values(f.sim.st.stations).filter(s => s.market?.alloy).map(s => [s.id, s.market!.alloy.stock]));
    f.sim.spawnShip(f.p, 'constructor', 'std', f.g.id, f.at);
    expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '취소할 명령' } })).toBeNull();
    expect(co.credits).toBe(before - FOUND_COST.credits);
    expect(co.foundingEscrow?.[f.g.id]).toBe(FOUND_COST.credits);
    for (const [id, stock] of Object.entries(stocks)) expect(f.sim.st.stations[id].market!.alloy.stock).toBe(stock);
    expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'idle' } })).toBeNull();
    expect(co.credits).toBe(before); expect(co.foundingEscrow).toBeUndefined();
    const observations: Observation[] = []; const unobserve = observeWorld(f.sim.st, event => observations.push(event));
    const site = createSite(f);
    expect(co.credits).toBe(before - FOUND_COST.credits);
    expect(Object.values(f.sim.st.stations).filter(s => s.owner === f.p)).toHaveLength(1);
    expect(qty(f.constructor.cargo, 'alloy') + qty(site.storage[f.p], 'alloy')).toBe(0);
    expect(observations.filter(o => o.kind === 'market' && o.reason === 'buy' && o.company === f.p)).toHaveLength(0);
    unobserve();
    expect(site.modules[0].progress).toBe(0);
  });

  it('rejects malformed founding names and coordinates before prepayment or cargo changes', () => {
    const f = fixture(), co = f.sim.st.companies[f.p], credits = co.credits;
    f.constructor.cargo.alloy = 17;
    for (const op of [{ k: 'found', at: f.at, name: null }, { k: 'found', at: null, name: '부지' }, { k: 'found', at: { ...f.at, x: NaN }, name: '부지' }]) {
      expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: op as any })).toMatch(/이름과 부지/);
      expect(co.credits).toBe(credits); expect(co.foundingEscrow).toBeUndefined(); expect(qty(f.constructor.cargo, 'alloy')).toBe(17);
    }
    f.sim.update(.25); expect(Object.values(f.sim.st.stations).some(s => s.owner === f.p)).toBe(false);
  });

  it('uses actual docked stock within hold capacity, and restores an old already-paid founding order', () => {
    const f = fixture(), at = f.sim.st.stations.astra;
    f.constructor.pos = { ...at.pos }; f.constructor.state = 'docked'; f.constructor.task = { k: 'docked', station: at.id, berth: 0 };
    at.storage[f.p].alloy = 90;
    expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '운송' } })).toBeNull();
    expect(qty(f.constructor.cargo, 'alloy')).toBe(90); expect(qty(at.storage[f.p], 'alloy')).toBe(0);
    // An old save contains an order with no payment marker: its original fee was paid on issue.
    f.g.op = { k: 'found', at: f.at, name: '기존 저장' }; delete f.sim.st.companies[f.p].foundingEscrow; f.constructor.state = 'space'; f.constructor.task = { k: 'none' }; f.constructor.pos = { ...f.at };
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); quiet(restored);
    const before = restored.st.companies[f.p].credits;
    until(restored, () => Object.values(restored.st.stations).some(s => s.owner === f.p), 5);
    expect(restored.st.companies[f.p].credits).toBe(before);
    const site = Object.values(restored.st.stations).find(s => s.owner === f.p)!;
    expect(qty(site.storage[f.p], 'alloy')).toBe(90); expect(site.modules[0].paid).toBe(FOUND_COST.credits);
  });

  it('refunds a previously paid but already delegated legacy founding order once', () => {
    const f = fixture(), parent = f.sim.newGroup(f.p, '기존 상위 편대'), co = f.sim.st.companies[f.p];
    f.g.parentId = parent.id; parent.childIds.push(f.g.id); f.g.override = false;
    f.g.op = { k: 'found', at: f.at, name: '과거에 위임한 명령' }; co.credits -= FOUND_COST.credits;
    const before = co.credits, restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); quiet(restored);
    expect(restored.st.companies[f.p].credits).toBe(before);
    restored.update(.25); restored.update(1);
    expect(restored.st.companies[f.p].credits).toBe(before + FOUND_COST.credits);
    expect(restored.st.companies[f.p].foundingEscrow).toBeUndefined(); expect(restored.st.groups[f.g.id].op.k).toBe('idle');
    const again = new WorldSim(JSON.parse(restored.serialize()), { migrateContent: false }); quiet(again); again.update(1);
    expect(again.st.companies[f.p].credits).toBe(before + FOUND_COST.credits);
  });

  it('buys at the market, carries a reserved multi-gate shipment through restart, and consumes exactly once', () => {
    const f = fixture(), site = createSite(f), market = f.sim.st.stations.astra;
    expect(jumps(f.sim.st.systems, 'astra', 'quiet')).toBeGreaterThanOrEqual(2);
    const beforeCredits = f.sim.st.companies[f.p].credits, beforeFunds = market.funds!, stock = market.market!.alloy.stock, price = f.sim.price(market, 'alloy', 'buy');
    const observations: Observation[] = []; const unobserve = observeWorld(f.sim.st, event => observations.push(event));
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 300 })).toBeNull();
    expect(f.sim.st.companies[f.p].credits).toBeCloseTo(beforeCredits - 300 * price, 8);
    expect(market.funds).toBeCloseTo(Math.min(market.fundsMax! * 1.5, beforeFunds + 300 * price * FUNDS_INFLOW), 8);
    expect(market.market!.alloy.stock).toBe(stock - 300);
    expect(qty(market.storage[f.p], 'alloy')).toBe(300);
    expect(qty(site.storage[f.p], 'alloy')).toBe(0);
    expect(observations.filter(o => o.kind === 'market' && o.reason === 'buy' && o.company === f.p).map(o => o.amount)).toEqual([300]);
    unobserve();
    const transport = routeTo(f.sim, f.p, site.id, 150);
    const second = f.sim.spawnShip(f.p, 'hauler', 'std', transport.g.id, market.pos);
    until(f.sim, () => Object.keys(transport.route.manifests).length === 2, 120);
    expect(Object.values(transport.route.manifests).reduce((n, m) => n + m.amount, 0)).toBe(300);
    expect(qty(transport.ship.cargo, 'alloy') + qty(second.cargo, 'alloy')).toBe(300);
    expect(heldAlloy(f.sim, f.p, site.id)).toBeCloseTo(300, 7);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); quiet(restored);
    const restoredRoute = restored.st.logistics![transport.route.id];
    expect(restoredRoute.manifests).toEqual(transport.route.manifests);
    expect(heldAlloy(restored, f.p, site.id)).toBeCloseTo(300, 7);
    const deliveries: { amount: number; system: string | undefined }[] = [];
    observeWorld(restored.st, e => { if (e.kind === 'logistics' && e.reason === 'unload' && e.route === restoredRoute.id && e.ship) deliveries.push({ amount: e.amount, system: sysAt(restored.st.systems, restored.st.ships[e.ship].pos)?.id }); });
    until(restored, () => restored.st.stations[site.id].modules[0].built, 1800);
    expect(heldAlloy(restored, f.p, site.id)).toBeCloseTo(300, 5);
    expect(restoredRoute.stats.loaded).toBe(300); expect(restoredRoute.stats.delivered).toBe(300);
    expect(deliveries.reduce((n, d) => n + d.amount, 0)).toBe(300);
    expect(deliveries.every(d => d.system === 'quiet')).toBe(true);
  }, 60_000);

  it('deduplicates the same purchase request across save/restart and rejects stale or conflicting retries', () => {
    const f = fixture(), market = f.sim.st.stations.astra, before = market.market!.alloy.stock;
    const buy = { c: 'buy', station: 'astra', res: 'alloy', amount: 100, request: { seq: 1, id: 'p95_test_purchase_1' } } as const;
    const events: Observation[] = []; observeWorld(f.sim.st, e => events.push(e));
    expect(f.sim.command(f.p, buy)).toBeNull();
    const credits = f.sim.st.companies[f.p].credits, funds = market.funds;
    expect(f.sim.command(f.p, buy)).toBeNull();
    expect(f.sim.st.companies[f.p].credits).toBe(credits); expect(market.funds).toBe(funds);
    expect(market.market!.alloy.stock).toBe(before - 100); expect(qty(market.storage[f.p], 'alloy')).toBe(100);
    expect(events.filter(e => e.kind === 'market' && e.reason === 'buy' && e.company === f.p)).toHaveLength(1);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(restored.command(f.p, buy)).toBeNull();
    expect(restored.st.companies[f.p].credits).toBe(credits); expect(qty(restored.st.stations.astra.storage[f.p], 'alloy')).toBe(100);
    expect(restored.command(f.p, { ...buy, request: { seq: 1, id: 'different_purchase_1' } })).toMatch(/지난 구매/);
    expect(restored.command(f.p, { ...buy, request: { seq: 3, id: 'out_of_order_purchase' } })).toMatch(/대기 중/);
    expect(restored.command(f.p, { ...buy, request: { seq: 2, id: 'p95_test_purchase_2' } })).toBeNull();
    expect(restored.command(f.p, buy)).toMatch(/지난 구매/);
    expect(qty(restored.st.stations.astra.storage[f.p], 'alloy')).toBe(200);
    const other = restored.addPlayer('별도 구매사'); restored.st.companies[other].credits = 1e6;
    expect(restored.command(other, buy)).toBeNull();
    expect(qty(restored.st.stations.astra.storage[other], 'alloy')).toBe(100);
    expect(qty(restored.st.stations.astra.storage[f.p], 'alloy')).toBe(200);
  });

  it('rejects non-finite or inherited market items without corrupting credits or stock', () => {
    const f = fixture(), market = f.sim.st.stations.astra;
    const before = { credits: f.sim.st.companies[f.p].credits, funds: market.funds, stock: market.market!.alloy.stock };
    for (const amount of [NaN, Infinity, -Infinity]) expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount })).toMatch(/수량/);
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: '__proto__', amount: 1 })).toMatch(/거래 불가/);
    expect({ credits: f.sim.st.companies[f.p].credits, funds: market.funds, stock: market.market!.alloy.stock }).toEqual(before);
    expect(qty(market.storage[f.p], 'alloy')).toBe(0);
  });

  it('delivers carried cargo directly, accepts only needed material, and refuses another company', () => {
    const f = fixture(), site = createSite(f), g = f.sim.newGroup(f.p, '현장 수송'), ship = f.sim.spawnShip(f.p, 'hauler', 'std', g.id, f.at);
    ship.cargo.alloy = 350; ship.cargo.ore = 11;
    const other = f.sim.addPlayer('다른 회사'), foreign = f.sim.newGroup(other, '타사 수송'), intruder = f.sim.spawnShip(other, 'hauler', 'std', foreign.id, f.at); intruder.cargo.alloy = 100;
    expect(f.sim.command(other, { c: 'setOp', group: foreign.id, op: { k: 'build', station: site.id } })).toMatch(/자사/);
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'build', station: site.id } })).toBeNull();
    until(f.sim, () => qty(ship.cargo, 'alloy') <= 50, 60);
    expect(qty(ship.cargo, 'alloy')).toBe(50); expect(qty(ship.cargo, 'ore')).toBe(11);
    expect(qty(intruder.cargo, 'alloy')).toBe(100); expect(qty(site.storage[other], 'alloy')).toBe(0);
    expect((site.modules[0].reserved?.alloy ?? 0) + qty(site.storage[f.p], 'alloy')).toBeCloseTo(300, 6);
  });

  it('does not accept a delivery order when its only cargo ship has an overriding child order', () => {
    const f = fixture(), site = createSite(f), parent = f.sim.newGroup(f.p, '상위 편대'), child = f.sim.newGroup(f.p, '독립 수송', parent.id);
    const ship = f.sim.spawnShip(f.p, 'hauler', 'std', child.id, f.at); ship.cargo.alloy = 50;
    expect(f.sim.command(f.p, { c: 'setOp', group: child.id, op: { k: 'idle' } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'setOp', group: parent.id, op: { k: 'build', station: site.id } })).toMatch(/명령을 수행할/);
    expect(f.sim.command(f.p, { c: 'release', group: child.id })).toBeNull();
    expect(f.sim.command(f.p, { c: 'setOp', group: parent.id, op: { k: 'build', station: site.id } })).toBeNull();
  });

  it('retains a shipment when its destination disappears and when its route is cancelled', () => {
    const f = fixture(), site = createSite(f);
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 150 })).toBeNull();
    const { ship, route } = routeTo(f.sim, f.p, site.id);
    until(f.sim, () => !!route.manifests[ship.id], 120);
    const cargo = qty(ship.cargo, 'alloy'); delete f.sim.st.stations[site.id];
    until(f.sim, () => route.state === 'paused', 30);
    expect(qty(ship.cargo, 'alloy')).toBe(cargo); expect(route.manifests[ship.id].amount).toBe(cargo);
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [route.id], action: 'cancel' })).toBeNull();
    expect(qty(ship.cargo, 'alloy')).toBe(cargo); expect(f.sim.st.logistics![route.id]).toBeUndefined();
  });

  it('returns the plan prepayment and keeps an in-flight shipment when its construction plan is cancelled', () => {
    const f = fixture(), site = createSite(f); site.modules[0].built = true; site.modules[0].progress = 1;
    const initialCredits = f.sim.st.companies[f.p].credits;
    expect(f.sim.command(f.p, { c: 'queueModule', station: site.id, kind: 'repair' })).toBeNull();
    const plan = site.modules.find(m => m.kind === 'repair')!;
    expect(f.sim.st.companies[f.p].credits).toBe(initialCredits - MODULES.repair.credits);
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 180 })).toBeNull();
    const { ship, route } = routeTo(f.sim, f.p, site.id, 180);
    until(f.sim, () => !!route.manifests[ship.id], 120);
    const beforeCancel = f.sim.st.companies[f.p].credits;
    expect(f.sim.command(f.p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).toBeNull();
    expect(f.sim.st.companies[f.p].credits).toBe(beforeCancel + MODULES.repair.credits);
    until(f.sim, () => route.cursors[ship.id]?.code === 'construction', 1200);
    expect(qty(ship.cargo, 'alloy')).toBe(180); expect(route.manifests[ship.id].amount).toBe(180);
    expect(route.stats.delivered).toBe(0); expect(qty(site.storage[f.p], 'alloy')).toBe(0);
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [route.id], action: 'cancel' })).toBeNull();
    expect(qty(ship.cargo, 'alloy')).toBe(180);
  }, 60_000);

  it('refunds only unused reservations and the remaining paid fraction after work has begun', () => {
    const f = fixture(), site = createSite(f); site.modules[0].built = true; site.modules[0].progress = 1;
    site.storage[f.p].alloy = MODULES.repair.mats.alloy; site.storage[f.p].machinery = MODULES.repair.mats.machinery;
    expect(f.sim.command(f.p, { c: 'queueModule', station: site.id, kind: 'repair' })).toBeNull();
    const plan = site.modules.find(m => m.kind === 'repair')!;
    until(f.sim, () => plan.progress > .05, 30);
    const before = f.sim.st.companies[f.p].credits, progress = plan.progress;
    const reserved = { ...plan.reserved! }, consumed = { ...plan.used! };
    expect(f.sim.command(f.p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).toBeNull();
    expect(f.sim.st.companies[f.p].credits).toBe(before + Math.round(MODULES.repair.credits * (1 - progress)));
    for (const item of ['alloy', 'machinery']) {
      expect(qty(site.storage[f.p], item)).toBeCloseTo(reserved[item], 8);
      expect(reserved[item] + consumed[item]).toBeCloseTo(MODULES.repair.mats[item], 8);
    }
  });

  it('uses the existing combat cargo-loss path when a construction carrier is destroyed', () => {
    const f = fixture(), site = createSite(f);
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 150 })).toBeNull();
    const { g, ship, route } = routeTo(f.sim, f.p, site.id);
    until(f.sim, () => !!route.manifests[ship.id], 120);
    f.sim.undock(ship);
    const enemy = f.sim.newGroup('pirates', '시험 해적'); f.sim.spawnShip('pirates', 'corvette', 'gun', enemy.id, ship.pos);
    const e = f.sim.createEngagement(ship.pos, [enemy], [g]);
    const observations: Observation[] = []; observeWorld(f.sim.st, event => observations.push(event));
    (f.sim as any).finishEngagement(e, { winner: 1, ships: [{ ref: ship.id, dead: true, hp: 0, escaped: false, dmg: 0 }], groupKills: new Map() });
    until(f.sim, () => route.stats.lost === 150, 5);
    expect(f.sim.st.ships[ship.id]).toBeUndefined();
    expect(observations.filter(o => o.kind === 'consume' && o.reason === 'combat_cargo_loss' && o.ship === ship.id && o.item === 'alloy').map(o => o.amount)).toEqual([150]);
    expect(route.stats.delivered).toBe(0); expect(route.manifests[ship.id]).toBeUndefined();
  });

  it('waits with cargo aboard when a completed station is full and resumes once space is freed', () => {
    const f = fixture(), site = createSite(f);
    site.modules[0].built = true; site.modules[0].progress = 1; site.storage[f.p].ore = 20000;
    expect(f.sim.command(f.p, { c: 'queueModule', station: site.id, kind: 'repair' })).toBeNull();
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 180 })).toBeNull();
    const { ship, route } = routeTo(f.sim, f.p, site.id, 180);
    until(f.sim, () => Object.values(route.cursors).some(c => c.code === 'construction'), 1200);
    expect(qty(ship.cargo, 'alloy')).toBe(180); expect(qty(site.storage[f.p], 'alloy')).toBe(0);
    site.storage[f.p].ore -= 200;
    until(f.sim, () => route.stats.delivered === 180, 120);
    expect(qty(ship.cargo, 'alloy')).toBe(0);
    expect(qty(site.storage[f.p], 'alloy') + (site.modules.find(m => m.kind === 'repair')!.reserved?.alloy ?? 0)).toBeCloseTo(180, 6);
  }, 60_000);

  it('manual site delivery respects a completed station warehouse cap and retains excess aboard', () => {
    const f = fixture(), site = createSite(f); site.modules[0].built = true; site.modules[0].progress = 1;
    site.storage[f.p].ore = 20000;
    expect(f.sim.command(f.p, { c: 'queueModule', station: site.id, kind: 'repair' })).toBeNull();
    const g = f.sim.newGroup(f.p, '수동 반입'), ship = f.sim.spawnShip(f.p, 'hauler', 'std', g.id, f.at); ship.cargo.alloy = 180;
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'build', station: site.id } })).toBeNull();
    for (let i = 0; i < 120; i++) f.sim.update(.25);
    expect(qty(ship.cargo, 'alloy')).toBe(180); expect(qty(site.storage[f.p], 'alloy')).toBe(0);
    site.storage[f.p].ore -= 200;
    until(f.sim, () => qty(ship.cargo, 'alloy') === 0, 60);
    expect(qty(site.storage[f.p], 'alloy') + (site.modules.find(m => m.kind === 'repair')!.reserved?.alloy ?? 0)).toBeCloseTo(180, 6);
  });

  it('partial manual delivery immediately withdraws the tracked manifest before a same-tick save and resume', () => {
    const f = fixture(), site = createSite(f);
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 100 })).toBeNull();
    const { g, ship, route } = routeTo(f.sim, f.p, site.id, 100); ship.cargo.alloy = 30;
    until(f.sim, () => !!route.manifests[ship.id], 120);
    expect(qty(ship.cargo, 'alloy')).toBe(130); expect(route.manifests[ship.id].amount).toBe(100);
    // A competing delivery has already reserved all but 50 at the site.
    site.modules[0].reserved!.alloy = 250;
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'build', station: site.id } })).toBeNull();
    ship.pos = { ...site.pos }; f.sim.undock(ship);
    until(f.sim, () => qty(ship.cargo, 'alloy') === 80, 60);
    expect(route.manifests[ship.id].amount).toBe(50); expect(route.stats.withdrawn).toBe(50);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); quiet(restored);
    expect(restored.st.logistics![route.id].manifests[ship.id].amount).toBe(50);
    expect(restored.command(f.p, { c: 'routeControl', routes: [route.id], action: 'resume' })).toBeNull();
    restored.update(.25);
    expect(qty(restored.st.ships[ship.id].cargo, 'alloy')).toBe(80);
    expect(restored.st.logistics![route.id].manifests[ship.id].amount).toBe(50);
  });

  it('founding unloads tracked constructor cargo from the paused route immediately', () => {
    const f = fixture(), source = f.sim.st.stations.astra;
    const depot = { ...structuredClone(source), id: 'p95_depot', name: '기존 창고', owner: f.p, public: false, market: null, pos: { ...source.pos, x: source.pos.x + 5000 }, storage: { [f.p]: {} }, modules: [{ kind: 'core', slot: 0, progress: 1, built: true }] };
    f.sim.st.stations[depot.id] = depot;
    (f.sim as any).dockShip(f.constructor, source); f.constructor.cargo.alloy = 30;
    expect(f.sim.command(f.p, { c: 'buy', station: source.id, res: 'alloy', amount: 100 })).toBeNull();
    const config: RouteConfig = { name: '기존 노선', from: source.id, to: depot.id, item: 'alloy', mode: 'transfer', amount: 100, repeat: true };
    expect(f.sim.command(f.p, { c: 'putRoute', group: f.g.id, config })).toBeNull();
    const route = Object.values(f.sim.st.logistics!).find(r => r.group === f.g.id)!;
    until(f.sim, () => !!route.manifests[f.constructor.id], 10);
    expect(route.manifests[f.constructor.id].amount).toBe(100);
    expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '현장 전환' } })).toBeNull();
    f.constructor.pos = { ...f.at }; f.sim.undock(f.constructor);
    until(f.sim, () => Object.values(f.sim.st.stations).some(s => s.owner === f.p && s.name === '현장 전환'), 5);
    const site = Object.values(f.sim.st.stations).find(s => s.owner === f.p && s.name === '현장 전환')!;
    expect(qty(site.storage[f.p], 'alloy')).toBe(130);
    expect(route.manifests[f.constructor.id]).toBeUndefined(); expect(route.stats.withdrawn).toBe(100);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); quiet(restored);
    expect(restored.command(f.p, { c: 'routeControl', routes: [route.id], action: 'resume' })).toBeNull();
    restored.update(.25);
    expect(restored.st.logistics![route.id].manifests[f.constructor.id]).toBeUndefined();
    expect(qty(restored.st.ships[f.constructor.id].cargo, 'alloy')).toBe(0);
  });

  it('ordinary partial unloading also withdraws tracked cargo before a paused route can resume', () => {
    const f = fixture(), site = createSite(f); site.modules[0].built = true; site.modules[0].progress = 1; site.storage[f.p].ore = 19950;
    expect(f.sim.command(f.p, { c: 'queueModule', station: site.id, kind: 'repair' })).toBeNull();
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 100 })).toBeNull();
    const { g, ship, route } = routeTo(f.sim, f.p, site.id, 100); ship.cargo.alloy = 30;
    until(f.sim, () => !!route.manifests[ship.id], 120);
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    (f.sim as any).unload(ship, site, false);
    expect(qty(ship.cargo, 'alloy')).toBe(80); expect(route.manifests[ship.id].amount).toBe(50);
    expect(route.stats.withdrawn).toBe(50);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(restored.st.logistics![route.id].manifests[ship.id].amount).toBe(50);
  });

  it('allocates one partial unload only once across old and new route manifests on the same ship', () => {
    const f = fixture(), site = createSite(f); site.modules[0].built = true; site.modules[0].progress = 1; site.storage[f.p].ore = 19950;
    expect(f.sim.command(f.p, { c: 'queueModule', station: site.id, kind: 'repair' })).toBeNull();
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 200 })).toBeNull();
    const first = routeTo(f.sim, f.p, site.id, 100); first.ship.cargo.alloy = 30;
    until(f.sim, () => !!first.route.manifests[first.ship.id], 120);
    const secondGroup = f.sim.newGroup(f.p, '새 수송 편대');
    expect(f.sim.command(f.p, { c: 'moveShip', ship: first.ship.id, group: secondGroup.id })).toBeNull();
    const config: RouteConfig = { ...first.config, name: '새 노선' };
    expect(f.sim.command(f.p, { c: 'putRoute', group: secondGroup.id, config })).toBeNull();
    const second = Object.values(f.sim.st.logistics!).find(r => r.group === secondGroup.id)!;
    until(f.sim, () => !!second.manifests[first.ship.id], 120);
    expect(qty(first.ship.cargo, 'alloy')).toBe(230);
    expect(f.sim.command(f.p, { c: 'setOp', group: secondGroup.id, op: { k: 'idle' } })).toBeNull();
    (f.sim as any).unload(first.ship, site, false);
    expect(qty(first.ship.cargo, 'alloy')).toBe(180);
    expect(first.route.manifests[first.ship.id].amount + second.manifests[first.ship.id].amount).toBe(150);
    expect((first.route.stats.withdrawn ?? 0) + (second.stats.withdrawn ?? 0)).toBe(50);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(restored.st.logistics![first.route.id].manifests[first.ship.id].amount + restored.st.logistics![second.id].manifests[first.ship.id].amount).toBe(150);
  });

  it('persists prepayment, allows retargeting without a second debit, and refunds exactly once on cancellation', () => {
    const f = fixture(), co = f.sim.st.companies[f.p]; co.credits = FOUND_COST.credits;
    expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '변경 기지', escrowed: false } })).toBeNull();
    expect(co.credits).toBe(0); expect(co.foundingEscrow?.[f.g.id]).toBe(FOUND_COST.credits);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); quiet(restored);
    expect(restored.st.companies[f.p].foundingEscrow?.[f.g.id]).toBe(FOUND_COST.credits);
    expect(restored.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '목표 변경' } })).toBeNull();
    expect(restored.st.companies[f.p].credits).toBe(0);
    expect(restored.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'idle' } })).toBeNull();
    expect(restored.st.companies[f.p].credits).toBe(FOUND_COST.credits);
    expect(restored.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'idle' } })).toBeNull();
    expect(restored.st.companies[f.p].credits).toBe(FOUND_COST.credits);
    expect(restored.st.companies[f.p].foundingEscrow).toBeUndefined();
  });

  it('refunds a destroyed constructor’s prepayment after restart without recreating its lost cargo', () => {
    const f = fixture(), co = f.sim.st.companies[f.p]; co.credits = FOUND_COST.credits; f.constructor.cargo.alloy = 40;
    expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '상실' } })).toBeNull();
    delete f.sim.st.ships[f.constructor.id]; f.g.shipIds = [];
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); quiet(restored);
    until(restored, () => restored.st.companies[f.p].credits === FOUND_COST.credits, 5);
    expect(restored.st.companies[f.p].foundingEscrow).toBeUndefined();
    expect(restored.st.groups[f.g.id].op.k).toBe('idle');
    expect(restored.st.ships[f.constructor.id]).toBeUndefined();
    restored.update(2);
    expect(restored.st.companies[f.p].credits).toBe(FOUND_COST.credits);
  });

  it('keeps prepayment in assessed assets and reconciles the actual debit and refund in server analytics', () => {
    const f = fixture(), server = new GameServer({ v: 1, world: JSON.parse(f.sim.serialize()), auth: {} }, { singleplayer: false, snapInterval: 1, migrateContent: false });
    const sim = server.sim, gross = () => { const row = server.analytics!.query('player', f.p).current.companies[0]; return row.assets + row.liabilities; };
    const before = gross();
    expect(sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '회계' } })).toBeNull();
    expect(gross()).toBe(before);
    expect(server.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 7);
    expect(sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'idle' } })).toBeNull();
    expect(gross()).toBe(before);
    expect(server.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 7);
    expect(sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'found', at: f.at, name: '회계' } })).toBeNull();
    sim.update(.25);
    expect(gross()).toBe(before); // operating-cost accrual changes liabilities, not the prepaid asset
    expect(server.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 7);
  });

  it('keeps company stock and construction reservations separate, and refunds only unworked materials on cancellation', () => {
    const f = fixture(), site = createSite(f), other = f.sim.addPlayer('독립 회사');
    expect(f.sim.command(other, { c: 'buy', station: 'astra', res: 'alloy', amount: 60 })).toBeNull();
    expect(qty(f.sim.st.stations.astra.storage[f.p], 'alloy')).toBe(0);
    const foreignGroup = f.sim.newGroup(other, '타사 운송'); f.sim.spawnShip(other, 'hauler', 'std', foreignGroup.id, f.sim.st.stations.astra.pos);
    const config: RouteConfig = { name: '침범', from: 'astra', to: site.id, item: 'alloy', mode: 'construction', amount: 60, repeat: true };
    expect(f.sim.command(other, { c: 'putRoute', group: foreignGroup.id, config })).toMatch(/자사/);
    expect(f.sim.command(other, { c: 'queueModule', station: site.id, kind: 'repair' })).not.toBeNull();
    site.modules[0].built = true; site.modules[0].progress = 1;
    site.storage[f.p].alloy = 100; const credits = f.sim.st.companies[f.p].credits;
    expect(f.sim.command(f.p, { c: 'queueModule', station: site.id, kind: 'repair' })).toBeNull();
    const plan = site.modules.find(m => m.kind === 'repair')!;
    expect(plan.reserved?.alloy).toBe(100); expect(qty(site.storage[f.p], 'alloy')).toBe(0);
    expect(f.sim.command(f.p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).toBeNull();
    expect(qty(site.storage[f.p], 'alloy')).toBe(100); expect(f.sim.st.companies[f.p].credits).toBe(credits);
    expect(qty(f.sim.st.stations.astra.storage[other], 'alloy')).toBe(60);
  });
});
