// Company operations: one goal-and-work layer over the existing execution engines.
//
// Every accepted player command that starts company work is recorded here as a `Work`.
// Nothing in this file moves goods, builds or researches by itself: works are *projections*
// of the existing engines (construction plans, production orders, ship builds, research
// projects, pool logistics jobs, managed routes) and goals only *issue ordinary commands*
// through `WorldSim.command`, so every rule, price, capacity and ownership check of the
// original systems still applies. Approvals (결재) are raised only where automatic work would
// spend money without authority or take a risk the company has not accepted.
import { waitCode, type WaitCode } from './waitCode';
import { territoryRisk } from './territory';
import { validateFieldGoal, runFieldGoal, type FieldGoal } from './fieldOps';
import type { WorldSim, Cmd } from './sim';
import { poolMember } from './haulers';
import type { Company, Station, WorldState, Op, WGroup } from './types';
import { qty, cargoSum } from './types';
import { ITEMS, EQUIPMENT, RECIPES, TECHS, FACILITIES, recipeFor, facilityBuild } from './industry';
import { MODULES, RES_NAME } from './data';
import { missing, planMats, prereqBuilt } from './construction';
import { recipeOk, facLines } from './production';
import { econOf, growthOn, hullBuild, hullUpkeep } from './hullops';
import { chainOn, chainValue } from './econChain';
import { OVERHEAD } from './econConfig';
import { yardFee } from './valuation';
import { effSec } from './security';
import { usableRouteGate } from './logistics';
import { CONTENT, gearReleased } from '../content/registry';
import { dist } from './geom';
import { industryHold } from './procurement';
import { buyCost } from './market';

// ───────────────────────────────────────────────────────────────────────── types

export type WorkKind =
  | 'buy' | 'sell' | 'transport' | 'route' | 'station' | 'facility' | 'ship' | 'research' | 'production'
  | 'repair' | 'refit' | 'purchase_ship' | 'exchange' | 'contract' | 'operation'
  | 'stockpile' | 'trade' | 'fleet' | 'facilities' | 'condition' | 'survey_field' | 'develop_field';
/** continuous: an open-ended operation (mining, patrol, escort …) — it runs until the player stops or changes it */
export type WorkMode = 'once' | 'maintain' | 'repeat' | 'condition' | 'continuous';
export type WorkState = 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled';
export const GOAL_KINDS: WorkKind[] = ['stockpile', 'trade', 'fleet', 'facilities', 'condition', 'survey_field', 'develop_field'];

export type GoalSpec =
  /** keep (maintain) or reach (once) `target` units of `item`: at `station` (scope 'station', default), or
   *  across the whole company (scope 'company' — every own store and shipment counts; `station` receives purchases) */
  | { k: 'stockpile'; station: string; item: string; target: number; maintain: boolean; buy: boolean; produce: boolean; scope?: 'station' | 'company' }
  /** buy at `from`, carry and sell at `to`; one cycle moves `amount`; `cycles` 0 = until stopped */
  | { k: 'trade'; item: string; from: string; to: string; amount: number; maxBuy: number; minSell: number; minProfit: number; cycles: number }
  /** have `count` new hulls of this design built at `station` */
  | { k: 'fleet'; station: string; hull: string; variant?: string; preset?: string; count: number; group?: string }
  /** have `count` built facilities of `kind` at `station` */
  | { k: 'facilities'; station: string; kind: string; count: number }
  /** buy below / sell above `price` at `station`, `amount` per trigger */
  | { k: 'condition'; station: string; item: string; side: 'buy' | 'sell'; price: number; amount: number; repeat: boolean }
  /** P10 deposits: test-mine and report, or develop continuously (world/fieldOps.ts) */
  | FieldGoal;

export interface WorkRef {
  station?: string; module?: string; order?: string; build?: string; research?: string; job?: string; route?: string;
  group?: string; contract?: string; ship?: string; item?: string; at?: { x: number; y: number; z: number }; tech?: string;
  /** fleet operation kind (group op) */
  op?: string;
}
export interface Work {
  id: string; owner: string; kind: WorkKind; mode: WorkMode; title: string;
  state: WorkState; reason: string; created: number; updated: number; finished?: number;
  /** 0 (lowest) … 9 (highest); maps onto procurement / logistics priority where they exist */
  priority: number;
  parent?: string;
  /** created by a goal or the planner, not directly by the player */
  auto?: boolean;
  /** found already running in the engines (older save or engine-initiated) and taken under management */
  adopted?: boolean;
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
  /** P17.4b AUD-09: kind of block while waiting and since when (cleared when the work stops waiting) */
  wait?: { code: WaitCode; since: number };
  log: { t: number; text: string }[];
  /** goal runtime state (persisted so a restart resumes exactly) */
  rt?: {
    order?: string; launched?: number; cycles?: number; losses?: number; profit?: number;
    /** recurring trade cycle: 'buy' (nothing bought yet) → 'bought' (purchase settled, shipment not registered yet —
     *  P17.4.0 AUD-02: never bought again, only re-dispatched) → 'move' (shipment registered) → settled → 'buy' */
    phase?: 'buy' | 'bought' | 'move';
    /** P17.4.0: failed shipment registrations of the bought cycle and when the purchase was made */
    shipFails?: number; boughtAt?: number;
    /** P17.4.0 AUD-01: since when reachable remote stock has had no pool hauler to bring it */
    strandSince?: number;
    /** value-chain worlds: estimated hauling cost of the cycle in flight (counted in its profit) */
    cycleHaul?: number;
    cycleCost?: number; cycleJob?: string; sellQuote?: number; sellRatio?: number; bought?: number; riskOk?: number; noBuyUntil?: number; creditsOk?: number;
    rejected?: Record<string, { t: number; amount: number }>; lastRun?: number; triggered?: number;
    /** last observed progress per production order of this goal (`station:order` → done, time) — stall detection */
    prod?: Record<string, { done: number; t: number }>;
    /** a cancel/pause was issued by the player on the underlying object */
    cancelled?: boolean;
    /** market chosen by the player in an approval (overrides the cheapest-market choice) */
    market?: string;
    /** fleet operation held while paused (restored on resume) */
    heldOp?: Op;
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
  // P17.4b AUD-09: a structured code and start time for the current block (advisory; the reason text stays the source)
  if (state === 'waiting') { const code = waitCode(reason); if (w.wait?.code !== code) w.wait = { code, since: h.time }; }
  else if (w.wait) delete w.wait;
  if (terminal(w) && w.finished === undefined) {
    w.finished = h.time;
    for (const a of Object.values(h.st.approvals ?? {})) if (a.work === w.id && a.state === 'open') { a.state = 'resolved'; a.note = '업무 종료로 결재 불필요'; a.updated = h.time; }
  }
}
export const STATE_NAME: Record<WorkState, string> = { running: '진행', waiting: '대기', paused: '일시정지', done: '완료', failed: '실패', cancelled: '취소' };
export const KIND_NAME: Record<WorkKind, string> = {
  buy: '구매', sell: '판매', transport: '운송', route: '정기 운송', station: '정거장 건설', facility: '시설 건설', ship: '함선 건조', research: '연구', production: '생산',
  repair: '수리', refit: '개장', purchase_ship: '함선 구매', exchange: '거래소', contract: '계약', operation: '함대 작전',
  stockpile: '비축 목표', trade: '반복 무역', fleet: '함대 목표', facilities: '시설 목표', condition: '조건 거래', survey_field: '광구 시험 채굴', develop_field: '광구 개발',
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
      // the new order is the last one (its id cannot be derived from st.seq: a batch started at once also takes a sequence number)
      if (!st) return; const o = st.orders?.at(-1); if (!o || findWork(h, company, x => x.ref.station === st.id && x.ref.order === o.id)) return; const id = o.id;
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
      if (cmd.op.k !== 'found') { if (!opControl) opWork(h, company, cmd.group, h.st.groups[cmd.group]?.op ?? cmd.op); return; }
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
// ───────────────────────────────────────────────────────── fleet operations

export const OP_NAME: Record<string, string> = {
  mine: '채굴', haul: '수송', patrol: '순찰', escort: '호위', attack: '공격', build: '건설 지원', survey: '탐사', salvage: '인양', move: '이동', dock: '정박', found: '정거장 설립', recover: '잔해 인양', salvzone: '구역 인양', lootTender: '약탈 회수 지원', fieldrepair: '현장 수리', repairzone: '구역 현장 수리',
};
/** operations without a natural end: they run until the player stops or changes them */
const CONTINUOUS_OPS = new Set(['mine', 'haul', 'patrol', 'escort', 'build', 'salvzone', 'lootTender', 'repairzone', 'repairbiz']);
/** set while workOp itself issues the order, so pausing/resuming does not open or close a work */
let opControl = false;
function opTarget(h: WorldSim, op: Op): string {
  const stn = (id?: string) => (id && h.st.stations[id]?.name) || '';
  switch (op.k) {
    case 'mine': return `${h.st.fields[op.field]?.name ?? '광구'}${op.deliver ? ` → ${stn(op.deliver)}${op.sell ? ' 판매' : ''}` : ''}`;
    case 'haul': return `${stn(op.from)} → ${stn(op.to)} ${op.res.startsWith('*') ? (op.res === '*auto' ? '자동 보급' : '전체') : itemName(op.res)}`;
    case 'patrol': return `${h.sysOf(op.at)?.name ?? ''} 반경 ${Math.round(op.radius)}`;
    case 'escort': return h.st.groups[op.group]?.name ?? '';
    case 'attack': return op.group ? h.st.groups[op.group]?.name ?? '목표 함대' : '해적 거점';
    case 'build': case 'dock': return stn(op.station);
    case 'survey': return h.st.systems[op.system]?.name ?? '';
    case 'salvage': return '인양 지점';
    case 'recover': return h.st.wrecks?.[op.wreck]?.name ?? '전장 잔해';
    case 'salvzone': return op.biz ? `${h.sysOf(op.at)?.name ?? ''} 주변 인양 사업` : `${h.sysOf(op.at)?.name ?? ''} 반경 ${Math.round(op.radius)}`;
    case 'repairzone': return `${h.sysOf(op.at)?.name ?? ''} 반경 ${Math.round(op.radius)}`;
    case 'fieldrepair': return h.st.ships[op.ship]?.name ?? '함선';
    case 'repairbiz': return `${h.sysOf(op.at)?.name ?? ''} 수리업 (×${op.mul})`;
    case 'lootTender': return h.st.groups[op.group]?.name ?? '약탈 편대';
    case 'move': return h.sysOf(op.to)?.name ?? '';
    default: return '';
  }
}
/** A group order became the group's operation: end its previous operation work and open one for the new order. */
function opWork(h: WorldSim, owner: string, groupId: string, op: Op, adopted = false): Work | undefined {
  const g = h.st.groups[groupId]; if (!g || g.owner !== owner) return;
  for (const w of Object.values(h.st.works ?? {})) if (w.owner === owner && w.kind === 'operation' && w.ref.group === groupId && !terminal(w)) {
    w.result = op.k === 'idle' ? '대기 명령으로 종료' : `${OP_NAME[op.k] ?? op.k} 명령으로 전환`;
    setState(h, w, w.mode === 'continuous' ? 'done' : 'cancelled', '');
  }
  if (op.k === 'idle' || op.k === 'found' || !OP_NAME[op.k]) return;
  const w = addWork(h, owner, 'operation', `${g.name} · ${OP_NAME[op.k]}${opTarget(h, op) ? ` · ${opTarget(h, op)}` : ''}`, { group: groupId, op: op.k, ...('station' in op ? { station: op.station } : op.k === 'mine' && op.deliver ? { station: op.deliver } : {}) },
    { mode: CONTINUOUS_OPS.has(op.k) ? 'continuous' : 'once', progress: { done: 0, total: CONTINUOUS_OPS.has(op.k) ? 0 : 1 }, ...(adopted ? { adopted: true } : {}) });
  if (adopted) { delete w.parent; delete w.auto; }
  projectWork(h, w); return w;
}
function projectOperation(h: WorldSim, w: Work) {
  const g = h.st.groups[w.ref.group ?? ''];
  if (!g || g.owner !== w.owner) { w.result = '부대 해산·소실'; return setState(h, w, w.mode === 'continuous' ? 'done' : 'failed', '부대 소실'); }
  if (w.rt?.heldOp) return setState(h, w, 'paused', '일시정지 — 부대 대기 중, 재개하면 같은 명령으로 복귀');
  const ships = h.subtreeShips(g).filter(s => s.hp > 0).length;
  if (g.op.k !== w.ref.op) {
    if (w.mode === 'continuous') { w.result = `운영 종료 — ${g.status || '명령 변경'}`; return setState(h, w, 'done', ''); }
    w.progress.done = 1; w.result = g.status || '임무 종료'; return setState(h, w, 'done', '');
  }
  if (!ships) return setState(h, w, 'waiting', '배속된 함선 없음 — 함대 화면에서 함선을 배속하세요');
  if ((w.ref.op === 'move' && /도착/.test(g.status)) || (w.ref.op === 'dock' && / 정박$/.test(g.status))) { w.progress.done = 1; w.result = g.status; return setState(h, w, 'done', ''); }
  const blocked = /없음|불가|부족|소실|오류|대기|초과|상실|차단/.test(g.status);
  return setState(h, w, blocked ? 'waiting' : 'running', `${g.status || '수행 중'} · 함선 ${ships}척`);
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
        if (core?.id) w.ref.module ??= core.id;
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
    case 'operation': return projectOperation(h, w);
    case 'contract': {
      // AUD-14: the work follows the contract's real outcome; a contract record that disappeared before its
      // outcome was seen is NOT a success
      const c = h.st.contracts[w.ref.contract ?? ''];
      if (!c) { w.result = '계약 기록이 정리되어 결과를 확인할 수 없음'; return setState(h, w, 'cancelled', w.result); }
      if (c.takenBy !== w.owner) { w.result = '수주 상태가 아님'; return setState(h, w, 'cancelled', w.result); }
      if (!c.done) return setState(h, w, 'running', c.amount ? `계약 수행 중 · 납품 ${fmt(c.progress)}/${fmt(c.amount)}` : '계약 수행 중');
      const out = c.outcome ?? (c.ended ? 'void' : h.time > c.expires ? 'expired' : 'complete');
      if (out === 'complete') { if (w.state !== 'done') { w.income = c.mil ? (w.income ?? 0) : c.reward; w.result = `완수 · 보수 ${fmt(c.reward)} cr`; } return setState(h, w, 'done', ''); }
      w.result = out === 'expired' ? `기한 만료 · 납품 ${fmt(c.progress)}/${fmt(c.amount ?? 0)}` : out === 'cancelled' ? `포기${c.ended ? ` — ${c.ended}` : ''}` : out === 'failed' ? `실패${c.ended ? ` — ${c.ended}` : ''}` : `무효 종료${c.ended ? ` — ${c.ended}` : ''} (불이익 없음)`;
      return setState(h, w, out === 'expired' || out === 'failed' ? 'failed' : 'cancelled', w.result);
    }
  }
}
function procurementWhy(h: WorldSim, owner: string, station: string, kind: string, source: string): string {
  const p = Object.values(h.st.procurementPlans ?? {}).find(x => x.owner === owner && x.station === station && x.sourceKind === kind && x.sourceId === source && x.state !== 'closed' && x.shortage > EPS);
  return p ? ` · 조달: ${p.reason}` : '';
}

// ─────────────────────────────────────────────────────────── spending authority

export interface AuthResult { ok: boolean; kind?: ApprovalKind; why?: string }
export function spentLastHour(h: Pick<WorldSim, 'time'>, ops: CompanyOps) {
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
export function procurementAuthority(h: WorldSim, owner: string, station: string, kind: 'construction' | 'production' | 'ship' | 'research', source: string, item: string) {
  if (!h.st.works) return undefined;
  const w = findWork(h, owner, x => !terminal(x) && x.ref.station === station && (kind === 'construction' ? x.ref.module === source : kind === 'production' ? x.ref.order === source : kind === 'research' ? x.ref.research === source : x.ref.build === source));
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

function purchaseApproval(h: WorldSim, w: Work, auth: AuthResult, items: Approval['items'], extra: { risk?: Approval['risk']; alt?: Approval['alt']; context: string; key?: string }) {
  const co = h.st.companies[w.owner], pol = opsOf(co).policy;
  const cost = items.reduce((n, x) => n + x.amount * x.price, 0), unit = items.length === 1 ? items[0].price : undefined;
  const holder = budgetHolder(h, w), key = extra.key ?? `${auth.kind}`;
  const label = items.map(x => `${itemName(x.item)} ${fmt(x.amount)}`).join(', ');
  const station = items[0] ? h.st.stations[items[0].station]?.name ?? '' : '';
  const options: ApprovalOption[] = [];
  if (auth.kind === 'credits') {
    options.push({ id: 'approve', label: '이번만 최소 잔액 아래로 집행', detail: `잔액이 ${fmt(co.credits - cost)} cr로 내려갑니다 (최소 ${fmt(pol.minCredits)} cr)`, cost, scopes: ['once'] });
    options.push({ id: 'wait', label: '수입이 생길 때까지 대기', detail: '잔액이 회복되면 자동으로 다시 시도합니다', recommended: true, scopes: ['once'] });
  } else {
    const cap = items.reduce((n, x) => n + x.amount * Math.ceil(x.price * 1.15), 0);
    options.push({ id: 'approve', label: holder.budget ? '예산 증액 후 구매' : '구매 승인', detail: `${station}에서 ${label} — 추정 ${fmt(cost)} cr, 최대 ${fmt(cap)} cr (단가 상한 +15%)`, cost, recommended: !extra.risk, scopes: ['once', 'work', 'policy'], input: 'budget' });
    options.push(...alternatives(h, w, items));
    options.push({ id: 'wait', label: '구매 없이 자사 재고·생산으로만 진행', detail: `내부 이송과 생산으로 가능한 만큼 진행하고 6시간 동안 같은 구매를 묻지 않습니다 — 영향: ${label} 부족이 이어지고 이 목표는 대기${children(h, w).filter(c => !terminal(c)).length ? `, 진행 중인 하위 업무 ${children(h, w).filter(c => !terminal(c)).length}건은 계속` : ''}`, scopes: ['once'] });
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

/** rough travel time of a pool haul over `hops` gate jumps (display only — always labelled as an estimate) */
const etaText = (hops: number) => hops <= 0 ? '현장 즉시' : `도착 약 ${Math.round(4 + hops * 3)}분 (추정)`;
/**
 * Real alternatives to a proposed purchase, each with its expected effect: other markets (price, route,
 * risk, time), making the item instead (own lines that the goal does not use yet, or a facility to build).
 */
function alternatives(h: WorldSim, w: Work, items: Approval['items']): ApprovalOption[] {
  if (items.length !== 1 || !safeItem(items[0].item)) return [];
  const x = items[0], co = h.st.companies[w.owner], out: ApprovalOption[] = [];
  const target = h.st.stations[(w.goal && 'station' in w.goal ? w.goal.station : undefined) ?? w.ref.station ?? x.station] ?? h.st.stations[x.station];
  const chosen = x.amount * x.price;
  const markets = Object.values(h.st.stations).filter(s => s.id !== x.station && s.public && s.market?.[x.item] && s.market[x.item].stock >= 1 && h.canDock(s, w.owner) && h.price(s, x.item, 'buy') > 0)
    .map(s => ({ s, price: h.price(s, x.item, 'buy'), r: s.id === target?.id ? { hops: 0, risk: 0 } : target ? routeRisk(h, s, target, 100) : null })).filter(m => m.r)
    .sort((a, b) => a.price * (1 + a.r!.hops * 0.01) - b.price * (1 + b.r!.hops * 0.01) || a.s.id.localeCompare(b.s.id)).slice(0, 2);
  for (const m of markets) {
    const n = Math.min(x.amount, Math.floor(m.s.market![x.item].stock)), cost = n * m.price, diff = cost - chosen;
    out.push({ id: `market:${m.s.id}`, label: `${m.s.name}에서 구매`, detail: `단가 ${fmt(m.price)} cr · ${fmt(n)}개 ${fmt(cost)} cr (추정, 제안안보다 ${diff >= 0 ? `${fmt(diff)} cr 비쌈` : `${fmt(-diff)} cr 저렴`}) · ${m.r!.hops}점프 · 경로 위험 ${Math.round(m.r!.risk)} · ${etaText(m.r!.hops)}${n < x.amount ? ` · 시장 재고 부족으로 ${fmt(x.amount - n)} 미충족` : ''}`, cost, eta: etaText(m.r!.hops), risk: `경로 위험 ${Math.round(m.r!.risk)} (추정)`, scopes: ['once', 'work'] });
  }
  if (w.goal?.k === 'stockpile') {
    const recipes = producible(h, w.owner, x.item), own = Object.values(h.st.stations).filter(s => s.owner === w.owner);
    const unit = (r: (typeof recipes)[number]) => Object.entries(r.in).reduce((n, [i, k]) => n + k * (cheapestPrice(h, w.owner, i) ?? Infinity), 0) / r.out[x.item];
    const withLines = recipes.filter(r => own.some(s => facLines(s, r.fac) > 0));
    if (withLines.length && (!w.goal.produce || !opsOf(co).policy.preferProduce)) {
      const r = withLines[0], u = unit(r);
      out.push({ id: 'produce', label: '자체 생산으로 전환', detail: `${r.name} — 원료 시장가 기준 약 ${Number.isFinite(u) ? fmt(u) : '?'} cr/개 vs 구매 ${fmt(x.price)} cr/개 (추정, 설비 유지비 제외) · 생산 라인 대기열에 따라 지연`, scopes: ['once'] });
    } else if (!withLines.length && recipes.length && target?.owner === w.owner) {
      const r = [...recipes].sort((a, b) => unit(a) - unit(b))[0], fac = FACILITIES[r.fac], mod = MODULES[r.fac];
      if (fac && mod) {
        const est = facilityBuild(mod, true).credits, u = unit(r);
        out.push({ id: `facility:${r.fac}`, label: `${fac.name} 건설 후 자체 생산`, detail: `${target.name}에 ${fac.name} 착공 — 건설비 약 ${fmt(est)} cr + 자재(조달) · 완공까지 이 목표 구매 보류 · 완공 후 원료비 약 ${Number.isFinite(u) ? fmt(u) : '?'} cr/개 vs 구매 ${fmt(x.price)} cr/개 (추정, 유지비 별도)`, cost: est, scopes: ['once'] });
      }
    }
  }
  return out;
}
function cheapestPrice(h: WorldSim, owner: string, item: string) {
  let best: number | undefined;
  for (const s of Object.values(h.st.stations)) if (s.public && s.market?.[item] && h.canDock(s, owner)) { const p = h.price(s, item, 'buy'); if (p > 0 && (best === undefined || p < best)) best = p; }
  return best;
}
/** after a rejection: look at the real alternatives once; anything that needs no new money is applied, the rest is offered once */
function reviewAfterReject(h: WorldSim, w: Work, a: Approval) {
  if (a.key === 'alt') { note(w, h.time, '대안도 거절 — 6시간 동안 구매를 제안하지 않고 내부 재고·생산만 사용'); return; }
  const alts = a.options.filter(o => /^(market:|facility:|produce$)/.test(o.id));
  const free = Object.values(h.st.stations).filter(s => s.storage[w.owner] && a.items[0] && s.id !== (w.goal && 'station' in w.goal ? w.goal.station : '')).reduce((n, s) => n + (a.items[0] && safeItem(a.items[0].item) ? freeStock(h, w.owner, s, a.items[0].item, w.id) : 0), 0);
  const summary = [`자사 다른 정거장 여유 재고 ${fmt(free)}`, ...alts.map(o => `${o.label}: ${o.detail}`)];
  if (!alts.length) summary.push('다른 시장·생산 대안 없음');
  note(w, h.time, `거절 후 대안 검토 — ${summary.join(' / ')}`);
  if (!alts.length) return;
  raise(h, w, a.kind === 'risk' ? 'risk' : 'purchase', 'alt', {
    title: `${w.title} — 거절 후 대안`, reason: '제안한 구매가 거절되어 다른 방법을 검토했습니다', situation: summary.join(' · '), items: a.items,
    estimate: { cost: Math.min(...alts.map(o => o.cost ?? Infinity).filter(Number.isFinite), a.estimate.cost), note: '각 대안의 금액·시간은 현재 시세와 경로 기준 추정' },
    options: [...alts, { id: 'wait', label: '대안도 보류', detail: '6시간 동안 구매를 제안하지 않고 내부 재고·생산만 사용합니다', recommended: true, scopes: ['once'] }, { id: 'reject', label: '거절', detail: '6시간 동안 다시 묻지 않습니다', scopes: ['once'] }],
    rejectEffect: '이 목표는 내부 재고·생산으로 가능한 만큼만 진행하고 부족분은 대기 사유로 남습니다', scopeNote: '이번만: 이 금액까지 · 이 목표: 같은 시장·단가 이내라면 이 목표 끝까지',
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
    default: {
      if (option.startsWith('market:')) {
        const sid = option.slice(7), price = h.st.stations[sid] && a.items[0] ? h.price(h.st.stations[sid], a.items[0].item, 'buy') : 0;
        (w.rt ??= {}).market = sid; delete w.rt.noBuyUntil;
        const target = holder.budget ? holder : budgetHolder(h, w), b = target.budget ??= { limit: 0, spent: 0 }, cap = Math.ceil(price * 1.15);
        if (scope === 'work') { b.open = true; b.maxPrice = Math.max(b.maxPrice ?? 0, cap); } else { b.limit = Math.max(b.limit, b.spent) + (value ?? (opt.cost ?? 0) * 1.15); b.maxPrice = Math.max(b.maxPrice ?? 0, cap); }
        break;
      }
      if (option.startsWith('facility:')) {
        const kind = option.slice(9), st = h.st.stations[(w.goal && 'station' in w.goal ? w.goal.station : w.ref.station) ?? ''];
        if (!st || st.owner !== owner) return '자사 정거장이 아닙니다';
        const count = st.modules.filter(m => m.kind === kind).length + 1;
        const err = createGoal(h, owner, { k: 'facilities', station: st.id, kind, count }, { budget: value ?? opt.cost ?? 0, priority: w.priority });
        if (err) return err;
        (w.rt ??= {}).noBuyUntil = h.time + 24 * 3600; note(w, h.time, `${FACILITIES[kind]?.name ?? kind} 건설 목표 등록 — 완공 후 자체 생산`);
        break;
      }
      if (option === 'produce' && w.goal?.k === 'stockpile') { w.goal.produce = true; if (!pol.preferProduce) pol.preferProduce = true; delete (w.rt ??= {}).noBuyUntil; (w.rt.rejected ??= {})[a.key] = { t: h.time, amount: a.estimate.cost }; break; }
      return '선택지를 확인하세요';
    }
    case 'safe': (w.rt ??= {}).riskOk = -1; if (scope === 'work') { const b = (holder.budget ??= { limit: 0, spent: 0 }); b.limit = Math.max(b.limit, b.spent) + (a.alt?.cost ?? amount); } else { const b = (holder.budget ??= { limit: 0, spent: 0 }); b.limit = Math.max(b.limit, b.spent) + (a.alt?.cost ?? amount); } break;
    case 'wait': (w.rt ??= {}).noBuyUntil = h.time + REJECT_HOLD; ((w.rt.rejected ??= {})[a.key] = { t: h.time, amount: a.estimate.cost }); break;
    case 'pause': workOp(h, owner, w.id, 'pause'); break;
    case 'cancel': workOp(h, owner, w.id, 'cancel'); break;
    case 'reject': ((w.rt ??= {}).rejected ??= {})[a.key] = { t: h.time, amount: a.estimate.cost }; w.rt.noBuyUntil = h.time + REJECT_HOLD; break;
  }
  a.state = option === 'reject' ? 'rejected' : 'approved'; a.choice = option; a.scope = scope; a.decided = h.time; a.updated = h.time;
  if (option === 'reject' && (a.kind === 'purchase' || a.kind === 'budget' || a.kind === 'risk')) reviewAfterReject(h, w, a);
  note(w, h.time, `결재 ${option === 'reject' ? '거절' : '처리'}: ${opt.label}${scope !== 'once' ? ` (${scope === 'work' ? '이 목표 전체' : '정책 위임'})` : ''}`);
  // related open approvals of the same work become moot when a budget/authority was granted
  if (option === 'approve' || option === 'safe' || option.startsWith('market:') || option === 'produce') for (const x of Object.values(h.st.approvals ?? {})) if (x !== a && x.work === a.work && x.state === 'open' && x.kind !== 'loss') { x.state = 'resolved'; x.note = '같은 업무의 다른 결재로 해결'; x.updated = h.time; }
  return null;
}

// ─────────────────────────────────────────────────────────────── route helpers

/** fewest-jump path (by usable gates); returns hops and the highest sector risk crossed, or null */
export function routeRisk(h: WorldSim, a: Station, b: Station, maxRisk = 100): { hops: number; risk: number } | null {
  const s = h.sysOf(a.pos), e = h.sysOf(b.pos); if (!s || !e) return null;
  // P10: territory adds region risk (lawless, uncharted, contested borders)
  const r = (id: string) => Math.min(100, 100 - effSec(h.st.systems[id]) + territoryRisk(h.st, h.st.systems[id]));
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
  return Object.values(h.st.ships).filter(s => s.owner === owner && poolMember(h.st, s) && s.hp > 0 && econOf(s).cargo > 0 && !econOf(s).military);
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
  return Math.max(0, qty(station.storage[owner], item) - reserveLevel(h, owner, station, item, exceptGoal) - outboundClaims(h, owner, station.id, item));
}

/**
 * AUTO-P0: the common stock-protection rule. Units of `item` at `station` that must stay: the player's minimum
 * stock there (procurement `protectedStock`), station-scope stockpile goals, and what the station's own
 * construction / ship builds / production still need. Every automatic sale (mining direct sale, condition goals,
 * pool sale shipments and the excess-stock planner) leaves at least this much in the store.
 */
export function stockFloor(h: Pick<WorldSim, 'st'>, owner: string, station: Station, item: string): number {
  if (!h.st.companies[owner]) return 0;
  return reserveLevel(h, owner, station, item) + industryHold(h, owner, station, item);
}
/**
 * AUTO-P0.1: the reserve level of one item in one store. The minimum stock (`protectedStock`) and every
 * station-scope stockpile goal for the same item and store all ask for the same thing — "keep N units here" — and a
 * stockpile goal measures its progress against the store's stock, so one set of units satisfies all of them. The
 * level is therefore the largest of them, not their sum. Consumption reservations (construction, builds,
 * production) are separate demands and are added on top by `stockFloor`.
 */
export function reserveLevel(h: Pick<WorldSim, 'st'>, owner: string, station: Station, item: string, exceptGoal?: string): number {
  let level = h.st.companies[owner]?.procurement?.protectedStock[station.id]?.[item] ?? 0;
  for (const w of Object.values(h.st.works ?? {})) if (w.owner === owner && w.id !== exceptGoal && !terminal(w) && w.goal?.k === 'stockpile' && (w.goal.scope ?? 'station') === 'station' && w.goal.station === station.id && w.goal.item === item) level = Math.max(level, w.goal.target);
  return level;
}
/** AUTO-P0: the most units (≤ n) whose walked purchase cost fits in `spend` */
export function affordableLot(m: Parameters<typeof buyCost>[0], n: number, spend: number): number {
  let lo = 0, hi = Math.max(0, Math.floor(n + EPS));
  if (spend <= 0) return 0;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (buyCost(m, mid, true) <= spend + EPS) lo = mid; else hi = mid - 1; }
  return lo;
}
/** AUTO-P0: units at `station` that can be sold now: stored − floor − units already promised to outbound shipments */
export function sellableStock(h: Pick<WorldSim, 'st'>, owner: string, station: Station, item: string): number {
  const promised = Object.values(h.st.logisticsJobs ?? {}).filter(j => j.owner === owner && j.from === station.id && j.item === item && liveJob(j) && !j.stow).reduce((n, j) => n + Math.max(0, outstanding(j) - j.reserved - j.carried), 0);
  return Math.max(0, qty(station.storage[owner], item) - stockFloor(h, owner, station, item) - promised);
}
/**
 * AUTO-P0: company-scope stockpile targets cap what may leave the company: holding − target − pending sales.
 * AUTO-P0.1: several company-scope goals for one item share one stock (each measures the same company holding), so
 * the target is the largest of them. `extra` counts units in hand that are in no store yet (cargo being unloaded).
 * AUTO-P1: holding is secured stock only (every store); shipments in flight and cargo aboard ships are not counted,
 * so a sale never relies on goods still at sea.
 */
export function companySaleCap(h: Pick<WorldSim, 'st'>, owner: string, item: string, extra = 0): number {
  let target = 0;
  for (const w of Object.values(h.st.works ?? {})) if (w.owner === owner && !terminal(w) && w.goal?.k === 'stockpile' && w.goal.scope === 'company' && w.goal.item === item) target = Math.max(target, w.goal.target);
  if (!target) return Infinity;
  const pending = Object.values(h.st.logisticsJobs ?? {}).filter(j => j.owner === owner && j.item === item && j.kind === 'sell' && liveJob(j)).reduce((n, j) => n + Math.max(0, outstanding(j) - j.reserved - j.carried), 0);
  return Math.max(0, companyHolding(h, owner, item) + extra - target - pending);
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
      const scope = sp.scope === 'company' ? 'company' : 'station';
      if (sp.scope !== undefined && sp.scope !== 'company' && sp.scope !== 'station') return '비축 범위를 확인하세요';
      if (live.some(w => w.goal?.k === 'stockpile' && (w.goal.scope ?? 'station') === scope && w.goal.item === sp.item && (scope === 'company' || w.goal.station === sp.station)))
        return scope === 'company' ? '같은 품목의 회사 전체 비축 목표가 이미 있습니다 — 기존 목표의 수량을 바꾸세요' : '같은 정거장·품목의 비축 목표가 이미 있습니다 — 기존 목표의 수량을 바꾸세요';
      spec = { k: 'stockpile', station: st.id, item: spec.item, target: Math.floor(spec.target), maintain: !!spec.maintain, buy: spec.buy !== false, produce: spec.produce !== false, ...(scope === 'company' ? { scope } : {}) };
      title ??= scope === 'company' ? `회사 전체 · ${itemName(spec.item)} ${fmt(spec.target)} ${spec.maintain ? '비축 유지' : '확보'}` : `${st.name} · ${itemName(spec.item)} ${fmt(spec.target)} ${spec.maintain ? '비축 유지' : '확보'}`; mode = spec.maintain ? 'maintain' : 'once'; total = spec.target; unit = itemName(spec.item);
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
    case 'survey_field': case 'develop_field': {
      const err = validateFieldGoal(h, owner, spec); if (err) return err;
      const sp = spec;
      if (live.some(w => (w.goal?.k === 'survey_field' || w.goal?.k === 'develop_field') && (w.goal.group === sp.group))) return '이 편대는 이미 다른 광구 목표에 배정되어 있습니다';
      const f = h.st.fields[sp.field];
      if (sp.k === 'survey_field') {
        spec = { k: 'survey_field', field: f.id, group: sp.group, samples: Math.floor(sp.samples), ...(sp.deliver ? { deliver: sp.deliver } : {}) };
        title ??= `${f.name} · 시험 채굴 ${fmt(spec.samples)}개`; total = spec.samples; unit = '표본';
      } else {
        spec = { k: 'develop_field', field: f.id, group: sp.group, sell: !!sp.sell, miners: Math.floor(sp.miners), ...(sp.deliver ? { deliver: sp.deliver } : {}), ...(sp.yard ? { yard: sp.yard, hull: typeof sp.hull === 'string' && Object.hasOwn(CONTENT.hulls, sp.hull) ? sp.hull : Object.values(CONTENT.hulls).find(x => x.classId === 'miner')?.id } : {}) };
        title ??= `${f.name} · 광구 개발`; mode = 'continuous'; total = 0; unit = '개';
      }
      break;
    }
    default: return '알 수 없는 목표 종류';
  }
  const fieldGoal = spec.k === 'survey_field' || spec.k === 'develop_field';
  const w = addWork(h, owner, spec.k, title!, fieldGoal ? { group: (spec as FieldGoal).group, station: (spec as FieldGoal).deliver } : { station: spec.k === 'trade' ? spec.from : (spec as any).station, item: spec.k === 'fleet' || spec.k === 'facilities' ? undefined : (spec as any).item }, { mode, goal: spec, priority: opts.priority ?? 5, progress: { done: 0, total, unit } });
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
    case 'survey_field': case 'develop_field': return runFieldGoal(fieldHost(h, w), w.goal);
  }
}
/** adapter giving fieldOps the goal machinery (state, approvals, child commands) without duplicating it */
function fieldHost(h: WorldSim, w: Work) {
  const co = h.st.companies[w.owner], rt = (w.rt ??= {}) as Record<string, any>;
  return {
    h, owner: w.owner, rt, maxRisk: opsOf(co).policy.maxRisk,
    setState: (state: WorkState, reason: string) => setState(h, w, state, reason),
    log: (text: string) => note(w, h.time, text),
    progress: (done: number, total: number, unit: string) => { w.progress = { done, total, unit }; },
    result: (text: string) => { w.result = text; },
    cmd: (c: any) => cmd(h, w, c),
    askRisk: (level: number, hops: number, situation: string) => {
      if (Object.values(h.st.approvals ?? {}).some(a => a.work === w.id && a.state === 'rejected' && h.time - (a.decided ?? 0) < 6 * 3600)) return true;
      raise(h, w, 'risk', 'risk', { title: `${w.title} — 위험 지역`, reason: `광구 지역 위험도 ${Math.round(level)}가 허용치(${opsOf(co).policy.maxRisk})를 넘습니다`, situation, items: [], estimate: { cost: 0, note: '함선 손실 위험 — 비용은 발생하지 않음' }, risk: { level, hops, note: '치안·지역(무법/미개척/국경 분쟁) 기반 추정' },
        options: [{ id: 'approve', label: '위험 지역 진입 허용', detail: '이 목표에 한해 허용합니다', scopes: ['work'] }, { id: 'pause', label: '일시정지', detail: '', recommended: true, scopes: ['once'] }, { id: 'reject', label: '거절', detail: '6시간 동안 다시 묻지 않음', scopes: ['once'] }],
        rejectEffect: '편대를 보내지 않습니다', scopeNote: '이 목표 전체' });
      return true;
    },
    hasChildFleet: () => liveChildren(h, w).some(c => c.kind === 'fleet'),
    childFleet: (spec: { station: string; hull: string; count: number; group: string }) => {
      const before = new Set(Object.keys(h.st.works ?? {}));
      const err = createGoal(h, w.owner, { k: 'fleet', station: spec.station, hull: spec.hull, count: Math.min(50, spec.count), group: spec.group }, { priority: w.priority });
      if (err) return err;
      for (const id of Object.keys(h.st.works ?? {})) if (!before.has(id) && h.st.works![id].kind === 'fleet') { h.st.works![id].parent = w.id; h.st.works![id].auto = true; }
      return null;
    },
  };
}
const liveChildren = (h: WorldSim, w: Work, kind?: WorkKind) => children(h, w).filter(c => !terminal(c) && (!kind || c.kind === kind));
function cmd(h: WorldSim, w: Work, c: Cmd): string | null { return withParent(w.id, () => h.command(w.owner, c)); }

/**
 * AUTO-P1: one company's stock of an item, split by what each part may be used for.
 * - `stored`: secured stock — units actually in a store (any station where the company keeps goods). Only this
 *   satisfies a stockpile target and only this can bound an automatic sale.
 * - `incoming`: units of normal (non-sale) shipments with a destination, reserved at their source or on board.
 *   Counted against duplicate procurement, never as stock already secured.
 * - `selling`: units of sale shipments (reserved or on board) — on their way out of the company.
 * - `afloat`: cargo aboard own ships that no shipment tracks (a miner's or hauler's hold, untracked cargo):
 *   a company asset, but no ground for lowering a sale floor.
 * `total` is every physical unit once: stores + all shipment reservations + every ship hold.
 */
export interface CompanyStock { stored: number; incoming: number; selling: number; afloat: number; total: number }
export function companyStock(w: Pick<WorldState, 'stations' | 'ships' | 'logisticsJobs'>, owner: string, item: string): CompanyStock {
  const out: CompanyStock = { stored: 0, incoming: 0, selling: 0, afloat: 0, total: 0 };
  for (const st of Object.values(w.stations)) out.stored += qty(st.storage?.[owner], item);
  const tracked = new Map<string, number>();
  for (const j of Object.values(w.logisticsJobs ?? {})) {
    if (j.owner !== owner || j.item !== item || !liveJob(j)) continue;
    if (j.kind === 'sell') out.selling += j.reserved + j.carried; else out.incoming += j.reserved + j.carried;
    const ship = j.ship ?? j.held?.ship; if (ship && j.carried > 0) tracked.set(ship, (tracked.get(ship) ?? 0) + j.carried);
  }
  let aboard = 0;
  for (const s of Object.values(w.ships)) if (s.owner === owner) { const n = qty(s.cargo, item); aboard += n; out.afloat += Math.max(0, n - (tracked.get(s.id) ?? 0)); }
  const reserved = Object.values(w.logisticsJobs ?? {}).reduce((n, j) => n + (j.owner === owner && j.item === item && liveJob(j) ? j.reserved : 0), 0);
  out.total = out.stored + reserved + aboard;
  return out;
}
/** AUTO-P1: secured company stock of `item` — what is actually in its stores (see `companyStock`) */
export function companyHolding(h: Pick<WorldSim, 'st'>, owner: string, item: string) {
  let n = 0;
  for (const st of Object.values(h.st.stations)) n += qty(st.storage[owner], item);
  return n;
}
/** free company stock of `item` over every store (protections, outbound promises and other goals' targets removed) */
function freeCompany(h: WorldSim, owner: string, item: string, exceptGoal?: string) {
  let n = 0; for (const st of Object.values(h.st.stations)) if (st.storage[owner]) n += freeStock(h, owner, st, item, exceptGoal);
  return n;
}
const STALL = 900;
interface GoalOrder { w: Work; st: Station; o: NonNullable<Station['orders']>[number]; r: NonNullable<ReturnType<typeof recipeFor>>; out: string; per: number; inflight: number; stalled: boolean }
/** live production orders this goal planned (final product and intermediates), with stall detection */
function goalOrders(h: WorldSim, w: Work): GoalOrder[] {
  const rt = (w.rt ??= {}), seenP = (rt.prod ??= {}), out: GoalOrder[] = [], keep = new Set<string>();
  for (const c of liveChildren(h, w, 'production')) {
    const st = h.st.stations[c.ref.station ?? '']; const o = st?.orders?.find(x => x.id === c.ref.order); if (!st || !o) continue;
    const r = recipeFor(h.st, o.recipe); if (!r) continue;
    const item = Object.keys(r.out)[0], inflight = (st.jobs ?? []).filter(j => j.order === o.id).length, key = `${st.id}:${o.id}`;
    const prev = seenP[key];
    if (!prev || prev.done !== o.done || inflight > 0 || o.paused) seenP[key] = { done: o.done, t: h.time };
    keep.add(key);
    out.push({ w: c, st, o, r, out: item, per: r.out[item], inflight, stalled: !o.paused && inflight === 0 && h.time - seenP[key].t >= STALL });
  }
  for (const k of Object.keys(seenP)) if (!keep.has(k)) delete seenP[k];
  return out;
}
const remainingOut = (g: GoalOrder) => g.o.mode === 'count' ? Math.max(0, g.o.n - g.o.done) * g.per : 0;
const batchesToFeed = (g: GoalOrder) => g.o.mode === 'count' ? Math.max(0, g.o.n - g.o.done - g.inflight) : 0;
function producible(h: WorldSim, owner: string, item: string) {
  const co = h.st.companies[owner];
  return Object.values(RECIPES).map(r => recipeFor(h.st, r.id)!).filter(r => r && (r.out[item] ?? 0) > 0 && recipeOk(r, co) && (!r.growth || growthOn(h.st)) && Object.keys(r.out).every(k => gearReleased(k)));
}
/**
 * Plan `need` more units of `item` from the company's own production lines, at any own station that has them.
 * Extends this goal's existing order of the same recipe at a station before opening a new one, so repeated
 * passes never stack orders. Returns the units newly planned.
 */
function planProduce(h: WorldSim, w: Work, item: string, need: number, target: Station, orders: GoalOrder[], notes: string[]): number {
  if (need < 1) return 0;
  const recipes = producible(h, w.owner, item);
  if (!recipes.length) { notes.push(`${itemName(item)}: 생산 레시피 없음 또는 연구 필요`); return 0; }
  const own = Object.values(h.st.stations).filter(s => s.owner === w.owner);
  const stalledAt = new Set(orders.filter(g => g.stalled).map(g => `${g.st.id}:${g.r.id}`));
  type Opt = { r: (typeof recipes)[number]; st: Station; lines: number; load: number; hops: number; inputs: number };
  const opts: Opt[] = [];
  for (const r of recipes) for (const st of own) {
    const lines = facLines(st, r.fac); if (lines < 1 || stalledAt.has(`${st.id}:${r.id}`)) continue;
    const queued = (st.orders ?? []).filter(o => recipeFor(h.st, o.recipe)?.fac === r.fac && !o.paused).reduce((n, o) => n + (o.mode === 'count' ? Math.max(0, o.n - o.done) : 1), 0);
    // inputs: 0 all in company stock, 1 producible by the company, 2 must be bought
    const inputs = Math.max(0, ...Object.entries(r.in).map(([x, n]) => freeCompany(h, w.owner, x, w.id) >= n ? 0 : producible(h, w.owner, x).some(rr => own.some(s => facLines(s, rr.fac) > 0)) ? 1 : 2));
    opts.push({ r, st, lines, load: queued / lines, hops: st.id === target.id ? 0 : routeRisk(h, st, target, 100)?.hops ?? 99, inputs });
  }
  if (!opts.length) {
    const facs = [...new Set(recipes.map(r => FACILITIES[r.fac]?.name ?? r.fac))];
    notes.push(`${itemName(item)}: 자사 정거장에 생산 시설 없음 (${facs.join(' 또는 ')} 필요)`); return 0;
  }
  // one recipe per pass: the one whose inputs the company can supply itself, then the most output per batch
  opts.sort((a, b) => a.inputs - b.inputs || b.r.out[item] / b.r.time - a.r.out[item] / a.r.time || a.load - b.load || a.hops - b.hops || a.st.id.localeCompare(b.st.id));
  const r = opts[0].r, per = r.out[item], places = opts.filter(o => o.r.id === r.id).slice(0, 3);
  let batches = Math.ceil(need / per - EPS);
  // spread over the stations that have these lines, weighted by free capacity (a small job stays in one place)
  const weight = places.map(o => o.lines / (1 + o.load)), total = weight.reduce((a, b) => a + b, 0);
  const share = batches <= places[0].lines * 2 ? [batches] : places.map((_, i) => Math.floor(batches * weight[i] / total));
  if (share.length > 1) share[0] += batches - share.reduce((a, b) => a + b, 0);
  let planned = 0;
  share.forEach((b, i) => {
    if (b < 1) return; const st = places[i].st;
    const mine = orders.find(g => g.st.id === st.id && g.r.id === r.id && g.o.mode === 'count' && !g.o.paused);
    if (mine) {
      const err = cmd(h, w, { c: 'prodOp', station: st.id, order: mine.o.id, op: 'set', n: mine.o.n + b });
      if (!err) { mine.w.progress.total = mine.o.n; planned += b * per; }
      return;
    }
    const err = cmd(h, w, { c: 'prodOrder', station: st.id, recipe: r.id, mode: 'count', n: b });
    if (err) { notes.push(`${st.name} 생산 불가: ${err}`); return; }
    const o = st.orders!.at(-1)!, c = findWork(h, w.owner, x => x.ref.station === st.id && x.ref.order === o.id);
    if (c) { c.ref.item = item; orders.push({ w: c, st, o, r, out: item, per, inflight: 0, stalled: false }); }
    planned += b * per;
  });
  if (planned) notes.push(`${r.name} ${fmt(planned)} 생산 계획 (${share.filter(b => b > 0).map((b, i) => `${places[i].st.name} ${b}회`).join(', ')})`);
  return planned;
}
/** intermediate products: make what the goal's own orders still need and the company neither holds nor already plans */
function planInputs(h: WorldSim, w: Work, target: Station, orders: GoalOrder[], notes: string[]) {
  for (let depth = 0; depth < 3; depth++) {
    let added = 0;
    const need = new Map<string, number>();
    for (const g of orders) if (!g.stalled) for (const [x, n] of Object.entries(g.r.in)) need.set(x, (need.get(x) ?? 0) + n * batchesToFeed(g));
    for (const [x, req] of [...need].sort((a, b) => a[0].localeCompare(b[0]))) {
      const planned = orders.filter(g => g.out === x && !g.stalled).reduce((n, g) => n + remainingOut(g), 0);
      // input already on its way to one of this goal's production stations is covered too
      const consumers = new Set(orders.filter(g => (g.r.in[x] ?? 0) > 0).map(g => g.st.id));
      const moving = Object.values(h.st.logisticsJobs ?? {}).filter(j => j.owner === w.owner && j.item === x && j.kind !== 'sell' && liveJob(j) && consumers.has(j.to)).reduce((n, j) => n + outstanding(j), 0);
      const short = req - freeCompany(h, w.owner, x, w.id) - planned - moving;
      if (short >= 1 && producible(h, w.owner, x).length) added += planProduce(h, w, x, short, target, orders, notes);
    }
    if (!added) break;
  }
}

function runStockpile(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'stockpile' }>) {
  const st = h.st.stations[g.station]; if (!st) return setState(h, w, 'failed', '목표 정거장 소실');
  const co = h.st.companies[w.owner], pol = opsOf(co).policy, company = g.scope === 'company';
  // AUTO-P1: a company-wide target counts only secured (stored) stock; its own shipments in flight prevent a duplicate purchase
  const have = company ? companyHolding(h, w.owner, g.item) : qty(st.storage[w.owner], g.item), incoming = company ? companyStock(h.st, w.owner, g.item).incoming : incomingTo(h, w.owner, st.id, g.item);
  w.progress = { done: Math.min(have, g.target), total: g.target, unit: itemName(g.item) };
  const orders = goalOrders(h, w);
  if (!g.maintain && have >= g.target - EPS) {
    for (const o of orders) cmd(h, w, { c: 'prodOp', station: o.st.id, order: o.o.id, op: 'cancel' });
    for (const c of liveChildren(h, w, 'transport')) { const j = h.st.logisticsJobs?.[c.ref.job ?? '']; if (j && !j.ship && j.reserved <= EPS) cmd(h, w, { c: 'poolControl', job: j.id, action: 'cancel' }); }
    w.result = `${itemName(g.item)} ${fmt(have)} 확보`; resolveOpen(h, w, 'purchase', '목표 달성'); resolveOpen(h, w, 'budget', '목표 달성'); resolveOpen(h, w, 'inputs', '목표 달성');
    return setState(h, w, 'done', '');
  }
  let deficit = g.target - have - incoming;
  const parts: string[] = [];
  if (incoming > EPS) parts.push(`운송 중·예정 ${fmt(incoming)}`);
  const ships = poolShips(h, w.owner), maxCargo = ships.length ? Math.max(...ships.map(s => econOf(s).cargo)) : 0;
  // 1) company stock elsewhere (station scope only — company scope already counts every store)
  const sources = !company && ships.length ? Object.values(h.st.stations).filter(s => s.id !== st.id && (h.canDock(s, w.owner)) && freeStock(h, w.owner, s, g.item, w.id) >= 1 && routeRisk(h, s, st, pol.maxRisk))
    .sort((a, b) => (routeRisk(h, a, st, pol.maxRisk)!.hops - routeRisk(h, b, st, pol.maxRisk)!.hops) || a.id.localeCompare(b.id)) : [];
  if (deficit > EPS && sources.length && liveChildren(h, w, 'transport').length < MAX_LIVE_CHILDREN) {
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
  // stock still free elsewhere. P17.4.0 AUD-01: only stock that can actually come here holds back production or
  // purchase — a store the company cannot dock at, or one with no route inside the risk limit, is reported but
  // not counted; reachable stock waiting for a hauler is counted for a grace period (dispatch is only delayed),
  // then no longer (no hauler is coming), so the goal can fall back to production / purchase (with approval).
  const remote = company ? [] : Object.values(h.st.stations).filter(s => s.id !== st.id && s.storage[w.owner]).map(s => ({ s, n: freeStock(h, w.owner, s, g.item, w.id) })).filter(x => x.n >= 1);
  const reach = remote.filter(x => h.canDock(x.s, w.owner) && routeRisk(h, x.s, st, pol.maxRisk));
  const unreach = remote.filter(x => !reach.includes(x));
  const rt = (w.rt ??= {});
  let pending = reach.reduce((n, x) => n + x.n, 0);
  if (pending >= 1 && !ships.length) {
    rt.strandSince ??= h.time;
    if (h.time - rt.strandSince > STRAND_GRACE) { parts.push(`자사 재고 ${fmt(pending)}: 공용 배차 수송선 없이 ${Math.round((h.time - rt.strandSince) / 60)}분 — 계획에서 제외`); pending = 0; }
  } else delete rt.strandSince;
  if (deficit > EPS && pending >= 1) {
    deficit -= pending;
    parts.push(`자사 재고 ${fmt(pending)} 이송 대기${!ships.length ? ' — 공용 배차 수송선 없음 (물류 관리에서 함선 참여)' : ' (운송 순번 대기)'}`);
  }
  if (unreach.length) {
    const why = (s: Station) => !h.canDock(s, w.owner) ? '정박 불가' : routeRisk(h, s, st, 100) ? '경로 위험 허용치 초과' : '경로 없음';
    parts.push(`도달 불가 재고 ${fmt(unreach.reduce((n, x) => n + x.n, 0))} (${unreach.map(x => `${x.s.name} ${why(x.s)}`).join(', ')}) — 계획에서 제외`);
  }
  // 2) own production anywhere in the company: output already planned counts, then plan the rest
  const notes: string[] = [];
  const planned = orders.filter(o => o.out === g.item && !o.stalled).reduce((n, o) => n + remainingOut(o), 0);
  if (planned > EPS) { deficit -= planned; parts.push(`생산 예정 ${fmt(planned)}`); }
  const stalled = orders.filter(o => o.stalled);
  if (stalled.length) parts.push(`생산 정체 ${stalled.length}건 (${stalled.map(o => `${o.st.name}: ${o.o.why ?? '사유 미상'}`).join('; ')}) — 계획에서 제외`);
  if (deficit >= 1 && g.produce && pol.preferProduce) deficit -= planProduce(h, w, g.item, deficit, st, orders, notes);
  if (g.produce && pol.preferProduce) planInputs(h, w, st, orders, notes);
  parts.push(...notes);
  const live = orders.filter(o => !o.stalled);
  if (deficit < 1) {
    for (const k of ['purchase', 'budget', 'credits', 'risk']) resolveOpen(h, w, k, '부족분이 이미 확보·계획됨');
    const waiting = live.filter(o => o.w.state === 'waiting');
    if (waiting.length && !live.some(o => o.inflight > 0)) return setState(h, w, 'waiting', [...parts, `생산 대기: ${waiting.map(o => `${o.st.name} ${o.o.why ?? ''}`).join('; ')}`].join(' · '));
    return setState(h, w, 'running', parts.join(' · ') || '목표 재고 유지 중');
  }
  // 3) purchase only what neither stock nor production covers
  if (!g.buy) return setState(h, w, 'waiting', [...parts, `구매 비허용 — ${fmt(deficit)} 부족, 내부 재고·생산 대기`].join(' · '));
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
  if (risky && (w.rt?.riskOk ?? 0) >= 0 && !w.rt?.market) {
    const est = Math.ceil(need) * risky.price;
    const ap = purchaseApproval(h, w, { ok: false, kind: 'purchase', why: `가장 유리한 시장이 위험 허용치(${pol.maxRisk})를 넘는 경로에 있음` }, [{ item, amount: Math.ceil(need), price: risky.price, station: risky.s.id }],
      { risk: { level: risky.risk, hops: risky.hops, note: `${risky.hops}점프 · 경로 최대 위험도 ${Math.round(risky.risk)} (보안 등급 기반 추정 — 실제 교전 여부는 알 수 없음)` }, alt: pick ? { station: pick.s.id, cost: Math.ceil(need) * pick.price, hops: pick.hops, risk: pick.risk } : undefined,
        context: `${st.name}에 ${itemName(item)} ${fmt(need)} 부족. 위험 경로 ${risky.s.name} 단가 ${fmt(risky.price)} cr${pick ? ` / 안전 경로 ${pick.s.name} 단가 ${fmt(pick.price)} cr` : ' / 안전 경로 시장 없음'}` });
    if (ap) return setState(h, w, 'waiting', [...parts, '경로 위험 결재 대기 — 다른 업무는 계속 진행'].join(' · '));
  }
  const forced = w.rt?.market ? any.find(c => c.s.id === w.rt!.market) : undefined;
  const use = forced ?? ((w.rt?.riskOk ?? 0) > pol.maxRisk && any[0] ? any[0] : pick);
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
  const affordable = affordableLot(use.s.market![item], batch, co.credits - floor);
  if (affordable < 1 && co.credits < use.price) return setState(h, w, 'waiting', [...parts, `자금 부족 — ${fmt(use.price)} cr/개, 보유 ${fmt(co.credits)} cr · 수입 발생 시 자동 재개`].join(' · '));
  const batchN = affordable >= 1 ? Math.min(batch, affordable) : batch;
  // AUTO-P0: the walked purchase cost (market.buyCost), so authorisation and budgets match the money spent
  const cost = buyCost(use.s.market![item], batchN, growthOn(h.st)), whole = Math.max(cost, Math.ceil(need) * use.price);
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

/** Value-chain worlds: hauling cost of moving `n` units a→b with a pool hauler — its running cost (upkeep +
 *  overhead + supplies at reference value) over an estimated round trip, shared by the load it carries.
 *  Other worlds: 0 (their trade rule is unchanged). */
export function tradeHaulCost(h: WorldSim, ship: { hull?: string; classId: string } | undefined, hops: number, n: number): number {
  if (!chainOn(h.st) || !ship || n <= 0) return 0;
  const u = hullUpkeep(ship.hull ?? ship.classId);
  const perH = u.credits * (1 + OVERHEAD) + Object.entries(u.supplies ?? {}).reduce((a, [k, q]) => a + q * chainValue(k, h.st.econ!.eq), 0);
  const roundTripH = 2 * (0.15 + 0.12 * hops), cargo = Math.max(1, econOf(ship as Parameters<typeof econOf>[0]).cargo);
  return perH * roundTripH * Math.ceil(n / cargo);
}

function runTrade(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'trade' }>): void {
  const a = h.st.stations[g.from], b = h.st.stations[g.to]; if (!a?.market?.[g.item] || !b?.market?.[g.item]) return setState(h, w, 'failed', '시장 소실');
  const rt = (w.rt ??= {}); rt.phase ??= 'buy'; rt.cycles ??= 0; rt.losses ??= 0; rt.profit ??= 0;
  w.progress = { done: rt.cycles, total: g.cycles || 0, unit: '회' };
  if (rt.phase === 'bought') return dispatchTrade(h, w, g, a, b, `${rt.cycles + 1}회차 매입 완료`);
  if (rt.phase === 'move') {
    const j = h.st.logisticsJobs?.[rt.cycleJob ?? ''];
    if (j && liveJob(j)) return setState(h, w, 'running', `${rt.cycles + 1}회차 운송·판매 중 · 누적 손익 ${fmt(rt.profit)} cr`);
    const earned = j?.earned ?? 0, haul = rt.cycleHaul ?? 0, profit = earned - (rt.cycleCost ?? 0) - haul;
    // learn how much of the quoted sell price a sale of this size really realises (price walks down, taxes)
    if (rt.sellQuote && rt.bought) { const r = earned / (rt.sellQuote * rt.bought); rt.sellRatio = Math.max(0.2, Math.min(1.05, rt.sellRatio === undefined ? r : (rt.sellRatio + r) / 2)); }
    rt.cycles++; rt.profit += profit; w.income = (w.income ?? 0) + earned; rt.phase = 'buy';
    note(w, h.time, `${rt.cycles}회차 정산: 매입 ${fmt(rt.cycleCost ?? 0)} · 매출 ${fmt(earned)}${haul ? ` · 운송비 추정 ${fmt(haul)}` : ''} · ${profit >= 0 ? '이익' : '손실'} ${fmt(Math.abs(profit))} cr${j && j.lost ? ` · 손실 화물 ${fmt(j.lost)}` : ''}`);
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
  const ships = poolShips(h, w.owner);
  // AUTO-P0: a purchase walks the price up (market.buyCost), so the quote is the average price this cycle's
  // amount really costs, not the first unit's price (the authorisation and the profit check use the same figure)
  const lot = Math.floor(Math.min(g.amount, a.market![g.item].stock, h.room(a, w.owner), ships.length ? Math.max(...ships.map(s => econOf(s).cargo)) : g.amount));
  const buy = lot >= 1 ? buyCost(a.market![g.item], lot, growthOn(h.st)) / lot : h.price(a, g.item, 'buy'), sell = h.price(b, g.item, 'sell');
  // expected realised price: the quote times the ratio actually realised by earlier cycles (0.9 until measured)
  const ratio = rt.sellRatio ?? 0.9, expect = sell * ratio;
  if (buy > g.maxBuy + EPS) return setState(h, w, 'waiting', `매수가 ${fmt(buy)} cr > 상한 ${fmt(g.maxBuy)} cr — 대기`);
  const hops = chainOn(h.st) ? routeRisk(h, a, b, 100)?.hops ?? 0 : 0, haulAll = tradeHaulCost(h, ships[0], hops, g.amount);
  if (sell < g.minSell - EPS || (expect - buy) * g.amount - haulAll < g.minProfit - EPS || expect <= buy) return setState(h, w, 'waiting', `매도 호가 ${fmt(sell)} cr · 실현 예상 ${fmt(expect)} cr (${rt.sellRatio === undefined ? '초기 추정 90%' : `지난 회차 실현율 ${Math.round(ratio * 100)}%`}) vs 매수 ${fmt(buy)} cr${haulAll ? ` · 운송비 추정 ${fmt(haulAll)} cr` : ''} — 수익 조건 미충족, 대기`);
  if (!ships.length) return setState(h, w, 'waiting', '공용 배차 수송선이 없습니다');
  const r = routeRisk(h, a, b, Math.max(opsOf(h.st.companies[w.owner]).policy.maxRisk, rt.riskOk ?? 0));
  if (!r) {
    const any = routeRisk(h, a, b, 100);
    if (any) raise(h, w, 'risk', 'risk', { title: `${w.title} — 위험 경로`, reason: `경로 위험도 ${Math.round(any.risk)}가 허용치를 넘습니다`, situation: `${a.name} → ${b.name}: ${any.hops}점프 (보안 등급 기반 추정)`, items: [], estimate: { cost: buy * g.amount, note: '1회차 매입 추정' }, risk: { level: any.risk, hops: any.hops, note: '보안 등급 기반 추정 — 실제 교전 여부는 알 수 없음' }, options: [{ id: 'approve', label: '위험 경로로 진행', detail: '이 목표에 한해 위험 경로를 허용합니다', scopes: ['work'] }, { id: 'pause', label: '일시정지', detail: '', recommended: true, scopes: ['once'] }, { id: 'reject', label: '거절', detail: '6시간 동안 다시 묻지 않음', scopes: ['once'] }], rejectEffect: '무역을 진행하지 않습니다', scopeNote: '이 목표 전체' });
    return setState(h, w, 'waiting', any ? '경로 위험 결재 대기' : '경로 없음');
  }
  const n = lot;
  if (n < 1) return setState(h, w, 'waiting', '시장 재고 또는 보관 공간 부족');
  const cost = buyCost(a.market![g.item], n, growthOn(h.st)), auth = authorize(h, w, cost, buy, g.item, cost);
  if (!auth.ok) { purchaseApproval(h, w, auth, [{ item: g.item, amount: n, price: buy, station: a.id }], { context: `${rt.cycles + 1}회차 매입 — 예상 매도가 ${fmt(sell)} cr (현재 시세, 도착 시 달라질 수 있음)` }); return setState(h, w, 'waiting', `결재 대기: ${auth.why}`); }
  const co = h.st.companies[w.owner], before = co.credits, held = qty(a.storage[w.owner], g.item);
  const err = cmd(h, w, { c: 'buy', station: a.id, res: g.item, amount: n }); if (err) return setState(h, w, 'waiting', `매입 실패: ${err}`);
  const paid = before - co.credits, got = Math.floor(qty(a.storage[w.owner], g.item) - held + EPS); charge(h, w, paid, buy, g.item);
  // P17.4.0 AUD-02: the purchase is settled first (persisted with the work), then the shipment is registered; a
  // failed registration leaves the cycle in 'bought' and the next pass only re-dispatches what was bought
  rt.cycleCost = paid; rt.phase = 'bought'; rt.sellQuote = sell; rt.bought = got; rt.shipFails = 0; rt.boughtAt = h.time; delete rt.cycleJob;
  if (chainOn(h.st)) rt.cycleHaul = Math.round(tradeHaulCost(h, ships[0], hops, got)); else delete rt.cycleHaul;
  return dispatchTrade(h, w, g, a, b, `${rt.cycles + 1}회차: ${fmt(got)} 매입 (${fmt(paid)} cr)`);
}
/** P17.4.0 AUD-02: register the sale shipment of a cycle already bought (never buys). After repeated failures the
 *  bought goods stay in the origin store and the player is offered recovery options (keep retrying / end the trade). */
const TRADE_SHIP_GRACE = 600;
/** P17.4.0 AUD-01: how long reachable remote stock with no pool hauler at all still holds back production / purchase (s) */
const STRAND_GRACE = 1800;
function dispatchTrade(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'trade' }>, a: Station, b: Station, head: string): void {
  const rt = w.rt!;
  const n = Math.floor(Math.min(rt.bought ?? 0, qty(a.storage[w.owner], g.item)) + EPS);
  if (n < 1) {
    // the bought goods are no longer in the origin store (sold or moved by the player): settle the cycle as it stands
    note(w, h.time, `${(rt.cycles ?? 0) + 1}회차 매입품이 ${a.name} 보관함에 없음 — 회차를 매출 0으로 정산`);
    rt.phase = 'move'; delete rt.cycleJob;
    return runTrade(h, w, g);
  }
  const ids = Object.keys(h.st.logisticsJobs ?? {}).length;
  const e2 = cmd(h, w, { c: 'poolCreate', request: { from: a.id, to: b.id, item: g.item, kind: 'sell', amount: n, priority: w.priority, repeat: false } });
  if (!e2) {
    rt.cycleJob = Object.keys(h.st.logisticsJobs ?? {})[ids]; rt.phase = 'move'; rt.bought = n; rt.shipFails = 0;
    resolveOpen(h, w, 'ship', '판매 운송 등록');
    return setState(h, w, 'running', `${head} → ${b.name} 판매 운송`);
  }
  rt.shipFails = (rt.shipFails ?? 0) + 1;
  const kept = `매입품 ${fmt(n)}은 ${a.name} 보관함에 보존 · 다시 매입하지 않고 운송만 재시도`;
  if (rt.shipFails >= 3 && h.time - (rt.boughtAt ?? h.time) >= TRADE_SHIP_GRACE) {
    raise(h, w, 'loss', 'ship', {
      title: `${w.title} — 판매 운송 불가`, reason: `매입한 화물의 판매 운송을 등록하지 못했습니다 (${e2})`,
      situation: `${a.name} 보관함에 ${itemName(g.item)} ${fmt(n)} (매입 ${fmt(rt.cycleCost ?? 0)} cr) — ${b.name} 판매 운송 ${rt.shipFails}회 실패`, items: [],
      estimate: { cost: 0, note: '추가 매입은 없습니다' },
      options: [{ id: 'approve', label: '운송 재시도 유지', detail: '수송선·경로가 회복되면 이 화물만 운송합니다', recommended: true, scopes: ['once'] },
        { id: 'cancel', label: '반복 무역 종료', detail: '화물은 출발지 보관함에 남습니다 — 재고 화면에서 직접 판매·운송', scopes: ['once'] }],
      rejectEffect: '', scopeNote: '이번 결정만 적용',
    });
  }
  return setState(h, w, 'waiting', `${head} — 판매 운송 등록 실패: ${e2} · ${kept}`);
}

function runCondition(h: WorldSim, w: Work, g: Extract<GoalSpec, { k: 'condition' }>) {
  const st = h.st.stations[g.station]; if (!st?.market?.[g.item]) return setState(h, w, 'failed', '시장 소실');
  const p = h.price(st, g.item, g.side);
  if (g.side === 'buy' ? p > g.price + EPS : p < g.price - EPS) return setState(h, w, 'waiting', `현재 ${fmt(p)} cr — 조건 ${g.side === 'buy' ? '이하' : '이상'} ${fmt(g.price)} cr 대기`);
  const co = h.st.companies[w.owner], before = co.credits;
  if (g.side === 'buy') {
    const n = Math.floor(Math.min(g.amount, st.market[g.item].stock, h.room(st, w.owner)));
    if (n < 1) return setState(h, w, 'waiting', '시장 재고 또는 보관 공간 부족');
    const auth = authorize(h, w, buyCost(st.market[g.item], n, growthOn(h.st)), p, g.item);
    if (!auth.ok) { purchaseApproval(h, w, auth, [{ item: g.item, amount: n, price: p, station: st.id }], { context: '가격 조건 충족' }); return setState(h, w, 'waiting', `결재 대기: ${auth.why}`); }
    const err = cmd(h, w, { c: 'buy', station: st.id, res: g.item, amount: n }); if (err) return setState(h, w, 'waiting', err);
    charge(h, w, before - co.credits, p, g.item);
  } else {
    // AUTO-P0: a condition sale never digs into the minimum stock, stockpile goals or industry needs
    const n = Math.floor(Math.min(g.amount, sellableStock(h, w.owner, st, g.item), companySaleCap(h, w.owner, g.item)) + EPS);
    if (n < 1) return setState(h, w, 'waiting', qty(st.storage[w.owner], g.item) >= 1 ? '보관 재고가 최소 비축·생산 예약 이하 — 초과분이 생기면 판매' : '판매할 보관 재고 없음');
    const err = cmd(h, w, { c: 'sell', station: st.id, res: g.item, amount: n }); if (err) return setState(h, w, 'waiting', err);
    w.income = (w.income ?? 0) + (co.credits - before);
  }
  (w.rt ??= {}).triggered = (w.rt.triggered ?? 0) + 1;
  w.progress = { done: w.rt.triggered, total: g.repeat ? 0 : 1 };
  if (!g.repeat) { w.result = `${g.side === 'buy' ? '구매' : '판매'} 실행 · ${fmt(Math.abs(co.credits - before))} cr`; return setState(h, w, 'done', ''); }
  return setState(h, w, 'running', `${w.rt.triggered}회 실행`);
}

// ─────────────────────────────────────────────── purchase approvals for orders

/** the work's procurement plans that are short only because nothing authorises buying */
function blockedPlans(h: WorldSim, w: Work) {
  if (!['facility', 'production', 'ship', 'station'].includes(w.kind) || terminal(w) || w.state === 'paused' || !w.ref.station) return [];
  const kind = w.kind === 'facility' || w.kind === 'station' ? 'construction' : w.kind === 'production' ? 'production' : 'ship';
  const source = kind === 'construction' ? (w.kind === 'station' ? h.st.stations[w.ref.station]?.modules.find(m => m.kind === 'core')?.id : w.ref.module) : kind === 'production' ? w.ref.order : w.ref.build;
  if (!source) return [];
  return Object.values(h.st.procurementPlans ?? {}).filter(p => p.owner === w.owner && p.station === w.ref.station && p.sourceKind === kind && p.sourceId === source && p.state !== 'closed' && p.shortage > EPS && /자동 구매 꺼짐|최대 단가|구매 예산/.test(p.reason));
}
/**
 * Construction / production / ship work blocked only by missing purchase authority → ONE batched approval per
 * decision holder: a goal collects the input shortages of all the orders it planned; a directly ordered work
 * gets its own. The approval budget is spent by the procurement planner through `procurementAuthority`.
 */
function procurementApprovals(h: WorldSim) {
  const groups = new Map<string, { holder: Work; plans: ReturnType<typeof blockedPlans>; from: Work[] }>();
  for (const w of Object.values(h.st.works ?? {})) {
    if (terminal(w) || !['facility', 'production', 'ship', 'station'].includes(w.kind)) continue;
    const holder = budgetHolder(h, w), plans = blockedPlans(h, w);
    const gr = groups.get(holder.id) ?? (groups.set(holder.id, { holder, plans: [], from: [] }).get(holder.id)!);
    gr.plans.push(...plans); if (plans.length) gr.from.push(w);
  }
  for (const { holder, plans, from } of groups.values()) {
    const key = holder.goal ? 'inputs' : 'purchase';
    if (!plans.length) { resolveOpen(h, holder, key, '자재가 확보됨'); continue; }
    if ((holder.rt?.noBuyUntil ?? 0) > h.time || holder.state === 'paused') continue;
    const need = new Map<string, number>();
    for (const p of plans) need.set(p.item, (need.get(p.item) ?? 0) + Math.ceil(p.shortage));
    // what the goal's own production will still make is not a purchase need
    if (holder.goal) for (const o of goalOrders(h, holder)) if (!o.stalled && need.has(o.out)) need.set(o.out, Math.max(0, need.get(o.out)! - remainingOut(o)));
    for (const [k, n] of need) if (n < 1) need.delete(k);
    if (!need.size) { resolveOpen(h, holder, key, '자체 생산으로 충당 예정'); continue; }
    const items: Approval['items'] = [];
    for (const [item, amount] of [...need].sort((a, b) => a[0].localeCompare(b[0]))) {
      const m = Object.values(h.st.stations).filter(s => s.public && s.market?.[item] && s.market[item].stock >= 1 && h.canDock(s, holder.owner)).map(s => ({ s, price: h.price(s, item, 'buy') })).filter(x => x.price > 0).sort((a, b) => a.price - b.price || a.s.id.localeCompare(b.s.id))[0];
      if (m) items.push({ item, amount, price: m.price, station: m.s.id });
    }
    if (!items.length) continue;
    const whole = items.reduce((n, x) => n + x.amount * x.price, 0);
    if (authorize(h, from[0], whole, Math.max(...items.map(x => x.price)), items[0].item, whole).ok) continue;
    purchaseApproval(h, holder, { ok: false, kind: 'purchase', why: '자사 재고로 부족 — 구매 권한 없음' }, items, {
      key, context: `${holder.title}: 자사 재고·운송으로 충당되지 않는 ${holder.goal ? '원료·부품' : '자재'} ${items.map(x => `${itemName(x.item)} ${fmt(x.amount)}`).join(', ')}${from.length > 1 ? ` (작업 ${from.length}건 합산)` : ''}`,
    });
  }
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
      case 'operation': {
        const g = h.st.groups[r.group ?? '']; if (!g || g.owner !== owner) return '부대를 찾을 수 없습니다';
        opControl = true;
        try {
          if (action === 'pause') { if (w.rt?.heldOp) return null; const held = structuredClone(g.op); const e = h.command(owner, { c: 'setOp', group: g.id, op: { k: 'idle' } }); if (!e) (w.rt ??= {}).heldOp = held; return e; }
          if (action === 'resume') { const held = w.rt?.heldOp; if (!held) return '일시정지된 작전이 아닙니다'; const e = h.command(owner, { c: 'setOp', group: g.id, op: held }); if (!e) delete w.rt!.heldOp; return e; }
          return w.rt?.heldOp ? null : h.command(owner, { c: 'setOp', group: g.id, op: { k: 'idle' } });
        } finally { opControl = false; }
      }
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
  repair: 'repair', refit: 'repair', fit: 'repair', fitShip: 'repair', buyShip: 'ships', buyShipListing: 'ships', hire: 'crew', lease: 'storage', payArrears: 'upkeep', recovery: 'upkeep', recoverySell: 'upkeep',
};
export const LEDGER_NAME: Record<string, string> = {
  sales: '판매', purchase: '구매', construction: '건설', shipbuilding: '조선', research: '연구', repair: '수리·개장', ships: '함선 매매', crew: '지휘관', storage: '보관 임대', upkeep: '운영 유지비', blackmarket: '암시장', fines: '벌금', law_fines: '치안 벌금', mil_contract: '군사 계약', bounty: '전투 현상금', other: '전투·계약·기타',
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

// ─────────────────────────────────────────────────────────────── adoption

const refKey = (kind: string, a?: string, b?: string) => `${kind}|${a ?? ''}|${b ?? ''}`;
function workKeys(w: Work): string[] {
  const r = w.ref, out: string[] = [];
  if (r.module) out.push(refKey('module', r.station, r.module));
  if (r.order) out.push(refKey('order', r.station, r.order));
  if (r.build) out.push(refKey('build', r.station, r.build));
  if (r.research) out.push(refKey('research', w.owner, r.research));
  if (r.job) out.push(refKey('job', r.job));
  if (r.route) out.push(refKey('route', r.route));
  if (w.kind === 'operation' && !terminal(w)) out.push(refKey('op', r.group));
  if (w.kind === 'station' && !terminal(w) && r.group && !r.station) out.push(refKey('found', r.group));
  if (r.contract) out.push(refKey('contract', r.contract));
  return out;
}
/**
 * Bring every piece of company activity that the engines are running but no work describes yet under
 * management: orders, builds, research and construction from older saves, pool shipments started by the
 * procurement planner, managed routes, accepted contracts and standing fleet orders. Only `Work` records are
 * created — the engine objects themselves are never copied, restarted or changed. Idempotent.
 */
export function adoptEngineWork(h: WorldSim) {
  const index = new Set<string>();
  for (const w of Object.values(h.st.works ?? {})) for (const k of workKeys(w)) index.add(k);
  const players = new Set(Object.values(h.st.companies).filter(c => c.kind === 'player').map(c => c.id));
  const adopt = (owner: string, kind: WorkKind, title: string, ref: WorkRef, key: string, extra: Partial<Work> = {}) => {
    if (index.has(key)) return; index.add(key);
    const w = addWork(h, owner, kind, title, ref, { adopted: true, ...extra });
    if (!extra.parent) { delete w.parent; delete w.auto; }
    note(w, h.time, '기존 실행 중인 작업을 통합 업무로 편입'); projectWork(h, w); return w;
  };
  for (const st of Object.values(h.st.stations)) {
    const owner = st.owner; if (!owner || !players.has(owner)) continue;
    for (const m of st.modules) if (!m.built && m.id) adopt(owner, m.kind === 'core' ? 'station' : 'facility', `${st.name} · ${MODULES[m.kind]?.name ?? m.kind} 건설`, { station: st.id, module: m.id }, refKey('module', st.id, m.id));
    for (const o of st.orders ?? []) { const r = recipeFor(h.st, o.recipe); adopt(owner, 'production', `${st.name} · ${r?.name ?? o.recipe} ${o.mode === 'stock' ? `재고 ${fmt(o.n)} 유지` : `${fmt(o.n)}회`}`, { station: st.id, order: o.id }, refKey('order', st.id, o.id), { mode: o.mode === 'stock' ? 'maintain' : 'once', progress: { done: o.done, total: o.n } }); }
    for (const b of st.builds ?? []) adopt(owner, 'ship', `${st.name} · ${b.hull ? CONTENT.hulls[b.hull]?.name ?? b.hull : b.classId} 건조`, { station: st.id, build: b.id }, refKey('build', st.id, b.id));
  }
  for (const co of Object.values(h.st.companies)) if (players.has(co.id)) for (const p of co.research ?? []) adopt(co.id, 'research', `${TECHS[p.tech]?.name ?? p.tech} ${p.source === 'copy' ? '복제' : p.source === 'salvage' ? '분석' : '연구'}`, { station: p.station, research: p.id, tech: p.tech }, refKey('research', co.id, p.id));
  for (const r of Object.values(h.st.logistics ?? {})) if (players.has(r.owner) && r.state !== 'complete') adopt(r.owner, 'route', `${r.config.name || '운송 경로'} · ${itemName(r.config.item)}`, { route: r.id, group: r.group, item: r.config.item }, refKey('route', r.id), { mode: r.config.repeat ? 'repeat' : 'once' });
  for (const j of Object.values(h.st.logisticsJobs ?? {})) {
    if (!players.has(j.owner) || !liveJob(j)) continue;
    // a procurement shipment belongs under the construction / production / ship work it supplies
    const plan = j.procurement ? h.st.procurementPlans?.[j.procurement] : undefined;
    const parent = plan ? findWork(h, j.owner, w => !terminal(w) && w.ref.station === plan.station && (plan.sourceKind === 'construction' ? w.ref.module === plan.sourceId || (w.kind === 'station' && h.st.stations[plan.station]?.modules.find(m => m.kind === 'core')?.id === plan.sourceId) : plan.sourceKind === 'production' ? w.ref.order === plan.sourceId : plan.sourceKind === 'research' ? w.ref.research === plan.sourceId : w.ref.build === plan.sourceId)) : undefined;
    const from = h.st.stations[j.from]?.name ?? j.from, to = h.st.stations[j.to]?.name ?? j.to;
    adopt(j.owner, 'transport', `${plan ? '조달 · ' : ''}${itemName(j.item)} ${fmt(j.amount)} ${from} → ${to}${j.kind === 'sell' ? ' 판매' : ''}`, { job: j.id, item: j.item, station: j.to }, refKey('job', j.id),
      { mode: j.repeat ? 'repeat' : 'once', priority: j.priority, progress: { done: 0, total: j.amount }, ...(parent ? { parent: parent.id, auto: true } : plan ? { auto: true } : {}) });
  }
  for (const c of Object.values(h.st.contracts)) if (c.takenBy && players.has(c.takenBy) && !c.done) adopt(c.takenBy, 'contract', c.title, { contract: c.id, station: c.stationId }, refKey('contract', c.id), { reason: '계약 수행 중' });
  for (const g of Object.values(h.st.groups)) {
    if (!players.has(g.owner) || !g.override && g.parentId) continue;
    if (g.op.k === 'found') { const w = adopt(g.owner, 'station', `정거장 설립 · ${g.op.name}`, { group: g.id, at: { ...g.op.at } }, refKey('found', g.id)); if (w) setState(h, w, 'running', '건설선 부지로 이동 중'); continue; }
    if (g.op.k === 'idle' || !OP_NAME[g.op.k] || index.has(refKey('op', g.id))) continue;
    // a haul run by a managed route is that route's work, not a separate operation
    if (g.op.k === 'haul' && g.op.route && h.st.logistics?.[g.op.route]) continue;
    index.add(refKey('op', g.id)); const w = opWork(h, g.owner, g.id, g.op, true); if (w) note(w, h.time, '기존 실행 중인 작업을 통합 업무로 편입');
  }
}

// ───────────────────────────────────────────────────────────────── main loop

let lastSync = new WeakMap<WorldState, number>();
const lastAdopt = new WeakMap<WorldState, number>();
/** called every strategic second by the world tick */
export function stepOperations(h: WorldSim) {
  if (!growthOn(h.st)) return;
  reconcileLedger(h);
  const last = lastSync.get(h.st) ?? -Infinity; if (h.time - last < 2 - EPS) return;
  lastSync.set(h.st, h.time);
  for (const w of Object.values(h.st.works ?? {})) projectWork(h, w);
  if (h.time - (lastAdopt.get(h.st) ?? -Infinity) >= 10 - EPS) { lastAdopt.set(h.st, h.time); adoptEngineWork(h); }
  const works = Object.values(h.st.works ?? {});
  for (const w of works) if (GOAL_KINDS.includes(w.kind) && !terminal(w) && w.state !== 'paused' && h.time - (w.rt?.lastRun ?? -Infinity) >= 10 - EPS) runGoal(h, w);
  procurementApprovals(h);
  for (const a of Object.values(h.st.approvals ?? {})) if (a.state === 'open' && terminal(h.st.works?.[a.work] ?? { state: 'done' } as Work)) { a.state = 'resolved'; a.note = '업무 종료'; a.updated = h.time; }
  prune(h);
}
export function resetOpsClock(st: WorldState) { lastSync.delete(st); lastAdopt.delete(st); }

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
  /** AUTO-P1: units of normal shipments under way (reserved or aboard) and untracked cargo aboard own ships */
  incoming?: number; afloat?: number;
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
  const companyTargets: [InventoryRow, number][] = [];
  for (const wk of Object.values(w.works ?? {})) if (wk.owner === owner && !terminal(wk)) {
    if (wk.goal?.k === 'stockpile' && wk.goal.scope === 'company') { const r = row(wk.goal.item); r.target += wk.goal.target; r.works.push(wk.id); companyTargets.push([r, wk.goal.target]); }
    else if (wk.goal?.k === 'stockpile') {
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
  // a company-wide target is measured against everything the company holds of the item (sales shipments are already gone)
  // AUTO-P1: measured against secured (stored) stock; normal shipments already under way count as covering it
  for (const [r, target] of companyTargets) { const c = companyStock(w, owner, r.item); r.shortage += Math.max(0, target - c.stored - c.incoming); }
  for (const r of rows.values()) { const c = companyStock(w, owner, r.item); r.incoming = c.incoming; r.afloat = c.afloat; }
  return [...rows.values()].sort((a, b) => b.shortage - a.shortage || b.total - a.total || a.item.localeCompare(b.item));
}

/** cargo held on own ships, for screens that need the hold of one ship */
export const holdOf = (s: { cargo: Record<string, number> }) => cargoSum(s.cargo);
