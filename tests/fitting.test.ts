// Fitting V2 (growth P2): server-enforced rules, item conservation, combat and render fidelity,
// save migration and rollback repair.
import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { WorldState, WShip } from '../src/world/types';
import { qty } from '../src/world/types';
import { CONTENT, legacyOf, variantLayout } from '../src/content/registry';
import { hpAccepts } from '../src/content/rules';
import { legacyModuleSets } from '../src/content/validate';
import { checkFitting, fittingItems, fittingMounts, shipLoadout, legacySig, type ShipFitting } from '../src/world/fitting';
import { census, compareCensus, migrateContent } from '../src/world/migrate';
import { EQUIPMENT, HULLS, itemPrice } from '../src/world/industry';
import { SHIP_CLASSES, getLoadout } from '../src/sim/data/ships';
import { World } from '../src/sim/world';
import type { ShipSpec } from '../src/sim/fleet';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const run = (sim: WorldSim, seconds: number, dt = 0.5) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };

/** a player with one docked ship of each requested class at helios (public, refit service) */
function setup(seed = 41, ...ships: [string, string][]) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('피팅');
  const co = sim.st.companies[p]; co.credits = 20_000_000; co.rep = 1000;
  const out: WShip[] = [];
  for (const [cls, lo] of ships) {
    const k = sim.st.stations.helios.shipStock?.[`${cls}_mk1`]; if (k) k.n = Math.max(k.n, 1);   // capital hulls are stocked one at a time
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: cls, loadoutId: lo })).toBeNull();
    const s = Object.values(sim.st.ships).filter(x => x.owner === p && x.classId === cls).pop()!;
    s.task = { k: 'docked', station: 'helios' } as any; s.state = 'docked';
    out.push(s);
  }
  return { sim, p, co, ships: out, store: () => sim.storage(sim.st.stations.helios, p) };
}
/** every item a company owns, wherever it is: storage anywhere + fitted on its ships */
function holdings(st: WorldState, p: string) {
  const h: Record<string, number> = {};
  for (const x of Object.values(st.stations)) for (const [k, n] of Object.entries(x.storage[p] ?? {})) if (EQUIPMENT[k] && n) h[k] = (h[k] ?? 0) + n;
  for (const s of Object.values(st.ships)) if (s.owner === p) for (const [k, n] of Object.entries(fittingItems(s.fitting))) h[k] = (h[k] ?? 0) + n;
  return h;
}
const fit = (s: WShip): ShipFitting => clone(s.fitting!);
/** a hardpoint of this ship that takes torpedo tubes, and is not already carrying one */
const torpHp = (s: WShip) => variantLayout(s.variant!)!.hardpoints.find(h => !hpAccepts(h, 'eq_torpedo') && s.fitting!.hp[h.id] !== 'eq_torpedo')!;
const freeModule = Object.values(EQUIPMENT).find(e => e.kind === 'module' && !e.tech)!.id;

describe('fitting V2: rules enforced by the server', () => {
  it('new player ships carry a fitting equal to their preset; NPC ships stay on legacy loadouts', () => {
    const { sim, ships: [bs] } = setup(41, ['battleship', 'fortress']);
    const m = legacyOf('battleship', 'fortress')!;
    expect(bs.fitting!.hp).toEqual(CONTENT.presets[m.preset].weapons);
    expect(bs.variant).toBe(m.variant);
    expect(bs.fitting!.preset).toBe(m.preset);
    expect(bs.fitting!.sig).toBe(legacySig(bs.loadoutId, bs.fit));
    run(sim, 60);
    const npc = Object.values(sim.st.ships).filter(s => sim.st.companies[s.owner]?.kind !== 'player');
    expect(npc.length).toBeGreaterThan(0);
    expect(npc.every(s => s.fitting === undefined)).toBe(true);
  });

  it('rejects wrong size, type, mount, power, mass, unknown slots/items, foreign or undocked ships — and changes nothing', () => {
    const { sim, p, co, ships: [cr, bs], store } = setup(42, ['cruiser', 'gun'], ['battleship', 'std']);
    const other = sim.addPlayer('남의 회사');
    const lay = variantLayout(cr.variant!)!;
    const S = store(); for (const k of Object.keys(EQUIPMENT)) S[k] = 5;
    const snap = () => JSON.stringify([cr.fitting, cr.fit, cr.loadoutId, cr.variant, bs.fitting, bs.fit, co.credits, sim.st.stations.helios.storage[p]]);
    const before = snap();
    const tryFit = (f: Partial<ShipFitting>, extra: object = {}) => sim.command(p, { c: 'fit', ship: cr.id, hp: f.hp ?? cr.fitting!.hp, bay: f.bay ?? cr.fitting!.bay, ...extra } as any);
    const mHp = lay.hardpoints.find(h => h.size === 'M' && h.type !== 'pd')!;
    const sHp = lay.hardpoints.find(h => h.size === 'S')!;
    // size
    expect(tryFit({ hp: { ...cr.fitting!.hp, [mHp.id]: 'eq_heavy_cannon' } })).toMatch(/크기 초과/);
    // type: a PD hardpoint takes only PD
    const pdHp = lay.hardpoints.find(h => h.type === 'pd');
    if (pdHp) expect(tryFit({ hp: { ...cr.fitting!.hp, [pdHp.id]: 'eq_autocannon' } })).toMatch(/방공/);
    // a module is not a weapon, a weapon is not a module
    expect(tryFit({ hp: { ...cr.fitting!.hp, [sHp.id]: 'mod_fcs' } })).toMatch(/무장 장비가 아님|내부 장비/);
    expect(tryFit({ bay: { bay1: 'eq_autocannon' } })).toMatch(/내부 장비가 아님/);
    // unknown slot / item / variant of another hull
    expect(tryFit({ hp: { ...cr.fitting!.hp, zz9: 'eq_pd_gun' } })).toMatch(/없는 하드포인트/);
    expect(tryFit({ bay: { bay9: 'mod_fcs' } })).toMatch(/없는 내부 베이/);
    expect(tryFit({ hp: { ...cr.fitting!.hp, [sHp.id]: 'eq_nope' } })).toMatch(/알 수 없는 장비/);
    expect(tryFit({}, { variant: 'battleship_mk1_std' })).toMatch(/변형이 아님/);
    // a blueprint-graded variant cannot be picked before blueprints exist (P6)
    CONTENT.variants.cruiser_mk1_tmp = { id: 'cruiser_mk1_tmp', hull: 'cruiser_mk1', name: '시험형', desc: '', blueprint: 'rare' } as any;
    try { expect(tryFit({}, { variant: 'cruiser_mk1_tmp' })).toMatch(/설계도 필요/); } finally { delete (CONTENT.variants as any).cruiser_mk1_tmp; }
    // mass: four armour plates on a 4-slot cruiser were never allowed (4 × size 2 > 4 slots)
    expect(tryFit({ bay: { bay1: 'mod_armor', bay2: 'mod_armor', bay3: 'mod_armor', bay4: 'mod_armor' } })).toMatch(/적재 초과/);
    // power: rail cannons on a battleship's main hardpoints plus ECM in every bay — light enough, too hungry
    const blay = variantLayout(bs.variant!)!;
    const hot: Record<string, string> = { ...bs.fitting!.hp };
    for (const h of blay.hardpoints) if (!hpAccepts(h, 'eq_rail_cannon')) hot[h.id] = 'eq_rail_cannon';
    const ecm = Object.fromEntries(blay.internals.map(b => [b.id, 'mod_ecm']));
    const rep = checkFitting(bs.variant!, { hp: hot, bay: ecm });
    expect(rep.power).toBeGreaterThan(rep.supply); expect(rep.mass).toBeLessThanOrEqual(rep.cap);
    expect(sim.command(p, { c: 'fit', ship: bs.id, hp: hot, bay: ecm })).toMatch(/전력 초과/);
    // reactors add supply: swapping ECM for reactors makes the same guns legal
    const rx = Object.fromEntries(blay.internals.slice(0, 3).map(b => [b.id, 'mod_reactor']));
    expect(checkFitting(bs.variant!, { hp: hot, bay: rx }).errors).toEqual([]);
    // a reactor module adds supply: the same load with reactors instead of ECM can pass power
    expect(checkFitting(cr.variant!, { hp: {}, bay: { bay1: 'mod_reactor' } }).supply).toBe(CONTENT.hulls[cr.hull!].power + 20);
    // other company's ship, undocked ship
    expect(sim.command(other, { c: 'fit', ship: cr.id, hp: {}, bay: {} })).toMatch(/자사 함선이 아님/);
    cr.task = { k: 'none' }; cr.state = 'space';
    expect(tryFit({ hp: {} })).toMatch(/정박/);
    cr.task = { k: 'docked', station: 'helios' } as any; cr.state = 'docked';
    expect(snap()).toBe(before);
    // garbage input is cleaned, not trusted
    expect(sim.command(p, { c: 'fit', ship: cr.id, hp: { [sHp.id]: 42, x: null } as any, bay: 'oops' as any })).not.toMatch(/TypeError/);
  });

  it('mount styles are enforced (torpedo tubes do not go on spinal mounts)', () => {
    // core mk1 hulls have no spinal or fixed-only mismatches, so prove the rule on a test hardpoint
    const hp = { id: 'sp', pos: [0, 0, 0] as [number, number, number], facing: 0, arc: 10, size: 'L' as const, type: 'universal' as const, mount: 'spinal' as const };
    expect(hpAccepts(hp, 'eq_torpedo')).toMatch(/척추 마운트에 장착 불가/);
    expect(hpAccepts(hp, 'eq_rail_cannon')).toBeNull();
    expect(hpAccepts({ ...hp, mount: 'vls', size: 'M' }, 'eq_laser')).toMatch(/수직발사 마운트/);
  });

  it('every legacy module set still fits every legacy preset, and the bays never allow more than the old slots', () => {
    for (const c of Object.values(SHIP_CLASSES)) {
      const n = HULLS[c.id]?.slots ?? 0;
      const sets = legacyModuleSets(n);
      for (const l of c.loadouts) {
        const m = legacyOf(c.id, l.id)!;
        const w = CONTENT.presets[m.preset].weapons;
        for (const set of sets) expect(checkFitting(m.variant, { hp: w, bay: Object.fromEntries(set.map((k, i) => [`bay${i + 1}`, k])) }).errors).toEqual([]);
      }
      // the heaviest legacy-illegal set (one size-2 module more than allowed) is over the mass limit on the heaviest preset
      if (n >= 1) {
        const heavy = Object.values(CONTENT.presets).filter(x => x.hull === `${c.id}_mk1`)
          .sort((a, b) => Object.values(b.weapons).reduce((s, k) => s + CONTENT.equipment[k].mass, 0) - Object.values(a.weapons).reduce((s, k) => s + CONTENT.equipment[k].mass, 0))[0];
        const armour = Array.from({ length: n }, (_, i) => [`bay${i + 1}`, 'mod_armor']);
        if (2 * n > n) expect(checkFitting(heavy.variant, { hp: heavy.weapons, bay: Object.fromEntries(armour) }).errors.join()).toMatch(/적재 초과/);
      }
    }
  });
});

describe('fitting V2: items are conserved', () => {
  it('fit and unfit move items between ship and storage, all or nothing, over many cycles', () => {
    const { sim, p, co, ships: [cr], store } = setup(43, ['cruiser', 'gun']);
    const S = store(); S.mod_fcs = 2; S.mod_sensor = 1; S.mod_armor2 = 1; S.eq_torpedo = 1; S.eq_medium_gun = 1;
    const h0 = holdings(sim.st, p);
    const original = fit(cr);
    const lay = variantLayout(cr.variant!)!;
    const th = torpHp(cr); expect(th).toBeTruthy();
    const custom: ShipFitting = { hp: { ...original.hp, [th.id]: 'eq_torpedo' }, bay: { bay1: 'mod_fcs', bay2: 'mod_sensor', bay3: 'mod_armor2' } };
    let credits = co.credits;
    for (let i = 0; i < 6; i++) {
      expect(sim.command(p, { c: 'fit', ship: cr.id, ...custom })).toBeNull();
      expect(cr.fitting!.hp[th.id]).toBe('eq_torpedo');
      expect(cr.fit).toEqual(['mod_fcs', 'mod_sensor', 'mod_armor2']);
      expect(holdings(sim.st, p)).toEqual(h0);
      expect(sim.command(p, { c: 'fit', ship: cr.id, ...original })).toBeNull();
      expect(holdings(sim.st, p)).toEqual(h0);
      expect(cr.fit).toEqual([]);
      expect(co.credits).toBeLessThan(credits); credits = co.credits; // public station charges a service fee
    }
    // one missing item makes the whole change fail: nothing moves, nothing is charged
    const snap = JSON.stringify([cr.fitting, S, co.credits]);
    expect(sim.command(p, { c: 'fit', ship: cr.id, hp: original.hp, bay: { bay1: 'mod_fcs', bay2: 'mod_fcs', bay3: 'mod_fcs' } })).toMatch(/부족/);
    expect(JSON.stringify([cr.fitting, S, co.credits])).toBe(snap);
    expect(qty(S, 'eq_torpedo')).toBe(1); expect(qty(S, 'mod_fcs')).toBe(2);
  });

  it('two ships cannot share one stored item', () => {
    const { sim, p, ships: [a, b], store } = setup(44, ['cruiser', 'gun'], ['cruiser', 'gun']);
    const S = store(); S.mod_reactor = 1;
    expect(sim.command(p, { c: 'fit', ship: a.id, hp: a.fitting!.hp, bay: { bay1: 'mod_reactor' } })).toBeNull();
    expect(sim.command(p, { c: 'fit', ship: b.id, hp: b.fitting!.hp, bay: { bay1: 'mod_reactor' } })).toMatch(/부족/);
    expect(qty(S, 'mod_reactor')).toBe(0);
    expect(holdings(sim.st, p).mod_reactor).toBe(1);
  });

  it('public stations sell missing items only when asked, at 1.2× price, and only researched ones', () => {
    const { sim, p, co, ships: [cr], store } = setup(45, ['cruiser', 'gun']);
    const S = store();
    const f = { hp: cr.fitting!.hp, bay: { bay1: freeModule } };
    expect(sim.command(p, { c: 'fit', ship: cr.id, ...f })).toMatch(/부족/);
    const c0 = co.credits;
    expect(sim.command(p, { c: 'fit', ship: cr.id, ...f, buy: true })).toBeNull();
    expect(c0 - co.credits).toBe(Math.round(itemPrice(freeModule) * 1.2) + 400 + 300);
    expect(qty(S, freeModule)).toBe(0);
    // a researched-only weapon cannot be bought without the research
    const gated = Object.values(EQUIPMENT).find(e => e.kind === 'module' && e.tech)!;
    co.tech = (co.tech ?? []).filter(t => t !== gated.tech);
    expect(sim.command(p, { c: 'fit', ship: cr.id, hp: cr.fitting!.hp, bay: { bay1: gated.id }, buy: true })).toMatch(/연구 필요/);
  });

  it('own facilities never sell items; they use storage only and charge nothing', () => {
    const { sim, p, co, ships: [cr], store } = setup(46, ['cruiser', 'gun']);
    const helios = sim.st.stations.helios;
    // make helios behave like an own fitting station for this test
    helios.owner = p; helios.public = false; helios.modules.push({ kind: 'fitting', progress: 1, built: true, slot: 9 });
    expect(sim.command(p, { c: 'fit', ship: cr.id, hp: cr.fitting!.hp, bay: { bay1: 'mod_fcs' }, buy: true })).toMatch(/판매하지 않음/);
    store().mod_fcs = 1;
    const c0 = co.credits;
    expect(sim.command(p, { c: 'fit', ship: cr.id, hp: cr.fitting!.hp, bay: { bay1: 'mod_fcs' } })).toBeNull();
    expect(co.credits).toBe(c0);
  });

  it('legacy refit and fitShip commands translate to V2 fittings with the same conservation', () => {
    const { sim, p, ships: [bs], store } = setup(47, ['battleship', 'std']);
    const h0 = holdings(sim.st, p);
    expect(sim.command(p, { c: 'refit', ship: bs.id, loadoutId: 'fortress' })).toBeNull();
    expect(bs.variant).toBe('battleship_mk1_fortress');
    expect(bs.loadoutId).toBe('fortress');
    expect(bs.fitting!.hp).toEqual(CONTENT.presets.battleship_fortress.weapons);
    // weapons bought for the refit are the only new items; the old ones went to storage
    const h1 = holdings(sim.st, p);
    for (const [k, n] of Object.entries(h0)) expect(h1[k]).toBeGreaterThanOrEqual(n);
    store().mod_engine = 2;
    expect(sim.command(p, { c: 'fitShip', ship: bs.id, fit: ['mod_engine', 'mod_engine'] })).toBeNull();
    expect(bs.fit).toEqual(['mod_engine', 'mod_engine']);
    expect(holdings(sim.st, p)).toEqual({ ...h1, mod_engine: 2 });
  });

  it('company presets: save, overwrite by name, limit, delete; invalid fittings are not saved', () => {
    const { sim, p, co, ships: [cr] } = setup(48, ['cruiser', 'gun']);
    expect(sim.command(p, { c: 'savePreset', name: '근접전', variant: cr.variant!, hp: cr.fitting!.hp, bay: { bay1: 'mod_fcs' } })).toBeNull();
    expect(sim.command(p, { c: 'savePreset', name: '근접전', variant: cr.variant!, hp: cr.fitting!.hp, bay: { bay1: 'mod_sensor' } })).toBeNull();
    expect(co.fitPresets!.length).toBe(1);
    expect(co.fitPresets![0].bay).toEqual({ bay1: 'mod_sensor' });
    expect(sim.command(p, { c: 'savePreset', name: 'x', variant: cr.variant!, hp: { zz: 'eq_lance' }, bay: {} })).toMatch(/저장 불가/);
    for (let i = 1; i < 20; i++) expect(sim.command(p, { c: 'savePreset', name: `p${i}`, variant: cr.variant!, hp: {}, bay: {} })).toBeNull();
    expect(sim.command(p, { c: 'savePreset', name: 'p20', variant: cr.variant!, hp: {}, bay: {} })).toMatch(/20개/);
    expect(sim.command(p, { c: 'delPreset', id: co.fitPresets![0].id })).toBeNull();
    expect(co.fitPresets!.length).toBe(19);
  });

  it('ships launched from an own yard get a fitting with the built modules', () => {
    const { sim, p } = setup(49);
    const s = sim.spawnShip(p, 'destroyer', 'aa', Object.values(sim.st.groups).find(g => g.owner === p)!.id, sim.st.stations.helios.pos);
    expect(s.fitting).toBeTruthy();
    s.fit = ['mod_fcs', 'mod_ecm'];
    (sim as any).legacyFitting(s);
    expect(Object.values(s.fitting!.bay).sort()).toEqual(['mod_ecm', 'mod_fcs']);
    expect(s.fit!.sort()).toEqual(['mod_ecm', 'mod_fcs']);
  });
});

describe('fitting V2: combat engine and renderer use exactly the fitted equipment', () => {
  const fleet = (name: string, ships: ShipSpec[]) => ({ name, root: { name, commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] } });
  const battle = (a: ShipSpec[], b: ShipSpec[], seed = 5) => new World({ seed, scenarioId: 'test', fleets: [fleet('A', a), fleet('B', b)] } as any);
  const fitOf = (classId: string, loadoutId: string): ShipSpec['fit'] => {
    const m = legacyOf(classId, loadoutId)!;
    return shipLoadout({ classId, loadoutId, variant: m.variant, fitting: { hp: CONTENT.presets[m.preset].weapons, bay: {} } }) as any;
  };

  it('for all 25 presets, the fitting spec builds the identical ship and the identical battle', () => {
    let n = 0;
    const foe: ShipSpec[] = [{ classId: 'cruiser', loadoutId: 'gun' }, { classId: 'destroyer', loadoutId: 'aa' }];
    for (const c of Object.values(SHIP_CLASSES)) for (const l of c.loadouts) {
      const legacy = battle([{ classId: c.id, loadoutId: l.id }], foe);
      const fitted = battle([{ classId: c.id, loadoutId: l.id, fit: fitOf(c.id, l.id) }], foe);
      const a = legacy.ships[0], b = fitted.ships[0];
      expect(b.maxHp).toBe(a.maxHp); expect(b.armor).toEqual(a.armor); expect(b.maxSpeed).toBe(a.maxSpeed);
      expect(b.mounts.map(w => [w.weapon.id, w.def.pos, w.def.facing, w.def.arc])).toEqual(a.mounts.map(w => [w.weapon.id, w.def.pos, w.def.facing, w.def.arc]));
      for (let i = 0; i < 400 && !legacy.outcome; i++) { legacy.step(); fitted.step(); }
      expect(fitted.digest()).toBe(legacy.digest());
      n++;
    }
    expect(n).toBe(25);
  });

  it('a custom fitting changes the ship in battle (weapons, arcs, structure)', () => {
    const { sim, p, ships: [cr], store } = setup(50, ['cruiser', 'gun']);
    const hp = torpHp(cr);
    store().eq_torpedo = 1;
    expect(sim.command(p, { c: 'fit', ship: cr.id, hp: { ...cr.fitting!.hp, [hp.id]: 'eq_torpedo' }, bay: cr.fitting!.bay })).toBeNull();
    const spec = (sim as any).fittingSpec(cr) as ShipSpec['fit'];
    expect(spec!.mounts).toEqual(fittingMounts(cr.variant!, cr.fitting!));
    const w = battle([{ classId: 'cruiser', loadoutId: cr.loadoutId, fit: spec }], [{ classId: 'corvette', loadoutId: 'gun' }]);
    const mounts = w.ships[0].mounts.map(x => x.weapon.id);
    expect(mounts.filter(m => m === 'torpedo').length).toBe(Object.values(cr.fitting!.hp).filter(k => k === 'eq_torpedo').length);
    expect(mounts.length).toBe(Object.keys(cr.fitting!.hp).length);
    const base = getLoadout('cruiser', 'gun').mounts;
    expect(mounts).not.toEqual(base.map(m => m.weapon));
  });

  it('the world battle setup passes the fitting to the combat engine for player ships', () => {
    const { sim, ships: [cr] } = setup(51, ['cruiser', 'gun']);
    const spec = (sim as any).fittingSpec(cr);
    expect(spec.mounts.map((m: any) => `${m.weapon}|${m.pos}|${m.facing}|${m.arc}`).sort()).toEqual(getLoadout('cruiser', 'gun').mounts.map(m => `${m.weapon}|${m.pos}|${m.facing}|${m.arc}`).sort());
  });

  it('3D model turrets sit exactly on the fitted hardpoints', async () => {
    // minimal canvas so the mesh builder's procedural textures run in node
    const ctx = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
    (globalThis as any).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
    const { buildShip } = await import('../src/render/shipMesh');
    const { sim, p, ships: [cr], store } = setup(52, ['cruiser', 'gun']);
    const lay = variantLayout(cr.variant!)!;
    const hp = torpHp(cr);
    store().eq_torpedo = 1;
    expect(sim.command(p, { c: 'fit', ship: cr.id, hp: { ...cr.fitting!.hp, [hp.id]: 'eq_torpedo' }, bay: cr.fitting!.bay })).toBeNull();
    const lo = shipLoadout(cr);
    const model = buildShip(SHIP_CLASSES.cruiser, lo, 0);
    expect(model.turrets.length).toBe(Object.keys(cr.fitting!.hp).length);
    for (const t of model.turrets) {
      const h = lay.hardpoints.find(x => x.pos.every((v, i) => v === t.mount.pos[i]))!;
      expect(h, `turret at ${t.mount.pos}`).toBeTruthy();
      expect([t.root.position.x, t.root.position.y, t.root.position.z]).toEqual(h.pos);
      expect(t.mount.weapon).toBe(EQUIPMENT[cr.fitting!.hp[h.id]].weapon);
    }
    expect(model.turrets.some(t => t.mount.weapon === 'torpedo' && t.mount.pos === hp.pos)).toBe(true);
  });
});

describe('fitting V2: save migration (contentV 1 → 2) and rollback', () => {
  function v1Save() {
    const { sim, p, ships } = setup(53, ['battleship', 'fortress'], ['destroyer', 'aa']);
    ships[1].fit = ['mod_fcs', 'mod_ecm', 'mod_engine'];
    run(sim, 30);
    const dsId = ships[1].id;
    const st: WorldState = JSON.parse(sim.serialize());
    st.contentV = 1; delete st.conversions;
    for (const s of Object.values(st.ships)) delete s.fitting;
    return { st, p, dsId };
  }

  it('turns loadouts + modules into fittings, records conversions, conserves every item', () => {
    const { st, p, dsId } = v1Save();
    const before = census(st);
    const sim = new WorldSim(clone(st));
    const rep = sim.contentReport!;
    expect(rep.from).toBe(1);
    expect(rep.fitted).toBe(Object.values(st.ships).filter(s => s.owner === p).length);
    expect(rep.granted.filter(g => !g.item.startsWith('blueprint:'))).toEqual([]);
    expect(rep.returned).toEqual([]);
    expect(rep.converted.find(c => c.item === 'eq_heavy_cannon')!.n).toBe(before.equipment.eq_heavy_cannon);
    expect(compareCensus(before, census(sim.st))).toEqual([]);
    const ds = sim.st.ships[dsId];
    expect(Object.values(ds.fitting!.bay).sort()).toEqual(['mod_ecm', 'mod_engine', 'mod_fcs']);
    // NPC ships untouched
    for (const s of Object.values(sim.st.ships)) if (s.owner !== p) expect(s.fitting).toBeUndefined();
    // idempotent; save round-trips
    expect(migrateContent(sim.st).fitted).toBe(0);
    const s1 = sim.serialize(); expect(new WorldSim(JSON.parse(s1)).serialize()).toBe(s1);
  });

  it('a module with no bay (corrupt old save) goes to storage, never disappears', () => {
    const { st, dsId } = v1Save();
    const ds = st.ships[dsId];
    ds.fit = ['mod_fcs', 'mod_ecm', 'mod_engine', 'mod_sensor']; // 4 modules in 3 slots
    const before = census(st);
    const sim = new WorldSim(clone(st));
    expect(sim.contentReport!.returned.map(r => r.item)).toEqual(['mod_sensor']);
    expect(compareCensus(before, census(sim.st))).toEqual([]);
  });

  it('dry-run (migrateContent:false) on a contentV 0 save keeps the legacy path: no fittings, legacy commands work', () => {
    const { st, p } = v1Save();
    st.contentV = 0; for (const s of Object.values(st.ships)) { delete s.hull; delete s.variant; }
    const sim = new WorldSim(clone(st), { migrateContent: false });
    expect(sim.st.contentV ?? 0).toBe(0);
    const bs = Object.values(sim.st.ships).find(s => s.owner === p && s.classId === 'battleship')!;
    expect(bs.fitting).toBeUndefined();
    expect(sim.command(p, { c: 'fit', ship: bs.id, hp: {}, bay: {} })).toMatch(/피팅 V2가 적용되지 않았/);
    bs.task = { k: 'docked', station: 'helios' } as any;
    expect(sim.command(p, { c: 'refit', ship: bs.id, loadoutId: 'std' })).toBeNull();
    expect(bs.fitting).toBeUndefined();
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'corvette', loadoutId: 'gun' })).toBeNull();
    expect(Object.values(sim.st.ships).every(s => s.fitting === undefined)).toBe(true);
  });

  it('rollback to older code and forward again: ships the old code refitted are rebuilt from their loadout', () => {
    const { st, p } = v1Save();
    const migrated: WorldState = JSON.parse(new WorldSim(clone(st)).serialize());
    // older code (P1) ignores `fitting`, refits the battleship by loadout and changes modules
    const bs = Object.values(migrated.ships).find(s => s.owner === p && s.classId === 'battleship')!;
    bs.loadoutId = 'std'; bs.fit = ['mod_engine'];
    const sim = new WorldSim(clone(migrated));
    const after = sim.st.ships[bs.id];
    expect(after.fitting!.hp).toEqual(CONTENT.presets.battleship_std.weapons);
    expect(after.variant).toBe('battleship_mk1_std');
    expect(Object.values(after.fitting!.bay)).toEqual(['mod_engine']);
    expect(after.fitting!.sig).toBe(legacySig('std', ['mod_engine']));
    // untouched ships keep their custom fitting
    const ds = Object.values(sim.st.ships).find(s => s.owner === p && s.classId === 'destroyer')!;
    expect(ds.fitting).toEqual(migrated.ships[ds.id].fitting);
  });
});

describe('fitting V2: hostile input', () => {
  it('prototype keys and junk are rejected without side effects', () => {
    const { sim, p, co, ships: [cr] } = setup(60, ['cruiser', 'gun']);
    const before = JSON.stringify([cr, co.credits, co.fitPresets]);
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(sim.command(p, { c: 'fit', ship: cr.id, variant: bad, hp: cr.fitting!.hp, bay: {} })).toBeTruthy();
      expect(sim.command(p, { c: 'fit', ship: cr.id, hp: { ...cr.fitting!.hp, hp01: bad }, bay: {} })).toBeTruthy();
      expect(sim.command(p, { c: 'fit', ship: cr.id, hp: cr.fitting!.hp, bay: { bay1: bad } })).toBeTruthy();
      expect(sim.command(p, { c: 'fit', ship: cr.id, hp: { [bad]: 'eq_pd_gun' }, bay: {} } as any)).toBeTruthy();
      expect(sim.command(p, { c: 'savePreset', name: 'x', variant: bad, hp: {}, bay: {} })).toBeTruthy();
    }
    expect(sim.command(p, { c: 'fit', ship: cr.id, hp: null, bay: 7 } as any)).toBeTruthy();
    expect(JSON.stringify([cr, co.credits, co.fitPresets])).toBe(before);
  });
});
