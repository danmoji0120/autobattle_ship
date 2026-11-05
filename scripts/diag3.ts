import { World } from '../src/sim/world';
import { defaultPlayerFleet } from '../src/sim/fleet';
import { getScenario } from '../src/sim/data/scenarios';
const w = new World({ seed: 1, scenarioId: 'kestrel', fleets: [defaultPlayerFleet(), getScenario('kestrel').enemy] });
const lastHitW = new Map<number, string>();
while (!w.outcome && w.time < 90) {
  w.step();
  for (const e of w.events) {
    if (e.t === 'hit') { const a = w.shipById.get(e.attacker); lastHitW.set(e.target, `${e.weapon} from ${a?.name} d=${a ? a.pos.distTo(w.shipById.get(e.target)!.pos).toFixed(0) : '?'}`); }
    if (e.t === 'dying') { const s = w.shipById.get(e.ship)!; console.log(w.time.toFixed(1), s.name, s.cls.id, 'killed by', lastHitW.get(s.id)); }
  }
  if (w.tick % 60 === 0) {
    for (const g of w.groups) {
      if (!g.shipIds.length) continue;
      const ships = w.directShips(g); if (!ships.length) continue;
      const c = w.centroid(ships);
      console.log(`  t=${w.time.toFixed(0)} ${g.team}:${g.name} ${g.order.type}${g.order.type==='flank'?g.order.side:''} ph=${g.ai.phase} C=${c.x.toFixed(0)},${c.z.toFixed(0)} wp=${g.ai.waypoint ? g.ai.waypoint.x.toFixed(0)+','+g.ai.waypoint.z.toFixed(0) : '-'} T=${w.groupById.get(g.ai.mainTarget)?.name}`);
    }
  }
}
