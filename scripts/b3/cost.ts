// B-3 cost sheet: what the first sovereignty in each system class costs and what holding it costs per hour, read from
// the real data tables (station sizes, facility prices, ship market prices, ship upkeep, the SOV / CLASS rules,
// administration goods at item prices) and the battle-calibrated combat rating (combatRating.ts).
//   npx tsx scripts/b3/cost.ts
import { world, run } from '../../tests/helpers/territory';
import { CLASS, SOV, supplyNeed, regionClass, upkeepOf, powerNeed } from '../../src/world/sovereignty';
import { STATION_SIZES } from '../../src/world/stations';
import { MODULES } from '../../src/world/data';
import { itemPrice } from '../../src/world/industry';
import { shipWorth } from '../../src/world/hullops';
import { shipRate } from '../../src/world/upkeep';
import { rateClass } from '../../src/world/combatRating';
const sim = world(); const A = sim.addPlayer('측정'); run(sim, 60);
const K: [string, string][] = [['frigate', 'patrol'], ['destroyer', 'aa'], ['cruiser', 'multi'], ['cruiser', 'missile'], ['battleship', 'std']];
const P: Record<string, { price: number; up: number; r: number }> = {};
for (const [c, l] of K) {
  const id = sim.spawnShip(A, c, l, sim.newGroup(A, 'x').id, { x: 0, y: 0, z: 0 }); const s = sim.st.ships[typeof id === 'string' ? id : (id as any).id];
  const r = shipRate(sim.st, s);
  P[`${c}/${l}`] = { price: shipWorth(sim.st, s), up: r.credits + Object.entries(r.supplies).reduce((a, [k, n]) => a + n * itemPrice(k), 0), r: rateClass(c, l) };
}
console.log('ship | price | upkeep cr/h | rating | cr per rating | upkeep per rating/h');
for (const [k, v] of Object.entries(P)) console.log(`${k} | ${Math.round(v.price).toLocaleString()} | ${Math.round(v.up)} | ${v.r.toFixed(0)} | ${Math.round(v.price / v.r).toLocaleString()} | ${(v.up / v.r).toFixed(2)}`);
const ex: Record<string, string> = { outer: 'gloam', rich: 'relic', lawless: 'fang', npc_border: 'sunder', npc_core: 'forge', capital: 'helios' };
console.log('\nclass | facilities cr | admin goods cr/h | governance upkeep cr/h | power need | garrison (frigates / cruisers / mixed) price | garrison upkeep/h (frigates / cruisers / mixed) | peace total/h (mixed, in space) | docked-only total/h (mixed) | war ×2 total/h (mixed)');
const mixed = (pn: number) => { // half the rating in cruisers, a quarter AA destroyers, a quarter patrol frigates
  const n = (k: string, share: number) => Math.ceil(pn * share / P[k].r);
  const l: [string, number][] = [['cruiser/multi', n('cruiser/multi', 0.5)], ['destroyer/aa', n('destroyer/aa', 0.25)], ['frigate/patrol', n('frigate/patrol', 0.25)]];
  return { price: l.reduce((a, [k, c]) => a + P[k].price * c, 0), up: l.reduce((a, [k, c]) => a + P[k].up * c, 0) };
};
const one = (k: string, pn: number) => { const n = Math.ceil(pn / P[k].r); return { price: n * P[k].price, up: n * P[k].up }; };
for (const [cls, sys] of Object.entries(ex)) {
  const rule = CLASS[cls as keyof typeof CLASS];
  const mods = ['power', 'power', 'warehouse', 'governance', ...Array(rule.defense).fill('defense')];
  const fac = (STATION_SIZES as any)[rule.station].credits + mods.reduce((a, m) => a + ((MODULES as any)[m]?.credits ?? 0), 0);
  const sup = Object.entries(supplyNeed(regionClass(sim.st, sim.st.systems[sys]))).reduce((a, [k, n]) => a + n * itemPrice(k), 0);
  const gov = upkeepOf(sim, A, sys), pn = powerNeed(sim, A, sys);
  const f = one('frigate/patrol', pn), c = one('cruiser/multi', pn), m = mixed(pn), md = mixed(pn / 0.6), mw = mixed(pn * 2);
  console.log(`${cls} (${sys}) | ${Math.round(fac).toLocaleString()} | ${Math.round(sup).toLocaleString()} | ${gov.toLocaleString()} | ${pn} | ${Math.round(f.price).toLocaleString()} / ${Math.round(c.price).toLocaleString()} / ${Math.round(m.price).toLocaleString()} | ${Math.round(f.up).toLocaleString()} / ${Math.round(c.up).toLocaleString()} / ${Math.round(m.up).toLocaleString()} | ${Math.round(sup + gov + m.up).toLocaleString()} | ${Math.round(sup + gov + md.up).toLocaleString()} | ${Math.round(sup + gov + mw.up).toLocaleString()}`);
}
console.log(`\neconomic bars (outer): assets ${SOV.assets.toLocaleString()} · revenue ${SOV.revenue.toLocaleString()} / ${SOV.revWindowH} h · liquid ${SOV.liquid.toLocaleString()}`);
