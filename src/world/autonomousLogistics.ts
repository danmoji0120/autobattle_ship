// Company-owned, opt-in dispatch. Existing managed routes remain on their original execution path.
import type { WorldSim } from './sim';
import type { WShip, WGroup, Station, WorldState } from './types';
import { addc, takec, qty, cargoSum, cargoKeys } from './types';
import { autoLogistics, poolMember, haulerAvailability } from './haulers';
import { econOf, berthFits, growthOn } from './hullops';
import { EQUIPMENT, ITEMS, techFx } from './industry';
import { constructionRoom } from './storage';
import { occupiedBerths, stationBerths } from './stations';
import { dist, jumps, nextGate } from './geom';
import { departureHeld } from './upkeep';
import { usableRouteGate, incomingRoutes } from './logistics';
import { emit, watchMoney } from './observe';
import { effSec } from './security';
import { stockFloor } from './operations';

export interface PoolRequest {
  from: string; to: string; item: string;
  kind: 'transfer' | 'sell' | 'supply' | 'construction';
  amount: number; priority: number; repeat: boolean;
}
export interface LogisticsJob extends PoolRequest {
  id: string; owner: string; created: number; updated: number;
  state: 'queued' | 'active' | 'waiting' | 'paused' | 'complete' | 'cancelled';
  ship?: string; reason?: string; code?: string; retryAt?: number; attempts?: number;
  /** Reserved goods are removed from free storage but remain physically at the source. */
  reserved: number; carried: number; delivered: number; cycleDelivered: number;
  lost: number; withdrawn: number; earned: number; cycles: number; lastAction?: number;
  /** Set only by the server's procurement planner, never by the client. */
  procurement?: string;
  /** The origin was paused while this shipment had cargo; resume only with that origin. */
  procurementSuspended?: boolean;
  /** P12.5: the loaded ship was taken by a direct command; the cargo stays tracked and the same ship resumes it */
  held?: { ship: string; since: number; auto: boolean };
  /** P12.5: delivers untracked cargo already aboard (from === to); never loads anything */
  stow?: true;
  /** P13.2: part of `lost` that was jettisoned under a raider's demand (not a destroyed ship) */
  pirated?: number;
  /** AUTO-P0: created by the excess-stock sales planner (procurement.ts `planSales`) — may be re-targeted */
  sale?: true;
}
type Host = Pick<WorldSim, 'st' | 'time' | 'id' | 'opOf' | 'opOwner' | 'subtreeShips' | 'shipsOf' | 'canDock' | 'storage' | 'sysOf' | 'goDock' | 'goConstruction' | 'cargoPermit' | 'intakeRoom' | 'sellAt' | 'undock' | 'ev'>;
const EPS = 1e-9;
const isTerminal = (j: LogisticsJob) => j.state === 'complete' || j.state === 'cancelled';
const compatibleItem = (item: string) => Object.hasOwn(ITEMS, item) || Object.hasOwn(EQUIPMENT, item) || item.startsWith('bp:') || item.startsWith('bpf:');

function problem(h: Host, owner: string, r: PoolRequest, external = false, reserved = 0, carrying = false): string | null {
  if (!growthOn(h.st)) return '이 월드에서는 공용 물류를 사용할 수 없습니다';
  if (!r || typeof r.from !== 'string' || typeof r.to !== 'string' || r.from === r.to && !(r as LogisticsJob).stow || !carrying && !Object.hasOwn(h.st.stations, r.from) || !Object.hasOwn(h.st.stations, r.to)) return '서로 다른 출발지와 목적지를 선택하세요';
  const a = h.st.stations[r.from], b = h.st.stations[r.to];
  if (!['transfer', 'sell', 'supply', 'construction'].includes(r.kind)) return '운송 목적을 선택하세요';
  if (typeof r.item !== 'string' || !compatibleItem(r.item)) return '운송할 품목을 선택하세요';
  if (!carrying && (!a || !h.canDock(a, owner) && !(external && !a.public && a.owner !== owner && (qty(a.storage[owner], r.item) > 0 || reserved > 0)))) return '이용 가능한 출발 정거장을 선택하세요';
  if (r.kind === 'construction' ? b.owner !== owner : !h.canDock(b, owner)) return '이용 가능한 목적 정거장을 선택하세요';
  if (r.kind === 'sell' && !b.market?.[r.item]) return '목적지 시장에서 이 품목을 매입하지 않습니다';
  if (r.kind === 'supply' && (b.owner !== owner || !carrying && ![a, b].some(st => st?.owner === owner && st.modules.some(m => m.kind === 'logistics' && m.built)))) return '생산 공급에는 자사 목적지와 물류센터가 필요합니다';
  const validAmount = Number.isSafeInteger(r.amount) && r.amount >= 1 || external && r.kind === 'construction' && Number.isFinite(r.amount) && r.amount > EPS && r.amount <= Number.MAX_SAFE_INTEGER;
  if (!validAmount || !Number.isSafeInteger(r.priority) || r.priority < 0 || r.priority > 9 || typeof r.repeat !== 'boolean') return '수량은 양의 정수, 우선순위는 0–9여야 합니다';
  return null;
}
export function createPoolJob(h: Host, owner: string, request: PoolRequest, procurement?: string, sale = false): string | null {
  const err = problem(h, owner, request, !!procurement); if (err) return err;
  const { from, to, item, kind, amount, priority, repeat } = request;
  const job: LogisticsJob = { id: h.id('lj'), owner, from, to, item, kind, amount, priority, repeat, created: h.time, updated: h.time, state: 'queued', reserved: 0, carried: 0, delivered: 0, cycleDelivered: 0, lost: 0, withdrawn: 0, earned: 0, cycles: 0, ...(procurement ? { procurement } : {}), ...(sale && kind === 'sell' ? { sale: true as const } : {}) };
  (h.st.logisticsJobs ??= {})[job.id] = job;
  return null;
}
function releaseReservation(h: Host, j: LogisticsJob) {
  const source = h.st.stations[j.from];
  if (source && j.reserved > 0) { addc(h.storage(source, j.owner), j.item, j.reserved); j.reserved = 0; }
}
function clearWait(h: Host, j: LogisticsJob, s?: WShip) {
  if (j.code && j.ship) emit(h.st, { kind: 'logistics', reason: 'resumed', amount: 0, company: j.owner, group: s?.groupId, ship: j.ship });
  delete j.code; delete j.retryAt; delete j.attempts;
}
/** Return source reservations; a surviving ship keeps every item physically aboard. */
function detach(h: Host, j: LogisticsJob, reason: string, lost = false) {
  const s = j.ship ? h.st.ships[j.ship] : undefined;
  clearWait(h, j, s);
  // P12.5: cargo that stays aboard a surviving ship is delivered later by a stow job, to this destination
  const keeper = s ?? (j.held ? h.st.ships[j.held.ship] : undefined);
  if (autoLogistics(h.st) && keeper && !lost && j.carried > EPS && keeper.owner === j.owner) keeper.logisticsStow = j.to;
  delete j.held;
  if (j.carried > 0 && j.ship) emit(h.st, { kind: 'logistics', reason: 'aborted', amount: j.carried, company: j.owner, group: s?.groupId, ship: j.ship, item: j.item });
  if (j.carried > 0) { if (lost) j.lost += j.carried; else j.withdrawn += j.carried; }
  j.carried = 0; releaseReservation(h, j);
  if (s?.logisticsJob === j.id) { delete s.logisticsJob; if (s.cargoWork?.key.startsWith(`pool:${j.id}:`)) delete s.cargoWork; if (s.state !== 'battle') { s.vel = { x: 0, y: 0, z: 0 }; delete s.warp; } }
  delete j.ship; j.reason = j.reserved > EPS ? `${reason} — 출발지 복구 시 예약 재고 반환` : reason; j.updated = h.time;
}
/**
 * P13.2: cargo left a surviving ship at a raider's demand. Settled at that moment: carried −, lost +
 * (and pirated +). A shipment that still has cargo goes on and delivers the rest (the shortfall stays
 * outstanding and is re-dispatched after it); one with nothing left releases the ship and is re-queued.
 */
export function cargoLost(h: Host, s: WShip, item: string, n: number): number {
  let left = n, settled = 0;
  for (const j of Object.values(h.st.logisticsJobs ?? {})) {
    if (left <= EPS) break;
    if (isTerminal(j) || j.item !== item || j.owner !== s.owner || (j.ship !== s.id && j.held?.ship !== s.id) || j.carried <= EPS) continue;
    const k = Math.min(j.carried, left);
    j.carried -= k; j.lost += k; j.pirated = (j.pirated ?? 0) + k; left -= k; settled += k; j.updated = h.time;
    emit(h.st, { kind: 'logistics', reason: 'pirated', amount: k, company: j.owner, group: s.groupId, ship: s.id, item });
    if (j.carried > EPS) continue;
    j.carried = 0;
    if (j.ship === s.id) { detach(h, j, '화물 약탈 — 남은 필요량 재배차', true); if (!isTerminal(j) && j.state !== 'paused') j.state = 'queued'; }
    else { delete j.held; delete j.code; j.state = 'queued'; j.reason = '화물 약탈 — 남은 필요량 재배차'; }
  }
  if (settled > EPS) h.ev('warn', `물류 손실: ${s.name} 화물 ${Math.round(settled)} 약탈 — 남은 필요량은 다시 배차합니다`, { company: s.owner, pos: s.pos, ref: s.groupId, tag: 'logistics' });
  return settled;
}
/** P12.5: a loaded shipment yields to a direct command without losing track of its cargo. */
function hold(h: Host, j: LogisticsJob, s: WShip, reason: string) {
  clearWait(h, j, s);
  if (s.cargoWork?.key.startsWith(`pool:${j.id}:`)) delete s.cargoWork;
  delete s.logisticsJob; releaseReservation(h, j);
  const rest = j.amount - j.cycleDelivered - j.carried;
  if (rest > EPS && !j.repeat) {
    // the unloaded remainder must not wait for this ship: procurement re-plans it, a direct request is split off
    if (j.procurement) j.amount = j.cycleDelivered + j.carried;
    else if (j.kind !== 'sell' && !createPoolJob(h, j.owner, { from: j.from, to: j.to, item: j.item, kind: j.kind, amount: rest, priority: j.priority, repeat: false })) j.amount = j.cycleDelivered + j.carried;
  }
  delete j.ship; j.held = { ship: s.id, since: h.time, auto: true };
  j.state = 'paused'; j.code = 'held'; j.reason = `${reason} — 화물 ${Math.round(j.carried * 10) / 10} 보존 · 함선이 대기 상태로 돌아오면 같은 함선으로 자동 재개`; j.updated = h.time;
  emit(h.st, { kind: 'logistics', reason: 'held', amount: j.carried, company: j.owner, group: s.groupId, ship: s.id, item: j.item });
}
export function interruptPoolShips(h: Host, ships: WShip[], reason: string, keep = true) {
  if (autoLogistics(h.st)) {
    // P12.5: membership is not revoked by a command; the ship rejoins once its group is idle again
    for (const s of ships) {
      const j = s.logisticsJob ? h.st.logisticsJobs?.[s.logisticsJob] : undefined;
      if (!j) { delete s.logisticsJob; continue; }
      if (j.owner !== s.owner || j.ship !== s.id) { delete s.logisticsJob; continue; }
      if (keep && j.carried > EPS && !j.stow) hold(h, j, s, reason);
      else { detach(h, j, reason); if (!isTerminal(j) && j.state !== 'paused') j.state = 'queued'; if (j.stow && !isTerminal(j)) j.state = 'cancelled'; }
    }
    return;
  }
  for (const s of ships) {
    if (!s.logisticsPool && !s.logisticsJob) continue;
    s.logisticsPool = false;
    const j = s.logisticsJob ? h.st.logisticsJobs?.[s.logisticsJob] : undefined;
    if (j?.owner === s.owner && j.ship === s.id) { const tracked = j.carried; detach(h, j, reason); if (!isTerminal(j)) { if (j.procurement && tracked > 0) { delete j.procurementSuspended; j.state = 'paused'; j.reason = '수동 명령으로 조달 화물이 함선에 남았습니다 — 화물을 확인한 뒤 작업을 재개하거나 취소하세요'; } else if (j.state !== 'paused') j.state = 'queued'; } }
    else delete s.logisticsJob;
  }
}
export function setPoolShips(h: Host, owner: string, ids: string[], on: boolean): string | null {
  if (!growthOn(h.st) || !Array.isArray(ids) || !ids.length || ids.length > 500 || typeof on !== 'boolean' || ids.some(id => typeof id !== 'string')) return '자사 수송 함선을 선택하세요';
  const ships = [...new Set(ids)].map(id => h.st.ships[id]);
  if (ships.some(s => !s || s.owner !== owner)) return '자사 함선만 설정할 수 있습니다';
  if (autoLogistics(h.st)) {
    // P12.5: every idle cargo ship already hauls; this only excludes (off) or re-includes (on) ships
    if (on && (ships as WShip[]).some(s => econOf(s).cargo <= 0 || s.classId === 'miner' || s.classId === 'constructor')) return '화물칸이 있는 수송 함선만 자동 물류에 포함할 수 있습니다';
    for (const s of ships as WShip[]) { if (on) { delete s.logisticsExcluded; if (econOf(s).military) s.logisticsPool = true; } else { s.logisticsExcluded = true; delete s.logisticsPool; } }
    if (!on) interruptPoolShips(h, ships as WShip[], '자동 물류에서 제외됨 — 기존 화물은 함선에 보존', false);
    return null;
  }
  if (on) for (const s of ships as WShip[]) {
    const g = h.st.groups[s.groupId];
    if (!g || h.opOf(g).k !== 'idle' || s.state === 'battle' || s.state === 'building' || econOf(s).cargo <= 0 || econOf(s).military || s.classId === 'constructor' || s.classId === 'miner' || s.reserve || s.listed || s.cargoWork || Object.values(h.st.logistics ?? {}).some(r => r.owner === owner && !!r.manifests[s.id])) return '대기 중인 수송 함선만 참여할 수 있습니다. 채굴·건설·전투·기존 노선과 화물 작업을 먼저 정리하세요';
  }
  if (on) for (const s of ships as WShip[]) s.logisticsPool = true;
  else interruptPoolShips(h, ships as WShip[], '공용 배차에서 제외됨 — 기존 화물은 함선에 보존');
  return null;
}
export function controlPoolJob(h: Host, owner: string, id: string, action: 'pause' | 'resume' | 'cancel'): string | null {
  const j = h.st.logisticsJobs?.[id];
  if (!j || j.owner !== owner || !['pause', 'resume', 'cancel'].includes(action)) return '자사 작업과 동작을 선택하세요';
  if (j.held && action !== 'cancel') {
    // P12.5: a held shipment resumes with its own ship; the player can only allow or stop that
    j.held.auto = action === 'resume';
    j.reason = action === 'resume' ? '함선이 대기 상태로 돌아오면 같은 함선으로 자동 재개 — 화물 보존' : '플레이어가 일시정지함 — 적재된 화물은 함선에 보존'; j.updated = h.time; return null;
  }
  if (action === 'resume') {
    if (j.state !== 'paused') return '일시정지된 작업만 재개할 수 있습니다';
    if (j.procurementSuspended && j.procurement) {
      const p = h.st.procurementPlans?.[j.procurement], st = p && h.st.stations[p.station], policy = h.st.companies[owner]?.procurement;
      const origin = p?.sourceKind === 'construction' ? st?.modules.find(m => m.id === p.sourceId && !m.built) : p?.sourceKind === 'production' ? st?.orders?.find(o => o.id === p.sourceId) : p?.sourceKind === 'ship' ? st?.builds?.find(b => b.id === p.sourceId && !b.started) : undefined;
      if (!p || !origin || origin.paused || policy?.enabled === false || policy?.disabled[JSON.stringify([p.station, p.sourceKind, p.sourceId])]) return '원본 작업의 자동 조달을 먼저 재개하세요';
    }
    const err = problem(h, owner, j, !!j.procurement, j.reserved, !!j.ship && j.carried > EPS); if (err) return err;
    j.state = j.ship ? 'active' : 'queued'; delete j.reason; delete j.retryAt; delete j.code; delete j.procurementSuspended;
  } else if (action === 'pause') {
    if (isTerminal(j)) return '완료되거나 취소된 작업입니다';
    if (!j.carried && j.ship) detach(h, j, '플레이어가 일시정지함');
    const s = j.ship && h.st.ships[j.ship]; if (s && s.state !== 'battle') { s.vel = { x: 0, y: 0, z: 0 }; delete s.warp; if (s.cargoWork?.key.startsWith(`pool:${j.id}:`)) delete s.cargoWork; }
    if (j.ship) clearWait(h, j, s || undefined);
    j.state = 'paused'; j.reason = '플레이어가 일시정지함 — 적재된 화물은 함선에 보존';
  } else {
    if (isTerminal(j)) return '완료되거나 취소된 작업입니다';
    detach(h, j, '취소됨 — 이미 적재된 화물은 함선에 보존'); j.state = 'cancelled'; delete j.procurementSuspended;
  }
  j.updated = h.time; return null;
}
function path(h: Host, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, maxRisk?: number): boolean {
  const a = h.sysOf(from), b = h.sysOf(to);
  return !!a && !!b && (maxRisk === undefined || 100 - effSec(b) <= maxRisk) && (a.id === b.id || !!nextGate(h.st.systems, a.id, b.id, gate => usableRouteGate(h.st, gate) && (maxRisk === undefined || 100 - effSec(h.st.systems[gate.to]) <= maxRisk)));
}
function pickupDistance(h: Host, s: WShip, source: Station): number {
  const a = h.sysOf(s.pos), b = h.sysOf(source.pos);
  if (!a || !b) return Infinity;
  return a.id === b.id ? dist(s.pos, source.pos) : jumps(h.st.systems, a.id, b.id) * 200000 + dist(s.pos, a.origin) + dist(source.pos, b.origin);
}
function free(h: Host, s: WShip, held?: Set<string>): boolean {
  if (held) return haulerAvailability(h, s).ok && !routeShip(h, s) && !held.has(s.id);
  const g = h.st.groups[s.groupId];
  return !!s.logisticsPool && !s.logisticsJob && !!g && !g.fleeing && h.opOf(g).k === 'idle' && s.state !== 'battle' && s.state !== 'building' && s.hp > 0 && !s.reserve && !s.listed && !s.cargoWork && econOf(s).cargo * techFx(h.st.companies[s.owner]?.tech).cargoMul - cargoSum(s.cargo) > EPS && !Object.values(h.st.logistics ?? {}).some(r => !!r.manifests[s.id]);
}
const routeShip = (h: Host, s: WShip) => Object.values(h.st.logistics ?? {}).some(r => !!r.manifests[s.id]);
/** ships whose tracked cargo belongs to a held shipment (they resume it, nothing else) */
function heldShips(h: Host): Set<string> {
  const set = new Set<string>(); for (const j of Object.values(h.st.logisticsJobs ?? {})) if (j.held && !isTerminal(j)) set.add(j.held.ship);
  return set;
}
/** P12.5: an available ship carrying untracked cargo delivers it before taking new work (never creates goods). */
function stowCargo(h: Host, held: Set<string>) {
  for (const s of Object.values(h.st.ships)) {
    if (s.logisticsJob || held.has(s.id) || cargoSum(s.cargo) <= EPS || !haulerAvailability(h, s, false).ok || routeShip(h, s)) continue;
    const item = cargoKeys(s.cargo).find(k => qty(s.cargo, k) > EPS); if (!item) continue;
    const amount = qty(s.cargo, item), berth = econOf(s).berth;
    const fits = (st: Station | undefined) => !!st && h.canDock(st, s.owner) && berthFits(st, berth) && h.intakeRoom(st, s.owner, item, false) > EPS && path(h, s.pos, st.pos);
    const pref = s.logisticsStow ? h.st.stations[s.logisticsStow] : undefined;
    const dest = fits(pref) ? pref! : Object.values(h.st.stations).filter(st => st.owner === s.owner && fits(st)).sort((a, b) => pickupDistance(h, s, a) - pickupDistance(h, s, b) || a.id.localeCompare(b.id))[0]
      ?? Object.values(h.st.stations).filter(st => fits(st) && Object.hasOwn(st.storage, s.owner)).sort((a, b) => pickupDistance(h, s, a) - pickupDistance(h, s, b) || a.id.localeCompare(b.id))[0];
    if (!dest) continue;
    const job: LogisticsJob = { id: h.id('lj'), owner: s.owner, from: dest.id, to: dest.id, item, kind: 'transfer', amount, priority: 9, repeat: false, created: h.time, updated: h.time, state: 'active', ship: s.id, reserved: 0, carried: amount, delivered: 0, cycleDelivered: 0, lost: 0, withdrawn: 0, earned: 0, cycles: 0, stow: true };
    (h.st.logisticsJobs ??= {})[job.id] = job; s.logisticsJob = job.id; delete s.logisticsStow;
    emit(h.st, { kind: 'logistics', reason: 'stow', amount, company: s.owner, group: s.groupId, ship: s.id, station: dest.id, item });
  }
}
/** Slow, bounded fallback scan; assigned work is never reconsidered for a closer ship. */
export function dispatchPool(h: Host) {
  const held = autoLogistics(h.st) ? heldShips(h) : undefined;
  if (held) stowCargo(h, held);
  const jobs = Object.values(h.st.logisticsJobs ?? {}).filter(j => !j.ship && j.reserved <= EPS && (j.state === 'queued' || j.state === 'waiting')).sort((a, b) => Math.min(9, b.priority + Math.floor((h.time - b.created) / 300)) - Math.min(9, a.priority + Math.floor((h.time - a.created) / 300)) || a.created - b.created || a.id.localeCompare(b.id));
  if (!jobs.length) return;
  const ships = Object.values(h.st.ships).filter(s => free(h, s, held)).sort((a, b) => a.id.localeCompare(b.id));
  for (const j of jobs) {
    const a = h.st.stations[j.from], b = h.st.stations[j.to];
    const maxRisk = j.procurement || j.sale ? h.st.companies[j.owner]?.procurement?.maxRisk ?? 100 : undefined;
    const external = !!a && !!j.procurement && !h.canDock(a, j.owner) && !a.public && a.owner !== j.owner && qty(a.storage[j.owner], j.item) > EPS;
    if (!a || !b || (!h.canDock(a, j.owner) && !external) || (j.kind === 'construction' ? b.owner !== j.owner : !h.canDock(b, j.owner))) { j.state = 'waiting'; j.reason = '정거장 또는 이용 권한을 확인하세요'; j.code = 'station'; continue; }
    // AUTO-P0: a sale shipment (manual or automatic) leaves the common stock floor (minimum stock, stockpile goals, industry needs)
    const protectedAmount = j.kind === 'sell' ? stockFloor(h, j.owner, a, j.item) : j.procurement ? h.st.companies[j.owner]?.procurement?.protectedStock?.[a.id]?.[j.item] ?? 0 : 0;
    const freeStock = Math.max(0, qty(a.storage[j.owner], j.item) - protectedAmount);
    if (freeStock <= EPS) { j.state = 'waiting'; j.reason = j.kind === 'sell' && protectedAmount > 0 ? '출발지 재고가 최소 비축·생산 예약 이하 — 초과분이 생기면 자동 재시도' : '출발지 자유 재고 부족 또는 보호 재고 — 재고가 생기면 자동 재시도'; j.code = 'source'; continue; }
    if (j.kind === 'construction' && constructionRoom(b, j.item, true) - incomingRoutes(h, j.owner, j.to, j.item) - incomingPool(h.st, j.owner, j.to, j.item) <= EPS) { j.state = 'waiting'; j.reason = '현장 필요량 확보 또는 운송 중 — 추가 수요 대기'; j.code = 'construction'; continue; }
    if (!path(h, a.pos, b.pos, maxRisk)) { j.state = 'waiting'; j.reason = '허용된 점프 경로가 없습니다 — 경로 또는 위험 제한을 확인하세요'; j.code = 'path'; continue; }
    const candidates = ships.filter(s => s.owner === j.owner && (external || berthFits(a, econOf(s).berth)) && (j.kind === 'construction' || berthFits(b, econOf(s).berth)) && path(h, s.pos, a.pos, maxRisk));
    candidates.sort((x, y) => pickupDistance(h, x, a) - pickupDistance(h, y, a) || x.id.localeCompare(y.id));
    const s = candidates[0];
    if (!s) { j.state = 'waiting'; j.reason = h.st.logisticsV ? '수송선 대기 — 모든 수송선이 운송 중이거나 정박 규격·경로가 맞지 않습니다. 수송선이 비면 자동 배정' : '적합한 공용 수송 함선 대기 — 참여 설정, 정박 규격 및 경로 확인'; j.code = 'ship'; continue; }
    let amount = Math.min(j.amount - j.cycleDelivered, Math.max(0, econOf(s).cargo * techFx(h.st.companies[j.owner]?.tech).cargoMul - cargoSum(s.cargo)), freeStock);
    if (j.kind === 'construction') amount = Math.min(amount, Math.max(0, constructionRoom(b, j.item, true) - incomingRoutes(h, j.owner, j.to, j.item) - incomingPool(h.st, j.owner, j.to, j.item)));
    if (j.kind !== 'construction') amount = Math.floor(amount + EPS);
    if (amount <= EPS) { j.state = 'waiting'; j.code = 'source'; j.reason = '적재 가능한 자유 재고 또는 현장 필요량 대기'; continue; }
    j.reserved = takec(h.storage(a, j.owner), j.item, amount);
    ships.splice(ships.indexOf(s), 1); s.logisticsJob = j.id; j.ship = s.id; j.state = 'active'; j.updated = h.time; delete j.reason; delete j.code; delete j.retryAt; delete j.attempts;
  }
}
/** Reconcile disappeared ships and non-command state changes, including after JSON restore. */
export function maintainPool(h: Host) {
  for (const j of Object.values(h.st.logisticsJobs ?? {})) {
    if (!j.ship && j.held && !isTerminal(j)) { maintainHeld(h, j); continue; }
    if (!j.ship) { if (j.reserved > EPS) releaseReservation(h, j); continue; }
    const s = h.st.ships[j.ship];
    if (!s || s.owner !== j.owner) { detach(h, j, '수송 함선 손실 — 미완료 물량 재배차 대기', !s); if (!isTerminal(j) && j.state !== 'paused') j.state = 'queued'; continue; }
    const g = h.st.groups[s.groupId];
    if (autoLogistics(h.st) && j.carried > EPS && !j.stow && s.logisticsJob === j.id && poolMember(h.st, s) && g && (h.opOf(g).k !== 'idle' || s.reserve || s.listed)) { hold(h, j, s, '함선이 다른 작업에 사용됨'); continue; }
    if (!poolMember(h.st, s) || s.logisticsJob !== j.id || !g || h.opOf(g).k !== 'idle' || s.state === 'building' || s.reserve || s.listed) { const tracked = j.carried; detach(h, j, '함선이 다른 작업에 사용됨 — 화물 보존, 미완료 물량 재배차'); if (!isTerminal(j)) { if (j.procurement && tracked > 0) { delete j.procurementSuspended; j.state = 'paused'; j.reason = '조달 화물이 함선에 남았습니다 — 화물을 확인한 뒤 작업을 재개하거나 취소하세요'; } else if (j.state !== 'paused') j.state = 'queued'; } }
  }
}
/** P12.5: account for a held shipment's ship and cargo; rejoin the same ship once it is idle again. */
function maintainHeld(h: Host, j: LogisticsJob) {
  const s = h.st.ships[j.held!.ship];
  if (!s || s.owner !== j.owner) {
    if (j.carried > EPS) emit(h.st, { kind: 'logistics', reason: 'aborted', amount: j.carried, company: j.owner, ship: j.held!.ship, item: j.item });
    if (!s) j.lost += j.carried; else j.withdrawn += j.carried;
    j.carried = 0; delete j.held; delete j.code; j.state = 'queued'; j.reason = !s ? '수송 함선 손실 — 남은 필요량 재배차' : '함선 소유권 변경 — 남은 필요량 재배차'; j.updated = h.time; return;
  }
  const present = Math.min(j.carried, qty(s.cargo, j.item));
  if (present < j.carried - EPS) { j.withdrawn += j.carried - present; j.carried = present; j.updated = h.time; }
  if (j.carried <= EPS) { j.carried = 0; delete j.held; delete j.code; j.state = 'queued'; j.reason = '화물이 작업에서 회수됨 — 잔량 재배차'; return; }
  if (!j.held!.auto) return;
  const g = h.st.groups[s.groupId];
  if (!poolMember(h.st, s) || s.logisticsJob || !g || h.opOf(g).k !== 'idle' || s.state === 'building' || s.reserve || s.listed || s.cargoWork) return;
  s.logisticsJob = j.id; j.ship = s.id; delete j.held; delete j.code; delete j.reason; j.state = 'active'; j.updated = h.time;
  emit(h.st, { kind: 'logistics', reason: 'resumed', amount: j.carried, company: j.owner, group: s.groupId, ship: s.id, item: j.item });
}
function wait(h: Host, j: LogisticsJob, s: WShip, code: string, reason: string) {
  if (j.code !== code) { j.attempts = 0; emit(h.st, { kind: 'logistics', reason: `blocked:${reason}`, amount: 0, company: j.owner, group: s.groupId, ship: s.id, station: j.carried ? j.to : j.from }); }
  j.state = 'waiting'; j.code = code; j.reason = reason; j.attempts = (j.attempts ?? 0) + 1; j.retryAt = h.time + Math.min(15, 2 + j.attempts * 2); s.vel = { x: 0, y: 0, z: 0 }; delete s.warp;
}
/** Active shipments and legacy route manifests both count against construction demand. */
export function incomingPool(w: Pick<WorldState, 'logisticsJobs'>, owner: string, to: string, item: string): number {
  return Object.values(w.logisticsJobs ?? {}).reduce((n, j) => n + (j.owner === owner && j.to === to && j.item === item && j.kind !== 'sell' && j.state !== 'cancelled' ? j.carried + j.reserved : 0), 0);
}
export function stepPoolShip(h: Host, s: WShip, g: WGroup, dt: number, speed: number): boolean {
  const j = s.logisticsJob && h.st.logisticsJobs?.[s.logisticsJob];
  if (!j || j.owner !== s.owner || j.ship !== s.id) return false;
  if (j.state === 'paused') return true;
  if (isTerminal(j)) return true;
  if ((j.retryAt ?? 0) > h.time || j.lastAction === h.time) return true;
  const held = s.state === 'docked' && departureHeld(h.st, s); if (held) { wait(h, j, s, 'held', held); return true; }
  const station = h.st.stations[j.carried > EPS ? j.to : j.from], site = j.carried > EPS && j.kind === 'construction';
  const externalPickup = !!station && j.carried <= EPS && !!j.procurement && !h.canDock(station, j.owner) && !station.public && station.owner !== j.owner && j.reserved > EPS;
  if (!station || (site ? station.owner !== j.owner : !h.canDock(station, j.owner) && !externalPickup)) { wait(h, j, s, 'station', '정거장을 이용할 수 없습니다 — 권한과 시설을 확인하세요'); return true; }
  if (!site && !externalPickup && !berthFits(station, econOf(s).berth)) { wait(h, j, s, 'berth', '정박 규격 부족 — 시설이나 함선을 확인하세요'); return true; }
  const limit = !site && !externalPickup ? stationBerths(station) : undefined;
  if (limit !== undefined && !(s.state === 'docked' && s.task.k === 'docked' && s.task.station === station.id) && occupiedBerths(h.st, station.id, s.id) >= limit) { wait(h, j, s, 'berth_full', '정박 공간 부족 — 다른 함선이 출항하면 자동 재개'); return true; }
  if (!path(h, s.pos, station.pos, j.procurement || j.sale ? h.st.companies[j.owner]?.procurement?.maxRisk ?? 100 : undefined)) { wait(h, j, s, 'path', '허용된 점프 경로가 없습니다 — 경로 또는 위험 제한 회복 대기'); return true; }
  clearWait(h, j, s); j.state = 'active'; delete j.reason;
  if (!(site || externalPickup ? h.goConstruction(s, station, dt, speed) : h.goDock(s, station, dt, speed, true, true))) return true;
  if (j.carried > EPS) {
    const present = Math.min(j.carried, qty(s.cargo, j.item));
    if (present < j.carried) { j.withdrawn += j.carried - present; j.carried = present; }
    if (j.carried <= EPS) { detach(h, j, '화물이 작업에서 회수됨 — 잔량 재배차'); j.state = 'queued'; return true; }
    let moved = 0;
    if (j.kind === 'sell') {
      if (!station.market?.[j.item]) { wait(h, j, s, 'market', '시장 수요 없음 — 시장 회복 대기'); return true; }
      const result = watchMoney(h.st, 'market_sale', { company: j.owner, group: g.id, ship: s.id, station: station.id, item: j.item }, () => h.sellAt(station, j.owner, j.item, j.carried));
      moved = result.sold; j.earned += result.value; if (moved > 0) takec(s.cargo, j.item, moved);
    } else {
      const desired = Math.min(j.carried, j.procurement ? Math.max(0, j.amount - j.cycleDelivered) : Infinity, h.intakeRoom(station, j.owner, j.item, site), site ? constructionRoom(station, j.item, true) : Infinity);
      const permit = h.cargoPermit(s, station, `pool:${j.id}:unload`, desired); if (permit === null) return true;
      moved = Math.min(desired, permit); if (moved > 0) { takec(s.cargo, j.item, moved); addc(h.storage(station, j.owner), j.item, moved); }
    }
    j.carried -= moved; j.delivered += moved; j.cycleDelivered += moved; j.updated = h.time;
    if (moved > 0) { j.lastAction = h.time; emit(h.st, { kind: 'logistics', reason: 'unload', amount: moved, company: j.owner, group: g.id, ship: s.id, station: station.id, item: j.item }); }
    if (j.procurement && j.cycleDelivered + EPS >= j.amount && j.carried > EPS) { j.withdrawn += j.carried; j.reason = '수요 감소로 남은 화물은 함선에 보존'; j.carried = 0; }
    if (j.carried > EPS) { wait(h, j, s, j.kind === 'sell' ? 'budget' : site ? 'construction' : 'storage', j.kind === 'sell' ? '시장 예산 부족 — 화물 보존·자동 재시도' : site ? '건설 현장의 필요량 또는 공간 부족 — 화물 보존·자동 재시도' : '목적지 창고 가득 — 공간 확보 후 자동 재개'); return true; }
    delete s.logisticsJob; delete j.ship; j.carried = 0;
    if (j.cycleDelivered + EPS >= j.amount) { j.cycles++; if (j.repeat) { j.cycleDelivered = 0; j.state = 'queued'; } else j.state = 'complete'; }
    else j.state = 'queued';
    return true;
  }
  const cap = econOf(s).cargo * techFx(h.st.companies[j.owner]?.tech).cargoMul;
  let amount = Math.min(j.reserved, j.procurement ? Math.max(0, j.amount - j.cycleDelivered) : Infinity, Math.max(0, cap - cargoSum(s.cargo)));
  if (j.kind === 'construction') {
    const dest = h.st.stations[j.to];
    if (!dest || dest.owner !== j.owner) { wait(h, j, s, 'station', '자사 건설 현장을 이용할 수 없습니다 — 시설과 소유권을 확인하세요'); return true; }
    amount = Math.min(amount, Math.max(0, constructionRoom(dest, j.item, true) - incomingRoutes(h, j.owner, j.to, j.item) - incomingPool(h.st, j.owner, j.to, j.item) + j.reserved));
  }
  if (j.kind !== 'construction') amount = Math.floor(amount + EPS);
  if (amount <= EPS) { detach(h, j, '출발지 자유 재고, 화물 공간 또는 현장 필요량 부족 — 조건 회복 대기'); j.state = 'waiting'; j.code = j.kind === 'construction' ? 'construction' : 'source'; return true; }
  const permit = h.cargoPermit(s, station, `pool:${j.id}:load`, amount); if (permit === null) return true;
  const loaded = Math.min(j.reserved, amount, permit);
  if (loaded <= EPS) { wait(h, j, s, 'source', '출발지 자유 재고 부족 — 재고 회복 대기'); return true; }
  j.reserved -= loaded; releaseReservation(h, j);
  addc(s.cargo, j.item, loaded); j.carried = loaded; j.lastAction = h.time; j.updated = h.time;
  emit(h.st, { kind: 'logistics', reason: 'depart', amount: loaded, company: j.owner, group: g.id, ship: s.id, station: station.id, item: j.item });
  return true;
}
