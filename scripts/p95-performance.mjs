// Sequential isolated P9 baseline/current comparisons. Run with node --expose-gc.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const baseline = '07b52c90b8ac2aa6fe66275805c0fd069068dfed';
const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p95-performance-')), oldRoot = path.join(tmp, 'old');
mkdirSync(oldRoot);
execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
async function bundle(root, label) {
  const entry = path.join(tmp, `${label}.ts`), out = path.join(tmp, `${label}.mjs`);
  writeFileSync(entry, `export { WorldSim } from ${JSON.stringify(path.join(root, 'src/world/sim.ts'))};\nexport { GameServer } from ${JSON.stringify(path.join(root, 'src/server/core.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}
const old = await bundle(oldRoot, 'baseline'), current = await bundle(process.cwd(), 'current');
function workload(api, count, mode) {
  const sim = api.WorldSim.create(951), p = sim.addPlayer('성능 검증'), source = sim.st.stations.astra;
  sim.st.companies[p].credits = 1e6; source.storage[p].alloy = 100000;
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  const destinations = [];
  for (let i = 0; i < count; i++) {
    const site = { ...structuredClone(source), id: `p95_perf_${i}`, owner: p, public: false, name: `시험 기지 ${i}`, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined,
      pos: { ...source.pos, x: source.pos.x + 7000 + i * 25, z: source.pos.z + 7000 }, storage: { [p]: {} }, modules: [
        { kind: 'core', slot: 0, progress: 1, built: true },
        { kind: 'repair', slot: 1, progress: 0, built: false, id: `p95_plan_${i}`, paid: 0, paused: false, reserved: {}, used: {} },
      ] };
    sim.st.stations[site.id] = site; destinations.push(site.id);
    const g = sim.newGroup(p, `시험 운송 ${i}`), s = sim.spawnShip(p, 'hauler', 'std', g.id, source.pos); sim.dockShip(s, source);
    const error = sim.command(p, { c: 'putRoute', group: g.id, config: { name: `시험 ${i}`, from: source.id, to: site.id, item: 'alloy', mode, amount: 60, repeat: true } });
    if (error) throw Error(error);
  }
  const server = new api.GameServer({ v: 1, world: JSON.parse(sim.serialize()), auth: {} }, { singleplayer: false, snapInterval: 1e9, migrateContent: false });
  server.sim.npcSlow = () => {};
  const w = server.sim.st;
  const owned = () => (w.stations.astra.storage[p].alloy || 0) + Object.values(w.ships).filter(s => s.owner === p).reduce((n, s) => n + (s.cargo.alloy || 0), 0) + destinations.reduce((n, id) => { const st = w.stations[id]; return n + (st.storage[p].alloy || 0) + st.modules.reduce((m, plan) => m + (plan.reserved?.alloy || 0) + (plan.used?.alloy || 0), 0); }, 0);
  for (let i = 0; i < 80; i++) server.step(.25);
  const initial = owned(); global.gc?.(); const heap = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), start = performance.now(), ticks = [];
  for (let i = 0; i < 600; i++) { const at = performance.now(); server.step(.25); ticks.push(performance.now() - at); }
  const ms = performance.now() - start, used = process.cpuUsage(cpu); global.gc?.();
  ticks.sort((a, b) => a - b); const balance = owned() - initial;
  if (Math.abs(balance) > 1e-6) throw Error(`material imbalance: ${balance}`);
  const routes = Object.values(w.logistics ?? {});
  return { routes: count, mode, ticks: ticks.length, meanMs: ms / ticks.length, cpuMs: (used.user + used.system) / 1000 / ticks.length,
    p95Ms: ticks[Math.floor(ticks.length * .95)], worstMs: ticks.at(-1), heapDeltaBytes: process.memoryUsage().heapUsed - heap,
    worldBytes: Buffer.byteLength(server.sim.serialize()), loaded: routes.reduce((n, r) => n + r.stats.loaded, 0), delivered: routes.reduce((n, r) => n + r.stats.delivered, 0), materialBalance: balance };
}
const reports = [];
for (let round = 1; round <= 2; round++) for (const count of [0, 10, 30]) {
  for (const [version, api, mode] of [['baseline', old, 'transfer'], ['current', current, 'transfer'], ...(count ? [['current', current, 'construction']] : [])]) {
    const result = { round, version, ...workload(api, count, mode) }; reports.push(result); console.log(JSON.stringify(result));
  }
}
mkdirSync('artifacts/p95', { recursive: true });
writeFileSync('artifacts/p95/performance.json', JSON.stringify({ baseline, note: 'Sequential single-process samples, 80 warmup and 600 measured 0.25-second GameServer steps; analytics enabled, no clients, NPC spawning disabled; pre-seeded resources and stations. Construction and transfer are different workloads; heap delta is not total memory.', reports }, null, 2));
