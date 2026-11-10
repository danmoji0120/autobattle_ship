// Repeat on both checkouts, without concurrent workloads. Inclusive method timings overlap.
import { performance } from 'node:perf_hooks';
import { WorldSim } from '../src/world/sim';

const seconds = Number(process.argv[2] ?? 600), sim = WorldSim.create(97130);
sim.addPlayer('성능 측정');
const names = ['economy', 'npcs', 'npcSlow', 'detectEngagements', 'contracts', 'milestones', 'netWorth'] as const;
const timings: Record<string, { calls: number; ms: number }> = {};
for (const name of names) {
  const obj = sim as any, original = obj[name]; timings[name] = { calls: 0, ms: 0 };
  obj[name] = function (...args: unknown[]) { const t = performance.now(); try { return original.apply(this, args); } finally { timings[name].calls++; timings[name].ms += performance.now() - t; } };
}
const cpu = process.cpuUsage(), start = performance.now();
for (let t = 0; t < seconds; t++) sim.update(1);
console.log(JSON.stringify({ seconds, wallMs: performance.now() - start, cpu: process.cpuUsage(cpu), rss: process.memoryUsage().rss, timings,
  notes: 'Inclusive timings overlap; instrumentation adds overhead and can affect the wall-time-limited NPC battle scheduler. No players receive orders.' }, null, 2));
