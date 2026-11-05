import { World } from '../src/sim/world';
import { defaultPlayerFleet } from '../src/sim/fleet';
import { getScenario } from '../src/sim/data/scenarios';
const scen = process.argv[2] ?? 'kestrel';
const seed = Number(process.argv[3] ?? 1);
const w = new World({ seed, scenarioId: scen, fleets: [defaultPlayerFleet(), getScenario(scen).enemy] });
const dmgBy: Record<string, number> = {}; const results: Record<string, number> = {};
const deaths: string[] = [];
while (!w.outcome && w.time < 560) {
  w.step();
  for (const e of w.events) {
    if (e.t === 'hit') { const a = w.shipById.get(e.attacker); const k = `${a?.team}:${e.weapon}`; dmgBy[k] = (dmgBy[k] ?? 0) + e.dmg; results[`${e.weapon}:${e.result}`] = (results[`${e.weapon}:${e.result}`] ?? 0) + 1; }
    if (e.t === 'dying') { const s = w.shipById.get(e.ship)!; const k = w.shipById.get(s.killedBy); deaths.push(`${w.time.toFixed(1)} T${s.team} ${s.cls.id}/${s.loadout.id} ${s.name} by ${k?.cls.id ?? '?'} grp=${w.groupById.get(s.groupId)!.name} pos=${s.pos.x.toFixed(0)},${s.pos.z.toFixed(0)}`); }
  }
}
console.log(w.outcome);
console.log(deaths.join('\n'));
console.log(Object.entries(dmgBy).sort().map(([k, v]) => `${k} ${v.toFixed(0)}`).join('\n'));
console.log(Object.entries(results).sort().map(([k, v]) => `${k} ${v}`).join('  '));
