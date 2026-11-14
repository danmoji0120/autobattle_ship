// P13.1 §16 large battles and many salvagers. Real P11 battles (no faked results) between three mutually
// hostile companies of N ships each near astra, in a P13.1 world: measures the wreck-creation time inside
// the battle end, wreck count and size, conservation (cargo before = destroyed + in wrecks; wreck at creation
// = taken + left + decayed), duplicates, save/restore equality, then sends many salvage groups (zone orders)
// and measures tick cost against the same world without salvagers, plus what the salvage industry earned.
//   npx vite-node scripts/salvage/p131-perf.ts [sides] [perSide...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { observeWorld } from '../../src/world/observe';
import * as wrecksMod from '../../src/world/wrecks';
import { assetReferenceValue } from '../../src/world/valuation';
import type { V } from '../../src/world/types';

const args = process.argv.slice(2).map(Number).filter(n => n > 0);
const SIDES = args[0] ?? 3, SIZES = args.length > 1 ? args.slice(1) : [100, 200];

function world(seed: number) {
  const sim = WorldSim.create(seed, { salvage: 'p131' });
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  return sim;
}
const MIX = ['destroyer', 'frigate', 'corvette', 'corvette', 'hauler'];

function run(perSide: number) {
  const sim = world(1310 + perSide);
  const a = sim.st.stations.astra, at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  const cos = Array.from({ length: SIDES }, (_, k) => sim.addPlayer(`측${k}`));
  for (const c of cos) for (const d of cos) if (c !== d) sim.command(c, { c: 'stance', target: d, v: -1 } as any);
  const cargoBefore: Record<string, number> = {};
  const groups: string[][] = cos.map(() => []);
  cos.forEach((c, k) => {
    const ang = k / SIDES * Math.PI * 2, cx = Math.cos(ang) * 2500 + 9000, cz = Math.sin(ang) * 2500;
    for (let g = 0; g * 10 < perSide; g++) {
      const grp = sim.newGroup(c, `${c}-${g}`); grp.commanderId = sim.newCommander(c, 2).id; groups[k].push(grp.id);
      for (let i = 0; i < 10 && g * 10 + i < perSide; i++) {
        const s = sim.spawnShip(c, MIX[i % MIX.length], 'std', grp.id, at(cx + (i % 5) * 60 + g * 30, cz + Math.floor(i / 5) * 60 + g * 40));
        if (s.classId === 'hauler') { s.cargo.metal = 200; s.cargo.electronics = 50; s.logisticsExcluded = true; cargoBefore.metal = (cargoBefore.metal ?? 0) + 200; cargoBefore.electronics = (cargoBefore.electronics ?? 0) + 50; }
      }
    }
  });
  // everyone attacks the next side's groups (real orders)
  cos.forEach((c, k) => groups[k].forEach((gid, i) => { const tg = groups[(k + 1) % SIDES]; sim.command(c, { c: 'setOp', group: gid, op: { k: 'attack', group: tg[i % tg.length] } } as any); }));
  const flow: Record<string, number> = {};
  // the combatants' own ships only (NPC traders that keep spawning buy and sell metal at markets)
  const orig = new Set(Object.keys(sim.st.ships)), sideFlow: Record<string, number> = {};
  const stop = observeWorld(sim.st, e => { if (!e.item) return; const k = `${e.kind}/${e.reason}/${e.item}`; flow[k] = (flow[k] ?? 0) + e.amount; if (e.ship && orig.has(e.ship)) sideFlow[k] = (sideFlow[k] ?? 0) + e.amount; });
  // time makeWrecks inside the real battle end
  // wreck creation runs inside the tick that ends a battle: measured as those ticks' cost
  let makeMs = 0, makeCalls = 0, maxMake = 0;
  const t0 = performance.now(); let simT = 0, maxTick = 0;
  for (; simT < 1800; simT += 0.5) {
    const n0 = Object.keys(sim.st.wrecks ?? {}).length, s = performance.now();
    sim.update(0.5);
    const dt = performance.now() - s; maxTick = Math.max(maxTick, dt);
    if (Object.keys(sim.st.wrecks ?? {}).length > n0) { makeCalls++; maxMake = Math.max(maxMake, dt); makeMs += dt; }
    if (simT > 120 && !Object.values(sim.st.engagements).some(e => !e.done) && simT % 30 === 0) {
      const alive = cos.filter(c => Object.values(sim.st.ships).some(x => x.owner === c)).length;
      if (alive <= 1) break;
    }
  }
  const battleWall = performance.now() - t0;
  const ws = Object.values(sim.st.wrecks ?? {});
  const dead = ws.reduce((n, w) => n + w.sources.length, 0);
  const ids = ws.flatMap(w => w.sources.map(s => s.ship));
  const dupSources = ids.length - new Set(ids).size;
  const engs = new Set(ws.map(w => w.eng));
  const perEng = [...engs].map(e => ws.filter(w => w.eng === e).length);
  // cargo conservation: original cargo + what survivors recovered from wrecks during the battle (automatic
  // on-site salvage; a salvager that is itself sunk later puts it into a new wreck again)
  //   = destroyed + moved into wrecks + still aboard + unloaded into storage
  const aboard: Record<string, number> = {};
  for (const s of Object.values(sim.st.ships)) if (orig.has(s.id)) for (const k of ['metal', 'electronics']) aboard[k] = (aboard[k] ?? 0) + (s.cargo[k] ?? 0);
  const fl = (k: string) => sideFlow[k] ?? 0;
  const cons = Object.fromEntries(['metal', 'electronics'].map(k => [k, +(cargoBefore[k] + fl(`salvage/recover/${k}`) - fl(`consume/combat_cargo_loss/${k}`) - fl(`salvage/to_wreck/${k}`) - aboard[k] - fl(`logistics/salvage_unload/${k}`)).toFixed(6)]));
  const recoveredInBattle = Object.fromEntries(['metal', 'electronics'].map(k => [k, +fl(`salvage/recover/${k}`).toFixed(3)]));
  const lotsMax = Math.max(0, ...ws.map(w => w.lots.length)), wreckJsonBytes = JSON.stringify(sim.st.wrecks ?? {}).length;
  // save / restore equality
  const copy = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
  const same = JSON.stringify(copy.st.wrecks) === JSON.stringify(sim.st.wrecks);
  // many salvagers: the salvage industry (company S) vs a control copy without them
  const control = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
  const S = sim.addPlayer('인양 산업'); sim.st.companies[S].credits = 1e6;
  // a neutral salvage company: it may take hull scrap, equipment and fragments; the combatants' cargo is
  // protected (no unauthorised orders here). Hostile to them it would mostly evade their surviving warships.
  const nSalv = Math.max(10, Math.round(perSide / 5)); const refusedOrders: Record<string, number> = {};
  for (let g = 0; g < nSalv; g++) {
    const grp = sim.newGroup(S, `인양${g}`); grp.commanderId = sim.newCommander(S, 2).id;
    for (const cl of ['hauler', 'miner', 'constructor']) sim.spawnShip(S, cl, 'std', grp.id, at(2000 + g * 50, -3000));
    const w = ws[g % Math.max(1, ws.length)];
    const e = w ? sim.command(S, { c: 'setOp', group: grp.id, op: { k: 'salvzone', at: w.pos, radius: 4000 } } as any) : 'no wreck';
    if (e) refusedOrders[e] = (refusedOrders[e] ?? 0) + 1;
  }

  const tick = (x: WorldSim) => { const s = performance.now(); x.update(1); return performance.now() - s; };
  const withS: number[] = [], without: number[] = [];
  const refs = new Map<string, wrecksMod.WreckSite>(); const track = () => { for (const w of Object.values(sim.st.wrecks ?? {})) refs.set(w.id, w); };
  track();
  const phases: Record<string, number> = {}; const why: Record<string, number> = {};
  for (let t = 0; t < 1800; t++) {
    withS.push(tick(sim)); without.push(tick(control)); track();
    if (t % 60 === 59) for (const g of Object.values(sim.st.groups)) if (g.owner === S) { const k = g.salv ? `${g.salv.mode}/${g.salv.phase}` : `op:${g.op.k}`; phases[k] = (phases[k] ?? 0) + 1; const y = ((g.salv as any)?.why ?? g.status ?? '').split(' — ')[0].slice(0, 24); if (y) why[y] = (why[y] ?? 0) + 1; }
  }
  stop();
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const p95 = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * .95)] ?? 0;
  // every wreck that existed during the salvage phase (the battle may still be producing new ones)
  const all = [...refs.values()];
  const initial = all.reduce((n, w) => n + w.initial, 0);
  const left = all.reduce((n, w) => n + (sim.st.wrecks?.[w.id] ? wrecksMod.wreckUnits(w) : 0), 0);
  const removedLeft = all.filter(w => !sim.st.wrecks?.[w.id]).reduce((n, w) => n + wrecksMod.wreckUnits(w), 0);
  const takenS = all.reduce((n, w) => n + Object.values(w.taken[S] ?? {}).reduce((a, b) => a + b, 0), 0);
  const takenAll = all.reduce((n, w) => n + Object.values(w.taken).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0), 0);
  const decayed = Object.entries(flow).filter(([k]) => k.startsWith('consume/wreck_decay/')).reduce((n, [, v]) => n + v, 0);
  const stored = Object.values(sim.st.stations).reduce((n, st) => n + Object.entries(st.storage[S] ?? {}).reduce((a, [k, v]) => a + v * assetReferenceValue(sim.st, k), 0), 0);
  const aboardS = Object.values(sim.st.ships).filter(s => s.owner === S).reduce((n, s) => n + Object.entries(s.salvaged ?? {}).reduce((a, [k, v]) => a + v * assetReferenceValue(sim.st, k), 0), 0);
  return {
    sides: SIDES, perSide, ships: SIDES * perSide, battleSimSeconds: simT, battleWallMs: Math.round(battleWall), maxTickMs: +maxTick.toFixed(1),
    wreckCreation: { ticksWithNewWrecks: makeCalls, meanTickMsThen: +(makeMs / Math.max(1, makeCalls)).toFixed(2), maxTickMsThen: +maxMake.toFixed(1) },
    wrecks: ws.length, engagements: engs.size, wrecksPerEngagementMax: Math.max(0, ...perEng), deadInWrecks: dead, duplicateSources: dupSources,
    lotsMax, wreckJsonBytes,
    cargoConservationError: cons, recoveredDuringBattle: recoveredInBattle, saveRestoreEqual: same,
    salvage: { groups: nSalv, ships: nSalv * 3, wrecksDuringSalvage: all.length, refusedOrders, phaseSamples: phases, reasons: why, initialUnits: initial, removedWithRemainder: removedLeft, takenBySalvager: takenS, takenAll, leftAfter30min: left, decayed, accountingError: +(initial - takenAll - left - removedLeft).toFixed(6), decayFlowEqualsRemovedRemainder: Math.abs(decayed - removedLeft) < 1e-6,
      salvagerValueStored: Math.round(stored), salvagerValueAboard: Math.round(aboardS),
      tickMsWith: +mean(withS).toFixed(3), tickMsWithout: +mean(without).toFixed(3), p95With: +p95(withS).toFixed(3), p95Without: +p95(without).toFixed(3) },
  };
}
const rows = [];
for (const n of SIZES) { const r = run(n); rows.push(r); console.log(JSON.stringify(r)); }
mkdirSync('docs/salvage-results', { recursive: true });
writeFileSync(`docs/salvage-results/p131-perf-${SIDES}x${SIZES.join('-')}.json`, JSON.stringify({ note: 'real P11 battles between mutually hostile companies near astra (P13.1 world, NPCs removed, security 100); then a neutral salvage company groups (hauler+miner+constructor) on zone orders for 1800 sim seconds vs a control copy without them', rows }, null, 2));
