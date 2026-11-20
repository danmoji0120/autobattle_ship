// P17.4f F1: per-industry profit and loss — the same real money as the cash ledger, booked by the business each ship
// serves (running cost, own sales, repair-business income, repair costs of the patient's business).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { activityOf, pnlRows } from '../src/world/industryPnl';
import type { WShip } from '../src/world/types';

const own = (sim: WorldSim, id: string) => Object.values(sim.st.ships).filter(s => s.owner === id);
const run = (sim: WorldSim, sec: number, stop?: () => boolean) => { for (let t = 0; t < sec && !stop?.(); t++) sim.update(1); };
const act = (sim: WorldSim, co: string, side: 'inc' | 'exp', a: string) => (sim.st.companies[co].ops?.act ?? []).reduce((n, h) => n + ((h[side] as Record<string, number>)[a] ?? 0), 0);
const led = (sim: WorldSim, co: string, side: 'inc' | 'exp', cat: string) => (sim.st.companies[co].ops?.ledger ?? []).reduce((n, h) => n + (h[side][cat] ?? 0), 0);

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

describe('P17.4f F1 activity of a ship', () => {
  it('follows the effective group op (a sub-group follows its parent) and a shipment', () => {
    const { sim, A, rep } = world();
    const g = sim.st.groups[rep.groupId];
    const cases: [string, string][] = [['mine', 'mining'], ['salvzone', 'salvage'], ['repairbiz', 'repair'], ['haul', 'logistics'], ['patrol', 'military'], ['hold', 'other']];
    for (const [k, a] of cases) { g.op = { k } as never; expect(activityOf(sim.st, rep)).toBe(a); }
    const parent = sim.newGroup(A, '상위'); parent.op = { k: 'mine' } as never;
    g.parentId = parent.id; g.op = { k: 'patrol' } as never; g.override = false;
    expect(activityOf(sim.st, rep)).toBe('mining');
    g.override = true; expect(activityOf(sim.st, rep)).toBe('military');
    rep.logisticsJob = 'x' as never; expect(activityOf(sim.st, rep)).toBe('logistics');
  });
});

describe('P17.4f F1 real money by activity', () => {
  it('running cost is booked every hour for every ship, to its activity', () => {
    const { sim, A } = world();
    run(sim, 3600);
    const rows = pnlRows(sim.st.companies[A], sim.time, 24);
    const ships = own(sim, A).filter(s => s.classId !== 'platform').length;
    expect(rows.reduce((n, r) => n + r.ships, 0)).toBeCloseTo(ships, 0);
    expect(rows.reduce((n, r) => n + r.exp, 0)).toBeGreaterThan(0);
    expect(rows.find(r => r.act === 'repair')?.ships ?? 0).toBeCloseTo(0, 0);   // the repair ship has no repair op yet
  }, 60_000);

  it('a ship\'s own sale is income of its activity; a storage sale is "stock"; totals match the cash ledger', () => {
    const { sim, A, rep } = world();
    sim.st.groups[rep.groupId].op = { k: 'mine' } as never;
    const st = Object.values(sim.st.stations).find(s => s.public && s.market?.ore)!;
    const r1 = sim.sellAt(st, A, 'ore', 40, rep), r2 = sim.sellAt(st, A, 'ore', 40);
    expect(r1.value).toBeGreaterThan(0);
    expect(act(sim, A, 'inc', 'mining')).toBeCloseTo(r1.value, 6);
    expect(act(sim, A, 'inc', 'stock')).toBeCloseTo(r2.value, 6);
    expect(led(sim, A, 'inc', 'sales')).toBeCloseTo(r1.value + r2.value, 6);
  });

  it('the repair business is repair income for the provider and a cost of the client ship\'s activity', () => {
    const { sim, A, B, rep } = world();
    const cust = own(sim, B)[0];
    cust.state = 'space'; cust.task = { k: 'idle' } as unknown as WShip['task'];
    const at = { ...rep.pos, x: rep.pos.x + 3000 }; cust.pos = { ...at }; cust.vel = { x: 0, y: 0, z: 0 }; cust.hp = 0.5;
    expect(sim.command(B, { c: 'autoOpsPolicy', repairService: { enabled: true, maxMul: 1.5, perHour: 1e6, minCredits: 0 } } as never)).toBeNull();
    expect(sim.command(A, { c: 'setOp', group: rep.groupId, op: { k: 'repairbiz', at: { ...rep.pos }, jumps: 1, mul: 1.2, clients: 'all', minFee: 0, avoidRisk: true } } as never)).toBeNull();
    const g = sim.st.groups[rep.groupId];
    sim.st.groups[cust.groupId].op = { k: 'hold' } as never;
    run(sim, 3 * 3600, () => { if (cust.state === 'space') { cust.pos = { ...at }; cust.vel = { x: 0, y: 0, z: 0 }; } return cust.hp >= 1 && !g.rbiz?.target; });
    const income = g.rbiz!.income;
    expect(income).toBeGreaterThan(0);
    expect(act(sim, A, 'inc', 'repair')).toBeCloseTo(income, 3);
    expect(act(sim, B, 'exp', 'other')).toBeGreaterThanOrEqual(income - 1e-6);   // the fee + that ship's running cost
    const repRow = pnlRows(sim.st.companies[A], sim.time, 24).find(r => r.act === 'repair')!;
    expect(repRow.exp).toBeGreaterThan(0);   // the repair ship's own running cost is the business's cost
    expect(repRow.net).toBeCloseTo(repRow.inc - repRow.exp, 6);
    // restore keeps the record (it lives in the save)
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    expect(act(sim2, A, 'inc', 'repair')).toBeCloseTo(income, 3);
  }, 120_000);
});
