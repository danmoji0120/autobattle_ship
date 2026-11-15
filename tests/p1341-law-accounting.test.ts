// P13.4.1 law enforcement accounting (lawV worlds): what a guard inspection may seize (stolen goods + the transit bans
// of that place — not station import bans, never fitted equipment, never openly traded goods), the seizure fine kept
// as total / paid / unpaid on its smuggling case (never forgiven by a short balance, never charged twice), when a
// smuggling case closes, and the P13.3 world left as it was. Every check runs the real world paths (inspect,
// guardInspect, the guard stop, lawPay through the command API, save / restore).
import { afterEach, describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type V, type WShip, type WGroup } from '../src/world/types';
import { LAW, lawCrime, wanted, lawBook, policedSystems, lawlessSys, jurisdiction } from '../src/world/law';
import { BM, hotKey, inspect, guardInspect, bansAt, restrictedAt, TRANSIT_BANS } from '../src/world/blackmarket';
import { sysAt } from '../src/world/geom';
import { effSec } from '../src/world/security';
import { legacyView } from '../src/server/sync';

const lawBase = JSON.parse(JSON.stringify(LAW)), bmBase = { ...BM };
afterEach(() => { Object.assign(LAW, JSON.parse(JSON.stringify(lawBase))); Object.assign(BM, bmBase); });

function fixture(opts: Record<string, unknown> = { law: 'p134' }) {
  const sim = WorldSim.create(133, opts as any);
  const [A, B, C] = ['밀수 PMC', '원소유 PMC', '정상 PMC'].map(n => sim.addPlayer(n));
  sim.update(1);
  for (const g of Object.values(sim.st.groups)) if (g.owner !== 'union') { for (const id of g.shipIds) delete sim.st.ships[id]; delete sim.st.groups[g.id]; }
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e6;
  const a = sim.st.stations.astra;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, C, a, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: string[]): WGroup {
  const g = f.sim.newGroup(owner, `편대 ${Object.keys(f.sim.st.groups).length}`);
  g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => { const s = f.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; });
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
const run = (sim: WorldSim, seconds: number, dt = .5) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const until = (sim: WorldSim, cond: () => boolean, seconds = 900, dt = .5) => { for (let t = 0; t < seconds && !cond(); t += dt) sim.update(dt); return cond(); };
const cases = (f: F, co: string) => Object.values(f.sim.st.law?.cases ?? {}).filter(c => c.by === co);
const smug = (f: F, co: string) => cases(f, co).filter(c => c.kind === 'smuggling');
const unpaid = (c: { fine: number; paid: number }) => c.fine - c.paid;
const customs = (f: F, co: string, item: string) => (f.sim.st.companies[co].bm?.customs ?? []).filter(l => l.item === item).reduce((a, l) => a + l.n, 0);
const lawSpent = (f: F, co: string) => (f.sim.st.companies[co].ops?.ledger ?? []).reduce((a, b) => a + (b.exp.law_fines ?? 0), 0);
const bmSpent = (f: F, co: string) => (f.sim.st.companies[co].ops?.ledger ?? []).reduce((a, b) => a + (b.exp.fines ?? 0), 0);
/** a hauler of A in open space of `sys` (away from its stations) */
function hauler(f: F, sys: string, cargo: Record<string, number>) {
  const o = f.sim.st.systems[sys].origin;
  const g = fleet(f, f.A, { x: o.x + 4000, y: 0, z: o.z + 9000 }, ['hauler']);
  const s = ships(f, g)[0];
  for (const [k, n] of Object.entries(cargo)) s.cargo[k] = n;
  return { g, s, sysObj: f.sim.st.systems[sys] };
}
const HOT = (f: F, item = 'electronics') => hotKey(item, f.B);

describe('P13.4.1 A — what a guard inspection may seize', () => {
  it('A01: the rules of each place — station import ban (dock) ≠ transit ban (space); legal where no rule is defined; openly traded goods are never banned in that space', () => {
    const f = fixture();
    const st = f.sim.st;
    // Astra (security 80, no factions): ECM modules are banned at its public station, heavy cannons in its space
    expect(restrictedAt(st, f.a)).toEqual(expect.arrayContaining(['mod_ecm', 'eq_heavy_cannon']));
    expect(bansAt(st, st.systems.astra, f.a)).toEqual(restrictedAt(st, f.a));
    expect(bansAt(st, st.systems.astra)).toEqual(['eq_heavy_cannon']);
    // Drake (security 52): policed, but no transit rule is defined there → nothing is banned in its space
    expect(policedSystems(f.sim).has('drake')).toBe(true);
    expect(bansAt(st, st.systems.drake)).toEqual([]);
    // an item a public market of the system trades openly is legal in that system's space
    const m = f.a.market!; const had = m.eq_heavy_cannon;
    (m as any).eq_heavy_cannon = { ...(Object.values(m)[0] as any) };
    expect(bansAt(st, st.systems.astra)).toEqual([]);
    if (had) m.eq_heavy_cannon = had; else delete (m as any).eq_heavy_cannon;
    // a P10 world: the same item is banned in Union space and legal in a guild system
    const p = WorldSim.create(133, { layout: 'p10', law: 'p134', factionEcon: 'v2' } as any);
    expect(p.st.systems.helios.faction).toBe('union');
    expect(bansAt(p.st, p.st.systems.helios)).toEqual(TRANSIT_BANS.union);
    expect(p.st.systems.astra.faction).toBe('guild');
    expect(bansAt(p.st, p.st.systems.astra)).toEqual([]);
  });

  it('A02: stolen goods only / restricted goods only / mixed — exact units seized, legal cargo and fitted equipment untouched, one fine on the whole seizure', () => {
    const f = fixture();
    BM.fine = 0.3;
    // stolen only
    const h1 = hauler(f, 'astra', { [HOT(f)]: 40, ore: 30 });
    expect(guardInspect(f.sim, h1.s, h1.sysObj, 'op1', f.a)).toBe(40);
    expect(qty(h1.s.cargo, HOT(f))).toBe(0); expect(qty(h1.s.cargo, 'ore')).toBe(30);
    expect(customs(f, f.B, 'electronics')).toBe(40);
    // restricted only: the transit-banned heavy cannons are seized; ECM modules (only a station import ban) stay aboard
    const h2 = hauler(f, 'astra', { eq_heavy_cannon: 3, mod_ecm: 5 });
    expect(guardInspect(f.sim, h2.s, h2.sysObj, 'op2', f.a)).toBe(3);
    expect(qty(h2.s.cargo, 'eq_heavy_cannon')).toBe(0); expect(qty(h2.s.cargo, 'mod_ecm')).toBe(5);
    // mixed: both kinds seized exactly, in one seizure with one fine
    const h3 = hauler(f, 'astra', { [HOT(f, 'alloy')]: 25, eq_heavy_cannon: 2, crystal: 10 });
    const n0 = smug(f, f.A).length, log0 = (f.sim.st.companies[f.A].bm?.log ?? []).length;
    expect(guardInspect(f.sim, h3.s, h3.sysObj, 'op3', f.a)).toBe(27);
    expect(qty(h3.s.cargo, 'crystal')).toBe(10);
    expect(customs(f, f.B, 'alloy')).toBe(25);
    expect(smug(f, f.A).length).toBe(n0 + 1);
    const seizeLog = (f.sim.st.companies[f.A].bm?.log ?? []).slice(log0).filter(e => e.k === 'seize');
    expect(seizeLog.length).toBe(1);
    expect(seizeLog[0].items).toEqual({ [HOT(f, 'alloy')]: 25, eq_heavy_cannon: 2 });
    const c3 = smug(f, f.A).at(-1)!;
    expect(c3.fine).toBe(Math.round(seizeLog[0].value! * BM.fine));
    // the same inspection again (same operation): nothing seized, nothing fined, no new case
    const cr = f.sim.st.companies[f.A].credits;
    expect(guardInspect(f.sim, h3.s, h3.sysObj, 'op3', f.a)).toBe(0);
    expect(f.sim.st.companies[f.A].credits).toBe(cr); expect(smug(f, f.A).length).toBe(n0 + 1);
    // fitted equipment is not cargo: a cannon-armed ship with an empty hold carries nothing illicit
    const w = fleet(f, f.A, h1.s.pos, ['destroyer']); const ws = ships(f, w)[0];
    ws.fit = ['eq_heavy_cannon', 'eq_heavy_cannon'];
    expect(guardInspect(f.sim, ws, h1.sysObj, 'op4', f.a)).toBe(0);
    expect(ws.fit).toEqual(['eq_heavy_cannon', 'eq_heavy_cannon']);
  });

  it('A03: where no rule bans them, restricted goods and normal cargo pass a guard inspection; a pass makes no case', () => {
    const f = fixture();
    const h = hauler(f, 'drake', { eq_heavy_cannon: 4, mod_ecm: 4, ore: 50 });
    const n0 = cases(f, f.A).length, cr = f.sim.st.companies[f.A].credits;
    expect(guardInspect(f.sim, h.s, h.sysObj, 'opd', f.sim.st.stations[Object.keys(f.sim.st.stations).find(id => sysAt(f.sim.st.systems, f.sim.st.stations[id].pos)?.id === 'drake')!])).toBe(0);
    expect(h.s.cargo).toMatchObject({ eq_heavy_cannon: 4, mod_ecm: 4, ore: 50 });
    expect(cases(f, f.A).length).toBe(n0); expect(f.sim.st.companies[f.A].credits).toBe(cr);
    expect((f.sim.st.companies[f.A].bm?.log ?? []).at(-1)).toMatchObject({ k: 'pass' });
  });

  it('A04: the P13.3 world is unchanged — a guard inspection only exists with lawV; dock inspections keep the station rule', () => {
    const f = fixture({ blackMarket: 'p133' });
    expect(f.sim.st.lawV).toBeUndefined();
    const h = hauler(f, 'astra', { eq_heavy_cannon: 3, [HOT(f)]: 5 });
    expect(guardInspect(f.sim, h.s, h.sysObj, 'x', f.a)).toBe(5);              // stolen only (no transit bans without lawV)
    expect(qty(h.s.cargo, 'eq_heavy_cannon')).toBe(3);
  });
});

describe('P13.4.1 B — fines are kept: total = paid + unpaid on every path', () => {
  it('B01: zero balance — the whole fine stays owed on the smuggling case; credits never go negative; goods still go to the owner exactly', () => {
    const f = fixture();
    const co = f.sim.st.companies[f.A]; co.credits = 0;
    const h = hauler(f, 'astra', { [HOT(f)]: 60 });
    expect(guardInspect(f.sim, h.s, h.sysObj, 'z1', f.a)).toBe(60);
    expect(co.credits).toBe(0);
    const c = smug(f, f.A)[0];
    expect(c.fine).toBeGreaterThan(0); expect(c.paid).toBe(0); expect(c.fixed).toBe(true);
    expect(c.state).toBe('open'); expect(c.served).toBeDefined(); expect(c.creditor).toBe('astra');
    expect(co.law?.unpaid).toBe(c.fine);
    expect(customs(f, f.B, 'electronics')).toBe(60);
    const seize = (co.bm?.log ?? []).find(e => e.k === 'seize')!;
    expect(seize).toMatchObject({ fine: 0, owed: c.fine });
    // the debt keeps a watch level only (already enforced): no dispatch for it
    expect(wanted(f.sim.st, f.A).level).toBe(1);
    run(f.sim, 120);
    expect(Object.values(lawBook(f.sim.st).ops).filter(o => o.co === f.A).length).toBe(0);
    expect(c.state).toBe('open'); expect(unpaid(c)).toBe(c.fine);       // a debt never decays away
    f.sim.st.time += LAW.decay * 3; run(f.sim, 3);
    expect(c.state).toBe('open'); expect(unpaid(c)).toBe(c.fine);
  });

  it('B02: partial balance — 3,000 collected at once, the rest owed; later partial and full payments through lawPay; never paid twice', () => {
    const f = fixture();
    const co = f.sim.st.companies[f.A]; co.credits = 3000;
    const h = hauler(f, 'astra', { [HOT(f)]: 300 });                       // a fine well above 3,000
    guardInspect(f.sim, h.s, h.sysObj, 'p1', f.a);
    const c = smug(f, f.A)[0];
    const total = c.fine;
    expect(total).toBeGreaterThan(8000);
    expect(c.paid).toBe(3000); expect(co.credits).toBe(0); expect(unpaid(c)).toBe(total - 3000);
    expect(bmSpent(f, f.A)).toBe(3000);
    // pay 5,000 next to the billing station (no docking) once money comes in
    co.credits = 100000;
    for (const s of ships(f, h.g)) s.pos = { x: f.a.pos.x + 1500, y: 0, z: f.a.pos.z };
    expect(f.sim.command(f.A, { c: 'lawPay', case: c.id, amount: 5000 })).toBeNull();
    expect(c.paid).toBe(8000); expect(unpaid(c)).toBe(total - 8000); expect(co.credits).toBe(95000);
    expect(c.fine).toBe(total);                                             // the total never changes
    expect(c.state).toBe('open');
    // pay the rest: closes as paid, no wanted score left; a repeated request finds nothing to pay
    expect(f.sim.command(f.A, { c: 'lawPay' })).toBeNull();
    expect(c.paid).toBe(total); expect(c.state).toBe('closed'); expect(c.end).toBe('paid');
    expect(co.credits).toBe(100000 - (total - 3000));
    expect(f.sim.command(f.A, { c: 'lawPay' })).toMatch(/미납 벌금이 없습니다/);
    expect(f.sim.command(f.A, { c: 'lawPay', case: c.id, amount: 10 })).toMatch(/미납 벌금이 없습니다/);
    expect(co.credits).toBe(100000 - (total - 3000));
    expect(lawSpent(f, f.A)).toBe(total - 3000);
    expect(bmSpent(f, f.A) + lawSpent(f, f.A)).toBe(total);
    expect(wanted(f.sim.st, f.A).level).toBe(0);
  });

  it('B03: a debt survives save / restore at every step (after the fine, after a partial payment, after full payment); nothing is created or lost', () => {
    const f = fixture();
    const co = f.sim.st.companies[f.A]; co.credits = 1000;
    const h = hauler(f, 'astra', { [HOT(f)]: 120 });
    guardInspect(f.sim, h.s, h.sysObj, 'r1', f.a);
    const id = smug(f, f.A)[0].id;
    let sim = new WorldSim(JSON.parse(f.sim.serialize()));
    const view = (s: WorldSim) => { const c = s.st.law!.cases[id]; return { fine: c.fine, paid: c.paid, state: c.state, credits: s.st.companies[f.A].credits, owed: s.st.companies[f.A].law?.unpaid }; };
    const v0 = view(f.sim); expect(view(sim)).toEqual(v0);
    // replaying the same inspection after the restart: nothing new
    const s2 = sim.st.ships[h.s.id];
    expect(guardInspect(sim, s2, sim.st.systems.astra, 'r1', sim.st.stations.astra)).toBe(0);
    expect(view(sim)).toEqual(v0);
    sim.st.companies[f.A].credits = 2000;
    for (const id2 of h.g.shipIds) sim.st.ships[id2].pos = { x: f.a.pos.x + 1000, y: 0, z: f.a.pos.z };
    expect(sim.command(f.A, { c: 'lawPay', amount: 2000 })).toBeNull();
    const v1 = view(sim);
    expect(v1.paid).toBe(3000);
    sim = new WorldSim(JSON.parse(sim.serialize()));
    expect(view(sim)).toEqual(v1);
    sim.st.companies[f.A].credits = 1e6;
    expect(sim.command(f.A, { c: 'lawPay' })).toBeNull();
    const v2 = view(sim); expect(v2.state).toBe('closed'); expect(v2.paid).toBe(v2.fine);
    sim = new WorldSim(JSON.parse(sim.serialize()));
    expect(view(sim)).toEqual(v2);
    expect(sim.command(f.A, { c: 'lawPay' })).toMatch(/미납 벌금이 없습니다/);
    // the case ID and its key: a re-sent crime with the same key returns the same closed case, unchanged
    const c = sim.st.law!.cases[id];
    const again = lawCrime(sim, { kind: 'smuggling', by: f.A, sys: 'astra', pos: c.pos, value: c.value, key: c.key, how: 'inspection', fine: 99999, paid: 0, served: true });
    expect(again?.id).toBe(id); expect(view(sim)).toEqual(v2);
  });

  it('B04: a stop of a broke company — the seizure fine and the crime fine are both kept, each once; the inspection is not repeated and the guards do not come back for it', () => {
    const f = fixture();
    const co = f.sim.st.companies[f.A]; co.credits = 0;
    const g = fleet(f, f.A, f.at(5000, 3000), ['hauler']);
    const s = ships(f, g)[0]; s.cargo[HOT(f)] = 80; s.cargo.eq_heavy_cannon = 2;
    const ext = lawCrime(f.sim, { kind: 'extortion', by: f.A, group: g.id, ship: s.id, sys: 'astra', pos: s.pos, value: 20000, key: 'b4' })!;
    expect(ext.known).toBe(true);
    run(f.sim, 2);
    const op = Object.values(lawBook(f.sim.st).ops)[0];
    expect(op).toBeDefined();
    expect(until(f.sim, () => op.end !== undefined, 700)).toBe(true);    // offline / unanswered → comply → inspected
    expect(op.end).toBe('inspected');
    expect(qty(s.cargo, HOT(f))).toBe(0); expect(qty(s.cargo, 'eq_heavy_cannon')).toBe(0);
    expect(customs(f, f.B, 'electronics')).toBe(80);
    const sm = smug(f, f.A); expect(sm.length).toBe(1);
    expect(sm[0].creditor).toBe(f.sim.st.groups[op.guards[0]]?.npc?.home ?? op.home);
    expect(co.credits).toBe(0);
    expect(co.law?.unpaid).toBe(unpaid(ext) + unpaid(sm[0]));
    expect(unpaid(ext)).toBe(ext.fine); expect(unpaid(sm[0])).toBe(sm[0].fine);
    // both are enforced now: no further dispatch for this group, however long it waits
    const nOps = Object.keys(lawBook(f.sim.st).ops).length;
    run(f.sim, 400);
    expect(Object.values(lawBook(f.sim.st).ops).filter(o => o.target === g.id && o.end === undefined).length).toBe(0);
    expect(Object.keys(lawBook(f.sim.st).ops).length).toBeLessThanOrEqual(nOps);
    expect((co.bm?.log ?? []).filter(e => e.k === 'seize').length).toBe(1);
  });

  it('B05: where no Union guard enforces, a seizure debt is still payable — next to the billing station only (never orphaned)', () => {
    const f = fixture();
    const st = f.sim.st, pol = policedSystems(f.sim);
    const stn = Object.values(st.stations).find(x => {
      const sys = sysAt(st.systems, x.pos);
      return x.public && sys && !pol.has(sys.id) && !lawlessSys(sys) && effSec(sys) >= BM.secFloor + 5;
    });
    expect(stn, 'a public station in record-only space').toBeDefined();
    const sys = sysAt(st.systems, stn!.pos)!;
    expect(jurisdiction(f.sim, sys.id)).toMatchObject({ auth: null });
    BM.dockBase = 1; BM.maxChance = 1;
    const co = st.companies[f.A]; co.credits = 0;
    const g = fleet(f, f.A, { x: stn!.pos.x + 300, y: 0, z: stn!.pos.z }, ['hauler']);
    const s = ships(f, g)[0]; s.cargo[HOT(f)] = 90;
    expect(inspect(f.sim, s, 'dock', sys, stn)).toBe('seize');
    const c = smug(f, f.A)[0];
    expect(c.auth).toBeNull(); expect(c.creditor).toBe(stn!.id); expect(unpaid(c)).toBe(c.fine);
    expect(wanted(st, f.A).score).toBe(0);                                 // no Union warrant for it
    expect(co.law?.unpaid).toBe(c.fine);                                    // but the company sees the debt
    co.credits = 1e6;
    // near a policed Union station: not this authority's debt
    for (const x of ships(f, g)) x.pos = { x: f.a.pos.x + 1000, y: 0, z: f.a.pos.z };
    expect(f.sim.command(f.A, { c: 'lawPay' })).toMatch(new RegExp(stn!.name));
    // next to the billing station: paid, money to that station's authority
    const f0 = stn!.funds ?? 0;
    for (const x of ships(f, g)) x.pos = { x: stn!.pos.x + 1500, y: 0, z: stn!.pos.z };
    expect(f.sim.command(f.A, { c: 'lawPay' })).toBeNull();
    expect(c.paid).toBe(c.fine); expect(c.state).toBe('closed');
    if (stn!.fundsMax !== undefined && f0 < stn!.fundsMax) expect(stn!.funds!).toBeGreaterThan(f0);
  });
});

describe('P13.4.1 C — when a smuggling case closes', () => {
  it('C01: seized and paid in full → closed at once (end: paid), no wanted score, history kept; a pass makes no case', () => {
    const f = fixture();
    const h = hauler(f, 'astra', { [HOT(f)]: 30 });
    guardInspect(f.sim, h.s, h.sysObj, 'c1', f.a);
    const c = smug(f, f.A)[0];
    expect(c).toMatchObject({ state: 'closed', end: 'paid' }); expect(c.paid).toBe(c.fine); expect(c.fine).toBeGreaterThan(0);
    expect(wanted(f.sim.st, f.A).score).toBe(0);
    expect(f.sim.st.companies[f.A].law?.cases.find(x => x.id === c.id)).toMatchObject({ state: 'closed', fine: c.fine, paid: c.fine, served: true });
    // a clean hauler passes: nothing recorded as a crime
    const ok = hauler(f, 'astra', { ore: 40 });
    expect(guardInspect(f.sim, ok.s, ok.sysObj, 'c1b', f.a)).toBe(0);
    expect(smug(f, f.A).length).toBe(1);
  });

  it('C02: a second seizure is a new case — the closed one is never reopened; each keeps its own fine', () => {
    const f = fixture();
    BM.dockBase = 1; BM.maxChance = 1;
    const g = fleet(f, f.A, f.at(300, 0), ['hauler']); const s = ships(f, g)[0];
    s.cargo[HOT(f)] = 20;
    expect(inspect(f.sim, s, 'dock', f.sim.st.systems.astra, f.a)).toBe('seize');
    const [c1] = smug(f, f.A); expect(c1.state).toBe('closed');
    const fine1 = c1.fine;
    s.cargo[HOT(f, 'alloy')] = 30;                                           // new goods, same inspection window
    expect(inspect(f.sim, s, 'dock', f.sim.st.systems.astra, f.a)).toBe('seize');
    const all = smug(f, f.A); expect(all.length).toBe(2);
    expect(all[0].id).toBe(c1.id); expect(all[0].fine).toBe(fine1); expect(all[0].state).toBe('closed');
    expect(all[1].key).not.toBe(all[0].key); expect(all[1].state).toBe('closed');
  });

  it('C03: an existing world — cases made before P13.4.1 (smuggling with fine 0) are not billed retroactively', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(300, 0), ['hauler']);
    const old = lawCrime(f.sim, { kind: 'smuggling', by: f.A, group: g.id, sys: 'astra', pos: f.at(300, 0), value: 9000, key: 'old:1', how: 'inspection' })!;
    expect(old.fine).toBe(0); expect(old.fixed).toBeUndefined();
    const save = JSON.parse(f.sim.serialize());
    const sim = new WorldSim(save);
    run(sim, 10);
    expect(sim.st.law!.cases[old.id].fine).toBe(0);
    expect(sim.command(f.A, { c: 'lawPay' })).toMatch(/미납 벌금이 없습니다/);
  });
});

describe('P13.4.1 D — privacy', () => {
  it('D01: fines, debts and creditors are in the owner\'s view only', () => {
    const f = fixture();
    f.sim.st.companies[f.A].credits = 0;
    const h = hauler(f, 'astra', { [HOT(f)]: 50 });
    guardInspect(f.sim, h.s, h.sysObj, 'd1', f.a);
    const lv = (co: string) => legacyView(f.sim.st, { company: co } as any, 'astra') as any;
    const mine = lv(f.A), theirs = lv(f.C), victim = lv(f.B);
    expect(mine.companies[f.A].law.unpaid).toBeGreaterThan(0);
    expect(mine.companies[f.A].law.fined).toBe(mine.companies[f.A].law.unpaid);
    for (const v of [theirs, victim]) {
      expect(v.companies[f.A]?.law).toBeUndefined();
      expect(v.companies[f.A]?.bm).toBeUndefined();
      expect(v.law).toBeUndefined();
    }
  });
});
