// A-1: where the standard world's tick time goes, compared with the P10 layout alone. Runs each world 1 h (three
// idle companies, seed 21), then profiles 10 game-minutes at the server's 0.05 s step with the V8 sampling profiler
// and sums self time by source file.
//   npx vite-node scripts/a1/a1-profile.ts [out.json]
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';

const session = new Session(); session.connect();
await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 200 });
const out: Record<string, unknown> = {};
for (const [name, o] of Object.entries({ p10: { layout: 'p10' as const }, std: { ...STANDARD_WORLD } })) {
  const s = WorldSim.create(21, o);
  for (const n of ['A', 'B', 'C']) s.addPlayer(n);
  for (let i = 0; i < 3600; i++) s.update(1);
  await session.post('Profiler.start');
  const t = process.hrtime.bigint();
  for (let i = 0; i < 20 * 600; i++) s.update(0.05);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const { profile } = await session.post('Profiler.stop');
  const dt = profile.timeDeltas ?? []; const self = new Map<number, number>();
  (profile.samples ?? []).forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
  const byFile = new Map<string, number>(), byFn = new Map<string, number>();
  let total = 0;
  for (const n of profile.nodes) {
    const us = self.get(n.id) ?? 0; if (!us) continue; total += us;
    const f = (n.callFrame.url.split('/src/')[1] ?? (n.callFrame.url ? n.callFrame.url.split('/').pop() : '(native/gc)')) || '(native/gc)';
    byFile.set(f, (byFile.get(f) ?? 0) + us);
    const fn = `${f}:${n.callFrame.functionName || '(anon)'}`; byFn.set(fn, (byFn.get(fn) ?? 0) + us);
  }
  const top = (m: Map<string, number>, k: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, us]) => [f, +(us / 1000 / 600).toFixed(3), +(100 * us / total).toFixed(1)]);
  out[name] = { msPerGameSecond: +(ms / 600).toFixed(2), topFilesMsPerGameSecondPct: top(byFile, 18), topFunctions: top(byFn, 20) };
  console.log(name, JSON.stringify(out[name]));
}
writeFileSync(process.argv[2] ?? 'a1-profile.json', JSON.stringify(out, null, 1));
process.exit(0);
