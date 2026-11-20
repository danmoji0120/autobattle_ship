import { describe, expect, it } from 'vitest';
import { dist, sysAt } from '../src/world/geom';
import { surveyIntel, visit, knowsField } from '../src/world/intel';
import { fitGear, fitStandardGear } from '../src/world/industrialGear';
import { pnlRows } from '../src/world/industryPnl';
import { outpostProblem } from '../src/world/strategicFields';
import { WorldSim } from '../src/world/sim';
import { cargoSum, qty, type Field, type Op, type Station } from '../src/world/types';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { isMil } from '../src/world/military';
import { inspectRepairCandidate, riskyAt } from '../src/world/repairBiz';
import { observeWorld } from '../src/world/observe';
import { legacyView } from '../src/server/sync';

function until(sim: WorldSim, seconds: number, done: () => boolean) {
  for (let i = 0; i < seconds && !done(); i++) sim.update(1);
  return done();
}

function pilot(quiet = true) {
  const sim = WorldSim.create(175, { ...STANDARD_WORLD, strategic: 'p175' });
  if (quiet) {
    for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = Infinity; }
    for (const g of Object.values(sim.st.groups)) if (g.owner === 'pirates') {
      for (const id of g.shipIds) delete sim.st.ships[id];
      delete sim.st.groups[g.id];
    }
  }
  const company = sim.addPlayer('흉터 개척 회사');
  const field = sim.st.fields.p10_scar_crystal;
  sim.st.companies[company].credits = 150_000;
  return { sim, company, field };
}

function found(sim: WorldSim, company: string, field: Field) {
  const sys = sysAt(sim.st.systems, field.pos)!;
  visit(sim.st, company, sys.id);
  const at = { ...field.pos, x: field.pos.x + 2250 };
  const build = sim.newGroup(company, '공작선');
  const builder = sim.spawnShip(company, 'constructor', 'std', build.id, at);
  fitStandardGear(builder);
  builder.cargo.alloy = 300;
  const freight = sim.newGroup(company, '나머지 건설 자재');
  const supply = sim.spawnShip(company, 'hauler', 'std', freight.id, at);
  supply.cargo.alloy = 300;
  expect(sim.command(company, { c: 'setOp', group: build.id, op: { k: 'found', at, name: '흉터 전초기지', size: 'S' } })).toBeNull();
  let base: Station | undefined;
  expect(until(sim, 5, () => !!(base = Object.values(sim.st.stations).find(s => s.owner === company)))).toBe(true);
  expect(outpostProblem(sim.st, field, base, company)).toMatch(/코어/);
  expect(sim.command(company, { c: 'setOp', group: freight.id, op: { k: 'build', station: base!.id } })).toBeNull();
  expect(until(sim, 240, () => !outpostProblem(sim.st, field, base, company)), JSON.stringify(base!.modules)).toBe(true);
  return base!;
}

describe('P17.5 strategic field pilot', () => {
  it('builds an S outpost, mines with two ships and sells a physical shipment through the public market', () => {
    const { sim, company, field } = pilot();
    const miners = sim.newGroup(company, '채굴선 두 척');
    for (let i = 0; i < 2; i++) fitStandardGear(sim.spawnShip(company, 'miner', 'std', miners.id, field.pos));
    const op: Op = { k: 'mine', field: field.id, deliver: '', auto: true, sell: false };
    expect(sim.command(company, { c: 'setOp', group: miners.id, op })).toMatch(/지대 없음/);
    visit(sim.st, company, 'scar');
    expect(knowsField(sim.st, company, field)).toBe(true);
    expect(sim.command(company, { c: 'setOp', group: miners.id, op })).toMatch(/전초기지/);
    const base = found(sim, company, field);
    const guard = sim.newGroup(company, '광구 방어');
    sim.spawnShip(company, 'destroyer', 'gun', guard.id, field.pos);
    expect(sim.command(company, { c: 'setOp', group: guard.id, op: { k: 'defend', at: field.pos, radius: 3500 } })).toBeNull();
    expect(sim.command(company, { c: 'setOp', group: miners.id, op: { ...op, sell: true } })).toMatch(/판매 운송/);
    expect(sim.command(company, { c: 'setOp', group: miners.id, op })).toBeNull();
    const item = 'resonant_crystal';
    expect(until(sim, 1000, () => qty(base.storage[company], item) >= 5),
      JSON.stringify({ status: miners.status, ships: sim.shipsOf(miners).map(s => [s.cargo, s.task]) })).toBe(true);
    const truck = sim.newGroup(company, '전략 원광 운송');
    const ship = sim.spawnShip(company, 'hauler', 'std', truck.id, base.pos);
    const escort = sim.newGroup(company, '수송 호위');
    sim.spawnShip(company, 'corvette', 'gun', escort.id, base.pos);
    expect(sim.command(company, { c: 'setOp', group: escort.id, op: { k: 'escort', group: truck.id } })).toBeNull();
    expect(sim.command(company, { c: 'poolShips', ships: [ship.id], on: true })).toBeNull();
    const buyer = sim.st.stations.p9_ceres_works;
    expect(buyer.market![item].stock).toBe(0);
    const co = sim.st.companies[company], credits = co.credits;
    expect(sim.command(company, { c: 'poolCreate', request: { from: base.id, to: buyer.id, item, kind: 'sell', amount: 5, priority: 5, repeat: false } })).toBeNull();
    expect(until(sim, 300, () => qty(ship.cargo, item) >= 5)).toBe(true);
    expect(until(sim, 2000, () => Object.values(sim.st.logisticsJobs ?? {}).some(j => j.owner === company && j.item === item && j.state === 'complete')),
      JSON.stringify(Object.values(sim.st.logisticsJobs ?? {}))).toBe(true);
    expect(buyer.market![item].stock).toBeGreaterThan(0);
    expect(co.upkeep?.debt ?? 0).toBe(0);
    const rows = pnlRows(co, sim.time);
    expect(rows.find(r => r.act === 'mining')!.sales).toBeGreaterThan(0);
    expect(rows.find(r => r.act === 'military')!.operating).toBeGreaterThan(0);
    expect(rows.find(r => r.act === 'logistics')!.operating).toBeGreaterThan(0);
    console.log('[P17.5 opening]', JSON.stringify({ time: Math.round(sim.time), mined: co.stats.mined, reserve: Math.round(field.amount), credits, final: co.credits, rows: rows.filter(r => r.inc || r.exp || r.operating) }));
  }, 120_000);

  it('keeps ordinary worlds intact and offers a legal site at each of the five pilot deposits', () => {
    const { sim, company } = pilot();
    const ordinary = WorldSim.create(175, { ...STANDARD_WORLD });
    const fields = Object.values(sim.st.fields).filter(f => f.strategic);
    expect(fields).toHaveLength(5);
    expect(ordinary.st.strategicV).toBeUndefined();
    expect(Object.values(ordinary.st.fields).some(f => f.strategic)).toBe(false);
    expect(new WorldSim(JSON.parse(sim.serialize())).st.strategicV).toBe(1);
    for (const field of fields) {
      const sys = sysAt(sim.st.systems, field.pos)!;
      visit(sim.st, company, sys.id);
      surveyIntel(sim.st, company, sys.id, 1e4);
      expect(knowsField(sim.st, company, field), field.id).toBe(true);
      const g = sim.newGroup(company, field.id);
      fitStandardGear(sim.spawnShip(company, 'constructor', 'std', g.id, field.pos));
      const points = Array.from({ length: 12 }, (_, i) => {
        const a = i * Math.PI / 6;
        return { x: field.pos.x + 2800 * Math.cos(a), y: 0, z: field.pos.z + 2800 * Math.sin(a) };
      });
      const attempts = [];
      for (const at of points) {
        const err = sim.command(company, { c: 'setOp', group: g.id, op: { k: 'found', at, name: field.name, size: 'S' } });
        if (!err) { attempts.push(null); break; }
        attempts.push(err);
      }
      expect(attempts.at(-1), `${field.id} ${attempts.join(', ')}`).toBeNull();
      expect(sim.command(company, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
      console.log('[P17.5 pilot site]', JSON.stringify({ id: field.id, system: sys.id, security: sys.security, reserve: field.max, regen: field.regen, radius: field.strategic?.radius }));
    }
  });

  it('has an existing pirate band raid miners, while a present screen deters the same band', () => {
    const { sim, company, field } = pilot(false);
    const base = found(sim, company, field);
    const miners = sim.newGroup(company, '노출된 채굴선');
    const ships = Array.from({ length: 2 }, () => sim.spawnShip(company, 'miner', 'std', miners.id, field.pos));
    ships.forEach(fitStandardGear);
    const mine: Op = { k: 'mine', field: field.id, deliver: base.id, sell: false };
    expect(sim.command(company, { c: 'setOp', group: miners.id, op: mine })).toBeNull();
    expect(sim.command(company, { c: 'piracyPolicy', group: miners.id, policy: 'protect' })).toBeNull();
    const lair = 'p10_scar_lair';
    const band = (world: WorldSim) => Object.values(world.st.groups).find(g => g.npc?.home === lair && g.op.k === 'raid');
    expect(until(sim, 600, () => band(sim)?.op.k === 'raid' && (band(sim)!.op as Extract<Op, { k: 'raid' }>).target === miners.id)).toBe(true);
    const raider = band(sim)!;
    const duringApproach = sim.serialize();
    const guarded = new WorldSim(JSON.parse(duringApproach));
    const screen = guarded.newGroup(company, '광구 방어 전열');
    for (const hull of ['battleship', 'destroyer', 'destroyer']) guarded.spawnShip(company, hull, 'std', screen.id, field.pos);
    expect(guarded.command(company, { c: 'setOp', group: screen.id, op: { k: 'defend', at: field.pos, radius: 3500 } })).toBeNull();
    const isBattle = (e: { groupRefs: string[] }) => e.groupRefs.includes(raider.id) && e.groupRefs.some(id => id === miners.id || id === miners.id + '#civ');
    const attacked = until(sim, 1000, () => Object.values(sim.st.engagements).some(isBattle));
    expect(attacked, JSON.stringify({ t: sim.time, raider: [raider.op, raider.status, sim.groupCenter(raider)], miners: [miners.status, sim.groupCenter(miners)], battles: Object.values(sim.st.engagements).slice(-8).map(e => e.groupRefs),
      events: sim.st.events.filter(e => e.company === company).slice(-12).map(e => [e.tag, e.text]) })).toBe(true);
    const battle = Object.values(sim.st.engagements).find(e => e.groupRefs.includes(raider.id) && e.groupRefs.some(id => id === miners.id || id === miners.id + '#civ'))!;
    expect(until(sim, 600, () => battle.done)).toBe(true);
    const unguardedSurvivors = ships.filter(s => sim.st.ships[s.id]).length;
    expect(unguardedSurvivors).toBeLessThan(ships.length);
    const wreck = Object.values(sim.st.wrecks ?? {}).find(w => w.sources.some(s => ships.some(ship => ship.id === s.ship)));
    expect(wreck?.lots.length).toBeGreaterThan(0);
    until(guarded, Math.ceil(sim.time - guarded.time), () => false);
    expect(sim.st.events.some(e => e.company === company && e.ref === miners.id && e.tag === 'strategic_contact')).toBe(true);
    const guardedSurvivors = ships.filter(s => guarded.st.ships[s.id]).length;
    expect(guardedSurvivors).toBeGreaterThan(unguardedSurvivors);
    expect(guarded.st.companies[company].stats.mined).toBeGreaterThan(sim.st.companies[company].stats.mined);
    const withdrew = new WorldSim(JSON.parse(duringApproach));
    const availableCargo = cargoSum(withdrew.st.stations[base.id].storage[company])
      + ships.reduce((sum, s) => sum + cargoSum(withdrew.st.ships[s.id].cargo), 0);
    const cover = withdrew.newGroup(company, '지연 방어');
    for (const hull of ['battleship', 'destroyer', 'destroyer']) withdrew.spawnShip(company, hull, 'std', cover.id, field.pos);
    expect(withdrew.command(company, { c: 'setOp', group: cover.id, op: { k: 'defend', at: field.pos, radius: 3500 } })).toBeNull();
    expect(withdrew.command(company, { c: 'setOp', group: miners.id, op: { k: 'dock', station: base.id } })).toBeNull();
    expect(until(withdrew, 400, () => ships.every(s => withdrew.st.ships[s.id]?.state === 'docked'))).toBe(true);
    const savedCargo = cargoSum(withdrew.st.stations[base.id].storage[company])
      + ships.reduce((sum, s) => sum + cargoSum(withdrew.st.ships[s.id].cargo), 0);
    expect(availableCargo).toBeGreaterThan(0);
    expect(savedCargo).toBe(availableCargo);
    expect(withdrew.st.stations[base.id]?.owner).toBe(company);
    const beforeReturn = withdrew.st.companies[company].stats.mined;
    expect(withdrew.command(company, { c: 'setOp', group: miners.id, op: mine })).toBeNull();
    expect(until(withdrew, 150, () => withdrew.st.companies[company].stats.mined > beforeReturn)).toBe(true);
    console.log('[P17.5 withdrawal]', JSON.stringify({ survived: ships.length, savedCargo, resumed: true }));
    console.log('[P17.5 raid]', JSON.stringify({ time: sim.time, raider: raider.name, unguardedSurvivors, guardedSurvivors,
      unguardedMined: sim.st.companies[company].stats.mined, guardedMined: guarded.st.companies[company].stats.mined, wreckLots: wreck?.lots.length }));
    const recovery = sim.newGroup(company, '전장 인양');
    const salvage = sim.spawnShip(company, 'miner', 'std', recovery.id, wreck!.pos);
    expect(fitGear(salvage, ['ind_salv_s']).length).toBeGreaterThan(0);
    expect(sim.command(company, { c: 'setOp', group: recovery.id, op: { k: 'recover', wreck: wreck!.id } })).toBeNull();
    expect(until(sim, 60, () => cargoSum(wreck!.taken[company]) > 0)).toBe(true);
    console.log('[P17.5 recovery]', JSON.stringify(wreck!.taken[company]));
    const bangedUp = guarded.shipsOf(screen).filter(s => s.state === 'space' && s.hp < 0.97);
    expect(bangedUp.length).toBeGreaterThan(0);
    const provider = guarded.addPlayer('현장 정비 회사');
    // Redeploy the damaged screen to a quiet spot in the same system before offering paid work.
    const scar = guarded.st.systems.scar;
    const safe = Array.from({ length: 8 }, (_, i) => {
      const a = i * Math.PI / 4;
      return { x: base.pos.x + 8000 * Math.cos(a), y: 0, z: base.pos.z + 8000 * Math.sin(a) };
    }).find(p => sysAt(guarded.st.systems, p)?.id === scar.id && !riskyAt(guarded, provider, p));
    expect(safe).toBeDefined();
    expect(guarded.command(company, { c: 'setOp', group: screen.id, op: { k: 'move', to: safe! } })).toBeNull();
    expect(until(guarded, 450, () => bangedUp.some(s => s.state === 'space' && dist(s.pos, safe!) < 900))).toBe(true);
    const repairGroup = guarded.newGroup(provider, '전장 정비선');
    const rig = guarded.spawnShip(provider, 'constructor', 'std', repairGroup.id, safe!);
    expect(fitGear(rig, ['ind_rep_s']).length).toBe(1);
    expect(guarded.command(company, { c: 'autoOpsPolicy', repairService: { enabled: true, maxMul: 1.5, perHour: 10000, minCredits: 0 } })).toBeNull();
    const repairOrder: Extract<Op, { k: 'repairbiz' }> = {
      k: 'repairbiz', at: safe!, jumps: 0, mul: 1.2, clients: 'players', minFee: 1, avoidRisk: true,
    };
    expect(guarded.command(provider, { c: 'setOp', group: repairGroup.id, op: repairOrder })).toBeNull();
    const hullBefore = bangedUp.reduce((n, s) => n + s.hp, 0);
    let paid = 0, earned = 0;
    const unobserve = observeWorld(guarded.st, event => {
      if (event.reason !== 'repair_service') return;
      if (event.kind === 'cost' && event.company === company) paid += event.amount;
      if (event.kind === 'income' && event.company === provider) earned += event.amount;
    });
    const repaired = until(guarded, 450, () => paid >= 10);
    unobserve();
    expect(repaired, JSON.stringify({ status: repairGroup.status, paid, clients: bangedUp.map(s => inspectRepairCandidate(guarded, repairGroup, repairOrder, s)) })).toBe(true);
    expect(bangedUp.reduce((n, s) => n + s.hp, 0)).toBeGreaterThan(hullBefore);
    expect(paid).toBeGreaterThan(0);
    expect(earned).toBeCloseTo(paid, 6);
    console.log('[P17.5 field repair]', JSON.stringify({ patients: bangedUp.length, paid, earned, repairCycles: repairGroup.rbiz!.jobs.length }));
  }, 120_000);

  it('pays a non-industrial PMC from the player escrow and restores its original order after real duty', () => {
    const { sim, company, field } = pilot();
    const base = found(sim, company, field);
    const guard = sim.addPlayer('외부 경비 회사', 'security');
    visit(sim.st, guard, 'scar');
    const g = sim.newGroup(guard, '원정 경비');
    const ship = sim.spawnShip(guard, 'destroyer', 'gun', g.id, { ...field.pos, z: field.pos.z + 1500 });
    const prior: Op = { k: 'move', to: { ...field.pos, z: field.pos.z + 1300 } };
    expect(sim.command(guard, { c: 'setOp', group: g.id, op: prior })).toBeNull();
    const co = sim.st.companies[company];
    const before = co.credits;
    const stranger = sim.addPlayer('정보 없는 회사', 'security');
    expect(sim.command(company, { c: 'milPostFieldGuard', field: field.id, station: base.id, reward: 3000 })).toBeNull();
    const contract = Object.values(sim.st.contracts).find(k => isMil(k) && k.mil.field === field.id)!;
    expect(co.credits).toBe(before - 3000);
    expect(contract.escrow).toBe(3000);
    expect(legacyView(sim.st, { company: stranger }, 'astra').contracts[contract.id]).toBeUndefined();
    expect(legacyView(sim.st, { company: guard }, 'scar').contracts[contract.id]?.id).toBe(contract.id);
    expect(sim.command(guard, { c: 'accept', contract: contract.id, group: g.id })).toBeNull();
    expect(g.op.k).toBe('defend');
    expect(until(sim, 1050, () => contract.done)).toBe(true);
    expect(contract.mil?.result?.ok).toBe(true);
    expect(contract.mil?.duty).toBeGreaterThanOrEqual(900);
    expect(contract.mil?.result?.pay).toBe(2400);
    expect(contract.escrow).toBe(0);
    expect(g.op).toEqual(prior);
    expect(dist(ship.pos, field.pos)).toBeLessThan(3500);
    expect(Object.values(sim.st.stations).some(s => s.owner === guard)).toBe(false);
    console.log('[P17.5 field guard]', JSON.stringify(contract.mil?.result));
  }, 120_000);
});
