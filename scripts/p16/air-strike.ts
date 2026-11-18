// P16.5: who do the strike craft go for, and what do they hit? Per scenario × seed, for side A's (or both
// sides') squadrons: STRIKE time share per target class, torpedoes dropped per target class, torpedo / craft-gun
// hits and damage per target class, craft lost (to PD / to craft) and the enemy carriers' hull. Sim only.
//   npx vite-node scripts/p16/air-strike.ts [-- seconds=240] [-- json]
import '../../src/content/registry';
import { World, type BattleSetup } from '../../src/sim/world';
import type { FleetSpec, GroupSpec, ShipSpec } from '../../src/sim/fleet';
import { getScenario } from '../../src/sim/data/scenarios';

const SECS = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 240);
const CV: ShipSpec = { classId: 'carrier', loadoutId: 'air_group', cpu: { id: 'cpu_carrier', arch: 'carrier' } };
const S = (classId: string, loadoutId = 'std'): ShipSpec => ({ classId, loadoutId });
const g = (ships: ShipSpec[]): GroupSpec => ({ name: 't', commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] });
const f = (ships: ShipSpec[]): FleetSpec => ({ name: 't', root: g(ships) });
const ESC = [S('battleship'), S('battleship'), S('cruiser'), S('cruiser'), S('destroyer'), S('destroyer'), S('destroyer')];

export const AIR_SCEN: Record<string, (seed: number) => BattleSetup> = {
  skirmish: seed => ({ seed, scenarioId: 'kestrel', rules: 3, timeLimit: SECS + 60, fleets: [f([CV, ...ESC]), getScenario('kestrel').enemy] }),
  standoff: seed => ({ seed, scenarioId: 'kestrel', rules: 3, timeLimit: SECS + 60, spawnZ: 1600,
    fleets: [f([CV, S('cruiser'), S('cruiser'), S('destroyer'), S('destroyer')]), f([S('battleship'), S('cruiser'), S('cruiser'), S('destroyer'), S('destroyer')])] }),
  duel: seed => ({ seed, scenarioId: 'kestrel', rules: 3, timeLimit: SECS + 60, spawnZ: 1400,
    fleets: [f([CV, S('cruiser'), S('destroyer'), S('destroyer')]), f([CV, S('cruiser'), S('destroyer'), S('destroyer')])] }),
};

type Row = Record<string, number>;
export interface AirStrikeResult {
  scenario: string; seed: number; simTime: number; outcome: string;
  strikeShare: Row; drops: Row; torpHits: Row; torpDmg: Row; gunHits: Row; gunDmg: Row;
  craftLost: { pd: number; craft: number; byRole: Row }; torp: { dropped: number; hit: number; intercepted: number; missed: number }; launched: number; enemyCarrierHull: number[]; ownCarrierHull: number[];
}

export function airStrike(name: string, setup: BattleSetup, seed: number, secs = SECS, team = 0): AirStrikeResult {
  const w = new World(setup);
  const cls = (id: number) => w.shipById.get(id)?.cls.id ?? '?';
  const add = (r: Row, k: string, v = 1) => { r[k] = (r[k] ?? 0) + v; };
  const strikeT: Row = {}, drops: Row = {}, torpHits: Row = {}, torpDmg: Row = {}, gunHits: Row = {}, gunDmg: Row = {};
  const craftLost = { pd: 0, craft: 0, byRole: {} as Row };
  let tHit = 0, tInt = 0;
  // torpedoes dropped: the munition's target at release
  const orig = w.craftMunition.bind(w);
  w.craftMunition = (carrier, m, wd, pos, dir, targetId) => { if (carrier.team === team) add(drops, cls(targetId)); orig(carrier, m, wd, pos, dir, targetId); };
  const mine = new Set(w.ships.filter(s => s.team === team).map(s => s.id));
  while (!w.outcome && w.time < secs) {
    w.step();
    const c = w.craft;
    if (c) for (const sq of c.squads) if (sq.team === team && sq.cs.role === 'bomber' && sq.task === 1 && sq.tgtShip >= 0) add(strikeT, cls(sq.tgtShip), w.dt);
    for (const e of w.events as any[]) {
      if (e.t === 'hit' && mine.has(e.attacker)) {
        if (e.weapon === 'air_torpedo') { tHit++; add(torpHits, cls(e.target)); add(torpDmg, cls(e.target), e.dmg ?? 0); }
        else if (/wing_/.test(e.weapon)) { add(gunHits, cls(e.target)); add(gunDmg, cls(e.target), e.dmg ?? 0); }
      } else if (e.t === 'intercept' && e.kind === 'torpedo' && !mine.has(e.by)) tInt++;
    }
  }
  const c = w.craft;
  if (c) for (const q of c.squads) if (q.team === team) add(craftLost.byRole, q.cs.role, q.stats.lost);
  const lostAll = Object.values(craftLost.byRole).reduce((a, b) => a + b, 0);
  craftLost.pd = c ? c.pdKills.reduce((a, v, t) => a + (t !== team ? v ?? 0 : 0), 0) : 0; craftLost.craft = lostAll - craftLost.pd;
  const dropped = Object.values(drops).reduce((a, b) => a + b, 0);
  const alive = w.munitions.filter(m => !m.dead && m.air && m.team === team).length;
  const torp = { dropped, hit: tHit, intercepted: tInt, missed: dropped - tHit - tInt - alive };
  const tot = Object.values(strikeT).reduce((a, b) => a + b, 0) || 1;
  const strikeShare: Row = {}; for (const k in strikeT) strikeShare[k] = +(strikeT[k] / tot).toFixed(2);
  for (const r of [torpDmg, gunDmg]) for (const k in r) r[k] = Math.round(r[k]);
  const hull = (own: boolean) => w.ships.filter(s => s.cls.id === 'carrier' && (s.team === team) === own).map(s => +Math.max(0, s.hp / s.maxHp).toFixed(2));
  return { scenario: name, seed, simTime: Math.round(w.time), outcome: w.outcome ? (w.outcome.winner === team ? 'win' : w.outcome.winner === undefined || w.outcome.winner < 0 ? 'draw' : 'loss') : 'running',
    strikeShare, drops, torpHits, torpDmg, gunHits, gunDmg, craftLost, torp,
    launched: (w.craft?.squads ?? []).filter(q => q.team === team).reduce((a, q) => a + q.stats.launched, 0), enemyCarrierHull: hull(false), ownCarrierHull: hull(true) };
}

if (!process.env.AIR_STRIKE_LIB) {
  for (const [name, mk] of Object.entries(AIR_SCEN)) for (const seed of [1, 2, 3]) console.log(JSON.stringify(airStrike(name, mk(seed), seed)));
}
