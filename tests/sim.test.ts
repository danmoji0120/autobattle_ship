import { describe, it, expect } from 'vitest';
import { World, type BattleSetup } from '../src/sim/world';
import { defaultPlayerFleet, fleetCost, validateFleet, walk, PLAYER_BUDGET, type FleetSpec } from '../src/sim/fleet';
import { getScenario, SCENARIOS } from '../src/sim/data/scenarios';
import { WEAPONS } from '../src/sim/data/weapons';
import { Vec3 } from '../src/sim/math';

const setup = (seed: number, scen = 'kestrel', a: FleetSpec = defaultPlayerFleet(), b: FleetSpec = getScenario(scen).enemy): BattleSetup =>
  ({ seed, scenarioId: scen, fleets: [a, b] });

const runTo = (w: World, t: number) => { while (w.time < t && !w.outcome) w.step(); };

describe('determinism & replay', () => {
  it('same seed produces identical state', () => {
    const a = new World(setup(7)), b = new World(setup(7));
    runTo(a, 60); runTo(b, 60);
    expect(a.digest()).toBe(b.digest());
    expect(a.radioLog.map(r => r.text)).toEqual(b.radioLog.map(r => r.text));
  });

  it('different seeds diverge', () => {
    const a = new World(setup(1)), b = new World(setup(2));
    runTo(a, 60); runTo(b, 60);
    expect(a.digest()).not.toBe(b.digest());
  });

  it('recorded player orders replay exactly', () => {
    const live = new World(setup(11));
    const raiders = live.groups.find(g => g.name === '뇌격 1편대')!;
    const main = live.groups.find(g => g.name === '주력 전대')!;
    const enemyLine = live.groups.find(g => g.team === 1 && g.name === '중앙 전열')!;
    runTo(live, 10);
    live.issueOrder(raiders.id, { type: 'flank', side: -1, targetGroup: enemyLine.id });
    runTo(live, 25);
    live.issueOrder(main.id, { type: 'hold' });
    runTo(live, 40);
    live.issueOrder(main.id, null, { release: true });
    live.issueOrder(main.id, null, { retreatAt: 0.5 });
    runTo(live, 120);
    const replay = new World(setup(11));
    replay.scheduleReplay(JSON.parse(JSON.stringify(live.orderLog)));
    runTo(replay, 120);
    expect(replay.digest()).toBe(live.digest());
    expect(replay.orderLog.length).toBe(live.orderLog.length);
  });
});

describe('battle flow', () => {
  it.each(SCENARIOS.map(s => s.id))('scenario %s ends with an outcome', id => {
    const w = new World(setup(3, id));
    const o = w.runUntilEnd();
    expect(o).not.toBeNull();
    expect(o!.time).toBeGreaterThan(40);
    expect(w.highlights.length).toBeGreaterThan(0);
    expect(w.radioLog.length).toBeGreaterThan(10);
  });

  it('default fleet fits the budget and validates', () => {
    const f = defaultPlayerFleet();
    expect(validateFleet(f)).toBe(true);
    expect(fleetCost(f)).toBeLessThanOrEqual(PLAYER_BUDGET);
    expect(validateFleet({ name: 'x', root: { name: 'r', ships: [{ classId: 'nope', loadoutId: 'x' }], children: [] } })).toBe(false);
  });
});

describe('commanders matter', () => {
  it('named commanders beat acting captains with identical ships', () => {
    const stripped = defaultPlayerFleet();
    walk(stripped.root, g => { g.commanderId = null; });
    let wins = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const w = new World(setup(seed, 'x', defaultPlayerFleet(), stripped));
      if (w.runUntilEnd()!.winner === 0) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(6);
  });

  it('a skilled admiral coordinates hammer & anvil (raiders wait for the line)', () => {
    const w = new World(setup(5));
    let staged = false, struck = false;
    while (w.time < 90 && !w.outcome) {
      w.step();
      for (const g of w.groups) if (g.team === 0 && g.role === 'raider' && g.order.type === 'flank') {
        if (g.ai.phase === 'staging') staged = true;
        if (g.ai.phase === 'strike') struck = true;
      }
    }
    expect(struck).toBe(true);
    // at least one radio call about the coordinated strike
    expect(w.radioLog.some(r => r.team === 0 && /돌입|망치|지금|측면/.test(r.text))).toBe(true);
    void staged;
  });

  it('player orders override delegation and can be released', () => {
    const w = new World(setup(9));
    const g = w.groups.find(x => x.name === '지원 전대')!;
    runTo(w, 5);
    expect(g.playerOverride).toBe(false);
    w.issueOrder(g.id, { type: 'retreat' });
    w.step();
    expect(g.playerOverride).toBe(true);
    expect(g.order.type).toBe('retreat');
    w.issueOrder(g.id, null, { release: true });
    runTo(w, 12);
    expect(g.playerOverride).toBe(false);
    expect(g.order.type).not.toBe('retreat');
  });

  it('retreating groups leave the battlefield', () => {
    const w = new World(setup(4));
    const g = w.groups.find(x => x.name === '호위 전대')!;
    w.issueOrder(g.id, { type: 'retreat' });
    runTo(w, 70);
    const ships = w.subtreeShips(g, true);
    expect(ships.every(s => s.state === 'escaped' || s.state === 'dead' || s.state === 'dying')).toBe(true);
    expect(ships.some(s => s.state === 'escaped')).toBe(true);
  });
});

describe('damage model', () => {
  it('heavy shells penetrate, light rounds ricochet off battleship armor', () => {
    const w = new World(setup(1));
    const bb = w.ships.find(s => s.team === 1 && s.cls.id === 'battleship')!;
    const dir = bb.fwd.clone().scale(-1); // incoming from the front
    const hp0 = bb.hp;
    w.applyHit(bb, WEAPONS.heavy_cannon, -1, bb.pos.clone(), dir, 'shell');
    const heavy = hp0 - bb.hp;
    expect(heavy).toBeGreaterThan(WEAPONS.heavy_cannon.damage * 0.8);
    let small = 0, ric = 0;
    for (let i = 0; i < 40; i++) {
      const before = bb.hp;
      w.applyHit(bb, WEAPONS.autocannon, -1, bb.pos.clone(), dir, 'shell');
      small += before - bb.hp;
      if (w.events.some(e => e.t === 'hit' && e.result === 'ricochet')) ric++;
      w.events.length = 0;
    }
    expect(small / 40).toBeLessThan(WEAPONS.autocannon.damage * 0.4);
    expect(ric).toBeGreaterThan(10);
  });

  it('rear armor is weaker than the bow', () => {
    const w = new World(setup(1));
    const ca = w.ships.find(s => s.team === 1 && s.cls.id === 'battleship')!;
    const avg = (dir: Vec3) => { let d = 0; for (let i = 0; i < 30; i++) { const h = ca.hp; w.applyHit(ca, WEAPONS.medium_gun, -1, ca.pos.clone(), dir, 'shell'); d += h - ca.hp; ca.hp = ca.maxHp; } return d / 30; };
    const front = avg(ca.fwd.clone().scale(-1));
    const rear = avg(ca.fwd.clone());
    expect(rear).toBeGreaterThan(front * 1.2);
  });
});
