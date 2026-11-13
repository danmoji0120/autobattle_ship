// Faction economy v2 stabilization: export fill cap default, strategic export floor, modernization gated by
// readiness, pirate (raider) economy: smuggling, raids, salvage — goods move, nothing is created for free.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { factionEcon2Step, rates, FE_TUNING, PROFILES2 } from '../src/world/factionEcon2';
import { startConflict } from '../src/world/factionEcon';
import { P10_FRONTS } from '../src/world/worldgen-p10';
import { qty, type Cargo } from '../src/world/types';
import type { FactionState } from '../src/world/territory';

const host = (sim: WorldSim) => sim as unknown as Parameters<typeof factionEcon2Step>[0];
const cycles = (sim: WorldSim, n: number) => { for (let i = 0; i < n; i++) { factionEcon2Step(host(sim), sim.st); sim.st.time += 60; } };
const sum = (c: Cargo | undefined) => Object.values(c ?? {}).reduce((a, b) => a + (b ?? 0), 0);
function ledgerGap(f: FactionState) {
  const L = f.econ!.led; let worst = 0;
  const keys = new Set([...Object.keys(f.stock), ...Object.keys(L.opening), ...Object.keys(L.extracted), ...Object.keys(L.made), ...Object.keys(L.inputs), ...Object.keys(L.bought), ...Object.keys(L.used), ...Object.keys(L.exported), ...Object.keys(L.seized ?? {}), ...Object.keys(L.salvaged ?? {}), ...Object.keys(L.lost ?? {})]);
  for (const k of keys) {
    const q = (c: Cargo | undefined) => qty(c ?? {}, k);
    const e = q(L.opening) + q(L.extracted) + q(L.made) - q(L.inputs) + q(L.bought) + q(L.seized) + q(L.salvaged) - q(L.used) - q(L.exported) - q(L.lost);
    worst = Math.max(worst, Math.abs(e - qty(f.stock, k)) / Math.max(1, Math.abs(e)));
  }
  return worst;
}
const hostileWorld = () => {
  const sim = WorldSim.create(5, { layout: 'p10', factionEcon: 'v2' });
  const F = sim.st.factions!;
  // pirates hostile to everyone (embargo), every other pair at peace; no war
  for (const f of Object.values(F)) for (const g of Object.keys(f.rel)) f.rel[g] = f.id === 'pirates' || g === 'pirates' ? -90 : 0;
  return sim;
};

describe('faction economy v2 stabilization', () => {
  it('factions fill markets to 60% of target by default (the rest is left to player sellers)', () => {
    expect(FE_TUNING.exportFill).toBe(.6);
  });

  it('modernization waits until the fleet is supplied', () => {
    const sim = WorldSim.create(5, { layout: 'p10', factionEcon: 'v2' });
    const f = sim.st.factions!.union; f.infra = 1e3; f.econ!.eff = 1;
    f.econ!.rdy = 1; expect(sum(rates(sim.st, f).prog.modern)).toBeGreaterThan(0);
    f.econ!.rdy = .6; expect(sum(rates(sim.st, f).prog.modern)).toBe(0);
  });

  it('pirates smuggle through the embargo (they buy in markets of factions hostile to them)', () => {
    const sim = hostileWorld();
    cycles(sim, 60);
    const L = sim.st.factions!.pirates.econ!.led;
    expect(sum(L.imported)).toBeGreaterThan(0);
    for (const f of Object.values(sim.st.factions!)) expect(ledgerGap(f), f.id).toBeLessThan(1e-6);
  });

  it('raids move goods from hostile neighbours to the pirates; nothing is created', () => {
    const sim = hostileWorld();
    const F = sim.st.factions!;
    cycles(sim, 120);
    const seized = F.pirates.econ!.led.seized ?? {};
    expect(sum(seized)).toBeGreaterThan(0);
    // every seized unit is a recorded loss of a neighbour (iron and miners border the pirates)
    const lost: Cargo = {};
    for (const f of Object.values(F)) if (f.id !== 'pirates') for (const [k, n] of Object.entries(f.econ!.led.lost ?? {})) lost[k] = (lost[k] ?? 0) + n!;
    for (const [k, n] of Object.entries(seized)) expect(lost[k] ?? 0).toBeCloseTo(n!, 6);
    expect(Object.values(F).filter(f => f.id !== 'pirates' && sum(f.econ!.led.lost) > 0).every(f => ['iron', 'miners'].includes(f.id))).toBe(true);
    for (const f of Object.values(F)) { expect(ledgerGap(f), f.id).toBeLessThan(1e-6); for (const n of Object.values(f.stock)) expect(n!).toBeGreaterThanOrEqual(0); }
    // raiding is bounded by the pirates' strength: a pirate fleet of strength 0 takes nothing
    const before = sum(F.pirates.econ!.led.seized); F.pirates.strength = 0; cycles(sim, 5);
    expect(sum(F.pirates.econ!.led.seized)).toBeCloseTo(before, 6);
  });

  it('no raids on factions at peace with the pirates', () => {
    const sim = WorldSim.create(5, { layout: 'p10', factionEcon: 'v2' });
    for (const f of Object.values(sim.st.factions!)) for (const g of Object.keys(f.rel)) f.rel[g] = 0;
    cycles(sim, 60);
    expect(sum(sim.st.factions!.pirates.econ!.led.seized)).toBe(0);
  });

  it('pirates salvage wrecks of their fights in proportion to the losses on both sides', () => {
    const sim = hostileWorld();
    const fr = P10_FRONTS.find(x => x.a === 'iron' && x.b === 'pirates')!;
    const c = startConflict(host(sim) as never, sim.st, fr.a, fr.b, fr.edges);
    cycles(sim, 30);
    const lostBoth = (c.lost.iron ?? 0) + (c.lost.pirates ?? 0);
    expect(lostBoth).toBeGreaterThan(0);
    expect(qty(sim.st.factions!.pirates.econ!.led.salvaged ?? {}, 'alloy')).toBeCloseTo(6 * lostBoth, 6);
    expect(PROFILES2.iron.raider).toBeFalsy();
    expect(sum(sim.st.factions!.iron.econ!.led.salvaged)).toBe(0);
  });

  it('the munitions maker keeps exporting armour plate during a war (strategic goods do not stop)', () => {
    const sim = hostileWorld();
    cycles(sim, 60);
    const iron = sim.st.factions!.iron;
    const fr = P10_FRONTS.find(x => x.a === 'iron' && x.b === 'pirates')!;
    startConflict(host(sim) as never, sim.st, fr.a, fr.b, fr.edges);
    const ex0 = qty(iron.econ!.led.exported, 'armor_plate'), made0 = qty(iron.econ!.led.made, 'armor_plate');
    cycles(sim, 120);
    const made = qty(iron.econ!.led.made, 'armor_plate') - made0, ex = qty(iron.econ!.led.exported, 'armor_plate') - ex0;
    expect(made).toBeGreaterThan(0);
    expect(ex).toBeGreaterThan(0);
  });
});
