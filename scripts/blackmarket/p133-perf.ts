// P13.3 cost: the same P9 world (seed, NPC economy and fleets as created) stepped with and without black markets
// (both P13.2 piracy worlds), plus a loaded variant: 3 players, every one of 40 haulers carrying stolen goods through
// gates and docks (inspections on every event). Wall-clock per simulated hour and save size.
//   npx vite-node scripts/blackmarket/p133-perf.ts [seed] [hours]
import { WorldSim } from '../../src/world/sim';
import { hotKey } from '../../src/world/blackmarket';
const seed = Number(process.argv[2] ?? 133), hours = Number(process.argv[3] ?? 1), dt = 0.5;
function run(label: string, opts: any, load: boolean) {
  const sim = WorldSim.create(seed, opts);
  let n = 0;
  if (load) {
    const ps = ['P1', 'P2', 'P3'].map(x => sim.addPlayer(x));
    const sts = Object.values(sim.st.stations).filter(s => s.public);
    for (let i = 0; i < 40; i++) {
      const o = ps[i % 3], g = sim.newGroup(o, `h${i}`); g.commanderId = sim.newCommander(o, 1).id;
      const from = sts[i % sts.length], to = sts[(i * 7 + 3) % sts.length];
      const s = sim.spawnShip(o, 'hauler', 'std', g.id, { ...from.pos, x: from.pos.x + 400 }); s.logisticsExcluded = true;
      s.cargo[hotKey('alloy', ps[(i + 1) % 3])] = 30; s.cargo.mod_ecm = 2;
      sim.command(o, { c: 'setOp', group: g.id, op: { k: 'dock', station: to.id } } as any); n++;
    }
  }
  const t0 = performance.now(); let worst = 0;
  for (let t = 0; t < hours * 3600; t += dt) { const a = performance.now(); sim.update(dt); worst = Math.max(worst, performance.now() - a); }
  const ms = performance.now() - t0;
  const save = sim.serialize();
  const insp = Object.values(sim.st.companies).reduce((a, c) => a + (c.bm?.log ?? []).filter(x => x.k === 'pass' || x.k === 'seize').length, 0);
  return { label, seed, hours, dt, wallMsPerSimHour: Math.round(ms / hours), meanTickMs: +(ms / (hours * 3600 / dt)).toFixed(3), worstTickMs: +worst.toFixed(1), saveBytes: save.length, bmBytes: JSON.stringify(sim.st.blackMarkets ?? {}).length, haulers: n, inspectionsLogged: insp };
}
const out = [
  run('P13.2 world (no black markets)', { piracy: 'p132' }, false),
  run('P13.3 world', { blackMarket: 'p133' }, false),
  run('P13.2 world + 40 haulers', { piracy: 'p132' }, true),
  run('P13.3 world + 40 smuggling haulers', { blackMarket: 'p133' }, true),
];
console.log(JSON.stringify(out, null, 1));
