import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { Station, WGroup } from '../src/world/types';
import { qty, cargoSum } from '../src/world/types';
import { RECIPES, FACILITIES, ITEMS } from '../src/world/industry';
import { stationPower, storageCap } from '../src/world/production';

const run = (sim: WorldSim, seconds: number, dt = 0.25) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };
const groupNamed = (sim: WorldSim, owner: string, name: string) => Object.values(sim.st.groups).find(g => g.owner === owner && g.name === name) as WGroup;

/** a player with an own station whose docking hub is finished */
function base(seed = 21) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('산업사');
  calm(sim);
  sim.st.companies[p].credits = 2_000_000;
  expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' })).toBeNull();
  const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
  const a = sim.st.stations.astra.pos;
  expect(sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '공업 기지' } })).toBeNull();
  run(sim, 200);
  const own = Object.values(sim.st.stations).find(s => s.owner === p) as Station;
  expect(own.modules.find(m => m.kind === 'core')!.built).toBe(true);
  return { sim, p, own, cg };
}
/** instantly finish facilities (tests of production, not construction) */
function give(own: Station, ...kinds: string[]) {
  for (const k of kinds) own.modules.push({ kind: k, progress: 1, built: true, slot: own.modules.length + 1 });
}

describe('industry: multi-tier production', () => {
  it('ore → metal, titanium ore → titanium, metal+titanium → alloy, alloy+metal → structure: exact recipe accounting', () => {
    const { sim, p, own } = base();
    give(own, 'power', 'refinery', 'smelter', 'alloy_plant', 'hull_works');
    const S = own.storage[p];
    for (const k of Object.keys(S)) S[k] = 0;
    S.ore = 400; S.titanium_ore = 90;
    for (const [recipe, n] of [['metal', 10], ['titanium', 3], ['alloy', 2], ['structure', 2]] as const)
      expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe, mode: 'count', n })).toBeNull();
    run(sim, 1200);
    // 10×(ore 40 → metal 20) = 200 metal; 3×(ti_ore 30 → ti 12) = 36 ti; 2×(metal 20 + ti 6 → alloy 22); 2×(alloy 18 + metal 10 → structure 10)
    expect(qty(S, 'ore')).toBe(0);
    expect(qty(S, 'titanium_ore')).toBe(0);
    expect(qty(S, 'structure')).toBe(20);
    expect(qty(S, 'alloy')).toBe(44 - 36);
    expect(qty(S, 'metal')).toBe(200 - 40 - 20);
    expect(qty(S, 'titanium')).toBe(36 - 12);
    expect(own.orders!.length).toBe(0);                   // finished count orders leave the queue
    expect(own.jobs!.length).toBe(0);
  });

  it('an order waits with the exact missing input, then starts on its own when it arrives', () => {
    const { sim, p, own } = base();
    give(own, 'refinery', 'alloy_plant');
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    S.metal = 20;
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'alloy', mode: 'count', n: 1 })).toBeNull();
    run(sim, 5);
    const o = own.orders![0];
    expect(o.why).toMatch(/원료 부족: 티타늄 6/);
    expect(S.metal).toBe(20);                                // nothing consumed while waiting
    S.titanium = 6;
    run(sim, 2);
    expect(own.jobs!.length).toBe(1);
    expect(qty(S, 'metal')).toBe(0); expect(qty(S, 'titanium')).toBe(0);    // inputs taken at start, atomically
    run(sim, 160);                                           // 90 s batch at 20/33 power
    expect(S.alloy).toBe(22);
  });

  it('no facility / research / storage full are reported, never silently ignored', () => {
    const { sim, p, own } = base();
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'metal', mode: 'count', n: 1 })).toMatch(/광석 정제소이\(가\) 없습니다/);
    give(own, 'refinery');
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'metal_eff', mode: 'count', n: 1 })).toMatch(/연구 필요/);
    // fill the warehouse: core = 20,000
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    S.ore = storageCap(own);
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'metal', mode: 'count', n: 1 })).toBeNull();
    // ore 40 → metal 20 frees space, so a full warehouse never deadlocks refining
    run(sim, 1);
    expect(own.jobs!.length).toBe(1);
  });

  it('more instances = more parallel lines; low power slows production', () => {
    const { sim, p, own } = base();
    give(own, 'refinery', 'refinery', 'refinery');
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    S.ore = 4000;
    sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'metal', mode: 'count', n: 30 });
    run(sim, 1);
    expect(own.jobs!.length).toBe(3);
    // 3 refineries draw 45 power against the hub's 20 → 44% speed
    const pw = stationPower(own);
    expect(pw.factor).toBeCloseTo(20 / 45, 5);
    run(sim, 60);
    expect(qty(S, 'metal')).toBe(0);                          // a 60 s batch is not done at 44% speed
    give(own, 'power');
    expect(stationPower(own).factor).toBe(1);
    run(sim, 80);
    expect(qty(S, 'metal')).toBe(3 * 20);
  });

  it('stock-target orders keep a level, pause/resume/reorder/cancel work', () => {
    const { sim, p, own } = base();
    give(own, 'power', 'refinery');
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    S.ore = 10000;
    sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'metal', mode: 'stock', n: 100 });
    run(sim, 600);
    expect(S.metal).toBe(100);
    expect(own.orders![0].why).toMatch(/목표 재고 도달/);
    S.metal = 30; run(sim, 250);
    expect(S.metal).toBeGreaterThanOrEqual(100);
    const id = own.orders![0].id;
    expect(sim.command(p, { c: 'prodOp', station: own.id, order: id, op: 'pause' })).toBeNull();
    S.metal = 0; run(sim, 200);
    expect(qty(S, 'metal')).toBe(0);
    expect(sim.command(p, { c: 'prodOp', station: own.id, order: id, op: 'cancel' })).toBeNull();
    expect(own.orders!.length).toBe(0);
  });

  it('nothing is created or destroyed except by recipes: long mixed run conserves every item', () => {
    const { sim, p, own } = base();
    give(own, 'power', 'power', 'refinery', 'smelter', 'alloy_plant', 'machine_shop', 'hull_works', 'gas_plant');
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    Object.assign(S, { ore: 3000, titanium_ore: 600, silicate: 400, gas: 400 });
    for (const r of ['metal', 'titanium', 'silicon', 'alloy', 'machinery', 'structure', 'chemicals', 'precision']) sim.command(p, { c: 'prodOrder', station: own.id, recipe: r, mode: 'stock', n: 60 });
    // count every recipe batch started; replay the ledger
    const ledger: Record<string, number> = { ore: 3000, titanium_ore: 600, silicate: 400, gas: 400 };
    const seen = new Set<string>();
    for (let t = 0; t < 3000; t += 0.25) {
      sim.update(0.25);
      for (const j of own.jobs!) if (!seen.has(j.id)) { seen.add(j.id); for (const [k, n] of Object.entries(RECIPES[j.recipe].in)) ledger[k] = (ledger[k] ?? 0) - n; for (const [k, n] of Object.entries(RECIPES[j.recipe].out)) ledger[k] = (ledger[k] ?? 0) + n; }
    }
    for (const j of own.jobs!) for (const [k, n] of Object.entries(RECIPES[j.recipe].out)) ledger[k] -= n; // still running
    for (const k of new Set([...Object.keys(ledger), ...Object.keys(S)])) expect(qty(S, k)).toBeCloseTo(ledger[k] ?? 0, 6);
    expect(seen.size).toBeGreaterThan(20);
    expect(qty(S, 'structure')).toBeGreaterThan(0);
    expect(qty(S, 'precision')).toBeGreaterThan(0);
  });

  it('fields yield their mixture; miners deliver several goods', () => {
    const { sim, p, own } = base();
    expect(sim.st.fields.barcaring.mix).toEqual({ ore: 0.5, titanium_ore: 0.3, rare_ore: 0.2 });
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    const miners = groupNamed(sim, p, '제1 채굴반');
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: own.id, sell: false } })).toBeNull();
    run(sim, 900);
    expect(qty(S, 'ore')).toBeGreaterThan(50);
    expect(qty(S, 'silicate')).toBeCloseTo(qty(S, 'ore') / 3, 0);
  });

  it('hauling: one item, everything, and automatic supply of what the destination lacks', () => {
    const { sim, p, own } = base();
    give(own, 'logistics', 'alloy_plant', 'power');
    const astra = sim.st.stations.astra;
    const A = astra.storage[p]; Object.assign(A, { metal: 200, titanium: 60, ore: 500, silicate: 100 });
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'alloy', mode: 'count', n: 3 });
    sim.st.companies[p].credits += 10000;
    expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'hauler', loadoutId: 'std' })).toBeNull();
    const hg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'hauler'))!;
    expect(sim.command(p, { c: 'setOp', group: hg.id, op: { k: 'haul', from: 'astra', to: own.id, res: '*auto' } })).toBeNull();
    run(sim, 900);
    expect(qty(S, 'ore')).toBe(0);                              // auto supply only brings what the orders need
    expect(qty(S, 'silicate')).toBe(0);
    expect(qty(S, 'alloy')).toBe(66);                            // three batches made from hauled inputs
    // everything mode
    expect(sim.command(p, { c: 'setOp', group: hg.id, op: { k: 'haul', from: 'astra', to: own.id, res: '*all' } })).toBeNull();
    run(sim, 900);
    expect(cargoSum(A)).toBeLessThan(1);
    expect(qty(S, 'ore')).toBe(500);
    // auto needs a logistics centre
    own.modules = own.modules.filter(m => m.kind !== 'logistics');
    expect(sim.command(p, { c: 'setOp', group: hg.id, op: { k: 'haul', from: 'astra', to: own.id, res: '*auto' } })).toMatch(/물류센터/);
  });

  it('own warehouse capacity: unloading stops at the limit and keeps the rest aboard', () => {
    const { sim, p, own } = base();
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    S.ore = storageCap(own) - 30;
    const miners = groupNamed(sim, p, '제1 채굴반');
    sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: own.id, sell: false } });
    run(sim, 900);
    expect(cargoSum(S)).toBeLessThanOrEqual(storageCap(own) + 1e-6);
    expect(sim.st.events.some(e => e.company === p && e.tag === 'storage_full')).toBe(true);
  });

  it('public markets trade the new goods; regional production restocks and pirate pressure slows it', () => {
    const sim = WorldSim.create(5);
    const p = sim.addPlayer('상사');
    const nova = sim.st.stations.nova.market!;
    expect(nova.metal).toBeTruthy(); expect(nova.silicon).toBeTruthy();
    expect(sim.st.stations.bastion.market!.weapon_parts).toBeTruthy();
    expect(sim.st.stations.exchange.market!['bp:composites']).toBeTruthy();
    sim.st.companies[p].credits = 1e6;
    expect(sim.command(p, { c: 'buy', station: 'bastion', res: 'weapon_parts', amount: 5 })).toBeNull();
    expect(qty(sim.st.stations.bastion.storage[p], 'weapon_parts')).toBe(5);
    // a producing station refills; the same station under heavy pirate activity refills slower
    const w = sim.st.stations.bastion.market!.weapon_parts; w.stock = 0;
    const a = new WorldSim(JSON.parse(sim.serialize())), b = new WorldSim(JSON.parse(sim.serialize()));
    b.st.systems.astra.heat = 100;
    for (let i = 0; i < 2400; i++) { a.update(0.25); b.update(0.25); b.st.systems.astra.heat = 100; }
    expect(a.st.stations.bastion.market!.weapon_parts.stock).toBeGreaterThan(b.st.stations.bastion.market!.weapon_parts.stock * 1.5);
  });

  it('production state survives a restart exactly; old saves are upgraded in place', () => {
    const { sim, p, own } = base();
    give(own, 'refinery', 'power');
    const S = own.storage[p]; S.ore = 400;
    sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'metal', mode: 'count', n: 5 });
    run(sim, 30);
    const snap = JSON.parse(sim.serialize());
    const sim2 = new WorldSim(snap);
    const o2 = sim2.st.stations[own.id];
    expect(o2.orders).toEqual(own.orders); expect(o2.jobs).toEqual(own.jobs);
    run(sim, 400); run(sim2, 400);
    expect(o2.storage[p]).toEqual(own.storage[p]);
    // legacy save: shipyard/depot kinds and no industry version
    const old = JSON.parse(sim.serialize());
    delete old.industryV;
    old.stations[own.id].modules.push({ kind: 'shipyard', progress: 1, built: true, slot: 20 }, { kind: 'depot', progress: 1, built: true, slot: 21 });
    for (const f of Object.values(old.fields) as any[]) delete f.mix;
    const sim3 = new WorldSim(old);
    const k3 = sim3.st.stations[own.id].modules.map(m => m.kind);
    expect(k3).toContain('yard_s'); expect(k3).toContain('warehouse'); expect(k3).not.toContain('shipyard');
    expect(sim3.st.fields.grey.mix).toBeTruthy();
    for (const m of sim3.st.stations[own.id].modules) expect(FACILITIES[m.kind]).toBeTruthy();
    expect(Object.keys(ITEMS).length).toBeGreaterThanOrEqual(20);
  });

  it('player exchange: escrow, purchase, withdrawal, no duplication under competing buyers', () => {
    const sim = WorldSim.create(8);
    const a = sim.addPlayer('판매사'), b = sim.addPlayer('구매사'), c = sim.addPlayer('경쟁사');
    const st = sim.st.stations.astra;
    st.storage[a].engine = 3;
    for (const x of [a, b, c]) sim.st.companies[x].credits = 100000;
    expect(sim.command(a, { c: 'list', station: 'astra', item: 'engine', qty: 3, price: 2000 })).toBeNull();
    expect(qty(st.storage[a], 'engine')).toBe(0);                    // held in escrow
    const l = st.listings![0];
    expect(sim.command(a, { c: 'buyListing', station: 'astra', listing: l.id, qty: 1 })).toMatch(/자기 매물/);
    expect(sim.command(b, { c: 'buyListing', station: 'astra', listing: l.id, qty: 2 })).toBeNull();
    expect(sim.command(c, { c: 'buyListing', station: 'astra', listing: l.id, qty: 5 })).toBeNull();  // only 1 left
    expect(sim.command(b, { c: 'buyListing', station: 'astra', listing: l.id, qty: 1 })).toMatch(/이미 팔렸/);
    expect(qty(st.storage[b], 'engine') + qty(st.storage[c], 'engine')).toBe(3);
    expect(sim.st.companies[b].credits).toBe(100000 - 4000);
    expect(sim.st.companies[c].credits).toBe(100000 - 2000);
    expect(sim.st.companies[a].credits).toBeCloseTo(100000 + 6000 * (1 - (st.tax ?? 0.02)), 6);
    st.storage[a].metal = 50;
    sim.command(a, { c: 'list', station: 'astra', item: 'metal', qty: 50, price: 30 });
    expect(sim.command(a, { c: 'delist', station: 'astra', listing: st.listings![0].id })).toBeNull();
    expect(qty(st.storage[a], 'metal')).toBe(50);
    expect(sim.command(a, { c: 'list', station: 'astra', item: 'metal', qty: 60, price: 30 })).toMatch(/수량 부족/);
  });
});
