// A-1: the integrated standard world (world/worldPreset.ts) — one creation rule for a server's first start and an
// operator reset, with every developed system on at once.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { GameServer } from '../src/server/core';
import { STANDARD_WORLD, newWorldOptions, worldRules } from '../src/world/worldPreset';

const ALL_ON = { layout: 'p10', systems: 40, factions: 6, factionEcon: true, combat: true, ops: true, logistics: true, salvage: true, piracy: true, blackMarket: true, law: true, rep: true, derelicts: true, officers: true, military: true, econChain: false };

describe('A-1 standard world preset', () => {
  it('a standard world runs every integrated system', () => {
    const sim = WorldSim.create(7, newWorldOptions({ worldPreset: 'standard' }));
    expect(worldRules(sim.st)).toEqual(ALL_ON);
  });

  it('the standard preset ignores the per-system flags', () => {
    expect(newWorldOptions({ worldPreset: 'standard', econNew: true, combatNew: false })).toEqual({ ...STANDARD_WORLD });
  });

  it('legacy (and unset) keeps the old opt-in behaviour', () => {
    expect(newWorldOptions({})).toEqual({});
    expect(newWorldOptions({ worldPreset: 'legacy', lawNew: true, repNew: true })).toEqual({ law: 'p134', rep: 'p14' });
    const g = new GameServer(null, { singleplayer: false, deferExclusiveGrant: true, analytics: { enabled: false } } as any, 5);
    expect(worldRules(g.sim.st).layout).toBe('p9');
    expect(worldRules(g.sim.st).law).toBe(false);
  });

  it('a first start and an operator reset build the same world', () => {
    const flags = { worldPreset: 'standard' as const, combatNew: true };
    const start = new GameServer(null, { singleplayer: false, deferExclusiveGrant: true, analytics: { enabled: false }, ...flags } as any, 11);
    const reset = WorldSim.create(11, newWorldOptions(flags));
    expect(worldRules(start.sim.st)).toEqual(ALL_ON);
    expect(worldRules(reset.st)).toEqual(ALL_ON);
    const strip = (s: string) => { const w = JSON.parse(s); for (const c of Object.values<any>(w.companies)) delete c.online; return w; };
    expect(strip(start.sim.serialize())).toEqual(strip(reset.serialize()));
  });

  it('a new company starts normally and the world keeps its rules through save and restore', () => {
    const sim = WorldSim.create(3, { ...STANDARD_WORLD });
    const a = sim.addPlayer('A'), b = sim.addPlayer('B');
    const terms = sim.starterTerms();
    expect(terms.station).toBe(sim.st.stations.astra.name);
    for (const id of [a, b]) {
      const c = sim.st.companies[id];
      expect(c.credits).toBe(terms.credits);
      expect(c.homeStation).toBe('astra');
      expect(Object.values(sim.st.ships).some(s => s.owner === id)).toBe(true);
    }
    // 15 game-minutes (a 1-s step of a P10 world with every system costs ~10-15 ms; under a loaded CI this stays well
    // inside the timeout below)
    for (let i = 0; i < 900; i++) sim.update(1);
    for (const c of Object.values(sim.st.companies)) expect(Number.isFinite(c.credits)).toBe(true);
    const s1 = sim.serialize();
    const back = new WorldSim(JSON.parse(s1));
    expect(worldRules(back.st)).toEqual(ALL_ON);
    expect(back.serialize()).toBe(s1);
  }, 180000);
});
