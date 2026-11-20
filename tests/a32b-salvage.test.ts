// A-3.2b: the salvager's first business — natural derelicts (finite, shared, deterministic), salvage contracts
// (reward reserved from the station's funds, provenance-checked delivery), the salvager's guide and the
// salvage → sale link. Scenario numbers refer to docs/A3_2B_FIRST_SALVAGE.md §8.
import { describe, expect, it } from 'vitest';
import { pnlRows } from '../src/world/industryPnl';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { qty, type Contract, type WShip } from '../src/world/types';
import { DERELICT_CFG, derelictLots, enableDerelicts, regionOf, spawnDerelict, stepDerelicts } from '../src/world/derelicts';
import { acceptSalvageContract } from '../src/world/salvageContracts';
import { lotValue, wreckFor, type WreckSite } from '../src/world/wrecks';
import { moneySupply, observeWorld } from '../src/world/observe';
import { firstBusinessOn, firstBusinessStatus, firstProfitReached, salvageOpportunities, SALVAGE_SELL_ITEMS } from '../src/world/firstBusiness';
import { EQUIPMENT } from '../src/world/industry';

const run = (sim: WorldSim, s: number) => { for (let i = 0; i < s; i++) sim.update(1); };
const until = (sim: WorldSim, cond: () => boolean, s = 3600) => { for (let i = 0; i < s && !cond(); i++) sim.update(1); return cond(); };
const derelicts = (sim: WorldSim) => Object.values(sim.st.wrecks ?? {}).filter(w => w.origin === 'derelict');
const left = (w?: WreckSite) => (w?.lots ?? []).reduce((n, l) => n + l.n, 0);
const groupOf = (sim: WorldSim, me: string) => Object.values(sim.st.groups).find(g => g.owner === me)!;
const shipsOf = (sim: WorldSim, me: string) => Object.values(sim.st.ships).filter(s => s.owner === me);
function flows(sim: WorldSim) { const out: Record<string, number> = {}; const stop = observeWorld(sim.st, e => { if (!e.item) return; const k = `${e.kind}/${e.reason ?? ''}`; out[k] = (out[k] ?? 0) + e.amount; }); return { out, stop }; }
function world(seed = 21) { return WorldSim.create(seed, { ...STANDARD_WORLD }); }
/** a salvage contract posted the way the server does it, on a chosen derelict */
function postOn(sim: WorldSim, stationId: string, x: WreckSite, res: string, amount: number, reward: number): Contract {
  const id = sim.offerContract({ stationId, kind: 'salvage', title: `인양 ${res}`, desc: '', reward, rep: 2, res: res as Contract['res'], amount, target: x.id }, DERELICT_CFG.contract.board);
  x.contract = id;
  return sim.st.contracts[id];
}

describe('A-3.2b derelicts: finite, shared, deterministic supply', () => {
  it('S1/S2: a new standard world places derelicts per region within the caps; old salvage worlds have none', () => {
    const sim = world();
    const ds = derelicts(sim);
    expect(sim.st.derelictV).toBe(1);
    expect(ds.length).toBeGreaterThan(10);
    expect(ds.length).toBeLessThanOrEqual(DERELICT_CFG.globalMax);
    const by = new Map<string, WreckSite[]>();
    for (const x of ds) by.set(x.region!, [...(by.get(x.region!) ?? []), x]);
    for (const [key, xs] of by) {
      const B = DERELICT_CFG.band[key.split(':')[1] as keyof typeof DERELICT_CFG.band];
      expect(xs.length).toBeLessThanOrEqual(B.max);
      for (const x of xs) { expect(x.grade).toBe(B.grade); expect(regionOf(sim.st.systems[x.system])).toBe(key); }
    }
    // ownerless lots, recorded value
    for (const x of ds) for (const l of x.lots) expect(l.owner).toBe('');
    // the P13.1-only world and the legacy world get none
    const p131 = WorldSim.create(21, { salvage: 'p131' });
    expect(p131.st.derelictV).toBeUndefined(); expect(Object.keys(p131.st.wrecks ?? {}).length).toBe(0);
    expect(WorldSim.create(21).st.derelictV).toBeUndefined();
  });

  it('S3: a small (beginner) derelict never carries equipment or blueprint fragments; large ones may', () => {
    let r = 1; const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
    for (let i = 0; i < 200; i++) for (const l of derelictLots(rnd, 'small')) { expect(['hull', 'cargo']).toContain(l.k); expect(EQUIPMENT[l.item]).toBeUndefined(); expect(l.item.startsWith('bpf:')).toBe(false); }
    let eq = 0; for (let i = 0; i < 200; i++) eq += derelictLots(rnd, 'large').filter(l => l.k === 'equip').length;
    expect(eq).toBeGreaterThan(0);
  });

  it('S4: same seed → same derelicts; save/restore never makes a derelict twice; respawn obeys the period and caps', () => {
    const a = world(7), b = world(7);
    expect(derelicts(a).map(x => [x.id, x.system, x.lots.map(l => l.n).join()])).toEqual(derelicts(b).map(x => [x.id, x.system, x.lots.map(l => l.n).join()]));
    const back = new WorldSim(JSON.parse(a.serialize()));
    const before = derelicts(back).length, seq = back.st.derelicts!.seq;
    enableDerelicts(back.st, back.time);   // idempotent (the migration flag on an already converted world)
    stepDerelicts(back.st, back.time);
    expect(derelicts(back).length).toBe(before); expect(back.st.derelicts!.seq).toBe(seq);
    // empty a region: nothing reappears before its timer
    const x = derelicts(back).find(d => d.system === 'ceres')!;
    const key = x.region!, R = back.st.derelicts!.regions[key];
    for (const d of derelicts(back).filter(d => d.region === key)) for (const l of d.lots) l.n = 0;
    run(back, 70);
    expect(derelicts(back).filter(d => d.region === key && left(d) > 0).length).toBe(0);
    back.st.derelicts!.check = 0; R.next = back.time;
    stepDerelicts(back.st, back.time);
    const now = derelicts(back).filter(d => d.region === key && left(d) > 0);
    expect(now.length).toBe(1);
    expect(R.next - back.time).toBeGreaterThanOrEqual(DERELICT_CFG.band.safe.period * 0.75 - 1);
  }, 60000);

  it('S5/S6: spawned = recovered + remaining + decayed (events per item); exhausted or expired derelicts are removed', () => {
    const sim = world(9);
    const me = sim.addPlayer('보존', 'salvager');
    const fl = flows(sim);
    const sys = sim.st.systems.ceres;
    const x = spawnDerelict(sim.st, { system: sys, grade: 'small', region: regionOf(sys), time: sim.time, life: 1800, near: sim.st.stations.p9_ceres_works.pos });
    const made = fl.out['salvage/derelict_hull'] + (fl.out['salvage/derelict_cargo'] ?? 0);
    expect(made).toBe(x.initial);
    expect(sim.command(me, { c: 'setOp', group: groupOf(sim, me).id, op: { k: 'recover', wreck: x.id } })).toBeNull();
    until(sim, () => left(x) < x.initial * 0.5, 1500);
    x.expires = sim.time + 1;
    run(sim, 15); fl.stop();
    expect(sim.st.wrecks![x.id]).toBeUndefined();
    const recovered = Object.values(x.taken).reduce((n, t) => n + Object.values(t).reduce((a, b) => a + b, 0), 0);
    const decayed = fl.out['consume/wreck_decay'] ?? 0;
    expect(recovered).toBeGreaterThan(0);
    expect(recovered + decayed).toBe(x.initial);
  }, 60000);

  it('S7/S8: ownerless derelict salvage is legal (no crime, no credit change) and two companies share one wreck without duplication', () => {
    const sim = world(11);
    const A = sim.addPlayer('갑 인양', 'salvager'), B = sim.addPlayer('을 인양', 'salvager');
    const x = derelicts(sim).find(d => d.system === 'ceres')!;
    const total = x.initial, repA = sim.st.companies[A].rep;
    for (const c of [A, B]) expect(sim.command(c, { c: 'setOp', group: groupOf(sim, c).id, op: { k: 'recover', wreck: x.id } })).toBeNull();
    until(sim, () => left(x) === 0 || !sim.st.wrecks![x.id], 2400);
    const tA = Object.values(x.taken[A] ?? {}).reduce((a, b) => a + b, 0), tB = Object.values(x.taken[B] ?? {}).reduce((a, b) => a + b, 0);
    expect(tA + tB + left(x)).toBe(total);
    expect(x.crime).toBeUndefined();
    expect(sim.st.companies[A].rep).toBeCloseTo(repA, 6);
    expect(Object.values(sim.st.law?.cases ?? {}).filter(c => (c as { by?: string }).by === A || (c as { by?: string }).by === B).length).toBe(0);
  }, 90000);

  it('S9: a derelict is a world object seen by everyone (public survey report), its lots once a ship comes close', () => {
    const sim = world();
    const me = sim.addPlayer('관측', 'salvager');
    const x = derelicts(sim).find(d => d.system === 'ceres')!;
    const v = wreckFor(x, me) as ReturnType<typeof wreckFor> & { lots?: unknown };
    expect(v.origin).toBe('derelict'); expect(v.est).toBeGreaterThan(0); expect(v.main?.length).toBeGreaterThan(0); expect(v.lots).toBeUndefined();
    x.seen.push(me);
    expect((wreckFor(x, me) as { lots?: unknown }).lots).toBeTruthy();
  });
});

describe('A-3.2b Ceres start: guaranteed nearby beginner opportunities without per-player copies', () => {
  it('S10: the guide lists safe derelicts near Ceres; danger and value are distinguishable', () => {
    const sim = world();
    const me = sim.addPlayer('세레스 인양', 'salvager'), co = sim.st.companies[me];
    expect(firstBusinessOn(co)).toBe(true);
    const ops = salvageOpportunities(sim.st, me);
    const safe = ops.filter(o => o.kind === 'derelict' && o.risk <= 30 && o.jumps <= 1);
    expect(safe.length).toBeGreaterThanOrEqual(2);
    expect(safe.every(o => o.grade === 'small')).toBe(true);
    const risky = ops.filter(o => o.risk > 55);
    if (risky.length) expect(Math.max(...risky.map(o => o.value))).toBeGreaterThan(Math.max(...safe.map(o => o.value)));
  });

  it('S11: founding many salvagers never copies derelicts — the home region stays within its cap', () => {
    const sim = world(3);
    const ceres = (s: WorldSim) => derelicts(s).filter(x => x.region === regionOf(s.st.systems.ceres) && !x.contract);
    // empty the region, then found salvagers one after another
    for (const x of ceres(sim)) for (const l of x.lots) l.n = 0;
    run(sim, 15);
    for (let i = 0; i < 5; i++) { sim.addPlayer(`인양 ${i}`, 'salvager'); run(sim, 65); }
    expect(ceres(sim).filter(x => left(x) > 0).length).toBe(1);   // one nudge (rate limited), cap 2 not exceeded
    // every timer due at once, many times: the cap holds
    const R = sim.st.derelicts!.regions[regionOf(sim.st.systems.ceres)];
    for (let i = 0; i < 6; i++) { R.next = sim.time; sim.st.derelicts!.check = 0; stepDerelicts(sim.st, sim.time); }
    expect(ceres(sim).filter(x => left(x) > 0).length).toBe(DERELICT_CFG.band.safe.max);
  }, 90000);
});

describe('A-3.2b salvage contracts: real budget, provenance, no new money', () => {
  function setup() {
    const sim = world(5);
    const me = sim.addPlayer('계약 인양', 'salvager'), other = sim.addPlayer('경쟁 인양', 'salvager');
    const x = derelicts(sim).find(d => d.system === 'ceres')!;
    const st = sim.st.stations.p9_ceres_works;
    const lot = [...x.lots].sort((a, b) => b.n - a.n)[0];
    const k = postOn(sim, st.id, x, lot.item, Math.floor(lot.n / 2), 2000);
    return { sim, me, other, x, st, k, item: lot.item };
  }

  it('S12: accepting reserves the reward from the station (money supply unchanged); a short budget refuses; one taker only', () => {
    const { sim, me, other, st, k } = setup();
    const m0 = moneySupply(sim.st), f0 = st.funds!;
    expect(sim.command(me, { c: 'accept', contract: k.id })).toBeNull();
    expect(st.funds).toBeCloseTo(f0 - 2000, 6); expect(k.escrow).toBe(2000);
    expect(moneySupply(sim.st)).toBeCloseTo(m0, 3);
    expect(k.expires - sim.time).toBe(DERELICT_CFG.contract.life);
    expect(sim.command(other, { c: 'accept', contract: k.id })).toBe('수주 불가');
    expect(sim.command(me, { c: 'accept', contract: k.id })).toBe('수주 불가');
    // a station that cannot cover a reward refuses it (nothing reserved)
    const k2 = postOn(sim, st.id, derelicts(sim).filter(d => !d.contract)[0], 'metal', 10, 10 ** 9);
    expect(acceptSalvageContract(sim, other, k2)).toMatch(/예산 부족/);
    expect(k2.escrow).toBeUndefined();
  });

  it('S13/S14: goods the company already had never count; only goods from the target, handed over at the station; extras stay; paid from the reservation', () => {
    const { sim, me, x, st, k, item } = setup();
    const co = sim.st.companies[me];
    // Keep stock alongside incoming contract items without dispatching the starter's auto-sale rule.
    expect(sim.command(me, { c: 'salesPolicy', settings: { item, sell: false } })).toBeNull();
    // pre-owned identical goods in the warehouse and aboard
    sim.storage(st, me)[item] = 500;
    const hauler = shipsOf(sim, me).find(s => s.classId === 'hauler')!; hauler.cargo[item] = 40;
    expect(sim.command(me, { c: 'accept', contract: k.id })).toBeNull();
    run(sim, 30);
    expect(k.progress).toBe(0);
    const c0 = co.credits, fl = flows(sim);
    const money: { kind: string; reason?: string; amount: number }[] = [];
    const stopMoney = observeWorld(sim.st, e => { if (e.kind.startsWith('currency') && /contract/.test(e.reason ?? '')) money.push(e); else if (e.item) { const k2 = `${e.kind}/${e.reason ?? ''}`; fl.out[k2] = (fl.out[k2] ?? 0) + e.amount; } });
    expect(sim.command(me, { c: 'setOp', group: groupOf(sim, me).id, op: { k: 'recover', wreck: x.id } })).toBeNull();
    expect(until(sim, () => k.done, 3000)).toBe(true);
    stopMoney();
    expect(k.progress).toBe(k.amount);
    expect(k.escrow).toBe(0);
    expect(co.milestones).toContain('first_contract'); expect(co.milestones).toContain('first_salvage');
    expect(fl.out['consume/contract_delivery']).toBe(k.amount);
    // the pre-owned warehouse stock is untouched by the delivery (it may only have grown by unloaded extras)
    expect(qty(sim.storage(st, me), item)).toBeGreaterThanOrEqual(500);
    // the reward was a transfer from the reservation (contract → company), never created money
    const pay = money.filter(e => e.reason === 'contract_salvage');
    expect(pay.length).toBe(1); expect(pay[0].kind).toBe('currency.transfer'); expect(pay[0].amount).toBeCloseTo(k.reward, 6);
    expect(money.some(e => e.kind !== 'currency.transfer')).toBe(false);
    const business = pnlRows(co, sim.time).find(row => row.act === 'salvage');
    expect((business?.inc ?? 0) - (business?.sales ?? 0)).toBeCloseTo(k.reward, 6);
    expect(co.credits).toBeGreaterThan(c0 + k.reward - 2000);   // reward in, minus upkeep paid meanwhile
    // extras: what was recovered beyond the contract is the company's
    const got = Object.values(x.taken[me] ?? {}).reduce((a, b) => a + b, 0);
    expect(got).toBeGreaterThan(k.amount!);
  }, 90000);

  it('S15: expiry gives the reservation back to the station; a vanished target ends the contract without a credit penalty', () => {
    const { sim, me, other, x, st, k } = setup();
    const f0 = st.funds!;
    expect(sim.command(me, { c: 'accept', contract: k.id })).toBeNull();
    k.expires = sim.time + 1;
    run(sim, 15);
    expect(k.done).toBe(true); expect(k.escrow).toBe(0);
    expect(st.funds).toBeGreaterThan(f0 - 1);   // returned (plus whatever the market did meanwhile)
    // target gone (a competitor emptied it) with nothing of it aboard: ended, refunded, no credit loss
    const y = derelicts(sim).find(d => d.id !== x.id && !d.contract)!;
    const k2 = postOn(sim, st.id, y, y.lots[0].item, 5, 600);
    expect(sim.command(other, { c: 'accept', contract: k2.id })).toBeNull();
    const rep0 = sim.st.companies[other].rep, f1 = st.funds!;
    for (const l of y.lots) l.n = 0;
    run(sim, 80);
    expect(k2.done).toBe(true); expect(k2.ended).toBe('대상 소멸'); expect(k2.escrow).toBe(0);
    expect(sim.st.companies[other].rep).toBeCloseTo(rep0, 6);
    expect(st.funds).toBeGreaterThan(f1 + 599 - 1);
  }, 60000);

  it('S16: stations post salvage contracts within their budget and cooldown; never more than the world cap; no posting loop', () => {
    const sim = world(13);
    run(sim, 2 * 3600);
    const ks = Object.values(sim.st.contracts).filter(k => k.kind === 'salvage');
    expect(ks.length).toBeGreaterThan(0);
    expect(ks.filter(k => !k.done).length).toBeLessThanOrEqual(DERELICT_CFG.contract.maxOpen);
    for (const k of ks) {
      const st = sim.st.stations[k.stationId];
      expect(k.reward).toBeGreaterThanOrEqual(DERELICT_CFG.contract.minReward);
      expect(k.target && (sim.st.wrecks?.[k.target] || k.done)).toBeTruthy();
      expect(st.services.contracts).toBe(true);
    }
    // one target, one contract
    const targets = ks.filter(k => !k.done).map(k => k.target);
    expect(new Set(targets).size).toBe(targets.length);
    // per station: posting attempts are spaced by the cooldown
    const byStation = new Map<string, number>(); for (const k of ks) byStation.set(k.stationId, (byStation.get(k.stationId) ?? 0) + 1);
    for (const n of byStation.values()) expect(n).toBeLessThanOrEqual(Math.ceil(2 * 3600 / DERELICT_CFG.contract.cooldown) + 1);
  }, 120000);

  it('S16b: a salvager\'s home station still posts a follow-up job when distant boards fill the world cap (only there, only up to the extra)', () => {
    const sim = world(13);
    run(sim, 3600);
    // clear the boards, then fill the world cap with jobs elsewhere (Ceres has none)
    for (const k of Object.values(sim.st.contracts)) if (k.kind === 'salvage' && !k.done) k.done = true;
    const far = Object.values(sim.st.stations).filter(s => s.public && s.services.contracts && s.id !== 'p9_ceres_works');
    const x = derelicts(sim)[0];
    for (const st of far.slice(0, DERELICT_CFG.contract.maxOpen)) postOn(sim, st.id, x, 'alloy', 1, 600);
    for (const k of Object.values(sim.st.contracts)) if (k.kind === 'salvage' && !k.done) k.expires = sim.time + 99999;
    for (const id of Object.keys(sim.st.derelicts!.posts)) sim.st.derelicts!.posts[id] = 0;
    run(sim, 1800);
    expect(Object.values(sim.st.contracts).filter(k => !k.done && k.kind === 'salvage').length).toBeLessThanOrEqual(DERELICT_CFG.contract.maxOpen);   // no salvager yet: capped
    const before = new Set(Object.values(sim.st.contracts).filter(k => k.kind === 'salvage').map(k => k.id));
    const me = sim.addPlayer('세레스 인양', 'salvager');
    const home = sim.st.companies[me].homeStation;
    for (const id of Object.keys(sim.st.derelicts!.posts)) sim.st.derelicts!.posts[id] = 0;
    expect(until(sim, () => Object.values(sim.st.contracts).some(k => !k.done && k.kind === 'salvage' && k.stationId === home && !before.has(k.id)), 3600)).toBe(true);
    const openNow = Object.values(sim.st.contracts).filter(k => !k.done && k.kind === 'salvage');
    expect(openNow.length).toBeLessThanOrEqual(DERELICT_CFG.contract.maxOpen + DERELICT_CFG.contract.homeExtra);
    // above the world cap: only the home station
    expect(openNow.filter(k => k.stationId !== home).length).toBeLessThanOrEqual(DERELICT_CFG.contract.maxOpen);
  }, 120000);

  it('S17: save/restore mid-contract keeps the reservation, the provenance aboard and the progress', () => {
    const { sim, me, x, k } = setup();
    expect(sim.command(me, { c: 'accept', contract: k.id })).toBeNull();
    expect(sim.command(me, { c: 'setOp', group: groupOf(sim, me).id, op: { k: 'recover', wreck: x.id } })).toBeNull();
    until(sim, () => shipsOf(sim, me).some(s => s.salvSrc), 2000);
    const m0 = moneySupply(sim.st);
    const back = new WorldSim(JSON.parse(sim.serialize()));
    expect(back.st.contracts[k.id].escrow).toBe(k.escrow);
    expect(moneySupply(back.st)).toBeCloseTo(m0, 3);
    expect(Object.values(back.st.ships).some((s: WShip) => s.owner === me && s.salvSrc)).toBe(true);
    expect(until(back, () => back.st.contracts[k.id].done, 3000)).toBe(true);
    expect(back.st.contracts[k.id].progress).toBe(k.amount);
  }, 90000);
});

describe('A-3.2b first business: guide, sales link, milestone', () => {
  it('S18: salvage → unload → automatic sale at Ceres → first profit only after real salvage', () => {
    const sim = world();
    const me = sim.addPlayer('첫 인양', 'salvager'), co = sim.st.companies[me];
    // no salvage yet: even with cash above the start (an outside gift), the first business is not done
    co.credits += 50000; expect(firstProfitReached(co)).toBe(false); co.credits -= 50000;
    for (const item of SALVAGE_SELL_ITEMS) expect(sim.command(me, { c: 'salesPolicy', settings: { item, sell: true, minPrice: 0 } })).toBeNull();
    const o = salvageOpportunities(sim.st, me).find(x => x.kind === 'derelict' && x.risk <= 30)!;
    expect(sim.command(me, { c: 'setOp', group: groupOf(sim, me).id, op: { k: 'recover', wreck: o.id } })).toBeNull();
    expect(until(sim, () => co.milestones.includes('first_salvage'), 1800)).toBe(true);
    expect(until(sim, () => (firstBusinessStatus(sim.st, me)!.pnl.income.sales ?? 0) > 0, 1200)).toBe(true);
    const s = firstBusinessStatus(sim.st, me)!;
    expect(s.salvage!.units).toBeGreaterThan(0);
    expect(s.steps.find(x => x.id === 'unload')!.done).toBe(true);
    expect(s.steps.find(x => x.id === 'sell')!.done).toBe(true);
    // nothing is forced: the fleet stands by when the target is done (no automatic next target)
    until(sim, () => groupOf(sim, me).op.k === 'idle', 2400);
    expect(groupOf(sim, me).op.k).toBe('idle');
  }, 120000);

  it('S19: a world converted later (migration) gets its derelicts once; a non-salvage world refuses', () => {
    const sim = WorldSim.create(17, { layout: 'p10', factionEcon: 'v2', combat: 'p11', ops: 'p12', logistics: 'p125', salvage: 'p131' });
    expect(sim.st.derelictV).toBeUndefined();
    const r = enableDerelicts(sim.st, sim.time);
    expect(r.made).toBeGreaterThan(5);
    expect(enableDerelicts(sim.st, sim.time).made).toBe(0);
    const legacy = WorldSim.create(17);
    expect(enableDerelicts(legacy.st, legacy.time).made).toBe(0); expect(legacy.st.derelictV).toBeUndefined();
  });

  it('S20: derelict value matches the survey estimate it was posted with (no hidden extra)', () => {
    const sim = world();
    for (const x of derelicts(sim)) {
      const v = x.lots.reduce((a, l) => a + l.n * lotValue(sim.st, l), 0);
      expect(Math.abs(v - x.est!)).toBeLessThanOrEqual(50);
    }
  });
});
