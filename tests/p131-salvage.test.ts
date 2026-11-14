// P13.1 physical battlefield wrecks & integrated salvage (salvageV worlds). §15 groups A–E.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, cargoSum, type Station, type V, type WShip, type WGroup } from '../src/world/types';
import { makeWrecks, expireWrecks, wreckFor, wreckUnits, type WreckSite } from '../src/world/wrecks';
import { salvageHold, salvageRate, protectedLot } from '../src/world/salvage';
import { haulerAvailability } from '../src/world/haulers';
import { legacyView } from '../src/server/sync';
import { observeWorld } from '../src/world/observe';
import { fittingItems } from '../src/world/fitting';
import { EQUIPMENT, loadoutEquipment } from '../src/world/industry';
import { getLoadout } from '../src/sim/data/ships';
import { BBEX_CLASS } from '../src/sim/bbex/data';
import { enableSalvageP131 } from '../src/world/salvageMigrate';

function fixture(seed = 131) {
  const sim = WorldSim.create(seed, { salvage: 'p131' });
  const [A, B, C] = ['군사 PMC', '수송 PMC', '인양 PMC'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e7;
  const a = sim.st.stations.astra;
  const home: Station = { ...structuredClone(a), id: 'p131_home', name: 'C 인양 기지', public: false, owner: C, pos: { ...a.pos, x: a.pos.x + 1500 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [C]: {} },
    modules: ['core', 'power', 'warehouse', 'warehouse', 'logistics', 'dock', 'dock'].map((kind, i) => ({ id: `ph_${kind}${i}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] };
  sim.st.stations[home.id] = home;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, C, a, home, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: string[], commander = true): WGroup {
  const g = f.sim.newGroup(owner, `${f.sim.st.companies[owner].name} 편대`);
  if (commander) g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => f.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .5) sim.update(.5); };
const until = (sim: WorldSim, cond: () => boolean, seconds = 1500) => { for (let t = 0; t < seconds && !cond(); t += .5) sim.update(.5); return cond(); };
/** a wreck made the real way: ships really fitted and loaded, built by the same function the battle end calls */
function wreckOf(f: F, list: WShip[], at: V, eng = 'e_test'): WreckSite {
  const made = makeWrecks(f.sim.st, eng, list.map(ship => ({ ship, pos: at })), f.sim.time, () => f.sim.rng.next(), [...new Set(list.map(s => s.owner))]);
  for (const s of list) { const g = f.sim.st.groups[s.groupId]; if (g) g.shipIds = g.shipIds.filter(x => x !== s.id); delete f.sim.st.ships[s.id]; }
  return made[0];
}
const held = (f: F, co: string, item: string) => Object.values(f.sim.st.ships).filter(s => s.owner === co).reduce((n, s) => n + qty(s.cargo, item), 0)
  + Object.values(f.sim.st.stations).reduce((n, st) => n + qty(st.storage[co], item), 0);
const lotN = (w: WreckSite | undefined, k: string, item: string, owner?: string) => (w?.lots ?? []).filter(l => l.k === k && l.item === item && (!owner || l.owner === owner)).reduce((n, l) => n + l.n, 0);


const fittedOf = (s: WShip): Record<string, number> => s.fitting ? fittingItems(s.fitting) : loadoutEquipment(getLoadout(s.classId, s.loadoutId).mounts);
const totalLeft = (w?: WreckSite) => (w?.lots ?? []).reduce((n, l) => n + l.n, 0);
const takenBy = (w: WreckSite, co: string) => Object.values(w.taken[co] ?? {}).reduce((a, n) => a + n, 0);
function flows(f: F) { const out: Record<string, number> = {}; const stop = observeWorld(f.sim.st, e => { if (!e.item) return; const k = `${e.kind}/${e.reason ?? ''}/${e.item}`; out[k] = (out[k] ?? 0) + e.amount; }); return { out, stop }; }
/** a real P11 fight: A attacks B's escorted hauler until the hauler is sunk */
function sinkHauler(f: F, cargo: Record<string, number>) {
  const gb = fleet(f, f.B, f.at(4000, 2500), ['hauler', 'corvette']);
  const [h] = ships(f, gb); Object.assign(h.cargo, cargo); h.logisticsExcluded = true; h.hp = 0.3;
  const ga = fleet(f, f.A, f.at(3000, 2500), ['destroyer', 'destroyer', 'destroyer', 'frigate']);
  expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'attack', group: gb.id } })).toBeNull();
  const ok = until(f.sim, () => !f.sim.st.ships[h.id], 2400);
  return { ga, gb, h, ok };
}

describe('P13.1 A — wrecks from real destruction', () => {
  it('A01/A02: opt-in world has no random derelicts; legacy worlds keep theirs and the old path', () => {
    const f = fixture();
    expect(f.sim.st.salvageV).toBe(1); expect(f.sim.st.logisticsV).toBe(1); expect(f.sim.st.opsV).toBe(1); expect(f.sim.st.combatV).toBe(2);
    expect(f.sim.st.sites).toBeUndefined();
    const legacy = WorldSim.create(131);
    expect(legacy.st.salvageV).toBeUndefined(); expect(legacy.st.wrecks).toBeUndefined();
    expect(Object.keys(legacy.st.sites ?? {}).length).toBeGreaterThan(0);
    const g = fleet(f, f.C, f.at(2000, 0), ['hauler']);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'survey', system: 'astra' } })).toMatch(/유기선|전장 잔해/);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'salvage', site: 'x' } })).toMatch(/유기선|전장 잔해/);
    // the new orders do not exist in legacy worlds
    const lg = legacy.newGroup(legacy.addPlayer('L'), 'L'); legacy.spawnShip(lg.owner, 'hauler', 'std', lg.id, legacy.st.stations.astra.pos);
    expect(legacy.command(lg.owner, { c: 'setOp', group: lg.id, op: { k: 'salvzone', at: legacy.st.stations.astra.pos, radius: 2000 } })).toMatch(/사용할 수 없습니다/);
  });

  it('A03: cargo of a destroyed ship splits exactly into wreck + destroyed (events balance per item)', () => {
    const f = fixture();
    const g = fleet(f, f.B, f.at(3000, 0), ['hauler', 'hauler']);
    const [h1, h2] = ships(f, g); h1.cargo.metal = 300; h1.cargo.electronics = 101; h2.cargo.metal = 77;
    const fl = flows(f);
    const w = wreckOf(f, [h1, h2], f.at(3000, 0)); fl.stop();
    for (const [item, n] of [['metal', 377], ['electronics', 101]] as const) {
      const inWreck = lotN(w, 'cargo', item, f.B), lost = fl.out[`consume/combat_cargo_loss/${item}`] ?? 0;
      expect(inWreck).toBeGreaterThan(0); expect(Number.isInteger(inWreck)).toBe(true);
      expect(inWreck + lost).toBe(n);
      expect(fl.out[`salvage/to_wreck/${item}`]).toBe(inWreck);
    }
  });

  it('A04: equipment comes from the real fit (never more than fitted); hull scrap is shipValue × 2.2; owners and sources kept', () => {
    const f = fixture();
    const g = fleet(f, f.B, f.at(3000, 0), ['destroyer', 'destroyer', 'destroyer', 'destroyer']);
    const fitted: Record<string, number> = {};
    for (const s of ships(f, g)) for (const [k, n] of Object.entries(fittedOf(s))) fitted[k] = (fitted[k] ?? 0) + n;
    const w = wreckOf(f, ships(f, g), f.at(3000, 0));
    for (const l of w.lots.filter(l => l.k === 'equip')) { expect(EQUIPMENT[l.item]).toBeTruthy(); expect(l.n).toBeLessThanOrEqual(fitted[l.item] ?? 0); }
    const hull = w.lots.filter(l => l.k === 'hull').reduce((n, l) => n + l.n, 0);
    expect(hull).toBeLessThanOrEqual(4 * 80 * 2.2); expect(hull).toBeGreaterThan(4 * 80 * 2.2 - 16);
    expect(w.lots.every(l => l.owner === f.B)).toBe(true);
    expect(w.sources).toHaveLength(4); expect(w.sources.every(s => s.owner === f.B && s.classId === 'destroyer')).toBe(true);
    expect(w.lots.some(l => l.k === 'cargo' || l.k === 'frag')).toBe(false);   // warships carry no cargo; fragments only from pirates
    expect(w.expires - w.created).toBe(7200 + 4 * 600);
  });

  it('A05: a real P11 battle leaves a wreck where the hauler died, with its surviving cargo; once per engagement', () => {
    const f = fixture();
    const r = sinkHauler(f, { metal: 200, electronics: 80 });
    expect(r.ok).toBe(true);
    const w = Object.values(f.sim.st.wrecks ?? {}).find(x => x.sources.some(s => s.ship === r.h.id))!;
    expect(w).toBeTruthy();
    expect(w.seen).toEqual(expect.arrayContaining([f.A, f.B]));
    expect(lotN(w, 'cargo', 'metal', f.B) + lotN(w, 'cargo', 'electronics', f.B)).toBeGreaterThan(0);
    expect(lotN(w, 'cargo', 'metal', f.B)).toBeLessThan(200);
    expect(Math.hypot(w.pos.x - r.h.pos.x, w.pos.z - r.h.pos.z)).toBeLessThan(2000);   // the last place the ship was
    expect(f.sim.st.fields && Object.values(f.sim.st.fields).some(x => x.salvage)).toBe(false);   // no legacy debris field
    expect(makeWrecks(f.sim.st, w.eng, [], f.sim.time, Math.random, [])).toEqual([]);
    const n = Object.keys(f.sim.st.wrecks!).length;
    expect(makeWrecks(f.sim.st, w.eng, [{ ship: { ...r.h, id: 'again' }, pos: w.pos }], f.sim.time, Math.random, [])).toEqual([]);
    expect(Object.keys(f.sim.st.wrecks!).length).toBe(n);
  }, 120000);

  it('A06: a large battle becomes at most six wreck fields; every source and owner is preserved', () => {
    const f = fixture();
    const g1 = fleet(f, f.A, f.at(0, 0), Array(60).fill('corvette'), false), g2 = fleet(f, f.B, f.at(0, 0), Array(60).fill('frigate'), false);
    const dead = [...ships(f, g1), ...ships(f, g2)].map((ship, i) => ({ ship, pos: f.at((i % 12) * 900, Math.floor(i / 12) * 900) }));
    const t0 = performance.now();
    const made = makeWrecks(f.sim.st, 'e_big', dead, f.sim.time, () => f.sim.rng.next(), [f.A, f.B]);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(made.length).toBeGreaterThan(1); expect(made.length).toBeLessThanOrEqual(6);
    expect(made.reduce((n, w) => n + w.sources.length, 0)).toBe(120);
    expect(new Set(made.flatMap(w => w.lots.map(l => l.owner)))).toEqual(new Set([f.A, f.B]));
    expect(made.every(w => w.expires - w.created <= 4 * 3600)).toBe(true);
  });

  it('A07/A08: BB-EX and exclusive equipment never enter a wreck; blueprint fragments only from pirate hulls', () => {
    const f = fixture();
    const g = fleet(f, f.B, f.at(3000, 0), ['destroyer'], false);
    const bb = { ...ships(f, g)[0], id: 'bbex_probe', classId: BBEX_CLASS };   // only the server grant may create one
    expect(makeWrecks(f.sim.st, 'e_bb', [{ ship: bb, pos: bb.pos }], 0, Math.random, [f.B])).toEqual([]);
    const ex = Object.keys(EQUIPMENT).find(k => EQUIPMENT[k].exclusive);
    const d = ships(f, g)[0];
    if (ex) { d.fitting = { ...(d.fitting ?? {}), x: ex } as any; }
    const w = makeWrecks(f.sim.st, 'e_ex', [{ ship: d, pos: d.pos }], 0, () => 0, [f.B])[0];   // rng 0: every unit survives
    expect(w.lots.some(l => !!EQUIPMENT[l.item]?.exclusive)).toBe(false);
    expect(w.lots.some(l => l.k === 'frag')).toBe(false);
    const pg = fleet(f, 'pirates', f.at(5000, 0), Array(30).fill('destroyer'), false);
    const pw = makeWrecks(f.sim.st, 'e_pir', ships(f, pg).map(ship => ({ ship, pos: ship.pos })), 0, () => f.sim.rng.next(), [f.A]);
    const frags = pw.flatMap(x => x.lots.filter(l => l.k === 'frag'));
    expect(frags.every(l => l.item.startsWith('bpf:') && l.owner === 'pirates')).toBe(true);
  });
});

describe('P13.1 B — physical salvage engine', () => {
  it('B01: a recover order flies, works and fills the real hold; nothing reaches storage before docking; exact accounting', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['hauler'], false); ships(f, src)[0].cargo.metal = 400;
    const w = wreckOf(f, ships(f, src), f.at(6000, 0));
    const init = totalLeft(w);
    const g = fleet(f, f.C, f.at(2000, 0), ['hauler']);
    w.seen.push(f.C);   // C has looked at it
    // B's cargo is protected (B is not hostile to C): an ordinary order leaves it alone
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } })).toMatch(/회수할 수 있는 물품이 없습니다/);
    // a hostile company's cargo is fair game
    f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } })).toBeNull();
    const h = ships(f, g)[0];
    run(f.sim, 5);
    expect(cargoSum(h.cargo)).toBe(0); expect(totalLeft(w)).toBe(init);   // no teleport
    expect(until(f.sim, () => cargoSum(h.cargo) > 50, 600)).toBe(true);
    expect(qty(f.home.storage[f.C], 'metal')).toBe(0);
    const left = totalLeft(f.sim.st.wrecks?.[w.id]);
    expect(takenBy(w, f.C) + left).toBe(init);
    expect(qty(h.cargo, 'metal')).toBe(w.taken[f.C].metal);
    expect(h.salvaged?.metal).toBe(w.taken[f.C].metal);
  }, 60000);

  it('B02: full hold → dock and unload only salvage → return → continue until the wreck is empty → stand by', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['hauler', 'hauler'], false); for (const s of ships(f, src)) s.cargo.metal = 450;
    f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    const w = wreckOf(f, ships(f, src), f.at(6000, 0));
    const cargoInit = lotN(w, 'cargo', 'metal');
    const g = fleet(f, f.C, f.at(2000, 0), ['hauler']); const h = ships(f, g)[0];
    h.cargo.ore = 100;   // the company's own goods aboard stay aboard
    const cap = salvageHold(f.sim, h);
    expect(cargoInit).toBeGreaterThan(cap - 100);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } })).toBeNull();
    let sawUnload = false, sawReturn = false;
    const done = until(f.sim, () => { const S = g.salv; if (S?.phase === 'unload') sawUnload = true; if (sawUnload && S?.phase === 'return') sawReturn = true; return g.op.k === 'idle'; }, 4000);
    expect(done).toBe(true); expect(sawUnload).toBe(true); expect(sawReturn).toBe(true);
    expect(qty(h.cargo, 'ore')).toBe(100);
    const stored = Object.values(f.sim.st.stations).reduce((n, st) => n + qty(st.storage[f.C], 'metal'), 0);
    expect(stored + qty(h.cargo, 'metal')).toBe(cargoInit);
    expect(lotN(f.sim.st.wrecks?.[w.id], 'cargo', 'metal')).toBe(0);
    expect(f.sim.st.events.some(e => e.company === f.C && /인양 완료/.test(e.text))).toBe(true);
  }, 120000);

  it('B03/B04: what each ship type can do, and salvage_ops is a capability not a multiplier on the loot', () => {
    const f = fixture();
    const g = fleet(f, f.C, f.at(0, 0), ['hauler', 'miner', 'constructor', 'destroyer', 'battleship'], false);
    const [h, m, c, d, b] = ships(f, g);
    const co = f.sim.st.companies[f.C]; co.tech = (co.tech ?? []).filter(t => t !== 'salvage_ops');
    expect([h, m, c, d].map(s => salvageRate(f.sim, s, 'cargo'))).toEqual([8, 4, 5, 2]);
    expect([h, m, c, d].map(s => salvageRate(f.sim, s, 'hull'))).toEqual([0, 5, 3, 0]);
    expect([h, m, c, d].map(s => salvageRate(f.sim, s, 'equip'))).toEqual([0, 0, 0.1, 0.02]);
    expect(salvageHold(f.sim, d)).toBe(8); expect(salvageHold(f.sim, b)).toBe(30);
    d.hp = 0.4; expect(salvageRate(f.sim, d, 'cargo')).toBe(1); d.hp = 1;
    co.tech = [...(co.tech ?? []), 'salvage_ops'];
    expect(salvageRate(f.sim, h, 'cargo')).toBe(12); expect(salvageRate(f.sim, h, 'equip')).toBeCloseTo(0.03); expect(salvageRate(f.sim, d, 'frag')).toBeCloseTo(0.03);
    // the wreck holds the same amount either way: tech changes speed and reach, never quantity
    const s1 = fleet(f, f.B, f.at(9000, 0), ['destroyer'], false); const fixedRng = () => 0.5;
    const w1 = makeWrecks(f.sim.st, 'e1', ships(f, s1).map(ship => ({ ship, pos: ship.pos })), 0, fixedRng, [f.C])[0];
    co.tech = co.tech.filter(t => t !== 'salvage_ops');
    const s2 = fleet(f, f.B, f.at(9000, 0), ['destroyer'], false);
    const w2 = makeWrecks(f.sim.st, 'e2', ships(f, s2).map(ship => ({ ship, pos: ship.pos })), 0, fixedRng, [f.C])[0];
    expect(wreckUnits(w1)).toBe(wreckUnits(w2));
  });

  it('B05: a miner strips hull scrap a warship cannot; a constructor pulls equipment', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(5000, 0), ['destroyer', 'destroyer'], false);
    const w = makeWrecks(f.sim.st, 'e_b5', ships(f, src).map(ship => ({ ship, pos: f.at(5000, 0) })), 0, () => 0.1, [f.C])[0];
    const war = fleet(f, f.C, f.at(4000, 0), ['destroyer']);
    expect(f.sim.command(f.C, { c: 'setOp', group: war.id, op: { k: 'recover', wreck: w.id } })).toBeNull();   // it can take equipment
    const hull0 = w.lots.filter(l => l.k === 'hull').reduce((n, l) => n + l.n, 0);
    run(f.sim, 120);
    expect(w.lots.filter(l => l.k === 'hull').reduce((n, l) => n + l.n, 0)).toBe(hull0);
    const mg = fleet(f, f.C, f.at(4000, 300), ['miner', 'constructor']);
    expect(f.sim.command(f.C, { c: 'setOp', group: mg.id, op: { k: 'recover', wreck: w.id } })).toBeNull();
    run(f.sim, 120);
    expect(w.lots.filter(l => l.k === 'hull').reduce((n, l) => n + l.n, 0)).toBeLessThan(hull0);
    const [mi, ct] = ships(f, mg);
    expect(Object.keys(mi.salvaged ?? {}).every(k => !EQUIPMENT[k])).toBe(true);
    expect(Object.keys(ct.salvaged ?? {}).some(k => !!EQUIPMENT[k]) || Object.keys(war.shipIds.map(id => f.sim.st.ships[id].salvaged ?? {})[0]).some(k => !!EQUIPMENT[k])).toBe(true);
  }, 60000);

  it('B06: bad orders are refused by the server', () => {
    const f = fixture();
    const g = fleet(f, f.C, f.at(0, 0), ['hauler']);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: 'nope' } })).toMatch(/잔해가 없거나/);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'salvzone', at: f.at(0, 0), radius: 100 } })).toMatch(/반경/);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'salvzone', at: { x: 9e7, y: 0, z: 9e7 }, radius: 3000 } })).toMatch(/성계/);
    expect(f.sim.command(f.A, { c: 'setOp', group: g.id, op: { k: 'salvzone', at: f.at(0, 0), radius: 3000 } })).not.toBeNull();   // not A's fleet
    expect(f.sim.command(f.A, { c: 'autoSalvage', group: g.id, on: false })).not.toBeNull();
  });

  it('B07/B08: automatic logistics never takes a salvaging hauler; P12 return beats salvage', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['hauler'], false); ships(f, src)[0].cargo.metal = 300;
    f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    const w = wreckOf(f, ships(f, src), f.at(6000, 0));
    const g = fleet(f, f.C, f.at(2000, 0), ['hauler']); const h = ships(f, g)[0];
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'salvzone', at: w.pos, radius: 3000 } })).toBeNull();
    until(f.sim, () => cargoSum(h.cargo) > 20, 600);
    expect(haulerAvailability(f.sim, h).ok).toBe(false);
    expect(h.logisticsJob).toBeUndefined();
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'return' } })).toBeNull();
    run(f.sim, 2);
    expect(g.salv).toBeUndefined();
    const before = takenBy(w, f.C);
    run(f.sim, 30);
    expect(takenBy(w, f.C)).toBe(before);   // returning, not salvaging
    // once docked by the return order the recovered goods go into storage
    until(f.sim, () => h.state === 'docked', 900);
    run(f.sim, 4);
    expect(Object.values(f.sim.st.stations).reduce((n, st) => n + qty(st.storage[f.C], 'metal'), 0)).toBe(before);
  }, 60000);
});

describe('P13.1 C — on-site automatic and zone salvage', () => {
  it('C01: after a real battle the idle winners pick up what is close and legal, then carry it home', () => {
    const f = fixture();
    const r = sinkHauler(f, { metal: 300, electronics: 120 });
    expect(r.ok).toBe(true);
    // the attack target is gone: stand the fleet down (as a player would after the fight)
    f.sim.command(f.A, { c: 'setOp', group: r.ga.id, op: { k: 'idle' } });
    const w = Object.values(f.sim.st.wrecks!).find(x => x.sources.some(s => s.ship === r.h.id))!;
    const got = until(f.sim, () => takenBy(w, f.A) > 0, 600);
    expect(got).toBe(true);
    // A declared hostility by attacking, so B's cargo is legal for A; A's warships only hold a little
    const holdA = ships(f, r.ga).reduce((n, s) => n + salvageHold(f.sim, s), 0);
    run(f.sim, 700);
    expect(takenBy(w, f.A)).toBeLessThanOrEqual(holdA + 5);
    expect(r.ga.salv?.mode === 'auto' && r.ga.salv.phase !== 'unload' ? false : true).toBe(true);   // gave up within the time limit
  }, 180000);

  it('C02/C03/C04: the toggle, protected cargo and a hostile fleet nearby all stop automatic pickup', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['hauler', 'destroyer'], false); ships(f, src)[0].cargo.metal = 300;
    const w = wreckOf(f, ships(f, src), f.at(6000, 0));
    const g = fleet(f, f.C, f.at(5000, 0), ['destroyer', 'destroyer']);
    // B is neutral to C: its cargo is protected; equipment / hull are free but a destroyer can only pull equipment
    expect(f.sim.command(f.C, { c: 'autoSalvage', group: g.id, on: false })).toBeNull();
    run(f.sim, 60);
    expect(takenBy(w, f.C)).toBe(0); expect(g.salv).toBeUndefined();
    expect(f.sim.command(f.C, { c: 'autoSalvage', group: g.id, on: true })).toBeNull();
    run(f.sim, 200);
    expect(w.taken[f.C]?.metal ?? 0).toBe(0);   // never protected cargo
    // a hostile warship near the wreck: no pickup starts
    const f2 = fixture(); const src2 = fleet(f2, f2.B, f2.at(6000, 0), ['destroyer'], false);
    const w2 = makeWrecks(f2.sim.st, 'e_c4', ships(f2, src2).map(ship => ({ ship, pos: f2.at(6000, 0) })), 0, () => 0.1, [f2.C])[0];
    for (const s of ships(f2, src2)) { delete f2.sim.st.ships[s.id]; } src2.shipIds = [];
    const g2 = fleet(f2, f2.C, f2.at(5000, 0), ['destroyer']);
    f2.sim.command(f2.C, { c: 'stance', target: f2.A, v: -1 });
    fleet(f2, f2.A, f2.at(9500, 0), ['destroyer', 'destroyer']);
    run(f2.sim, 20);
    expect(g2.salv).toBeUndefined(); expect(takenBy(w2, f2.C)).toBe(0);
  }, 120000);

  it('C05: a fleet under a move order does not stop to salvage', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['destroyer'], false);
    const w = makeWrecks(f.sim.st, 'e_c5', ships(f, src).map(ship => ({ ship, pos: f.at(6000, 0) })), 0, () => 0.1, [f.C])[0];
    const g = fleet(f, f.C, f.at(5500, 0), ['destroyer']);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'move', to: f.at(30000, 0) } })).toBeNull();
    run(f.sim, 60);
    expect(takenBy(w, f.C)).toBe(0);
  });

  it('C06/C07: zone salvage chooses wrecks inside the zone, unloads, comes back, waits, and takes new wrecks', () => {
    const f = fixture();
    f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    const mk = (dx: number, eng: string, n: number) => { const s = fleet(f, f.B, f.at(dx, 0), Array(n).fill('hauler'), false); for (const x of ships(f, s)) x.cargo.metal = 450; return wreckOf(f, ships(f, s), f.at(dx, 0), eng); };
    const inside = mk(7000, 'z1', 1), outside = mk(20000, 'z2', 1);
    const g = fleet(f, f.C, f.at(2000, 0), ['hauler', 'hauler']);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'salvzone', at: f.at(7000, 0), radius: 3000 } })).toBeNull();
    expect(until(f.sim, () => g.salv?.phase === 'hold', 3000)).toBe(true);
    expect(lotN(f.sim.st.wrecks?.[inside.id], 'cargo', 'metal')).toBe(0);
    expect(takenBy(outside, f.C)).toBe(0);
    expect(g.op.k).toBe('salvzone');   // a zone order keeps going
    const later = mk(8000, 'z3', 1);
    expect(until(f.sim, () => takenBy(later, f.C) > 0, 600)).toBe(true);
  }, 180000);
});

describe('P13.1 D — ownership, competition, legality, lifetime', () => {
  it('D01: two companies on one wreck never take the same unit (sums are exact)', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['hauler', 'hauler', 'destroyer'], false); for (const s of ships(f, src)) s.cargo.metal = 450;
    f.sim.command(f.A, { c: 'stance', target: f.B, v: -1 }); f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    const w = wreckOf(f, ships(f, src), f.at(6000, 0));
    const init = { ...Object.fromEntries(w.lots.map(l => [l.id, l.n])) }, total = totalLeft(w);
    const ga = fleet(f, f.A, f.at(5500, 0), ['hauler', 'miner']), gc = fleet(f, f.C, f.at(6500, 0), ['hauler', 'constructor']);
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'recover', wreck: w.id } });
    f.sim.command(f.C, { c: 'setOp', group: gc.id, op: { k: 'recover', wreck: w.id } });
    for (let i = 0; i < 20; i++) {
      run(f.sim, 15);
      const cur = f.sim.st.wrecks?.[w.id];
      const left = totalLeft(cur);
      expect(takenBy(w, f.A) + takenBy(w, f.C) + left).toBe(total);
      for (const l of cur?.lots ?? []) { expect(l.n).toBeGreaterThanOrEqual(0); expect(l.n).toBeLessThanOrEqual(init[l.id]); }
    }
    expect(takenBy(w, f.A)).toBeGreaterThan(0); expect(takenBy(w, f.C)).toBeGreaterThan(0);
  }, 120000);

  it('D02/D03: taking a neutral company\'s cargo needs an explicit order; it costs reputation where the law reaches, not in lawless space', () => {
    for (const sec of [100, 0]) {
      const f = fixture();
      for (const sys of Object.values(f.sim.st.systems)) { sys.security = sec; sys.heat = 0; }
      const src = fleet(f, f.B, f.at(6000, 0), ['hauler'], false); ships(f, src)[0].cargo.metal = 300;
      const w = wreckOf(f, ships(f, src), f.at(6000, 0));
      expect(protectedLot(f.sim, f.C, w.lots.find(l => l.k === 'cargo')!)).toBe(true);
      const co = f.sim.st.companies[f.C]; co.rep = 50;
      const g = fleet(f, f.C, f.at(5000, 0), ['hauler']);
      expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id, illegal: true } })).toBeNull();
      until(f.sim, () => (w.taken[f.C]?.metal ?? 0) > 50, 600);
      expect(w.crime?.[f.C]).toBeGreaterThan(0);
      if (sec >= 25) expect(co.rep).toBeLessThan(50); else expect(co.rep).toBe(50);
      expect(f.sim.st.events.some(e => e.company === f.B && /회수하고 있습니다/.test(e.text))).toBe(true);
    }
  }, 120000);

  it('D04/D05: wrecks expire (remainder destroyed, recorded) and exhausted wrecks disappear; fleets stop following them', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(30000, 0), ['destroyer'], false);
    const w = wreckOf(f, ships(f, src), f.at(30000, 0));
    const left = totalLeft(w);
    const g = fleet(f, f.C, f.at(0, 0), ['miner']);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } })).toBeNull();
    const fl = flows(f);
    w.expires = f.sim.time + 3;
    run(f.sim, 6); fl.stop();
    expect(f.sim.st.wrecks?.[w.id]).toBeUndefined();
    const decayed = Object.entries(fl.out).filter(([k]) => k.startsWith('consume/wreck_decay/')).reduce((n, [, v]) => n + v, 0);
    expect(decayed).toBe(left - takenBy(w, f.C));
    run(f.sim, 4);
    expect(g.op.k).toBe('idle'); expect(g.salv).toBeUndefined();
    expect(f.sim.st.events.some(e => e.company === f.C && /인양 완료 — 잔해가 소멸/.test(e.text))).toBe(true);
    // exhausted: removed on the next sweep without waiting for the timer
    const w2 = wreckOf(f, ships(f, fleet(f, f.B, f.at(9000, 0), ['corvette'], false)), f.at(9000, 0), 'e_x');
    for (const l of w2.lots) l.n = 0;
    expect(expireWrecks(f.sim.st, f.sim.time).map(x => x.id)).toContain(w2.id);
  }, 60000);

  it('D06/D07/D08: viewers see a wreck\'s contents only after seeing it; owners and takers are recorded', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['hauler'], false); ships(f, src)[0].cargo.metal = 100;
    const w = wreckOf(f, ships(f, src), f.at(6000, 0));
    expect(w.seen).toEqual([f.B]);
    const pub = wreckFor(w, f.C) as any;
    expect(pub.lots).toBeUndefined(); expect(pub.left).toBeUndefined(); expect(pub.size).toBeGreaterThan(0);
    const own = wreckFor(w, f.B) as any;
    expect(own.lots.length).toBeGreaterThan(0); expect(own.sources[0].owner).toBe(f.B);
    fleet(f, f.C, f.at(5000, 0), ['corvette']);
    run(f.sim, 2);
    expect(w.seen).toContain(f.C);
    expect(w.lots.every(l => l.owner === f.B)).toBe(true);
  });
});

describe('P13.1 E — saves, sync, legacy, conversion', () => {
  it('E01: a salvage operation survives save / restore with the same accounting', () => {
    const f = fixture();
    f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    const src = fleet(f, f.B, f.at(6000, 0), ['hauler', 'hauler'], false); for (const s of ships(f, src)) s.cargo.metal = 450;
    const w = wreckOf(f, ships(f, src), f.at(6000, 0)); const total = totalLeft(w);
    const g = fleet(f, f.C, f.at(5000, 0), ['hauler']);
    f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } });
    until(f.sim, () => takenBy(w, f.C) > 30, 600);
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    const w2 = copy.st.wrecks![w.id], g2 = copy.st.groups[g.id];
    expect(g2.salv?.mode).toBe('recover'); expect(takenBy(w2, f.C) + totalLeft(w2)).toBe(total);
    for (let t = 0; t < 120; t += .5) copy.update(.5);
    expect(takenBy(w2, f.C)).toBeGreaterThan(takenBy(w, f.C));
    expect(takenBy(w2, f.C) + totalLeft(copy.st.wrecks?.[w.id])).toBe(total);
  }, 60000);

  it('E02: sync sends wrecks, hides other companies\' salvage state and recovered cargo', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['hauler'], false); ships(f, src)[0].cargo.metal = 300;
    f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    const w = wreckOf(f, ships(f, src), f.at(6000, 0));
    const g = fleet(f, f.C, f.at(5800, 0), ['hauler']);
    f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } });
    until(f.sim, () => takenBy(w, f.C) > 0, 300);
    const sysId = f.sim.sysOf(w.pos)!.id;
    const mine = JSON.parse(JSON.stringify(legacyView(f.sim.st, { company: f.C }, sysId))) as any;
    const theirs = JSON.parse(JSON.stringify(legacyView(f.sim.st, { company: f.A }, sysId))) as any;
    expect(mine.wrecks[w.id].lots.length).toBeGreaterThan(0); expect(mine.wrecks[w.id].taken[f.C]).toBeTruthy();
    expect(theirs.wrecks[w.id].lots).toBeUndefined();
    expect(mine.groups[g.id].salv).toBeTruthy(); expect(theirs.groups[g.id].salv).toBeUndefined();
    expect(mine.ships[g.shipIds[0]].salvaged).toBeTruthy(); expect(theirs.ships[g.shipIds[0]]?.salvaged).toBeUndefined();
  }, 60000);

  it('E03: NPC fleets do not salvage on their own (player fleets only until P14)', () => {
    const f = fixture();
    const src = fleet(f, f.B, f.at(6000, 0), ['destroyer'], false);
    const w = makeWrecks(f.sim.st, 'e_e3', ships(f, src).map(ship => ({ ship, pos: f.at(6000, 0) })), 0, () => 0.1, [f.C])[0];
    for (const s of ships(f, src)) delete f.sim.st.ships[s.id]; src.shipIds = [];
    const u = fleet(f, 'union', f.at(5800, 0), ['destroyer', 'miner'], false);
    run(f.sim, 60);
    expect(w.taken.union).toBeUndefined(); expect(u.salv).toBeUndefined();
  });

  it('E04: converting a legacy save (copy) retires derelicts, keeps goods and pendingLoot, and is idempotent', () => {
    const legacy = WorldSim.create(77, { logistics: 'p125' });
    const p = legacy.addPlayer('구 회사'); const co = legacy.st.companies[p];
    const g = legacy.newGroup(p, '탐사대'); legacy.spawnShip(p, 'hauler', 'std', g.id, legacy.st.stations.astra.pos);
    g.op = { k: 'survey', system: 'astra' };
    for (let t = 0; t < 30; t++) legacy.update(1);
    co.pendingLoot = { [legacy.st.stations.astra.id]: { alloy: 12 } } as any;   // remote recovery still waiting for storage room
    const copy = new WorldSim(JSON.parse(legacy.serialize()), { migrateContent: false });
    const value = (sim: WorldSim) => JSON.stringify([Object.values(sim.st.stations).map(s => s.storage), Object.values(sim.st.companies).map(c => [c.credits, c.blueprints, c.pendingLoot]), Object.values(sim.st.ships).map(s => s.cargo)]);
    const before = value(copy);
    const r = enableSalvageP131(copy);
    expect(r.already).toBe(false); expect(r.sitesRetired).toBeGreaterThan(0);
    expect(r.groupsStopped).toEqual([{ group: g.id, op: 'survey' }]);
    expect(r.pendingLootKept).toEqual([p]);
    expect(copy.st.salvageV).toBe(1); expect(copy.st.sites).toBeUndefined();
    expect(value(copy)).toBe(before);
    expect(enableSalvageP131(copy).already).toBe(true);
    expect(legacy.st.salvageV).toBeUndefined(); expect(legacy.st.sites).toBeTruthy();   // the original is untouched
    for (let t = 0; t < 30; t++) copy.update(1);
  }, 60000);
});
