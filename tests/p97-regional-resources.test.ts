import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { Station } from '../src/world/types';
import { cargoSum, qty } from '../src/world/types';
import { sysAt, jumps, hashId, miningSpot } from '../src/world/geom';
import { ITEMS, RECIPES, TECHS, recipeFor } from '../src/world/industry';
import { activateRegionalResources, REGIONAL_FIELDS, regionalHullMaterials } from '../src/world/regional';
import { buildNeeds, buildSpeed, prodSpeed, stationNeeds, stepProduction } from '../src/world/production';
import { supplyBatch } from '../src/world/logistics';
import { grantBlueprint, hullBlueprint } from '../src/world/blueprints';
import { TIER_BASE, miningCargoCapacity } from '../src/world/hullops';
import { checkFitting } from '../src/world/fitting';
import { World } from '../src/sim/world';
import { defaultPlayerFleet } from '../src/sim/fleet';
import { getScenario } from '../src/sim/data/scenarios';
import { priceOf } from '../src/world/market';
import { pubYardHtml } from '../src/client/strategic/growthUi';
import { materialReferenceCost, regionalReferenceValue, regionalShipValueAdjustment, valueOf } from '../src/world/valuation';
import { marketHtml, newIndUi, prodHtml } from '../src/client/strategic/industryUi';
import { newGrowthYardUi, ownYardGrowthHtml } from '../src/client/strategic/growthUi';
import { Analytics } from '../src/server/analytics';

// These integration fixtures deliberately supply capital, facilities, ordinary inputs and research;
// they do not claim that a new company reached the late game without assistance.
function quiet(sim: WorldSim) {
  (sim as any).npcSlow = () => {};
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
}
function factory(sim: WorldSim, owner: string, kinds: string[]): Station {
  const base = sim.st.stations.astra;
  const s: Station = { ...structuredClone(base), id: 'p97_fixture_factory', name: '시험 생산 거점', owner, public: false,
    pos: { ...base.pos, x: base.pos.x + 3500 }, size: 'L', market: null, funds: undefined, fundsMax: undefined,
    storage: { [owner]: {} }, modules: ['core', 'power', ...kinds].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })),
    orders: [], jobs: [], builds: [], listings: [], seq: 0 };
  sim.st.stations[s.id] = s;
  return s;
}
function until(sim: WorldSim, label: string, condition: () => boolean, seconds = 4000) {
  for (let t = 0; t < seconds && !condition(); t += .25) sim.update(.25);
  if (!condition()) throw new Error(`${label}: ${JSON.stringify(Object.values(sim.st.groups).filter(g => sim.st.companies[g.owner]?.kind === 'player').map(g => ({ name: g.name, status: g.status, op: g.op })))}`);
}

describe('P9.7 regional resources', () => {
  it('creates four exclusive origins with stable fields, unchanged geography and finite replenishment', () => {
    const a = WorldSim.create(970), b = WorldSim.create(970);
    expect(a.serialize()).toBe(b.serialize());
    expect(Object.keys(a.st.systems)).toHaveLength(22);
    expect(a.st.regionalV).toBe(1);
    for (const def of REGIONAL_FIELDS) {
      const f = a.st.fields[def.id];
      expect(sysAt(a.st.systems, f.pos)?.id).toBe(def.sys);
      expect(f.amount).toBe(def.amount);
      expect(f.regen).toBe(def.regen);
      expect(Object.values(f.mix!).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
      const origins = Object.values(a.st.fields).filter(x => x.res === def.res || (x.mix?.[def.res] ?? 0) > 0);
      expect(origins.map(x => x.id)).toEqual([def.id]);
      expect(def.regen * def.mix[def.res] * 86400).toBeGreaterThan(0);
      expect(def.regen * def.mix[def.res] * 86400).toBeLessThan(1000);
      expect(Object.values(a.st.stations).some(s => !!s.market?.[def.res])).toBe(false);
    }
    for (const system of ['quiet', 'rift', 'rime', 'frontier'])
      expect(REGIONAL_FIELDS.some(f => f.sys === system)).toBe(false);
    expect(jumps(a.st.systems, 'astra', 'blackgate')).toBeGreaterThan(1);
    const f = a.st.fields.p97_anvil_dense;
    f.amount = 0;
    quiet(a);
    for (let i = 0; i < 160; i++) a.update(.25);
    expect(f.amount).toBeCloseTo(f.regen * 40, 6);
    f.amount = f.max - .001;
    for (let i = 0; i < 8; i++) a.update(.25);
    expect(f.amount).toBe(f.max);
  });

  it('retains a usable starting fleet, basic hull purchase and ordinary mining without rare materials', () => {
    const sim = WorldSim.create(980); quiet(sim);
    const p = sim.addPlayer('초기 성장 시험'), co = sim.st.companies[p];
    const group = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'miner'))!;
    expect(co.credits).toBe(12000);
    expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'corvette', loadoutId: 'gun' })).toBeNull();
    const afterPurchase = co.credits;
    expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } })).toBeNull();
    for (let i = 0; i < 2400; i++) sim.update(.25);
    expect(co.stats.mined).toBeGreaterThan(0);
    expect(co.credits).toBeGreaterThan(afterPurchase);
    expect(co.tech ?? []).toEqual([]);
  });

  it('finishes already paid batches but requires regional inputs for every new batch after activation', () => {
    let sim = WorldSim.create(971); quiet(sim);
    for (const def of REGIONAL_FIELDS) delete sim.st.fields[def.id];
    delete sim.st.regionalV;
    const p = sim.addPlayer('구형 산업'), co = sim.st.companies[p]; co.tech = ['railguns'];
    const st = factory(sim, p, ['weapons_factory']);
    for (const [item, n] of Object.entries(RECIPES.eq_rail_cannon.in)) st.storage[p][item] = n * 3;
    expect(sim.command(p, { c: 'prodOrder', station: st.id, recipe: 'eq_rail_cannon', mode: 'count', n: 2 })).toBeNull();
    expect(st.jobs).toHaveLength(1);
    const oldAmount = sim.st.fields.kestrel.amount = 3210.5;
    const oldSave = JSON.parse(sim.serialize());
    sim = new WorldSim(structuredClone(oldSave), { migrateContent: false });
    expect(sim.st.regionalV).toBeUndefined();
    expect(sim.st.fields.kestrel.amount).toBe(oldAmount);
    expect(sim.st.fields.p97_anvil_dense).toBeUndefined();
    activateRegionalResources(sim.st);
    const restored = sim.st.stations[st.id];
    expect(restored.orders![0].done).toBe(0);
    const before = JSON.stringify(sim.st);
    activateRegionalResources(sim.st);
    expect(JSON.stringify(sim.st)).toBe(before);
    stepProduction(restored, sim.st.companies[p], 3000, sim.st);
    expect(restored.jobs).toHaveLength(0);
    expect(qty(restored.storage[p], 'eq_rail_cannon')).toBe(1);
    expect(restored.orders![0].done).toBe(1);
    expect(restored.orders![0].why).toContain('고강도 특수 합금');
    expect(stationNeeds(restored, sim.st).dense_alloy).toBe(12);
    expect(supplyBatch(restored, 'dense_alloy', sim.st)).toBe(6);
    let again = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(again.st.fields.kestrel.amount).toBe(oldAmount);
    expect(again.st.stations[st.id].orders![0].why).toContain('고강도 특수 합금');
    again.st.stations[st.id].storage[p].dense_alloy = 6;
    stepProduction(again.st.stations[st.id], again.st.companies[p], 1, again.st);
    expect(qty(again.st.stations[st.id].storage[p], 'dense_alloy')).toBe(0);
    again = new WorldSim(JSON.parse(again.serialize()), { migrateContent: false });
    stepProduction(again.st.stations[st.id], again.st.companies[p], 3000, again.st);
    expect(qty(again.st.stations[st.id].storage[p], 'eq_rail_cannon')).toBe(2);
    expect(again.st.stations[st.id].orders).toHaveLength(0);
  });

  it('does not let already activated development saves use legacyRecipe for stock replenishment', () => {
    let sim = WorldSim.create(982), p = sim.addPlayer('구형 재고 주문');
    sim.st.companies[p].tech = ['railguns'];
    const st = factory(sim, p, ['weapons_factory']);
    for (const [item, n] of Object.entries(RECIPES.eq_rail_cannon.in)) st.storage[p][item] = n * 4;
    // A saved P9.7 development world can already have this flag and an in-flight paid batch.
    delete sim.st.regionalV;
    expect(sim.command(p, { c: 'prodOrder', station: st.id, recipe: 'eq_rail_cannon', mode: 'stock', n: 2 })).toBeNull();
    sim.st.regionalV = 1;
    st.orders![0].legacyRecipe = true;
    const paid = structuredClone(st.storage[p]);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const restored = sim.st.stations[st.id];
    expect(restored.storage[p]).toEqual(paid);
    expect(stationNeeds(restored, sim.st).dense_alloy).toBe(12);
    expect(supplyBatch(restored, 'dense_alloy', sim.st)).toBe(6);
    stepProduction(restored, sim.st.companies[p], 3000, sim.st);
    expect(qty(restored.storage[p], 'eq_rail_cannon')).toBe(1);
    expect(restored.jobs).toHaveLength(0);
    expect(restored.orders![0].n).toBe(2);
    expect(restored.orders![0].done).toBe(1);
    expect(restored.orders![0].why).toContain('고강도 특수 합금');
    restored.storage[p].dense_alloy = 6;
    stepProduction(restored, sim.st.companies[p], 1, sim.st);
    stepProduction(restored, sim.st.companies[p], 3000, sim.st);
    expect(qty(restored.storage[p], 'eq_rail_cannon')).toBe(2);
    expect(restored.orders![0].done).toBe(2);
    restored.storage[p].eq_rail_cannon = 0;
    stepProduction(restored, sim.st.companies[p], 1, sim.st);
    expect(restored.jobs).toHaveLength(0);
    expect(restored.orders![0].why).toContain('고강도 특수 합금');
  });

  it('rejects a conflicting explicit migration before modifying old fields or orders', () => {
    const sim = WorldSim.create(972);
    delete sim.st.regionalV;
    const before = JSON.stringify(sim.st);
    expect(() => activateRegionalResources(sim.st)).toThrow(/collision/);
    expect(JSON.stringify(sim.st)).toBe(before);
  });

  it('actually mines every authored rare material without inventing or losing mixed cargo', () => {
    const sim = WorldSim.create(978); quiet(sim);
    const p = sim.addPlayer('네 산지 채굴 시험'); sim.st.companies[p].credits = 1e7;
    for (const def of REGIONAL_FIELDS) {
      const f = sim.st.fields[def.id]; f.regen = 0;
      const initial = f.amount, group = sim.newGroup(p, def.name), ship = sim.spawnShip(p, 'miner', 'std', group.id, f.pos);
      ship.pos = miningSpot(f, hashId(ship.id) % f.rocks);
      expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'mine', field: f.id, deliver: 'drakeout', sell: false } })).toBeNull();
      until(sim, def.id, () => qty(ship.cargo, def.res) > 0, 60);
      expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'idle' } })).toBeNull();
      const extracted = initial - f.amount;
      expect(cargoSum(ship.cargo)).toBeCloseTo(extracted, 6);
      expect(qty(ship.cargo, def.res)).toBeCloseTo(extracted * def.mix[def.res], 6);
    }
  });

  it('shares one finite deposit between two companies without duplicating rare cargo, including after restore', () => {
    let sim = WorldSim.create(984); quiet(sim); (sim as any).npcs = () => {};
    const owners = [sim.addPlayer('경쟁사 A'), sim.addPlayer('경쟁사 B')];
    const field = sim.st.fields.p97_anvil_dense;
    field.amount = 120; field.regen = 0;
    const ids = owners.map(owner => {
      const group = sim.newGroup(owner, '공유 광상');
      const ship = sim.spawnShip(owner, 'miner', 'std', group.id, field.pos);
      ship.pos = miningSpot(field, hashId(ship.id) % field.rocks);
      expect(sim.command(owner, { c: 'setOp', group: group.id, op: { k: 'mine', field: field.id, deliver: 'p9_anvil_port', sell: false } })).toBeNull();
      return ship.id;
    });
    until(sim, 'shared deposit exhausted', () => field.amount < 1, 120);
    const mined = 120 - field.amount;
    const cargo = ids.map(id => sim.st.ships[id].cargo);
    expect(cargo.every(c => qty(c, 'dense_titanium_ore') > 0)).toBe(true);
    expect(cargo.reduce((n, c) => n + cargoSum(c), 0)).toBeCloseTo(mined, 6);
    expect(cargo.reduce((n, c) => n + qty(c, 'dense_titanium_ore'), 0)).toBeCloseTo(mined * .3, 6);
    const saved = structuredClone(cargo);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(ids.map(id => sim.st.ships[id].cargo)).toEqual(saved);
    expect(sim.st.fields[field.id].amount).toBeCloseTo(120 - mined, 8);
  });

  it('lets four companies independently mine the four different origins in one shared world', () => {
    const sim = WorldSim.create(985); quiet(sim); (sim as any).npcs = () => {};
    const miners = REGIONAL_FIELDS.map(def => {
      const owner = sim.addPlayer(def.sys), f = sim.st.fields[def.id];
      const g = sim.newGroup(owner, def.sys), ship = sim.spawnShip(owner, 'miner', 'std', g.id, f.pos);
      ship.pos = miningSpot(f, hashId(ship.id) % f.rocks);
      expect(sim.command(owner, { c: 'setOp', group: g.id, op: { k: 'mine', field: f.id, deliver: 'drakeout', sell: false } })).toBeNull();
      return { def, ship, initial: f.amount };
    });
    until(sim, 'four independent origins', () => miners.every(({ def, ship }) => qty(ship.cargo, def.res) > 1), 120);
    for (const { def, ship, initial } of miners) {
      const f = sim.st.fields[def.id];
      // Initial field is full; account for its simultaneous regeneration.
      expect(qty(ship.cargo, def.res)).toBeGreaterThan(1);
      expect(initial - f.amount).toBeLessThanOrEqual(cargoSum(ship.cargo) + 1e-6);
      expect(qty(ship.cargo, def.res)).toBeCloseTo(cargoSum(ship.cargo) * def.mix[def.res], 6);
    }
  });

  it('applies cargo compression to miners and their support haulers in regional mining operations only', () => {
    const sim = WorldSim.create(987); quiet(sim); (sim as any).npcs = () => {};
    const p = sim.addPlayer('압축 연구'); sim.st.companies[p].tech = ['cargo_compression'];
    const f = sim.st.fields.p97_anvil_dense;
    const g = sim.newGroup(p, '압축 채굴'), miner = sim.spawnShip(p, 'miner', 'std', g.id, f.pos);
    expect(miningCargoCapacity(sim.st, miner, sim.st.companies[p].tech)).toBe(175);
    expect(miningCargoCapacity({}, miner, sim.st.companies[p].tech)).toBe(140);
    miner.pos = miningSpot(f, hashId(miner.id) % f.rocks); miner.cargo.ore = 138;
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: f.id, deliver: 'p9_anvil_port', sell: false } })).toBeNull();
    until(sim, 'compressed miner', () => cargoSum(miner.cargo) > 140, 20);
    expect(cargoSum(miner.cargo)).toBeLessThanOrEqual(175);
    const h = sim.newGroup(p, '압축 수송 지원'), donor = sim.spawnShip(p, 'miner', 'std', h.id, f.pos), hauler = sim.spawnShip(p, 'hauler', 'std', h.id, f.pos);
    donor.pos = miningSpot(f, hashId(donor.id) % f.rocks); donor.cargo.ore = 100;
    hauler.pos = { ...donor.pos, y: donor.pos.y + 26 }; hauler.cargo.ore = 440;
    expect(sim.command(p, { c: 'setOp', group: h.id, op: { k: 'mine', field: f.id, deliver: 'p9_anvil_port', sell: false } })).toBeNull();
    until(sim, 'compressed mining support hauler', () => cargoSum(hauler.cargo) > 450, 20);
    expect(cargoSum(hauler.cargo)).toBeLessThanOrEqual(562.5);

    const old = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); delete old.st.regionalV;
    const legacyMiner = old.st.ships[miner.id]; legacyMiner.cargo = { ore: 138 }; legacyMiner.pos = miningSpot(old.st.fields[f.id], hashId(legacyMiner.id) % f.rocks);
    for (let i = 0; i < 8; i++) old.update(.25);
    expect(cargoSum(legacyMiner.cargo)).toBe(138);
  });

  it('preserves a running rare-material batch and a paused second batch over save and resume', () => {
    let sim = WorldSim.create(981), p = sim.addPlayer('생산 복원');
    sim.st.companies[p].tech = ['rare_processing'];
    const st = factory(sim, p, ['smelter']);
    Object.assign(st.storage[p], { dense_titanium_ore: 80, titanium: 20, metal: 20 });
    expect(sim.command(p, { c: 'prodOrder', station: st.id, recipe: 'dense_alloy', mode: 'count', n: 2 })).toBeNull();
    const order = st.orders![0]; expect(st.jobs).toHaveLength(1);
    expect(sim.command(p, { c: 'prodOp', station: st.id, order: order.id, op: 'pause' })).toBeNull();
    expect(qty(st.storage[p], 'dense_titanium_ore')).toBe(40);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const restored = sim.st.stations[st.id], co = sim.st.companies[p];
    stepProduction(restored, co, 180, sim.st);
    expect(qty(restored.storage[p], 'dense_alloy')).toBe(12);
    expect(qty(restored.storage[p], 'dense_titanium_ore')).toBe(40);
    expect(restored.jobs).toHaveLength(0); expect(restored.orders![0].paused).toBe(true);
    expect(sim.command(p, { c: 'prodOp', station: st.id, order: order.id, op: 'resume' })).toBeNull();
    expect(restored.jobs).toHaveLength(1); expect(qty(restored.storage[p], 'dense_titanium_ore')).toBe(0);
    stepProduction(restored, co, 180, sim.st);
    expect(qty(restored.storage[p], 'dense_alloy')).toBe(24); expect(restored.orders).toHaveLength(0);
  });

  it('requires the four regional inputs in the server recipe and snapshots capital build materials', () => {
    const sim = WorldSim.create(973), p = sim.addPlayer('재료 검증'), co = sim.st.companies[p];
    co.tech = ['railguns', 'particle_lance', 'reactive_armor', 'reactor_tuning'];
    const st = factory(sim, p, ['weapons_factory', 'armor_plant', 'reactor_plant']);
    for (const id of ['eq_rail_cannon', 'eq_lance', 'mod_armor2', 'mod_reactor']) {
      const r = recipeFor(sim.st, id)!;
      for (const [item, n] of Object.entries(RECIPES[id].in)) st.storage[p][item] = (st.storage[p][item] ?? 0) + n;
      expect(Object.keys(r.in).some(k => ITEMS[k]?.regional)).toBe(true);
      expect(sim.command(p, { c: 'prodOrder', station: st.id, recipe: id, mode: 'count', n: 1 })).toBeNull();
      const order = st.orders!.find(o => o.recipe === id)!;
      expect(order.why).toMatch(/부족/);
      expect(st.jobs!.some(j => j.order === order.id)).toBe(false);
    }
    const terms = regionalHullMaterials(sim.st, 'dreadnought_mk1');
    expect(terms).toEqual({ dense_alloy: 20, singular_alloy: 40 });
    expect(buildNeeds('dreadnought', 'std', [], { hull: 'dreadnought_mk1', regionalMaterials: terms }).singular_alloy).toBe(40);
    expect(buildNeeds('dreadnought', 'std', [], { hull: 'dreadnought_mk1' }).singular_alloy).toBeUndefined();
    expect(regionalHullMaterials(undefined, 'dreadnought_mk1')).toBeUndefined();
    expect(regionalHullMaterials(sim.st, 'corvette_mk1')).toBeUndefined();
    for (const id of ['eq_rail_cannon', 'eq_lance', 'mod_armor2', 'mod_reactor']) {
      const r = recipeFor(sim.st, id)!;
      const inputs = Object.entries(r.in).reduce((n, [item, amount]) => n + valueOf(item) * amount, 0);
      expect(regionalReferenceValue(sim.st, id)).toBeGreaterThan(inputs);
    }
    expect(regionalReferenceValue({}, 'mod_armor2')).toBeUndefined();
    st.storage[p].mod_armor2 = 1;
    expect(marketHtml(sim.st as any, st, p, newIndUi(), () => 0)).toContain('data-region-value=');
  });

  it('shows estimated input value separately from old references and executable prices', () => {
    const sim = WorldSim.create(983), p = sim.addPlayer('원가 검증');
    const st = factory(sim, p, ['weapons_factory']);
    const ui = newIndUi(); ui.recSel = 'eq_rail_cannon';
    const recipe = recipeFor(sim.st, ui.recSel)!;
    expect(materialReferenceCost(sim.st, recipe.in)).toBeCloseTo(11561.4, 1);
    const html = prodHtml(sim.st as any, st, p, ui);
    expect(html).toContain('예상 재료 원가');
    expect(html).toContain('기존 참고 가치');
    expect(html).toContain('11,561');
    expect(html).toContain('실제 거래');
    const need = buildNeeds('dreadnought', '', [], { hull: 'dreadnought_mk1', preset: 'dreadnought_std', regionalMaterials: regionalHullMaterials(sim.st, 'dreadnought_mk1') });
    const before = { ...need }; delete before.dense_alloy; delete before.singular_alloy;
    expect(materialReferenceCost(sim.st, need) - materialReferenceCost(sim.st, before)).toBeCloseTo(20 * valueOf('dense_alloy') + 40 * valueOf('singular_alloy'), 5);
    const yui = newGrowthYardUi(); yui.hull = 'dreadnought_mk1';
    const yard = ownYardGrowthHtml(sim.st as any, st, p, yui, []);
    expect(yard).toContain('예상 재료 원가');
    expect(yard).toContain('고강도 특수 합금');
    expect(yard).toContain('특이 합금');
  });

  it('values regional assets and fitted materials for assessment without changing old worlds', () => {
    const sim = WorldSim.create(986), p = sim.addPlayer('자산 평가');
    const st = sim.st.stations.astra;
    const base = sim.netWorth(p);
    st.storage[p].eq_lance = 1;
    expect(sim.netWorth(p) - base).toBeCloseTo(regionalReferenceValue(sim.st, 'eq_lance')!, 0);
    const ship = { hull: 'dreadnought_mk1', fitting: { hp: { a: 'eq_lance' }, bay: { a: 'mod_armor2' } } };
    const expected = 20 * valueOf('dense_alloy') + 40 * valueOf('singular_alloy') +
      regionalReferenceValue(sim.st, 'eq_lance')! + regionalReferenceValue(sim.st, 'mod_armor2')!;
    expect(regionalShipValueAdjustment(sim.st, ship)).toBeCloseTo(expected, 6);
    expect(regionalShipValueAdjustment({}, ship)).toBe(0);
    const replaced = { hull: 'dreadnought_mk1', fitting: { hp: { hp01: 'eq_lance' }, bay: {} } };
    expect(regionalShipValueAdjustment(sim.st, replaced)).toBeCloseTo(20 * valueOf('dense_alloy') + 40 * valueOf('singular_alloy') + regionalReferenceValue(sim.st, 'eq_lance')! - valueOf('eq_heavy_cannon'), 6);
    const fleet = sim.newGroup(p, '함선 평가'), dread = sim.spawnShip(p, 'dreadnought', 'std', fleet.id, st.pos);
    const beforeFit = sim.netWorth(p);
    expect(dread.fitting!.hp.hp01).toBe('eq_heavy_cannon');
    dread.fitting!.hp.hp01 = 'eq_lance';
    expect(sim.netWorth(p) - beforeFit).toBeCloseTo(regionalReferenceValue(sim.st, 'eq_lance')! - valueOf('eq_heavy_cannon'), 0);
  });

  it('uses the same regional asset reference in storage, cargo and player listings', () => {
    const sim = WorldSim.create(988), p = sim.addPlayer('자산 위치');
    const analytics = new Analytics(sim), st = sim.st.stations.astra;
    const ship = Object.values(sim.st.ships).find(s => s.owner === p)!;
    const assets = () => analytics.sample().companies.find(c => c.id === p)!.assets;
    st.storage[p].eq_lance = 1;
    const inStorage = assets();
    delete st.storage[p].eq_lance; ship.cargo.eq_lance = 1;
    const inCargo = assets();
    expect(inCargo).toBeCloseTo(inStorage, 0);
    delete ship.cargo.eq_lance; st.storage[p].eq_lance = 1;
    expect(sim.command(p, { c: 'list', station: st.id, item: 'eq_lance', qty: 1, price: 1 })).toBeNull();
    expect(assets()).toBeCloseTo(inStorage, 0);
  });

  it('uses real NPC market stock atomically for restricted refits in regional worlds only', () => {
    const sim = WorldSim.create(976), p = sim.addPlayer('공영 피팅 검증'), co = sim.st.companies[p];
    co.credits = 100000; co.tech = ['reactive_armor'];
    const st = sim.st.stations.helios, g = sim.newGroup(p, '피팅 검증');
    const ship = sim.spawnShip(p, 'cruiser', 'gun', g.id, st.pos);
    expect((sim as any).dockShip(ship, st)).toBe(true);
    const command = { c: 'fit', ship: ship.id, variant: ship.variant!, hp: { ...ship.fitting!.hp }, bay: { bay1: 'mod_armor2' }, buy: true } as const;
    const startCredits = co.credits, originalFit = structuredClone(ship.fitting);
    expect(sim.command(p, command)).toMatch(/시장 재고 부족/);
    expect(co.credits).toBe(startCredits); expect(ship.fitting).toEqual(originalFit);
    st.market!.mod_armor2 = { stock: 1, target: 1, base: 1234 };
    const cost = priceOf(st.market!.mod_armor2, 'buy', true);
    co.credits = 1;
    expect(sim.command(p, command)).toMatch(/자금 부족/);
    expect(st.market!.mod_armor2.stock).toBe(1); expect(ship.fitting).toEqual(originalFit);
    co.credits = startCredits;
    expect(sim.command(p, command)).toBeNull();
    expect(co.credits).toBeCloseTo(startCredits - cost - 700, 6);
    expect(st.market!.mod_armor2.stock).toBe(0);
    expect(ship.fitting!.bay.bay1).toBe('mod_armor2');
    expect(sim.command(p, command)).toMatch(/변경 사항 없음/);
    expect(st.market!.mod_armor2.stock).toBe(0);
    const legacy = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    delete legacy.st.regionalV;
    const other = legacy.spawnShip(p, 'cruiser', 'gun', legacy.newGroup(p, '구형 피팅').id, st.pos);
    expect((legacy as any).dockShip(other, legacy.st.stations[st.id])).toBe(true);
    expect(legacy.command(p, { c: 'fit', ship: other.id, variant: other.variant!, hp: other.fitting!.hp, bay: { bay1: 'mod_armor2' }, buy: true })).toBeNull();
  });

  it('does not generate restricted weapons through public-yard presets in regional worlds', () => {
    const sim = WorldSim.create(977), p = sim.addPlayer('공영 조선소 검증'), co = sim.st.companies[p];
    co.credits = 100_000_000; co.rep = 1000;
    const st = sim.st.stations.helios;
    const cmd = { c: 'buyShip', station: st.id, classId: 'battleship', loadoutId: 'rail', hull: 'battleship_mk1', variant: 'battleship_mk1_std', preset: 'battleship_rail' } as const;
    const stock = st.shipStock!.battleship_mk1.n, credits = co.credits, ships = Object.keys(sim.st.ships).length;
    expect(sim.command(p, cmd)).toMatch(/지역 희귀 소재/);
    expect(st.shipStock!.battleship_mk1.n).toBe(stock); expect(co.credits).toBe(credits); expect(Object.keys(sim.st.ships)).toHaveLength(ships);
    expect(pubYardHtml(sim.st as any, st, p, [])).not.toContain('value="battleship_rail"');
    expect(sim.command(p, { ...cmd, loadoutId: 'std', preset: 'battleship_std' })).toBeNull();
    const old = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); delete old.st.regionalV;
    old.st.stations.helios.shipStock!.battleship_mk1.n = 1;
    expect(old.command(p, cmd)).toBeNull();
    const sold = Object.values(old.st.ships).find(s => s.owner === p && s.fitting && Object.values(s.fitting.hp).includes('eq_rail_cannon'));
    expect(sold).toBeDefined();
  });

  it('does not start a dreadnought without the actual regional materials, then launches one after restore', () => {
    let sim = WorldSim.create(975); quiet(sim); (sim as any).npcs = () => {};
    const p = sim.addPlayer('최상위 선체 시험'), co = sim.st.companies[p];
    co.credits = 100_000_000; co.tech = Object.keys(TECHS);
    const st = factory(sim, p, ['yard_xl', ...TIER_BASE[4].filter(k => k !== 'power'), 'power', 'power']); st.size = 'XL';
    const hull = 'dreadnought_mk1', preset = 'dreadnought_std';
    expect(grantBlueprint(sim.st, co, hullBlueprint(hull)!, 'fixture', sim.time)).toBe(true);
    const base = buildNeeds('dreadnought', 'std', [], { hull, variant: `${hull}_std`, preset });
    Object.assign(st.storage[p], base);
    expect(sim.command(p, { c: 'buildShip', station: st.id, classId: 'dreadnought', loadoutId: 'std', hull, variant: `${hull}_std`, preset })).toBeNull();
    let plan = st.builds![0];
    expect(plan.started).toBe(false);
    expect(plan.regionalMaterials).toEqual({ dense_alloy: 20, singular_alloy: 40 });
    expect(plan.why).toContain('고강도 특수 합금'); expect(plan.why).toContain('특이 합금');
    expect(st.storage[p].structure).toBe(base.structure);
    st.storage[p].dense_alloy = 20; st.storage[p].singular_alloy = 40;
    sim.tick(.25); expect(plan.started).toBe(true);
    expect(qty(st.storage[p], 'dense_alloy')).toBe(0); expect(qty(st.storage[p], 'singular_alloy')).toBe(0);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); quiet(sim); (sim as any).npcs = () => {};
    const restored = sim.st.stations[st.id]; plan = restored.builds![0];
    expect(plan.started).toBe(true); expect(plan.regionalMaterials).toEqual({ dense_alloy: 20, singular_alloy: 40 });
    // The existing strategic tick is advanced over the remaining yard work in one isolated step.
    sim.tick(plan.left / buildSpeed(restored, sim.st.companies[p]) + 1);
    const ship = Object.values(sim.st.ships).find(s => s.owner === p && s.hull === hull)!;
    expect(ship).toBeDefined(); expect(restored.builds).toHaveLength(0);
    expect(checkFitting(ship.variant!, ship.fitting!).errors).toEqual([]);
    const blue = defaultPlayerFleet(); blue.root.children = []; blue.root.ships = [{ classId: ship.classId, loadoutId: ship.loadoutId, fit: sim.fittingSpec(ship), fx: sim.shipFxOf(ship) }];
    const battle = new World({ seed: 975, scenarioId: 'kestrel', fleets: [blue, getScenario('kestrel').enemy] });
    expect(battle.ships.some(s => s.team === 0 && s.cls.id === 'dreadnought')).toBe(true);
    for (let i = 0; i < 20 && !battle.outcome; i++) battle.step();
    expect(battle.tick).toBeGreaterThan(0);
  });

  it('mines Anvil, hauls through gates, processes an alloy and fits a produced armor module', () => {
    let sim = WorldSim.create(974); quiet(sim);
    const p = sim.addPlayer('지역 산업 시험'), co = sim.st.companies[p];
    co.credits = 1e7; co.tech = ['rare_processing', 'reactive_armor'];
    const station = factory(sim, p, ['smelter', 'armor_plant', 'fitting', 'logistics']);
    Object.assign(station.storage[p], { titanium: 10, metal: 10, armor_plate: 6, composite: 8, chemicals: 6 });
    const f = sim.st.fields.p97_anvil_dense, initial = f.amount;
    f.regen = 0; // isolate conservation from the separate regeneration check above
    const group = sim.newGroup(p, '앤빌 채굴'), miner = sim.spawnShip(p, 'miner', 'std', group.id, f.pos);
    expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'mine', field: f.id, deliver: 'p9_anvil_port', sell: false } })).toBeNull();
    until(sim, 'mining and unloading', () => qty(sim.st.stations.p9_anvil_port.storage[p], 'dense_titanium_ore') >= 45);
    expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'idle' } })).toBeNull();
    const source = sim.st.stations.p9_anvil_port;
    const extracted = initial - f.amount;
    expect(qty(source.storage[p], 'dense_titanium_ore') + qty(miner.cargo, 'dense_titanium_ore')).toBeCloseTo(extracted * .3, 5);
    expect(cargoSum(source.storage[p]) + cargoSum(miner.cargo)).toBeCloseTo(extracted, 5);
    const buyer = sim.addPlayer('희귀 원광 구매사'); sim.st.companies[buyer].credits = 10000;
    const sellerBefore = sim.st.companies[p].credits, buyerBefore = sim.st.companies[buyer].credits;
    expect(sim.command(p, { c: 'list', station: source.id, item: 'dense_titanium_ore', qty: 5, price: 20 })).toBeNull();
    const listing = source.listings![0];
    const buy = { c: 'buyListing', station: source.id, listing: listing.id, qty: 5, request: { seq: 1, id: 'p97-rare-trade-01' } } as const;
    expect(sim.command(buyer, buy)).toBeNull(); expect(sim.command(buyer, buy)).toBeNull();
    expect(qty(source.storage[buyer], 'dense_titanium_ore')).toBe(5);
    expect(sim.st.companies[buyer].credits).toBe(buyerBefore - 100);
    expect(sim.st.companies[p].credits).toBeCloseTo(sellerBefore + 100 * (1 - (source.tax ?? .02)), 6);
    expect(qty(source.storage[p], 'dense_titanium_ore') + qty(source.storage[buyer], 'dense_titanium_ore') + qty(miner.cargo, 'dense_titanium_ore')).toBeCloseTo(extracted * .3, 5);
    expect(sim.command(p, { c: 'prodOrder', station: station.id, recipe: 'dense_alloy', mode: 'count', n: 1 })).toBeNull();
    expect(station.orders![0].why).toContain('고밀도 티타늄 원광');
    const freight = sim.newGroup(p, '원광 운송'), ship = sim.spawnShip(p, 'hauler', 'std', freight.id, source.pos);
    expect(sim.command(p, { c: 'putRoute', group: freight.id, config: { name: '앤빌 → 공장', from: source.id, to: station.id, item: 'dense_titanium_ore', amount: 40, mode: 'supply', repeat: false, minStock: 0, targetStock: 40 } })).toBeNull();
    const route = Object.values(sim.st.logistics!)[0];
    until(sim, 'physical loading', () => qty(sim.st.ships[ship.id].cargo, 'dense_titanium_ore') === 40);
    const sourceAfterLoad = qty(source.storage[p], 'dense_titanium_ore');
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); quiet(sim);
    expect(qty(sim.st.ships[ship.id].cargo, 'dense_titanium_ore')).toBe(40);
    until(sim, 'delivery and refining', () => qty(sim.st.stations[station.id].storage[p], 'dense_alloy') === 12, 6000);
    const dst = sim.st.stations[station.id], savedRoute = sim.st.logistics![route.id];
    expect(savedRoute.stats.loaded).toBe(40); expect(savedRoute.stats.delivered).toBe(40);
    expect(qty(sim.st.stations[source.id].storage[p], 'dense_titanium_ore')).toBeCloseTo(sourceAfterLoad, 6);
    expect(qty(sim.st.ships[ship.id].cargo, 'dense_titanium_ore')).toBe(0);
    expect(qty(dst.storage[p], 'dense_titanium_ore')).toBe(0);
    expect(sim.command(p, { c: 'prodOrder', station: dst.id, recipe: 'mod_armor2', mode: 'count', n: 1 })).toBeNull();
    until(sim, 'armor production', () => qty(dst.storage[p], 'mod_armor2') === 1, 3000);
    expect(qty(dst.storage[p], 'dense_alloy')).toBe(8);
    const fightGroup = sim.newGroup(p, '피팅 시험'), warship = sim.spawnShip(p, 'cruiser', 'gun', fightGroup.id, dst.pos);
    expect((sim as any).dockShip(warship, dst)).toBe(true);
    expect(sim.command(p, { c: 'fitShip', ship: warship.id, fit: ['mod_armor2'] })).toBeNull();
    expect(Object.values(warship.fitting!.bay)).toContain('mod_armor2');
    expect(qty(dst.storage[p], 'mod_armor2')).toBe(0);
  }, 60_000);

  it('lets a company that mines nothing buy a processed regional material, haul it and manufacture equipment', () => {
    const sim = WorldSim.create(989); quiet(sim); (sim as any).npcs = () => {};
    const seller = sim.addPlayer('소재 생산사'), buyer = sim.addPlayer('비채굴 제조사');
    sim.st.companies[seller].credits = sim.st.companies[buyer].credits = 1e7;
    sim.st.companies[seller].tech = ['rare_processing']; sim.st.companies[buyer].tech = ['reactive_armor'];
    const producer = factory(sim, seller, ['smelter', 'trade_hub', 'logistics']);
    Object.assign(producer.storage[seller], { titanium: 10, metal: 10 });
    const buyerSite: Station = { ...structuredClone(producer), id: 'p971_buyer_factory', name: '구매사 공장', owner: buyer,
      pos: { ...producer.pos, x: producer.pos.x + 5000 }, storage: { [buyer]: { armor_plate: 6, composite: 8, chemicals: 6 } },
      modules: ['core', 'power', 'armor_plant', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })), orders: [], jobs: [], builds: [], listings: [], seq: 0 };
    sim.st.stations[buyerSite.id] = buyerSite;
    const field = sim.st.fields.p97_anvil_dense; field.regen = 0;
    const g = sim.newGroup(seller, '판매사 광부'), miner = sim.spawnShip(seller, 'miner', 'std', g.id, field.pos);
    miner.pos = miningSpot(field, hashId(miner.id) % field.rocks);
    expect(sim.command(seller, { c: 'setOp', group: g.id, op: { k: 'mine', field: field.id, deliver: 'p9_anvil_port', sell: false } })).toBeNull();
    until(sim, 'seller mines rare ore', () => qty(sim.st.stations.p9_anvil_port.storage[seller], 'dense_titanium_ore') >= 40, 4000);
    expect(sim.command(seller, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    expect(sim.command(seller, { c: 'prodOrder', station: producer.id, recipe: 'dense_alloy', mode: 'count', n: 1 })).toBeNull();
    const freight = sim.newGroup(seller, '원광 운송'); sim.spawnShip(seller, 'hauler', 'std', freight.id, sim.st.stations.p9_anvil_port.pos);
    expect(sim.command(seller, { c: 'putRoute', group: freight.id, config: { name: '원광', from: 'p9_anvil_port', to: producer.id, item: 'dense_titanium_ore', amount: 40, mode: 'transfer', repeat: false } })).toBeNull();
    until(sim, 'seller processes alloy', () => qty(producer.storage[seller], 'dense_alloy') === 12, 6000);
    expect(sim.command(seller, { c: 'list', station: producer.id, item: 'dense_alloy', qty: 12, price: 500 })).toBeNull();
    const listing = producer.listings![0], sellerBefore = sim.st.companies[seller].credits, buyerBefore = sim.st.companies[buyer].credits;
    expect(sim.command(buyer, { c: 'buyListing', station: producer.id, listing: listing.id, qty: 12 })).toBeNull();
    expect(sim.st.companies[buyer].credits).toBe(buyerBefore - 6000);
    expect(sim.st.companies[seller].credits).toBeCloseTo(sellerBefore + 6000 * (1 - (producer.tax ?? .02)), 6);
    expect(producer.listings).toHaveLength(0); expect(qty(producer.storage[buyer], 'dense_alloy')).toBe(12);
    const haul = sim.newGroup(buyer, '구입 소재 운송'), carrier = sim.spawnShip(buyer, 'hauler', 'std', haul.id, producer.pos);
    expect(sim.command(buyer, { c: 'putRoute', group: haul.id, config: { name: '구매 소재', from: producer.id, to: buyerSite.id, item: 'dense_alloy', amount: 12, mode: 'transfer', repeat: false } })).toBeNull();
    until(sim, 'buyer takes delivery', () => qty(buyerSite.storage[buyer], 'dense_alloy') === 12, 2000);
    expect(qty(producer.storage[buyer], 'dense_alloy')).toBe(0); expect(qty(carrier.cargo, 'dense_alloy')).toBe(0);
    expect(sim.command(buyer, { c: 'prodOrder', station: buyerSite.id, recipe: 'mod_armor2', mode: 'count', n: 1 })).toBeNull();
    until(sim, 'buyer makes armor', () => qty(buyerSite.storage[buyer], 'mod_armor2') === 1, 3000);
    expect(qty(buyerSite.storage[buyer], 'dense_alloy')).toBe(8);
    expect(sim.st.companies[buyer].stats.mined).toBe(0);
  }, 60_000);

  it('physically supplies Shard crystals, makes optics and a lance, and uses that fitting in battle', () => {
    let sim = WorldSim.create(979); quiet(sim); (sim as any).npcs = () => {};
    const p = sim.addPlayer('공명 결정 시험'), co = sim.st.companies[p];
    co.credits = 1e7; co.tech = ['rare_processing', 'particle_lance'];
    const station = factory(sim, p, ['rare_refinery', 'weapons_factory', 'fitting']);
    Object.assign(station.storage[p], { silicon: 12, crystal: 20, weapon_parts: 8, electronics: 12, rare_metal: 6, singular_alloy: 2 });
    const field = sim.st.fields.p97_shard_resonance; field.regen = 0;
    const miners = sim.newGroup(p, '파편 채굴'), miner = sim.spawnShip(p, 'miner', 'std', miners.id, field.pos);
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: field.id, deliver: 'drakeout', sell: false } })).toBeNull();
    until(sim, 'Shard mining and intersystem delivery', () => qty(sim.st.stations.drakeout.storage[p], 'resonant_crystal') >= 30, 6000);
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'idle' } })).toBeNull();
    expect(sim.command(p, { c: 'prodOrder', station: station.id, recipe: 'resonant_optics', mode: 'count', n: 1 })).toBeNull();
    expect(station.orders![0].why).toContain('공명 결정');
    const freight = sim.newGroup(p, '공명 결정 운송'); sim.spawnShip(p, 'hauler', 'std', freight.id, sim.st.stations.drakeout.pos);
    expect(sim.command(p, { c: 'putRoute', group: freight.id, config: { name: '공명 결정 공급', from: 'drakeout', to: station.id, item: 'resonant_crystal', amount: 30, mode: 'transfer', repeat: false } })).toBeNull();
    until(sim, 'optics refining', () => qty(sim.st.stations[station.id].storage[p], 'resonant_optics') === 8, 6000);
    expect(sim.command(p, { c: 'prodOrder', station: station.id, recipe: 'eq_lance', mode: 'count', n: 1 })).toBeNull();
    expect(station.jobs!.some(j => j.recipe === 'eq_lance')).toBe(true);
    expect(qty(station.storage[p], 'resonant_optics')).toBe(2);
    sim.tick(1200);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); quiet(sim); (sim as any).npcs = () => {};
    const restored = sim.st.stations[station.id], job = restored.jobs!.find(j => j.recipe === 'eq_lance')!;
    expect(job.left).toBeGreaterThan(0); expect(job.left).toBeLessThan(job.total);
    sim.tick(job.left / prodSpeed(restored, sim.st.companies[p]) + 1);
    expect(qty(restored.storage[p], 'eq_lance')).toBe(1);
    expect(qty(restored.storage[p], 'singular_alloy')).toBe(0);
    const fleet = sim.newGroup(p, '입자 창 피팅'), ship = sim.spawnShip(p, 'battlecruiser', 'std', fleet.id, restored.pos);
    expect((sim as any).dockShip(ship, restored)).toBe(true);
    expect(sim.command(p, { c: 'fit', ship: ship.id, variant: ship.variant!, hp: { hp01: 'eq_lance' }, bay: {} })).toBeNull();
    expect(qty(restored.storage[p], 'eq_lance')).toBe(0);
    expect(sim.fittingSpec(ship)!.mounts.some(m => m.weapon === 'particle_lance')).toBe(true);
    const blue = defaultPlayerFleet(); blue.root.children = []; blue.root.ships = [{ classId: ship.classId, loadoutId: ship.loadoutId, fit: sim.fittingSpec(ship), fx: sim.shipFxOf(ship) }];
    const battle = new World({ seed: 979, scenarioId: 'kestrel', fleets: [blue, getScenario('kestrel').enemy] });
    expect(battle.ships.some(s => s.team === 0 && s.mounts.some(m => m.weapon.id === 'particle_lance'))).toBe(true);
    for (let i = 0; i < 30 && !battle.outcome; i++) battle.step();
    expect(battle.tick).toBeGreaterThan(0);
  }, 60_000);
});
