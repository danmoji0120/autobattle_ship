import { World } from '../src/sim/world';
import type { FleetSpec, ShipSpec } from '../src/sim/fleet';
const N = 16;
const F = (ships: ShipSpec[]): FleetSpec => ({ name: 'x', root: { name: 'r', commanderId: 'wolf', order: 'engage', retreatAt: 0, ships, children: [] } });
const S = (c: string, l: string, n: number) => Array.from({ length: n }, () => ({ classId: c, loadoutId: l }));
function versus(name: string, a: ShipSpec[], b: ShipSpec[]) {
  let w0 = 0, dur = 0, hp0 = 0;
  for (let seed = 1; seed <= N; seed++) { const w = new World({ seed, scenarioId: 'x', fleets: [F(a), F(b)] }); w.runUntilEnd(); if (w.outcome!.winner === 0) w0++; dur += w.outcome!.time; hp0 += w.teamValueFrac(0) - w.teamValueFrac(1); }
  console.log(name.padEnd(34), `A wins ${w0}/${N}`, `avg ${(dur / N).toFixed(0)}s`, `margin ${(hp0 / N).toFixed(2)}`);
}
const which = process.argv[2];
versus('2BB vs 4CA-missile (600)', S('battleship', 'std', 2), S('cruiser', 'missile', 4));
versus('2BB vs 4CA-multi (600/560)', S('battleship', 'std', 2), S('cruiser', 'multi', 4));
versus('2BB vs 4CA-gun', S('battleship', 'std', 2), S('cruiser', 'gun', 4));
versus('2BB rail vs 2BB std', S('battleship', 'rail', 2), S('battleship', 'std', 2));
versus('2BB fort vs 2BB std', S('battleship', 'fortress', 2), S('battleship', 'std', 2));
versus('4CA-missile vs 4CA-gun', S('cruiser', 'missile', 4), S('cruiser', 'gun', 4));
versus('1BB+3DDaa vs 4CA-missile', [...S('battleship', 'std', 1), ...S('destroyer', 'aa', 3)], S('cruiser', 'missile', 4));
versus('6CVtorp vs 1BB(270/300)', S('corvette', 'torp', 6), S('battleship', 'std', 1));
versus('6CVgun vs 3DDaa', S('corvette', 'gun', 6), S('destroyer', 'aa', 3));
versus('6CVtorp vs 1BB+1DD(380)', S('corvette', 'torp', 8), [...S('battleship', 'std', 1), ...S('destroyer', 'aa', 1)]);
