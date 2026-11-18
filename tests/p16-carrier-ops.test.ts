// P16.3 carrier operations: aviation module effects (ShipFx.air → craft pool), air control and mission
// assignment, the carrier combat computer (stand-off / evasion), gun-officer vs air-wing officer effects,
// the carrier combat rating and light battle resolution, the preview gate on carrier gear (production,
// purchase, salvage research, lab rules 3), no extra upkeep supply, and the migration preparation.
// docs/P16_3_CARRIER_OPERATIONS.md
import { describe, expect, it } from 'vitest';
import { World, type BattleSetup } from '../src/sim/world';
import { Vec3 } from '../src/sim/math';
import { BASE_CONTROL, effectiveCraft } from '../src/sim/craft';
import { WEAPONS, type WeaponDef } from '../src/sim/data/weapons';
import { SHIP_CLASSES, getLoadout } from '../src/sim/data/ships';
import type { FleetSpec, GroupSpec, ShipFx, ShipSpec } from '../src/sim/fleet';
import { CONTENT, gearReleased, type Registry } from '../src/content/registry';
import { CARRIER_ARMS, CARRIER_MODULES, CARRIER_HULL, CARRIER_MARKETS } from '../src/content/packs/growth/carrier';
import { EQUIPMENT, RECIPES, airFx } from '../src/world/industry';
import { rate, rateClass, airValueMul } from '../src/world/combatRating';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { salvageItem } from '../src/world/research';
import { migrateCarriers } from '../src/world/industrialGear';
import { availableHulls, configProblems, defaultConfig, defaultShip, battleSetup } from '../src/devlab/labModel';

const S = (c: string, l: string, n: number, extra: Partial<ShipSpec> = {}): ShipSpec[] => Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...extra }));
const G = (ships: ShipSpec[], order: GroupSpec['order'] = 'engage', cmd = 'wolf'): GroupSpec => ({ name: 'g', commanderId: cmd, order, retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec, name: string): FleetSpec => ({ name, root: g });
const setup = (a: GroupSpec, b: GroupSpec, seed = 7, rules = 3): BattleSetup => ({ seed, scenarioId: 'p163', fleets: [F(a, 'A'), F(b, 'B')], rules });
const carrierOf = (w: World, team = 0) => w.ships.find(s => s.cls.id === 'carrier' && s.team === team)!;
const air = (...ids: string[]): ShipFx => ({ air: airFx(ids) });
const CPU = { cpu: { id: 'cpu_carrier', arch: 'carrier' as const } };

describe('P16.3 aviation modules: AirSpec → ShipFx.air → craft pool, each module alone', () => {
  const squads = (fx?: ShipFx) => { const w = new World(setup(G(S('carrier', 'air_group', 1, fx ? { fx } : {})), G(S('cruiser', 'multi', 1)))); return { w, sq: w.craft!.squads }; };
  const plain = squads().sq;

  it('the world sums / multiplies module effects (airFx) and returns nothing without aviation modules', () => {
    expect(airFx(['mod_fcs'])).toBeUndefined();
    expect(airFx(['air_hangar_ext', 'air_hangar_ext'])).toEqual({ complement: 4 });
    expect(airFx(['air_maint', 'air_maint'])).toEqual({ turnaround: 0.75 * 0.75, spares: 1.25 * 1.25 });
    expect(airFx(['air_control'])).toEqual({ control: 1 });
  });

  it('hangar extension: +2 airframes per H squadron, nothing else changes', () => {
    const { sq } = squads(air('air_hangar_ext'));
    sq.forEach((q, i) => {
      expect(q.cs.n).toBe(plain[i].cs.n + 2);
      expect(q.cs.spares).toBe(plain[i].cs.spares);
      expect(q.cs.turnaround).toBe(plain[i].cs.turnaround);
      expect(q.base).toBe(plain[i].base);
    });
    expect(sq[0].wing.control).toBe(BASE_CONTROL);
  });

  it('maintenance: turnaround × 0.75, spares × 1.25 (rounded), craft numbers unchanged', () => {
    const { sq } = squads(air('air_maint'));
    sq.forEach((q, i) => {
      expect(q.cs.n).toBe(plain[i].cs.n);
      expect(q.cs.turnaround).toBeCloseTo(plain[i].cs.turnaround * 0.75, 9);
      expect(q.cs.spares).toBe(Math.round(plain[i].cs.spares * 1.25));
      expect(q.spares).toBe(q.cs.spares);
    });
  });

  it('air control: one more squadron on missions at once; craft numbers unchanged', () => {
    const { sq } = squads(air('air_control'));
    expect(sq[0].wing.control).toBe(BASE_CONTROL + 1);
    sq.forEach((q, i) => expect(q.cs).toEqual(plain[i].cs));
  });

  it('the officer air-wing hooks (airTurn / airCtl) act through the same path; no skill grants them yet', () => {
    const base = WEAPONS.wing_fighter.craft!;
    expect(effectiveCraft(base)).toBe(base);
    expect(effectiveCraft(base, undefined, { airTurn: 0.2 }).turnaround).toBeCloseTo(base.turnaround * 0.8, 9);
    expect(effectiveCraft(base, { turnaround: 0.75 }, { airTurn: 0.2 }).turnaround).toBeCloseTo(base.turnaround * 0.6, 9);
  });

  it('effects reach the fight: hangar extension launches more craft, maintenance re-sorties sooner', () => {
    const launches = (fx?: ShipFx) => { const w = new World(setup(G(S('carrier', 'air_group', 1, fx ? { fx } : {})), G(S('cruiser', 'multi', 2)))); let n = 0; while (!w.outcome && w.time < 150) { w.step(); for (const e of w.events) if (e.t === 'craftLaunch' && e.ship === carrierOf(w).id) n++; } return n; };
    const p = launches();
    expect(launches(air('air_hangar_ext'))).toBeGreaterThan(p);
    expect(launches(air('air_maint'))).toBeGreaterThan(p);
  });
});

describe('P16.3 air control and mission assignment', () => {
  const run = (fxA: ShipFx | undefined, seed = 7) => {
    const w = new World(setup(G([...S('carrier', 'air_group', 1, fxA ? { fx: fxA } : {}), ...S('cruiser', 'multi', 2)]), G(S('cruiser', 'multi', 3), 'engage', 'krause'), seed));
    while (!w.outcome && w.time < 120) w.step();
    return w.craft!.squads.filter(q => q.team === 0);
  };

  it('base control 3: with four squadrons wanting missions one is held on CAP; a control module removes the hold', () => {
    const sq = run(undefined);
    const tasks = sq.map(q => q.stats.tasks);
    expect(tasks.reduce((a, t) => a + t[1], 0)).toBeGreaterThan(0);               // strikes
    expect(sq.reduce((a, q) => a + q.stats.held, 0)).toBeGreaterThan(0);             // the limit bit
    const ctl = run(air('air_control'));
    expect(ctl.reduce((a, q) => a + q.stats.held, 0)).toBe(0);
  });

  it('escort: fighters cover a friendly ship that enemy bombers go for; interceptors intercept near the carrier', () => {
    const w = new World(setup(
      G([...S('carrier', 'air_group', 1), ...S('cruiser', 'multi', 2)]),
      G([...S('carrier', 'air_group', 1), ...S('cruiser', 'multi', 1)], 'engage', 'krause'), 11));
    while (!w.outcome && w.time < 150) w.step();
    const sq = w.craft!.squads;
    const sum = (k: number) => sq.reduce((a, q) => a + q.stats.tasks[k], 0);
    expect(sum(3)).toBeGreaterThan(0);   // ESCORT
    expect(sum(2)).toBeGreaterThan(0);   // AIR
    for (const q of sq) expect(q.stats.tasks.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});

describe('P16.3 carrier combat computer', () => {
  const trial = (cpu: boolean, seed: number) => {
    const w = new World(setup(G([...S('carrier', 'air_group', 1, cpu ? CPU : {}), ...S('cruiser', 'multi', 2)]), G(S('cruiser', 'multi', 3), 'engage', 'krause'), seed));
    const car = carrierOf(w);
    let minD = Infinity;
    while (!w.outcome && w.time < 150 && car.state === 'alive') { w.step(); if (w.tick % 30 === 0) for (const s of w.ships) if (s.team !== car.team && s.state === 'alive') minD = Math.min(minD, s.pos.distTo(car.pos)); }
    return { minD, hp: car.hp / car.maxHp };
  };

  it('keeps the carrier further from enemy guns and in better shape than basic control (3 seeds)', () => {
    for (const seed of [7, 8, 9]) {
      const a = trial(false, seed), b = trial(true, seed);
      expect(b.minD).toBeGreaterThan(a.minD);
      expect(b.hp).toBeGreaterThan(a.hp);
    }
  });

  it('without strike craft the carrier computer falls back to basic control (same battle)', () => {
    const lo = getLoadout('carrier', 'air_group');
    const fit = { name: 'guns', mounts: lo.mounts.filter(m => WEAPONS[m.weapon].kind !== 'craft') };
    const mk = (cpu: boolean) => { const w = new World(setup(G(S('carrier', 'air_group', 1, { fit, ...(cpu ? CPU : {}) })), G(S('cruiser', 'multi', 1), 'engage', 'krause'))); while (!w.outcome && w.time < 60) w.step(); return w.digest(); };
    expect(mk(true)).toBe(mk(false));
  });
});

describe('P16.3 officer effects: gun officers do not boost craft; air-wing effects do', () => {
  const hit = (ofx: Record<string, number> | undefined, kind: string) => {
    const w = new World(setup(G(S('carrier', 'air_group', 1)), G(S('cruiser', 'multi', 1), 'engage', 'krause')));
    const a = carrierOf(w), t = w.ships.find(s => s.team === 1)!;
    a.ofx = ofx;
    const g = WEAPONS.wing_fighter.craft!.gun!;
    const gun: WeaponDef = { ...WEAPONS.wing_fighter, kind: 'shell', damage: g.damage, pen: g.pen, range: g.range, reload: g.reload, salvo: 1 };
    const hp0 = t.hp;
    for (let i = 0; i < 40; i++) w.applyHit(t, gun, a.id, t.pos.clone(), new Vec3(0, 0, 1), kind);
    return hp0 - t.hp;
  };

  it('pen / crit / damage officer effects change a ship gun hit but not a craft hit', () => {
    const gunOfx = { pen: 0.5, crit: 0.5, dmgCap: 0.3, dmgSmall: 0.3, rearDmg: 0.3 };
    expect(hit(gunOfx, 'craft')).toBe(hit(undefined, 'craft'));
    expect(hit(gunOfx, 'shell')).not.toBe(hit(undefined, 'shell'));
  });
  it('the air-wing extension point (ofx.airDmg) raises craft damage only', () => {
    expect(hit({ airDmg: 0.5 }, 'craft')).toBeGreaterThan(hit(undefined, 'craft'));
    expect(hit({ airDmg: 0.5 }, 'shell')).toBe(hit(undefined, 'shell'));
  });
});

describe('P16.3 combat rating and light battle resolution', () => {
  const cls = SHIP_CLASSES.carrier, std = cls.loadouts[0];
  const noCraft = { ...std, mounts: std.mounts.filter(m => WEAPONS[m.weapon].kind !== 'craft') };

  it('the carrier rating counts its air group and aviation modules; other ships are unchanged', () => {
    expect(rate({ cls, lo: std }).off).toBeGreaterThan(rate({ cls, lo: noCraft }).off * 1.5);
    expect(rate({ cls, lo: std, fx: air('air_hangar_ext') }).cr).toBeGreaterThan(rate({ cls, lo: std }).cr);
    expect(rate({ cls, lo: std, fx: air('air_maint') }).cr).toBeGreaterThan(rate({ cls, lo: std }).cr);
    expect(rateClass('cruiser')).toBeCloseTo(139.16, 1);   // the reference scale (K) is unchanged
    const c = rateClass('carrier');
    expect(c).toBeGreaterThan(rateClass('cruiser'));
    expect(c).toBeLessThan(rateClass('battleship'));
  });

  it('airValueMul: 1 for the standard air group and every non-carrier; lower without craft, higher with modules', () => {
    expect(airValueMul(cls, std)).toBe(1);
    for (const id of ['frigate', 'destroyer', 'cruiser', 'battleship']) { const c = SHIP_CLASSES[id]; for (const lo of c.loadouts) expect(airValueMul(c, lo, { air: { complement: 9 } })).toBe(1); }
    expect(airValueMul(cls, noCraft)).toBeLessThan(0.8);
    expect(airValueMul(cls, noCraft)).toBeGreaterThanOrEqual(0.3);
    expect(airValueMul(cls, std, air('air_hangar_ext', 'air_maint'))).toBeGreaterThan(1.05);
    expect(airValueMul(cls, std, { air: { complement: 50 } })).toBe(1.6);   // clamp
  });

  it('world quick resolution: a carrier is weighted by its air group, other ships by their value as before', () => {
    const sim = WorldSim.create(71, { ...STANDARD_WORLD });
    sim.addPlayer('경량 판정');
    const s = Object.values(sim.st.ships).find(x => SHIP_CLASSES[x.classId]?.loadouts.length)!;
    const g = sim.st.groups[s.groupId];
    const av = (x: typeof s) => (sim as any).airValue(x, g) as number;
    expect(av(s)).toBe(1);
    const c = structuredClone(s); Object.assign(c, { classId: 'carrier', loadoutId: 'air_group', hull: undefined, variant: undefined, fitting: undefined, fit: [] });
    expect(av(c)).toBeCloseTo(1, 9);   // standard air group (NPC: no fitting effects)
  });
});

describe('P16.3 preview gate: carrier gear is neither produced, bought nor researched from salvage', () => {
  const CRAFT = CARRIER_ARMS.map(a => a.id), AIR = CARRIER_MODULES.map(m => m.id);

  it('gearReleased: craft weapons, aviation modules and the carrier computer wait for a released carrier; other gear is unaffected', () => {
    for (const id of [...CRAFT, ...AIR]) expect(gearReleased(id)).toBe(false);
    for (const id of ['eq_medium_gun', 'mod_fcs', 'cpu_line', 'cpu_generic']) expect(gearReleased(id)).toBe(true);
    const h = CONTENT.hulls[CARRIER_HULL];
    const released: Registry = { ...CONTENT, hulls: { ...CONTENT.hulls, [CARRIER_HULL]: { ...h, preview: undefined } } };
    for (const id of [...CRAFT, ...AIR]) expect(gearReleased(id, released)).toBe(true);
  });

  it('production orders and market purchases are refused; salvage research skips them', () => {
    const sim = WorldSim.create(61, { ...STANDARD_WORLD });
    const p = sim.addPlayer('항모 운용 검증');
    const co = sim.st.companies[p]; co.credits = 50_000_000; co.tech = [...(co.tech ?? []), 'combined_arms', 'torpedo_casting', 'pd_network', 'modular_assembly', 'long_sensors', 'damage_control'];
    const own = Object.values(sim.st.stations).find(s => s.owner === p) ?? (() => { const x = sim.st.stations.helios; return x; })();
    for (const id of [...CRAFT, ...AIR]) {
      const r = Object.values(RECIPES).find(x => (x.out[id] ?? 0) > 0)!;
      expect(r).toBeDefined();
      const res = sim.command(p, { c: 'prodOrder', station: own.id, recipe: r.id, mode: 'count', n: 1 } as any);
      if (own.owner === p) expect(res).toMatch(/공개 선체가 없어 생산할 수 없음/);
      // no market stocks it; even a row that appeared (e.g. an early migration) does not sell it
      expect(sim.command(p, { c: 'buy', station: 'helios', res: id, amount: 1 } as any)).toBe('거래 불가');
      sim.st.stations.helios.market![id] = { ...Object.values(sim.st.stations.helios.market!)[0], stock: 5 };
      expect(sim.command(p, { c: 'buy', station: 'helios', res: id, amount: 1 } as any)).toMatch(/공개 선체가 없어 구매할 수 없음/);
    }
    for (const t of ['combined_arms', 'torpedo_casting', 'pd_network', 'modular_assembly', 'long_sensors', 'damage_control']) {
      const it = salvageItem(t); if (it) expect([...CRAFT, ...AIR]).not.toContain(it);
    }
  });

  it('craft weapons carry no hourly supply upkeep (P16: the chemicals 0.8 was removed)', () => {
    for (const id of CRAFT) expect(EQUIPMENT[id].supply).toBeUndefined();
  });

  it('dev lab: the carrier appears and validates only in an experiment with rules 3, which reaches the battle setup', () => {
    expect(availableHulls().map(h => h.id)).not.toContain(CARRIER_HULL);
    expect(availableHulls(3).map(h => h.id)).toContain(CARRIER_HULL);
    const cfg = defaultConfig();
    cfg.sides[0].root.ships = [defaultShip(CARRIER_HULL, 'car1', undefined, 3)];
    expect(configProblems(cfg).join('\n')).toMatch(/전투 규칙 3/);
    cfg.rules = 3;
    expect(configProblems(cfg)).toEqual([]);
    expect(battleSetup(cfg).rules).toBe(3);
    expect(configProblems({ ...cfg, rules: 2 }).join('\n')).toMatch(/기본값 또는 3/);
    const w = new World(battleSetup(cfg));
    expect(w.craft).not.toBeNull();
  });
});

describe('P16.3 migration preparation (not executed on any world)', () => {
  it('refused while the carrier is a preview; with the release override only carrier gear rows are added, once', () => {
    const sim = WorldSim.create(62, { ...STANDARD_WORLD });
    const snap = JSON.stringify(sim.st);
    const r = migrateCarriers(sim.st);
    expect(r.applied).toBe(false); expect(r.reason).toMatch(/미공개/);
    expect(JSON.stringify(sim.st)).toBe(snap);
    const ok = migrateCarriers(sim.st, { released: true });
    expect(ok.applied).toBe(true); expect(ok.markets).toBeGreaterThan(0);
    for (const [sid, ids] of Object.entries(CARRIER_MARKETS)) for (const id of ids) expect(sim.st.stations[sid].market![id]).toBeDefined();
    expect(migrateCarriers(sim.st, { released: true }).applied).toBe(false);
  });
});

describe('P16.3 determinism with carrier operations', () => {
  it('same setup (computer, modules, escorts, enemy carrier) → same digest', () => {
    const mk = () => { const w = new World(setup(G([...S('carrier', 'air_group', 1, { ...CPU, fx: air('air_control', 'air_maint', 'air_hangar_ext') }), ...S('cruiser', 'multi', 1)]), G([...S('carrier', 'air_group', 1, CPU), ...S('destroyer', 'aa', 2)], 'engage', 'krause'), 13)); while (!w.outcome && w.time < 90) w.step(); return w.digest(); };
    expect(mk()).toBe(mk());
  });
});
