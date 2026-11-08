// Compare the P9.5 simulation before and after the yard restock fast path. The temporary
// baseline keeps all current P9.5 changes and restores only the two pre-optimization calls.
import { build } from 'esbuild';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p95-yard-'));
try {
  const oldRoot = path.join(tmp, 'before'); cpSync('src', oldRoot, { recursive: true });
  const oldHullops = execFileSync('git', ['show', '07b52c90b8ac2aa6fe66275805c0fd069068dfed:src/world/hullops.ts'], { encoding: 'utf8' });
  writeFileSync(path.join(oldRoot, 'world/hullops.ts'), oldHullops);
  const simFile = path.join(oldRoot, 'world/sim.ts'); let simSource = readFileSync(simFile, 'utf8');
  assert(simSource.includes('hullSale, hullStock, yardHulls'));
  assert(simSource.includes('const sale = hullStock(id); if (!sale) continue;'));
  simSource = simSource.replace('hullSale, hullStock, yardHulls', 'hullSale, yardHulls').replace('const sale = hullStock(id); if (!sale) continue;', 'const sale = hullSale(id); if (!sale) continue;');
  writeFileSync(simFile, simSource);
  const bundle = async (root, name) => {
    const entry = path.join(tmp, `${name}.ts`), outfile = path.join(tmp, `${name}.mjs`);
    writeFileSync(entry, `export { WorldSim } from ${JSON.stringify(path.resolve(root, 'world/sim.ts'))};\nexport { hullSale, yardHulls } from ${JSON.stringify(path.resolve(root, 'world/hullops.ts'))};\nexport { CONTENT } from ${JSON.stringify(path.resolve(root, 'content/registry.ts'))};\n`);
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
    return import(pathToFileURL(outfile).href);
  };
  const before = await bundle(oldRoot, 'before'), after = await bundle('src', 'after');
  const coldBefore = await bundle(oldRoot, 'before-no-player'), coldAfter = await bundle('src', 'after-no-player');
  const setup = lib => {
    const sim = lib.WorldSim.create(951); sim.addPlayer('조선소 등가 검증');
    sim.npcSlow = () => {};
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    return sim;
  };
  const a = setup(before), b = setup(after), hash = s => createHash('sha256').update(s.serialize()).digest('hex');
  const now = performance.now; Object.defineProperty(performance, 'now', { configurable: true, value: () => 0 });
  const ms = { before: 0, after: 0 }, run = (sim, label, ticks) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < ticks; i++) sim.update(.25);
    ms[label] += Number(process.hrtime.bigint() - start) / 1e6;
  };
  try {
    // A world can run before anyone creates a company or asks for a price. Check this cold path
    // with independent valuation caches: the former implementation priced hulls while restocking.
    const emptyA = coldBefore.WorldSim.create(952), emptyB = coldAfter.WorldSim.create(952);
    for (const sim of [emptyA, emptyB]) {
      sim.npcSlow = () => {};
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    }
    run(emptyA, 'before', 40); run(emptyB, 'after', 40); assert.equal(hash(emptyA), hash(emptyB));
    const coldPrices = lib => Object.values(lib.CONTENT.hulls).map(h => [h.id, lib.hullSale(h.id)]);
    assert.deepEqual(coldPrices(coldBefore), coldPrices(coldAfter));
    // First tick the untouched worlds before querying prices, so lazy valuation order is covered.
    run(a, 'before', 40); run(b, 'after', 40); assert.equal(hash(a), hash(b));
    const prices = lib => Object.values(lib.CONTENT.hulls).map(h => [h.id, lib.hullSale(h.id)]);
    assert.deepEqual(prices(before), prices(after));
    for (const id of Object.keys(a.st.stations)) assert.deepEqual(before.yardHulls(a.st.stations[id]), after.yardHulls(b.st.stations[id]));
    for (const [sim, lib] of [[a, before], [b, after]]) for (const st of Object.values(sim.st.stations)) if (st.public) {
      for (const m of Object.values(st.market ?? {})) m.stock = Math.max(m.stock, 100000);
      for (const id of lib.yardHulls(st)) { const sale = lib.hullSale(id); (st.shipStock ??= {})[id] = { n: 0, t: Math.max(0, sale.restock - 1) }; }
    }
    assert.equal(hash(a), hash(b));
    const hashes = [];
    for (let minute = 1; minute <= 5; minute++) {
      run(a, 'before', 240); run(b, 'after', 240);
      const left = hash(a), right = hash(b); assert.equal(left, right); hashes.push(left);
    }
    assert.deepEqual(prices(before), prices(after));
    const restocked = Object.values(b.st.stations).reduce((n, st) => n + Object.values(st.shipStock ?? {}).reduce((m, stock) => m + stock.n, 0), 0);
    assert(restocked > 0);
    const result = { seconds: 310, checkpointHashesMatched: hashes.length + 1, coldWorldPricesMatched: true, hulls: Object.keys(after.CONTENT.hulls).length, stations: Object.keys(b.st.stations).length, restocked, hash: hashes.at(-1), elapsedMs: ms, note: 'Single sequential sample; NPC spawning suppressed and elapsed simulation wall clock fixed for reproducibility. Both versions include the same P9.5 changes.' };
    writeFileSync('artifacts/p95/yard-equivalence.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
  } finally { Object.defineProperty(performance, 'now', { configurable: true, value: now }); }
} finally { rmSync(tmp, { recursive: true, force: true }); }
