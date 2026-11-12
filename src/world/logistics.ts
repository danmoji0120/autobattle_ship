// Authoritative managed transport. Uses the existing docking, gates, stock, market and upkeep paths.
import { gateOpen } from './territory';
import type { WorldSim } from './sim';
import type { WorldState, WShip, WGroup, Gate } from './types';
import { cargoSum, qty, takec, addc } from './types';
import { econOf, growthOn, berthFits } from './hullops';
import { ITEMS, EQUIPMENT, recipeFor, techFx } from './industry';
import { orderWants } from './production';
import { nextGate } from './geom';
import { departureHeld } from './upkeep';
import { emit, watchMoney } from './observe';
import { constructionRoom } from './storage';
import { incomingPool } from './autonomousLogistics';

export interface RouteConfig {
  name: string; from: string; to: string; item: string;
  mode: 'transfer' | 'sell' | 'supply' | 'construction'; amount: number; repeat: boolean;
  minStock?: number; targetStock?: number;
}
export interface RouteCursor {
  phase: 'source' | 'destination' | 'waiting' | 'complete';
  reason?: string; code?: string; station?: string; since?: number; retryAt?: number; attempts?: number;
  lastAction?: number;
}
export interface RouteManifest { from: string; to: string; item: string; mode: RouteConfig['mode']; amount: number; targetStock?: number; loadedAt: number }
export interface RouteStats { loaded: number; delivered: number; sold: number; earned: number; trips: number; lost: number; withdrawn?: number }
export interface LogisticsRoute {
  id: string; owner: string; group: string; config: RouteConfig;
  state: 'running' | 'paused' | 'complete'; reason?: string; created: number; updated: number;
  manifests: Record<string, RouteManifest>; cursors: Record<string, RouteCursor>; done: string[];
  replenishing?: boolean; stats: RouteStats; recent: ({ t: number } & RouteStats)[];
}
type Host = Pick<WorldSim, 'st' | 'time' | 'id' | 'opOwner' | 'subtreeShips' | 'shipsOf' | 'canDock' | 'storage' | 'sysOf' | 'intakeRoom' | 'goDock' | 'goConstruction' | 'cargoPermit' | 'undock' | 'sellAt' | 'ev'>;
export const routeShips = (w: Pick<WorldState, 'ships' | 'groups'>, route: Pick<LogisticsRoute, 'group' | 'owner'>): WShip[] => {
  const out: WShip[] = [], root = w.groups[route.group]; if (!root) return out;
  const walk = (g: WGroup) => { for (const id of g.shipIds) { const s = w.ships[id]; if (s?.owner === route.owner && econOf(s).cargo > 0) out.push(s); } for (const id of g.childIds) { const child = w.groups[id]; if (child && !child.override) walk(child); } }; walk(root); return out;
};
export function routeLabel(route: LogisticsRoute): { state: 'paused' | 'complete' | 'waiting' | 'running'; text: string } {
  if (route.state === 'paused') return { state: 'paused', text: route.reason ?? '플레이어가 일시정지함' };
  if (route.state === 'complete') return { state: 'complete', text: '편도 운송 완료' };
  const blocked = Object.values(route.cursors).find(c => !!c.code);
  if (blocked) return { state: 'waiting', text: blocked.reason ?? '조건 회복 대기' };
  return { state: 'running', text: Object.keys(route.manifests).length ? '화물 운송 중' : '출발지 이동·적재 대기' };
}
function resetCursor(c: RouteCursor, phase: RouteCursor['phase']) { c.phase = phase; delete c.code; delete c.reason; delete c.since; delete c.retryAt; delete c.attempts; delete c.station; }
function block(h: Host, r: LogisticsRoute, s: WShip, c: RouteCursor, code: string, reason: string, station?: string) {
  const changed = c.code !== code || c.station !== station;
  if (changed) { c.since = h.time; c.attempts = 0; emit(h.st, { kind: 'logistics', reason: `blocked:${reason}`, amount: 0, company: r.owner, group: s.groupId, ship: s.id, route: r.id, station }); }
  c.code = code; c.reason = reason; c.station = station; c.phase = 'waiting'; c.attempts = (c.attempts ?? 0) + 1;
  c.retryAt = h.time + Math.min(15, 2 + c.attempts * 2); s.vel = { x: 0, y: 0, z: 0 }; delete s.warp;
  const g = h.st.groups[s.groupId]; if (g) g.status = reason;
}
function pause(h: Host, r: LogisticsRoute, reason: string) {
  if (r.state === 'paused' && r.reason === reason) return;
  r.state = 'paused'; r.reason = reason; r.updated = h.time;
  for (const s of routeShips(h.st, r)) { if (s.cargoWork?.key.startsWith(`route:${r.id}:`)) delete s.cargoWork; emit(h.st, { kind: 'logistics', reason: 'resumed', amount: 0, company: r.owner, group: s.groupId, ship: s.id, route: r.id }); }
}
function bind(h: Host, r: LogisticsRoute) {
  const g = h.st.groups[r.group]; g.op = { k: 'haul', from: r.config.from, to: r.config.to, res: r.config.item, route: r.id }; g.override = true; g.fleeing = false; delete g.march;
}
/** Largest current batch input, respecting paused, finished and already satisfied orders. */
export function supplyBatch(st: import('./types').Station | undefined, item: string, world?: { regionalV?: number }): number {
  if (!st) return 0; let need = 0;
  for (const order of st.orders ?? []) { const recipe = recipeFor(world, order.recipe); if (!order.paused && recipe && !orderWants(order, st.storage[st.owner] ?? {}, st.jobs ?? [])) need = Math.max(need, recipe.in[item] ?? 0); }
  return need;
}
/** External collection exposes only the requesting company's already-owned stock. */
function canCollect(h: Host, station: import('./types').Station, owner: string, group: string, item: string): boolean {
  if (station.public || station.owner === owner) return false;
  const stock = station.storage[owner];
  if (stock && Object.hasOwn(stock, item) && Number.isFinite(stock[item]) && stock[item] > 0) return true;
  // An already-authorized route may wait for more stock, even after its last shipment was delivered.
  return Object.values(h.st.logistics ?? {}).some(r => r.owner === owner && r.group === group && r.config.from === station.id && r.config.item === item);
}
function configError(h: Host, owner: string, group: string, c: RouteConfig): string | null {
  if (!growthOn(h.st)) return '이 월드에서는 관리형 물류 노선을 사용할 수 없습니다';
  const g = h.st.groups[group]; if (!g || g.owner !== owner) return '자사 편대를 선택하세요';
  if (!c || typeof c.from !== 'string' || typeof c.to !== 'string' || !Object.hasOwn(h.st.stations, c.from) || !Object.hasOwn(h.st.stations, c.to) || c.from === c.to) return '서로 다른 출발지·목적지를 선택하세요';
  const a = h.st.stations[c.from], b = h.st.stations[c.to];
  if (!['transfer', 'sell', 'supply', 'construction'].includes(c.mode)) return '운송 목적을 선택하세요';
  if (typeof c.item !== 'string' || (!Object.hasOwn(ITEMS, c.item) && !Object.hasOwn(EQUIPMENT, c.item) && !c.item.startsWith('bp:') && !c.item.startsWith('bpf:'))) return '운송할 품목을 선택하세요';
  const external = !h.canDock(a, owner) && canCollect(h, a, owner, group, c.item);
  if ((!h.canDock(a, owner) && !external) || (c.mode === 'construction' ? b.owner !== owner : !h.canDock(b, owner))) return c.mode === 'construction' ? '출발지는 이용 가능한 정거장, 목적지는 자사 건설 현장이어야 합니다' : '이용 가능한 정거장을 선택하세요 (자사 코어 완공 필요)';
  if (typeof c.repeat !== 'boolean') return '반복 운송 여부를 지정하세요';
  if (!Number.isSafeInteger(c.amount) || c.amount < 1) return '회당 적재량은 1 이상의 정수여야 합니다';
  const carriers = routeShips(h.st, { group, owner });
  if (!carriers.length) return '편대에 화물 적재 함선이 없습니다';
  if (carriers.some(s => s.state === 'building')) return '건설 중인 함선은 작업을 정리한 후 배정하세요';
  if (carriers.some(s => !external && !berthFits(a, econOf(s).berth) || c.mode !== 'construction' && !berthFits(b, econOf(s).berth))) return '이 편대의 선체가 이용할 수 없는 정박 규격입니다';
  if (c.mode === 'sell' && !b.market?.[c.item]) return '목적지 시장에서 이 품목을 매입하지 않습니다';
  if (c.mode === 'supply') {
    if (b.owner !== owner) return '생산 공급 목적지는 자사 정거장이어야 합니다';
    if (![a, b].some(st => st.owner === owner && st.modules.some(m => m.kind === 'logistics' && m.built))) return '생산 공급에는 출발지 또는 목적지 물류센터가 필요합니다';
    if (!Number.isSafeInteger(c.minStock) || c.minStock! < 0 || !Number.isSafeInteger(c.targetStock) || c.targetStock! <= c.minStock!) return '공급 재고 기준은 0 ≤ 보충 시작 < 목표 재고의 정수여야 합니다';
  }
  return null;
}
export function putRoute(h: Host, owner: string, group: string, config: RouteConfig, id?: string): string | null {
  const existing = id ? h.st.logistics?.[id] : undefined;
  if (id && (!existing || existing.owner !== owner)) return '자사 노선이 아닙니다';
  if (existing && existing.group !== group) return '편대 변경은 기존 노선을 취소한 후 새로 설정하세요 — 화물은 보존됩니다';
  const error = configError(h, owner, group, config); if (error) return error;
  const competing = Object.values(h.st.logistics ?? {}).find(r => r.owner === owner && r.group === group && r.id !== id);
  if (competing) return '이 편대에 이미 노선이 있습니다 — 기존 노선을 수정하거나 취소하세요';
  if (existing && Object.values(existing.manifests).some(m => m.amount > 0) && (existing.config.item !== config.item || existing.config.mode !== config.mode)) return '운송 중에는 품목·판매 방식을 바꿀 수 없습니다 — 현재 화물을 배송하거나 노선을 취소한 뒤 변경하세요';
  const clean: RouteConfig = { name: String(config.name ?? '').trim().slice(0, 40) || `${h.st.stations[config.from].name} → ${h.st.stations[config.to].name}`, from: config.from, to: config.to, item: config.item, mode: config.mode, amount: config.amount, repeat: !!config.repeat, ...(config.mode === 'supply' ? { minStock: config.minStock, targetStock: config.targetStock } : {}) };
  const r: LogisticsRoute = existing ?? { id: h.id('lr'), owner, group, config: clean, state: 'running', created: h.time, updated: h.time, manifests: {}, cursors: {}, done: [], stats: { loaded: 0, delivered: 0, sold: 0, earned: 0, trips: 0, lost: 0, withdrawn: 0 }, recent: [] };
  if (!existing) pauseManualRoutes(h, manualRoutes(h, owner, group));
  r.replenishing = false; r.config = clean; r.updated = h.time;
  const op = h.st.groups[group].op; if (op.k === 'haul' && op.route === r.id) { op.from = clean.from; op.to = clean.to; op.res = clean.item; }
  for (const m of Object.values(r.manifests)) { m.to = clean.to; m.targetStock = clean.targetStock; }
  if (!existing) { (h.st.logistics ??= {})[r.id] = r; bind(h, r); }
  else for (const c of Object.values(r.cursors)) delete c.retryAt;
  return null;
}
export function controlRoutes(h: Host, owner: string, ids: string[], action: 'pause' | 'resume' | 'cancel'): string | null {
  if (!growthOn(h.st) || !Array.isArray(ids) || !ids.length || !['pause', 'resume', 'cancel'].includes(action)) return '노선과 동작을 선택하세요';
  const routes = [...new Set(ids)].map(id => h.st.logistics?.[id]);
  if (routes.some(r => !r || r.owner !== owner)) return '자사 노선만 변경할 수 있습니다';
  if (action === 'resume') for (const r of routes) { const error = configError(h, owner, r!.group, r!.config); if (error) return error; }
  for (const r of routes as LogisticsRoute[]) {
    if (action === 'pause') { pause(h, r, '플레이어가 일시정지함'); for (const s of routeShips(h.st, r)) if (s.state !== 'battle') { s.vel = { x: 0, y: 0, z: 0 }; delete s.warp; } }
    else if (action === 'resume') { const restart = r.state === 'complete' || routeShips(h.st, r).every(s => r.done.includes(s.id)); r.state = 'running'; delete r.reason; if (restart) r.done = []; for (const c of Object.values(r.cursors)) { delete c.retryAt; delete c.code; } bind(h, r); r.updated = h.time; }
    else { const g = h.st.groups[r.group]; if (g?.op.k === 'haul' && g.op.route === r.id) { for (const s of routeShips(h.st, r)) { if (s.cargoWork?.key.startsWith(`route:${r.id}:`)) delete s.cargoWork; if (s.state !== 'battle') { s.vel = { x: 0, y: 0, z: 0 }; delete s.warp; } } g.op = { k: 'idle' }; g.status = '노선 취소 — 화물 보존'; } delete h.st.logistics![r.id]; }
  }
  return null;
}
/** Capture affected routes before a manual command replaces an inherited order. */
export function manualRoutes(h: Host, owner: string, group?: string, ship?: string): LogisticsRoute[] {
  const groups = [group ? h.st.groups[group] : undefined, ship ? h.st.groups[h.st.ships[ship]?.groupId] : undefined].filter((g): g is WGroup => !!g && g.owner === owner);
  return Object.values(h.st.logistics ?? {}).filter(r => r.owner === owner && groups.some(g => { const root = h.opOwner(g), op = root.op; return r.group === g.id || op.k === 'haul' && op.route === r.id; }));
}
export function pauseManualRoutes(h: Host, routes: LogisticsRoute[]) { for (const r of routes) pause(h, r, '수동 명령 우선 — 노선을 다시 재개하면 운송 명령으로 전환됩니다'); }
function record(r: LogisticsRoute, time: number, change: Partial<RouteStats>) {
  const t = Math.floor(time / 60) * 60; let recent = r.recent.at(-1);
  if (!recent || recent.t !== t) { recent = { t, loaded: 0, delivered: 0, sold: 0, earned: 0, trips: 0, lost: 0, withdrawn: 0 }; r.recent.push(recent); if (r.recent.length > 60) r.recent.shift(); }
  for (const key of Object.keys(change) as (keyof RouteStats)[]) { r.stats[key] = (r.stats[key] ?? 0) + change[key]!; recent[key] = (recent[key] ?? 0) + change[key]!; }
}
/** A manual partial unload removes tracked cargo immediately, before a same-tick resume. */
export function withdrawRouteCargo(h: Host, owner: string, ship: string, item: string, amount: number) {
  let remaining = amount;
  for (const r of Object.values(h.st.logistics ?? {})) {
    if (remaining <= 1e-9) break;
    const m = r.owner === owner ? r.manifests[ship] : undefined;
    if (!m || m.item !== item) continue;
    // A moved ship may still carry manifests from its old and new routes. One physical removal
    // can reduce their combined tracked quantity only once, in stable route order.
    const withdrawn = Math.min(remaining, m.amount); m.amount -= withdrawn; remaining -= withdrawn;
    if (withdrawn > 0) record(r, h.time, { withdrawn });
    if (m.amount <= 0) delete r.manifests[ship];
  }
}
export function incomingRoutes(h: Host, owner: string, to: string, item: string) {
  let n = 0;
  for (const r of Object.values(h.st.logistics ?? {})) if (r.owner === owner) for (const [id, m] of Object.entries(r.manifests)) { const ship = h.st.ships[id], group = ship && h.st.groups[ship.groupId]; if (ship?.owner === r.owner && group && h.opOwner(group).op.k === 'haul' && (h.opOwner(group).op as { route?: string }).route === r.id && m.mode !== 'sell' && m.to === to && m.item === item) n += Math.min(m.amount, qty(ship.cargo, item)); }
  return n;
}
export function maintainRoutes(h: Host) {
  for (const r of Object.values(h.st.logistics ?? {})) {
    if (!h.st.groups[r.group] || h.st.groups[r.group].owner !== r.owner) { pause(h, r, '배정 편대가 없어졌습니다 — 노선을 취소하고 새 편대에 설정하세요'); continue; }
    const ships = routeShips(h.st, r); r.done = r.done.filter(id => ships.some(s => s.id === id));
    for (const [id, m] of Object.entries(r.manifests)) if (!h.st.ships[id] || h.st.ships[id].owner !== r.owner) { record(r, h.time, h.st.ships[id] ? { withdrawn: m.amount } : { lost: m.amount }); delete r.manifests[id]; delete r.cursors[id]; }
    for (const id of Object.keys(r.cursors)) if (!h.st.ships[id] || !ships.some(s => s.id === id) && !r.manifests[id]) delete r.cursors[id];
    for (const [id, m] of Object.entries(r.manifests)) { const ship = h.st.ships[id]; const present = Math.min(m.amount, qty(ship?.cargo, m.item)); if (present < m.amount) record(r, h.time, { withdrawn: m.amount - present }); m.amount = present; if (!m.amount) delete r.manifests[id]; }
    if (r.state === 'running') for (const ship of ships) { const held = ship.state === 'docked' ? departureHeld(h.st, ship) : null; if (held) { const c = r.cursors[ship.id] ??= { phase: 'waiting' }; if ((c.retryAt ?? 0) <= h.time) block(h, r, ship, c, 'held', held); } }
    if (r.state === 'running' && !ships.length) pause(h, r, '운송 함선이 없습니다 — 함선을 배정한 뒤 재개하세요');
    if (r.state === 'running' && !r.config.repeat && ships.length && ships.every(s => r.done.includes(s.id))) { r.state = 'complete'; r.updated = h.time; }
  }
}
/** a gate a managed route may use: its exit exists and (P10) no border conflict has closed it */
export const usableRouteGate = (w: Pick<WorldState, 'systems' | 'conflicts'>, gate: Gate) => !!w.systems[gate.to]?.gates.some(exit => exit.id === gate.exit) && gateOpen(w, gate);
export function stepRouteShip(h: Host, r: LogisticsRoute, s: WShip, g: WGroup, dt: number, speed: number) {
  if (r.owner !== s.owner || h.opOwner(g).id !== r.group) return;
  if (r.state !== 'running') { g.status = r.state === 'complete' ? '편도 운송 완료' : r.reason ?? '물류 일시정지'; if (s.state !== 'battle') { s.vel = { x: 0, y: 0, z: 0 }; delete s.warp; } return; }
  if (econOf(s).cargo <= 0) return; // unassigned escorts are not given new travel or asset orders
  const c = r.cursors[s.id] ??= { phase: 'source' };
  if (c.lastAction === h.time || (c.retryAt ?? 0) > h.time || (!r.config.repeat && r.done.includes(s.id))) return;
  const held = s.state === 'docked' ? departureHeld(h.st, s) : null;
  if (held) { block(h, r, s, c, 'held', held); return; }
  const m = r.manifests[s.id], conf = m ?? r.config, target = m ? conf.to : conf.from;
  const st = h.st.stations[target];
  const site = !!m && m.mode === 'construction';
  if (!st || (site ? st.owner !== r.owner : !!m && !h.canDock(st, r.owner))) { pause(h, r, `${m ? '목적지' : '출발지'} 정거장을 이용할 수 없습니다 — 설정을 수정하고 재개하세요`); return; }
  const externalPickup = !m && !h.canDock(st, r.owner);
  if (externalPickup && !canCollect(h, st, r.owner, r.group, r.config.item)) { block(h, r, s, c, 'source', '이 정거장에 인수할 자사 재고가 없습니다 — 재고 회복 대기', target); return; }
  if (!site && !externalPickup && !berthFits(st, econOf(s).berth)) { block(h, r, s, c, 'berth', '정박 규격이 부족합니다 — 적합한 함선·정거장으로 변경하세요', target); return; }
  const here = h.sysOf(s.pos), there = h.sysOf(st.pos);
  if (!here || !there || here.id !== there.id && !nextGate(h.st.systems, here.id, there.id, gate => usableRouteGate(h.st, gate))) { block(h, r, s, c, 'path', '연결된 점프 경로가 없습니다 — 게이트 연결 회복 대기', target); return; }
  if (c.code) { emit(h.st, { kind: 'logistics', reason: 'resumed', amount: 0, company: r.owner, group: g.id, ship: s.id, route: r.id }); resetCursor(c, m ? 'destination' : 'source'); }
  c.phase = m ? 'destination' : 'source'; g.status = `${st.name}로 ${m ? '운송' : '적재하러 이동'}`;
  if (!(site || externalPickup ? h.goConstruction(s, st, dt, speed) : h.goDock(s, st, dt, speed, true))) return;
  if (m) {
    m.amount = Math.min(m.amount, qty(s.cargo, m.item));
    let moved = 0, earned = 0;
    if (m.mode === 'sell') {
      if (!st.market?.[m.item]) { block(h, r, s, c, 'market', '이 품목의 시장 수요가 없습니다 — 시장 회복 또는 노선 변경 필요', st.id); return; }
      const result = watchMoney(h.st, 'market_sale', { company: r.owner, group: g.id, ship: s.id, station: st.id, item: m.item, route: r.id }, () => h.sellAt(st, r.owner, m.item, m.amount));
      moved = result.sold; earned = result.value;
      if (moved) { takec(s.cargo, m.item, moved); record(r, h.time, { sold: moved, earned }); }
    } else {
      const targetRoom = m.mode === 'supply' ? Math.max(0, (m.targetStock ?? 0) - qty(h.storage(st, r.owner), m.item)) : m.mode === 'construction' ? constructionRoom(st, m.item, true) : Infinity;
      const desired = Math.max(0, Math.min(m.amount, h.intakeRoom(st, r.owner, m.item, m.mode === 'construction'), targetRoom));
      const permit = h.cargoPermit(s, st, `route:${r.id}:unload`, desired);
      if (permit === null) { g.status = `${st.name}: 화물 하역 중`; return; }
      moved = Math.min(desired, permit);
      if (moved) { takec(s.cargo, m.item, moved); addc(h.storage(st, r.owner), m.item, moved); }
    }
    m.amount -= moved;
    if (moved) { record(r, h.time, { delivered: moved }); c.lastAction = h.time; emit(h.st, { kind: 'logistics', reason: 'unload', amount: moved, company: r.owner, group: g.id, ship: s.id, station: st.id, item: m.item, route: r.id }); }
    if (m.amount > 1e-9) { block(h, r, s, c, m.mode === 'sell' ? 'budget' : m.mode === 'construction' ? 'construction' : m.mode === 'supply' && qty(h.storage(st, r.owner), m.item) >= (m.targetStock ?? 0) ? 'target' : 'storage', m.mode === 'sell' ? '시장 구매 예산 부족 — 남은 화물 보존·예산 회복 대기' : m.mode === 'construction' ? '현장에 더 받을 자재가 없거나 창고가 가득 찼습니다 — 화물 보존·노선 변경 가능' : m.mode === 'supply' && qty(h.storage(st, r.owner), m.item) >= (m.targetStock ?? 0) ? '목표 재고 충족 — 화물 보존·소비 후 자동 공급' : '목적지 창고 가득 — 재고 이동·임대·증설 후 자동 재개', st.id); return; }
    delete r.manifests[s.id]; record(r, h.time, { trips: 1 }); resetCursor(c, r.config.repeat ? 'source' : 'complete'); c.lastAction = h.time;
    if (!r.config.repeat && !r.done.includes(s.id)) r.done.push(s.id);
    return;
  }
  const stock = h.storage(st, r.owner), cap = econOf(s).cargo * techFx(h.st.companies[r.owner]?.tech).cargoMul;
  let amount = r.config.mode === 'construction'
    ? Math.min(r.config.amount, Math.max(0, cap - cargoSum(s.cargo)), qty(stock, r.config.item))
    : Math.min(r.config.amount, Math.floor(cap - cargoSum(s.cargo)), Math.floor(qty(stock, r.config.item)));
  if (r.config.mode === 'construction') {
    const dest = h.st.stations[r.config.to];
    if (!dest || dest.owner !== r.owner) { pause(h, r, '자사 건설 현장을 이용할 수 없습니다 — 설정을 확인하세요'); return; }
    const outstanding = Math.max(0, constructionRoom(dest, r.config.item, true) - incomingRoutes(h, r.owner, dest.id, r.config.item) - incomingPool(h.st, r.owner, dest.id, r.config.item));
    if (outstanding <= 1e-9) { block(h, r, s, c, 'construction', '필요 자재 확보 또는 운송 중 — 추가 수요 대기', dest.id); return; }
    amount = Math.min(amount, outstanding);
  }
  if (r.config.mode === 'supply') {
    const dest = h.st.stations[r.config.to];
    if (!dest || !h.canDock(dest, r.owner)) { pause(h, r, '생산 목적지를 이용할 수 없습니다 — 설정을 확인하세요'); return; }
    const batch = supplyBatch(dest, r.config.item, h.st), needs = batch > 0;
    const current = qty(h.storage(dest, r.owner), r.config.item), onWay = incomingRoutes(h, r.owner, dest.id, r.config.item) + incomingPool(h.st, r.owner, dest.id, r.config.item);
    if (current <= r.config.minStock!) r.replenishing = true;
    if (current + onWay >= r.config.targetStock!) r.replenishing = false;
    if (!needs || !r.replenishing) { const threshold = needs && current < batch && onWay === 0; block(h, r, s, c, threshold ? 'threshold' : 'supply', !needs ? '이 원료를 사용하는 생산 주문 대기' : threshold ? `생산 원료 ${current}/${batch} — 보충 시작 재고 ${r.config.minStock}. 노선 재고 기준을 조정하세요` : '공급 재고 충족 — 소비 후 자동 보충 (운송 중 물량 포함)', dest.id); return; }
    amount = Math.min(amount, Math.max(0, r.config.targetStock! - current - onWay));
  }
  if (r.config.mode === 'construction' ? amount <= 1e-9 : amount < 1) {
    const full = cap - cargoSum(s.cargo) < (r.config.mode === 'construction' ? 1e-9 : 1);
    block(h, r, s, c, full ? 'cargo' : 'source', full ? '기존 화물로 화물칸이 찼습니다 — 기존 화물 하역 필요' : `${st.name}의 자유 재고 부족 — 예약 자재는 사용하지 않음`, st.id); return;
  }
  const permit = h.cargoPermit(s, st, `route:${r.id}:load`, amount);
  if (permit === null) { g.status = `${st.name}: 화물 적재 중`; return; }
  amount = Math.min(amount, permit);
  const loaded = takec(stock, r.config.item, amount); addc(s.cargo, r.config.item, loaded);
  r.manifests[s.id] = { from: r.config.from, to: r.config.to, item: r.config.item, mode: r.config.mode, amount: loaded, targetStock: r.config.targetStock, loadedAt: h.time };
  record(r, h.time, { loaded }); resetCursor(c, 'destination'); c.lastAction = h.time;
  emit(h.st, { kind: 'logistics', reason: 'depart', amount: loaded, company: r.owner, group: g.id, ship: s.id, station: st.id, item: r.config.item, route: r.id });
}
