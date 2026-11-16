// A-1: fingerprint of a standard world after 1 h of play (three companies; miners working) — used to show a pure
// performance change leaves the simulation bit-for-bit identical.   npx vite-node scripts/a1/a1-determinism.ts
// NPC-only battles advance within a wall-time budget per tick (sim.ts NPC_BATTLE_BUDGET_MS): on a busy machine they
// finish at a later world time. That is by design, but it makes a fingerprint depend on CPU load, so the clock is
// frozen here — the budget never runs out and the run depends only on the code.
globalThis.performance.now = () => 0;
import { createHash } from 'node:crypto';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';

const out: Record<string, string> = {};
for (const seed of [21, 41]) {
  const s = WorldSim.create(seed, { ...STANDARD_WORLD });
  for (const n of ['A', 'B', 'C']) {
    const id = s.addPlayer(n);
    const g = Object.values(s.st.groups).find(x => x.owner === id && x.name === '제1 채굴반')!;
    s.command(id, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } } as any);
  }
  for (let i = 0; i < 3600; i++) s.update(i % 2 ? 0.05 : 1.95);
  out[seed] = createHash('sha256').update(s.serialize()).digest('hex').slice(0, 16);
}
console.log(JSON.stringify(out));
process.exit(0);
