// P10 performance observations (disposable worlds, single process). Reports numbers, imposes no threshold.
//   npx vite-node scripts/p10/performance.ts -- [out.json]
//
//   1. tick cost five / p9 / p10 (idle world, after a warm-up hour)
//   2. heavy load on p10: N companies each mining several unidentified deposits, plus a border war
//   3. sync bytes per client (full snapshot and steady-state deltas) with N companies on p9 and p10
//   4. per-company intel size and save size
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { newWorld } from '../../src/world/worldgen';
import { sysAt } from '../../src/world/geom';
import { SyncHub, ClientSync, syncMessage } from '../../src/server/sync';
import { startConflict } from '../../src/world/factionEcon';

type Layout = 'five' | 'p9' | 'p10';
const make = (layout: Layout, seed: number) => layout === 'five' ? new WorldSim(newWorld(seed)) : WorldSim.create(seed, layout === 'p10' ? { layout: 'p10' } : {});
const run = (sim: WorldSim, sec: number) => { for (let i = 0; i < sec; i++) sim.tick(1); };
function timeTicks(sim: WorldSim, n: number) {
  const cpu0 = process.cpuUsage(), t = performance.now();
  run(sim, n);
  const cpu = process.cpuUsage(cpu0);
  return { msPerTick: (performance.now() - t) / n, cpuMsPerTick: (cpu.user + cpu.system) / 1000 / n };
}

/** N player companies; each gets a group of `miners` mining ships on a different deposit (unidentified ones on p10) */
function populate(sim: WorldSim, companies: number, miners: number) {
  const fields = Object.values(sim.st.fields).filter(f => !f.salvage && (sim.st.worldLayout === 'p10' ? !!f.geo : true));
  const out: string[] = [];
  for (let c = 0; c < companies; c++) {
    const p = sim.addPlayer(`부하 ${c + 1}`); sim.st.companies[p].credits = 1e8;
    const f = fields[c % fields.length];
    const g = sim.newGroup(p, '채굴');
    for (let i = 0; i < miners; i++) sim.spawnShip(p, 'miner', 'std', g.id, { x: f.pos.x + 300 + i * 40, y: 0, z: f.pos.z });
    out.push(p);
    (sim as any).__pending = [...((sim as any).__pending ?? []), [p, g.id, f.id]];
  }
  run(sim, 3); // ships arrive → the deposit is discovered (fog worlds)
  for (const [p, g, f] of (sim as any).__pending as [string, string, string][]) {
    const err = sim.command(p, { c: 'setOp', group: g, op: { k: 'mine', field: f, deliver: '', sell: true, auto: true } } as any);
    if (err) console.error('mine refused', p, f, err);
  }
  return out;
}

function syncBytes(sim: WorldSim, companies: string[], frames: number) {
  const hub = new SyncHub(), cs = companies.map(() => new ClientSync());
  const first: number[] = [], delta: number[] = [];
  for (let i = 0; i <= frames; i++) {
    run(sim, 1);
    const frame = hub.frame(sim.st, sim.st.time, 1);
    companies.forEach((c, k) => {
      const m = syncMessage(frame, cs[k], { company: c }, 'helios', true);
      const b = m ? Buffer.byteLength(m) : 0;
      (i === 0 ? first : delta).push(b);
    });
    hub.done(frame);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return { fullBytesAvg: Math.round(avg(first)), fullBytesMax: Math.max(...first), deltaBytesPerFrameAvg: Math.round(avg(delta)), deltaBytesPerFrameMax: Math.max(...delta) };
}

const results: any = { note: 'single process; tick(1) = 1 simulated second; heavy = N companies × miners on separate deposits; sync = protocol-2 per-client messages, 1 frame per simulated second' };

// warm modules/JIT
for (const l of ['five', 'p9', 'p10'] as Layout[]) run(make(l, 1), 60);

// 1. idle tick cost
results.idle = (['five', 'p9', 'p10'] as Layout[]).map(l => {
  const sim = make(l, 1234); sim.addPlayer('관측'); run(sim, 3600);
  return { layout: l, systems: Object.keys(sim.st.systems).length, ships: Object.keys(sim.st.ships).length, ...timeTicks(sim, 1800), saveBytes: Buffer.byteLength(sim.serialize()) };
});
console.log('idle', results.idle);

// 2 + 3 + 4. load by company count
results.load = [] as any[];
for (const layout of ['p9', 'p10'] as Layout[]) for (const n of [1, 4, 8]) {
  const sim = make(layout, 4321);
  const cos = populate(sim, n, 6);
  run(sim, 600);
  const mining = timeTicks(sim, 900);
  const sync = syncBytes(sim, cos, 60);
  const intel = cos.map(c => Buffer.byteLength(JSON.stringify(sim.st.intel?.[c] ?? {})));
  const minedShips = Object.values(sim.st.ships).filter(s => cos.includes(s.owner) && s.task.k === 'mine').length;
  let war: any = null;
  if (layout === 'p10') {
    startConflict(sim, sim.st, 'iron', 'guild', [['crossroads', 'rampart']]);
    war = timeTicks(sim, 900);
  }
  const row = { layout, companies: n, playerShips: n * 6, miningShips: minedShips, mining, war, sync, intelBytesPerCompany: Math.round(intel.reduce((a, b) => a + b, 0) / intel.length), saveBytes: Buffer.byteLength(sim.serialize()), ships: Object.keys(sim.st.ships).length };
  results.load.push(row);
  console.log(layout, n, JSON.stringify(row));
}

// long exploration: intel growth for one company that sweeps every reachable system
{
  const sim = make('p10', 99); const p = sim.addPlayer('탐사');
  const g = sim.newGroup(p, '정찰');
  for (const s of Object.values(sim.st.systems)) { sim.spawnShip(p, 'corvette', 'gun', g.id, { x: s.origin.x + 9000, y: 0, z: s.origin.z }); }
  run(sim, 5);
  results.intelAllVisited = { systemsVisited: Object.keys(sim.st.intel![p].sys).length, fieldsKnown: Object.keys(sim.st.intel![p].fields).length, bytes: Buffer.byteLength(JSON.stringify(sim.st.intel![p])) };
  console.log('intel all', results.intelAllVisited);
  void sysAt;
}

const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
