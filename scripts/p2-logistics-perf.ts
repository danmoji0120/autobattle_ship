// Bundle: npx esbuild scripts/p2-logistics-perf.ts --bundle --platform=node --format=esm --outfile=/tmp/p2-logistics-perf.mjs
// Run: node --expose-gc /tmp/p2-logistics-perf.mjs
import { GameServer } from '../src/server/core';
import { WorldSim } from '../src/world/sim';
import { routeShips, type LogisticsRoute } from '../src/world/logistics';
import { qty, type Station } from '../src/world/types';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
const arg = process.argv.indexOf('--worker');
if (arg >= 0) {
  const count = Number(process.argv[arg + 1]), paused = process.argv[arg + 2] === 'paused';
  const sim = WorldSim.create(615), players: string[] = [], groups: string[] = [];
  const origin = sim.st.stations.astra;
  for (let i = 0; i < 3; i++) {
    const p = sim.addPlayer(`부하 검증 ${i + 1}`); players.push(p); sim.st.companies[p].credits = 1e6;
    for (const [j, dx] of [[0, 1400], [1, 3000]]) {
      const st: Station = { ...structuredClone(origin), id: `bench_${i}_${j}`, name: `산업항 ${i}-${j}`, owner: p, public: false, pos: { ...origin.pos, x: origin.pos.x + dx, z: origin.pos.z + i * 2000 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: { ore: j ? 0 : 100000 } }, modules: [{ kind: 'core', slot: 0, built: true, progress: 1 }] };
      sim.st.stations[st.id] = st;
    }
  }
  for (let i = 0; i < count; i++) { const p = players[i % 3], g = sim.newGroup(p, `운송 ${i + 1}`), source = sim.st.stations[`bench_${i % 3}_0`]; const s = sim.spawnShip(p, 'hauler', 'std', g.id, source.pos); (sim as any).dockShip(s, source); groups.push(g.id); }
  const server = new GameServer({ v: 1, world: JSON.parse(sim.serialize()), auth: {} }, { singleplayer: false, snapInterval: 1e9 });
  for (let i = 0; i < count; i++) {
    const error = server.sim.command(players[i % 3], { c: 'putRoute', group: groups[i], config: { name: `노선 ${i + 1}`, from: `bench_${i % 3}_0`, to: `bench_${i % 3}_1`, item: 'ore', mode: 'transfer', amount: 100, repeat: true } }); if (error) throw Error(error);
  }
  if (paused) for (const p of players) { const ids = Object.values(server.sim.st.logistics!).filter(r => r.owner === p).map(r => r.id); if (ids.length) server.sim.command(p, { c: 'routeControl', routes: ids, action: 'pause' }); }
  for (let i = 0; i < 240; i++) server.step(.25);
  // A real six-ship tactical NPC battle runs concurrently with transport and existing NPC economy.
  const pos = { ...server.sim.st.systems.drake.origin, x: server.sim.st.systems.drake.origin.x + 10000 };
  const pirates = server.sim.newGroup('pirates', '부하 해적'), union = server.sim.newGroup('union', '부하 초계대');
  for (let i = 0; i < 3; i++) { server.sim.spawnShip('pirates', 'destroyer', 'strike', pirates.id, { ...pos, z: pos.z - 200 }); server.sim.spawnShip('union', 'destroyer', 'aa', union.id, { ...pos, z: pos.z + 200 }); }
  server.sim.createEngagement(pos, [pirates], [union]);
  const ore = () => players.reduce((n, p) => n + Object.values(server.sim.st.stations).reduce((a, st) => a + qty(st.storage[p], 'ore'), 0) + Object.values(server.sim.st.ships).filter(s => s.owner === p).reduce((a, s) => a + qty(s.cargo, 'ore'), 0), 0);
  const routes = () => Object.values(server.sim.st.logistics!);
  const losses = () => routes().reduce((n, r) => n + r.stats.lost + Object.entries(r.manifests).filter(([id]) => !server.sim.st.ships[id]).reduce((a, [, m]) => a + m.amount, 0), 0);
  const initialOre = ore(), initialLoss = losses(), initialDelivered = routes().reduce((n, r) => n + r.stats.delivered, 0);
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed, start = performance.now(), cpu = process.cpuUsage();
  const ticks: number[] = [], battleTicks: number[] = []; let peakBattles = 0, maxBattleMs = 0;
  for (let i = 0; i < 2400; i++) {
    const npc = Object.values(server.sim.st.engagements).some(e => !e.done && !e.live), at = performance.now(); server.step(.25); const elapsed = performance.now() - at;
    ticks.push(elapsed); if (npc) battleTicks.push(elapsed); peakBattles = Math.max(peakBattles, server.sim.battles.size); maxBattleMs = Math.max(maxBattleMs, server.sim.npcBattleMs);
  }
  const used = process.cpuUsage(cpu), wallMs = performance.now() - start; global.gc?.();
  const data = server.snapshotFile(), health = server.analytics!.query('admin', '').health;
  const percentile = (values: number[], q: number) => { const v = [...values].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(v.length * q))] ?? 0; };
  const delivered = routes().reduce((n, r) => n + r.stats.delivered, 0) - initialDelivered;
  const balance = ore() + losses() - initialLoss - initialOre;
  if (Math.abs(balance) > 1e-7 || (!paused && delivered <= 0) || !battleTicks.length || health.failures || health.dropped || Math.abs(health.reconciliation) > .001) throw Error(`load validation failed: ${JSON.stringify({ balance, delivered, battleTicks: battleTicks.length, health })}`);
  console.log(JSON.stringify({ routes: count, companies: 3, paused, seconds: 600, cpuMs: (used.user + used.system) / 1000, wallMs, heapDelta: process.memoryUsage().heapUsed - heapBefore, maxRssKiB: process.resourceUsage().maxRSS, tickP95Ms: percentile(ticks, .95), tickWorstMs: percentile(ticks, 1), battleTickP95Ms: percentile(battleTicks, .95), battleTickWorstMs: percentile(battleTicks, 1), battleTickCount: battleTicks.length, peakBattles, maxNpcBattleMs: maxBattleMs, worldBytes: Buffer.byteLength(JSON.stringify(data.world)), routeBytes: Buffer.byteLength(JSON.stringify(data.world.logistics)), analyticsBytes: Buffer.byteLength(JSON.stringify(data.analytics)), delivered, materialBalance: balance, reconciliation: health.reconciliation, dropped: health.dropped, failures: health.failures }));
} else {
  const reports = [];
  for (const count of [1, 10, 50]) for (const state of ['paused', 'active']) {
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', String(count), state], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (child.status) throw Error(child.stderr || child.stdout); const report = JSON.parse(child.stdout); reports.push(report); console.log(JSON.stringify(report));
  }
  mkdirSync('artifacts/logistics-p2', { recursive: true }); writeFileSync('artifacts/logistics-p2/logistics-performance.json', JSON.stringify({ fixture: 'three companies; 1/10/50 actual routes; same fleets paused/active; NPC economy and real tactical battle', reports }, null, 2));
}
