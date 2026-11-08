// Before/after collector benchmark, including complete game-state equality and tick tails.
// node scripts/p2-analytics-perf.mjs [baseline-ref] (no production connections)
import { build } from 'esbuild';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url'; import { createHash } from 'node:crypto';
if (process.argv[2] === '--worker') {
  const { GameServer } = await import(pathToFileURL(process.argv[3]).href);
  const opts = { singleplayer: false, snapInterval: 1e9, analytics: { enabled: false } };
  const initial = new GameServer(null, opts, 511), sim = initial.sim;
  for (let i = 0; i < 3; i++) { const p = sim.addPlayer(`측정 ${i}`); sim.st.companies[p].leases = { astra: 1 }; const g = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'miner')); sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } }); }
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const s of Object.values(sim.st.systems)) s.security = 100;
  const file = initial.snapshotFile();
  function run(enabled, seconds) {
    const s = new GameServer(structuredClone(file), { ...opts, analytics: { enabled } }); global.gc?.();
    const memory = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), start = performance.now(), ticks = [];
    for (let i = 0; i < seconds * 4; i++) { const at = performance.now(); s.step(.25); ticks.push(performance.now() - at); }
    const used = process.cpuUsage(cpu), wallMs = performance.now() - start; global.gc?.(); ticks.sort((a, b) => a - b);
    const data = s.analytics?.snapshot();
    return { enabled, seconds, cpuMs: (used.user + used.system) / 1000, wallMs, tickP95Ms: ticks[Math.floor(ticks.length * .95)], tickWorstMs: ticks.at(-1), heapDelta: process.memoryUsage().heapUsed - memory, bytes: data ? Buffer.byteLength(JSON.stringify(data)) : 0, dropped: data?.dropped ?? 0, statisticsHash: data ? createHash('sha256').update(JSON.stringify(data)).digest('hex') : undefined, reconciliation: s.analytics?.query('admin', '').health.reconciliation ?? 0, state: s.sim.serialize() };
  }
  run(false, 120); run(true, 120); const pairs = [];
  for (let i = 0; i < 3; i++) {
    let off, on; if (i % 2) { on = run(true, 600); off = run(false, 600); } else { off = run(false, 600); on = run(true, 600); }
    if (off.state !== on.state) throw Error('collector changed game state');
    const hash = createHash('sha256').update(off.state).digest('hex'); delete off.state; delete on.state;
    pairs.push({ off, on, overheadPercent: (on.cpuMs / off.cpuMs - 1) * 100, hash });
  }
  console.log(JSON.stringify({ pairs }));
} else {
  const ref = process.argv[2] ?? 'f108438', temp = mkdtempSync(path.join(tmpdir(), 'siderarium-p2-perf-')), old = path.join(temp, 'old'); mkdirSync(old);
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', ref], { maxBuffer: 32 * 1024 * 1024 }) }); symlinkSync(path.resolve('node_modules'), path.join(old, 'node_modules'));
  const reports = {};
  for (const [label, entry] of [['before', path.join(old, 'src/server/core.ts')], ['after', 'src/server/core.ts']]) {
    const core = path.join(temp, label + '.mjs'); await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: core, logLevel: 'silent' });
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', core], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (child.status) throw Error(child.stderr || child.stdout); reports[label] = JSON.parse(child.stdout);
    console.log(label, JSON.stringify(reports[label]));
  }
  if (reports.before.pairs.some((p, i) => p.hash !== reports.after.pairs[i].hash || p.on.statisticsHash !== reports.after.pairs[i].on.statisticsHash)) throw Error('optimization changed baseline game state');
  mkdirSync('artifacts/logistics-p2', { recursive: true }); writeFileSync('artifacts/logistics-p2/analytics-performance.json', JSON.stringify({ baseline: ref, fixture: 'three companies, real mining/market/postpaid leases, alternating order, 3 x 600s pairs', ...reports }, null, 2));
}
