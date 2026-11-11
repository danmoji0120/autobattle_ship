// Experiment A — autonomy: a fresh world with NO player at all, run for N game hours.
//   npx vite-node scripts/audit/autonomy.ts <seed> <hours> <out.json>
import fs from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { run } from './lib';

const seed = Number(process.argv[2] ?? 1), hours = Number(process.argv[3] ?? 24), out = process.argv[4] ?? `autonomy-${seed}.json`;
const sim = WorldSim.create(seed);
const r = run(sim, hours, 600);
const st = sim.st;
fs.writeFileSync(out, JSON.stringify({ seed, hours, ...r, final: {
  lairs: Object.values(st.lairs).map(l => ({ id: l.id, alive: l.alive, tier: l.tier, sys: sim.sysOf(l.pos)?.id })),
  companies: Object.values(st.companies).map(c => ({ id: c.id, kind: c.kind, credits: c.credits, stats: c.stats })),
  battleLog: (st.battleLog ?? []).map(b => ({ sys: b.sys, winner: b.winner, names: b.names, losses: b.losses, n: b.n, dur: b.end - b.start })),
  systems: Object.values(st.systems).map(s => ({ id: s.id, name: s.name, kind: s.kind, sec: s.security, recoverUntil: s.recoverUntil ?? 0 })),
} }));
console.log(`seed ${seed} ${hours}h done in ${r.wallS.toFixed(0)}s: battles ${r.battles.length}, events ${r.events.length}`);
