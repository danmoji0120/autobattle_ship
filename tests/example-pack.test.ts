// P7 stage 5: the example content pack (src/content/packs/example) goes through the whole pipeline a
// Codex-made pack must survive — validator → game tables/UI lists → research unlock → production →
// fitting → combat effect → save/reload. Kept as the regression test the guide (§13) points to.
import { describe, it, expect, vi } from 'vitest';
import { addFoundationFreighter } from './helpers/foundation';
vi.setConfig({ testTimeout: 300_000 });
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import type { Station } from '../src/world/types';
import { qty } from '../src/world/types';
import { CONTENT, contentAvail, buildRegistry, variantLayout } from '../src/content/registry';
import { hpAccepts } from '../src/content/rules';
import { EQUIPMENT, TECHS, RECIPES } from '../src/world/industry';
import { WEAPONS } from '../src/sim/data/weapons';
import { World } from '../src/sim/world';
import type { FleetSpec, ShipSpec } from '../src/sim/fleet';
import { validateContent } from '../src/content/validate';
import { EXAMPLE_PACK } from '../src/content/packs/example';
import { PACKS } from '../src/content/packs';

const run = (sim: WorldSim, seconds: number, dt = 1) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };
const give = (own: Station, ...kinds: string[]) => { for (const k of kinds) own.modules.push({ kind: k, progress: 1, built: true, slot: own.modules.length + 1 }); };
function station(sim: WorldSim, p: string) {
  sim.st.companies[p].credits = 5_000_000;
  sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' });
  const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
  const a = sim.st.stations.astra.pos;
  expect(sim.command(p, { c: 'buy', station: 'astra', res: 'alloy', amount: 300 })).toBeNull(); // buy locally before loading the constructor
  addFoundationFreighter(sim, p, cg.id);
  sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '예제 기지' } });
  run(sim, 200, 0.5);
  return Object.values(sim.st.stations).find(s => s.owner === p) as Station;
}

describe('example content pack (guide §13)', () => {
  it('passes the validator, alone on top of its dependencies and in the full registry', () => {
    expect(PACKS).toContain(EXAMPLE_PACK);
    expect(validateContent(CONTENT).filter(i => i.level === 'error')).toEqual([]);
    expect(validateContent(CONTENT).filter(i => /twin/.test(i.msg))).toEqual([]);
    // the same pack with a broken reference is caught: an unknown prerequisite, an unknown facility
    const bad = { ...EXAMPLE_PACK, techs: [{ ...EXAMPLE_PACK.techs![0], pre: ['optical_laser'] }], arms: [{ ...EXAMPLE_PACK.arms![0], recipe: { ...EXAMPLE_PACK.arms![0].recipe, fac: 'laser_plant' } }] };
    const errs = validateContent(buildRegistry([...PACKS.filter(p => p !== EXAMPLE_PACK), bad])).filter(i => i.level === 'error').map(i => i.msg).join('\n');
    expect(errs).toMatch(/optical_laser/);
    expect(errs).toMatch(/laser_plant/);
  });

  it('is in the game tables, growth-only, and hidden from a legacy world', () => {
    expect(EQUIPMENT.eq_laser_twin).toMatchObject({ weapon: 'laser_twin', growth: true });
    expect(WEAPONS.laser_twin).toMatchObject({ family: 'laser', tier: 2, role: 'anti-small' });
    expect(TECHS.twin_emitters).toMatchObject({ area: 'energy', pre: ['optical_lasers'], growth: true });
    expect(RECIPES.eq_laser_twin).toMatchObject({ fac: 'energy_fab', out: { eq_laser_twin: 1 } });
    expect(contentAvail('eq_laser_twin', 0)).toBe(false);
    expect(contentAvail('eq_laser_twin', 4)).toBe(true);
    const c0 = new WorldSim(newWorld(7), { migrateContent: false }); calm(c0);
    const q = c0.addPlayer('구세계'); const own = station(c0, q);
    give(own, 'power', 'lab_weapons'); c0.st.companies[q].tech!.push('optical_lasers');
    expect(c0.command(q, { c: 'research', station: own.id, tech: 'twin_emitters' })).not.toBeNull();
    // the energy-turret structure it needs on small hulls is growth-only too
    expect(contentAvail('corvette_mk1_laser', 0)).toBe(false);
    // builds and refits name the structure through hullChoice / applyFitting: both refuse it here
    expect((c0 as any).hullChoice({ c: 'buildShip', station: own.id, classId: 'corvette', loadoutId: '', hull: 'corvette_mk1', variant: 'corvette_mk1_laser' })).toMatch(/사용할 수 없는 구조/);
    const g0 = c0.newGroup(q, '구'); const s0 = c0.spawnHull(q, 'corvette_mk1', 'corvette_mk1_std', undefined, g0.id, own.pos); (c0 as any).dockShip(s0, own);
    if (s0.fitting) expect(c0.command(q, { c: 'fit', ship: s0.id, variant: 'corvette_mk1_laser', hp: {}, bay: s0.fitting.bay })).toMatch(/사용할 수 없는 구조/);
  });

  it('research → production → fitting → combat → save/reload', () => {
    const sim = WorldSim.create(23); calm(sim);
    const p = sim.addPlayer('예제사'); const co = sim.st.companies[p];
    const own = station(sim, p);
    give(own, 'power', 'power', 'lab_weapons', 'lab_basic', 'fitting', 'energy_fab');
    for (const [k, n] of Object.entries({ electronics: 100, crystal: 60, precision: 10, silicon: 40, weapon_parts: 10, optics: 0 })) own.storage[p][k] = (own.storage[p][k] ?? 0) + n;
    // the prerequisite gates it
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'twin_emitters' })).toMatch(/선행/);
    co.tech = [...(co.tech ?? []), 'optical_lasers'];
    // the weapon recipe is locked until the research is done
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'eq_laser_twin', mode: 'count', n: 1 })).not.toBeNull();
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'twin_emitters' })).toBeNull();
    run(sim, 2);
    for (const r of co.research ?? []) if (r.started) r.left = 0.5;
    run(sim, 2);
    expect(co.tech).toContain('twin_emitters');
    // production from real goods over real time
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'optics', mode: 'count', n: 1 })).toBeNull();
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'eq_laser_twin', mode: 'count', n: 1 })).toBeNull();
    const e0 = qty(own.storage[p], 'electronics');
    run(sim, 300);
    expect(qty(own.storage[p], 'eq_laser_twin')).toBe(0);                 // 480 s of work: not yet
    run(sim, 900);
    expect(qty(own.storage[p], 'eq_laser_twin')).toBe(1);
    expect(qty(own.storage[p], 'electronics')).toBeLessThanOrEqual(e0 - 2);
    // fit it to a corvette refitted to the energy-turret structure (needs the laser research)
    const v = 'corvette_mk1_laser'; const lay = variantLayout(v)!;
    const hp = lay.hardpoints.find(h => !hpAccepts(h, 'eq_laser_twin'))!;
    expect(hp).toBeTruthy();
    expect(hpAccepts(variantLayout('corvette_mk1_std')!.hardpoints.find(h => h.id === 'hp02')!, 'eq_laser_twin')).toMatch(/에너지 무장 불가/);
    const g = sim.newGroup(p, '시험 초계'); const s = sim.spawnHull(p, 'corvette_mk1', 'corvette_mk1_std', undefined, g.id, own.pos); (sim as any).dockShip(s, own);
    const nf: Record<string, string> = { ...s.fitting!.hp, [hp.id]: 'eq_laser_twin' }; delete nf.hp02; delete nf.hp03;
    expect(sim.command(p, { c: 'fit', ship: s.id, variant: v, hp: nf, bay: s.fitting!.bay })).toBeNull();
    expect(s.variant).toBe(v);
    expect(qty(own.storage[p], 'eq_laser_twin')).toBe(0);
    const fit = (sim as any).fittingSpec(s) as ShipSpec['fit'];
    expect(fit!.mounts.some(m => m.weapon === 'laser_twin')).toBe(true);
    // its numbers act in battle: it fires and its hits land with its damage
    const A: FleetSpec = { name: 'a', root: { name: 'a', order: 'engage', retreatAt: 0, ships: [{ classId: 'corvette', loadoutId: 'gun', fit }], children: [] } };
    const B: FleetSpec = { name: 'b', root: { name: 'b', order: 'engage', retreatAt: 0, ships: [{ classId: 'corvette', loadoutId: 'gun' }], children: [] } };
    const w = new World({ seed: 5, scenarioId: 'kestrel', fleets: [A, B] });
    let fired = 0, hit = 0;
    for (let i = 0; i < 20000 && !(fired && hit); i++) {
      w.step();
      for (const e of w.events.splice(0)) {
        if (e.t === 'fire' && e.weapon === 'laser_twin') fired++;
        if (e.t === 'hit' && e.weapon === 'laser_twin' && e.dmg > 0) hit++;
      }
    }
    expect(fired).toBeGreaterThan(0);
    expect(hit).toBeGreaterThan(0);
    // save → reload: research, fitting and the weapon all survive
    const back = new WorldSim(JSON.parse(sim.serialize()));
    expect(back.st.companies[p].tech).toContain('twin_emitters');
    expect(back.st.ships[s.id].fitting!.hp[hp.id]).toBe('eq_laser_twin');
    expect(back.st.ships[s.id].variant).toBe(v);
    expect(((back as any).fittingSpec(back.st.ships[s.id]) as ShipSpec['fit'])!.mounts.some(m => m.weapon === 'laser_twin')).toBe(true);
  });
});
