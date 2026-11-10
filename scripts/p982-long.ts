// Disposable deterministic workloads. All transfers, production and building use the game engine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WorldSim } from '../src/world/sim';
import { qty, type Station } from '../src/world/types';
import { moduleMaterials } from '../src/world/stations';
import { buildNeeds } from '../src/world/production';
import { TECHS } from '../src/world/industry';
import { grantBlueprint, hullBlueprint } from '../src/world/blueprints';
import { planProcurement } from '../src/world/procurement';
import { dispatchPool } from '../src/world/autonomousLogistics';
import { moneySupply, observeWorld, type Observation } from '../src/world/observe';

type TestCase = { companies: number; shipsPerCompany: number; seconds: number; sustained: boolean };
function run(c: TestCase) {
  let sim = WorldSim.create(98201); const owners: string[] = [], ids: { owner: string; target: string; plan: string; order: string; hull: string }[] = [];
  for (let i = 0; i < c.companies; i++) owners.push(sim.addPlayer(`P982 company ${i}`));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const system of Object.values(sim.st.systems)) system.security = 100;
  const base = sim.st.stations.astra;
  for (let i = 0; i < owners.length; i++) {
    const p = owners[i], co = sim.st.companies[p]; co.credits = 1e8; co.tech = Object.keys(TECHS); base.storage[p] = {};
    const make = (suffix: string, dx: number, modules: string[]): Station => ({ ...structuredClone(base), id: `p982_${i}_${suffix}`, name: `${i} ${suffix}`, public: false, owner: p, pos: { ...base.pos, x: base.pos.x + dx }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: modules.map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) });
    const site = make('site', 500 + 80 * i, ['core', 'power', 'refinery', 'logistics', 'yard_s']), warehouse = make('warehouse', -500 - 80 * i, ['core']), warehouse2 = make('warehouse2', -1200 - 80 * i, ['core']);
    sim.st.stations[site.id] = site; sim.st.stations[warehouse.id] = warehouse; if (c.sustained) sim.st.stations[warehouse2.id] = warehouse2;
    const group = sim.newGroup(p, 'shared procurement'), ships = [];
    for (let n = 0; n < c.shipsPerCompany; n++) { const s = sim.spawnShip(p, 'hauler', 'std', group.id, base.pos); (sim as any).dockShip(s, base); ships.push(s.id); }
    const must = (error: string | null) => { if (error) throw Error(error); };
    must(sim.command(p, { c: 'poolShips', ships, on: true }));
    must(sim.command(p, { c: 'queueModule', station: site.id, kind: 'warehouse' })); const module = site.modules.find(m => m.kind === 'warehouse')!;
    const batches = c.sustained ? 500 : 3;
    must(sim.command(p, { c: 'prodOrder', station: site.id, recipe: 'alloy_direct', mode: 'count', n: batches })); const order = site.orders![0];
    const hull = 'patrol_pathfinder'; if (!grantBlueprint(sim.st, co, hullBlueprint(hull)!, 'p982 performance fixture', sim.time)) throw Error('blueprint fixture');
    must(sim.command(p, { c: 'buildShip', station: site.id, classId: 'corvette', loadoutId: '', hull, variant: 'patrol_pathfinder_std', preset: 'pathfinder_patrol' })); const build = site.builds![0];
    const need: Record<string, number> = { ore: batches * 60 };
    for (const x of [moduleMaterials(module), buildNeeds(build.classId, build.loadoutId, build.fit, build)]) for (const [item, n] of Object.entries(x)) need[item] = (need[item] ?? 0) + n;
    for (const [item, n] of Object.entries(need)) {
      if (c.sustained) { base.storage[p][item] = Math.min(1000, Math.floor(n / 3)); const rest = n - base.storage[p][item]; warehouse.storage[p][item] = Math.floor(rest / 2); warehouse2.storage[p][item] = rest - warehouse.storage[p][item]; }
      else { base.storage[p][item] = Math.floor(n / 2); warehouse.storage[p][item] = n - Math.floor(n / 2); }
    }
    ids.push({ owner: p, target: site.id, plan: module.id!, order: order.id, hull });
  }
  const scan = (p: string) => {
    const result: Record<string, number> = {}; const add = (item: string, n: number) => { result[item] = (result[item] ?? 0) + n; };
    for (const st of Object.values(sim.st.stations)) { for (const [item, n] of Object.entries(st.storage[p] ?? {})) add(item, n); if (st.owner === p) for (const m of st.modules) for (const [item, n] of Object.entries(m.reserved ?? {})) add(item, n); }
    for (const s of Object.values(sim.st.ships)) if (s.owner === p) for (const [item, n] of Object.entries(s.cargo)) add(item, n);
    for (const j of Object.values(sim.st.logisticsJobs ?? {})) if (j.owner === p) add(j.item, j.reserved);
    return result;
  };
  const baseline = Object.fromEntries(owners.map(p => [p, scan(p)])); const moneyBefore = moneySupply(sim.st);
  const consumed: Record<string, number> = {}, produced: Record<string, number> = {}; let created = 0, destroyed = 0;
  const receive = (e: Observation) => {
    if (e.company && e.item && owners.includes(e.company) && (e.kind === 'consume' || e.kind === 'produce')) { const map = e.kind === 'consume' ? consumed : produced, key = JSON.stringify([e.company, e.item]); map[key] = (map[key] ?? 0) + e.amount; }
    if (e.kind === 'currency.create') created += e.amount; if (e.kind === 'currency.destroy') destroyed += e.amount;
  };
  let unobserve = observeWorld(sim.st, receive);
  const startPlan = performance.now(); planProcurement(sim); const firstPlanMs = performance.now() - startPlan;
  const startDispatch = performance.now(); dispatchPool(sim); const firstDispatchMs = performance.now() - startDispatch;
  const firstWait: Record<string, number> = {}, secured: Record<string, number> = {}; const samples: number[] = [], hourly: object[] = []; let idle = 0, empty = 0;
  const started = performance.now();
  for (let tick = 0; tick < c.seconds * 4; tick++) {
    const start = performance.now(); sim.update(.25); const ms = performance.now() - start; if (tick % 40 === 0) samples.push(ms);
    if (tick % 4 === 0) {
      for (const j of Object.values(sim.st.logisticsJobs ?? {})) if (j.procurement && j.ship && firstWait[j.id] === undefined) firstWait[j.id] = sim.time - j.created;
      for (const s of Object.values(sim.st.ships)) if (owners.includes(s.owner) && s.classId === 'hauler') { if (!s.logisticsJob) idle++; else if (!(sim.st.logisticsJobs?.[s.logisticsJob]?.carried) && (s.warp || Math.hypot(s.vel.x, s.vel.z) > 1)) empty++; }
      for (const x of ids) {
        const st = sim.st.stations[x.target], m = st.modules.find(m => m.id === x.plan);
        if (m?.secured && secured[`${x.owner}:construction`] === undefined) secured[`${x.owner}:construction`] = sim.time;
        if (st.jobs?.some(j => j.order === x.order) && secured[`${x.owner}:production`] === undefined) secured[`${x.owner}:production`] = sim.time;
        if (st.builds?.some(b => b.started) && secured[`${x.owner}:ship`] === undefined) secured[`${x.owner}:ship`] = sim.time;
      }
    }
    if (tick + 1 === c.seconds * 2) { unobserve(); sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); unobserve = observeWorld(sim.st, receive); }
    if (c.seconds >= 28800 && (tick + 1) % (3600 * 4) === 0) { const hour = (tick + 1) / 14400; hourly.push({ hour, procurementJobs: Object.values(sim.st.logisticsJobs ?? {}).filter(j => !!j.procurement).length, producedAlloy: owners.reduce((n, p) => n + (produced[JSON.stringify([p, 'alloy'])] ?? 0), 0), heapUsedBytes: process.memoryUsage().heapUsed }); console.log(`${c.companies} companies: ${hour} / 8 game hours`); }
  }
  unobserve(); const elapsedMs = performance.now() - started, jobs = Object.values(sim.st.logisticsJobs ?? {}), delta: Record<string, number> = {};
  for (const p of owners) { const end = scan(p); for (const item of new Set([...Object.keys(baseline[p]), ...Object.keys(end)])) { const key = JSON.stringify([p, item]); const d = (end[item] ?? 0) + (consumed[key] ?? 0) - (produced[key] ?? 0) - (baseline[p][item] ?? 0); if (Math.abs(d) > 1e-5) delta[key] = d; } }
  const sorted = [...samples].sort((a, b) => a - b), goals = ids.flatMap(x => { const st = sim.st.stations[x.target]; return [!!st.modules.find(m => m.id === x.plan)?.built, !st.orders?.some(o => o.id === x.order), Object.values(sim.st.ships).some(s => s.owner === x.owner && s.hull === x.hull)]; });
  const outstanding = jobs.filter(j => j.procurement && j.state !== 'cancelled' && j.state !== 'complete');
  const result = { ...c, goalSuccess: goals.filter(Boolean).length, goals: goals.length, procurementJobs: jobs.filter(j => !!j.procurement).length, completedJobs: jobs.filter(j => !!j.procurement && j.state === 'complete').length, activeOrWaiting: outstanding.length, possibleDuplicateOutstanding: outstanding.filter(j => outstanding.some(k => k.id !== j.id && k.procurement === j.procurement && k.from === j.from)).length, lost: jobs.reduce((n, j) => n + j.lost, 0), purchaseSpend: owners.reduce((n, p) => n + (sim.st.companies[p].procurement?.spent ?? 0), 0), meanFirstDispatchWaitSeconds: Object.values(firstWait).reduce((a, b) => a + b, 0) / (Object.keys(firstWait).length || 1), meanFirstMaterialReadySeconds: Object.values(secured).reduce((a, b) => a + b, 0) / (Object.keys(secured).length || 1), readinessSamples: Object.keys(secured).length, idleShipSeconds: idle, emptyTravelShipSeconds: empty, firstPlanMs, firstDispatchMs, tickMeanMs: samples.reduce((a, b) => a + b, 0) / samples.length, tickP95Ms: sorted[Math.floor(.95 * sorted.length)], tickMaxMs: sorted.at(-1), elapsedMs, heapUsedBytes: process.memoryUsage().heapUsed, hourly, itemConservationErrors: delta, currencySupplyError: moneySupply(sim.st) - moneyBefore - created + destroyed };
  console.log(JSON.stringify(result)); if (Object.keys(delta).length) throw Error(`item conservation: ${JSON.stringify(delta)}`); return result;
}
const selected = Number(process.argv.find(a => /^--companies=/.test(a))?.split('=')[1] ?? 1), shipsPerCompany = Number(process.argv.find(a => /^--ships=/.test(a))?.split('=')[1] ?? 3), seconds = process.argv.includes('--long') ? 28800 : 600, sustained = process.argv.includes('--sustained');
mkdirSync('artifacts/p982', { recursive: true });
const results = [run({ companies: selected, shipsPerCompany, seconds, sustained })];
writeFileSync(`artifacts/p982/${seconds === 28800 ? 'long' : 'sample'}${sustained ? '-sustained' : ''}-${selected}${shipsPerCompany === 3 ? '' : `-ships${shipsPerCompany}`}.json`, JSON.stringify(results, null, 2));
