// Escort AI scenarios in disposable worlds (never a saved/production world).
//   npx vite-node scripts/escort/scenarios.ts -- [out.json]
//
// Every scenario uses the real WorldSim tick, real commands (setOp) and the existing engagement system.
// Each prints a short line and records numbers in the JSON so the report quotes measured values.
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import type { V, WGroup, WShip } from '../../src/world/types';
import { jumps, nextGate } from '../../src/world/geom';
import { startConflict } from '../../src/world/factionEcon';
import { gateOpen } from '../../src/world/territory';

const D = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
const results: Record<string, any> = {};
const ok = (name: string, pass: boolean, data: any) => { results[name] = { pass, ...data }; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(data)); };

/** fresh world, one player with the starter mining group (2 miners) and guard (destroyer + 2 corvettes), no pirates around */
function setup(seed = 7, layout?: 'p10') {
  const sim = WorldSim.create(seed, layout ? { layout } : {});
  clearPirates(sim);
  const p = sim.addPlayer('호위 시험'); sim.st.companies[p].credits = 1e6;
  const gs = Object.values(sim.st.groups).filter(g => g.owner === p);
  const mining = gs.find(g => g.name.includes('채굴'))!, guard = gs.find(g => g.name.includes('경비'))!;
  return { sim, p, mining, guard };
}
function clearPirates(sim: WorldSim) {
  for (const g of Object.values(sim.st.groups)) if (g.owner === 'pirates') { for (const id of g.shipIds) delete sim.st.ships[id]; delete sim.st.groups[g.id]; }
  // keep new bands from spawning during a scenario (lairs stay; spawn timers pushed out)
  for (const l of Object.values(sim.st.lairs)) { l.nextBand = 1e12; l.respawnAt = 1e12; }
}
/** keep other NPC traffic (union patrols, NPC miners/traders) out of a test area so the measured fight is ours */
function isolate(sim: WorldSim, at: V, r: number) {
  for (const g of Object.values(sim.st.groups)) {
    const k = sim.st.companies[g.owner]?.kind;
    if (k === 'player' || g.owner === 'pirates') continue;
    // union forces anywhere in the system (rapid-response fleets warp in from their base)
    const sameSys = g.owner === 'union' && g.shipIds.some(id => sim.st.ships[id] && sysOf(sim, sim.st.ships[id].pos) === sysOf(sim, at));
    if (sameSys || g.shipIds.some(id => sim.st.ships[id] && D(sim.st.ships[id].pos, at) < r)) { for (const id of g.shipIds) delete sim.st.ships[id]; g.shipIds = []; }
  }
}
const ships = (sim: WorldSim, g: WGroup) => g.shipIds.map(id => sim.st.ships[id]).filter(Boolean) as WShip[];
const cen = (ss: WShip[]): V => ({ x: ss.reduce((a, s) => a + s.pos.x, 0) / ss.length, y: 0, z: ss.reduce((a, s) => a + s.pos.z, 0) / ss.length });
const sysOf = (sim: WorldSim, p: V) => (sim as any).sysOf(p)?.id as string | undefined;
function nearField(sim: WorldSim, from: V, sameSys = true) {
  const sys = sysOf(sim, from);
  return Object.values(sim.st.fields).filter(f => !f.salvage && (!sameSys || sysOf(sim, f.pos) === sys)).sort((a, b) => D(a.pos, from) - D(b.pos, from))[0];
}
const mine = (sim: WorldSim, p: string, g: WGroup, field: string) => sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field, deliver: '', sell: true, auto: true } } as any);
const escort = (sim: WorldSim, p: string, g: WGroup, target: WGroup, focus?: string) => sim.command(p, { c: 'setOp', group: g.id, op: { k: 'escort', group: target.id, ...(focus ? { focus } : {}) } } as any);
const events = (sim: WorldSim, p: string, re: RegExp) => sim.st.events.filter(e => e.company === p && re.test(e.text));
function pirateBand(sim: WorldSim, at: V, target: WGroup, comp: [string, string][] = [['corvette', 'gun'], ['corvette', 'gun']]) {
  const g = sim.newGroup('pirates', '시험 약탈단', null, { k: 'raid', home: '', target: target.id } as any);
  g.npc = { role: 'rogue', sys: sysOf(sim, at)!, home: '', homePos: at, template: comp, nextRefit: 1e12, born: sim.time } as any;
  (g as any)._nextPick = 1e12; // keep the chosen target (raid re-picks every 5 s)
  comp.forEach(([c, lo], i) => sim.spawnShip('pirates', c, lo, g.id, { x: at.x + i * 60, y: 0, z: at.z }));
  return g;
}
/** moving away from the start station: escort centroid ahead of the wards along their heading */
const ahead = (ec: V, wc: V, goal: V) => (ec.x - wc.x) * (goal.x - wc.x) + (ec.z - wc.z) * (goal.z - wc.z) > 0;

// ─────────────────────────────────────────────── A. same station departure → field → guard
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  let maxSep = 0, samples = 0, aheadN = 0, minersAt = -1, escortAt = -1, guardSeen = -1;
  const firstDeparture: number[] = [];
  for (let t = 1; t <= 120; t++) {
    sim.tick(1);
    const m = ships(sim, mining), e = ships(sim, guard);
    if (m.some(s => s.state === 'space') && !firstDeparture.length) firstDeparture.push(t);
    const mc = cen(m), ec = cen(e);
    const travelling = minersAt < 0 && D(mc, f.pos) > f.radius + 900 && D(mc, astra.pos) > 800; // outbound leg
    if (travelling) { samples++; maxSep = Math.max(maxSep, D(ec, mc)); if (ahead(ec, mc, f.pos)) aheadN++; }
    if (minersAt < 0 && D(mc, f.pos) < f.radius + 300) minersAt = t;
    if (escortAt < 0 && D(ec, f.pos) < f.radius + 900) escortAt = t;
    if (guardSeen < 0 && guard.escort?.phase === 'guard') guardSeen = t;
  }
  let ring: number[] = [];
  for (let t = 0; t < 400 && !ring.length; t++) { sim.tick(1); if (guard.escort?.phase === 'guard' && ships(sim, mining).every(s => D(s.pos, f.pos) < f.radius + 300)) { for (let k = 0; k < 8; k++) sim.tick(1); ring = ships(sim, guard).map(s => D(s.pos, f.pos)); } }
  ok('A_same_station_departure', samples > 5 && aheadN / samples > 0.9 && maxSep < 1200 && escortAt <= minersAt && guardSeen > 0 && ring.every(r => r < Math.max(450, f.radius + 300) + 400),
    { field: f.id, travelSamples: samples, escortAheadShare: +(aheadN / samples).toFixed(2), maxSeparationWhileTravelling: maxSep, escortReachedFieldAt: escortAt, minersReachedFieldAt: minersAt, guardPhaseAt: guardSeen, ringDistances: ring, escortStatus: guard.status, minersStatus: mining.status });
}

// ─────────────────────────────────────────────── B. far escort: wards wait at the station, then go together
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  // escort is out in space 12 km away (same system)
  const far = { x: astra.pos.x - 12000, y: 0, z: astra.pos.z + 3000 };
  for (const s of ships(sim, guard)) { s.state = 'space'; s.task = { k: 'none' }; s.pos = { ...far, x: far.x + Math.random() * 100 }; }
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  let heldStatus = '', departAt = -1, sepAtDepart = -1, holdTicks = 0, escortPhaseAtDepart = '';
  for (let t = 1; t <= 300; t++) {
    sim.tick(1);
    const m = ships(sim, mining), e = ships(sim, guard);
    if (/집결 대기/.test(mining.status)) { holdTicks++; heldStatus ||= mining.status; }
    if (departAt < 0 && m.some(s => s.state === 'space')) { departAt = t; sepAtDepart = D(cen(e), cen(m)); escortPhaseAtDepart = guard.escort?.phase ?? ''; }
  }
  ok('B_far_escort_rally', holdTicks >= 3 && departAt > holdTicks && sepAtDepart <= 2200, { escortStartDistance: 12370, heldTicks: holdTicks, escortPhaseWhenMinersUndocked: escortPhaseAtDepart, minersUndockedAt: departAt, heldStatus, escortDistanceWhenMinersUndocked: sepAtDepart, escortStatus: guard.status });
}

// ─────────────────────────────────────────────── B2. escort many jumps away: no endless wait
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  const sysA = sysOf(sim, astra.pos)!;
  const remote = Object.values(sim.st.systems).map(s => ({ s, j: jumps(sim.st.systems, sysA, s.id) })).sort((a, b) => b.j - a.j)[0];
  for (const s of ships(sim, guard)) { s.state = 'space'; s.task = { k: 'none' }; s.pos = { x: remote.s.origin.x + 500, y: 0, z: remote.s.origin.z }; }
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  let departAt = -1, held = 0, sep = -1, eta = '';
  for (let t = 1; t <= 300; t++) {
    sim.tick(1);
    if (/집결 대기/.test(mining.status)) { held++; eta ||= mining.status; }
    if (departAt < 0 && ships(sim, mining).some(s => s.state === 'space')) { departAt = t; sep = sysOf(sim, cen(ships(sim, guard))) === sysA ? D(cen(ships(sim, guard)), cen(ships(sim, mining))) : -1; }
  }
  ok('B2_remote_escort_rally', held > 0 && departAt > 0 && departAt <= 241 && sep >= 0 && sep <= 2200, { escortJumpsAway: remote.j, firstStatus: eta, heldTicks: held, minersUndockedAt: departAt, escortDistanceAtUndock: sep, warnings: events(sim, p, /호위 합류 지연/).length });
}
{
  // the wait is bounded: a hold that has lasted waitMax (e.g. carried over a restart) ends with one warning
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos), sysA = sysOf(sim, astra.pos)!;
  const remote = Object.values(sim.st.systems).map(s => ({ s, j: jumps(sim.st.systems, sysA, s.id) })).sort((a, b) => b.j - a.j)[0];
  for (const s of ships(sim, guard)) { s.state = 'space'; s.task = { k: 'none' }; s.pos = { x: remote.s.origin.x + 500, y: 0, z: remote.s.origin.z }; }
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  for (let t = 0; t < 5; t++) sim.tick(1);
  const heldBefore = /집결 대기/.test(mining.status);
  mining.ward!.waitSince! -= 240;
  let departAt = -1;
  for (let t = 1; t <= 30; t++) { sim.tick(1); if (departAt < 0 && ships(sim, mining).some(s => s.state === 'space')) departAt = t; }
  const warn = events(sim, p, /호위 합류 지연/);
  ok('B3_wait_is_bounded', heldBefore && departAt > 0 && departAt <= 2 && warn.length === 1, { heldBefore, minersUndockedAfterTimeoutAt: departAt, warning: warn[0]?.text });
}

// ─────────────────────────────────────────────── C. escort slower than the wards
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  // the escort is a single badly damaged battlecruiser: 80 × (0.6 + 0.4×0.3) = 57.6 < miner cruise 70
  for (const s of ships(sim, guard)) { delete sim.st.ships[s.id]; }
  guard.shipIds = [];
  const bc = sim.spawnShip(p, 'battlecruiser', 'std', guard.id, { ...astra.pos }); sim.dockShip(bc, astra); bc.hp = 0.3;
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  let maxSep = 0, n = 0, aheadN = 0, maxMinerSpeed = 0;
  const escSpeed = 80 * (0.6 + 0.4 * 0.3);
  for (let t = 1; t <= 200; t++) {
    sim.tick(1);
    const m = ships(sim, mining), mc = cen(m), ec = bc.pos;
    if (D(mc, f.pos) > f.radius + 900 && D(mc, astra.pos) > 800 && m.every(s => s.state === 'space')) {
      n++; maxSep = Math.max(maxSep, D(ec, mc)); if (ahead(ec, mc, f.pos)) aheadN++;
      for (const s of m) maxMinerSpeed = Math.max(maxMinerSpeed, Math.hypot(s.vel.x, s.vel.z));
    }
  }
  ok('C_slow_escort_sets_pace', n > 5 && maxSep < 1200 && maxMinerSpeed <= escSpeed * 0.93 + 1, { escortSpeed: +escSpeed.toFixed(1), minerCruise: 70, maxMinerSpeedWhileEscorted: +maxMinerSpeed.toFixed(1), maxSeparation: maxSep, escortAheadShare: +(aheadN / Math.max(1, n)).toFixed(2), samples: n });
}

// ─────────────────────────────────────────────── D. hauler leaves the field; mining escort stays; a cargo escort follows the hauler
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  const h = sim.spawnShip(p, 'hauler', 'std', mining.id, { ...astra.pos }); sim.dockShip(h, astra);
  // second escort group: one corvette protecting the carriers of the same mining group
  const cargoEsc = sim.newGroup(p, '수송 호위');
  const cv = ships(sim, guard).find(s => s.classId === 'corvette')!;
  sim.command(p, { c: 'moveShip', ship: cv.id, group: cargoEsc.id } as any);
  escort(sim, p, guard, mining); escort(sim, p, cargoEsc, mining, 'cargo'); mine(sim, p, mining, f.id);
  let haulTrips = 0, maxGuardFromFieldMinersWorking = 0, maxGuardToMiners = 0, cargoNearHauler = 0, cargoSamples = 0, haulerAway = false, guardNearHauler = 0, awayWorking = 0;
  const minersOf = () => ships(sim, mining).filter(s => s.classId === 'miner');
  for (let t = 1; t <= 900; t++) {
    sim.tick(1);
    const away = D(h.pos, f.pos) > f.radius + 3000 && h.state === 'space';
    if (away && !haulerAway) haulTrips++;
    haulerAway = away;
    const mc = cen(minersOf()), gc = cen(ships(sim, guard));
    if (guard.shipIds.length) maxGuardToMiners = Math.max(maxGuardToMiners, D(gc, mc));
    if (away && D(mc, f.pos) < f.radius + 900) { awayWorking++; maxGuardFromFieldMinersWorking = Math.max(maxGuardFromFieldMinersWorking, D(gc, f.pos)); if (D(gc, h.pos) < 2000) guardNearHauler++; }
    if (away && cargoEsc.shipIds.length) { cargoSamples++; if (D(sim.st.ships[cv.id].pos, h.pos) < 2200) cargoNearHauler++; }
  }
  const guardRing = Math.max(450, f.radius + 300);
  ok('D_hauler_split', haulTrips >= 1 && awayWorking > 0 && maxGuardFromFieldMinersWorking < guardRing + 600 && guardNearHauler === 0 && cargoSamples > 0 && cargoNearHauler / cargoSamples > 0.85,
    { haulerTripsAwayFromField: haulTrips, ticksHaulerAwayMinersWorking: awayWorking, miningEscortMaxDistanceFromFieldThen: maxGuardFromFieldMinersWorking, ring: guardRing, miningEscortNearHaulerTicks: guardNearHauler, miningEscortMaxDistanceToMiners: maxGuardToMiners, cargoEscortWithHaulerShare: +(cargoNearHauler / Math.max(1, cargoSamples)).toFixed(2), cargoEscortStatus: cargoEsc.status });
}

// ─────────────────────────────────────────────── E/F. pirates approach the guarded field; escort intercepts, then returns
// Battles step in sim.update() (30 Hz tactical engine) — the same path the server runs.
//   cruise: the band starts 5 km out and flies in (below the warp threshold) → the escort must meet it first
//   warp:   the band starts 9 km out and warps in next to the miners (ambush) → the escort must be in that fight
for (const [mode, distOut] of [['cruise', 5000], ['warp', 9000]] as const) for (const seed of [7, 8, 9]) {
  const { sim, p, mining, guard } = setup(seed);
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  for (let t = 0; t < 150 && guard.escort?.phase !== 'guard'; t++) sim.tick(1);
  // wait until the miners are working the deposit
  for (let t = 0; t < 200 && !(guard.escort?.phase === 'guard' && ships(sim, mining).every(s => D(s.pos, f.pos) < f.radius + 300)); t++) sim.tick(1);
  const dir = { x: f.pos.x - astra.pos.x, z: f.pos.z - astra.pos.z }, l = Math.hypot(dir.x, dir.z);
  const start = { x: f.pos.x + dir.x / l * distOut, y: 0, z: f.pos.z + dir.z / l * distOut };
  isolate(sim, f.pos, 16000);
  const band = pirateBand(sim, start, mining);
  const minerHp0 = ships(sim, mining).map(s => +s.hp.toFixed(2));
  let interceptAt = -1, contact: any = null, returnedAt = -1, fled = false, doneAt = -1, minDistThreatToMiners = Infinity;
  const engs0 = new Set(Object.keys(sim.st.engagements));
  for (let t = 1; t <= 1500; t++) {
    // the measured fight is escort vs band: union forces of the system (rapid response warps in) are kept out
    if (!contact) isolate(sim, f.pos, 16000);
    // positions just before this step (a new engagement re-places ships into battle formation)
    const pre = band.shipIds.length ? { mc: cen(ships(sim, mining)), ec: cen(ships(sim, guard)), bc: cen(ships(sim, band)),
      bandToEscort: Math.min(...ships(sim, band).flatMap(a => ships(sim, guard).map(b => D(a.pos, b.pos)))),
      bandToMiners: Math.min(...ships(sim, band).flatMap(a => ships(sim, mining).map(b => D(a.pos, b.pos)))) } : null;
    sim.update(1);
    if (interceptAt < 0 && guard.escort?.phase === 'intercept') interceptAt = t;
    if (mining.fleeing) fled = true;
    if (!contact && band.shipIds.length) minDistThreatToMiners = Math.min(minDistThreatToMiners, D(cen(ships(sim, band)), cen(ships(sim, mining))));
    const e = Object.values(sim.st.engagements).find(x => !engs0.has(x.id) && x.groupRefs.includes(band.id));
    if (e && !contact) {
      const m = ships(sim, mining);
      void m;
      contact = { id: e.id, groups: e.groupRefs.map(r => `${sim.st.groups[r]?.name}(${sim.st.groups[r]?.owner})`), at: t, escortIn: e.groupRefs.includes(guard.id), minersIn: e.groupRefs.includes(mining.id),
        contactToMiners: pre ? D(e.pos, pre.mc) : -1, bandToEscortBefore: pre?.bandToEscort, bandToMinersBefore: pre?.bandToMiners, escortToMinersBefore: pre ? D(pre.ec, pre.mc) : -1 };
    }
    if (contact && doneAt < 0 && (!sim.st.engagements[contact.id] || sim.st.engagements[contact.id].done)) doneAt = t;
    if (doneAt > 0 && returnedAt < 0 && guard.shipIds.length && guard.escort?.phase === 'guard' && D(cen(ships(sim, guard)), f.pos) < Math.max(450, f.radius + 300) + 500) returnedAt = t;
    if (returnedAt > 0) break;
  }
  const lost = 2 - ships(sim, mining).length;
  const minerHp = ships(sim, mining).map(s => +s.hp.toFixed(2));
  const name = `${mode}_seed${seed}`;
  const firstMet = mode === 'cruise' ? interceptAt > 0 && !!contact && interceptAt < contact.at && contact.contactToMiners > 1200 : !!contact;
  ok(`E_pirates_${name}`, firstMet && !!contact?.escortIn && lost === 0,
    { approachFrom: distOut, interceptPhaseAt: interceptAt, contact, closestBandToMinersBeforeContact: minDistThreatToMiners, minersFled: fled, minerHpBefore: minerHp0, minerHpAfter: minerHp, minersLost: lost, escortShipsLeft: guard.shipIds.length, pirateShipsLeft: band.shipIds.length });
  ok(`F_return_${name}`, returnedAt > 0, { battleDoneAt: doneAt, backOnGuardAt: returnedAt, escortStatus: guard.status, radio: sim.st.events.filter(e => e.ref === guard.id && /위협 해소|요격한다/.test(e.text)).map(e => e.text) });
}

// ─────────────────────────────────────────────── G. mining in a neighbouring system: gates, regroup after jumps
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, sysA = sysOf(sim, astra.pos)!;
  const nb = sim.st.systems[sysA].gates[0].to;
  const f = Object.values(sim.st.fields).filter(x => !x.salvage && sysOf(sim, x.pos) === nb).sort((a, b) => D(a.pos, sim.st.systems[nb].gates.find(g => g.to === sysA)!.pos) - D(b.pos, sim.st.systems[nb].gates.find(g => g.to === sysA)!.pos))[0];
  escort(sim, p, guard, mining); const err = mine(sim, p, mining, f.id);
  let maxSepSame = 0, sepOver = 0, splitTicks = 0, regroupHold = 0, minersAt = -1, escortAt = -1, minersJumpedAt = -1, escortJumpedAt = -1;
  for (let t = 1; t <= 700; t++) {
    sim.tick(1);
    const m = ships(sim, mining), e = ships(sim, guard), mc = cen(m), ec = cen(e);
    const ms = sysOf(sim, mc), es = sysOf(sim, ec);
    if (minersJumpedAt < 0 && ms === nb) minersJumpedAt = t;
    if (escortJumpedAt < 0 && es === nb) escortJumpedAt = t;
    if (/재집결 대기/.test(mining.status)) regroupHold++;
    const allSame = [...m, ...e].every(s => sysOf(sim, s.pos) === ms);
    if (ms !== es) splitTicks++; else if (allSame && m.every(s => s.state === 'space') && D(mc, f.pos) > f.radius + 900 && D(mc, astra.pos) > 800) { maxSepSame = Math.max(maxSepSame, D(ec, mc)); if (D(ec, mc) > 2200) sepOver++; }
    if (minersAt < 0 && D(mc, f.pos) < f.radius + 300 && ms === nb) minersAt = t;
    if (escortAt < 0 && es === nb && D(ec, f.pos) < f.radius + 900) escortAt = t;
    if (minersAt > 0 && guard.escort?.phase === 'guard') break;
  }
  ok('G_jump_gate_travel', !err && minersAt > 0 && escortAt > 0 && escortAt <= minersAt + 10 && escortJumpedAt <= minersJumpedAt + 5 && splitTicks < 40,
    { cmdErr: err, targetSystem: nb, field: f.id, escortJumpedAt, minersJumpedAt, ticksInDifferentSystems: splitTicks, regroupHoldTicks: regroupHold, maxSeparationSameSystem: maxSepSame, ticksSeparatedOver2200: sepOver, warpNote: 'long in-system legs use the warp drive; separation peaks are warp transits', minersAtField: minersAt, escortAtField: escortAt, escortStatus: guard.status });
}

// ─────────────────────────────────────────────── H. escort destroyed / escort order cancelled
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  for (let t = 0; t < 120; t++) sim.tick(1);
  // the escort is wiped out (same bookkeeping as a combat loss)
  for (const s of ships(sim, guard)) { delete sim.st.ships[s.id]; }
  guard.shipIds = [];
  for (let t = 0; t < 30; t++) sim.tick(1);
  const warn = events(sim, p, /호위 전력 상실/);
  let mined = 0; const m0 = sim.st.companies[p].stats.mined;
  for (let t = 0; t < 400; t++) sim.tick(1);
  mined = sim.st.companies[p].stats.mined - m0;
  ok('H1_escort_destroyed', warn.length === 1 && mined > 0 && !/집결 대기/.test(mining.status), { warning: warn[0]?.text, minedAfterLoss: mined, minersStatus: mining.status, escortStatus: guard.status });
}
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  for (let t = 0; t < 120; t++) sim.tick(1);
  sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'idle' } } as any);
  for (let t = 0; t < 20; t++) sim.tick(1);
  const info = events(sim, p, /호위가 해제/);
  const m0 = sim.st.companies[p].stats.mined; for (let t = 0; t < 300; t++) sim.tick(1);
  ok('H2_escort_cancelled', info.length === 1 && sim.st.companies[p].stats.mined > m0, { notice: info[0]?.text, minersStatus: mining.status });
}
{
  // the protected group's order is cancelled: the escort stands by around it (no chase to an old target)
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  escort(sim, p, guard, mining); mine(sim, p, mining, f.id);
  for (let t = 0; t < 90; t++) sim.tick(1);
  sim.command(p, { c: 'deleteGroup', group: mining.id } as any);
  for (let t = 0; t < 10; t++) sim.tick(1);
  ok('H3_target_group_disbanded', guard.escort?.phase === 'lost' && /소실/.test(guard.status) && events(sim, p, /호위 대상이 사라졌습니다/).length === 1, { escortStatus: guard.status });
}

// ─────────────────────────────────────────────── I. server restart mid-mission keeps the escort order and its state
{
  const { sim, p, mining, guard } = setup();
  const astra = sim.st.stations.astra, f = nearField(sim, astra.pos);
  const far = { x: astra.pos.x - 12000, y: 0, z: astra.pos.z + 3000 };
  for (const s of ships(sim, guard)) { s.state = 'space'; s.task = { k: 'none' }; s.pos = { ...far }; }
  escort(sim, p, guard, mining, 'work'); mine(sim, p, mining, f.id);
  for (let t = 0; t < 30; t++) sim.tick(1);
  const before = { op: JSON.stringify(guard.op), phase: guard.escort?.phase, waitSince: mining.ward?.waitSince, minersStatus: mining.status };
  const re = new WorldSim(JSON.parse(sim.serialize()));
  const g2 = re.st.groups[guard.id], m2 = re.st.groups[mining.id];
  const after = { op: JSON.stringify(g2.op), phase: g2.escort?.phase, waitSince: m2.ward?.waitSince };
  let departAt = -1, sep = -1;
  for (let t = 1; t <= 300; t++) { re.tick(1); const mc = cen(ships(re, m2)); if (departAt < 0 && D(mc, astra.pos) > 1500) { departAt = t; sep = D(cen(ships(re, g2)), mc); } }
  ok('I_restart_keeps_escort', before.op === after.op && before.phase === after.phase && before.waitSince === after.waitSince && departAt > 0 && sep < 2600 && /광구 경계|진형/.test(g2.status),
    { before, after, minersLeftAfterRestartAt: departAt, escortDistanceAtDeparture: sep, escortStatusAfter: g2.status });
}

// ─────────────────────────────────────────────── J. route blocked (P10 chokepoint closed): reported, wards don't wait for it
{
  const { sim, p, mining, guard } = setup(4321, 'p10');
  const astra = sim.st.stations.astra, sysA = sysOf(sim, astra.pos)!;
  // close a gate edge whose loss cuts some system off from the start system (a real chokepoint of this layout)
  let blockedSys: any = null, edge: [string, string] | null = null;
  outer: for (const sy of Object.values(sim.st.systems)) for (const gt of sy.gates) {
    const cut = (g: any) => !((g.id === gt.id) || (sim.st.systems[gt.to].gates.some(b => b.to === sy.id && b.id === g.id)));
    const off = Object.values(sim.st.systems).find(x => x.id !== sysA && !nextGate(sim.st.systems, x.id, sysA, cut));
    if (off) { blockedSys = off; edge = [sy.id, gt.to]; break outer; }
  }
  if (edge) startConflict(sim as any, sim.st, 'iron', 'guild', [edge]);
  if (!blockedSys) ok('J_route_blocked', false, { note: 'no system cut off by the closed edge in this layout — not exercised' });
  else {
    for (const s of ships(sim, guard)) { s.state = 'space'; s.task = { k: 'none' }; s.pos = { x: blockedSys.origin.x + 300, y: 0, z: blockedSys.origin.z }; }
    escort(sim, p, guard, mining);
    const f = Object.values(sim.st.fields).filter(x => !x.salvage && sysOf(sim, x.pos) === sysA).sort((a, b) => D(a.pos, astra.pos) - D(b.pos, astra.pos))[0];
    (sim.st.intel?.[p] as any) && ((sim.st.intel![p].fields as any)[f.id] ??= { seen: sim.time });
    const err = mine(sim, p, mining, f.id);
    let departAt = -1;
    for (let t = 1; t <= 120; t++) { sim.tick(1); if (departAt < 0 && D(cen(ships(sim, mining)), astra.pos) > 1500) departAt = t; }
    const ev = events(sim, p, /호위 불가능/);
    ok('J_route_blocked', guard.escort?.phase === 'blocked' && ev.length === 1 && /경로 차단/.test(guard.status) && (err !== null || departAt > 0), { closedEdge: edge, cutOffSystem: blockedSys.id, mineCmd: err, minersLeftAt: departAt, escortStatus: guard.status, event: ev[0]?.text });
  }
}

const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
const fails = Object.entries(results).filter(([, r]) => !r.pass).map(([k]) => k);
console.log(fails.length ? `FAILED: ${fails.join(', ')}` : 'all scenarios passed');
