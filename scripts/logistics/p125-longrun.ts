// P12.5 §14 unattended long runs: companies own raw-material stations and a factory in different systems,
// queue long production orders and one construction project, and never touch logistics. Natural pirate
// lairs stay active. Measures duplicate assignments, idle haulers, delivered volume, production and
// construction progress, losses, per-item conservation, ledger integrity, tick cost, save growth, stalls.
//   npx vite-node scripts/logistics/p125-longrun.ts -- <companies> <haulersPerCompany> <hours> [seed]
import { mkdirSync, appendFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import type { Station } from '../../src/world/types';
import { qty } from '../../src/world/types';
import { observeWorld } from '../../src/world/observe';
import { haulerAvailability, poolMember } from '../../src/world/haulers';
import { storageCap } from '../../src/world/production';

const [companies = 1, perCo = 5, hours = 8, seed = 1250] = process.argv.slice(2).filter(a => /^\d+(\.\d+)?$/.test(a)).map(Number);
const sim = WorldSim.create(seed, { logistics: 'p125' });
const ids: string[] = [], sites: { p: string; A: Station; B: Station; C: Station }[] = [];
// systems with gates, paired so that each company's stations sit in neighbouring systems
const systems = Object.values(sim.st.systems).filter(s => s.gates.length >= 2 && s.id !== 'astra').sort((a, b) => a.idx - b.idx);
const astra = sim.st.stations.astra;
const make = (p: string, id: string, sys: typeof systems[number], k: number, modules: string[]): Station => ({ ...structuredClone(astra), id, name: id, public: false, owner: p, pos: { x: sys.origin.x + 2500 + k * 1700, y: 0, z: sys.origin.z - 2000 + k * 900 }, size: 'L', market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} },
  modules: modules.map((kind, i) => ({ id: `${id}_${kind}_${i}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] } as Station);
for (let i = 0; i < companies; i++) {
  const p = sim.addPlayer(`물류${i + 1}`), co = sim.st.companies[p]; co.credits = 5e6; ids.push(p);
  const home = systems[(i * 3) % systems.length], n1 = sim.st.systems[home.gates[0].to], n2 = sim.st.systems[home.gates[1].to];
  const store = ['core', 'power', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'dock', 'dock'];
  const A = make(p, `lr_${i}_A`, n1, i, store), B = make(p, `lr_${i}_B`, n2, i, store);
  const C = make(p, `lr_${i}_C`, home, i, ['core', 'power', 'power', 'refinery', 'refinery', 'logistics', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'dock', 'dock']);
  for (const s of [A, B, C]) sim.st.stations[s.id] = s;
  A.storage[p].ore = Math.floor(storageCap(A) * 0.9); B.storage[p].ore = Math.floor(storageCap(B) * 0.9);
  // construction materials at A for one warehouse expansion at C
  A.storage[p].alloy = 3000; A.storage[p].structure = 300; A.storage[p].machinery = 100;
  co.homeStation = C.id;
  for (let g = 0, made = 0; made < perCo; g++) {
    const grp = sim.newGroup(p, `수송${g + 1}`);
    for (let k = 0; k < 5 && made < perCo; k++, made++) { const s = sim.spawnShip(p, 'hauler', 'std', grp.id, [A, B, C][made % 3].pos); (sim as any).dockShip(s, [A, B, C][made % 3]); }
  }
  sites.push({ p, A, B, C });
}
// credits before the player's own commands, so that order / construction costs are inside the ledger window
const credits0 = Object.fromEntries(ids.map(p => [p, sim.st.companies[p].credits]));
for (const { p, C } of sites) {
  for (let k = 0; k < 2; k++) { const err = sim.command(p, { c: 'prodOrder', station: C.id, recipe: 'alloy_direct', mode: 'count', n: 5000 }); if (err) throw Error(err); }
  const err = sim.command(p, { c: 'queueModule', station: C.id, kind: 'warehouse' }); if (err) console.error('construction', err);
}
const items = ['ore', 'alloy', 'structure', 'machinery'];
const holding = (p: string, item: string) => { let n = 0; for (const st of Object.values(sim.st.stations)) n += qty(st.storage[p], item); for (const s of Object.values(sim.st.ships)) if (s.owner === p) n += qty(s.cargo, item); for (const j of Object.values(sim.st.logisticsJobs ?? {})) if (j.owner === p && j.item === item) n += j.reserved; return n; };
const start = Object.fromEntries(ids.map(p => [p, Object.fromEntries(items.map(i => [i, holding(p, i)]))]));
const flow: Record<string, Record<string, number>> = Object.fromEntries(ids.map(p => [p, {}]));
// delivered / lost come from events: completed shipments are pruned from the save, so summing jobs would undercount
const unloaded: Record<string, number> = Object.fromEntries(ids.map(p => [p, 0]));
const lostEv: Record<string, Record<string, number>> = Object.fromEntries(ids.map(p => [p, {}]));
const stop = observeWorld(sim.st, e => { if (!e.company || !flow[e.company] || !e.item) return; if (e.kind === 'logistics' && e.reason === 'unload' && !e.route) unloaded[e.company] += e.amount; if (e.kind === 'consume' && e.reason === 'combat_cargo_loss') lostEv[e.company][e.item] = (lostEv[e.company][e.item] ?? 0) + e.amount; if (!items.includes(e.item)) return; const f = flow[e.company]; if (e.kind === 'consume') f[e.item] = (f[e.item] ?? 0) - e.amount; else if (e.kind === 'produce') f[e.item] = (f[e.item] ?? 0) + e.amount; });
const save0 = sim.serialize().length;
let dupes = 0, samples = 0, idleSum = 0, starved = 0, maxLive = 0, logicErr = 0;
const dts: number[] = [];
const T = Math.round(hours * 3600);
for (let t = 1; t <= T; t++) {
  const t0 = performance.now(); sim.update(1); dts.push(performance.now() - t0);
  if (t % 60 === 0) {
    samples++;
    const jobs = Object.values(sim.st.logisticsJobs ?? {}), live = jobs.filter(j => j.state !== 'complete' && j.state !== 'cancelled');
    maxLive = Math.max(maxLive, jobs.length);
    const byShip = new Map<string, number>(); for (const j of live) if (j.ship) byShip.set(j.ship, (byShip.get(j.ship) ?? 0) + 1);
    dupes += [...byShip.values()].filter(n => n > 1).length;
    for (const j of live) if (j.ship && sim.st.ships[j.ship]?.logisticsJob !== j.id) logicErr++;
    const members = Object.values(sim.st.ships).filter(s => ids.includes(s.owner) && poolMember(sim.st, s));
    const avail = members.filter(s => haulerAvailability(sim, s).ok);
    idleSum += members.length ? avail.length / members.length : 0;
    if (avail.length && live.some(j => j.code === 'ship' && ids.includes(j.owner) && avail.some(s => s.owner === j.owner))) starved++;
  }
}
stop();
const jobs = Object.values(sim.st.logisticsJobs ?? {});
const per = ids.map(p => {
  const co = sim.st.companies[p], mine = jobs.filter(j => j.owner === p), site = sites.find(x => x.p === p)!;
  // combat cargo losses are 'consume' events, so they are already inside flow
  const lost = lostEv[p];
  const conservation = Object.fromEntries(items.map(i => [i, +(holding(p, i) - (start[p][i] + (flow[p][i] ?? 0))).toFixed(3)]));
  const ledger = co.ops ? co.ops.ledger.reduce((n, h) => n + Object.values(h.inc).reduce((a, b) => a + b, 0) - Object.values(h.exp).reduce((a, b) => a + b, 0), 0) : 0;
  const stalled = mine.filter(j => j.state !== 'complete' && j.state !== 'cancelled' && sim.time - j.updated > 3600).map(j => `${j.item}:${j.state}:${j.code ?? ''}:${(j.reason ?? '').slice(0, 40)}`);
  return { company: co.name, haulersAlive: Object.values(sim.st.ships).filter(s => s.owner === p && s.classId === 'hauler').length, delivered: Math.round(unloaded[p]), shipmentsStored: mine.length,
    alloyProduced: Math.round(flow[p].alloy ?? 0), oreConsumed: Math.round(-(flow[p].ore ?? 0)), constructionDone: site.C.modules.filter(m => m.kind === 'warehouse').every(m => m.built), lost, conservation,
    ledgerGap: hours <= 48 ? Math.round(ledger - (co.credits - credits0[p])) : null, stalled: stalled.length, stalledSample: stalled.slice(0, 3) };
});
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
const out = { case: `${companies} co × ${perCo} haulers, ${hours} h`, seed, simHours: hours, duplicateAssignments: dupes, assignmentMismatch: logicErr, idleShare: +(idleSum / Math.max(1, samples)).toFixed(3), starvedSamples: starved, samples,
  meanMsPerSimSecond: +mean.toFixed(2), p95Ms: +q(dts, .95).toFixed(2), maxMs: +Math.max(...dts).toFixed(1), saveBytesStart: save0, saveBytesEnd: sim.serialize().length, jobsStored: jobs.length, maxJobsStored: maxLive, per };
console.log(JSON.stringify(out, null, 1));
mkdirSync('docs/logistics-results', { recursive: true }); appendFileSync('docs/logistics-results/p125-longrun.jsonl', JSON.stringify(out) + '\n');
