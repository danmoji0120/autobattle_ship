// Disposable, deterministic workloads; reports observations rather than imposing a timing threshold.
import { performance } from 'node:perf_hooks';
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import { nextGate } from '../src/world/geom';
import { GameServer } from '../src/server/core';

function run(layout: 'five' | 'p9') {
  const make = (seed: number) => layout === 'five' ? new WorldSim(newWorld(seed)) : WorldSim.create(seed);
  let start = performance.now();
  for (let i = 0; i < 20; i++) make(1234 + i);
  const createMs = (performance.now() - start) / 20;
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const batch = Array.from({ length: 30 }, (_, i) => make(7000 + i));
  global.gc?.();
  const heapPerWorldBytes = global.gc ? (process.memoryUsage().heapUsed - heapBefore) / batch.length : null;
  // Keep the worlds alive across the measurement; allow their collection before the tick test.
  batch.length = 0; global.gc?.();
  const sim = make(1234); sim.addPlayer('성능 측정');
  for (let i = 0; i < 100; i++) sim.update(.25);
  const cpu0 = process.cpuUsage(); start = performance.now();
  for (let i = 0; i < 1600; i++) sim.update(.25);
  const tickMs = (performance.now() - start) / 1600, cpu = process.cpuUsage(cpu0);
  const ids = Object.keys(sim.st.systems); start = performance.now(); let found = 0;
  for (let i = 0; i < 20000; i++) { const a = i % ids.length, b = (a + 1 + Math.floor(i / ids.length) % (ids.length - 1)) % ids.length; if (nextGate(sim.st.systems, ids[a], ids[b])) found++; }
  const pathUs = (performance.now() - start) * 1000 / 20000;
  const serialized = sim.serialize(), save = JSON.parse(serialized);
  const server = new GameServer({ v: 1, world: save, auth: {} }, { singleplayer: false, snapInterval: 1 });
  for (let i = 0; i < 100; i++) server.step(.25);
  const serverCpu = process.cpuUsage(); start = performance.now();
  for (let i = 0; i < 800; i++) server.step(.25);
  const serverStepMs = (performance.now() - start) / 800, serverUsed = process.cpuUsage(serverCpu);
  return { layout, systems: ids.length, createMs, tickMs, tickCpuMs: (cpu.user + cpu.system) / 1000 / 1600,
    serverStepMs, serverCpuMs: (serverUsed.user + serverUsed.system) / 1000 / 800, serverSteps: 800,
    saveBytes: Buffer.byteLength(serialized), heapPerWorldBytes, pathUs, pathsFound: found, ships: Object.keys(sim.st.ships).length, serverShips: Object.keys(server.sim.st.ships).length };
}
// Warm shared modules and JIT for both layouts before the timed creation batches.
for (let i = 0; i < 10; i++) { new WorldSim(newWorld(i)); WorldSim.create(i); }
console.log(JSON.stringify({ note: 'single process, warm modules, 20 creations, 1600 simulation ticks and 800 GameServer steps per layout; analytics enabled, no connected clients; heap is a GC-based 30-world estimate, not RSS', results: [run('five'), run('p9')] }, null, 2));
