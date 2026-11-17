// B-2 PMC military business: the five contract types in the real standard world (no scripted outcomes), the money
// they move (escrow → pay / refund, never created), the battle link (bounty kept separate, one battle → one contract),
// authority, save/restore and the two military starts. Scenario numbers refer to docs/B2_MILITARY_BUSINESS.md §8.
import { beforeAll, describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import type { Contract, WGroup } from '../src/world/types';
import { MIL, isMil, milGuide, milOnBattle, milProgress, migrateMilitary, settle, type MilTerms } from '../src/world/military';
import { moneySupply } from '../src/world/observe';
import { econOf, yardHulls, yardShipPrice } from '../src/world/hullops';
import { CONTENT } from '../src/content/registry';
import { sysAt } from '../src/world/geom';

type MK = Contract & { mil: MilTerms };
const run = (sim: WorldSim, s: number) => { for (let i = 0; i < s; i++) sim.update(1); };
const until = (sim: WorldSim, cond: () => boolean, s = 3600) => { for (let i = 0; i < s && !cond(); i++) sim.update(1); return cond(); };
const fleet = (sim: WorldSim, me: string) => Object.values(sim.st.groups).find(g => g.owner === me && !g.parentId)!;
/** a company grows its fleet the ordinary way: the cheapest military hull a public yard sells, bought into the main
 *  fleet with the real buyShip command (the test only supplies the money a few contracts would have earned) */
function reinforce(sim: WorldSim, me: string, n: number) {
  for (let i = 0; i < n; i++) {
    const o = Object.values(sim.st.stations).flatMap(st => yardHulls(st).filter(h => econOf({ classId: CONTENT.hulls[h].classId }).military).map(h => ({ st, h, price: yardShipPrice(st, h) }))).filter(x => x.price > 0).sort((a, b) => a.price - b.price)[0];
    sim.st.companies[me].credits += o.price;
    expect(sim.command(me, { c: 'buyShip', station: o.st.id, classId: CONTENT.hulls[o.h].classId, loadoutId: '', hull: o.h, group: fleet(sim, me).id })).toBeNull();
  }
}
const offers = (sim: WorldSim, f: (k: MK) => boolean = () => true) => (Object.values(sim.st.contracts).filter(k => isMil(k) && !k.done && !k.takenBy) as MK[]).filter(f);
const sysOf = (sim: WorldSim, g: WGroup) => sysAt(sim.st.systems, sim.groupCenter(g)!)?.id;
const restore = (save: string) => new WorldSim(JSON.parse(save));

/** a world one hour in (pirate bands and rogues out, boards full), with a security and a veteran start */
let warm = '';
let SEC = '', VET = '';
beforeAll(() => {
  const sim = WorldSim.create(41, { ...STANDARD_WORLD });
  SEC = sim.addPlayer('경비', 'security'); VET = sim.addPlayer('퇴역', 'veteran');
  run(sim, 3600);
  warm = sim.serialize();
}, 240_000);

describe('B-2 gate, posting and money', () => {
  it('standard worlds run military contracts; legacy bounty / lair postings (new money) are replaced', () => {
    const sim = restore(warm);
    expect(sim.st.milV).toBe(1);
    const open = Object.values(sim.st.contracts).filter(k => !k.done);
    expect(open.some(k => k.kind === 'bounty' || k.kind === 'lair')).toBe(false);
    const types = new Set(offers(sim).map(k => k.mil.type));
    for (const t of ['patrol', 'defend', 'hunt', 'strike'] as const) expect(types.has(t)).toBe(true);
    // targets are real: pirate groups / live lairs / pirate systems; one contract per target in the whole world
    const seen = new Set<string>();
    for (const k of offers(sim, k => !!k.mil.target)) {
      const t = k.mil.target!;
      expect(seen.has(t)).toBe(false); seen.add(t);
      if (t.startsWith('lair:')) expect(sim.st.lairs[t.slice(5)]?.alive).toBe(true);
      else if (!t.startsWith('lane:')) expect(sim.st.groups[t]?.owner).toBe('pirates');
    }
    // finite: per-type world caps
    for (const t of ['patrol', 'defend', 'hunt', 'strike', 'escort'] as const) expect(offers(sim, k => k.mil.type === t).length).toBeLessThanOrEqual(MIL.worldCap[t]);
  });

  it('acceptance reserves base + bonus from the station; settlement pays the earned part and returns the rest exactly', () => {
    const sim = restore(warm);
    const k = offers(sim, k => k.mil.type === 'patrol')[0];
    const st = sim.st.stations[k.stationId], f0 = st.funds!, m0 = moneySupply(sim.st), c0 = sim.st.companies[SEC].credits;
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: fleet(sim, SEC).id })).toBeNull();
    expect(st.funds).toBeCloseTo(f0 - k.mil.base - k.mil.bonus, 6);
    expect(k.escrow).toBe(k.mil.base + k.mil.bonus);
    expect(moneySupply(sim.st)).toBeCloseTo(m0, 6);
    settle(sim, k, true, 'test', 0.5);
    const bonus = Math.round(k.mil.bonus * 0.5);
    expect(sim.st.companies[SEC].credits).toBeCloseTo(c0 + k.mil.base + bonus, 6);
    expect(st.funds).toBeCloseTo(f0 - k.mil.base - bonus, 6);
    expect(k.escrow).toBe(0);
    expect(moneySupply(sim.st)).toBeCloseTo(m0, 6);
    // settled once: a second settlement changes nothing
    settle(sim, k, true, 'again', 1);
    expect(sim.st.companies[SEC].credits).toBeCloseTo(c0 + k.mil.base + bonus, 6);
    expect(sim.st.companies[SEC].milLog?.length).toBe(1);
  });

  it('cancel and expiry return the reservation exactly and cost credit; a void (target gone) costs nothing', () => {
    const sim = restore(warm);
    const [a, b] = offers(sim, k => k.mil.type === 'patrol' || k.mil.type === 'defend');
    const m0 = moneySupply(sim.st);
    const g = fleet(sim, SEC);
    expect(sim.command(SEC, { c: 'accept', contract: a.id, group: g.id })).toBeNull();
    const fac = sim.st.stations[a.stationId].faction!, rep0 = sim.st.companies[SEC].standing?.[fac] ?? 0, fa = sim.st.stations[a.stationId].funds!;
    expect(sim.command(SEC, { c: 'milCancel', contract: a.id })).toBeNull();
    expect(a.done).toBe(true); expect(a.escrow).toBe(0);
    expect(sim.st.stations[a.stationId].funds).toBeCloseTo(fa + a.mil.base + a.mil.bonus, 6);
    expect(sim.st.companies[SEC].standing?.[fac] ?? 0).toBeLessThan(rep0);
    expect(moneySupply(sim.st)).toBeCloseTo(m0, 6);
    // expiry while taken
    expect(sim.command(SEC, { c: 'accept', contract: b.id, group: g.id })).toBeNull();
    sim.command(SEC, { c: 'setOp', group: g.id, op: { k: 'dock', station: sim.st.companies[SEC].homeStation } });
    b.expires = sim.time + 2;
    run(sim, 3);
    expect(b.done).toBe(true); expect(b.ended).toBe('기한 만료'); expect(b.escrow).toBe(0);
    expect(b.mil.result?.ok).toBe(false);
  });
});

describe('B-2 scenarios in the real world', () => {
  it('1 · a security start completes its first patrol (route flown, time on duty in space); docking does not count', () => {
    const sim = restore(warm);
    const g = fleet(sim, SEC);
    const k = offers(sim, k => k.mil.type === 'patrol' && k.mil.risk < 1.3).sort((x, y) => x.mil.risk - y.mil.risk)[0];
    expect(k).toBeTruthy();
    // a docked fleet earns nothing: accept, keep it docked
    const twin = restore(warm), k2 = twin.st.contracts[k.id] as MK, g2 = fleet(twin, SEC);
    expect(twin.command(SEC, { c: 'accept', contract: k2.id, group: g2.id })).toBeNull();
    twin.command(SEC, { c: 'setOp', group: g2.id, op: { k: 'dock', station: twin.st.companies[SEC].homeStation } });
    run(twin, 900);
    expect(k2.mil.duty ?? 0).toBe(0); expect(k2.done).toBe(false);
    // the real run
    const c0 = sim.st.companies[SEC].credits;
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: g.id })).toBeNull();
    expect(g.op.k).toBe('patrol');
    expect(until(sim, () => k.done, 3600)).toBe(true);
    expect(k.mil.result?.ok).toBe(true);
    expect(k.mil.duty).toBeGreaterThanOrEqual(k.mil.dur!);
    for (const v of k.mil.visits!) expect(v).toBeGreaterThanOrEqual(MIL.loops);
    expect(sim.st.companies[SEC].credits).toBeGreaterThan(c0);
    expect(sim.st.companies[SEC].milestones).toContain('first_mil');
    const r = k.mil.result!;
    console.log('[B-2 S1 patrol]', JSON.stringify({ title: k.title, dur: Math.round(r.dur), pay: r.pay, bonus: r.bonus, upkeep: r.upkeep, salary: r.salary, net: r.net }));
  }, 120_000);

  it('2 · escorting a real guild trader: it waits docked for the escort, sails with it, and settles on arrival', () => {
    const sim = restore(warm);
    const g = fleet(sim, SEC);
    let k: MK | undefined;
    expect(until(sim, () => !!(k = offers(sim, x => x.mil.type === 'escort' && !x.mil.poster)[0]), 3600)).toBe(true);
    const ward = sim.st.groups[k!.mil.ward!];
    expect(ward.owner).toBe('guild');
    const ws = sim.st.ships[ward.shipIds[0]];
    expect(ws.state).toBe('docked');
    expect(sim.command(SEC, { c: 'accept', contract: k!.id, group: g.id })).toBeNull();
    // the trader does not leave before the escort joins (the late-escort problem)
    let leftEarly = false;
    for (let i = 0; i < MIL.joinMax && !k!.mil.joined && !k!.done; i++) { sim.update(1); if (!k!.mil.joined && ws.state !== 'docked' && !k!.done) leftEarly = true; }
    expect(leftEarly).toBe(false);
    expect(until(sim, () => k!.done, 2400)).toBe(true);
    console.log('[B-2 S2 escort]', k!.title, k!.ended, JSON.stringify(k!.mil.result), 'cover', k!.mil.cover);
    expect(k!.mil.result?.ok).toBe(true);
    const dest = sim.st.stations[k!.mil.dest!];
    expect(Math.hypot(ws.pos.x - dest.pos.x, ws.pos.z - dest.pos.z)).toBeLessThan(3500);
    expect(k!.mil.cover![0] / Math.max(1, k!.mil.cover![1])).toBeGreaterThanOrEqual(MIL.coverMin);
  }, 120_000);

  it('3 · pirates attack the convoy: a real battle, counted once, bounty separate from the contract pay', () => {
    const sim = restore(warm);
    const g = fleet(sim, SEC);
    let k: MK | undefined;
    expect(until(sim, () => !!(k = offers(sim, x => x.mil.type === 'escort' && !x.mil.poster)[0]), 3600)).toBe(true);
    expect(sim.command(SEC, { c: 'accept', contract: k!.id, group: g.id })).toBeNull();
    expect(until(sim, () => !!k!.mil.joined || k!.done, MIL.joinMax + 5)).toBe(true);
    // a real rogue band (no new ships) is sent at the trader once it sails
    const ward = sim.st.groups[k!.mil.ward!];
    const band = Object.values(sim.st.groups).filter(x => x.owner === 'pirates' && x.shipIds.length >= 2 && x.shipIds.length <= 4 && x.op.k === 'raid').sort((a, b) => a.shipIds.length - b.shipIds.length)[0];
    expect(band).toBeTruthy();
    until(sim, () => sim.st.ships[ward.shipIds[0]]?.state === 'space' || k!.done, 120);
    const wp = sim.groupCenter(ward)!;
    for (const id of band.shipIds) { const s = sim.st.ships[id]; s.pos = { x: wp.x + 900, y: wp.y, z: wp.z + 300 }; s.state = 'space'; s.task = { k: 'none' }; }
    (band.op as any).target = ward.id;
    const credits0 = sim.st.companies[SEC].credits;
    expect(until(sim, () => k!.done, 2400)).toBe(true);
    const r = k!.mil.result!;
    console.log('[B-2 S3 attacked convoy]', k!.ended, JSON.stringify(r), 'battles', k!.mil.battles);
    expect(k!.mil.battles!.length).toBeGreaterThan(0);
    // each battle counted toward at most one contract of the company
    const counted = sim.st.mil!.counted[SEC] ?? [];
    expect(new Set(counted).size).toBe(counted.length);
    // the contract's pay never exceeds its reservation; the bounty is a separate booked flow
    expect(r.pay + r.bonus).toBeLessThanOrEqual(k!.mil.base + k!.mil.bonus);
    const ledger = sim.st.companies[SEC].ops?.ledger ?? [];
    const booked = (cat: string) => ledger.reduce((a, b) => a + (b.inc[cat] ?? 0), 0);
    if (r.bounty > 0) expect(booked('bounty')).toBeGreaterThan(0);
    if (r.ok) expect(booked('mil_contract')).toBeGreaterThan(0);
    void credits0;
  }, 180_000);

  it('4 · a veteran start completes a pirate hunt on a real band; another company killing it first voids the contract', () => {
    const sim = restore(warm);
    const g = fleet(sim, VET);
    // the starting four hulls (power 210) are rated for patrols / escorts; a hunt needs a grown fleet (§4)
    reinforce(sim, VET, 3);
    // the guide's board: wait for a hunt the fleet can carry (rogue bands wander into lawful space)
    const fitHunt = () => milGuide(sim.st, VET)!.board.find(o => o.type === 'hunt' && o.fit === 'ok' && !(sim.st.contracts[o.id] as MK).mil.target!.startsWith('lair:'));
    // rogue bands are hunted by everyone (faction patrols, NPC companies): a contract whose band someone else kills
    // first is void — that path is checked here too, then the next fitting hunt is taken (up to three tries)
    let k!: MK, target!: WGroup, c0 = 0, r!: NonNullable<MilTerms['result']>;
    for (let tries = 0; tries < 3; tries++) {
      expect(until(sim, () => !!fitHunt() && Object.values(sim.st.contracts).every(x => !(isMil(x) && x.takenBy === VET && !x.done)), 7200)).toBe(true);
      k = sim.st.contracts[fitHunt()!.id] as MK;
      target = sim.st.groups[k.mil.target!];
      c0 = sim.st.companies[VET].credits;
      const funds0 = sim.st.stations[k.stationId].funds!;
      expect(sim.command(VET, { c: 'accept', contract: k.id, group: g.id })).toBeNull();
      expect(g.op).toMatchObject({ k: 'attack', group: target.id });
      expect(until(sim, () => k.done, 3600)).toBe(true);
      r = k.mil.result!;
      console.log('[B-2 S4 hunt]', k.title, k.ended, JSON.stringify(r));
      if (r.ok || !k.ended?.includes('무효')) break;
      expect(r.refund).toBe(k.mil.base + k.mil.bonus);                       // void: the reservation goes back whole
      expect(sim.st.stations[k.stationId].funds).toBeGreaterThanOrEqual(funds0 - 1e-6);
    }
    expect(r.ok).toBe(true);
    expect(sim.st.groups[target.id]?.shipIds.length ?? 0).toBe(0);
    expect(r.bounty).toBeGreaterThan(0);
    expect(sim.st.companies[VET].credits).toBeGreaterThan(c0);
    // the guide shows the settled operation with its loss side
    const gd = milGuide(sim.st, VET)!;
    expect(gd.results[0].id).toBe(k.id);
    expect(gd.totals.repair).toBe(r.repair);
  }, 180_000);

  it('5 · repair and resupply, then the next contract', () => {
    const sim = restore(warm);
    const g = fleet(sim, VET);
    const ships = Object.values(sim.st.ships).filter(s => s.owner === VET);
    for (const s of ships) s.hp = 0.6;   // the state a hunt leaves (scenario 4 measured ~2,700 cr of damage)
    const gd = milGuide(sim.st, VET)!;
    expect(gd.next.some(t => t.includes('수리'))).toBe(true);
    const home = sim.st.companies[VET].homeStation;
    expect(ships.every(s => s.state === 'docked')).toBe(true);
    const c0 = sim.st.companies[VET].credits;
    for (const s of ships) expect(sim.command(VET, { c: 'repair', ship: s.id })).toBeNull();
    expect(ships.every(s => s.hp === 1)).toBe(true);
    expect(sim.st.companies[VET].credits).toBeLessThan(c0);
    void home;
    const k = offers(sim, k => k.mil.type === 'patrol' || k.mil.type === 'defend')[0];
    expect(sim.command(VET, { c: 'accept', contract: k.id, group: g.id })).toBeNull();
    expect(k.takenBy).toBe(VET);
  });

  it('6 · officer: contract duty raises the mapped trees; a learned detection skill widens what the patrol reports', () => {
    const sim = restore(warm);
    const g = fleet(sim, SEC); const cm = sim.st.commanders[g.commanderId!];
    const m0 = { ...cm.of!.mastery };
    const k = offers(sim, k => k.mil.type === 'patrol')[0];
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: g.id })).toBeNull();
    settle(sim, k, true, 'test', 0);
    expect((cm.of!.mastery.command ?? 0)).toBeGreaterThan(m0.command ?? 0);
    expect((cm.of!.mastery.intercept ?? 0)).toBeGreaterThan(m0.intercept ?? 0);
    expect(cm.of!.earned.contract ?? 0).toBeGreaterThan(0);
    // duplicate: the same contract never pays twice
    const e0 = cm.of!.earned.contract;
    settle(sim, k, true, 'test', 0);
    expect(cm.of!.earned.contract).toBe(e0);
    // detection: a hostile band 3,300 m from the patrol — outside the base sensor range, inside it with 위협 탐지 Ⅲ
    const seenWith = (learn: boolean) => {
      const s2 = restore(warm), g2 = fleet(s2, SEC), c2 = s2.st.commanders[g2.commanderId!];
      if (learn) { c2.of!.skills.ic_watch = 3; }
      const k2 = offers(s2, k => k.mil.type === 'patrol')[0];
      expect(s2.command(SEC, { c: 'accept', contract: k2.id, group: g2.id })).toBeNull();
      const p = k2.mil.route![1];
      for (const id of g2.shipIds) { const s = s2.st.ships[id]; s.state = 'space'; s.task = { k: 'none' }; s.pos = { ...p }; }
      const band = Object.values(s2.st.groups).find(x => x.owner === 'pirates' && x.shipIds.length)!;
      for (const id of band.shipIds) { const s = s2.st.ships[id]; s.state = 'space'; s.pos = { x: p.x + 3300, y: p.y, z: p.z }; s.vel = { x: 0, y: 0, z: 0 }; }
      band.cooldown = 999; band.op = { k: 'idle' } as any;
      run(s2, 1);
      return (k2.mil.seen ?? []).includes(band.id);
    };
    expect(seenWith(false)).toBe(false);
    expect(seenWith(true)).toBe(true);
  });

  it('7 · two companies on one target: one contract per target; the other company\'s kill voids it without penalty', () => {
    const sim = restore(warm);
    const fitHunt = () => milGuide(sim.st, VET)!.board.find(o => o.type === 'hunt' && o.fit !== 'danger' && !(sim.st.contracts[o.id] as MK).mil.target!.startsWith('lair:'));
    expect(until(sim, () => !!fitHunt(), 7200)).toBe(true);
    const k = sim.st.contracts[fitHunt()!.id] as MK;
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: fleet(sim, SEC).id })).toBeNull();
    // the other company cannot take the same contract, and no second contract names the same target
    expect(sim.command(VET, { c: 'accept', contract: k.id, group: fleet(sim, VET).id })).not.toBeNull();
    // the security fleet is kept home (it never reaches the band); the veteran fleet hunts it without a contract
    sim.command(SEC, { c: 'setOp', group: fleet(sim, SEC).id, op: { k: 'dock', station: sim.st.companies[SEC].homeStation } });
    run(sim, 120);
    expect(Object.values(sim.st.contracts).filter(x => isMil(x) && !x.done && x.mil.target === k.mil.target).length).toBe(1);
    sim.command(VET, { c: 'setOp', group: fleet(sim, VET).id, op: { k: 'attack', group: k.mil.target! } });
    const rep0 = sim.st.companies[SEC].rep, funds0 = sim.st.stations[k.stationId].funds!;
    expect(until(sim, () => k.done, 3600)).toBe(true);
    console.log('[B-2 S7 competition]', k.ended, JSON.stringify(k.mil.result));
    if (!sim.st.groups[k.mil.target!]?.shipIds.length) {
      expect(k.mil.result!.ok).toBe(false);
      expect(k.ended).toContain('무효');
      expect(sim.st.companies[SEC].rep).toBeGreaterThanOrEqual(rep0 - 1e-9);
      expect(sim.st.stations[k.stationId].funds).toBeGreaterThanOrEqual(funds0 + k.mil.base + k.mil.bonus - 1e-6);
    }
  }, 180_000);

  it('8 · company-to-company escort: poster pays from its own reserved credits; authority checks hold', () => {
    const sim = restore(warm);
    const H = sim.addPlayer('운송', 'hauler');
    const hg = fleet(sim, H);
    const home = sim.st.companies[H].homeStation;
    const dest = Object.values(sim.st.stations).find(s => s.public && s.id !== home && sysAt(sim.st.systems, s.pos)?.id === sysOf(sim, hg) && sim.canDock(s, H))
      ?? Object.values(sim.st.stations).find(s => s.public && s.id !== home && sim.canDock(s, H))!;
    const c0 = sim.st.companies[H].credits, m0 = moneySupply(sim.st);
    expect(sim.command(H, { c: 'milPostEscort', group: hg.id, to: dest.id, reward: 1500 })).toBeNull();
    expect(sim.st.companies[H].credits).toBeCloseTo(c0 - 1500, 6);
    expect(moneySupply(sim.st)).toBeCloseTo(m0, 6);
    const k = offers(sim, k => k.mil.poster === H)[0];
    expect(k.escrow).toBe(1500);
    // refused: poster takes its own job; someone else's fleet; a fleet that is not a combat fleet
    expect(sim.command(H, { c: 'accept', contract: k.id, group: hg.id })).not.toBeNull();
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: fleet(sim, VET).id })).not.toBeNull();
    // escort order on another company's group is refused without a contract …
    expect(sim.command(VET, { c: 'setOp', group: fleet(sim, VET).id, op: { k: 'escort', group: hg.id } })).not.toBeNull();
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: fleet(sim, SEC).id })).toBeNull();
    expect(fleet(sim, SEC).op).toMatchObject({ k: 'escort', group: hg.id });
    // … and a second company cannot settle the same contract
    expect(sim.command(VET, { c: 'accept', contract: k.id, group: fleet(sim, VET).id })).not.toBeNull();
    expect(sim.command(VET, { c: 'milCancel', contract: k.id })).not.toBeNull();
    expect(sim.command(VET, { c: 'milDispatch', contract: k.id })).not.toBeNull();
    // the poster sends its cargo group once the escort has joined
    expect(until(sim, () => !!k.mil.joined, 900)).toBe(true);
    expect(sim.command(H, { c: 'setOp', group: hg.id, op: { k: 'dock', station: dest.id } })).toBeNull();
    const s0 = sim.st.companies[SEC].credits;
    expect(until(sim, () => k.done, 1800)).toBe(true);
    console.log('[B-2 S8 company escort]', k.ended, JSON.stringify(k.mil.result));
    expect(k.mil.result!.ok).toBe(true);
    const paid = k.mil.result!.pay + k.mil.result!.bonus;
    expect(paid).toBeLessThanOrEqual(1500);
    expect(sim.st.companies[SEC].credits - s0).toBeGreaterThanOrEqual(paid - 1e-6 - 50);   // minus a few seconds of upkeep
    expect(k.escrow).toBe(0);
  }, 180_000);

  it('9 · save / restore and reconnect mid-contract: progress kept, settled once, stale commands refused', () => {
    const sim = restore(warm);
    const g = fleet(sim, SEC);
    const k = offers(sim, k => k.mil.type === 'defend').sort((a, b) => a.mil.risk - b.mil.risk)[0];
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: g.id })).toBeNull();
    run(sim, 400);
    const duty = k.mil.duty!; expect(duty).toBeGreaterThan(0);
    const save = sim.serialize();
    const b = restore(save), kb = b.st.contracts[k.id] as MK;
    expect(kb.mil.duty).toBe(duty); expect(kb.takenBy).toBe(SEC); expect(kb.escrow).toBe(k.escrow);
    expect(JSON.stringify(milProgress(b.st, kb))).toBe(JSON.stringify(milProgress(sim.st, k)));
    // a replayed accept (reconnect) is refused; the job goes on and settles exactly once
    expect(b.command(SEC, { c: 'accept', contract: k.id, group: fleet(b, SEC).id })).not.toBeNull();
    expect(until(b, () => kb.done, 3600)).toBe(true);
    expect(kb.mil.result!.ok).toBe(true);
    expect((b.st.companies[SEC].milLog ?? []).filter(r => r.id === k.id).length).toBe(1);
    // replaying the save again near completion does not pay twice in the restored world
    const c = restore(b.serialize()); run(c, 10);
    expect((c.st.companies[SEC].milLog ?? []).filter(r => r.id === k.id).length).toBe(1);
    // an expired, untaken offer cannot be accepted
    const o = offers(c)[0]; o.expires = c.time - 1;
    expect(c.command(SEC, { c: 'accept', contract: o.id, group: fleet(c, SEC).id })).not.toBeNull();
  }, 180_000);

  it('10 · a risky contract with too little strength: ships lost, the loss is in the operation P&L, the guide shows the way back', () => {
    const sim = restore(warm);
    const g = fleet(sim, VET);
    // the most dangerous real target in reach of the veteran's board
    const k = offers(sim, k => (k.mil.type === 'strike' || k.mil.type === 'hunt') && !k.mil.target!.startsWith('lane:') && !k.mil.target!.startsWith('lair:')).sort((a, b) => b.mil.power - a.mil.power)[0];
    expect(k).toBeTruthy();
    expect(k.mil.power).toBeGreaterThan(milGuide(sim.st, VET)!.fleets[0].power);
    expect(milGuide(sim.st, VET)!.board.find(o => o.id === k.id)?.fit).not.toBe('ok');
    expect(sim.command(VET, { c: 'accept', contract: k.id, group: g.id })).toBeNull();
    expect(until(sim, () => k.done, 3600)).toBe(true);
    const r = k.mil.result!;
    console.log('[B-2 S10 risky]', k.title, k.ended, JSON.stringify(r));
    if (!r.ok) {
      expect(r.lostShips).toBeGreaterThan(0);
      expect(r.net).toBeLessThan(0);
      const gd = milGuide(sim.st, VET)!;
      expect(gd.next.some(t => t.includes('잃') || t.includes('손실'))).toBe(true);
    }
  }, 180_000);
});

describe('B-2 authority, abuse and migration', () => {
  it('refuses foreign fleets, busy fleets, foreign cancels and unlawful targets', () => {
    const sim = restore(warm);
    const k = offers(sim, k => k.mil.type === 'patrol')[0];
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: fleet(sim, VET).id })).not.toBeNull();   // someone else's fleet
    expect(sim.command(SEC, { c: 'accept', contract: k.id })).not.toBeNull();                              // no fleet named
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: fleet(sim, SEC).id })).toBeNull();
    const k2 = offers(sim, k => k.mil.type === 'defend')[0];
    expect(sim.command(SEC, { c: 'accept', contract: k2.id, group: fleet(sim, SEC).id })).not.toBeNull(); // fleet already on a contract
    expect(sim.command(VET, { c: 'milCancel', contract: k.id })).not.toBeNull();
    expect(sim.command(VET, { c: 'milDispatch', contract: k.id })).not.toBeNull();
    // a fleet with no combat ships cannot be committed
    const H = sim.addPlayer('운송', 'hauler');
    expect(sim.command(H, { c: 'accept', contract: k2.id, group: fleet(sim, H).id })).not.toBeNull();
    expect(Object.values(sim.st.ships).filter(s => s.groupId === fleet(sim, H).id).some(s => econOf(s).military)).toBe(false);
  });

  it('a contractor that fires on the convoy it protects forfeits the contract', () => {
    const sim = restore(warm);
    const H = sim.addPlayer('운송', 'hauler');
    const hg = fleet(sim, H);
    const dest = Object.values(sim.st.stations).find(s => s.public && s.id !== sim.st.companies[H].homeStation && sim.canDock(s, H))!;
    expect(sim.command(H, { c: 'milPostEscort', group: hg.id, to: dest.id, reward: 1000 })).toBeNull();
    const k = offers(sim, k => k.mil.poster === H)[0];
    expect(sim.command(SEC, { c: 'accept', contract: k.id, group: fleet(sim, SEC).id })).toBeNull();
    const c0 = sim.st.companies[H].credits;
    // a battle in which the contractor damaged the poster's ships
    const e = { id: 'eng_test', groupRefs: [], dmg: { [SEC]: { [H]: 50 } }, sides: [[SEC], [H]], pos: { x: 0, y: 0, z: 0 } } as any;
    milOnBattle(sim, e, { players: [SEC, H], vsPir: () => 0, pirateKilled: 0, bountyBy: new Map() });
    expect(k.done).toBe(true); expect(k.ended).toBe('보호 대상 공격');
    expect(sim.st.companies[H].credits).toBeCloseTo(c0 + 1000, 6);   // the poster gets its reservation back
  });

  it('an existing save without B-2 is unchanged until migrated; migration is explicit, idempotent and keeps old contracts', () => {
    const legacy = WorldSim.create(7, { ...STANDARD_WORLD, military: undefined } as any);
    legacy.addPlayer('경비', 'security');
    run(legacy, 600);
    expect(legacy.st.milV).toBeUndefined();
    const save = JSON.parse(legacy.serialize());
    const sim = new WorldSim(save);
    const before = JSON.stringify(sim.st.contracts);
    run(sim, 1);
    expect(Object.values(sim.st.contracts).some(k => k.kind === 'mil')).toBe(false);
    const snap = JSON.stringify(Object.fromEntries(Object.entries(sim.st.contracts).filter(([, k]) => !k.done)));
    expect(migrateMilitary(sim.st).applied).toBe(true);
    expect(migrateMilitary(sim.st).applied).toBe(false);
    expect(JSON.stringify(Object.fromEntries(Object.entries(sim.st.contracts).filter(([id]) => JSON.parse(snap)[id])))).toBe(snap);
    run(sim, 120);
    expect(Object.values(sim.st.contracts).some(k => k.kind === 'mil')).toBe(true);
    void before;
  });
});
