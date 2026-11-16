// A-3.2b.2: salvage-site risk and operating convenience — recent-battle wrecks (shown apart from the hostile fleets
// seen now, confirmation, demoted from the recommendation, never refused), the salvage hauler's part-load sale after
// 20 game minutes (cost check, small-trip gap, failure → return → retry, save/restore), mining haulers unchanged.
// See docs/A3_2B_2_FINISH.md.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { addc, qty } from '../src/world/types';
import { RECENT_BATTLE_S, salvageConfirm, salvageOperatingStatus, salvageOpportunities, SALVAGE_SELL_ITEMS } from '../src/world/firstBusiness';
import { yardShipPrice } from '../src/world/hullops';
import { CONTENT } from '../src/content/registry';
import { SALV_PARTIAL_GAP, SALV_PARTIAL_WAIT, salvTripCost, planMinerSaleTrip } from '../src/world/procurement';
import { econOf } from '../src/world/hullops';
import type { WreckSite } from '../src/world/wrecks';

const run = (sim: WorldSim, s: number, each?: (t: number) => void) => { for (let i = 1; i <= s; i++) { sim.update(1); each?.(i); } };
function start(seed = 21) {
  const sim = WorldSim.create(seed, { ...STANDARD_WORLD });
  const me = sim.addPlayer('인양 마무리', 'salvager'), co = sim.st.companies[me];
  const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
  const ships = () => Object.values(sim.st.ships).filter(s => s.owner === me);
  const home = sim.st.stations[co.homeStation!];
  return { sim, me, co, g, ships, home, hauler: ships().find(s => s.classId === 'hauler')! };
}
const sellAll = (sim: WorldSim, me: string) => { for (const item of SALVAGE_SELL_ITEMS) expect(sim.command(me, { c: 'salesPolicy', settings: { item, sell: true, minPrice: 0 } })).toBeNull(); };
const salvJobs = (sim: WorldSim, me: string) => Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.salvTrip);
/** a battlefield wreck (no derelict origin) next to a derelict the guide recommends, made `ago` seconds ago */
function battleWreck(sim: WorldSim, near: { system: string; pos: { x: number; y: number; z: number } }, ago: number, eng = 'e_test', n = 300): WreckSite {
  const w: WreckSite = {
    id: `wk_${eng}_0`, name: '시험 전장 잔해 A', eng, system: near.system, pos: { x: near.pos.x + 2000, y: 0, z: near.pos.z },
    created: sim.time - ago, expires: sim.time + 7200, sources: [{ ship: 'x1', owner: 'guild', classId: 'hauler', at: sim.time - ago }],
    lots: [{ k: 'cargo', item: 'alloy', n: n / 2, owner: '' }, { k: 'hull', item: 'alloy', n: n / 2, owner: '' }], initial: n, taken: {}, seen: [],
  } as unknown as WreckSite;
  (sim.st.wrecks ??= {})[w.id] = w;
  return w;
}

describe('A-3.2b.2 recent-battle wrecks', () => {
  it('a battle wreck made minutes ago is marked apart from hostile fleets, asks first, is not recommended and sorts below recommended targets; the order is not refused', () => {
    const { sim, me, g } = start();
    const d = salvageOpportunities(sim.st, me).find(x => x.recommended && x.kind === 'derelict' && x.jumps === 0)!;
    const dw = sim.st.wrecks![d.id];
    const w = battleWreck(sim, dw, 600);
    const opts = salvageOpportunities(sim.st, me), o = opts.find(x => x.id === w.id)!;
    expect(o.kind).toBe('wreck');
    expect(o.band).toBe('safe');
    expect(o.threat).toEqual({ near: 0, system: 0 });             // nobody hostile visible …
    expect(o.battle).toEqual({ ago: 600, fighting: false, recent: true });   // … but a battle 10 minutes ago
    expect(o.recommended).toBe(false);
    // every recommended row comes before it
    const at = opts.indexOf(o);
    expect(opts.slice(at + 1).some(x => x.recommended)).toBe(false);
    const ask = salvageConfirm(o)!;
    expect(ask).toMatch(/10분 전에 이곳에서 전투/);
    expect(ask).toMatch(/지금 보이는 적대 함대는 없지만/);
    // a recommended derelict still goes without a question
    expect(salvageConfirm(opts.find(x => x.id === d.id)!)).toBeNull();
    // the player may still send the fleet there
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } })).toBeNull();
  });

  it('the recent-battle mark ends after 30 game minutes; a fight still going on at the site keeps it; nothing about the fleets involved is exposed', () => {
    const { sim, me } = start();
    const d = salvageOpportunities(sim.st, me).find(x => x.recommended && x.kind === 'derelict' && x.jumps === 0)!;
    const dw = sim.st.wrecks![d.id];
    const old = battleWreck(sim, dw, RECENT_BATTLE_S + 60, 'e_old');
    let o = salvageOpportunities(sim.st, me).find(x => x.id === old.id)!;
    expect(o.battle).toEqual({ ago: RECENT_BATTLE_S + 60, fighting: false, recent: false });
    expect(o.recommended).toBe(true);
    expect(salvageConfirm(o)).toBeNull();
    // a fight this state carries near the site (on a client: one the company can see) marks it again
    sim.st.engagements.e_live = { id: 'e_live', pos: { ...old.pos }, start: sim.time, done: false, sides: [['guild'], ['pirates']], groupRefs: [], live: false, tick: 0, orders: [], setup: {} } as never;
    o = salvageOpportunities(sim.st, me).find(x => x.id === old.id)!;
    expect(o.battle).toEqual({ ago: RECENT_BATTLE_S + 60, fighting: true, recent: true });
    expect(o.recommended).toBe(false);
    expect(salvageConfirm(o)).toMatch(/교전이 진행 중/);
    // only the time and the in-progress flag are added: no sides, fleets, ship counts or positions
    expect(Object.keys(o.battle!).sort()).toEqual(['ago', 'fighting', 'recent']);
    delete sim.st.engagements.e_live;
    // derelicts and jettisoned cargo carry no battle record
    expect(salvageOpportunities(sim.st, me).filter(x => x.kind !== 'wreck').every(x => x.battle === undefined)).toBe(true);
  });
});

/** a large old battle wreck next to home: the fleet keeps salvaging (and unloading) for a long time */
function bigSite(sim: WorldSim, me: string): string {
  const d = salvageOpportunities(sim.st, me).find(x => x.recommended && x.kind === 'derelict' && x.jumps === 0)!;
  const w = battleWreck(sim, sim.st.wrecks![d.id], RECENT_BATTLE_S * 3, 'e_big');
  w.lots = [{ k: 'cargo', item: 'ore', n: 30000, owner: '' } as never]; w.initial = 30000;   // cheap cargo next to home: the hauler keeps unloading
  return w.id;
}
/** a company salvaging for ten hours at a modest rate: this site right next to home would otherwise read as a goldmine
 *  (a 95-second cycle) and make every trip a loss against the salvage left behind */
const history = (co: { salvage?: unknown }, now: number) => { co.salvage = { units: 0, value: 0, items: {}, sites: [], first: now - 36000 }; };

describe('A-3.2b.2 salvage hauler part-load sale', () => {
  it('a small excess waits; after 20 game minutes a part load leaves (cost checked); the next part load waits for the gap; full loads are unaffected', () => {
    const { sim, me, co, g, home, hauler } = start();
    sellAll(sim, me);
    const lot = Math.floor(econOf(hauler).cargo);
    const small = Math.floor(lot * 0.3);
    addc(sim.storage(home, me), 'electronics', small);
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: bigSite(sim, me) } })).toBeNull();
    history(co, sim.time);
    let firstNote = 0, waitNote = '', tripAt = 0, doneAt = 0;
    let backAt = 0;
    run(sim, 3600, t => {
      if (doneAt && !backAt && !hauler.logisticsJob && Object.keys(hauler.cargo).some(k => k === 'ore' && qty(hauler.cargo, k) > 0)) backAt = t;   // hauling salvage again
      const r = co.procurement?.minerTrip?.reason ?? '';
      if (!firstNote && /60% 적재/.test(r)) { firstNote = t; waitNote = r; }
      const j = salvJobs(sim, me)[0];
      if (j && !tripAt) tripAt = t;
      if (j?.state === 'complete' && !doneAt) doneAt = t;
    });
    expect(firstNote).toBeGreaterThan(0);
    expect(waitNote).toMatch(/분 더 쌓여 있으면 부분 적재 판매/);
    const jobs = salvJobs(sim, me);
    expect(jobs.length).toBe(1);
    const j = jobs[0];
    expect(j.item).toBe('electronics');
    expect(j.amount).toBeLessThan(lot * 0.6);
    expect(tripAt - firstNote).toBeGreaterThanOrEqual(SALV_PARTIAL_WAIT - 60);   // waited (the planner runs on unloads)
    expect(co.procurement!.salvPartialAt!.electronics).toBe(j.created);
    expect(co.procurement!.minerTrip!.reason.length).toBeGreaterThan(0);
    expect(doneAt).toBeGreaterThan(tripAt);
    expect(j.delivered).toBeGreaterThan(0);
    // measured round trip against the planning estimate (reported in the A-3.2b.2 document)
    const hops = Number(/\((\d+)점프/.exec(co.procurement!.minerTrip!.reason)?.[1] ?? NaN);
    console.log(`[a32b2] part-load trip: ${Math.round(j.amount)} of lot ${lot} → ${j.to}, waited ${tripAt - firstNote}s, sold after ${doneAt - tripAt}s, back to salvage after ${backAt - tripAt}s, estimate ${salvTripCost(sim, hauler, 0, 3).seconds}s (0 jumps) / ${salvTripCost(sim, hauler, 1, 3).seconds}s (1 jump), earned ${Math.round(j.earned)}; note: ${co.procurement!.minerTrip!.reason} ${hops}`);
    // another small excess right away: no second part load inside the gap
    addc(sim.storage(home, me), 'electronics', small);
    const t0 = sim.time; let second = 0;
    run(sim, SALV_PARTIAL_GAP - 120, () => { if (!second && salvJobs(sim, me).length > 1) second = sim.time; });
    if (second) expect(second - co.procurement!.salvPartialAt!.electronics).toBeGreaterThanOrEqual(SALV_PARTIAL_GAP);
    expect(salvJobs(sim, me).filter(x => x.created > t0 && x.created < j.created + SALV_PARTIAL_GAP).length).toBe(0);
  }, 240000);

  it('a part load that would lose money (running-cost share + salvage left behind) is not flown; zero trips is a valid result', () => {
    const { sim, me, co, g, home, hauler } = start();
    sellAll(sim, me);
    addc(sim.storage(home, me), 'electronics', 40);      // ≈ 7,000 cr: above the per-jump minimum, below the cost
    // a company that has been salvaging a lot: an hour of a hauler's share is worth far more than the load
    co.salvage = { units: 50000, value: 900000, items: {}, sites: [], first: sim.time - 3600 };
    const c = salvTripCost(sim, hauler, 1, 3);
    expect(c.opportunity).toBeGreaterThan(c.upkeep);
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: bigSite(sim, me) } })).toBeNull();
    const notes = new Set<string>();
    run(sim, 2400, () => { const r = co.procurement?.minerTrip?.reason; if (r) notes.add(r.replace(/\d[\d,]*/g, '#')); });
    expect(salvJobs(sim, me).length).toBe(0);
    expect([...notes].some(r => /손해 예상, 재고 보존/.test(r))).toBe(true);
    expect(qty(sim.storage(home, me), 'electronics')).toBeGreaterThanOrEqual(40);   // the stock stays
  }, 240000);

  it('save/restore keeps the waiting time and the gap; a failed part-load sale flies back, waits and retries', () => {
    const { sim, me, co, g, home, hauler } = start();
    sellAll(sim, me);
    addc(sim.storage(home, me), 'electronics', 120);
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: bigSite(sim, me) } })).toBeNull();
    history(co, sim.time);
    // run until the planner has started counting, then save and restore
    for (let i = 0; i < 1800 && !/60% 적재/.test(co.procurement?.minerTrip?.reason ?? ''); i++) sim.update(1);
    const since = co.procurement!.salesStatus!.electronics.since![home.id];
    expect(since).toBeGreaterThan(0);
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    const co2 = sim2.st.companies[me];
    expect(co2.procurement!.salesStatus!.electronics.since![home.id]).toBe(since);
    // every market for electronics stops buying once the trip has left: the sale fails
    let job = ''; let left = 0;
    for (let i = 0; i < 3600 && !job; i++) { sim2.update(1); const j = salvJobs(sim2, me)[0]; if (j?.ship) { job = j.id; left = sim2.time; } }
    expect(job).not.toBe('');
    expect(left - since).toBeGreaterThanOrEqual(SALV_PARTIAL_WAIT);
    const saved: Record<string, unknown> = {};
    for (const st of Object.values(sim2.st.stations)) if (st.market?.electronics) { saved[st.id] = st.market.electronics; delete st.market.electronics; }
    const j = sim2.st.logisticsJobs![job];
    let back = 0;
    for (let i = 0; i < 4000 && !back; i++) { sim2.update(1); if (j.returning) back = sim2.time; }
    expect(back).toBeGreaterThan(0);                                   // gave up and flies home with the cargo
    const retry = co2.procurement!.minerTripRetry!.electronics;
    expect(retry.fails).toBe(1);
    expect(retry.at).toBeGreaterThan(back);
    // markets buy again: after the back-off the stock is sold (a new trip or the same cargo sent on)
    for (const [id, m] of Object.entries(saved)) sim2.st.stations[id].market!.electronics = m as never;
    let sold = false;
    for (let i = 0; i < 6000 && !sold; i++) { sim2.update(1); sold = salvJobs(sim2, me).some(x => x.delivered > 0); }
    expect(sold).toBe(true);
    expect(sim2.st.ships[hauler.id]).toBeDefined();
  }, 300000);

  it('mining haulers keep the AUTO-P1 rule (10 minutes) — the salvage wait and cost check apply only to salvage', () => {
    // the salvage flag is what switches the rule: called as a mining trip on a docked, empty hauler the old rule applies
    const { sim, me, g, home, hauler } = start();
    sellAll(sim, me);
    addc(sim.storage(home, me), 'electronics', 120);
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: bigSite(sim, me) } })).toBeNull();   // not a pool ship
    hauler.state = 'docked'; hauler.task = { k: 'docked', station: home.id } as never;
    const co = sim.st.companies[me];
    expect(planMinerSaleTrip(sim, hauler, home, false)).toBe(false);
    expect(co.procurement!.minerTrip!.reason).toMatch(/한 번에 실을 만큼 모이면 판매 왕복/);
    expect(planMinerSaleTrip(sim, hauler, home, true)).toBe(false);
    expect(co.procurement!.minerTrip!.reason).toMatch(/60% 적재/);
    // 11 minutes later the mining rule lets a part load go; the salvage rule still waits
    co.procurement!.salesStatus!.electronics.since![home.id] = sim.time - 660;
    expect(planMinerSaleTrip(sim, hauler, home, true)).toBe(false);
    expect(co.procurement!.minerTrip!.reason).toMatch(/60% 적재/);
    expect(planMinerSaleTrip(sim, hauler, home, false)).toBe(true);
    expect(co.procurement!.salvPartialAt).toBeUndefined();
  });
});

describe('A-3.2b.2 replacement ships go through the existing yard purchase', () => {
  it('the offer the "조선소 열기" button opens is bought with the ordinary buyShip command: short of money and empty stock are refused, the price follows the stock', () => {
    const { sim, me, co } = start();
    for (const x of Object.values(sim.st.ships)) if (x.owner === me) delete sim.st.ships[x.id];
    const offer = salvageOperatingStatus(sim.st, me).comeback!.offers.find(o => o.hull === 'hauler_mk1')!;
    expect(offer).toBeTruthy();
    const st = sim.st.stations[offer.station], buy = () => sim.command(me, { c: 'buyShip', station: st.id, classId: CONTENT.hulls[offer.hull].classId, loadoutId: '', hull: offer.hull });
    // short of money: refused, nothing taken
    co.credits = offer.price - 1;
    const owned = () => Object.values(sim.st.ships).filter(x => x.owner === me).length;
    expect(buy()).not.toBeNull(); expect(owned()).toBe(0); expect(co.credits).toBe(offer.price - 1);
    // enough money: one ship per confirmed purchase, each at the yard's current price (which rises as stock falls)
    co.credits = 1e7;
    let n = st.shipStock?.[offer.hull]?.n ?? 0, bought = 0;
    expect(n).toBeGreaterThan(0);
    while (n > 0) {
      const p = yardShipPrice(st, offer.hull), before = co.credits;
      expect(buy()).toBeNull(); bought++;
      expect(before - co.credits).toBe(p);
      n = st.shipStock![offer.hull].n;
      // the guide's offer follows the yard: the same price the next purchase would pay
      const o2 = salvageOperatingStatus(sim.st, me).comeback?.offers.find(o => o.hull === offer.hull && o.station === st.id);
      if (n > 0 && o2) expect(o2.price).toBe(yardShipPrice(st, offer.hull));
    }
    expect(owned()).toBe(bought);
    // stock gone: the next purchase is refused
    const c0 = co.credits;
    expect(buy()).not.toBeNull(); expect(co.credits).toBe(c0); expect(owned()).toBe(bought);
  });
});
