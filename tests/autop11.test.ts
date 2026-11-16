// AUTO-P1.1: a mining hauler's sale trip that finds no market comes back to its station; a damaged mining hauler
// docked with cargo at a repair station is repaired there. A-3.1 miner start (3 miners + 1 hauler), seed 21.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { addc, qty, type Station } from '../src/world/types';
import { companyStock } from '../src/world/operations';
import { MINER_TRIP_GIVEUP } from '../src/world/procurement';
import { repairQuote } from '../src/world/repair';

function start() {
  const sim = WorldSim.create(21, { ...STANDARD_WORLD });
  const me = sim.addPlayer('복귀 시험', 'miner'), co = sim.st.companies[me];
  const port = sim.st.stations.p9_anvil_port;
  const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
  const hauler = sim.subtreeShips(g).find(s => s.classId === 'hauler')!;
  expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } })).toBeNull();
  expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_titanium', deliver: port.id, sell: true } })).toBeNull();
  return { sim, me, co, port, g, hauler };
}
/** every unit of the item the company has, wherever it is (stores, holds, reservations), plus what it has sold */
const ledger = (sim: WorldSim, me: string, item: string) => {
  let n = 0;
  for (const st of Object.values(sim.st.stations)) n += qty(st.storage[me], item);
  for (const s of Object.values(sim.st.ships)) if (s.owner === me) n += qty(s.cargo, item);
  for (const j of Object.values(sim.st.logisticsJobs ?? {})) if (j.owner === me) { if (j.state !== 'complete' && j.state !== 'cancelled') n += j.reserved; n += j.delivered; }
  return n;
};
const minerJobs = (sim: WorldSim, me: string) => Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.miner);
/** markets that buy silicate: budgeted ones are starved of funds, the others stop buying — until `restore` */
function closeMarkets(sim: WorldSim) {
  const list = Object.values(sim.st.stations).filter(s => s.market?.silicate);
  const funds = new Map(list.map(s => [s.id, s.funds])), books = new Map(list.map(s => [s.id, s.market!.silicate]));
  const budgeted = (s: Station) => s.public && funds.get(s.id) !== undefined;
  const hold = () => { for (const s of list) if (budgeted(s)) s.funds = 0; else delete s.market!.silicate; };
  const restore = () => { for (const s of list) if (budgeted(s)) s.funds = Math.max(funds.get(s.id)!, 2e5); else s.market!.silicate = books.get(s.id)!; };
  return { hold, restore, budgetedCount: list.filter(budgeted).length };
}
/** a trip under way with 400 silicate; every market then closes until the hauler gives up and turns home */
function strandedTrip() {
  const f = start();
  const { sim, me, port, hauler } = f;
  addc(sim.storage(port, me), 'silicate', 400);
  for (let i = 0; i < 1500 && !(hauler.logisticsJob && qty(hauler.cargo, 'silicate') > 0); i++) sim.update(1);
  const j = minerJobs(sim, me)[0]; expect(j?.carried).toBeGreaterThan(0);
  const before = ledger(sim, me, 'silicate'), load = j.carried + j.reserved + j.delivered;
  const m = closeMarkets(sim); expect(m.budgetedCount).toBeGreaterThan(0);
  let waitedFrom = -1;
  for (let i = 0; i < 4000 && !j.returning; i++) { m.hold(); sim.update(1); if (waitedFrom < 0 && j.state === 'waiting') waitedFrom = sim.time; }
  expect(j.returning).toBe(true);
  expect(j.to).toBe(port.id);
  expect(sim.time - waitedFrom).toBeGreaterThanOrEqual(MINER_TRIP_GIVEUP - 15);   // waited about the give-up time first
  expect(j.reason).toMatch(/복귀/);
  expect(j.carried + j.reserved + j.delivered + j.withdrawn + j.lost).toBeCloseTo(load, 6);   // the trip's goods: none lost or doubled
  expect(qty(hauler.cargo, 'silicate')).toBeGreaterThanOrEqual(j.carried - 1e-6);
  expect(ledger(sim, me, 'silicate')).toBeGreaterThanOrEqual(before - 1e-6);   // mining only adds
  return { ...f, j, m, before, load };
}

describe('AUTO-P1.1 sale trip comes home when no market will buy', () => {
  it('budget exhausted, no other market: after 15 min it flies back, stores the cargo; survives save/restore; backs off, then sells once markets recover', () => {
    const { sim, me, j, before, load } = strandedTrip();
    // save and restore during the return leg
    const s2 = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const j2 = s2.st.logisticsJobs![j.id], co2 = s2.st.companies[me], port2 = s2.st.stations.p9_anvil_port, h2 = s2.st.ships[j.ship!];
    expect(j2.returning).toBe(true); expect(h2.logisticsJob).toBe(j.id); expect(co2.credits).toBe(sim.st.companies[me].credits);
    const m2 = closeMarkets(s2);
    const stored0 = qty(port2.storage[me], 'silicate'), carried = j2.carried;
    for (let i = 0; i < 3000 && j2.state !== 'cancelled'; i++) { m2.hold(); s2.update(1); }
    expect(j2.state).toBe('cancelled');                      // ended at home: nothing left aboard
    expect(qty(h2.cargo, 'silicate')).toBeLessThan(1e-6);
    expect(qty(port2.storage[me], 'silicate')).toBeGreaterThanOrEqual(stored0 + carried - 1e-6);
    expect(j2.withdrawn).toBeCloseTo(carried, 6);
    expect(j2.delivered + j2.withdrawn + j2.lost).toBeCloseTo(load, 6);
    expect(ledger(s2, me, 'silicate')).toBeGreaterThanOrEqual(before - 1e-6);   // nothing lost or counted twice (mining adds)
    const retry = co2.procurement!.minerTripRetry!.silicate; expect(retry.fails).toBe(1);
    expect(h2.logisticsJob).toBeUndefined();                  // back to mining haul
    // markets recover: no new trip before the back-off ends, a sale after it
    m2.restore();
    const jobs0 = minerJobs(s2, me).length;
    let early = 0;
    for (let i = 0; i < 4000 && !minerJobs(s2, me).slice(jobs0).some(x => x.state === 'complete'); i++) { s2.update(1); if (s2.time < retry.at - 1e-6 && minerJobs(s2, me).length > jobs0) early++; }
    expect(early).toBe(0);
    const again = minerJobs(s2, me).slice(jobs0).find(x => x.state === 'complete')!;
    expect(again).toBeTruthy(); expect(again.delivered).toBeGreaterThan(0);
    expect(co2.procurement!.minerTripRetry?.silicate).toBeUndefined();   // a sale clears the back-off
    // only the one hauler ever carried
    expect(new Set(minerJobs(s2, me).map(x => x.ship ?? h2.id))).toEqual(new Set([h2.id]));
  });

  it('home store full: the cargo stays aboard as the trip\'s (counted once); stored when room appears or sold when a market recovers', () => {
    const { sim, me, co, port, hauler, j, m } = strandedTrip();
    for (let i = 0; i < 3000 && sim.time >= 0 && !(hauler.state === 'docked' && hauler.task.k === 'docked' && hauler.task.station === port.id); i++) {
      m.hold(); if (sim.room(port, me) > 0) addc(sim.storage(port, me), 'crystal', sim.room(port, me)); sim.update(1);
    }
    for (let i = 0; i < 30; i++) { m.hold(); if (sim.room(port, me) > 0) addc(sim.storage(port, me), 'crystal', sim.room(port, me)); sim.update(1); }
    expect(j.code).toBe('returned'); expect(j.state).toBe('waiting');
    expect(j.carried).toBeGreaterThan(0); expect(qty(hauler.cargo, 'silicate')).toBeGreaterThanOrEqual(j.carried - 1e-6);
    expect(j.reason).toMatch(/창고 가득.*함선에 보존/);
    const c = companyStock(sim.st, me, 'silicate');
    expect(c.selling).toBeGreaterThanOrEqual(j.carried - 1e-6);
    // every unit once: stores + every job's reservation + every hold
    let raw = 0; for (const st of Object.values(sim.st.stations)) raw += qty(st.storage[me], 'silicate');
    for (const s of Object.values(sim.st.ships)) if (s.owner === me) raw += qty(s.cargo, 'silicate');
    for (const x of Object.values(sim.st.logisticsJobs!)) if (x.owner === me && x.state !== 'complete' && x.state !== 'cancelled') raw += x.reserved;
    expect(c.total).toBeCloseTo(raw, 6);
    expect(co.procurement!.salesStatus!.silicate.reason).toMatch(/복귀/);
    // markets recover after the back-off: the same cargo goes out again and is sold
    const retry = co.procurement!.minerTripRetry!.silicate;
    m.restore();
    const credits0 = co.credits, sold0 = j.delivered;
    for (let i = 0; i < 5000 && j.state !== 'complete'; i++) { if (sim.room(port, me) > 0) addc(sim.storage(port, me), 'crystal', sim.room(port, me)); sim.update(1); }
    expect(j.state).toBe('complete'); expect(j.returning).toBeUndefined();
    expect(sim.time).toBeGreaterThanOrEqual(retry.at);
    expect(j.delivered).toBeGreaterThan(sold0); expect(co.credits).toBeGreaterThan(credits0 - 5000);
    expect(j.earned).toBeGreaterThan(0);
  });
});

describe('AUTO-P1.1 automatic repair of a damaged mining hauler with cargo aboard', () => {
  it('docked at a repair station and unable to unload: repaired in place with its cargo kept, within the approved limits', () => {
    const { sim, me, co, port, hauler } = start();
    (sim as any).dockShip(hauler, port);
    hauler.hp = 0.2; addc(hauler.cargo, 'silicate', 60);
    addc(sim.storage(port, me), 'crystal', sim.room(port, me));   // the store is full: it cannot unload
    const quote = repairQuote(sim.st, hauler, co).cost;
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: 1000, maxPerRepair: quote + 1, perHour: quote + 1 } })).toBeNull();
    const c0 = co.credits;
    for (let i = 0; i < 12; i++) { addc(sim.storage(port, me), 'crystal', sim.room(port, me)); sim.update(1); }
    expect(hauler.hp).toBe(1);
    expect(qty(hauler.cargo, 'silicate')).toBe(60);
    expect(c0 - co.credits).toBeGreaterThanOrEqual(quote - 1e-6);
    expect(co.procurement!.repair!.log!.map(x => x.n)).toEqual([quote]);
  });

  it('the same hauler over the hourly budget is not repaired and keeps its cargo; one away from a repair yard with cargo waits to unload', () => {
    const { sim, me, co, port, hauler } = start();
    (sim as any).dockShip(hauler, port);
    hauler.hp = 0.2; addc(hauler.cargo, 'silicate', 60);
    addc(sim.storage(port, me), 'crystal', sim.room(port, me));
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: 0, maxPerRepair: 1e6, perHour: 10 } })).toBeNull();
    sim.update(1);   // the docked decision
    expect(hauler.hp).toBe(0.2); expect(qty(hauler.cargo, 'silicate')).toBe(60);
    expect(co.procurement!.repair!.status![hauler.id].reason).toMatch(/시간당 수리 예산/);
    // no repair yard here: a loaded mining hauler is not sent off to one
    port.services.repair = false;
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: 0, maxPerRepair: 1e6, perHour: 1e6 } })).toBeNull();
    for (let i = 0; i < 12; i++) { addc(sim.storage(port, me), 'crystal', sim.room(port, me)); sim.update(1); }
    expect(hauler.repairAt).toBeUndefined(); expect(hauler.hp).toBe(0.2);
    expect(co.procurement!.repair!.status![hauler.id].reason).toMatch(/화물 하역 후/);
  });
});
