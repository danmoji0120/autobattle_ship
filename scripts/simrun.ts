import { World } from '../src/sim/world';
import { defaultPlayerFleet } from '../src/sim/fleet';
import { getScenario } from '../src/sim/data/scenarios';
const scen = process.argv[2] ?? 'kestrel';
const seed = Number(process.argv[3] ?? 1);
const w = new World({ seed, scenarioId: scen, fleets: [defaultPlayerFleet(), getScenario(scen).enemy] });
const t0 = Date.now();
let lastT = 0;
while (!w.outcome && w.time < 560) {
  w.step();
  if (w.time - lastT >= 20) {
    lastT = w.time;
    const alive = [0, 1].map(t => w.ships.filter(s => s.team === t && s.state === 'alive').length);
    console.log(`t=${w.time.toFixed(0)} alive=${alive} val=${[0,1].map(t=>w.teamValueFrac(t as 0|1).toFixed(2))} mun=${w.munitions.length}`);
  }
}
console.log('outcome', w.outcome, 'ms', Date.now() - t0);
for (const r of w.radioLog.slice(0, 80)) console.log(`[${r.time.toFixed(1)}] ${r.team ? 'E' : 'P'} ${r.who}: ${r.text}`);
console.log('--- highlights');
for (const h of w.highlights.sort((a, b) => b.score - a.score).slice(0, 8)) console.log(h.time.toFixed(1), h.score.toFixed(1), h.title, h.text);
