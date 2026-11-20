// P17.4e AUD-17: hauler recovery, own-fleet field maintenance, paid outside repair and the repair business are booked
// under separate ledger lines (before, all but station repair fell into "전투·계약·기타" by reconciliation).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { book, rebookExpense, LEDGER_NAME } from '../src/world/operations';
import type { WShip } from '../src/world/types';

const own = (sim: WorldSim, id: string) => Object.values(sim.st.ships).filter(s => s.owner === id);
const run = (sim: WorldSim, sec: number, stop?: () => boolean) => { for (let t = 0; t < sec && !stop?.(); t++) sim.update(1); };
const sum = (sim: WorldSim, co: string, side: 'inc' | 'exp', cat: string) => (sim.st.companies[co].ops?.ledger ?? []).reduce((n, h) => n + (h[side][cat] ?? 0), 0);

function world() {
  const sim = WorldSim.create(31, { ...STANDARD_WORLD });
  const A = sim.addPlayer('수리업'), B = sim.addPlayer('고객');
  const rep = own(sim, A).find(s => s.ind && s.fitting)!;
  rep.fitting!.bay = { [Object.keys(rep.fitting!.bay)[0] ?? 'ind1']: 'ind_rep_m' };
  rep.state = 'space'; rep.task = { k: 'idle' } as unknown as WShip['task'];
  expect(sim.command(A, { c: 'newGroup', name: '수리', ships: [rep.id] } as never)).toBeNull();
  sim.st.companies[A].credits = 1e6; sim.st.companies[B].credits = 1e6;
  return { sim, A, B, rep };
}

describe('P17.4e AUD-17 repair kinds have their own ledger lines', () => {
  it('the paid repair business books the client\'s cost and the provider\'s income separately (not "기타")', () => {
    const { sim, A, B, rep } = world();
    const cust = own(sim, B)[0];
    cust.state = 'space'; cust.task = { k: 'idle' } as unknown as WShip['task'];
    const at = { ...rep.pos, x: rep.pos.x + 3000 }; cust.pos = { ...at }; cust.vel = { x: 0, y: 0, z: 0 }; cust.hp = 0.5;
    sim.st.groups[cust.groupId].op = { k: 'hold' } as never;
    expect(sim.command(B, { c: 'autoOpsPolicy', repairService: { enabled: true, maxMul: 1.5, perHour: 1e6, minCredits: 0 } } as never)).toBeNull();
    expect(sim.command(A, { c: 'setOp', group: rep.groupId, op: { k: 'repairbiz', at: { ...rep.pos }, jumps: 1, mul: 1.2, clients: 'all', minFee: 0, avoidRisk: true } } as never)).toBeNull();
    const g = sim.st.groups[rep.groupId];
    run(sim, 3 * 3600, () => { if (cust.state === 'space') { cust.pos = { ...at }; cust.vel = { x: 0, y: 0, z: 0 }; } return cust.hp >= 1 && !g.rbiz?.target; });
    expect(cust.hp).toBe(1);
    const income = g.rbiz!.income;
    expect(income).toBeGreaterThan(0);
    expect(sum(sim, A, 'inc', 'repair_biz')).toBeCloseTo(income, 3);
    expect(sum(sim, B, 'exp', 'repair_service')).toBeCloseTo(income, 3);
    expect(sum(sim, A, 'exp', 'repair_fleet')).toBe(0);   // repairing a client is not own maintenance
  }, 120_000);

  it('field repair of an own ship is booked as own-fleet maintenance', () => {
    const { sim, A, rep } = world();
    const pat = own(sim, A).find(s => s.id !== rep.id)!;
    pat.state = 'space'; pat.task = { k: 'idle' } as unknown as WShip['task'];
    pat.pos = { ...rep.pos, x: rep.pos.x + 500 }; pat.vel = { x: 0, y: 0, z: 0 }; pat.hp = 0.6;
    expect(sim.command(A, { c: 'setOp', group: rep.groupId, op: { k: 'fieldrepair', ship: pat.id } } as never)).toBeNull();
    const c0 = sim.st.companies[A].credits;
    run(sim, 1800, () => pat.hp >= 0.999);
    expect(pat.hp).toBeGreaterThan(0.6);
    const fleet = sum(sim, A, 'exp', 'repair_fleet');
    expect(fleet).toBeGreaterThan(0);
    expect(fleet).toBeLessThanOrEqual(c0 - sim.st.companies[A].credits + 1e-6 + sum(sim, A, 'inc', 'other'));
    expect(sum(sim, A, 'inc', 'repair_biz')).toBe(0);
  }, 120_000);

  it('rebookExpense moves an expense between lines without changing the total; every line has a name', () => {
    const { sim, A } = world();
    book(sim, A, 'repair', -300);
    rebookExpense(sim, A, 'repair', 'hauler_recovery', 200);
    rebookExpense(sim, A, 'repair', 'hauler_recovery', 500);   // more than booked: capped
    const b = sim.st.companies[A].ops!.ledger.at(-1)!;
    expect(b.exp.hauler_recovery).toBe(300); expect(b.exp.repair).toBeUndefined();
    for (const k of ['repair', 'repair_fleet', 'hauler_recovery', 'repair_service', 'repair_biz']) expect(LEDGER_NAME[k]).toBeTruthy();
  });
});
