// P5: weapon families and tiers, shields, the 13-area research additions, the ammunition and energy
// factories, specialised labs — working in a growth world, absent from a c0 world.
import { describe, it, expect, vi } from 'vitest';
import { addFoundationFreighter } from './helpers/foundation';
vi.setConfig({ testTimeout: 300_000 });
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import type { Station } from '../src/world/types';
import { qty } from '../src/world/types';
import { CONTENT, contentAvail } from '../src/content/registry';
import { variantLayout } from '../src/content/registry';
import { hpAccepts, bayAccepts } from '../src/content/rules';
import { EQUIPMENT, TECHS, FACILITIES, RECIPES, growthFx } from '../src/world/industry';
import { WEAPONS } from '../src/sim/data/weapons';
import { World } from '../src/sim/world';
import type { FleetSpec } from '../src/sim/fleet';
import { shipRate } from '../src/world/upkeep';
import { RESEARCH_AREAS } from '../src/content/schema';
import { validateContent } from '../src/content/validate';

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
  sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: 'P5 기지' } });
  run(sim, 200, 0.5);
  return Object.values(sim.st.stations).find(s => s.owner === p) as Station;
}
const stock = (own: Station, p: string, need: Record<string, number>) => { for (const [k, n] of Object.entries(need)) own.storage[p][k] = (own.storage[p][k] ?? 0) + n; };
const finishResearch = (sim: WorldSim, p: string) => { for (const r of sim.st.companies[p].research ?? []) if (r.started) r.left = 0.5; run(sim, 2); };

describe('P5 content is installed and gated', () => {
  it('weapons, modules, techs, facilities and recipes are in the game tables, marked growth-only', () => {
    for (const a of Object.values(CONTENT.arms)) {
      expect(EQUIPMENT[a.id]?.weapon, a.id).toBe(a.id.slice(3));
      expect(WEAPONS[a.id.slice(3)].family).toBe(a.family);
      expect(RECIPES[a.id].fac).toBe(a.recipe.fac);
      expect(EQUIPMENT[a.id].growth).toBe(true);
      expect(contentAvail(a.id, 0)).toBe(false);
      expect(contentAvail(a.id, 4)).toBe(true);
    }
    for (const k of ['ammo_plant', 'energy_fab', 'lab_power', 'lab_ballistics', 'lab_energy', 'lab_logistics']) expect(FACILITIES[k]?.growth, k).toBe(true);
    // the 13 research areas all have research, and every family has at least two tiers
    const areas = new Set(Object.values(TECHS).map(t => t.area));
    for (const a of RESEARCH_AREAS) expect(areas.has(a), a).toBe(true);
    const fam = new Map<string, Set<number>>();
    for (const w of Object.values(WEAPONS)) if (w.family) (fam.get(w.family) ?? fam.set(w.family, new Set()).get(w.family)!).add(w.tier!);
    for (const f of ['laser', 'coil', 'missile', 'torpedo', 'plasma', 'particle', 'pd', 'cannon']) expect(fam.get(f)?.size ?? 0, f).toBeGreaterThanOrEqual(2);
    expect([...fam.get('laser')!].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(validateContent(CONTENT).filter(i => i.level === 'error')).toEqual([]);
  });

  it('a c0 world refuses P5 research, facilities and recipes; a growth world accepts them', () => {
    const c0 = new WorldSim(newWorld(7), { migrateContent: false }); calm(c0);
    const p0 = c0.addPlayer('구세계');
    const own0 = station(c0, p0);
    give(own0, 'lab_weapons', 'lab_basic', 'power');
    expect(c0.command(p0, { c: 'research', station: own0.id, tech: 'optical_lasers' })).toMatch(/알 수 없는 연구/);
    c0.st.companies[p0].tech = [...(c0.st.companies[p0].tech ?? []), 'optical_lasers', 'missile_fab'];
    expect(c0.command(p0, { c: 'queueModule', station: own0.id, kind: 'energy_fab' })).toMatch(/건설 불가/);
    give(own0, 'ammo_plant');
    expect(c0.command(p0, { c: 'prodOrder', station: own0.id, recipe: 'munitions', mode: 'count', n: 1 })).toMatch(/알 수 없는 레시피/);

    const g = WorldSim.create(7); calm(g);
    const p = g.addPlayer('신세계');
    const own = station(g, p);
    give(own, 'lab_weapons', 'lab_basic', 'power');
    expect(g.command(p, { c: 'research', station: own.id, tech: 'optical_lasers' })).toBeNull();
  });
});

describe('P5 gameplay chain: research → facility → production → fitting → combat effect → save', () => {
  it('works end to end', () => {
    const sim = WorldSim.create(17); calm(sim);
    const p = sim.addPlayer('무장사'); const co = sim.st.companies[p];
    const own = station(sim, p);
    // This pre-equipped industrial fixture needs a medium footprint for its nine facilities;
    // the test exercises the research-to-fitting chain, not the cost of founding a new core.
    own.size = 'M';
    give(own, 'power', 'power', 'lab_weapons', 'lab_basic', 'lab_materials', 'lab_electronics', 'fitting', 'reactor_plant', 'yard_s');
    co.tech = [...(co.tech ?? []), 'fire_control', 'research_methods'];
    stock(own, p, { electronics: 200, crystal: 200, machinery: 100, chemicals: 200, metal: 200, precision: 40, silicon: 100, weapon_parts: 40, alloy: 2000, optics: 0 });
    // research: materials are consumed when it starts; a specialised lab is required for advanced work
    const e0 = qty(own.storage[p], 'electronics');
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'optical_lasers' })).toBeNull();
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'deflector_shields' })).toBeNull();
    run(sim, 2);
    expect(qty(own.storage[p], 'electronics')).toBeLessThan(e0);
    finishResearch(sim, p);
    expect(co.tech).toContain('optical_lasers');
    expect(co.tech).toContain('deflector_shields');
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'uv_lasers' })).toMatch(/선행 연구|전문 연구소/);
    co.tech.push('blue_lasers');
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'uv_lasers' })).toMatch(/전문 연구소/);
    // the research unlocked a facility: build it (materials + time)
    expect(sim.command(p, { c: 'queueModule', station: own.id, kind: 'energy_fab' })).toBeNull();
    const plan = own.modules.find(m => m.kind === 'energy_fab')!;
    plan.progress = 1; plan.built = true;
    // production: optics, then the weapon, from real materials over real time
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'optics', mode: 'count', n: 2 })).toBeNull();
    run(sim, 600);
    expect(qty(own.storage[p], 'optics')).toBeGreaterThanOrEqual(2);
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'eq_laser_red', mode: 'count', n: 1 })).toBeNull();
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'mod_shield', mode: 'count', n: 1 })).toBeNull();
    run(sim, 1500);
    expect(qty(own.storage[p], 'eq_laser_red')).toBeGreaterThanOrEqual(1);
    expect(qty(own.storage[p], 'mod_shield')).toBeGreaterThanOrEqual(1);
    // fitting: a hull with an energy-capable hardpoint and an armour bay
    const hull = Object.values(CONTENT.variants).map(v => ({ v, lay: variantLayout(v.id)! })).find(({ lay }) => lay.hardpoints.some(h => !hpAccepts(h, 'eq_laser_red')) && lay.internals.some(b => !bayAccepts(b, 'mod_shield')))!;
    expect(hull).toBeTruthy();
    const g = sim.newGroup(p, '시험함');
    const s = sim.spawnHull(p, hull.v.hull, hull.v.id, undefined, g.id, own.pos); (sim as any).dockShip(s, own);
    const hp = hull.lay.hardpoints.find(h => !hpAccepts(h, 'eq_laser_red'))!;
    const bay = hull.lay.internals.find(b => !bayAccepts(b, 'mod_shield'))!;
    const nf = { hp: { ...s.fitting!.hp, [hp.id]: 'eq_laser_red' }, bay: { ...s.fitting!.bay, [bay.id]: 'mod_shield' } };
    // free the power the laser and the shield need by emptying other hardpoints if necessary
    let r = sim.command(p, { c: 'fit', ship: s.id, hp: nf.hp, bay: nf.bay });
    if (r && /전력|질량/.test(r)) { for (const k of Object.keys(nf.hp)) if (k !== hp.id) delete nf.hp[k]; r = sim.command(p, { c: 'fit', ship: s.id, hp: nf.hp, bay: nf.bay }); }
    expect(r).toBeNull();
    expect(s.fitting!.hp[hp.id]).toBe('eq_laser_red');
    // combat effects: the shield module gives the ship a shield, the laser is mounted
    const fx = (sim as any).shipFxOf(s);
    expect(fx.shield).toBeCloseTo(0.15, 5);
    const spec = (sim as any).fittingSpec(s);
    expect(spec.mounts.some((m: { weapon: string }) => m.weapon === 'laser_red')).toBe(true);
    // save → load → the same tech, equipment and fitting
    const back = new WorldSim(JSON.parse(sim.serialize()));
    const s2 = back.st.ships[s.id];
    expect(s2.fitting!.hp[hp.id]).toBe('eq_laser_red');
    expect(s2.fitting!.bay[bay.id]).toBe('mod_shield');
    expect(back.st.companies[p].tech).toContain('optical_lasers');
    expect((back as any).shipFxOf(s2).shield).toBeCloseTo(0.15, 5);
    // kinetic weapons burn ammunition: a coilgun adds metal/chemicals to the ship's upkeep
    const before = shipRate(sim.st, s).supplies.metal ?? 0;
    s.fitting!.hp[hp.id] = 'eq_coil_s';
    expect(shipRate(sim.st, s).supplies.metal ?? 0).toBeGreaterThan(before);
    co.tech.push('ammo_logistics');
    const withLog = shipRate(sim.st, s).supplies.metal!;
    expect(withLog).toBeCloseTo(((EQUIPMENT.eq_coil_s.supply!.metal) + before) * 0.8, 5);
  });
});

describe('P5 combat: shields, weapon roles, family research', () => {
  const fleet = (classId: string, loadoutId: string, fx = {}): FleetSpec => ({ name: 'f', root: { name: 'g', order: 'engage', retreatAt: 0, ships: [{ classId, loadoutId, fx }], children: [] } });
  it('shields absorb hits first; energy weapons strip them faster than kinetic ones; they regenerate', () => {
    const w = new World({ seed: 3, scenarioId: 'kestrel', fleets: [fleet('destroyer', 'aa'), fleet('cruiser', 'gun', { shield: 0.2, shieldRegen: 0.02 })] });
    const t = w.ships.find(s => s.team === 1)!;
    expect(t.maxShield).toBeCloseTo(t.maxHp * 0.2, 5);
    const hp0 = t.hp, sh0 = t.shield!;
    const a = w.ships.find(s => s.team === 0)!;
    w.applyHit(t, WEAPONS.laser_blue, a.id, t.pos.clone(), t.fwd.clone(), 'shell');
    expect(t.hp).toBe(hp0);
    expect(sh0 - t.shield!).toBeCloseTo(WEAPONS.laser_blue.damage * WEAPONS.laser_blue.vsShield!, 5);
    const sh1 = t.shield!;
    w.applyHit(t, WEAPONS.coil_s, a.id, t.pos.clone(), t.fwd.clone(), 'shell');
    expect(sh1 - t.shield!).toBeCloseTo(WEAPONS.coil_s.damage * WEAPONS.coil_s.vsShield!, 5);
    // a big hit on a nearly empty shield goes through to the hull
    t.shield = 10;
    w.applyHit(t, WEAPONS.plasma_l, a.id, t.pos.clone(), t.fwd.clone(), 'shell');
    expect(t.shield).toBe(0);
    expect(t.hp).toBeLessThan(hp0);
    // regeneration after 4 s without hits
    const sh2 = t.shield!;
    for (let i = 0; i < 400 && !w.outcome; i++) w.step();
    expect(t.shield!).toBeGreaterThan(sh2);
  });

  it('target preference: anti-small weapons prefer escorts, anti-capital weapons ignore raiders', () => {
    const w = new World({ seed: 3, scenarioId: 'kestrel', fleets: [fleet('destroyer', 'aa'), fleet('corvette', 'gun')] });
    const small = w.ships.find(s => s.team === 1)!;
    const red = w.suitability(WEAPONS.laser_red, small), gamma = w.suitability(WEAPONS.laser_gamma, small);
    expect(red).toBeGreaterThan(gamma);
    // the built-in weapons keep their old preference numbers (c0 battles are unchanged)
    expect(WEAPONS.medium_gun.role).toBeUndefined();
  });

  it('research combat effects: family-scoped damage, global accuracy, shields', () => {
    const g = growthFx([], ['beam_focusing', 'sabot_rounds', 'targeting_ai']);
    expect(g.fam?.laser?.range).toBeCloseTo(1.08, 5);
    expect(g.fam?.coil?.dmg).toBeCloseTo(1.08, 5);
    expect(g.fam?.cannon?.dmg).toBeCloseTo(1.08, 5);
    expect(g.accMul).toBeCloseTo(1.05, 5);
    const sh = growthFx(['mod_shield'], ['shield_harmonics', 'phased_shields']);
    expect(sh.shield).toBeCloseTo(0.15 * 1.15, 5);
    expect(sh.shieldRegen).toBeCloseTo(0.02 * 1.25, 5);
    expect(growthFx(undefined, undefined)).toEqual({});
    // the combat engine applies the family effect to that family's mounts only
    const w = new World({ seed: 4, scenarioId: 'kestrel', fleets: [fleet('destroyer', 'aa', { fam: { cannon: { dmg: 1.5 } } }), fleet('destroyer', 'aa')] });
    const a = w.ships.find(s => s.team === 0)!, b = w.ships.find(s => s.team === 1)!;
    const gun = a.mounts.find(m => m.weapon.family === 'cannon'), gun2 = b.mounts.find(m => m.weapon.id === gun?.weapon.id);
    if (gun && gun2) expect(gun.weapon.damage).toBeCloseTo(gun2.weapon.damage * 1.5, 5);
    const pd = a.mounts.find(m => m.weapon.family === 'pd');
    if (pd) expect(pd.weapon).toBe(WEAPONS[pd.weapon.id]);
  });
});
