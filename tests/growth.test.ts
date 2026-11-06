// Growth P3 / P4 / P6 (contentV 3): independent hulls, upkeep + arrears, finite markets, blueprints,
// ship stock and the player ship market. Assets are never created, lost or duplicated.
import { describe, it, expect, vi } from 'vitest';
// several tests simulate hours of world time: allow for slow or loaded machines
vi.setConfig({ testTimeout: 300_000 });
import { WorldSim } from '../src/world/sim';
import type { WorldState, Station, WShip } from '../src/world/types';
import { qty } from '../src/world/types';
import { census, compareCensus, CONTENT_VERSION } from '../src/world/migrate';
import { CONTENT } from '../src/content/registry';
import { shipLoadout } from '../src/world/fitting';
import { buildNeeds } from '../src/world/production';
import { hullEcon, hullSale, yardHulls, econOf, GROWTH_V } from '../src/world/hullops';
import { STARTER_BLUEPRINTS } from '../src/content/packs/growth/blueprints';
import { departureHeld, forecast, overheadMul, STAGE_AT } from '../src/world/upkeep';
import { priceOf } from '../src/world/market';
import { ECON } from '../src/world/data';

const run = (sim: WorldSim, seconds: number, dt = 0.5, each?: () => void) => { for (let t = 0; t < seconds; t += dt) { sim.update(dt); each?.(); } };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const ownedShips = (sim: WorldSim, p: string) => Object.values(sim.st.ships).filter(s => s.owner === p);
const give = (own: Station, ...kinds: string[]) => { for (const k of kinds) own.modules.push({ kind: k, progress: 1, built: true, slot: own.modules.length + 1 }); };

function world(seed = 61) {
  const sim = WorldSim.create(seed); calm(sim);
  const p = sim.addPlayer('성장 시험');
  const co = sim.st.companies[p]; co.credits = 3_000_000; co.rep = 1000;
  return { sim, p, co };
}
function withStation(seed = 62) {
  const { sim, p, co } = world(seed);
  sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' });
  const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
  const a = sim.st.stations.astra.pos;
  sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '시험 기지' } });
  run(sim, 200);
  const own = Object.values(sim.st.stations).find(s => s.owner === p) as Station;
  expect(own.modules.find(m => m.kind === 'core')!.built).toBe(true);
  return { sim, p, co, own };
}
/** a c2 save as production would have it after the P2 migration: the c3 fields stripped */
function c2Save() {
  const { sim, p } = world(63);
  for (const [classId, loadoutId] of [['destroyer', 'gun'], ['miner', 'std'], ['cruiser', 'missile']] as const) expect(sim.command(p, { c: 'buyShip', station: 'helios', classId, loadoutId })).toBeNull();
  run(sim, 120);
  const st: WorldState = JSON.parse(sim.serialize());
  st.contentV = 2; st.grants = (st.grants ?? []).filter(g => g.v < 3); delete st.uniques;
  for (const co of Object.values(st.companies)) { delete co.blueprints; delete co.upkeep; }
  for (const x of Object.values(st.stations)) { delete x.funds; delete x.fundsMax; delete x.shipStock; delete x.shipListings; }
  for (const s of Object.values(st.ships)) { delete s.wear; delete s.reserve; delete s.listed; }
  return { st, p };
}

describe('growth: c2 → c3 save migration', () => {
  it('grants blueprints for existing build rights, seeds budgets and stock, conserves every asset, round-trips', () => {
    const { st, p } = c2Save();
    const before = census(st);
    const sim = new WorldSim(clone(st), { migrateContent: true });
    const rep = sim.contentReport!;
    expect(rep.from).toBe(2); expect(rep.to).toBe(CONTENT_VERSION); expect(CONTENT_VERSION).toBe(GROWTH_V);
    expect(compareCensus(before, census(sim.st))).toEqual([]);                     // nothing lost or duplicated
    expect(Object.keys(sim.st.ships).sort()).toEqual(Object.keys(st.ships).sort()); // every ship kept
    for (const s of Object.values(sim.st.ships)) { expect(s.hull).toBe(st.ships[s.id].hull); expect(s.fitting).toEqual(st.ships[s.id].fitting); }
    const co = sim.st.companies[p];
    for (const b of STARTER_BLUEPRINTS) expect(co.blueprints?.[b], b).toBeTruthy();
    expect(rep.granted.every(g => g.v === 3 && g.item.startsWith('blueprint:'))).toBe(true);
    expect(co.credits).toBe(st.companies[p].credits);                            // no money created
    for (const x of Object.values(sim.st.stations)) if (x.public && x.market) expect(x.funds).toBeGreaterThan(0);
    expect(sim.st.stations.helios.shipStock?.destroyer_vls?.n).toBe(hullSale('destroyer_vls')!.stock);
    // idempotent and round-trips
    const s1 = sim.serialize();
    const again = new WorldSim(JSON.parse(s1), { migrateContent: true });
    expect(again.contentReport!.granted).toEqual([]);
    expect(again.serialize()).toBe(s1);
  });

  it('without the flag a c2 save stays c2: no blueprints, no upkeep, legacy commands', () => {
    const { st, p } = c2Save();
    const sim = new WorldSim(clone(st), { migrateContent: false });
    expect(sim.st.contentV).toBe(2);
    expect(sim.st.companies[p].blueprints).toBeUndefined();
    const cr = sim.st.companies[p].credits;
    run(sim, 600);
    expect(sim.st.companies[p].upkeep).toBeUndefined();
    expect(sim.st.companies[p].credits).toBeGreaterThanOrEqual(cr - 1e-6);     // no running costs before c3
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'frigate', loadoutId: 'aa' })).toBeNull(); // legacy path, no stock
    expect(sim.command(p, { c: 'buyBlueprint', station: 'helios', blueprint: 'bp_frigate_mk1' })).toMatch(/설계도 시스템/);
  });
});

describe('growth: hulls and variants (P3)', () => {
  it('every growth hull is its own hull: own silhouette, a standard variant, presets that fit; mk1 hulls are unchanged', () => {
    const growth = Object.values(CONTENT.hulls).filter(h => !h.id.endsWith('_mk1'));
    expect(growth.length).toBeGreaterThanOrEqual(13);
    expect(new Set(growth.map(h => h.mesh.base)).size).toBe(growth.length);      // no shared silhouettes
    for (const h of growth) {
      expect(CONTENT.variants[`${h.id}_std`]?.hull, h.id).toBe(h.id);
      expect(Object.values(CONTENT.presets).some(x => x.hull === h.id), h.id).toBe(true);
    }
    const dd = growth.filter(h => h.classId === 'destroyer').map(h => h.id).sort();
    expect(dd).toEqual(['destroyer_fast', 'destroyer_heavy', 'destroyer_picket', 'destroyer_vls']);
    for (const cls of ['miner', 'hauler', 'constructor']) expect(new Set(Object.values(CONTENT.hulls).filter(h => h.classId === cls).map(h => h.size)).size, cls).toBeGreaterThanOrEqual(3);
    // mk1 hulls keep the legacy economy exactly
    for (const c of ['miner', 'hauler', 'constructor', 'destroyer', 'battleship']) expect(hullEcon(`${c}_mk1`)).toMatchObject({ cargo: ECON[c].cargo, mine: ECON[c].mine, cruise: ECON[c].cruise, price: ECON[c].price });
  });

  it('a growth ship maps to its hull + variant: stats multipliers and mesh reach the battle loadout', () => {
    const { sim, p } = world(64);
    expect(sim.command(p, { c: 'buyShip', station: 'bastion', classId: 'destroyer', loadoutId: 'gun', hull: 'destroyer_heavy' })).toBeNull();
    const s = ownedShips(sim, p).find(x => x.hull === 'destroyer_heavy')!;
    expect(s.variant).toBe('destroyer_heavy_std');
    expect(s.fitting?.preset).toBeTruthy();
    const lo = shipLoadout(s);
    expect(lo.mesh).toEqual({ base: 'dd_heavy', scale: 1.1 });
    expect(lo.hpMul).toBeCloseTo(CONTENT.hulls.destroyer_heavy.stats!.hpMul!, 6);
    expect(econOf(s).cruise).toBe(CONTENT.hulls.destroyer_heavy.ops!.cruise);
    const mk1 = ownedShips(sim, p).find(x => x.hull === 'corvette_mk1' || x.hull === 'miner_mk1')!;
    expect(shipLoadout(mk1).mesh).toBeUndefined();
  });

  it('large industrial hulls do not dominate: lower efficiency on small fields, big berths, higher cost per throughput', () => {
    const S = hullEcon('miner_mk1'), M = hullEcon('miner_m'), L = hullEcon('miner_l'), XL = hullEcon('miner_xl');
    expect(M.mine).toBeGreaterThan(S.mine); expect(XL.mine).toBeGreaterThan(L.mine);
    const perRate = (id: string) => hullSale(id)!.price / hullEcon(id).mine;
    expect(perRate('miner_xl')).toBeGreaterThan(perRate('miner_mk1'));
    expect(L.berth).toBe('L'); expect(XL.berth).toBe('XL');
    expect(hullEcon('miner_l').minField).toBeGreaterThan(0);
    // an L hull cannot unload at an M-berth station
    const { sim, p } = world(65);
    expect(sim.command(p, { c: 'buyShip', station: 'barcaco', classId: 'miner', loadoutId: 'std', hull: 'miner_l' })).toBeNull();
    const g = Object.values(sim.st.groups).find(x => x.owner === p && x.shipIds.some(id => sim.st.ships[id].hull === 'miner_l'))!;
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: 'rustport', sell: true } })).toMatch(/정박|수용|L급/);
  });
});

describe('growth: ship stock and the player ship market (P6)', () => {
  it('public yards sell from real stock: no duplication, the last unit goes to one buyer only, restock uses materials', () => {
    const { sim, p } = world(66);
    const q = sim.addPlayer('경쟁사'); Object.assign(sim.st.companies[q], { credits: 3_000_000, rep: 1000 });
    const helios = sim.st.stations.helios;
    expect(yardHulls(helios)).toContain('destroyer_vls');
    const n0 = helios.shipStock!.destroyer_vls.n; expect(n0).toBe(2);
    const ships0 = Object.keys(sim.st.ships).length;
    const cr = sim.st.companies[p].credits;
    const price1 = sim.shipPrice(helios, 'destroyer_vls');
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'destroyer', loadoutId: 'gun', hull: 'destroyer_vls' })).toBeNull();
    expect(sim.st.companies[p].credits).toBe(cr - price1);
    expect(sim.shipPrice(helios, 'destroyer_vls')).toBeGreaterThan(price1);    // scarcer, dearer
    // the same tick: both want the last one
    const r1 = sim.command(p, { c: 'buyShip', station: 'helios', classId: 'destroyer', loadoutId: 'gun', hull: 'destroyer_vls' });
    const r2 = sim.command(q, { c: 'buyShip', station: 'helios', classId: 'destroyer', loadoutId: 'gun', hull: 'destroyer_vls' });
    expect(r1).toBeNull(); expect(r2).toMatch(/재고 없음/);
    expect(helios.shipStock!.destroyer_vls.n).toBe(0);
    expect(Object.keys(sim.st.ships).length).toBe(ships0 + 2);
    expect(ownedShips(sim, q).filter(s => s.hull === 'destroyer_vls').length).toBe(0);
    // special variants are never sold by NPC yards
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'destroyer', loadoutId: 'gun', hull: 'destroyer_vls', preset: 'dd_vls_ext_salvo' })).toMatch(/표준 구조|프리셋/);
    // restock takes regional alloy; with no alloy nothing is produced
    const alloy = helios.market!.alloy.stock;
    helios.market!.alloy.stock = 0;
    const tgt = helios.market!.alloy.target; helios.market!.alloy.target = 0;
    run(sim, hullSale('destroyer_vls')!.restock * 2, 2, () => { helios.market!.alloy.stock = 0; });
    helios.market!.alloy.target = tgt;
    expect(helios.shipStock!.destroyer_vls.n).toBe(0);
    expect(helios.shipStock!.destroyer_vls.why).toMatch(/자재 부족/);
    helios.market!.alloy.stock = alloy + 1000;
    run(sim, 30, 2);
    expect(helios.shipStock!.destroyer_vls.n).toBe(1);
    expect(helios.market!.alloy.stock).toBeLessThan(alloy + 1000);
  });

  it('a player-built ship sold on the exchange: ownership and equipment move, the buyer needs no blueprint or research', () => {
    const { sim, p } = world(67);
    const q = sim.addPlayer('구매사'); Object.assign(sim.st.companies[q], { credits: 500_000 });
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'destroyer', loadoutId: 'gun', hull: 'destroyer_vls' })).toBeNull();
    const s = ownedShips(sim, p).find(x => x.hull === 'destroyer_vls')!;
    run(sim, 2);
    const before = census(JSON.parse(sim.serialize()));
    const fit = clone(s.fitting);
    expect(sim.command(p, { c: 'listShip', ship: s.id, price: 15000 })).toBeNull();
    expect(departureHeld(sim.st, s)).toMatch(/매물/);
    expect(sim.command(p, { c: 'listShip', ship: s.id, price: 15000 })).toMatch(/이미/);
    const l = sim.st.stations.helios.shipListings![0];
    expect(sim.command(p, { c: 'buyShipListing', station: 'helios', listing: l.id })).toMatch(/자기 매물/);
    expect(sim.st.companies[q].blueprints?.bp_destroyer_vls).toBeUndefined();
    expect(sim.st.companies[q].tech).not.toContain('guided_missiles');
    const crP = sim.st.companies[p].credits, crQ = sim.st.companies[q].credits;
    expect(sim.command(q, { c: 'buyShipListing', station: 'helios', listing: l.id })).toBeNull();
    expect(s.owner).toBe(q); expect(s.listed).toBeUndefined(); expect(s.fitting).toEqual(fit);
    expect(sim.st.groups[s.groupId].owner).toBe(q);
    expect(sim.st.companies[q].credits).toBe(crQ - 15000);
    expect(sim.st.companies[p].credits).toBeCloseTo(crP + 15000 * (1 - (sim.st.stations.helios.tax ?? 0.02)), 6);
    // equipment moved, not copied (credits differ only by the broker tax, a sink)
    expect(compareCensus(before, census(JSON.parse(sim.serialize()))).filter(x => !x.startsWith('credits'))).toEqual([]);
    // a second purchase of the same listing fails, nothing duplicated
    expect(sim.command(q, { c: 'buyShipListing', station: 'helios', listing: l.id })).toMatch(/팔렸거나/);
    // the buyer can sail it
    expect(departureHeld(sim.st, s)).toBeNull();
  });
});

describe('growth: blueprints and own builds (P6)', () => {
  it('own builds check blueprint, research, yard, facilities and materials; the launched ship carries the preset', () => {
    const { sim, p, co, own } = withStation(68);
    give(own, 'power', 'yard_s', 'yard_m');
    const cmd = { c: 'buildShip', station: own.id, classId: 'destroyer', loadoutId: 'gun', hull: 'destroyer_vls', preset: 'dd_vls_salvo' } as const;
    expect(sim.command(p, cmd)).toMatch(/설계도 필요/);
    co.blueprints!.bp_destroyer_vls = { src: 'test', t: 0 };
    expect(sim.command(p, cmd)).toMatch(/연구 필요/);
    co.tech!.push('guided_missiles');
    expect(sim.command(p, cmd)).toMatch(/필요 시설/);
    give(own, 'electronics_fab');
    expect(sim.command(p, cmd)).toBeNull();
    const b = own.builds!.at(-1)!;
    expect(b.hull).toBe('destroyer_vls'); expect(b.preset).toBe('dd_vls_salvo');
    const need = buildNeeds(b.classId, b.loadoutId, b.fit, b);
    for (const [k, n] of Object.entries(need)) own.storage[p][k] = (own.storage[p][k] ?? 0) + n;
    const n0 = ownedShips(sim, p).length;
    run(sim, b.total + 120, 2);
    expect(own.builds!.length).toBe(0);
    const s = ownedShips(sim, p).find(x => x.hull === 'destroyer_vls')!;
    expect(ownedShips(sim, p).length).toBe(n0 + 1);
    expect(s.fitting!.hp).toEqual(CONTENT.presets.dd_vls_salvo.weapons);
    for (const k of Object.keys(need)) if (!k.startsWith('eq_')) expect(qty(own.storage[p], k), k).toBeLessThan(1e-6); // parts consumed
  });

  it('blueprints are bought with credits from their source; wreck fragments assemble into one; unique ones are limited', () => {
    const { sim, p, co } = world(69);
    const offers = Object.values(CONTENT.blueprints).filter(b => b.sources.some(s => s.kind === 'shop'));
    expect(offers.length).toBeGreaterThan(0);
    const frag = Object.values(CONTENT.blueprints).find(b => b.sources.some(s => s.kind === 'salvage'))!;
    const src = frag.sources.find(s => s.kind === 'salvage') as { kind: 'salvage'; fragments: number };
    expect(sim.command(p, { c: 'assembleBlueprint', station: co.homeStation, blueprint: frag.id })).toMatch(/조각/);
    sim.st.stations[co.homeStation].storage[p][`bpf:${frag.id}`] = src.fragments;
    expect(sim.command(p, { c: 'assembleBlueprint', station: co.homeStation, blueprint: frag.id })).toBeNull();
    expect(co.blueprints![frag.id]).toBeTruthy();
    expect(qty(sim.st.stations[co.homeStation].storage[p], `bpf:${frag.id}`)).toBe(0);
    const uniq = Object.values(CONTENT.blueprints).find(b => b.sources.some(s => s.kind === 'unique'));
    if (uniq) expect((uniq.sources.find(s => s.kind === 'unique') as { limit: number }).limit).toBeGreaterThan(0);
  });
});

describe('growth: upkeep and arrears (P4)', () => {
  function fleet(n: number, seed = 70) {
    const { sim, p, co } = world(seed);
    const g = sim.newGroup(p, '대함대');
    for (let i = 0; i < n; i++) { const s = sim.spawnHull(p, 'corvette_mk1', 'corvette_mk1_std', undefined, g.id, sim.st.stations.astra.pos); (sim as any).dockShip(s, sim.st.stations.astra); }
    return { sim, p, co, g };
  }

  it('overhead grows with fleet size: 2× ships cost more than 2× upkeep, so scale is not free', () => {
    expect(overheadMul(8)).toBe(1); expect(overheadMul(20)).toBeGreaterThan(1); expect(overheadMul(500)).toBeLessThanOrEqual(1.6 + 1e-9);
    const a = fleet(10, 71), b = fleet(30, 72);
    const fa = forecast(a.sim.st, a.co), fb = forecast(b.sim.st, b.co);
    expect(fb.perHour / fb.ships).toBeGreaterThan(fa.perHour / fa.ships);
  });

  it('unpaid upkeep goes through the stages; ships are never deleted, ships in space are never recalled, consent before reserve', () => {
    const { sim, p, co, g } = fleet(24, 73);
    // one squadron is out on patrol in space
    const out = sim.newGroup(p, '초계');
    const sp = ownedShips(sim, p).filter(s => s.classId === 'corvette').slice(0, 3);
    for (const s of sp) (sim as any).moveShipTo(s, out);
    sim.command(p, { c: 'setOp', group: out.id, op: { k: 'patrol', at: sim.st.stations.astra.pos, r: 3000 } as any });
    run(sim, 30);
    co.credits = 0;
    const ids = Object.keys(sim.st.ships).filter(id => sim.st.ships[id].owner === p).sort();
    const fits = Object.fromEntries(ids.map(id => [id, JSON.stringify(sim.st.ships[id].fitting)]));
    const stages: number[] = [];
    run(sim, STAGE_AT[4] + 300, 5, () => { const st = co.upkeep!.stage; if (stages.at(-1) !== st) stages.push(st); });
    expect(stages).toEqual([0, 1, 2, 3, 4]);
    expect(Object.keys(sim.st.ships).filter(id => sim.st.ships[id].owner === p).sort()).toEqual(ids);  // nothing deleted
    for (const id of ids) expect(JSON.stringify(sim.st.ships[id].fitting)).toBe(fits[id]);            // nor stripped
    for (const s of sp) expect(s.state).toBe('space');                                                 // never recalled
    const docked = ownedShips(sim, p).find(s => s.groupId === g.id)!;
    expect(departureHeld(sim.st, docked)).toMatch(/체납/);
    expect(ownedShips(sim, p).some(s => s.reserve)).toBe(false);                                       // no consent, no reserve
    expect(co.credits).toBeGreaterThanOrEqual(0);
    // consent: auto-reserve moves idle docked ships, which then cost 85% less
    expect(sim.command(p, { c: 'autoReserve', on: true })).toBeNull();
    run(sim, 70, 5);
    expect(ownedShips(sim, p).filter(s => s.reserve).length).toBeGreaterThan(0);
    for (const s of sp) expect(s.reserve).toBeUndefined();
    // paying clears the debt and the stage
    co.credits = 10_000_000;
    run(sim, 70, 5);
    expect(co.upkeep!.stage).toBe(0); expect(co.upkeep!.debt).toBe(0);
    expect(departureHeld(sim.st, docked) ?? '').not.toMatch(/체납/);              // a reserve ship stays reserve until reactivated
  });

  it('reserve and reactivation by command', () => {
    const { sim, p, co } = fleet(3, 74);
    const s = ownedShips(sim, p).find(x => x.state === 'docked')!;
    const before = forecast(sim.st, co).credits;
    expect(sim.command(p, { c: 'reserve', ship: s.id, on: true })).toBeNull();
    expect(forecast(sim.st, co).credits).toBeLessThan(before);
    expect(departureHeld(sim.st, s)).toMatch(/예비역/);
    expect(sim.command(p, { c: 'reserve', ship: s.id, on: false })).toBeNull();
    expect(departureHeld(sim.st, s)).toMatch(/재취역/);
    run(sim, 620, 5);
    expect(s.reserve).toBeUndefined();
  });
});

describe('growth: finite market demand and station budgets (P4)', () => {
  it('dumping ore: price falls to the floor, the budget caps payment, the rest stays stored, budgets recover', () => {
    const { sim, p } = world(75);
    const st = sim.st.stations.nova;
    const S = sim.storage(st, p); S.ore = 200_000;
    const p0 = priceOf(st.market!.ore, 'sell', true);
    const f0 = st.funds!;
    sim.command(p, { c: 'sell', station: 'nova', res: 'ore', amount: 200_000 });
    expect(qty(S, 'ore')).toBeGreaterThan(0);                                  // could not all be sold
    expect(st.funds!).toBeLessThan(f0 * 0.05 + 1);
    expect(priceOf(st.market!.ore, 'sell', true)).toBeLessThan(p0 * 0.5);
    expect(sim.command(p, { c: 'sell', station: 'nova', res: 'ore', amount: 1000 })).toMatch(/예산/);
    // the glut is absorbed slowly (finite demand), the budget regenerates
    const stock = st.market!.ore.stock, f1 = st.funds!;
    expect(stock).toBeGreaterThan(st.market!.ore.target);
    run(sim, 60, 5);
    const absorbed = stock - st.market!.ore.stock;
    expect(absorbed).toBeGreaterThan(0);                                         // demand works it off …
    expect(absorbed).toBeLessThan((stock - st.market!.ore.target) * 0.5);        // … but not instantly
    run(sim, 3540, 5);
    expect(st.funds!).toBeGreaterThan(f1 + st.fundsMax! * 0.05);
  });
});

describe('growth: persistence and long automation', () => {
  it('stock, listings, blueprints, upkeep and wear survive a restart exactly', () => {
    const { sim, p } = world(76);
    sim.command(p, { c: 'buyShip', station: 'helios', classId: 'destroyer', loadoutId: 'gun', hull: 'destroyer_vls' });
    const s = ownedShips(sim, p).find(x => x.hull === 'destroyer_vls')!;
    run(sim, 3);
    sim.command(p, { c: 'listShip', ship: s.id, price: 20000 });
    run(sim, 200);
    const a = sim.serialize();
    const b = new WorldSim(JSON.parse(a), { migrateContent: false });
    expect(b.st.contentV).toBe(CONTENT_VERSION);
    expect(b.serialize()).toBe(a);
    run(sim, 300); run(b, 300);
    // continues identically (same state; JSON key order may differ where a field is first set later)
    expect(JSON.parse(b.serialize())).toEqual(JSON.parse(sim.serialize()));
  });

  it('a long unattended mining run stays sane: no negative stock or budgets, no NaN, positive net', () => {
    const { sim, p, co } = world(77);
    co.credits = 20000;
    const miners = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'miner'))!;
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } })).toBeNull();
    const c0 = co.credits;
    run(sim, 4 * 3600, 2);
    expect(Number.isFinite(co.credits)).toBe(true);
    expect(co.credits).toBeGreaterThan(c0);
    for (const x of Object.values(sim.st.stations)) {
      if (x.funds !== undefined) expect(x.funds).toBeGreaterThanOrEqual(0);
      for (const m of Object.values(x.market ?? {})) { expect(Number.isFinite(m.stock)).toBe(true); expect(m.stock).toBeGreaterThanOrEqual(0); }
    }
    for (const s of ownedShips(sim, p)) expect(s.wear ?? 0).toBeLessThan(1);
    expect(co.upkeep!.total.paid).toBeGreaterThan(0);
  });

  it('miners that never dock (a hauler carries their ore) are still maintained: automation is not penalised', () => {
    const { sim, p, co } = world(78);
    co.credits = 20000;
    const home = sim.st.stations[co.homeStation];
    const g = sim.newGroup(p, '채굴반 H');
    const ms = [0, 1, 2].map(() => { const s = sim.spawnHull(p, 'miner_mk1', 'miner_mk1_std', undefined, g.id, home.pos); (sim as any).dockShip(s, home); return s; });
    const h = sim.spawnHull(p, 'hauler_mk1', 'hauler_mk1_std', undefined, g.id, home.pos); (sim as any).dockShip(h, home);
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } })).toBeNull();
    run(sim, 3 * 3600, 2);
    // wear builds ~0.05/h at the field: unmaintained miners sit near 0.15 here (and reach 1.0 in a day)
    expect(h.wear ?? 0).toBeLessThan(0.05);
    for (const m of ms) expect(m.wear ?? 0, m.id).toBeLessThan(0.05);
    expect(co.upkeep!.total.paid).toBeGreaterThan(0);
  });
});
