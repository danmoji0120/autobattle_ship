import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { Station } from '../src/world/types';
import { qty } from '../src/world/types';
import { TECHS, FACILITIES, techFx } from '../src/world/industry';
import { labSlots, projectTime, salvageItem, wreckLoot } from '../src/world/research';

const run = (sim: WorldSim, seconds: number, dt = 0.5) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };

function base(seed = 41) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('연구소');
  calm(sim);
  sim.st.companies[p].credits = 3_000_000;
  sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' });
  const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
  const a = sim.st.stations.astra.pos;
  sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '연구 기지' } });
  run(sim, 200);
  const own = Object.values(sim.st.stations).find(s => s.owner === p) as Station;
  const co = sim.st.companies[p];
  return { sim, p, own, co };
}
const give = (own: Station, ...kinds: string[]) => { for (const k of kinds) own.modules.push({ kind: k, progress: 1, built: true, slot: own.modules.length + 1 }); };
const stock = (own: Station, p: string, c: Record<string, number>, times = 1) => { for (const [k, n] of Object.entries(c)) own.storage[p][k] = (own.storage[p][k] ?? 0) + n * times; };

describe('research: labs, prerequisites, consumption, parallel projects, unlocks, blueprints, salvage', () => {
  it('nine fields, every lab facility covers some, the tree is acyclic and every prerequisite exists', () => {
    // the nine built-in fields; growth (P5) adds five more lab fields for the 13-area tree
    expect(new Set(Object.values(TECHS).filter(t => !t.growth).map(t => t.field)).size).toBe(9);
    const fields = new Set(Object.values(TECHS).map(t => t.field));
    expect(fields.size).toBe(14);
    const covered = new Set(Object.values(FACILITIES).flatMap(f => f.lab ?? []));
    for (const f of fields) expect(covered.has(f)).toBe(true);
    const seen = new Set<string>(), stack = new Set<string>();
    const visit = (id: string) => { expect(TECHS[id]).toBeTruthy(); if (seen.has(id)) return; expect(stack.has(id)).toBe(false); stack.add(id); for (const p of TECHS[id].pre ?? []) visit(p); stack.delete(id); seen.add(id); };
    for (const id of Object.keys(TECHS)) visit(id);
  });

  it('needs a lab of the right field; credits at registration, materials consumed at start, then the tech is known', () => {
    const { sim, p, own, co } = base();
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'process_control' })).toMatch(/연구소가 없습니다/);
    give(own, 'power', 'lab_basic');
    for (const k of Object.keys(own.storage[p])) own.storage[p][k] = 0;
    const cr = co.credits;
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'process_control' })).toBeNull();
    expect(co.credits).toBe(cr - TECHS.process_control.credits);
    run(sim, 5);
    const r = co.research![0];
    expect(r.started).toBe(false);
    expect(r.why).toMatch(/재료 부족: .*전자부품 4/);
    stock(own, p, TECHS.process_control.cost); own.storage[p].machinery += 3;
    run(sim, 1);
    expect(r.started).toBe(true);
    expect(qty(own.storage[p], 'electronics')).toBe(0); expect(qty(own.storage[p], 'machinery')).toBe(3);
    run(sim, TECHS.process_control.time - 60);
    expect(co.tech).not.toContain('process_control');
    run(sim, 120);
    expect(co.tech).toContain('process_control');
    expect(co.research!.length).toBe(0);
    // the unlock is real: production speed and the recipe gate
    expect(techFx(co.tech).prodMul).toBeCloseTo(1.1, 6);
    expect(sim.st.events.some(e => e.company === p && /연구 완료: 공정 제어/.test(e.text))).toBe(true);
  });

  it('prerequisites: refused unless known or queued earlier; a queued follow-up waits, then starts by itself', () => {
    const { sim, p, own, co } = base();
    give(own, 'power', 'power', 'lab_basic', 'lab_industry');
    stock(own, p, { electronics: 100, machinery: 100, chemicals: 100 });
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'lean_production' })).toMatch(/선행 연구 필요: 고효율 정련/);
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'process_control' })).toBeNull();
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'refining_2' })).toBeNull();
    run(sim, 2);
    const [a, b] = co.research!;
    expect(a.started).toBe(true);
    expect(b.started).toBe(false); expect(b.why).toMatch(/선행 연구 대기: 공정 제어/);
    run(sim, TECHS.process_control.time + 10);
    expect(co.tech).toContain('process_control');
    expect(b.started).toBe(true);
  });

  it('parallel projects use separate slots; slot-limited projects queue; power and research techs change speed', () => {
    const { sim, p, own, co } = base();
    give(own, 'power', 'power', 'lab_basic', 'lab_industry');
    stock(own, p, { electronics: 200, machinery: 200, crystal: 50, structure: 50, chemicals: 50 });
    expect(labSlots(own).length).toBe(2);
    for (const t of ['process_control', 'mining_lasers', 'station_engineering']) expect(sim.command(p, { c: 'research', station: own.id, tech: t })).toBeNull();
    run(sim, 2);
    expect(co.research!.filter(r => r.started).length).toBe(2);
    expect(co.research![2].why).toMatch(/슬롯 사용 중/);
    const l0 = co.research![0].left;
    run(sim, 100);
    expect(l0 - co.research![0].left).toBeCloseTo(100, 0);           // power factor 1, no research tech
    co.tech!.push('research_methods');
    const l1 = co.research![0].left; run(sim, 100);
    expect(l1 - co.research![0].left).toBeCloseTo(120, 0);
  });

  it('pause, reorder and cancel (full refund before start, pro-rata after; materials are not returned)', () => {
    const { sim, p, own, co } = base();
    give(own, 'power', 'lab_basic');
    for (const k of Object.keys(own.storage[p])) own.storage[p][k] = 0;
    const cr0 = co.credits, paid0 = co.upkeep?.total.paid ?? 0;
    sim.command(p, { c: 'research', station: own.id, tech: 'process_control' });
    sim.command(p, { c: 'research', station: own.id, tech: 'mining_lasers' });
    const [a, b] = co.research!;
    expect(sim.command(p, { c: 'researchOp', project: b.id, op: 'top' })).toBeNull();
    expect(co.research![0]).toBe(b);
    expect(sim.command(p, { c: 'researchOp', project: a.id, op: 'cancel' })).toBeNull();
    expect(co.credits).toBe(cr0 - TECHS.mining_lasers.credits);
    stock(own, p, TECHS.mining_lasers.cost);
    run(sim, 900);
    expect(b.started).toBe(true);
    expect(sim.command(p, { c: 'researchOp', project: b.id, op: 'pause' })).toBeNull();
    const left = b.left; run(sim, 50); expect(b.left).toBe(left);
    expect(sim.command(p, { c: 'researchOp', project: b.id, op: 'cancel' })).toBeNull();
    expect(co.credits).toBeCloseTo(cr0 - TECHS.mining_lasers.credits * 0.5 - ((co.upkeep?.total.paid ?? 0) - paid0), -2);
  });

  it('unlocks are enforced: facility, recipe and hull design need the tech', () => {
    const { sim, p, own, co } = base();
    give(own, 'power', 'yard_s');
    expect(sim.command(p, { c: 'queueModule', station: own.id, kind: 'engine_plant' })).toMatch(/연구 필요: 함선 추진기관/);
    // c3: the blueprint (right) and the research (know-how) are separate requirements
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'frigate', loadoutId: 'patrol' })).toMatch(/설계도 필요/);
    co.blueprints!.bp_frigate_mk1 = { src: 'test', t: 0 };
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'frigate', loadoutId: 'patrol' })).toMatch(/연구 필요/);
    co.tech!.push('ship_propulsion', 'frigate_design');
    expect(sim.command(p, { c: 'queueModule', station: own.id, kind: 'engine_plant' }) ?? '').not.toMatch(/연구 필요/);
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'frigate', loadoutId: 'patrol' })).toBeNull();
  });

  it('blueprints: bought from a broker, learned from storage; known techs can be copied into tradeable blueprints', () => {
    const { sim, p, own, co } = base();
    sim.st.stations.helios.market!['bp:frigate_design'].stock = 1;
    expect(sim.command(p, { c: 'buy', station: 'helios', res: 'bp:frigate_design', amount: 1 })).toBeNull();
    expect(qty(sim.st.stations.helios.storage[p], 'bp:frigate_design')).toBe(1);
    expect(sim.command(p, { c: 'learnBlueprint', station: 'helios', tech: 'frigate_design' })).toBeNull();
    expect(co.tech).toContain('frigate_design');
    expect(qty(sim.st.stations.helios.storage[p], 'bp:frigate_design')).toBe(0);
    // copy it at a design bureau and put the copy on the exchange
    give(own, 'power', 'power', 'lab_basic', 'design_bureau');
    stock(own, p, { electronics: 10, precision: 4 });
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'frigate_design', source: 'copy' })).toBeNull();
    run(sim, projectTime('frigate_design', 'copy') + 10);
    expect(qty(own.storage[p], 'bp:frigate_design')).toBe(1);
    expect(co.tech!.filter(t => t === 'frigate_design').length).toBe(1);
    // another PMC buys it through the exchange and learns it
    const q = sim.addPlayer('구매사'); sim.st.companies[q].credits = 200000;
    own.modules.push({ kind: 'trade_hub', progress: 1, built: true, slot: 9 });
    expect(sim.command(p, { c: 'list', station: own.id, item: 'bp:frigate_design', qty: 1, price: 15000 })).toBeNull();
    const l = own.listings![0];
    expect(sim.command(q, { c: 'buyListing', station: own.id, listing: l.id, qty: 1 })).toBeNull();
    expect(sim.command(q, { c: 'learnBlueprint', station: own.id, tech: 'frigate_design' })).toBeNull();
    expect(sim.st.companies[q].tech).toContain('frigate_design');
  });

  it('salvage: wrecks yield parts and captured equipment; captured equipment can be reverse-engineered faster', () => {
    let i = 0; const seq = [0.9, 0.5, 0.1, 0.0];
    const loot = wreckLoot(() => seq[i++ % seq.length], { eq_heavy_cannon: 2, eq_pd_gun: 1 });
    expect(loot.weapon_parts).toBeGreaterThan(0);
    expect(Object.keys(loot).some(k => k.startsWith('eq_'))).toBe(true);
    const { sim, p, own, co } = base();
    give(own, 'power', 'power', 'lab_basic', 'lab_weapons');
    co.tech!.push('fire_control', 'guided_missiles');
    expect(salvageItem('heavy_ordnance')).toBe('eq_heavy_cannon');
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'heavy_ordnance', source: 'salvage' })).toMatch(/노획품이 없습니다/);
    own.storage[p].eq_heavy_cannon = 1;
    stock(own, p, TECHS.heavy_ordnance.cost);
    expect(sim.command(p, { c: 'research', station: own.id, tech: 'heavy_ordnance', source: 'salvage' })).toBeNull();
    run(sim, 2);
    expect(qty(own.storage[p], 'eq_heavy_cannon')).toBe(0);
    expect(co.research![0].total).toBe(Math.round(TECHS.heavy_ordnance.time * 0.4));
    run(sim, co.research![0].total + 10);
    expect(co.tech).toContain('heavy_ordnance');
  });

  it('projects survive a restart and finish identically', () => {
    const { sim, p, own, co } = base();
    give(own, 'power', 'lab_basic');
    stock(own, p, { electronics: 10, machinery: 10 });
    sim.command(p, { c: 'research', station: own.id, tech: 'process_control' });
    run(sim, 600);
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    expect(sim2.st.companies[p].research).toEqual(co.research);
    run(sim, 1300); run(sim2, 1300);
    expect(sim2.st.companies[p].tech).toEqual(co.tech);
    expect(co.tech).toContain('process_control');
  });
});
