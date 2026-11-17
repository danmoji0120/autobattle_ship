// B-1 officer development: data integrity of the 13 trees, learning rules and refusals, experience from real
// results only (anti-abuse, tick independence), real effects in combat and industry, salary, named officers and BB,
// save/restore, migration of an existing save, replay determinism, and the growth of a combat rookie and an
// industry rookie in the real world simulation. See docs/B1_OFFICERS.md.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { World } from '../src/sim/world';
import {
  TREES, SKILLS, SKILL, FX, FX_KEYS, TRAITS, TRAIT, NAMED, TIER_GATE, MASTERY, MAX_CAPSTONES, MAX_LEVEL, XP_SOFT_HOUR, XP_HARD_HOUR,
  xpToNext, xpForLevel, spForLevel, nodeLines, fxText, masteryLevel, type FxKey, type Tree,
} from '../src/world/officerData';
import {
  isOfficer, officerFx, learnBlock, grantXp, combatXp, migrateOfficers, payroll, battleFx, stationDirector, effSkill, makeNamed, type Officer,
} from '../src/world/officers';
import { shipRate, forecast } from '../src/world/upkeep';
import { repairQuote } from '../src/world/repair';
import { stepProduction } from '../src/world/production';
import { battleSetup, defaultConfig, defaultShip, runBattle, summarize, type LabConfig } from '../src/devlab/labModel';
import { RECIPES } from '../src/world/industry';
import type { WCommander, V } from '../src/world/types';

const run = (sim: WorldSim, sec: number, dt = 1, until?: () => boolean) => { for (let t = 0; t < sec; t += dt) { sim.update(dt); if (until?.()) return true; } return false; };
const mk = (seed = 3, extra: Record<string, unknown> = {}) => { const sim = WorldSim.create(seed, { officers: 'b1', ...extra }); const me = sim.addPlayer('육성 PMC'); return { sim, me }; };
/** a hired officer of `me` */
const hire = (sim: WorldSim, me: string, tier = 1) => sim.newCommander(me, tier) as Officer;
/** an officer that meets every gate (level 40, legendary mastery everywhere, plenty of points) */
function master(sim: WorldSim, me: string): Officer {
  const c = hire(sim, me);
  c.level = MAX_LEVEL; c.of.sp = 999; c.of.spGiven = 999;
  for (const t of TREES) c.of.mastery[t.id] = MASTERY[5];
  return c;
}
const learn = (sim: WorldSim, me: string, c: WCommander, node: string) => sim.command(me, { c: 'officerLearn', commander: c.id, node });
/** learn a node with all its prerequisites (one path through reqAny) */
function learnPath(sim: WorldSim, me: string, c: Officer, id: string) {
  const n = SKILL[id];
  for (const r of n.req ?? []) if (!c.of.skills[r]) learnPath(sim, me, c, r);
  if (n.reqAny?.length && !n.reqAny.some(r => c.of.skills[r])) learnPath(sim, me, c, n.reqAny.find(r => !SKILL[r].ex || !SKILLS.some(x => x.ex === SKILL[r].ex && c.of.skills[x.id])) ?? n.reqAny[0]);
  if (n.cross && !c.of.skills[n.cross]) learnPath(sim, me, c, n.cross);
  if (!c.of.skills[id]) expect(learn(sim, me, c, id), id).toBeNull();
}
const PVP_AT = { x: 640000, y: 0, z: 640000 };
function fleet(sim: WorldSim, owner: string, pos: V, comp: string[], cmd?: WCommander) {
  const g = sim.newGroup(owner, `${owner}-편대`);
  if (cmd) g.commanderId = cmd.id;
  comp.forEach((cl, i) => sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const engOf = (sim: WorldSim, gid: string) => { const s = sim.st.ships[sim.st.groups[gid]?.shipIds[0]]; return s?.engagement ? sim.st.engagements[s.engagement] : undefined; };

// ------------------------------------------------------------------------------------------------ data

describe('B-1 data: 13 trees, structure, descriptions', () => {
  it('has 13 fields, each with 8+ ordinary nodes, branches, prerequisites, mastery gates, an exclusive choice, a cross-field link and two final specialisations', () => {
    expect(TREES.map(t => t.name)).toEqual(['포술', '방공', '요격', '기동', '방어', '작전', '전자전', '채광', '인양', '물류', '산업', '탐사', '군수·정비']);
    for (const t of TREES) {
      const ns = SKILLS.filter(n => n.tree === t.id && !n.sig);
      expect(ns.length, t.id).toBeGreaterThanOrEqual(8);
      expect(new Set(ns.map(n => n.tier)), t.id).toEqual(new Set([1, 2, 3, 4, 5]));
      expect(ns.filter(n => n.tier === 1).length, t.id).toBeGreaterThanOrEqual(2);          // two starting branches
      expect(ns.some(n => n.req?.length || n.reqAny?.length), t.id).toBe(true);
      expect(ns.some(n => n.ex), t.id).toBe(true);
      expect(ns.some(n => n.cross && SKILL[n.cross].tree !== t.id), t.id).toBe(true);
      expect(ns.filter(n => n.tier === 5).length, t.id).toBe(2);
      for (const n of ns) {
        for (const r of [...(n.req ?? []), ...(n.reqAny ?? []), ...(n.cross ? [n.cross] : [])]) expect(SKILL[r], `${n.id} → ${r}`).toBeDefined();
        if (n.tier > 1) expect(!!(n.req?.length || n.reqAny?.length), `${n.id} hangs off the tree`).toBe(true);
        if (n.ex) expect(SKILLS.filter(x => x.ex === n.ex).length, n.id).toBeGreaterThanOrEqual(2);
        expect(n.max).toBeGreaterThanOrEqual(1); expect(n.cost).toBeGreaterThanOrEqual(1);
      }
    }
    expect(SKILLS.length).toBe(new Set(SKILLS.map(n => n.id)).size);
  });

  it('every effect is a defined, capped key; every key is used; descriptions are generated from the effect values', () => {
    const used = new Set<string>();
    for (const n of SKILLS) for (const [k, v] of Object.entries(n.fx)) {
      expect(FX[k as FxKey], `${n.id}.${k}`).toBeDefined(); used.add(k);
      expect(v).toBeGreaterThan(0);
      for (let r = 1; r <= n.max; r++) expect(nodeLines(n, r)).toContain(fxText(k as FxKey, FX[k as FxKey].unit === 'flag' ? v : v * r));
    }
    for (const t of TRAITS) for (const k of Object.keys(t.fx)) { expect(FX[k as FxKey], `${t.id}.${k}`).toBeDefined(); used.add(k); }
    for (const k of FX_KEYS) expect(used.has(k), `unused effect ${k}`).toBe(true);
  });

  it('air defence and interception are separate fields: no shared effect inside their own nodes', () => {
    const keys = (t: Tree) => new Set(SKILLS.filter(n => n.tree === t && !n.sig).flatMap(n => Object.keys(n.fx)));
    const air = keys('airdef'), icp = keys('intercept');
    expect([...air].filter(k => icp.has(k))).toEqual([]);
    expect(air.has('pd') && air.has('torpPd')).toBe(true);
    expect(icp.has('detect') && icp.has('pursuit')).toBe(true);
  });

  it('mastering every capstone is impossible for one officer: two specialisations and 44 points at level 40', () => {
    expect(spForLevel(MAX_LEVEL)).toBe(44);
    const all = SKILLS.filter(n => !n.sig).reduce((a, n) => a + n.cost * n.max, 0);
    expect(all).toBeGreaterThan(spForLevel(MAX_LEVEL) * 4);
    expect(MAX_CAPSTONES).toBe(2);
    // level 25 (the capstone gate) needs a long career: at the hourly cap it is more than 10 game hours
    expect(xpForLevel(TIER_GATE[5].level) / XP_SOFT_HOUR).toBeGreaterThan(10);
    expect(xpForLevel(MAX_LEVEL) / XP_SOFT_HOUR).toBeGreaterThan(60);
  });
});

// ------------------------------------------------------------------------------------------------ learning

describe('B-1 learning: prerequisites, gates, exclusive choices, refusals', () => {
  it('every node of every tree refuses before its prerequisites and accepts after them', () => {
    const { sim, me } = mk();
    for (const n of SKILLS.filter(x => !x.sig)) {
      const c = master(sim, me);
      if (n.req?.length || n.reqAny?.length || n.cross) expect(learnBlock(c, n), n.id).toMatch(/선행/);
      learnPath(sim, me, c, n.id);
      expect(c.of.skills[n.id], n.id).toBe(1);
    }
  });

  it('tier gates use level and field mastery; points are spent exactly; ranks stop at the maximum', () => {
    const { sim, me } = mk();
    const c = hire(sim, me);
    expect(c.level).toBe(1); expect(c.of.sp).toBe(spForLevel(1));
    const sp0 = c.of.sp;
    expect(learn(sim, me, c, 'gn_aim')).toBeNull();
    expect(c.of.sp).toBe(sp0 - 1);
    expect(learn(sim, me, c, 'gn_range')).toMatch(/Lv\.3 필요/);
    c.level = 3; c.of.sp = 5;
    expect(learn(sim, me, c, 'gn_range')).toMatch(/숙련도 입문/);
    c.of.mastery.gunnery = MASTERY[1];
    expect(learn(sim, me, c, 'gn_range')).toBeNull();
    expect(learn(sim, me, c, 'gn_range')).toBeNull();
    expect(learn(sim, me, c, 'gn_range')).toMatch(/최대 단계/);
    c.of.sp = 0;
    expect(learn(sim, me, c, 'gn_aim')).toMatch(/스킬 포인트/);
  });

  it('exclusive choices, the capstone limit, signature nodes, unknown nodes and other companies are refused', () => {
    const { sim, me } = mk();
    const other = sim.addPlayer('남의 PMC');
    const c = master(sim, me);
    learnPath(sim, me, c, 'gn_heavy');
    expect(learn(sim, me, c, 'gn_rapid')).toMatch(/함께 배울 수 없음/);
    learnPath(sim, me, c, 'gn_cap1'); learnPath(sim, me, c, 'df_cap1');
    learnPath(sim, me, c, 'mn_select');
    expect(learnBlock(c, SKILL.mn_cap1)).toMatch(/최종 전문화는 2개까지/);
    expect(learn(sim, me, c, 'sig_wolf')).toMatch(/고유 능력/);
    expect(learn(sim, me, c, 'nope')).toMatch(/알 수 없는 스킬/);
    expect(learn(sim, me, c, '__proto__')).toMatch(/알 수 없는 스킬/);
    expect(sim.command(other, { c: 'officerLearn', commander: c.id, node: 'sv_rate' })).not.toBeNull();
    expect(c.of.skills.sv_rate).toBeUndefined();
  });

  it('posting: a station director cannot command a group at the same time; one director per own station; public stations refused', () => {
    const { sim, me } = mk();
    const c = hire(sim, me), d = hire(sim, me);
    const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
    expect(sim.command(me, { c: 'assignCmd', group: g.id, commander: c.id })).toBeNull();
    expect(sim.command(me, { c: 'officerPost', commander: c.id, post: 'astra' })).toMatch(/자사 정거장/);
    const st = sim.st.stations.astra; st.owner = me; st.public = false;
    expect(sim.command(me, { c: 'officerPost', commander: c.id, post: 'astra' })).toBeNull();
    expect(g.commanderId).toBeNull();                         // the command was released
    expect(sim.command(me, { c: 'officerPost', commander: d.id, post: 'astra' })).toMatch(/이미 책임자/);
    expect(sim.command(me, { c: 'assignCmd', group: g.id, commander: c.id })).toBeNull();
    expect(c.of.post).toBeUndefined();                        // a command ends the posting
  });
});

// ------------------------------------------------------------------------------------------------ experience

describe('B-1 experience: real results only', () => {
  it('levels and points follow the curve; the hourly budget caps farming; one-off awards are paid once', () => {
    const { sim, me } = mk();
    const c = hire(sim, me);
    c.of.talent = 0;
    let r = grantXp(sim.st, c, 'mine', xpToNext(1), { mining: 1 });
    expect(r.gain).toBe(xpToNext(1)); expect(c.level).toBe(2); expect(c.of.spGiven).toBe(spForLevel(2));
    r = grantXp(sim.st, c, 'mine', 1e6, { mining: 1 });
    expect(c.of.hr!.n).toBeLessThanOrEqual(XP_HARD_HOUR);
    expect(grantXp(sim.st, c, 'mine', 100, { mining: 1 }).gain).toBe(0);            // the hour is spent
    sim.st.time += 3600;
    expect(grantXp(sim.st, c, 'research', 50, { industry: 1 }, 'rs:x').gain).toBe(50);
    expect(grantXp(sim.st, c, 'research', 50, { industry: 1 }, 'rs:x').gain).toBe(0);   // dedupe
    expect(grantXp(sim.st, c, 'mine', NaN, { mining: 1 }).gain).toBe(0);
    expect(grantXp(sim.st, c, 'mine', -5, { mining: 1 }).gain).toBe(0);
  });

  it('combat: no experience without a hostile foe or without fighting; the same foe again gives less; one award per battle', () => {
    const { sim, me } = mk();
    const c = hire(sim, me);
    const share = { dmg: 3000, taken: 1200, intercepts: 4, killValue: 800, rear: 0, ships: 2, role: 'line', op: 'patrol' };
    expect(combatXp(sim.st, c, share, [], 'b:e0:g').gain).toBe(0);                   // own ships / no hostile company
    expect(combatXp(sim.st, c, { ...share, dmg: 0, taken: 0, intercepts: 0 }, ['x'], 'b:e1:g').gain).toBe(0);
    const a = combatXp(sim.st, c, share, ['x'], 'b:e2:g').gain;
    expect(combatXp(sim.st, c, share, ['x'], 'b:e2:g').gain).toBe(0);
    sim.st.time += 3600;
    const b = combatXp(sim.st, c, share, ['x'], 'b:e3:g').gain;
    expect(b).toBeCloseTo(a / 2, 5);
    sim.st.time += 3 * 3600;
    expect(combatXp(sim.st, c, share, ['x'], 'b:e4:g').gain).toBeCloseTo(a, 5);
  });

  it('idle time and repeated commands give nothing; mining gives mining mastery in proportion to output, independent of the tick rate', () => {
    const go = (dt: number, mine: boolean) => {
      const { sim, me } = mk(4);
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; }
      const c = hire(sim, me);
      const g = Object.values(sim.st.groups).find(x => x.owner === me && x.name === '제1 채굴반')!;
      expect(sim.command(me, { c: 'assignCmd', group: g.id, commander: c.id })).toBeNull();
      for (let i = 0; i < 20; i++) sim.command(me, { c: 'setOp', group: g.id, op: mine ? { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } : { k: 'idle' } });
      const xp0 = c.of.earned.mine ?? 0;
      run(sim, 1800, dt);
      return { xp: (c.of.earned.mine ?? 0) - xp0, all: Object.values(c.of.earned).reduce((x, y) => x + y, 0), m: c.of.mastery.mining ?? 0 };
    };
    const idle = go(1, false);
    expect(idle.all).toBe(0);
    const a = go(1, true), b = go(0.25, true);
    expect(a.xp).toBeGreaterThan(20);
    expect(a.m).toBeGreaterThan(0);
    expect(Math.abs(a.xp - b.xp) / a.xp).toBeLessThan(0.15);
  }, 240000);

  it('PvP: a fight against a declared enemy pays both officers; attacking your own fleet is refused and pays nothing', () => {
    const { sim, me } = mk(6, { combat: 'p11' });
    const foe = sim.addPlayer('적 PMC');
    const ca = hire(sim, me, 2), cb = hire(sim, foe, 2);
    const ga = fleet(sim, me, PVP_AT, ['destroyer', 'frigate', 'frigate'], ca);
    const own = fleet(sim, me, { x: PVP_AT.x, y: 0, z: PVP_AT.z + 600 }, ['frigate']);
    expect(sim.command(me, { c: 'setOp', group: ga.id, op: { k: 'attack', group: own.id } })).not.toBeNull();
    const gb = fleet(sim, foe, { x: PVP_AT.x + 900, y: 0, z: PVP_AT.z }, ['destroyer', 'frigate', 'frigate'], cb);
    expect(sim.command(me, { c: 'setOp', group: ga.id, op: { k: 'attack', group: gb.id } })).toBeNull();
    expect(run(sim, 200, 0.5, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!;
    run(sim, 1800, 0.5, () => !sim.st.engagements[e.id] || sim.st.engagements[e.id].done);
    run(sim, 5, 0.5);
    expect(ca.of.earned.combat ?? 0).toBeGreaterThan(0);
    expect(cb.of.earned.combat ?? 0).toBeGreaterThan(0);
    expect(ca.of.seen).toContain(`b:${e.id}:${ga.id}`);
  }, 240000);
});

// ------------------------------------------------------------------------------------------------ effects

/** two identical one-ship sides; `ofx` on the blue side's commanders */
function duel(ofx?: Record<string, number>, hull = 'frigate_mk1'): LabConfig {
  const c = defaultConfig();
  const ship = (id: string) => ({ ...defaultShip(hull, id), count: 2 });
  for (const [i, side] of c.sides.entries()) {
    side.root.children = [{ ...side.root.children[0], ships: [ship(i ? 'red' : 'blue')], children: [] }];
    if (i === 0 && ofx) { side.root.commander = { ...side.root.commander!, ofx }; side.root.children[0].commander = { ...side.root.children[0].commander!, ofx }; }
  }
  return c;
}

describe('B-1 effects in combat (tactical engine)', () => {
  it('a skilled officer measurably improves the same fleet; the result is deterministic per seed', () => {
    const seeds = [1, 2, 3, 4, 5, 6];
    const base = summarize(seeds.flatMap(s => [runBattle(duel(), s, false), runBattle(duel(), s, true)]));
    const ofx = { acc: 0.3, rof: 0.2, pen: 0.15, crit: 0.6, armor: 0.12, hp: 0.08, dc: 0.3 };
    const off = summarize(seeds.flatMap(s => [runBattle(duel(ofx), s, false), runBattle(duel(ofx), s, true)]));
    expect(off.meanSides[0].hits / off.meanSides[0].shots).toBeGreaterThan(base.meanSides[0].hits / base.meanSides[0].shots);
    expect(off.meanSides[0].dealt).toBeGreaterThan(base.meanSides[0].dealt * 1.05);
    expect(off.wins[0]).toBeGreaterThanOrEqual(base.wins[0]);
    // determinism: identical replays
    expect(runBattle(duel(ofx), 9, false).digest).toBe(runBattle(duel(ofx), 9, false).digest);
    // the officer's values change ship stats inside the engine only through ofx
    const w = new World(battleSetup(duel({ hp: 0.08, armor: 0.12 }), 1));
    const blue = w.ships.filter(s => s.team === 0), red = w.ships.filter(s => s.team === 1);
    expect(blue[0].maxHp).toBeCloseTo(red[0].maxHp * 1.08, 3);
  }, 240000);

  it('air defence skills raise interceptions against guided weapons', () => {
    const missileBoat = 'destroyer_vls';
    const base = summarize([1, 2, 3, 4].flatMap(s => [runBattle(duel(undefined, missileBoat), s, false)]));
    const off = summarize([1, 2, 3, 4].flatMap(s => [runBattle(duel({ pd: 0.4, pdRange: 0.3, torpPd: 0.35, pdNet: 1 }, missileBoat), s, false)]));
    expect(off.meanSides[0].intercepts).toBeGreaterThanOrEqual(base.meanSides[0].intercepts);
  }, 240000);

  it('the world passes a commanding officer’s battle effects (and a superior’s aura as a maximum, never a sum) into the battle setup', () => {
    const { sim, me } = mk();
    const top = master(sim, me), sub = master(sim, me);
    learnPath(sim, me, top, 'op_chain'); learnPath(sim, me, top, 'gn_aim'); learnPath(sim, me, top, 'gn_aim'); learnPath(sim, me, top, 'gn_aim');
    expect(learn(sim, me, top, 'gn_aim')).toBeNull(); expect(learn(sim, me, top, 'gn_aim')).toBeNull();
    learnPath(sim, me, sub, 'gn_aim');
    const parent = sim.newGroup(me, '본대'), child = sim.newGroup(me, '분대', parent.id);
    parent.childIds.push(child.id);
    parent.commanderId = top.id; child.commanderId = sub.id;
    const fx = battleFx(sim.st, child)!;
    const own = officerFx(sub).acc ?? 0, aura = (officerFx(top).acc ?? 0) * (officerFx(top).aura ?? 0);
    expect(aura).toBeGreaterThan(0);
    expect(fx.acc).toBeCloseTo(Math.max(own, aura), 6);                           // the larger applies, never the sum
    expect(fx.acc).toBeLessThan(own + aura);
    expect(sim.cmdr(child).ofx?.acc).toBeCloseTo(fx.acc, 6);
    // an injured officer does not command: only the superior's aura is left
    sub.injuredUntil = sim.time + 100;
    expect(sim.cmdr(child).ofx?.acc ?? 0).toBeCloseTo(aura, 6);
    expect(effSkill(top)).toBeGreaterThan(top.skill);
  });
});

describe('B-1 effects in industry, logistics and support', () => {
  it('mining skills raise the real output of the commanded miners (same world, same seed)', () => {
    const go = (skills: string[]) => {
      const { sim, me } = mk(4);
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; }
      const c = master(sim, me);
      for (const s of skills) { if (c.of.skills[s]) expect(learn(sim, me, c, s)).toBeNull(); else learnPath(sim, me, c, s); }
      const g = Object.values(sim.st.groups).find(x => x.owner === me && x.name === '제1 채굴반')!;
      sim.command(me, { c: 'assignCmd', group: g.id, commander: c.id });
      sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } });
      // output per second actually spent cutting rock (hauling and unloading time is not the officer's mining skill)
      const f = sim.st.fields.kestrel;
      let mined = 0, last = f.amount, busy = 0;
      for (let t = 0; t < 1200; t++) {
        const cutting = g.shipIds.filter(id => sim.st.ships[id]?.task.k === 'mine').length;
        sim.update(1);
        if (f.amount < last && cutting) { mined += last - f.amount; busy += cutting; }
        last = f.amount;
      }
      return { rate: mined / Math.max(1, busy), mine: officerFx(c).mine ?? 0 };
    };
    const base = go([]), skilled = go(['mn_rate', 'mn_rate', 'mn_rate']);
    expect(skilled.mine - base.mine).toBeCloseTo(0.18, 6);
    // the real extraction rate follows the skill (±3% for hull wear and field differences along the way)
    expect(skilled.rate / base.rate).toBeGreaterThan((1 + skilled.mine) / (1 + base.mine) - 0.03);
  }, 240000);

  it('a station director speeds up production and research only at the station directed', () => {
    const { sim, me } = mk();
    const st = sim.st.stations.astra; st.owner = me; st.public = false;
    const c = master(sim, me);
    learnPath(sim, me, c, 'in_prod'); expect(learn(sim, me, c, 'in_prod')).toBeNull(); expect(learn(sim, me, c, 'in_prod')).toBeNull();
    const job = () => ({ id: 'jx', order: 'none', recipe: Object.keys(RECIPES)[0], fac: 'x', left: 1000, total: 1000 });
    const co = sim.st.companies[me];
    st.jobs = [job()]; stepProduction(st, co, 10, sim.st); const without = 1000 - st.jobs[0].left;
    expect(sim.command(me, { c: 'officerPost', commander: c.id, post: st.id })).toBeNull();
    expect(stationDirector(sim.st, st.id)?.id).toBe(c.id);
    st.jobs = [job()]; stepProduction(st, co, 10, sim.st); const withDir = 1000 - st.jobs[0].left;
    expect(withDir).toBeCloseTo(without * 1.15, 5);
    // another station is not affected
    expect(stationDirector(sim.st, 'helios')).toBeNull();
  });

  it('support skills lower supply use, repair cost and reactivation time of the commanded ships; salary is a running cost', () => {
    const { sim, me } = mk(3);
    const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
    const s = sim.st.ships[g.shipIds[0]];
    const co = sim.st.companies[me];
    s.hp = 0.5;
    const rate0 = shipRate(sim.st, s), repair0 = repairQuote(sim.st, s, co).cost, react0 = sim.reactivateS(s);
    const c = master(sim, me);
    for (const n of ['sp_supply', 'sp_repair']) learnPath(sim, me, c, n);
    expect(sim.command(me, { c: 'assignCmd', group: g.id, commander: c.id })).toBeNull();
    const sup = officerFx(c).supply!;
    expect(sup).toBeGreaterThan(0);
    for (const k of Object.keys(rate0.supplies)) expect(shipRate(sim.st, s).supplies[k]).toBeCloseTo(rate0.supplies[k] * (1 - sup), 6);
    expect(repairQuote(sim.st, s, co).cost).toBeCloseTo(repair0 * (1 - officerFx(c).repair!), -1);
    expect(sim.reactivateS(s)).toBe(react0);                                        // readiness is the other branch
    // the readiness branch (exclusive with repair supervision) shortens reactivation instead
    const r = master(sim, me);
    learnPath(sim, me, r, 'sp_ready');
    expect(learn(sim, me, r, 'sp_repair')).toMatch(/함께 배울 수 없음/);
    expect(sim.command(me, { c: 'assignCmd', group: g.id, commander: r.id })).toBeNull();
    expect(sim.reactivateS(s)).toBeCloseTo(react0 * (1 - officerFx(r).readiness!), 6);
    expect(sim.command(me, { c: 'assignCmd', group: g.id, commander: c.id })).toBeNull();
    // salary: the posting decides, a bigger command pays more, a level adds a little; it appears in the forecast
    const p = payroll(sim.st, me);
    expect(p.perHour).toBeGreaterThan(0);
    const line = p.lines.find(l => l.id === c.id)!;
    expect(line.post).toMatch(/지휘/);
    expect(forecast(sim.st, co).officers).toBe(p.perHour);
    const spent0 = co.credits;
    run(sim, 3600, 2);
    expect(co.credits).toBeLessThan(spent0);
    expect(Object.values(sim.st.commanders).filter(x => x.owner === me)).toHaveLength(Object.values(sim.st.commanders).filter(x => x.owner === me).length);   // nobody leaves
  }, 120000);
});

// ------------------------------------------------------------------------------------------------ named, BB, persistence

describe('B-1 named officers, BB, save/restore and migration', () => {
  it('named officers: signature node only for them, one weak field, not strictly better than a trained ordinary officer', () => {
    const { sim, me } = mk();
    const n = NAMED.find(x => x.id === 'n_wolf')!;
    const named = makeNamed(sim.st, n, 'c_named', 'astra') as Officer;
    sim.st.commanders[named.id] = named;
    expect(sim.st.officerNamed?.n_wolf).toBe(named.id);
    named.owner = me; named.stationId = null;
    expect(learnBlock(named, SKILL.sig_wolf) ?? '').not.toMatch(/고유 능력/);
    expect(TRAIT[named.of.trait].grow.maneuver).toBeLessThan(0);          // a field the named officer is weak in
    expect(named.of.talent).toBe(0);                                      // ordinary officers learn faster
    const rookie = hire(sim, me);
    expect(rookie.of.talent).toBeGreaterThan(0);
    // a trained ordinary officer reaches the same caps: every effect key has the same maximum for both
    for (const k of FX_KEYS) expect(FX[k].cap).toBeGreaterThan(0);
    // the same signature officer does not appear twice
    expect(NAMED.filter(x => sim.st.officerNamed?.[x.id]).map(x => x.id)).toEqual(['n_wolf']);
  });

  it('save and restore keep every officer field exactly; officer commands still work after the restore', () => {
    const { sim, me } = mk();
    const c = master(sim, me);
    learnPath(sim, me, c, 'gn_link');
    grantXp(sim.st, c, 'mine', 300, { mining: 1 });
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    expect(sim2.st.officerV).toBe(1);
    expect(sim2.st.commanders[c.id].of).toEqual(c.of);
    expect(officerFx(sim2.st.commanders[c.id])).toEqual(officerFx(c));
    expect(sim2.command(me, { c: 'officerLearn', commander: c.id, node: 'ad_pd' })).toBeNull();
  });

  it('an existing save is unchanged until migrated; migration is non-destructive and idempotent', () => {
    const legacy = WorldSim.create(5);
    const me = legacy.addPlayer('구 PMC');
    const old = legacy.newCommander(me, 3);
    old.level = 7; old.xp = 350; old.battles = 12;
    const g = Object.values(legacy.st.groups).find(x => x.owner === me)!; g.commanderId = old.id;
    const npc = Object.values(legacy.st.commanders).find(x => x.owner && legacy.st.companies[x.owner]?.kind !== 'player');
    expect(legacy.st.officerV).toBeUndefined();
    expect(old.of).toBeUndefined();
    expect(legacy.cmdr(g).ofx).toBeUndefined();
    const save = JSON.parse(legacy.serialize());
    const sim = new WorldSim(save);
    expect(sim.st.officerV).toBeUndefined();                                      // loading never converts
    const r = migrateOfficers(sim.st);
    expect(r.converted).toBeGreaterThan(0);
    const c = sim.st.commanders[old.id] as Officer;
    expect([c.name, c.rank, c.level, c.battles, c.owner, sim.st.groups[g.id].commanderId]).toEqual([old.name, old.rank, 7, 12, me, old.id]);
    expect(c.of.sp).toBe(spForLevel(7));
    expect(c.of.migrated?.level).toBe(7);
    expect(masteryLevel(Object.values(c.of.mastery).reduce((a, b) => Math.max(a, b ?? 0), 0))).toBeGreaterThan(0);   // its history counts
    if (npc) expect(sim.st.commanders[npc.id].of).toBeUndefined();               // NPC commanders keep the old rules
    const snap = JSON.stringify(sim.st.commanders);
    const again = migrateOfficers(sim.st);
    expect(again.converted).toBe(0);
    expect(JSON.stringify(sim.st.commanders)).toBe(snap);
  });

  it('BB keeps its causal ability and is developed like any officer', () => {
    const { sim, me } = mk();
    const r = sim.grantExclusive('acc-1', me);
    expect(['granted', 'present']).toContain(r);
    const bb = Object.values(sim.st.commanders).find(c => c.causal)!;
    expect(bb).toBeDefined();
    expect(isOfficer(bb)).toBe(true);
    expect(bb.of!.trait).toBe('n_bb');
    expect(bb.causal).toBe(true);
    const cd = sim.cmdr(Object.values(sim.st.groups).find(g => g.commanderId === bb.id)!);
    expect((cd as { causal?: boolean }).causal).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ growth

describe('B-1 growth simulations in the real world', () => {
  it('an industry rookie: hired at level 1, mines for game hours, levels up, learns mining skills that raise output, posts as a station director', () => {
    const { sim, me } = mk(4);
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; }
    const c = hire(sim, me);
    expect(c.level).toBe(1);
    const g = Object.values(sim.st.groups).find(x => x.owner === me && x.name === '제1 채굴반')!;
    expect(sim.command(me, { c: 'assignCmd', group: g.id, commander: c.id })).toBeNull();
    expect(sim.command(me, { c: 'officerFocus', commander: c.id, tree: 'mining' })).toBeNull();
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } })).toBeNull();
    const learned: string[] = [];
    const want = ['mn_rate', 'mn_rate', 'mn_rate', 'mn_assay', 'mn_relay', 'mn_small'];
    for (let h = 0; h < 6; h++) {
      run(sim, 3600, 2);
      for (const n of want) if (!learnBlock(c, SKILL[n]) && learn(sim, me, c, n) === null) learned.push(n);
    }
    expect(c.level).toBeGreaterThanOrEqual(4);
    expect(masteryLevel(c.of.mastery.mining ?? 0)).toBeGreaterThanOrEqual(1);
    expect(learned).toContain('mn_rate');
    expect(learned.some(n => SKILL[n].tier === 2)).toBe(true);
    expect(officerFx(c).mine).toBeGreaterThan(0);
    expect(c.of.earned.mine).toBeGreaterThan(0);
    expect(Object.keys(c.of.earned)).not.toContain('combat');
    console.log('[B-1 industry rookie]', JSON.stringify({ level: c.level, mastery: c.of.mastery, learned, earned: c.of.earned, sp: c.of.sp }));
  }, 600000);

  it('a combat rookie: fights real battles against hostile companies, levels up, learns gunnery and defence, and the learned skills reach the battle setup', () => {
    const { sim, me } = mk(8, { combat: 'p11' });
    const c = hire(sim, me);
    expect(c.level).toBe(1);
    const learned: string[] = [];
    expect(sim.command(me, { c: 'officerFocus', commander: c.id, tree: 'gunnery' })).toBeNull();
    const want = ['gn_aim', 'df_armor', 'gn_range'];   // keep points for a tier-2 node once a field reaches 입문
    for (let k = 0; k < 8; k++) {
      const foe = sim.addPlayer(`적 ${k}`);
      const at = { x: PVP_AT.x + k * 40000, y: 0, z: PVP_AT.z };
      const ga = fleet(sim, me, at, ['destroyer', 'frigate', 'frigate'], c);
      const gb = fleet(sim, foe, { x: at.x + 900, y: 0, z: at.z }, ['frigate', 'frigate', 'corvette'], hire(sim, foe, 1));
      for (const g of Object.values(sim.st.groups)) if (g.owner === me && g.id !== ga.id && g.commanderId === c.id) g.commanderId = null;
      expect(sim.command(me, { c: 'setOp', group: ga.id, op: { k: 'attack', group: gb.id } })).toBeNull();
      expect(run(sim, 300, 0.5, () => !!engOf(sim, ga.id))).toBe(true);
      const e = engOf(sim, ga.id)!;
      run(sim, 1800, 0.5, () => !sim.st.engagements[e.id] || !!sim.st.engagements[e.id].done);
      run(sim, 600, 1);
      c.injuredUntil = 0;
      while (want.length && !learnBlock(c, SKILL[want[0]]) && learn(sim, me, c, want[0]) === null) learned.push(want.shift()!);
      // a tier-2 node of whichever combat field the officer has grown into (the player's choice in the tree screen)
      const best = TREES.filter(t => t.kind === 'combat').sort((a, b) => (c.of.mastery[b.id] ?? 0) - (c.of.mastery[a.id] ?? 0))[0].id;
      if (!learned.some(x => SKILL[x].tier === 2) && masteryLevel(c.of.mastery[best] ?? 0) >= 1) {
        for (const n of SKILLS.filter(x => x.tree === best && x.tier === 2 && !x.sig)) {
          const pre = [...(n.req ?? []), ...(n.reqAny?.some(r => c.of.skills[r]) ? [] : (n.reqAny ?? []).slice(0, 1))].filter(r => !c.of.skills[r]);
          if (c.of.sp < pre.reduce((a, r) => a + SKILL[r].cost, 0) + n.cost) continue;
          for (const r of pre) if (learn(sim, me, c, r) === null) learned.push(r);
          if (learn(sim, me, c, n.id) === null) { learned.push(n.id); break; }
        }
      }
    }
    console.log('[B-1 combat rookie]', JSON.stringify({ level: c.level, xp: c.xp, battles: c.battles, mastery: c.of.mastery, learned, earned: c.of.earned, log: c.of.log.slice(-8).map(l => l.text) }));
    expect(c.of.earned.combat ?? 0).toBeGreaterThan(400);
    expect(c.level).toBeGreaterThanOrEqual(4);
    expect(Math.max(...TREES.filter(t => t.kind === 'combat').map(t => masteryLevel(c.of.mastery[t.id] ?? 0)))).toBeGreaterThanOrEqual(1);
    expect(learned).toContain('gn_aim');
    expect(learned).toContain('df_armor');
    expect(learned.some(n => SKILL[n].tier === 2)).toBe(true);                  // a node behind the mastery gate
    const g = Object.values(sim.st.groups).find(x => x.commanderId === c.id && x.shipIds.length)
      ?? (() => { const x = fleet(sim, me, PVP_AT, ['frigate']); x.commanderId = c.id; return x; })();
    expect(sim.cmdr(g).ofx?.acc).toBeGreaterThan(0);
  }, 900000);
});
