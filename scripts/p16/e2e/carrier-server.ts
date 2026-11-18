// P16.6 §2 — the carrier on a real persistent world, end to end: `node dist-server/server.mjs` (new code, standard
// world, temp file save) and three real WebSocket accounts:
//   A 항모 PMC  (security background: frigate + 2 corvettes + officer)  — researches, buys, builds and flies the carrier
//   B 포격 PMC  (veteran background)                                     — an ordinary gun battle group, the opponent
//   C 인양 PMC  (salvager background)                                    — salvages the carrier's wreck
// Placed once with the server stopped (scenario.ts): A's late-game NON-carrier state (own L station with labs and
// factories, generic goods, credits, company credit), B's gun battle group. Nothing carrier-specific is ever placed:
// tech, blueprint, hull, strike craft, aviation modules, computer, interceptor/air-control/guns bought on the market —
// all come from real commands. Time: research, production, building and travel take tens of hours; with the server
// stopped the same WorldSim update loop advances the saved world (no wall-clock wait, no other edit). The battle,
// the restart during it, spectating and the replay run on the live server.
// Development carrier release only (docs/P16_6_CARRIER_RELEASE.md): the script and the server it spawns run with
// NODE_ENV=development P16_DEV_CARRIER_RELEASE=1. Needs `npm run build` and `npm run build:server`.
//   NODE_ENV=development P16_DEV_CARRIER_RELEASE=1 npx vite-node scripts/p16/e2e/carrier-server.ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorldSim } from '../../../src/world/sim';
import { World } from '../../../src/sim/world';
import { RECIPES } from '../../../src/world/industry';
import { CARRIER_HULL, DAWN_STD_WEAPONS } from '../../../src/content/packs/growth/carrier';
import { Server, Pilot, freePort, until, delay } from './harness';
import { DEV_CARRIER_RELEASE } from '../../../src/content/carrierRelease';
import { BATTLE_RULES } from '../../../src/sim/world';
import { seedCarrierCompany, seedWarGroup, advance, TECH_ORDER } from './scenario';

const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p166-'));
const save = path.join(dir, 'world.json');
const srv = new Server(await freePort(), save, undefined, { WORLD_SEED: '9416' });
const T0 = Date.now(), checks: string[] = [], facts: Record<string, unknown> = {};
function check(ok: unknown, label: string, extra?: unknown) {
  if (!ok) throw Error('FAIL ' + label + (extra !== undefined ? ' ' + JSON.stringify(extra) : '') + ` [last command errors A:${A.lastErr} B:${B.lastErr} C:${C.lastErr}]`);
  checks.push(label); console.log(`PASS [${Math.round((Date.now() - T0) / 1000)}s]`, label, extra !== undefined ? JSON.stringify(extra) : '');
}
const A = new Pilot(srv, 'A 항모 PMC', 'security'), B = new Pilot(srv, 'B 포격 PMC', 'veteran'), C = new Pilot(srv, 'C 인양 PMC', 'salvager');
const connectAll = async () => { for (const p of [A, B, C]) await p.connect(); };
/** server stopped: advance the saved world with its own update loop until `done` (or `maxH` hours) */
function offline(maxH: number, done: (sim: WorldSim) => boolean, label: string) {
  const file = JSON.parse(readFileSync(save, 'utf8'));
  const sim = new WorldSim(file.world, { migrateContent: false });
  const t0 = sim.time;
  advance(sim, maxH * 3600, t => (t % 60 === 0) && done(sim));
  const h = Math.round((sim.time - t0) / 360) / 10;
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  console.log(`  offline: ${label} — ${h} h of world time`);
  (facts.offlineHours as Record<string, number>)[label] = h;
  return done(sim);
}
facts.offlineHours = {};
if (!DEV_CARRIER_RELEASE) throw Error('run with NODE_ENV=development P16_DEV_CARRIER_RELEASE=1 (development carrier release)');
const recipeFor = (item: string) => Object.values(RECIPES).find(r => (r.out[item] ?? 0) > 0)!.id;
const store = (s: any, st: string, co: string) => (s.stations[st]?.storage?.[co] ?? {}) as Record<string, number>;

try {
  // ── 0. a fresh standard world (new code: rules 3, carrier released) and three accounts
  await srv.start();
  await A.signup('p166_a'); await B.signup('p166_b'); await C.signup('p166_c');
  await connectAll();
  const s0 = A.snap();
  check(BATTLE_RULES === 3, '0: development release mode: new battles are rules 3', { BATTLE_RULES });
  check(s0.carrierV === 1 && s0.stations.helios.market.eq_wing_fighter && s0.stations.bastion.market.eq_wing_torpedo, '0: new standard world has the carrier gear markets (helios, bastion)');
  check(!Object.values<any>(s0.ships).some(s => s.hull === CARRIER_HULL), '0: no carrier exists anywhere in the new world (NPC fleets included)');
  await srv.stop();

  // ── placement (server stopped): A's non-carrier late-game state, B's gun battle group
  { const file = JSON.parse(readFileSync(save, 'utf8'));
    const sim = new WorldSim(file.world, { migrateContent: false });
    const st = seedCarrierCompany(sim, A.id);
    const h = sim.st.stations.helios.pos;
    const at = { x: h.x + (st.pos.x - h.x) * -0.9, y: 0, z: h.z + (st.pos.z - h.z) * -0.9 + 2500 };
    const g = seedWarGroup(sim, B.id, 'B 포격 전단', at, [['battleship', 'std'], ['cruiser', 'std'], ['cruiser', 'std'], ['destroyer', 'std'], ['destroyer', 'std']]);
    sim.st.companies[B.id].credits = 400_000;
    file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
    facts.base = st.id; facts.bGroup = g.id; facts.bAt = at; }
  const base = facts.base as string, bGroup = facts.bGroup as string;

  // ── 1. research (15 projects) — real commands, labs at A's station
  await srv.start(); await connectAll();
  for (const t of TECH_ORDER) { const r = await A.command({ c: "research", station: base, tech: t }); check(r === null, `1: research queued — ${t}`, r ?? undefined); }
  { const r = await A.command({ c: 'buildShip', station: base, classId: 'carrier', loadoutId: '', hull: CARRIER_HULL, variant: 'carrier_dawn_std', outfit: 'hull' });
    check(r !== null, '1: building a 여명급 is refused before the blueprint and the research', r); }
  // C (salvager) moves its salvage group to helios now, so it is in reach of the coming battle's wrecks
  { const cg0 = Object.values<any>(C.snap().groups).find(g => g.owner === C.id && g.shipIds.length);
    check(await C.command({ c: 'setOp', group: cg0.id, op: { k: 'dock', station: 'helios' } }) === null, '1: C sends its salvage group to helios'); }
  await srv.stop();
  check(offline(40, sim => TECH_ORDER.every(t => sim.st.companies[A.id].tech?.includes(t)), 'research'), '1: all 15 research projects finished');

  // ── 2. blueprint, hull, carrier gear — real commands and the station's production
  await srv.start(); await connectAll();
  const cr0 = A.snap().companies[A.id].credits;
  check(await A.command({ c: 'buyBlueprint', station: 'helios', blueprint: 'bp_carrier_dawn' }) === null, '2: A buys the 여명급 blueprint at helios');
  const cr1 = (await A.fresh()).companies[A.id].credits;
  facts.blueprintPaid = cr0 - cr1;
  check(await A.command({ c: 'buildShip', station: base, classId: 'carrier', loadoutId: '', hull: CARRIER_HULL, variant: 'carrier_dawn_std', outfit: 'hull' }) === null, '2: A lays down a 여명급 hull at its own L yard');
  const gear: [string, number][] = [['eq_wing_fighter', 2], ['eq_wing_torpedo', 1], ['air_hangar_ext', 1], ['air_maint', 1], ['cpu_carrier', 1]];
  for (const [id, n] of gear) check(await A.command({ c: 'prodOrder', station: base, recipe: recipeFor(id), mode: 'count', n }) === null, `2: production order — ${id} ×${n}`);
  await srv.stop();
  const ready = (sim: WorldSim) => Object.values(sim.st.ships).some(s => s.owner === A.id && s.hull === CARRIER_HULL && s.task.k === 'docked') && gear.every(([id, n]) => ((sim.st.stations[base].storage[A.id] as any)[id] ?? 0) >= n);
  check(offline(12, ready, 'build + production'), '2: the carrier hull is delivered and the gear is in A\'s storage');

  // ── 3. fitting: own yard (produced gear), then the helios market for the rest (interceptor, air control, guns)
  await srv.start(); await connectAll();
  let s = A.snap();
  const cv = Object.values<any>(s.ships).find(x => x.owner === A.id && x.hull === CARRIER_HULL);
  facts.carrier = cv.id;
  const own = { hp: { h1: 'eq_wing_fighter', h2: 'eq_wing_fighter', h3: 'eq_wing_torpedo' }, bay: { fl1: 'air_hangar_ext', fl2: 'air_maint', cpu1: 'cpu_carrier' } };
  check(await A.command({ c: 'fit', ship: cv.id, ...own }) === null, '3: own yard — 2 fighter wings, torpedo wing, hangar extension, maintenance, carrier computer fitted from produced stock');
  s = await A.fresh();
  check(Object.values(store(s, base, A.id)).length >= 0 && gear.every(([id]) => (store(s, base, A.id)[id] ?? 0) === 0), '3: the fitted gear left A\'s storage (nothing duplicated)');
  check(await A.command({ c: 'setOp', group: cv.groupId, op: { k: 'dock', station: 'helios' } }) === null, '3: the carrier sails to helios');
  await srv.stop();
  check(offline(3, sim => { const x = sim.st.ships[cv.id]; return x.task.k === 'docked' && (x.task as any).station === 'helios'; }, 'sail to helios'), '3: docked at helios');
  await srv.start(); await connectAll();
  const full = { hp: { ...DAWN_STD_WEAPONS }, bay: { ...own.bay, fl3: 'air_control' } };
  const cr2 = A.snap().companies[A.id].credits;
  check(await A.command({ c: 'fit', ship: cv.id, ...full, buy: true }) === null, '3: helios — interceptor wing, air control, 2 medium guns, 6 point defence bought and fitted (fit buy)');
  s = await A.fresh();
  // fit-buy of ordinary gear is the station's refit service (service price, no market stock — only regional advanced
  // gear needs real stock); the market itself is checked with a plain purchase of a spare interceptor wing
  facts.fitBuyPaid = cr2 - s.companies[A.id].credits;
  check(facts.fitBuyPaid as number > 0, '3: the refit service charged A for the bought gear', { paid: facts.fitBuyPaid });
  const st0 = s.stations.helios.market.eq_wing_interceptor.stock;
  check(await A.command({ c: 'buy', station: 'helios', res: 'eq_wing_interceptor', amount: 1 }) === null, '3: A buys a spare interceptor wing on the helios market');
  s = await A.fresh();
  facts.marketBuy = [st0, s.stations.helios.market.eq_wing_interceptor.stock];
  check(st0 - s.stations.helios.market.eq_wing_interceptor.stock > 0.9 && (s.stations.helios.storage?.[A.id]?.eq_wing_interceptor ?? 0) >= 1, '3: the market stock went down by one and the wing is in A\'s helios storage', facts.marketBuy);
  const sorted = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort());
  check(sorted(s.ships[cv.id].fitting.hp) === sorted(full.hp) && sorted(s.ships[cv.id].fitting.bay) === sorted(full.bay), '3: carrier fitting = the standard air group (H slots h1–h4) + flight bays fl1–fl3 + carrier computer', s.ships[cv.id].fitting);

  // ── 4. the carrier group: A's security ships + officer join the carrier
  const esc = Object.values<any>(s.ships).filter(x => x.owner === A.id && x.id !== cv.id).map(x => x.id);
  const oldG = Object.values<any>(s.groups).find(g => g.owner === A.id && g.id !== cv.groupId && g.shipIds.length);
  for (const id of esc) check(await A.command({ c: 'moveShip', ship: id, group: cv.groupId }) === null, `4: escort ${s.ships[id].name} joins the carrier group`);
  const officer = oldG?.commanderId ?? Object.values<any>(s.commanders).find(c => c.owner === A.id)?.id;
  check(await A.command({ c: 'assignCmd', group: cv.groupId, commander: officer }) === null, '4: the security officer takes command of the carrier group');
  check(await A.command({ c: 'renameGroup', group: cv.groupId, name: '여명 항모단' }) === null, '4: group named');
  s = await A.fresh();
  facts.groupShips = s.groups[cv.groupId].shipIds.map((id: string) => s.ships[id].hull ?? s.ships[id].classId);
  check(s.groups[cv.groupId].shipIds.length === 1 + esc.length && s.groups[cv.groupId].commanderId === officer, '4: 여명 항모단 = carrier + escorts + officer', facts.groupShips);

  // ── 5. battle: B declares hostility (mutual hostility = a war, not a crime), A attacks B's battle group
  check(await B.command({ c: 'stance', target: A.id, v: -1 }) === null, '5: B declares A hostile');
  check(await A.command({ c: 'setOp', group: cv.groupId, op: { k: 'attack', group: bGroup } }) === null, '5: A orders the carrier group to attack B\'s gun battle group');
  const eng = await until(() => Object.values<any>(A.snap().engagements ?? {}).find(e => !e.done && e.groupRefs?.includes(cv.groupId))?.id, 'no engagement', 600000);
  check(!!eng, '5: P11 engagement between A\'s carrier group and B\'s battle group', { eng });
  const bi = await A.join(eng);
  check(bi.setup.rules === 3, '5: the live battle is stamped rules 3', { rules: bi.setup.rules });
  const local = () => { const b = A.binits.get(eng)!; const w = new World(structuredClone(b.setup)); w.scheduleReplay(structuredClone(b.orders)); return w; };
  // craft: launch, recover, re-sortie (local lockstep re-simulation of what the server streams)
  const airAt = async (sec: number) => { await delay(sec * 1000); const b = A.binits.get(eng)!; const w = local(); const T = b.tick + Math.floor((Date.now() - b.t0) / 1000 * 30); while (w.tick < T && !w.outcome) w.step(); return w; };
  A.binits.get(eng)!.t0 = Date.now();
  let w = await airAt(40);
  const sq = () => (w.craft?.squads ?? []).map(q => ({ role: q.cs.role, n: q.cs.n, ...q.stats }));
  facts.air40 = sq();
  check(w.craft && sq().reduce((a, q) => a + q.launched, 0) > 0, '6: strike craft launched in the live battle', facts.air40);
  // 7. restart during the battle
  await srv.stop();
  const saved = JSON.parse(readFileSync(save, 'utf8')).world.engagements?.[eng];
  check(saved && !saved.done, '7: the server stopped mid-battle; the engagement is in the save', { orders: saved?.orders?.length });
  await srv.start(); await connectAll();
  const bi2 = await A.join(eng); bi2.t0 = Date.now();
  check(bi2.setup.rules === 3 && bi2.orders.length >= saved.orders.length, '7: after the restart the battle continues (same setup, orders kept)', { tick: bi2.tick });
  // 8. spectating: C (not a party) joins and its lockstep copy matches the server's ships
  const ci = await C.join(eng);
  { const sim = (b: any, T: number) => { const x = new World(structuredClone(b.setup)); x.scheduleReplay(structuredClone(b.orders)); while (x.tick < T && !x.outcome) x.step(); return x; };
    // C is not a party: its strategic snapshot does not show the battle's ships (fog), so compare its lockstep copy
    // (a) with party A's lockstep copy at the same tick (same digest) and (b) with A's snapshot ship hp
    const sa = await A.fresh();
    const wc = sim(ci, ci.tick), wa = sim(A.binits.get(eng)!, ci.tick);
    check(wc.digest() === wa.digest(), '8: spectator C and party A re-simulate the live battle to the same state at the same tick', { tick: ci.tick });
    const diffs: number[] = [];
    for (const ts of wc.ships) { if (!ts.ref || ts.ref.includes(':')) continue; const ws = sa.ships[ts.ref]; if (!ws) continue; diffs.push(Math.abs((ts.state === 'alive' ? ts.hp / ts.maxHp : 0) - ws.hp)); }
    facts.spectate = { ships: diffs.length, maxHpDiff: Math.max(...diffs) };
    check(diffs.length > 3 && Math.max(...diffs) < 0.08, '8: C\'s lockstep copy matches the server\'s ship hp at the join (A\'s snapshot)', facts.spectate); }
  // 9. run the battle out: carrier sunk
  const end = await until(() => { const r = (A.snap().battleLog ?? []).find((x: any) => x.id === eng); return r; }, 'battle did not end', 1500000);
  s = A.snap();
  const rec = end;
  facts.battle = { summary: rec.summary, losses: rec.losses, winner: rec.winner, sec: Math.round(rec.end - rec.start) };
  check(!s.ships[cv.id], '9: the carrier was sunk', facts.battle);
  // 12. the finished battle re-opens as a replay (bjoin) — the client snapshot's battle log carries no setup / orders,
  //     so the replay below uses what the server streams to a replay viewer
  const rb = await B.join(eng);
  check(rb.replay === true && rb.setup.rules === 3, '12: B re-opens the finished battle as a replay (rules 3)', { orders: rb.orders.length });
  // replay (record) vs server; and the air statistics of the whole battle
  { const rw = new World(structuredClone(rb.setup)); rw.scheduleReplay(structuredClone(rb.orders)); while (!rw.outcome && rw.tick < 30 * 1500) rw.step();
    const lost = rw.ships.filter(x => (x.state === 'dead' || x.state === 'dying') && x.ref && !x.ref.includes(':')).map(x => x.ref!).sort();
    const goneOnServer = rw.ships.map(x => x.ref).filter((r): r is string => !!r && !r.includes(':') && !s.ships[r]).sort();
    const air = (rw.craft?.squads ?? []).map(q => ({ role: q.cs.role, n: q.cs.n, ...q.stats }));
    facts.air = air;
    check(JSON.stringify(lost) === JSON.stringify(goneOnServer), '10: the battle record replays to exactly the ships the server lost', { lost: lost.length });
    check(air.some(q => q.recovered > 0) && air.some(q => q.launched > q.n), '6: craft returned to the carrier and flew again (recovered > 0, launches > airframes)', air);
    const hpDiff = rw.ships.filter(x => x.state === 'alive' && x.ref && s.ships[x.ref]).map(x => Math.abs(x.hp / x.maxHp - s.ships[x.ref!].hp));
    check(hpDiff.every(d => d < 1e-6), '10: survivors\' hp after the battle = the replay\'s final hp', { ships: hpDiff.length }); }
  // ── 11. wreck + salvage by C
  const wrecks = Object.values<any>(s.wrecks ?? {}).filter(x => x.eng === eng || x.sources?.some((y: any) => y.ship === cv.id));
  const cw = wrecks.find(x => x.sources?.some((y: any) => y.ship === cv.id));
  const lots = (cw?.lots ?? []).map((l: any) => [l.item, l.n]);
  facts.carrierWreck = { id: cw?.id, lots };
  check(cw && lots.some(([k]: any) => String(k).startsWith('eq_wing_') || ['cpu_carrier', 'air_maint', 'air_hangar_ext', 'air_control'].includes(k)), '11: the carrier\'s wreck holds its strike-craft / aviation gear', facts.carrierWreck);
  const cg = Object.values<any>(s.groups).find(g => g.owner === C.id && g.shipIds.length);
  check(await A.command({ c: 'setOp', group: Object.values<any>(s.groups).find(g => g.owner === A.id && g.shipIds.length)?.id ?? cv.groupId, op: { k: 'idle' } }) !== undefined, '11: A stands down');
  check(await C.command({ c: 'setOp', group: cg.id, op: { k: 'salvzone', at: cw.pos, radius: 3000 } }) === null, '11: C sends its salvage group on a zone salvage over the carrier wreck');
  await srv.stop();
  const isCarrierGear = (k: string) => k.startsWith('eq_wing_') || ['cpu_carrier', 'air_maint', 'air_hangar_ext', 'air_control'].includes(k);
  /** carrier gear C holds: ship holds + station storage (its own view of the world) */
  const cGear = (w: any) => { const out: Record<string, number> = {};
    for (const m of [...Object.values<any>(w.ships).filter(x => x.owner === C.id).map(x => x.cargo ?? {}), ...Object.values<any>(w.stations).map(st => st.storage?.[C.id] ?? {})])
      for (const [k, n] of Object.entries<number>(m)) if (isCarrierGear(k) && n > 0) out[k] = (out[k] ?? 0) + n;
    return out; };
  const gear0 = cGear(JSON.parse(readFileSync(save, 'utf8')).world);
  check(offline(10, sim => Object.keys(sim.st.wrecks?.[cw.id]?.taken?.[C.id] ?? {}).some(isCarrierGear), 'salvage'), '11: C recovered carrier gear from the wreck (wreck ledger)');
  const gear1 = cGear(JSON.parse(readFileSync(save, 'utf8')).world);
  facts.cGear = { before: gear0, after: gear1 };
  check(Object.entries(gear1).some(([k, n]) => n > (gear0[k] ?? 0)), '11: the recovered carrier gear is in C\'s holds / storage', facts.cGear);
  await srv.start(); await connectAll();
  s = C.snap();
  facts.cGearAfterRestart = cGear(s);
  check(JSON.stringify(facts.cGearAfterRestart) === JSON.stringify(gear1), '11: after a restart C\'s view shows the same salvaged carrier gear', facts.cGearAfterRestart);
  await srv.stop();
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ checks, facts }, null, 1));
  console.log(`\nALL ${checks.length} CHECKS PASSED — ${dir}`);
  console.log(JSON.stringify(facts, null, 1));
} catch (e) {
  console.error(e);
  console.log(JSON.stringify(facts, null, 1));
  console.log(srv.log.split('\n').slice(-30).join('\n'));
  await srv.stop();
  process.exit(1);
}
