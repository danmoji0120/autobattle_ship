import { World } from '../src/sim/world';
import { defaultPlayerFleet, walk, type FleetSpec } from '../src/sim/fleet';
const N = 20;
function strip(f: FleetSpec, id: string | null) { walk(f.root, g => { g.commanderId = id; }); return f; }
function versus(name: string, a: FleetSpec, b: FleetSpec) {
  let w0 = 0, dur = 0;
  for (let seed = 1; seed <= N; seed++) { const w = new World({ seed, scenarioId: 'x', fleets: [a, b] }); w.runUntilEnd(); if (w.outcome!.winner === 0) w0++; dur += w.outcome!.time; }
  console.log(name.padEnd(30), `team0 wins ${w0}/${N}`, `avg ${(dur / N).toFixed(0)}s`);
}
versus('named vs acting captains', defaultPlayerFleet(), strip(defaultPlayerFleet(), null));
versus('named vs all rookies(gray)', defaultPlayerFleet(), strip(defaultPlayerFleet(), 'gray'));
versus('all barros vs all gray', strip(defaultPlayerFleet(), 'barros'), strip(defaultPlayerFleet(), 'gray'));
