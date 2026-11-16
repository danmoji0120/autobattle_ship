// A-1: a new company founded and left alone (the player logs off), then the player comes back and orders mining.
// Does the company recover, or do the arrears stages hold the miners in dock with no way to earn?
//   npx vite-node scripts/a1/a1-comeback.ts [awayHours=10] [out.json]
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { upkeepOf, departureHeld } from '../../src/world/upkeep';

const away = Number(process.argv[2] ?? 10);
const sim = WorldSim.create(21, { ...STANDARD_WORLD });
const me = sim.addPlayer('복귀 검증');
const w = sim.st, co = w.companies[me];
const miners = Object.values(w.groups).find(g => g.owner === me && g.name === '제1 채굴반')!;
for (let i = 0; i < away * 3600; i++) sim.update(1);
const u = upkeepOf(co);
const back = { h: away, credits: Math.round(co.credits), debt: Math.round(u.debt), stage: u.stage, held: Object.values(w.ships).filter(s => s.owner === me).map(s => departureHeld(w, s)) };
const err = sim.command(me, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } } as any);
const after: any[] = [];
for (let h = 1; h <= 4; h++) {
  for (let i = 0; i < 3600; i++) sim.update(1);
  const ms = Object.values(w.ships).filter(s => s.groupId === miners.id);
  after.push({ h, credits: Math.round(co.credits), debt: Math.round(upkeepOf(co).debt), stage: upkeepOf(co).stage, mined: Math.round(co.stats.mined), minersInSpace: ms.filter(s => s.state === 'space').length, minersStatus: miners.status });
}
const out = { awayHours: away, onReturn: back, mineOrderErr: err, after };
console.log(JSON.stringify(out));
writeFileSync(process.argv[3] ?? 'a1-comeback.json', JSON.stringify(out, null, 1));
process.exit(0);
