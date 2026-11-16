// A-3.2b scenario runs: a Ceres salvager start (standard world, seed 21), 6 game hours with a 2-hour snapshot.
// The "player" is a bot that uses only ordinary commands, once a game minute, the way the guide offers them:
// accept a salvage contract it can reach (explicitly), otherwise `recover` the best target the guide lists, and
// the guide's "회수품 자동 판매" (salesPolicy). Nothing is forced or granted.
//   none     — A-3.2b off, the fleet does nothing (upkeep only: the "no opportunity" floor)
//   base     — A-3.2b off, battlefield wrecks only (the state before this stage)
//   derelict — A-3.2b on, natural derelicts and salvage contracts only, route risk ≤ 55
//   all      — A-3.2b on, every target the guide lists (derelicts, battle wrecks, jettisoned cargo), risk ≤ 55
//   safe     — A-3.2b on, A-3.2b.1 guide's recommended targets only (route risk ≤ 30, no hostile seen at the site; contracts ≤ 30)
//   risky    — A-3.2b on, prefers targets with route risk > 55 (danger space, no escort)
//   compete3 — A-3.2b on, three salvager companies at Ceres, each "all"
// usage: npx tsx scripts/a32b/salvage-scenarios.ts <mode> [hours=6] [outDir=docs/a32b-results] [seed=21]
import { writeFileSync, mkdirSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { qty } from '../../src/world/types';
import { firstBusinessStatus, salvageOpportunities, salvageStatus, salvageOperatingStatus, SALVAGE_SELL_ITEMS, type SalvageOption } from '../../src/world/firstBusiness';
import { observeWorld } from '../../src/world/observe';
import { assetReferenceValue } from '../../src/world/valuation';
import { storeUsed } from '../../src/world/storage';
import { hullPrice } from '../../src/world/valuation';

const mode = process.argv[2] ?? 'all', hours = Number(process.argv[3] ?? 6), outDir = process.argv[4] ?? 'docs/a32b-results', seed = Number(process.argv[5] ?? 21);
const on = !['none', 'base'].includes(mode);
const { derelicts: _off, ...noDerelicts } = STANDARD_WORLD;
const sim = WorldSim.create(seed, on ? { ...STANDARD_WORLD } : { ...noDerelicts });
const n = mode === 'compete3' ? 3 : 1;
const ids = Array.from({ length: n }, (_, i) => sim.addPlayer(`세레스 인양 ${i + 1}`, 'salvager'));
const ok = (e: string | null, what: string) => { if (e) throw new Error(`${what}: ${e}`); };
if (mode !== 'none') for (const me of ids) for (const item of SALVAGE_SELL_ITEMS) ok(sim.command(me, { c: 'salesPolicy', settings: { item, sell: true, minPrice: 0 } }), 'sales policy');
const groupOf = (me: string) => Object.values(sim.st.groups).find(g => g.owner === me && Object.values(sim.st.ships).some(s => s.owner === me && s.groupId === g.id));
const val = (k: string) => k.startsWith('bpf:') ? 500 : assetReferenceValue(sim.st, k);
// A-3.2b.1: recovered goods counted from the engine's own salvage events (the same in every mode — `co.salvage` is
// only kept when A-3.2b is on). Observation never consumes RNG or changes gameplay (observe.ts).
const EV = new Map<string, { units: number; value: number; items: Record<string, number> }>(ids.map(me => [me, { units: 0, value: 0, items: {} }]));
observeWorld(sim.st, e => {
  if (e.kind !== 'salvage' || e.reason !== 'recover' || !e.company || !e.item) return;
  const x = EV.get(e.company); if (!x) return;
  x.units += e.amount; x.value += e.amount * val(e.item); x.items[e.item] = (x.items[e.item] ?? 0) + e.amount;
});

interface Track { trips: Map<string, { item: string; amount: number; delivered: number; earned: number; state: string; returning: boolean; to: string }>; found: Set<string>; worked: Set<string>; accepted: number; lostValue: number; shipsSeen: Map<string, number>; peak: number; idleNoTarget: number; blocked: number; ks: Map<string, { progress: number; amount: number; done: boolean; ended?: string; reward: number }>; stalls: Record<string, number>; firstSalvage?: number; firstProfit?: number; picks: { t: number; id: string; kind: string; risk: number; value: number }[] }
const T = new Map<string, Track>(ids.map(me => [me, { trips: new Map(), found: new Set(), worked: new Set(), accepted: 0, lostValue: 0, shipsSeen: new Map(), peak: 0, idleNoTarget: 0, blocked: 0, ks: new Map(), stalls: {}, picks: [] }]));

function allowed(o: SalvageOption): boolean {
  if (mode === 'derelict') return o.kind === 'derelict' && o.risk <= 55;
  if (mode === 'risky') return o.risk > 55;
  if (mode === 'safe') return o.recommended;
  return o.risk <= 55;
}
function act(me: string) {
  const t = T.get(me)!, g = groupOf(me); if (!g) return;
  const ops = mode === 'none' ? [] : salvageOpportunities(sim.st, me).filter(o => mode !== 'base' || o.kind !== 'derelict');
  for (const o of ops) t.found.add(o.id);
  if (mode === 'none' || g.op.k !== 'idle') return;
  // a reachable contract first (explicit accept), then the guide's best allowed target
  if (on && mode !== 'risky') {
    const sv = salvageStatus(sim.st, me);
    const mine = sv.contracts.find(k => !k.done);
    const tgt = mine?.target && sim.st.wrecks?.[mine.target] ? mine.target : undefined;
    if (tgt) {
      const e = sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: tgt } });
      if (!e) { t.picks.push({ t: sim.time, id: tgt, kind: 'contract', risk: 0, value: 0 }); return; }
      t.stalls[`계약 대상: ${e}`] = (t.stalls[`계약 대상: ${e}`] ?? 0) + 1;   // e.g. the ships that could work it were lost
    }
    const k = sv.board.find(b => b.risk <= (mode === 'safe' ? 30 : 55) && b.target && sim.st.wrecks?.[b.target]);
    if (k && sim.command(me, { c: 'accept', contract: k.id }) === null) {
      t.accepted++;
      const e = sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: k.target! } });
      if (e) { t.stalls[`계약 대상: ${e}`] = (t.stalls[`계약 대상: ${e}`] ?? 0) + 1; return; }
      t.picks.push({ t: sim.time, id: k.target!, kind: 'contract', risk: k.risk, value: k.reward });
      return;
    }
  }
  const o = (mode === 'risky' ? [...ops].sort((a, b) => b.value - a.value) : ops).find(allowed);
  if (!o) { t.idleNoTarget++; return; }
  const err = sim.command(me, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: o.id } });
  if (err) { t.stalls[err] = (t.stalls[err] ?? 0) + 1; return; }
  t.picks.push({ t: sim.time, id: o.id, kind: o.kind, risk: o.risk, value: o.value });
}
function observe(me: string) {
  const t = T.get(me)!, co = sim.st.companies[me];
  for (const s of Object.values(sim.st.ships)) if (s.owner === me && !t.shipsSeen.has(s.id)) t.shipsSeen.set(s.id, s.hull ? hullPrice(s.hull, s.variant).price : 0);
  for (const [id, v] of t.shipsSeen) if (!sim.st.ships[id]) { t.lostValue += v; t.shipsSeen.delete(id); }   // NPC yard list price
  for (const st of Object.values(sim.st.stations)) t.peak = Math.max(t.peak, storeUsed(st.storage[me]));
  for (const id of co.salvage?.sites ?? []) t.worked.add(id);
  for (const j of Object.values(sim.st.logisticsJobs ?? {})) if (j.owner === me && j.salvTrip) t.trips.set(j.id, { item: j.item, amount: Math.round(j.amount), delivered: Math.round(j.delivered), earned: Math.round(j.earned), state: j.state, returning: !!j.returning, to: j.to });
  // every salvage contract we took, sampled each minute (finished ones are removed from the world 5 min after expiry)
  for (const k of Object.values(sim.st.contracts)) if (k.kind === 'salvage' && k.takenBy === me) t.ks.set(k.id, { progress: k.progress, amount: k.amount ?? 0, done: k.done, ended: k.ended, reward: k.reward });
  const g = groupOf(me);
  if (g?.status && /작업 불가|하역 가능한 정거장이 없습니다/.test(g.status)) { t.blocked++; t.stalls[g.status.slice(0, 60)] = (t.stalls[g.status.slice(0, 60)] ?? 0) + 1; }
  if (t.firstSalvage === undefined && co.milestones.includes('first_salvage')) t.firstSalvage = sim.time;
  if (t.firstProfit === undefined && co.milestones.includes('first_profit')) t.firstProfit = sim.time;
}
function report(me: string) {
  const co = sim.st.companies[me], t = T.get(me)!, s = firstBusinessStatus(sim.st, me)!, p = s.pnl;
  const stock: Record<string, number> = {};
  for (const st of Object.values(sim.st.stations)) for (const [k, v] of Object.entries(st.storage[me] ?? {})) if (v > 0.5) stock[k] = (stock[k] ?? 0) + v;
  for (const sh of Object.values(sim.st.ships)) if (sh.owner === me) for (const [k, v] of Object.entries(sh.cargo)) if (v > 0.5) stock[k] = (stock[k] ?? 0) + v;
  const r = Math.round;
  return {
    company: co.name, time: r(sim.time), credits: r(co.credits), netCash: r(co.credits - s.start), debt: r(co.upkeep?.debt ?? 0),
    firstSalvageAt: t.firstSalvage === undefined ? null : r(t.firstSalvage), firstProfitAt: t.firstProfit === undefined ? null : r(t.firstProfit),
    targetsSeen: t.found.size, targetsWorked: t.worked.size, picks: t.picks.length, pickKinds: t.picks.reduce((a, x) => { a[x.kind] = (a[x.kind] ?? 0) + 1; return a; }, {} as Record<string, number>),
    // engine events (every mode); `ledger*` is the A-3.2b company ledger (only kept when A-3.2b is on)
    recoveredUnits: r(EV.get(me)!.units), recoveredValue: r(EV.get(me)!.value), recoveredByItem: Object.fromEntries(Object.entries(EV.get(me)!.items).map(([k, v]) => [k, r(v)])),
    ledgerUnits: r(co.salvage?.units ?? 0), ledgerValue: r(co.salvage?.value ?? 0),
    saleTrips: (() => { const xs = [...t.trips.values()]; return { n: xs.length, done: xs.filter(x => x.state === 'complete').length, returned: xs.filter(x => x.returning).length, sold: xs.reduce((a, x) => a + x.delivered, 0), earned: xs.reduce((a, x) => a + x.earned, 0), items: xs.reduce((a, x) => { a[x.item] = (a[x.item] ?? 0) + x.delivered; return a; }, {} as Record<string, number>) }; })(),
    operating: (() => { const o = salvageOperatingStatus(sim.st, me); return { state: o.state, can: o.can, workers: o.workers, haulers: o.haulers, damagedHaulers: o.damagedHaulers, issues: o.issues, comeback: o.comeback && { credits: r(o.comeback.credits), stage: o.comeback.stage, offers: o.comeback.offers.map(x => `${x.hull}@${x.station} ${x.price}${x.affordable ? '' : ' (부족)'}`), steps: o.comeback.steps } }; })(),
    shipsLeft: Object.values(sim.st.ships).filter(x => x.owner === me).map(x => x.classId),
    contracts: (() => { const ks = [...t.ks.values()], ok = (k: { progress: number; amount: number }) => k.progress >= k.amount - 1e-6;
      return { accepted: t.accepted, done: ks.filter(k => k.done && ok(k)).length, failed: ks.filter(k => k.done && !ok(k)).length, open: ks.filter(k => !k.done).length,
        failReasons: ks.filter(k => k.done && !ok(k)).reduce((a, k) => { const r = k.ended ?? '기한 만료'; a[r] = (a[r] ?? 0) + 1; return a; }, {} as Record<string, number>),
        deliveredOnFailed: Math.round(ks.filter(k => k.done && !ok(k)).reduce((a, k) => a + k.progress, 0)) }; })(),
    marketRevenue: r(p.income.sales ?? 0), contractPay: r(p.income.other ?? 0), salesByItem: Object.fromEntries(Object.entries(p.sales).map(([k, v]) => [k, r(v)])),
    upkeep: r(p.expense.upkeep ?? 0), repair: r(p.expense.repair ?? 0), otherExpense: r(Object.entries(p.expense).filter(([k]) => !['upkeep', 'repair'].includes(k)).reduce((a, [, v]) => a + v, 0)),
    shipsLost: co.stats.lost, shipLossValue: r(t.lostValue),
    unsoldStock: Object.fromEntries(Object.entries(stock).map(([k, v]) => [k, r(v)])), unsoldValue: r(Object.entries(stock).reduce((a, [k, v]) => a + v * val(k), 0)),
    warehousePeak: r(t.peak), minutesIdleNoTarget: t.idleNoTarget, minutesBlocked: t.blocked, stalls: t.stalls,
    salesStatus: Object.fromEntries(Object.entries(co.procurement?.salesStatus ?? {}).filter(([, v]) => v.reason && !/초과 재고 없음/.test(v.reason)).map(([k, v]) => [k, v.reason])),
    milestones: co.milestones,
  };
}
const world = () => {
  const ds = Object.values(sim.st.wrecks ?? {});
  return { derelictsLive: ds.filter(x => x.origin === 'derelict').length, battleWrecksLive: ds.filter(x => !x.origin).length, derelictsMade: sim.st.derelicts?.spawned ?? 0, derelictValueMade: Math.round(sim.st.derelicts?.value ?? 0),
    salvageContractsPosted: Object.values(sim.st.contracts).filter(k => k.kind === 'salvage').length };
};
const snaps: Record<string, unknown> = {};
const t0 = Date.now();
for (let s = 1; s <= hours * 3600; s++) {
  sim.update(1);
  if (s % 60 === 0) for (const me of ids) { act(me); observe(me); }
  if (s === 2 * 3600 || s === hours * 3600) snaps[`${s / 3600}h`] = { world: world(), companies: ids.map(report) };
}
const out = { mode, seed, hours, wallSeconds: Math.round((Date.now() - t0) / 1000), snapshots: snaps, picks: Object.fromEntries(ids.map(me => [me, T.get(me)!.picks.slice(0, 60)])) };
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/${mode}-${hours}h-s${seed}.json`, JSON.stringify(out, null, 1));
const last = (snaps[`${hours}h`] as { companies: ReturnType<typeof report>[] }).companies;
console.log(mode, JSON.stringify(last.map(c => ({ net: c.netCash, sales: c.marketRevenue, contract: c.contractPay, upkeep: c.upkeep, lost: c.shipsLost, units: c.recoveredUnits, first: c.firstSalvageAt, profit: c.firstProfitAt }))));
void qty;
