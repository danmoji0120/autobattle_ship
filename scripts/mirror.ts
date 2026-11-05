import { World } from '../src/sim/world';
import { defaultPlayerFleet } from '../src/sim/fleet';
const dmg: Record<string, number> = {}; const shots: Record<string, number> = {};
for (let seed = 1; seed <= 12; seed++) {
  const w = new World({ seed, scenarioId: 'x', fleets: [defaultPlayerFleet(), defaultPlayerFleet()] });
  while (!w.outcome && w.time < 100) {
    w.step();
    for (const e of w.events) {
      if (e.t === 'hit') { const s = w.shipById.get(e.attacker); const k = `${e.weapon}:${s?.team}`; dmg[k] = (dmg[k] ?? 0) + e.dmg; }
      if (e.t === 'fire') { const s = w.shipById.get(e.ship); const k = `${e.weapon}:${s?.team}`; shots[k] = (shots[k] ?? 0) + 1; }
      if (e.t === 'pd') { const s = w.shipById.get(e.ship); const k = `pd${e.hit?'hit':''}:${s?.team}`; shots[k] = (shots[k] ?? 0) + 1; }
    }
  }
}
for (const k of Object.keys(dmg).sort()) console.log(k, dmg[k].toFixed(0), shots[k] ?? '');
console.log(Object.entries(shots).sort().map(([k,v])=>k+'='+v).join(' '));
