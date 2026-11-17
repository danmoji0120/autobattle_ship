// B-3: does the combat rating agree with real battles? Fleets of equal total rating (≈ 1,200, the outer-system
// requirement) fight in the battle engine (src/sim/world.ts, the same engine as world engagements); equal ratings
// should give near-even results, and the side the rating favours should win.
//   npx tsx scripts/b3/rating-duels.ts [seeds]
import '../../src/world/sim';
import { World } from '../../src/sim/world';
import type { FleetSpec, ShipSpec } from '../../src/sim/fleet';
import { rateClass } from '../../src/world/combatRating';
import { SHIP_CLASSES } from '../../src/sim/data/ships';
const N = +(process.argv[2] ?? 8);
const F = (ships: ShipSpec[]): FleetSpec => ({ name: 'x', root: { name: 'r', commanderId: 'wolf', order: 'engage', retreatAt: 0, ships, children: [] } });
type Mix = [string, string, number][];
const ships = (m: Mix) => m.flatMap(([c, l, n]) => Array.from({ length: n }, () => ({ classId: c, loadoutId: l })));
const rOf = (m: Mix) => m.reduce((a, [c, l, n]) => a + rateClass(c, l) * n, 0);
const vOf = (m: Mix) => m.reduce((a, [c, , n]) => a + SHIP_CLASSES[c].cost * n, 0);
const name = (m: Mix) => m.map(([c, l, n]) => `${n}×${c}/${l}`).join('+');
function versus(a: Mix, b: Mix) {
  let w0 = 0, w1 = 0, margin = 0; const t0 = Date.now();
  for (let seed = 1; seed <= N; seed++) {
    const w = new World({ seed, scenarioId: 'x', fleets: [F(ships(a)), F(ships(b))] }); w.runUntilEnd();
    if (w.outcome!.winner === 0) w0++; else if (w.outcome!.winner === 1) w1++;
    margin += w.teamValueFrac(0) - w.teamValueFrac(1);
  }
  const ra = rOf(a), rb = rOf(b);
  console.log(`${name(a)} [r ${ra.toFixed(0)} / old ${vOf(a)}]  vs  ${name(b)} [r ${rb.toFixed(0)} / old ${vOf(b)}]  →  A ${w0} : B ${w1} / ${N}, margin ${(margin / N).toFixed(2)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
/** scale a mix to a target total rating (whole ships) */
const to = (m: Mix, target: number): Mix => { const k = target / rOf(m); return m.map(([c, l, n]) => [c, l, Math.max(1, Math.round(n * k))]); };
const CA: Mix = [['cruiser', 'multi', 9]], R = rOf(CA);
const pairs: [Mix, Mix][] = [
  // equal rating, single classes
  [CA, to([['frigate', 'patrol', 1]], R)],
  [CA, to([['frigate', 'missile', 1]], R)],
  [CA, to([['corvette', 'torp', 1]], R)],
  [CA, to([['destroyer', 'aa', 1]], R)],
  [CA, to([['destroyer', 'strike', 1]], R)],
  [CA, to([['light_cruiser', 'missile', 1]], R)],
  [CA, to([['battlecruiser', 'heavy', 1]], R)],
  [CA, to([['battleship', 'std', 1]], R)],
  // equal rating, mixed fleets (not in the calibration)
  [CA, to([['frigate', 'patrol', 6], ['frigate', 'aa', 2], ['destroyer', 'aa', 2]], R)],
  [CA, to([['battleship', 'std', 1], ['cruiser', 'missile', 2], ['frigate', 'patrol', 4]], R)],
  [to([['destroyer', 'strike', 6], ['light_cruiser', 'gun', 4]], R), to([['battlecruiser', 'rail', 2], ['frigate', 'missile', 6]], R)],
  [to([['frigate', 'patrol', 1]], R), to([['battleship', 'std', 2], ['destroyer', 'aa', 2]], R)],
  // unequal: the side rated 1.5× should win clearly
  [CA, to([['frigate', 'patrol', 1]], R / 1.5)],
  [CA, to([['frigate', 'patrol', 1]], R * 1.5)],
  [to([['battleship', 'std', 1], ['destroyer', 'aa', 2]], R * 1.5), CA],
  // the old scale's equality: 20 frigates = 9 cruisers (1,200)
  [CA, [['frigate', 'patrol', 20]]],
];
for (const [a, b] of pairs) versus(a, b);
