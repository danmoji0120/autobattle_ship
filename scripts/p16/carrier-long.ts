// P16.4.1: sustained carrier engagements (≥ 3–5 min of sim time). Per scenario × seed: launches, recoveries,
// re-sorties (a slot launched again after landing), losses, craft that left (fuel/out of range), airborne / deck
// counts every 60 s, ordnance, CAP-held decisions and each carrier's hull fraction (0 = sunk). Sim only (deterministic), no rendering.
//   npx vite-node scripts/p16/carrier-long.ts [-- seconds=300]
import '../../src/content/registry';
import { World, type BattleSetup } from '../../src/sim/world';
import type { FleetSpec, GroupSpec, ShipSpec } from '../../src/sim/fleet';
import { getScenario } from '../../src/sim/data/scenarios';
import { CRAFT_ST } from '../../src/sim/craft';

const SECS = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 300);
const CV: ShipSpec = { classId: 'carrier', loadoutId: 'air_group', cpu: { id: 'cpu_carrier', arch: 'carrier' } };
const S = (classId: string, loadoutId = 'std'): ShipSpec => ({ classId, loadoutId });
const g = (ships: ShipSpec[]): GroupSpec => ({ name: 't', commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] });
const f = (ships: ShipSpec[]): FleetSpec => ({ name: 't', root: g(ships) });
const ESC = [S('battleship'), S('battleship'), S('cruiser'), S('cruiser'), S('destroyer'), S('destroyer'), S('destroyer')];

const SCEN: Record<string, (seed: number) => BattleSetup> = {
  // the browser skirmish fleet (carrier + 7 escorts) against the kestrel scenario enemy
  skirmish: seed => ({ seed, scenarioId: 'kestrel', rules: 3, timeLimit: SECS + 60, fleets: [f([CV, ...ESC]), getScenario('kestrel').enemy] }),
  // carrier kept back behind a gun line, long opening range
  standoff: seed => ({ seed, scenarioId: 'kestrel', rules: 3, timeLimit: SECS + 60, spawnZ: 1600,
    fleets: [f([CV, S('cruiser'), S('cruiser'), S('destroyer'), S('destroyer')]), f([S('battleship'), S('cruiser'), S('cruiser'), S('destroyer'), S('destroyer')])] }),
  // carrier against carrier, equal escorts
  duel: seed => ({ seed, scenarioId: 'kestrel', rules: 3, timeLimit: SECS + 60, spawnZ: 1400,
    fleets: [f([CV, S('cruiser'), S('destroyer'), S('destroyer')]), f([CV, S('cruiser'), S('destroyer'), S('destroyer')])] }),
};

const rows: unknown[] = [];
for (const [name, mk] of Object.entries(SCEN)) for (const seed of [1, 2, 3]) {
  const w = new World(mk(seed));
  const prev = new Uint8Array(8192), sorties = new Uint16Array(8192);
  let resort = 0, tick = 0;
  const marks: { t: number; air: number; deck: number; lost: number; rec: number }[] = [];
  const sum = (k: 'launched' | 'recovered' | 'lost' | 'left' | 'ordFired' | 'held') => (w.craft?.squads ?? []).reduce((a, q) => a + q.stats[k], 0);
  while (!w.outcome && w.time < SECS) {
    w.step(); tick++;
    const c = w.craft;
    if (c) for (let i = 0; i < c.st.length; i++) {
      if (c.st[i] === CRAFT_ST.OUT && prev[i] !== CRAFT_ST.OUT) { if (sorties[i]++ > 0) resort++; }
      prev[i] = c.st[i];
    }
    if (c && tick % (60 * 30) === 0) {
      let air = 0, deck = 0;
      for (let i = 0; i < c.st.length; i++) { if (c.st[i] === CRAFT_ST.OUT) air++; else if (c.st[i] === CRAFT_ST.HANGAR || c.st[i] === CRAFT_ST.PREP) deck++; }
      marks.push({ t: Math.round(w.time), air, deck, lost: sum('lost'), rec: sum('recovered') });
    }
  }
  const cvs = w.ships.filter(s => s.cls.id === 'carrier');
  const r = { scenario: name, seed, simTime: Math.round(w.time), outcome: w.outcome ? `${w.outcome.winner === 0 ? 'A' : w.outcome.winner === 1 ? 'B' : 'draw'}` : 'running',
    launched: sum('launched'), recovered: sum('recovered'), resorties: resort, lost: sum('lost'), left: sum('left'), ordnance: sum('ordFired'), heldDecisions: sum('held'),
    carrierHull: cvs.map(s => +Math.max(0, s.hp / s.maxHp).toFixed(2)), marks };
  rows.push(r);
  console.log(JSON.stringify(r));
}
