// P11 regression baseline: runs a fixed set of ordinary 2-side battles (scenario, BB-EX trials, a world
// encounter with orders) to the end and prints a digest per battle. The N-side refactor must leave every
// line identical (stable order, same seeds).
//   npx vite-node scripts/combat/baseline.ts -- [out.json]
import fs from 'node:fs';
import { World, type BattleSetup } from '../../src/sim/world';
import { defaultPlayerFleet } from '../../src/sim/fleet';
import { SCENARIOS } from '../../src/sim/data/scenarios';
import { TRIALS, trialSetup, angelDescentSetup } from '../../src/sim/bbex/trials';

const out = process.argv.slice(2).filter(a => a !== '--')[0];
const rows: Record<string, unknown> = {};
const run = (id: string, setup: BattleSetup, orders?: (w: World) => void, maxT = 1000) => {
  const t0 = performance.now();
  const w = new World(setup);
  while (!w.outcome && w.time < maxT) { orders?.(w); w.step(); }
  const alive = w.ships.filter(s => s.state === 'alive').length;
  rows[id] = { digest: w.digest(), tick: w.tick, winner: w.outcome?.winner, reason: w.outcome?.reason, alive, radio: w.radioLog.length, hl: w.highlights.length, kills: w.ships.reduce((a, s) => a + s.stats.kills, 0) };
  console.log(id.padEnd(26), JSON.stringify(rows[id]), `${Math.round(performance.now() - t0)}ms`);
};
for (const sc of SCENARIOS) for (const seed of [1, 7, 42]) run(`${sc.id}.s${seed}`, { seed, scenarioId: sc.id, fleets: [defaultPlayerFleet(), sc.enemy] });
// orders mid-battle (retreat, attack, release) — the lockstep path
run('kestrel.orders', { seed: 9, scenarioId: 'kestrel', fleets: [defaultPlayerFleet(), SCENARIOS[0].enemy] }, w => {
  if (w.tick === 300) { const g = w.groups.find(x => x.team === 0 && x.shipIds.length)!; const t = w.groups.find(x => x.team === 1 && x.shipIds.length)!; w.issueOrder(g.id, { type: 'attack', targetGroup: t.id }); }
  if (w.tick === 900) { const g = w.groups.filter(x => x.team === 0 && x.shipIds.length)[1]; w.issueOrder(g.id, { type: 'retreat' }); }
  if (w.tick === 1500) { const g = w.groups.find(x => x.team === 0 && x.shipIds.length)!; w.issueOrder(g.id, null, { release: true }); }
});
run('spawnz720', { seed: 3, scenarioId: 'wolfpack', spawnZ: 720, fleets: [defaultPlayerFleet(), SCENARIOS[0].enemy] });
for (const id of ['bb50', 'missile', 'swarm', 'aa', 'no_bb']) run(`trial.${id}`, trialSetup(TRIALS.find(t => t.id === id)!, 5), undefined, 400);
run('angel', angelDescentSetup(3, { n: 60 }), undefined, 300);
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
