// A-2.1: recovery under arrears — recovery sorties, emergency sale and trade-in to a public yard, closing on payment.
// The arrears stages themselves are unchanged (tests/upkeep*); these check the narrow way back and its limits.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { upkeepOf, departureHeld } from '../src/world/upkeep';
import { addDebt, moneyUnits } from '../src/world/money';
import { buybackValue, RECOVERY_SHIPS } from '../src/world/recovery';
import { hullIdOf } from '../src/world/hullops';
import { moneySupply } from '../src/world/observe';

function world(seed = 5) {
  const sim = WorldSim.create(seed, { ...STANDARD_WORLD });
  const me = sim.addPlayer('회생');
  const w = sim.st, co = w.companies[me];
  const groups = Object.values(w.groups).filter(g => g.owner === me);
  const miners = groups.find(g => g.name === '제1 채굴반')!, guard = groups.find(g => g.name !== '제1 채굴반')!;
  const ships = (g: { id: string }) => Object.values(w.ships).filter(s => s.groupId === g.id);
  return { sim, me, w, co, miners, guard, ships };
}
/** put the company two hours into arrears with `debt` owed and nothing in the wallet (stage 4) */
function arrears(sim: WorldSim, id: string, debt = 10000) {
  const co = sim.st.companies[id];
  co.credits = 0;
  addDebt(co, moneyUnits(debt), sim.st.time);
  const u = upkeepOf(co);
  u.debtSince = u.since = sim.st.time - 7300; u.stage = 4;
}
const run = (sim: WorldSim, s: number) => { for (let i = 0; i < s; i++) sim.update(1); };
const mineOp = { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } as const;

describe('A-2.1 recovery sorties', () => {
  it('keeps the arrears hold, and lets named civilian ships fly economic work only', () => {
    const { sim, me, w, co, miners, guard, ships } = world();
    arrears(sim, me);
    expect(sim.command(me, { c: 'setOp', group: miners.id, op: mineOp } as any)).toBeNull();
    run(sim, 120);
    // the old rule: nobody leaves
    expect(ships(miners).every(s => s.state === 'docked')).toBe(true);
    expect(departureHeld(w, ships(miners)[0])).toBe('운영비 체납 — 신규 출항 보류');
    // name both miners: they leave for the belt; the guard stays held
    for (const s of ships(miners).filter(x => x.classId === 'miner')) expect(sim.command(me, { c: 'recovery', ship: s.id, on: true } as any)).toBeNull();
    expect(upkeepOf(co).recovery).toBeTruthy();
    expect(sim.command(me, { c: 'setOp', group: guard.id, op: { k: 'escort', group: miners.id } } as any)).toBeNull();
    run(sim, 120);
    expect(ships(miners).some(s => s.state === 'space')).toBe(true);
    expect(ships(guard).every(s => s.state === 'docked')).toBe(true);
    expect(departureHeld(w, ships(guard)[0])).toBe('운영비 체납 — 신규 출항 보류');
  });

  it('is capped, refused below stage 3, and a named ship cannot take a military order', () => {
    const { sim, me, w, miners, guard, ships } = world();
    const g = ships(guard), m = ships(miners);
    expect(sim.command(me, { c: 'recovery', ship: m[0].id, on: true } as any)).toMatch(/체납 3단계/);
    arrears(sim, me);
    expect(sim.command(me, { c: 'recovery', ship: m[0].id, on: true } as any)).toBeNull();
    expect(sim.command(me, { c: 'recovery', ship: m[1].id, on: true } as any)).toBeNull();
    expect(sim.command(me, { c: 'recovery', ship: g[0].id, on: true } as any)).toMatch(new RegExp(`${RECOVERY_SHIPS}척까지`));
    // a miner group told to attack stays docked
    expect(sim.command(me, { c: 'setOp', group: miners.id, op: { k: 'patrol', at: { x: 0, y: 0, z: 0 }, radius: 500 } } as any)).toBeNull();
    expect(departureHeld(w, m[0])).toMatch(/채굴·운송·인양 작전만/);
    // release one: it is held again
    expect(sim.command(me, { c: 'recovery', ship: m[1].id, on: false } as any)).toBeNull();
    expect(departureHeld(w, m[1])).toBe('운영비 체납 — 신규 출항 보류');
  });

  it('a combat ship can only be moved to a yard', () => {
    const { sim, me, w, guard, ships } = world();
    arrears(sim, me);
    const d = ships(guard)[0];
    expect(sim.command(me, { c: 'recovery', ship: d.id, on: true } as any)).toBeNull();
    expect(sim.command(me, { c: 'setOp', group: guard.id, op: { k: 'patrol', at: { x: 0, y: 0, z: 0 }, radius: 500 } } as any)).toBeNull();
    expect(departureHeld(w, d)).toMatch(/정박 이동만/);
    expect(sim.command(me, { c: 'setOp', group: guard.id, op: { k: 'dock', station: 'drakeout' } } as any)).toBeNull();
    expect(departureHeld(w, d)).toBeNull();
  });

  it('a ship in reserve can be named: the reactivation fee goes on the debt and the normal wait applies', () => {
    const { sim, me, co, miners, ships } = world();
    const m = ships(miners)[0];
    expect(sim.command(me, { c: 'reserve', ship: m.id, on: true } as any)).toBeNull();
    arrears(sim, me);
    const before = upkeepOf(co).debt;
    expect(sim.command(me, { c: 'recovery', ship: m.id, on: true } as any)).toBeNull();
    expect(upkeepOf(co).debt).toBeGreaterThan(before);
    expect(m.reserve?.until).toBeGreaterThan(sim.st.time);
  });

  it('closes by itself when the debt is paid, and the normal rules come back', () => {
    const { sim, me, w, co, miners, guard, ships } = world();
    arrears(sim, me, 500);
    for (const s of ships(miners)) sim.command(me, { c: 'recovery', ship: s.id, on: true } as any);
    co.credits = 5000;                       // income arrives (as a sale would)
    expect(sim.command(me, { c: 'payArrears' } as any)).toBeNull();
    run(sim, 2);
    const u = upkeepOf(co);
    expect(u.debt).toBe(0);
    expect(u.recovery).toBeUndefined();
    expect(u.recovered?.paid).toBeGreaterThan(0);
    expect(Object.values(w.ships).some(s => s.recovery)).toBe(false);
    expect(departureHeld(w, ships(guard)[0])).toBeNull();
  });
});

describe('A-2.1 emergency sale and trade-in', () => {
  it('sells a docked standard ship to the yard: real budget, real stock, proceeds pay the debt, no money appears', () => {
    const { sim, me, w, co, guard, ships } = world();
    arrears(sim, me, 3000);
    const c = ships(guard).find(s => hullIdOf(s) === 'corvette_mk1')!;
    const st = w.stations[(c.task as any).station];
    const value = buybackValue(w, c);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(Math.round(0.5 * 9300));
    const stock0 = st.shipStock!.corvette_mk1.n, funds0 = st.funds!, debt0 = upkeepOf(co).debt, money0 = moneySupply(w);
    expect(sim.command(me, { c: 'recoverySell', ship: c.id } as any)).toBeNull();
    expect(w.ships[c.id]).toBeUndefined();
    expect(st.shipStock!.corvette_mk1.n).toBe(stock0 + 1);
    expect(st.funds).toBeCloseTo(funds0 - value, 6);
    const paid = debt0 - upkeepOf(co).debt;
    expect(paid).toBeCloseTo(Math.min(debt0, value), 6);
    expect(co.credits).toBeCloseTo(Math.max(0, value - debt0), 6);
    // the yard's money moved to the company; the part that paid the debt left circulation (upkeep is a sink)
    expect(moneySupply(w)).toBeCloseTo(money0 - paid, 4);
  });

  it('refuses outside stage 3, with cargo, non-standard fittings, a yard that does not buy the hull, or no budget', () => {
    const { sim, me, w, guard, miners, ships } = world();
    const c = ships(guard).find(s => hullIdOf(s) === 'corvette_mk1')!;
    expect(sim.command(me, { c: 'recoverySell', ship: c.id } as any)).toMatch(/체납 3단계/);
    arrears(sim, me);
    const m = ships(miners)[0];
    m.cargo = { ore: 5 } as any;
    expect(sim.command(me, { c: 'recoverySell', ship: m.id } as any)).toMatch(/하역/);
    m.cargo = {} as any;
    const hp = Object.keys(c.fitting!.hp)[0];
    const keep = c.fitting!.hp[hp]; c.fitting!.hp[hp] = 'eq_medium_gun';
    expect(sim.command(me, { c: 'recoverySell', ship: c.id } as any)).toMatch(/표준 구성/);
    c.fitting!.hp[hp] = keep;
    const st = w.stations[(c.task as any).station];
    const funds = st.funds!; st.funds = 10;
    expect(sim.command(me, { c: 'recoverySell', ship: c.id } as any)).toMatch(/예산 부족/);
    st.funds = funds;
    st.shipStock!.corvette_mk1.n = 8;
    expect(sim.command(me, { c: 'recoverySell', ship: c.id } as any)).toMatch(/재고가 가득/);
    st.shipStock!.corvette_mk1.n = 4;
    const nova = w.stations.nova;
    c.task = { k: 'docked', station: nova.id } as any;
    expect(sim.command(me, { c: 'recoverySell', ship: c.id } as any)).toMatch(/매입하지 않습니다/);
  });

  it('trade-in only when no ship can earn: a corvette becomes the yard\'s miner, the shortfall goes on the debt', () => {
    const { sim, me, w, co, miners, guard, ships } = world();
    arrears(sim, me, 30000);   // larger than the miners' sale value, so the recovery stays open
    const c = ships(guard).find(s => hullIdOf(s) === 'corvette_mk1')!;
    expect(sim.command(me, { c: 'recoverySell', ship: c.id, swap: 'miner_mk1' } as any)).toMatch(/채굴할 수 있는 함선이 이미/);
    // sell the miners first (combat-only company)
    for (const m of ships(miners)) expect(sim.command(me, { c: 'recoverySell', ship: m.id } as any)).toBeNull();
    const st = w.stations[(c.task as any).station];
    const debt0 = upkeepOf(co).debt, credits0 = co.credits, miners0 = st.shipStock!.miner_mk1.n;
    const value = buybackValue(w, c), price = (sim as any).shipPrice(st, 'miner_mk1');
    expect(sim.command(me, { c: 'recoverySell', ship: c.id, swap: 'hauler_l' } as any)).toMatch(/1형 채굴선·수송선/);
    expect(sim.command(me, { c: 'recoverySell', ship: c.id, swap: 'miner_mk1' } as any)).toBeNull();
    expect(st.shipStock!.miner_mk1.n).toBe(miners0 - 1);
    const got = Object.values(w.ships).filter(s => s.owner === me && hullIdOf(s) === 'miner_mk1');
    expect(got.length).toBe(1);
    expect(got[0].recovery).toBe(true);
    if (price > value) expect(upkeepOf(co).debt).toBeCloseTo(debt0 + (price - value), 6);
    else expect(co.credits + (debt0 - upkeepOf(co).debt)).toBeCloseTo(credits0 + value - price, 6);
    // it can go to work at once
    const g = w.groups[got[0].groupId];
    expect(sim.command(me, { c: 'setOp', group: g.id, op: mineOp } as any)).toBeNull();
    expect(departureHeld(w, got[0])).toBeNull();
  });

  it('keeps the recovery state through save and restore', () => {
    const { sim, me, miners, ships } = world();
    arrears(sim, me);
    const m = ships(miners)[0];
    sim.command(me, { c: 'recovery', ship: m.id, on: true } as any);
    const back = new WorldSim(JSON.parse(sim.serialize()));
    expect(back.st.ships[m.id].recovery).toBe(true);
    expect(back.st.companies[me].upkeep?.recovery?.debt0).toBeCloseTo(upkeepOf(sim.st.companies[me]).recovery!.debt0, 6);
    expect(departureHeld(back.st, back.st.ships[m.id])).toBeNull();
  });
});
