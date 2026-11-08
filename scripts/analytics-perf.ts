// Reproducible headless measurement; no production data. Run:
// npx esbuild scripts/analytics-perf.ts --bundle --platform=node --format=esm --outfile=/tmp/siderarium-perf.mjs
// node --expose-gc /tmp/siderarium-perf.mjs
import { GameServer } from '../src/server/core';
import { WorldSim } from '../src/world/sim';
import type { SaveFile } from '../src/server/protocol';
import { writeFileSync, mkdirSync } from 'node:fs';
const sim = WorldSim.create(511);
for (let i = 0; i < 3; i++) {
  const p = sim.addPlayer(`성능검증 ${i}`);
  const g = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'miner'))!;
  sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } });
}
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
for (const s of Object.values(sim.st.systems)) s.security = 100;
const file: SaveFile = { v: 1, world: JSON.parse(sim.serialize()), auth: {} };
function run(enabled: boolean, seconds: number) {
  const server = new GameServer(structuredClone(file), { singleplayer: false, snapInterval: 1e9, analytics: { enabled } });
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), start = process.hrtime.bigint();
  for (let i = 0; i < seconds * 4; i++) server.step(.25);
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6, used = process.cpuUsage(cpu);
  global.gc?.(); const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  const stats = server.analytics?.snapshot();
  return { enabled, seconds, wallMs, cpuMs: (used.user + used.system) / 1000, observerCpuMs: server.analytics?.cpuMs ?? 0, heapDelta, statsBytes: stats ? Buffer.byteLength(JSON.stringify(stats)) : 0, rows: stats?.current.rows.length ?? 0, dropped: stats?.dropped ?? 0, reconciliation: server.analytics?.query('admin', '').health.reconciliation ?? 0, state: server.sim.serialize() };
}
run(false, 60); run(true, 60);
const pairs = [];
for (let i = 0; i < 3; i++) {
  const off = run(false, 600), on = run(true, 600);
  if (off.state !== on.state) throw Error('measurement fixture diverged with analytics enabled');
  const { state: _off, ...a } = off, { state: _on, ...b } = on;
  pairs.push({ off: a, on: b, overheadPercent: (on.cpuMs / off.cpuMs - 1) * 100 });
  console.log(JSON.stringify(pairs.at(-1)));
}
mkdirSync('artifacts/storage-analytics', { recursive: true });
writeFileSync('artifacts/storage-analytics/performance.json', JSON.stringify({ fixture: '3 companies, real automatic mining and NPC markets, 600 world seconds × 3 alternating pairs; full state equality checked', pairs }, null, 2));
