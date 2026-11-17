// B-3 combat rating calibration from real battles. For every warship class / standard loadout X, a squadron of X
// (about the outer-system requirement, ≈ 1,200 rating) fights m standard heavy cruisers (세이버급 'multi', 140 each)
// in the battle engine; m is searched until the fight is even (mean value margin crosses 0, linear interpolation).
// X's battle-equivalent rating is then m × 140 / k. Prints the factor table used by src/world/combatRating.ts (CALIB).
//   npx tsx scripts/b3/rating-calibrate.ts [seeds]
import '../../src/world/sim';
import { World } from '../../src/sim/world';
import type { FleetSpec } from '../../src/sim/fleet';
import { SHIP_CLASSES } from '../../src/sim/data/ships';
import { rate } from '../../src/world/combatRating';
const N = +(process.argv[2] ?? 8);
const F = (c: string, l: string, n: number): FleetSpec => ({ name: 'x', root: { name: 'r', commanderId: 'wolf', order: 'engage', retreatAt: 0, ships: Array.from({ length: n }, () => ({ classId: c, loadoutId: l })), children: [] } });
function margin(c: string, l: string, k: number, m: number, oc = 'cruiser', ol = 'multi') {
  let s = 0;
  for (let seed = 1; seed <= N; seed++) { const w = new World({ seed, scenarioId: 'x', fleets: [F(c, l, k), F(oc, ol, m)] }); w.runUntilEnd(); s += w.teamValueFrac(0) - w.teamValueFrac(1); }
  return s / N;
}
/** how many opponents (oc/ol) make k ships of c/l an even fight */
function even(c: string, l: string, k: number, guess: number, oc: string, ol: string) {
  let m = Math.max(1, Math.round(guess)), y = margin(c, l, k, m, oc, ol);
  let lo2 = m, ylo = y, hi = m, yhi = y;
  if (y > 0) { while (yhi > 0 && hi < 60) { lo2 = hi; ylo = yhi; hi += Math.max(1, Math.round(hi * 0.25)); yhi = margin(c, l, k, hi, oc, ol); } }
  else { while (ylo <= 0 && lo2 > 1) { hi = lo2; yhi = ylo; lo2 = Math.max(1, lo2 - Math.max(1, Math.round(lo2 * 0.25))); ylo = margin(c, l, k, lo2, oc, ol); } }
  return ylo === yhi ? lo2 : lo2 + (hi - lo2) * ylo / (ylo - yhi);
}
// reference opponents: the standard heavy cruiser defines the scale (140); the others get their rating against it
// first, then every class is rated against all four and the geometric mean is taken (no single matchup decides)
const OPP: [string, string][] = [['cruiser', 'multi'], ['destroyer', 'aa'], ['battleship', 'std'], ['frigate', 'patrol']];
const oppR: Record<string, number> = { 'cruiser:multi': 140 };
for (const [oc, ol] of OPP.slice(1)) {
  const model = rate({ cls: SHIP_CLASSES[oc], lo: SHIP_CLASSES[oc].loadouts.find(x => x.id === ol)! }).cr;
  const k = Math.max(1, Math.round(1260 / model));
  oppR[`${oc}:${ol}`] = even(oc, ol, k, k * model / 140, 'cruiser', 'multi') * 140 / k;
  console.log('opponent', oc, ol, oppR[`${oc}:${ol}`].toFixed(0));
}
const out: Record<string, number> = {};
for (const c of ['corvette', 'frigate', 'destroyer', 'light_cruiser', 'cruiser', 'battlecruiser', 'battleship', 'dreadnought']) for (const lo of SHIP_CLASSES[c].loadouts) {
  const model = rate({ cls: SHIP_CLASSES[c], lo }).cr;
  const k = Math.max(1, Math.round(1260 / model));
  const est = OPP.map(([oc, ol]) => { const r = oppR[`${oc}:${ol}`]; return even(c, lo.id, k, k * model / r, oc, ol) * r / k; });
  const emp = Math.exp(est.reduce((a, x) => a + Math.log(Math.max(1, x)), 0) / est.length), eq = emp * k / 140;
  console.log('   vs', OPP.map(([oc, ol], i) => `${oc}/${ol} ${est[i].toFixed(0)}`).join(' · '));
  out[`${c}:${lo.id}`] = +(emp / model).toFixed(3);
  console.log(`${c}/${lo.id}`.padEnd(24), `${k} ships ≈ ${eq.toFixed(1)} cruisers → battle rating ${emp.toFixed(0)} (model ${model.toFixed(0)}, old ${SHIP_CLASSES[c].cost}) factor ${(emp / model).toFixed(2)}`);
}
console.log(JSON.stringify(out));
