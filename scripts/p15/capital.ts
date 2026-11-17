// P15.0: capital-ship combat diagnostics. Representative small battles over several seeds, with
// damage by weapon kind, torpedo fate, point-defence tracking, big-gun usage and time to kill.
//   npx vite-node scripts/p15/capital.ts [seeds=6] [filter]
// Output is one line per matchup plus a detail block; run it before and after a change with the same
// seeds and fleets (docs/P15_0_CAPITAL_SHIPS.md).
import { World } from '../../src/sim/world';
import { WEAPONS } from '../../src/sim/data/weapons';
import { shipCost } from '../../src/sim/data/ships';
import type { FleetSpec, ShipSpec } from '../../src/sim/fleet';
import '../../src/content/registry';

const SEEDS = Number(process.argv[2] ?? 6);
const FILTER = process.argv[3] ?? '';
const RULES = Number(process.env.P15_RULES ?? 0);
const S = (c: string, l: string, n: number): ShipSpec[] => Array.from({ length: n }, () => ({ classId: c, loadoutId: l }));
const F = (ships: ShipSpec[], cmd = 'wolf'): FleetSpec => ({ name: 'x', root: { name: 'r', commanderId: cmd, order: 'engage', retreatAt: 0, ships, children: [] } });
const CAP = new Set(['battleship', 'battlecruiser', 'dreadnought', 'cruiser']);

export const MATCHUPS: [string, ShipSpec[], ShipSpec[]][] = [
  ['M1 8CVtorp vs 1BB', S('corvette', 'torp', 8), S('battleship', 'std', 1)],
  ['M2 6FFpatrol vs 2CA', S('frigate', 'patrol', 6), S('cruiser', 'multi', 2)],
  ['M3 13FFpatrol vs 9CA (issue)', S('frigate', 'patrol', 13), S('cruiser', 'multi', 9)],
  ['M4 12CVtorp vs 1DN', S('corvette', 'torp', 12), S('dreadnought', 'std', 1)],
  ['M5 6FFpatrol vs 1BC', S('frigate', 'patrol', 6), S('battlecruiser', 'heavy', 1)],
  ['M6 8CVgun vs 1BB (no torp)', S('corvette', 'gun', 8), S('battleship', 'std', 1)],
  ['M7 8CVtorp vs 1BB+2DDaa', S('corvette', 'torp', 8), [...S('battleship', 'std', 1), ...S('destroyer', 'aa', 2)]],
  ['M8 16CVtorp vs 2BB+2DDaa', S('corvette', 'torp', 16), [...S('battleship', 'std', 2), ...S('destroyer', 'aa', 2)]],
  ['M9 2BB vs 4CAgun (gunline)', S('battleship', 'std', 2), S('cruiser', 'gun', 4)],
  ['M10 2BB vs 2BB', S('battleship', 'std', 2), S('battleship', 'std', 2)],
  ['M11 1BB+3DDaa vs 4CAmissile', [...S('battleship', 'std', 1), ...S('destroyer', 'aa', 3)], S('cruiser', 'missile', 4)],
  ['M12 1DN vs 2BB', S('dreadnought', 'std', 1), S('battleship', 'std', 2)],
  ['M13 4CVtorp vs 1BB', S('corvette', 'torp', 4), S('battleship', 'std', 1)],
  ['M14 16CVtorp vs 1DN+3DDaa', S('corvette', 'torp', 16), [...S('dreadnought', 'std', 1), ...S('destroyer', 'aa', 3)]],
];

type Agg = Record<string, number>;
const add = (a: Agg, k: string, v = 1) => { a[k] = (a[k] ?? 0) + v; };

export function runMatch(a: ShipSpec[], b: ShipSpec[], seed: number) {
  const w = new World({ seed, scenarioId: 'p15', fleets: [F(a), F(b)], rules: RULES });
  const m: Agg = {};
  const lastHit = new Map<number, string>();
  const tracked = new Set<number>();
  let capFirstDeath = -1, capAllDead = -1;
  const t0 = performance.now();
  while (!w.outcome && w.time < 545) {
    w.step();
    lastHit.clear();
    for (const e of w.events) {
      if (e.t === 'fire') {
        const k = WEAPONS[e.weapon]?.kind ?? 'shell';
        add(m, `fire.${k}`);
        const s = w.shipById.get(e.ship)!;
        if (CAP.has(s.cls.id) && k === 'shell') {
          const mt = s.mounts[e.mount]; const t = w.shipById.get(mt.targetId);
          add(m, 'cap.gunShots');
          if (t && t.role === 'raider') add(m, 'cap.gunShotsAtRaider');
          if (WEAPONS[e.weapon].damage >= 250) { add(m, 'cap.heavyShots'); if (t && t.role === 'raider') add(m, 'cap.heavyAtRaider'); }
        }
      } else if (e.t === 'hit') {
        const t = w.shipById.get(e.target)!;
        const k = WEAPONS[e.weapon]?.kind ?? 'shell';
        lastHit.set(t.id, k);
        const cap = CAP.has(t.cls.id) ? 'cap' : 'small';
        add(m, `${cap}.dmg.${k}`, e.dmg);
        if (k === 'torpedo') { add(m, `${cap}.torpHits`); add(m, `${cap}.torpFacing.${e.facing}`); }
        const a = w.shipById.get(e.attacker);
        if (a && CAP.has(a.cls.id) && k === 'shell') { add(m, 'cap.gunHits'); if (t.role === 'raider') add(m, 'cap.gunHitsRaider'); }
      } else if (e.t === 'intercept') add(m, `intercept.${e.kind}`);
      else if (e.t === 'crit') { const t = w.shipById.get(e.ship)!; if (CAP.has(t.cls.id)) { add(m, 'cap.crit'); add(m, `cap.critBy.${lastHit.get(t.id) ?? '?'}`); } }
    }
    // point defence: how many PD mounts follow each tracked munition (sampled every 3rd tick)
    if (w.tick % 3 === 0) {
      const per = new Map<number, number>();
      for (const s of w.ships) if (s.state === 'alive') for (const mt of s.mounts) if (mt.weapon.kind === 'pd' && mt.targetIsMunition && mt.targetId >= 0) per.set(mt.targetId, (per.get(mt.targetId) ?? 0) + 1);
      for (const [id, n] of per) { add(m, 'pd.trackSamples'); add(m, 'pd.trackers', n); tracked.add(id); const mu = w.munitionById.get(id); if (mu && mu.kind === 'torpedo') add(m, 'pd.torpTrackSamples'); }
      // capital mount usage: share of weapon mounts (not PD) with a target
      for (const s of w.ships) if (s.state === 'alive' && CAP.has(s.cls.id)) {
        const ts = new Set<number>();
        for (const mt of s.mounts) if (mt.weapon.kind !== 'pd') { add(m, 'cap.mountSamples'); if (mt.targetId >= 0) { add(m, 'cap.mountBusy'); ts.add(mt.targetId); } }
        add(m, 'cap.shipSamples'); add(m, 'cap.distinctTargets', ts.size);
      }
    }
    // time to kill: capital ships of side B (the defending capital side in every matchup)
    const capB = w.ships.filter(s => s.team === 1 && CAP.has(s.cls.id));
    if (capFirstDeath < 0 && capB.some(s => s.state !== 'alive')) capFirstDeath = w.time;
    if (capAllDead < 0 && capB.length && capB.every(s => s.state !== 'alive')) capAllDead = w.time;
  }
  m.ms = performance.now() - t0;
  const sideHp = (k: number) => { let hp = 0, max = 0; for (const s of w.ships) if (s.team === k) { hp += Math.max(0, s.state === 'alive' ? s.hp : 0); max += s.maxHp; } return hp / max; };
  const lost = (k: number) => w.ships.filter(s => s.team === k && s.state !== 'alive').length;
  for (const s of w.ships) { if (CAP.has(s.cls.id)) add(m, 'cap.fireDmg', Math.max(0, s.stats.dmgTaken)); }
  return { winner: w.outcome?.winner ?? -1, time: w.outcome?.time ?? w.time, hp0: sideHp(0), hp1: sideHp(1), lost0: lost(0), lost1: lost(1), capFirstDeath, capAllDead, m, tracked: tracked.size };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
export function runAll(seeds = SEEDS, filter = FILTER) {
  const rows: string[] = [];
  for (const [name, a, b] of MATCHUPS) {
    if (filter && !filter.split(',').some(f => name.startsWith(f + ' '))) continue;
    const cost = (x: ShipSpec[]) => x.reduce((s, y) => s + shipCost(y.classId, y.loadoutId), 0);
    let wA = 0, wB = 0, dur = 0, hp0 = 0, hp1 = 0, l0 = 0, l1 = 0, ttk = 0, nttk = 0, ttkAll = 0, nAll = 0, ms = 0;
    const M: Agg = {};
    for (let seed = 1; seed <= seeds; seed++) {
      const r = runMatch(a, b, seed);
      if (r.winner === 0) wA++; else if (r.winner === 1) wB++;
      dur += r.time; hp0 += r.hp0; hp1 += r.hp1; l0 += r.lost0; l1 += r.lost1; ms += r.m.ms;
      if (r.capFirstDeath >= 0) { ttk += r.capFirstDeath; nttk++; }
      if (r.capAllDead >= 0) { ttkAll += r.capAllDead; nAll++; }
      for (const [k, v] of Object.entries(r.m)) add(M, k, v);
    }
    const n = seeds;
    const kinds = ['shell', 'missile', 'torpedo', 'pd'];
    const capDmg = kinds.reduce((s, k) => s + (M[`cap.dmg.${k}`] ?? 0), 0);
    const fireDmg = Math.max(0, (M['cap.fireDmg'] ?? 0) - capDmg);
    const tot = capDmg + fireDmg || 1;
    const torpF = M['fire.torpedo'] ?? 0;
    rows.push(`${name.padEnd(30)} A ${wA}/${n} B ${wB}/${n} draw ${n - wA - wB} | ${(dur / n).toFixed(0)}s | HP A ${pct(hp0 / n)} B ${pct(hp1 / n)} | lost A ${(l0 / n).toFixed(1)}/${a.length} B ${(l1 / n).toFixed(1)}/${b.length} | cost ${cost(a)}:${cost(b)}`);
    rows.push(`   capital dmg taken: shell ${pct((M['cap.dmg.shell'] ?? 0) / tot)} missile ${pct((M['cap.dmg.missile'] ?? 0) / tot)} torp ${pct((M['cap.dmg.torpedo'] ?? 0) / tot)} pd ${pct((M['cap.dmg.pd'] ?? 0) / tot)} fire ${pct(fireDmg / tot)} | crits ${((M['cap.crit'] ?? 0) / n).toFixed(1)} (torp ${((M['cap.critBy.torpedo'] ?? 0) / n).toFixed(1)}) | TTK(B capitals) first ${nttk ? (ttk / nttk).toFixed(0) : '-'}s all ${nAll ? (ttkAll / nAll).toFixed(0) : '-'}s (${nAll}/${n})`);
    rows.push(`   torps fired ${(torpF / n).toFixed(1)} [cap facing f${((M['cap.torpFacing.front'] ?? 0) / n).toFixed(1)}/s${((M['cap.torpFacing.side'] ?? 0) / n).toFixed(1)}/r${((M['cap.torpFacing.rear'] ?? 0) / n).toFixed(1)}] hit ${(((M['cap.torpHits'] ?? 0) + (M['small.torpHits'] ?? 0)) / n).toFixed(1)} intercepted ${((M['intercept.torpedo'] ?? 0) / n).toFixed(1)} | missiles fired ${((M['fire.missile'] ?? 0) / n).toFixed(1)} intercepted ${((M['intercept.missile'] ?? 0) / n).toFixed(1)} | PD trackers/munition ${((M['pd.trackers'] ?? 0) / Math.max(1, M['pd.trackSamples'] ?? 0)).toFixed(2)}`);
    rows.push(`   capital guns: busy ${pct((M['cap.mountBusy'] ?? 0) / Math.max(1, M['cap.mountSamples'] ?? 0))} distinct targets/ship ${((M['cap.distinctTargets'] ?? 0) / Math.max(1, M['cap.shipSamples'] ?? 0)).toFixed(2)} | shots ${((M['cap.gunShots'] ?? 0) / n).toFixed(0)} at raiders ${pct((M['cap.gunShotsAtRaider'] ?? 0) / Math.max(1, M['cap.gunShots'] ?? 0))} hits ${((M['cap.gunHits'] ?? 0) / n).toFixed(0)} (raider ${((M['cap.gunHitsRaider'] ?? 0) / n).toFixed(0)}) | heavy shots at raiders ${pct((M['cap.heavyAtRaider'] ?? 0) / Math.max(1, M['cap.heavyShots'] ?? 0))} | ${(ms / n).toFixed(0)} ms/battle`);
  }
  return rows;
}

if (!process.env.P15_LIB) for (const r of runAll()) console.log(r);
