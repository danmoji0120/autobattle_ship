// P13.2.2 §D — raiding economics in a P10 40-system world (factions v2, natural NPC guild traders, pirate lairs)
// on logistics that happen on their own: victim companies run P12.5 production (raw stations → factory, the
// automatic logistics moves the ore), nobody scripts a convoy. The raider puts its fleets on lane plunder at the
// gates where the warm-up hour saw the most loaded cargo ships. Nothing is faked: every container comes from a
// real demand → jettison, every sale is a real `sell` at a real market, costs are what the world charged; unsold
// goods are reported apart and never counted as cash.
//
// The same script runs on the code before the target-choice AI (P13.2.1, 80869ca) and after it (P13.2.2):
// split recovery uses the lootTender order when the code has it, else (before) a salvage zone at the ambush.
//   RAID    = medium (3 corvettes + destroyer + hauler, per lane) | split (the warships; a separate 2-hauler recovery fleet)
//   NEUTRAL = 1: guild NPC traders are targets too (extortion where the law reaches) | 0: hostile companies only
//   DETCLOCK= 1 (default): a fixed clock, so NPC battles never run out of their wall-time budget and the run does
//           not depend on machine load (P13.2.2 §D.1: that budget made P13.2.1's 22.96 vs 55.29 per unit). No game code changes.
//   npx vite-node scripts/piracy/p1322-p10-econ.ts [hours] [seed]
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
if ((process.env.DETCLOCK ?? '1') !== '0') { const t = { v: 0 }; (globalThis.performance as any).now = () => t.v; }
import { WorldSim } from '../../src/world/sim';
import type { Station, WShip, WGroup, V } from '../../src/world/types';
import { qty } from '../../src/world/types';
import { observeWorld } from '../../src/world/observe';
import { storageCap } from '../../src/world/production';
import { assetReferenceValue, hullPrice } from '../../src/world/valuation';
import { repairQuote } from '../../src/world/repair';
import { opsOf, OP_NAME } from '../../src/world/operations';
import { priceOf } from '../../src/world/market';
import { dist } from '../../src/world/geom';

const [hours = 8, seed = 13220] = process.argv.slice(2).map(Number).filter(n => n > 0);
const RAID = (process.env.RAID ?? 'medium') as 'medium' | 'split';
const NEUTRAL = (process.env.NEUTRAL ?? '1') !== '0';
const VICTIMS = Number(process.env.VICTIMS ?? 4);
const LANES = Number(process.env.LANES ?? 2);
const HOLD = !!process.env.HOLD;
const code = (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() + (execSync('git status --porcelain src', { encoding: 'utf8' }).trim() ? '+dirty' : ''); } catch { return '?'; } })();
const TAG = process.env.TAG ?? `p10-${RAID}${NEUTRAL ? '-neutral' : ''}${HOLD ? '-hold' : ''}-${hours}h-s${seed}-${code}`;
const RAID_FLEET: Record<typeof RAID, string[]> = { medium: ['corvette', 'corvette', 'corvette', 'destroyer', 'hauler'], split: ['corvette', 'corvette', 'corvette', 'destroyer'] };

let sim = WorldSim.create(seed, { layout: 'p10', piracy: 'p132', factionEcon: 'v2' } as any);
const tmpl = Object.values(sim.st.stations).find(s => s.public)!;
const make = (p: string, id: string, sys: { origin: { x: number; z: number } }, k: number, modules: string[]): Station => ({ ...structuredClone(tmpl), id, name: id, public: false, owner: p, pos: { x: sys.origin.x + 2500 + k * 1700, y: 0, z: sys.origin.z - 2000 + k * 900 }, size: 'L', market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} },
  modules: modules.map((kind, i) => ({ id: `${id}_${kind}_${i}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] } as Station);
const wipe = (p: string) => { for (const s of Object.values(sim.st.ships)) if (s.owner === p) delete sim.st.ships[s.id]; for (const g of Object.values(sim.st.groups)) if (g.owner === p) delete sim.st.groups[g.id]; };
const run = (sec: number) => { for (let t = 0; t < sec; t++) sim.update(1); };

// ── natural world first: one hour so the guild trade and the factions are moving
run(3600);

// ── victims: P12.5 production companies (raw ore at two stations in neighbouring systems, a refinery that makes
//    alloy from it); the automatic logistics moves the ore, nobody orders a shipment
const systems = Object.values(sim.st.systems).filter(s => s.gates.length >= 2).sort((a, b) => a.idx - b.idx);
const victims: string[] = [];
for (let i = 0; i < VICTIMS; i++) {
  const p = sim.addPlayer(`생산${i + 1}`); wipe(p); sim.st.companies[p].credits = 5e6; victims.push(p);
  const home = systems[(i * 7 + 3) % systems.length], n1 = sim.st.systems[home.gates[0].to], n2 = sim.st.systems[home.gates[1].to];
  const store = ['core', 'power', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'dock', 'dock'];
  const A = make(p, `pv_${i}_A`, n1, i, store), B = make(p, `pv_${i}_B`, n2, i, store);
  const C = make(p, `pv_${i}_C`, home, i, ['core', 'power', 'power', 'refinery', 'refinery', 'logistics', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'dock', 'dock']);
  for (const s of [A, B, C]) sim.st.stations[s.id] = s;
  A.storage[p].ore = Math.floor(storageCap(A) * 0.9); B.storage[p].ore = Math.floor(storageCap(B) * 0.9);
  sim.st.companies[p].homeStation = C.id;
  for (let g = 0, made = 0; made < 6; g++) {
    const grp = sim.newGroup(p, `수송${g + 1}`);
    for (let k = 0; k < 3 && made < 6; k++, made++) { const s = sim.spawnShip(p, 'hauler', 'std', grp.id, [A, B, C][made % 3].pos); (sim as any).dockShip(s, [A, B, C][made % 3]); }
  }
  for (let k = 0; k < 2; k++) { const err = sim.command(p, { c: 'prodOrder', station: C.id, recipe: 'alloy_direct', mode: 'count', n: 5000 } as any); if (err) throw Error(err); }
}

// ── warm-up traffic census: loaded cargo ships in space, binned by the nearest gate (within 8 km)
const R = sim.addPlayer('약탈 상회'); wipe(R); sim.st.companies[R].credits = 3e6;
const traffic = new Map<string, { n: number; value: number; pos: V; sys: string; gate: string }>();
for (let t = 0; t < 3600; t += 30) {
  run(30);
  for (const s of Object.values(sim.st.ships)) {
    if (s.state !== 'space' || s.owner === R || s.owner === 'pirates' || !Object.values(s.cargo).some(n => n > 1)) continue;
    const sys = sim.sysOf(s.pos); if (!sys) continue;
    let best: { d: number; g: (typeof sys.gates)[number] } | undefined;
    for (const g of sys.gates) { const d = dist(g.pos, s.pos); if (d < 8000 && (!best || d < best.d)) best = { d, g }; }
    if (!best) continue;
    const key = `${sys.id}>${best.g.to}`, v = Object.entries(s.cargo).reduce((a, [k, n]) => a + (n as number) * assetReferenceValue(sim.st, k), 0);
    const e = traffic.get(key) ?? { n: 0, value: 0, pos: best.g.pos, sys: sys.id, gate: best.g.to }; e.n++; e.value += v; traffic.set(key, e);
  }
}
const picked: [string, { n: number; value: number; pos: V; sys: string; gate: string }][] = [];
for (const e of [...traffic.entries()].sort((a, b) => b[1].n - a[1].n)) { if (picked.length >= LANES) break; if (picked.some(([, x]) => (x.sys === e[1].gate && x.gate === e[1].sys) || x.sys === e[1].sys)) continue; picked.push(e); }   // distinct chokepoints: not both ends of one gate, one lane per system
const lanes = picked.map(([k, e]) => ({ key: k, ...e, ambush: { x: e.pos.x + 900, y: 0, z: e.pos.z + 600 } }));
if (!lanes.length) throw Error('no traffic');
for (const v of victims) if (sim.command(R, { c: 'stance', target: v, v: -1 } as any)) throw Error('stance');

// ── raider fleets, one per lane
const raids: WGroup[] = [], tenders: WGroup[] = [];
let tenderOrder = 'none';
for (const [i, L] of lanes.entries()) {
  const g = sim.newGroup(R, `약탈대${i + 1}`); g.commanderId = sim.newCommander(R, 2).id;
  for (const cl of RAID_FLEET[RAID]) { const s = sim.spawnShip(R, cl, 'std', g.id, L.ambush); if (cl === 'hauler') s.logisticsExcluded = true; }
  raids.push(g);
  if (RAID === 'split') {
    const t = sim.newGroup(R, `회수선${i + 1}`); t.commanderId = sim.newCommander(R, 2).id;
    for (let k = 0; k < 2; k++) { const s = sim.spawnShip(R, 'hauler', 'std', t.id, { ...L.ambush, x: L.ambush.x - 1200 - k * 40 }); s.logisticsExcluded = true; }
    tenders.push(t);
  }
}
const orderRaid = (i: number) => HOLD ? sim.command(R, { c: 'setOp', group: raids[i].id, op: { k: 'defend', at: lanes[i].ambush, radius: 3000 } } as any)
  : sim.command(R, { c: 'setOp', group: raids[i].id, op: { k: 'harass', at: lanes[i].ambush, radius: 6000, plunder: 'nonlethal', ...(NEUTRAL ? { neutral: true } : {}) } } as any);
const orderTender = (i: number) => {
  const t = tenders[i]; if (!t) return null;
  if (HOLD) return sim.command(R, { c: 'setOp', group: t.id, op: { k: 'defend', at: lanes[i].ambush, radius: 3000 } } as any);
  // the code supports the order only if it knows it (an unknown op kind passes the old validateOp's default
  // branch and leaves the fleet inert — the first run of the 80869ca split cases, kept as invalid)
  if ((OP_NAME as Record<string, string>).lootTender) {
    const e = sim.command(R, { c: 'setOp', group: t.id, op: { k: 'lootTender', group: raids[i].id } } as any);
    if (!e) { tenderOrder = 'lootTender'; return null; }
    return e;
  }
  tenderOrder = 'salvzone (no lootTender in this code)';
  return sim.command(R, { c: 'setOp', group: t.id, op: { k: 'salvzone', at: lanes[i].ambush, radius: 6000, ...(NEUTRAL ? { illegal: true } : {}) } } as any);
};
for (let i = 0; i < lanes.length; i++) { const e = orderRaid(i); if (e) throw Error('raid ' + e); const e2 = orderTender(i); if (e2) throw Error('tender ' + e2); }
const hullValue = (s: WShip) => hullPrice(s.hull ?? `${s.classId}_mk1`, s.variant).price;
const investment = Object.values(sim.st.ships).filter(s => s.owner === R).reduce((n, s) => n + hullValue(s), 0);
const credits0 = sim.st.companies[R].credits, rep0 = sim.st.companies[R].rep;

// ── measurement
const ref = (k: string) => assetReferenceValue(sim.st, k);
const c: Record<string, number> = {};
const bump = (k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };
const cost: Record<string, number> = {};
const who = (co: string | undefined) => victims.includes(co ?? '') ? 'V' : co === 'guild' ? 'guild' : 'other';
const estimates: { t: number; group: string; to: string; est: unknown }[] = [];
const ev = (e: any) => {
  if (e.kind === 'piracy' && e.company === R && ['threat', 'comply', 'flee', 'resist', 'stall', 'withdraw', 'force', 'sunk', 'drop'].includes(e.reason)) {
    bump(`${e.reason}/${who(e.from)}`);
    if (e.reason === 'threat') { const g = Object.values(sim.st.groups).find(x => x.owner === R && x.plx?.ship === e.ship); estimates.push({ t: sim.time, group: g?.name ?? '?', to: who(e.from), est: g?.plx?.est ?? null }); }
  }
  if (e.kind === 'piracy' && e.reason === 'to_drop' && e.to === R) { const w = who(e.company); bump(`dropped/${w}/${e.item}`, e.amount); bump(`droppedRef/${w}`, e.amount * ref(e.item)); }
  if (e.kind === 'salvage' && e.reason === 'recover' && e.company === R) { bump(`recovered/${String(e.ref ?? '').startsWith('cd_') ? 'drop' : 'wreck'}/${who(e.from)}/${e.item}`, e.amount); bump('recoveredRef', e.amount * ref(e.item)); }
  if (e.kind === 'cost' && e.company === R) cost[e.reason] = (cost[e.reason] ?? 0) + e.amount;
};
let stop = observeWorld(sim.st, ev);
let rShips = new Map(Object.values(sim.st.ships).filter(s => s.owner === R).map(s => [s.id, s]));
const rLost: { t: number; cls: string; value: number }[] = [];
const fights: { id: string; t: number; sys?: string; sides: string[] }[] = [];
const sales: { t: number; item: string; n: number; cr: number; station: string; bidBefore: number | null }[] = [];
let restartOk: boolean | null = null, err: unknown = null;
const T = Math.round(hours * 3600), perHour: unknown[] = [];
try {
  for (let t = 1; t <= T; t++) {
    sim.update(1);
    if (t % 60 === 0) {
      const now = new Map(Object.values(sim.st.ships).filter(s => s.owner === R).map(s => [s.id, s]));
      for (const [id, s] of rShips) if (!now.has(id)) rLost.push({ t: sim.time, cls: s.classId, value: hullValue(s) });
      // who the raider's fleets are fighting (P11 engagements), sampled each minute
      for (const e of Object.values(sim.st.engagements)) {
        const refs = (e as any).groupRefs as string[] | undefined; if (!refs?.some(id => sim.st.groups[id]?.owner === R)) continue;
        const key = (e as any).id ?? JSON.stringify(refs);
        if (!fights.some(f => f.id === key)) fights.push({ id: key, t: sim.time, sys: (e as any).sys, sides: [...new Set(refs.map(id => sim.st.groups[id]?.owner ?? '?'))].map(o => who(o) === 'other' ? o : who(o)) });
      }
      rShips = now;
      for (let i = 0; i < raids.length; i++) {
        const g = sim.st.groups[raids[i].id]; if (g && ['idle', 'dock'].includes(g.op.k) && g.shipIds.some(id => sim.st.ships[id])) orderRaid(i);
        const r2 = tenders[i] && sim.st.groups[tenders[i].id]; if (r2 && ['idle', 'dock'].includes(r2.op.k) && r2.shipIds.some(id => sim.st.ships[id])) orderTender(i);
      }
    }
    // real sales: every 10 min whatever the raider holds at a market station goes to that market's real bid
    if (t % 600 === 0) for (const st of Object.values(sim.st.stations)) {
      if (!st.market) continue;
      for (const [k, n] of Object.entries(st.storage[R] ?? {})) {
        if (n < 1) continue; const c0 = sim.st.companies[R].credits, s0 = qty(st.storage[R], k);
        const m = (st.market as any)[k]; const bid = m ? priceOf(m, 'sell', true) : null;
        if (!sim.command(R, { c: 'sell', station: st.id, res: k, amount: Math.floor(n) } as any)) sales.push({ t: sim.time, item: k, n: s0 - qty(st.storage[R], k), cr: sim.st.companies[R].credits - c0, station: st.id, bidBefore: bid });
      }
    }
    if (t === Math.round(T / 2)) {
      stop(); const json = sim.serialize(); const before = JSON.stringify({ d: sim.st.drops, p: sim.st.piracy, j: sim.st.logisticsJobs });
      sim = new WorldSim(JSON.parse(json), { migrateContent: false });
      restartOk = before === JSON.stringify({ d: sim.st.drops, p: sim.st.piracy, j: sim.st.logisticsJobs });
      stop = observeWorld(sim.st, ev);
      rShips = new Map(Object.values(sim.st.ships).filter(s => s.owner === R).map(s => [s.id, s]));
    }
    if (t % 3600 === 0) {
      const row = { hour: t / 3600, credits: Math.round(sim.st.companies[R].credits - credits0), threats: Object.entries(c).filter(([k]) => k.startsWith('threat/')).reduce((a, [, v]) => a + v, 0), comply: Object.entries(c).filter(([k]) => k.startsWith('comply/')).reduce((a, [, v]) => a + v, 0), sold: Math.round(sales.reduce((a, s) => a + s.cr, 0)), rShips: rShips.size };
      perHour.push(row); console.log(JSON.stringify(row));
    }
  }
} catch (e) { err = e; console.error(e); }
stop();
const co = sim.st.companies[R];
const ledger = opsOf(co).ledger.reduce((m: { inc: Record<string, number>; exp: Record<string, number> }, b) => { for (const [k, v] of Object.entries(b.inc)) m.inc[k] = Math.round((m.inc[k] ?? 0) + v); for (const [k, v] of Object.entries(b.exp)) m.exp[k] = Math.round((m.exp[k] ?? 0) + v); return m; }, { inc: {}, exp: {} });
const unsold: Record<string, { units: number; ref: number }> = {};
for (const st of Object.values(sim.st.stations)) for (const [k, n] of Object.entries(st.storage[R] ?? {})) if (n > 0) { const u = (unsold[k] ??= { units: 0, ref: 0 }); u.units += n; u.ref += n * ref(k); }
for (const s of Object.values(sim.st.ships)) if (s.owner === R) for (const [k, n] of Object.entries(s.cargo)) if ((n as number) > 0) { const u = (unsold[`${k}(aboard)`] ??= { units: 0, ref: 0 }); u.units += n as number; u.ref += (n as number) * ref(k); }
const repairDue = Object.values(sim.st.ships).filter(s => s.owner === R && s.hp < 1 - 1e-6).reduce((n, s) => n + (repairQuote(sim.st, s, co).cost ?? 0), 0);
const cashFlow = co.credits - credits0;
const lostHull = rLost.reduce((a, x) => a + x.value, 0);
const salesCr = sales.reduce((a, s) => a + s.cr, 0);
const finalPL = cashFlow - lostHull - repairDue;
const salesBy = sales.reduce((m: Record<string, { n: number; cr: number }>, s) => { const x = (m[s.item] ??= { n: 0, cr: 0 }); x.n += s.n; x.cr += s.cr; return m; }, {});
const sum = (p: string) => Object.entries(c).filter(([k]) => k.startsWith(p)).reduce((a, [, v]) => a + v, 0);
const out = {
  tag: TAG, code, hours, seed, raid: RAID, neutral: NEUTRAL, hold: HOLD, victims: VICTIMS, detClock: (process.env.DETCLOCK ?? '1') !== '0', tenderOrder, error: err ? String(err) : null, restartEqual: restartOk,
  lanes: lanes.map(l => ({ key: l.key, loadedSamples: l.n, refValueSeen: Math.round(l.value) })),
  attempts: sum('threat/'), complies: sum('comply/'), byTarget: Object.fromEntries(Object.entries(c).filter(([k]) => /^(threat|comply|flee|resist|stall|withdraw|force|sunk)\//.test(k))),
  droppedUnits: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('dropped/')).map(([k, v]) => [k.slice(8), Math.round(v)])), droppedReferenceValue: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('droppedRef/')).map(([k, v]) => [k.slice(11), Math.round(v)])),
  recoveredUnits: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('recovered/')).map(([k, v]) => [k.slice(10), Math.round(v)])), recoveredReferenceValue: Math.round(c.recoveredRef ?? 0),
  sales: { credits: Math.round(salesCr), byItem: Object.fromEntries(Object.entries(salesBy).map(([k, v]) => [k, { units: Math.round(v.n), cr: Math.round(v.cr), perUnit: v.n ? +(v.cr / v.n).toFixed(2) : null, refPerUnit: ref(k) }])), count: sales.length },
  unsold: Object.fromEntries(Object.entries(unsold).map(([k, v]) => [k, { units: Math.round(v.units), referenceValue: Math.round(v.ref) }])), unsoldReferenceValue: Math.round(Object.values(unsold).reduce((a, v) => a + v.ref, 0)),
  costEvents: Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, Math.round(v)])), ledger,
  upkeep: Math.round(ledger.exp.upkeep ?? 0), repairDue: Math.round(repairDue),
  lostHulls: { ships: rLost.length, value: Math.round(lostHull), list: rLost }, investment: Math.round(investment),
  netCashFlow: Math.round(cashFlow), finalPL: Math.round(finalPL), perHourPL: Math.round(finalPL / hours),
  paybackHours: finalPL > 0 ? +(investment / (finalPL / hours)).toFixed(1) : null,
  reputation: { start: +rep0.toFixed(2), end: +co.rep.toFixed(2) },
  fights,
  estimates: estimates.slice(0, 400), perHour,
};
console.log(JSON.stringify({ ...out, estimates: `${estimates.length} rows` }, null, 1));
mkdirSync('docs/piracy-results/p1322', { recursive: true });
writeFileSync(`docs/piracy-results/p1322/p10-${TAG}.json`, JSON.stringify(out, null, 2));
