// P16.5.1: world-level check that the light judgement is unchanged for craft-free ships — run standard worlds
// for a few simulated hours and hash the engagement outcomes and the ship states (hp / alive) after.
//   npx vite-node scripts/p16/light-digest.ts [-- hours=6]
import '../../src/content/registry';
import { createHash } from 'node:crypto';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';

const H = Number(process.argv.find(a => a.startsWith('hours='))?.slice(6) ?? 6);
for (const seed of [11, 23, 71]) {
  const sim = WorldSim.create(seed, { ...STANDARD_WORLD });
  for (let t = 0; t < H * 3600; t += 1) sim.tick(1);
  const eng = Object.values(sim.st.engagements).map(e => `${e.id}:${e.done ? 1 : 0}:${e.winner ?? ''}`).sort();
  const ships = Object.values(sim.st.ships).map(s => `${s.id}:${s.hp.toFixed(6)}:${s.state}`).sort();
  const h = createHash('sha1').update(eng.join('|') + '#' + ships.join('|')).digest('hex').slice(0, 12);
  console.log(JSON.stringify({ seed, hours: H, engagements: eng.length, decided: eng.filter(x => /:1:/.test(x)).length, ships: ships.length, digest: h }));
}
