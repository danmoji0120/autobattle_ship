// B-3 cost sheet: what the first sovereignty in each system class costs, read from the real data tables
// (station sizes, facility prices, ship market prices, the SOV / CLASS rules, supply needs at item prices).
import { world, run } from '../../tests/helpers/territory';
import { CLASS, SOV, supplyNeed, regionClass, upkeepOf, powerNeed } from '../../src/world/sovereignty';
import { STATION_SIZES } from '../../src/world/stations';
import { MODULES, shipValue } from '../../src/world/data';
import { itemPrice } from '../../src/world/industry';
import { shipWorth } from '../../src/world/hullops';
import { SHIP_CLASSES } from '../../src/sim/data/ships';
const sim = world(); const A = sim.addPlayer('측정'); run(sim, 60);
const price = (c: string) => { const id = sim.spawnShip(A, c, SHIP_CLASSES[c].loadouts[0].id, sim.newGroup(A, 'x').id, { x: 0, y: 0, z: 0 }); const s = sim.st.ships[typeof id === 'string' ? id : (id as any).id]; return shipWorth(sim.st, s); };
const P: Record<string, number> = {}; for (const c of ['frigate', 'destroyer', 'cruiser']) P[c] = price(c);
console.log('ship price / value:', Object.entries(P).map(([c, p]) => `${c} ${Math.round(p)} / ${shipValue(c)} = ${Math.round(p / shipValue(c))} cr per point`).join(' · '));
const ex: Record<string, string> = { outer: 'gloam', rich: 'relic', lawless: 'fang', npc_border: 'sunder', npc_core: 'forge', capital: 'helios' };
console.log('class | station+facilities | supply cr/h | upkeep cr/h | power need | fleet (cruisers / frigates) cr | assets bar | revenue bar 12h | liquid bar');
for (const [cls, sys] of Object.entries(ex)) {
  const rule = CLASS[cls as keyof typeof CLASS];
  const mods = ['power', 'power', 'warehouse', 'governance', ...Array(rule.defense).fill('defense')];
  const fac = (STATION_SIZES as any)[rule.station].credits + mods.reduce((a, m) => a + ((MODULES as any)[m]?.credits ?? 0), 0);
  const sup = Object.entries(supplyNeed(regionClass(sim.st, sim.st.systems[sys]))).reduce((a, [k, n]) => a + n * itemPrice(k), 0);
  const pn = powerNeed(sim, A, sys);
  const cru = Math.ceil(pn / shipValue('cruiser')) * P.cruiser, fri = Math.ceil(pn / shipValue('frigate')) * P.frigate;
  console.log(`${cls} (${sys}) | ${Math.round(fac).toLocaleString()} | ${Math.round(sup).toLocaleString()} | ${upkeepOf(sim, A, sys).toLocaleString()} | ${Math.round(pn)} | ${Math.round(cru).toLocaleString()} / ${Math.round(fri).toLocaleString()} | ${(SOV.assets * rule.mult).toLocaleString()} | ${(SOV.revenue * rule.mult).toLocaleString()} | ${(SOV.liquid * rule.mult).toLocaleString()} | stab ${rule.stabH}h`);
}
// fleet upkeep per hour (upkeep.ts shipRate: credits + supplies at item price) of the garrisons that meet the requirement
import { shipRate } from '../../src/world/upkeep';
const rate = (c: string) => { const s = Object.values(sim.st.ships).find(x => x.owner === A && x.classId === c)!; const r = shipRate(sim.st, s); return r.credits + Object.entries(r.supplies).reduce((a, [k, n]) => a + n * itemPrice(k), 0); };
const R: Record<string, number> = {}; for (const c of Object.keys(P)) R[c] = rate(c);
console.log('ship upkeep cr/h:', Object.entries(R).map(([c, v]) => `${c} ${Math.round(v)}`).join(' · '));
for (const [cls, sys] of Object.entries(ex)) {
  const pn = powerNeed(sim, A, sys);
  console.log(`${cls}: garrison upkeep/h cruisers ${Math.round(Math.ceil(pn / shipValue('cruiser')) * R.cruiser).toLocaleString()} · frigates ${Math.round(Math.ceil(pn / shipValue('frigate')) * R.frigate).toLocaleString()}`);
}
