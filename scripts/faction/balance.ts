// Static supply/demand table of the v2 faction economy at full efficiency (all factions together).
//   npx vite-node scripts/faction/balance.ts
import { WorldSim } from '../../src/world/sim';
import { rates, PROFILES2, FE_SCALE } from '../../src/world/factionEcon2';
import { RECIPES, ITEMS } from '../../src/world/industry';
import { addc, type Cargo } from '../../src/world/types';
const sim = WorldSim.create(5, { layout: 'p10', factionEcon: 'v2' });
const need: Cargo = {}, cap: Cargo = {}, by: Record<string, Cargo> = {};
for (const f of Object.values(sim.st.factions!)) {
  const R = rates(sim.st, f), p = PROFILES2[f.id];
  for (const [k, n] of Object.entries(R.base)) addc(need, k, n);
  for (const c of Object.values(R.prog)) for (const [k, n] of Object.entries(c)) addc(need, k, n);
  for (const [k, n] of Object.entries(R.input)) addc(need, k, n);
  for (const [k, n] of Object.entries(p.mine)) { addc(cap, k, R.size * n * FE_SCALE); addc((by[k] ??= {}), f.id, R.size * n * FE_SCALE); }
  for (const [r, n] of Object.entries(p.sectors)) { const o = Object.keys(RECIPES[r].out)[0]; const c = (['armor_plate', 'weapon_parts', 'eq_autocannon', 'eq_medium_gun', 'mod_armor'].includes(r) ? R.mun : R.ind) * n * FE_SCALE; addc(cap, o, c); addc((by[o] ??= {}), f.id, c); }
}
const rows = Object.keys({ ...need, ...cap }).sort((a, b) => (ITEMS[a]?.tier ?? 0) - (ITEMS[b]?.tier ?? 0) || a.localeCompare(b));
console.log('good            need/h     cap/h   cap/need  value need/h   producers');
for (const k of rows) console.log(`${k.padEnd(14)} ${Math.round(need[k] ?? 0).toString().padStart(8)} ${Math.round(cap[k] ?? 0).toString().padStart(9)}  ${((cap[k] ?? 0) / Math.max(1, need[k] ?? 0)).toFixed(2).padStart(6)}  ${Math.round((need[k] ?? 0) * (ITEMS[k]?.price ?? 50) / 1000).toString().padStart(8)}k   ${Object.entries(by[k] ?? {}).map(([f, n]) => `${f}:${Math.round(n)}`).join(' ')}`);
