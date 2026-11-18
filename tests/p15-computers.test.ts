// P15.1 combat computers (BattleSetup.rules 2): computer bay and equipment, fitting → ShipSpec wiring, the
// per-computer movement behaviours, order priority, off-role fits and rules 0/1 compatibility.
// docs/P15_1_COMBAT_COMPUTERS.md
import { CARRIER_MODULES } from '../src/content/packs/growth/carrier';
import { describe, expect, it } from 'vitest';
import { World, BATTLE_RULES } from '../src/sim/world';
import { orderAllows, cpuSummary, cpuRange, bandsOf, CPU_ACTIVE, type CpuArch } from '../src/sim/ai/computer';
import { WEAPONS } from '../src/sim/data/weapons';
import type { FleetSpec, ShipSpec, GroupSpec } from '../src/sim/fleet';
import type { Ship, Group, Order } from '../src/sim/types';
import { CONTENT } from '../src/content/registry';
import { bayAccepts } from '../src/content/rules';
import { validateContent } from '../src/content/validate';
import { EQUIPMENT } from '../src/world/industry';
import { cpuOfFitting } from '../src/world/fitting';
import { CPU_MODULES, CPU_MARKETS } from '../src/content/packs/growth/computers';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { migrateComputers } from '../src/world/industrialGear';

const S = (c: string, l: string, n: number, cpu?: CpuArch): ShipSpec[] =>
  Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...(cpu && cpu !== 'basic' ? { cpu: { id: `cpu_${cpu}`, arch: cpu } } : {}) }));
const G = (ships: ShipSpec[], order: GroupSpec['order'] = 'engage', cmd = 'wolf'): GroupSpec => ({ name: 'g', commanderId: cmd, order, retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec): FleetSpec => ({ name: 'x', root: g });
const world = (a: GroupSpec, b: GroupSpec, rules = BATTLE_RULES, seed = 2) => new World({ seed, scenarioId: 'p151', fleets: [F(a), F(b)], rules });
const nearest = (w: World, s: Ship) => Math.min(...w.ships.filter(e => e.state === 'alive' && w.hostile(s.team, e.team)).map(e => e.pos.distTo(s.pos)));
/** mean distance from team 0 to its nearest enemy between t0 and t1 seconds */
function meanRange(w: World, t0: number, t1: number) {
  let sum = 0, n = 0;
  while (!w.outcome && w.time < t1) {
    w.step();
    if (w.time >= t0 && w.tick % 30 === 0) for (const s of w.ships) if (s.team === 0 && s.state === 'alive') { sum += nearest(w, s); n++; }
  }
  return sum / Math.max(1, n);
}
function digest(w: World, T: number) {
  while (!w.outcome && w.time < T) w.step();
  return w.ships.map(s => `${s.id}:${s.hp.toFixed(3)}:${s.pos.x.toFixed(3)},${s.pos.z.toFixed(3)}:${s.state}`).join('|') + `#${w.tick}`;
}

describe('P15.1 content: computer bay and equipment', () => {
  it('every combat hull gets exactly one computer bay; civilian, platform and exclusive hulls do not', () => {
    expect(BATTLE_RULES).toBe(2);
    for (const h of Object.values(CONTENT.hulls)) {
      const n = h.internals.filter(b => b.kind === 'computer').length;
      expect(n, h.id).toBeLessThanOrEqual(1);
      if (h.exclusive || h.classId === 'platform') expect(n, h.id).toBe(0);
    }
    for (const id of ['frigate', 'destroyer', 'cruiser', 'battleship', 'corvette']) {
      const hs = Object.values(CONTENT.hulls).filter(h => h.classId === id && !h.exclusive);
      expect(hs.length, id).toBeGreaterThan(0);
      for (const h of hs) expect(h.internals.filter(b => b.kind === 'computer').length, h.id).toBe(1);
    }
  });

  it('a computer goes only in the computer bay, and the computer bay takes only computers (no hull-class limit)', () => {
    const cpuBay = { id: 'cpu1', kind: 'computer' as const, size: 'S' as const };
    for (const m of CPU_MODULES) {
      expect(bayAccepts(cpuBay, m.id), m.id).toBeNull();
      expect(bayAccepts({ id: 'x', kind: 'special', size: 'L' }, m.id)).not.toBeNull();
      expect(bayAccepts({ id: 'x', kind: 'fcs', size: 'L' }, m.id)).not.toBeNull();
      expect(EQUIPMENT[m.id]?.cpu?.arch).toBe(m.cpu!.arch);
    }
    expect(bayAccepts(cpuBay, 'mod_fcs')).not.toBeNull();
    // the existing modules keep their own effect and bay
    expect(EQUIPMENT.mod_fcs.cpu).toBeUndefined();
    expect(EQUIPMENT.mod_pd.cpu).toBeUndefined();
    // the same computer is accepted on a corvette and on a battleship hull alike
    for (const cls of ['corvette', 'battleship']) {
      const h = Object.values(CONTENT.hulls).find(x => x.classId === cls && !x.exclusive)!;
      const bay = h.internals.find(b => b.kind === 'computer')!;
      expect(bayAccepts(bay, 'cpu_siege'), h.id).toBeNull();
      expect(bayAccepts(bay, 'cpu_swarm'), h.id).toBeNull();
    }
  });

  it('content validates and the product id is separate from the behaviour', () => {
    expect(validateContent(CONTENT).filter(i => i.level === 'error')).toEqual([]);
    // P16.3: the carrier computer is a product of the carrier pack (preview-gated with the carrier gear)
    const archs = new Set([...CPU_MODULES, ...CARRIER_MODULES.filter(m => m.cpu)].map(m => m.cpu!.arch));
    for (const a of CPU_ACTIVE) expect(archs.has(a), a).toBe(true);
    expect(CPU_MODULES.filter(m => m.cpu!.arch === 'line').map(m => m.id).sort()).toEqual(['cpu_generic', 'cpu_line']);
    for (const ids of Object.values(CPU_MARKETS)) for (const id of ids) expect(EQUIPMENT[id], id).toBeTruthy();
  });

  it('the fitted computer reaches the ShipSpec; an empty bay means basic control', () => {
    expect(cpuOfFitting({ hp: {}, bay: {} })).toBeUndefined();
    expect(cpuOfFitting({ hp: {}, bay: { int1: 'mod_fcs' } })).toBeUndefined();
    expect(cpuOfFitting({ hp: {}, bay: { int1: 'mod_fcs', cpu1: 'cpu_generic' } })).toEqual({ id: 'cpu_generic', arch: 'line', react: 1.6 });
    expect(cpuOfFitting({ hp: {}, bay: { cpu1: 'cpu_siege' } })).toEqual({ id: 'cpu_siege', arch: 'siege' });
  });

  it('the standard world stocks the computers at public stations', () => {
    const sim = WorldSim.create(3, { ...STANDARD_WORLD });
    expect(sim.st.cpuV).toBe(1);
    const st = sim.st.stations;
    for (const [sid, ids] of Object.entries(CPU_MARKETS)) if (st[sid]?.public && st[sid].market) for (const id of ids) expect(st[sid].market![id], `${sid}/${id}`).toBeTruthy();
  });
});

describe('P15.1.1 existing-world migration (COMPUTERS_P151_MIGRATE)', () => {
  it('adds only the computer market rows, once; pre-growth worlds are refused', () => {
    const { computers: _c, ...legacy } = STANDARD_WORLD;
    const sim = WorldSim.create(5, legacy);
    expect(sim.st.cpuV).toBeUndefined();
    const before = JSON.parse(JSON.stringify(sim.st));
    const r = migrateComputers(sim.st);
    expect(r.applied).toBe(true);
    expect(r.markets).toBe(Object.entries(CPU_MARKETS).filter(([sid]) => before.stations[sid]?.public && before.stations[sid]?.market).reduce((n, [, ids]) => n + ids.length, 0));
    const after = JSON.parse(JSON.stringify(sim.st));
    for (const sid of Object.keys(after.stations)) {
      const m0 = before.stations[sid].market ?? {}, m1 = after.stations[sid].market ?? {};
      for (const k of Object.keys(m1)) if (!k.startsWith('cpu_')) expect(m1[k], `${sid}/${k}`).toEqual(m0[k]);
    }
    delete after.cpuV; for (const st of Object.values<any>(after.stations)) if (st.market) for (const k of Object.keys(st.market)) if (k.startsWith('cpu_')) delete st.market[k];
    expect(after).toEqual(before);
    expect(migrateComputers(sim.st)).toMatchObject({ applied: false, reason: '이미 적용됨' });
    const old = structuredClone(before); old.contentV = 2;
    expect(migrateComputers(old).applied).toBe(false);
  });
});

describe('P15.1 range bands and UI summary', () => {
  it('bands come from the usable weapons as min / median / max, and the UI uses the same aim distance', () => {
    const rows = [{ w: WEAPONS.heavy_cannon, f: 0, arc: 150 }, { w: WEAPONS.autocannon, f: 0, arc: 150 }];
    const b = bandsOf(rows, () => false);
    expect(b.min).toBeLessThanOrEqual(b.med);
    expect(b.med).toBeLessThanOrEqual(b.max);
    expect(cpuRange('artillery', b)).toBeCloseTo(b.max * 0.9, 5);
    expect(cpuRange('swarm', b)).toBeCloseTo(b.min * 0.6, 5);
    expect(cpuRange('siege', b)).toBeNull();          // no torpedo: siege falls back
    const ui = cpuSummary('artillery', [{ weapon: 'heavy_cannon', facing: 0, arc: 150 }], WEAPONS);
    expect(ui).toContain(`${Math.round(WEAPONS.heavy_cannon.range * 0.9)}m`);
    expect(cpuSummary('siege', [{ weapon: 'heavy_cannon', facing: 0, arc: 150 }], WEAPONS)).toContain('기본 제어');
  });
});

describe('P15.1 orders come first', () => {
  const g = (phase?: string) => ({ ai: { phase } } as unknown as Group);
  const o = (type: Order['type']) => ({ type } as Order);
  it('engage / attack let the computer act; move, hold, reserve and retreat never do; flank only on the strike', () => {
    for (const a of CPU_ACTIVE) {
      expect(orderAllows(g(), o('engage'), a)).toBe(true);
      expect(orderAllows(g(), o('attack'), a)).toBe(true);
      for (const t of ['move', 'hold', 'reserve', 'retreat'] as Order['type'][]) expect(orderAllows(g(), o(t), a), `${a}/${t}`).toBe(false);
      expect(orderAllows(g('transit'), o('flank'), a)).toBe(false);
      expect(orderAllows(g('strike'), o('flank'), a)).toBe(true);
      expect(orderAllows(g(), o('escort'), a)).toBe(a === 'picket');
    }
  });

  it('a group on hold keeps basic control whatever computer it carries', () => {
    const w = world(G(S('cruiser', 'multi', 2, 'artillery'), 'hold'), G(S('destroyer', 'aa', 2)));
    for (let i = 0; i < 30 * 20; i++) w.step();
    const mine = w.ships.filter(s => s.team === 0);
    expect(mine.every(s => s.cpu)).toBe(true);
    expect(mine.every(s => s.cpu!.acting === 'basic')).toBe(true);
  });
});

describe('P15.1 behaviour differs by computer (rules 2)', () => {
  it('artillery holds the long band, swarm closes in, compared with basic control', () => {
    const r: Record<string, number> = {};
    for (const a of ['basic', 'swarm', 'artillery'] as CpuArch[]) r[a] = meanRange(world(G(S('cruiser', 'multi', 3, a)), G(S('destroyer', 'aa', 8), 'hold', 'vorn')), 40, 90);
    expect(r.artillery).toBeGreaterThan(r.basic + 80);
    expect(r.swarm).toBeLessThan(r.basic - 40);
  });

  it('a siege corvette makes torpedo runs from the beam and breaks away; basic control does not', () => {
    const runs = (a: CpuArch) => {
      const w = world(G(S('corvette', 'torp', 4, a), 'engage', 'kostov'), G([...S('battleship', 'std', 1), ...S('destroyer', 'aa', 2)], 'engage', 'vorn'));
      for (let i = 0; i < 30 * 90 && !w.outcome; i++) w.step();
      return w.ships.filter(s => s.team === 0).reduce((n, s) => n + (s.cpu?.breaks ?? 0), 0);
    };
    expect(runs('basic')).toBe(0);
    expect(runs('siege')).toBeGreaterThan(0);
  });

  it('a mixed line stands where every member reaches: cruisers in a battleship line keep their guns in range (P15.1.1)', () => {
    const w = world(G([...S('battleship', 'std', 2, 'line'), ...S('cruiser', 'multi', 2, 'line')]), G([...S('battleship', 'std', 2), ...S('cruiser', 'multi', 2)], 'engage', 'vorn'), BATTLE_RULES, 11);
    const ds: number[] = [];
    while (!w.outcome && w.time < 70) {
      w.step();
      if (w.time > 35 && w.tick % 30 === 0) for (const s of w.ships) if (s.team === 0 && s.cls.id === 'cruiser' && s.state === 'alive' && s.cpu?.acting === 'line') {
        const t = w.shipById.get(s.ai.targetId); if (t && t.state === 'alive') ds.push(t.pos.distTo(s.pos));
      }
    }
    expect(ds.length).toBeGreaterThan(10);
    const med = w.ships.find(s => s.team === 0 && s.cls.id === 'cruiser')!.cpu!.bands!.med;
    expect(ds.reduce((a, b) => a + b, 0) / ds.length).toBeLessThan(med * 1.02);
  });

  it('a siege boat breaks across and away from its target, not onward past it (P15.1.1)', () => {
    const w = world(G(S('corvette', 'torp', 4, 'siege'), 'engage', 'kostov'), G(S('battleship', 'std', 1), 'engage', 'vorn'), BATTLE_RULES, 11);
    const start = new Map<number, number>(), gain: number[] = [];
    while (!w.outcome && w.time < 90) {
      w.step();
      for (const s of w.ships) if (s.team === 0 && s.state === 'alive' && s.cpu) {
        const t = w.shipById.get(s.ai.targetId); if (!t) continue;
        const d = t.pos.distTo(s.pos);
        if (s.cpu.mode === 'break' && !start.has(s.id)) start.set(s.id, d);
        if (s.cpu.mode !== 'break' && start.has(s.id)) { gain.push(d - start.get(s.id)!); start.delete(s.id); }
      }
    }
    expect(gain.length).toBeGreaterThan(3);
    // a break ends farther from the target than it started
    expect(gain.filter(g => g > 0).length / gain.length).toBeGreaterThan(0.8);
  });

  it('an off-role fit falls back to basic control and fights normally', () => {
    // a battleship without torpedoes carrying a siege computer behaves exactly like basic control
    const a = digest(world(G(S('dreadnought', 'std', 1, 'siege')), G(S('battleship', 'std', 2), 'engage', 'vorn')), 60);
    const b = digest(world(G(S('dreadnought', 'std', 1)), G(S('battleship', 'std', 2), 'engage', 'vorn')), 60);
    expect(a).toBe(b);
  });

  it('rules 2 battles with computers are deterministic', () => {
    const mk = () => world(G(S('destroyer', 'strike', 3, 'picket')), G(S('corvette', 'torp', 4, 'swarm'), 'engage', 'rask'), 2, 9);
    expect(digest(mk(), 45)).toBe(digest(mk(), 45));
  });
});

describe('P15.1 compatibility: rules 0 / 1 ignore the computer', () => {
  it('a computer in the ShipSpec changes nothing under rules 0 and 1', () => {
    for (const rules of [0, 1]) {
      const a = digest(world(G(S('cruiser', 'multi', 2, 'artillery')), G(S('destroyer', 'aa', 3)), rules), 40);
      const b = digest(world(G(S('cruiser', 'multi', 2)), G(S('destroyer', 'aa', 3)), rules), 40);
      expect(a).toBe(b);
      const w = world(G(S('cruiser', 'multi', 2, 'artillery')), G(S('destroyer', 'aa', 3)), rules);
      expect(w.ships.some(s => s.cpu)).toBe(false);
    }
  });
});
