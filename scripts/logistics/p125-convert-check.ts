// P12.5 §12 conversion check for existing saves. Reads a save (or builds a legacy world with every kind of
// in-flight transport), converts a COPY with enableAutoLogistics, and verifies that nothing of value changed:
// assets, hauler ownership, cargo, per-station stock, construction reservations, in-transit goods,
// unfinished / paused shipments, positions and movement state, credits and ledger. The original is never
// written. Then the copy runs on and must deliver every converted shipment without loss.
//   npx vite-node scripts/logistics/p125-convert-check.ts -- [save.json]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import type { WorldState } from '../../src/world/types';
import { qty, cargoKeys } from '../../src/world/types';
import { enableAutoLogistics } from '../../src/world/logisticsMigrate';
import { moduleMaterials } from '../../src/world/stations';
import { observeWorld } from '../../src/world/observe';

const file = process.argv.slice(2).find(a => a.endsWith('.json'));
const checks: { ok: boolean; label: string; extra?: unknown }[] = [];
const check = (ok: unknown, label: string, extra?: unknown) => { checks.push({ ok: !!ok, label, ...(extra === undefined ? {} : { extra }) }); console.log(ok ? 'PASS' : 'FAIL', label, extra === undefined ? '' : JSON.stringify(extra)); };

function legacyWorld(): WorldSim {
  const sim = WorldSim.create(1251, { ops: 'p12' }), p = sim.addPlayer('변환 검사'), co = sim.st.companies[p]; co.credits = 5e6;
  const a = sim.st.stations.astra; a.storage[p] = { ore: 2000, alloy: 800, structure: 200, machinery: 100 };
  const own = { ...structuredClone(a), id: 'cv_own', name: '자사 정거장', public: false, owner: p, pos: { ...a.pos, x: a.pos.x + 1800 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} },
    modules: ['core', 'power', 'warehouse', 'logistics', 'refinery', 'dock'].map((kind, i) => ({ id: `cv_${kind}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] } as any;
  sim.st.stations[own.id] = own;
  const other = Object.values(sim.st.stations).find(st => st.public && st.id !== a.id && sim.canDock(st, p) && sim.sysOf(st.pos)?.id === sim.sysOf(a.pos)?.id && st.market?.ore)!;
  const hauler = (name: string) => { const g = sim.newGroup(p, name); const s = sim.spawnShip(p, 'hauler', 'std', g.id, a.pos); (sim as any).dockShip(s, a); return { g, s }; };
  const r1 = hauler('건설 공급'), r2 = hauler('단발 운송'), r3 = hauler('반복 판매'), r4 = hauler('직접 운송'), r5 = hauler('공용 배차'), r6 = hauler('공용 배차 2');
  if (sim.command(p, { c: 'queueModule', station: own.id, kind: 'warehouse' })) throw Error('queue');
  const mats = moduleMaterials(own.modules.at(-1)!); const item = Object.keys(mats).find(k => qty(a.storage[p], k) > 0) ?? 'alloy';
  const e = (x: string | null, w: string) => { if (x) throw Error(`${w}: ${x}`); };
  e(sim.command(p, { c: 'putRoute', group: r1.g.id, config: { name: '건설', from: a.id, to: own.id, item, mode: 'construction', amount: 100, repeat: true } }), 'route construction');
  e(sim.command(p, { c: 'putRoute', group: r2.g.id, config: { name: '단발', from: a.id, to: own.id, item: 'ore', mode: 'transfer', amount: 200, repeat: false } }), 'route transfer');
  e(sim.command(p, { c: 'putRoute', group: r3.g.id, config: { name: '판매', from: a.id, to: other.id, item: 'ore', mode: 'sell', amount: 100, repeat: true } }), 'route sell');
  e(sim.command(p, { c: 'setOp', group: r4.g.id, op: { k: 'haul', from: a.id, to: own.id, res: 'machinery' } }), 'haul');
  e(sim.command(p, { c: 'poolShips', ships: [r5.s.id, r6.s.id], on: true }), 'pool');
  e(sim.command(p, { c: 'poolCreate', request: { from: a.id, to: own.id, item: 'structure', kind: 'transfer', amount: 150, priority: 5, repeat: false } }), 'pool job');
  e(sim.command(p, { c: 'poolCreate', request: { from: a.id, to: own.id, item: 'alloy', kind: 'transfer', amount: 100, priority: 5, repeat: false } }), 'pool job 2');
  for (let i = 0; i < 2000; i++) { sim.update(.25); if ([r1, r2, r4, r5].every(x => cargoKeys(x.s.cargo).length) && sim.st.ships[r5.s.id].state === 'space') break; }
  // one pool shipment paused by the player mid-flight
  const j2 = Object.values(sim.st.logisticsJobs ?? {}).find(j => j.item === 'alloy');
  if (j2) sim.command(p, { c: 'poolControl', job: j2.id, action: 'pause' });
  return sim;
}

const original: WorldState = file ? JSON.parse(readFileSync(file, 'utf8')).world ?? JSON.parse(readFileSync(file, 'utf8')) : JSON.parse(legacyWorld().serialize());
const originalText = JSON.stringify(original);
const copy = new WorldSim(structuredClone(original), { migrateContent: false });
const players = Object.values(copy.st.companies).filter(c => c.kind === 'player').map(c => c.id);
function census(st: WorldState) {
  const out: Record<string, any> = {};
  for (const p of players) {
    const items: Record<string, number> = {};
    const add = (k: string, n: number) => { if (n) items[k] = (items[k] ?? 0) + n; };
    for (const s of Object.values(st.stations)) for (const k of cargoKeys(s.storage[p] ?? {})) add(k, qty(s.storage[p], k));
    for (const s of Object.values(st.ships)) if (s.owner === p) for (const k of cargoKeys(s.cargo)) add(k, qty(s.cargo, k));
    for (const j of Object.values(st.logisticsJobs ?? {})) if (j.owner === p) add(j.item, j.reserved);
    // materials a construction plan has secured stay the company's until the build consumes them
    for (const s of Object.values(st.stations)) if (s.owner === p) for (const m of s.modules) for (const [k, n] of Object.entries(m.reserved ?? {})) add(k, n);
    const reservedSites = Object.values(st.stations).filter(s => s.owner === p).flatMap(s => s.modules.map(m => JSON.stringify([m.id, m.reserved ?? {}, m.used ?? {}])));
    out[p] = { items, credits: st.companies[p].credits, ledger: JSON.stringify(st.companies[p].ops?.ledger ?? []), ships: Object.values(st.ships).filter(s => s.owner === p).map(s => [s.id, s.groupId, s.pos, s.state, s.task?.k]).sort(), reservedSites };
  }
  return out;
}
const before = census(copy.st);
const inFlightBefore = Object.values(copy.st.logisticsJobs ?? {}).filter(j => j.state !== 'complete' && j.state !== 'cancelled').map(j => ({ id: j.id, state: j.state, carried: j.carried, reserved: j.reserved, ship: j.ship }));
const routesBefore = Object.values(copy.st.logistics ?? {}).map(r => ({ id: r.id, mode: r.config.mode, repeat: r.config.repeat, manifests: Object.values(r.manifests).reduce((n, m) => n + m.amount, 0) }));
const r1 = enableAutoLogistics(copy);
const after = census(copy.st);
check(!r1.already && copy.st.logisticsV === 1, 'the copy is converted once (logisticsV = 1)', { routesBefore });
for (const p of players) {
  check(JSON.stringify(after[p].items) === JSON.stringify(before[p].items), `${p}: every unit of every item (stations, holds, reservations) is unchanged`, after[p].items);
  check(after[p].credits === before[p].credits && after[p].ledger === before[p].ledger, `${p}: credits and ledger unchanged`);
  check(JSON.stringify(after[p].ships) === JSON.stringify(before[p].ships), `${p}: hauler ownership, groups, positions and movement state unchanged`);
  check(JSON.stringify(after[p].reservedSites) === JSON.stringify(before[p].reservedSites), `${p}: construction reservations and consumption unchanged`);
}
for (const j of inFlightBefore) { const n = copy.st.logisticsJobs![j.id]; check(n && n.state === j.state && n.carried === j.carried && n.reserved === j.reserved && n.ship === j.ship, `existing shipment ${j.id} (${j.state}) kept exactly`, j); }
check(r1.manifestJobs.every(m => copy.st.logisticsJobs![m.job].carried === m.amount && copy.st.ships[m.ship].logisticsJob === m.job), 'route cargo aboard is now tracked by a shipment to the same destination', r1.manifestJobs);
check(r1.routesCompat.every(id => copy.st.logistics?.[id]?.compat), 'repeating sale / transfer loops are kept in compatibility mode, not turned into new loops', r1.routesCompat);
check(r1.routesConverted.every(id => !copy.st.logistics?.[id]), 'construction / supply / one-way routes are replaced by demand-based logistics', r1.routesConverted);
check(r1.haulGroups.every(h => copy.st.groups[h.group].op.k === 'idle' && h.ships.every(s => copy.st.ships[s].logisticsStow === h.to)), 'direct haul orders are released; their cargo is marked for its destination', r1.haulGroups);
const snap = copy.serialize(); const r2 = enableAutoLogistics(copy);
check(r2.already && copy.serialize() === snap, 'a second conversion changes nothing (idempotent)');
check(JSON.stringify(original) === originalText, 'the original save object is never modified');
// run on: everything converted is delivered, nothing is lost (a shipment the player paused stays paused, cargo aboard)
const lostBefore = Object.values(copy.st.logisticsJobs ?? {}).reduce((n, j) => n + j.lost, 0);
const flow: Record<string, Record<string, number>> = Object.fromEntries(players.map(p => [p, {}]));
const stop = observeWorld(copy.st, e => { if (!e.company || !flow[e.company] || !e.item) return; const f = flow[e.company]; if (e.kind === 'consume' || e.kind === 'market' && e.reason === 'sell') f[e.item] = (f[e.item] ?? 0) - e.amount; else if (e.kind === 'produce') f[e.item] = (f[e.item] ?? 0) + e.amount; });
const moving = () => Object.values(copy.st.logisticsJobs ?? {}).filter(j => j.state !== 'complete' && j.state !== 'cancelled' && j.state !== 'paused' && (j.carried > 0 || j.stow));
for (let i = 0; i < 4 * 3600 && moving().length; i++) copy.update(.25);
stop();
check(!moving().length, 'after conversion every tracked cargo reaches a station within an hour', moving().map(j => [j.item, j.state, j.reason]));
const paused = Object.values(copy.st.logisticsJobs ?? {}).filter(j => j.state === 'paused');
check(paused.every(j => j.carried > 0 && j.ship && qty(copy.st.ships[j.ship]?.cargo, j.item) >= j.carried), 'a shipment the player paused before conversion stays paused with its cargo aboard', paused.map(j => [j.id, j.carried]));
check(Object.values(copy.st.logisticsJobs ?? {}).reduce((n, j) => n + j.lost, 0) === lostBefore, 'no cargo was lost while the converted world ran');
const end = census(copy.st);
for (const p of players) for (const k of Object.keys(before[p].items)) { const want = before[p].items[k] + (flow[p][k] ?? 0); check(Math.abs((end[p].items[k] ?? 0) - want) < 1e-6, `${p}: ${k} after the run = before conversion + production − consumption − market sales`, { before: before[p].items[k], flow: flow[p][k] ?? 0, after: end[p].items[k] ?? 0 }); }
const failed = checks.filter(c => !c.ok).length;
mkdirSync('artifacts/p125', { recursive: true });
writeFileSync('artifacts/p125/convert-check.json', JSON.stringify({ source: file ?? 'generated legacy world (P12 world with every transport kind in flight)', passed: checks.length - failed, failed, checks, conversion: r1 }, null, 2));
console.log(JSON.stringify({ passed: checks.length - failed, failed }));
if (failed) process.exitCode = 1;
