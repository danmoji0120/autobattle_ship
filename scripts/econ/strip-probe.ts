// Probe (analysis): can a company profit by buying finished NPC hulls, stripping their standard weapons into
// storage and selling those weapons to NPC markets? Real commands in an isolated world, for each world kind.
//   npx vite-node scripts/econ/strip-probe.ts -- [hours=6] [seed=5] [legacy|B-chain|B-margin|B-keep]
import { WorldSim } from '../../src/world/sim';
import { CONTENT } from '../../src/content/registry';
import { EQUIPMENT } from '../../src/world/industry';
import { qty } from '../../src/world/types';
import type { EqPolicy } from '../../src/world/econChain';

const args = process.argv.slice(2).filter(a => a !== '--');
const hours = Number(args[0] ?? 6), seed = Number(args[1] ?? 5), only = args[2];
const kinds: [string, { econ?: 'chain'; eq?: EqPolicy }][] = [['legacy', {}], ['B chain', { econ: 'chain', eq: 'chain' }], ['B margin', { econ: 'chain', eq: 'margin' }], ['B keep', { econ: 'chain', eq: 'keep' }]];
for (const [label, o] of kinds.filter(([l]) => !only || l.replace(' ', '-') === only)) {
  const sim = WorldSim.create(seed, o), W = sim.st;
  const p = sim.addPlayer('스트립'), co = W.companies[p]; co.credits = 2_000_000; co.rep = 100;
  const rows: string[] = [];
  let spent = 0, earned = 0, bought = 0;
  for (let h = 0; h < hours; h++) {
    for (const st of Object.values(W.stations).filter(s => s.public && s.services.shipyard.length)) {
      for (const preset of Object.values(CONTENT.presets).filter(pr => ['corvette_mk1', 'frigate_mk1', 'patrol_pathfinder'].includes(pr.hull) && Object.keys(pr.weapons ?? {}).length)) {
        const c0 = co.credits;
        const err = sim.command(p, { c: 'buyShip', station: st.id, classId: '', loadoutId: '', hull: preset.hull, variant: preset.variant, preset: preset.id });
        if (err) continue;
        const ship = Object.values(W.ships).filter(s => s.owner === p).at(-1)!;
        spent += c0 - co.credits; bought++;
        const e2 = sim.command(p, { c: 'fit', ship: ship.id, variant: ship.variant, hp: {}, bay: ship.fitting?.bay ?? {} });
        if (e2) { rows.push(`unfit ${preset.id}: ${e2}`); continue; }
        // sell every stripped weapon at the best-paying market that trades it (here, or anywhere: ignore hauling)
        for (const eq of Object.keys(st.storage[p] ?? {}).filter(k => EQUIPMENT[k] && qty(st.storage[p], k) >= 1)) {
          const n = Math.floor(qty(st.storage[p], eq));
          const mk = Object.values(W.stations).filter(s => s.public && s.market?.[eq]).sort((a, b) => sim.price(b, eq, 'sell') - sim.price(a, eq, 'sell'))[0];
          if (!mk) continue;
          st.storage[p][eq] -= n; (mk.storage[p] ??= {})[eq] = (mk.storage[p][eq] ?? 0) + n;   // teleport: upper bound
          const c1 = co.credits; sim.command(p, { c: 'sell', station: mk.id, res: eq, amount: n }); earned += co.credits - c1;
        }
      }
    }
    for (let t = 0; t < 3600; t++) sim.update(1);
    console.log(`  ${label} h${h + 1}: ships ${bought} · paid ${Math.round(spent)} · weapons sold ${Math.round(earned)} · net ${Math.round(earned - spent)}`);
  }
  console.log(`${label.padEnd(9)} ships ${bought} · paid ${Math.round(spent)} · weapons sold ${Math.round(earned)} · net ${Math.round(earned - spent)} (hull kept, hauling ignored) ${rows.slice(0, 2).join(' | ')}`);
}
