// A-2.1: recovery from deep arrears for different fleets, in the integrated standard world (P10 + all systems).
// Each case: a company is left without orders until its debt is larger than the starting funds (arrears stage 4,
// all departures held), then the player uses only the recovery tools the game offers. Nobody else gives money,
// no admin step. Recorded: debt on return, what was done, hourly debt / credits / income / running cost, when the
// recovery closed, and whether every ship can depart normally afterwards.
//   npx vite-node scripts/a21/a21-matrix.ts <case> [seed=21] [out.json]
//   case: miners | haulers | combat | corvettes | veteran
// Fleet set-up for haulers / combat / corvettes: the starter ships that do not belong to the case are removed at
// t = 0 and the case's ships are created docked at Astra (harness only; everything after that is normal play).
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { upkeepOf, departureHeld, forecast } from '../../src/world/upkeep';
import { hullIdOf } from '../../src/world/hullops';
import { buybackValue } from '../../src/world/recovery';
import { qty } from '../../src/world/types';
import type { WShip } from '../../src/world/types';

const kase = process.argv[2] ?? 'miners', seed = Number(process.argv[3] ?? 21);
const sim = WorldSim.create(seed, { ...STANDARD_WORLD });
const me = sim.addPlayer(`회생 ${kase}`);
const w = sim.st, co = w.companies[me], u = upkeepOf(co);
const astra = w.stations.astra;
const own = () => Object.values(w.ships).filter(s => s.owner === me);
const run = (s: number) => { for (let i = 0; i < s; i++) sim.update(1); };
const cmd = (c: any) => { const e = sim.command(me, c); steps.push({ t: +(w.time / 3600).toFixed(2), c: c.c, ship: c.ship ? w.ships[c.ship]?.name ?? c.ship : undefined, swap: c.swap, err: e }); return e; };
const steps: any[] = [];
const drop = (s: WShip) => { const g = w.groups[s.groupId]; if (g) g.shipIds = g.shipIds.filter(x => x !== s.id); delete w.ships[s.id]; };
const add = (hull: string, name: string) => {
  const g = sim.newGroup(me, name);
  const s = sim.spawnHull(me, hull, `${hull}_std`, undefined, g.id, astra.pos); sim.dockShip(s, astra); return s;
};
const minersGroup = () => Object.values(w.groups).find(g => g.owner === me && g.name === '제1 채굴반')!;
const mineOp = { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true };

// ---- fleets
if (kase === 'haulers') { for (const s of own()) drop(s); add('hauler_mk1', '수송반 A'); add('hauler_mk1', '수송반 B'); }
if (kase === 'combat') for (const s of own()) if (hullIdOf(s) === 'miner_mk1') drop(s);
if (kase === 'corvettes') { for (const s of own()) drop(s); add('corvette_mk1', '경비 A'); add('corvette_mk1', '경비 B'); }
let away = 16;
if (kase === 'veteran') {
  // six hours of normal mining, then the company expands (a destroyer and a second mining team), stocks ore
  // in its warehouse for an hour and then the player is away with every group idle
  cmd({ c: 'setOp', group: minersGroup().id, op: mineOp });
  run(5 * 3600);
  cmd({ c: 'buyShip', station: 'astra', classId: 'destroyer', loadoutId: '', hull: 'destroyer_mk1' });
  const g2 = sim.newGroup(me, '제2 채굴반');
  for (let i = 0; i < 2; i++) cmd({ c: 'buyShip', station: 'astra', classId: 'miner', loadoutId: '', hull: 'miner_mk1', group: g2.id });
  cmd({ c: 'setOp', group: minersGroup().id, op: { ...mineOp, sell: false } });
  cmd({ c: 'setOp', group: g2.id, op: { ...mineOp, sell: false } });
  run(3600);
  for (const g of Object.values(w.groups)) if (g.owner === me) cmd({ c: 'setOp', group: g.id, op: { k: 'dock', station: 'astra' } });
  // spend what is left the way an expanding company might (a frigate), leaving little cash
  cmd({ c: 'buyShip', station: 'astra', classId: 'frigate', loadoutId: '', hull: 'frigate_mk1' });
  away = 30;
}
const fleet0 = own().map(s => hullIdOf(s));
const credits0 = co.credits;
run(away * 3600);
const snap = (t: string) => ({ t, h: +(w.time / 3600).toFixed(2), credits: Math.round(co.credits), debt: Math.round(u.debt), stage: u.stage, perHour: Math.round(forecast(w, co).perHour), earned: Math.round(co.stats.earned), paid: Math.round(u.total.paid), ships: own().length, inSpace: own().filter(s => s.state === 'space').length, recovery: !!u.recovery, stock: Math.round(qty(astra.storage[me] ?? {}, 'ore')) });
const log: any[] = [snap('복귀')];
const onReturn = { ...log[0], held: own().map(s => departureHeld(w, s)), fleet: own().map(s => hullIdOf(s)) };

// ---- what the player does, using what the running-cost panel offers
const nameAndMine = (ships: WShip[]) => {
  for (const s of ships) cmd({ c: 'recovery', ship: s.id, on: true });
  const gs = new Set(ships.map(s => s.groupId));
  for (const g of gs) cmd({ c: 'setOp', group: g, op: mineOp });
};
const minersNow = () => own().filter(s => hullIdOf(s).startsWith('miner'));
if (kase === 'miners') nameAndMine(minersNow());
if (kase === 'haulers') {
  // haulers have nothing to carry and no money to buy cargo: trade one in for the yard's miner, which is named at once
  const h = own()[0];
  cmd({ c: 'recoverySell', ship: h.id, swap: 'miner_mk1' });
  nameAndMine(minersNow());
}
if (kase === 'combat') {
  // the destroyer is worth most: sell it to the yard here; the proceeds pay the debt first
  const d = own().find(s => hullIdOf(s) === 'destroyer_mk1')!;
  steps.push({ note: `destroyer buyback value ${buybackValue(w, d)}` });
  cmd({ c: 'recoverySell', ship: d.id });
}
if (kase === 'corvettes') {
  // a corvette is worth less than a miner: trade one in (the difference goes on the debt), lay up the other
  const [a, b] = own();
  steps.push({ note: `corvette buyback value ${buybackValue(w, a)}, miner price ${(sim as any).shipPrice(astra, 'miner_mk1')}` });
  cmd({ c: 'recoverySell', ship: a.id, swap: 'miner_mk1' });
  cmd({ c: 'reserve', ship: b.id, on: true });
  nameAndMine(minersNow());
}
if (kase === 'veteran') {
  // sell the ore in the warehouse (proceeds pay the debt first), lay up the warships, name two miners and mine
  const ore = Math.floor(qty(astra.storage[me] ?? {}, 'ore'));
  if (ore > 0) cmd({ c: 'sell', station: 'astra', res: 'ore', amount: ore });
  for (const s of own()) if (/destroyer|frigate|corvette/.test(hullIdOf(s)) && !s.reserve) cmd({ c: 'reserve', ship: s.id, on: true });
  nameAndMine(minersNow().slice(0, 2));
  nameAndMine(minersNow().slice(2));   // refused: two at a time
}
log.push(snap('조치 직후'));
let doneAt: number | null = u.recovery || u.debt > 1 ? null : w.time; const t0 = w.time;
for (let m = 1; m <= 8 * 6 && doneAt === null; m++) {
  for (let i = 0; i < 600; i++) { sim.update(1); if (doneAt === null && !u.recovery && u.debt <= 1) doneAt = w.time; }
  if (m % 3 === 0 || doneAt !== null) log.push(snap(`+${m * 10}분`));
}
// normal operation afterwards: everything that is not laid up may depart again
const heldAfter = own().map(s => ({ ship: s.name, hull: hullIdOf(s), held: departureHeld(w, s) }));
const out = { case: kase, seed, awayHours: away, fleetBefore: fleet0, creditsWhenLeft: Math.round(credits0), onReturn, steps, recoveredAfterMin: doneAt === null ? null : Math.round((doneAt - t0) / 60), recovered: u.recovered ?? null, heldAfter, log };
console.log(JSON.stringify({ ...out, log: undefined }));
for (const r of log) console.log(JSON.stringify(r));
writeFileSync(process.argv[4] ?? `a21-${kase}.json`, JSON.stringify(out, null, 1));
process.exit(0);
