// Pirate (raider) recovery check: pirates hostile to all (embargo), strength set to 10, 12 h of direct cycles.
//   npx vite-node scripts/faction/pirates.ts
import { WorldSim } from '../../src/world/sim';
import { factionEcon2Step } from '../../src/world/factionEcon2';
const sim = WorldSim.create(5, { layout: 'p10', factionEcon: 'v2' }); const F = sim.st.factions!;
for (const f of Object.values(F)) for (const g of Object.keys(f.rel)) f.rel[g] = f.id === 'pirates' || g === 'pirates' ? -90 : 0;
F.pirates.strength = 10;
const v = (c: any) => Math.round(Object.values(c ?? {}).reduce((a: number, b: any) => a + b, 0) as number);
for (let h = 1; h <= 12; h++) { for (let i = 0; i < 60; i++) { factionEcon2Step(sim as any, sim.st); sim.st.time += 60; }
  const p = F.pirates, e = p.econ!; console.log(`h${h} pir s${p.strength.toFixed(1)} r${e.rdy.toFixed(2)} e${e.eff.toFixed(2)} b${Math.round(e.budget)} seized ${v(e.led.seized)} built ${e.led.builtStr.toFixed(1)} | iron s${F.iron.strength.toFixed(1)} r${F.iron.econ!.rdy.toFixed(2)} lost ${v(F.iron.econ!.led.lost)} | miners r${F.miners.econ!.rdy.toFixed(2)} e${F.miners.econ!.eff.toFixed(2)} lost ${v(F.miners.econ!.led.lost)}`); }
