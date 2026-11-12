// Company operations: one goal-and-work layer over the existing execution engines.
//
// Every accepted player command that starts company work is recorded here as a `Work`.
// Nothing in this file moves goods, builds or researches by itself: works are *projections*
// of the existing engines (construction plans, production orders, ship builds, research
// projects, pool logistics jobs, managed routes) and goals only *issue ordinary commands*
// through `WorldSim.command`, so every rule, price, capacity and ownership check of the
// original systems still applies. Approvals (결재) are raised only where automatic work would
// spend money without authority or take a risk the company has not accepted.
import type { WorldSim, Cmd } from './sim';
import type { Company, Station, WorldState } from './types';
import { qty, cargoSum } from './types';
import { ITEMS, EQUIPMENT, RECIPES, TECHS, recipeFor, facilityBuild } from './industry';
import { MODULES, RES_NAME } from './data';
import { missing, planMats, prereqBuilt } from './construction';
import { recipeOk, facLines } from './production';
import { econOf, growthOn, hullBuild } from './hullops';
import { yardFee } from './valuation';
import { effSec } from './security';
import { usableRouteGate } from './logistics';
import { CONTENT } from '../content/registry';
import { dist } from './geom';

// ───────────────────────────────────────────────────────────────────────── types

export type WorkKind =
  | 'buy' | 'sell' | 'transport' | 'route' | 'station' | 'facility' | 'ship' | 'research' | 'production'
  | 'repair' | 'refit' | 'purchase_ship' | 'exchange' | 'contract'
  | 'stockpile' | 'trade' | 'fleet' | 'facilities' | 'condition';
export type WorkMode = 'once' | 'maintain' | 'repeat' | 'condition';
export type WorkState = 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled';
export const GOAL_KINDS: WorkKind[] = ['stockpile', 'trade', 'fleet', 'facilities', 'condition'];

export type GoalSpec =
  /** keep (maintain) or reach (once) `target` units of `item` in the company store at `station` */
  | { k: 'stockpile'; station: string; item: string; target: number; maintain: boolean; buy: boolean; produce: boolean }
  /** buy at `from`, carry and sell at `to`; one cycle moves `amount`; `cycles` 0 = until stopped */
  | { k: 'trade'; item: string; from: string; to: string; amount: number; maxBuy: number; minSell: number; minProfit: number; cycles: number }
  /** have `count` new hulls of this design built at `station` */
  | { k: 'fleet'; station: string; hull: string; variant?: string; preset?: string; count: number; group?: string }
  /** have `count` built facilities of `kind` at `station` */
  | { k: 'facilities'; station: string; kind: string; count: number }
  /** buy below / sell above `price` at `station`, `amount` per trigger */
  | { k: 'condition'; station: string; item: string; side: 'buy' | 'sell'; price: number; amount: number; repeat: boolean };

export interface WorkRef {
  station?: string; module?: string; order?: string; build?: string; research?: string; job?: string; route?: string;
  group?: string; contract?: string; ship?: string; item?: string; at?: { x: number; y: number; z: number }; tech?: string;
}
export interface Work {
  id: string; owner: string; kind: WorkKind; mode: WorkMode; title: string;
  state: WorkState; reason: string; created: number; updated: number; finished?: number;
  /** 0 (lowest) … 9 (highest); maps onto procurement / logistics priority where they exist */
  priority: number;
  parent?: string;
  /** created by a goal or the planner, not directly by the player */
  auto?: boolean;
  ref: WorkRef;
  goal?: GoalSpec;
  progress: { done: number; total: number; unit?: string };
  /** spending authority: `limit` total credits (children included); `open` = no total cap; `maxPrice` caps unit price */
  budget?: { limit: number; spent: number; maxPrice?: number; open?: boolean };
  /** credits actually spent by this work itself (purchases, fees) — never reversed by later changes */
  cost: number;
  /** credits received (sales) */
  income?: number;
  result?: string;
  log: { t: number; text: string }[];
  /** goal runtime state (persisted so a restart resumes exactly) */
  rt?: {
    order?: string; launched?: number; cycles?: number; losses?: number; profit?: number; phase?: 'buy' | 'move';
    cycleCost?: number; cycleJob?: string; sellQuote?: number; sellRatio?: number; bought?: number; riskOk?: number; noBuyUntil?: number; creditsOk?: number;
    rejected?: Record<string, { t: number; amount: number }>; lastRun?: number; triggered?: number;
    /** a cancel/pause was issued by the player on the underlying object */
    cancelled?: boolean;
  };
}

export type ApprovalKind = 'purchase' | 'budget' | 'credits' | 'risk' | 'loss';
export type ApprovalScope = 'once' | 'work' | 'policy';
export interface ApprovalOption {
  id: string; label: string; detail: string; cost?: number; eta?: string; risk?: string;
  recommended?: boolean; scopes: ApprovalScope[];
  /** option accepts a modified number (budget or max unit price) */
  input?: 'budget' | 'price';
}
export interface Approval {
  id: string; owner: string; work: string; key: string; kind: ApprovalKind;
  title: string; reason: string; situation: string;
  items: { item: string; amount: number; price: number; station: string }[];
  estimate: { cost: number; unit?: number; note: string };
  risk?: { level: number; hops: number; note: string };
  alt?: { station: string; cost: number; hops: number; risk: number };
  options: ApprovalOption[];
  rejectEffect: string; scopeNote: string;
  created: number; updated: number; raised: number;
  state: 'open' | 'approved' | 'rejected' | 'resolved';
  decided?: number; choice?: string; scope?: ApprovalScope; note?: string;
}
export interface OpsPolicy {
  /** 'ask': unauthorised automatic spending raises an approval · 'auto': within the limits below, buy without asking */
  autonomy: 'ask' | 'auto';
  /** never let automatic work take the balance below this */
  minCredits: number;
  /** automatic spending per game hour, 0 = no hourly limit */
  hourlyLimit: number;
  /** a whole requirement estimated below this is approved automatically (not per purchase — splitting does not help) */
  autoApproveBelow: number;
  /** highest sector risk (100 − security) automatic goal transport may cross without asking */
  maxRisk: number;
  /** stockpile goals use own production before buying */
  preferProduce: boolean;
  /** delegated item purchases: item → max unit price, drawn from `delegatedBudget` */
  autoBuy: Record<string, number>;
  delegatedBudget: number; delegatedSpent: number;
}
export interface LedgerHour { h: number; inc: Record<string, number>; exp: Record<string, number>; sales?: Record<string, number> }
export interface CompanyOps {
  policy: OpsPolicy;
  ledger: LedgerHour[];
  /** automatic spending (for the hourly limit) */
  spend: { t: number; n: number }[];
  /** balance last seen by the ledger reconciliation */
  credits?: number;
}

export const defaultOpsPolicy = (): OpsPolicy => ({ autonomy: 'ask', minCredits: 0, hourlyLimit: 0, autoApproveBelow: 0, maxRisk: 50, preferProduce: true, autoBuy: {}, delegatedBudget: 0, delegatedSpent: 0 });
export const opsOf = (co: Company): CompanyOps => {
  const o = (co.ops ??= { policy: defaultOpsPolicy(), ledger: [], spend: [] });
  o.policy = { ...defaultOpsPolicy(), ...o.policy }; return o;
};

const EPS = 1e-6;
const LOG_CAP = 12;
const KEEP_FINISHED = 200;
const MAX_LIVE_CHILDREN = 8;
const REJECT_HOLD = 6 * 3600;
export const terminal = (w: Work) => w.state === 'done' || w.state === 'failed' || w.state === 'cancelled';
export const itemName = (id: string) => ITEMS[id]?.name ?? EQUIPMENT[id]?.name ?? RES_NAME[id] ?? id;
const fmt = (n: number) => Math.round(n).toLocaleString();
const finite = (n: unknown, max = 1e12): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
const safeItem = (id: unknown): id is string => typeof id === 'string' && (Object.hasOwn(ITEMS, id) || Object.hasOwn(EQUIPMENT, id));

// ───────────────────────────────────────────────────────────────── registry core

/** goal context: commands issued inside `withParent` become child works of that goal */
let parentCtx: string | undefined;
export function withParent<T>(parent: string, fn: () => T): T {
  const prev = parentCtx; parentCtx = parent;
  try { return fn(); } finally { parentCtx = prev; }
}

function addWork(h: WorldSim, owner: string, kind: WorkKind, title: string, ref: WorkRef, extra: Partial<Work> = {}): Work {
  const works = h.st.works ??= {};
  const parent = extra.parent ?? parentCtx;
  const w: Work = { id: h.id('wk'), owner, kind, mode: 'once', title, state: 'running', reason: '', created: h.time, updated: h.time, priority: 5, ref, progress: { done: 0, total: 1 }, cost: 0, log: [], ...(parent ? { parent, auto: true } : {}), ...extra };
  works[w.id] = w; return w;
}
export function note(w: Work, t: number, text: string) {
  if (w.log.at(-1)?.text === text) return;
  w.log.push({ t, text }); if (w.log.length > LOG_CAP) w.log.splice(0, w.log.length - LOG_CAP);
}
function setState(h: WorldSim, w: Work, state: WorkState, reason: string) {
  if (w.state !== state || w.reason !== reason) { w.updated = h.time; if (w.state !== state) note(w, h.time, `${STATE_NAME[state]}${reason ? ` — ${reason}` : ''}`); }
  w.state = state; w.reason = reason;
  if (terminal(w) && w.finished === undefined) {
    w.finished = h.time;
    for (const a of Object.values(h.st.approvals ?? {})) if (a.work === w.id && a.state === 'open') { a.state = 'resolved'; a.note = '업무 종료로 결재 불필요'; a.updated = h.time; }
  }
}
export const STATE_NAME: Record<WorkState, string> = { running: '진행', waiting: '대기', paused: '일시정지', done: '완료', failed: '실패', cancelled: '취소' };
export const KIND_NAME: Record<WorkKind, string> = {
  buy: '구매', sell: '판매', transport: '운송', route: '정기 운송', station: '정거장 건설', facility: '시설 건설', ship: '함선 건조', research: '연구', production: '생산',
  repair: '수리', refit: '개장', purchase_ship: '함선 구매', exchange: '거래소', contract: '계약',
  stockpile: '비축 목표', trade: '반복 무역', fleet: '함대 목표', facilities: '시설 목표', condition: '조건 거래',
};
const children = (h: WorldSim, w: Work) => Object.values(h.st.works ?? {}).filter(c => c.parent === w.id);
const findWork = (h: WorldSim, owner: string, test: (w: Work) => boolean) => Object.values(h.st.works ?? {}).find(w => w.owner === owner && test(w));
/** the budget-bearing ancestor (or the work itself) */
function budgetHolder(h: WorldSim, w: Work): Work {
  let cur: Work | undefined = w; const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); if (cur.budget || !cur.parent) return cur; cur = h.st.works?.[cur.parent]; }
  return w;
}

// ────────────────────────────────────────────────────────────── command hook

export interface CmdSnapshot { credits: number; jobs: number; routes: string[]; stock?: number }
export function snapshot(h: WorldSim, company: string, cmd?: Cmd): CmdSnapshot {
  const market = cmd && (cmd.c === 'buy' || cmd.c === 'sell') && typeof cmd.station === 'string' ? h.st.stations[cmd.station]?.market?.[cmd.res] : undefined;
  return { credits: h.st.companies[company]?.credits ?? 0, jobs: Object.keys(h.st.logisticsJobs ?? {}).length, routes: Object.keys(h.st.logistics ?? {}), ...(market ? { stock: market.stock } : {}) };
}

/** Record a successfully executed command as company work. Called by `WorldSim.command`. */
export function registerCommand(h: WorldSim, company: string, cmd: Cmd, before: CmdSnapshot) {
  if (!growthOn(h.st)) return;
  const co = h.st.companies[company]; if (!co || co.kind !== 'player') return;
  const spent = before.credits - co.credits;
  const st = 'station' in cmd && typeof cmd.station === 'string' ? h.st.stations[cmd.station] : undefined;
  const done = (kind: WorkKind, title: string, ref: WorkRef, result: string) => {
    const w = addWork(h, company, kind, title, ref, { progress: { done: 1, total: 1 } });
    w.cost = Math.max(0, spent); if (spent < 0) w.income = -spent; w.result = result;
    setState(h, w, 'done', ''); note(w, h.time, result);
    return w; // a goal that issued this records its own spending (charge) — never counted twice
  };
  switch (cmd.c) {
    case 'buy': {
      if (spent <= EPS) return; // duplicate retry: nothing happened
      const n = before.stock !== undefined ? before.stock - (st?.market?.[cmd.res]?.stock ?? before.stock) : 0;
      const w = done('buy', `${itemName(cmd.res)} 구매`, { station: cmd.station, item: cmd.res, ship: cmd.ship }, `${itemName(cmd.res)} ${fmt(n)} 구매 · ${fmt(spent)} cr (평균 ${fmt(spent / Math.max(1, n))} cr) · ${st?.name ?? ''}`);
      w.progress = { done: n, total: n, unit: itemName(cmd.res) };
      return;
    }
    case 'sell': {
      if (-spent <= EPS) return;
      const n = before.stock !== undefined ? (st?.market?.[cmd.res]?.stock ?? before.stock) - before.stock : 0;
      done('sell', `${itemName(cmd.res)} 판매`, { station: cmd.station, item: cmd.res }, `${itemName(cmd.res)} ${fmt(n)} 판매 +${fmt(-spent)} cr · ${st?.name ?? ''}`).progress = { done: n, total: n, unit: itemName(cmd.res) };
      return;
    }
    case 'repair': done('repair', `${h.st.ships[cmd.ship]?.name ?? '함선'} 수리`, { ship: cmd.ship }, `수리 완료 · ${fmt(spent)} cr`); return;
    case 'refit': case 'fit': case 'fitShip': done('refit', `${h.st.ships[cmd.ship]?.name ?? '함선'} 개장`, { ship: cmd.ship }, `장비 변경 적용${spent > EPS ? ` · ${fmt(spent)} cr` : ''}`); return;
    case 'buyShip': case 'buyShipListing': done('purchase_ship', '함선 구매', { station: cmd.station }, `함선 구매 · ${fmt(spent)} cr`); return;
    case 'buyListing': case 'list': case 'delist': {
      if (Math.abs(spent) <= EPS && cmd.c === 'buyListing') return;
      done('exchange', cmd.c === 'buyListing' ? '거래소 구매' : cmd.c === 'list' ? '거래소 등록' : '거래소 등록 취소', { station: cmd.station }, cmd.c === 'buyListing' ? `거래소 구매 · ${fmt(spent)} cr` : cmd.c === 'list' ? `${itemName(cmd.item)} ${fmt(cmd.qty)} 등록 · 단가 ${fmt(cmd.price)} cr` : '등록 취소 — 물품 보관함 반환');
      return;
    }
    case 'accept': {
      const c = h.st.contracts[cmd.contract];
      addWork(h, company, 'contract', c?.title ?? '계약', { contract: cmd.contract, station: c?.stationId }, { reason: '계약 수행 중' });
      return;
    }
    case 'queueModule': {
      const m = st?.modules.at(-1); if (!st || !m?.id) return;
      const w = addWork(h, company, 'facility', `${st.name} · ${MODULES[m.kind]?.name ?? m.kind} 건설`, { station: st.id, module: m.id }, { progress: { done: 0, total: 1 } });
      w.cost = Math.max(0, spent); chargeParent(h, w, w.cost); projectWork(h, w);
      return;
    }
    case 'prodOrder': {
      if (!st) return; const id = `o${st.seq}`, o = st.orders?.find(x => x.id === id); if (!o) return;
      const r = recipeFor(h.st, o.recipe);
      addWork(h, company, 'production', `${st.name} · ${r?.name ?? o.recipe} ${o.mode === 'stock' ? `재고 ${fmt(o.n)} 유지` : `${fmt(o.n)}회`}`, { station: st.id, order: id }, { mode: o.mode === 'stock' ? 'maintain' : 'once', progress: { done: 0, total: o.n } });
      return;
    }
    case 'buildShip': {
      if (!st) return; const id = `b${st.seq}`, b = st.builds?.find(x => x.id === id); if (!b) return;
      const name = b.hull ? CONTENT.hulls[b.hull]?.name ?? b.hull : b.classId;
      const w = addWork(h, company, 'ship', `${st.name} · ${name} 건조`, { station: st.id, build: id }, { progress: { done: 0, total: 1 } });
      w.cost = Math.max(0, spent); chargeParent(h, w, w.cost);
      return;
    }
    case 'research': {
      const id = `r${co.rseq}`, p = co.research?.find(x => x.id === id); if (!p) return;
      const w = addWork(h, company, 'research', `${TECHS[p.tech]?.name ?? p.tech} ${p.source === 'copy' ? '복제' : p.source === 'salvage' ? '분석' : '연구'}`, { station: p.station, research: id, tech: p.tech }, { progress: { done: 0, total: 1 } });
      w.cost = Math.max(0, spent); chargeParent(h, w, w.cost);
      return;
    }
    case 'poolCreate': {
      const ids = Object.keys(h.st.logisticsJobs ?? {}); if (ids.length <= before.jobs) return;
      const j = h.st.logisticsJobs![ids.at(-1)!];
      const from = h.st.stations[j.from]?.name ?? j.from, to = h.st.stations[j.to]?.name ?? j.to;
      addWork(h, company, 'transport', `${itemName(j.item)} ${fmt(j.amount)} ${from} → ${to}${j.kind === 'sell' ? ' 판매' : ''}`, { job: j.id, item: j.item, station: j.to }, { mode: j.repeat ? 'repeat' : 'once', priority: j.priority, progress: { done: 0, total: j.amount } });
      return;
    }
    case 'putRoute': {
      const id = cmd.route ?? Object.keys(h.st.logistics ?? {}).find(k => !before.routes.includes(k)); const r = id ? h.st.logistics?.[id] : undefined; if (!r) return;
      if (findWork(h, company, w => w.ref.route === r.id && !terminal(w))) return;
      addWork(h, company, 'route', `${r.config.name || '운송 경로'} · ${itemName(r.config.item)}`, { route: r.id, group: r.group, item: r.config.item }, { mode: r.config.repeat ? 'repeat' : 'once' });
      return;
    }
    case 'setOp': {
      if (cmd.op.k !== 'found') return;
      const prior = findWork(h, company, w => w.kind === 'station' && w.ref.group === cmd.group && !terminal(w) && !w.ref.station);
      if (prior) { prior.ref.at = { ...cmd.op.at }; prior.title = `정거장 설립 · ${cmd.op.name}`; return; }
      const w = addWork(h, company, 'station', `정거장 설립 · ${cmd.op.name}`, { group: cmd.group, at: { ...cmd.op.at } }, { progress: { done: 0, total: 1 } });
      w.cost = Math.max(0, spent); setState(h, w, 'running', '건설선 부지로 이동 중');
      return;
    }
    case 'planOp': case 'prodOp': case 'buildOp': case 'researchOp': {
      if (cmd.op !== 'cancel') return;
      const w = findWork(h, company, x => !terminal(x) && (cmd.c === 'planOp' ? x.ref.module === cmd.plan && x.ref.station === cmd.station : cmd.c === 'prodOp' ? x.ref.order === cmd.order && x.ref.station === cmd.station : cmd.c === 'buildOp' ? x.ref.build === cmd.build && x.ref.station === cmd.station : x.ref.research === cmd.project));
      if (w) { (w.rt ??= {}).cancelled = true; setState(h, w, 'cancelled', '취소됨 — 이미 지출·투입된 자원은 되돌리지 않음 (환불은 원래 규칙대로)'); }
      return;
    }
    case 'poolControl': case 'routeControl': {
      for (const w of Object.values(h.st.works ?? {})) if (w.owner === company && !terminal(w) && (cmd.c === 'poolControl' ? w.ref.job === cmd.job : cmd.routes.includes(w.ref.route ?? ''))) projectWork(h, w);
      return;
    }
  }
}
function chargeParent(h: WorldSim, w: Work, amount: number) {
  if (!w.parent || amount <= EPS) return;
  const holder = budgetHolder(h, h.st.works?.[w.parent] ?? w);
  if (holder.budget) holder.budget.spent += amount;
}

// ─────────────────────────────────────────────────────────────── projection

/** Refresh state, reason and progress from the engine that executes the work. */
export function projectWork(h: WorldSim, w: Work) {
  if (terminal(w) || GOAL_KINDS.includes(w.kind)) return;
  const co = h.st.companies[w.owner];
  const st = w.ref.station ? h.st.stations[w.ref.station] : undefined;
  switch (w.kind) {
    case 'facility': {
      if (!st) return setState(h, w, 'failed', '정거장 소실');
      const m = st.modules.find(x => x.id === w.ref.module);
      if (!m) return setState(h, w, 'cancelled', '건설 계획이 취소됨');
      w.progress = { done: m.built ? 1 : m.progress, total: 1 };
      if (m.built) { w.result = `${MODULES[m.kind]?.name ?? m.kind} 가동 시작`; return setState(h, w, 'done', ''); }
      if (m.paused) return setState(h, w, 'paused', '일시정지');
      if (!prereqBuilt(st, m)) return setState(h, w, 'waiting', '선행 시설 완공 대기');
      const short = planMats(m).filter(r => missing(m, r) > EPS);
      if (short.length) return setState(h, w, 'waiting', `자재 확보 중: ${short.slice(0, 3).map(r => `${itemName(r)} ${fmt(missing(m, r))}`).join(', ')}${procurementWhy(h, w.owner, st.id, 'construction', m.id!)}`);
      return setState(h, w, 'running', '건설 중');
    }
    case 'production': {
      if (!st) return setState(h, w, 'failed', '정거장 소실');
      const o = st.orders?.find(x => x.id === w.ref.order);
      if (!o) { if (w.rt?.cancelled) return setState(h, w, 'cancelled', '취소됨'); w.progress.done = w.progress.total; w.result = '생산 완료'; return setState(h, w, 'done', ''); }
      const r = recipeFor(h.st, o.recipe), out = r ? Object.keys(r.out)[0] : undefined;
      w.progress = o.mode === 'count' ? { done: o.done, total: o.n, unit: '회' } : { done: Math.min(o.n, out ? qty(st.storage[w.owner], out) : 0), total: o.n, unit: out ? itemName(out) : '' };
      if (o.paused) return setState(h, w, 'paused', '일시정지');
      const active = (st.jobs ?? []).some(j => j.order === o.id);
      if (o.why && !active) return setState(h, w, 'waiting', `${o.why}${procurementWhy(h, w.owner, st.id, 'production', o.id)}`);
      return setState(h, w, 'running', active ? '생산 중' : o.mode === 'stock' ? '목표 재고 유지 중' : '다음 배치 대기');
    }
    case 'ship': {
      if (!st) return setState(h, w, 'failed', '정거장 소실');
      const b = st.builds?.find(x => x.id === w.ref.build);
      if (!b) { if (w.rt?.cancelled) return setState(h, w, 'cancelled', '취소됨'); w.progress.done = 1; w.result = '진수 완료'; return setState(h, w, 'done', ''); }
      w.progress = { done: b.started ? Math.max(0, 1 - b.left / Math.max(EPS, b.total)) : 0, total: 1 };
      if (b.paused) return setState(h, w, 'paused', '일시정지');
      if (!b.started) return setState(h, w, 'waiting', `${b.why ?? '착공 대기'}${procurementWhy(h, w.owner, st.id, 'ship', b.id)}`);
      return setState(h, w, 'running', '건조 중');
    }
    case 'research': {
      const p = co?.research?.find(x => x.id === w.ref.research);
      if (!p) { if (w.ref.tech && co?.tech?.includes(w.ref.tech) || !w.rt?.cancelled) { w.progress.done = 1; w.result = '연구 완료'; return setState(h, w, 'done', ''); } return setState(h, w, 'cancelled', '취소됨'); }
      w.progress = { done: p.started ? Math.max(0, 1 - p.left / Math.max(EPS, p.total)) : 0, total: 1 };
      if (p.paused) return setState(h, w, 'paused', '일시정지');
      if (!p.started) return setState(h, w, 'waiting', p.why ?? '연구실 대기');
      return setState(h, w, 'running', '연구 중');
    }
    case 'transport': {
      const j = h.st.logisticsJobs?.[w.ref.job ?? ''];
      if (!j) return setState(h, w, w.progress.done >= w.progress.total - EPS ? 'done' : 'cancelled', '작업 기록 정리됨');
      w.progress = { done: j.repeat ? j.cycleDelivered : j.delivered, total: j.amount };
      if (j.earned > (w.income ?? 0)) w.income = j.earned;
      const why = j.reason ?? '';
      if (j.state === 'complete') { w.result = `${fmt(j.delivered)} 인도${j.lost ? ` · 손실 ${fmt(j.lost)}` : ''}${j.earned ? ` · 판매 ${fmt(j.earned)} cr` : ''}`; return setState(h, w, 'done', ''); }
      if (j.state === 'cancelled') return setState(h, w, 'cancelled', why || '취소됨');
      if (j.state === 'paused') return setState(h, w, 'paused', why || '일시정지');
      if (j.state === 'active') return setState(h, w, 'running', j.carried > EPS ? `운송 중 ${fmt(j.carried)}` : '적재하러 이동 중');
      return setState(h, w, 'waiting', why || '배차 대기');
    }
    case 'route': {
      const r = h.st.logistics?.[w.ref.route ?? ''];
      if (!r) return setState(h, w, 'cancelled', '경로 삭제됨');
      if (r.state === 'complete') { w.result = '경로 완료'; return setState(h, w, 'done', ''); }
      if (r.state === 'paused') return setState(h, w, 'paused', r.reason ?? '일시정지');
      return setState(h, w, 'running', r.reason ?? '운행 중');
    }
    case 'station': {
      if (w.ref.station) {
        const s = h.st.stations[w.ref.station]; if (!s) return setState(h, w, 'failed', '정거장 소실');
        const core = s.modules.find(m => m.kind === 'core');
        w.progress = { done: core?.built ? 1 : core?.progress ?? 0, total: 1 };
        if (core?.built) { w.result = `${s.name} 설립 완료`; return setState(h, w, 'done', ''); }
        const short = core ? planMats(core).filter(r => missing(core, r) > EPS) : [];
        return setState(h, w, short.length ? 'waiting' : 'running', short.length ? `핵심 시설 자재 대기: ${short.slice(0, 3).map(r => `${itemName(r)} ${fmt(missing(core!, r))}`).join(', ')}` : '도킹 허브 건설 중');
      }
      const at = w.ref.at;
      const made = at && Object.values(h.st.stations).find(s => s.owner === w.owner && (s.founded ?? -1) >= w.created - EPS && dist(s.pos, { ...at, y: 0 }) < 1);
      if (made) { w.ref.station = made.id; note(w, h.time, `${made.name} 부지 확보`); return projectWork(h, w); }
      const g = h.st.groups[w.ref.group ?? ''];
      if (!g || g.owner !== w.owner) return setState(h, w, 'failed', '건설 부대 소실 — 선불금은 원래 규칙대로 정산');
      if (g.op.k !== 'found') return setState(h, w, 'cancelled', '부대 명령이 변경되어 설립 취소 — 선불금은 원래 규칙대로 정산');
      return setState(h, w, 'running', '건설선 부지로 이동 중');
    }
    case 'contract': {
      const c = h.st.contracts[w.ref.contract ?? ''];
      if (!c) { w.result = '계약 종료'; return setState(h, w, 'done', ''); }
      return setState(h, w, 'running', '계약 수행 중');
    }
  }
}
function procurementWhy(h: WorldSim, owner: string, station: string, kind: string, source: string): string {
  const p = Object.values(h.st.procurementPlans ?? {}).find(x => x.owner === owner && x.station === station && x.sourceKind === kind && x.sourceId === source && x.state !== 'closed' && x.shortage > EPS);
  return p ? ` · 조달: ${p.reason}` : '';
}

// ─────────────────────────────────────────────────────────── spending authority

export interface AuthResult { ok: boolean; kind?: ApprovalKind; why?: string }
function spentLastHour(h: WorldSim, ops: CompanyOps) {
  ops.spend = ops.spend.filter(s => s.t > h.time - 3600);
  return ops.spend.reduce((n, s) => n + s.n, 0);
}
/** May `w` spend `amount` credits at unit `price` on `item` without asking? `whole` is the full requirement estimate. */
export function authorize(h: WorldSim, w: Work, amount: number, price: number, item: string, whole = amount): AuthResult {
  const co = h.st.companies[w.owner]; const ops = opsOf(co), pol = ops.policy;
  if (co.credits - amount < pol.minCredits - EPS && !((w.rt?.creditsOk ?? -1) >= h.time)) return { ok: false, kind: 'credits', why: `최소 보유 크레딧 ${fmt(pol.minCredits)} cr 아래로 내려감` };
  if (pol.hourlyLimit > 0 && spentLastHour(h, ops) + amount > pol.hourlyLimit + EPS) return { ok: false, kind: 'budget', why: `시간당 자동 지출 한도 ${fmt(pol.hourlyLimit)} cr 초과` };
  const holder = budgetHolder(h, w), b = holder.budget;
  if (b) {
    if (b.maxPrice !== undefined && price > b.maxPrice + EPS) return { ok: false, kind: 'budget', why: `단가 ${fmt(price)} cr가 승인 단가 ${fmt(b.maxPrice)} cr 초과` };
    if (b.open || b.spent + amount <= b.limit + EPS) return { ok: true };
    return { ok: false, kind: 'budget', why: `업무 예산 ${fmt(b.limit)} cr 중 ${fmt(b.spent)} cr 사용 — ${fmt(amount)} cr 추가 필요` };
  }
  if (pol.autoBuy[item] > 0 && price <= pol.autoBuy[item] + EPS && pol.delegatedSpent + amount <= pol.delegatedBudget + EPS) return { ok: true };
  if (pol.autonomy === 'auto') return { ok: true };
  if (pol.autoApproveBelow > 0 && whole <= pol.autoApproveBelow + EPS) return { ok: true };
  return { ok: false, kind: 'purchase', why: '이 업무에는 아직 구매 권한이 없음' };
}
export function charge(h: WorldSim, w: Work, amount: number, price: number, item: string) {
  if (amount <= EPS) return;
  const co = h.st.companies[w.owner], ops = opsOf(co), holder = budgetHolder(h, w);
  w.cost += amount; ops.spend.push({ t: h.time, n: amount });
  if (holder.budget) holder.budget.spent += amount;
  else if (ops.policy.autoBuy[item] > 0 && price <= ops.policy.autoBuy[item] + EPS) ops.policy.delegatedSpent += amount;
}

/**
 * Procurement (P9.8.2) purchasing authority from the work system: a construction / production / ship
 * order whose work (or its goal) carries an approved budget may be supplied by purchase.
 * Returns undefined when the work system grants nothing (the legacy procurement policy still applies).
 */
export function procurementAuthority(h: WorldSim, owner: string, station: string, kind: 'construction' | 'production' | 'ship', source: string, item: string) {
  if (!h.st.works) return undefined;
  const w = findWork(h, owner, x => !terminal(x) && x.ref.station === station && (kind === 'construction' ? x.ref.module === source : kind === 'production' ? x.ref.order === source : x.ref.build === source));
  if (!w) return undefined;
  const co = h.st.companies[owner], pol = opsOf(co).policy, holder = budgetHolder(h, w), b = holder.budget;
  const delegated = pol.autoBuy[item] > 0 ? pol.autoBuy[item] : 0;
  const maxPrice = b ? b.maxPrice ?? Infinity : delegated > 0 ? delegated : pol.autonomy === 'auto' ? Infinity : 0;
  const left = b ? (b.open ? Infinity : Math.max(0, b.limit - b.spent)) : delegated > 0 ? Math.max(0, pol.delegatedBudget - pol.delegatedSpent) : pol.autonomy === 'auto' ? Infinity : 0;
  const hourly = pol.hourlyLimit > 0 ? Math.max(0, pol.hourlyLimit - spentLastHour(h, opsOf(co))) : Infinity;
  if (!(maxPrice > 0) || !(Math.min(left, hourly) > EPS)) return undefined;
  return { maxPrice, left: Math.min(left, hourly), minCredits: pol.minCredits, charge: (n: number, price: number) => charge(h, w, n, price, item) };
}

// ─────────────────────────────────────────────────────────────────── approvals

function raise(h: WorldSim, w: Work, kind: ApprovalKind, key: string, a: Omit<Approval, 'id' | 'owner' | 'work' | 'key' | 'kind' | 'created' | 'updated' | 'raised' | 'state'>): Approval | undefined {
  const rej = w.rt?.rejected?.[key];
  if (rej && h.time - rej.t < REJECT_HOLD && a.estimate.cost <= rej.amount * 1.5) return undefined;
  const all = h.st.approvals ??= {};
  const open = Object.values(all).find(x => x.work === w.id && x.key === key && x.state === 'open');
  if (open) { Object.assign(open, a); open.updated = h.time; return open; }
  const ap: Approval = { id: h.id('ap'), owner: w.owner, work: w.id, key, kind, created: h.time, updated: h.time, raised: h.time, state: 'open', ...a };
  all[ap.id] = ap; note(w, h.time, `결재 요청: ${ap.title}`);
  h.ev('info', `결재 요청 — ${ap.title}`, { company: w.owner, tag: 'approval' });
  return ap;
}
function resolveOpen(h: WorldSim, w: Work, key: string, why: string) {
  for (const a of Object.values(h.st.approvals ?? {})) if (a.work === w.id && a.key === key && a.state === 'open') { a.state = 'resolved'; a.note = why; a.updated = h.time; }
}
const openApproval = (h: WorldSim, w: Work, key: string) => Object.values(h.st.approvals ?? {}).find(x => x.work === w.id && x.key === key && x.state === 'open');

function purchaseApproval(h: WorldSim, w: Work, auth: AuthResult, items: Approval['items'], extra: { risk?: Approval['risk']; alt?: Approval['alt']; context: string }) {
  const co = h.st.companies[w.owner], pol = opsOf(co).policy;
  const cost = items.reduce((n, x) => n + x.amount * x.price, 0), unit = items.length === 1 ? items[0].price : undefined;
  const holder = budgetHolder(h, w), key = `${auth.kind}`;
  const label = items.map(x => `${itemName(x.item)} ${fmt(x.amount)}`).join(', ');
  const station = items[0] ? h.st.stations[items[0].station]?.name ?? '' : '';
  const options: ApprovalOption[] = [];
  if (auth.kind === 'credits') {
    options.push({ id: 'approve', label: '이번만 최소 잔액 아래로 집행', detail: `잔액이 ${fmt(co.credits - cost)} cr로 내려갑니다 (최소 ${fmt(pol.minCredits)} cr)`, cost, scopes: ['once'] });
    options.push({ id: 'wait', label: '수입이 생길 때까지 대기', detail: '잔액이 회복되면 자동으로 다시 시도합니다', recommended: true, scopes: ['once'] });
  } else {
    const cap = items.reduce((n, x) => n + x.amount * Math.ceil(x.price * 1.15), 0);
    options.push({ id: 'approve', label: holder.budget ? '예산 증액 후 구매' : '구매 승인', detail: `${station}에서 ${label} — 추정 ${fmt(cost)} cr, 최대 ${fmt(cap)} cr (단가 상한 +15%)`, cost, recommended: !extra.risk, scopes: ['once', 'work', 'policy'], input: 'budget' });
    options.push({ id: 'wait', label: '구매 없이 자사 재고·생산으로만 진행', detail: '내부 이송과 생산으로 가능한 만큼 진행하고 6시간 동안 같은 구매를 묻지 않습니다', scopes: ['once'] });
  }
  if (extra.alt) options.push({ id: 'safe', label: '안전 경로 시장 이용', detail: `${h.st.stations[extra.alt.station]?.name ?? ''} — 추정 ${fmt(extra.alt.cost)} cr · ${extra.alt.hops}점프 · 최대 위험 ${Math.round(extra.alt.risk)} (추정)`, cost: extra.alt.cost, recommended: true, scopes: ['once', 'work'] });
  options.push({ id: 'pause', label: '이 목표 일시정지', detail: '진행 중인 운송 화물은 그대로 도착합니다', scopes: ['once'] });
  options.push({ id: 'reject', label: '거절', detail: '구매하지 않고 6시간 동안 같은 조건으로 다시 묻지 않습니다 (금액이 1.5배 넘게 늘면 다시 요청)', scopes: ['once'] });
  return raise(h, w, auth.kind === 'credits' ? 'credits' : extra.risk ? 'risk' : holder.budget ? 'budget' : 'purchase', key, {
    title: `${w.title} — ${auth.kind === 'credits' ? '최소 잔액 침범' : holder.budget ? '예산 초과' : '구매 결재'}`,
    reason: auth.why ?? '', situation: extra.context, items,
    estimate: { cost, unit, note: '현재 시장가 기준 추정 — 구매 시점 가격·재고에 따라 달라질 수 있음' },
    risk: extra.risk, alt: extra.alt, options,
    rejectEffect: '구매 없이 내부 재고·생산으로 가능한 만큼만 진행하고, 부족분은 업무 대기 사유로 표시됩니다',
    scopeNote: '이번만: 이 금액까지 · 이 목표: 같은 품목·단가 이내라면 이 목표 끝까지 · 정책 위임: 회사 전체 같은 품목·단가 이내 자동 구매 (위임 예산 한도 내)',
  });
}

/** Apply a decision. `value` modifies the approved budget (credits). */
export function decideApproval(h: WorldSim, owner: string, id: string, option: string, scope: ApprovalScope = 'once', value?: number): string | null {
  const a = h.st.approvals?.[id];
  if (!a || a.owner !== owner) return '결재 문서를 찾을 수 없습니다';
  if (a.state !== 'open') return '이미 처리된 결재입니다';
  const opt = a.options.find(o => o.id === option); if (!opt) return '선택지를 확인하세요';
  if (!opt.scopes.includes(scope)) return '이 선택지에 사용할 수 없는 적용 범위입니다';
  if (value !== undefined && !finite(value)) return '금액을 확인하세요';
  const w = h.st.works?.[a.work]; if (!w) return '연결된 업무가 없습니다';
  const co = h.st.companies[owner], pol = opsOf(co).policy, holder = budgetHolder(h, w);
  const unitCap = (x: Approval['items'][number]) => Math.ceil(x.price * 1.15);
  const maxUnit = a.items.length ? Math.max(...a.items.map(unitCap)) : undefined;
  // a one-time approval covers the listed quantities at up to the capped unit price, so ordinary price
  // movement while buying does not leave a remainder that needs a second approval
  const capped = a.items.length ? a.items.reduce((n, x) => n + x.amount * unitCap(x), 0) : a.estimate.cost;
  const amount = value ?? capped;
  switch (option) {
    case 'approve': {
      if (a.kind === 'credits') { (w.rt ??= {}).creditsOk = h.time + 600; break; }
      if (a.kind === 'loss') { (w.rt ??= {}).losses = 0; if (w.state === 'paused') setState(h, w, 'running', '손실 경고 승인 — 재개'); break; }
      if (a.kind === 'risk' && a.risk) (w.rt ??= {}).riskOk = Math.max(w.rt?.riskOk ?? 0, a.risk.level);
      if (scope === 'policy') {
        for (const x of a.items) pol.autoBuy[x.item] = Math.max(pol.autoBuy[x.item] ?? 0, unitCap(x));
        pol.delegatedBudget += amount;
      } else {
        const target = holder.budget ? holder : budgetHolder(h, w);
        const b = target.budget ??= { limit: 0, spent: 0 };
        if (scope === 'work') { b.open = true; b.maxPrice = Math.max(b.maxPrice ?? 0, maxUnit ?? 0) || undefined; }
        else { b.limit = Math.max(b.limit, b.spent) + amount; if (maxUnit) b.maxPrice = Math.max(b.maxPrice ?? 0, maxUnit); }
      }
      if (w.rt?.noBuyUntil) delete w.rt.noBuyUntil;
      break;
    }
    case 'safe': (w.rt ??= {}).riskOk = -1; if (scope === 'work') { const b = (holder.budget ??= { limit: 0, spent: 0 }); b.limit = Math.max(b.limit, b.spent) + (a.alt?.cost ?? amount); } else { const b = (holder.budget ??= { limit: 0, spent: 0 }); b.limit = Math.max(b.limit, b.spent) + (a.alt?.cost ?? amount); } break;
    case 'wait': (w.rt ??= {}).noBuyUntil = h.time + REJECT_HOLD; ((w.rt.rejected ??= {})[a.key] = { t: h.time, amount: a.estimate.cost }); break;
    case 'pause': workOp(h, owner, w.id, 'pause'); break;
    case 'cancel': workOp(h, owner, w.id, 'cancel'); break;
    case 'reject': ((w.rt ??= {}).rejected ??= {})[a.key] = { t: h.time, amount: a.estimate.cost }; w.rt.noBuyUntil = h.time + REJECT_HOLD; break;
    default: return '선택지를 확인하세요';
  }
  a.state = option === 'reject' ? 'rejected' : 'approved'; a.choice = option; a.scope = scope; a.decided = h.time; a.updated = h.time;
  note(w, h.time, `결재 ${option === 'reject' ? '거절' : '처리'}: ${opt.label}${scope !== 'once' ? ` (${scope === 'work' ? '이 목표 전체' : '정책 위임'})` : ''}`);
  // related open approvals of the same work become moot when a budget/authority was granted
  if (option === 'approve' || option === 'safe') for (const x of Object.values(h.st.approvals ?? {})) if (x !== a && x.work === a.work && x.state === 'open' && x.kind !== 'loss') { x.state = 'resolved'; x.note = '같은 업무의 다른 결재로 해결'; x.updated = h.time; }
  return null;
}

// ─────────────────────────────────────────────────────────────── route helpers

/** fewest-jump path (by usable gates); returns hops and the highest sector risk crossed, or null */
export function routeRisk(h: WorldSim, a: Station, b: Station, maxRisk = 100): { hops: number; risk: number } | null {
  const s = h.sysOf(a.pos), e = h.sysOf(b.pos); if (!s || !e) return null;
  const r = (id: string) => 100 - effSec(h.st.systems[id]);
  if (r(s.id) > maxRisk + EPS || r(e.id) > maxRisk + EPS) return null;
  if (s.id === e.id) return { hops: 0, risk: r(s.id) };
  const q = [{ id: s.id, hops: 0, risk: r(s.id) }], seen = new Set([s.id]);
  while (q.length) {
    const n = q.shift()!;
    for (const g of [...(h.st.systems[n.id]?.gates ?? [])].sort((x, y) => x.id.localeCompare(y.id))) {
      const nx = h.st.systems[g.to]; if (!nx || seen.has(nx.id) || !usableRouteGate(h.st, g) || r(nx.id) > maxRisk + EPS) continue;
      const v = { id: nx.id, hops: n.hops + 1, risk: Math.max(n.risk, r(nx.id)) };
      if (nx.id === e.id) return { hops: v.hops, risk: v.risk };
      seen.add(nx.id); q.push(v);
    }
  }
  return null;
}
function poolShips(h: WorldSim, owner: string) {
  return Object.values(h.st.ships).filter(s => s.owner === owner && s.logisticsPool && s.hp > 0 && econOf(s).cargo > 0 && !econOf(s).military);
}
const outstanding = (j: { amount: number; cycleDelivered: number }) => Math.max(0, j.amount - j.cycleDelivered);
const liveJob = (j: { state: string }) => j.state !== 'complete' && j.state !== 'cancelled';
function incomingTo(h: WorldSim, owner: string, station: string, item: string) {
  return Object.values(h.st.logisticsJobs ?? {}).filter(j => j.owner === owner && j.to === station && j.item === item && j.kind !== 'sell' && liveJob(j)).reduce((n, j) => n + outstanding(j), 0);
}
/** units at `station` already promised to unreserved outbound pool requests */
function outboundClaims(h: WorldSim, owner: string, station: string, item: string) {
  return Object.values(h.st.logisticsJobs ?? {}).filter(j => j.owner === owner && j.from === station && j.item === item && liveJob(j)).reduce((n, j) => n + Math.max(0, outstanding(j) - j.reserved - j.carried), 0);
}
/** free stock at a station after protections, outbound promises and other goals' targets */
export function freeStock(h: WorldSim, owner: string, station: Station, item: string, exceptGoal?: string) {
  const co = h.st.companies[owner];
  const protectedN = co.procurement?.protectedStock[station.id]?.[item] ?? 0;
  const goalHold = Object.values(h.st.works ?? {}).filter(w => w.owner === owner && w.id !== exceptGoal && !terminal(w) && w.goal?.k === 'stockpile' && w.goal.station === station.id && w.goal.item === item).reduce((n, w) => n + (w.goal as Extract<GoalSpec, { k: 'stockpile' }>).target, 0);
  return Math.max(0, qty(station.storage[owner], item) - protectedN - goalHold - outboundClaims(h, owner, station.id, item));
}

// ─────────────────────────────────────────────────────────────────────── goals

export function createGoal(h: WorldSim, owner: string, spec: GoalSpec, opts: { title?: string; priority?: number; budget?: number; maxPrice?: number } = {}): string | null {
  if (!growthOn(h.st)) return '이 세계에서는 회사 목표를 사용할 수 없습니다';
  const co = h.st.companies[owner]; if (!co || co.kind !== 'player') return '알 수 없는 회사';
  if (!spec || typeof spec !== 'object') return '목표를 확인하세요';
  if (opts.priority !== undefined && (!Number.isSafeInteger(opts.priority) || opts.priority < 0 || opts.priority > 9)) return '우선순위는 0–9';
  if (opts.budget !== undefined && !finite(opts.budget)) return '예산을 확인하세요';
  if (opts.maxPrice !== undefined && !finite(opts.maxPrice)) return '최대 단가를 확인하세요';
  const live = Object.values(h.st.works ?? {}).filter(w => w.owner === owner && !terminal(w) && GOAL_KINDS.includes(w.kind));
  if (live.length >= 40) return '진행 중인 회사 목표는 40개까지';
  const ownStation = (id: unknown) => typeof id === 'string' && Object.hasOwn(h.st.stations, id) && (h.st.stations[id].owner === owner || h.st.stations[id].public && h.canDock(h.st.stations[id], owner)) ? h.st.stations[id] : undefined;
  let title = opts.title, mode: WorkMode = 'once', total = 1, unit = '';
  switch (spec.k) {
    case 'stockpile': {
      const st = ownStation(spec.station); if (!st) return '자사 정거장 또는 이용 가능한 공용 정거장을 선택하세요';
      if (!safeItem(spec.item)) return '품목을 확인하세요';
      if (!finite(spec.target, 1e7) || spec.target < 1) return '목표 수량을 확인하세요';
      const sp = spec;
      if (live.some(w => w.goal?.k === 'stockpile' && w.goal.station === sp.station && w.goal.item === sp.item)) return '같은 정거장·품목의 비축 목표가 이미 있습니다 — 기존 목표의 수량을 바꾸세요';
      spec = { k: 'stockpile', station: st.id, item: spec.item, target: Math.floor(spec.target), maintain: !!spec.maintain, buy: spec.buy !== false, produce: spec.produce !== false };
      title ??= `${st.name} · ${itemName(spec.item)} ${fmt(spec.target)} ${spec.maintain ? '비축 유지' : '확보'}`; mode = spec.maintain ? 'maintain' : 'once'; total = spec.target; unit = itemName(spec.item);
      break;
    }
    case 'trade': {
      const a = ownStation(spec.from), b = ownStation(spec.to);
      if (!a?.market?.[spec.item] || !b?.market?.[spec.item]) return '두 시장 모두 이 품목을 거래해야 합니다';
      if (a.id === b.id) return '서로 다른 시장을 선택하세요';
      if (!safeItem(spec.item) || !finite(spec.amount, 1e6) || spec.amount < 1 || !finite(spec.maxBuy) || !finite(spec.minSell) || !finite(spec.minProfit ?? 0) || !Number.isSafeInteger(spec.cycles) || spec.cycles < 0) return '거래 조건을 확인하세요';
      spec = { k: 'trade', item: spec.item, from: a.id, to: b.id, amount: Math.floor(spec.amount), maxBuy: spec.maxBuy, minSell: spec.minSell, minProfit: spec.minProfit ?? 0, cycles: spec.cycles };
      title ??= `반복 무역 · ${itemName(spec.item)} ${a.name} → ${b.name}`; mode = 'repeat'; total = spec.cycles || 0; unit = '회';
      break;
    }
    case 'fleet': {
      const st = ownStation(spec.station); if (!st || st.owner !== owner) return '자사 조선소 정거장을 선택하세요';
      if (typeof spec.hull !== 'string' || !Object.hasOwn(CONTENT.hulls, spec.hull)) return '선체를 확인하세요';
      if (!Number.isSafeInteger(spec.count) || spec.count < 1 || spec.count > 50) return '척수는 1–50';
      spec = { k: 'fleet', station: st.id, hull: spec.hull, variant: spec.variant, preset: spec.preset, count: spec.count, group: spec.group };
      title ??= `${st.name} · ${CONTENT.hulls[spec.hull].name} ${spec.count}척 건조`; total = spec.count; unit = '척';
      break;
    }
    case 'facilities': {
      const st = ownStation(spec.station); if (!st || st.owner !== owner) return '자사 정거장을 선택하세요';
      if (typeof spec.kind !== 'string' || !Object.hasOwn(MODULES, spec.kind) || spec.kind === 'core') return '시설 종류를 확인하세요';
      if (!Number.isSafeInteger(spec.count) || spec.count < 1 || spec.count > 20) return '개수는 1–20';
      spec = { k: 'facilities', station: st.id, kind: spec.kind, count: spec.count };
      title ??= `${st.name} · ${MODULES[spec.kind].name} ${spec.count}개 확보`; total = spec.count; unit = '개';
      break;
    }
    case 'condition': {
      const st = ownStation(spec.station); if (!st?.market?.[spec.item]) return '이 품목을 거래하는 시장을 선택하세요';
      if (!safeItem(spec.item) || (spec.side !== 'buy' && spec.side !== 'sell') || !finite(spec.price) || spec.price <= 0 || !finite(spec.amount, 1e6) || spec.amount < 1) return '조건을 확인하세요';
      spec = { k: 'condition', station: st.id, item: spec.item, side: spec.side, price: spec.price, amount: Math.floor(spec.amount), repeat: !!spec.repeat };
      title ??= `${st.name} · ${itemName(spec.item)} ${spec.side === 'buy' ? `${fmt(spec.price)} cr 이하 구매` : `${fmt(spec.price)} cr 이상 판매`} ${fmt(spec.amount)}`; mode = 'condition'; total = spec.amount;
      break;
    }
    default: return '알 수 없는 목표 종류';
  }
  const w = addWork(h, owner, spec.k, title!, { station: spec.k === 'trade' ? spec.from : spec.station, item: spec.k === 'fleet' || spec.k === 'facilities' ? undefined : spec.item }, { mode, goal: spec, priority: opts.priority ?? 5, progress: { done: 0, total, unit } });
  delete w.parent; delete w.auto;
  if (opts.budget !== undefined || opts.maxPrice !== undefined) w.budget = { limit: opts.budget ?? 0, spent: 0, ...(opts.maxPrice ? { maxPrice: opts.maxPrice } : {}) };
  setState(h, w, 'running', '계획 수립 중');
  runGoal(h, w);
  return null;
}

function runGoal(h: WorldSim, w: Work) {
  if (terminal(w) || w.state === 'paused' || !w.goal) return;
  (w.rt ??= {}).lastRun = h.time;
  const co = h.st.companies[w.owner]; if (!co) return setState(h, w, 'failed', '회사 없음');
  switch (w.goal.k) {
    case 'stockpile': return runStockpile(h, w, w.goal);
    case 'fleet': return runFleet(h, w, w.goal);
    case 'facilities': return runFacilities(h, w, w.goal);
    case 'trade': return runTrade(h, w, w.goal);
    case 'condition': return runCondition(h, w, w.goal);
  }
}
const liveChildren = (h: WorldSim, w: Work, kind?: WorkKind) => children(h, w).filter(c => !terminal(c) && (!kind || c.kind === kind));
function cmd(h: WorldSim, w: Work, c: Cmd): string | null { return withParent(w.id, () => h.command(w.owner, c)); }

function runStockpile(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'stockpile' }>) {
  const st = h.st.stations[g.station]; if (!st) return setState(h, w, 'failed', '목표 정거장 소실');
  const co = h.st.companies[w.owner], pol = opsOf(co).policy;
  const have = qty(st.storage[w.owner], g.item), incoming = incomingTo(h, w.owner, st.id, g.item);
  w.progress = { done: Math.min(have, g.target), total: g.target, unit: itemName(g.item) };
  const prod = w.rt?.order ? st.orders?.find(o => o.id === w.rt!.order) : undefined;
  if (!g.maintain && have >= g.target - EPS) {
    if (prod) cmd(h, w, { c: 'prodOp', station: st.id, order: prod.id, op: 'cancel' });
    for (const c of liveChildren(h, w, 'transport')) { const j = h.st.logisticsJobs?.[c.ref.job ?? '']; if (j && !j.ship && j.reserved <= EPS) cmd(h, w, { c: 'poolControl', job: j.id, action: 'cancel' }); }
    w.result = `${itemName(g.item)} ${fmt(have)} 확보`; resolveOpen(h, w, 'purchase', '목표 달성'); resolveOpen(h, w, 'budget', '목표 달성');
    return setState(h, w, 'done', '');
  }
  let deficit = g.target - have - incoming;
  const parts: string[] = [];
  if (incoming > EPS) parts.push(`운송 중·예정 ${fmt(incoming)}`);
  if (deficit <= EPS) { for (const k of ['purchase', 'budget', 'credits', 'risk']) resolveOpen(h, w, k, '부족분이 이미 확보됨'); return setState(h, w, 'running', parts.join(' · ') || '목표 재고 유지 중'); }
  const ships = poolShips(h, w.owner), maxCargo = ships.length ? Math.max(...ships.map(s => econOf(s).cargo)) : 0;
  const capChildren = liveChildren(h, w, 'transport').length >= MAX_LIVE_CHILDREN;
  // 1) company stock elsewhere
  const sources = ships.length ? Object.values(h.st.stations).filter(s => s.id !== st.id && (h.canDock(s, w.owner)) && freeStock(h, w.owner, s, g.item, w.id) >= 1 && routeRisk(h, s, st, pol.maxRisk))
    .sort((a, b) => (routeRisk(h, a, st, pol.maxRisk)!.hops - routeRisk(h, b, st, pol.maxRisk)!.hops) || a.id.localeCompare(b.id)) : [];
  if (sources.length && !capChildren) {
    let blocked = false;
    for (const s of sources) {
      let moved = 0;
      // one request per ship-load, until this source's free stock or the shortfall is used up
      while (!blocked && deficit >= 1 && liveChildren(h, w, 'transport').length < MAX_LIVE_CHILDREN) {
        const n = Math.floor(Math.min(deficit, freeStock(h, w.owner, s, g.item, w.id), maxCargo));
        if (n < 1) break;
        const err = cmd(h, w, { c: 'poolCreate', request: { from: s.id, to: st.id, item: g.item, kind: 'transfer', amount: n, priority: w.priority, repeat: false } });
        if (err) { parts.push(`이송 불가: ${err}`); blocked = true; break; }
        deficit -= n; moved += n;
      }
      if (moved) parts.push(`${s.name}에서 ${fmt(moved)} 이송`);
      if (blocked || deficit < 1) break;
    }
  }
  // stock still free elsewhere but waiting for transport slots: never buy what the company already has
  const pending = liveChildren(h, w, 'transport').length >= MAX_LIVE_CHILDREN ? sources.reduce((n, s) => n + freeStock(h, w.owner, s, g.item, w.id), 0) : 0;
  if (pending >= 1) { deficit -= pending; parts.push(`자사 재고 ${fmt(pending)} 이송 대기`); }
  if (deficit <= EPS) return setState(h, w, 'running', parts.join(' · '));
  // 2) own production at the target station
  const recipe = g.produce && pol.preferProduce ? Object.values(RECIPES).map(r => recipeFor(h.st, r.id)!).find(r => r && Object.keys(r.out)[0] === g.item && recipeOk(r, co) && facLines(st, r.fac) > 0 && (!r.growth || growthOn(h.st))) : undefined;
  if (recipe && st.owner === w.owner) {
    let order = prod;
    if (!order) {
      const err = cmd(h, w, { c: 'prodOrder', station: st.id, recipe: recipe.id, mode: 'stock', n: g.target });
      if (!err) { order = st.orders?.at(-1); (w.rt ??= {}).order = order?.id; parts.push(`${recipe.name} 생산 주문 등록`); }
      else parts.push(`생산 불가: ${err}`);
    } else if (order.n !== g.target) cmd(h, w, { c: 'prodOp', station: st.id, order: order.id, op: 'set', n: g.target });
    if (order) {
      if (order.paused) cmd(h, w, { c: 'prodOp', station: st.id, order: order.id, op: 'resume' });
      parts.push(order.why ? `생산 대기: ${order.why}` : '자체 생산으로 확보 중');
      return setState(h, w, order.why ? 'waiting' : 'running', parts.join(' · '));
    }
  }
  // 3) purchase
  if (!g.buy) return setState(h, w, 'waiting', [...parts, '구매 비허용 — 내부 재고·생산 대기'].join(' · '));
  if ((w.rt?.noBuyUntil ?? 0) > h.time) return setState(h, w, 'waiting', [...parts, `구매 보류 중 (결재 거절·대기) — ${fmt(deficit)} 부족`].join(' · '));
  return buyFor(h, w, st, g.item, deficit, parts);
}

/** cheapest safe market purchase + transfer; raises the matching approval when not authorised */
function buyFor(h: WorldSim, w: Work, st: Station, item: string, need: number, parts: string[]) {
  const co = h.st.companies[w.owner], pol = opsOf(co).policy;
  const ships = poolShips(h, w.owner), maxCargo = ships.length ? Math.max(...ships.map(s => econOf(s).cargo)) : 0;
  const markets = Object.values(h.st.stations).filter(s => s.public && s.market?.[item] && s.market[item].stock >= 1 && h.canDock(s, w.owner) && h.price(s, item, 'buy') > 0);
  if (!markets.length) return setState(h, w, 'waiting', [...parts, `${itemName(item)}을(를) 파는 시장 없음 — ${fmt(need)} 부족`].join(' · '));
  const local = markets.find(s => s.id === st.id);
  if (!local && !ships.length) return setState(h, w, 'waiting', [...parts, '공용 배차 수송선이 없어 구매품을 옮길 수 없음 — 물류 관리에서 함선을 참여시키세요'].join(' · '));
  const riskOk = Math.max(pol.maxRisk, w.rt?.riskOk ?? 0);
  type Cand = { s: Station; price: number; hops: number; risk: number };
  // without pool haulers only the target's own market can be used; otherwise a remote market must beat it by the haul premium
  const effCost = (c: { s: Station; price: number; hops: number }) => c.price * (1 + c.hops * 0.01 + (c.s.id === st.id ? 0 : 0.02));
  const cand = (limit: number) => markets.filter(s => ships.length || s.id === st.id).map(s => { const r = s.id === st.id ? { hops: 0, risk: 0 } : routeRisk(h, s, st, limit); return r ? { s, price: h.price(s, item, 'buy'), ...r } : undefined; }).filter((x): x is Cand => !!x).sort((a, b) => effCost(a) - effCost(b) || a.s.id.localeCompare(b.s.id));
  const safe = cand(riskOk), any = cand(100);
  const holder = budgetHolder(h, w), maxPrice = holder.budget?.maxPrice;
  const pick = safe[0];
  // a markedly cheaper market only reachable through riskier space → ask, with both options
  const risky = any[0] && (!pick || any[0].price < pick.price * 0.85) && any[0].risk > riskOk ? any[0] : undefined;
  if (risky && (w.rt?.riskOk ?? 0) >= 0) {
    const est = Math.ceil(need) * risky.price;
    const ap = purchaseApproval(h, w, { ok: false, kind: 'purchase', why: `가장 유리한 시장이 위험 허용치(${pol.maxRisk})를 넘는 경로에 있음` }, [{ item, amount: Math.ceil(need), price: risky.price, station: risky.s.id }],
      { risk: { level: risky.risk, hops: risky.hops, note: `${risky.hops}점프 · 경로 최대 위험도 ${Math.round(risky.risk)} (보안 등급 기반 추정 — 실제 교전 여부는 알 수 없음)` }, alt: pick ? { station: pick.s.id, cost: Math.ceil(need) * pick.price, hops: pick.hops, risk: pick.risk } : undefined,
        context: `${st.name}에 ${itemName(item)} ${fmt(need)} 부족. 위험 경로 ${risky.s.name} 단가 ${fmt(risky.price)} cr${pick ? ` / 안전 경로 ${pick.s.name} 단가 ${fmt(pick.price)} cr` : ' / 안전 경로 시장 없음'}` });
    if (ap) return setState(h, w, 'waiting', [...parts, '경로 위험 결재 대기 — 다른 업무는 계속 진행'].join(' · '));
  }
  const use = (w.rt?.riskOk ?? 0) > pol.maxRisk && any[0] ? any[0] : pick;
  if (!use) return setState(h, w, 'waiting', [...parts, `위험 허용치 안의 경로로 갈 수 있는 시장 없음`].join(' · '));
  if (maxPrice !== undefined && use.price > maxPrice + EPS) {
    const ap = purchaseApproval(h, w, { ok: false, kind: 'budget', why: `시장가 ${fmt(use.price)} cr가 승인 단가 ${fmt(maxPrice)} cr 초과` }, [{ item, amount: Math.ceil(need), price: use.price, station: use.s.id }], { context: `${use.s.name} ${itemName(item)} 단가 상승 — 승인 당시보다 비쌉니다` });
    return setState(h, w, 'waiting', [...parts, ap ? '단가 상승 결재 대기' : '단가 상한 초과 — 가격 하락 대기'].join(' · '));
  }
  const destRoom = st.id === use.s.id ? Infinity : Math.max(0, h.room(st, w.owner) - incomingTo(h, w.owner, st.id, item));
  const batch = Math.floor(Math.min(need, use.s.market![item].stock, h.room(use.s, w.owner), destRoom, st.id === use.s.id ? Infinity : maxCargo * Math.max(1, Math.min(3, ships.length))) + EPS);
  if (batch < 1) return setState(h, w, 'waiting', [...parts, h.room(use.s, w.owner) < 1 ? `${use.s.name} 보관 공간 부족 — 구획 임대 필요` : destRoom < 1 ? '목적지 보관 공간 부족 — 창고 증설 또는 재고 이동' : '시장 재고 부족'].join(' · '));
  // money: buy what the balance allows; a pure lack of funds is a waiting reason, not a decision
  const pol2 = opsOf(co).policy, floor = (w.rt?.creditsOk ?? -1) >= h.time ? 0 : pol2.minCredits;
  const affordable = Math.floor((co.credits - floor) / use.price + EPS);
  if (affordable < 1 && co.credits < use.price) return setState(h, w, 'waiting', [...parts, `자금 부족 — ${fmt(use.price)} cr/개, 보유 ${fmt(co.credits)} cr · 수입 발생 시 자동 재개`].join(' · '));
  const batchN = affordable >= 1 ? Math.min(batch, affordable) : batch;
  const cost = batchN * use.price, whole = Math.ceil(need) * use.price;
  const auth = authorize(h, w, cost, use.price, item, whole);
  if (!auth.ok) {
    purchaseApproval(h, w, auth, [{ item, amount: Math.ceil(need), price: use.price, station: use.s.id }], { context: `${st.name}에 ${itemName(item)} ${fmt(need)} 부족 — 자사 재고${parts.length ? '·이송' : ''}로 충당되지 않음. 최저가 시장 ${use.s.name} (${use.hops}점프, 추정)` });
    return setState(h, w, 'waiting', [...parts, `결재 대기: ${auth.why}`].join(' · '));
  }
  if (st.id !== use.s.id && liveChildren(h, w, 'transport').length >= MAX_LIVE_CHILDREN) return setState(h, w, 'running', [...parts, '진행 중인 운송 완료 대기'].join(' · '));
  const before = co.credits, stockBefore = qty(use.s.storage[w.owner], item);
  const err = cmd(h, w, { c: 'buy', station: use.s.id, res: item, amount: batchN });
  if (err) return setState(h, w, 'waiting', [...parts, `구매 실패: ${err}`].join(' · '));
  const paid = before - co.credits, got = Math.max(0, qty(use.s.storage[w.owner], item) - stockBefore);
  charge(h, w, paid, use.price, item);
  for (const k of ['purchase', 'budget', 'credits']) resolveOpen(h, w, k, '권한 범위 안에서 구매 진행');
  parts.push(`${use.s.name}에서 ${fmt(got)} 구매 (${fmt(paid)} cr)`);
  if (st.id !== use.s.id && got >= 1) {
    const e2 = cmd(h, w, { c: 'poolCreate', request: { from: use.s.id, to: st.id, item, kind: 'transfer', amount: Math.floor(got), priority: w.priority, repeat: false } });
    if (e2) parts.push(`운송 등록 실패: ${e2} — 구매품은 ${use.s.name} 보관함에 보존`);
  }
  return setState(h, w, 'running', parts.join(' · '));
}

function runFleet(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'fleet' }>) {
  const st = h.st.stations[g.station]; if (!st || st.owner !== w.owner) return setState(h, w, 'failed', '조선소 정거장 소실');
  const kids = children(h, w).filter(c => c.kind === 'ship');
  const launched = kids.filter(c => c.state === 'done').length, live = kids.filter(c => !terminal(c)).length;
  w.progress = { done: launched, total: g.count, unit: '척' };
  if (launched >= g.count) { w.result = `${g.count}척 진수 완료`; return setState(h, w, 'done', ''); }
  const parts = [`진수 ${launched}/${g.count}`, live ? `건조 중·대기 ${live}` : ''].filter(Boolean);
  if (launched + live >= g.count || live >= 2) return setState(h, w, 'running', parts.join(' · '));
  return startHull(h, w, g, st, launched, live, parts);
}
function startHull(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'fleet' }>, st: Station, launched: number, live: number, parts: string[]): void {
  const variant = g.variant ?? (g.preset ? CONTENT.presets[g.preset]?.variant : undefined) ?? `${g.hull}_std`;
  let est = 0; try { const b = hullBuild(g.hull, variant); est = b.credits + yardFee(b); } catch { est = 0; }
  const auth = authorize(h, w, est, est, `hull:${g.hull}`, est * (g.count - launched - live));
  if (!auth.ok) {
    purchaseApproval(h, w, auth, [{ item: `hull:${g.hull}`, amount: g.count - launched - live, price: est, station: st.id }], { context: `${st.name}에서 ${CONTENT.hulls[g.hull]?.name ?? g.hull} 착공 비용(인건비+조선소 운영비) 척당 ${fmt(est)} cr — 자재는 생산·조달 체계가 확보` });
    return setState(h, w, 'waiting', [...parts, `결재 대기: ${auth.why}`].join(' · '));
  }
  const before = h.st.companies[w.owner].credits;
  const err = cmd(h, w, { c: 'buildShip', station: st.id, classId: CONTENT.hulls[g.hull]?.classId ?? '', loadoutId: '', hull: g.hull, variant, preset: g.preset, group: g.group });
  if (err) return setState(h, w, 'waiting', [...parts, `착공 불가: ${err}`].join(' · '));
  const paid = before - h.st.companies[w.owner].credits;
  // the child ship work already charged the goal budget (chargeParent); count it toward the hourly limit and goal cost
  const co = h.st.companies[w.owner]; opsOf(co).spend.push({ t: h.time, n: paid }); w.cost += paid;
  for (const k of ['purchase', 'budget']) resolveOpen(h, w, k, '권한 범위 안에서 착공');
  live++; parts.push('추가 착공');
  if (launched + live < g.count && live < 2) return startHull(h, w, g, st, launched, live, parts);
  return setState(h, w, 'running', parts.join(' · '));
}

function runFacilities(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'facilities' }>) {
  const st = h.st.stations[g.station]; if (!st || st.owner !== w.owner) return setState(h, w, 'failed', '정거장 소실');
  const built = st.modules.filter(m => m.kind === g.kind && m.built).length, planned = st.modules.filter(m => m.kind === g.kind && !m.built).length;
  w.progress = { done: Math.min(built, g.count), total: g.count, unit: '개' };
  if (built >= g.count) { w.result = `${MODULES[g.kind]?.name ?? g.kind} ${built}개 가동`; return setState(h, w, 'done', ''); }
  if (built + planned >= g.count || planned >= 1) return setState(h, w, 'running', `가동 ${built} · 건설 중 ${planned}`);
  const est = facilityBuild(MODULES[g.kind], true).credits;
  const auth = authorize(h, w, est, est, `fac:${g.kind}`, est * (g.count - built - planned));
  if (!auth.ok) {
    purchaseApproval(h, w, auth, [{ item: `fac:${g.kind}`, amount: g.count - built - planned, price: est, station: st.id }], { context: `${st.name}에 ${MODULES[g.kind]?.name ?? g.kind} 추가 착공 비용 개당 ${fmt(est)} cr — 자재는 조달 체계가 확보` });
    return setState(h, w, 'waiting', `결재 대기: ${auth.why}`);
  }
  const err = cmd(h, w, { c: 'queueModule', station: st.id, kind: g.kind });
  if (err) return setState(h, w, 'waiting', `착공 불가: ${err}`);
  opsOf(h.st.companies[w.owner]).spend.push({ t: h.time, n: est }); w.cost += est;
  return setState(h, w, 'running', `가동 ${built} · 추가 착공`);
}

function runTrade(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'trade' }>) {
  const a = h.st.stations[g.from], b = h.st.stations[g.to]; if (!a?.market?.[g.item] || !b?.market?.[g.item]) return setState(h, w, 'failed', '시장 소실');
  const rt = (w.rt ??= {}); rt.phase ??= 'buy'; rt.cycles ??= 0; rt.losses ??= 0; rt.profit ??= 0;
  w.progress = { done: rt.cycles, total: g.cycles || 0, unit: '회' };
  if (rt.phase === 'move') {
    const j = h.st.logisticsJobs?.[rt.cycleJob ?? ''];
    if (j && liveJob(j)) return setState(h, w, 'running', `${rt.cycles + 1}회차 운송·판매 중 · 누적 손익 ${fmt(rt.profit)} cr`);
    const earned = j?.earned ?? 0, profit = earned - (rt.cycleCost ?? 0);
    // learn how much of the quoted sell price a sale of this size really realises (price walks down, taxes)
    if (rt.sellQuote && rt.bought) { const r = earned / (rt.sellQuote * rt.bought); rt.sellRatio = Math.max(0.2, Math.min(1.05, rt.sellRatio === undefined ? r : (rt.sellRatio + r) / 2)); }
    rt.cycles++; rt.profit += profit; w.income = (w.income ?? 0) + earned; rt.phase = 'buy';
    note(w, h.time, `${rt.cycles}회차 정산: 매입 ${fmt(rt.cycleCost ?? 0)} · 매출 ${fmt(earned)} · ${profit >= 0 ? '이익' : '손실'} ${fmt(Math.abs(profit))} cr${j && j.lost ? ` · 손실 화물 ${fmt(j.lost)}` : ''}`);
    rt.losses = profit < 0 ? rt.losses + 1 : 0;
    if (g.cycles && rt.cycles >= g.cycles) { w.result = `${rt.cycles}회 완료 · 누적 손익 ${fmt(rt.profit)} cr`; return setState(h, w, 'done', ''); }
    if (rt.losses >= 2) {
      raise(h, w, 'loss', 'loss', {
        title: `${w.title} — 연속 손실`, reason: '최근 2회 연속 손실로 자동 반복을 멈췄습니다', situation: `누적 손익 ${fmt(rt.profit)} cr · 매수 ${fmt(h.price(a, g.item, 'buy'))} / 매도 ${fmt(h.price(b, g.item, 'sell'))} cr (현재 시세)`, items: [],
        estimate: { cost: 0, note: '판매가는 운송 도착 시점의 시장가·구매 예산에 따라 달라집니다' },
        options: [{ id: 'approve', label: '조건 유지하고 재개', detail: '손실 위험을 감수하고 다음 회차를 진행합니다', scopes: ['once'] }, { id: 'cancel', label: '반복 무역 종료', detail: '진행 중 화물은 그대로 도착·판매', recommended: true, scopes: ['once'] }, { id: 'reject', label: '정지 상태 유지', detail: '조건을 바꾼 뒤 직접 재개하세요', scopes: ['once'] }],
        rejectEffect: '반복 무역은 정지 상태로 남습니다', scopeNote: '이번 결정만 적용',
      });
      w.state = 'paused'; w.reason = '연속 손실 — 결재 대기'; w.updated = h.time; return;
    }
  }
  const buy = h.price(a, g.item, 'buy'), sell = h.price(b, g.item, 'sell');
  // expected realised price: the quote times the ratio actually realised by earlier cycles (0.9 until measured)
  const ratio = rt.sellRatio ?? 0.9, expect = sell * ratio;
  if (buy > g.maxBuy + EPS) return setState(h, w, 'waiting', `매수가 ${fmt(buy)} cr > 상한 ${fmt(g.maxBuy)} cr — 대기`);
  if (sell < g.minSell - EPS || (expect - buy) * g.amount < g.minProfit - EPS || expect <= buy) return setState(h, w, 'waiting', `매도 호가 ${fmt(sell)} cr · 실현 예상 ${fmt(expect)} cr (${rt.sellRatio === undefined ? '초기 추정 90%' : `지난 회차 실현율 ${Math.round(ratio * 100)}%`}) vs 매수 ${fmt(buy)} cr — 수익 조건 미충족, 대기`);
  const ships = poolShips(h, w.owner); if (!ships.length) return setState(h, w, 'waiting', '공용 배차 수송선이 없습니다');
  const r = routeRisk(h, a, b, Math.max(opsOf(h.st.companies[w.owner]).policy.maxRisk, rt.riskOk ?? 0));
  if (!r) {
    const any = routeRisk(h, a, b, 100);
    if (any) raise(h, w, 'risk', 'risk', { title: `${w.title} — 위험 경로`, reason: `경로 위험도 ${Math.round(any.risk)}가 허용치를 넘습니다`, situation: `${a.name} → ${b.name}: ${any.hops}점프 (보안 등급 기반 추정)`, items: [], estimate: { cost: buy * g.amount, note: '1회차 매입 추정' }, risk: { level: any.risk, hops: any.hops, note: '보안 등급 기반 추정 — 실제 교전 여부는 알 수 없음' }, options: [{ id: 'approve', label: '위험 경로로 진행', detail: '이 목표에 한해 위험 경로를 허용합니다', scopes: ['work'] }, { id: 'pause', label: '일시정지', detail: '', recommended: true, scopes: ['once'] }, { id: 'reject', label: '거절', detail: '6시간 동안 다시 묻지 않음', scopes: ['once'] }], rejectEffect: '무역을 진행하지 않습니다', scopeNote: '이 목표 전체' });
    return setState(h, w, 'waiting', any ? '경로 위험 결재 대기' : '경로 없음');
  }
  const n = Math.floor(Math.min(g.amount, a.market![g.item].stock, h.room(a, w.owner), Math.max(...ships.map(s => econOf(s).cargo))));
  if (n < 1) return setState(h, w, 'waiting', '시장 재고 또는 보관 공간 부족');
  const cost = n * buy, auth = authorize(h, w, cost, buy, g.item, cost);
  if (!auth.ok) { purchaseApproval(h, w, auth, [{ item: g.item, amount: n, price: buy, station: a.id }], { context: `${rt.cycles + 1}회차 매입 — 예상 매도가 ${fmt(sell)} cr (현재 시세, 도착 시 달라질 수 있음)` }); return setState(h, w, 'waiting', `결재 대기: ${auth.why}`); }
  const co = h.st.companies[w.owner], before = co.credits, held = qty(a.storage[w.owner], g.item);
  const err = cmd(h, w, { c: 'buy', station: a.id, res: g.item, amount: n }); if (err) return setState(h, w, 'waiting', `매입 실패: ${err}`);
  const paid = before - co.credits, got = Math.floor(qty(a.storage[w.owner], g.item) - held + EPS); charge(h, w, paid, buy, g.item);
  const ids = Object.keys(h.st.logisticsJobs ?? {}).length;
  const e2 = cmd(h, w, { c: 'poolCreate', request: { from: a.id, to: b.id, item: g.item, kind: 'sell', amount: got, priority: w.priority, repeat: false } });
  if (e2) return setState(h, w, 'waiting', `운송 등록 실패: ${e2} — 매입품은 ${a.name} 보관함에 보존`);
  rt.cycleJob = Object.keys(h.st.logisticsJobs ?? {})[ids]; rt.cycleCost = paid; rt.phase = 'move'; rt.sellQuote = sell; rt.bought = got;
  return setState(h, w, 'running', `${rt.cycles + 1}회차: ${fmt(got)} 매입 (${fmt(paid)} cr) → ${b.name} 판매 운송`);
}

function runCondition(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'condition' }>) {
  const st = h.st.stations[g.station]; if (!st?.market?.[g.item]) return setState(h, w, 'failed', '시장 소실');
  const p = h.price(st, g.item, g.side);
  if (g.side === 'buy' ? p > g.price + EPS : p < g.price - EPS) return setState(h, w, 'waiting', `현재 ${fmt(p)} cr — 조건 ${g.side === 'buy' ? '이하' : '이상'} ${fmt(g.price)} cr 대기`);
  const co = h.st.companies[w.owner], before = co.credits;
  if (g.side === 'buy') {
    const n = Math.floor(Math.min(g.amount, st.market[g.item].stock, h.room(st, w.owner)));
    if (n < 1) return setState(h, w, 'waiting', '시장 재고 또는 보관 공간 부족');
    const auth = authorize(h, w, n * p, p, g.item);
    if (!auth.ok) { purchaseApproval(h, w, auth, [{ item: g.item, amount: n, price: p, station: st.id }], { context: '가격 조건 충족' }); return setState(h, w, 'waiting', `결재 대기: ${auth.why}`); }
    const err = cmd(h, w, { c: 'buy', station: st.id, res: g.item, amount: n }); if (err) return setState(h, w, 'waiting', err);
    charge(h, w, before - co.credits, p, g.item);
  } else {
    const n = Math.floor(Math.min(g.amount, qty(st.storage[w.owner], g.item)));
    if (n < 1) return setState(h, w, 'waiting', '판매할 보관 재고 없음');
    const err = cmd(h, w, { c: 'sell', station: st.id, res: g.item, amount: n }); if (err) return setState(h, w, 'waiting', err);
    w.income = (w.income ?? 0) + (co.credits - before);
  }
  (w.rt ??= {}).triggered = (w.rt.triggered ?? 0) + 1;
  w.progress = { done: w.rt.triggered, total: g.repeat ? 0 : 1 };
  if (!g.repeat) { w.result = `${g.side === 'buy' ? '구매' : '판매'} 실행 · ${fmt(Math.abs(co.credits - before))} cr`; return setState(h, w, 'done', ''); }
  return setState(h, w, 'running', `${w.rt.triggered}회 실행`);
}

// ─────────────────────────────────────────────── purchase approvals for orders

/** UI-ordered construction/production/ship work blocked only by missing purchase authority → one batched approval */
function procurementApprovals(h: WorldSim, w: Work) {
  if (!['facility', 'production', 'ship', 'station'].includes(w.kind) || terminal(w) || w.state === 'paused') return;
  const kind = w.kind === 'facility' || w.kind === 'station' ? 'construction' : w.kind === 'production' ? 'production' : 'ship';
  const source = kind === 'construction' ? (w.kind === 'station' ? h.st.stations[w.ref.station ?? '']?.modules.find(m => m.kind === 'core')?.id : w.ref.module) : kind === 'production' ? w.ref.order : w.ref.build;
  if (!source || !w.ref.station) return;
  const plans = Object.values(h.st.procurementPlans ?? {}).filter(p => p.owner === w.owner && p.station === w.ref.station && p.sourceKind === kind && p.sourceId === source && p.state !== 'closed' && p.shortage > EPS && /자동 구매 꺼짐|최대 단가|구매 예산/.test(p.reason));
  if (!plans.length) { resolveOpen(h, w, 'purchase', '자재가 확보됨'); return; }
  if ((w.rt?.noBuyUntil ?? 0) > h.time) return;
  const st = h.st.stations[w.ref.station]; if (!st) return;
  const items: Approval['items'] = [];
  for (const p of plans) {
    const m = Object.values(h.st.stations).filter(s => s.public && s.market?.[p.item] && s.market[p.item].stock >= 1 && h.canDock(s, w.owner)).map(s => ({ s, price: h.price(s, p.item, 'buy') })).filter(x => x.price > 0).sort((a, b) => a.price - b.price)[0];
    if (m) items.push({ item: p.item, amount: Math.ceil(p.shortage), price: m.price, station: m.s.id });
  }
  if (!items.length) return;
  const whole = items.reduce((n, x) => n + x.amount * x.price, 0);
  if (authorize(h, w, whole, Math.max(...items.map(x => x.price)), items[0].item, whole).ok) return;
  purchaseApproval(h, w, { ok: false, kind: 'purchase', why: '자사 재고로 부족 — 구매 권한 없음' }, items, { context: `${w.title}: 자사 재고·운송으로 충당되지 않는 자재 ${items.map(x => `${itemName(x.item)} ${fmt(x.amount)}`).join(', ')}` });
}

// ───────────────────────────────────────────────────────────── player control

export type WorkOp = 'pause' | 'resume' | 'cancel' | 'priority' | 'amount' | 'budget';
export function workOp(h: WorldSim, owner: string, id: string, op: WorkOp, value?: number, price?: number): string | null {
  const w = h.st.works?.[id]; if (!w || w.owner !== owner) return '자사 업무를 찾을 수 없습니다';
  if (!['pause', 'resume', 'cancel', 'priority', 'amount', 'budget'].includes(op)) return '알 수 없는 동작';
  if (terminal(w) && op !== 'budget') return '이미 끝난 업무입니다';
  const r = w.ref, st = r.station;
  const engine = (action: 'pause' | 'resume' | 'cancel'): string | null => {
    switch (w.kind) {
      case 'facility': return h.command(owner, { c: 'planOp', station: st!, plan: r.module!, op: action });
      case 'production': return h.command(owner, { c: 'prodOp', station: st!, order: r.order!, op: action });
      case 'ship': return h.command(owner, { c: 'buildOp', station: st!, build: r.build!, op: action });
      case 'research': return h.command(owner, { c: 'researchOp', project: r.research!, op: action });
      case 'transport': return h.command(owner, { c: 'poolControl', job: r.job!, action });
      case 'route': return h.command(owner, { c: 'routeControl', routes: [r.route!], action });
      case 'station':
        if (action !== 'cancel') return '정거장 설립 이동은 일시정지할 수 없습니다 — 취소하거나 부대 명령을 바꾸세요';
        if (r.station) return '부지 확보 후에는 정거장 화면에서 시설 계획을 관리하세요';
        return h.command(owner, { c: 'setOp', group: r.group!, op: { k: 'idle' } });
      case 'contract': return '계약은 계약 화면에서 관리합니다';
      default: return null;
    }
  };
  if (op === 'priority') {
    if (!Number.isSafeInteger(value) || value! < 0 || value! > 9) return '우선순위는 0–9';
    w.priority = value!;
    const kind = w.kind === 'facility' ? 'construction' : w.kind === 'production' ? 'production' : w.kind === 'ship' ? 'ship' : undefined;
    if (kind && st) h.command(owner, { c: 'procSource', station: st, kind, source: (kind === 'construction' ? r.module : kind === 'production' ? r.order : r.build)!, enabled: true, priority: value });
    if (w.kind === 'transport') { const j = h.st.logisticsJobs?.[r.job ?? '']; if (j && !j.ship) j.priority = value!; }
    for (const c of liveChildren(h, w)) if (c.kind === 'transport') { const j = h.st.logisticsJobs?.[c.ref.job ?? '']; if (j && !j.ship) j.priority = value!; c.priority = value!; }
    note(w, h.time, `우선순위 ${value}`); return null;
  }
  if (op === 'budget') {
    if (value !== undefined && !finite(value)) return '예산을 확인하세요';
    if (price !== undefined && !finite(price)) return '단가를 확인하세요';
    const b = (w.budget ??= { limit: 0, spent: 0 });
    if (value !== undefined) { b.limit = value; delete b.open; }
    if (price !== undefined) { if (price > 0) b.maxPrice = price; else delete b.maxPrice; }
    note(w, h.time, `예산 ${fmt(b.limit)} cr${b.maxPrice ? ` · 단가 상한 ${fmt(b.maxPrice)} cr` : ''}`); return null;
  }
  if (op === 'amount') {
    if (!finite(value, 1e7) || value! < 1) return '수량을 확인하세요';
    const g = w.goal;
    if (g?.k === 'stockpile') g.target = Math.floor(value!);
    else if (g?.k === 'fleet' || g?.k === 'facilities') g.count = Math.min(g.k === 'fleet' ? 50 : 20, Math.floor(value!));
    else if (g?.k === 'trade') g.cycles = Math.floor(value!);
    else if (g?.k === 'condition') g.amount = Math.floor(value!);
    else if (w.kind === 'production') { const err = h.command(owner, { c: 'prodOp', station: st!, order: r.order!, op: 'set', n: Math.floor(value!) }); if (err) return err; }
    else return '수량을 바꿀 수 없는 업무입니다';
    w.progress.total = Math.floor(value!); note(w, h.time, `수량 ${fmt(value!)}`);
    if (g) runGoal(h, w); return null;
  }
  // pause / resume / cancel
  if (GOAL_KINDS.includes(w.kind)) {
    if (op === 'resume') { if (w.state !== 'paused') return '일시정지된 업무만 재개할 수 있습니다'; setState(h, w, 'running', '재개'); }
    for (const c of liveChildren(h, w)) {
      if (op === 'cancel' && c.kind === 'transport') { const j = h.st.logisticsJobs?.[c.ref.job ?? '']; if (j && j.carried > EPS) continue; } // loaded cargo completes its trip
      if (op === 'resume' ? c.state === 'paused' : c.state !== 'paused' || op === 'cancel') workOp(h, owner, c.id, op);
    }
    if (op === 'pause') setState(h, w, 'paused', '플레이어가 일시정지함 — 적재된 화물은 계속 도착');
    if (op === 'cancel') setState(h, w, 'cancelled', '플레이어가 취소함 — 이미 지출한 비용과 적재 화물은 그대로');
    if (op === 'resume') runGoal(h, w);
    return null;
  }
  const err = engine(op); if (err) return err;
  if (op === 'cancel') { (w.rt ??= {}).cancelled = true; setState(h, w, 'cancelled', '플레이어가 취소함'); }
  else projectWork(h, w);
  return null;
}

export function setOpsPolicy(h: WorldSim, owner: string, p: Partial<OpsPolicy> & { autoBuyItem?: string; autoBuyPrice?: number }): string | null {
  const co = h.st.companies[owner]; if (!co || !growthOn(h.st) || !p || typeof p !== 'object') return '정책을 확인하세요';
  const pol = opsOf(co).policy;
  if (p.autonomy !== undefined && p.autonomy !== 'ask' && p.autonomy !== 'auto') return '자율 수준을 확인하세요';
  for (const k of ['minCredits', 'hourlyLimit', 'autoApproveBelow', 'delegatedBudget'] as const) if (p[k] !== undefined && !finite(p[k])) return '금액을 확인하세요';
  if (p.maxRisk !== undefined && (!finite(p.maxRisk) || p.maxRisk > 100)) return '위험 허용치는 0–100';
  if (p.autoBuyItem !== undefined && (!safeItem(p.autoBuyItem) || !finite(p.autoBuyPrice))) return '위임 품목과 단가를 확인하세요';
  if (p.autonomy) pol.autonomy = p.autonomy;
  for (const k of ['minCredits', 'hourlyLimit', 'autoApproveBelow', 'delegatedBudget', 'maxRisk'] as const) if (p[k] !== undefined) pol[k] = p[k]!;
  if (p.preferProduce !== undefined) pol.preferProduce = !!p.preferProduce;
  if (p.autoBuyItem) { if (p.autoBuyPrice! > 0) pol.autoBuy[p.autoBuyItem] = p.autoBuyPrice!; else delete pol.autoBuy[p.autoBuyItem]; }
  return null;
}

// ──────────────────────────────────────────────────────────────────── ledger

const seen = new WeakMap<WorldState, Map<string, number>>();
const hourOf = (t: number) => Math.floor(t / 3600);
/** book a credit movement (positive income, negative expense) under a category */
export function book(h: { st: WorldState; time: number }, owner: string, cat: string, delta: number, item?: string) {
  if (!growthOn(h.st) || Math.abs(delta) < EPS) return;
  const co = h.st.companies[owner]; if (!co || co.kind !== 'player') return;
  const ops = opsOf(co), hr = hourOf(h.time);
  let b = ops.ledger.at(-1); if (!b || b.h !== hr) { b = { h: hr, inc: {}, exp: {} }; ops.ledger.push(b); if (ops.ledger.length > 48) ops.ledger.splice(0, ops.ledger.length - 48); }
  if (delta > 0) { b.inc[cat] = (b.inc[cat] ?? 0) + delta; if (item) (b.sales ??= {})[item] = (b.sales[item] ?? 0) + delta; }
  else b.exp[cat] = (b.exp[cat] ?? 0) - delta;
  const m = seen.get(h.st) ?? new Map(); seen.set(h.st, m); m.set(owner, (m.get(owner) ?? 0) + delta);
}
export const bookedSoFar = (st: WorldState, owner: string) => seen.get(st)?.get(owner) ?? 0;
export const CMD_CATEGORY: Partial<Record<Cmd['c'], string>> = {
  buy: 'purchase', buyListing: 'purchase', queueModule: 'construction', planOp: 'construction', setOp: 'construction', buildShip: 'shipbuilding', buildOp: 'shipbuilding',
  research: 'research', researchOp: 'research', learnBlueprint: 'research', buyBlueprint: 'research', assembleBlueprint: 'research',
  repair: 'repair', refit: 'repair', fit: 'repair', fitShip: 'repair', buyShip: 'ships', buyShipListing: 'ships', hire: 'crew', lease: 'storage', payArrears: 'upkeep',
};
export const LEDGER_NAME: Record<string, string> = {
  sales: '판매', purchase: '구매', construction: '건설', shipbuilding: '조선', research: '연구', repair: '수리·개장', ships: '함선 매매', crew: '지휘관', storage: '보관 임대', upkeep: '운영 유지비', other: '전투·계약·기타',
};
/** everything not booked by a known path since the last reconciliation → "other" (contracts, bounties, refunds …) */
function reconcileLedger(h: WorldSim) {
  for (const co of Object.values(h.st.companies)) {
    if (co.kind !== 'player') continue;
    const ops = opsOf(co), booked = bookedSoFar(h.st, co.id);
    if (ops.credits !== undefined) { const residual = co.credits - ops.credits - booked; if (Math.abs(residual) > 0.5) book(h, co.id, 'other', residual); }
    ops.credits = co.credits; seen.get(h.st)?.set(co.id, 0);
  }
}

// ───────────────────────────────────────────────────────────────── main loop

let lastSync = new WeakMap<WorldState, number>();
/** called every strategic second by the world tick */
export function stepOperations(h: WorldSim) {
  if (!growthOn(h.st)) return;
  reconcileLedger(h);
  const last = lastSync.get(h.st) ?? -Infinity; if (h.time - last < 2 - EPS) return;
  lastSync.set(h.st, h.time);
  const works = Object.values(h.st.works ?? {});
  for (const w of works) projectWork(h, w);
  for (const w of works) if (GOAL_KINDS.includes(w.kind) && !terminal(w) && w.state !== 'paused' && h.time - (w.rt?.lastRun ?? -Infinity) >= 10 - EPS) runGoal(h, w);
  for (const w of works) procurementApprovals(h, w);
  for (const a of Object.values(h.st.approvals ?? {})) if (a.state === 'open' && terminal(h.st.works?.[a.work] ?? { state: 'done' } as Work)) { a.state = 'resolved'; a.note = '업무 종료'; a.updated = h.time; }
  prune(h);
}
export function resetOpsClock(st: WorldState) { lastSync.delete(st); }

function prune(h: WorldSim) {
  const works = h.st.works; if (!works) return;
  const byOwner = new Map<string, Work[]>();
  for (const w of Object.values(works)) if (terminal(w)) (byOwner.get(w.owner) ?? byOwner.set(w.owner, []).get(w.owner)!).push(w);
  for (const list of byOwner.values()) if (list.length > KEEP_FINISHED) {
    list.sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0));
    for (const w of list.slice(KEEP_FINISHED)) if (!Object.values(works).some(c => c.parent === w.id && !terminal(c))) delete works[w.id];
  }
  const aps = h.st.approvals; if (!aps) return;
  const closed = Object.values(aps).filter(a => a.state !== 'open').sort((a, b) => b.updated - a.updated);
  for (const a of closed.slice(KEEP_FINISHED)) delete aps[a.id];
}

// ─────────────────────────────────────────────────────────────── inventory

export interface InventoryRow {
  item: string; total: number; stored: number; reserved: number; available: number; inTransit: number; listed: number;
  planned: number; consumption: number; target: number; shortage: number; surplus: number;
  stations: { station: string; stored: number; reserved: number; available: number; protected: number }[];
  ships: { ship: string; amount: number; to?: string; job?: string }[];
  works: string[];
}
/**
 * Company-wide inventory. Each physical unit is counted exactly once: free store, a pool reservation
 * (removed from the store, still at the source), a construction reservation, a ship hold or an
 * exchange listing. Pure function of the replicated state — the client uses the same code.
 */
export function companyInventory(w: Pick<WorldState, 'stations' | 'ships' | 'logisticsJobs' | 'works'> & Partial<WorldState>, owner: string): InventoryRow[] {
  const rows = new Map<string, InventoryRow>();
  const row = (item: string) => { let r = rows.get(item); if (!r) { r = { item, total: 0, stored: 0, reserved: 0, available: 0, inTransit: 0, listed: 0, planned: 0, consumption: 0, target: 0, shortage: 0, surplus: 0, stations: [], ships: [], works: [] }; rows.set(item, r); } return r; };
  const at = (r: InventoryRow, station: string) => { let s = r.stations.find(x => x.station === station); if (!s) { s = { station, stored: 0, reserved: 0, available: 0, protected: 0 }; r.stations.push(s); } return s; };
  const co = w.companies?.[owner];
  const jobs = Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === owner && liveJob(j));
  for (const st of Object.values(w.stations)) {
    const store = st.storage?.[owner];
    if (store) for (const [item, n] of Object.entries(store)) if (n > EPS) { const r = row(item), s = at(r, st.id); s.stored += n; r.stored += n; s.protected = co?.procurement?.protectedStock[st.id]?.[item] ?? 0; }
    for (const l of st.listings ?? []) if (l.seller === owner && l.qty > EPS) row(l.item).listed += l.qty;
    if (st.owner !== owner) continue;
    for (const m of st.modules) if (!m.built) {
      for (const [item, n] of Object.entries(m.reserved ?? {})) if (n > EPS) { const r = row(item); r.reserved += n; at(r, st.id).reserved += n; }
      for (const item of planMats(m)) { const n = missing(m, item); if (n > EPS) row(item).consumption += n; }
    }
    const r0 = (id: string) => recipeFor(w as WorldState, id);
    for (const o of st.orders ?? []) {
      const rc = r0(o.recipe); if (!rc) continue;
      const out = Object.keys(rc.out)[0], per = rc.out[out];
      const batches = o.mode === 'count' ? Math.max(0, o.n - o.done) : Math.max(0, Math.ceil((o.n - qty(store, out)) / per));
      if (batches > 0) { row(out).planned += batches * per; for (const [i, n] of Object.entries(rc.in)) row(i).consumption += n * batches; }
    }
  }
  for (const j of jobs) if (j.reserved > EPS) { const r = row(j.item); r.reserved += j.reserved; at(r, j.from).reserved += j.reserved; }
  for (const s of Object.values(w.ships)) if (s.owner === owner) for (const [item, n] of Object.entries(s.cargo ?? {})) if (n > EPS) {
    const r = row(item), j = jobs.find(x => x.ship === s.id && x.item === item);
    r.inTransit += n; r.ships.push({ ship: s.id, amount: n, to: j?.to, job: j?.id });
  }
  for (const wk of Object.values(w.works ?? {})) if (wk.owner === owner && !terminal(wk)) {
    if (wk.goal?.k === 'stockpile') {
      const g = wk.goal, r = row(g.item); r.target += g.target; r.works.push(wk.id);
      const have = qty(w.stations[g.station]?.storage?.[owner], g.item);
      const inc = jobs.filter(j => j.to === g.station && j.item === r.item && j.kind !== 'sell').reduce((n, j) => n + outstanding(j), 0);
      r.shortage += Math.max(0, g.target - have - inc);
    } else if (wk.ref.item) row(wk.ref.item).works.push(wk.id);
  }
  for (const r of rows.values()) {
    for (const s of r.stations) {
      const claims = jobs.filter(j => j.from === s.station && j.item === r.item).reduce((n, j) => n + Math.max(0, outstanding(j) - j.reserved - j.carried), 0);
      s.available = Math.max(0, s.stored - s.protected - claims); r.available += s.available;
    }
    r.total = r.stored + r.reserved + r.inTransit + r.listed;
    r.surplus = r.target > 0 ? Math.max(0, r.total + r.planned - r.target - r.consumption) : 0;
    if (r.target <= 0) r.shortage = Math.max(0, r.consumption - r.total - r.planned);
  }
  return [...rows.values()].sort((a, b) => b.shortage - a.shortage || b.total - a.total || a.item.localeCompare(b.item));
}

/** cargo held on own ships, for screens that need the hold of one ship */
export const holdOf = (s: { cargo: Record<string, number> }) => cargoSum(s.cargo);
