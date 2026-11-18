// P16.4 (verification only — the preview gate stays closed): a carrier injected into a test world copy is sunk
// in a real P11 battle, and its battlefield wreck carries its strike-craft gear like any other fitted equipment.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { V, WShip, WGroup } from '../src/world/types';
import { makeWrecks } from '../src/world/wrecks';
import { EQUIPMENT } from '../src/world/industry';
import { CARRIER_HULL, DAWN_STD_WEAPONS } from '../src/content/packs/growth/carrier';
import { gearReleased } from '../src/content/registry';

const WING = ['eq_wing_fighter', 'eq_wing_torpedo', 'eq_wing_interceptor'];

function fixture(seed = 164) {
  const sim = WorldSim.create(seed, { salvage: 'p131' });
  const [A, B] = ['항모 시험 PMC', '공격 PMC'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  const a = sim.st.stations.astra;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: [string, string][]): WGroup {
  const g = f.sim.newGroup(owner, '편대');
  g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach(([cl, lo], i) => f.sim.spawnShip(owner, cl, lo, g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
/** the carrier as a fitted content ship (standard air group preset on the Dawn hull) */
function fitCarrier(s: WShip) {
  s.hull = CARRIER_HULL; s.variant = 'carrier_dawn_std';
  s.fitting = { hp: { ...DAWN_STD_WEAPONS }, bay: {} } as WShip['fitting'];
}
const until = (sim: WorldSim, cond: () => boolean, seconds = 2400) => { for (let t = 0; t < seconds && !cond(); t += .5) sim.update(.5); return cond(); };

describe('P16.4 carrier wreck (test world copy, gate closed)', () => {
  it('the gate is still closed: carrier gear is not released', () => {
    expect(gearReleased('eq_wing_fighter')).toBe(false);
  });

  it('a carrier sunk in a real battle leaves a wreck; equipment lots come only from its real fit', () => {
    const f = fixture();
    const gb = fleet(f, f.B, f.at(4000, 2500), [['carrier', 'air_group']]);
    const c = f.sim.st.ships[gb.shipIds[0]];
    fitCarrier(c); c.hp = 0.08;
    const ga = fleet(f, f.A, f.at(3000, 2500), [['cruiser', 'std'], ['destroyer', 'std'], ['destroyer', 'std'], ['destroyer', 'std']]);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'attack', group: gb.id } })).toBeNull();
    expect(until(f.sim, () => !f.sim.st.ships[c.id])).toBe(true);
    const w = Object.values(f.sim.st.wrecks ?? {}).find(x => x.sources.some(s => s.ship === c.id))!;
    expect(w).toBeTruthy();
    expect(w.sources.find(s => s.ship === c.id)!.classId).toBe('carrier');
    const fitted = new Set(Object.values(DAWN_STD_WEAPONS));
    const eq = w.lots.filter(l => l.k === 'equip' && l.owner === f.B);
    for (const l of eq) expect(fitted.has(l.item)).toBe(true);
  });

  it('with every unit surviving (rng 0) the wreck holds all four craft squadrons as equipment', () => {
    const f = fixture();
    const g = fleet(f, f.B, f.at(3000, 0), [['carrier', 'air_group']]);
    const c = f.sim.st.ships[g.shipIds[0]];
    fitCarrier(c);
    const [w] = makeWrecks(f.sim.st, 'e_p164', [{ ship: c, pos: c.pos }], 0, () => 0, [f.B]);
    const n = (item: string) => w.lots.filter(l => l.k === 'equip' && l.item === item).reduce((a, l) => a + l.n, 0);
    for (const id of WING) expect(EQUIPMENT[id]).toBeTruthy();
    expect(n('eq_wing_fighter')).toBe(2);
    expect(n('eq_wing_torpedo')).toBe(1);
    expect(n('eq_wing_interceptor')).toBe(1);
  });
});
