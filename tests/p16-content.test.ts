// P16.2 carrier content and fitting rules: H (hangar) hardpoints and flight bays decided by hull structure and
// equipment, never by class name; strike craft kept out of gun range / gun firepower sums; the carrier hull as
// a preview hull (complete data, not released to the world); an explicit rules-3 battle with the real content;
// world command paths (purchase, blueprint, fitting). docs/P16_2_CARRIER_CONTENT.md, P16_0 §14 T5–T7.
import { describe, expect, it } from 'vitest';
import { World, BATTLE_RULES, type BattleSetup } from '../src/sim/world';
import { bandsOf } from '../src/sim/ai/computer';
import { WEAPONS, isCraft, isShipGun } from '../src/sim/data/weapons';
import { SHIP_CLASSES, getLoadout } from '../src/sim/data/ships';
import type { FleetSpec, GroupSpec, ShipSpec } from '../src/sim/fleet';
import type { SimEvent } from '../src/sim/types';
import { CONTENT, variantLayout, hullReleased, contentAvail } from '../src/content/registry';
import { hpAccepts, bayAccepts, weaponType, weaponOf, TYPE_NAME } from '../src/content/rules';
import { validateContent } from '../src/content/validate';
import { craftScore, CRAFT_BUDGET, referenceScores } from '../src/content/validateArsenal';
import { sizeRank, type HardpointDef } from '../src/content/schema';
import { EQUIPMENT, RECIPES } from '../src/world/industry';
import { checkFitting, fittingItems, placeModules, shipLoadout } from '../src/world/fitting';
import { rate } from '../src/world/combatRating';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { growthOn, yardHulls } from '../src/world/hullops';
import { offersAt, grantBlueprint, contractAwards } from '../src/world/blueprints';
import { CARRIER_HULL, CARRIER_ARMS, CARRIER_MODULES, DAWN_STD_WEAPONS } from '../src/content/packs/growth/carrier';
import type { WShip } from '../src/world/types';

const CRAFT_EQ = CARRIER_ARMS.map(a => a.id);
const AIR_EQ = CARRIER_MODULES.filter(m => m.slot === 'flight').map(m => m.id);   // P16.3 adds the carrier computer (computer bay) to the pack
const weaponsEq = Object.values(EQUIPMENT).filter(e => e.kind === 'weapon').map(e => e.id);
const modulesEq = Object.values(EQUIPMENT).filter(e => e.kind === 'module').map(e => e.id);
const allHardpoints = (): { v: string; hp: HardpointDef }[] => Object.keys(CONTENT.variants).flatMap(v => (variantLayout(v)?.hardpoints ?? []).map(hp => ({ v, hp })));

/** hpAccepts as it was before P16.2 (2115e3c), for the equivalence check on every non-H hardpoint */
function oldHpAccepts(hp: HardpointDef, equipId: string): string | null {
  const spec = CONTENT.equipment[equipId], weapon = weaponOf(equipId);
  if (!spec || !weapon || !WEAPONS[weapon]) return 'not a weapon';
  if (spec.slot !== 'hardpoint') return 'module';
  if (sizeRank(spec.size) > sizeRank(hp.size)) return 'size';
  const w = WEAPONS[weapon];
  const t = w.hp ? w.hp : w.kind === 'pd' ? 'pd' : w.kind === 'missile' || w.kind === 'torpedo' ? 'missile' : weapon === 'pulse_laser' || weapon === 'particle_lance' ? 'energy' : 'ballistic';
  if (hp.type === 'pd' && t !== 'pd') return 'pd';
  if (t !== 'pd' && hp.type !== 'universal' && hp.type !== t) return 'type';
  if (spec.mounts && !spec.mounts.includes(hp.mount)) return 'mount';
  return null;
}

describe('P16.2 content (T7)', () => {
  it('validates clean; three craft weapons, three aviation modules, one preview carrier with production and blueprint data', () => {
    const issues = validateContent(CONTENT);
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
    expect(issues.filter(i => i.level === 'warn')).toEqual([]);
    expect(BATTLE_RULES).toBe(2);
    for (const id of CRAFT_EQ) {
      const w = WEAPONS[EQUIPMENT[id].weapon!];
      expect(w.kind, id).toBe('craft');
      expect(w.salvo).toBe(0);
      expect(w.craft).toBeTruthy();
      expect(weaponType(w.id)).toBe('hangar');
      expect(RECIPES[id]?.tech, id).toBeTruthy();
      expect(contentAvail(id, 2)).toBe(false);               // growth-only content
      expect(contentAvail(id, 3)).toBe(true);
      expect(craftScore(w.craft!)).toBeLessThanOrEqual(CRAFT_BUDGET.L! * 1.25);
    }
    expect(WEAPONS[WEAPONS.wing_torpedo.craft!.ordnance!].kind).toBe('torpedo');
    for (const id of AIR_EQ) { expect(EQUIPMENT[id].air, id).toBeTruthy(); expect(CONTENT.equipment[id].slot).toBe('flight'); expect(RECIPES[id]).toBeTruthy(); }
    const h = CONTENT.hulls[CARRIER_HULL];
    expect(h.preview).toBe(true);
    expect(h.sale).toBeUndefined();
    expect(h.build?.parts).toBeTruthy();
    expect(h.hardpoints.filter(p => p.type === 'hangar')).toHaveLength(4);
    expect(h.internals.filter(b => b.kind === 'flight')).toHaveLength(3);
    expect(h.internals.some(b => b.kind === 'computer')).toBe(true);   // combat hull: registry adds the computer bay
    expect(CONTENT.blueprints.bp_carrier_dawn.target).toEqual({ kind: 'hull', id: CARRIER_HULL });
    // the battle class exists by id but stays out of every class catalogue until release
    expect(SHIP_CLASSES.carrier.loadouts[0].mounts.filter(m => isCraft(WEAPONS[m.weapon]))).toHaveLength(4);
    expect(Object.keys(SHIP_CLASSES)).not.toContain('carrier');
    // the class loadout is exactly the standard preset (same mounts, same order)
    const lo = shipLoadout({ classId: 'carrier', loadoutId: 'air_group', variant: 'carrier_dawn_std', fitting: { hp: { ...DAWN_STD_WEAPONS }, bay: {} } });
    expect(lo.mounts).toEqual(getLoadout('carrier', 'air_group').mounts);
    // built-in weapon budget reference unchanged by craft
    expect(Object.values(referenceScores()).every(Number.isFinite)).toBe(true);
  });
});

describe('P16.2 fitting rules (T6): hull structure and equipment decide, not the class', () => {
  it('every non-H hardpoint accepts exactly what it accepted before for every non-craft weapon, and never a craft weapon', () => {
    let n = 0;
    for (const { v, hp } of allHardpoints()) {
      if (hp.type === 'hangar') continue;
      for (const eq of weaponsEq) {
        if (CRAFT_EQ.includes(eq)) { expect(hpAccepts(hp, eq), `${v}/${hp.id} ${eq}`).toMatch(/격납\(H\)/); continue; }
        // P16.7: combat repair rigs fit only support (R) hardpoints, and support hardpoints take only them
        const isRep = WEAPONS[EQUIPMENT[eq]?.weapon ?? '']?.kind === 'repair';
        if (isRep || hp.type === 'support') { if (!(isRep && hp.type === 'support')) expect(hpAccepts(hp, eq), `${v}/${hp.id} ${eq}`).not.toBeNull(); continue; }
        expect(hpAccepts(hp, eq) === null, `${v}/${hp.id} ${eq}`).toBe(oldHpAccepts(hp, eq) === null);
        n++;
      }
    }
    expect(n).toBeGreaterThan(1000);
    // universal and missile hardpoints exist and keep taking their guns / launchers
    const uni = allHardpoints().find(x => x.hp.type === 'universal')!.hp, mis = allHardpoints().find(x => x.hp.type === 'missile')!.hp;
    expect(hpAccepts(uni, 'eq_wing_fighter')).toMatch(/격납\(H\)/);
    expect(hpAccepts(mis, 'eq_wing_torpedo')).toMatch(/격납\(H\)/);
  });

  it('an H hardpoint takes strike craft only', () => {
    for (const hp of CONTENT.hulls[CARRIER_HULL].hardpoints.filter(p => p.type === 'hangar')) {
      expect(TYPE_NAME[hp.type]).toBe('격납(H)');
      for (const eq of weaponsEq) {
        const why = hpAccepts(hp, eq);
        if (CRAFT_EQ.includes(eq)) expect(why, eq).toBeNull(); else expect(why, eq).toMatch(/함재기 무장만/);
      }
    }
  });

  it('a flight bay takes aviation modules only, and aviation modules go nowhere else (a universal bay included)', () => {
    const bays = Object.keys(CONTENT.variants).flatMap(v => (variantLayout(v)?.internals ?? []).map(b => ({ v, b })));
    expect(bays.some(x => x.b.kind === 'special')).toBe(true);
    for (const { v, b } of bays) for (const eq of modulesEq) {
      const why = bayAccepts(b, eq);
      if (AIR_EQ.includes(eq)) { if (b.kind === 'flight') expect(why, `${v}/${b.id} ${eq}`).toBeNull(); else expect(why, `${v}/${b.id} ${eq}`).toMatch(b.kind === 'computer' ? /전투 컴퓨터만/ : /항공 장비 베이에만/); }
      else if (b.kind === 'flight') expect(why, `${v}/${b.id} ${eq}`).toMatch(CONTENT.equipment[eq]?.slot === 'industrial' || CONTENT.equipment[eq]?.slot === 'computer' ? /에만 장착/ : /항공 장비만/);
    }
    // module placement fills flight bays with aviation gear, and leaves the universal bay free
    const pl = placeModules('carrier_dawn_std', ['air_control', 'mod_fcs', 'air_maint', 'air_hangar_ext']);
    expect(pl.unplaced).toEqual([]);
    expect(Object.entries(pl.bay).filter(([id]) => id.startsWith('fl')).map(([, m]) => m).sort()).toEqual(['air_control', 'air_hangar_ext', 'air_maint']);
    expect(pl.bay.bay1).toBe('mod_fcs');
  });

  it('the standard carrier fitting with full aviation gear and a computer is legal (power, mass)', () => {
    const rep = checkFitting('carrier_dawn_std', { hp: { ...DAWN_STD_WEAPONS }, bay: { fl1: 'air_hangar_ext', fl2: 'air_control', fl3: 'air_maint', sen1: 'mod_sensor', bay1: 'mod_fcs', cpu1: 'cpu_line' } });
    expect(rep.errors).toEqual([]);
    expect(rep.power).toBeLessThanOrEqual(rep.supply);
    expect(rep.mass).toBeLessThanOrEqual(rep.cap);
  });
});

describe('P16.2 kind audit (T5): strike craft are not gun range or gun firepower', () => {
  const lo = getLoadout('carrier', 'air_group');
  const gunsOnly = { ...lo, mounts: lo.mounts.filter(m => !isCraft(WEAPONS[m.weapon])) };
  it('combat computer bands are the same with and without the craft; the rating counts craft only through the P16.3 air term', () => {
    const rows = (ms: typeof lo.mounts) => ms.map(m => ({ w: WEAPONS[m.weapon], f: m.facing, arc: m.arc }));
    expect(bandsOf(rows(lo.mounts), () => false)).toEqual(bandsOf(rows(gunsOnly.mounts), () => false));
    const cls = SHIP_CLASSES.carrier;
    // P16.2 asserted equality (craft ignored); P16.3 adds the carrier air-group rating (tests/p16-carrier-ops.test.ts)
    expect(rate({ cls, lo }).off).toBeGreaterThan(rate({ cls, lo: gunsOnly }).off);
    expect(rate({ cls, lo }).def).toBe(rate({ cls, lo: gunsOnly }).def);
  });
  it('generic gun sums see no craft firepower or craft range', () => {
    for (const id of CRAFT_EQ) { const w = WEAPONS[EQUIPMENT[id].weapon!]; expect(isShipGun(w)).toBe(false); expect(w.damage * w.salvo / w.reload).toBe(0); }
    const maxGunRange = (ms: typeof lo.mounts) => Math.max(...ms.map(m => WEAPONS[m.weapon]).filter(isShipGun).map(w => w.range));
    expect(maxGunRange(lo.mounts)).toBe(WEAPONS.medium_gun.range);
  });
});

// ─────────────────────────────────────────────────────────── battles with the real content
const S = (c: string, l: string, n: number, extra: Partial<ShipSpec> = {}): ShipSpec[] => Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...extra }));
const G = (ships: ShipSpec[], order: GroupSpec['order'] = 'engage', cmd = 'wolf'): GroupSpec => ({ name: 'g', commanderId: cmd, order, retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec, name: string): FleetSpec => ({ name, root: g });
const setup = (a: GroupSpec, b: GroupSpec, rules?: number, seed = 7): BattleSetup => ({ seed, scenarioId: 'p16c', fleets: [F(a, 'A'), F(b, 'B')], ...(rules !== undefined ? { rules } : {}) });
function run(w: World, T: number, on?: (e: SimEvent) => void) { while (!w.outcome && w.time < T) { w.step(); if (on) for (const e of w.events) on(e); } return w; }

describe('P16.2 explicit rules-3 battle with the real carrier content', () => {
  it('rules 3: the carrier launches all four squadrons, craft fight (guns and air torpedoes); rules 2 / default: no craft at all', () => {
    const ev: Record<string, number> = {};
    const w3 = run(new World(setup(G(S('carrier', 'air_group', 1)), G(S('cruiser', 'multi', 2)), 3)), 120, e => { ev[e.t] = (ev[e.t] ?? 0) + 1; });
    expect(w3.craft).not.toBeNull();
    const carrier = w3.ships.find(s => s.cls.id === 'carrier')!;
    expect(ev.craftLaunch ?? 0).toBeGreaterThan(20);
    expect(carrier.stats.dmgDealt).toBeGreaterThan(0);
    for (const rules of [0, 1, 2, undefined]) {
      const ev2: Record<string, number> = {};
      const w2 = run(new World(setup(G(S('carrier', 'air_group', 1)), G(S('cruiser', 'multi', 2)), rules)), 60, e => { ev2[e.t] = (ev2[e.t] ?? 0) + 1; });
      expect(w2.craft).toBeNull();
      expect(ev2.craftLaunch ?? 0).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────── world command paths
function world(seed = 61) {
  const sim = WorldSim.create(seed, { ...STANDARD_WORLD });
  expect(growthOn(sim.st)).toBe(true);
  const p = sim.addPlayer('항모 검증');
  const co = sim.st.companies[p]; co.credits = 50_000_000; co.rep = 1000;
  co.standing = Object.fromEntries(['union', 'guild', 'ceres', 'miners', 'iron', 'pirates'].map(f => [f, 100]));
  return { sim, p, co };
}
/** a docked player ship at helios (bought through the normal command) */
function dockedShip(sim: WorldSim, p: string, hull: string): WShip {
  const k = sim.st.stations.helios.shipStock?.[hull]; if (k) k.n = Math.max(k.n, 1);
  expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: CONTENT.hulls[hull].classId, loadoutId: '', hull } as any)).toBeNull();
  const s = Object.values(sim.st.ships).filter(x => x.owner === p && x.hull === hull).pop()!;
  s.task = { k: 'docked', station: 'helios' } as any; s.state = 'docked';
  return s;
}

describe('P16.2 world paths: the preview carrier is not released, its equipment follows the slot rules', () => {
  it('purchase and construction are refused; no yard stocks it; no catalogue lists it', () => {
    const { sim, p } = world();
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'carrier', loadoutId: '', hull: CARRIER_HULL } as any)).toMatch(/공개되지 않은 선체/);
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'carrier', loadoutId: 'air_group' } as any)).toMatch(/알 수 없는 함급/);
    const own = Object.values(sim.st.stations).find(s => s.owner === p);
    if (own) expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'carrier', loadoutId: '', hull: CARRIER_HULL } as any)).toMatch(/공개되지 않은 선체/);
    for (const st of Object.values(sim.st.stations)) { expect(yardHulls(st)).not.toContain(CARRIER_HULL); expect(st.shipStock?.[CARRIER_HULL]).toBeUndefined(); }
    expect(hullReleased(CARRIER_HULL)).toBe(false);
    expect(hullReleased('cruiser_vigil')).toBe(true);
    for (const st of Object.values(sim.st.stations)) expect(st.market?.eq_wing_fighter).toBeUndefined();
  });

  it('its blueprint is neither sold nor granted (and the world RNG is not drawn for it)', () => {
    const { sim, p, co } = world();
    for (const sid of ['helios', 'bastion']) expect(offersAt(sim.st, sim.st.stations[sid], co).map(o => o.bp.id)).not.toContain('bp_carrier_dawn');
    expect(sim.command(p, { c: 'buyBlueprint', station: 'helios', blueprint: 'bp_carrier_dawn' } as any)).toMatch(/판매하지 않는 설계도/);
    expect(grantBlueprint(sim.st, co, 'bp_carrier_dawn', 'contract', 0)).toBe(false);
    expect(co.blueprints?.bp_carrier_dawn).toBeUndefined();
    let draws = 0;
    const got = contractAwards(sim.st, co, 9, () => { draws++; return 0; });
    expect(got).not.toContain('bp_carrier_dawn');
    const randomSources = Object.values(CONTENT.blueprints).filter(b => !co.blueprints?.[b.id] || got.includes(b.id)).reduce((n, b) => n + (b.sources.some(s => s.kind === 'contract') ? 1 : 0), 0);
    expect(draws).toBeLessThanOrEqual(randomSources);
  });

  it('fitting commands on a carrier (placed by test): H and flight rules hold on the server, items are conserved, and the fitted ship fights with craft under rules 3', () => {
    const { sim, p } = world(62);
    const s = dockedShip(sim, p, 'cruiser_vigil');
    // a carrier the world could not have produced yet: written in directly, as a release migration would
    Object.assign(s, { classId: 'carrier', loadoutId: 'air_group', hull: CARRIER_HULL, variant: 'carrier_dawn_std', fit: [], fitting: { hp: { ...DAWN_STD_WEAPONS }, bay: {}, preset: 'dawn_air_group' } });
    const store = sim.storage(sim.st.stations.helios, p);
    for (const k of [...CRAFT_EQ, ...AIR_EQ, 'eq_medium_gun', 'mod_fcs', 'eq_missile_rack']) store[k] = 3;
    const tryFit = (hp: Record<string, string>, bay: Record<string, string>) => sim.command(p, { c: 'fit', ship: s.id, hp, bay } as any);
    const base = { ...DAWN_STD_WEAPONS };
    const snap = JSON.stringify([s.fitting, store]);
    expect(tryFit({ ...base, sec1: 'eq_wing_fighter' }, {})).toMatch(/격납\(H\) 하드포인트에만/);
    expect(tryFit({ ...base, h1: 'eq_medium_gun' }, {})).toMatch(/함재기 무장만/);
    expect(tryFit({ ...base, h1: 'eq_missile_rack' }, {})).toMatch(/함재기 무장만/);
    expect(tryFit(base, { bay1: 'air_control' })).toMatch(/항공 장비 베이에만/);
    expect(tryFit(base, { fl1: 'mod_fcs' })).toMatch(/항공 장비만/);
    expect(JSON.stringify([s.fitting, store])).toBe(snap);   // refusals change nothing
    // a legal change: torpedo squadron → interceptors, aviation gear into the flight bays
    const before = { ...fittingItems(s.fitting) }, st0 = { ...store };
    expect(tryFit({ ...base, h3: 'eq_wing_interceptor' }, { fl1: 'air_control', fl2: 'air_maint' })).toBeNull();
    expect(s.fitting!.hp.h3).toBe('eq_wing_interceptor');
    expect(s.fitting!.bay).toMatchObject({ fl1: 'air_control', fl2: 'air_maint' });
    expect(store.eq_wing_torpedo).toBe(st0.eq_wing_torpedo + 1);
    expect(store.eq_wing_interceptor).toBe(st0.eq_wing_interceptor - 1);
    expect(store.air_control).toBe(st0.air_control - 1);
    expect(fittingItems(s.fitting).eq_wing_interceptor).toBe((before.eq_wing_interceptor ?? 0) + 1);
    // world → battle: the fitting becomes the ship's mounts; under rules 3 its craft launch
    const fit = (sim as any).fittingSpec(s) as ShipSpec['fit'];
    expect(fit!.mounts.filter(m => isCraft(WEAPONS[m.weapon]))).toHaveLength(4);
    let launches = 0;
    run(new World(setup(G([{ classId: 'carrier', loadoutId: 'air_group', fit }]), G(S('destroyer', 'aa', 2)), 3)), 60, e => { if (e.t === 'craftLaunch') launches++; });
    expect(launches).toBeGreaterThan(10);
  });

  it('a released hull with universal / missile hardpoints refuses craft through the server command', () => {
    const { sim, p } = world(63);
    const s = dockedShip(sim, p, 'cruiser_vigil');
    const store = sim.storage(sim.st.stations.helios, p); store.eq_wing_fighter = 2;
    const uni = variantLayout(s.variant!)!.hardpoints.find(h => h.type === 'universal')!;
    expect(sim.command(p, { c: 'fit', ship: s.id, hp: { ...s.fitting!.hp, [uni.id]: 'eq_wing_fighter' }, bay: s.fitting!.bay } as any)).toMatch(/격납\(H\) 하드포인트에만/);
  });
});
