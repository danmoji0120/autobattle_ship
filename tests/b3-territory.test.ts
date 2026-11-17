// B-3 sovereignty (성계 영유권·실효 지배·영토 전쟁) in the real standard world. Scenario numbers follow
// docs/B3_TERRITORY.md §10 (the 23 scenarios of the B-3 instruction).
//
// What is real and what is a stand-in (see tests/helpers/territory.ts and the report §8):
//  * every territory rule (control points, presence, the seven conditions, stabilisation, upkeep, policies, wars,
//    occupations, treaties, faction fleets, contracts) runs through the engine itself (sovTick and the commands);
//  * finished stations / facilities, warships with officers, administration goods in storage and hourly business
//    income are placed by the fixture (they stand in for hours of construction, shipbuilding, hauling and trading);
//  * long holds use `ff` (only the territory clock advances; ships stay where they are). The full-loop growth runs
//    (everything moving) are scripts/b3/pioneer.ts and scripts/b3/growth.ts, reported in docs/B3_TERRITORY.md §9.
import { beforeAll, describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import type { WorldState, WShip } from '../src/world/types';
import {
  CLASS, SOV, evaluate, stageOf, regionClass, upkeepOf, powerIn, legalOf, warSides, sovWarHostile, sovGateTransit, sovMineBlock, sovMined,
  sovFoundRule, migrateTerritory, sovReport, supplyNeed, sovTick, govReservedSpace, supplyStats, points, type SovSys,
} from '../src/world/sovereignty';
import { bumpStanding } from '../src/world/territory';
import { visit, sysLevel } from '../src/world/intel';
import { isMil } from '../src/world/military';
import { stepUpkeep } from '../src/world/upkeep';
import { moneySupply } from '../src/world/observe';
import { legacyView } from '../src/server/sync';
import { GameServer, type Conn } from '../src/server/core';
import type { ServerMsg } from '../src/server/protocol';
import { run, restore, outpost, warships, deliver, earn, ff, kit, addMods, garrison, GOV_KIT } from './helpers/territory';

const rec = (sim: WorldSim, id: string) => sim.st.sov!.sys[id] as SovSys;
const cmd = (sim: WorldSim, co: string, c: Record<string, unknown>) => sim.command(co, { c: 'sov', ...c } as never);
const fails = (sim: WorldSim, co: string, sys: string) => Object.entries(evaluate(sim, co, sys)).filter(([, c]) => !c.ok).map(([k]) => k);
/** an hour of a grown company: business income booked as sales and the seat's administration goods delivered */
const upkeepHour = (sim: WorldSim, co: string, sysId: string, income = 30_000, share = 1.2) => () => {
  earn(sim, co, income);
  const g = Object.values(sim.st.stations).find(s => s.owner === co && sim.sysOf(s.pos)?.id === sysId && s.modules.some(m => m.kind === 'governance' && m.built));
  if (g) deliver(sim, co, g, share);
};
/** the full first-sovereignty path in one system: kit → influence → declare → governance → hold until established */
function pioneer(sim: WorldSim, co: string, sysId: string, opts: Parameters<typeof kit>[3] = {}, maxH = 60) {
  const cls = regionClass(sim.st, sim.st.systems[sysId]);
  const k = kit(sim, co, sysId, { size: CLASS[cls].station === 'L' ? 'L' : CLASS[cls].station === 'XL' ? 'XL' : 'M', ...opts });
  const tick = upkeepHour(sim, co, sysId);
  let h = 0;
  for (; h < 12 && stageOf(sim, co, sysId) < 3; h++) ff(sim, 1, tick);
  expect(cmd(sim, co, { op: 'declare', sys: sysId })).toBeNull();
  addMods(k.st, ['governance', ...Array(CLASS[cls].defense).fill('defense')]);
  for (; h < maxH && rec(sim, sysId).owner !== co; h++) ff(sim, 1, tick);
  return { ...k, hours: h };
}

let warm = '';
let A = '', B = '', C = '';
beforeAll(() => {
  const sim = WorldSim.create(41, { ...STANDARD_WORLD });
  A = sim.addPlayer('아르고 개척'); B = sim.addPlayer('보레아스 산업'); C = sim.addPlayer('카론 운송');
  run(sim, 600);
  warm = sim.serialize();
}, 240_000);
const fresh = () => restore(warm);

describe('B-3 gate, data model and migration', () => {
  it('the standard world runs B-3; StarSystem.faction is never a company id; w.sov and other companies’ reports stay server-side', () => {
    const sim = fresh();
    expect(sim.st.sovV).toBe(1);
    expect(Object.keys(sim.st.sov!.sys).length).toBe(Object.keys(sim.st.systems).length);
    const facs = new Set(Object.keys(sim.st.factions ?? {}));
    for (const s of Object.values(sim.st.systems)) if (s.faction) expect(facs.has(s.faction)).toBe(true);
    // NPC systems start under their faction's control, pirate systems under the pirates'; outer systems are unowned
    expect(rec(sim, 'harbor').ctl['fac:union']).toBeGreaterThan(50);
    expect(rec(sim, 'gloam').owner).toBeUndefined();
    expect(legalOf(sim.st, 'harbor')).toBe('fac:union');
    run(sim, 120);
    const v = legacyView(sim.st, { company: A } as never, 'gloam') as unknown as WorldState;
    expect((v as any).sov).toBeUndefined();
    expect(v.companies[B].sovx).toBeUndefined();
  });

  it('an existing save without B-3 is unchanged until migrated; migration is explicit and idempotent', () => {
    const old = WorldSim.create(41, { ...STANDARD_WORLD, territory: undefined } as never);
    expect(old.st.sovV).toBeUndefined();
    const before = JSON.stringify(old.st.systems);
    run(old, 120);
    expect(old.st.sov).toBeUndefined();
    expect(Object.values(old.st.systems).some(s => (s as any).terr)).toBe(false);
    void before;
    expect(migrateTerritory(old.st).applied).toBe(true);
    expect(migrateTerritory(old.st).applied).toBe(false);
    run(old, 120);
    expect(old.st.sov?.sys.harbor.ctl['fac:union']).toBeGreaterThan(50);
  }, 120_000);
});

describe('B-3 sovereignty is hard to get', () => {
  it('1 · a new company that only builds a station (and has money) never gets sovereignty', () => {
    const sim = fresh();
    const st = outpost(sim, A, 'gloam', 'M', GOV_KIT(2).filter(k => k !== 'governance'));
    sim.st.companies[A].credits += 5_000_000;
    ff(sim, 24, () => earn(sim, A, 30_000));
    // the station alone does not make a claimant: no combat ships, no activity
    const s = stageOf(sim, A, 'gloam');
    expect(s).toBeLessThanOrEqual(3);
    const r = cmd(sim, A, { op: 'declare', sys: 'gloam' });
    if (r === null) { addMods(st, ['governance']); ff(sim, 30, upkeepHour(sim, A, 'gloam')); }
    expect(rec(sim, 'gloam').owner).toBeUndefined();
    expect(fails(sim, A, 'gloam')).toContain('mil');
  }, 120_000);

  it('2 · economy alone is not enough: rich, governance built and supplied, but no military — no sovereignty', () => {
    const sim = fresh();
    const st = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse']);
    // a single escort lets it reach influence and declare, then it leaves
    const [g] = garrison(sim, A, 'gloam', st, ['destroyer'], ['cruiser']);
    sim.st.companies[A].credits += 8_000_000;
    ff(sim, 6, upkeepHour(sim, A, 'gloam'));
    expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    addMods(st, ['governance', 'defense', 'defense']);
    for (const gr of Object.values(sim.st.groups).filter(x => x.owner === A)) for (const id of gr.shipIds) if (sim.st.ships[id] && sim.sysOf(sim.st.ships[id].pos)?.id === 'gloam') delete sim.st.ships[id];
    void g;
    ff(sim, 36, upkeepHour(sim, A, 'gloam'));
    expect(rec(sim, 'gloam').owner).toBeUndefined();
    const f = fails(sim, A, 'gloam');
    expect(f).toContain('mil');
    expect(evaluate(sim, A, 'gloam').econ.ok).toBe(true);
  }, 120_000);

  it('3 · a big fleet without industry and administration cannot take a system', () => {
    const sim = fresh();
    const st = outpost(sim, A, 'gloam', 'S', []);
    garrison(sim, A, 'gloam', st, ['cruiser', 'cruiser', 'destroyer'], Array(8).fill('cruiser'));
    sim.st.companies[A].credits += 3_000_000;
    ff(sim, 8, () => earn(sim, A, 30_000));
    expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    ff(sim, 36, () => earn(sim, A, 30_000));
    expect(rec(sim, 'gloam').owner).toBeUndefined();
    const f = fails(sim, A, 'gloam');
    expect(f).toEqual(expect.arrayContaining(['infra', 'logi']));
    expect(evaluate(sim, A, 'gloam').mil.ok).toBe(true);
  }, 120_000);

  it('4 · a grown company pioneers an unowned system over a long hold and establishes sovereignty', () => {
    const sim = fresh();
    const credits0 = moneySupply(sim.st);
    const p = pioneer(sim, A, 'gloam');
    const r = rec(sim, 'gloam');
    expect(r.owner).toBe(A);
    expect(r.how).toBe('pioneer');
    // control rises slowly: 60 at 5/h needs ≥ 12 h; stabilisation 12 h more — never a jump
    expect(p.hours).toBeGreaterThanOrEqual(CLASS.outer.stabH + 10);
    expect(sim.st.companies[A].milestones).toContain('first_sov');
    expect(sim.st.systems.gloam.faction).toBeUndefined();
    expect((sim.st.systems.gloam as any).terr.owner).toBe(A);
    void credits0;
    expect(sovReport(sim, A).rows.find(x => x.sys === 'gloam')?.stage).toBe(8);
  }, 120_000);
});

describe('B-3 routes to legitimacy', () => {
  it('5 · an industrial company meets the military condition with another company’s fleet under a guard contract', () => {
    const sim = fresh();
    const st = outpost(sim, A, 'gloam', 'M', GOV_KIT(2).filter(k => k !== 'governance'));
    sim.st.companies[A].credits += 3_000_000;
    // A: one small escort only
    garrison(sim, A, 'gloam', st, ['destroyer'], []);
    ff(sim, 6, upkeepHour(sim, A, 'gloam'));
    expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    addMods(st, ['governance']);
    const p0 = powerIn(sim, A, 'gloam');
    expect(evaluate(sim, A, 'gloam').mil.ok).toBe(false);
    // B (a PMC) has warships at hand; A posts a guard contract from its own credits, B accepts with its fleet
    const g = warships(sim, B, { ...st.pos, x: st.pos.x + 1500 }, Array(10).fill('cruiser'));
    const credA = sim.st.companies[A].credits;
    expect(cmd(sim, A, { op: 'guard', sys: 'gloam', hours: 12, reward: 60_000 })).toBeNull();
    expect(sim.st.companies[A].credits).toBe(credA - 60_000);
    const k = Object.values(sim.st.contracts).find(x => isMil(x) && x.mil.poster === A && !x.done)!;
    expect(sim.command(B, { c: 'accept', contract: k.id, group: g.id } as never)).toBeNull();
    ff(sim, 1);
    expect(powerIn(sim, A, 'gloam')).toBeGreaterThan(p0 + 600);
    expect(powerIn(sim, B, 'gloam')).toBeGreaterThan(0);   // B's own presence is still B's
    ff(sim, 10, upkeepHour(sim, A, 'gloam'));
    expect(evaluate(sim, A, 'gloam').mil.ok).toBe(true);
  }, 120_000);

  it('6 · a lawless system is legitimate only after the pirates are pacified (lair gone, no pirates for hours)', () => {
    const sim = fresh();
    const S = 'watch';
    expect(regionClass(sim.st, sim.st.systems[S])).toBe('lawless');
    const k = kit(sim, A, S, { perGate: ['cruiser', 'cruiser', 'destroyer'] });
    const tick = upkeepHour(sim, A, S);
    for (let h = 0; h < 12 && stageOf(sim, A, S) < 3; h++) ff(sim, 1, tick);
    expect(cmd(sim, A, { op: 'declare', sys: S })).toBeNull();
    addMods(k.st, ['governance', 'defense', 'defense', 'defense']);
    ff(sim, 4, tick);
    expect(evaluate(sim, A, S).legit.ok).toBe(false);
    expect(evaluate(sim, A, S).legit.miss.join()).toMatch(/소굴|해적/);
    // stand-in for the assault (lair destruction and pirate bands is covered by the B-2 hunt tests)
    for (const l of Object.values(sim.st.lairs)) if (sim.sysOf(l.pos)?.id === S) l.alive = false;
    for (const s of Object.values(sim.st.ships)) if ((s.owner === 'pirates' || sim.st.companies[s.owner]?.kind === 'pirate') && sim.sysOf(s.pos)?.id === S) delete sim.st.ships[s.id];
    ff(sim, 3, tick);
    expect(rec(sim, S).claims[A].legit).toBeUndefined();
    ff(sim, 6, tick);
    expect(rec(sim, S).claims[A]?.legit ?? rec(sim, S).how).toBe('pacify');
    for (let h = 0; h < 30 && rec(sim, S).owner !== A; h++) ff(sim, 1, tick);
    expect(rec(sim, S).owner).toBe(A);
    expect(rec(sim, S).how).toBe('pacify');
  }, 120_000);

  it('7 · two companies claim one system: neither establishes while the other holds ≥ 40 control; the stronger grip wins', () => {
    const sim = fresh();
    const sys = sim.st.systems.gloam;
    const a = outpost(sim, A, 'gloam', 'M', GOV_KIT(2).filter(k => k !== 'governance'), 0);
    const b = outpost(sim, B, 'gloam', 'M', GOV_KIT(2).filter(k => k !== 'governance'), 5);
    sim.st.companies[A].credits += 2_500_000; sim.st.companies[B].credits += 2_500_000;
    const atGate = (i: number) => ({ x: sys.gates[i].pos.x + (sys.origin.x - sys.gates[i].pos.x) * 0.1, y: 0, z: sys.gates[i].pos.z + (sys.origin.z - sys.gates[i].pos.z) * 0.1 });
    warships(sim, A, atGate(0), ['cruiser', 'destroyer', 'destroyer']); warships(sim, A, a.pos, Array(7).fill('cruiser'));
    const bg = warships(sim, B, atGate(1), ['cruiser', 'destroyer', 'destroyer']); warships(sim, B, b.pos, ['cruiser', 'cruiser', 'cruiser']);
    const both = () => { upkeepHour(sim, A, 'gloam')(); upkeepHour(sim, B, 'gloam')(); };
    ff(sim, 6, both);
    expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    expect(cmd(sim, B, { op: 'declare', sys: 'gloam' })).toBeNull();
    addMods(a, ['governance']); addMods(b, ['governance']);
    ff(sim, 24, both);
    const r = rec(sim, 'gloam');
    expect(r.owner).toBeUndefined();
    expect(r.ctl[A]).toBeGreaterThanOrEqual(40); expect(r.ctl[B]).toBeGreaterThanOrEqual(40);
    expect(fails(sim, A, 'gloam')).toContain('ctl');
    expect((sim.st.systems.gloam as any).terr.claims.length).toBe(2);
    // B's gate squadron leaves; A takes that gate too and pulls ahead
    for (const id of bg.shipIds) delete sim.st.ships[id];
    warships(sim, A, atGate(1), ['cruiser', 'destroyer', 'destroyer']);
    for (let h = 0; h < 40 && r.owner !== A; h++) ff(sim, 1, both);
    expect(r.owner).toBe(A);
    // B's claim cannot be legitimate against a sovereign without agreement or war
    expect(evaluate(sim, B, 'gloam').legit.ok).toBe(false);
  }, 180_000);

  it('8 · an NPC border system by negotiation: standing, control and a real price paid to the faction; the faction then leaves', () => {
    const sim = fresh();
    const S = 'sunder', f = sim.st.systems[S].faction!;
    expect(regionClass(sim.st, sim.st.systems[S])).toBe('npc_border');
    const k = kit(sim, A, S, { size: 'L', perGate: ['cruiser', 'cruiser', 'destroyer'], credits: 4_000_000 });
    const tick = upkeepHour(sim, A, S, 40_000);
    for (let h = 0; h < 12 && stageOf(sim, A, S) < 3; h++) ff(sim, 1, tick);
    expect(cmd(sim, A, { op: 'declare', sys: S })).toBeNull();
    addMods(k.st, ['governance', ...Array(4).fill('defense')]);
    ff(sim, 6, tick);
    expect(evaluate(sim, A, S).legit.ok).toBe(false);
    // standing below the bar: refused
    expect(cmd(sim, A, { op: 'negotiate', sys: S })).toMatch(/신뢰도/);
    bumpStanding(sim.st, A, f, 80 - (sim.st.companies[A].standing?.[f] ?? 0));   // stand-in for a long faction contract record
    const budget0 = sim.st.factions![f].econ!.budget, c0 = sim.st.companies[A].credits, m0 = moneySupply(sim.st);
    expect(cmd(sim, A, { op: 'negotiate', sys: S })).toBeNull();
    const price = c0 - sim.st.companies[A].credits;
    expect(price).toBeGreaterThan(SOV.cessionPrice);
    expect(sim.st.factions![f].econ!.budget).toBeCloseTo(budget0 + price, 3);
    void m0;   // the price leaves the companies' money and enters the faction treasury (not part of moneySupply)
    expect(rec(sim, S).ceded).toBe(A);
    expect(sim.st.systems[S].faction).toBe(f);           // still the faction's until established
    for (let h = 0; h < 50 && rec(sim, S).owner !== A; h++) ff(sim, 1, tick);
    expect(rec(sim, S).owner).toBe(A);
    expect(rec(sim, S).how).toBe('cession');
    expect(sim.st.systems[S].faction).toBeUndefined();   // the faction left; the system is not "faction = company"
    expect(sim.st.factions![f].claimed ?? []).not.toContain(S);
  }, 180_000);
});

describe('B-3 territory war', () => {
  /** B owns gloam (pioneered); A has a foothold and a claim there */
  let owned = '';
  beforeAll(() => {
    const sim = fresh();
    pioneer(sim, B, 'gloam');
    expect(rec(sim, 'gloam').owner).toBe(B);
    const a = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse'], 9);
    garrison(sim, A, 'gloam', a, ['cruiser', 'cruiser', 'cruiser', 'destroyer'], ['cruiser', 'cruiser', 'cruiser', 'cruiser', 'cruiser', 'cruiser']);
    sim.st.companies[A].credits += 3_000_000;
    for (let h = 0; h < 10 && stageOf(sim, A, 'gloam') < 3; h++) ff(sim, 1, () => { upkeepHour(sim, B, 'gloam')(); earn(sim, A, 30_000); });
    expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    owned = sim.serialize();
  }, 240_000);
  const both = (sim: WorldSim) => () => { upkeepHour(sim, B, 'gloam')(); earn(sim, A, 30_000); };
  /** B's fleets leave gloam (the owner is away) */
  /** B's fleets leave gloam (the owner is away) and A's station squadron moves onto B's governance seat */
  const bLeaves = (sim: WorldSim) => {
    const away = sim.st.systems.drift.origin; const moved: [WShip, any][] = [];
    for (const s of Object.values(sim.st.ships)) if (s.owner === B && sim.sysOf(s.pos)?.id === 'gloam') { moved.push([s, { ...s.pos }]); s.pos = { ...away, x: away.x + moved.length * 300 }; }
    const seat = Object.values(sim.st.stations).find(s => s.owner === B && sim.sysOf(s.pos)?.id === 'gloam')!;
    const sq = Object.values(sim.st.groups).find(g => g.owner === A && g.name === '기지 경비')!;
    for (const [i, id] of sq.shipIds.entries()) sim.st.ships[id].pos = { x: seat.pos.x + Math.cos(i) * 900, y: 0, z: seat.pos.z + Math.sin(i) * 900 };
    return moved;
  };

  it('10 · 12 · invading a player system: notice first, then a real hold; occupation is not sovereignty and cannot be imposed early', () => {
    const sim = restore(owned);
    expect(legalOf(sim.st, 'gloam')).toBe(B);
    const c0 = sim.st.companies[A].credits;
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toBeNull();
    expect(c0 - sim.st.companies[A].credits).toBe(SOV.warFee);
    const war = Object.values(sim.st.sov!.wars).find(x => x.sys === 'gloam')!;
    expect(war.status).toBe('notice');
    expect(war.start - war.at).toBe(SOV.noticeH * 3600);
    expect(sovWarHostile(sim.st, A, B, 'gloam')).toBe(false);   // nothing may be shot during the notice
    ff(sim, SOV.noticeH, both(sim));
    expect(war.status).toBe('active');
    expect(sovWarHostile(sim.st, A, B, 'gloam')).toBe(true);
    expect(sovWarHostile(sim.st, A, B, 'drift')).toBe(false);   // only in the war system
    bLeaves(sim);
    for (let h = 0; h < 30 && !rec(sim, 'gloam').occ; h++) ff(sim, 1, both(sim));
    const r = rec(sim, 'gloam');
    expect(r.occ?.by).toBe(A);
    expect(r.owner).toBe(B);                                       // 12: occupation does not move the title
    expect((sim.st.systems.gloam as any).terr.status).toBe('occupied');
    expect(cmd(sim, A, { op: 'impose', war: war.id })).toMatch(/점령 유지/);
    expect(cmd(sim, C, { op: 'impose', war: war.id })).toMatch(/공격 전쟁이 아닙니다/);
  }, 180_000);

  it('11 · the defender returns with its fleet and recaptures; the occupation unwinds', () => {
    const sim = restore(owned);
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toBeNull();
    ff(sim, SOV.noticeH, both(sim));
    const moved = bLeaves(sim);
    for (let h = 0; h < 30 && !rec(sim, 'gloam').occ; h++) ff(sim, 1, both(sim));
    expect(rec(sim, 'gloam').occ).toBeDefined();
    ff(sim, 4, both(sim));
    // B comes back stronger than A at its station and the gates
    for (const [s, p] of moved) s.pos = p;
    const gst = Object.values(sim.st.stations).find(s => s.owner === B && sim.sysOf(s.pos)?.id === 'gloam')!;
    garrison(sim, B, 'gloam', gst, ['cruiser', 'cruiser', 'cruiser', 'cruiser', 'cruiser'], ['cruiser', 'cruiser', 'cruiser', 'cruiser', 'cruiser', 'cruiser']);
    for (let h = 0; h < 30 && rec(sim, 'gloam').occ; h++) ff(sim, 1, both(sim));
    expect(rec(sim, 'gloam').occ).toBeUndefined();
    expect(rec(sim, 'gloam').owner).toBe(B);
    const war = Object.values(sim.st.sov!.wars).find(x => x.sys === 'gloam')!;
    expect(war.log.some(l => /탈환/.test(l.txt))).toBe(true);
  }, 180_000);

  it('13 · a long occupation lets the attacker impose a war treaty; only then does the title pass', () => {
    const sim = restore(owned);
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toBeNull();
    ff(sim, SOV.noticeH, both(sim));
    bLeaves(sim);
    for (let h = 0; h < 30 && !rec(sim, 'gloam').occ; h++) ff(sim, 1, both(sim));
    const war = Object.values(sim.st.sov!.wars).find(x => x.sys === 'gloam')!;
    ff(sim, CLASS.outer.holdH - 1, both(sim));
    expect(cmd(sim, A, { op: 'impose', war: war.id })).toMatch(/점령 유지/);
    ff(sim, 2, both(sim));
    expect(cmd(sim, A, { op: 'impose', war: war.id })).toBeNull();
    const r = rec(sim, 'gloam');
    expect(r.owner).toBe(A); expect(r.how).toBe('war'); expect(war.status).toBe('ended');
    expect(r.policy.pass).toBe('free');                          // the old sovereign's rules do not carry over
    // re-invasion limits after a war
    expect(cmd(sim, B, { op: 'war', sys: 'gloam' })).toMatch(/선언/);
  }, 180_000);

  it('9 · invading an NPC system: the faction answers with fleets drawn from its own strength (no free spawns)', () => {
    const sim = fresh();
    const S = 'sunder', f = sim.st.systems[S].faction!;
    const k = kit(sim, A, S, { size: 'L', perGate: ['cruiser', 'cruiser', 'cruiser', 'destroyer'], atStation: ['cruiser', 'cruiser', 'cruiser', 'cruiser'], credits: 4_000_000 });
    const tick = upkeepHour(sim, A, S, 40_000);
    for (let h = 0; h < 12 && stageOf(sim, A, S) < 3; h++) ff(sim, 1, tick);
    expect(cmd(sim, A, { op: 'declare', sys: S })).toBeNull();
    addMods(k.st, ['governance', ...Array(4).fill('defense')]);
    const str0 = sim.st.factions![f].strength, st0 = sim.st.companies[A].standing?.[f] ?? 0;
    expect(cmd(sim, A, { op: 'war', sys: S })).toBeNull();
    expect(sim.st.companies[A].standing![f]).toBeLessThan(st0);
    const war = Object.values(sim.st.sov!.wars).find(x => x.sys === S)!;
    expect(war.start - war.at).toBe(SOV.noticeNpcH * 3600);
    ff(sim, SOV.noticeNpcH + 1, tick);
    expect(war.status).toBe('active');
    const fleets = Object.keys(war.fleets ?? {});
    expect(fleets.length).toBeGreaterThan(0);
    const locked = Object.values(war.fleets!).reduce((a, b) => a + b, 0);
    expect(sim.st.factions![f].strength).toBeCloseTo(str0 - locked, 3);
    for (const id of fleets) expect(sim.st.groups[id]?.owner).toBe(`fac_${f}`);
    // A holds the system against the faction's administration; the faction's grip decays to an occupation
    for (let h = 0; h < 40 && !rec(sim, S).occ; h++) ff(sim, 1, tick);
    expect(rec(sim, S).occ?.by).toBe(A);
    expect(sim.st.systems[S].faction).toBe(f);
    ff(sim, CLASS.npc_border.holdH + 1, tick);
    expect(cmd(sim, A, { op: 'impose', war: war.id })).toBeNull();
    expect(rec(sim, S).owner).toBe(A);
    expect(sim.st.systems[S].faction).toBeUndefined();
    // a capital cannot be imposed while its faction is strong
    void 0;
  }, 240_000);
});

describe('B-3 governance, upkeep and protection', () => {
  let ruled = '';
  beforeAll(() => {
    const sim = fresh();
    pioneer(sim, B, 'gloam');
    expect(rec(sim, 'gloam').owner).toBe(B);
    ruled = sim.serialize();
  }, 240_000);
  const ship = (sim: WorldSim, co: string) => Object.values(sim.st.ships).find(s => s.owner === co)!;

  it('14 · mining permits and royalties move real credits; refusal needs real enforcement', () => {
    const sim = restore(ruled);
    expect(cmd(sim, A, { op: 'policy', sys: 'gloam', policy: { mine: 'permit' } })).toMatch(/영토가 아닙니다/);
    expect(cmd(sim, B, { op: 'policy', sys: 'gloam', policy: { mine: 'permit', price: { mine: 8000, build: 0, pass: 0 } } })).toBeNull();
    expect(sovMineBlock(sim, C, 'gloam')).toMatch(/허가/);
    const c0 = sim.st.companies[C].credits, b0 = sim.st.companies[B].credits;
    sim.st.companies[C].credits += 10_000;
    expect(cmd(sim, C, { op: 'permit', sys: 'gloam', kind: 'mine' })).toBeNull();
    expect(sim.st.companies[C].credits).toBe(c0 + 10_000 - 8000);
    expect(sim.st.companies[B].credits).toBe(b0 + 8000);
    expect(sovMineBlock(sim, C, 'gloam')).toBeNull();
    // royalty: owed on what is mined, collected from what the miner really has
    expect(cmd(sim, B, { op: 'policy', sys: 'gloam', policy: { mine: 'royalty', royalty: 0.1 } })).toBeNull();
    sovMined(sim, C, 'gloam', 50_000);
    expect(rec(sim, 'gloam').owed[C]).toBeCloseTo(5000, 3);
    const b1 = sim.st.companies[B].credits, cc = sim.st.companies[C].credits;
    ff(sim, 1, upkeepHour(sim, B, 'gloam'));
    const got = cc - sim.st.companies[C].credits;
    expect(got).toBeGreaterThan(0); expect(got).toBeLessThanOrEqual(5000);
    expect(rec(sim, 'gloam').led.reduce((a, x) => a + x.tax, 0)).toBe(got);
    void b1;
    // without the sovereign's warships the rule is words only
    sim.st.companies[C].credits = 0;
    expect(cmd(sim, B, { op: 'policy', sys: 'gloam', policy: { mine: 'exclusive' } })).toBeNull();
    sim.st.sov!.sys.gloam.permits.mine = {};
    expect(sovMineBlock(sim, C, 'gloam')).toMatch(/허가/);
    for (const s of Object.values(sim.st.ships)) if (s.owner === B) delete sim.st.ships[s.id];
    ff(sim, 0); run(sim, 61);
    expect(sovMineBlock(sim, C, 'gloam')).toBeNull();
  }, 120_000);

  it('15 · passage tolls and closures are enforced only where the sovereign really guards the gate', () => {
    const sim = restore(ruled);
    const dest = sim.st.systems.gloam, exit = dest.gates[0], s = ship(sim, C);
    expect(cmd(sim, B, { op: 'policy', sys: 'gloam', policy: { pass: 'toll', toll: 1500 } })).toBeNull();
    const c0 = sim.st.companies[C].credits = 5000, b0 = sim.st.companies[B].credits;
    expect(sovGateTransit(sim, s, exit, dest)).toBe(true);
    expect(sim.st.companies[C].credits).toBe(c0 - 1500);
    expect(sim.st.companies[B].credits).toBe(b0 + 1500);
    sim.st.companies[C].credits = 100;
    expect(sovGateTransit(sim, s, exit, dest)).toBe(false);          // cannot pay: refused, nothing taken
    expect(sim.st.companies[C].credits).toBe(100);
    expect(cmd(sim, B, { op: 'policy', sys: 'gloam', policy: { pass: 'restricted' } })).toBeNull();
    expect(sovGateTransit(sim, s, exit, dest)).toBe(false);
    expect(cmd(sim, B, { op: 'grant', sys: 'gloam', kind: 'pass', target: C, on: true })).toBeNull();
    expect(sovGateTransit(sim, s, exit, dest)).toBe(true);
    expect(cmd(sim, B, { op: 'grant', sys: 'gloam', kind: 'pass', target: C, on: false })).toBeNull();
    // the gate squadron leaves: the closure cannot be enforced there
    for (const x of Object.values(sim.st.ships)) if (x.owner === B && Math.hypot(x.pos.x - exit.pos.x, x.pos.z - exit.pos.z) < SOV.gateR + 500) delete sim.st.ships[x.id];
    run(sim, 61);
    expect(sovGateTransit(sim, s, exit, dest)).toBe(true);
    // the sovereign itself, NPC traffic and pirates are never charged
    expect(sovGateTransit(sim, ship(sim, B), exit, dest)).toBe(true);
  }, 120_000);

  it('16 · unpaid upkeep and a broken supply line erode stability, then the title is disputed and lost', () => {
    const sim = restore(ruled);
    const r = rec(sim, 'gloam');
    expect(r.stab).toBeGreaterThanOrEqual(60);
    sim.st.companies[B].credits = 0;
    ff(sim, 6);                                            // no income, no deliveries
    expect(r.arrears).toBeGreaterThan(0);
    expect(r.stab).toBeLessThan(60);
    expect(evaluate(sim, B, 'gloam').logi.ok).toBe(false);
    expect(sovReport(sim, B).alerts.join()).toMatch(/안정도/);
    // a rival with warships moves in while the sovereign is broke and unsupplied
    const a = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse'], 9);
    garrison(sim, A, 'gloam', a, ['cruiser', 'cruiser', 'cruiser', 'cruiser'], ['cruiser', 'cruiser', 'cruiser', 'cruiser']);
    for (const s of Object.values(sim.st.ships)) if (s.owner === B) delete sim.st.ships[s.id];   // the unpaid fleet is gone
    for (let h = 0; h < 120 && r.owner === B; h++) ff(sim, 1);
    expect(r.owner).toBeUndefined();
  }, 180_000);

  it('17 · a stable sovereign keeps its title through a short fleet absence and recovers afterwards', () => {
    const sim = restore(ruled);
    const r = rec(sim, 'gloam'), tick = upkeepHour(sim, B, 'gloam');
    ff(sim, 6, tick);
    const s0 = r.stab;
    const away = sim.st.systems.drift.origin, moved: [WShip, any][] = [];
    for (const s of Object.values(sim.st.ships)) if (s.owner === B && sim.sysOf(s.pos)?.id === 'gloam') { moved.push([s, { ...s.pos }]); s.pos = { ...away }; }
    ff(sim, 3, tick);
    expect(r.owner).toBe(B);
    expect(r.stab).toBeLessThan(s0);
    expect(r.stab).toBeGreaterThan(40);
    for (const [s, p] of moved) s.pos = p;
    ff(sim, 6, tick);
    expect(r.owner).toBe(B);
    expect(r.stab).toBeGreaterThan(s0 - 6);
  }, 120_000);

  it('18 · offline protection: notice, docked defenders sortie by themselves, and repeated invasions are limited', () => {
    const sim = restore(ruled);
    // B's reserve squadron is docked at its seat; B is offline
    const gst = Object.values(sim.st.stations).find(s => s.owner === B && sim.sysOf(s.pos)?.id === 'gloam')!;
    const res = warships(sim, B, gst.pos, ['cruiser', 'cruiser'], '예비 함대');
    for (const id of res.shipIds) { const s = sim.st.ships[id]; s.state = 'docked'; s.task = { k: 'docked', station: gst.id } as never; }
    const a = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse'], 9);
    garrison(sim, A, 'gloam', a, ['cruiser', 'cruiser', 'destroyer'], ['cruiser', 'cruiser', 'cruiser']);
    sim.st.companies[A].credits += 2_000_000;
    // a claim is needed before any war; the declaration costs money
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toMatch(/선언/);
    for (let h = 0; h < 10 && stageOf(sim, A, 'gloam') < 3; h++) ff(sim, 1, () => earn(sim, A, 30_000));
    expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toBeNull();
    const war = Object.values(sim.st.sov!.wars).find(x => x.sys === 'gloam')!;
    expect(war.start - war.at).toBe(SOV.noticeH * 3600);              // B was seen within 7 days: full notice
    expect(res.op.k).not.toBe('defend');
    ff(sim, SOV.noticeH + 1);
    expect(war.status).toBe('active');
    expect(res.op.k).toBe('defend');                                    // the docked reserve sortied on its own
    // the attacker cannot keep re-declaring: after a truce, 48 h for it and 12 h for anyone
    expect(cmd(sim, A, { op: 'propose', kind: 'truce', sys: 'gloam' })).toBeNull();
    const t = Object.values(sim.st.sov!.treaties).find(x => x.kind === 'truce')!;
    expect(cmd(sim, A, { op: 'answer', treaty: t.id, accept: true })).toMatch(/응답할 조약/);   // not addressed to A
    expect(cmd(sim, B, { op: 'answer', treaty: t.id, accept: true })).toBeNull();
    expect(war.status).toBe('ended');
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toMatch(/재침공 제한/);
    // a defender away for over a week gets a shorter notice (1 h) and a halved hold — the protection is bounded
    sim.st.sov!.co[B].seen = sim.time - 8 * 86400;
    ff(sim, SOV.truceCoolH + 1, () => earn(sim, A, 30_000));
    // a claim with no progress for 48 h lapses; the attacker declares again (another fee) before a new war
    if (!rec(sim, 'gloam').claims[A]) expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toBeNull();
    const w2 = Object.values(sim.st.sov!.wars).find(x => x.sys === 'gloam' && x.status !== 'ended')!;
    expect(w2.start - w2.at).toBe(SOV.noticeInactiveH * 3600);
  }, 180_000);

  it('19 · a territory defence contract: the hired company counts for the sovereign and fights on its side in a war', () => {
    const sim = restore(ruled);
    const gst = Object.values(sim.st.stations).find(s => s.owner === B && sim.sysOf(s.pos)?.id === 'gloam')!;
    const g = warships(sim, C, { ...gst.pos, x: gst.pos.x + 1200 }, ['cruiser', 'cruiser', 'destroyer']);
    const p0 = powerIn(sim, B, 'gloam');
    expect(cmd(sim, A, { op: 'guard', sys: 'gloam', hours: 4, reward: 20_000 })).toMatch(/주장하거나 영유/);
    expect(cmd(sim, B, { op: 'guard', sys: 'gloam', hours: 6, reward: 40_000 })).toBeNull();
    const k = Object.values(sim.st.contracts).find(x => isMil(x) && x.mil.poster === B && !x.done)!;
    expect(sim.command(C, { c: 'accept', contract: k.id, group: g.id } as never)).toBeNull();
    ff(sim, 1, upkeepHour(sim, B, 'gloam'));
    expect(powerIn(sim, B, 'gloam')).toBeGreaterThan(p0 + 300);
    // a war over gloam: the contractor is on the defender's side and lawful to fight — only in gloam
    const a = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse'], 9);
    garrison(sim, A, 'gloam', a, ['cruiser', 'destroyer'], ['cruiser', 'cruiser', 'cruiser']);
    sim.st.companies[A].credits += 2_000_000;
    for (let h = 0; h < 10 && stageOf(sim, A, 'gloam') < 3; h++) ff(sim, 1, () => earn(sim, A, 30_000));
    expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toBeNull();
    ff(sim, SOV.noticeH);
    const war = Object.values(sim.st.sov!.wars).find(x => x.sys === 'gloam')!;
    const [att, def] = warSides(sim.st, war);
    expect(def.has(C)).toBe(true); expect(att.has(C)).toBe(false);
    expect(sovWarHostile(sim.st, A, C, 'gloam')).toBe(true);
    expect(sovWarHostile(sim.st, A, C, 'drift')).toBe(false);
    // the defender can also hire war service against the attacker
    sim.st.companies[B].credits += 100_000;
    expect(cmd(sim, B, { op: 'warContract', war: war.id, hours: 4, reward: 50_000 })).toBeNull();
  }, 180_000);

  it('20 · each further territory costs more: higher upkeep and higher economic bars', () => {
    const sim = restore(ruled);
    const up1 = upkeepOf(sim, B, 'drift');
    const need1 = evaluate(sim, B, 'drift').econ.miss.join();
    // a second, nearer system for comparison: B already holds gloam
    sim.st.sov!.sys.gloam.owner = undefined;
    const up0 = upkeepOf(sim, B, 'drift');
    sim.st.sov!.sys.gloam.owner = B;
    expect(up1).toBeGreaterThan(up0 * 1.1);
    const m = /순자산 [\d,]+ \/ ([\d,]+)/.exec(need1);
    if (m) expect(Number(m[1].replace(/,/g, ''))).toBeGreaterThanOrEqual(SOV.assets * 1.5);
    // the claim limit
    sim.st.companies[B].credits += 1_000_000;
    for (const S of ['drift', 'cradle', 'mire']) { outpost(sim, B, S, 'M', ['power']); garrison(sim, B, S, undefined, ['cruiser', 'cruiser'], []); }
    for (let h = 0; h < 10; h++) ff(sim, 1, upkeepHour(sim, B, 'gloam'));
    const res = ['drift', 'cradle', 'mire'].map(S => cmd(sim, B, { op: 'declare', sys: S }));
    expect(res.filter(x => x === null).length).toBeLessThanOrEqual(SOV.maxClaims);
    expect(res.some(x => typeof x === 'string' && /곳까지/.test(x))).toBe(true);
  }, 180_000);

  it('21 · a company without territory is untouched: free mining, passage and building outside sovereign rules', () => {
    const sim = restore(ruled);
    for (const id of ['drift', 'harbor', 'watch', 'gloam']) {
      expect(sovMineBlock(sim, C, id)).toBeNull();
      expect(sovFoundRule(sim.st, id, C, sim.time).ok).toBe(true);
      expect(sovGateTransit(sim, ship(sim, C), sim.st.systems[id].gates[0], sim.st.systems[id])).toBe(true);
    }
    // its economy and contracts run as before (the a1 / b2 suites cover the full loop with B-3 on)
    const c0 = sim.st.companies[C].credits; run(sim, 600);
    expect(Number.isFinite(sim.st.companies[C].credits)).toBe(true);
    expect(sim.st.companies[C].credits).toBeGreaterThan(c0 - 50_000);
  }, 120_000);

  it('22 · save / restore mid-claim and mid-war: identical state and identical continuation', () => {
    const sim = restore(ruled);
    const a = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse'], 9);
    garrison(sim, A, 'gloam', a, ['cruiser', 'cruiser', 'destroyer'], ['cruiser', 'cruiser', 'cruiser']);
    sim.st.companies[A].credits += 2_000_000;
    for (let h = 0; h < 10 && stageOf(sim, A, 'gloam') < 3; h++) ff(sim, 1, () => earn(sim, A, 30_000));
    expect(cmd(sim, A, { op: 'declare', sys: 'gloam' })).toBeNull();
    expect(cmd(sim, A, { op: 'war', sys: 'gloam' })).toBeNull();
    ff(sim, 2);
    const save = sim.serialize();
    const back = restore(save);
    expect(JSON.stringify(back.st.sov)).toBe(JSON.stringify(sim.st.sov));
    ff(sim, 4); ff(back, 4);
    expect(JSON.stringify(back.st.sov!.sys.gloam)).toBe(JSON.stringify(sim.st.sov!.sys.gloam));
    expect(JSON.stringify(back.st.sov!.wars)).toBe(JSON.stringify(sim.st.sov!.wars));
  }, 120_000);
  it('24 · administration goods are reserved: fleet supply cannot take them, the excess stays usable, nothing is created, save keeps it, release returns it', () => {
    const sim = restore(ruled);
    const r = rec(sim, 'gloam'), need = supplyNeed(regionClass(sim.st, sim.st.systems.gloam));
    const G = Object.values(sim.st.stations).find(s => s.owner === B && sim.sysOf(s.pos)?.id === 'gloam' && s.modules.some(m => m.kind === 'governance'))!;
    const sto = G.storage[B];
    // exactly 3 h of need in storage, then one territory cycle: 1 h is moved into the reservation
    for (const k of Object.keys(need)) sto[k] = need[k] * 3;
    for (const k of Object.keys(r.gov![B].res ?? {})) delete r.gov![B].res![k];
    r.gov![B].stock = undefined;
    ff(sim, 0); for (let m = 0; m < 1; m++) { sim.st.time += 60; sovTick(sim, 60); }
    const L = r.gov![B];
    for (const k of Object.keys(need)) {
      expect(L.res![k]).toBeCloseTo(need[k], 3);
      // conservation: storage + reservation = 3 h − the minute consumed
      expect(sto[k] + L.res![k]).toBeCloseTo(need[k] * 3 - need[k] / 60, 3);
    }
    // the fleet's upkeep wants far more alloy than is free: it takes the free stock, never the reservation
    const u = sim.st.companies[B].upkeep!; u.stage = 0; u.supplies = { alloy: 10_000 }; u.last = -1e9;
    const before = sto.alloy ?? 0;
    stepUpkeep(sim.st, sim.st.companies[B], 60);
    expect(before).toBeGreaterThan(0);
    expect(sto.alloy ?? 0).toBe(before - Math.floor(before));
    expect(L.res!.alloy).toBeCloseTo(need.alloy, 3);
    // the seat keeps running on its reservation for the next hour although the free alloy is gone
    for (let m = 0; m < 50; m++) { sim.st.time += 60; sovTick(sim, 60); }
    expect(L.short ?? 0).toBe(0);
    expect(L.lack?.alloy).toBeGreaterThan(0);               // the shortfall is reported before the seat stops
    expect(evaluate(sim, B, 'gloam').logi.miss.join(' ')).toMatch(/예약 부족/);
    const rep = sovReport(sim, B).rows.find(x => x.sys === 'gloam')!;
    expect(rep.supply!.reserved!.alloy).toBeGreaterThan(0); expect(rep.supply!.lack!.alloy).toBeGreaterThan(0);
    // save / restore keeps reservation, shortfall and stall state
    const back = restore(sim.serialize());
    expect(JSON.stringify(back.st.sov!.sys.gloam.gov)).toBe(JSON.stringify(r.gov));
    // reserved goods hold warehouse space
    expect(govReservedSpace(sim.st, G.id, B)).toBeGreaterThan(0);
    // the governance stops (facility demolished): the reservation goes back to storage, nothing lost or made
    const tot = (k: string) => (sto[k] ?? 0) + (L.res?.[k] ?? 0);
    const t0 = Object.fromEntries(Object.keys(need).map(k => [k, tot(k)]));
    G.modules = G.modules.filter(m => m.kind !== 'governance');
    sim.st.time += 60; sovTick(sim, 60);
    expect(L.res).toBeUndefined();
    for (const k of Object.keys(need)) expect(sto[k] ?? 0).toBeCloseTo(t0[k], 6);
  }, 120_000);
  it('25 · two claimants in one system keep separate administration records: one company’s shortage never touches the other', () => {
    const sim = fresh();
    const a = outpost(sim, A, 'gloam', 'M', GOV_KIT(2), 0);
    const b = outpost(sim, B, 'gloam', 'M', GOV_KIT(2), 5);
    sim.st.companies[A].credits += 2_500_000; sim.st.companies[B].credits += 2_500_000;
    warships(sim, A, a.pos, ['cruiser', 'cruiser']); warships(sim, B, b.pos, ['cruiser', 'cruiser']);
    const r = rec(sim, 'gloam');
    r.claims[A] = { co: A, at: sim.time, prog: 0, live: sim.time, stage: 4 } as never;
    r.claims[B] = { co: B, at: sim.time, prog: 0, live: sim.time, stage: 4 } as never;
    // A's haulers keep a buffer and deliver every hour; B's seat gets nothing
    deliver(sim, A, a, 1, 2);
    ff(sim, 4, () => { deliver(sim, A, a, 1.2); earn(sim, A, 30_000); earn(sim, B, 30_000); });
    const LA = r.gov![A], LB = r.gov![B];
    expect(LA.short ?? 0).toBe(0);
    expect(LB.short).toBeGreaterThan(3600);
    expect(supplyStats(r, A, sim.time).ratio).toBeGreaterThanOrEqual(SOV.supplyShare);
    expect(supplyStats(r, B, sim.time).ratio).toBe(0);
    expect(LA.seat).toBe(a.id); expect(LB.seat).toBe(b.id);
    expect(Object.keys(LB.res ?? {})).toHaveLength(0);
    // only B's seat lost its weight as a control point; A's still counts as a government
    const pts = points(sim, 'gloam');
    expect(pts.find(p => p.id === 'st:' + a.id)!.w).toBe(3);
    expect(pts.find(p => p.id === 'st:' + b.id)!.w).toBe(2);
    // and only B's report shows a stalled seat
    expect(evaluate(sim, B, 'gloam').logi.miss.join(' ')).toMatch(/멈춰/);
    expect(evaluate(sim, A, 'gloam').logi.miss.join(' ')).not.toMatch(/멈춰|예약 부족/);
    // B's claim ends: its record is dropped, A's is untouched
    const keep = JSON.stringify(LA);
    expect(cmd(sim, B, { op: 'withdraw', sys: 'gloam' })).toBeNull();
    sim.st.time += 60; sovTick(sim, 60);
    expect(r.gov![B]).toBeUndefined();
    expect(JSON.parse(keep).seat).toBe(r.gov![A].seat);
  }, 120_000);
  it('26 · a save from before the split: the shared administration record moves to the sovereign, the seat keeps working', () => {
    const sim = restore(ruled);
    const r = rec(sim, 'gloam'), g = r.gov![B];
    const G = sim.st.stations[g.seat!];
    for (const [k, n] of Object.entries(g.res ?? {})) G.storage[B][k] = (G.storage[B][k] ?? 0) + n;   // old saves had no reservation
    delete r.gov; r.sup = g.sup; r.stock = g.stock; r.short = 0;
    sim.st.time += 60; sovTick(sim, 60);
    expect(r.sup).toBeUndefined(); expect(r.stock).toBeUndefined();
    expect(r.gov![B].sup.length).toBe(g.sup.length);
    expect(Object.keys(r.gov![B].res ?? {}).length).toBeGreaterThan(0);
    expect(r.owner).toBe(B);
    expect(evaluate(sim, B, 'gloam').logi.ok).toBe(true);
  }, 120_000);
});

// ───────────────────────────────────────────── 23 · the multiplayer server
const ACC = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const conn = (id: string, account: string) => { const inbox: ServerMsg[] = []; const c: Conn = { id, account, lastEvent: 0, battles: new Set(), send: m => inbox.push(JSON.parse(JSON.stringify(m))) }; return { c, inbox }; };
const ack = (inbox: ServerMsg[], id: number) => (inbox.find(m => m.t === 'ack' && (m as any).id === id) as any)?.err;

describe('B-3 on the multiplayer server', () => {
  it('23 · authority on the server: only the sovereign rules, others buy what is sold, treaties answer only the addressee; restart keeps it', () => {
    const srv = new GameServer(null, { singleplayer: false, accounts: true, snapInterval: 0.5, worldPreset: 'standard' }, 7);
    const ids: string[] = [], boxes: ServerMsg[][] = [];
    for (const [i, n] of ['영주', '방문사', '제3사'].entries()) {
      const x = conn('c' + i, ACC[i]); srv.connect(x.c); srv.handle('c' + i, { t: 'hello', name: 'x', token: 'x' } as never);
      srv.handle('c' + i, { t: 'createPmc', name: n, background: 'veteran' } as never);
      boxes.push(x.inbox); ids.push((x.inbox.find(m => m.t === 'welcome') as any).company);
    }
    const sim = srv.sim, [O, V, T] = ids;
    expect(sim.st.sovV).toBe(1);
    pioneer(sim, O, 'gloam');
    expect(rec(sim, 'gloam').owner).toBe(O);
    let n = 1;
    const send = (i: number, c: Record<string, unknown>) => { const id = n++; srv.handle('c' + i, { t: 'cmd', id, cmd: { c: 'sov', ...c } } as never); return ack(boxes[i], id); };
    expect(send(1, { op: 'policy', sys: 'gloam', policy: { pass: 'restricted' } })).toMatch(/영토가 아닙니다/);
    expect(send(0, { op: 'policy', sys: 'gloam', policy: { pass: 'restricted', price: { mine: 0, build: 0, pass: 3000 } } })).toBeNull();
    expect(send(2, { op: 'grant', sys: 'gloam', kind: 'pass', target: ids[2], on: true })).toMatch(/영토가 아닙니다/);
    const v0 = sim.st.companies[V].credits;
    expect(send(1, { op: 'permit', sys: 'gloam', kind: 'pass' })).toBeNull();
    expect(sim.st.companies[V].credits).toBe(v0 - 3000);
    // a transfer offered by the sovereign can be answered only by its addressee
    expect(send(0, { op: 'propose', kind: 'transfer', sys: 'gloam', to: V, pay: 0 })).toBeNull();
    const t = Object.values(sim.st.sov!.treaties).find(x => x.kind === 'transfer')!;
    expect(send(2, { op: 'answer', treaty: t.id, accept: true })).toMatch(/응답할 조약/);
    // the views: everyone sees the system's public territory; only the owner gets its report
    srv.step(1);
    // fog: a company that never saw gloam does not see its territory either; once it has visited, it sees the title
    if (sim.st.fog && sysLevel(sim.st, T, 'gloam') < 1) expect((legacyView(sim.st, { company: T } as never, 'gloam') as any).systems.gloam).toBeUndefined();
    visit(sim.st, V, 'gloam');
    const vV = legacyView(sim.st, { company: V } as never, 'gloam') as unknown as WorldState;
    expect((vV.systems.gloam as any).terr?.owner).toBe(O);
    expect(vV.companies[O].sovx).toBeUndefined();
    expect(vV.companies[V].sovx).toBeDefined();
    // restart from the save: the title, policy and offer survive
    const srv2 = new GameServer(JSON.parse(JSON.stringify(srv.snapshotFile())), { singleplayer: false, accounts: true, snapInterval: 0.5 }, 7);
    expect(srv2.sim.st.sov!.sys.gloam.owner).toBe(O);
    expect(srv2.sim.st.sov!.sys.gloam.policy.pass).toBe('restricted');
    expect(srv2.sim.st.sov!.treaties[t.id].status).toBe('offer');
    // and the addressee accepts on the restarted server: the title passes by agreement
    const x = conn('v2', ACC[1]); srv2.connect(x.c); srv2.handle('v2', { t: 'hello', name: 'x', token: 'x' } as never);
    srv2.handle('v2', { t: 'cmd', id: 900, cmd: { c: 'sov', op: 'answer', treaty: t.id, accept: true } } as never);
    expect(ack(x.inbox, 900)).toBeNull();
    expect(srv2.sim.st.sov!.sys.gloam.owner).toBe(V);
    expect(srv2.sim.st.sov!.sys.gloam.how).toBe('agreement');
    void T;
  }, 240_000);
});
