// A-2.1: the A-1 comeback case, with the recovery tools. A new company is left alone for N hours (arrears stage 4,
// every departure held), then the player comes back, names the two miners for a recovery sortie and orders mining.
// Recorded every 10 game-minutes until the debt is paid, then 1 h more to show the normal rules are back.
//   npx vite-node scripts/a21/a21-comeback.ts [awayHours=10] [seed=21] [out.json]
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { upkeepOf, departureHeld, forecast } from '../../src/world/upkeep';

const away = Number(process.argv[2] ?? 10), seed = Number(process.argv[3] ?? 21);
const sim = WorldSim.create(seed, { ...STANDARD_WORLD });
const me = sim.addPlayer('회생 검증');
const w = sim.st, co = w.companies[me];
const mine = () => Object.values(w.ships).filter(s => s.owner === me);
const miners = Object.values(w.groups).find(g => g.owner === me && g.name === '제1 채굴반')!;
const guard = Object.values(w.groups).find(g => g.owner === me && g.name !== '제1 채굴반')!;
for (let i = 0; i < away * 3600; i++) sim.update(1);
const u = upkeepOf(co);
const snap = (t: string) => ({ t, h: +(w.time / 3600).toFixed(2), credits: Math.round(co.credits), debt: Math.round(u.debt), stage: u.stage, perHour: Math.round(forecast(w, co).perHour), earned: Math.round(co.stats.earned), mined: Math.round(co.stats.mined), paid: Math.round(u.total.paid), minersInSpace: mine().filter(s => s.groupId === miners.id && s.state === 'space').length, minersStatus: miners.status, recovery: !!u.recovery, held: mine().map(s => departureHeld(w, s)) });
const log: any[] = [snap('복귀')];
const cmds: Record<string, string | null> = {};
// before naming anything: the order alone still does not move the miners (the old softlock, unchanged rule)
cmds.mineOrder = sim.command(me, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } } as any);
for (let i = 0; i < 600; i++) sim.update(1);
log.push(snap('지정 전 10분'));
// guard ships may not be named for work; the escort order stays held
cmds.escortOrder = sim.command(me, { c: 'setOp', group: guard.id, op: { k: 'escort', group: miners.id } } as any);
const ms = mine().filter(s => s.groupId === miners.id), gs = mine().filter(s => s.groupId === guard.id);
cmds.name1 = sim.command(me, { c: 'recovery', ship: ms[0].id, on: true } as any);
cmds.name2 = sim.command(me, { c: 'recovery', ship: ms[1].id, on: true } as any);
cmds.name3 = sim.command(me, { c: 'recovery', ship: gs[0].id, on: true } as any);   // cap: 2
let doneAt: number | null = null; const t0 = w.time;
for (let m = 1; m <= 6 * 6 && doneAt === null; m++) {
  for (let i = 0; i < 600; i++) { sim.update(1); if (doneAt === null && !u.recovery && u.debt <= 1) doneAt = w.time; }
  log.push(snap(`회생 ${m * 10}분`));
}
const guardHeldAtEnd = gs.map(s => departureHeld(w, s));
for (let i = 0; i < 3600; i++) sim.update(1);
log.push(snap('정상 복귀 +1h'));
const out = { seed, awayHours: away, cmds, recoveredAfterMin: doneAt === null ? null : Math.round((doneAt - t0) / 60), recovered: u.recovered, guardHeldAtEnd, guardStatus: guard.status, guardInSpace: gs.filter(s => w.ships[s.id]?.state === 'space').length, log };
console.log(JSON.stringify({ ...out, log: undefined }));
for (const r of log) console.log(JSON.stringify({ ...r, held: undefined }));
writeFileSync(process.argv[4] ?? 'a21-comeback.json', JSON.stringify(out, null, 1));
process.exit(0);
