// P13.3 economics: real scenarios in the same world, before (P13.2.2, no black market) and after (P13.3).
//   B  stolen goods: A plunders B's hauler (P13.2 engine) and turns the loot into credits
//        before — sells at the normal market of the station where its fleet unloaded (as P13.2.2 allowed)
//        after  — the loot is stolen goods: (b1) sold at the black market of that station if there is one it now knows
//                 (docking there found it), else (b2) a discovery trip + physical smuggling run to the lawless black market
//   A  legal trade (C): buy at the cheapest market, fly, unload, sell at the best market — same rules before and after
//   C  smuggling (C, after only): buy restricted goods at the lawless black market, fly them through the real gates into
//      a secure region, dock, sell at its black market (inspections happen on the way as events)
// Every number is a real credit or cargo delta of the world after real commands and simulation; unsold goods are listed
// as unsold, never as cash. Deterministic: no NPC battles (lairs off, no NPC ships), fixed dt, no wall clock.
//   npx tsx scripts/blackmarket/p133-econ.ts [seed] > out.json
import { WorldSim } from '../../src/world/sim';
import { qty, cargoSum, type V, type WGroup, type Cargo } from '../../src/world/types';
import { parseHot, isHot, bmAt } from '../../src/world/blackmarket';
import { sysAt } from '../../src/world/geom';
import { effSec } from '../../src/world/security';

const seed = Number(process.argv[2] ?? 133);
const DT = 0.5;

function world(bm: boolean) {
  const sim = WorldSim.create(seed, bm ? { blackMarket: 'p133' } : { piracy: 'p132' });
  const [A, B, C] = ['약탈 PMC', '피해 PMC', '무역 PMC'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e6;
  return { sim, A, B, C };
}
type Wd = ReturnType<typeof world>;
const fleet = (w: Wd, owner: string, pos: V, comp: string[]): WGroup => {
  const g = w.sim.newGroup(owner, `${owner}`); g.commanderId = w.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => { const s = w.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }); if (cl === 'hauler') s.logisticsExcluded = true; });
  return g;
};
const until = (sim: WorldSim, cond: () => boolean, limit: number) => { const t0 = sim.time; while (sim.time - t0 < limit && !cond()) sim.update(DT); return cond(); };
const ok = (r: string | null, what: string) => { if (r) throw new Error(`${what}: ${r}`); };
const near = (st: { pos: V }, d = 300): V => ({ x: st.pos.x + d, y: 0, z: st.pos.z });

/** B: plunder, then turn the loot into credits */
function routeB(bm: boolean) {
  const w = world(bm), { sim, A, B } = w;
  const a = sim.st.stations.astra.pos, at = (dx: number, dz: number): V => ({ x: a.x + dx, y: 0, z: a.z + dz });
  ok(sim.command(A, { c: 'stance', target: B, v: -1 }), 'stance');
  const vg = fleet(w, B, at(10000, -25000), ['hauler']); const vh = sim.st.ships[vg.shipIds[0]];
  Object.assign(vh.cargo, { alloy: 300, electronics: 60 });
  ok(sim.command(B, { c: 'setOp', group: vg.id, op: { k: 'move', to: at(4000, -25000) } }), 'convoy');
  const ga = fleet(w, A, at(10000, -21000), ['destroyer', 'frigate', 'hauler']);
  ok(sim.command(A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: vg.id, policy: 'nonlethal' } }), 'plunder');
  const t0 = sim.time, cr0 = sim.st.companies[A].credits;
  until(sim, () => !ga.plx && ga.op.k === 'idle', 3600);
  const tPlunder = sim.time - t0;
  const stored: Record<string, Cargo> = {};
  for (const st of Object.values(sim.st.stations)) for (const [k, n] of Object.entries(st.storage[A] ?? {})) if (n > 0) (stored[st.id] ??= {})[k] = n;
  const taken = Object.values(stored).reduce((s, c) => s + cargoSum(c), 0) + sim.shipsOf(ga).reduce((s, x) => s + cargoSum(x.cargo), 0);
  const inspections = () => (sim.st.companies[A].bm?.log ?? []).filter(e => e.k === 'pass' || e.k === 'seize').map(e => ({ k: e.k, at: e.at, why: e.why, items: e.items }));
  const res: any = { world: bm ? 'P13.3 (blackMarketV)' : 'P13.2.2 (no black market)', seed, plunderSeconds: Math.round(tPlunder), unitsTaken: taken, unloadedAt: stored };
  if (!bm) {
    let rev = 0; const unsold: Cargo = {};
    for (const [sid, c] of Object.entries(stored)) for (const [k, n] of Object.entries(c)) {
      const before = sim.st.companies[A].credits;
      const r = sim.st.stations[sid].market?.[k] ? sim.command(A, { c: 'sell', station: sid, res: k, amount: Math.floor(n) }) : '시장 없음';
      rev += sim.st.companies[A].credits - before;
      const left = qty(sim.st.stations[sid].storage[A], k); if (left >= 1) unsold[k] = (unsold[k] ?? 0) + left;
      if (r) res.note = (res.note ?? '') + `${k}@${sid}: ${r}; `;
    }
    return { ...res, mode: '정상 시장 즉시 판매', revenue: Math.round(rev), unsold, seconds: Math.round(sim.time - t0), creditsDelta: Math.round(sim.st.companies[A].credits - cr0) };
  }
  // after: the loot is stolen goods
  const hotUnits = Object.values(stored).reduce((s, c) => s + Object.entries(c).filter(([k]) => isHot(k)).reduce((x, [, n]) => x + n, 0), 0);
  res.stolenUnits = hotUnits; res.seizedOnUnload = inspections();
  const known = sim.st.companies[A].bm?.known ?? [];
  // b1: a black market where the goods already are
  let rev = 0; const steps: string[] = [];
  for (const [sid, c] of Object.entries(stored)) {
    const b = bmAt(sim.st, sid);
    if (!b || !known.includes(b.id)) continue;
    for (const [k, n] of Object.entries(c)) if (isHot(k)) { const before = sim.st.companies[A].credits; const r = sim.command(A, { c: 'bmSell', station: sid, res: k, amount: Math.floor(n) }); rev += sim.st.companies[A].credits - before; steps.push(`${sid} 암시장 ${k} ${r ?? '처분'}`); }
  }
  // b2: what is still stolen goes on a discovery trip + smuggling run to the lawless black market with A's hauler
  const lawless = sim.st.blackMarkets!.bm_lawless, dest = sim.st.stations[lawless.station];
  const leftAt = Object.entries(stored).map(([sid]) => [sid, Object.entries(sim.st.stations[sid].storage[A] ?? {}).filter(([k, n]) => isHot(k) && n >= 1)] as const).filter(([, l]) => l.length);
  let smuggle: any = null;
  if (leftAt.length) {
    const hg = sim.newGroup(A, 'A 밀수'); const hs = sim.shipsOf(ga).find(x => x.classId === 'hauler')!; sim.command(A, { c: 'moveShip', ship: hs.id, group: hg.id });
    const t1 = sim.time;
    if (!known.includes(lawless.id)) { ok(sim.command(A, { c: 'setOp', group: hg.id, op: { k: 'dock', station: dest.id } }), 'discovery trip'); until(sim, () => !!sim.st.companies[A].bm?.known.includes(lawless.id), 7200); }
    const tDisc = sim.time - t1;
    const before = sim.st.companies[A].credits;
    ok(sim.command(A, { c: 'setOp', group: hg.id, op: { k: 'smuggle', from: leftAt[0][0], to: dest.id, sell: true } }), 'smuggle');
    until(sim, () => hg.op.k === 'idle', 10800);
    rev += sim.st.companies[A].credits - before;
    smuggle = { from: leftAt[0][0], to: dest.id, discoverySeconds: Math.round(tDisc), runSeconds: Math.round(sim.time - t1 - tDisc), result: hg.smug?.why, aboardAfter: hs.cargo };
  }
  const unsold: Cargo = {};
  for (const st of Object.values(sim.st.stations)) for (const [k, n] of Object.entries(st.storage[A] ?? {})) if (n >= 1) unsold[k] = (unsold[k] ?? 0) + n;
  for (const s of Object.values(sim.st.ships)) if (s.owner === A) for (const [k, n] of Object.entries(s.cargo)) if (n >= 1) unsold[k] = (unsold[k] ?? 0) + n;
  return { ...res, mode: '암시장 처분', b1: steps, smuggle, revenue: Math.round(rev), unsold, inspections: inspections(), seconds: Math.round(sim.time - t0), creditsDelta: Math.round(sim.st.companies[A].credits - cr0),
    returnedToVictim: (sim.st.companies[B].bm?.log ?? []).filter(e => e.k === 'return').map(e => e.items) };
}

/** A: legal trade run of C with one hauler (buy cheapest → fly → unload → sell best) */
function routeA(bm: boolean) {
  const w = world(bm), { sim, C } = w, item = 'alloy';
  const pub = Object.values(sim.st.stations).filter(st => st.public && st.market?.[item]);
  const price = (st: typeof pub[number], side: 'buy' | 'sell') => sim.price(st, item, side);
  const buyAt = pub.reduce((a, b) => price(b, 'buy') < price(a, 'buy') ? b : a), sellAt = pub.filter(s => s !== buyAt).reduce((a, b) => price(b, 'sell') > price(a, 'sell') ? b : a);
  const g = fleet(w, C, near(buyAt), ['hauler']); const s = sim.st.ships[g.shipIds[0]];
  sim.dockShip(s, buyAt);
  const cr0 = sim.st.companies[C].credits, t0 = sim.time;
  const n = Math.min(200, Math.floor(buyAt.market![item].stock));
  ok(sim.command(C, { c: 'buy', station: buyAt.id, res: item, amount: n, ship: s.id }), 'buy');
  ok(sim.command(C, { c: 'setOp', group: g.id, op: { k: 'dock', station: sellAt.id } }), 'fly');
  until(sim, () => s.state === 'docked' && s.task.k === 'docked' && s.task.station === sellAt.id, 10800);
  ok(sim.command(C, { c: 'unloadCargo', ship: s.id }), 'unload');
  until(sim, () => qty(s.cargo, item) < 1, 600);
  sim.command(C, { c: 'sell', station: sellAt.id, res: item, amount: Math.floor(qty(sellAt.storage[C], item)) });
  return { world: bm ? 'P13.3' : 'P13.2.2', seed, item, units: n, from: buyAt.id, to: sellAt.id, seconds: Math.round(sim.time - t0), profit: Math.round(sim.st.companies[C].credits - cr0), unsold: qty(sellAt.storage[C], item) + qty(s.cargo, item) };
}

/** C: restricted goods from the lawless black market into the secure one (after only) */
function routeC(scale = 1) {
  const w = world(true), { sim, C } = w;
  const src = sim.st.blackMarkets!.bm_lawless, dst = sim.st.blackMarkets!.bm_secure;
  const a = sim.st.stations[src.station], b = sim.st.stations[dst.station];
  const g = fleet(w, C, near(a), ['hauler']); const s = sim.st.ships[g.shipIds[0]];
  sim.dockShip(s, a);                                                            // contact: finds the lawless market
  const t1 = sim.time; const p = sim.newGroup(C, 'C 정찰'); const scout = sim.spawnShip(C, 'hauler', 'std', p.id, near(b)); scout.logisticsExcluded = true; sim.dockShip(scout, b);   // and the secure one (a scout docked there)
  const cr0 = sim.st.companies[C].credits, t0 = sim.time;
  const item = 'mod_ecm', n = Math.floor(src.stock[item].n * scale);
  ok(sim.command(C, { c: 'bmBuy', station: a.id, res: item, amount: n, ship: s.id }), 'bmBuy');
  const cost = cr0 - sim.st.companies[C].credits;
  ok(sim.command(C, { c: 'setOp', group: g.id, op: { k: 'smuggle', to: b.id, items: [item], sell: true } }), 'smuggle');
  until(sim, () => g.op.k === 'idle', 14400);
  const sys = sysAt(sim.st.systems, b.pos)!;
  return { seed, item, units: n, from: a.id, to: b.id, destSecurity: Math.round(effSec(sys)), cost: Math.round(cost), seconds: Math.round(sim.time - t0), profit: Math.round(sim.st.companies[C].credits - cr0), result: g.smug?.why,
    aboardAfter: s.cargo, log: (sim.st.companies[C].bm?.log ?? []).map(e => ({ k: e.k, at: e.at, value: e.value && Math.round(e.value), fine: e.fine && Math.round(e.fine), why: e.why })), discoverySetup: Math.round(t0 - t1) };
}

const cOnly = process.argv[3] === 'C';
if (cOnly) { console.log(JSON.stringify([1, 1 / 3].map(k => { const r = routeC(k); return { seed, scale: k, units: r.units, cost: r.cost, profit: r.profit, seconds: r.seconds, out: r.log.filter(e => e.k === 'seize' || e.k === 'sell' || e.k === 'pass').map(e => `${e.k}@${e.at} ${e.why ?? ''} ${e.value ?? ''}`) }; }))); process.exit(0); }
const out = { seed, dt: DT, fixedClock: 'n/a (no NPC battles: lairs off, no NPC ships; fixed dt)', load: 'single process, no other runs', layout: 'p9 (server default)',
  B: { before: routeB(false), after: routeB(true) }, A: { before: routeA(false), after: routeA(true) }, C: { full: routeC(1), third: routeC(1 / 3) } };
console.log(JSON.stringify(out, (k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v, 2));
void parseHot;
