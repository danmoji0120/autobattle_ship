// Server-authoritative demand planning; all movement is executed by the existing logistics pool.
import type { WorldSim } from './sim';
import { poolMember, HAULER_MIN_HP } from './haulers';
import type { Cargo, Company, Station, WShip } from './types';
import { qty, cargoSum } from './types';
import { missing, planMats, prereqBuilt } from './construction';
import { buildNeeds, builtCount, facLines, orderWants, recipeOk, yardSlots, buildSpec } from './production';
import { ITEMS, EQUIPMENT, recipeFor } from './industry';
import { moduleMaterials } from './stations';
import { growthOn, econOf, berthFits } from './hullops';
import { takesSpace } from './storage';
import { dist } from './geom';
import { effSec } from './security';
import { usableRouteGate, incomingRoutes } from './logistics';
import { createPoolJob, controlPoolJob, assignMinerTrip, type LogisticsJob } from './autonomousLogistics';
import { procurementAuthority, sellableStock, companySaleCap } from './operations';
import { techFx } from './industry';
import { priceOf, tradeChunk, buyCost } from './market';
import { shipRate } from './upkeep';
import { takec } from './types';
import { projectCost, missingPre, fieldsAt, salvageItem } from './research';
import { TECHS } from './industry';
import { compareSale, SALE_STRATEGIES, type SaleStrategy } from './saleSearch';

export type ProcurementKind = 'construction' | 'production' | 'ship' | 'research';
/** the source record a plan feeds (an unbuilt module, a production order, an unstarted build, an unstarted research
 *  project), or undefined once it is gone / started. P17.4a: research projects join the planner (AUD-05). */
export function procurementOrigin(w: { companies: Record<string, Company>; stations: Record<string, Station> }, owner: string, station: string, kind: ProcurementKind, source: string): { paused?: boolean } | undefined {
  const st = w.stations[station];
  return kind === 'construction' ? st?.modules.find(m => m.id === source && !m.built) : kind === 'production' ? st?.orders?.find(o => o.id === source) : kind === 'ship' ? st?.builds?.find(b => b.id === source && !b.started) : w.companies[owner]?.research?.find(r => r.id === source && r.station === station && !r.started);
}
export interface ProcurementPolicy {
  enabled: boolean; autoBuy: boolean; budget: number; spent: number; minCredits: number; maxRisk: number;
  maxPrice: Record<string, number>; protectedStock: Record<string, Cargo>;
  disabled: Record<string, boolean>; priority: Record<string, number>;
  /** AUTO-P0: items whose excess stock (above every hold) is sold automatically, never below `minPrice` a unit */
  sales?: Record<string, SalesRule>;
  /** AUTO-P0: last planning result per sold item (shown to the player; recomputed every pass) */
  salesStatus?: Record<string, SalesStatus>;
  /** AUTO-P1: a mining fleet's own hauler may fly sale round trips of its station's excess stock. AUTO-P1.1: allowed
   *  unless the player turned it off (`false`, "채굴 운반 전용"); unset — every company that never chose — means allowed. */
  minerSales?: boolean;
  /** AUTO-P1.1: per item, after a sale trip came back unsold: no new trip before `at`; `fails` grows the wait */
  minerTripRetry?: Record<string, { at: number; fails: number }>;
  /** AUTO-P1: last decision of the mining hauler sale planner (shown to the player) */
  minerTrip?: { t: number; ship: string; reason: string };
  /** A-3.2b.2: per item, when the salvage hauler last left with a part load (no other part load for SALV_PARTIAL_GAP) */
  salvPartialAt?: Record<string, number>;
  /** AUTO-P1: automatic repair of automated haulers that fell out of dispatch (off by default) */
  repair?: import('./autoRepair').RepairPolicy;
}
/** P17.4b AUD-06: `strategy` orders the markets tried (unset = 'local', the original behaviour) */
export interface SalesRule { minPrice: number; strategy?: SaleStrategy }
export interface SalesStatus { t: number; excess: number; moving: number; reason: string; sold: number; earned: number; since?: Record<string, number> }
export interface ProcurementPlan {
  id: string; owner: string; station: string; sourceKind: ProcurementKind; sourceId: string; item: string;
  required: number; used: number; secured: number; local: number; otherIncoming: number;
  reserved: number; inTransit: number; planned: number; shortage: number;
  priority: number; created: number; reviewed: number; spent: number;
  state: 'waiting' | 'moving' | 'ready' | 'paused' | 'closed'; reason: string;
}
export interface ProcurementSettings {
  enabled: boolean; autoBuy: boolean; budget: number; minCredits: number; maxRisk: number;
  priceItem?: string; maxUnitPrice?: number; protectStation?: string; protectItem?: string; protectAmount?: number;
}
export const sourceKey = (station: string, kind: ProcurementKind, source: string) => JSON.stringify([station, kind, source]);
export const defaultProcurementPolicy = (): ProcurementPolicy => ({ enabled: true, autoBuy: false, budget: 0, spent: 0, minCredits: 0, maxRisk: 100, maxPrice: {}, protectedStock: {}, disabled: {}, priority: {} });
const EPS = 1e-8;
const live = (j: LogisticsJob) => j.state !== 'complete' && j.state !== 'cancelled';
const outstanding = (j: LogisticsJob) => Math.max(0, j.amount - j.cycleDelivered);
const safeItem = (item: unknown): item is string => typeof item === 'string' && (Object.hasOwn(ITEMS, item) || Object.hasOwn(EQUIPMENT, item) || item.startsWith('bp:') || item.startsWith('bpf:'));
const finiteMoney = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12;

export function setProcurementPolicy(h: WorldSim, owner: string, s: ProcurementSettings): string | null {
  const co = h.st.companies[owner];
  if (!growthOn(h.st) || !co || !s || typeof s.enabled !== 'boolean' || typeof s.autoBuy !== 'boolean' || !finiteMoney(s.budget) || !finiteMoney(s.minCredits) || !finiteMoney(s.maxRisk) || s.maxRisk > 100) return '조달 설정과 예산을 확인하세요';
  if ((s.priceItem !== undefined || s.maxUnitPrice !== undefined) && (!safeItem(s.priceItem) || !finiteMoney(s.maxUnitPrice))) return '품목별 최대 단가를 확인하세요';
  if ((s.protectStation !== undefined || s.protectItem !== undefined || s.protectAmount !== undefined) && (typeof s.protectStation !== 'string' || !Object.hasOwn(h.st.stations, s.protectStation) || !(h.canDock(h.st.stations[s.protectStation], owner) || Object.hasOwn(h.st.stations[s.protectStation].storage, owner)) || !safeItem(s.protectItem) || !finiteMoney(s.protectAmount))) return '보호할 자사 보관함과 재고 수량을 확인하세요';
  const policy = co.procurement ??= defaultProcurementPolicy();
  policy.enabled = s.enabled; policy.autoBuy = s.autoBuy; policy.budget = s.budget; policy.minCredits = s.minCredits; policy.maxRisk = s.maxRisk;
  if (s.priceItem !== undefined) { if (s.maxUnitPrice! > 0) policy.maxPrice[s.priceItem] = s.maxUnitPrice!; else delete policy.maxPrice[s.priceItem]; }
  if (s.protectStation !== undefined && s.protectItem !== undefined) {
    const stocks = policy.protectedStock[s.protectStation] ??= {};
    if (s.protectAmount! > 0) stocks[s.protectItem] = s.protectAmount!; else delete stocks[s.protectItem];
  }
  return null;
}
export function setProcurementSource(h: WorldSim, owner: string, station: string, kind: ProcurementKind, source: string, enabled: boolean, priority?: number): string | null {
  const st = h.st.stations[station], co = h.st.companies[owner];
  if (!growthOn(h.st) || !co || !st || st.owner !== owner || !['construction', 'production', 'ship'].includes(kind) || typeof source !== 'string' || typeof enabled !== 'boolean' || (priority !== undefined && (!Number.isSafeInteger(priority) || priority < 0 || priority > 9))) return '자사 작업과 조달 설정을 확인하세요';
  const exists = kind === 'construction' ? st.modules.some(m => m.id === source && !m.built) : kind === 'production' ? (st.orders ?? []).some(o => o.id === source) : (st.builds ?? []).some(b => b.id === source);
  if (!exists) return '원본 건설·생산·조선 작업이 없습니다';
  const policy = co.procurement ??= defaultProcurementPolicy(), key = sourceKey(station, kind, source);
  if (enabled) delete policy.disabled[key]; else policy.disabled[key] = true;
  if (priority !== undefined) policy.priority[key] = priority;
  if (priority !== undefined) for (const p of Object.values(h.st.procurementPlans ?? {})) if (p.owner === owner && p.station === station && p.sourceKind === kind && p.sourceId === source) for (const j of Object.values(h.st.logisticsJobs ?? {})) if (j.procurement === p.id && live(j) && !j.ship) j.priority = priority;
  return null;
}
/** Stop obsolete work synchronously without initiating purchases inside the player's transaction. */
export function stopProcurement(h: WorldSim, owner: string, reason: 'paused' | 'closed', station?: string, kind?: ProcurementKind, source?: string) {
  for (const p of Object.values(h.st.procurementPlans ?? {})) {
    if (p.owner !== owner || (station !== undefined && p.station !== station) || (kind !== undefined && p.sourceKind !== kind) || (source !== undefined && p.sourceId !== source)) continue;
    for (const j of Object.values(h.st.logisticsJobs ?? {})) if (j.procurement === p.id && live(j)) {
      if (reason === 'paused' && j.state === 'paused') continue; // Do not resume a separately paused shipment.
      if (reason === 'paused' && j.carried > EPS && j.ship) { if (!controlPoolJob(h, owner, j.id, 'pause')) j.procurementSuspended = true; }
      else controlPoolJob(h, owner, j.id, 'cancel');
    }
    const stranded = Object.values(h.st.logisticsJobs ?? {}).some(j => j.procurement === p.id && j.reserved > EPS && !h.st.stations[j.from]);
    p.state = reason; p.reason = stranded ? '출발지 소실 — 예약 자산은 원래 위치에 보존되며 정거장 복구 전 반환할 수 없습니다' : reason === 'paused' ? '자동 조달 정지 — 미적재 예약 반환, 적재된 운송은 재개 대기' : '원본 수요 종료 — 예약 반환, 적재 화물은 함선에 보존'; p.reviewed = h.time;
  }
}
interface Demand { owner: string; station: Station; kind: ProcurementKind; source: string; item: string; required: number; used: number; secured: number; need: number; priority: number; order: number }
function demandList(h: WorldSim, co: Company): Demand[] {
  const out: Demand[] = [], policy = co.procurement; let order = 0;
  const push = (st: Station, kind: ProcurementKind, id: string, item: string, required: number, used = 0, secured = 0) => {
    const key = sourceKey(st.id, kind, id); if (policy?.disabled[key] || required <= EPS) return;
    out.push({ owner: co.id, station: st, kind, source: id, item, required, used, secured, need: Math.max(0, required - used - secured), priority: policy?.priority[key] ?? (kind === 'production' ? 5 : 7), order: order++ });
  };
  for (const st of Object.values(h.st.stations).filter(s => s.owner === co.id).sort((a, b) => a.id.localeCompare(b.id))) stationDemand(h, co, st, push);
  return out.sort((a, b) => b.priority - a.priority || a.order - b.order || a.station.id.localeCompare(b.station.id) || a.item.localeCompare(b.item));
}
/** what construction, ship builds and production orders at one own station still need (by `push`) */
function stationDemand(h: Pick<WorldSim, 'st'>, co: Company, st: Station, push: (st: Station, kind: ProcurementKind, id: string, item: string, required: number, used?: number, secured?: number) => void) {
  {
    for (const m of st.modules) if (!m.built && !m.paused && m.id && prereqBuilt(st, m)) for (const item of planMats(m)) push(st, 'construction', m.id, item, moduleMaterials(m)[item] ?? 0, m.used?.[item] ?? 0, m.reserved?.[item] ?? 0);
    for (const b of st.builds ?? []) if (!b.started && !b.paused) {
      const spec = buildSpec(b);
      if ((spec.tech ?? []).some(t => !co.tech?.includes(t)) || (spec.facilities ?? []).some(f => !builtCount(st, f)) || !yardSlots(st).some(y => y.size >= spec.yard)) continue;
      for (const [item, amount] of Object.entries(buildNeeds(b.classId, b.loadoutId, b.fit, b))) push(st, 'ship', b.id, item, amount);
    }
    for (const o of st.orders ?? []) {
      const r = recipeFor(h.st, o.recipe); if (o.paused || !r || !recipeOk(r, co) || !facLines(st, r.fac) || orderWants(o, st.storage[co.id] ?? {}, st.jobs ?? [], h.st)) continue;
      // At most one not-yet-started batch per order; already started batches consumed their inputs.
      for (const [item, amount] of Object.entries(r.in)) push(st, 'production', o.id, item, amount);
    }
    // P17.4a (AUD-05): unstarted research projects whose prerequisites are known and whose field has a lab here.
    // The captured item a salvage analysis consumes is never procured (it is not a trade good).
    for (const r of co.research ?? []) {
      if (r.station !== st.id || r.started || r.paused) continue;
      const t = TECHS[r.tech]; if (!t || r.source !== 'copy' && missingPre(co, r.tech).length || !fieldsAt(st).has(t.field)) continue;
      const own = r.source === 'salvage' ? salvageItem(r.tech) : undefined;
      for (const [item, amount] of Object.entries(projectCost(r))) if (item !== own && !item.startsWith('bp:')) push(st, 'research', r.id, item, amount);
    }
  }
}
/** AUTO-P0: units of `item` at an own station still needed by its construction, ship builds and production
 *  (the same demand the procurement planner fills) — never sold or counted as excess */
export function industryHold(h: Pick<WorldSim, 'st'>, owner: string, station: Station, item: string): number {
  const co = h.st.companies[owner];
  if (!co || station.owner !== owner) return 0;
  let n = 0;
  stationDemand(h, co, station, (_st, kind, id, it, required, used = 0, secured = 0) => {
    if (it !== item || co.procurement?.disabled[sourceKey(station.id, kind, id)] || required <= EPS) return;
    n += Math.max(0, required - used - secured);
  });
  return n;
}
/** Only ordinary stations are considered: sites, deposits and other hidden exploration data are never searched. */
export function routeScore(h: Pick<WorldSim, 'st' | 'sysOf'>, a: Station, b: Station, maxRisk: number): number {
  return routeInfo(h, a, b, maxRisk)?.score ?? Infinity;
}
/** P17.4b: the route behind `routeScore` — fewest jumps (gate order breaks ties), the summed risk of the systems it
 *  enters (start system included) and the same score; null when no route stays within `maxRisk` */
export function routeInfo(h: Pick<WorldSim, 'st' | 'sysOf'>, a: Station, b: Station, maxRisk: number): { score: number; hops: number; risk: number } | null {
  const start = h.sysOf(a.pos), end = h.sysOf(b.pos); if (!start || !end || 100 - effSec(start) > maxRisk || 100 - effSec(end) > maxRisk) return null;
  if (start.id === end.id) return { score: dist(a.pos, b.pos), hops: 0, risk: 100 - effSec(start) };
  const queue = [{ id: start.id, hops: 0, risk: 0 }], seen = new Set([start.id]);
  while (queue.length) {
    const node = queue.shift()!;
    for (const gate of [...(h.st.systems[node.id]?.gates ?? [])].sort((x, y) => x.id.localeCompare(y.id))) {
      const next = h.st.systems[gate.to]; if (!next || seen.has(next.id) || !usableRouteGate(h.st, gate)) continue;
      const risk = 100 - effSec(next); if (risk > maxRisk) continue;
      const hops = node.hops + 1, sumRisk = node.risk + risk;
      if (next.id === end.id) return { score: hops * 200000 + sumRisk * 1000 + dist(a.pos, start.origin) + dist(b.pos, end.origin), hops, risk: sumRisk + 100 - effSec(start) };
      seen.add(next.id); queue.push({ id: next.id, hops, risk: sumRisk });
    }
  }
  return null;
}
function poolShips(h: WorldSim, owner: string): WShip[] {
  return Object.values(h.st.ships).filter(s => {
    const g = h.st.groups[s.groupId]; return s.owner === owner && poolMember(h.st, s) && !!g && h.opOf(g).k === 'idle' && s.state !== 'battle' && s.state !== 'building' && !s.reserve && !s.listed && econOf(s).cargo > 0 && !econOf(s).military && s.classId !== 'miner' && s.classId !== 'constructor';
  });
}
export function canCarry(ships: WShip[], a: Station, b: Station, construction: boolean, external = false) { return ships.some(s => (external || berthFits(a, econOf(s).berth)) && (construction || berthFits(b, econOf(s).berth))); }
function freeAt(co: Company, station: Station, item: string, claims: Map<string, number>) {
  const key = JSON.stringify([co.id, station.id, item]);
  return Math.max(0, qty(station.storage[co.id], item) - (co.procurement?.protectedStock[station.id]?.[item] ?? 0) - (claims.get(key) ?? 0));
}
function claim(claims: Map<string, number>, owner: string, station: string, item: string, amount: number) {
  const key = JSON.stringify([owner, station, item]); claims.set(key, (claims.get(key) ?? 0) + amount);
}
function createJob(h: WorldSim, plan: ProcurementPlan, source: Station, amount: number): boolean {
  // A production order does not itself require a logistics centre. Use an ordinary
  // transfer when the optional supply-mode facility is absent; both paths use the pool.
  const dest = h.st.stations[plan.station];
  const supply = [source, dest].some(st => st?.owner === plan.owner && st.modules.some(m => m.kind === 'logistics' && m.built));
  const kind = plan.sourceKind === 'construction' ? 'construction' : plan.sourceKind === 'production' && supply ? 'supply' : 'transfer';
  const error = createPoolJob(h, plan.owner, { from: source.id, to: plan.station, item: plan.item, kind, amount, priority: plan.priority, repeat: false }, plan.id);
  if (error) { plan.reason = error; return false; }
  return true;
}
/** One pass is atomic with respect to commands, market transactions, and the strategic tick. */
export function planProcurement(h: WorldSim) {
  if (!growthOn(h.st)) return;
  const companies = Object.values(h.st.companies).filter(co => co.kind === 'player');
  const allJobs = Object.values(h.st.logisticsJobs ?? {}), shipsByOwner = new Map(companies.map(co => [co.id, poolShips(h, co.id)]));
  // No implicit work or save fields for untouched old companies without opt-in transport.
  const activeCompanies = companies.filter(co => shipsByOwner.get(co.id)!.length || !!co.procurement || Object.values(h.st.procurementPlans ?? {}).some(p => p.owner === co.id && p.state !== 'closed'));
  if (!activeCompanies.length) return;
  const plans = h.st.procurementPlans ??= {}, byKey = new Map<string, ProcurementPlan>();
  for (const p of Object.values(plans)) byKey.set(JSON.stringify([p.owner, p.station, p.sourceKind, p.sourceId, p.item]), p);
  const demand: Demand[] = [];
  for (const co of activeCompanies) if (co.procurement?.enabled !== false) demand.push(...demandList(h, co));
  const ageRank = (d: Demand) => { const p = byKey.get(JSON.stringify([d.owner, d.station.id, d.kind, d.source, d.item])); return Math.min(9, d.priority + (p && p.state !== 'closed' ? Math.floor((h.time - p.created) / 300) : 0)); };
  demand.sort((a, b) => ageRank(b) - ageRank(a) || a.order - b.order || a.station.id.localeCompare(b.station.id) || a.item.localeCompare(b.item));
  const activeKeys = new Set(demand.map(d => JSON.stringify([d.owner, d.station.id, d.kind, d.source, d.item])));
  for (const p of Object.values(plans)) if (!activeKeys.has(JSON.stringify([p.owner, p.station, p.sourceKind, p.sourceId, p.item])) && p.state !== 'closed') {
    const co = h.st.companies[p.owner], st = h.st.stations[p.station];
    const origin = procurementOrigin(h.st, p.owner, p.station, p.sourceKind, p.sourceId);
    const suspended = !!origin && (co?.procurement?.enabled === false || !!co?.procurement?.disabled[sourceKey(p.station, p.sourceKind, p.sourceId)] || !!origin.paused);
    if (!suspended) for (const j of allJobs) if (j.procurement === p.id && live(j)) controlPoolJob(h, p.owner, j.id, 'cancel');
    p.state = suspended ? 'paused' : 'closed';
    const stranded = allJobs.some(j => j.procurement === p.id && j.reserved > EPS && !h.st.stations[j.from]);
    p.reason = stranded ? '출발지 소실 — 예약 자산은 원래 위치에 보존되며 정거장 복구 전 반환할 수 없습니다' : p.state === 'paused' ? '자동 조달 정지 — 미적재 예약 반환, 적재된 운송은 재개 대기' : '원본 수요 종료 — 예약 반환, 적재 화물은 함선에 보존'; p.reviewed = h.time;
  }
  // Preserve manual claims first. Re-evaluate unassigned automatic requests when free stock or paths change.
  const claims = new Map<string, number>();
  const recheck = allJobs.filter(j => !!j.procurement && live(j) && !j.ship && j.state !== 'paused' && j.reserved <= EPS && j.carried <= EPS);
  const recheckIds = new Set(recheck.map(j => j.id));
  for (const j of allJobs) if (live(j) && !recheckIds.has(j.id)) claim(claims, j.owner, j.from, j.item, Math.max(0, outstanding(j) - j.reserved - j.carried));
  recheck.sort((a, b) => b.priority - a.priority || a.created - b.created || a.id.localeCompare(b.id));
  for (const j of recheck) {
    const co = h.st.companies[j.owner], from = h.st.stations[j.from], to = h.st.stations[j.to];
    const access = !!co && !!from && (h.canDock(from, j.owner) || !from.public && from.owner !== j.owner && qty(from.storage[j.owner], j.item) > EPS);
    const free = co && from && to && access && Number.isFinite(routeScore(h, from, to, co.procurement?.maxRisk ?? 100)) ? freeAt(co, from, j.item, claims) : 0;
    const available = j.kind === 'construction' ? free : Math.floor(free + EPS);
    const n = Math.min(outstanding(j), available);
    if (n <= EPS || j.kind !== 'construction' && n < 1) { controlPoolJob(h, j.owner, j.id, 'cancel'); continue; }
    if (n < outstanding(j)) j.amount = j.cycleDelivered + n;
    claim(claims, j.owner, j.from, j.item, n);
  }
  const local = new Map<string, number>(), manualIncoming = new Map<string, number>(), destRoom = new Map<string, number>();
  const adjustClaim = (owner: string, station: string, item: string, amount: number) => {
    claim(claims, owner, station, item, amount);
    const key = JSON.stringify([owner, station, item]);
    if (local.has(key)) local.set(key, Math.max(0, (local.get(key) ?? 0) - amount));
  };
  for (const d of demand) {
    const key = JSON.stringify([d.owner, d.station.id, d.item]);
    // A pending outbound request has a prior virtual claim on this same free store.
    // Do not also count those units as available to a local production/build goal.
    if (!local.has(key)) local.set(key, Math.max(0, qty(d.station.storage[d.owner], d.item) - (claims.get(key) ?? 0)));
    if (!manualIncoming.has(key)) {
      const pool = allJobs.filter(j => !j.procurement && live(j) && j.owner === d.owner && j.to === d.station.id && j.item === d.item && j.kind !== 'sell').reduce((n, j) => n + j.reserved + j.carried, 0);
      manualIncoming.set(key, pool + incomingRoutes(h, d.owner, d.station.id, d.item));
    }
    if (!destRoom.has(d.station.id)) {
      const incoming = allJobs.filter(j => live(j) && j.owner === d.owner && j.to === d.station.id && j.kind !== 'sell' && takesSpace(j.item)).reduce((n, j) => n + (j.procurement ? outstanding(j) : j.reserved + j.carried), 0);
      destRoom.set(d.station.id, Math.max(0, h.room(d.station, d.owner) - incoming));
    }
  }
  for (const d of demand) {
    const co = h.st.companies[d.owner], policy = co.procurement ?? defaultProcurementPolicy(), ships = shipsByOwner.get(d.owner)!;
    const key = JSON.stringify([d.owner, d.station.id, d.kind, d.source, d.item]);
    let p = byKey.get(key);
    if (!p) { p = { id: h.id('pr'), owner: d.owner, station: d.station.id, sourceKind: d.kind, sourceId: d.source, item: d.item, required: 0, used: 0, secured: 0, local: 0, otherIncoming: 0, reserved: 0, inTransit: 0, planned: 0, shortage: 0, priority: d.priority, created: h.time, reviewed: h.time, spent: 0, state: 'waiting', reason: '' }; plans[p.id] = p; byKey.set(key, p); }
    if (p.state === 'closed') p.created = h.time;
    const inventoryKey = JSON.stringify([d.owner, d.station.id, d.item]);
    const localAmount = Math.min(d.need, local.get(inventoryKey) ?? 0); local.set(inventoryKey, (local.get(inventoryKey) ?? 0) - localAmount);
    claim(claims, d.owner, d.station.id, d.item, localAmount);
    const other = Math.min(d.need - localAmount, manualIncoming.get(inventoryKey) ?? 0); manualIncoming.set(inventoryKey, (manualIncoming.get(inventoryKey) ?? 0) - other);
    const children = allJobs.filter(j => j.procurement === p!.id && live(j));
    for (const j of children) if (j.procurementSuspended && j.state === 'paused' && !controlPoolJob(h, d.owner, j.id, 'resume')) delete j.procurementSuspended;
    let remaining = Math.max(0, d.need - localAmount - other);
    // Keep in-flight and reserved work before unstarted requests, cancelling no-longer-needed excess.
    children.sort((a, b) => Number(b.carried > 0 || b.reserved > 0) - Number(a.carried > 0 || a.reserved > 0) || a.created - b.created || a.id.localeCompare(b.id));
    let covered = 0;
    for (const j of children) {
      const original = outstanding(j), sourceClaim = Math.max(0, original - j.reserved - j.carried);
      if (remaining <= EPS) {
        const beforeReserved = j.reserved; controlPoolJob(h, d.owner, j.id, 'cancel'); adjustClaim(j.owner, j.from, j.item, -sourceClaim);
        const sourceKey = JSON.stringify([j.owner, j.from, j.item]);
        if (local.has(sourceKey)) local.set(sourceKey, (local.get(sourceKey) ?? 0) + beforeReserved - j.reserved);
        if (takesSpace(j.item)) destRoom.set(d.station.id, (destRoom.get(d.station.id) ?? 0) + original);
        continue;
      }
      if (original > remaining + EPS) {
        const newAmount = Math.min(j.amount, j.kind === 'construction' ? j.cycleDelivered + remaining : Math.ceil(j.cycleDelivered + remaining));
        const reduced = Math.max(0, j.amount - newAmount); j.amount = newAmount;
        adjustClaim(j.owner, j.from, j.item, -Math.min(sourceClaim, reduced));
        if (takesSpace(j.item)) destRoom.set(d.station.id, (destRoom.get(d.station.id) ?? 0) + reduced);
      }
      const n = outstanding(j); covered += n; remaining = Math.max(0, remaining - n);
    }
    p.required = d.required; p.used = d.used; p.secured = d.secured; p.local = localAmount; p.otherIncoming = other; p.priority = d.priority; p.reviewed = h.time; p.state = 'waiting'; p.reason = '';
    if (remaining > EPS && ships.length) {
      const candidates = Object.values(h.st.stations).filter(st => st.id !== d.station.id && (h.canDock(st, d.owner) || !st.public && st.owner !== d.owner && qty(st.storage[d.owner], d.item) > EPS) && freeAt(co, st, d.item, claims) > EPS && canCarry(ships, st, d.station, d.kind === 'construction', !h.canDock(st, d.owner)))
        .map(st => ({ st, score: routeScore(h, st, d.station, policy.maxRisk) })).filter(x => Number.isFinite(x.score)).sort((a, b) => a.score - b.score || a.st.id.localeCompare(b.st.id));
      const maxCargo = Math.max(...ships.map(s => econOf(s).cargo));
      for (const { st } of candidates) {
        while (remaining > EPS) {
          const available = freeAt(co, st, d.item, claims), room = destRoom.get(d.station.id) ?? 0;
          const amount = Math.min(remaining, available, maxCargo, takesSpace(d.item) ? room : Infinity);
          const transfer = d.kind === 'construction' ? amount : Math.floor(amount + EPS);
          if (transfer <= EPS || d.kind !== 'construction' && transfer < 1) break;
          if (!createJob(h, p, st, transfer)) break;
          const j = Object.values(h.st.logisticsJobs!).at(-1)!; allJobs.push(j); children.push(j); adjustClaim(d.owner, st.id, d.item, transfer);
          destRoom.set(d.station.id, Math.max(0, room - (takesSpace(d.item) ? transfer : 0))); remaining = Math.max(0, remaining - transfer); covered += transfer;
        }
      }
      // Purchasing authority: the company procurement policy, or an approved budget on the
      // originating work / goal (company operations). Neither exists by default.
      const legacy = policy.autoBuy && policy.maxPrice[d.item] > 0 && policy.spent < policy.budget;
      const ops = remaining > EPS && !legacy ? procurementAuthority(h, d.owner, d.station.id, d.kind, d.source, d.item) : undefined;
      if (remaining > EPS && (legacy || ops)) {
        const maxUnit = legacy ? policy.maxPrice[d.item] : ops!.maxPrice, budgetLeft = () => legacy ? policy.budget - policy.spent : ops!.left, floor = legacy ? policy.minCredits : ops!.minCredits;
        const markets = Object.values(h.st.stations).filter(st => st.id !== d.station.id && st.public && st.market?.[d.item] && h.canDock(st, d.owner) && canCarry(ships, st, d.station, d.kind === 'construction') && qty(st.storage[d.owner], d.item) >= (policy.protectedStock[st.id]?.[d.item] ?? 0))
          .map(st => ({ st, score: routeScore(h, st, d.station, policy.maxRisk), price: h.price(st, d.item, 'buy') })).filter(x => Number.isFinite(x.score) && x.price > 0 && x.price <= maxUnit).sort((a, b) => a.score - b.score || a.price - b.price || a.st.id.localeCompare(b.st.id));
        for (const { st, price } of markets) {
          if (remaining < 1 - EPS) break;
          const room = destRoom.get(d.station.id) ?? 0;
          let amount = Math.floor(Math.min(remaining, maxCargo, st.market![d.item].stock, h.room(st, d.owner), takesSpace(d.item) ? room : Infinity, budgetLeft() / price, (co.credits - floor) / price) + EPS);
          // a purchase walks the price up (market.buyCost): buy only what the budget and the credit floor really cover
          const spendable = Math.min(budgetLeft(), co.credits - floor);
          if (amount >= 1 && buyCost(st.market![d.item], amount, true) > spendable + EPS) {
            let lo = 0, hi = amount;
            while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (buyCost(st.market![d.item], mid, true) <= spendable + EPS) lo = mid; else hi = mid - 1; }
            amount = lo;
          }
          if (amount < 1) continue;
          const stockBefore = qty(st.storage[d.owner], d.item), creditsBefore = co.credits;
          const err = h.command(d.owner, { c: 'buy', station: st.id, res: d.item, amount });
          if (err) { p.reason = err; continue; }
          const bought = Math.max(0, qty(st.storage[d.owner], d.item) - stockBefore), spent = Math.max(0, creditsBefore - co.credits);
          if (legacy) policy.spent += spent; else { ops!.charge(spent, price); ops!.left -= spent; } p.spent += spent;
          if (bought > 0 && createJob(h, p, st, bought)) {
            const j = Object.values(h.st.logisticsJobs!).at(-1)!; allJobs.push(j); children.push(j); claim(claims, d.owner, st.id, d.item, bought);
            destRoom.set(d.station.id, Math.max(0, room - (takesSpace(d.item) ? bought : 0))); remaining = Math.max(0, remaining - bought); covered += bought;
          }
        }
      }
    }
    p.reserved = children.filter(live).reduce((n, j) => n + j.reserved, 0); p.inTransit = children.filter(live).reduce((n, j) => n + j.carried, 0);
    p.planned = children.filter(live).reduce((n, j) => n + Math.max(0, outstanding(j) - j.reserved - j.carried), 0);
    p.shortage = Math.max(0, d.need - localAmount - other - covered);
    if (children.some(j => live(j) && j.reserved > EPS && !h.st.stations[j.from])) { p.state = 'waiting'; p.reason = '출발지 소실 — 예약 자산은 원래 위치에 보존되며 정거장 복구 전 반환할 수 없습니다'; }
    else if (children.some(j => live(j) && j.state === 'paused')) { p.state = 'waiting'; p.reason = '일시정지된 운송 작업 또는 수동 회수 화물을 확인하세요'; }
    else if (children.some(j => live(j) && j.state === 'waiting' && j.reason)) { p.state = 'waiting'; p.reason = `${children.find(j => live(j) && j.state === 'waiting' && j.reason)!.reason}${p.shortage > EPS ? ` · ${Math.ceil(p.shortage)} 추가 부족` : ''}`; }
    else if (covered > EPS) { p.state = 'moving'; p.reason = p.shortage > EPS ? `일부 확보 · ${Math.ceil(p.shortage)} 부족` : '공용 물류 배정·운송 대기'; }
    else if (p.shortage <= EPS) { p.state = 'ready'; p.reason = '현장 재고 또는 기존 운송으로 충족'; }
    else if (!ships.length) p.reason = '공용 배차 참여 수송선이 없습니다 — 물류 관리에서 함선을 참여시키세요';
    else if ((destRoom.get(d.station.id) ?? 0) <= EPS && takesSpace(d.item)) p.reason = '목적지 공간 부족 — 재고 이동 또는 창고 증설 후 재시도';
    else if (!policy.autoBuy) p.reason = '접근 가능한 자사 자유 재고 부족 · 자동 구매 꺼짐';
    else if (!(policy.maxPrice[d.item] > 0)) p.reason = '품목별 구매 최대 단가를 설정하세요';
    else if (policy.spent >= policy.budget || co.credits <= policy.minCredits) p.reason = '구매 예산 또는 최소 보유 크레딧 제한';
    else if (!p.reason) p.reason = '접근 가능한 재고·시장·경로 또는 구매 조건 대기';
  }
}

// ─────────────────────────────────────────── AUTO-P0: stock floors and excess-stock sales

export interface SalesSettings { item: string; sell: boolean; minPrice?: number; station?: string; keep?: number; strategy?: SaleStrategy }
const sellableItem = (item: unknown): item is string => typeof item === 'string' && (Object.hasOwn(ITEMS, item) || Object.hasOwn(EQUIPMENT, item));
/**
 * One item's sales policy: sell its excess automatically (never below `minPrice` a unit) or stop, and optionally
 * the minimum stock to keep at one store (the procurement `protectedStock`, shared with every automatic path).
 */
export function setSalesPolicy(h: WorldSim, owner: string, s: SalesSettings): string | null {
  const co = h.st.companies[owner];
  if (!growthOn(h.st) || !co || co.kind !== 'player' || !s || typeof s !== 'object') return '이 세계에서는 판매 정책을 사용할 수 없습니다';
  if (!sellableItem(s.item) || typeof s.sell !== 'boolean') return '품목과 자동 판매 여부를 확인하세요';
  if (s.minPrice !== undefined && !finiteMoney(s.minPrice)) return '최저 판매 단가를 확인하세요';
  if (s.station !== undefined || s.keep !== undefined) {
    const st = typeof s.station === 'string' && Object.hasOwn(h.st.stations, s.station) ? h.st.stations[s.station] : undefined;
    if (!st || !(h.canDock(st, owner) || Object.hasOwn(st.storage, owner)) || !finiteMoney(s.keep) || s.keep! > 1e9) return '최소 비축 수량과 보관 정거장을 확인하세요';
  }
  const policy = co.procurement ??= defaultProcurementPolicy();
  if (s.strategy !== undefined && !SALE_STRATEGIES.includes(s.strategy)) return '판매 전략을 확인하세요';
  if (s.sell) { const prev = policy.sales?.[s.item]; const strategy = s.strategy ?? prev?.strategy; (policy.sales ??= {})[s.item] = { minPrice: s.minPrice ?? 0, ...(strategy && strategy !== 'local' ? { strategy } : {}) }; }
  else if (policy.sales?.[s.item]) {
    delete policy.sales[s.item]; delete policy.salesStatus?.[s.item];
    // unassigned automatic shipments of this item stop; loaded ones finish their sale
    for (const j of Object.values(h.st.logisticsJobs ?? {})) if (j.owner === owner && j.sale && j.item === s.item && live(j) && !j.ship && j.carried <= EPS) controlPoolJob(h, owner, j.id, 'cancel');
  }
  if (s.station !== undefined) {
    const stocks = policy.protectedStock[s.station] ??= {};
    if (s.keep! > 0) stocks[s.item] = s.keep!; else delete stocks[s.item];
    if (!Object.keys(stocks).length) delete policy.protectedStock[s.station];
  }
  return null;
}
/** what selling up to `amount` at `st` pays — walking the price down, within the station's budget (less `promised`
 *  to shipments already on their way), stopping where the unit price falls under `minPrice` */
export function saleQuote(h: Pick<WorldSim, 'st' | 'price'>, st: Station, item: string, amount: number, minPrice: number, promised = 0): { sold: number; value: number } {
  const m = st.market?.[item]; if (!m || amount < 1) return { sold: 0, value: 0 };
  const tax = 1 - (st.tax ?? 0), budget = st.public && st.funds !== undefined;
  const sim = { ...m }; let funds = (st.funds ?? 0) - promised, left = Math.floor(amount), sold = 0, value = 0;
  while (left >= 1) {
    let chunk = Math.min(left, tradeChunk(m));
    const p = priceOf(sim, 'sell', true);
    if (p * tax < minPrice - EPS || p <= 0) break;
    if (budget) { const can = Math.floor(funds / (p * tax)); if (can < chunk) chunk = can; if (chunk <= 0) break; funds -= chunk * p * tax; }
    value += chunk * p * tax; sim.stock += chunk; left -= chunk; sold += chunk;
  }
  return { sold, value };
}
/** credits already promised to each market by this company's live sale shipments (their budget is not counted twice) */
function salePromised(h: WorldSim, owner: string): Map<string, number> {
  const promised = new Map<string, number>();
  for (const j of Object.values(h.st.logisticsJobs ?? {})) {
    if (j.owner !== owner || j.kind !== 'sell' || !live(j)) continue;
    const st = h.st.stations[j.to]; if (!st?.market?.[j.item]) continue;
    const n = j.carried + j.reserved + Math.max(0, outstanding(j) - j.reserved - j.carried);
    promised.set(st.id, (promised.get(st.id) ?? 0) + n * h.price(st, j.item, 'sell') * (1 - (st.tax ?? 0)));
  }
  return promised;
}
/** markets that buy `amount` of `item` from `from` at no less than the rule's price, best first (value less a jump discount) */
function saleMarkets(h: WorldSim, owner: string, carriers: WShip[], promised: Map<string, number>, item: string, from: Station, amount: number, rule: SalesRule, exclude?: string) {
  const maxRisk = h.st.companies[owner]?.procurement?.maxRisk ?? 100, cmp = compareSale(rule.strategy);
  return Object.values(h.st.stations)
    .filter(m => m.id !== from.id && m.id !== exclude && m.public && m.market?.[item] && h.canDock(m, owner) && canCarry(carriers, from, m, false))
    .map(m => { const r = routeInfo(h, from, m, maxRisk); const q = r ? saleQuote(h, m, item, amount, rule.minPrice, promised.get(m.id) ?? 0) : { sold: 0, value: 0 }; return { m, hops: r?.hops ?? 0, risk: r?.risk ?? 0, q }; })
    .filter(x => x.q.sold >= 1).sort((a, b) => cmp({ net: a.q.value, hops: a.hops, risk: a.risk, local: false, id: a.m.id }, { net: b.q.value, hops: b.hops, risk: b.risk, local: false, id: b.m.id }));
}
/** AUTO-P1: a mining hauler's sale trip must stay short and pay for the mining time it takes */
export const MINER_TRIP_MAX_JUMPS = 3;
export const MINER_TRIP_MIN_VALUE = 1500;   // expected sale value per jump of the one-way trip (at least one)
/** AUTO-P1.1: a sale trip waits this long with no market to go on to before it flies its cargo back */
export const MINER_TRIP_GIVEUP = 900;
/** AUTO-P1.1: after a trip comes back unsold, no new trip of that item for 15 min, doubling per further failure (≤ 4 h) */
const MINER_TRIP_BACKOFF = 900, MINER_TRIP_BACKOFF_MAX = 4 * 3600;
/** AUTO-P1.1: mining-hauler sale trips are on unless the player chose "mining haul only" */
export const minerSalesOn = (p: Pick<ProcurementPolicy, 'minerSales'> | undefined) => !!p && p.minerSales !== false;
/**
 * A-3.2b.2: salvage haulers may sell a part load (below 60 % of the hold) once the excess has waited this long at the
 * store; a part-load trip of an item then blocks the next part-load trip of it for SALV_PARTIAL_GAP (full loads
 * are not held back). Mining haulers keep the AUTO-P1 rule (10 minutes, only while the store has room).
 */
export const SALV_PARTIAL_WAIT = 1200, SALV_PARTIAL_GAP = 1800;
/** A-3.2b.2: planning estimate of a sale round trip — per jump each way, plus undocking, in-system legs, docking and the sale */
export const SALV_TRIP_HOP_S = 30, SALV_TRIP_BASE_S = 60;   // calibrated on a measured 2-jump trip: sold after 70 s, back salvaging after 142 s
export interface SalvTripCost { seconds: number; upkeep: number; opportunity: number; cost: number }
/**
 * A-3.2b.2: what a salvage hauler's sale round trip costs. The game has no fuel or tolls; a hauler's running cost
 * (upkeep, plus a big-berth fee if it has one) is paid whether it flies or not, so the trip is charged its share for
 * the trip time. The work opportunity is the salvage this hauler would have carried meanwhile: the company's
 * recovered value per hour since its first salvage, split over its working civilian ships.
 */
export function salvTripCost(h: WorldSim, s: WShip, hops: number, workers: number): SalvTripCost {
  const seconds = 2 * (Math.max(0, hops) * SALV_TRIP_HOP_S) + SALV_TRIP_BASE_S;
  const r = shipRate(h.st, s), upkeep = (r.credits + r.dock) * seconds / 3600;
  const sv = h.st.companies[s.owner]?.salvage, age = sv?.first !== undefined ? h.time - sv.first : 0;
  const perHour = sv && age >= 600 ? sv.value / (age / 3600) / Math.max(1, workers) : 0;
  const opportunity = perHour * seconds / 3600;
  return { seconds, upkeep, opportunity, cost: upkeep + opportunity };
}

const minerRetryWait = (h: WorldSim, p: ProcurementPolicy, item: string) => Math.max(0, (p.minerTripRetry?.[item]?.at ?? 0) - h.time);
/** AUTO-P1.1: no market will take the trip's cargo — fly it back to its source (real route, docking rules unchanged) */
function returnMinerTrip(h: WorldSim, p: ProcurementPolicy, j: LogisticsJob, why: string) {
  const home = h.st.stations[j.from], name = ITEMS[j.item]?.name ?? EQUIPMENT[j.item]?.name ?? j.item;
  const r = (p.minerTripRetry ??= {})[j.item] ??= { at: 0, fails: 0 };
  r.fails++; r.at = h.time + Math.min(MINER_TRIP_BACKOFF_MAX, MINER_TRIP_BACKOFF * 2 ** (r.fails - 1));
  j.amount = j.cycleDelivered + j.carried;   // nothing more is promised from the source store
  j.to = j.from; j.returning = true; delete j.stuck; j.state = 'active'; delete j.code; delete j.retryAt; j.attempts = 0;
  j.reason = `${why} — 맞는 시장이 ${Math.round(MINER_TRIP_GIVEUP / 60)}분 동안 없어 ${home?.name ?? j.from}(으)로 복귀`;
  p.minerTrip = { t: h.time, ship: j.ship ?? '', reason: `${name} 판매 실패 — ${home?.name ?? j.from}(으)로 복귀, ${Math.round((r.at - h.time) / 60)}분 뒤 판매 왕복 재시도` };
  h.ev('info', `${j.salvTrip ? '인양' : '채굴'} 수송선 판매 왕복 복귀: ${name} ${Math.round(j.carried)} — ${j.reason}`, { company: j.owner, pos: home?.pos });
}
/**
 * AUTO-P1: a mining fleet's hauler that has just unloaded (docked, empty, at its fleet's delivery station) takes one
 * sale round trip of the station's excess stock when the player allowed it, no idle usable pool hauler is there to
 * do it, and the trip is short and worth it. Items, amounts and prices follow the same stock floor, company target
 * and minimum-price rules as every other automatic sale. The hauler goes back to mining when the trip ends; the
 * fleet's miners unload themselves meanwhile. Returns true when a trip was assigned.
 */
export function planMinerSaleTrip(h: WorldSim, s: WShip, dock: Station, salvage = false): boolean {
  if (!growthOn(h.st)) return false;
  const who = salvage ? '인양 수송선' : '채굴 수송선', work = salvage ? '인양' : '채굴';
  const co = h.st.companies[s.owner], policy = co?.kind === 'player' ? co.procurement : undefined;
  if (!minerSalesOn(policy) || !policy?.sales || !Object.keys(policy.sales).length) return false;
  if (s.logisticsJob || cargoSum(s.cargo) > EPS || s.state !== 'docked' || s.task.k !== 'docked' || s.task.station !== dock.id) return false;
  const note = (reason: string) => { policy.minerTrip = { t: h.time, ship: s.id, reason }; return false; };
  if (poolShips(h, co.id).some(p => p.hp >= HAULER_MIN_HP && !p.logisticsJob)) return note('유휴 공용 수송선이 판매 운송을 맡음');
  if (s.hp < HAULER_MIN_HP) return note(`${who} 손상(내구 ${Math.round(s.hp * 100)}%) — 수리 후 판매 왕복`);
  if (!h.canDock(dock, co.id)) return note(`${dock.name}: 정박 불가`);
  const status = policy.salesStatus ??= {}, promised = salePromised(h, co.id);
  const lot = Math.floor(econOf(s).cargo * techFx(co.tech).cargoMul + EPS);
  let why = '판매할 초과 재고 없음';
  for (const item of Object.keys(policy.sales).sort()) {
    const rule = policy.sales[item], name = ITEMS[item]?.name ?? EQUIPMENT[item]?.name ?? item;
    const back = minerRetryWait(h, policy, item);
    if (back > 0) { why = `${name}: 최근 판매 왕복이 팔지 못하고 복귀 — ${Math.ceil(back / 60)}분 뒤 재시도`; continue; }
    const excess = Math.floor(Math.min(sellableStock(h, co.id, dock, item), companySaleCap(h, co.id, item)) + EPS);
    // A-3.2b.2: a salvage store's waiting time counts only while it actually holds excess to ship
    const clear = () => { if (salvage) { const x = status[item]?.since; if (x) delete x[dock.id]; } };
    if (excess < 1) { clear(); continue; }
    if (dock.market?.[item] && saleQuote(h, dock, item, excess, rule.minPrice, promised.get(dock.id) ?? 0).sold >= 1) { clear(); continue; }   // sold here by planSales
    const st0 = status[item] ??= { t: h.time, excess, moving: 0, reason: '', sold: 0, earned: 0 };
    const since = (st0.since ??= {}); since[dock.id] ??= h.time;
    const waited = h.time - since[dock.id], small = excess < lot * 0.6 && h.room(dock, co.id) > lot;
    if (!salvage && small && waited < 600) { why = `${name} 초과 ${excess}: 한 번에 실을 만큼 모이면 판매 왕복`; continue; }
    if (salvage && small) {
      if (waited < SALV_PARTIAL_WAIT) { why = `${name} 초과 ${excess}: 60% 적재(${Math.ceil(lot * 0.6)})까지 모으는 중 — ${Math.ceil((SALV_PARTIAL_WAIT - waited) / 60)}분 더 쌓여 있으면 부분 적재 판매`; continue; }
      const gap = (policy.salvPartialAt?.[item] ?? -Infinity) + SALV_PARTIAL_GAP - h.time;
      if (gap > 0) { why = `${name} 초과 ${excess}: 최근 부분 적재 왕복 — 소량 반복 운송 방지, ${Math.ceil(gap / 60)}분 뒤 다시 판단`; continue; }
    }
    const amount = Math.min(excess, lot), best = saleMarkets(h, co.id, [s], promised, item, dock, amount, rule)[0];
    if (!best) { why = `${name} 초과 ${excess}: 조건에 맞는 매입 시장 없음(최저 단가·예산·경로 위험·정박) — 재고 보존, 재시도`; continue; }
    if (best.hops > MINER_TRIP_MAX_JUMPS) { why = `${name}: 가장 나은 시장 ${best.m.name}이(가) ${best.hops}점프 — ${who} 왕복 한도(${MINER_TRIP_MAX_JUMPS}점프) 초과`; continue; }
    if (best.q.value < MINER_TRIP_MIN_VALUE * Math.max(1, best.hops)) { why = `${name}: 예상 판매액 ${Math.round(best.q.value).toLocaleString()} cr — ${work}을 비울 만한 수익 아님(점프당 ${MINER_TRIP_MIN_VALUE.toLocaleString()} cr 이상)`; continue; }
    // A-3.2b.2: a salvage trip must earn more than its running-cost share and the salvage the hauler leaves behind
    const cost = salvage ? salvTripCost(h, s, best.hops, salvageWorkers(h, s)) : undefined;
    if (cost && best.q.value <= cost.cost) { why = `${name}: 예상 판매액 ${Math.round(best.q.value).toLocaleString()} cr ≤ 왕복 비용 ${Math.round(cost.cost).toLocaleString()} cr(운영비 ${Math.round(cost.upkeep).toLocaleString()} + 인양 기회비용 ${Math.round(cost.opportunity).toLocaleString()}, 약 ${Math.round(cost.seconds / 60)}분) — 손해 예상, 재고 보존`; continue; }
    const err = createPoolJob(h, co.id, { from: dock.id, to: best.m.id, item, kind: 'sell', amount: Math.floor(best.q.sold), priority: 4, repeat: false }, undefined, true);
    if (err) { why = `${name}: ${err}`; continue; }
    const j = Object.values(h.st.logisticsJobs!).at(-1)!;
    assignMinerTrip(h, j, s, salvage);
    delete since[dock.id];
    const part = salvage && small;
    if (part) (policy.salvPartialAt ??= {})[item] = h.time;
    policy.minerTrip = { t: h.time, ship: s.id, reason: `${s.name}: ${name} ${Math.round(j.reserved)} → ${best.m.name} ${part ? '부분 적재 ' : ''}판매 왕복 (${best.hops}점프, 예상 ${Math.round(best.q.value).toLocaleString()} cr${cost ? ` · 왕복 비용 약 ${Math.round(cost.cost).toLocaleString()} cr` : ''})` };
    h.ev('info', `${who} 판매 왕복: ${s.name}이(가) ${dock.name}의 ${name} ${Math.round(j.reserved)}을(를) ${best.m.name}에 판매하러 출발`, { company: co.id, pos: dock.pos });
    return true;
  }
  return note(why);
}
/** A-3.2b.2: civilian ships of a salvage hauler's group (the share of salvage income one hauler stands for) */
function salvageWorkers(h: WorldSim, s: WShip): number {
  const g = h.st.groups[s.groupId];
  return g ? g.shipIds.filter(id => { const x = h.st.ships[id]; return x && !econOf(x).military; }).length : 1;
}
/**
 * Excess-stock sales, run with the procurement planner. For every item with a sales policy and every store that
 * holds more than its floor: sell at that station when its market pays the floor price, otherwise create a pool
 * sale shipment to the best reachable market (price walk, station budget less other shipments, jumps, risk limit,
 * docking and berths). Only idle pool haulers carry — a mining fleet's own hauler keeps its mining role. With no
 * market or no hauler the goods stay where they are and the next pass retries. A shipment stuck at a market whose
 * budget ran out is sent on to another market with its cargo.
 */
export function planSales(h: WorldSim) {
  if (!growthOn(h.st)) return;
  for (const co of Object.values(h.st.companies)) {
    const policy = co.kind === 'player' ? co.procurement : undefined, rules = policy?.sales;
    if (!policy || !rules || !Object.keys(rules).length) continue;
    const status = policy.salesStatus ??= {};
    const ships = poolShips(h, co.id), maxCargo = ships.length ? Math.max(...ships.map(s => econOf(s).cargo * techFx(co.tech).cargoMul)) : 0;
    const jobs = Object.values(h.st.logisticsJobs ?? {}).filter(j => j.owner === co.id && j.kind === 'sell' && live(j));
    const promised = salePromised(h, co.id);
    const promise = (st: Station, item: string, n: number) => promised.set(st.id, (promised.get(st.id) ?? 0) + n * h.price(st, item, 'sell') * (1 - (st.tax ?? 0)));
    // AUTO-P1: an idle mining hauler may carry when the pool has no usable ship (its trips are planned when it docks)
    const minerCarriers = minerSalesOn(policy) ? Object.values(h.st.ships).filter(s => s.owner === co.id && s.classId === 'hauler' && (() => { const g = h.st.groups[s.groupId], k = g && h.opOf(g).k; return k === 'mine' || (k === 'recover' || k === 'salvzone') && !!h.st.salvageV; })()) : [];
    const markets = (item: string, from: Station, amount: number, rule: SalesRule, exclude?: string) => saleMarkets(h, co.id, ships.length ? ships : minerCarriers, promised, item, from, amount, rule, exclude);
    for (const item of Object.keys(rules).sort()) {
      const rule = rules[item], st0 = status[item] ?? { t: h.time, excess: 0, moving: 0, reason: '', sold: 0, earned: 0 };
      const reasons: string[] = [];
      // shipments waiting at a market that cannot pay go on to another one (cargo kept aboard throughout)
      // (a market that no longer buys at once; one short of budget when it cannot pay for half the load)
      for (const j of jobs) {
        if (!(j.sale && j.item === item && j.carried > EPS && j.ship && j.state === 'waiting')) { if (j.stuck && j.state !== 'waiting') delete j.stuck; continue; }
        // AUTO-P1.1: a mining-hauler trip back home with unsold cargo it could not store tries a market again after its back-off
        const home = j.returning && j.code === 'returned';
        if (home ? minerRetryWait(h, policy, item) > 0 : !(j.code === 'market' || j.code === 'price' || j.code === 'budget' && (() => { const here = h.st.stations[j.to]; return !here || saleQuote(h, here, item, j.carried, rule.minPrice).sold < j.carried / 2; })())) { delete j.stuck; continue; }
        const here = h.st.stations[j.to]; const alt = here && markets(item, here, j.carried, { minPrice: rule.minPrice }, j.to)[0];
        const why = home ? '복귀 화물' : j.code === 'price' ? '최저 단가 미달' : j.code === 'market' ? '매입 중단' : '예산 소진';
        if (alt) { j.to = alt.m.id; j.state = 'active'; delete j.code; delete j.retryAt; delete j.stuck; delete j.returning; j.attempts = 0; j.reason = `${here.name} ${why} — ${alt.m.name}(으)로 이동해 판매`; promise(alt.m, item, j.carried); continue; }
        // AUTO-P1.1: no market for a mining hauler's trip: after MINER_TRIP_GIVEUP of that (selling nothing meanwhile) fly back
        if (!j.miner || j.returning) continue;
        if (!j.stuck || j.delivered > j.stuck.delivered + EPS) j.stuck = { since: h.time, delivered: j.delivered };
        else if (h.time - j.stuck.since >= MINER_TRIP_GIVEUP) returnMinerTrip(h, policy, j, `${here?.name ?? j.to} ${why}`);
      }
      let cap = companySaleCap(h, co.id, item), excessTotal = 0;
      for (const st of Object.values(h.st.stations).filter(x => qty(x.storage[co.id], item) >= 1).sort((a, b) => a.id.localeCompare(b.id))) {
        let excess = Math.floor(Math.min(sellableStock(h, co.id, st, item), cap) + EPS); if (excess < 1) continue;
        excessTotal += excess;
        // 1. this station's own market pays enough: sell here, no shipment
        if (st.market?.[item] && h.canDock(st, co.id)) {
          const q = saleQuote(h, st, item, excess, rule.minPrice, promised.get(st.id) ?? 0);
          // P17.4b AUD-06 'profit': keep the lot for a shipment when a reachable market pays clearly more after its jump discount
          const away = rule.strategy === 'profit' && q.sold >= 1 && ships.some(s => s.hp >= HAULER_MIN_HP) ? markets(item, st, Math.min(excess, Math.floor(maxCargo + EPS)), rule)[0] : undefined;
          const better = away && compareSale('profit')({ net: away.q.value / away.q.sold, hops: away.hops, risk: away.risk, local: false }, { net: q.value / q.sold, hops: 0, risk: 0, local: true }) < 0;
          if (better) reasons.push(`${st.name}: 최대 순수익 — ${away!.m.name}이(가) 현지보다 높게 매입 (${Math.round(away!.q.value / away!.q.sold).toLocaleString()} vs ${Math.round(q.value / q.sold).toLocaleString()} cr/개), 운송 판매`);
          if (q.sold >= 1 && !better) {
            const r = h.sellAt(st, co.id, item, q.sold); takec(h.storage(st, co.id), item, r.sold);
            st0.sold += r.sold; st0.earned += r.value; excess -= r.sold; cap -= r.sold;
            if (r.sold > 0) h.ev('money', `자동 판매: ${st.name}에서 ${ITEMS[item]?.name ?? EQUIPMENT[item]?.name ?? item} ${Math.round(r.sold)} 판매 +${Math.round(r.value).toLocaleString()} cr (초과 재고)`, { company: co.id, pos: st.pos });
          }
          if (excess < 1) continue;
        }
        if (!h.canDock(st, co.id)) { reasons.push(`${st.name}: 정박할 수 없어 운송 불가`); continue; }
        // 2. ship it to another market
        const usable = ships.filter(s => s.hp >= HAULER_MIN_HP);
        if (!usable.length) {
          // AUTO-P1: the mining fleet's hauler sells on its next stop at this station (planMinerSaleTrip)
          const trip = jobs.find(j => j.miner && j.from === st.id && j.item === item);
          const miner = minerCarriers.find(s => { const g = h.st.groups[s.groupId], op = g && h.opOf(g); return op?.k === 'mine' && op.deliver === st.id; });
          if (trip) { reasons.push(trip.returning ? `${trip.salvTrip ? '인양' : '채굴'} 수송선이 팔지 못한 화물을 싣고 ${h.st.stations[trip.to]?.name ?? trip.to}(으)로 복귀 — ${trip.reason ?? ''}` : `${trip.salvTrip ? '인양' : '채굴'} 수송선 판매 왕복 중 → ${h.st.stations[trip.to]?.name ?? trip.to}`); continue; }
          const salv = minerCarriers.find(s => { const g = h.st.groups[s.groupId], k = g && h.opOf(g).k; return (k === 'recover' || k === 'salvzone') && g!.salv?.station === st.id; });
          if (salv && !miner) { reasons.push(`${st.name} 초과 ${excess}: 인양 수송선이 이곳에 하역한 뒤 판매 왕복 — ${policy.minerTrip?.reason ?? '대기'}`); continue; }
          if (miner) { reasons.push(`${st.name} 초과 ${excess}: 채굴 수송선이 다음 하역 때 판매 왕복 — ${policy.minerTrip?.reason ?? '대기'}`); continue; }
          reasons.push(!ships.length
            ? `${st.name} 초과 ${excess}: 공용 수송선 없음 — 재고 보존. 대기 편대에 수송선을 두거나 '채굴 운반 전용'을 해제하면 자동 운송`
            : `${st.name} 초과 ${excess}: 공용 수송선 손상(내구 ${Math.round(Math.max(...ships.map(s => s.hp)) * 100)}%) — 수리 후 자동 운송, 재고 보존`);
          continue;
        }
        const waiting = jobs.filter(j => j.sale && j.from === st.id && j.item === item && !j.ship && j.reserved <= EPS && j.state !== 'paused').length;
        if (waiting >= usable.length) continue;
        // ship full loads: a part load only when the store is nearly full or the excess has waited 10 minutes
        const since = (st0.since ??= {});
        since[st.id] ??= h.time;
        const lot = Math.floor(maxCargo + EPS);
        if (excess < lot * 0.6 && h.room(st, co.id) > lot && h.time - since[st.id] < 600) continue;
        const amount = Math.min(excess, lot), best = markets(item, st, amount, rule)[0];
        if (!best) { reasons.push(`${st.name} 초과 ${excess}: 조건에 맞는 매입 시장 없음(최저 단가·예산·경로 위험·정박) — 재고 보존, 재시도`); continue; }
        const err = createPoolJob(h, co.id, { from: st.id, to: best.m.id, item, kind: 'sell', amount: Math.floor(best.q.sold), priority: 4, repeat: false }, undefined, true);
        if (err) { reasons.push(`${st.name}: ${err}`); continue; }
        const j = Object.values(h.st.logisticsJobs!).at(-1)!; jobs.push(j); promise(best.m, item, j.amount); cap -= j.amount; delete since[st.id];
      }
      const mine = jobs.filter(j => j.sale && j.item === item && live(j));
      st0.t = h.time; st0.excess = excessTotal;
      st0.moving = mine.reduce((n, j) => n + Math.max(0, outstanding(j)), 0);
      st0.reason = reasons[0] ?? (st0.moving > 0 ? `운송·판매 중 ${Math.round(st0.moving)}` : excessTotal > 0 ? '초과 재고 처리 중' : '초과 재고 없음 — 최소 비축 유지');
      status[item] = st0;
    }
  }
}
