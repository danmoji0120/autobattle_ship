// P13.2.1 §9 truce cost. N real plunders (real demand → comply → jettison → party truce) live at once in a P13.2
// world with M other hostile groups in the same space; the strategic tick (P11 contact, reinforcement, gather
// with the truce checks) is timed against a copy of the same world whose truces have expired (same groups,
// same positions, same orders). A microbenchmark of `truceBlocks` itself is added for the worst case (every
// pair checked against every truce).
//   npx vite-node scripts/piracy/p1321-truce-perf.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WorldSim } from '../../src/world/sim';
import type { V, WGroup } from '../../src/world/types';
import { demand, truceBlocks } from '../../src/world/piracy';

function world(nTruce: number) {
  const sim = WorldSim.create(1321, { piracy: 'p132' });
  const [A, B, C] = ['약탈', '수송', '제3'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 10;
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e7;
  sim.command(A, { c: 'stance', target: B, v: -1 } as any);
  const a = sim.st.stations.astra.pos, at = (dx: number, dz: number): V => ({ x: a.x + dx, y: 0, z: a.z + dz });
  const fleet = (o: string, pos: V, comp: string[]) => { const g = sim.newGroup(o, 'g'); g.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return g; };
  const groups: WGroup[] = [];
  for (let i = 0; i < nTruce; i++) {   // plunder pairs on a grid, 6 km apart
    const p = at(-60000 + (i % 10) * 6000, -40000 - Math.floor(i / 10) * 6000);
    const v = fleet(B, p, ['hauler']); const h = sim.st.ships[v.shipIds[0]]; h.cargo.metal = 300; h.logisticsExcluded = true; v.piracyPolicy = 'survive';
    const r = fleet(A, { ...p, z: p.z - 800 }, ['destroyer', 'destroyer']);
    const res = demand(sim, r, h) as any; if (res.response !== 'comply') throw Error('no comply ' + i);
    groups.push(v, r);
  }
  // unrelated hostile groups of the same two companies spread over the same area (contact checks against them)
  for (let i = 0; i < 40; i++) groups.push(fleet(i % 2 ? A : B, at(-60000 + (i % 10) * 6000 + 2500, -40000 - Math.floor(i / 10) * 6000 + 2500), ['corvette']));
  return { sim, groups };
}
const time = (sim: WorldSim, sec: number) => { const t0 = performance.now(); for (let t = 0; t < sec; t += .5) sim.update(.5); return (performance.now() - t0) / (sec / .5); };
const rows: unknown[] = [];
for (const n of [0, 10, 40]) {
  const w = world(n), ctl = world(n);
  for (const t of ctl.sim.st.piracy?.truces ?? []) t.until = ctl.sim.time;   // same world, truces already over
  const truces = w.sim.st.piracy?.truces?.length ?? 0;
  // warm up, then alternate the two worlds to share any machine noise
  time(w.sim, 5); time(ctl.sim, 5);
  let a = 0, b = 0;
  for (let k = 0; k < 6; k++) { a += time(w.sim, 10); b += time(ctl.sim, 10); }
  // worst case: every pair of the world's groups checked against every truce
  const gs = Object.values(w.sim.st.groups), p = gs[0] ? w.sim.groupCenter(gs[0])! : { x: 0, y: 0, z: 0 };
  const calls = gs.length * gs.length; const t0 = performance.now();
  for (const x of gs) for (const y of gs) truceBlocks(w.sim.st, x, y, p, w.sim.time);
  const usPerCall = (performance.now() - t0) * 1000 / Math.max(1, calls);
  rows.push({ truces, activeAfter: (w.sim.st.piracy?.truces ?? []).filter(t => t.until > w.sim.time).length, groups: gs.length, tickMsWithTruces: +(a / 6).toFixed(3), tickMsTrucesExpired: +(b / 6).toFixed(3), truceBlocksUsPerCall: +usPerCall.toFixed(3), calls });
  console.log(JSON.stringify(rows.at(-1)));
}
mkdirSync('docs/piracy-results/p1321', { recursive: true });
writeFileSync('docs/piracy-results/p1321/truce-perf.json', JSON.stringify({ note: 'N real party truces + 40 unrelated hostile groups; tick of the same world with its truces expired as control; truceBlocks worst case (every group pair × every truce)', rows }, null, 2));
