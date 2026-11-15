// P13.3 on the P10 layout (40 systems, factions, fog): placement per region type, faction restrictions at the
// chosen stations, and a short run (intel-based discovery, budgets, no errors). Writes docs/blackmarket-results/p10-<seed>.json
//   npx vite-node scripts/blackmarket/p133-p10-check.ts [seed] [hours]
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { restrictedAt, tierOf } from '../../src/world/blackmarket';
import { sysAt } from '../../src/world/geom';
const seed = Number(process.argv[2] ?? 133), hours = Number(process.argv[3] ?? 0.5);
const sim = WorldSim.create(seed, { layout: 'p10', blackMarket: 'p133', factionEcon: 'v2' } as any);
const st = sim.st;
const place = Object.values(st.blackMarkets!).map(b => { const s = st.stations[b.station], y = sysAt(st.systems, s.pos)!; return { id: b.id, tier: b.tier, station: s.id, name: s.name, faction: s.faction, system: y.id, region: (y as any).region, security: y.security, tierOfSystem: tierOf(y), restrictedHere: restrictedAt(st, s), funds: Math.round(b.funds), hostFundsAfter: Math.round(s.funds ?? 0), lairs: b.lairs }; });
const players = ['P1', 'P2'].map(n => sim.addPlayer(n));
const t0 = performance.now(); let worst = 0;
for (let t = 0; t < hours * 3600; t += 0.5) { const a = performance.now(); sim.update(0.5); worst = Math.max(worst, performance.now() - a); }
const after = Object.values(st.blackMarkets!).map(b => ({ id: b.id, funds: Math.round(b.funds), stock: Object.fromEntries(Object.entries(b.stock).map(([k, x]) => [k, +x.n.toFixed(2)])) }));
const known = Object.fromEntries(Object.entries(st.companies).filter(([, c]) => c.bm?.known.length).map(([id, c]) => [id, c.bm!.known]));
const out = { seed, hours, layout: 'p10', fog: !!(st as any).fog || !!(st as any).intel, place, after, knownByIntel: known, players, meanTickMs: +((performance.now() - t0) / (hours * 7200)).toFixed(2), worstTickMs: +worst.toFixed(1), saveBytes: sim.serialize().length };
writeFileSync(`docs/blackmarket-results/p10-seed${seed}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
