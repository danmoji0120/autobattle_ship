// P16.5 equal-cost carrier balance. Fleets of (nearly) the same production cost — hull + standard equipment,
// world/valuation.ts hullCost — fight in the rules-3 battle engine over several seeds. Per matchup: win rate,
// time to the outcome, lost value per side (production cost of the ships sunk), the carriers' hull, craft
// launched / recovered / lost / hits. Each matchup is also put through the NPC light judgement (world/sim.ts
// quickResolve strength: Σ class value × airValueMul, ×U(0.82, 1.18) per side) to compare its predicted win
// chance with the tactical result.
//   npx vite-node scripts/p16/equal-cost.ts [-- seeds=6] [-- secs=300] [-- only=name,name]
import '../../src/content/registry';
import { World, type BattleSetup } from '../../src/sim/world';
import type { FleetSpec, GroupSpec, ShipSpec } from '../../src/sim/fleet';
import { CARRIER_CLASS, SHIP_CLASSES, type LoadoutDef } from '../../src/sim/data/ships';
import { hullCost } from '../../src/world/valuation';
import { shipValue } from '../../src/world/data';
import { airValueMul, strengthParts } from '../../src/world/combatRating';
import { registerP165MixedHulls, P165_CRUISER_H, P165_BATTLESHIP_H } from '../../tests/helpers/p16Craft';
registerP165MixedHulls();

const arg = (k: string, d: string) => process.argv.find(a => a.startsWith(k + '='))?.slice(k.length + 1) ?? d;
const SEEDS = Number(arg('seeds', '6')), SECS = Number(arg('secs', '300'));
const ONLY = arg('only', '').split(',').filter(Boolean);

// ── ships ───────────────────────────────────────────────────────────────────────────────────────────────
const CPU = { id: 'cpu_carrier', arch: 'carrier' as const };
/** a carrier whose four H slots carry these wings (fighter / torpedo / interceptor), the rest standard */
const wingFit = (name: string, wings: string[]): LoadoutDef => {
  const std = CARRIER_CLASS.loadouts[0];
  let k = 0;
  return { id: 'air_group', name, desc: '', mounts: std.mounts.map(m => m.weapon.startsWith('wing_') ? { ...m, weapon: wings[k++] } : m) };
};
const WINGS: Record<string, LoadoutDef> = {
  mixed: CARRIER_CLASS.loadouts[0],
  torpedo: wingFit('뇌격 중심', ['wing_fighter', 'wing_torpedo', 'wing_torpedo', 'wing_torpedo']),
  intercept: wingFit('요격 중심', ['wing_fighter', 'wing_interceptor', 'wing_interceptor', 'wing_interceptor']),
};
const CV = (wing = 'mixed'): ShipSpec => ({ classId: 'carrier', loadoutId: 'air_group', cpu: CPU, ...(wing !== 'mixed' ? { fit: { name: WINGS[wing].name, mounts: WINGS[wing].mounts } } : {}) });
const S = (classId: string, loadoutId: string, n = 1): ShipSpec[] => Array.from({ length: n }, () => ({ classId, loadoutId }));
/** production cost of a battle ship spec (hull + its standard preset; a carrier wing variant costs the same within 2 %) */
const HULL: Record<string, string> = { carrier: 'carrier_dawn', [P165_CRUISER_H]: 'cruiser_mk1', [P165_BATTLESHIP_H]: 'battleship_mk1' };
const PRESET: Record<string, string> = { 'carrier:air_group': 'dawn_air_group', [`${P165_CRUISER_H}:std`]: 'cruiser_multi', [`${P165_CRUISER_H}:air`]: 'cruiser_multi', [`${P165_BATTLESHIP_H}:std`]: 'battleship_std', [`${P165_BATTLESHIP_H}:air`]: 'battleship_std', [`${P165_BATTLESHIP_H}:air_fwd`]: 'battleship_std' };
const costOf = (s: ShipSpec) => hullCost(HULL[s.classId] ?? `${s.classId}_mk1`, undefined, PRESET[`${s.classId}:${s.loadoutId}`] ?? `${s.classId}_${s.loadoutId}`).total;

// ── fleets (≈ 610 k each) ──────────────────────────────────────────────────────────────────────────────
const FLEETS: Record<string, () => ShipSpec[]> = {
  cv_strike: () => [CV(), ...S('cruiser', 'multi'), ...S('destroyer', 'strike', 2)],              // carrier, no AA escort
  cv_aa: () => [CV(), ...S('cruiser', 'multi'), ...S('destroyer', 'aa', 2)],                       // carrier with AA escort
  cv_torpedo: () => [CV('torpedo'), ...S('cruiser', 'multi'), ...S('destroyer', 'aa', 2)],
  cv_intercept: () => [CV('intercept'), ...S('cruiser', 'multi'), ...S('destroyer', 'aa', 2)],
  no_cv: () => [...S('cruiser', 'multi', 2), ...S('destroyer', 'aa', 2)],                          // a cruiser in the carrier's place
  gun: () => [...S('cruiser', 'gun', 2), ...S('destroyer', 'strike', 2)],
  missile: () => [...S('cruiser', 'missile', 2), ...S('destroyer', 'strike', 2)],
  ca_h: () => [...S(P165_CRUISER_H, 'air', 2), ...S('destroyer', 'aa', 2)],                     // H-slot cruisers (test hulls)
  ca_std: () => [...S(P165_CRUISER_H, 'std', 2), ...S('destroyer', 'aa', 2)],
  bb_h: () => [...S(P165_BATTLESHIP_H, 'air'), ...S('destroyer', 'aa', 2)],
  bb_h_fwd: () => [...S(P165_BATTLESHIP_H, 'air_fwd'), ...S('destroyer', 'aa', 2)],
  bb_std: () => [...S(P165_BATTLESHIP_H, 'std'), ...S('destroyer', 'aa', 2)],
  aa_heavy: () => [...S('cruiser', 'gun'), ...S('destroyer', 'aa', 4), ...S('frigate', 'aa', 4)],
};
const MATCH: [string, string, string][] = [
  ['carrier vs gun', 'cv_aa', 'gun'],
  ['cruiser-in-place vs gun', 'no_cv', 'gun'],
  ['carrier vs missile', 'cv_aa', 'missile'],
  ['cruiser-in-place vs missile', 'no_cv', 'missile'],
  ['carrier vs AA-heavy', 'cv_aa', 'aa_heavy'],
  ['cruiser-in-place vs AA-heavy', 'no_cv', 'aa_heavy'],
  ['carrier (no AA escort) vs gun', 'cv_strike', 'gun'],
  ['carrier vs carrier', 'cv_aa', 'cv_aa'],
  ['carrier vs cruiser-in-place', 'cv_aa', 'no_cv'],
  ['interceptor wing vs cruiser-in-place', 'cv_intercept', 'no_cv'],
  ['carrier AA escort vs none', 'cv_aa', 'cv_strike'],
  ['torpedo wing vs mixed', 'cv_torpedo', 'cv_aa'],
  ['interceptor wing vs mixed', 'cv_intercept', 'cv_aa'],
  ['torpedo wing vs interceptor wing', 'cv_torpedo', 'cv_intercept'],
  ['torpedo wing vs gun', 'cv_torpedo', 'gun'],
  ['H-slot cruisers vs standard cruisers', 'ca_h', 'ca_std'],
  ['H-slot cruisers vs gun', 'ca_h', 'gun'],
  ['H-slot battleship vs standard battleship', 'bb_h', 'bb_std'],
  ['H-slot battleship (fwd turret) vs standard', 'bb_h_fwd', 'bb_std'],
  ['interceptor wing vs gun', 'cv_intercept', 'gun'],
];

const g = (ships: ShipSpec[]): GroupSpec => ({ name: 't', commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] });
const f = (ships: ShipSpec[]): FleetSpec => ({ name: 't', root: g(ships) });

/** light judgement: P(side A's strength × U(0.82,1.18) ≥ side B's) for full-health ships, average captains */
const loOf = (s: ShipSpec) => { const cls = SHIP_CLASSES[s.classId]; return s.fit ? { id: 'fit', name: '', desc: '', mounts: s.fit.mounts } as LoadoutDef : cls.loadouts.find(l => l.id === s.loadoutId) ?? cls.loadouts[0]; };
/** P16.5 model: class value × airValueMul */
const valOld = (s: ShipSpec) => shipValue(s.classId) * airValueMul(SHIP_CLASSES[s.classId], loOf(s));
/** P16.5.1 model: base (hull and guns) + air (fitted wings) */
const partsNew = (s: ShipSpec) => strengthParts(SHIP_CLASSES[s.classId], loOf(s), shipValue(s.classId));
export function lightPOf(A: number, B: number): number {
  let win = 0; const N = 400;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (A * (0.82 + 0.36 * (i + 0.5) / N) >= B * (0.82 + 0.36 * (j + 0.5) / N)) win++;
  return win / (N * N);
}
const sum = (l: ShipSpec[], f: (s: ShipSpec) => number) => l.reduce((x, s) => x + f(s), 0);
/** Wilson 95 % interval of a rate */
const wilson = (k: number, n: number) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [+(c - h).toFixed(2), +(c + h).toFixed(2)]; };
const sd = (l: number[]) => { const m = l.reduce((a, b) => a + b, 0) / l.length; return Math.sqrt(l.reduce((a, b) => a + (b - m) ** 2, 0) / l.length); };

interface Side { won: number; lostValue: number; lostPer: number[]; cvHull: number[]; launched: number; recovered: number; lost: number; torpHits: number; gunHits: number; dmgToShips: number }
const rows: unknown[] = [];
for (const [name, a, b] of MATCH) {
  if (ONLY.length && !ONLY.some(o => name.includes(o))) continue;
  const A = FLEETS[a](), B = FLEETS[b]();
  const cost = [A, B].map(x => x.reduce((s, sp) => s + costOf(sp), 0));
  const tot = [0, 1].map((): Side => ({ won: 0, lostValue: 0, lostPer: [], cvHull: [], launched: 0, recovered: 0, lost: 0, torpHits: 0, gunHits: 0, dmgToShips: 0 }));
  let draws = 0, ttk = 0, decided = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    // alternate the sides so neither fleet always spawns on the same side
    const flip = seed % 2 === 0;
    const setup: BattleSetup = { seed, scenarioId: 'kestrel', rules: 3, timeLimit: SECS, spawnZ: 1300, fleets: flip ? [f(B), f(A)] : [f(A), f(B)] };
    const w = new World(setup);
    const specOf = new Map<number, ShipSpec>();
    w.ships.forEach(s => { const list = s.team === (flip ? 1 : 0) ? A : B; const idx = w.ships.filter(x => x.team === s.team).indexOf(s); specOf.set(s.id, list[idx]); });
    const sideOf = (team: number) => (team === 0) !== flip ? 0 : 1;   // team → matchup side (0 = A)
    while (!w.outcome && w.time < SECS) {
      w.step();
      for (const e of w.events as any[]) if (e.t === 'hit' && e.dmg > 0) {
        const at = w.shipById.get(e.attacker); if (!at) continue;
        if (e.weapon === 'air_torpedo') tot[sideOf(at.team)].torpHits++;
        else if (/^wing_/.test(e.weapon)) tot[sideOf(at.team)].gunHits++;
      }
    }
    const win = w.outcome?.winner;
    if (win === undefined || win < 0) draws++; else { tot[sideOf(win)].won++; ttk += w.time; decided++; }
    const before = tot.map(t => t.lostValue);
    for (const s of w.ships) {
      const k = sideOf(s.team);
      if (s.state === 'dead' || s.state === 'dying') tot[k].lostValue += costOf(specOf.get(s.id)!);
      if (s.cls.id === 'carrier') tot[k].cvHull.push(+Math.max(0, s.hp / s.maxHp).toFixed(2));
    }
    tot.forEach((t, k) => t.lostPer.push(t.lostValue - before[k]));
    for (const q of w.craft?.squads ?? []) { const k = sideOf(q.team); tot[k].launched += q.stats.launched; tot[k].recovered += q.stats.recovered; tot[k].lost += q.stats.lost; }
  }
  const per = (x: number) => Math.round(x / SEEDS);
  const r = {
    match: name, A: a, B: b, costA: cost[0], costB: cost[1], seeds: SEEDS,
    winA: +(tot[0].won / SEEDS).toFixed(2), winB: +(tot[1].won / SEEDS).toFixed(2), draws, ttk: decided ? Math.round(ttk / decided) : null,
    // actual score (win 1, draw ½) against the light judgement before (P16.5) and after (P16.5.1)
    scoreA: +((tot[0].won + draws / 2) / SEEDS).toFixed(2), winCI: wilson(tot[0].won, SEEDS),
    lightOld: +lightPOf(sum(A, valOld), sum(B, valOld)).toFixed(2),
    lightA: +lightPOf(sum(A, s => partsNew(s).total), sum(B, s => partsNew(s).total)).toFixed(2),
    strength: [A, B].map(l => ({ old: Math.round(sum(l, valOld)), base: Math.round(sum(l, s => partsNew(s).base)), air: Math.round(sum(l, s => partsNew(s).air)) })),
    lostValueSD: [Math.round(sd(tot[0].lostPer)), Math.round(sd(tot[1].lostPer))],
    lostValueA: per(tot[0].lostValue), lostValueB: per(tot[1].lostValue),
    cvHullA: tot[0].cvHull.length ? +(tot[0].cvHull.reduce((x, y) => x + y, 0) / tot[0].cvHull.length).toFixed(2) : null,
    cvHullB: tot[1].cvHull.length ? +(tot[1].cvHull.reduce((x, y) => x + y, 0) / tot[1].cvHull.length).toFixed(2) : null,
    craftA: { launched: per(tot[0].launched), recovered: per(tot[0].recovered), lost: per(tot[0].lost), torpHits: per(tot[0].torpHits), gunHits: per(tot[0].gunHits) },
    craftB: { launched: per(tot[1].launched), recovered: per(tot[1].recovered), lost: per(tot[1].lost), torpHits: per(tot[1].torpHits), gunHits: per(tot[1].gunHits) },
  };
  rows.push(r);
  console.log(JSON.stringify(r));
}
