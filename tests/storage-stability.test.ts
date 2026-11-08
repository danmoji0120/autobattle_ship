import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { leaseAccrual, setLease, serviceOf, publicCap, storeUsed } from '../src/world/storage';
import { stepUpkeep } from '../src/world/upkeep';
import { MODULES } from '../src/world/data';
import { normPlan } from '../src/world/construction';
import { cargoSum, qty, type Station } from '../src/world/types';

function fixture() {
  const sim = WorldSim.create(871);
  const p = sim.addPlayer('창고 검증');
  const co = sim.st.companies[p]; co.credits = 100000;
  const st = sim.st.stations.astra;
  return { sim, p, co, st };
}

describe('storage stability', () => {
  it('prepaid first hour, independently added blocks, release and reload never bill twice', () => {
    const { sim, co, st } = fixture();
    const rate = serviceOf(st).lease, start = co.credits;
    expect(setLease(sim.st, co, st, 1)).toBeNull();
    sim.st.time += 1800;
    expect(leaseAccrual(sim.st, co, 1800)).toBe(0);
    expect(setLease(sim.st, co, st, 2)).toBeNull();
    const loaded = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const c = loaded.st.companies[co.id];
    loaded.st.time += 1800;
    expect(leaseAccrual(loaded.st, c, 1800)).toBe(0);
    loaded.st.time += 900;
    expect(leaseAccrual(loaded.st, c, 900)).toBeCloseTo(rate / 4);
    expect(setLease(loaded.st, c, loaded.st.stations.astra, 1)).toBeNull();
    loaded.st.time += 900;
    expect(leaseAccrual(loaded.st, c, 900)).toBeCloseTo(rate / 4);
    // Returning the newest block flushes the oldest block’s actual 15 minutes of postpaid use.
    expect(c.credits).toBe(start - 2 * rate - rate / 4);
    expect(c.upkeep!.total.credits).toBe(2 * rate + rate / 4);
    expect(setLease(loaded.st, c, loaded.st.stations.astra, NaN)).toMatch(/정수/);
  });

  it('legacy leases accrue without inventing prepayments; arrears and released inventory survive', () => {
    const { sim, co, st } = fixture();
    for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
    co.leases = { astra: 2 }; co.credits = 0;
    st.storage[co.id].ore = publicCap(co, st) + 900;
    co.upkeep = undefined;
    sim.st.time += 60;
    stepUpkeep(sim.st, co, 60);
    expect(co.upkeep!.debt).toBeCloseTo(serviceOf(st).lease * 2 / 60);
    const debt = co.upkeep!.debt, goods = st.storage[co.id].ore;
    expect(setLease(sim.st, co, st, 0)).toBeNull();
    expect(co.upkeep!.debt).toBe(debt);
    expect(st.storage[co.id].ore).toBe(goods);
    expect(new WorldSim(JSON.parse(sim.serialize())).st.companies[co.id].upkeep!.debt).toBe(debt);
  });

  it('automatic delivery rejects full or unaffordable markets, retains cargo with one warning, resumes when space opens', () => {
    const { sim, p, co, st } = fixture();
    const g = Object.values(sim.st.groups).find(g => g.owner === p && g.op.k === 'idle' && g.shipIds.some(id => sim.st.ships[id].classId === 'miner'))!;
    for (const x of Object.values(sim.st.stations)) if (x.public) { x.storage[p].ore = publicCap(co, x); x.funds = 0; }
    expect(sim.autoDeliver(p, 'kestrel', true)).toBeNull();
    const unavailable = sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } });
    expect(unavailable).toMatch(/창고 가득.*임대.*화물.*보존/);
    expect(unavailable).not.toMatch(/사라짐/);
    expect(g.op.k).toBe('idle');
    const op = { k: 'mine' as const, field: 'kestrel', deliver: st.id, sell: true, auto: true };
    g.op = op;
    const miner = sim.st.ships[g.shipIds.find(id => sim.st.ships[id].classId === 'miner')!];
    miner.cargo.ore = 100;
    const before = cargoSum(miner.cargo);
    expect((sim as any).mineDock(g, op)).toBeNull();
    expect((sim as any).mineDock(g, op)).toBeNull();
    expect(cargoSum(miner.cargo)).toBe(before);
    expect(sim.st.events.filter(e => e.company === p && e.kind === 'warn' && e.text.includes('하역')).length).toBe(1);
    st.storage[p].ore -= 250;
    expect((sim as any).mineDock(g, op).id).toBe(st.id);
    (sim as any).unload(miner, st, true);
    expect(cargoSum(miner.cargo)).toBe(0);
    expect(qty(st.storage[p], 'ore')).toBe(publicCap(co, st) - 150);
  });

  it('battle recovery overflow remains conserved and is deposited exactly once after save/reload', () => {
    const { sim, p, co, st } = fixture();
    st.storage[p].ore = publicCap(co, st);
    // Force this to be the original nearest destination, regardless of other warehouses' free space.
    (sim as any).salvageWrecks(co, Array.from({ length: 30 }, () => ({ eq_laser: 4 })), 1, st.pos, []);
    const pending = co.pendingLoot?.[st.id];
    expect(storeUsed(pending)).toBeGreaterThan(0);
    const expected = { ...pending };
    const loaded = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const c = loaded.st.companies[p], target = loaded.st.stations.astra;
    target.storage[p].ore = 0;
    (loaded as any).recoverLoot(c);
    for (const [k, n] of Object.entries(expected!)) expect(qty(target.storage[p], k)).toBe(n);
    const after = JSON.stringify(target.storage[p]);
    (loaded as any).recoverLoot(c);
    expect(JSON.stringify(target.storage[p])).toBe(after);
    expect(c.pendingLoot?.[st.id]).toBeUndefined();
    const events = loaded.st.eventSeq;
    (loaded as any).finishEngagement({ done: true }, {});
    expect(loaded.st.eventSeq).toBe(events);
  });

  it('unfinished cores accept only missing construction materials and preserve legacy overstock across completion', () => {
    const { sim, p, st } = fixture();
    const own: Station = { ...structuredClone(st), id: 'building', owner: p, public: false, market: null, storage: { [p]: { ore: 90000 } }, modules: [normPlan({ kind: 'core', progress: 0, built: false, slot: 0 }, () => 'core-plan')] };
    sim.st.stations[own.id] = own;
    const ship = Object.values(sim.st.ships).find(s => s.owner === p)!;
    ship.cargo = { ore: 1000, alloy: 10000, crystal: 10000 };
    (sim as any).unload(ship, own, false);
    expect(qty(own.storage[p], 'ore')).toBe(90000);
    for (const [k, n] of Object.entries(MODULES.core.mats)) expect(qty(own.storage[p], k)).toBeCloseTo(n);
    expect(ship.cargo.ore).toBe(1000);
    expect(sim.intakeRoom(own, p, 'ore')).toBe(0);
    own.modules[0].built = true;
    const loaded = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(loaded.st.stations.building.storage[p].ore).toBe(90000);
    expect(loaded.room(loaded.st.stations.building, p)).toBe(0);
  });
  it('preserves fractional sale leftovers and stores blueprint records without consuming warehouse space', () => {
    const { sim, p, st, co } = fixture();
    const ship = Object.values(sim.st.ships).find(s => s.owner === p)!;
    st.funds = 0; ship.cargo = { ore: .005 };
    (sim as any).unload(ship, st, true);
    expect(qty(ship.cargo, 'ore') + qty(st.storage[p], 'ore')).toBeCloseTo(.005, 12);
    st.storage[p].ore = publicCap(co, st);
    ship.cargo = { ore: .005, 'bpf:bp_destroyer_mk1': 3 };
    (sim as any).unload(ship, st, false);
    expect(qty(ship.cargo, 'ore')).toBe(.005);
    expect(qty(st.storage[p], 'bpf:bp_destroyer_mk1')).toBe(3);
    expect(storeUsed(st.storage[p])).toBe(publicCap(co, st));
  });

  it('a new child mining order inspects the child cargo instead of an unrelated inherited parent operation', () => {
    const { sim, p, co, st } = fixture();
    const miners = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.filter(id => sim.st.ships[id].classId === 'miner').length === 2)!;
    const ship = sim.st.ships[miners.shipIds[0]], other = sim.st.ships[miners.shipIds[1]];
    const child = sim.newGroup(p, '독립 채굴반', miners.id);
    expect(sim.command(p, { c: 'moveShip', ship: ship.id, group: child.id })).toBeNull();
    other.cargo = { legacy_untradeable: 5 };
    for (const x of Object.values(sim.st.stations)) if (x.public) { x.storage[p].ore = publicCap(co, x); x.funds = 0; }
    st.funds = 10000;
    expect(sim.command(p, { c: 'setOp', group: child.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } })).toBeNull();
    expect(child.op.k).toBe('mine');
    expect(miners.op.k).toBe('idle');
    expect(other.cargo.legacy_untradeable).toBe(5);
  });

});
