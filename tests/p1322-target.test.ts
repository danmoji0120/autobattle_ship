// P13.2.2 — lane-plunder target choice by expected real profit: the comply chance (judge() without its noise,
// nearby separate escorts and support included), the units the raid can really carry away (with assigned
// recovery fleets), their real sale value at the best market now (the same price walk as a sale), the risk of a
// refusal. Designated targets and network destruction are not filtered. The estimate is pure.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { V, WGroup, WShip, Cargo } from '../src/world/types';
import { assess, complyChance, estimateTarget, judge, saleQuote, stepPlunder, wanted, PIR } from '../src/world/piracy';

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
function victim(f: F, pos: V, cargo: Cargo, policy: 'survive' | 'balanced' | 'protect' = 'balanced', name = 'B 수송') {
  const g = fleet(f, f.B, pos, ['hauler'], name); g.piracyPolicy = policy;
  const h = ships(f, g)[0]; Object.assign(h.cargo, cargo); h.logisticsExcluded = true;
  // hold still (the choice is what is tested, not the chase)
  return { g, h };
}
const pin = (f: F, gs: WGroup[]) => { for (const g of gs) { g.op = { k: 'idle' }; for (const s of ships(f, g)) s.vel = { x: 0, y: 0, z: 0 }; } };
const threatsTo = (f: F, g: WGroup) => (f.sim.st.piracy?.log ?? []).filter(e => e.kind === 'threat' && f.sim.st.ships[e.ship!]?.groupId === g.id).length;

describe('P13.2.2 target choice (lane plunder)', () => {
  it('Y01: judge() is assess() × noise; complyChance matches the real answer frequency', () => {
    // find a situation on the edge (neither sure comply nor sure refusal): the test needs one
    let f!: F, v!: ReturnType<typeof victim>, raid!: WGroup, want!: Cargo, a!: ReturnType<typeof assess>, p = 0;
    f = fixture(); v = victim(f, f.at(15000, 10000), { metal: 600 }, 'balanced');
    raid = fleet(f, f.A, f.at(15000, 9200), ['cruiser', 'destroyer', 'destroyer']); want = wanted(f.sim, v.h, 'part');
    for (let hp = 1; hp > 0.05; hp -= 0.02) {
      for (const s of ships(f, raid)) s.hp = hp;
      a = assess(f.sim, raid, v.g, v.h, want); p = complyChance(a);
      if (p > 0.3 && p < 0.7) break;
    }
    expect(p).toBeGreaterThan(0.05); expect(p).toBeLessThan(0.95);   // a situation on the edge (the test needs one)
    let comply = 0; const N = 3000;
    for (let i = 0; i < N; i++) {
      const r0 = f.sim.rng.next.bind(f.sim.rng);
      let drawn = 0; const rng = f.sim.rng as any, orig = rng.next;
      rng.next = () => { const x = orig.call(rng); drawn = x; return x; };
      const j = judge(f.sim, raid, v.g, v.h, want);
      rng.next = orig; void r0;
      expect(j.pressure).toBe(a.base * (0.9 + 0.2 * drawn));
      if (j.response === 'comply') comply++;
    }
    expect(Math.abs(comply / N - p)).toBeLessThan(0.04);
  });

  it('Y02: the estimate is pure (no RNG draw, no state change)', () => {
    const f = fixture();
    const v = victim(f, f.at(15000, 10000), { metal: 600, electronics: 100 }, 'balanced');
    const raid = fleet(f, f.A, f.at(15000, 8000), ['destroyer', 'destroyer']);
    const before = f.sim.serialize(), r0 = JSON.stringify(f.sim.rng);
    const e = estimateTarget(f.sim, raid, v.g, v.h, { k: 'plunder', at: v.h.pos, radius: 3000, policy: 'nonlethal' }, f.sim.groupCenter(raid)!);
    expect(e.sale).toBeGreaterThan(0);
    expect(f.sim.serialize()).toBe(before); expect(JSON.stringify(f.sim.rng)).toBe(r0);
  });

  it('Y03: saleQuote is what a real sale pays (price walk, tax, budget)', () => {
    const f = fixture();
    const st = Object.values(f.sim.st.stations).find(s => s.market?.electronics && f.sim.canDock(s, f.A))!;
    const q = saleQuote(f.sim, st, 'electronics', 900);
    const c0 = f.sim.st.companies[f.A].credits;
    const r = f.sim.sellAt(st, f.A, 'electronics', 900);
    expect(r.sold).toBe(q.sold); expect(r.value).toBeCloseTo(q.value, 6);
    expect(f.sim.st.companies[f.A].credits - c0).toBeCloseTo(q.value, 6);
  });

  it('Y04: a richer hauler with a separate escort nearby loses to a poorer unescorted one (the old score picked the escorted one)', () => {
    const f = fixture();
    const zone = f.at(15000, 10000);
    const rich = victim(f, f.at(18000, 10000), { electronics: 300 }, 'survive', 'B 고가');
    const esc = fleet(f, f.B, f.at(18000, 10900), ['destroyer', 'destroyer', 'frigate'], 'B 호위(별도)');   // a separate group, 900 m away (6 km from the other hauler)
    const poor = victim(f, f.at(12000, 10000), { metal: 600 }, 'survive', 'B 저가');
    const raid = fleet(f, f.A, f.at(15000, 9000), ['cruiser', 'destroyer', 'destroyer']);
    pin(f, [rich.g, esc, poor.g]);
    const op = { k: 'plunder' as const, at: zone, radius: 3000, policy: 'nonlethal' as const };
    const from = f.sim.groupCenter(raid)!;
    const eR = estimateTarget(f.sim, raid, rich.g, rich.h, op, from), eP = estimateTarget(f.sim, raid, poor.g, poor.h, op, from);
    // the old score: value / (the target group's own warships) / distance — the escort is not in that group
    const old = (v: number, s: WShip) => (v + 100) / (0 + 80) / (Math.hypot(s.pos.x - from.x, s.pos.z - from.z) + 1200);
    expect(old(300 * 150, rich.h)).toBeGreaterThan(old(600 * 6, poor.h));
    expect(eR.p).toBeLessThan(eP.p);
    expect(eP.score).toBeGreaterThan(eR.score);
    f.sim.command(f.A, { c: 'setOp', group: raid.id, op });
    run(f.sim, 4);
    expect(raid.plx?.target).toBe(poor.g.id);
    expect(raid.plx?.est?.p).toBeCloseTo(eP.p, 2);
  });

  it('Y05: an assigned recovery fleet close by raises the units the raid can take and the expected profit', () => {
    const f = fixture();
    const v = victim(f, f.at(15000, 10000), { metal: 1200 }, 'survive');
    const raid = fleet(f, f.A, f.at(15000, 9000), ['destroyer', 'destroyer']);
    const op = { k: 'plunder' as const, at: v.h.pos, radius: 3000, policy: 'nonlethal' as const };
    const from = f.sim.groupCenter(raid)!;
    const e0 = estimateTarget(f.sim, raid, v.g, v.h, op, from);
    const t = fleet(f, f.A, f.at(16500, 9000), ['hauler', 'hauler']);
    expect(f.sim.command(f.A, { c: 'setOp', group: t.id, op: { k: 'lootTender', group: raid.id } })).toBeNull();
    const e1 = estimateTarget(f.sim, raid, v.g, v.h, op, from);
    expect(e0.recover).toBeLessThan(e0.units);
    expect(e1.recover).toBeGreaterThan(e0.recover);
    expect(e1.profit).toBeGreaterThan(e0.profit);
  });

  it('Y06: goods with no buyer left (every market glutted) are worth less than the same tonnage of goods in demand', () => {
    const f = fixture();
    const raid = fleet(f, f.A, f.at(15000, 9000), ['destroyer', 'destroyer']);
    const a = victim(f, f.at(15000, 10000), { electronics: 200 }, 'survive', 'B 전자');
    const op = { k: 'plunder' as const, at: a.h.pos, radius: 3000, policy: 'nonlethal' as const };
    const from = f.sim.groupCenter(raid)!;
    const before = estimateTarget(f.sim, raid, a.g, a.h, op, from);
    for (const st of Object.values(f.sim.st.stations)) if (st.market?.electronics) st.market.electronics.stock = st.market.electronics.target * 10;
    const after = estimateTarget(f.sim, raid, a.g, a.h, op, from);
    expect(after.sale).toBeLessThan(before.sale * 0.5);
    expect(after.p).toBeCloseTo(before.p, 9);     // the victim's answer does not depend on markets
  });

  it('Y07: below the minimum expected profit a lane raid leaves the target alone and says why', () => {
    const f = fixture();
    const v = victim(f, f.at(15000, 10000), { ore: 5 }, 'survive');
    const raid = fleet(f, f.A, f.at(15000, 9000), ['destroyer']);
    pin(f, [v.g]);
    const op = { k: 'plunder' as const, at: v.h.pos, radius: 3000, policy: 'nonlethal' as const };
    expect(estimateTarget(f.sim, raid, v.g, v.h, op, f.sim.groupCenter(raid)!).profit).toBeLessThan(PIR.aiMinProfit);
    f.sim.command(f.A, { c: 'setOp', group: raid.id, op });
    run(f.sim, 60);
    expect(threatsTo(f, v.g)).toBe(0);
    expect(raid.plx?.why).toMatch(/수익성 있는 목표 없음/);
  });

  it('Y08: a designated target and network destruction are not filtered by profit', () => {
    // designated: a hopeless, cheap target is still threatened
    const f = fixture();
    const v = victim(f, f.at(15000, 10000), { ore: 5 }, 'protect');
    const raid = fleet(f, f.A, f.at(15000, 9500), ['corvette']);
    f.sim.command(f.A, { c: 'setOp', group: raid.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } });
    run(f.sim, 60, () => threatsTo(f, v.g) > 0);
    expect(threatsTo(f, v.g)).toBe(1);
    // destroy policy on a lane: the same hauler is attacked (no demand, no profit filter)
    const f2 = fixture();
    const v2 = victim(f2, f2.at(15000, 10000), { ore: 5 }, 'protect');
    const r2 = fleet(f2, f2.A, f2.at(15000, 9000), ['corvette']);
    pin(f2, [v2.g]);
    f2.sim.command(f2.A, { c: 'setOp', group: r2.id, op: { k: 'plunder', at: v2.h.pos, radius: 3000, policy: 'destroy' } });
    run(f2.sim, 4);
    expect(r2.plx?.target).toBe(v2.g.id);
  });

  it('Y09: force raises the refusal risk only when warships oppose it', () => {
    const f = fixture();
    const v = victim(f, f.at(15000, 10000), { metal: 600 }, 'protect');
    const raid = fleet(f, f.A, f.at(15000, 9000), ['destroyer']);
    const from = f.sim.groupCenter(raid)!;
    const nl = { k: 'plunder' as const, at: v.h.pos, radius: 3000, policy: 'nonlethal' as const }, fo = { ...nl, policy: 'force' as const };
    expect(estimateTarget(f.sim, raid, v.g, v.h, fo, from).risk).toBe(0);           // nobody to fight
    fleet(f, f.B, f.at(15000, 10600), ['frigate', 'frigate']);
    const a = estimateTarget(f.sim, raid, v.g, v.h, nl, from), b = estimateTarget(f.sim, raid, v.g, v.h, fo, from);
    expect(b.risk).toBeGreaterThan(a.risk); expect(a.risk).toBeGreaterThan(0);
  });
  it('Y10: the pruned search (cheap upper bound first) picks exactly what checking every candidate in group order picks', () => {
    const items = ['ore', 'metal', 'alloy', 'electronics', 'machinery', 'fuel'];
    let checked = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const f = fixture(1322 + seed);
      let x = seed * 7919; const rnd = () => ((x = (x * 48271) % 2147483647) / 2147483647);
      const vs: ReturnType<typeof victim>[] = [];
      for (let i = 0; i < 25; i++) {
        const cargo: Cargo = {}; for (let k = 0; k < 1 + Math.floor(rnd() * 2); k++) cargo[items[Math.floor(rnd() * items.length)]] = 1 + Math.floor(rnd() * (rnd() < 0.3 ? 20 : 500));
        vs.push(victim(f, f.at(15000 + (rnd() - 0.5) * 8000, 10000 + (rnd() - 0.5) * 8000), cargo, (['survive', 'balanced', 'protect'] as const)[Math.floor(rnd() * 3)], 'B ' + i));
      }
      const escorts = [0, 1, 2].map(i => fleet(f, f.B, f.at(15000 + (rnd() - 0.5) * 8000, 10000 + (rnd() - 0.5) * 8000), ['destroyer', 'frigate'], 'B 호위 ' + i));
      const raid = fleet(f, f.A, f.at(15000, 9000), ['cruiser', 'destroyer', 'destroyer', 'hauler']);
      pin(f, [...vs.map(v => v.g), ...escorts]);
      for (const policy of ['nonlethal', 'force'] as const) {
        const op = { k: 'plunder' as const, at: f.at(15000, 10000), radius: 6000, policy };
        const from = f.sim.groupCenter(raid)!;
        // brute force: every victim in group order, strictly better score wins
        let best: string | undefined, bs = 0;
        for (const g of Object.values(f.sim.st.groups)) {
          const v = vs.find(v => v.g === g); if (!v) continue;
          const e = estimateTarget(f.sim, raid, v.g, v.h, op, from);
          if (e.profit >= PIR.aiMinProfit && e.score > bs) { bs = e.score; best = g.id; }
        }
        delete raid.plx;
        stepPlunder(f.sim, raid, ships(f, raid), op, 0, f.sim.cmdr(raid));
        expect(raid.plx?.target).toBe(best);
        if (best) checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);   // the comparison picked real targets, not just "none"
  });
});
