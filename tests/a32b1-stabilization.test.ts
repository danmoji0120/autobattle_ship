// A-3.2b.1: beginner salvager survivability and business continuity — risk guidance (bands, hostile ships seen at
// the site, confirmation text), the operating status (정상 운영 / 능력 부족 / 운송 병목 / 사업 중단) with the A-2.1
// comeback route, and the salvage fleet hauler's sale round trip (AUTO-P1.1 rules). See docs/A3_2B_1_STABILIZATION.md.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { addc, qty, type WShip } from '../src/world/types';
import { DERELICT_CFG } from '../src/world/derelicts';
import { knownThreat, riskBand, salvageConfirm, salvageOperatingStatus, salvageOpportunities, SALVAGE_SELL_ITEMS, SITE_THREAT_R } from '../src/world/firstBusiness';
import { yardShipPrice, hullSale } from '../src/world/hullops';
import { CONTENT } from '../src/content/registry';

const run = (sim: WorldSim, s: number, each?: (t: number) => void) => { for (let i = 1; i <= s; i++) { sim.update(1); each?.(i); } };
const until = (sim: WorldSim, cond: () => boolean, s = 3600) => { for (let i = 0; i < s && !cond(); i++) sim.update(1); return cond(); };
/** `legacy`: the original salvager fleet (miner + constructor + hauler, hull-borne salvage) — a world without industrial hardpoints */
function start(seed = 21, legacy = false) {
  const sim = WorldSim.create(seed, { ...STANDARD_WORLD, ...(legacy ? { industrial: undefined } : {}) });
  const me = sim.addPlayer('인양 안정화', 'salvager'), co = sim.st.companies[me];
  const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
  const ships = () => Object.values(sim.st.ships).filter(s => s.owner === me);
  const home = sim.st.stations[co.homeStation!];
  return { sim, me, co, g, ships, home, hauler: ships().find(s => s.classId === 'hauler')!, miner: ships().find(s => s.classId === 'miner')!, cons: ships().find(s => s.classId === 'constructor')! };
}
const sellAll = (sim: WorldSim, me: string) => { for (const item of SALVAGE_SELL_ITEMS) expect(sim.command(me, { c: 'salesPolicy', settings: { item, sell: true, minPrice: 0 } })).toBeNull(); };
const salvJobs = (sim: WorldSim, me: string) => Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.salvTrip);
/** a hostile armed pirate ship parked next to a position (seen by everyone: same rule as the guide) */
function pirateAt(sim: WorldSim, system: string, pos: { x: number; y?: number; z: number }, n = 1) {
  void system;
  const pg = sim.newGroup('pirates', '시험 해적단');
  const ships = Array.from({ length: n }, (_, i) => sim.spawnShip('pirates', 'corvette', 'gun', pg.id, { x: pos.x + 500 + i * 60, y: 0, z: pos.z }));
  return { pg, ship: ships[0], ships };
}

describe('A-3.2b.1 risk guidance: bands, hostile ships at the site, the player decides', () => {
  it('route risk bands: ≤30 safe (recommended), 31–55 caution (asks), >55 danger (strong warning); recommended first', () => {
    expect([riskBand(0), riskBand(30), riskBand(31), riskBand(55), riskBand(56)]).toEqual(['safe', 'safe', 'caution', 'caution', 'danger']);
    const { sim, me } = start();
    const opts = salvageOpportunities(sim.st, me);
    expect(opts.length).toBeGreaterThan(3);
    expect(opts[0].recommended).toBe(true);
    // recommended rows come before every other, then safe, caution, danger
    const rank = opts.map(o => o.recommended ? 0 : o.band === 'safe' ? 1 : o.band === 'caution' ? 2 : 3);
    expect([...rank].sort((a, b) => a - b)).toEqual(rank);
    for (const o of opts) { expect(o.band).toBe(riskBand(o.risk)); expect(o.recommended).toBe(o.band === 'safe' && o.threat.near === 0); }
    // the confirmation text: none for a recommended target, a question for caution, a strong warning for danger
    const base = { name: 'X', threat: { near: 0, system: 0 } };
    expect(salvageConfirm({ ...base, risk: 20, band: 'safe' })).toBeNull();
    expect(salvageConfirm({ ...base, risk: 40, band: 'caution' })).toMatch(/주의.*권장.*보낼까요/);
    expect(salvageConfirm({ ...base, risk: 70, band: 'danger' })).toMatch(/위험.*격침.*그래도 보낼까요/);
  });

  it('a hostile armed ship seen at the site is reported apart from route risk and asks first even on a safe route; the order is never refused or swapped', () => {
    const { sim, me, g } = start();
    const o0 = salvageOpportunities(sim.st, me).find(o => o.recommended)!;
    const w = sim.st.wrecks![o0.id];
    expect(knownThreat(sim.st, me, w.system, w.pos)).toEqual({ near: 0, system: 0 });
    const { ship } = pirateAt(sim, w.system, w.pos);
    expect(knownThreat(sim.st, me, w.system, w.pos).near).toBe(1);
    const o = salvageOpportunities(sim.st, me).find(x => x.id === o0.id)!;
    expect(o.band).toBe('safe');                    // route risk unchanged (structural)
    expect(o.risk).toBe(o0.risk);
    expect(o.threat.near).toBe(1);
    expect(o.recommended).toBe(false);
    expect(salvageConfirm(o)).toMatch(new RegExp(`경로는 안전.*${SITE_THREAT_R / 1000}k.*1척`));
    // farther than the site radius but in the same system: counted apart
    ship.pos = { ...w.pos, x: w.pos.x + SITE_THREAT_R + 3000 };
    const t = knownThreat(sim.st, me, w.system, w.pos); expect(t).toEqual({ near: 0, system: 1 });
    // the player may still send the fleet there: the server accepts the same target, unchanged
    ship.pos = { ...w.pos, x: w.pos.x + 500 };
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: o.id } })).toBeNull();
    expect(g.op).toMatchObject({ k: 'recover', wreck: o.id });
    // a docked or own-faction ship is not a threat
    ship.state = 'docked'; expect(knownThreat(sim.st, me, w.system, w.pos).near).toBe(0);
  });
});

describe('A-3.2b.1 operating status and comeback', () => {
  it('ok → transport bottleneck → limited → halted as ships are lost; milestones stay; halted shows cash, rebuy prices and the way back', () => {
    const { sim, me, co, hauler, miner, cons } = start(21, true);
    co.milestones.push('first_salvage');
    let s = salvageOperatingStatus(sim.st, me);
    expect(s.state).toBe('ok'); expect(s.can).toEqual({ hull: true, cargo: true, equip: true, frag: true }); expect(s.comeback).toBeUndefined();
    hauler.hp = 0.3;
    s = salvageOperatingStatus(sim.st, me); expect(s.state).toBe('transport'); expect(s.issues.join()).toMatch(/수송선 손상/);
    sim.st.ships[hauler.id] && delete sim.st.ships[hauler.id];
    s = salvageOperatingStatus(sim.st, me); expect(s.state).toBe('transport'); expect(s.issues.join()).toMatch(/수송선 없음/);
    expect(s.comeback!.offers.some(o => o.hull === 'hauler_mk1')).toBe(true);
    delete sim.st.ships[cons.id];
    s = salvageOperatingStatus(sim.st, me); expect(s.state).toBe('limited'); expect(s.can).toEqual({ hull: true, cargo: true, equip: false, frag: false });
    delete sim.st.ships[miner.id];
    s = salvageOperatingStatus(sim.st, me);
    expect(s.state).toBe('halted'); expect(s.workers).toBe(0);
    expect(co.milestones).toContain('first_salvage');            // never revoked
    const c = s.comeback!;
    expect(c.credits).toBe(co.credits);
    expect(c.offers.length).toBeGreaterThan(0);
    for (const o of c.offers) {
      const st = sim.st.stations[o.station];
      expect(o.price).toBe(yardShipPrice(st, o.hull));            // the yard's real price (same as a purchase)
      expect(o.affordable).toBe(co.credits >= o.price);
      expect(o.jumps).toBeLessThanOrEqual(3);
      expect(hullSale(o.hull)).toBeTruthy();
    }
    expect(c.steps.join('\n')).toMatch(/대체 함선|가장 싼 대체 함선/);
    // the listed hull really can be bought at that price with the company's cash
    const cheapest = [...c.offers].sort((a, b) => a.price - b.price)[0];
    co.credits = Math.max(co.credits, cheapest.price + 10);
    const before = co.credits;
    expect(sim.command(me, { c: 'buyShip', station: cheapest.station, classId: CONTENT.hulls[cheapest.hull].classId, loadoutId: '', hull: cheapest.hull })).toBeNull();
    expect(before - co.credits).toBe(cheapest.price);
    // in arrears stage 3 the guide points at the A-2.1 recovery tools
    co.credits = 0; co.upkeep = { ...(co.upkeep ?? {}), debt: 8000, stage: 3 } as typeof co.upkeep;
    for (const x of Object.values(sim.st.ships)) if (x.owner === me) delete sim.st.ships[x.id];
    const r = salvageOperatingStatus(sim.st, me).comeback!;
    expect(r.steps.join('\n')).toMatch(/체납 3단계.*회생/);
    expect(r.offers.every(o => !o.affordable)).toBe(true);
  });

  it('pirates waiting at the site are shown and asked about; the fleet sent anyway and then lost (all three) shows 사업 중단 with the comeback block', () => {
    const { sim, me, co, g, ships } = start();
    const o = salvageOpportunities(sim.st, me).find(x => x.recommended && x.jumps === 0)!;
    const w = sim.st.wrecks![o.id];
    pirateAt(sim, w.system, w.pos, 4);
    const seen = salvageOpportunities(sim.st, me).find(x => x.id === o.id)!;
    expect(seen.threat.near).toBe(4);
    expect(salvageConfirm(seen)).toMatch(/적대 무장 함선 4척/);
    // the player confirms anyway (the guide asks, it does not refuse)
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: o.id } })).toBeNull();
    run(sim, 120);
    // the loss itself: what an engagement settlement does to a destroyed ship (sim.ts settle — stats.lost, group, ship
    // record). At Ceres the existing evasion AI (해적 회피) keeps this fleet alive; real losses are in the risky scenario.
    for (const s of ships()) { co.stats.lost++; const gg = sim.st.groups[s.groupId]; if (gg) gg.shipIds = gg.shipIds.filter(x => x !== s.id); delete sim.st.ships[s.id]; }
    run(sim, 30);
    expect(co.stats.lost).toBe(3);
    const h = salvageOperatingStatus(sim.st, me);
    expect(h.state).toBe('halted');
    expect(h.lost).toBe(3);
    expect(h.can).toEqual({ hull: false, cargo: false, equip: false, frag: false });
    expect(h.comeback!.credits).toBe(co.credits);
    expect(h.comeback!.steps.join('\n')).toMatch(/대체 함선/);
  }, 120000);
});

describe('A-3.2b.1 salvage hauler sale round trip (AUTO-P1.1 rules)', () => {
  it('after unloading, the hauler sells stock the home market does not buy at a nearby market, the rest keep salvaging, then it returns to work', () => {
    const { sim, me, co, g, home, hauler, miner, cons } = start(21, true);
    sellAll(sim, me);
    expect(home.market?.electronics).toBeFalsy();
    addc(sim.storage(home, me), 'electronics', 420);
    const fragKey = 'bpf:test'; addc(sim.storage(home, me), fragKey, 3);
    const o = salvageOpportunities(sim.st, me).find(x => x.recommended && x.jumps === 0)!;
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: o.id } })).toBeNull();
    const tripShips = new Set<string>();
    let tripAt = 0, minerWorkedDuring = false, back = 0, consMoved = false, minerSold = false;
    const minerCargo = () => Object.values(miner.cargo).reduce((a, b) => a + b, 0);
    let mc = 0;
    run(sim, 3600, t => {
      const j = hauler.logisticsJob ? sim.st.logisticsJobs![hauler.logisticsJob] : undefined;
      for (const x of salvJobs(sim, me)) if (x.ship) tripShips.add(x.ship);
      if (j?.salvTrip && !tripAt) tripAt = t;
      if (tripAt && j?.salvTrip) { const n = minerCargo(); if (n > mc + 0.5) minerWorkedDuring = true; mc = n; if (cons.state === 'space') consMoved = true; }
      if (tripAt && !back && !hauler.logisticsJob && t > tripAt + 5) back = t;
      if (miner.logisticsJob || cons.logisticsJob) minerSold = true;
    });
    const jobs = salvJobs(sim, me);
    expect(tripAt).toBeGreaterThan(0);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const done = jobs.filter(j => j.state === 'complete');
    expect(done.length).toBeGreaterThanOrEqual(1);
    for (const j of done) { expect(j.item).toBe('electronics'); expect(j.from).toBe(home.id); expect(j.to).not.toBe(home.id); expect(j.delivered).toBeGreaterThan(0); }
    expect([...tripShips]).toEqual([hauler.id]);             // only the hauler ever flew a trip
    expect(minerWorkedDuring || consMoved).toBe(true);       // the rest kept salvaging meanwhile
    expect(back).toBeGreaterThan(tripAt);                    // the hauler came back to salvage work
    expect(minerSold).toBe(false);                           // the miner and the constructor never go to market
    expect(co.ops!.ledger.reduce((n, b) => n + (b.sales?.electronics ?? 0), 0)).toBeGreaterThan(0);
    expect(qty(sim.storage(home, me), fragKey)).toBe(3);     // blueprint fragments stay in storage
  }, 180000);

  it('save/restore mid-trip keeps the trip; an order change ends it with the cargo kept aboard; no double use of the hauler', () => {
    const { sim, me, g, home, hauler } = start();
    sellAll(sim, me);
    addc(sim.storage(home, me), 'electronics', 420);
    const o = salvageOpportunities(sim.st, me).find(x => x.recommended && x.jumps === 0)!;
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: o.id } })).toBeNull();
    expect(until(sim, () => !!hauler.logisticsJob && !!sim.st.logisticsJobs![hauler.logisticsJob]?.salvTrip && qty(hauler.cargo, 'electronics') > 0, 3600)).toBe(true);
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    const h2 = sim2.st.ships[hauler.id], j2 = sim2.st.logisticsJobs![h2.logisticsJob!];
    expect(j2.salvTrip).toBe(true); expect(j2.miner).toBe(g.id);
    run(sim2, 30);
    expect(sim2.st.logisticsJobs![j2.id].state).not.toBe('cancelled');
    // while on the trip the hauler is never also given salvage work: its cargo holds only the sale item
    expect(Object.keys(sim2.st.ships[hauler.id].cargo).filter(k => qty(sim2.st.ships[hauler.id].cargo, k) > 1e-9)).toEqual(['electronics']);
    expect(sim2.st.ships[hauler.id].salvaged).toBeUndefined();
    // an order change (to mining) ends the trip; the cargo stays aboard
    const carried = qty(sim2.st.ships[hauler.id].cargo, 'electronics');
    expect(sim2.command(me, { c: 'setOp', group: g.id, op: { k: 'dock', station: home.id } })).toBeNull();
    run(sim2, 2);
    expect(sim2.st.logisticsJobs![j2.id].state).toBe('cancelled');
    expect(qty(sim2.st.ships[hauler.id].cargo, 'electronics')).toBeCloseTo(carried, 6);
  }, 180000);

  it('goods owed to a salvage contract are handed over on unloading and never sold on a trip; equipment stays stored', () => {
    const { sim, me, co, g, home, hauler } = start();
    sellAll(sim, me);
    const o = salvageOpportunities(sim.st, me).find(x => x.recommended && x.jumps === 0)!;
    const w = sim.st.wrecks![o.id];
    const lot = w.lots.find(l => l.k === 'cargo' || l.k === 'hull')!;
    // the home station posts a contract on that target for the lot's item
    const id = sim.offerContract({ stationId: home.id, kind: 'salvage', title: 't', desc: '', reward: 600, rep: 1, res: lot.item as never, amount: Math.min(20, Math.floor(lot.n)), target: w.id }, DERELICT_CFG.contract.board);
    w.contract = id;
    expect(sim.command(me, { c: 'accept', contract: id })).toBeNull();
    addc(sim.storage(home, me), 'electronics', 420);
    addc(sim.storage(home, me), 'eq_autocannon', 2);
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } })).toBeNull();
    const k = sim.st.contracts[id];
    let handedAt = Infinity;
    run(sim, 3600, t => { if (handedAt === Infinity && k.progress >= (k.amount ?? 0)) handedAt = t; });
    expect(k.progress).toBeGreaterThan(0);
    expect(k.progress).toBe(k.amount);                       // the owed goods were handed over (consumed, not stored)
    // a trip only carries stored stock: the contract's goods were never in the store, so no trip carried them before delivery
    // (indV: the starter's gearless hauler is idle from the start, so it may sell stored electronics before the handover —
    // never the contract's item)
    for (const j of salvJobs(sim, me)) { expect(j.from).toBe(home.id); if (j.created < handedAt) expect(j.item).not.toBe(lot.item); }
    // equipment is not on the guide's sale list: it stays stored
    expect(salvJobs(sim, me).some(j => j.item === 'eq_autocannon')).toBe(false);
    expect(qty(sim.storage(home, me), 'eq_autocannon')).toBe(2);
    void co; void hauler;
  }, 180000);
});
