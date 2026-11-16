// A-1 cost check: what one second of server time costs (20 steps of 0.05 s, as node.ts runs it) on
//   p9   — WorldSim.create(seed) with no flags (the legacy default)
//   p10  — the P10 layout alone
//   std  — the integrated standard world (worldPreset.ts)
// measured on a fresh world and again after `hours` of simulated play with three companies.
//   npx vite-node scripts/a1/a1-perf.ts [hours=6] [out.json]
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD, worldRules } from '../../src/world/worldPreset';

const hours = Number(process.argv[2] ?? 6);
const presets = { p9: {}, p10: { layout: 'p10' as const }, std: { ...STANDARD_WORLD } };
const msPerGameSecond = (s: WorldSim) => {
  for (let i = 0; i < 40; i++) s.update(0.05);
  const t = process.hrtime.bigint(); for (let i = 0; i < 20 * 60; i++) s.update(0.05);
  return Number(process.hrtime.bigint() - t) / 1e6 / 60;
};
const counts = (s: WorldSim) => {
  const w = s.st as any;
  return {
    ships: Object.keys(w.ships).length, engagements: Object.keys(w.engagements ?? {}).length, wrecks: Object.keys(w.wrecks ?? {}).length,
    events: (w.events ?? []).length, saveKB: Math.round(s.serialize().length / 1024), credits: Math.round(Object.values<any>(w.companies).reduce((a, c) => a + c.credits, 0)),
  };
};
const res: Record<string, unknown> = { hours };
for (const [name, o] of Object.entries(presets)) {
  const s = WorldSim.create(21, o);
  for (const n of ['A', 'B', 'C']) s.addPlayer(n);
  const fresh = msPerGameSecond(s);
  const t0 = Date.now(); const perHour: number[] = [];
  for (let h = 0; h < hours; h++) {
    const t = process.hrtime.bigint(); for (let i = 0; i < 3600; i++) s.update(1);
    perHour.push(+(Number(process.hrtime.bigint() - t) / 1e6 / 3600).toFixed(3));
  }
  const later = msPerGameSecond(s);
  res[name] = { rules: worldRules(s.st), msPerGameSecond: { fresh: +fresh.toFixed(2), after: +later.toFixed(2) }, msPerTick1sByHour: perHour, wallS: (Date.now() - t0) / 1000, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), ...counts(s) };
  console.log(name, JSON.stringify(res[name]));
}
writeFileSync(process.argv[3] ?? 'a1-perf.json', JSON.stringify(res, null, 1));
process.exit(0);
