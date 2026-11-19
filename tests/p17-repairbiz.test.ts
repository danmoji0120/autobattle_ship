// P17.2 repair business: paid field repair for other companies and NPC navies. docs/P17_INDUSTRY.md
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { observeWorld } from '../src/world/observe';
import { baseUnit, RB } from '../src/world/repairBiz';
import type { WShip } from '../src/world/types';

const own = (sim: WorldSim, id: string) => Object.values(sim.st.ships).filter(s => s.owner === id);
const op = (at: WShip['pos'], o: Record<string, unknown> = {}) => ({ k: 'repairbiz', at: { ...at }, jumps: 1, mul: 1.2, clients: 'all', minFee: 0, avoidRisk: true, ...o });
const SVC = { enabled: true, maxMul: 1.5, perHour: 1e6, minCredits: 0 };

/** provider A: one repair ship in its own group; customer B: one damaged ship idle in space 3 km away */
function world(providers = 1) {
  const sim = WorldSim.create(31, { ...STANDARD_WORLD });
  const A = sim.addPlayer('수리업'), B = sim.addPlayer('고객');
  const reps: WShip[] = [];
  const pool = own(sim, A).filter(s => s.ind && s.fitting);
  for (let i = 0; i < providers; i++) {
    const rep = pool[i];
    rep.fitting!.bay = { [Object.keys(rep.fitting!.bay)[0] ?? 'ind1']: 'ind_rep_m' };
    rep.state = 'space'; rep.task = { k: 'idle' } as unknown as WShip['task'];
    expect(sim.command(A, { c: 'newGroup', name: `수리 ${i}`, ships: [rep.id] } as any)).toBeNull();
    reps.push(rep);
  }
  const cust = own(sim, B)[0];
  cust.state = 'space'; cust.task = { k: 'idle' } as unknown as WShip['task'];
  cust.pos = { ...reps[0].pos, x: reps[0].pos.x + 3000 }; cust.vel = { x: 0, y: 0, z: 0 };
  cust.hp = 0.5;
  const g = sim.st.groups[cust.groupId]; g.op = { k: 'hold' } as any;
  sim.st.companies[A].credits = 1e6; sim.st.companies[B].credits = 1e6;
  return { sim, A, B, reps, cust };
}
/** money moved by the repair business (events), by direction */
function ledger(sim: WorldSim, payer?: string) {
  const m = { paid: 0, got: 0 };
  const off = observeWorld(sim.st, e => {
    if (e.reason !== 'repair_service') return;
    if (e.kind === 'cost' && (!payer || e.company === payer)) m.paid += e.amount;
    if (e.kind === 'income' && (!payer || e.from === payer)) m.got += e.amount;
  });
  return { m, off };
}
const run = (sim: WorldSim, sec: number, stop?: () => boolean) => { for (let t = 0; t < sec && !stop?.(); t++) sim.update(1); };
/** keep the customer where it is (it has no order of its own in these tests) */
const pin = (cust: WShip, at: WShip['pos']) => () => { if (cust.state === 'space') { cust.pos = { ...at }; cust.vel = { x: 0, y: 0, z: 0 }; } return false; };

describe('P17.2 repair business', () => {
  it('without the customer\'s consent there is no job; with it the ship is found, repaired to full and paid for exactly', () => {
    const { sim, A, B, reps, cust } = world();
    const gA = sim.st.groups[reps[0].groupId], at = { ...cust.pos };
    expect(sim.command(A, { c: 'setOp', group: gA.id, op: op(reps[0].pos) } as any)).toBeNull();
    run(sim, 40, pin(cust, at));
    expect(gA.rbiz?.target).toBeUndefined();
    expect(gA.status).toMatch(/수리업 대기/);
    // consent (the customer's own setting, through its own command)
    expect(sim.command(B, { c: 'autoOpsPolicy', repairService: SVC } as any)).toBeNull();
    const { m, off } = ledger(sim, B);
    const unit = baseUnit(sim, cust) * 1.2, a0 = sim.st.companies[A].credits, b0 = sim.st.companies[B].credits;
    run(sim, 3 * 3600, () => { pin(cust, at)(); return cust.hp >= 1 && !gA.rbiz?.target; });
    off();
    expect(cust.hp).toBe(1);
    expect(gA.rbiz!.jobs.length).toBe(1);
    expect(m.paid).toBeGreaterThan(0);
    expect(m.paid).toBeCloseTo(m.got, 6);
    expect(m.paid).toBeCloseTo(0.5 * unit, 0);
    expect(gA.rbiz!.income).toBeCloseTo(m.got, 6);
    // the transfer shows in both balances (each side also has its own unrelated running costs)
    expect(sim.st.companies[A].credits - a0).toBeLessThanOrEqual(m.got + 1e-6);
    expect(b0 - sim.st.companies[B].credits).toBeGreaterThanOrEqual(m.paid - 1e-6);
    // after the job it looks for the next one / waits
    run(sim, 60);
    expect(gA.status).toMatch(/수리업 대기|수리업:/);
  }, 120_000);

  it('the customer\'s hourly budget stops the job: no free repair, no negative balance', () => {
    const { sim, A, B, reps, cust } = world();
    const gA = sim.st.groups[reps[0].groupId], at = { ...cust.pos };
    const cap = 300;
    expect(sim.command(B, { c: 'autoOpsPolicy', repairService: { ...SVC, perHour: cap } } as any)).toBeNull();
    // player customers only, so the fleet does not move on to NPC work once this customer's budget is spent
    expect(sim.command(A, { c: 'setOp', group: gA.id, op: op(reps[0].pos, { clients: 'players' }) } as any)).toBeNull();
    const { m, off } = ledger(sim, B);
    const unit = baseUnit(sim, cust) * 1.2;
    expect(0.5 * unit).toBeGreaterThan(cap * 2);   // the full job costs far more than the budget
    run(sim, 1800, pin(cust, at));
    off();
    expect(m.paid).toBeGreaterThan(0);
    expect(m.paid).toBeLessThanOrEqual(cap + 1e-6);
    // hull restored is exactly what was paid for
    expect(cust.hp - 0.5).toBeCloseTo(m.paid / unit, 6);
    expect(cust.hp).toBeLessThan(1);
    expect(sim.st.companies[B].credits).toBeGreaterThan(0);
    expect(gA.rbiz?.target).toBeUndefined();
  }, 120_000);

  it('two repair businesses never take the same ship, and it is paid for once', () => {
    const { sim, A, B, reps, cust } = world(2);
    const at = { ...cust.pos };
    expect(sim.command(B, { c: 'autoOpsPolicy', repairService: SVC } as any)).toBeNull();
    for (const r of reps) expect(sim.command(A, { c: 'setOp', group: r.groupId, op: op(r.pos) } as any)).toBeNull();
    const { m, off } = ledger(sim, B);
    const unit = baseUnit(sim, cust) * 1.2;
    let both = 0;
    run(sim, 3 * 3600, () => {
      pin(cust, at)();
      const ts = reps.map(r => sim.st.groups[r.groupId].rbiz?.target);
      if (ts[0] && ts[0] === ts[1]) both++;
      return cust.hp >= 1 && !ts[0] && !ts[1];
    });
    off();
    expect(both).toBe(0);
    expect(cust.hp).toBe(1);
    expect(m.paid).toBeCloseTo(0.5 * unit, 0);
    expect(m.paid).toBeCloseTo(m.got, 6);
  }, 120_000);

  it('save and restore in the middle of a paid job: no double charge', () => {
    const { sim, A, B, reps, cust } = world();
    const gA = sim.st.groups[reps[0].groupId], at = { ...cust.pos };
    expect(sim.command(B, { c: 'autoOpsPolicy', repairService: SVC } as any)).toBeNull();
    expect(sim.command(A, { c: 'setOp', group: gA.id, op: op(reps[0].pos) } as any)).toBeNull();
    const unit = baseUnit(sim, cust) * 1.2;
    run(sim, 3 * 3600, () => { pin(cust, at)(); return (gA.rbiz?.billed ?? 0) > 0; });
    const billed = gA.rbiz!.billed!;
    expect(billed).toBeGreaterThan(0);
    const back = new WorldSim(JSON.parse(sim.serialize()));
    const c2 = back.st.ships[cust.id], g2 = back.st.groups[gA.id];
    const { m, off } = ledger(back, B);
    run(back, 3 * 3600, () => { pin(c2, at)(); return c2.hp >= 1 && !g2.rbiz?.target; });
    off();
    expect(c2.hp).toBe(1);
    expect(billed + m.paid).toBeCloseTo(0.5 * unit, 0);
    expect(g2.rbiz!.jobs[0].fee).toBe(Math.round(billed + m.paid));
  }, 180_000);

  it('NPC navy ships are paid for from their faction treasury (and guild traders / pirates are never customers)', () => {
    const { sim, A, reps } = world();
    const gA = sim.st.groups[reps[0].groupId];
    run(sim, 300);   // NPC navies spawn on their first force-plan pass
    const navy = Object.values(sim.st.ships).find(s => sim.st.companies[s.owner]?.kind === 'union' && s.state === 'space' && sim.st.groups[s.groupId]?.npc)!;
    expect(navy).toBeTruthy();
    const fid = (sim.st.systems[sim.st.groups[navy.groupId].npc!.sys] ?? sim.sysOf(navy.pos))!.faction!;
    const econ = sim.st.factions![fid].econ!;
    const at = { ...navy.pos };
    reps[0].pos = { ...at, x: at.x + 2000 };
    navy.hp = 0.6;
    const guild = Object.values(sim.st.ships).find(s => s.owner === 'guild');
    if (guild) { guild.hp = 0.4; guild.pos = { ...at, x: at.x - 1500 }; }
    expect(sim.command(A, { c: 'setOp', group: gA.id, op: op(reps[0].pos, { mul: 1.2 }) } as any)).toBeNull();
    const { m, off } = ledger(sim);
    const b0 = econ.budget, s0 = econ.led.services ?? 0;
    run(sim, 1200, () => { if (navy.state === 'space') { navy.pos = { ...at }; navy.vel = { x: 0, y: 0, z: 0 }; } return (gA.rbiz?.jobs.length ?? 0) > 0; });
    off();
    expect(m.got).toBeGreaterThan(0);
    expect((econ.led.services ?? 0) - s0).toBeCloseTo(m.got, 6);
    expect(econ.budget).toBeLessThanOrEqual(b0);
    expect(gA.rbiz!.jobs.every(j => sim.st.companies[j.client]?.kind === 'union')).toBe(true);
    // a price above what navies accept: no NPC job
    expect(RB.npcMaxMul).toBeLessThan(2);
  }, 120_000);

  it('validation: needs field repair gear and sane settings; a customer sets only its own consent', () => {
    const { sim, A, B, reps } = world();
    const gA = sim.st.groups[reps[0].groupId];
    expect(sim.command(A, { c: 'setOp', group: gA.id, op: op(reps[0].pos, { mul: 9 }) } as any)).toMatch(/가격 배율/);
    expect(sim.command(A, { c: 'setOp', group: gA.id, op: op(reps[0].pos, { jumps: 5 }) } as any)).toMatch(/0~1점프/);
    reps[0].fitting!.bay = {};
    expect(sim.command(A, { c: 'setOp', group: gA.id, op: op(reps[0].pos) } as any)).toMatch(/현장 수리 장비/);
    expect(sim.command(B, { c: 'autoOpsPolicy', repairService: { ...SVC, maxMul: 10 } } as any)).toMatch(/가격 상한/);
    expect(sim.st.companies[A].repairService).toBeUndefined();
  });
});
