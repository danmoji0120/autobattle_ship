import { World } from '../src/sim/world';
import type { FleetSpec } from '../src/sim/fleet';
const S = (c: string, l: string) => ({ classId: c, loadoutId: l });
const A: FleetSpec = { name: 'A', root: { name: '현장', ref: 'root', order: 'engage', retreatAt: 0, ships: [], children: [
  { name: '경비대', order: 'auto', retreatAt: 0, ships: [S('destroyer', 'aa'), S('corvette', 'gun'), S('corvette', 'gun')], children: [] },
  { name: '채굴반 (비전투)', order: 'retreat', retreatAt: 0, ships: [S('miner', 'std'), S('miner', 'std')], children: [] }] } };
const B: FleetSpec = { name: 'B', root: { name: '해적', order: 'engage', retreatAt: 0, ships: [], children: [
  { name: '무리1', order: 'auto', retreatAt: 0, ships: [S('corvette', 'gun'), S('corvette', 'torp')], children: [] },
  { name: '무리2', order: 'auto', retreatAt: 0, ships: [S('corvette', 'gun'), S('corvette', 'torp'), S('corvette', 'torp')], children: [] }] } };
for (let seed = 1; seed <= 6; seed++) {
  const w = new World({ seed, scenarioId: 'kestrel', spawnZ: 720, fleets: [A, B] });
  w.runUntilEnd();
  const st = (t: number) => w.ships.filter(s => s.team === t).map(s => `${s.cls.id[0]}:${s.state[0]}${Math.round(s.hp / s.maxHp * 100)}`).join(' ');
  console.log(seed, w.outcome, '|', st(0), '||', st(1));
}
