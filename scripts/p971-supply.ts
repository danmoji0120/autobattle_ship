// Physical finite-field simulation, no external services. NPCs/lairs are disabled to isolate throughput.
// Run: npx vite-node scripts/p971-supply.ts [game-seconds] [long|reserves]
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../src/world/sim';
import { cargoSum, qty } from '../src/world/types';
import { hashId, miningSpot } from '../src/world/geom';
import { REGIONAL_FIELDS } from '../src/world/regional';
import { FACILITIES, recipeFor, techFx } from '../src/world/industry';
import { prodSpeed } from '../src/world/production';

const duration = Number(process.argv[2] ?? 1800);
const long = process.argv[3] === 'long';
const reserves = process.argv[3] === 'reserves';
const results: unknown[] = [];
const destinations: Record<string, string> = { anvil: 'p9_anvil_port', shard: 'drakeout', dusk: 'rustport', blackgate: 'drakeout' };
for (const start of (long ? ['depleted'] as const : reserves ? ['full'] as const : ['full', 'depleted'] as const)) for (const miners of (long ? [1] : reserves ? [4] : [1, 2, 4])) {
  const sim = WorldSim.create(97120); (sim as any).npcSlow = () => {}; (sim as any).npcs = () => {};
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  const ops = REGIONAL_FIELDS.map(def => {
    const p = sim.addPlayer(`격리 ${def.sys}`), f = sim.st.fields[def.id];
    sim.st.companies[p].credits = 1_000_000;
    if (reserves) {
      const err = sim.command(p, { c: 'lease', station: destinations[def.sys], blocks: 3 });
      if (err) throw Error(err);
    }
    if (start === 'depleted') f.amount = 0;
    const g = sim.newGroup(p, def.sys), ships = Array.from({ length: miners }, () => {
      const ship = sim.spawnShip(p, 'miner', 'std', g.id, f.pos);
      ship.pos = miningSpot(f, hashId(ship.id) % f.rocks); return ship;
    });
    const error = sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: f.id, deliver: destinations[def.sys], sell: false } });
    if (error) throw Error(error);
    return { def, p, f, g, ships, extracted: 0, firstDepletedAtSeconds: 0 };
  });
  for (let t = 0; t < duration; t++) {
    const before = ops.map(x => x.f.amount);
    sim.update(1);
    ops.forEach((x, i) => { x.extracted += Math.max(0, Math.min(x.f.max, before[i] + x.f.regen) - x.f.amount); if (!x.firstDepletedAtSeconds && x.f.amount < 1) x.firstDepletedAtSeconds = t + 1; });
  }
  for (const { def, p, f, g, ships, extracted, firstDepletedAtSeconds } of ops) {
    const stored = qty(sim.st.stations[destinations[def.sys]].storage[p], def.res);
    const onboard = ships.reduce((n, ship) => n + qty(sim.st.ships[ship.id]?.cargo, def.res), 0);
    results.push({ start, miners, duration, field: def.id, resource: def.res, resourceExtractedApprox: extracted * def.mix[def.res],
      rareStored: stored, rareOnboard: onboard, totalCargoOnboard: ships.reduce((n, s) => n + cargoSum(sim.st.ships[s.id]?.cargo), 0),
      fieldRemaining: f.amount, firstDepletedAtSeconds: start === 'full' ? firstDepletedAtSeconds || null : null, theoreticalRareRegen: def.regen * def.mix[def.res] * duration,
      destination: destinations[def.sys], status: sim.st.groups[g.id]?.status });
  }
  console.log(`${start} ${miners} miners completed`);
}
const sim = WorldSim.create(97121), owner = sim.addPlayer('시설 처리량');
const st = sim.st.stations.astra;
const baselineSpeed = prodSpeed(st, sim.st.companies[owner]);
const processing = ['dense_alloy', 'resonant_optics', 'stabilized_isotope', 'singular_alloy'].map(id => {
  const r = recipeFor(sim.st, id)!;
  return { id, inputs: r.in, outputs: r.out, seconds: r.time, linesPerFacility: FACILITIES[r.fac].lines ?? 1,
    theoreticalBatchesPerDayPerFacilityAtFullPower: (FACILITIES[r.fac].lines ?? 1) * 86400 / r.time };
});
const output = { assumptions: `Real WorldSim mining, same seed, four independent companies, field-side starting positions, starter fleet and fixture capital. NPC raids are disabled; warehouse capacity, routing, cargo, upkeep and station handling stay enabled. ${reserves ? 'Each company leases three warehouse blocks at its destination.' : 'No extra warehouse is leased.'} Resource extraction is reconstructed from field stock plus regeneration in one-second samples; at max stock the cap can create a tiny approximation error. The experiment is not a projection or guarantee of daily supply.`, duration, processing, baselineSpeed, researchMultipliers: { mining: techFx(['mining_lasers', 'deep_core']).mineMul, cargo: techFx(['cargo_compression', 'logistics_ai']).cargoMul, production: techFx(['process_control', 'lean_production']).prodMul }, results };
mkdirSync('artifacts/p971', { recursive: true });
writeFileSync(`artifacts/p971/supply${long ? '-long' : reserves ? '-reserves' : ''}.json`, JSON.stringify(output, null, 2) + '\n');
