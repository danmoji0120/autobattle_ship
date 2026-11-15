// P13.2.2 — a separate recovery fleet assigned to a raid (op lootTender): its free hold counts in the victim's
// judgement only when it is really close (PIR.tenderR) and assigned to that very raid; it never adds attack.
// It follows the raid, recovers the containers that raid made jettison with the real salvage engine, unloads
// them into a warehouse and is a party of the plunder truce. Validation, end of the raid, save/restore.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { V, WGroup, WShip, Cargo } from '../src/world/types';
import { demand, judge, wanted, recoveryRoom, tendersNear, truceBlocks, dropUnits, PIR } from '../src/world/piracy';
import { salvageRoom } from '../src/world/salvage';
import { groupPiracyHtml } from '../src/client/strategic/piracyUi';

function fixture(seed = 1322) {
  const sim = WorldSim.create(seed, { piracy: 'p132' });
  const [A, B, C] = ['약탈 PMC', '수송 PMC', '제3 PMC'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 10;
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e7;
  sim.command(A, { c: 'stance', target: B, v: -1 } as any);
  const a = sim.st.stations.astra;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, C, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: string[], name = '편대'): WGroup {
  const g = f.sim.newGroup(owner, name); g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => f.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
const run = (sim: WorldSim, seconds: number, stop: () => boolean = () => false) => { for (let t = 0; t < seconds && !stop(); t += .5) sim.update(.5); };
function victim(f: F, pos: V, cargo: Cargo = { metal: 600 }, policy: 'survive' | 'balanced' | 'protect' = 'balanced') {
  const g = fleet(f, f.B, pos, ['hauler'], 'B 수송'); g.piracyPolicy = policy;
  const h = ships(f, g)[0]; Object.assign(h.cargo, cargo); h.logisticsExcluded = true;
  return { g, h };
}
const stored = (f: F, co: string, item: string) => Object.values(f.sim.st.stations).reduce((n, st) => n + (st.storage[co]?.[item] ?? 0), 0);
const held = (f: F, g: WGroup, item: string) => ships(f, g).reduce((n, s) => n + (s.cargo[item] ?? 0), 0);
const tender = (f: F, raid: WGroup, pos: V, comp = ['hauler', 'hauler']) => {
  const t = fleet(f, f.A, pos, comp, 'A 회수'); for (const s of ships(f, t)) s.logisticsExcluded = true;
  expect(f.sim.command(f.A, { c: 'setOp', group: t.id, op: { k: 'lootTender', group: raid.id } })).toBeNull();
  return t;
};

describe('P13.2.2 split recovery fleet (lootTender)', () => {
  it('X01: an assigned tender close to the victim raises recovery (hold), never attack; far / unassigned / other raid do not count', () => {
    const f = fixture();
    const v = victim(f, f.at(15000, 10000));
    const raid = fleet(f, f.A, f.at(15000, 9200), ['destroyer', 'destroyer'], 'A 약탈');
    const want = wanted(f.sim, v.h, 'part');
    const base = judge(f.sim, raid, v.g, v.h, want);
    // another raid's tender and an unassigned hauler right next to the victim: no effect
    const other = fleet(f, f.A, f.at(30000, 30000), ['destroyer'], 'A 다른 약탈');
    const t2 = tender(f, other, f.at(15500, 9500));
    const idle = fleet(f, f.A, f.at(15600, 9500), ['hauler'], 'A 대기 수송');
    expect(recoveryRoom(f.sim, raid, v.h.pos)).toBe(ships(f, raid).reduce((a, s) => a + salvageRoom(f.sim, s), 0));
    // the assigned tender beyond tenderR: no effect
    const t = tender(f, raid, f.at(15000 + PIR.tenderR + 600, 10000));
    expect(tendersNear(f.sim, raid, v.h.pos)).toEqual([]);
    expect(judge(f.sim, raid, v.g, v.h, want).recovery).toBeCloseTo(base.recovery, 9);
    // move it inside tenderR: counted
    for (const s of ships(f, t)) s.pos = { ...s.pos, x: v.h.pos.x + 2500 };
    expect(tendersNear(f.sim, raid, v.h.pos).map(g => g.id)).toEqual([t.id]);
    const room0 = ships(f, raid).reduce((a, s) => a + salvageRoom(f.sim, s), 0);
    const roomT = ships(f, t).reduce((a, s) => a + salvageRoom(f.sim, s), 0);
    expect(recoveryRoom(f.sim, raid, v.h.pos)).toBeCloseTo(room0 + roomT, 6);
    const j = judge(f.sim, raid, v.g, v.h, want);
    expect(base.recovery).toBeLessThan(1);
    expect(j.recovery).toBeGreaterThan(base.recovery);
    expect(j.attack).toBe(base.attack);                 // no combat power from the tender
    expect(j.defense).toBe(base.defense);
    void t2; void idle;
  });

  it('X02: a fleeing or full tender adds nothing', () => {
    const f = fixture();
    const v = victim(f, f.at(15000, 10000));
    const raid = fleet(f, f.A, f.at(15000, 9200), ['destroyer', 'destroyer'], 'A 약탈');
    const t = tender(f, raid, f.at(16000, 9200));
    const room0 = ships(f, raid).reduce((a, s) => a + salvageRoom(f.sim, s), 0);
    t.fleeing = true;
    expect(recoveryRoom(f.sim, raid, v.h.pos)).toBe(room0);
    t.fleeing = false;
    for (const s of ships(f, t)) s.cargo.ore = salvageRoom(f.sim, s) + (s.cargo.ore ?? 0);
    expect(recoveryRoom(f.sim, raid, v.h.pos)).toBeCloseTo(room0, 6);
  });

  it('X03: end to end — warships demand, the tender recovers the container and unloads it in a warehouse; it is a truce party', () => {
    const f = fixture();
    const v = victim(f, f.at(15000, -25000), { metal: 600 }, 'survive');
    f.sim.command(f.B, { c: 'setOp', group: v.g.id, op: { k: 'move', to: f.at(9000, -25000) } });
    const raid = fleet(f, f.A, f.at(15000, -21000), ['destroyer', 'destroyer'], 'A 약탈');
    const t = tender(f, raid, f.at(15000, -19500));
    expect(f.sim.command(f.A, { c: 'setOp', group: raid.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } })).toBeNull();
    const total = 600;
    let drop: string | undefined, tenderParty = false, statuses = new Set<string>();
    run(f.sim, 2400, () => {
      const d = Object.values(f.sim.st.drops ?? {})[0];
      if (d && !drop) { drop = d.id; expect(d.raid).toBe(raid.id); }
      const tr = f.sim.st.piracy?.truces.find(x => x.id === drop);
      if (tr && truceBlocks(f.sim.st, t, v.g, v.h.pos, f.sim.time)) tenderParty = true;
      if (t.status) statuses.add(t.status.split(' — ')[0].split(':')[0]);
      return !!drop && !f.sim.st.drops?.[drop] && stored(f, f.A, 'metal') > 0 && held(f, t, 'metal') < 1e-6 && t.salv === undefined;
    });
    expect(drop).toBeTruthy();
    expect(tenderParty).toBe(true);
    const got = stored(f, f.A, 'metal');
    expect(got).toBeGreaterThan(0);
    // the tender took most of it (the warships' salvage holds are small)
    expect(got + held(f, raid, 'metal')).toBeGreaterThan(ships(f, raid).reduce((a, s) => a + (s.salvaged?.metal ?? 0), 0));
    expect(statuses).toContain('약탈품 회수 중');
    expect(statuses).toContain('회수품 하역 중');
    // conservation: every unit is with the victim, in the container, aboard A's ships or in A's warehouses
    expect(v.h.cargo.metal! + dropUnits(f.sim.st) + held(f, raid, 'metal') + held(f, t, 'metal') + got).toBeCloseTo(total, 6);
    expect(t.op.k).toBe('lootTender');     // continuous: it keeps supporting the raid
  });

  it('X04: validation', () => {
    const f = fixture();
    const raid = fleet(f, f.A, f.at(0, 9000), ['destroyer'], 'A 약탈');
    const t = fleet(f, f.A, f.at(0, 10000), ['hauler'], 'A 회수');
    const war = fleet(f, f.A, f.at(0, 11000), ['frigate'], 'A 군함');
    const bRaid = fleet(f, f.B, f.at(0, 12000), ['destroyer'], 'B 약탈');
    const cmd = (g: WGroup, group: string) => f.sim.command(f.A, { c: 'setOp', group: g.id, op: { k: 'lootTender', group } });
    expect(cmd(t, 'nope')).toMatch(/약탈 편대가 없습니다/);
    expect(cmd(t, bRaid.id)).toMatch(/자사 약탈 편대/);
    expect(cmd(t, t.id)).toMatch(/자기 편대/);
    expect(cmd(war, raid.id)).toMatch(/수송선이 없습니다/);
    expect(cmd(t, raid.id)).toBeNull();
    const g = WorldSim.create(5, {}); const P = g.addPlayer('x'); const any = Object.values(g.st.groups).find(x => x.owner === P)!;
    expect(g.command(P, { c: 'setOp', group: any.id, op: { k: 'lootTender', group: any.id } })).toMatch(/P13\.2|활성화/);
  });

  it('X05: the tender follows its raid and stands down when the raid fleet is gone', () => {
    const f = fixture();
    const raid = fleet(f, f.A, f.at(0, 15000), ['destroyer'], 'A 약탈');
    const t = tender(f, raid, f.at(0, 5000));
    run(f.sim, 120);
    const c = f.sim.groupCenter(t)!, r = f.sim.groupCenter(raid)!;
    expect(Math.hypot(c.x - r.x, c.z - r.z)).toBeLessThan(PIR.tenderTrail + 600);
    expect(t.status).toMatch(/약탈 회수 지원/);
    for (const id of raid.shipIds) delete f.sim.st.ships[id];
    delete f.sim.st.groups[raid.id];
    run(f.sim, .5);
    expect(t.op.k).toBe('idle');
    expect(f.sim.st.events.some(e => e.ref === t.id && /약탈 회수 지원 종료/.test(e.text))).toBe(true);
  });

  it('X06: save / restore keeps the order, the drop raid id and the recovery run', () => {
    const f = fixture();
    const v = victim(f, f.at(15000, 10000), { metal: 600 }, 'survive');
    const raid = fleet(f, f.A, f.at(15000, 9200), ['destroyer', 'destroyer'], 'A 약탈');
    const t = tender(f, raid, f.at(16500, 9200));
    const r = demand(f.sim, raid, v.h) as any; expect(r.response).toBe('comply');
    expect(r.drop.raid).toBe(raid.id);
    expect(f.sim.st.piracy!.truces.find(x => x.id === r.drop.id)!.pa).toContain(t.id);
    run(f.sim, 20);
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(copy.st.groups[t.id].op).toEqual({ k: 'lootTender', group: raid.id });
    expect(copy.st.drops?.[r.drop.id]?.raid ?? 'gone').toBe(f.sim.st.drops?.[r.drop.id]?.raid ?? 'gone');
    run(f.sim, 600); run(copy, 600);
    expect(held(f, t, 'metal') + stored(f, f.A, 'metal')).toBeCloseTo(held({ ...f, sim: copy }, copy.st.groups[t.id], 'metal') + Object.values(copy.st.stations).reduce((n, st) => n + (st.storage[f.A]?.metal ?? 0), 0), 6);
  });

  it('X07: fleet panel shows the support button for a hauler group and the state of a tender', () => {
    const f = fixture();
    const raid = fleet(f, f.A, f.at(0, 9000), ['destroyer'], 'A 약탈');
    const t = fleet(f, f.A, f.at(0, 10000), ['hauler'], 'A 회수');
    expect(groupPiracyHtml(f.sim.st as any, f.A, t, 'nonlethal', false, false, true)).toContain('data-op="loot_tender"');
    expect(groupPiracyHtml(f.sim.st as any, f.A, raid, 'nonlethal', false, true, false)).not.toContain('loot_tender');
    f.sim.command(f.A, { c: 'setOp', group: t.id, op: { k: 'lootTender', group: raid.id } });
    run(f.sim, 2);
    const html = groupPiracyHtml(f.sim.st as any, f.A, t, 'nonlethal', false, false, true);
    expect(html).toContain('약탈 회수 지원'); expect(html).toContain('A 약탈'); expect(html).toContain('지원 중단');
  });
});
