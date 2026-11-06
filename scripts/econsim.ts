// Economy simulation (growth P4): a mining operation of N×(4 miners + 1 hauler) left on automatic
// mining + sale for H hours. Reports revenue, running costs, net, what the market absorbed, production
// and payback, at 8 h / 24 h / 72 h checkpoints.
//   npx vite-node scripts/econsim.ts -- <scale=1> <hours=72> <mode=c3|c2> <seed=5> [field=kestrel] [hull=miner_mk1]
// c2 runs the same fleet on the pre-growth economy (no upkeep, old market) as a baseline.
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import { migrateContent } from '../src/world/migrate';
import { hullSale } from '../src/world/hullops';
import { forecast } from '../src/world/upkeep';
import { priceOf } from '../src/world/market';
import { qty } from '../src/world/types';

const args = process.argv.slice(2).filter(a => a !== '--');
const scale = Number(args[0] ?? 1), hours = Number(args[1] ?? 72), mode = args[2] ?? 'c3', seed = Number(args[3] ?? 5);
const field = args[4] ?? 'kestrel';
const minerHull = args[5] ?? 'miner_mk1';
const DT = Number(process.env.ECON_DT ?? 4);
/** 'spread': group k mines the k-th nearest ore field (tests market demand rather than one field's regrowth) */
const SPREAD = ['kestrel', 'still', 'grey', 'barcaring', 'kestrel'];

let sim: WorldSim;
if (mode === 'c2') { const st = newWorld(seed); migrateContent(st, 2); sim = new WorldSim(st, { migrateContent: false }); }
else sim = WorldSim.create(seed);
const p = sim.addPlayer('econsim');
const co = sim.st.companies[p];
// the operation replaces the starter fleet (removed: this is an economic probe, not a playthrough)
for (const s of Object.values(sim.st.ships)) if (s.owner === p) { const g = sim.st.groups[s.groupId]; if (g) g.shipIds = g.shipIds.filter(x => x !== s.id); delete sim.st.ships[s.id]; }
for (const g of Object.values(sim.st.groups)) if (g.owner === p) delete sim.st.groups[g.id];
const home = sim.st.stations[co.homeStation];
let capex = 0;
const groups: string[] = [];
for (let k = 0; k < scale; k++) {
  const g = sim.newGroup(p, `채굴반 ${k + 1}`);
  groups.push(g.id);
  for (let i = 0; i < 4; i++) { const s = sim.spawnHull(p, minerHull, `${minerHull}_std`, undefined, g.id, home.pos); (sim as any).dockShip(s, home); capex += hullSale(minerHull)?.price ?? 0; }
  const h = sim.spawnHull(p, 'hauler_mk1', 'hauler_mk1_std', undefined, g.id, home.pos); (sim as any).dockShip(h, home); capex += hullSale('hauler_mk1')?.price ?? 0;
}
co.credits = 20000;
for (const [k, gid] of groups.entries()) {
  const r = sim.command(p, { c: 'setOp', group: gid, op: { k: 'mine', field: field === 'spread' ? SPREAD[k % SPREAD.length] : field, deliver: '', sell: true, auto: true } });
  if (r) { console.error('setOp failed:', r, field === 'spread' ? SPREAD[k % SPREAD.length] : field); process.exit(1); }
}
const sellAt = (sim.st.groups[groups[0]].op as { deliver: string }).deliver;
console.log('sell stations:', [...new Set(groups.map(g => (sim.st.groups[g].op as { deliver: string }).deliver))].join(', '));
const st = sim.st.stations[sellAt];
const ore0 = { price: priceOf(st.market!.ore, 'sell', mode === 'c3'), stock: st.market!.ore.stock, target: st.market!.ore.target };
console.log(`econsim ${mode} ×${scale} (${scale * 4} ${minerHull} + ${scale} hauler) at ${field} → ${st.name} · ${hours}h · seed ${seed} · fleet value ${capex.toLocaleString()} cr`);
console.log(`ore at start: price ${ore0.price} stock ${Math.round(ore0.stock)}/${ore0.target}${st.funds !== undefined ? ` · station budget ${Math.round(st.funds)}/${st.fundsMax}` : ''}`);

const stored = () => Object.values(sim.st.stations).reduce((a, x) => a + qty(x.storage[p] ?? {}, 'ore') + qty(x.storage[p] ?? {}, 'crystal'), 0);
const cr0 = co.credits;
let last = { t: 0, earned: 0, paid: 0, mined: 0 };
const rows: string[] = [];
const checkpoints = new Set([1, 2, 4, 8, 16, 24, 48, 72, hours]);
const t0 = Date.now();
let minFunds = Infinity;
for (let hr = 1; hr <= hours; hr++) {
  for (let t = 0; t < 3600; t += DT) { sim.update(DT); if (st.funds !== undefined) minFunds = Math.min(minFunds, st.funds); }
  if (!checkpoints.has(hr)) continue;
  const paid = co.upkeep?.total.paid ?? 0, earned = co.stats.earned, mined = co.stats.mined;
  const dh = hr - last.t;
  const ships = Object.values(sim.st.ships).filter(s => s.owner === p);
  const wear = ships.reduce((a, s) => a + (s.wear ?? 0), 0) / Math.max(1, ships.length);
  const f = mode === 'c3' ? forecast(sim.st, co) : null;
  rows.push([
    `${String(hr).padStart(3)}h`,
    `rev ${Math.round(earned).toLocaleString().padStart(10)}`,
    `cost ${Math.round(paid).toLocaleString().padStart(9)}`,
    `net ${Math.round(earned - paid).toLocaleString().padStart(10)}`,
    `net/h(last ${dh}h) ${Math.round(((earned - paid) - (last.earned - last.paid)) / dh).toLocaleString().padStart(7)}`,
    `mined ${Math.round(mined).toLocaleString().padStart(8)} (${Math.round((mined - last.mined) / dh).toLocaleString()}/h)`,
    `ore price ${priceOf(st.market!.ore, 'sell', mode === 'c3').toFixed(1)} stock ${Math.round(st.market!.ore.stock)}`,
    st.funds !== undefined ? `budget ${Math.round(st.funds).toLocaleString()}` : '',
    `stored ${Math.round(stored())}`,
    `wear ${(wear * 100).toFixed(0)}%`,
    f ? `upkeep ${Math.round(f.perHour)}/h stage ${co.upkeep?.stage ?? 0}` : '',
    `cr ${Math.round(co.credits).toLocaleString()}`,
  ].filter(Boolean).join(' · '));
  console.log(rows.at(-1));
  last = { t: hr, earned, paid, mined };
}
const netH = (co.stats.earned - (co.upkeep?.total.paid ?? 0)) / hours;
console.log(`summary ${mode} ×${scale}: net/h ${Math.round(netH)} · net per miner/h ${Math.round(netH / (scale * 4))} · payback ${netH > 0 ? (capex / netH).toFixed(1) + 'h' : '∞'} · min station budget ${Number.isFinite(minFunds) ? Math.round(minFunds) : '-'} · credits ${Math.round(cr0)}→${Math.round(co.credits)} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
