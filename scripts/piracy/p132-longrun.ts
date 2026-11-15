// P13.2 §17 long run: a normal P13.2 world (NPC factions, NPC traders, pirate lairs — nothing removed) with
// three logistics companies (P12.5 automatic logistics between their own stations, long production orders) and
// one raiding company with two plunder groups (lane plunder, P12 harass + plunder) on two of the logistics
// companies' delivery approaches; the third logistics company is not targeted (control for delivery times).
// Halfway the world is saved and loaded again (server restart). Nothing is faked: every container comes from a
// real demand + jettison, every wreck from a real P11 battle. Measures the 15 items of §17.
//   npx vite-node scripts/piracy/p132-longrun.ts [hours] [seed]
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import type { Station } from '../../src/world/types';
import { qty } from '../../src/world/types';
import { observeWorld } from '../../src/world/observe';
import { storageCap } from '../../src/world/production';
import { wreckUnits } from '../../src/world/wrecks';
import { assetReferenceValue, hullPrice } from '../../src/world/valuation';

const [hours = 8, seed = 1320] = process.argv.slice(2).map(Number).filter(n => n > 0);
let sim = WorldSim.create(seed, { piracy: 'p132' });
const systems = Object.values(sim.st.systems).filter(s => s.gates.length >= 2 && s.id !== 'astra').sort((a, b) => a.idx - b.idx);
const astra = sim.st.stations.astra;
const make = (p: string, id: string, sys: typeof systems[number], k: number, modules: string[]): Station => ({ ...structuredClone(astra), id, name: id, public: false, owner: p, pos: { x: sys.origin.x + 2500 + k * 1700, y: 0, z: sys.origin.z - 2000 + k * 900 }, size: 'L', market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} },
  modules: modules.map((kind, i) => ({ id: `${id}_${kind}_${i}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] } as Station);
// three logistics companies, each answering demands with a different policy
const POL = ['survive', 'balanced', 'protect'] as const;
// home systems in secured space (the raiders are not simply eaten by the pirate lairs of ember / fang / drake)
const HOMES = (process.env.HOMES ?? 'lyra,forge,ceres').split(',');
const L: string[] = [], sites: { p: string; A: Station; B: Station; C: Station }[] = [];
for (let i = 0; i < 3; i++) {
  const p = sim.addPlayer(`물류${i + 1}`), co = sim.st.companies[p]; co.credits = 5e6; L.push(p);
  for (const s of Object.values(sim.st.ships)) if (s.owner === p) delete sim.st.ships[s.id];
  for (const g of Object.values(sim.st.groups)) if (g.owner === p) delete sim.st.groups[g.id];
  const home = sim.st.systems[HOMES[i]] ?? systems[(i * 3) % systems.length], n1 = sim.st.systems[home.gates[0].to], n2 = sim.st.systems[home.gates[1].to];
  const store = ['core', 'power', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'dock', 'dock'];
  const A = make(p, `lr_${i}_A`, n1, i, store), B = make(p, `lr_${i}_B`, n2, i, store);
  const C = make(p, `lr_${i}_C`, home, i, ['core', 'power', 'power', 'refinery', 'refinery', 'logistics', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'dock', 'dock']);
  for (const s of [A, B, C]) sim.st.stations[s.id] = s;
  A.storage[p].ore = Math.floor(storageCap(A) * 0.9); B.storage[p].ore = Math.floor(storageCap(B) * 0.9);
  co.homeStation = C.id;
  for (let g = 0, made = 0; made < 6; g++) {
    const grp = sim.newGroup(p, `수송${g + 1}`);
    for (let k = 0; k < 3 && made < 6; k++, made++) { const s = sim.spawnShip(p, 'hauler', 'std', grp.id, [A, B, C][made % 3].pos); (sim as any).dockShip(s, [A, B, C][made % 3]); }
  }
  if (sim.command(p, { c: 'piracyPolicy', policy: POL[i] } as any)) throw Error('policy');
  for (let k = 0; k < 2; k++) { const err = sim.command(p, { c: 'prodOrder', station: C.id, recipe: 'alloy_direct', mode: 'count', n: 5000 } as any); if (err) throw Error(err); }
  sites.push({ p, A, B, C });
}
// the raiding company: two groups (4 corvettes + destroyer + hauler for recovery), each on one target's approach
const R = sim.addPlayer('약탈 상회'); sim.st.companies[R].credits = 2e6;
for (const s of Object.values(sim.st.ships)) if (s.owner === R) delete sim.st.ships[s.id];
for (const g of Object.values(sim.st.groups)) if (g.owner === R) delete sim.st.groups[g.id];
const NORAID = !!process.env.NORAID;
const RPOL = ['nonlethal', 'force'] as const;
// the lane plunder zone: the gate of the target's factory system through which its ore arrives (from A's system)
const ambush = (i: number) => { const C = sites[i].C, home = sim.sysOf(C.pos)!, gate = home.gates.find(g => g.to === sim.sysOf(sites[i].A.pos)!.id)!; return { x: gate.pos.x + 900, y: 0, z: gate.pos.z + 600 }; };
const raidGroups = [0, 1].map(i => {
  const g = sim.newGroup(R, `약탈${i + 1}`); g.commanderId = sim.newCommander(R, 2).id;
  const at = ambush(i);
  if (!NORAID) for (const cl of ['corvette', 'corvette', 'corvette', 'corvette', 'destroyer', 'hauler']) { const s = sim.spawnShip(R, cl, 'std', g.id, at); if (cl === 'hauler') s.logisticsExcluded = true; }
  return g;
});
if (!NORAID) for (const i of [0, 1]) if (sim.command(R, { c: 'stance', target: L[i], v: -1 } as any)) throw Error('stance');
const orderRaid = (i: number) => sim.command(R, { c: 'setOp', group: raidGroups[i].id, op: { k: 'harass', at: ambush(i), radius: 6000, plunder: RPOL[i] } } as any);
if (!NORAID) for (const i of [0, 1]) { const e = orderRaid(i); if (e) throw Error(e); }
// DEFEND=1: L2 keeps a defence group (2 destroyers + frigate, P12 defend) on its plunder zone — refusals, force, P11
const DEFEND = !!process.env.DEFEND;
if (DEFEND) {
  const g = sim.newGroup(L[1], '방어대'); g.commanderId = sim.newCommander(L[1], 2).id;
  for (const cl of ['destroyer', 'destroyer', 'frigate']) sim.spawnShip(L[1], cl, 'std', g.id, ambush(1));
  const e = sim.command(L[1], { c: 'setOp', group: g.id, op: { k: 'defend', at: ambush(1), radius: 4000 } } as any); if (e) throw Error(e);
}
const rFleetValue = Object.values(sim.st.ships).filter(s => s.owner === R).reduce((n, s) => n + hullPrice(s.hull ?? `${s.classId}_mk1`, s.variant).price, 0);
const credits0 = Object.fromEntries([...L, R].map(p => [p, sim.st.companies[p].credits]));

// ── measurement
const ITEMS = ['ore', 'alloy'];
const ref = (k: string) => assetReferenceValue(sim.st, k);
const kindOf = (c?: string) => !c ? '?' : L.includes(c) ? `L${L.indexOf(c) + 1}` : c === R ? 'raider' : sim.st.companies[c]?.kind ?? c;
const count: Record<string, number> = {};
const bump = (k: string, n = 1) => { count[k] = (count[k] ?? 0) + n; };
const flow: Record<string, Record<string, number>> = Object.fromEntries(L.map(p => [p, {}]));
const dropRefs = new Set<string>(), dropSeen = new Map<string, any>();
let pirStoreValue = 0, pirStoreUnits = 0;
const ev = (e: any) => {
  if (e.kind === 'piracy') {
    if (['threat', 'comply', 'flee', 'resist', 'stall', 'withdraw', 'force', 'sunk', 'drop', 'store', 'extortion'].includes(e.reason)) bump(`log/${e.reason}/${e.company === 'pirates' ? 'npc' : kindOf(e.company)}`);
    if (e.reason === 'to_drop') { bump(`dropped/${kindOf(e.company)}`, e.amount); bump(`droppedValue`, e.amount * ref(e.item)); }
    if (e.reason === 'lair_store') { pirStoreUnits += e.amount; pirStoreValue += e.amount * ref(e.item); }
  }
  if (e.kind === 'salvage' && e.reason === 'recover') {
    const fromDrop = String(e.ref ?? '').startsWith('cd_');
    bump(`recovered/${fromDrop ? 'drop' : 'wreck'}/${kindOf(e.company)}<-${kindOf(e.from)}`, e.amount);
  }
  if (e.kind === 'consume' && e.reason === 'drop_decay') bump(`dropDecay/${kindOf(e.company)}`, e.amount);
  if (e.kind === 'logistics' && e.reason === 'pirated') bump(`jobPirated/${kindOf(e.company)}`, e.amount);
  if (!e.item || !e.company) return;
  // per logistics company: production / consumption (combat cargo loss, decay) and ownership changes by recovery
  for (const p of L) {
    const f = flow[p];
    if (e.company === p && (e.kind === 'consume' || e.kind === 'produce')) f[e.item] = (f[e.item] ?? 0) + (e.kind === 'produce' ? e.amount : -e.amount);
    if (e.kind === 'salvage' && e.reason === 'recover' && e.from === p && e.company !== p) f[e.item] = (f[e.item] ?? 0) - e.amount;
    if (e.kind === 'salvage' && e.reason === 'recover' && e.company === p && e.from !== p) f[e.item] = (f[e.item] ?? 0) + e.amount;
    // P13.1: a sunk ship's hull / equipment become salvage material owned by the ship's owner (not its cargo)
    if (e.kind === 'salvage' && String(e.reason).startsWith('wreck_') && e.company === p) f[e.item] = (f[e.item] ?? 0) + e.amount;
  }
};
let stop = observeWorld(sim.st, ev);
const holding = (p: string, item: string) => {
  let n = 0;
  for (const st of Object.values(sim.st.stations)) n += qty(st.storage[p], item);
  for (const s of Object.values(sim.st.ships)) if (s.owner === p) n += qty(s.cargo, item);
  for (const j of Object.values(sim.st.logisticsJobs ?? {})) if (j.owner === p && j.item === item) n += j.reserved;
  for (const d of Object.values(sim.st.drops ?? {})) for (const l of d.lots) if (l.owner === p && l.item === item) n += l.n;
  for (const w of Object.values(sim.st.wrecks ?? {})) for (const l of w.lots) if (l.owner === p && l.item === item) n += l.n;
  return n;
};
const start = Object.fromEntries(L.map(p => [p, Object.fromEntries(ITEMS.map(i => [i, holding(p, i)]))]));
const save0 = sim.serialize().length;
const jobSeen = new Map<string, { owner: string; t0: number; t1?: number; item: string; amount: number }>();
let jobMismatch = 0; const mismatchSample: unknown[] = [];
let dropsActiveSum = 0, dropsActiveMax = 0, samples = 0;
const dts: number[] = []; let restartOk: boolean | null = null, err: unknown = null;
let rShips = new Map(Object.values(sim.st.ships).filter(s => s.owner === R).map(s => [s.id, s]));
const rLost: { t: number; cls: string; value: number }[] = [];
let sales = 0;
const T = Math.round(hours * 3600);
const perHour: unknown[] = [];
try {
  for (let t = 1; t <= T; t++) {
    const t0 = performance.now(); sim.update(1); dts.push(performance.now() - t0);
    for (const d of Object.values(sim.st.drops ?? {})) { if (!dropRefs.has(d.id)) { dropRefs.add(d.id); } dropSeen.set(d.id, d); }
    if (t % 10 === 0) {
      for (const j of Object.values(sim.st.logisticsJobs ?? {})) {
        if (!L.includes(j.owner)) continue;
        const r = jobSeen.get(j.id) ?? { owner: j.owner, t0: sim.time, item: j.item, amount: j.amount }; jobSeen.set(j.id, r);
        if (j.state === 'complete' && r.t1 === undefined) r.t1 = sim.time;
        // §17-9: what a job counts as carried must be aboard its ship
        if (j.ship && j.carried > 1e-6) {
          const s = sim.st.ships[j.ship];
          if (!s || qty(s.cargo, j.item) + 1e-6 < j.carried) { jobMismatch++; if (mismatchSample.length < 5) mismatchSample.push({ t: sim.time, job: j.id, carried: j.carried, aboard: s ? qty(s.cargo, j.item) : null, state: j.state }); }
        }
      }
    }
    if (t % 60 === 0) {
      samples++; const n = Object.keys(sim.st.drops ?? {}).length; dropsActiveSum += n; dropsActiveMax = Math.max(dropsActiveMax, n);
      const now = new Map(Object.values(sim.st.ships).filter(s => s.owner === R).map(s => [s.id, s]));
      for (const [id, s] of rShips) if (!now.has(id)) rLost.push({ t: sim.time, cls: s.classId, value: hullPrice(s.hull ?? `${s.classId}_mk1`, s.variant).price });
      rShips = now;
      // a raid group that ended its order (no target for a long while, or after unloading) is sent back
      for (const i of [0, 1]) { const g = sim.st.groups[raidGroups[i].id]; if (!NORAID && g && ['idle', 'dock'].includes(g.op.k) && Object.values(sim.st.ships).some(s => s.groupId === g.id)) orderRaid(i); }
    }
    if (t % 600 === 0) for (const st of Object.values(sim.st.stations)) {
      if (!st.market) continue;
      for (const [k, n] of Object.entries(st.storage[R] ?? {})) { if (n < 1) continue; const c0 = sim.st.companies[R].credits; if (!sim.command(R, { c: 'sell', station: st.id, res: k, amount: Math.floor(n) } as any)) sales += sim.st.companies[R].credits - c0; }
    }
    if (t === Math.round(T / 2)) {
      // server restart: save, load into a new world, continue
      stop(); const json = sim.serialize(); const before = JSON.stringify({ d: sim.st.drops, w: sim.st.wrecks, p: sim.st.piracy, j: sim.st.logisticsJobs });
      sim = new WorldSim(JSON.parse(json), { migrateContent: false });
      restartOk = before === JSON.stringify({ d: sim.st.drops, w: sim.st.wrecks, p: sim.st.piracy, j: sim.st.logisticsJobs });
      stop = observeWorld(sim.st, ev);
    }
    if (t % 3600 === 0) {
      const row = { hour: t / 3600, drops: Object.keys(sim.st.drops ?? {}).length, dropsCreated: dropRefs.size, wrecks: Object.keys(sim.st.wrecks ?? {}).length, engagements: Object.keys(sim.st.engagements).length,
        threats: Object.entries(count).filter(([k]) => k.startsWith('log/threat')).reduce((a, [, v]) => a + v, 0), ms: +(dts.slice(-3600).reduce((a, b) => a + b, 0) / 3600).toFixed(2), save: sim.serialize().length };
      perHour.push(row); console.log(JSON.stringify(row));
    }
  }
} catch (e) { err = e; console.error(e); }
stop();
// container accounting: initial = taken + left + decayed (all containers ever seen)
const allDrops = [...dropSeen.values()];
const dInitial = allDrops.reduce((a, d) => a + d.initial, 0);
const dTaken = allDrops.reduce((a, d) => a + Object.values(d.taken as Record<string, Record<string, number>>).reduce((x, m) => x + Object.values(m).reduce((y, z) => y + z, 0), 0), 0);
const dLeft = allDrops.filter(d => sim.st.drops?.[d.id]).reduce((a, d) => a + wreckUnits(d), 0);
const dRemoved = allDrops.filter(d => !sim.st.drops?.[d.id]).reduce((a, d) => a + wreckUnits(d), 0);
const dDecay = Object.entries(count).filter(([k]) => k.startsWith('dropDecay/')).reduce((a, [, v]) => a + v, 0);
const conservation = Object.fromEntries(L.map(p => [kindOf(p), Object.fromEntries(ITEMS.map(i => [i, +(holding(p, i) - (start[p][i] + (flow[p][i] ?? 0))).toFixed(4)]))]));
const jobs = [...jobSeen.values()];
const delivery = Object.fromEntries(L.map(p => { const done = jobs.filter(j => j.owner === p && j.t1 !== undefined).map(j => j.t1! - j.t0); return [kindOf(p), { jobs: jobs.filter(j => j.owner === p).length, completed: done.length, meanMin: done.length ? +(done.reduce((a, b) => a + b, 0) / done.length / 60).toFixed(1) : null, p90Min: done.length ? +(done.sort((a, b) => a - b)[Math.floor(done.length * 0.9)] / 60).toFixed(1) : null }]; }));
const stored = Object.values(sim.st.stations).reduce((n, st) => n + Object.entries(st.storage[R] ?? {}).reduce((x, [k, v]) => x + v * ref(k), 0), 0);
const aboard = Object.values(sim.st.ships).filter(s => s.owner === R).reduce((n, s) => n + Object.entries(s.cargo).reduce((x, [k, v]) => x + (v as number) * ref(k), 0), 0);
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const tally = (pre: string) => Object.fromEntries(Object.entries(count).filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k.slice(pre.length), +v.toFixed(2)]));
const responses = tally('log/');
const out = {
  hours, seed, noRaid: NORAID, defend: DEFEND, homes: HOMES, error: err ? String(err) : null, restartEqual: restartOk,
  '1_attempts': Object.fromEntries(Object.entries(responses).filter(([k]) => k.startsWith('threat/'))),
  '2_responses': Object.fromEntries(Object.entries(responses).filter(([k]) => /^(comply|flee|resist|stall)\//.test(k))),
  '3_nonDestructiveDrops': Object.fromEntries(Object.entries(responses).filter(([k]) => k.startsWith('drop/'))),
  '4_forceAndSinkings': Object.fromEntries(Object.entries(responses).filter(([k]) => /^(force|sunk|withdraw)\//.test(k))),
  '5_droppedUnits': tally('dropped/'), droppedReferenceValue: Math.round(count.droppedValue ?? 0),
  '6_recoveredUnits': tally('recovered/'),
  '7_dropDecayUnits': tally('dropDecay/'),
  '8_conservation': { containers: { created: allDrops.length, initial: +dInitial.toFixed(3), taken: +dTaken.toFixed(3), left: +dLeft.toFixed(3), removedRemainder: +dRemoved.toFixed(3), decayed: +dDecay.toFixed(3), error: +(dInitial - dTaken - dLeft - dRemoved).toFixed(6), decayEqualsRemoved: Math.abs(dDecay - dRemoved) < 1e-6 }, perCompanyItems: conservation },
  '9_jobMismatch': { samples: jobMismatch, sample: mismatchSample, piratedSettled: tally('jobPirated/') },
  '10_raider': { fleetReferenceValue: Math.round(rFleetValue), shipsLost: rLost.length, lostValue: Math.round(rLost.reduce((a, x) => a + x.value, 0)), lost: rLost.slice(0, 10), sales: Math.round(sales), creditsChange: Math.round(sim.st.companies[R].credits - credits0[R]), storedValue: Math.round(stored), aboardValue: Math.round(aboard),
    netIncludingLostHulls: Math.round(sim.st.companies[R].credits - credits0[R] + stored + aboard - rLost.reduce((a, x) => a + x.value, 0)) },
  '11_delivery': delivery,
  '12_npcPirates': { lairStoredUnits: +pirStoreUnits.toFixed(2), lairStoredReferenceValue: Math.round(pirStoreValue) },
  '13_tick': { meanMs: +(dts.reduce((a, b) => a + b, 0) / dts.length).toFixed(3), p95Ms: +q(dts, .95).toFixed(2), p99Ms: +q(dts, .99).toFixed(2), maxMs: +Math.max(...dts).toFixed(1) },
  '14_save': { start: save0, end: sim.serialize().length, dropsJson: JSON.stringify(sim.st.drops ?? {}).length, piracyBookJson: JSON.stringify(sim.st.piracy ?? {}).length, wrecksJson: JSON.stringify(sim.st.wrecks ?? {}).length },
  '15_activeContainers': { mean: +(dropsActiveSum / Math.max(1, samples)).toFixed(2), max: dropsActiveMax, end: Object.keys(sim.st.drops ?? {}).length },
  engagements: Object.keys(sim.st.engagements).length, wrecksEnd: Object.keys(sim.st.wrecks ?? {}).length,
  perHour,
};
console.log(JSON.stringify(out, null, 1));
mkdirSync('docs/piracy-results', { recursive: true });
writeFileSync(`docs/piracy-results/p132-longrun-${hours}h-s${seed}${NORAID ? '-noraid' : ''}${DEFEND ? '-defend' : ''}.json`, JSON.stringify(out, null, 2));
