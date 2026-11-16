// AUTO-P1: stock accounting by purpose, mining-hauler sale round trips, conditional automatic repair.
// Every scenario uses the A-3.1 miner start as it is (three miners and one hauler); no hauler is added unless a test
// says so (the pool-preference check).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { addc, qty } from '../src/world/types';
import { companySaleCap, companyStock, createGoal } from '../src/world/operations';
import { planMinerSaleTrip } from '../src/world/procurement';
import { repairQuote } from '../src/world/repair';

const run = (sim: WorldSim, s: number, each?: (t: number) => void) => { for (let i = 1; i <= s; i++) { sim.update(1); each?.(i); } };
function start() {
  const sim = WorldSim.create(21, { ...STANDARD_WORLD });
  const me = sim.addPlayer('채굴 왕복', 'miner'), co = sim.st.companies[me];
  const port = sim.st.stations.p9_anvil_port;
  const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
  const ships = sim.subtreeShips(g), hauler = ships.find(s => s.classId === 'hauler')!;
  expect(ships.filter(s => s.classId === 'miner')).toHaveLength(3);
  expect(ships.filter(s => s.classId === 'hauler')).toHaveLength(1);
  const mine = () => expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_titanium', deliver: port.id, sell: true } })).toBeNull();
  return { sim, me, co, port, g, hauler, mine };
}
const sellSilicate = (sim: WorldSim, me: string, minPrice = 5) => expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice } })).toBeNull();
const allOf = (sim: WorldSim, me: string, item: string) => {
  let n = 0;
  for (const st of Object.values(sim.st.stations)) n += qty(st.storage[me], item);
  for (const s of Object.values(sim.st.ships)) if (s.owner === me) n += qty(s.cargo, item);
  for (const j of Object.values(sim.st.logisticsJobs ?? {})) if (j.owner === me && j.state !== 'complete' && j.state !== 'cancelled') n += j.reserved;
  return n;
};
const minerJobs = (sim: WorldSim, me: string) => Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.miner);

describe('AUTO-P1 stock accounting by purpose', () => {
  it('secured stock, incoming shipments and untracked cargo are told apart; only secured stock bounds a sale', () => {
    const { sim, me, port, hauler, g } = start();
    addc(sim.storage(port, me), 'ore', 600);
    // the hauler leaves the mining fleet and carries 300 ore to another store (a normal shipment under way)
    expect(sim.command(me, { c: 'newGroup', name: '수송반', ships: [hauler.id] })).toBeNull();
    const other = sim.st.stations.astra;
    expect(sim.command(me, { c: 'poolCreate', request: { from: port.id, to: other.id, item: 'ore', kind: 'transfer', amount: 300, priority: 5, repeat: false } })).toBeNull();
    run(sim, 40);
    const j = Object.values(sim.st.logisticsJobs!).find(x => x.owner === me && x.kind === 'transfer')!;
    expect(j.carried + j.reserved).toBeCloseTo(300, 6);
    // a miner carries untracked ore of its own
    const miner = sim.subtreeShips(g).find(s => s.classId === 'miner')!; addc(miner.cargo, 'ore', 50);
    const c = companyStock(sim.st, me, 'ore');
    expect(c.stored).toBeCloseTo(300, 6);
    expect(c.incoming).toBeCloseTo(300, 6);
    expect(c.afloat).toBeCloseTo(50, 6);
    expect(c.total).toBeCloseTo(650, 6);                       // every physical unit once
    // a 500 company target: 300 secured + 300 under way + 50 afloat — the 300 in the store may not be sold
    expect(createGoal(sim, me, { k: 'stockpile', station: port.id, item: 'ore', target: 500, maintain: true, buy: true, produce: false, scope: 'company' })).toBeNull();
    expect(companySaleCap(sim, me, 'ore')).toBe(0);
    const w = Object.values(sim.st.works!).find(x => x.owner === me && x.goal?.k === 'stockpile')!;
    run(sim, 2);
    expect(w.progress?.done).toBeCloseTo(300, 6);               // progress counts what is stored, not what is coming
    expect(Object.values(sim.st.approvals ?? {}).filter(a => a.work === w.id && a.state === 'open')).toHaveLength(0);   // the shipment covers it: no purchase
  });
});

describe('AUTO-P1 mining hauler sale round trips (3 miners + 1 hauler)', () => {
  it('turned off explicitly ("mining haul only"): the mining hauler only collects, the excess stays and the reason says so', () => {
    const { sim, me, co, port, mine } = start();
    sellSilicate(sim, me); mine();
    expect(sim.command(me, { c: 'autoOpsPolicy', minerSales: false })).toBeNull();
    run(sim, 900);
    expect(minerJobs(sim, me)).toHaveLength(0);
    expect(co.procurement!.minerSales).toBe(false);
    expect(qty(sim.storage(port, me), 'silicate')).toBeGreaterThan(100);
    expect(co.procurement!.salesStatus!.silicate.reason).toMatch(/공용 수송선 없음.*채굴 운반 전용/);
  });

  it('on by default once an item is set to auto-sell (new miner, sales policy only): the hauler sells the excess at another market, keeps 500 ore, returns to mining, miners unload meanwhile', () => {
    const { sim, me, co, port, hauler, g, mine } = start();
    sellSilicate(sim, me);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 1, station: port.id, keep: 500 } })).toBeNull();
    expect(co.procurement!.minerSales).toBeUndefined();   // never chosen: trips allowed
    mine();
    let minersDocked = 0, oreLow = Infinity, collectedAfter = false, tripSeen = 0, lastOre = 0;
    const minerOre = () => sim.subtreeShips(g).filter(s => s.classId === 'miner').reduce((n, s) => n + qty(s.cargo, 'ore'), 0);
    run(sim, 2400, t => {
      if (hauler.logisticsJob) tripSeen = t;
      const mo = minerOre();
      if (hauler.logisticsJob && mo < lastOre - 1 && qty(hauler.cargo, 'ore') === 0) minersDocked++;   // a miner emptied its hold while the hauler was away
      lastOre = mo;
      if (t > 900) oreLow = Math.min(oreLow, qty(sim.storage(port, me), 'ore'));
      if (tripSeen && !hauler.logisticsJob && t > tripSeen + 5 && qty(hauler.cargo, 'ore') > 0) collectedAfter = true;
    });
    const done = minerJobs(sim, me).filter(j => j.state === 'complete');
    expect(done.length).toBeGreaterThanOrEqual(2);
    for (const j of done) { expect(j.to).not.toBe(port.id); expect(sim.st.stations[j.to].market?.silicate).toBeTruthy(); expect(j.earned / j.delivered).toBeGreaterThanOrEqual(5 - 1e-9); }
    expect(co.ops!.ledger.reduce((n, b) => n + (b.sales?.silicate ?? 0), 0)).toBeGreaterThan(0);
    expect(collectedAfter).toBe(true);                        // back to collecting ore after a trip
    expect(minersDocked).toBeGreaterThan(0);                  // miners unloaded themselves while the hauler was away
    expect(oreLow).toBeGreaterThanOrEqual(500 - 1e-6);
    expect(sim.room(port, me)).toBeGreaterThan(0);            // the store never filled
    expect(Object.values(sim.st.ships).filter(s => s.owner === me && s.logisticsJob).every(s => s.id === hauler.id)).toBe(true);   // only the hauler is ever given a trip
  });

  it('an idle pool hauler is preferred; a blocked market, a high floor price or the risk limit stop trips and keep the stock', () => {
    const { sim, me, co, port, hauler, mine } = start();
    sellSilicate(sim, me);
    expect(sim.command(me, { c: 'autoOpsPolicy', minerSales: true })).toBeNull();
    mine();
    addc(sim.storage(port, me), 'silicate', 400);
    const dockHauler = () => { for (const k of Object.keys(hauler.cargo)) delete hauler.cargo[k]; (sim as any).dockShip(hauler, port); };
    // 1. every silicate market closed
    const markets = Object.values(sim.st.stations).filter(s => s.market?.silicate), saved = markets.map(s => [s, s.market!.silicate] as const);
    for (const s of markets) delete s.market!.silicate;
    dockHauler();
    expect(planMinerSaleTrip(sim, hauler, port)).toBe(false);
    expect(co.procurement!.minerTrip!.reason).toMatch(/매입 시장 없음/);
    for (const [s, m] of saved) s.market!.silicate = m;
    // 2. floor price above every market
    sellSilicate(sim, me, 1e4);
    expect(planMinerSaleTrip(sim, hauler, port)).toBe(false);
    expect(co.procurement!.minerTrip!.reason).toMatch(/매입 시장 없음/);
    sellSilicate(sim, me);
    // 3. risk limit 0: no route qualifies
    co.procurement!.maxRisk = 0;
    expect(planMinerSaleTrip(sim, hauler, port)).toBe(false);
    co.procurement!.maxRisk = 100;
    expect(qty(sim.storage(port, me), 'silicate')).toBeGreaterThanOrEqual(400);
    // 4. an idle pool hauler takes the sale instead
    const spare = sim.spawnShip(me, 'hauler', 'std', sim.newGroup(me, '공용').id, port.pos); (sim as any).dockShip(spare, port);
    expect(planMinerSaleTrip(sim, hauler, port)).toBe(false);
    expect(co.procurement!.minerTrip!.reason).toMatch(/유휴 공용 수송선/);
    // 5. allowed again without the spare: the trip starts
    delete sim.st.ships[spare.id];
    expect(planMinerSaleTrip(sim, hauler, port)).toBe(true);
    expect(minerJobs(sim, me)).toHaveLength(1);
  });

  it('a fleet order change mid-trip ends the trip; the cargo is kept and comes back to the store', () => {
    const { sim, me, port, hauler, g, mine } = start();
    sellSilicate(sim, me);
    expect(sim.command(me, { c: 'autoOpsPolicy', minerSales: true })).toBeNull();
    mine(); addc(sim.storage(port, me), 'silicate', 400);
    for (let i = 0; i < 1200 && !(hauler.logisticsJob && qty(hauler.cargo, 'silicate') > 0); i++) sim.update(1);
    const j = minerJobs(sim, me)[0]; expect(j.carried).toBeGreaterThan(0);
    const before = allOf(sim, me, 'silicate') + j.delivered;
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    run(sim, 2);
    expect(j.state).toBe('cancelled'); expect(hauler.logisticsJob).toBeUndefined();
    expect(qty(hauler.cargo, 'silicate')).toBeGreaterThan(0);
    expect(allOf(sim, me, 'silicate') + j.delivered).toBeCloseTo(before, 6);
    // mining again: the hauler unloads the kept silicate at the fleet's station
    mine(); run(sim, 600);
    expect(qty(hauler.cargo, 'silicate')).toBeLessThan(1e-6);
    expect(allOf(sim, me, 'silicate') + minerJobs(sim, me).reduce((n, x) => n + x.delivered, 0)).toBeGreaterThanOrEqual(before - 1e-6);
  });

  it('the hauler lost mid-trip: the trip ends with the loss recorded; no other ship is sent', () => {
    const { sim, me, port, hauler, g, mine } = start();
    sellSilicate(sim, me);
    expect(sim.command(me, { c: 'autoOpsPolicy', minerSales: true })).toBeNull();
    mine(); addc(sim.storage(port, me), 'silicate', 400);
    for (let i = 0; i < 1200 && !(hauler.logisticsJob && qty(hauler.cargo, 'silicate') > 0); i++) sim.update(1);
    const j = minerJobs(sim, me)[0], carried = j.carried;
    delete sim.st.ships[hauler.id]; g.shipIds = g.shipIds.filter(id => id !== hauler.id);
    run(sim, 3);
    expect(j.state).toBe('cancelled'); expect(j.lost).toBeCloseTo(carried, 6);
    run(sim, 300);
    expect(Object.values(sim.st.logisticsJobs!).filter(x => x.owner === me && x.kind === 'sell' && x.ship)).toHaveLength(0);
  });

  it('save and restore mid-trip: the trip finishes and goods and money are conserved', () => {
    const { sim, me, co, port, hauler, mine } = start();
    sellSilicate(sim, me);
    expect(sim.command(me, { c: 'autoOpsPolicy', minerSales: true })).toBeNull();
    mine(); addc(sim.storage(port, me), 'silicate', 400);
    for (let i = 0; i < 1200 && !(hauler.logisticsJob && qty(hauler.cargo, 'silicate') > 0); i++) sim.update(1);
    const j = minerJobs(sim, me)[0];
    const saved = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const j2 = saved.st.logisticsJobs![j.id], h2 = saved.st.ships[hauler.id], co2 = saved.st.companies[me];
    expect(j2.miner).toBe(j.miner); expect(h2.logisticsJob).toBe(j.id); expect(co2.credits).toBe(co.credits);
    expect(qty(h2.cargo, 'silicate')).toBeCloseTo(qty(hauler.cargo, 'silicate'), 9);
    const c0 = co2.credits;
    for (let i = 0; i < 2400 && j2.state !== 'complete'; i++) saved.update(1);
    expect(j2.state).toBe('complete'); expect(j2.delivered).toBeGreaterThan(0);
    expect(co2.credits).toBeGreaterThan(c0);
    expect(h2.logisticsJob).toBeUndefined();
  });
});

describe('AUTO-P1 conditional automatic repair', () => {
  const damaged = () => {
    const f = start(); f.hauler.hp = 0.2;
    (f.sim as any).dockShip(f.hauler, f.port);
    return f;
  };
  it('off by default: a damaged hauler is not repaired and nothing is spent', () => {
    const { sim, co, hauler } = damaged();
    const c0 = co.credits; run(sim, 30);
    expect(hauler.hp).toBe(0.2); expect(co.credits).toBeLessThanOrEqual(c0);
    expect(co.procurement?.repair?.enabled ?? false).toBe(false);
  });

  it('allowed within the limits: repaired once at the station it is docked at, through the repair command', () => {
    const { sim, me, co, hauler, port } = damaged();
    expect(port.services.repair).toBe(true);
    const quote = repairQuote(sim.st, hauler, co).cost;
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: 1000, maxPerRepair: quote + 1, perHour: quote + 1 } })).toBeNull();
    const c0 = co.credits; run(sim, 12);
    expect(hauler.hp).toBe(1);
    expect(c0 - co.credits).toBeGreaterThanOrEqual(quote - 1e-6);
    expect(co.procurement!.repair!.log!.map(x => x.n)).toEqual([quote]);
    expect(Object.values(sim.st.works ?? {}).some(w => w.owner === me && /수리/.test(w.title ?? ''))).toBe(true);
  });

  it('over a limit (per repair, per hour, minimum balance): not repaired, the reason is shown, cargo kept', () => {
    const { sim, me, co, hauler } = damaged();
    addc(hauler.cargo, 'silicate', 50);
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: 0, maxPerRepair: 100, perHour: 1e6 } })).toBeNull();
    run(sim, 12);
    expect(hauler.hp).toBe(0.2); expect(co.procurement!.repair!.status![hauler.id].reason).toMatch(/1회 한도/);
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: 0, maxPerRepair: 1e6, perHour: 100 } })).toBeNull();
    run(sim, 12);
    expect(hauler.hp).toBe(0.2); expect(co.procurement!.repair!.status![hauler.id].reason).toMatch(/시간당 수리 예산/);
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: co.credits, maxPerRepair: 1e6, perHour: 1e6 } })).toBeNull();
    run(sim, 12);
    expect(hauler.hp).toBe(0.2); expect(co.procurement!.repair!.status![hauler.id].reason).toMatch(/최소 잔고/);
    expect(qty(hauler.cargo, 'silicate')).toBe(50);
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: 0, maxPerRepair: 0, perHour: 0 } })).not.toBeNull();   // no open-ended spending
  });

  it('no repair yard here: an idle pool hauler flies to the nearest reachable one, is repaired once and returns to the pool', () => {
    const { sim, me, co, hauler, port } = damaged();
    expect(sim.command(me, { c: 'newGroup', name: '수송반', ships: [hauler.id] })).toBeNull();
    port.services.repair = false;
    expect(sim.command(me, { c: 'autoOpsPolicy', repair: { enabled: true, minCredits: 0, maxPerRepair: 1e6, perHour: 1e6 } })).toBeNull();
    run(sim, 12);
    const target = hauler.repairAt?.station; expect(target).toBeTruthy(); expect(target).not.toBe(port.id);
    for (let i = 0; i < 3000 && hauler.hp < 1; i++) sim.update(1);
    expect(hauler.hp).toBe(1);
    expect(hauler.repairAt).toBeUndefined();
    expect(co.procurement!.repair!.log).toHaveLength(1);       // one repair, no duplicates
    run(sim, 30);
    expect(co.procurement!.repair!.log).toHaveLength(1);
  });
});
