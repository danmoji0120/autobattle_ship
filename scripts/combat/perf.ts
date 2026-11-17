// P11 combat performance: step time of 100- and 200-ship battles. The legacy 2-side cases run on any commit
// (compare the base branch with HEAD); the P11 cases (three sides, a mid-battle reinforcement) need P11.
//   [RULES=n] [CPU=1] npx vite-node scripts/combat/perf.ts -- [ticks=1800] [repeats=3]   (RULES: BattleSetup.rules, default the setup's;
//   CPU=1: every ship carries a P15.1 combat computer — cruisers line/artillery, destroyers picket, corvettes siege/swarm)
import { World, type BattleSetup } from '../../src/sim/world';
import { lineFleet } from '../../src/sim/bbex/trials';

const [ticks = 1800, repeats = 3] = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const CPU_BY: Record<string, string[]> = { cruiser: ['line', 'artillery'], destroyer: ['picket'], corvette: ['siege', 'swarm'] };
function withCpu(f: import('../../src/sim/fleet').FleetSpec) {
  if (!process.env.CPU) return f;
  let i = 0;
  const walk = (g: import('../../src/sim/fleet').GroupSpec) => {
    for (const s of g.ships) { const a = CPU_BY[s.classId]; if (a) { const arch = a[i++ % a.length] as import('../../src/sim/ai/computer').CpuArch; s.cpu = { id: `cpu_${arch}`, arch }; } }
    g.children.forEach(walk);
  };
  walk(f.root); return f;
}
const fleet = (name: string, n: number, team: 0 | 1 = 1) => withCpu(lineFleet(name, [['cruiser', 'multi', Math.round(n * .2)], ['destroyer', 'aa', Math.round(n * .4)], ['corvette', 'torp', n - Math.round(n * .2) - Math.round(n * .4)]], 6, team));
const p11 = typeof (World.prototype as any).scheduleEvent === 'function';
type Case = { id: string; setup: () => BattleSetup; each?: (w: World) => void };
const cases: Case[] = [
  { id: 'legacy 2-side 100 (50v50)', setup: () => ({ seed: 11, scenarioId: 'kestrel', fleets: [fleet('A', 50, 0), fleet('B', 50)] }) },
  { id: 'legacy 2-side 200 (100v100)', setup: () => ({ seed: 12, scenarioId: 'kestrel', fleets: [fleet('A', 100, 0), fleet('B', 100)] }) },
];
if (p11) cases.push(
  { id: 'P11 3-side 100 (34/33/33)', setup: () => ({ seed: 13, scenarioId: 'kestrel', fleets: [fleet('A', 34, 0), fleet('B', 33), fleet('C', 33)], sides: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] } as BattleSetup) },
  { id: 'P11 3-side 200 (70/70/60)', setup: () => ({ seed: 14, scenarioId: 'kestrel', fleets: [fleet('A', 70, 0), fleet('B', 70), fleet('C', 60)], sides: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] } as BattleSetup) },
  { id: 'P11 2-side 140 + join 60 @10s', setup: () => ({ seed: 15, scenarioId: 'kestrel', fleets: [fleet('A', 70, 0), fleet('B', 70)], sides: [{ name: 'A' }, { name: 'B' }] } as BattleSetup),
    each: w => { if (w.tick === 300) (w as any).scheduleEvent(300, { k: 'join', fleet: fleet('C', 60), side: { name: 'C', rel: [-1, -1] }, entry: { x: 1800, z: 0 } }); } },
);
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const c of cases) {
  const runs: { mean: number; p95: number; max: number; steps: number; digest: string; ships: number }[] = [];
  for (let r = 0; r < repeats; r++) {
    const w = new World({ ...c.setup(), ...(process.env.RULES ? { rules: Number(process.env.RULES) } : {}) }), dts: number[] = [];
    for (let i = 0; i < ticks && !w.outcome; i++) { c.each?.(w); const t0 = performance.now(); w.step(); dts.push(performance.now() - t0); }
    runs.push({ mean: dts.reduce((a, b) => a + b, 0) / dts.length, p95: q(dts, .95), max: Math.max(...dts), steps: dts.length, digest: w.digest(), ships: w.ships.length });
  }
  const med = (k: 'mean' | 'p95' | 'max') => q(runs.map(x => x[k]), .5);
  console.log(JSON.stringify({ id: c.id, ships: runs[0].ships, steps: runs[0].steps, meanMs: +med('mean').toFixed(3), p95Ms: +med('p95').toFixed(3), maxMs: +med('max').toFixed(2), budgetPct30Hz: +(med('mean') / (1000 / 30) * 100).toFixed(1), deterministic: runs.every(x => x.digest === runs[0].digest), digest: runs[0].digest }));
}
