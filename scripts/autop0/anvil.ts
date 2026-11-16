// AUTO-P0 scenario: the A-3.2a anvil miner (titanium field: ore, titanium ore, silicate), 2 game hours.
// modes: base (no policy: the A-3.2a result) | policy (silicate auto-sale, ore 500 kept, hauler moved to the pool)
//        | nohauler (policy, but the hauler stays in the mining fleet) | blocked (policy, every silicate market closed)
//        | p1 (AUTO-P1: policy, the hauler stays in the mining fleet, sale round trips and automatic repair allowed)
import { writeFileSync, mkdirSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { qty, cargoSum } from '../../src/world/types';
import { firstBusinessStatus } from '../../src/world/firstBusiness';

const mode = process.argv[2] ?? 'policy', hours = Number(process.argv[3] ?? 2), out = process.argv[4] ?? 'artifacts/autop0';
const sim = WorldSim.create(21, { ...STANDARD_WORLD });
const me = sim.addPlayer('앤빌 채굴', 'miner'), co = sim.st.companies[me];
const port = sim.st.stations.p9_anvil_port;
const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
const ok = (e: string | null, what: string) => { if (e) throw new Error(`${what}: ${e}`); };
const silMarkets = Object.values(sim.st.stations).filter(s => s.market?.silicate).map(s => s.id);
if (mode !== 'base') {
  ok(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } }), 'silicate policy');
  ok(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 1, station: port.id, keep: 500 } }), 'ore keep');
  ok(sim.command(me, { c: 'salesPolicy', settings: { item: 'titanium_ore', sell: true, minPrice: 3 } }), 'titanium policy');
}
let repairs = 0, repairCost = 0;
const hauler = mode === 'policy' || mode === 'blocked' ? sim.subtreeShips(g).find(s => s.classId === 'hauler')! : undefined;
if (hauler) {
  ok(sim.command(me, { c: 'newGroup', name: '판매 수송반', ships: [hauler.id] }), 'split hauler');
}
if (mode === 'p1') {
  ok(sim.command(me, { c: 'autoOpsPolicy', minerSales: true, repair: { enabled: true, minCredits: 5000, maxPerRepair: 5000, perHour: 10000 } }), 'auto ops');
}
if (mode === 'blocked') for (const id of silMarkets) delete sim.st.stations[id].market!.silicate;
ok(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_titanium', deliver: port.id, sell: true } }), 'mine');
const c0 = co.credits;
const silicateTotal = () => {
  let n = 0; for (const st of Object.values(sim.st.stations)) n += qty(st.storage[me], 'silicate');
  for (const s of Object.values(sim.st.ships)) if (s.owner === me) n += qty(s.cargo, 'silicate');
  return n;
};
const samples: any[] = [];
let minedSil = 0, soldSil = 0, soldSilValue = 0, oreMin = Infinity, oreAfter500 = Infinity, full = -1;
const prodListener = (e: any) => {};
for (let t = 1; t <= hours * 3600; t++) {
  const before = sim.st.companies[me].stats.mined;
  sim.update(1);
  // the player repairs a damaged sales hauler when it is docked (the pool never sends a hull under 40%)
  if (t % 30 === 0 && hauler && hauler.hp < 0.4 && hauler.state === 'docked' && hauler.task.k === 'docked') {
    const c = co.credits; if (!sim.command(me, { c: 'repair', ship: hauler.id })) { repairs++; repairCost += c - co.credits; }
  }
  if (t % 60 === 0) {
    const ore = qty(port.storage[me], 'ore');
    if (t > 1800) oreAfter500 = Math.min(oreAfter500, ore);
    const used = Object.values(port.storage[me] ?? {}).reduce((a, b) => a + (b as number), 0);
    if (full < 0 && used >= 1999) full = t;
    samples.push({ t, credits: Math.round(co.credits), store: Object.fromEntries(Object.entries(port.storage[me] ?? {}).map(([k, v]) => [k, Math.round(v as number)])), used: Math.round(used), aboard: Math.round(Object.values(sim.st.ships).filter(s => s.owner === me).reduce((n, s) => n + cargoSum(s.cargo), 0)), silicate: Math.round(silicateTotal()), status: { ...(co.procurement?.salesStatus ?? {}) } });
  }
}
const jobs = Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me);
const salesBy = (item: string) => jobs.filter(j => j.item === item && j.kind === 'sell').reduce((a, j) => ({ n: a.n + j.delivered, v: a.v + j.earned, lost: a.lost + j.lost }), { n: 0, v: 0, lost: 0 });
const s = firstBusinessStatus(sim.st, me)!;
const autoRepairs = co.procurement?.repair?.log ?? [];
const minerTrips = jobs.filter(j => j.miner);
const sum = {
  mode, hours, credits0: c0, repairs, repairCost: Math.round(repairCost), mined: Math.round(co.stats.mined),
  autoRepairs: autoRepairs.length, autoRepairCost: Math.round(autoRepairs.reduce((n, x) => n + x.n, 0)),
  minerTrips: { started: minerTrips.length, complete: minerTrips.filter(j => j.state === 'complete').length, cancelled: minerTrips.filter(j => j.state === 'cancelled').length, sold: Math.round(minerTrips.reduce((n, j) => n + j.delivered, 0)), earned: Math.round(minerTrips.reduce((n, j) => n + j.earned, 0)) },
  minerTripReason: co.procurement?.minerTrip?.reason, haulerHp: sim.subtreeShips(g).find(x => x.classId === 'hauler')?.hp, credits: Math.round(co.credits), net: Math.round(co.credits - c0), pnl: s.pnl,
  storeEnd: samples.at(-1).store, usedEnd: samples.at(-1).used, aboardEnd: samples.at(-1).aboard, fullAt: full,
  silicateHeldEnd: Math.round(silicateTotal()), silicateShipped: salesBy('silicate'), oreKeptMinAfter30min: Math.round(oreAfter500),
  salesStatus: co.procurement?.salesStatus, jobs: jobs.map(j => ({ id: j.id, item: j.item, kind: j.kind, from: j.from, to: j.to, amount: j.amount, state: j.state, delivered: j.delivered, earned: Math.round(j.earned), sale: !!j.sale, reason: j.reason })),
};
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/anvil-${mode}.json`, JSON.stringify({ ...sum, samples }, null, 1));
console.log(JSON.stringify({ ...sum, jobs: sum.jobs.length, salesStatus: Object.fromEntries(Object.entries(sum.salesStatus ?? {}).map(([k, v]: any) => [k, v.reason])) }, null, 1));
