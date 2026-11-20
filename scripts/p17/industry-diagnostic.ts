// Standard-world passive salvage and navy repair diagnostic. SEED, SECONDS, FRONTIER, MIN_FEE, MUL and RIG are optional.
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { WorldSim } from '../../src/world/sim';
import { jumps, dist } from '../../src/world/geom';
import { allSites } from '../../src/world/wrecks';
import { hostileNear, SALV, workable } from '../../src/world/salvage';
import { inspectRepairCandidate, RB } from '../../src/world/repairBiz';
import { pnlRows } from '../../src/world/industryPnl';
import { observeWorld } from '../../src/world/observe';

const seed = Number(process.env.SEED ?? 31), seconds = Number(process.env.SECONDS ?? 1800);
const sim = WorldSim.create(seed, { ...STANDARD_WORLD });
const salv = sim.addPlayer('인양 진단', 'salvager'), repair = sim.addPlayer('수리 진단');
const group = Object.values(sim.st.groups).find(g => g.owner === salv && g.shipIds.length)!;
const co = sim.st.companies[salv], home = sim.st.stations[co.homeStation];
const ship = Object.values(sim.st.ships).find(s => s.owner === repair && s.ind && s.fitting)!;
ship.fitting!.bay = { ind1: process.env.RIG ?? 'ind_rep_s' };
for (let i = 0; i < 30; i++) sim.update(1);
if (process.env.FRONTIER) {
  const base = sim.st.stations[process.env.FRONTIER];
  if (!base) throw new Error('Unknown repair base');
  ship.pos = { ...base.pos, x: base.pos.x + base.radius + 500 };
  ship.state = 'space'; ship.task = { k: 'none' };
}
const issue = (owner: string, command: Parameters<WorldSim['command']>[1]) => {
  const err = sim.command(owner, command); if (err) throw new Error(err);
};
issue(salv, { c: 'setOp', group: group.id, op: { k: 'salvzone', at: home.pos, radius: 6000, biz: true } });
issue(repair, { c: 'newGroup', name: '수리 진단', ships: [ship.id] });
const rg = sim.st.groups[ship.groupId], anchor = { ...ship.pos };
const mul = Number(process.env.MUL ?? 1.2), minFee = Number(process.env.MIN_FEE ?? 50);
const repairOp = { k: 'repairbiz', at: anchor, jumps: 1, mul, clients: 'npc', minFee, avoidRisk: true } as const;
issue(repair, { c: 'setOp', group: rg.id, op: repairOp });
const c0 = [salv, repair].map(id => sim.st.companies[id].credits);
const sites = new Map<string, Set<string>>(), patients = new Map<string, Set<string>>();
function add(map: Map<string, Set<string>>, reason: string, id: string) {
  if (!map.has(reason)) map.set(reason, new Set());
  map.get(reason)!.add(id);
}
const possible = (p: typeof home.pos, anchor: typeof home.pos) => {
  const a = sim.sysOf(anchor), b = sim.sysOf(p);
  return !!a && !!b && (a.id === b.id || jumps(sim.st.systems, a.id, b.id) <= 1);
};
const hp = new Map<string, number>(), jobs: Record<string, number> = {};
const sold = new Map<string, number>(), unloaded = new Map<string, number>(), worked = new Set<string>();
const damagedSystems = new Map<string, Set<string>>();
const peakDebt: Record<string, number> = {};
const paidShips = new Set<string>();
let sales = 0, savedSeconds = 0, paidToRepair = 0;
const first = { work: 0, sale: 0 };
observeWorld(sim.st, e => {
  if (e.company === salv && e.kind === 'market' && e.reason === 'sell') {
    sold.set(e.item!, (sold.get(e.item!) ?? 0) + e.amount); sales += e.value ?? 0; first.sale ||= sim.time;
  }
  if (e.company === salv && e.kind === 'logistics' && e.reason === 'salvage_unload') unloaded.set(e.item!, (unloaded.get(e.item!) ?? 0) + e.amount);
  if (e.company === salv && e.ref && e.kind === 'salvage' && e.reason === 'recover') { worked.add(e.ref); first.work ||= sim.time; }
  if (e.company === repair && e.kind === 'repair_job') {
    jobs[e.reason!] = (jobs[e.reason!] ?? 0) + 1;
    if (e.reason === 'complete') savedSeconds += e.value ?? 0;
  }
  if (e.kind === 'cost' && e.reason === 'repair_service' && e.to === repair && e.method?.startsWith('faction:')) {
    paidToRepair += e.amount; if (e.ship) paidShips.add(e.ship);
  }
});
for (let i = 0; i < seconds; i++) {
  sim.update(1);
  for (const id of [salv, repair]) peakDebt[id] = Math.max(peakDebt[id] ?? 0, sim.st.companies[id].upkeep?.debt ?? 0);
  if (i % 10 !== 0) continue;
  for (const w of allSites(sim.st)) {
    add(sites, 'world', w.id);
    if (!possible(w.pos, home.pos)) { add(sites, 'outOfRange', w.id); continue; }
    add(sites, 'inRange', w.id);
    if (!workable(sim, sim.shipsOf(group), w, false)) { add(sites, 'gearAccessOrHold', w.id); continue; }
    if (hostileNear(sim, salv, w.pos, SALV.hostileR)) add(sites, 'hostile', w.id);
    else add(sites, 'workable', w.id);
  }
  for (const s of Object.values(sim.st.ships)) {
    if (sim.st.companies[s.owner]?.kind !== 'union') continue;
    const g = sim.st.groups[s.groupId], base = sim.st.stations[g?.npc?.home ?? ''];
    const old = hp.get(s.id) ?? 1; hp.set(s.id, s.hp);
    if (s.hp < old - 1e-6) {
      add(patients, 'damage', s.id);
      add(damagedSystems, sim.sysOf(s.pos)?.id ?? '?', s.id);
    }
    if (s.state === 'space' && s.hp > old + 1e-6 && base && dist(s.pos, base.pos) < RB.homeR && !s.rbBy) add(patients, 'freeAtHome', s.id);
    if (g?.status === '손상 — 기지 귀환 수리') add(patients, 'returningHome', s.id);
    if (s.state !== 'space' || s.hp > 1 - RB.minHurt) continue;
    add(patients, 'damagedInSpace', s.id);
    if (!possible(s.pos, anchor)) continue;
    add(patients, 'inRange', s.id);
    const reason = inspectRepairCandidate(sim, rg, repairOp, s);
    add(patients, typeof reason === 'string' ? reason : 'eligible', s.id);
  }
}
const counts = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, v]) => [k, v.size]));
console.log(JSON.stringify({
  seed, seconds, home: home.id, repairSystem: sim.sysOf(anchor)?.id, sites: counts(sites), patients: counts(patients),
  damageBySystem: counts(damagedSystems), worked: worked.size, sold: Object.fromEntries(sold), unloaded: Object.fromEntries(unloaded),
  first, sales, salvaged: co.salvage?.units ?? 0, salvageStatus: group.status,
  repairJobs: jobs, repairIncome: rg.rbiz?.income ?? 0, paidToRepair, paidShips: paidShips.size, savedSeconds,
  companies: [salv, repair].map((id, i) => {
    const c = sim.st.companies[id];
    const cashOperating = (c.ops?.ledger ?? []).reduce((n, h) => n + (h.exp.upkeep ?? 0), 0);
    return { change: Math.round(c.credits - c0[i]), cashOperating: Math.round(cashOperating), debt: Math.round(c.upkeep?.debt ?? 0),
      peakDebt: Math.round(peakDebt[id]), rows: pnlRows(c, sim.time) };
  })
}, null, 2));
