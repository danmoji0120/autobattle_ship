// P13.2.1 §4 — raiding economics under controlled conditions, in a normal P13.2 world (NPC factions, NPC
// traders and lairs left in place; same seed for every run). Nothing is faked: the victim's haulers carry the
// victim's own stock on real P12.5 logistics transfers, every container comes from a real demand → jettison,
// every sale is a real `sell` command at a real market (price, stock and budget as they are), upkeep and
// maintenance are what the world charged.
//
//   CARGO = A (ore, low) | B (alloy, mid) | C (electronics, high) | D (ore + alloy + electronics, mixed)
//   RAID  = small | medium | p132 (the old P13.2 group) | split (medium warships + a separate recovery hauler)
//   ESCORT= none | light (2 corvettes) | medium (destroyer + 2 corvettes) | strong (2 destroyers + frigate, the
//           old DEFEND group) — one escort group per convoy group
//   HOLD=1  control: the same raider fleet is owned and kept at the ambush, but never plunders
//   npx vite-node scripts/piracy/p1321-econ.ts [hours] [seed]
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import type { Station, WShip } from '../../src/world/types';
import { qty } from '../../src/world/types';
import { observeWorld } from '../../src/world/observe';
import { storageCap } from '../../src/world/production';
import { assetReferenceValue, hullPrice } from '../../src/world/valuation';
import { econOf } from '../../src/world/hullops';
import { repairQuote } from '../../src/world/repair';
import { opsOf } from '../../src/world/operations';

const [hours = 8, seed = 13210] = process.argv.slice(2).map(Number).filter(n => n > 0);
const CARGO = (process.env.CARGO ?? 'C') as 'A' | 'B' | 'C' | 'D';
const RAID = (process.env.RAID ?? 'p132') as 'small' | 'medium' | 'p132' | 'split';
const ESCORT = (process.env.ESCORT ?? 'none') as 'none' | 'light' | 'medium' | 'strong';
const HOLD = !!process.env.HOLD;
const POLICY = (process.env.POLICY ?? 'nonlethal') as 'nonlethal' | 'force';
const VPOL = process.env.VPOL ?? 'balanced';   // the victim company's response policy (survive | balanced | protect)
const TAG = process.env.TAG ?? `${CARGO}-${RAID}-${ESCORT}${HOLD ? '-hold' : ''}${POLICY !== 'nonlethal' ? '-' + POLICY : ''}${VPOL !== 'balanced' ? '-v' + VPOL : ''}-${hours}h-s${seed}`;
const CARGO_ITEMS: Record<typeof CARGO, string[]> = { A: ['ore'], B: ['alloy'], C: ['electronics'], D: ['ore', 'alloy', 'electronics'] };
const RAID_FLEET: Record<typeof RAID, string[]> = {
  small: ['corvette', 'corvette', 'hauler'], medium: ['corvette', 'corvette', 'corvette', 'destroyer', 'hauler'],
  p132: ['corvette', 'corvette', 'corvette', 'corvette', 'destroyer', 'hauler'], split: ['corvette', 'corvette', 'corvette', 'destroyer'],
};
const ESCORT_FLEET: Record<typeof ESCORT, string[]> = { none: [], light: ['corvette', 'corvette'], medium: ['destroyer', 'corvette', 'corvette'], strong: ['destroyer', 'destroyer', 'frigate'] };

let sim = WorldSim.create(seed, { piracy: 'p132' });
const astra = sim.st.stations.astra;
const make = (p: string, id: string, sys: { origin: { x: number; z: number } }, modules: string[]): Station => ({ ...structuredClone(astra), id, name: id, public: false, owner: p, pos: { x: sys.origin.x + 2500, y: 0, z: sys.origin.z - 2000 }, size: 'L', market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} },
  modules: modules.map((kind, i) => ({ id: `${id}_${kind}_${i}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] } as Station);
const wipe = (p: string) => { for (const s of Object.values(sim.st.ships)) if (s.owner === p) delete sim.st.ships[s.id]; for (const g of Object.values(sim.st.groups)) if (g.owner === p) delete sim.st.groups[g.id]; };

// ── victim: one logistics company, origin X in a neighbour of lyra, destination Y in lyra (secured space)
const home = sim.st.systems[process.env.VHOME ?? 'lyra'], nb = sim.st.systems[home.gates[0].to];
const V = sim.addPlayer('수송 회사'); wipe(V); sim.st.companies[V].credits = 5e6;
const store = ['core', 'power', 'power', 'logistics', ...Array(8).fill('warehouse'), 'dock', 'dock'];
const X = make(V, 'ec_X', nb, store), Y = make(V, 'ec_Y', home, store);
sim.st.stations[X.id] = X; sim.st.stations[Y.id] = Y; sim.st.companies[V].homeStation = Y.id;
const items = CARGO_ITEMS[CARGO];
for (const it of items) X.storage[V][it] = Math.floor(storageCap(X) * 0.9 / items.length);
const convoys = [0, 1].map(k => {
  const g = sim.newGroup(V, `수송${k + 1}`);
  for (let i = 0; i < 3; i++) { const s = sim.spawnShip(V, 'hauler', 'std', g.id, X.pos); (sim as any).dockShip(s, X); }
  return g;
});
const vShips = Object.values(sim.st.ships).filter(s => s.owner === V).map(s => s.id);
if (sim.command(V, { c: 'poolShips', ships: vShips, on: true } as any)) throw Error('pool');
if (sim.command(V, { c: 'piracyPolicy', policy: VPOL } as any)) throw Error('victim policy');
for (const it of items) { const e = sim.command(V, { c: 'poolCreate', request: { from: X.id, to: Y.id, item: it, kind: 'transfer', amount: Math.floor(X.storage[V][it]), priority: 5, repeat: false } } as any); if (e) throw Error('poolCreate ' + e); }
const escorts = ESCORT === 'none' ? [] : convoys.map((c, k) => {
  const g = sim.newGroup(V, `호위${k + 1}`); g.commanderId = sim.newCommander(V, 2).id;
  for (const cl of ESCORT_FLEET[ESCORT]) { const s = sim.spawnShip(V, cl, 'std', g.id, X.pos); (sim as any).dockShip(s, X); }
  const e = sim.command(V, { c: 'setOp', group: g.id, op: { k: 'escort', group: c.id } } as any); if (e) throw Error('escort ' + e);
  return g;
});

// ── raider: one group on the lane (P12 harass + plunder) at the gate through which the convoys enter lyra
const R = sim.addPlayer('약탈 상회'); wipe(R); sim.st.companies[R].credits = 2e6;
const gate = home.gates.find(g => g.to === nb.id)!;
const ambush = { x: gate.pos.x + 900, y: 0, z: gate.pos.z + 600 };
const rg = sim.newGroup(R, '약탈대'); rg.commanderId = sim.newCommander(R, 2).id;
for (const cl of RAID_FLEET[RAID]) { const s = sim.spawnShip(R, cl, 'std', rg.id, ambush); if (cl === 'hauler') s.logisticsExcluded = true; }
const recovery = RAID === 'split' ? (() => { const g = sim.newGroup(R, '회수선'); const s = sim.spawnShip(R, 'hauler', 'std', g.id, { ...ambush, x: ambush.x - 600 }); s.logisticsExcluded = true; return g; })() : null;
if (!HOLD) if (sim.command(R, { c: 'stance', target: V, v: -1 } as any)) throw Error('stance');
const orderRaid = () => HOLD ? sim.command(R, { c: 'setOp', group: rg.id, op: { k: 'defend', at: ambush, radius: 3000 } } as any)
  : sim.command(R, { c: 'setOp', group: rg.id, op: { k: 'harass', at: ambush, radius: 6000, plunder: POLICY } } as any);
const orderRecovery = () => recovery && sim.command(R, { c: 'setOp', group: recovery.id, op: HOLD ? { k: 'defend', at: ambush, radius: 3000 } : { k: 'salvzone', at: ambush, radius: 6000 } } as any);
{ const e = orderRaid(); if (e) throw Error('raid ' + e); const e2 = orderRecovery(); if (e2) throw Error('recovery ' + e2); }
const hullValue = (s: WShip) => hullPrice(s.hull ?? `${s.classId}_mk1`, s.variant).price;
const investment = Object.values(sim.st.ships).filter(s => s.owner === R).reduce((n, s) => n + hullValue(s), 0);
const credits0 = sim.st.companies[R].credits;

// ── measurement
const ref = (k: string) => assetReferenceValue(sim.st, k);
const c: Record<string, number> = {};
const bump = (k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };
const cost: Record<string, number> = {};
const ev = (e: any) => {
  // piracy log events: company = the raider, from = the victim; to_drop: company = the cargo owner, to = the raider
  if (e.kind === 'piracy' && e.company === R && ['threat', 'comply', 'flee', 'resist', 'stall', 'withdraw', 'force', 'sunk', 'drop'].includes(e.reason))
    bump(`${e.reason}/${e.from === V ? 'V' : sim.st.companies[e.from]?.kind === 'player' ? 'player' : 'npc'}`);
  if (e.kind === 'piracy' && e.reason === 'to_drop' && e.to === R) { const w = e.company === V ? 'V' : 'npc'; bump(`dropped/${w}/${e.item}`, e.amount); bump(`droppedRef/${w}`, e.amount * ref(e.item)); }
  if (e.kind === 'piracy' && e.company === 'pirates' && e.reason === 'threat') bump('npcThreat');
  if (e.kind === 'salvage' && e.reason === 'recover' && e.company === R) { bump(`recovered/${String(e.ref ?? '').startsWith('cd_') ? 'drop' : 'wreck'}/${e.from === V ? 'V' : 'npc'}/${e.item}`, e.amount); bump('recoveredRef', e.amount * ref(e.item)); }
  if (e.kind === 'salvage' && e.reason === 'recover' && e.company !== R && e.from === V) bump(`recoveredByOthers/${e.company}`, e.amount);
  if (e.kind === 'consume' && e.reason === 'drop_decay' && e.company === V) bump('dropDecay', e.amount);
  if (e.kind === 'cost' && e.company === R) cost[e.reason] = (cost[e.reason] ?? 0) + e.amount;
};
let stop = observeWorld(sim.st, ev);
let rShips = new Map(Object.values(sim.st.ships).filter(s => s.owner === R).map(s => [s.id, s]));
let vLive = new Map(Object.values(sim.st.ships).filter(s => s.owner === V).map(s => [s.id, s]));
const rLost: { t: number; cls: string; value: number }[] = [], vLost: { t: number; cls: string; value: number }[] = [];
const sales: { t: number; item: string; n: number; cr: number; station: string }[] = [];
const delivered0 = qtyAt(Y);
function qtyAt(st: Station) { return Object.fromEntries(items.map(i => [i, qty(st.storage[V], i)])); }
let restartOk: boolean | null = null, err: unknown = null;
const T = Math.round(hours * 3600), perHour: unknown[] = [];
const dts: number[] = [];
try {
  for (let t = 1; t <= T; t++) {
    const t0 = performance.now(); sim.update(1); dts.push(performance.now() - t0);
    if (t % 60 === 0) {
      const now = new Map(Object.values(sim.st.ships).filter(s => s.owner === R).map(s => [s.id, s]));
      for (const [id, s] of rShips) if (!now.has(id)) rLost.push({ t: sim.time, cls: s.classId, value: hullValue(s) });
      rShips = now;
      const vn = new Map(Object.values(sim.st.ships).filter(s => s.owner === V).map(s => [s.id, s]));
      for (const [id, s] of vLive) if (!vn.has(id)) vLost.push({ t: sim.time, cls: s.classId, value: hullValue(s) });
      vLive = vn;
      const g = sim.st.groups[rg.id];
      if (g && ['idle', 'dock'].includes(g.op.k) && g.shipIds.some(id => sim.st.ships[id])) orderRaid();
      const r2 = recovery && sim.st.groups[recovery.id];
      if (r2 && ['idle', 'dock'].includes(r2.op.k) && r2.shipIds.some(id => sim.st.ships[id])) orderRecovery();
    }
    // real sales: every 10 min whatever the raider holds at a market station goes to that market's real bid
    if (t % 600 === 0) for (const st of Object.values(sim.st.stations)) {
      if (!st.market) continue;
      for (const [k, n] of Object.entries(st.storage[R] ?? {})) {
        if (n < 1) continue; const c0 = sim.st.companies[R].credits, s0 = qty(st.storage[R], k);
        if (!sim.command(R, { c: 'sell', station: st.id, res: k, amount: Math.floor(n) } as any)) sales.push({ t: sim.time, item: k, n: s0 - qty(st.storage[R], k), cr: sim.st.companies[R].credits - c0, station: st.id });
      }
    }
    if (t === Math.round(T / 2)) {
      stop(); const json = sim.serialize(); const before = JSON.stringify({ d: sim.st.drops, p: sim.st.piracy, j: sim.st.logisticsJobs });
      sim = new WorldSim(JSON.parse(json), { migrateContent: false });
      restartOk = before === JSON.stringify({ d: sim.st.drops, p: sim.st.piracy, j: sim.st.logisticsJobs });
      stop = observeWorld(sim.st, ev);
      rShips = new Map(Object.values(sim.st.ships).filter(s => s.owner === R).map(s => [s.id, s]));
      vLive = new Map(Object.values(sim.st.ships).filter(s => s.owner === V).map(s => [s.id, s]));
    }
    if (t % 3600 === 0) {
      const row = { hour: t / 3600, credits: Math.round(sim.st.companies[R].credits - credits0), comply: (c['comply/V'] ?? 0) + (c['comply/npc'] ?? 0), threats: (c['threat/V'] ?? 0) + (c['threat/npc'] ?? 0), sold: Math.round(sales.reduce((a, s) => a + s.cr, 0)), rShips: rShips.size, delivered: Object.fromEntries(items.map(i => [i, Math.round(qty(sim.st.stations[Y.id].storage[V], i) - delivered0[i])])), ms: +(dts.slice(-3600).reduce((a, b) => a + b, 0) / 3600).toFixed(2) };
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
// repairs: what the world charged (maintenance on docking, repair commands) and what the surviving damage would cost now
const repairDue = Object.values(sim.st.ships).filter(s => s.owner === R && s.hp < 1 - 1e-6).reduce((n, s) => n + (repairQuote(sim.st, s, co).cost ?? 0), 0);
const cashFlow = co.credits - credits0;
const lostHull = rLost.reduce((a, x) => a + x.value, 0);
const salesCr = sales.reduce((a, s) => a + s.cr, 0);
const finalPL = cashFlow - lostHull - repairDue;
const salesBy = sales.reduce((m: Record<string, { n: number; cr: number }>, s) => { const x = (m[s.item] ??= { n: 0, cr: 0 }); x.n += s.n; x.cr += s.cr; return m; }, {});
const out = {
  tag: TAG, hours, seed, cargo: CARGO, items, raid: RAID, escort: ESCORT, hold: HOLD, policy: POLICY, victimPolicy: VPOL, error: err ? String(err) : null, restartEqual: restartOk,
  attempts: { victim: c['threat/V'] ?? 0, npcTraders: c['threat/npc'] ?? 0 }, complies: { victim: c['comply/V'] ?? 0, npcTraders: c['comply/npc'] ?? 0 }, responses: Object.fromEntries(Object.entries(c).filter(([k]) => /^(comply|flee|resist|stall|withdraw|force|sunk|drop)\//.test(k))),
  droppedUnits: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('dropped/')).map(([k, v]) => [k.slice(8), Math.round(v)])), droppedReferenceValue: { victim: Math.round(c['droppedRef/V'] ?? 0), npcTraders: Math.round(c['droppedRef/npc'] ?? 0) },
  recoveredUnits: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('recovered/')).map(([k, v]) => [k.slice(10), Math.round(v)])), recoveredReferenceValue: Math.round(c.recoveredRef ?? 0),
  recoveredByOthers: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('recoveredByOthers/')).map(([k, v]) => [k.slice(18), Math.round(v)])), victimDropDecay: Math.round(c.dropDecay ?? 0),
  sales: { credits: Math.round(salesCr), byItem: Object.fromEntries(Object.entries(salesBy).map(([k, v]) => [k, { units: Math.round(v.n), cr: Math.round(v.cr), perUnit: v.n ? +(v.cr / v.n).toFixed(2) : null, refPerUnit: ref(k) }])), count: sales.length },
  unsold: Object.fromEntries(Object.entries(unsold).map(([k, v]) => [k, { units: Math.round(v.units), referenceValue: Math.round(v.ref) }])), unsoldReferenceValue: Math.round(Object.values(unsold).reduce((a, v) => a + v.ref, 0)),
  costEvents: Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, Math.round(v)])), ledger,
  upkeep: Math.round(ledger.exp.upkeep ?? 0), repairPaid: Math.round((ledger.exp.repair ?? 0)), repairDue: Math.round(repairDue),
  lostHulls: { ships: rLost.length, value: Math.round(lostHull), list: rLost }, investment: Math.round(investment),
  netCashFlow: Math.round(cashFlow), finalPL: Math.round(finalPL),
  paybackHours: finalPL > 0 ? +(investment / (finalPL / hours)).toFixed(1) : null,
  oldP132Formula: Math.round(cashFlow + Object.values(unsold).reduce((a, v) => a + v.ref, 0) - lostHull),
  victim: { delivered: Object.fromEntries(items.map(i => [i, Math.round(qty(sim.st.stations[Y.id].storage[V], i) - delivered0[i])])), shipsLost: vLost.length, lostValue: Math.round(vLost.reduce((a, x) => a + x.value, 0)), escorts: escorts.length },
  npcPirateThreats: c.npcThreat ?? 0, engagementsEnd: Object.keys(sim.st.engagements).length,
  tick: { meanMs: +(dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length)).toFixed(3) },
  perHour,
};
console.log(JSON.stringify(out, null, 1));
mkdirSync('docs/piracy-results/p1321', { recursive: true });
writeFileSync(`docs/piracy-results/p1321/econ-${TAG}.json`, JSON.stringify(out, null, 2));
void econOf;
