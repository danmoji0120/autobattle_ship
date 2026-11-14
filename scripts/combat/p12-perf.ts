// P12-20: strategic tick cost of 100 / 200 ships under fleet operations, against the same ships idle.
// Every 10 ships form one group; the groups take every P12 operation (return, defend, patrol, blockade,
// attack-move, harass, recon, rally, intercept, reinforce) in a mixed world with pirates to fight.
//   npx vite-node scripts/combat/p12-perf.ts -- [seconds=600]
import { WorldSim } from '../../src/world/sim';
import type { Op, V } from '../../src/world/types';

const [secs = 600] = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const P = (x: number, z: number): V => ({ x, y: 0, z });
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
function build(n: number, ops: boolean) {
  const sim = WorldSim.create(31, { ops: 'p12' });
  const cos = [sim.addPlayer('A'), sim.addPlayer('B')];
  sim.command(cos[0], { c: 'stance', target: cos[1], v: -1 } as any);
  const gate = sim.st.systems.drake.gates.find(g => g.to === 'ember')!;
  const groups: { co: string; id: string }[] = [];
  for (let i = 0; i < n / 10; i++) {
    const co = cos[i % 2];
    const g = sim.newGroup(co, `G${i}`); g.commanderId = sim.newCommander(co, 2).id;
    const at = P(-20000 + (i % 5) * 9000, -15000 + Math.floor(i / 5) * 7000);
    for (let k = 0; k < 10; k++) sim.spawnShip(co, ['destroyer', 'frigate', 'corvette', 'cruiser', 'hauler'][k % 5], 'std', g.id, P(at.x + (k % 4) * 50, at.z + Math.floor(k / 4) * 50));
    groups.push({ co, id: g.id });
  }
  for (let i = 0; i < 6; i++) { const g = sim.newGroup('pirates', `해적${i}`); for (let k = 0; k < 3; k++) sim.spawnShip('pirates', 'corvette', 'std', g.id, P(-8000 + i * 5000, 9000 + k * 40)); }
  if (ops) {
    const mk = (i: number, gid: string): Op => {
      const at = P(-15000 + (i % 7) * 5000, 2000 + (i % 3) * 4000);
      switch (i % 10) {
        case 0: return { k: 'return' };
        case 1: return { k: 'defend', at, radius: 2500 };
        case 2: return { k: 'patrol', at, radius: 2000, route: [at, P(at.x + 4000, at.z), P(at.x + 4000, at.z + 4000)] };
        case 3: return { k: 'blockade', system: 'drake', gate: gate.id };
        case 4: return { k: 'amove', to: P(at.x + 20000, at.z) };
        case 5: return { k: 'harass', at, radius: 3000 };
        case 6: return { k: 'recon', at, radius: 2500 };
        case 7: return { k: 'rally', at };
        case 8: { const t = groups.find(x => x.co !== groups[i].co); return t ? { k: 'intercept', group: t.id } : { k: 'idle' }; }
        default: { const t = groups.find(x => x.co === groups[i].co && x.id !== gid); return t ? { k: 'reinforce', group: t.id } : { k: 'idle' }; }
      }
    };
    groups.forEach((g, i) => { const err = sim.command(g.co, { c: 'setOp', group: g.id, op: mk(i, g.id) } as any); if (err) console.error('order refused', i, err); });
  }
  return sim;
}
for (const n of [100, 200]) for (const ops of [false, true]) {
  const sim = build(n, ops), dts: number[] = [];
  for (let t = 0; t < secs; t++) { const t0 = performance.now(); sim.update(1); dts.push(performance.now() - t0); }
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
  const battles = sim.st.battleLog?.length ?? 0;
  const states = Object.values(sim.st.groups).filter(g => g.opx).reduce<Record<string, number>>((a, g) => { const k = g.opx!.done ? `done:${g.opx!.done}` : `${g.op.k}:${g.opx!.phase}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  console.log(JSON.stringify({ case: `${n} ships ${ops ? 'P12 operations' : 'idle (baseline)'}`, simSeconds: secs, meanMsPerSimSecond: +mean.toFixed(2), p95Ms: +q(dts, .95).toFixed(2), maxMs: +Math.max(...dts).toFixed(1), realtimePct: +(mean / 1000 * 100).toFixed(2), battles, states }));
}
