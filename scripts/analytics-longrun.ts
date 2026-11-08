// Real six-hour world operation with collection and two file save/reload cycles.
// Bundle with esbuild and run with node --expose-gc (same as analytics-perf.ts).
import { GameServer } from '../src/server/core';
import { WorldSim } from '../src/world/sim';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os'; import path from 'node:path';
const hours = Math.max(1, Math.min(24, Number(process.env.ANALYTICS_LONG_HOURS ?? 6)));
const seed = WorldSim.create(411), players: string[] = [];
for (let i = 0; i < 3; i++) {
  const p = seed.addPlayer(`장기 물류 ${i + 1}`); players.push(p);
  seed.st.companies[p].leases = { astra: 1 }; // existing postpaid lease, no balance parameter change
  const group = Object.values(seed.st.groups).find(g => g.owner === p && g.shipIds.some(id => seed.st.ships[id].classId === 'miner'))!;
  const err = seed.command(p, { c: 'setOp', group: group.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } }); if (err) throw Error(err);
}
for (const l of Object.values(seed.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
for (const sys of Object.values(seed.st.systems)) sys.security = 100;
const options = { singleplayer: false, snapInterval: 1e9 };
let server = new GameServer({ v: 1, world: JSON.parse(seed.serialize()), auth: {} }, options);
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-analytics-long-')), save = path.join(dir, 'world.json');
const samples: unknown[] = [], hash = (s: string) => createHash('sha256').update(s).digest('hex');
global.gc?.(); const initialHeap = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), start = process.hrtime.bigint();
for (let elapsed = 1; elapsed <= hours * 3600; elapsed++) {
  server.step(1);
  if (elapsed % 3600 !== 0) continue;
  const file = server.snapshotFile(), health = server.analytics!.query('admin', '', { hours: 24 }).health;
  const bytes = Buffer.byteLength(JSON.stringify(file.analytics));
  if (bytes > server.analytics!.maxBytes || health.dropped || health.failures || Math.abs(health.reconciliation) > .001) throw Error(`telemetry health failure: ${JSON.stringify(health)}`);
  for (const st of Object.values(server.sim.st.stations)) { if ((st.funds ?? 0) < -1e-6) throw Error('negative market budget'); for (const v of Object.values(st.market ?? {})) if (!Number.isFinite(v.stock) || v.stock < -1e-6) throw Error('invalid market inventory'); }
  for (const ship of Object.values(server.sim.st.ships)) for (const n of Object.values(ship.cargo)) if (!Number.isFinite(n) || n < -1e-6) throw Error('invalid ship cargo');
  let reloaded = false;
  if (elapsed % 7200 === 0 && elapsed < hours * 3600) {
    const before = hash(server.sim.serialize());
    writeFileSync(save + '.tmp', JSON.stringify(file)); renameSync(save + '.tmp', save);
    server = new GameServer(JSON.parse(readFileSync(save, 'utf8')), options);
    if (hash(server.sim.serialize()) !== before) throw Error('game state changed on file reload');
    reloaded = true;
  }
  global.gc?.(); const sample = { hours: elapsed / 3600, bytes, heap: process.memoryUsage().heapUsed, reloaded, fineBuckets: file.analytics!.fine.length, hourlyBuckets: file.analytics!.hourly.length, reconciliation: health.reconciliation };
  samples.push(sample); console.log(JSON.stringify(sample));
}
const usage = process.cpuUsage(cpu), data = server.analytics!.query('admin', '', { hours: 24 });
const report = { simulatedHours: hours, companies: 3, initialHeap, finalHeap: process.memoryUsage().heapUsed, maxRssKiB: process.resourceUsage().maxRSS, wallMs: Number(process.hrtime.bigint() - start) / 1e6, cpuMs: (usage.user + usage.system) / 1000, samples, dropped: data.health.dropped, failures: data.health.failures, reconciliation: data.health.reconciliation, growth: data.current.companies, mined: players.map(p => server.sim.st.companies[p].stats.mined) };
mkdirSync('artifacts/storage-analytics', { recursive: true }); writeFileSync('artifacts/storage-analytics/longrun.json', JSON.stringify(report, null, 2)); console.log('PASS real long-running economy with collection, bounded history and save/reload');
