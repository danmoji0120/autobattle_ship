import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { Station } from '../src/world/types';
import { qty } from '../src/world/types';
import { HULLS, EQUIPMENT } from '../src/world/industry';
import { buildNeeds } from '../src/world/production';
import { World } from '../src/sim/world';
import { SHIP_CLASSES } from '../src/sim/data/ships';

const run = (sim: WorldSim, seconds: number, dt = 0.25) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };

function base(seed = 31) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('조선사');
  calm(sim);
  sim.st.companies[p].credits = 2_000_000;
  sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' });
  const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
  const a = sim.st.stations.astra.pos;
  sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '조선 기지' } });
  run(sim, 200);
  const own = Object.values(sim.st.stations).find(s => s.owner === p) as Station;
  expect(own.modules.find(m => m.kind === 'core')!.built).toBe(true);
  return { sim, p, own };
}
const give = (own: Station, ...kinds: string[]) => { for (const k of kinds) own.modules.push({ kind: k, progress: 1, built: true, slot: own.modules.length + 1 }); };
const stock = (own: Station, p: string, need: Record<string, number>, times = 1) => { for (const [k, n] of Object.entries(need)) own.storage[p][k] = (own.storage[p][k] ?? 0) + n * times; };
const ships = (sim: WorldSim, p: string, cls: string) => Object.values(sim.st.ships).filter(s => s.owner === p && s.classId === cls);

describe('shipbuilding from parts, yards and fitting', () => {
  it('hull classes span the agreed build times and grow in parts, slots and yard size', () => {
    const order = ['corvette', 'frigate', 'destroyer', 'light_cruiser', 'cruiser', 'battlecruiser', 'battleship', 'dreadnought'];
    for (const id of order) expect(SHIP_CLASSES[id]).toBeTruthy();
    expect(HULLS.corvette.time).toBeGreaterThanOrEqual(20 * 60); expect(HULLS.corvette.time).toBeLessThanOrEqual(30 * 60);
    expect(HULLS.destroyer.time).toBeGreaterThanOrEqual(3600); expect(HULLS.destroyer.time).toBeLessThanOrEqual(7200);
    expect(HULLS.cruiser.time).toBeGreaterThanOrEqual(3 * 3600);
    expect(HULLS.battleship.time).toBeGreaterThanOrEqual(12 * 3600); expect(HULLS.battleship.time).toBeLessThanOrEqual(24 * 3600);
    for (let i = 1; i < order.length; i++) {
      const a = HULLS[order[i - 1]], b = HULLS[order[i]];
      expect(b.time).toBeGreaterThan(a.time); expect(b.yard).toBeGreaterThanOrEqual(a.yard); expect(b.slots).toBeGreaterThanOrEqual(a.slots);
      expect(b.parts.structure).toBeGreaterThan(a.parts.structure);
      expect(SHIP_CLASSES[order[i]].hp).toBeGreaterThan(SHIP_CLASSES[order[i - 1]].hp);
    }
  });

  it('a corvette: registered without parts, waits with the exact shortage, then builds and launches with its fitting', () => {
    const { sim, p, own } = base();
    give(own, 'power', 'yard_s');
    const S = own.storage[p]; for (const k of Object.keys(S)) S[k] = 0;
    const cr = sim.st.companies[p].credits;
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'corvette', loadoutId: 'gun', fit: ['mod_engine'] })).toBeNull();
    expect(sim.st.companies[p].credits).toBe(cr - HULLS.corvette.credits);
    run(sim, 5);
    const b = own.builds![0];
    expect(b.started).toBe(false);
    expect(b.why).toMatch(/부품 부족: .*구조재 16/);
    const need = buildNeeds('corvette', 'gun', ['mod_engine']);
    expect(need.eq_autocannon).toBe(4); expect(need.eq_pd_gun).toBe(1); expect(need.mod_engine).toBe(1);
    stock(own, p, need); S.structure += 5;                    // one spare
    run(sim, 1);
    expect(b.started).toBe(true);
    expect(qty(S, 'structure')).toBe(5);                       // exactly the recipe consumed
    expect(qty(S, 'engine')).toBe(0); expect(qty(S, 'eq_autocannon')).toBe(0);
    const before = ships(sim, p, 'corvette').length;
    run(sim, HULLS.corvette.time - 30);
    expect(ships(sim, p, 'corvette').length).toBe(before);
    run(sim, 60);
    const all = ships(sim, p, 'corvette');
    expect(all.length).toBe(before + 1);
    const nu = all.find(s => s.fit?.includes('mod_engine'))!;
    expect(nu.state).toBe('docked'); expect(nu.loadoutId).toBe('gun');
    expect(own.builds!.length).toBe(0);
  });

  it('yard size and slots: bigger hulls need bigger yards, more yards build in parallel, big yards take small hulls', () => {
    const { sim, p, own } = base();
    give(own, 'power', 'power', 'yard_s', 'yard_s');
    sim.st.companies[p].tech = ['medium_hulls'];
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'destroyer', loadoutId: 'aa' })).toMatch(/중형 이상 조선소/);
    for (let i = 0; i < 3; i++) { stock(own, p, buildNeeds('corvette', 'gun', [])); expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'corvette', loadoutId: 'gun' })).toBeNull(); }
    run(sim, 1);
    expect(own.builds!.filter(b => b.started).length).toBe(2);
    expect(own.builds![2].why).toMatch(/슬롯 사용 중/);
    give(own, 'yard_m', 'hull_works', 'machine_shop');   // growth rev 2: the medium tier's base factories
    run(sim, 1);
    expect(own.builds!.filter(b => b.started).length).toBe(3);      // the medium yard took a corvette
    stock(own, p, buildNeeds('destroyer', 'aa', []));
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'destroyer', loadoutId: 'aa' })).toBeNull();
    run(sim, 1);
    expect(own.builds![3].why).toMatch(/슬롯 사용 중/);             // the only medium yard is busy
  });

  it('designs need research; cancel refunds in full before the keel, partially after (parts are not returned)', () => {
    const { sim, p, own } = base();
    give(own, 'power', 'yard_s');
    // c3: a design needs its blueprint (production right) and, separately, the research
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'frigate', loadoutId: 'patrol' })).toMatch(/설계도 필요/);
    sim.st.companies[p].blueprints!.bp_frigate_mk1 = { src: 'test', t: 0 };
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'frigate', loadoutId: 'patrol' })).toMatch(/연구 필요/);
    const cr0 = sim.st.companies[p].credits, paid = () => sim.st.companies[p].upkeep?.total.paid ?? 0, paid0 = paid();
    sim.command(p, { c: 'buildShip', station: own.id, classId: 'corvette', loadoutId: 'gun' });
    expect(sim.command(p, { c: 'buildOp', station: own.id, build: own.builds![0].id, op: 'cancel' })).toBeNull();
    expect(sim.st.companies[p].credits).toBe(cr0);
    stock(own, p, buildNeeds('corvette', 'gun', []));
    sim.command(p, { c: 'buildShip', station: own.id, classId: 'corvette', loadoutId: 'gun' });
    run(sim, HULLS.corvette.time / 2);
    const b = own.builds![0];
    expect(sim.command(p, { c: 'buildOp', station: own.id, build: b.id, op: 'cancel' })).toBeNull();
    expect(sim.st.companies[p].credits).toBeCloseTo(cr0 - HULLS.corvette.credits * 0.5 - (paid() - paid0), -2);
    expect(qty(own.storage[p], 'structure')).toBe(0);
  });

  it('own facilities never sell finished ships for credits; public yards still sell complete hulls', () => {
    const { sim, p, own } = base();
    give(own, 'yard_s');
    expect(sim.command(p, { c: 'buyShip', station: own.id, classId: 'corvette', loadoutId: 'gun' })).toMatch(/직접 건조/);
    expect(sim.st.stations.helios.services.shipyard).toContain('light_cruiser');
    sim.st.companies[p].rep = 50;
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'frigate', loadoutId: 'aa' })).toBeNull();
  });

  it('fitting moves modules between ship and storage all-or-nothing, within the hull slots', () => {
    const { sim, p, own } = base();
    give(own, 'fitting');
    const guard = Object.values(sim.st.groups).find(g => g.owner === p && g.name === '경비대')!;
    sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'dock', station: own.id } });
    run(sim, 300);
    const cv = ships(sim, p, 'corvette').find(s => s.task.k === 'docked' && (s.task as any).station === own.id)!;
    expect(cv).toBeTruthy();
    const S = own.storage[p]; S.mod_armor = 1; S.mod_ecm = 1; S.mod_engine = 1;
    expect(sim.command(p, { c: 'fitShip', ship: cv.id, fit: ['mod_armor', 'mod_engine'] })).toMatch(/적재 초과/);  // legacy: 2 + 1 units > 2 slots; V2: over the mass limit
    expect(sim.command(p, { c: 'fitShip', ship: cv.id, fit: ['mod_ecm', 'mod_engine'] })).toBeNull();
    expect(cv.fit).toEqual(['mod_ecm', 'mod_engine']);
    expect(qty(S, 'mod_ecm')).toBe(0); expect(qty(S, 'mod_engine')).toBe(0);
    expect(sim.command(p, { c: 'fitShip', ship: cv.id, fit: ['mod_engine', 'mod_engine'] })).toMatch(/부족/);
    expect(cv.fit).toEqual(['mod_ecm', 'mod_engine']);            // nothing changed on failure
    expect(sim.command(p, { c: 'fitShip', ship: cv.id, fit: [] })).toBeNull();
    expect(qty(S, 'mod_ecm')).toBe(1); expect(qty(S, 'mod_engine')).toBe(1);
    // weapons swap at an own facility uses equipment items and returns the old ones
    S.eq_torpedo = 1;
    expect(sim.command(p, { c: 'refit', ship: cv.id, loadoutId: 'torp' })).toBeNull();
    expect(cv.loadoutId).toBe('torp');
    expect(qty(S, 'eq_torpedo')).toBe(0); expect(qty(S, 'eq_autocannon')).toBe(2);
  });

  it('fitted modules change the tactical ship (hp, armour, speed, accuracy, range, evasion)', () => {
    const fx = { hpMul: 1.1, armorMul: 1.25, speedMul: 1.2, accMul: 1.2, rangeMul: 1.1, evasion: 0.18, reloadMul: 0.88 };
    const g = (name: string, f?: any) => ({ name, root: { name, commanderId: null, order: 'engage', retreatAt: 0, ships: [{ classId: 'cruiser', loadoutId: 'gun', fx: f }], children: [] } });
    const mk = (f?: any) => new World({ seed: 3, scenarioId: 'test', fleets: [g('A', f), g('B')] } as any);
    const a = mk().ships[0], b = mk(fx).ships[0];
    expect(b.maxHp).toBeCloseTo(a.maxHp * 1.1, 6);
    expect(b.armor.front).toBeCloseTo(a.armor.front * 1.25, 6);
    expect(b.maxSpeed).toBeCloseTo(a.maxSpeed * 1.2, 6);
    expect(b.gunnery).toBeCloseTo(a.gunnery * 1.2, 6);
    expect(b.mounts[0].weapon.range).toBeCloseTo(a.mounts[0].weapon.range * 1.1, 6);
    expect(b.mounts[0].weapon.reload).toBeCloseTo(a.mounts[0].weapon.reload * 0.88, 6);
    expect(b.evasion).toBe(0.18);
  });

  it('builds survive a restart and finish identically', () => {
    const { sim, p, own } = base();
    give(own, 'power', 'yard_s');
    stock(own, p, buildNeeds('corvette', 'gun', []));
    sim.command(p, { c: 'buildShip', station: own.id, classId: 'corvette', loadoutId: 'gun' });
    run(sim, 600);
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    expect(sim2.st.stations[own.id].builds).toEqual(own.builds);
    run(sim, HULLS.corvette.time); run(sim2, HULLS.corvette.time);
    expect(ships(sim2, p, 'corvette').length).toBe(ships(sim, p, 'corvette').length);
    expect(Object.keys(EQUIPMENT).length).toBeGreaterThan(15);
  });
});
