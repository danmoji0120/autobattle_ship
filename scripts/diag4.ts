import { World } from '../src/sim/world';
import { defaultPlayerFleet } from '../src/sim/fleet';
import { getScenario } from '../src/sim/data/scenarios';
const w = new World({ seed: Number(process.argv[2] ?? 1), scenarioId: 'kestrel', fleets: [defaultPlayerFleet(), getScenario('kestrel').enemy] });
const cnt: Record<string, number> = {};
const torps = new Map<number, any>();
while (!w.outcome && w.time < 200) {
  w.step();
  for (const e of w.events) {
    let k = e.t;
    if (e.t === 'fire') k += ':' + e.weapon + ':' + w.shipById.get(e.ship)!.team;
    if (e.t === 'intercept') k += ':' + e.kind;
    if (e.t === 'munitionExpire') k += ':' + e.kind;
    if (e.t === 'hit') k += ':' + e.weapon;
    cnt[k] = (cnt[k] ?? 0) + 1;
  }
  for (const m of w.munitions) if (m.kind === 'torpedo' && !torps.has(m.id)) { const t = w.shipById.get(m.targetId); torps.set(m.id, { t: w.time.toFixed(1), d: t ? t.pos.distTo(m.pos).toFixed(0) : '-', tgt: t?.cls.id }); }
}
console.log(cnt);
console.log([...torps.values()].slice(0, 20));
