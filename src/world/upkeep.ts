// Running costs (growth P4, contentV ≥ 3). Ships cost money and consumables to keep in service,
// wear out with use and are maintained automatically when they dock somewhere that can do it.
// Automation is never penalised: a mining fleet that unloads at a station with repair facilities is
// maintained on every visit without any order. Large hulls carry extra infrastructure costs, and a
// big fleet carries an administrative overhead, so ten times the ships is not ten times the profit.
//
// Settlement every SETTLE_DT seconds: consumables are taken from the company's own storage first
// (own stations, then the home station), the rest is bought at the home region's market (real stock
// and price: upkeep is real NPC demand that players can supply); if no market has it, emergency
// procurement costs double. Credits that cannot be paid become arrears:
//   stage 1 (immediately)    warning + forecast
//   stage 2 (30 min arrears) resupply and maintenance delayed (wear is not removed, extra wear)
//   stage 3 (60 min)         new departures held: docked ships stay docked (ships in space or in
//                            battle are never touched or recalled)
//   stage 4 (120 min)        idle docked ships are proposed for reserve; moved only with consent
//                            (the player's command, or the company's opt-in auto-reserve)
// Nothing is ever deleted or confiscated, no interest is charged, and paying the debt clears it.
import type { Company, Station, WorldState, WShip, Cargo, UpkeepState } from './types';
import { qty, addc } from './types';
import { econOf, hullIdOf, hullUpkeep, berthOf, growthOn, shipWorth } from './hullops';
import { sizeRank } from '../content/schema';
import { itemPrice, EQUIPMENT, techFx } from './industry';
import { priceOf, fundsIn } from './market';
import { leaseRate, dockCapacity, useDock, repairPoints, serviceOf } from './storage';

export const SETTLE_DT = 60;
export const RESERVE_MUL = 0.15;
export const REACTIVATE_S = 600;
/** seconds of unpaid arrears to reach stage 2/3/4 */
export const STAGE_AT = [0, 0, 1800, 3600, 7200];
export const STAGE_NAME = ['정상', '경고', '보급·정비 지연', '신규 출항 보류', '예비역 전환 제안'];
/** docking fee per hour for large hulls at public stations (own stations: free) */
export const BIG_DOCK_FEE: Record<string, number> = { L: 250, XL: 700 };

export const upkeepOf = (co: Company): UpkeepState => (co.upkeep ??= { debt: 0, stage: 0, since: 0, acc: 0, supplies: {}, last: 0, total: { credits: 0, supplies: 0, paid: 0 } });

/** administrative overhead per ship (rev 2: flat). The old curve (+3% per ship beyond 8) made
 *  splitting a fleet over several accounts cheaper than running it as one; a flat share costs the
 *  same however ships are divided. What a big fleet really runs into is maintenance capacity: public
 *  docks are shared and slow (storage.ts dockCapacity), so large fleets need their own repair bases. */
import { OVERHEAD } from './econConfig';
export { OVERHEAD };
export const overheadMul = (_ships: number) => 1 + OVERHEAD;

/** per-hour running cost of one ship right now */
export function shipRate(w: WorldState, s: WShip): { credits: number; supplies: Record<string, number>; dock: number } {
  const u = hullUpkeep(hullIdOf(s), s.variant);
  const res = !!s.reserve && !s.reserve.until;
  const mul = res ? RESERVE_MUL : 1;
  let dock = 0;
  const berth = econOf(s).berth;
  if (s.task.k === 'docked' && sizeRank(berth) >= 2) {
    const st = w.stations[s.task.station];
    if (st?.public) dock = (BIG_DOCK_FEE[berth] ?? 0) * (res ? 2 : 1);   // laid-up giants still occupy a big berth
  }
  // P5: fitted weapons burn ammunition / propellant; logistics research lowers supplies and pay
  const tf = techFx(w.companies[s.owner]?.tech);
  const supplies: Record<string, number> = res ? {} : { ...(u.supplies ?? {}) };
  if (!res && s.fitting) for (const id of Object.values(s.fitting.hp ?? {})) for (const [k, n] of Object.entries(EQUIPMENT[id]?.supply ?? {})) supplies[k] = (supplies[k] ?? 0) + n;
  if (tf.supplyMul !== 1) for (const k of Object.keys(supplies)) supplies[k] *= tf.supplyMul;
  return { credits: u.credits * mul * tf.upkeepMul, supplies, dock };
}

export interface Forecast { ships: number; credits: number; supplies: Record<string, number>; suppliesCr: number; dock: number; overhead: number; lease: number; perHour: number }
/** what the company's fleet costs per hour at current prices */
export function forecast(w: WorldState, co: Company): Forecast {
  const ships = Object.values(w.ships).filter(s => s.owner === co.id && s.classId !== 'platform');
  let credits = 0, dock = 0; const supplies: Record<string, number> = {};
  for (const s of ships) { const r = shipRate(w, s); credits += r.credits; dock += r.dock; for (const [k, n] of Object.entries(r.supplies)) supplies[k] = (supplies[k] ?? 0) + n; }
  const active = ships.filter(s => !s.reserve).length;
  const om = overheadMul(active);
  const market = homeMarket(w, co);
  let suppliesCr = 0;
  for (const [k, n] of Object.entries(supplies)) suppliesCr += n * (market?.market?.[k] ? priceOf(market.market[k], 'buy', true) : itemPrice(k) * 2);
  const overhead = credits * (om - 1);
  const lease = leaseRate(w, co);
  return { ships: ships.length, credits, supplies, suppliesCr, dock, overhead, lease, perHour: credits + overhead + dock + suppliesCr + lease };
}

/** the market a company buys its consumables at: its home station's, else the nearest public market */
export function homeMarket(w: WorldState, co: Company): Station | undefined {
  const home = w.stations[co.homeStation];
  if (home?.public && home.market) return home;
  const p = home?.pos ?? { x: 0, y: 0, z: 0 };
  return Object.values(w.stations).filter(s => s.public && s.market).sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.z - p.z) - Math.hypot(b.pos.x - p.x, b.pos.z - p.z))[0];
}

export interface UpkeepEvent { kind: 'warn' | 'info' | 'money'; text: string; tag?: string }

/** accrue dt seconds of running costs and wear; settles every SETTLE_DT. Returns notices. */
export function stepUpkeep(w: WorldState, co: Company, dt: number): UpkeepEvent[] {
  if (!growthOn(w) || co.kind !== 'player') return [];
  const u = upkeepOf(co);
  const out: UpkeepEvent[] = [];
  const ships = Object.values(w.ships).filter(s => s.owner === co.id && s.classId !== 'platform');
  const om = overheadMul(ships.filter(s => !s.reserve).length);
  const h = dt / 3600;
  for (const s of ships) {
    if (s.reserve?.until && w.time >= s.reserve.until) { delete s.reserve; out.push({ kind: 'info', text: `${s.name} 예비역 해제 — 재취역 완료`, tag: 'reserve' }); }
    const r = shipRate(w, s);
    u.acc += (r.credits * om + r.dock) * h;
    for (const [k, n] of Object.entries(r.supplies)) u.supplies[k] = (u.supplies[k] ?? 0) + n * h;
    // wear: accumulates while the ship works in space; slower without supplies (stage ≥ 2 doubles it)
    const wr = hullUpkeep(hullIdOf(s), s.variant).wear ?? 0;
    if (s.state === 'space' && !s.reserve && (Math.abs(s.vel.x) + Math.abs(s.vel.z) > 1 || s.task.k === 'mine')) s.wear = Math.min(1, (s.wear ?? 0) + wr * h * (u.stage >= 2 ? 2 : 1));
  }
  u.acc += leaseRate(w, co) * h;
  if (w.time - u.last < SETTLE_DT) return out;
  u.last = w.time;
  out.push(...settle(w, co, u));
  return out;
}

function settle(w: WorldState, co: Company, u: UpkeepState): UpkeepEvent[] {
  const out: UpkeepEvent[] = [];
  const delayed = u.stage >= 2;
  const fromStore: Record<string, number> = {}, bought: Record<string, number> = {};
  let supplyCr = 0;
  // consumables: whole units only (fractions carry over); own storage first, then the market
  const own = Object.values(w.stations).filter(s => s.owner === co.id);
  const home = w.stations[co.homeStation];
  const sources = [...own, ...(home && !own.includes(home) ? [home] : [])];
  const market = homeMarket(w, co);
  for (const [k, owed] of Object.entries(u.supplies)) {
    let n = Math.floor(owed + 1e-9); if (n <= 0) continue;
    if (delayed) continue;   // resupply delayed: the bill keeps accruing, nothing is drawn
    for (const st of sources) {
      const S = st.storage[co.id]; const t = Math.min(n, Math.floor(qty(S, k) + 1e-9));
      if (t > 0) { addc(S as Cargo, k, -t); n -= t; fromStore[k] = (fromStore[k] ?? 0) + t; }
      if (!n) break;
    }
    if (n > 0) {
      const m = market?.market?.[k];
      const fromM = m ? Math.min(n, Math.floor(m.stock)) : 0;
      if (fromM > 0) { const c = fromM * priceOf(m, 'buy', true); supplyCr += c; m!.stock -= fromM; fundsIn(market!, c); bought[k] = (bought[k] ?? 0) + fromM; }
      if (n - fromM > 0) supplyCr += (n - fromM) * itemPrice(k) * 2;   // emergency procurement (no stock: double price)
      if (n - fromM > 0) bought[k] = (bought[k] ?? 0) + n - fromM;
    }
    u.supplies[k] = owed - Math.floor(owed + 1e-9);
  }
  const bill = u.acc + supplyCr;
  u.acc = 0;
  u.total.credits += bill - supplyCr; u.total.supplies += supplyCr;
  const due = bill + u.debt;
  const pay = Math.max(0, Math.min(co.credits, due));
  co.credits -= pay; u.total.paid += pay;
  u.debt = due - pay;
  const f = forecast(w, co);
  u.bill = { t: w.time, credits: Math.round(bill - supplyCr), supplies: Math.round(supplyCr), dock: Math.round(f.dock), overhead: Math.round(f.overhead), fromStore, bought, paid: Math.round(pay), short: Math.round(u.debt), perHour: Math.round(f.perHour) };
  // arrears stages
  const prev = u.stage;
  if (u.debt > 1) {
    if (!u.since) u.since = w.time;
    const dt = w.time - u.since;
    u.stage = dt >= STAGE_AT[4] ? 4 : dt >= STAGE_AT[3] ? 3 : dt >= STAGE_AT[2] ? 2 : 1;
  } else { u.debt = 0; u.since = 0; u.stage = 0; }
  if (u.stage !== prev) {
    if (u.stage === 0) out.push({ kind: 'info', text: '운영비 체납 해소 — 모든 함선 정상 운용', tag: 'upkeep' });
    else if (u.stage === 1) out.push({ kind: 'warn', text: `운영비 체납 ${Math.round(u.debt).toLocaleString()} cr — 시간당 운영비 약 ${Math.round(f.perHour).toLocaleString()} cr. 30분 안에 갚지 못하면 보급·정비가 지연됩니다.`, tag: 'upkeep' });
    else if (u.stage === 2) out.push({ kind: 'warn', text: '체납 2단계: 보급·정비 지연 — 소모품을 보충하지 못해 함선 마모가 빨라집니다.', tag: 'upkeep' });
    else if (u.stage === 3) out.push({ kind: 'warn', text: '체납 3단계: 신규 출항 보류 — 정박 중인 함선은 체납이 풀릴 때까지 출항하지 않습니다 (운항·전투 중인 함선은 그대로).', tag: 'upkeep' });
    else out.push({ kind: 'warn', text: '체납 4단계: 정박 중인 유휴 함선의 예비역 전환을 권고합니다 (함대 화면에서 직접 선택, 운영비 85% 절감). 함선·장비는 삭제되지 않습니다.', tag: 'upkeep' });
  }
  if (u.stage >= 4 && u.autoReserve) {
    for (const s of Object.values(w.ships)) if (s.owner === co.id && s.state === 'docked' && !s.reserve && !s.listed && idleDocked(w, s)) { s.reserve = { since: w.time }; out.push({ kind: 'info', text: `${s.name} 예비역 전환 (자동 예비역 동의)`, tag: 'reserve' }); }
  }
  return out;
}

/** a docked ship whose group has nothing for it to do */
export function idleDocked(w: WorldState, s: WShip): boolean {
  const g = w.groups[s.groupId];
  return s.state === 'docked' && (!g || g.op.k === 'idle' || g.op.k === 'dock');
}

/** docked ships that must not depart: reserve, sale listings, or stage-3 arrears */
export function departureHeld(w: WorldState, s: WShip): string | null {
  if (!growthOn(w)) return null;
  if (s.listed) return '거래소 매물 — 출항 불가';
  if (s.reserve) return s.reserve.until ? '재취역 준비 중' : '예비역 — 출항하려면 재취역';
  const co = w.companies[s.owner];
  if ((co?.upkeep?.stage ?? 0) >= 3) return '운영비 체납 — 신규 출항 보류';
  return null;
}

/** maintenance on docking: a station with repair facilities removes wear for a fee (automatic) */
export function maintainOnDock(w: WorldState, s: WShip, st: Station, repairCapable: boolean): number {
  if (!growthOn(w) || !repairCapable || !(s.wear ?? 0)) return 0;
  const co = w.companies[s.owner];
  if (!co || co.kind !== 'player' || (co.upkeep?.stage ?? 0) >= 2) return 0;
  let fix = Math.min(s.wear!, 0.5);
  // rev 2: a dock maintains only so many hull-points an hour (shared at public stations); a crowded
  // dock does part of the job and the rest waits for the next visit
  const cap = dockCapacity(w, st);
  const pts = repairPoints(s, fix);
  if (pts > cap) { fix *= cap / pts; s.dockWait = w.time; }
  if (fix < 1e-4) return 0;
  useDock(st, repairPoints(s, fix));
  const cost = Math.round(fix * shipWorth(w, s) * 0.12 * (st.owner === co.id ? 0.5 : serviceOf(st).fee));
  s.wear = s.wear! - fix;
  upkeepOf(co).acc += cost;
  if (st.public) fundsIn(st, cost);
  return cost;
}
