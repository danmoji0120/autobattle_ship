// P13.1 supplement: how often is an escorted, loaded hauler actually sunk in a real P11 battle, and what does
// the battle record say about each side? In-process WorldSim (P13.1 world, NPCs and lairs removed), the same
// starting fixture as the real-server scenario, real attack orders only — nothing in the battle is edited.
// For every engagement it records the tactical outcome (side status, alive / lost / escaped ships, end time,
// reason) next to the strategic summary, so the P11 "destroyed / routed with 0 losses" cases can be told apart.
//   npx vite-node scripts/salvage/p131-convoy-trials.ts [trials] [layout...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { LAYOUTS, runTrial, type Trial } from './convoy-fixture';

{
  const args = process.argv.slice(2).filter(a => a !== '--');
  const n = Number(args.find(a => /^\d+$/.test(a)) ?? 6);
  const which = args.filter(a => LAYOUTS[a]);
  const rows: Trial[] = [];
  for (const id of which.length ? which : Object.keys(LAYOUTS)) {
    for (let i = 0; i < n; i++) {
      const r = runTrial(9400 + i, LAYOUTS[id]);
      rows.push(r);
      console.log(JSON.stringify({ layout: id, seed: r.seed, sunk: r.haulerSunk, fate: r.haulerFate, cargo: r.cargoInWrecks, eng: r.engagements.map(e => ({ t: `${Math.round(e.t0)}-${Math.round(e.t1)}`, reason: e.reason, sides: e.sides.map(s => `${s.status}:a${s.alive}/l${s.lost}/e${s.escaped}`), sum: e.summary })) }));
    }
  }
  const by = Object.fromEntries([...new Set(rows.map(r => r.layout))].map(l => { const rs = rows.filter(r => r.layout === l); return [l, { trials: rs.length, sunk: rs.filter(r => r.haulerSunk).length }]; }));
  console.log(JSON.stringify(by));
  mkdirSync('docs/salvage-results', { recursive: true });
  writeFileSync(`docs/salvage-results/p131-convoy-trials.json`, JSON.stringify({ note: 'in-process P13.1 world, real attack orders, nothing edited during the battle', layouts: LAYOUTS, summary: by, rows }, null, 2));
}
