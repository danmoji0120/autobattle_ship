// P13.1 long run: a normal P13.1 world (NPC factions, pirates, lairs — nothing removed) for several game hours.
// Wrecks come only from real P11 engagements. A salvage company runs three groups (hauler + miner + constructor):
// whenever a group stands idle it is sent (recover order) to the wreck with the most legal value per km
// (dispatch from every wreck in the world — an attentive player following battle reports; an upper bound),
// and recovered goods are sold where it unloads. Measures wreck creation per hour, duplicates, accounting
// (initial = taken + left + removed remainder + decayed), earnings vs upkeep, and save/restore.
//   npx vite-node scripts/salvage/p131-longrun.ts [hours] [seed]
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { observeWorld } from '../../src/world/observe';
import { wreckUnits, lotValue, type WreckSite } from '../../src/world/wrecks';
import { protectedLot } from '../../src/world/salvage';
import { sysAt } from '../../src/world/geom';

import { assetReferenceValue, hullPrice } from '../../src/world/valuation';

const [hours = 6, seed = 1313] = process.argv.slice(2).map(Number).filter(n => n > 0);
// 'safe': only wrecks in systems with security >= 50 (a cautious salvage company); 'any': every wreck
const MODE = process.argv.includes('safe') ? 'safe' : 'any';
// 'escort': each salvage group also carries two destroyers (same dispatch rule) — what an escort changes
const ESCORT = process.argv.includes('escort');
const sim = WorldSim.create(seed, { salvage: 'p131' });
const S = sim.addPlayer('인양 산업'); const co = sim.st.companies[S]; co.credits = 300000;
// clean start like scripts/econ/companies.ts: the starter ships are removed so upkeep is only the salvage fleet
for (const s of Object.values(sim.st.ships)) if (s.owner === S) delete sim.st.ships[s.id];
for (const g of Object.values(sim.st.groups)) if (g.owner === S) delete sim.st.groups[g.id];
const a = sim.st.stations.astra;
const gs = [0, 1, 2].map(i => { const g = sim.newGroup(S, `인양${i}`); g.commanderId = sim.newCommander(S, 2).id; for (const cl of ['hauler', 'miner', 'constructor', ...(ESCORT ? ['destroyer', 'destroyer'] : [])]) { const s = sim.spawnShip(S, cl, 'std', g.id, a.pos); (sim as any).dockShip(s, a); } return g; });
const mine = new Set(gs.map(g => g.id));
const fleetValue = Object.values(sim.st.ships).filter(s => mine.has(s.groupId)).reduce((n, s) => n + hullPrice(s.hull ?? `${s.classId}_mk1`, s.variant).price, 0);
const flow: Record<string, number> = {};
const stop = observeWorld(sim.st, e => { if (!e.item) return; const k = `${e.kind}/${e.reason}`; flow[k] = (flow[k] ?? 0) + e.amount; });
const refs = new Map<string, WreckSite>();
let sales = 0, sellErrors = 0, dispatched = 0, refused: Record<string, number> = {};
const perHour: { hour: number; wrecks: number; created: number; ships: number; sTakenValue: number; credits: number; tickMs: number }[] = [];
const credits0 = co.credits;
let tickMs = 0, err: unknown = null;
// every salvage ship lost: where (system, security), when, and who was on the other side of the engagement
const losses: { t: number; ship: string; cls: string; system: string; security: number; opponents: string[]; engagement: string | null }[] = [];
let alive = new Map(Object.values(sim.st.ships).filter(s => s.owner === S).map(s => [s.id, { cls: s.classId, system: sysAt(sim.st.systems, s.pos)?.id ?? '?', pos: { ...s.pos } }]));
const legalValue = (w: WreckSite) => w.lots.filter(l => !protectedLot(sim, S, l)).reduce((n, l) => n + l.n * lotValue(sim.st, l), 0);
try {
  for (let t = 1; t <= hours * 3600; t++) {
    const s0 = performance.now(); sim.update(1); tickMs += performance.now() - s0;
    for (const w of Object.values(sim.st.wrecks ?? {})) refs.set(w.id, w);
    const now = new Map(Object.values(sim.st.ships).filter(s => s.owner === S).map(s => [s.id, { cls: s.classId, system: sysAt(sim.st.systems, s.pos)?.id ?? '?', pos: { ...s.pos } }]));
    for (const [id, v] of alive) if (!now.has(id)) {
      const e = Object.values(sim.st.engagements).filter(x => x.sides.some(sd => sd.includes(S))).sort((x, y) => (y.start ?? 0) - (x.start ?? 0))[0];
      const opp = e ? [...new Set(e.sides.filter(sd => !sd.includes(S)).flat().map(c => sim.st.companies[c]?.kind ?? c))] : [];
      losses.push({ t, ship: id, cls: v.cls, system: v.system, security: sim.st.systems[v.system]?.security ?? -1, opponents: opp, engagement: e?.id ?? null });
    }
    alive = now;
    if (t % 60 === 0) for (const g of gs) {
      if (!sim.st.groups[g.id] || !['idle', 'dock'].includes(g.op.k) || g.salv) continue;
      const ships = Object.values(sim.st.ships).filter(s => s.groupId === g.id);
      if (!ships.length) continue;
      const from = ships[0].pos;
      const best = Object.values(sim.st.wrecks ?? {}).filter(w => MODE === 'any' || (sim.st.systems[w.system]?.security ?? 0) >= 50).map(w => ({ w, v: legalValue(w) / (1 + sim.routeDistance(from, w.pos) / 1000) })).filter(x => x.v > 0).sort((x, y) => y.v - x.v)[0];
      if (!best) continue;
      const e = sim.command(S, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: best.w.id } } as any);
      if (e) refused[e.slice(0, 40)] = (refused[e.slice(0, 40)] ?? 0) + 1; else dispatched++;
    }
    if (t % 600 === 0) for (const st of Object.values(sim.st.stations)) {
      if (!st.market) continue;
      for (const [k, n] of Object.entries(st.storage[S] ?? {})) {
        if (n < 1) continue;
        const c0 = co.credits; const e = sim.command(S, { c: 'sell', station: st.id, res: k, amount: Math.floor(n) } as any);
        if (e) sellErrors++; else sales += co.credits - c0;
      }
    }
    if (t % 3600 === 0) {
      const all = [...refs.values()];
      perHour.push({ hour: t / 3600, wrecks: Object.keys(sim.st.wrecks ?? {}).length, created: all.length, ships: all.reduce((n, w) => n + w.sources.length, 0),
        sTakenValue: Math.round(all.reduce((n, w) => n + Object.entries(w.taken[S] ?? {}).reduce((x, [k, v]) => x + v * lotValue(sim.st, { item: k }), 0), 0)), credits: Math.round(co.credits), tickMs: +(tickMs / 3600).toFixed(2) });
      console.log(JSON.stringify(perHour.at(-1))); tickMs = 0;
    }
  }
} catch (e) { err = e; console.error(e); }
stop();
const all = [...refs.values()];
const ids = all.flatMap(w => w.sources.map(s => s.ship));
const initial = all.reduce((n, w) => n + w.initial, 0);
const left = all.filter(w => sim.st.wrecks?.[w.id]).reduce((n, w) => n + wreckUnits(w), 0);
const removedLeft = all.filter(w => !sim.st.wrecks?.[w.id]).reduce((n, w) => n + wreckUnits(w), 0);
const taken = all.reduce((n, w) => n + Object.values(w.taken).reduce((a2, m) => a2 + Object.values(m).reduce((x, y) => x + y, 0), 0), 0);
const decayed = Object.entries(flow).filter(([k]) => k.startsWith('consume/wreck_decay')).reduce((n, [, v]) => n + v, 0);
const takenBy: Record<string, number> = {};
for (const w of all) for (const [c, m] of Object.entries(w.taken)) takenBy[sim.st.companies[c]?.kind ?? c] = (takenBy[sim.st.companies[c]?.kind ?? c] ?? 0) + Object.values(m).reduce((x, y) => x + y, 0);
const bySourceKind: Record<string, number> = {};
for (const w of all) for (const s of w.sources) { const k = s.owner === S ? 'salvager' : sim.st.companies[s.owner]?.kind ?? s.owner; bySourceKind[k] = (bySourceKind[k] ?? 0) + 1; }
const stored = Object.values(sim.st.stations).reduce((n, st) => n + Object.entries(st.storage[S] ?? {}).reduce((x, [k, v]) => x + v * assetReferenceValue(sim.st, k), 0), 0);
const aboard = Object.values(sim.st.ships).filter(s => s.owner === S).reduce((n, s) => n + Object.entries(s.salvaged ?? {}).reduce((x, [k, v]) => x + v * assetReferenceValue(sim.st, k), 0), 0);
const sTaken = all.reduce((n, w) => n + Object.entries(w.taken[S] ?? {}).reduce((x, [k, v]) => x + v * lotValue(sim.st, { item: k }), 0), 0);
const salvShipsLeft = Object.values(sim.st.ships).filter(s => mine.has(s.groupId)).length;
const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
const out = {
  hours, seed, mode: MODE, escort: ESCORT, losses, error: err ? String(err) : null, noDerelictSites: !sim.st.sites,
  wrecksCreated: all.length, shipsInWrecks: ids.length, duplicateSources: ids.length - new Set(ids).size, sourcesByOwnerKind: bySourceKind,
  accounting: { initialUnits: +initial.toFixed(3), taken: +taken.toFixed(3), left: +left.toFixed(3), removedRemainder: +removedLeft.toFixed(3), decayed, error: +(initial - taken - left - removedLeft).toFixed(6), decayFlowEqualsRemovedRemainder: Math.abs(decayed - removedLeft) < 1e-6 },
  takenByCompanyKind: takenBy,
  salvager: { groups: 3, ships: ESCORT ? 15 : 9, shipsLeft: salvShipsLeft, fleetReferenceValue: Math.round(fleetValue), dispatched, refused, takenReferenceValue: Math.round(sTaken), sales: Math.round(sales), sellErrors,
    creditsChange: Math.round(co.credits - credits0), upkeepAndOtherCosts: Math.round(co.credits - credits0 - sales), storedValue: Math.round(stored), aboardValue: Math.round(aboard),
    netOperating: Math.round(co.credits - credits0 + stored + aboard) },
  saveRestoreEqual: JSON.stringify(restored.st.wrecks) === JSON.stringify(sim.st.wrecks),
  perHour,
};
console.log(JSON.stringify(out));
mkdirSync('docs/salvage-results', { recursive: true });
writeFileSync(`docs/salvage-results/p131-longrun-${hours}h-s${seed}-${MODE}${ESCORT ? '-escort' : ''}.json`, JSON.stringify(out, null, 2));
