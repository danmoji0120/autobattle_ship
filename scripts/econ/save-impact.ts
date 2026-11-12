// Save-data impact of a balance proposal on an EXISTING (migrated c4) save. Read-only: builds an isolated
// migrated world, measures its current market prices, applies the proposal in memory, and reports
//   - per-good market base change (mean over public markets)
//   - value change of a typical industrial holding
//   - hulls: NPC list price vs own-yard build cost (parts bought at market ask) before/after
//   npx vite-node scripts/econ/save-impact.ts -- <proposal> [seed=5] [json-out]
import fs from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { newWorld } from '../../src/world/worldgen';
import { hullBuild, hullSale } from '../../src/world/hullops';
import { yardFee } from '../../src/world/valuation';
import { CONTENT } from '../../src/content/registry';
import { proposal } from './proposals';
import { ASK } from './model';
import type { WorldState } from '../../src/world/types';

const args = process.argv.slice(2).filter(a => a !== '--');
const prop = proposal(args[0] ?? 'combo'), seed = Number(args[1] ?? 5), out = args[2];

function migrated(): WorldSim {
  const st = newWorld(seed); delete (st as { contentV?: number }).contentV;
  return new WorldSim(JSON.parse(new WorldSim(st, { migrateContent: false }).serialize()), { migrateContent: true });
}
const meanBase = (w: WorldState) => {
  const acc: Record<string, number[]> = {};
  for (const s of Object.values(w.stations)) if (s.public && s.market) for (const [k, e] of Object.entries(s.market)) if (!k.startsWith('bp:')) (acc[k] ??= []).push(e.base);
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
};
const before = meanBase(migrated().st);
prop.patch?.();
const sim = migrated(); prop.reprice?.(sim.st);
const after = meanBase(sim.st);

const goods = Object.keys(before).filter(k => after[k] !== undefined).map(k => ({ id: k, before: Math.round(before[k]), after: Math.round(after[k]), pct: Math.round((after[k] / before[k] - 1) * 1000) / 10 }));
// a typical mid company's warehouse: raw, refined and parts in the proportions the long runs end with
const HOLD: Record<string, number> = { ore: 2000, silicate: 800, metal: 1200, alloy: 800, titanium: 300, machinery: 120, structure: 100, electronics: 80, armor_plate: 40 };
const hv = (p: Record<string, number>) => Object.entries(HOLD).reduce((a, [k, n]) => a + n * (p[k] ?? 0) * 0.9, 0);
const holding = { before: Math.round(hv(before)), after: Math.round(hv(after)) };
const hulls = Object.values(CONTENT.hulls).map(h => {
  const s = hullSale(h.id); if (!s) return undefined;
  const b = hullBuild(h.id);
  const cost = (p: Record<string, number>) => Object.entries(b.parts).reduce((a, [k, n]) => a + n * (p[k] ?? 0) * ASK, 0) + b.credits + yardFee(b);
  return { hull: h.id, price: s.price, buildBefore: Math.round(cost(before)), buildAfter: Math.round(cost(after)), ratioBefore: Math.round(cost(before) / s.price * 100) / 100, ratioAfter: Math.round(cost(after) / s.price * 100) / 100 };
}).filter(Boolean);
if (out) fs.writeFileSync(out, JSON.stringify({ proposal: prop.id, goods, holding, hulls }));
console.log(`# ${prop.id}: market base change on a migrated c4 save (mean over public markets)`);
for (const g of goods.filter(g => Math.abs(g.pct) >= 0.5).sort((a, b) => a.id.localeCompare(b.id))) console.log(`${g.id.padEnd(16)} ${String(g.before).padStart(7)} → ${String(g.after).padStart(7)}  ${g.pct > 0 ? '+' : ''}${g.pct}%`);
console.log(`holding (mid company warehouse, at bid): ${holding.before} → ${holding.after}`);
for (const h of hulls) console.log(`${h!.hull.padEnd(20)} NPC ${h!.price}  own-build ${h!.buildBefore} → ${h!.buildAfter}  (×${h!.ratioBefore} → ×${h!.ratioAfter})`);
