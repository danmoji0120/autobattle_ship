// Quick calibration print of the v2 faction economy (no player companies).
//   npx vite-node scripts/faction/calibrate.ts -- <hours> <seed> [chain]
import { WorldSim } from '../../src/world/sim';
import { ITEMS } from '../../src/world/industry';
import type { Cargo } from '../../src/world/types';
const [hours = 6, seed = 5] = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const chain = process.argv.includes('chain');
const sim = WorldSim.create(seed, { layout: 'p10', factionEcon: 'v2', ...(chain ? { econ: 'chain' as const } : {}) });
const val = (c: Cargo) => Object.entries(c).reduce((n, [k, v]) => n + (v ?? 0) * (ITEMS[k]?.price ?? 50), 0);
const snap = () => JSON.parse(JSON.stringify(Object.fromEntries(Object.values(sim.st.factions!).map(f => [f.id, { s: f.strength, i: f.infra, e: f.econ }]))));
let prev = snap();
const t0 = performance.now();
for (let h = 1; h <= hours; h++) {
  for (let i = 0; i < 3600; i++) sim.tick(1);
  const cur = snap();
  const rows: string[] = [];
  for (const [id, c] of Object.entries<any>(cur)) {
    const p = prev[id], L = c.e.led, P = p.e.led;
    const d = (k: string) => { const o: Cargo = {}; for (const [i, n] of Object.entries<number>(L[k])) o[i] = n - (P[k][i] ?? 0); return o; };
    const used = d('used'), bought = d('bought'), short = d('short'), made = d('made'), ext = d('extracted'), exp = d('exported'), imp = d('imported');
    const top = (c: Cargo) => Object.entries(c).filter(([, n]) => n > .5).sort((a, b) => b[1] * (ITEMS[b[0]]?.price ?? 50) - a[1] * (ITEMS[a[0]]?.price ?? 50)).slice(0, 3).map(([k, n]) => `${k}:${Math.round(n)}`).join(' ');
    rows.push(`${id.padEnd(7)} str ${c.s.toFixed(0).padStart(3)} inf ${c.i.toFixed(0).padStart(3)} dev ${c.e.dev.toFixed(2)} eff ${c.e.eff.toFixed(2)} rdy ${c.e.rdy.toFixed(2)} bud ${Math.round(c.e.budget / 1000)}k | inc ${Math.round((L.income - P.income) / 1000)}k exp$ ${Math.round((L.exportRev - P.exportRev) / 1000)}k spent ${Math.round((L.spent - P.spent) / 1000)}k | used ${Math.round(val(used) / 1000)}k prod ${Math.round((val(made) + val(ext)) / 1000)}k bought ${Math.round(val(bought) / 1000)}k (imp ${Math.round(val(imp) / 1000)}k) exported ${Math.round(val(exp) / 1000)}k short ${Math.round(val(short) / 1000)}k [${top(short)}] buys[${top(bought)}]`);
  }
  const war = Object.values(sim.st.conflicts ?? {}).filter(c => !c.ended).map(c => `${c.a}-${c.b}`).join(',');
  console.log(`--- h${h} ${((performance.now() - t0) / h / 3600).toFixed(2)} ms/tick war[${war}]`); console.log(rows.join('\n'));
  prev = cur;
}
