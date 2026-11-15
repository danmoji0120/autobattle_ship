// P13.4 cost and side effects: the same world (seed, NPC economy and fleets as created) stepped as a P13.3 world and
// as a P13.4 world; then a loaded P13.4 variant where 12 player groups are wanted in policed space at once (real
// dispatches, stops and automatic compliance). Wall-clock per simulated hour, NPC fleet counts at start / end, Union
// ship counts (no spawning), save size. Also the P10 layout (40 systems) for a short run.
//   npx vite-node scripts/law/p134-perf.ts [seed] [hours] [p10Hours]
import { writeFileSync, mkdirSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { lawCrime, policedSystems } from '../../src/world/law';
import { sysAt } from '../../src/world/geom';
const seed = Number(process.argv[2] ?? 133), hours = Number(process.argv[3] ?? 1), p10Hours = Number(process.argv[4] ?? 0.5), dt = 0.5;
const fleets = (sim: WorldSim) => {
  const by: Record<string, number> = {};
  for (const g of Object.values(sim.st.groups)) if (g.npc && g.shipIds.length) by[g.owner === 'union' ? `union:${g.npc.role}` : g.owner === 'pirates' ? 'pirates' : 'other-npc'] = (by[g.owner === 'union' ? `union:${g.npc.role}` : g.owner === 'pirates' ? 'pirates' : 'other-npc'] ?? 0) + 1;
  return { npcGroups: Object.values(sim.st.groups).filter(g => g.npc && g.shipIds.length).length, ships: Object.keys(sim.st.ships).length, unionShips: Object.values(sim.st.ships).filter(s => s.owner === 'union').length, by };
};
function run(label: string, opts: any, load: boolean, h = hours) {
  const sim = WorldSim.create(seed, opts);
  sim.update(1);
  const start = fleets(sim);
  const unionIds = new Set(Object.values(sim.st.ships).filter(s => s.owner === 'union').map(s => s.id));
  let wantedGroups = 0;
  if (load) {
    const ps = ['P1', 'P2', 'P3'].map(x => sim.addPlayer(x));
    const pol = [...policedSystems(sim)];
    const sts = Object.values(sim.st.stations).filter(s => s.public && pol.includes(sysAt(sim.st.systems, s.pos)?.id ?? ''));
    for (let i = 0; i < 12; i++) {
      const o = ps[i % 3], g = sim.newGroup(o, `w${i}`); g.commanderId = sim.newCommander(o, 1).id;
      const at = sts[i % sts.length];
      const p = { x: at.pos.x + 3000 + i * 300, y: 0, z: at.pos.z - 2500 };
      for (const cl of ['frigate', 'hauler']) { const s = sim.spawnShip(o, cl, 'std', g.id, p); s.logisticsExcluded = true; }
      const sys = sysAt(sim.st.systems, p)!.id;
      // a real case through the same API every crime path uses; witnessed by the station next to it
      lawCrime(sim, { kind: 'extortion', by: o, group: g.id, ship: g.shipIds[0], sys, pos: p, value: 20000, key: `perf:${i}` });
      wantedGroups++;
    }
  }
  const t0 = performance.now(); let worst = 0;
  for (let t = 0; t < h * 3600; t += dt) { const a = performance.now(); sim.update(dt); worst = Math.max(worst, performance.now() - a); }
  const ms = performance.now() - t0;
  const save = sim.serialize();
  const end = fleets(sim);
  const newUnion = Object.values(sim.st.ships).filter(s => s.owner === 'union' && !unionIds.has(s.id)).length;
  const L = sim.st.law;
  return {
    label, seed, hours: h, dt, wallMsPerSimHour: Math.round(ms / h), meanTickMs: +(ms / (h * 3600 / dt)).toFixed(3), worstTickMs: +worst.toFixed(1),
    saveBytes: save.length, lawBytes: JSON.stringify(L ?? {}).length, start, end, newUnionShipsDuringRun: newUnion,
    law: L && { cases: Object.keys(L.cases).length, open: Object.values(L.cases).filter(c => c.state === 'open').length, ops: Object.keys(L.ops).length, served: Object.values(L.cases).filter(c => c.served !== undefined).length, paid: Object.values(L.cases).reduce((a, c) => a + c.paid, 0) },
    wantedGroups,
  };
}
const out = {
  base: run('P13.3 world', { blackMarket: 'p133' }, false),
  law: run('P13.4 world', { law: 'p134' }, false),
  loaded: run('P13.4 world + 12 wanted player groups', { law: 'p134' }, true),
  p10base: run('P10 layout, P13.3', { layout: 'p10', blackMarket: 'p133', factionEcon: 'v2' }, false, p10Hours),
  p10law: run('P10 layout, P13.4', { layout: 'p10', law: 'p134', factionEcon: 'v2' }, false, p10Hours),
  p10loaded: run('P10 layout, P13.4 + 12 wanted player groups', { layout: 'p10', law: 'p134', factionEcon: 'v2' }, true, p10Hours),
};
mkdirSync('docs/law-results', { recursive: true });
writeFileSync(`docs/law-results/perf-seed${seed}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
