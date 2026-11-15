// P13.2 §17 large-scale: real P11 battles of 3 × N ships (100 / 200 per side) near astra.
//  (1) combat baseline: the same battle (same seed, same orders) in a P13.1 world and in a P13.2 world —
//      P13.2 must not change a battle that involves no plunder (survivors, losses, wrecks, end time).
//  (2) load: in the P13.2 world, while the battle runs, K raider groups threaten K loaded convoys
//      (real demands → real jettison → recovery by the raiders' own haulers) and K salvage groups work the
//      wrecks; tick cost is compared with a copy of the same world without the plunder pairs.
//   npx vite-node scripts/piracy/p132-perf.ts [perSide...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { observeWorld } from '../../src/world/observe';
import { wreckUnits } from '../../src/world/wrecks';
import type { V } from '../../src/world/types';

const SIZES = process.argv.slice(2).map(Number).filter(n => n > 0);
const SIDES = 3, MIX = ['destroyer', 'frigate', 'corvette', 'corvette', 'hauler'];

function world(seed: number, piracy: boolean) {
  const sim = WorldSim.create(seed, piracy ? { piracy: 'p132' } : { salvage: 'p131' });
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  return sim;
}
function battle(perSide: number, piracy: boolean) {
  const sim = world(1310 + perSide, piracy);
  const a = sim.st.stations.astra, at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  const cos = Array.from({ length: SIDES }, (_, k) => sim.addPlayer(`측${k}`));
  for (const c of cos) for (const d of cos) if (c !== d) sim.command(c, { c: 'stance', target: d, v: -1 } as any);
  const groups: string[][] = cos.map(() => []);
  cos.forEach((c, k) => {
    const ang = k / SIDES * Math.PI * 2, cx = Math.cos(ang) * 2500 + 9000, cz = Math.sin(ang) * 2500;
    for (let g = 0; g * 10 < perSide; g++) {
      const grp = sim.newGroup(c, `${c}-${g}`); grp.commanderId = sim.newCommander(c, 2).id; groups[k].push(grp.id);
      for (let i = 0; i < 10 && g * 10 + i < perSide; i++) {
        const s = sim.spawnShip(c, MIX[i % MIX.length], 'std', grp.id, at(cx + (i % 5) * 60 + g * 30, cz + Math.floor(i / 5) * 60 + g * 40));
        if (s.classId === 'hauler') { s.cargo.metal = 200; s.cargo.electronics = 50; s.logisticsExcluded = true; }
      }
    }
  });
  cos.forEach((c, k) => groups[k].forEach((gid, i) => { const tg = groups[(k + 1) % SIDES]; sim.command(c, { c: 'setOp', group: gid, op: { k: 'attack', group: tg[i % tg.length] } } as any); }));
  return { sim, cos, at };
}
const digest = (sim: WorldSim, cos: string[]) => ({
  time: sim.time,
  alive: cos.map(c => Object.values(sim.st.ships).filter(s => s.owner === c).length),
  hp: cos.map(c => +Object.values(sim.st.ships).filter(s => s.owner === c).reduce((n, s) => n + s.hp, 0).toFixed(3)),
  wrecks: Object.keys(sim.st.wrecks ?? {}).length,
  wreckUnits: +Object.values(sim.st.wrecks ?? {}).reduce((n, w) => n + wreckUnits(w), 0).toFixed(3),
  engagements: Object.keys(sim.st.engagements).length,
});
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const p95 = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * .95)] ?? 0;

const rows: unknown[] = [];
for (const n of SIZES.length ? SIZES : [100, 200]) {
  // (1) combat baseline: P13.1 world vs P13.2 world, same battle, 600 s
  const A = battle(n, false), B = battle(n, true);
  const cmp: unknown[] = [];
  for (let t = 1; t <= 600; t++) { A.sim.update(0.5); B.sim.update(0.5); if (t % 120 === 0) cmp.push({ t: t / 2, p131: digest(A.sim, A.cos), p132: digest(B.sim, B.cos) }); }
  const identical = cmp.every((r: any) => JSON.stringify(r.p131) === JSON.stringify(r.p132));
  // (2) load: plunder pairs while the battle goes on (B world), vs a copy without them
  const sim = B.sim, at = B.at;
  const control = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
  const K = Math.max(10, Math.round(n / 10));
  const R = sim.addPlayer('약탈대'), V = sim.addPlayer('수송사');
  sim.st.companies[R].credits = 1e6; sim.st.companies[V].credits = 1e6;
  sim.command(R, { c: 'stance', target: V, v: -1 } as any);
  sim.command(V, { c: 'piracyPolicy', policy: 'survive' } as any);
  const flow: Record<string, number> = {};
  const stop = observeWorld(sim.st, e => { const k = `${e.kind}/${e.reason}`; flow[k] = (flow[k] ?? 0) + (e.item ? e.amount : 1); });
  const pairs: { r: string; v: string }[] = [];
  for (let k = 0; k < K; k++) {
    const x = -6000 - (k % 5) * 2500, z = 20000 + Math.floor(k / 5) * 2500;
    const vg = sim.newGroup(V, `호송${k}`);
    for (let i = 0; i < 2; i++) { const s = sim.spawnShip(V, 'hauler', 'std', vg.id, at(x + i * 40, z)); s.cargo.metal = 300; s.cargo.electronics = 100; s.logisticsExcluded = true; }
    const rg = sim.newGroup(R, `약탈${k}`); rg.commanderId = sim.newCommander(R, 2).id;
    for (const cl of ['destroyer', 'corvette', 'corvette', 'hauler']) { const s = sim.spawnShip(R, cl, 'std', rg.id, at(x - 1600, z + 300)); if (cl === 'hauler') s.logisticsExcluded = true; }
    pairs.push({ r: rg.id, v: vg.id });
  }
  // a second control: the same extra ships, no plunder orders (separates "more ships" from the plunder logic)
  const sameShips = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
  for (const pr of pairs) { const e = sim.command(R, { c: 'setOp', group: pr.r, op: { k: 'plunder', group: pr.v, policy: 'nonlethal' } } as any); if (e) throw Error(e); }
  const tick = (x: WorldSim) => { const s = performance.now(); x.update(1); return performance.now() - s; };
  const withP: number[] = [], without: number[] = [], same: number[] = [];
  let dropsMax = 0;
  const dropRefs = new Map<string, any>();
  for (let t = 0; t < 900; t++) { withP.push(tick(sim)); without.push(tick(control)); same.push(tick(sameShips)); for (const d of Object.values(sim.st.drops ?? {})) dropRefs.set(d.id, d); dropsMax = Math.max(dropsMax, Object.keys(sim.st.drops ?? {}).length); }
  stop();
  const all = [...dropRefs.values()];
  const initial = all.reduce((a, d) => a + d.initial, 0), taken = all.reduce((a, d) => a + Object.values(d.taken as Record<string, Record<string, number>>).reduce((x, m) => x + Object.values(m).reduce((y, z) => y + z, 0), 0), 0);
  const left = all.reduce((a, d) => a + wreckUnits(d), 0);
  const copy = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
  const row = {
    perSide: n, ships: SIDES * n, combatBaseline: { identical, samples: cmp },
    load: { plunderPairs: K, raiderShips: K * 4, convoyShips: K * 2, threats: flow['piracy/threat'] ?? 0, complies: flow['piracy/comply'] ?? 0, drops: all.length, dropsActiveMax: dropsMax, droppedUnits: flow['piracy/to_drop'] ?? 0,
      recoveredFromDrops: +taken.toFixed(3), leftInDrops: +left.toFixed(3), containerError: +(initial - taken - left).toFixed(6), wreckRecovered: +(flow['salvage/recover'] ?? 0).toFixed(3),
      tickMsWith: +mean(withP).toFixed(3), tickMsWithout: +mean(without).toFixed(3), tickMsSameShipsNoPlunder: +mean(same).toFixed(3), p95SameShips: +p95(same).toFixed(3), p95With: +p95(withP).toFixed(3), p95Without: +p95(without).toFixed(3), maxWith: +Math.max(...withP).toFixed(1),
      saveRestoreEqual: JSON.stringify(copy.st.drops) === JSON.stringify(sim.st.drops) && JSON.stringify(copy.st.piracy) === JSON.stringify(sim.st.piracy) },
  };
  rows.push(row); console.log(JSON.stringify({ ...row, combatBaseline: { identical, last: cmp.at(-1) } }));
}
mkdirSync('docs/piracy-results', { recursive: true });
writeFileSync(`docs/piracy-results/p132-perf-${(SIZES.length ? SIZES : [100, 200]).join('-')}.json`, JSON.stringify({ note: '3 mutually hostile companies × N ships, real P11 battle near astra (NPCs removed, security 100). (1) same battle in a P13.1 and a P13.2 world; (2) P13.2 world with K plunder pairs + the battle vs a copy without them (tickMsWithout) and vs a copy with the same ships but no plunder orders (tickMsSameShipsNoPlunder), 900 s, all three ticked in the same loop', rows }, null, 2));
