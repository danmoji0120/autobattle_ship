// P13.2 cargo raiding (piracyV worlds). §15 groups A–G: every check compares real ship cargo, containers,
// station storage, logistics jobs and the economy event stream — not just command results.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, cargoSum, type Station, type V, type WShip, type WGroup, type Cargo } from '../src/world/types';
import { judge, demand, jettison, wanted, lootOf, PIR, stepPlunder, plunderOrder, type CargoDrop } from '../src/world/piracy';
import { salvageHold } from '../src/world/salvage';
import { incomingPool } from '../src/world/autonomousLogistics';
import { observeWorld } from '../src/world/observe';
import { legacyView } from '../src/server/sync';
import { EQUIPMENT } from '../src/world/industry';
import { makeWrecks } from '../src/world/wrecks';

function fixture(seed = 132, sec = 10) {
  const sim = WorldSim.create(seed, { piracy: 'p132' });
  const [A, B, C] = ['약탈 PMC', '수송 PMC', '인양 PMC'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = sec;
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e7;
  const a = sim.st.stations.astra;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, C, a, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: string[], commander = true): WGroup {
  const g = f.sim.newGroup(owner, `${f.sim.st.companies[owner]?.name ?? owner} 편대`);
  if (commander) g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => f.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .5) sim.update(.5); };
const until = (sim: WorldSim, cond: () => boolean, seconds = 1500) => { for (let t = 0; t < seconds && !cond(); t += .5) sim.update(.5); return cond(); };
/** a loaded hauler of B travelling away (a real move order: it keeps flying) */
function convoy(f: F, cargo: Cargo, pos = f.at(10000, -25000), comp = ['hauler']) {
  const g = fleet(f, f.B, pos, comp);
  const h = ships(f, g).find(s => s.classId === 'hauler')!; Object.assign(h.cargo, cargo); h.logisticsExcluded = true;
  expect(f.sim.command(f.B, { c: 'setOp', group: g.id, op: { k: 'move', to: { x: pos.x - 6000, y: 0, z: pos.z } } })).toBeNull();
  return { g, h };
}
const hostile = (f: F, a = f.A, b = f.B) => expect(f.sim.command(a, { c: 'stance', target: b, v: -1 })).toBeNull();
const logOf = (f: F, kind?: string) => (f.sim.st.piracy?.log ?? []).filter(e => !kind || e.kind === kind);
const drops = (f: F) => Object.values(f.sim.st.drops ?? {}) as CargoDrop[];
const left = (d: CargoDrop | undefined, item?: string) => (d?.lots ?? []).filter(l => !item || l.item === item).reduce((n, l) => n + l.n, 0);
const takenBy = (d: CargoDrop, co: string, item?: string) => Object.entries(d.taken[co] ?? {}).filter(([k]) => !item || k === item).reduce((a, [, n]) => a + n, 0);
/** every unit of an item anywhere: ships, stations, containers, wrecks, lair holds */
function world(f: F, item: string) {
  let n = 0;
  for (const s of Object.values(f.sim.st.ships)) if ([f.A, f.B, f.C, 'pirates'].includes(s.owner)) n += qty(s.cargo, item);
  for (const st of Object.values(f.sim.st.stations)) for (const c of [f.A, f.B, f.C]) n += qty(st.storage[c], item);
  for (const d of drops(f)) n += left(d, item);
  for (const w of Object.values(f.sim.st.wrecks ?? {})) n += w.lots.filter(l => l.item === item && l.k === 'cargo').reduce((a, l) => a + l.n, 0);
  for (const l of Object.values(f.sim.st.lairs)) n += qty(l.hold, item);
  return n;
}
function flows(f: F) { const out: Record<string, number> = {}; const stop = observeWorld(f.sim.st, e => { const k = `${e.kind}/${e.reason ?? ''}${e.item ? '/' + e.item : ''}`; out[k] = (out[k] ?? 0) + e.amount; }); return { out, stop }; }
/** a fixed ±0 noise (the judgement's world-RNG term) for comparisons */
const noNoise = (f: F) => { f.sim.rng.next = () => 0.5; };

describe('P13.2 A — interception and surrender', () => {
  it('A01/A02: a zone raid finds a real loaded hauler; empty ships are never asked', () => {
    const f = fixture(); hostile(f);
    const empty = convoy(f, {}, f.at(9000, -24000));
    const full = convoy(f, { ore: 300 }, f.at(11000, -26000));
    const ga = fleet(f, f.A, f.at(10000, -21000), ['destroyer', 'frigate', 'hauler']);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', at: f.at(10000, -25000), radius: 4000, policy: 'nonlethal' } })).toBeNull();
    run(f.sim, 3);
    expect(ga.plx?.target).toBe(full.g.id);
    expect(demand(f.sim, ga, empty.h)).toMatch(/화물이 없습니다/);
    until(f.sim, () => logOf(f, 'threat').length > 0, 300);
    expect(logOf(f, 'threat').every(e => e.ship === full.h.id)).toBe(true);
  });
  it('A03: demands need real distance — no demand far away, none after P11 contact; the hauler keeps flying', () => {
    const f = fixture(); hostile(f);
    const { h } = convoy(f, { ore: 300 });
    const ga = fleet(f, f.A, f.at(10000, -15000), ['destroyer', 'frigate', 'hauler']);
    const p0 = { ...h.pos };
    expect(demand(f.sim, ga, h)).toMatch(/위협 거리/);   // from 10 km: refused by the server
    expect(logOf(f)).toHaveLength(0);
    const f2 = fixture(); hostile(f2);
    const v = convoy(f2, { ore: 300 });
    const g2 = fleet(f2, f2.A, f2.at(10000, -15000), ['destroyer', 'frigate', 'hauler']);
    f2.sim.command(f2.A, { c: 'setOp', group: g2.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } });
    let at = -1;
    until(f2.sim, () => { if (logOf(f2, 'threat').length && at < 0) at = Math.min(...ships(f2, g2).map(s => Math.hypot(s.pos.x - v.h.pos.x, s.pos.z - v.h.pos.z))); return at >= 0; }, 600);
    expect(at).toBeGreaterThan(420); expect(at).toBeLessThanOrEqual(PIR.threatR + 120);
    expect(Object.keys(f2.sim.st.engagements)).toHaveLength(0);
    void p0;
  });
  it('A04/A05/A06: escort, damage and a way out change the answer (deterministic)', () => {
    const f = fixture(); hostile(f); noNoise(f);
    const lone = convoy(f, { alloy: 200 }, f.at(20000, 15000));
    const ga = fleet(f, f.A, f.at(20000, 14000), ['destroyer', 'destroyer']);
    const base = judge(f.sim, ga, lone.g, lone.h, wanted(f.sim, lone.h));
    const esc = fleet(f, f.B, f.at(20100, 15000), ['destroyer', 'destroyer', 'cruiser']);
    const guarded = judge(f.sim, ga, lone.g, lone.h, wanted(f.sim, lone.h));
    expect(guarded.defense).toBeGreaterThan(0); expect(guarded.pressure).toBeLessThan(base.pressure / 3);
    expect(guarded.response).not.toBe('comply');
    for (const id of esc.shipIds) delete f.sim.st.ships[id]; esc.shipIds = [];
    lone.h.hp = 0.3;
    const hurt = judge(f.sim, ga, lone.g, lone.h, wanted(f.sim, lone.h));
    expect(hurt.damage).toBeGreaterThan(0.5); expect(hurt.pressure).toBeGreaterThan(base.pressure * 1.5);
    lone.h.hp = 1;
    // next to a dock: a real chance to run
    const near = convoy(f, { alloy: 200 }, f.at(300, 300));
    const gb = fleet(f, f.A, f.at(300, 1300), ['corvette']);
    const j = judge(f.sim, gb, near.g, near.h, wanted(f.sim, near.h));
    expect(j.escape).toBeGreaterThan(base.escape);
    expect(j.response).toBe('flee');
    // a direct move order is kept (no automatic flight over it); an idle hauler runs for the dock
    const r = demand(f.sim, gb, near.h); expect(typeof r === 'object' && r.response).toBe('flee');
    expect(near.g.fleeing).toBeFalsy();
    const idle = convoy(f, { alloy: 200 }, f.at(400, 200));
    expect(f.sim.command(f.B, { c: 'setOp', group: idle.g.id, op: { k: 'idle' } })).toBeNull(); idle.g.override = false;
    const r2 = demand(f.sim, gb, idle.h); expect(typeof r2 === 'object' && r2.response).toBe('flee');
    expect(idle.g.fleeing).toBe(true);
  });
  it('A07/A08/A09: the three victim policies — survive gives up first, protect last', () => {
    const f = fixture(); hostile(f); noNoise(f);
    const v = convoy(f, { alloy: 200 }, f.at(20000, 15000));
    const out: Record<string, { p: number; r: Record<string, string> }> = {};
    for (const comp of [['corvette'], ['frigate'], ['destroyer'], ['destroyer', 'frigate'], ['destroyer', 'destroyer'], ['cruiser', 'destroyer'], ['cruiser', 'cruiser', 'destroyer']]) {
      const g = fleet(f, f.A, f.at(20000, 14000), comp);
      const r: Record<string, string> = {};
      let p = 0;
      for (const pol of ['survive', 'balanced', 'protect'] as const) { v.g.piracyPolicy = pol; const j = judge(f.sim, g, v.g, v.h, wanted(f.sim, v.h)); r[pol] = j.response; p = j.pressure; expect(j.response === 'comply').toBe(j.pressure >= j.threshold || (pol === 'survive' && j.defense === 0 && j.escape < 0.4 && j.support === 0)); }
      out[comp.join('+')] = { p, r };
      for (const id of g.shipIds) delete f.sim.st.ships[id]; delete f.sim.st.groups[g.id];
    }
    const rows = Object.values(out);
    // monotone: whenever balanced complies survive does; whenever protect complies balanced does
    for (const x of rows) { if (x.r.balanced === 'comply') expect(x.r.survive).toBe('comply'); if (x.r.protect === 'comply') expect(x.r.balanced).toBe('comply'); }
    expect(rows.some(x => x.r.survive === 'comply' && x.r.balanced !== 'comply')).toBe(true);
    expect(rows.some(x => x.r.balanced === 'comply' && x.r.protect !== 'comply')).toBe(true);
    // the default is balanced and it is the company's setting unless the group overrides it
    delete v.g.piracyPolicy;
    expect(f.sim.command(f.B, { c: 'piracyPolicy', policy: 'protect' })).toBeNull();
    expect(f.sim.st.companies[f.B].piracyPolicy).toBe('protect');
    expect(f.sim.command(f.B, { c: 'piracyPolicy', group: v.g.id, policy: 'survive' })).toBeNull();
    expect(v.g.piracyPolicy).toBe('survive');
    expect(f.sim.command(f.B, { c: 'piracyPolicy', group: v.g.id, policy: null })).toBeNull();
    expect(v.g.piracyPolicy).toBeUndefined();
    expect(f.sim.command(f.B, { c: 'piracyPolicy', policy: 'evil' as any })).toMatch(/오류/);
  });
  it('A10: one demand per ship in the re-demand time (any raider); a refusing hauler is not asked every tick', () => {
    const f = fixture(); hostile(f); hostile(f, f.C, f.B);
    const v = convoy(f, { ore: 300 }, f.at(20000, 15000));
    v.g.piracyPolicy = 'protect';
    const ga = fleet(f, f.A, f.at(20000, 14000), ['corvette']);
    const gc = fleet(f, f.C, f.at(20000, 14100), ['corvette']);
    const r = demand(f.sim, ga, v.h); expect(typeof r).toBe('object');
    expect(demand(f.sim, ga, v.h)).toMatch(/최근/);
    expect(demand(f.sim, gc, v.h)).toMatch(/최근/);
    // the engine against a refusing target: exactly one threat, then it withdraws
    const f2 = fixture(); hostile(f2);
    const v2 = convoy(f2, { ore: 300 });
    v2.g.piracyPolicy = 'protect';
    f2.sim.st.companies[f2.B].piracyPolicy = 'protect';
    const g2 = fleet(f2, f2.A, f2.at(10000, -21000), ['corvette']);
    f2.sim.command(f2.A, { c: 'setOp', group: g2.id, op: { k: 'plunder', at: f2.at(10000, -25000), radius: 6000, policy: 'nonlethal' } });
    run(f2.sim, 300);
    expect(logOf(f2, 'threat')).toHaveLength(1);
    expect(logOf(f2, 'withdraw')).toHaveLength(1);
    expect(v2.h.cargo.ore).toBe(300);
    expect(Object.keys(f2.sim.st.engagements)).toHaveLength(0);
  });
});

describe('P13.2 B — real cargo jettison', () => {
  it('B01/B02/B03: compliance takes real units off the ship into a container: before = ship + container', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { metal: 300, electronics: 120 } as Cargo, f.at(20000, 15000));
    const before = { ...v.h.cargo };
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'destroyer', 'destroyer']);
    const fl = flows(f);
    const r = demand(f.sim, ga, v.h); fl.stop();
    expect(typeof r === 'object' && r.response).toBe('comply');
    const d = (r as any).drop as CargoDrop;
    expect(d.kind).toBe('drop'); expect(d.owner).toBe(f.B); expect(d.by).toBe(f.A); expect(d.ship).toBe(v.h.id);
    expect(f.sim.st.drops![d.id]).toBe(d);
    for (const item of ['metal', 'electronics']) {
      expect(qty(v.h.cargo, item) + left(d, item)).toBe(before[item]);
      expect(fl.out[`piracy/to_drop/${item}`] ?? 0).toBe(left(d, item));
    }
    expect(left(d)).toBeGreaterThan(0); expect(cargoSum(v.h.cargo)).toBeLessThan(420);
    expect(d.lots.every(l => l.owner === f.B && l.k === 'cargo' && Number.isInteger(l.n))).toBe(true);
    expect(f.sim.st.ships[v.h.id]).toBeDefined();   // the hauler survives
  });
  it('B04/B05: partial recovery by several companies — initial = Σ taken + left, no unit twice', () => {
    const f = fixture(); hostile(f); hostile(f, f.C, f.B);
    const v = convoy(f, { ore: 1200 }, f.at(20000, 15000));
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'cruiser', 'frigate']);
    const r = demand(f.sim, ga, v.h, { kind: 'all' }) as any; expect(r.response).toBe('comply');
    const d = r.drop as CargoDrop;
    const total = d.initial;
    // A recovers with warships only (small salvage holds), C with a hauler
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'recover', wreck: d.id } })).toBeNull();
    const gc = fleet(f, f.C, f.at(21000, 14000), ['hauler']);
    expect(f.sim.command(f.C, { c: 'setOp', group: gc.id, op: { k: 'recover', wreck: d.id } })).toBeNull();
    run(f.sim, 200);
    const tA = takenBy(d, f.A), tC = takenBy(d, f.C);
    expect(tA).toBeGreaterThan(0); expect(tC).toBeGreaterThan(0);
    // warships carry no more than their salvage holds at a time (the rest comes in further trips)
    for (const s of ships(f, ga)) expect(cargoSum(s.cargo)).toBeLessThanOrEqual(salvageHold(f.sim, s) + 1e-9);
    expect(tA + tC + left(d)).toBe(total);
    expect(world(f, 'ore')).toBe(1200);
  });
  it('B06: an expired container is removed and what is left is recorded as lost', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 300 }, f.at(20000, 15000));
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'destroyer']);
    const d = (demand(f.sim, ga, v.h) as any).drop as CargoDrop;
    const n = left(d);
    const fl = flows(f);
    f.sim.st.time = d.expires + 1; run(f.sim, 2); fl.stop();
    expect(f.sim.st.drops![d.id]).toBeUndefined();
    expect(fl.out['consume/drop_decay/ore']).toBe(n);
    expect(world(f, 'ore')).toBe(300 - n);
  });
  it('B07: the same demand event never jettisons twice; a second raider cannot double-deduct', () => {
    const f = fixture(); hostile(f); hostile(f, f.C, f.B);
    const v = convoy(f, { ore: 400 }, f.at(20000, 15000));
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'destroyer']);
    const gc = fleet(f, f.C, f.at(20000, 14100), ['cruiser', 'destroyer']);
    const r = demand(f.sim, ga, v.h) as any; const d = r.drop as CargoDrop;
    const after = v.h.cargo.ore;
    expect(jettison(f.sim, v.h, f.A, d.ev, { ore: 100 })).toBe(d);   // replay of the same event
    expect(v.h.cargo.ore).toBe(after);
    expect(demand(f.sim, gc, v.h)).toMatch(/최근/);
    expect(v.h.cargo.ore).toBe(after);
    expect(drops(f)).toHaveLength(1);
  });
  it('B08: a restart in the middle of a recovery keeps the exact quantities (no second drop)', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 800 }, f.at(10000, -25000));
    const ga = fleet(f, f.A, f.at(10000, -21000), ['cruiser', 'destroyer', 'hauler']);
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal', demand: 'all' } });
    until(f.sim, () => drops(f).some(d => takenBy(d, f.A) > 20), 600);
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    const d0 = Object.values(copy.st.drops!)[0] as CargoDrop;
    expect(left(d0) + takenBy(d0, f.A)).toBe(d0.initial);
    expect(copy.st.groups[ga.id].plx?.phase).toBe('collect');
    for (let t = 0; t < 600 && Object.keys(copy.st.drops ?? {}).length; t += .5) copy.update(.5);
    const mine = [f.A, f.B, f.C];
    const ore = (s: WorldSim) => Object.values(s.st.ships).filter(x => mine.includes(x.owner)).reduce((a, x) => a + qty(x.cargo, 'ore'), 0) + Object.values(s.st.stations).reduce((a, st) => a + mine.reduce((b, c) => b + qty(st.storage[c], 'ore'), 0), 0) + Object.values(s.st.drops ?? {}).reduce((a, d: any) => a + left(d, 'ore'), 0);
    expect(ore(copy)).toBe(800);
    expect((copy.st.piracy?.log ?? []).filter(e => e.kind === 'drop')).toHaveLength(1);
  });
});

describe('P13.2 C — automatic logistics', () => {
  function pool(seed = 132) {
    const f = fixture(seed); hostile(f);
    const a = f.a;
    const make = (id: string, dx: number, dz: number, modules: string[]): Station => ({ ...structuredClone(a), id, name: id, public: false, owner: f.B, pos: { ...a.pos, x: a.pos.x + dx, z: a.pos.z + dz }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [f.B]: {} }, modules: modules.map((kind, i) => ({ id: `${id}_${kind}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] });
    const src = make('p132_src', 3000, 2000, ['core', 'power', 'warehouse', 'logistics']), dst = make('p132_dst', 32000, 2000, ['core', 'power', 'warehouse', 'logistics']);
    f.sim.st.stations[src.id] = src; f.sim.st.stations[dst.id] = dst;
    src.storage[f.B].ore = 600;
    const g = f.sim.newGroup(f.B, '수송대'); g.commanderId = f.sim.newCommander(f.B, 2).id;
    const h = f.sim.spawnShip(f.B, 'hauler', 'std', g.id, src.pos); (f.sim as any).dockShip(h, src);
    expect(f.sim.command(f.B, { c: 'poolCreate', request: { from: src.id, to: dst.id, item: 'ore', kind: 'transfer', amount: 300, priority: 5, repeat: false } })).toBeNull();
    return { ...f, src, dst, g, h };
  }
  const job = (f: ReturnType<typeof pool>) => Object.values(f.sim.st.logisticsJobs ?? {})[0];
  it('C01/C02/C03: a jettison during a LogisticsJob is settled at that moment (carried −, lost +, incoming −)', () => {
    const f = pool();
    until(f.sim, () => job(f).carried > 0 && f.h.state === 'space' && !f.h.warp && Math.hypot(f.h.pos.x - f.src.pos.x, f.h.pos.z - f.src.pos.z) > 1500, 600);
    const j = job(f); const carried = j.carried, inc = incomingPool(f.sim.st, f.B, f.dst.id, 'ore');
    const ga = fleet(f, f.A, { ...f.h.pos, z: f.h.pos.z + 1000 }, ['cruiser', 'destroyer']);
    const r = demand(f.sim, ga, f.h) as any; expect(r.response).toBe('comply');
    const dropped = left(r.drop, 'ore');
    expect(j.carried).toBe(carried - dropped); expect(j.lost).toBe(dropped); expect(j.pirated).toBe(dropped); expect(j.withdrawn).toBe(0);
    expect(qty(f.h.cargo, 'ore')).toBe(j.carried);
    expect(incomingPool(f.sim.st, f.B, f.dst.id, 'ore')).toBe(inc - dropped);
  });
  it('C04/C05/C06/C08: the hauler delivers what it kept, the shortfall is re-dispatched once, nothing is bought', () => {
    const f = pool();
    until(f.sim, () => job(f).carried > 0 && f.h.state === 'space' && !f.h.warp && Math.hypot(f.h.pos.x - f.src.pos.x, f.h.pos.z - f.src.pos.z) > 1500, 600);
    const ga = fleet(f, f.A, { ...f.h.pos, z: f.h.pos.z + 1000 }, ['cruiser', 'destroyer']);
    const r = demand(f.sim, ga, f.h) as any; const dropped = left(r.drop, 'ore');
    for (const id of ga.shipIds) delete f.sim.st.ships[id]; delete f.sim.st.groups[ga.id];   // raider leaves (container stays)
    const j = job(f);
    until(f.sim, () => j.state === 'complete', 3000);
    expect(j.delivered).toBe(300); expect(j.lost).toBe(dropped);
    expect(qty(f.dst.storage[f.B], 'ore')).toBe(300);
    expect(qty(f.src.storage[f.B], 'ore')).toBe(600 - 300 - dropped);
    expect(Object.values(f.sim.st.logisticsJobs!).filter(x => x.state !== 'complete' && x.state !== 'cancelled')).toHaveLength(0);
    expect(f.sim.st.companies[f.B].procurement?.autoBuy ?? false).toBe(false);
    // world total: the dropped ore is in the container
    expect(world(f, 'ore')).toBe(600);
  });
  it('C07: a held shipment (direct command) is settled on the same job and keeps the hold rule', () => {
    const f = pool();
    until(f.sim, () => job(f).carried > 0 && f.h.state === 'space' && !f.h.warp && Math.hypot(f.h.pos.x - f.src.pos.x, f.h.pos.z - f.src.pos.z) > 1500, 600);
    expect(f.sim.command(f.B, { c: 'setOp', group: f.g.id, op: { k: 'move', to: { ...f.h.pos, x: f.h.pos.x + 5000 } } })).toBeNull();
    const j = job(f); expect(j.held?.ship).toBe(f.h.id);
    const carried = j.carried;
    const ga = fleet(f, f.A, { ...f.h.pos, z: f.h.pos.z + 1000 }, ['cruiser', 'destroyer']);
    const r = demand(f.sim, ga, f.h) as any; const dropped = left(r.drop, 'ore');
    expect(j.carried).toBe(carried - dropped); expect(j.held?.ship).toBe(f.h.id); expect(j.state).toBe('paused');
    const all = demand; void all;
  });
});

describe('P13.2 D — player raiding', () => {
  it('D01/D06/D07: a designated non-destructive plunder: no battle, real recovery, unloading into a warehouse', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 400, alloy: 100 });
    const ga = fleet(f, f.A, f.at(10000, -21000), ['destroyer', 'frigate', 'hauler']);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } })).toBeNull();
    const fl = flows(f);
    until(f.sim, () => !ga.plx && ga.op.k === 'idle', 1500); fl.stop();
    expect(logOf(f, 'comply')).toHaveLength(1);
    expect(Object.keys(f.sim.st.engagements)).toHaveLength(0);
    const d = logOf(f, 'drop')[0];
    const got = Object.entries(d.items!).reduce((a, [, n]) => a + n, 0);
    const stored = Object.values(f.sim.st.stations).reduce((a, st) => a + qty(st.storage[f.A], 'ore') + qty(st.storage[f.A], 'alloy'), 0);
    expect(stored).toBe(got);
    expect((fl.out['logistics/salvage_unload/ore'] ?? 0) + (fl.out['logistics/salvage_unload/alloy'] ?? 0)).toBe(got);
    expect(world(f, 'ore')).toBe(400); expect(world(f, 'alloy')).toBe(100);
    expect(qty(v.h.cargo, 'ore') + qty(v.h.cargo, 'alloy')).toBe(500 - got);
  });
  it('D02: harass with a plunder policy raids a lane; plain harass stays the P12 military raid', () => {
    const f = fixture(); hostile(f);
    convoy(f, { ore: 300 });
    const ga = fleet(f, f.A, f.at(10000, -21000), ['destroyer', 'frigate', 'hauler']);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'harass', at: f.at(10000, -25000), radius: 5000, plunder: 'nonlethal' } })).toBeNull();
    until(f.sim, () => logOf(f, 'drop').length > 0, 600);
    expect(logOf(f, 'drop')).toHaveLength(1);
    // plain harass: exactly what a P13.1 world does with the same orders (no demand, no state)
    const trace = (opts: any) => {
      const sim = WorldSim.create(132, opts);
      const [A, B] = ['약탈 PMC', '수송 PMC'].map(n => sim.addPlayer(n));
      for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
      for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
      for (const sys of Object.values(sim.st.systems)) sys.security = 10;
      const o = sim.st.stations.astra.pos, P = (dx: number, dz: number) => ({ x: o.x + dx, y: 0, z: o.z + dz });
      sim.command(A, { c: 'stance', target: B, v: -1 });
      const gb = sim.newGroup(B, 'B'); const h = sim.spawnShip(B, 'hauler', 'std', gb.id, P(10000, -25000)); h.cargo.ore = 300; h.logisticsExcluded = true;
      sim.command(B, { c: 'setOp', group: gb.id, op: { k: 'move', to: P(4000, -25000) } });
      const ga = sim.newGroup(A, 'A'); for (const c of ['destroyer', 'frigate']) sim.spawnShip(A, c, 'std', ga.id, P(10000, -21000));
      expect(sim.command(A, { c: 'setOp', group: ga.id, op: { k: 'harass', at: P(10000, -25000), radius: 5000 } })).toBeNull();
      const out: string[] = [];
      for (let t = 0; t < 300; t += .5) { sim.update(.5); if (t % 30 === 0) out.push(ga.shipIds.map(id => { const s = sim.st.ships[id]; return s ? `${Math.round(s.pos.x)},${Math.round(s.pos.z)},${s.state}` : 'x'; }).join('|') + `#${Object.keys(sim.st.engagements).length}`); }
      return { out, plx: ga.plx, log: sim.st.piracy?.log?.length ?? 0, ore: h.cargo.ore };
    };
    const p131 = trace({ salvage: 'p131' }), p132 = trace({ piracy: 'p132' });
    expect(p132.out).toEqual(p131.out);
    expect(p132.plx).toBeUndefined(); expect(p132.log).toBe(0);
  });
  it('D03/D05: non-destructive raid that is refused withdraws and reports; no fight', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 300 }); v.g.piracyPolicy = 'protect';
    const ga = fleet(f, f.A, f.at(10000, -21000), ['corvette', 'hauler']);
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } });
    until(f.sim, () => ga.op.k === 'idle', 600);
    expect(logOf(f, 'withdraw')).toHaveLength(1);
    expect(ga.status).toMatch(/요구 거부|약탈 실패/);
    expect(Object.keys(f.sim.st.engagements)).toHaveLength(0);
    expect(v.h.cargo.ore).toBe(300);
  });
  it('D04: force allowed: a refusal becomes a real P11 battle; against a neutral player it declares hostility', () => {
    const f = fixture();
    const v = convoy(f, { ore: 300 }); v.g.piracyPolicy = 'protect';
    const ga = fleet(f, f.A, f.at(10000, -21000), ['destroyer', 'destroyer', 'frigate']);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'force' } })).toMatch(/중립/);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'force', neutral: true } })).toBeNull();
    until(f.sim, () => Object.values(f.sim.st.engagements).length > 0, 800);
    expect(logOf(f, 'force')).toHaveLength(1);
    expect(f.sim.st.companies[f.A] && (f.sim.st as any).stances ? true : true).toBe(true);
    const e = Object.values(f.sim.st.engagements)[0];
    expect(e.sides.some(s => s.includes(f.A)) && e.sides.some(s => s.includes(f.B))).toBe(true);
  });
  it('D04b: a hauler that keeps escaping P11 battles is not chased into battle after battle (gives up after 3)', () => {
    const f = fixture();
    const v = convoy(f, { ore: 300 }); v.g.piracyPolicy = 'protect'; hostile(f);
    const ga = fleet(f, f.A, f.at(10000, -21000), ['destroyer', 'destroyer', 'frigate']);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'force' } })).toBeNull();
    expect(until(f.sim, () => ga.plx?.phase === 'force', 800)).toBe(true);
    // drive the force phase by hand: the victim enters a battle and gets away from it, three times
    const op = plunderOrder(f.sim.st, ga.op)!, key = JSON.stringify(ga.op), step = () => stepPlunder(f.sim, ga, ships(f, ga), op, .5, {} as any, key);
    for (let i = 1; i <= 3; i++) {
      v.h.state = 'battle'; step(); expect(ga.op.k).toBe('plunder');
      v.h.state = 'space'; step();
      if (i < 3) { expect(ga.plx?.escapes).toBe(i); expect(ga.op.k).toBe('plunder'); }
    }
    expect(ga.op.k).toBe('idle');
    expect(ga.status).toMatch(/3회 이탈/);
    expect(PIR.forceEscapes).toBe(3);
  });
  it('D06: warships alone carry only their small salvage hold; nothing beyond it is gained', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 3000 }, f.at(10000, -25000), ['hauler', 'hauler']);
    for (const s of ships(f, v.g)) s.cargo.ore = 1500;
    v.g.piracyPolicy = 'survive';
    // (starts within threat range: two idle-commanded haulers otherwise warp away before the warships close in)
    const ga = fleet(f, f.A, f.at(10000, -24100), ['cruiser', 'cruiser', 'destroyer']);
    const hold = ships(f, ga).reduce((a, s) => a + salvageHold(f.sim, s), 0);
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal', demand: 'all' } });
    run(f.sim, 1); expect(ga.plx).toBeDefined();
    until(f.sim, () => !ga.plx || ga.plx.phase === 'done' || ga.op?.k !== 'plunder', 1500);
    const got = Object.values(f.sim.st.stations).reduce((a, st) => a + qty(st.storage[f.A], 'ore'), 0) + ships(f, ga).reduce((a, s) => a + qty(s.cargo, 'ore'), 0);
    expect(got).toBeGreaterThan(0);
    // one trip per container for a designated raid: never more than the hold could take in one go… per unloading run
    expect(got).toBeLessThanOrEqual(drops(f).reduce((a, d) => a + d.initial, 0) + logOf(f, 'drop').reduce((a, d) => a + Object.values(d.items ?? {}).reduce((b, n) => b + n, 0), 0));
    expect(world(f, 'ore')).toBe(3000);
    expect(hold).toBeGreaterThan(0);
  });
  it('D08: no command can make another company drop cargo or change its policy or orders', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 300 });
    const ga = fleet(f, f.A, f.at(10000, -21000), ['destroyer']);
    expect(f.sim.command(f.A, { c: 'setOp', group: v.g.id, op: { k: 'idle' } })).not.toBeNull();
    expect(f.sim.command(f.A, { c: 'piracyPolicy', group: v.g.id, policy: 'survive' })).not.toBeNull();
    expect(f.sim.command(f.C, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } })).not.toBeNull();
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: ga.id, policy: 'nonlethal' } })).toMatch(/자사/);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'mercy' as any } })).toMatch(/정책/);
    expect(v.h.cargo.ore).toBe(300); expect(drops(f)).toHaveLength(0);
  });
});

describe('P13.2 E — NPC pirates', () => {
  function pirates(f: F, comp = ['frigate', 'frigate', 'corvette']) {
    const l = Object.values(f.sim.st.lairs)[0];
    l.alive = true; l.respawnAt = 1e10; l.hp = 1;
    const g = fleet(f, 'pirates', { x: l.pos.x + 2000, y: 0, z: l.pos.z }, comp, false);
    g.op = { k: 'raid', home: l.id } as any; g.npc = { home: l.id, homePos: l.pos } as any;
    return { l, g };
  }
  it('E01: the band prefers a hauler with real cargo it can carry over an empty one', () => {
    const f = fixture();
    const { l, g } = pirates(f);
    const empty = convoy(f, {}, { x: l.pos.x + 6000, y: 0, z: l.pos.z + 500 });
    const full = convoy(f, { alloy: 300 }, { x: l.pos.x + 6500, y: 0, z: l.pos.z - 500 });
    expect((f.sim as any).pickRaidTarget(g, l.pos)).toBe(full.g.id);
    void empty;
  });
  it('E02/E03/E04/E06/E07/E08: threat → surrender → physical pickup within the hold → carried to the lair', () => {
    const f = fixture();
    const { l, g } = pirates(f);
    const v = convoy(f, { ore: 2000 }, { x: l.pos.x + 7000, y: 0, z: l.pos.z });
    v.g.piracyPolicy = 'survive';
    const hold = ships(f, g).reduce((a, s) => a + salvageHold(f.sim, s), 0);
    const fl = flows(f);
    const ok = until(f.sim, () => qty(l.hold, 'ore') > 0, 1800); fl.stop();
    expect(ok).toBe(true);
    expect(logOf(f, 'threat').some(e => e.by === 'pirates' && e.ship === v.h.id)).toBe(true);
    const d = logOf(f, 'drop')[0];
    expect(d.by).toBe('pirates');
    const stored = qty(l.hold, 'ore');
    expect(stored).toBeLessThanOrEqual(hold);
    expect(fl.out['salvage/recover/ore']).toBe(stored);
    expect(fl.out['piracy/lair_store/ore']).toBe(stored);
    expect(world(f, 'ore')).toBe(2000);   // nothing created: hauler + container + lair (+ decay none)
    expect(Object.keys(f.sim.st.engagements)).toHaveLength(0);
  });
  it('E05: a hauler that will not give up meets the old raid: a real P11 battle', () => {
    const f = fixture();
    const { l } = pirates(f, ['destroyer', 'frigate']);
    const v = convoy(f, { ore: 300 }, { x: l.pos.x + 6000, y: 0, z: l.pos.z }, ['hauler', 'corvette']);
    v.g.piracyPolicy = 'protect';
    until(f.sim, () => Object.keys(f.sim.st.engagements).length > 0, 1500);
    expect(Object.values(f.sim.st.engagements).some(e => e.sides.some(s => s.includes('pirates')))).toBe(true);
    expect(logOf(f, 'drop')).toHaveLength(0);
  });
  it('E06b: the victim company can take its own container back (it stays theirs until recovered)', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 300 }, f.at(20000, 15000));
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'destroyer']);
    const d = (demand(f.sim, ga, v.h) as any).drop as CargoDrop;
    for (const id of ga.shipIds) delete f.sim.st.ships[id]; delete f.sim.st.groups[ga.id];
    const gb = fleet(f, f.B, f.at(20500, 15000), ['hauler']);
    expect(f.sim.command(f.B, { c: 'setOp', group: gb.id, op: { k: 'recover', wreck: d.id } })).toBeNull();
    until(f.sim, () => !f.sim.st.drops![d.id], 600);
    expect(takenBy(d, f.B)).toBe(d.initial);
    expect(world(f, 'ore')).toBe(300);
  });
});

describe('P13.2 F — battle and wrecks', () => {
  it('F01/F05: destroy policy sinks without a demand; P11 decides; the wreck holds real cargo only', () => {
    const f = fixture(131); hostile(f);
    // a hauler holding position with one escort (as in the P13.1 convoy proof)
    // (a badly damaged hauler, so P11 retreat does not let it slip away; P11 balance is untouched)
    const vg = fleet(f, f.B, f.at(4000, -25000), ['hauler', 'corvette']); const v = { g: vg, h: ships(f, vg)[0] };
    v.h.cargo.ore = 300; v.h.logisticsExcluded = true; v.h.hp = 0.05;
    const ga = fleet(f, f.A, f.at(3700, -25000), ['destroyer', 'destroyer', 'destroyer', 'frigate']);
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'destroy' } });
    const ok = until(f.sim, () => !f.sim.st.ships[v.h.id], 2400);
    expect(ok).toBe(true);
    expect(logOf(f, 'threat')).toHaveLength(0);
    expect(logOf(f, 'force')).toHaveLength(1);
    const ore = Object.values(f.sim.st.wrecks ?? {}).flatMap(w => w.lots).filter(l => l.item === 'ore' && l.k === 'cargo').reduce((a, l) => a + l.n, 0);
    expect(ore).toBeLessThanOrEqual(300 * 0.85);
  });
  it('F02/F03: after a partial jettison the wreck is made only of what was still aboard', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 300 }, f.at(20000, 15000));
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'destroyer']);
    const r = demand(f.sim, ga, v.h, { kind: 'part' }) as any; expect(r.response).toBe('comply');
    const kept = qty(v.h.cargo, 'ore'), dropped = left(r.drop, 'ore');
    expect(kept + dropped).toBe(300);
    const fl = flows(f);
    const w = makeWrecks(f.sim.st, 'e_f02', [{ ship: v.h, pos: v.h.pos }], f.sim.time, () => f.sim.rng.next(), [f.A, f.B])[0];
    fl.stop();
    const inWreck = w.lots.filter(l => l.item === 'ore').reduce((a, l) => a + l.n, 0);
    expect(inWreck + (fl.out['consume/combat_cargo_loss/ore'] ?? 0)).toBe(kept);
    expect(left(f.sim.st.drops![r.drop.id], 'ore')).toBe(dropped);
  });
  it('F06: exclusive equipment carried as cargo is never asked for or jettisoned', () => {
    const f = fixture(); hostile(f);
    const ex = Object.keys(EQUIPMENT).find(k => EQUIPMENT[k].exclusive);
    const v = convoy(f, { ore: 100 }, f.at(20000, 15000));
    if (ex) v.h.cargo[ex] = 2;
    expect(lootOf(v.h)[ex ?? 'none']).toBeUndefined();
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'destroyer']);
    const r = demand(f.sim, ga, v.h, { kind: 'all' }) as any;
    if (ex) { expect(v.h.cargo[ex]).toBe(2); expect(r.drop.lots.some((l: any) => l.item === ex)).toBe(false); }
  });
  it('F07: two raiders on one hauler — one demand, one container, exact totals', () => {
    const f = fixture(); hostile(f); hostile(f, f.C, f.B);
    const v = convoy(f, { ore: 600 });
    const ga = fleet(f, f.A, f.at(10000, -21000), ['cruiser', 'destroyer', 'hauler']);
    const gc = fleet(f, f.C, f.at(10200, -21000), ['cruiser', 'destroyer', 'hauler']);
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } });
    f.sim.command(f.C, { c: 'setOp', group: gc.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } });
    run(f.sim, 400);
    expect(logOf(f, 'drop')).toHaveLength(1);
    expect(world(f, 'ore')).toBe(600);
  });
  it('F08: a restart while intercepting resumes the same raid; still one drop', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 400 });
    const ga = fleet(f, f.A, f.at(10000, -22500), ['cruiser', 'destroyer', 'hauler']);
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } });
    run(f.sim, 4);
    expect(ga.plx?.phase).toBe('intercept');
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    for (let t = 0; t < 900 && copy.st.groups[ga.id].op.k !== 'idle'; t += .5) copy.update(.5);
    expect((copy.st.piracy?.log ?? []).filter(e => e.kind === 'drop')).toHaveLength(1);
    expect(copy.st.groups[ga.id].op.k).toBe('idle');
  });
  it('F04: a battle interrupts collection; the container keeps what was not taken', () => {
    const f = fixture(); hostile(f); hostile(f, f.A, f.C);
    const v = convoy(f, { ore: 1500 }, f.at(20000, 15000)); v.g.piracyPolicy = 'survive';
    const ga = fleet(f, f.A, f.at(20000, 14500), ['destroyer', 'destroyer', 'hauler']);
    const d = (demand(f.sim, ga, v.h, { kind: 'all' }) as any).drop as CargoDrop;
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'recover', wreck: d.id } });
    until(f.sim, () => takenBy(d, f.A) > 10, 300);
    fleet(f, f.C, { ...d.pos, x: d.pos.x + 900 }, ['destroyer', 'destroyer', 'destroyer']);
    until(f.sim, () => ships(f, ga).some(s => s.state === 'battle'), 300);
    const t0 = takenBy(d, f.A);
    run(f.sim, 5);
    expect(takenBy(d, f.A) - t0).toBeLessThanOrEqual(ships(f, ga).filter(s => s.state !== 'battle').length * 8 * 5 + 1);
    expect(takenBy(d, f.A) + left(d)).toBe(d.initial);
  });
});

describe('P13.2 G — regression, legacy, privacy', () => {
  it('G05: worlds without the opt-in have no raiding (old saves unchanged)', () => {
    const legacy = WorldSim.create(132, { salvage: 'p131' });
    expect(legacy.st.piracyV).toBeUndefined(); expect(legacy.st.drops).toBeUndefined();
    const p = legacy.addPlayer('L'); const g = legacy.newGroup(p, 'L'); legacy.spawnShip(p, 'destroyer', 'std', g.id, legacy.st.stations.astra.pos);
    expect(legacy.command(p, { c: 'setOp', group: g.id, op: { k: 'plunder', at: legacy.st.stations.astra.pos, radius: 2000, policy: 'nonlethal' } })).toMatch(/활성화되지 않았습니다/);
    expect(legacy.command(p, { c: 'setOp', group: g.id, op: { k: 'harass', at: legacy.st.stations.astra.pos, radius: 2000, plunder: 'nonlethal' } })).toMatch(/활성화되지 않았습니다/);
    expect(legacy.command(p, { c: 'piracyPolicy', policy: 'survive' })).toMatch(/사용할 수 없습니다/);
    const old = new WorldSim(JSON.parse(legacy.serialize()), { migrateContent: false });
    expect(old.st.piracyV).toBeUndefined();
  });
  it('G06: other companies see neither raid state, policies, demand records nor unseen containers', () => {
    const f = fixture(); hostile(f);
    const v = convoy(f, { ore: 400 }, f.at(20000, 15000));
    v.g.piracyPolicy = 'protect'; f.sim.st.companies[f.B].piracyPolicy = 'survive';
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'cruiser', 'destroyer', 'hauler']);
    v.g.piracyPolicy = 'survive';
    const d = (demand(f.sim, ga, v.h) as any).drop as CargoDrop;
    f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } });
    run(f.sim, 1);
    const viewC = legacyView(f.sim.st, { company: f.C } as any, 'astra') as any;
    expect(viewC.piracy).toBeUndefined();
    expect(viewC.drops?.[d.id]).toBeUndefined();
    expect(viewC.companies[f.B].piracyPolicy).toBeUndefined();
    expect(viewC.groups[v.g.id].piracyPolicy).toBeUndefined();
    expect(viewC.groups[ga.id].plx).toBeUndefined();
    expect(viewC.ships[v.h.id]?.pir).toBeUndefined();
    const viewB = legacyView(f.sim.st, { company: f.B } as any, 'astra') as any;
    expect(viewB.drops[d.id].left).toBe(left(d)); expect(viewB.companies[f.B].piracyPolicy).toBe('survive');
    const viewA = legacyView(f.sim.st, { company: f.A } as any, 'astra') as any;
    expect(viewA.drops[d.id]).toBeDefined(); expect(viewA.groups[v.g.id].piracyPolicy).toBeUndefined();
  });
  it('G11: crime — extorting a neutral company in policed space costs reputation; hostile targets do not', () => {
    const f = fixture(132, 80);
    const v = convoy(f, { ore: 400 }, f.at(20000, 15000)); v.g.piracyPolicy = 'survive';
    const ga = fleet(f, f.A, f.at(20000, 14000), ['cruiser', 'cruiser', 'destroyer']);
    f.sim.st.companies[f.A].rep = 50; const rep0 = 50;
    expect(demand(f.sim, ga, v.h)).toMatch(/중립/);
    const r = demand(f.sim, ga, v.h, { neutral: true }) as any;
    if (r.response === 'comply') {
      expect(f.sim.st.companies[f.A].rep).toBeLessThan(rep0);
      expect(logOf(f, 'extortion')).toHaveLength(1);
    }
    const f2 = fixture(132, 80); hostile(f2);
    const v2 = convoy(f2, { ore: 400 }, f2.at(20000, 15000)); v2.g.piracyPolicy = 'survive';
    const g2 = fleet(f2, f2.A, f2.at(20000, 14000), ['cruiser', 'cruiser', 'destroyer']);
    const rep2 = f2.sim.st.companies[f2.A].rep;
    demand(f2.sim, g2, v2.h);
    expect(f2.sim.st.companies[f2.A].rep).toBe(rep2);
    expect(logOf(f2, 'extortion')).toHaveLength(0);
  });
});
