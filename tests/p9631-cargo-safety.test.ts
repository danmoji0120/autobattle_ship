import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { FACILITIES, TECHS } from '../src/world/industry';
import { allocate } from '../src/world/construction';
import { storageCap } from '../src/world/production';
import { constructionRoom, reservedSpace, storeUsed } from '../src/world/storage';
import { qty } from '../src/world/types';
import { storeHtml, newIndUi } from '../src/client/strategic/industryUi';
import { storageGrowthHtml } from '../src/client/strategic/growthUi';
import type { Station } from '../src/world/types';

function fixture() {
  const sim = WorldSim.create(96311); (sim as any).npcSlow = () => {};
  for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
  const p = sim.addPlayer('초과 보관 회사'), co = sim.st.companies[p]; co.credits = 50_000_000; co.tech = Object.keys(TECHS);
  const base = sim.st.stations.astra;
  const make = (id: string, dx: number, kinds: string[]): Station => ({ ...structuredClone(base), id, name: id, owner: p, public: false, size: 'XL', market: null,
    pos: { ...base.pos, x: base.pos.x + dx }, storage: { [p]: {} }, modules: kinds.map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) });
  const site = make('p9631_site', 3000, ['core', 'yard_l', 'power', 'power']);
  const source = make('p9631_source', -3000, ['core', 'power']);
  sim.st.stations[site.id] = site; sim.st.stations[source.id] = source;
  return { sim, p, co, site, source };
}

describe('P9.6.3.1 construction overflow safety', () => {
  it('returns 81,850 exactly once, blocks intake and exploits, survives restart, and resumes after physical outbound freight', () => {
    const f = fixture(), p = f.p; let sim = f.sim, site = f.site, source = f.source;
    const bill = FACILITIES.yard_xl.mats; site.storage[p].alloy = 70_000;
    const before = f.co.credits;
    expect(sim.command(p, { c: 'queueModule', station: site.id, kind: 'yard_xl' })).toBeNull();
    let plan = site.modules.find(m => m.kind === 'yard_xl')!; expect(plan.reserved!.alloy).toBe(70_000);
    Object.assign(site.storage[p], { ...bill, alloy: 0 }); allocate(site, site.storage[p]);
    expect(reservedSpace(site)).toBe(81_850); expect(storeUsed(site.storage[p])).toBe(0); expect(storageCap(site)).toBe(80_000);
    const foreign = sim.addPlayer('다른 회사'), foreignCredits = sim.st.companies[foreign].credits;
    expect(sim.command(foreign, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).not.toBeNull();
    expect(sim.st.companies[foreign].credits).toBe(foreignCredits); expect(reservedSpace(site)).toBe(81_850);
    expect(sim.command(p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).toBeNull();
    expect(f.co.credits).toBe(before); expect(storeUsed(site.storage[p])).toBe(81_850);
    expect(sim.st.events.at(-1)?.text).toMatch(/초과 보관 1,850/);
    for (const [item, amount] of Object.entries(bill)) expect(qty(site.storage[p], item), item).toBe(amount);
    expect(sim.command(p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).not.toBeNull();
    expect(storeUsed(site.storage[p])).toBe(81_850); expect(f.co.credits).toBe(before);
    const inventory = storeHtml(sim.st as any, site, p, newIndUi()), summary = storageGrowthHtml(sim.st as any, site, p);
    expect(inventory).toContain('81,850'); expect(inventory).toContain('초과 보관 1,850'); expect(inventory).toContain('신규 입고 불가');
    expect(summary).toContain('초과 보관 1,850');
    const group = sim.newGroup(p, '대기 중인 수송선'), carrier = sim.spawnHull(p, 'hauler_m', 'hauler_m_std', undefined, group.id, site.pos);
    expect((sim as any).dockShip(carrier, site)).toBe(true); carrier.cargo.ore = 50;
    expect(sim.command(p, { c: 'unloadCargo', ship: carrier.id })).toMatch(/빈 공간/); expect(carrier.cargo.ore).toBe(50);
    site.market = structuredClone(sim.st.stations.astra.market);
    const marketStock = site.market!.alloy.stock, balance = f.co.credits;
    expect(sim.command(p, { c: 'buy', station: site.id, res: 'alloy', amount: 1 })).toMatch(/창고 용량/);
    expect(site.market!.alloy.stock).toBe(marketStock); expect(f.co.credits).toBe(balance); site.market = null;
    // Re-registering can reserve overflow, but cannot manufacture free general intake capacity.
    expect(sim.command(p, { c: 'queueModule', station: site.id, kind: 'yard_xl' })).toBeNull();
    plan = site.modules.find(m => m.kind === 'yard_xl')!;
    expect(reservedSpace(site)).toBe(81_850); expect(storeUsed(site.storage[p])).toBe(0); expect(sim.room(site, p)).toBe(0);
    expect(sim.command(p, { c: 'unloadCargo', ship: carrier.id })).toMatch(/빈 공간/); expect(carrier.cargo.ore).toBe(50);
    expect(sim.command(p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).toBeNull();
    expect(storeUsed(site.storage[p])).toBe(81_850); expect(f.co.credits).toBe(before);
    // A managed inbound shipment remains aboard and its manifest remains intact while full.
    source.storage[p].ore = 100;
    const inbound = sim.newGroup(p, '입고 대기'), incomingShip = sim.spawnHull(p, 'hauler_m', 'hauler_m_std', undefined, inbound.id, source.pos);
    expect((sim as any).dockShip(incomingShip, source)).toBe(true);
    expect(sim.command(p, { c: 'putRoute', group: inbound.id, config: { name: '입고 시험', from: source.id, to: site.id, item: 'ore', amount: 100, mode: 'transfer', repeat: false } })).toBeNull();
    const routeId = Object.values(sim.st.logistics!).find(r => r.group === inbound.id)!.id;
    const until = (predicate: () => boolean, seconds = 3000) => { for (let t = 0; t < seconds && !predicate(); t += .25) sim.update(.25); expect(predicate()).toBe(true); };
    until(() => !!sim.st.logistics![routeId].cursors[incomingShip.id]?.code && sim.st.logistics![routeId].cursors[incomingShip.id].code === 'storage');
    expect(sim.st.logistics![routeId].manifests[incomingShip.id].amount).toBe(100); expect(sim.st.ships[incomingShip.id].cargo.ore).toBe(100);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); (sim as any).npcSlow = () => {};
    site = sim.st.stations[site.id]; source = sim.st.stations[source.id];
    expect(storeUsed(site.storage[p])).toBe(81_850); expect(sim.st.logistics![routeId].manifests[incomingShip.id].amount).toBe(100);
    expect(sim.st.ships[incomingShip.id].cargo.ore).toBe(100); expect(sim.st.ships[carrier.id].cargo.ore).toBe(50);
    const out = sim.newGroup(p, '초과 재고 반출'), ship = sim.spawnHull(p, 'hauler_xl', 'hauler_xl_std', undefined, out.id, site.pos);
    expect((sim as any).dockShip(ship, site)).toBe(true);
    expect(sim.command(p, { c: 'putRoute', group: out.id, config: { name: '합금 반출', from: site.id, to: source.id, item: 'alloy', amount: 2000, mode: 'transfer', repeat: false } })).toBeNull();
    const outId = Object.values(sim.st.logistics!).find(r => r.group === out.id)!.id;
    until(() => sim.st.logistics![outId].stats.loaded === 2000);
    expect(storeUsed(site.storage[p])).toBeLessThanOrEqual(80_000);
    until(() => sim.st.logistics![routeId].stats.delivered === 100);
    until(() => sim.st.logistics![outId].stats.delivered === 2000);
    expect(storeUsed(site.storage[p])).toBe(79_950); expect(qty(site.storage[p], 'alloy')).toBe(68_000); expect(qty(source.storage[p], 'alloy')).toBe(2000);
    expect(qty(site.storage[p], 'ore')).toBe(100); expect(sim.st.ships[carrier.id].cargo.ore).toBe(50);
    expect(sim.room(site, p)).toBe(50); expect(sim.st.logistics![routeId].stats.lost).toBe(0);
  }, 60_000);

  it('allows a net-consuming production batch during overflow and holds output until physical space is available', () => {
    const { sim, p, site } = fixture();
    site.modules.push({ kind: 'refinery', slot: site.modules.length, built: true, progress: 1 });
    site.storage[p].ore = 81_850;
    expect(sim.command(p, { c: 'prodOrder', station: site.id, recipe: 'metal', mode: 'count', n: 1 })).toBeNull();
    expect(site.jobs).toHaveLength(1); expect(qty(site.storage[p], 'ore')).toBe(81_810);
    sim.tick(120); expect(site.jobs).toHaveLength(1); expect(site.jobs![0].left).toBe(0); expect(qty(site.storage[p], 'metal')).toBe(0);
    site.storage[p].ore -= 1900; // fixture freeing space; physical outbound is exercised above
    sim.tick(1); expect(site.jobs).toHaveLength(0); expect(qty(site.storage[p], 'metal')).toBe(20);
    expect(storeUsed(site.storage[p])).toBe(79_930);
    sim.tick(1); expect(qty(site.storage[p], 'metal')).toBe(20);
  });

  it('does not bypass an overflowing warehouse through ship refitting or warehouse removal', () => {
    const { sim, p, site } = fixture(); site.storage[p].alloy = 81_850;
    const g = sim.newGroup(p, '장비 검증'), ship = sim.spawnShip(p, 'corvette', 'gun', g.id, site.pos);
    expect((sim as any).dockShip(ship, site)).toBe(true);
    const fitting = structuredClone(ship.fitting!), hp = { ...fitting.hp }, slot = Object.keys(hp)[0];
    expect(slot).toBeTruthy(); delete hp[slot];
    expect(sim.command(p, { c: 'fit', ship: ship.id, variant: ship.variant!, hp, bay: { ...fitting.bay } })).toMatch(/창고 용량 부족/);
    expect(ship.fitting).toEqual(fitting); expect(storeUsed(site.storage[p])).toBe(81_850);
    site.modules.push({ kind: 'warehouse', slot: 35, built: true, progress: 1 });
    expect(sim.command(p, { c: 'removeModule', station: site.id, slot: 35 })).toMatch(/보관할 공간/);
    expect(site.modules.some(m => m.kind === 'warehouse')).toBe(true); expect(storeUsed(site.storage[p])).toBe(81_850);
  });

  it('keeps return space for sale listings so repeated listing and withdrawal cannot add outside cargo', () => {
    const { sim, p, site } = fixture();
    site.modules.push({ kind: 'trade_hub', slot: site.modules.length, built: true, progress: 1 });
    site.storage[p].alloy = 80_000;
    expect(sim.command(p, { c: 'list', station: site.id, item: 'alloy', qty: 1000, price: 10 })).toBeNull();
    const listing = site.listings![0]; expect(qty(site.storage[p], 'alloy')).toBe(79_000); expect(sim.room(site, p)).toBe(0);
    const g = sim.newGroup(p, '매물 우회 검증'), ship = sim.spawnHull(p, 'hauler_m', 'hauler_m_std', undefined, g.id, site.pos);
    expect((sim as any).dockShip(ship, site)).toBe(true); ship.cargo.alloy = 100;
    expect(sim.command(p, { c: 'unloadCargo', ship: ship.id })).toMatch(/빈 공간/); expect(ship.cargo.alloy).toBe(100);
    expect(sim.command(p, { c: 'delist', station: site.id, listing: listing.id })).toBeNull();
    expect(qty(site.storage[p], 'alloy')).toBe(80_000); expect(sim.room(site, p)).toBe(0);
    expect(sim.command(p, { c: 'delist', station: site.id, listing: listing.id })).not.toBeNull();
    expect(qty(site.storage[p], 'alloy')).toBe(80_000); expect(ship.cargo.alloy).toBe(100);
  });

  it('does not refill construction stock hidden in the owner\'s sale listing', () => {
    const { sim, p, site, source } = fixture();
    site.modules.push({ kind: 'trade_hub', slot: site.modules.length, built: true, progress: 1 });
    site.storage[p].alloy = 70_000; source.storage[p].alloy = 100;
    expect(sim.command(p, { c: 'list', station: site.id, item: 'alloy', qty: 70_000, price: 10 })).toBeNull();
    const listing = site.listings![0];
    expect(sim.command(p, { c: 'queueModule', station: site.id, kind: 'yard_xl' })).toBeNull();
    const plan = site.modules.find(m => m.kind === 'yard_xl')!;
    expect(constructionRoom(site, 'alloy')).toBe(0); expect(sim.intakeRoom(site, p, 'alloy', true)).toBe(0);
    const g = sim.newGroup(p, '중복 공급 검증'), ship = sim.spawnHull(p, 'hauler_m', 'hauler_m_std', undefined, g.id, source.pos);
    expect((sim as any).dockShip(ship, source)).toBe(true);
    expect(sim.command(p, { c: 'putRoute', group: g.id, config: { name: '중복 공급 차단', from: source.id, to: site.id, item: 'alloy', amount: 100, mode: 'construction', repeat: true } })).toBeNull();
    for (let i = 0; i < 40; i++) sim.update(.25);
    expect(qty(source.storage[p], 'alloy')).toBe(100); expect(qty(ship.cargo, 'alloy')).toBe(0);
    expect(sim.command(p, { c: 'delist', station: site.id, listing: listing.id })).toBeNull();
    sim.tick(0); expect(plan.reserved!.alloy).toBe(70_000); expect(qty(site.storage[p], 'alloy')).toBe(0);
    expect(sim.command(p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).toBeNull();
    expect(qty(site.storage[p], 'alloy')).toBe(70_000); expect(qty(source.storage[p], 'alloy')).toBe(100);
  });

  it('protects public-warehouse listing returns without charging another company for the space', () => {
    const { sim, p } = fixture(), market = sim.st.stations.astra;
    const other = sim.addPlayer('별도 회사'); sim.st.companies[other].credits = 1_000_000;
    market.storage[p].alloy = 3000;
    expect(sim.command(p, { c: 'list', station: market.id, item: 'alloy', qty: 3000, price: 10 })).toBeNull();
    const listing = market.listings![0]; expect(sim.room(market, p)).toBe(0); expect(sim.room(market, other)).toBe(3000);
    const stock = market.market!.alloy.stock;
    expect(sim.command(p, { c: 'buy', station: market.id, res: 'alloy', amount: 1 })).toMatch(/매물 반환 공간/);
    expect(market.market!.alloy.stock).toBe(stock);
    expect(sim.command(other, { c: 'buyListing', station: market.id, listing: listing.id, qty: 1 })).toBeNull();
    expect(qty(market.storage[other], 'alloy')).toBe(1); expect(sim.room(market, p)).toBe(1);
    expect(sim.command(p, { c: 'delist', station: market.id, listing: listing.id })).toBeNull();
    expect(qty(market.storage[p], 'alloy')).toBe(2999); expect(qty(market.storage[other], 'alloy')).toBe(1);
  });

  it('preserves an unsized growth station and protects its existing overflow without changing its old capacity', () => {
    const { sim, p, site } = fixture(); delete site.size;
    expect(storageCap(site)).toBe(20_000); site.storage[p].alloy = 70_000;
    expect(sim.command(p, { c: 'queueModule', station: site.id, kind: 'yard_xl' })).toBeNull();
    const plan = site.modules.find(m => m.kind === 'yard_xl')!;
    expect(plan.reserved!.alloy).toBe(70_000); expect(sim.room(site, p)).toBe(0);
    Object.assign(site.storage[p], { ...FACILITIES.yard_xl.mats, alloy: 0 }); allocate(site, site.storage[p]);
    expect(reservedSpace(site)).toBe(81_850);
    expect(sim.command(p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).toBeNull();
    expect(storeUsed(site.storage[p])).toBe(81_850); expect(sim.room(site, p)).toBe(0); expect(storageCap(site)).toBe(20_000);
  });
});
