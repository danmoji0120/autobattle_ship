// P13.2.1 §5 — target choice of the raiding commander, diagnosed in a real P13.2 world (the same plunder order and
// the same `search` the game uses; nothing is called directly). Each case puts haulers with real cargo around a
// lane plunder zone and records which group the commander picks first, what it demands, what it really recovers
// and what that would sell for at the nearest real market bid.
//   npx vite-node scripts/piracy/p1321-target.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import type { V, WGroup, WShip, Cargo } from '../../src/world/types';
import { qty, cargoSum } from '../../src/world/types';
import { assetReferenceValue } from '../../src/world/valuation';
import { salvageRoom } from '../../src/world/salvage';
import { observeWorld } from '../../src/world/observe';
import { priceOf } from '../../src/world/market';

function world(seed = 1321) {
  const sim = WorldSim.create(seed, { piracy: 'p132' });
  const [R, V, W] = ['약탈 상회', '광석 운송', '전자 운송'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 10;
  for (const c of [R, V, W]) { sim.st.companies[c].credits = 1e7; }
  sim.command(R, { c: 'stance', target: V, v: -1 } as any); sim.command(R, { c: 'stance', target: W, v: -1 } as any);
  const a = sim.st.stations.astra, at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, R, V, W, at };
}
type F = ReturnType<typeof world>;
function fleet(f: F, owner: string, pos: V, comp: string[], name: string): WGroup {
  const g = f.sim.newGroup(owner, name); g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => f.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
/** a hauler group flying slowly across the zone (real move order) with real cargo */
function hauler(f: F, owner: string, pos: V, cargo: Cargo, name: string, to: V) {
  const g = fleet(f, owner, pos, ['hauler'], name); const h = ships(f, g)[0]; Object.assign(h.cargo, cargo); h.logisticsExcluded = true;
  f.sim.command(owner, { c: 'setOp', group: g.id, op: { k: 'move', to } } as any);
  return g;
}
const raider = (f: F, pos: V, comp = ['corvette', 'corvette', 'corvette', 'corvette', 'destroyer', 'hauler']) => {
  const g = fleet(f, f.R, pos, comp, '약탈대'); for (const s of ships(f, g)) if (s.classId === 'hauler') s.logisticsExcluded = true; return g;
};
/** the best real bid for n units of item across market stations right now (stock-dependent price, no sale made) */
function bid(f: F, item: string) {
  let best = 0, where = '';
  for (const st of Object.values(f.sim.st.stations)) {
    const m = (st.market as any)?.[item]; if (!m) continue;
    const p = priceOf(m, 'sell', true);   // what the station pays a seller now (stock-dependent); budget not checked
    if (p > best) { best = p; where = st.id; }
  }
  return { perUnit: +best.toFixed(2), station: where, ref: assetReferenceValue(f.sim.st, item) };
}
function run(f: F, g: WGroup, seconds: number) {
  const picks: { t: number; target: string; name: string }[] = [], demands: unknown[] = [];
  let last: string | undefined;
  const recovered: Record<string, number> = {};
  // one observer per world (observeWorld replaces the previous sink)
  const stop = observeWorld(f.sim.st, (e: any) => {
    if (e.kind === 'piracy' && e.company === f.R && ['threat', 'comply', 'flee', 'resist', 'stall', 'force', 'sunk'].includes(e.reason)) demands.push({ t: Math.round(f.sim.time), kind: e.reason, victim: f.sim.st.groups[e.group]?.name ?? f.sim.st.companies[e.from]?.name, value: Math.round(e.amount) });
    if (e.kind === 'salvage' && e.reason === 'recover' && e.company === f.R) recovered[e.item] = (recovered[e.item] ?? 0) + e.amount;
  });
  const stop2 = () => {};
  for (let t = 0; t < seconds; t += .5) {
    f.sim.update(.5);
    const P = g.plx; if (P?.target && P.target !== last) { last = P.target; picks.push({ t: Math.round(f.sim.time), target: P.target, name: f.sim.st.groups[P.target]?.name ?? '?' }); }
  }
  stop(); stop2();
  return { picks, demands, recovered: Object.fromEntries(Object.entries(recovered).map(([k, n]) => [k, Math.round(n)])) };
}
const zone = (f: F) => f.at(20000, 15000);
const out: Record<string, unknown> = {};

{ // case 1: a close cheap ore hauler vs a farther electronics hauler (both unescorted, same zone)
  const f = world(); const z = zone(f);
  hauler(f, f.V, { ...z, x: z.x + 1200 }, { ore: 600 }, '광석선(근거리)', { ...z, x: z.x + 1200, z: z.z + 9000 });
  hauler(f, f.W, { ...z, x: z.x - 3800 }, { electronics: 200 }, '전자선(원거리)', { ...z, x: z.x - 3800, z: z.z + 9000 });
  const g = raider(f, z);
  f.sim.command(f.R, { c: 'setOp', group: g.id, op: { k: 'harass', at: z, radius: 6000, plunder: 'nonlethal' } } as any);
  out.case1_nearCheap_vs_farElectronics = { ...run(f, g, 1200), cargoRef: { ore600: 600 * assetReferenceValue(f.sim.st, 'ore'), electronics200: 200 * assetReferenceValue(f.sim.st, 'electronics') }, bid: { ore: bid(f, 'ore'), electronics: bid(f, 'electronics') } };
}
{ // case 2: an electronics hauler under a strong escort (separate escort group) vs a lightly loaded alloy hauler alone
  const f = world(); const z = zone(f);
  const e = hauler(f, f.W, { ...z, x: z.x + 1500 }, { electronics: 300 }, '전자선(강호위)', { ...z, x: z.x + 1500, z: z.z + 9000 });
  const esc = fleet(f, f.W, { ...z, x: z.x + 1500, z: z.z - 200 }, ['destroyer', 'destroyer', 'frigate'], '호위대');
  f.sim.command(f.W, { c: 'setOp', group: esc.id, op: { k: 'escort', group: e.id } } as any);
  hauler(f, f.V, { ...z, x: z.x - 2500 }, { alloy: 300 }, '합금선(무호위)', { ...z, x: z.x - 2500, z: z.z + 9000 });
  const g = raider(f, z);
  f.sim.command(f.R, { c: 'setOp', group: g.id, op: { k: 'harass', at: z, radius: 6000, plunder: 'nonlethal' } } as any);
  const r = run(f, g, 1500);
  out.case2_escortedElectronics_vs_aloneAlloy = { ...r, raiderShipsLeft: ships(f, g).length, escortWarshipsAlive: Object.values(f.sim.st.ships).filter(x => x.owner === f.W && x.classId !== 'hauler').length, escortGroup: { op: f.sim.st.groups[esc.id]?.op.k, ships: f.sim.st.groups[esc.id]?.shipIds.length }, escortAtStart: 'destroyer×2 + frigate, escort op on 전자선', wrecks: Object.values(f.sim.st.wrecks ?? {}).map(w => ({ sources: w.sources.map(x => x.owner === f.W ? 'W:' + x.classId : x.owner === f.R ? 'R:' + x.classId : x.owner) })), haulerAlive: ships(f, e).length, engagements: Object.keys(f.sim.st.engagements).length };
}
{ // case 3: a lane that carries only cheap ore in small lots
  const f = world(); const z = zone(f);
  for (let i = 0; i < 4; i++) hauler(f, f.V, { ...z, x: z.x - 3000 + i * 2000, z: z.z - 2000 }, { ore: 60 }, `소량 광석선${i + 1}`, { ...z, x: z.x - 3000 + i * 2000, z: z.z + 12000 });
  const g = raider(f, z);
  f.sim.command(f.R, { c: 'setOp', group: g.id, op: { k: 'harass', at: z, radius: 6000, plunder: 'nonlethal' } } as any);
  out.case3_cheapOnlyLane = { ...run(f, g, 3600), bid: bid(f, 'ore') };
}
{ // case 4: recovery capacity — the raider's own hauler is already full; does it still demand (containers left behind)?
  const f = world(); const z = zone(f);
  hauler(f, f.W, { ...z, x: z.x + 1500 }, { electronics: 200 }, '전자선', { ...z, x: z.x + 1500, z: z.z + 9000 });
  const g = raider(f, z);
  const h = ships(f, g).find(s => s.classId === 'hauler')!;
  h.cargo.ore = Math.floor(salvageRoom(f.sim, h) + cargoSum(h.cargo));   // fill the hold with its own ore
  const roomBefore = ships(f, g).reduce((a, s) => a + salvageRoom(f.sim, s), 0);
  f.sim.command(f.R, { c: 'setOp', group: g.id, op: { k: 'harass', at: z, radius: 6000, plunder: 'nonlethal' } } as any);
  const r = run(f, g, 1500);
  out.case4_fullHold = { ...r, roomBefore: Math.round(roomBefore), ownOreAboard: qty(h.cargo, 'ore'), dropsLeft: Object.values(f.sim.st.drops ?? {}).map(d => ({ id: d.id, left: Math.round(d.lots.reduce((a, l) => a + l.n, 0)) })) };
}
console.log(JSON.stringify(out, null, 1));
mkdirSync('docs/piracy-results/p1321', { recursive: true });
writeFileSync('docs/piracy-results/p1321/target-diagnosis.json', JSON.stringify(out, null, 2));
