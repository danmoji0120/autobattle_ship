// P13.2.2 target-AI cost. In a P10 40-system world (1 h natural warmup) a raider evaluates every cargo-carrying
// group of its system with `estimateTarget` (the per-candidate work of lane plunder `search`, which runs at most
// every 2 s per searching raid). Reports µs per estimate and per full-system search, against the strategic tick.
//   npx vite-node scripts/piracy/p1322-search-perf.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WorldSim } from '../../src/world/sim';
import { estimateTarget, stepPlunder } from '../../src/world/piracy';
import type { Station, WGroup, WShip } from '../../src/world/types';

performance.now = (() => { let t = 0; return () => t; })();   // deterministic world (wall-clock NPC battle budget)
const realNow = () => Number(process.hrtime.bigint()) / 1e6;
const sim = WorldSim.create(13220, { layout: 'p10', piracy: 'p132', factionEcon: 'v2' } as any);
const R = sim.addPlayer('R'); sim.st.companies[R].credits = 1e7;
for (let t = 0; t < 3600; t += 1) sim.update(1);
const tick0 = realNow(); for (let t = 0; t < 120; t += .5) sim.update(.5); const tickMs = (realNow() - tick0) / 240;
const rows: unknown[] = [];
for (const policy of ['nonlethal', 'force'] as const) {
  let calls = 0, us = 0, searches = 0, worst = 0, cand = 0;
  for (const sys of Object.keys(sim.st.systems)) {
    const vs = Object.values(sim.st.groups).filter(t => t.owner !== R && t.shipIds.some(id => { const s = sim.st.ships[id]; return s && sim.sysOf(s.pos)?.id === sys && s.state === 'space' && Object.values(s.cargo).some(n => n > 0); }));
    if (!vs.length) continue;
    const st0 = Object.values(sim.st.stations).find(s => sim.sysOf(s.pos)?.id === sys) as Station | undefined; if (!st0) continue;
    const g = sim.newGroup(R, 'raid'); g.commanderId = sim.newCommander(R, 2).id;
    for (const cl of ['corvette', 'corvette', 'corvette', 'destroyer', 'hauler']) { const s = sim.spawnShip(R, cl, 'std', g.id, { ...st0.pos, x: st0.pos.x + 3000 }); void s; }
    const op = { k: 'plunder', at: st0.pos, radius: 1e9, policy, neutral: true } as any;
    const pick = vs.map(t => [t, t.shipIds.map(id => sim.st.ships[id]).find(s => s && Object.values(s.cargo).some(n => n > 0))!] as const);
    const one = () => { const cache = new Map<string, { st: Station; bid: number }[]>(); for (const [t, s] of pick) estimateTarget(sim, g, t, s, op, st0.pos, cache); };
    for (let k = 0; k < 20; k++) one();   // warm (JIT)
    const REP = 200, t0 = realNow();
    for (let k = 0; k < REP; k++) one();   // each repetition = one full search with a fresh price cache
    const ms = (realNow() - t0) / REP; calls += pick.length; us += ms * 1000; searches++; worst = Math.max(worst, ms); cand += vs.length;
    for (const id of [...g.shipIds]) delete sim.st.ships[id]; delete sim.st.groups[g.id];
  }
  rows.push({ policy, systemsSearched: searches, candidates: cand, usPerEstimate: +(us / calls).toFixed(1), msPerSystemSearchAvg: +(us / 1000 / searches).toFixed(3), msPerSystemSearchWorst: +worst.toFixed(3), strategicTickMs: +tickMs.toFixed(3) });
  console.log(JSON.stringify(rows.at(-1)));
}
mkdirSync('docs/piracy-results/p1322', { recursive: true });
writeFileSync('docs/piracy-results/p1322/search-perf.json', JSON.stringify({ note: 'estimateTarget over every cargo-carrying non-raider group of each system (radius unlimited = worst case); search runs ≤ every 2 s per searching raid', rows }, null, 2));
// dense cases: 40 haulers of 40 groups around one point, the real lane-plunder search over all of them
// (stepPlunder in search phase: search() runs once per call when its 2 s timer is due)
const dense: unknown[] = [];
for (const [label, cargo] of [['valuable (alloy 50, metal 200)', { metal: 200, alloy: 50 }], ['low value (ore 40)', { ore: 40 }]] as const) {
  const st0 = Object.values(sim.st.stations)[0];
  const B = sim.addPlayer('B' + label.length); const vs: [WGroup, WShip][] = [];
  for (let i = 0; i < 40; i++) { const t = sim.newGroup(B, 'v'); const s = sim.spawnShip(B, 'hauler', 'std', t.id, { ...st0.pos, x: st0.pos.x + 4000 + i * 50 }); s.cargo = { ...cargo } as any; s.logisticsExcluded = true; vs.push([t, s]); }
  const g = sim.newGroup(R, 'raid'); g.commanderId = sim.newCommander(R, 2).id;
  for (const cl of ['corvette', 'corvette', 'corvette', 'destroyer', 'hauler']) sim.spawnShip(R, cl, 'std', g.id, { ...st0.pos, x: st0.pos.x + 3000 });
  const op = { k: 'plunder', at: st0.pos, radius: 30000, policy: 'nonlethal', neutral: true } as any;
  const ships = g.shipIds.map(id => sim.st.ships[id]);
  const one = () => { delete g.plx; stepPlunder(sim, g, ships, op, 0, sim.cmdr(g)); };
  for (let k = 0; k < 20; k++) one();
  const t0 = realNow(); for (let k = 0; k < 100; k++) one(); const ms = (realNow() - t0) / 100;
  dense.push({ case: label, candidates: 40, msPerSearch: +ms.toFixed(3), searchEverySec: 2, why: g.plx?.why ?? null, est: g.plx?.est ?? null });
  console.log(JSON.stringify(dense.at(-1)));
  for (const [t, s] of vs) { delete sim.st.ships[s.id]; delete sim.st.groups[t.id]; }
  for (const id of [...g.shipIds]) delete sim.st.ships[id]; delete sim.st.groups[g.id];
}
writeFileSync('docs/piracy-results/p1322/search-perf.json', JSON.stringify({ code: process.env.CODE ?? null, note: 'rows: estimateTarget over every cargo-carrying non-raider group of each system after 1 h natural P10 traffic (radius unlimited), warm JIT, fresh price cache per search. dense: one real lane-plunder search step (stepPlunder, search phase) over 40 victims in one place. search runs at most every 2 s per searching raid', rows, dense }, null, 2));
