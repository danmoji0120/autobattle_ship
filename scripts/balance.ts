// Headless batch battles: win rates, durations, and which weapons do the work.
import { World } from '../src/sim/world';
import { defaultPlayerFleet, type FleetSpec } from '../src/sim/fleet';
import { getScenario, SCENARIOS } from '../src/sim/data/scenarios';
const N = Number(process.argv[3] ?? 12);
const which = process.argv[2] ?? 'all';
function run(name: string, a: FleetSpec, b: FleetSpec) {
  let wins = 0, losses = 0, draws = 0, dur = 0, torpH = 0, survivors = 0;
  const dmg: Record<string, number> = {};
  for (let seed = 1; seed <= N; seed++) {
    const w = new World({ seed, scenarioId: 'x', fleets: [a, b] });
    while (!w.outcome && w.time < 560) {
      w.step();
      for (const e of w.events) if (e.t === 'hit') { const s = w.shipById.get(e.attacker); if (s && s.team === 0) dmg[e.weapon] = (dmg[e.weapon] ?? 0) + e.dmg; if (e.weapon === 'torpedo' && s?.team === 0) torpH++; }
    }
    const o = w.outcome!;
    if (o.winner === 0) wins++; else if (o.winner === 1) losses++; else draws++;
    dur += o.time;
    survivors += w.ships.filter(s => s.team === 0 && (s.state === 'alive' || s.state === 'escaped')).length;
  }
  const tot = Object.values(dmg).reduce((x, y) => x + y, 0);
  console.log(`${name.padEnd(14)} W${wins} L${losses} D${draws}  avg ${(dur / N).toFixed(0)}s  surv ${(survivors / N).toFixed(1)}  torpHits/b ${(torpH / N).toFixed(1)}  dmg% ${Object.entries(dmg).sort((x, y) => y[1] - x[1]).map(([k, v]) => k + ':' + (v / tot * 100).toFixed(0)).join(' ')}`);
}
if (which === 'mirror' || which === 'all') run('mirror', defaultPlayerFleet(), defaultPlayerFleet());
for (const s of SCENARIOS) if (which === 'all' || which === s.id) run(s.id, defaultPlayerFleet(), getScenario(s.id).enemy);
