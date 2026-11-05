import { World } from '../src/sim/world';
import type { FleetSpec, ShipSpec } from '../src/sim/fleet';
const F = (ships: ShipSpec[]): FleetSpec => ({ name: 'x', root: { name: 'r', commanderId: 'wolf', order: 'engage', retreatAt: 0, ships, children: [] } });
const S = (c: string, l: string, n: number) => Array.from({ length: n }, () => ({ classId: c, loadoutId: l }));
const st: Record<string, number> = {}; const add = (k: string, v = 1) => (st[k] = (st[k] ?? 0) + v);
for (let seed = 1; seed <= 6; seed++) {
  const w = new World({ seed, scenarioId: 'x', fleets: [F(S('battleship', 'std', 2)), F(S('cruiser', 'missile', 4))] });
  while (!w.outcome) {
    w.step();
    for (const e of w.events) {
      if (e.t === 'fire') add('fire_' + e.weapon);
      if (e.t === 'hit') { add('hit_' + e.weapon); add('dmg_' + e.weapon, e.dmg); }
      if (e.t === 'intercept') add('intercept');
    }
    if (w.tick % 30 === 0) { const a = w.ships.filter(s => s.team === 0 && s.state === 'alive'); const b = w.ships.filter(s => s.team === 1 && s.state === 'alive'); if (a.length && b.length) { add('dist', w.centroid(a).distTo(w.centroid(b))); add('n'); } }
  }
}
st.avgDist = st.dist / st.n;
console.log(st);
