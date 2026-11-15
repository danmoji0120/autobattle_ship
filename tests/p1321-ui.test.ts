// P13.2.1 §7 — the status words follow what a group is really working on (display only):
// a sunk ship's wreck → 전장 잔해 인양, a jettisoned container → 투하 화물 회수,
// a container it plundered → 약탈품 회수 중, carrying the plunder to a warehouse → 회수품 하역 중.
// Every case runs the real engines (real wreck from makeWrecks, real demand → jettison, real recovery order).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { V, WShip, WGroup, Cargo } from '../src/world/types';
import { demand } from '../src/world/piracy';
import { makeWrecks } from '../src/world/wrecks';
import { salvLabel } from '../src/world/salvage';
import { groupSalvageHtml } from '../src/client/strategic/salvageUi';
import { groupPiracyHtml } from '../src/client/strategic/piracyUi';

function fixture(seed = 1321) {
  const sim = WorldSim.create(seed, { piracy: 'p132' });
  const [A, B, C] = ['약탈 PMC', '수송 PMC', '인양 PMC'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 10;
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e7;
  const a = sim.st.stations.astra;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, C, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: string[]): WGroup {
  const g = f.sim.newGroup(owner, '편대'); g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => f.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
/** run and collect every distinct status line and fleet-panel salvage tag the group shows */
function watch(f: F, g: WGroup, seconds: number, stop: () => boolean = () => false) {
  const status = new Set<string>(), tags = new Set<string>();
  for (let t = 0; t < seconds && !stop(); t += .5) {
    f.sim.update(.5);
    if (g.status) status.add(g.status.split(' — ')[0].split(':')[0]);
    if (g.salv) { const L = salvLabel(f.sim.st, g.salv); tags.add(L.head); }
  }
  return { status: [...status], tags: [...tags] };
}
function loaded(f: F, pos: V, cargo: Cargo) {
  const g = fleet(f, f.B, pos, ['hauler']); const h = ships(f, g)[0]; Object.assign(h.cargo, cargo); h.logisticsExcluded = true; g.piracyPolicy = 'survive';
  return { g, h };
}

describe('P13.2.1 §7 status words follow the real target', () => {
  it('U01: a sunk ship wreck reads 전장 잔해 인양 (never 투하 화물 / 약탈품)', () => {
    const f = fixture(); f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    const src = loaded(f, f.at(6000, 0), { metal: 300 });
    const [w] = makeWrecks(f.sim.st, 'e_ui', [{ ship: src.h, pos: src.h.pos }], f.sim.time, () => f.sim.rng.next(), [f.B]);
    src.g.shipIds = []; delete f.sim.st.ships[src.h.id]; w.seen.push(f.C);
    const g = fleet(f, f.C, f.at(2000, 0), ['hauler']);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } })).toBeNull();
    const seen = watch(f, g, 300, () => g.salv?.phase === 'work' && !!g.status);
    expect(seen.tags).toEqual(['전장 잔해 인양']);
    expect(g.status).toMatch(/^전장 잔해 인양: 인양 중/);
    expect(groupSalvageHtml(f.sim.st as any, g)).toContain('전장 잔해 인양');
    expect(seen.status.some(s => /투하 화물|약탈품/.test(s))).toBe(false);
  });

  it('U02: a jettisoned container recovered by an ordinary recover order reads 투하 화물 회수', () => {
    const f = fixture(); f.sim.command(f.A, { c: 'stance', target: f.B, v: -1 }); f.sim.command(f.C, { c: 'stance', target: f.B, v: -1 });
    const v = loaded(f, f.at(10000, -20000), { metal: 300 });
    const ra = fleet(f, f.A, f.at(10000, -20800), ['destroyer', 'destroyer']);
    const r = demand(f.sim, ra, v.h) as any; expect(r.response).toBe('comply');
    f.sim.st.drops![r.drop.id].seen.push(f.C);
    const g = fleet(f, f.C, f.at(10000, -17000), ['hauler']);
    expect(f.sim.command(f.C, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: r.drop.id } })).toBeNull();
    const seen = watch(f, g, 300, () => g.salv?.phase === 'work' && !!g.status);
    expect(seen.tags).toEqual(['투하 화물 회수']);
    expect(g.status).toMatch(/^투하 화물 회수: 회수 중/);
    expect(seen.status.some(s => /전장 잔해|약탈품|인양 중/.test(s))).toBe(false);
  });

  it('U03/U04: a plunder recovering its container reads 약탈품 회수 중, then 회수품 하역 중 on the way to the warehouse', () => {
    const f = fixture(); f.sim.command(f.A, { c: 'stance', target: f.B, v: -1 });
    const v = loaded(f, f.at(10000, -25000), { metal: 300 });
    f.sim.command(f.B, { c: 'setOp', group: v.g.id, op: { k: 'move', to: f.at(4000, -25000) } });
    const ra = fleet(f, f.A, f.at(10000, -21000), ['destroyer', 'frigate', 'hauler']);
    expect(f.sim.command(f.A, { c: 'setOp', group: ra.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } })).toBeNull();
    const seen = watch(f, ra, 2400, () => !ra.plx && ra.op.k === 'idle');
    expect(seen.tags).toContain('약탈품 회수 중'); expect(seen.tags).toContain('회수품 하역 중');
    expect(seen.tags.some(t => /전장 잔해|투하 화물 회수/.test(t))).toBe(false);
    expect(seen.status).toContain('약탈품 회수 중'); expect(seen.status).toContain('회수품 하역 중');
    expect(seen.status.some(s => /^(지정 인양|약탈품 회수$)/.test(s))).toBe(false);
    // the plunder really reached a warehouse (the words are not the only thing that happened)
    const stored = Object.values(f.sim.st.stations).reduce((n, st) => n + (st.storage[f.A]?.metal ?? 0), 0);
    expect(stored).toBeGreaterThan(0); expect(stored + (v.h.cargo.metal ?? 0)).toBe(300);
  });

  it('U05: the raid panel phase words', () => {
    const f = fixture();
    const ra = fleet(f, f.A, f.at(0, 0), ['destroyer', 'hauler']);
    ra.op = { k: 'plunder', group: 'x', policy: 'nonlethal' } as any;
    ra.plx = { key: 'k', phase: 'collect', since: 0, next: 0 } as any;
    expect(groupPiracyHtml(f.sim.st as any, f.A, ra, 'nonlethal', false, true)).toContain('약탈품 회수 중');
    ra.plx!.phase = 'loot';
    expect(groupPiracyHtml(f.sim.st as any, f.A, ra, 'nonlethal', false, true)).toContain('전장 잔해 인양');
  });
});
