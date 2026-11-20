// P17.4c: field goals compare the whole mining order (AUD-11); a military contract returns the fleet to its
// pre-contract order unless the player gave it another order meanwhile (AUD-10).
import { beforeAll, describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { createGoal } from '../src/world/operations';
import { isMil, settle, type MilTerms } from '../src/world/military';
import type { Contract, WGroup } from '../src/world/types';

const run = (sim: WorldSim, s: number) => { for (let i = 0; i < s; i++) sim.update(1); };

describe('P17.4c AUD-11 field goal order ownership', () => {
  function start() {
    const sim = WorldSim.create(21, { ...STANDARD_WORLD });
    const me = sim.addPlayer('광구 목표', 'miner');
    const port = sim.st.stations.p9_anvil_port;
    const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
    return { sim, me, port, g };
  }
  const goal = (sim: WorldSim, me: string) => Object.values(sim.st.works!).find(x => x.owner === me && x.kind === 'develop_field')!;

  it('a group already mining the field with other delivery / sale settings is re-assigned, and the replacement is logged', () => {
    const { sim, me, port, g } = start();
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_ore', deliver: '', sell: false, auto: true } })).toBeNull();
    expect(createGoal(sim, me, { k: 'develop_field', field: 'p9_anvil_ore', group: g.id, sell: true, miners: 0, deliver: port.id } as never)).toBeNull();
    run(sim, 20);
    const op = g.op as { k: string; deliver?: string; sell?: boolean; auto?: boolean };
    expect(op.k).toBe('mine'); expect(op.deliver).toBe(port.id); expect(op.sell).toBe(true); expect(op.auto).toBeFalsy();
    const w = goal(sim, me);
    expect(w.state).not.toBe('paused');
    expect(JSON.stringify(w.log ?? [])).toMatch(/목표 설정으로 교체/);
  });

  it('a player change of the sale flag or delivery pauses the goal with the difference; it is never overridden; resume re-assigns', () => {
    const { sim, me, port, g } = start();
    expect(createGoal(sim, me, { k: 'develop_field', field: 'p9_anvil_ore', group: g.id, sell: true, miners: 0, deliver: port.id } as never)).toBeNull();
    run(sim, 20);
    const w = goal(sim, me);
    expect((g.op as { sell?: boolean }).sell).toBe(true);
    // same field, sale off: before P17.4c the goal counted this as its own order and kept reporting progress
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_ore', deliver: port.id, sell: false } })).toBeNull();
    run(sim, 30);
    expect(w.state).toBe('paused');
    expect(w.reason).toMatch(/하역 판매 꺼짐/);
    expect((g.op as { sell?: boolean }).sell).toBe(false);           // the player's order stands
    run(sim, 60);
    expect((g.op as { sell?: boolean }).sell).toBe(false);
    // resume: the goal re-assigns its own settings once (before, it re-paused at once)
    expect(sim.command(me, { c: 'workOp', work: w.id, op: 'resume' })).toBeNull();
    run(sim, 30);
    expect(w.state).not.toBe('paused');
    expect((g.op as { sell?: boolean }).sell).toBe(true);
    // an automatic-unload change is also seen
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_ore', deliver: '', sell: true, auto: true } })).toBeNull();
    run(sim, 30);
    expect(w.state).toBe('paused'); expect(w.reason).toMatch(/하역지 자동/);
  });
});

type MK = Contract & { mil: MilTerms };
describe('P17.4c AUD-10 military contract returns the fleet to its prior order', () => {
  let warm = '', SEC = '';
  beforeAll(() => {
    const sim = WorldSim.create(41, { ...STANDARD_WORLD });
    SEC = sim.addPlayer('경비', 'security');
    run(sim, 1800);
    warm = sim.serialize();
  }, 240_000);
  const restore = () => new WorldSim(JSON.parse(warm));
  const fleet = (sim: WorldSim) => Object.values(sim.st.groups).find(g => g.owner === SEC && !g.parentId)!;
  const offer = (sim: WorldSim) => (Object.values(sim.st.contracts).filter(k => isMil(k) && !k.done && !k.takenBy) as MK[]).find(k => k.mil.type === 'patrol' || k.mil.type === 'defend')!;
  const home = (sim: WorldSim) => sim.st.companies[SEC].homeStation!;

  function accept(sim: WorldSim, g: WGroup) {
    const k = offer(sim); expect(k).toBeTruthy();
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: g.id })).toBeNull();
    expect(g.op.k).not.toBe('dock');
    return k;
  }

  it('after settlement the fleet goes back to the order it had before the contract (once), with an event', () => {
    const sim = restore(), g = fleet(sim);
    expect(sim.command(SEC, { c: 'setOp', group: g.id, op: { k: 'dock', station: home(sim) } })).toBeNull();
    const k = accept(sim, g);
    expect(k.mil.prevOp).toEqual({ k: 'dock', station: home(sim) });
    const evs = sim.st.events.length;
    settle(sim, k, true, 'test', 1);
    expect(g.op).toEqual({ k: 'dock', station: home(sim) });
    expect(sim.st.events.slice(evs).some(e => /계약 전 명령\(dock\)으로 복귀/.test(e.text))).toBe(true);
    expect(k.mil.prevOp).toBeUndefined();
    // a second settlement call changes nothing
    expect(sim.command(SEC, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    settle(sim, k, true, 'again', 1);
    expect(g.op.k).toBe('idle');
  });

  it('the prior order survives save / restore', () => {
    const sim = restore(), g = fleet(sim);
    expect(sim.command(SEC, { c: 'setOp', group: g.id, op: { k: 'dock', station: home(sim) } })).toBeNull();
    const k = accept(sim, g);
    const twin = new WorldSim(JSON.parse(sim.serialize()));
    const k2 = twin.st.contracts[k.id] as MK;
    expect(k2.mil.prevOp).toEqual({ k: 'dock', station: home(sim) });
    settle(twin, k2, false, 'test', 0, true);
    expect(twin.st.groups[g.id].op).toEqual({ k: 'dock', station: home(sim) });
  });

  it('a manual order during the contract is kept at the end; a re-sortie hands the fleet back to the contract', () => {
    const sim = restore(), g = fleet(sim);
    expect(sim.command(SEC, { c: 'setOp', group: g.id, op: { k: 'dock', station: home(sim) } })).toBeNull();
    const k = accept(sim, g);
    expect(sim.command(SEC, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    expect(k.mil.overridden).toBeDefined();
    const evs = sim.st.events.length;
    expect(sim.command(SEC, { c: 'milCancel', contract: k.id })).toBeNull();
    expect(g.op.k).toBe('idle');                                     // the player's latest order is not overwritten
    expect(sim.st.events.slice(evs).some(e => /직접 명령을 유지/.test(e.text))).toBe(true);
    // re-sortie: the override mark is cleared, so the prior order comes back at the end
    const sim2 = restore(), g2 = fleet(sim2);
    expect(sim2.command(SEC, { c: 'setOp', group: g2.id, op: { k: 'dock', station: home(sim2) } })).toBeNull();
    const k3 = accept(sim2, g2);
    expect(sim2.command(SEC, { c: 'setOp', group: g2.id, op: { k: 'idle' } })).toBeNull();
    expect(k3.mil.overridden).toBeDefined();
    expect(sim2.command(SEC, { c: 'milDispatch', contract: k3.id })).toBeNull();
    expect(k3.mil.overridden).toBeUndefined();
    settle(sim2, k3, true, 'test', 1);
    expect(g2.op).toEqual({ k: 'dock', station: home(sim2) });
  });
});
