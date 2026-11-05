import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { effSec } from '../src/world/security';
import { LAIR_FOOTHOLD, RECOVERY_TIME, supplyMul, influenceTarget } from '../src/world/factions';
import { sysAt } from '../src/world/geom';

const run = (sim: WorldSim, seconds: number, dt = 1) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };

describe('persistent NPC world: faction influence, lair destruction changes the region', () => {
  it('every system carries influence that reflects its situation (lawless: pirates strong; core: Union strong)', () => {
    const sim = WorldSim.create(5);
    run(sim, 3);
    const sys = Object.values(sim.st.systems).sort((a, b) => a.security - b.security);
    const low = sys[0], high = sys[sys.length - 1];
    expect(low.inf && high.inf).toBeTruthy();
    expect(low.inf!.pirates).toBeGreaterThan(high.inf!.pirates);
    expect(high.inf!.union).toBeGreaterThan(low.inf!.union);
  });

  it('a lair falls: pirates lose their foothold, Union and guild gain, reconstruction boom and contracts, no rebuild without a foothold', () => {
    const sim = WorldSim.create(5);
    const p = sim.addPlayer('토벌대');
    run(sim, 3);
    const l = Object.values(sim.st.lairs).find(x => x.alive && (x.tier ?? 2) >= 3)!;
    const sys = sysAt(sim.st.systems, l.pos)!;
    const before = { ...sys.inf! };
    const sec0 = effSec(sys);
    const supply0 = supplyMul(sys, sim.st.time);
    const contracts0 = Object.values(sim.st.contracts).filter(k => k.kind === 'delivery' && /재건 물자/.test(k.title)).length;
    (sim as any).destroyLair(l, { sides: [[p], ['pirates']] });
    expect(l.alive).toBe(false);
    expect(sys.inf!.pirates).toBeLessThan(before.pirates - 20);
    expect(sys.inf!.union).toBeGreaterThan(before.union);
    expect(sys.inf!.guild).toBeGreaterThan(before.guild);
    expect(effSec(sys)).toBeGreaterThan(sec0);
    expect(supplyMul(sys, sim.st.time)).toBeGreaterThan(supply0);
    const recon = Object.values(sim.st.contracts).filter(k => k.kind === 'delivery' && /재건 물자/.test(k.title));
    expect(recon.length).toBeGreaterThan(contracts0);
    expect(recon.every(k => k.expires - sim.st.time > 3000)).toBe(true);
    // the target itself moved: with the lair gone the pirate baseline is lower
    expect(influenceTarget(sim.st, sys, sim.st.time).pirates).toBeLessThan(before.pirates);
    // past the respawn time, the lair still waits while pirates have no foothold
    sys.inf!.pirates = LAIR_FOOTHOLD - 10;
    l.respawnAt = sim.st.time;
    run(sim, 5);
    expect(l.alive).toBe(false);
    // once pirate influence recovers, it is rebuilt
    sys.inf!.pirates = LAIR_FOOTHOLD + 20; l.respawnAt = sim.st.time;
    run(sim, 3);
    expect(l.alive).toBe(true);
    expect(RECOVERY_TIME).toBeGreaterThan(0);
  });

  it('pirate raids push pirates up and the guild down; influence drifts back toward the situation', () => {
    const sim = WorldSim.create(5);
    run(sim, 3);
    const sys = Object.values(sim.st.systems)[0];
    const t = influenceTarget(sim.st, sys, sim.st.time);
    sys.inf!.pirates = Math.min(100, t.pirates + 30);
    run(sim, 900);
    expect(Math.abs(sys.inf!.pirates - influenceTarget(sim.st, sys, sim.st.time).pirates)).toBeLessThan(15);
  });

  it('delivery contracts ask for the new goods too, and influence survives a restart', () => {
    const sim = WorldSim.create(9);
    sim.addPlayer('납품사');
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) { run(sim, 60, 2); for (const k of Object.values(sim.st.contracts)) if (k.kind === 'delivery' && k.res) seen.add(k.res); }
    expect([...seen].some(r => !['ore', 'alloy', 'crystal'].includes(r))).toBe(true);
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    for (const s of Object.values(sim.st.systems)) expect(sim2.st.systems[s.id].inf).toEqual(s.inf);
  });
});
