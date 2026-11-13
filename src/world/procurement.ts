// Server-authoritative demand planning; all movement is executed by the existing logistics pool.
import type { WorldSim } from './sim';
import type { Cargo, Company, Station, WShip } from './types';
import { qty } from './types';
import { missing, planMats, prereqBuilt } from './construction';
import { buildNeeds, builtCount, facLines, orderWants, recipeOk, yardSlots, buildSpec } from './production';
import { ITEMS, EQUIPMENT, recipeFor } from './industry';
import { moduleMaterials } from './stations';
import { growthOn, econOf, berthFits } from './hullops';
import { takesSpace } from './storage';
import { dist } from './geom';
import { effSec } from './security';
import { usableRouteGate, incomingRoutes } from './logistics';
import { createPoolJob, controlPoolJob, type LogisticsJob } from './autonomousLogistics';
import { procurementAuthority } from './operations';

export type ProcurementKind = 'construction' | 'production' | 'ship';
export interface ProcurementPolicy {
  enabled: boolean; autoBuy: boolean; budget: number; spent: number; minCredits: number; maxRisk: number;
  maxPrice: Record<string, number>; protectedStock: Record<string, Cargo>;
  disabled: Record<string, boolean>; priority: Record<string, number>;
}
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
  for (const st of Object.values(h.st.stations).filter(s => s.owner === co.id).sort((a, b) => a.id.localeCompare(b.id))) {
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
  }
  return out.sort((a, b) => b.priority - a.priority || a.order - b.order || a.station.id.localeCompare(b.station.id) || a.item.localeCompare(b.item));
}
/** Only ordinary stations are considered: sites, deposits and other hidden exploration data are never searched. */
function routeScore(h: WorldSim, a: Station, b: Station, maxRisk: number): number {
  const start = h.sysOf(a.pos), end = h.sysOf(b.pos); if (!start || !end || 100 - effSec(start) > maxRisk || 100 - effSec(end) > maxRisk) return Infinity;
  if (start.id === end.id) return dist(a.pos, b.pos);
  const queue = [{ id: start.id, hops: 0, risk: 0 }], seen = new Set([start.id]);
  while (queue.length) {
    const node = queue.shift()!;
    for (const gate of [...(h.st.systems[node.id]?.gates ?? [])].sort((x, y) => x.id.localeCompare(y.id))) {
      const next = h.st.systems[gate.to]; if (!next || seen.has(next.id) || !usableRouteGate(h.st, gate)) continue;
      const risk = 100 - effSec(next); if (risk > maxRisk) continue;
      const hops = node.hops + 1, sumRisk = node.risk + risk;
      if (next.id === end.id) return hops * 200000 + sumRisk * 1000 + dist(a.pos, start.origin) + dist(b.pos, end.origin);
      seen.add(next.id); queue.push({ id: next.id, hops, risk: sumRisk });
    }
  }
  return Infinity;
}
function poolShips(h: WorldSim, owner: string): WShip[] {
  return Object.values(h.st.ships).filter(s => {
    const g = h.st.groups[s.groupId]; return s.owner === owner && !!s.logisticsPool && !!g && h.opOf(g).k === 'idle' && s.state !== 'battle' && s.state !== 'building' && !s.reserve && !s.listed && econOf(s).cargo > 0 && !econOf(s).military && s.classId !== 'miner' && s.classId !== 'constructor';
  });
}
function canCarry(ships: WShip[], a: Station, b: Station, construction: boolean, external = false) { return ships.some(s => (external || berthFits(a, econOf(s).berth)) && (construction || berthFits(b, econOf(s).berth))); }
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
    const origin = p.sourceKind === 'construction' ? st?.modules.find(m => m.id === p.sourceId && !m.built) : p.sourceKind === 'production' ? st?.orders?.find(o => o.id === p.sourceId) : st?.builds?.find(b => b.id === p.sourceId && !b.started);
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
          const amount = Math.floor(Math.min(remaining, maxCargo, st.market![d.item].stock, h.room(st, d.owner), takesSpace(d.item) ? room : Infinity, budgetLeft() / price, (co.credits - floor) / price) + EPS);
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
