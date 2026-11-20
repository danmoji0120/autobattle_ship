// P16.7 field repair (out of battle). A ship with field repair gear (industrial.ts IND_REPAIR_MODULES) in an industrial
// bay restores the hull of damaged ships of its own company that are close to it — passively, with no order: a repair
// ship assigned to a fleet repairs that fleet wherever it goes, and one parked anywhere repairs whoever comes near.
// Two orders move it on purpose (same engine, the salvage recover / salvzone pattern):
//   • fieldrepair — go to one ship and repair it to full, then stand by;
//   • repairzone  — a continuing repair station: the commander picks damaged own ships around a point, flies to them,
//                   repairs and comes back, until told otherwise.
// Hull only — wear stays the work of station maintenance. It costs the station price per hull share (repair.ts
// REPAIR_RATE, research and the patient's officer discount) plus time; station repair is instant, field repair is
// where the ship is. Speed = gear rate × hull bonus × the repair ship's officer (support: repair supervision) ÷ the
// patient's hull size. Several repair ships on one patient: diminishing returns. A hostile fleet nearby stops the
// work. Spending respects the company's minimum balance and hourly limits (and the automatic repair policy's when it
// is on). Paid repair for other companies or NPCs is P17. docs/P16_7_REPAIR_SHIPS_DESIGN.md §3.
import { activityOf, bookAct } from './industryPnl';
import type { WorldSim } from './sim';
import type { Op, V, WGroup, WShip } from './types';
import { econOf, hullDefOf, shipWorth } from './hullops';
import { REPAIR_RATE } from './repair';
import { techFx } from './industry';
import { shipFx, groupFx } from './officers';
import { opsOf, spentLastHour, book } from './operations';
import { hostileNear } from './salvage';
import { emit } from './observe';
import { dist } from './geom';
import { sizeRank } from '../content/schema';
import { bizPatient, chargeBiz } from './repairBiz';

export const FIELD = {
  /** a repair ship works on a patient within this distance */
  reach: 450,
  /** hostile military fleets within this distance stop the work */
  hostileR: 5000,
  /** efficiency of the 1st, 2nd, 3rd repair ship on one patient (more do nothing) */
  dim: [1, 0.6, 0.3],
  /** patient hull size weight (S, M, L, XL): an XL hull takes eight times as long as an S */
  sizeW: [1, 2, 4, 8],
  /** credits are charged to the books in chunks of at least this much (and when a job ends) */
  bill: 250,
  /** a repairzone order works within 500..30000 m of its point */
  zoneMin: 500, zoneMax: 30000,
};

/** field repair rate of a ship (hull share per hour on a size-S hull; 0 = none) */
export const repairGearRate = (s: WShip) => (s.ind ? econOf(s).fieldRep ?? 0 : 0);
/** the repair ship's commanding officer: repair supervision (support) speeds the work up to +50 % */
export function fieldRate(h: WorldSim, s: WShip): number {
  const r = repairGearRate(s); if (!r) return 0;
  const off = h.st.officerV ? shipFx(h.st, s).repair ?? 0 : 0;
  return r * (1 + 2 * off);
}
/** hull size weight of a patient */
export function sizeWeight(s: WShip): number {
  const z = hullDefOf(s)?.size ?? econOf(s).berth;
  return FIELD.sizeW[sizeRank(z)] ?? 1;
}
/** credits for one whole hull (1.0) of field repair on this ship: the station price (repair.ts repairQuote) */
export function fieldUnitCost(h: WorldSim, s: WShip): number {
  const co = h.st.companies[s.owner];
  const off = h.st.officerV ? shipFx(h.st, s).repair ?? 0 : 0;
  return shipWorth(h.st, s) * REPAIR_RATE / techFx(co?.tech).repairMul * (1 - off);
}
const usable = (s: WShip) => s.state === 'space' || s.state === 'docked';
/** can this ship be repaired in the field right now */
export const patientOk = (s: WShip) => s.hp < 0.999 && s.hp > 0 && usable(s);

/** the lowest balance and hourly room automatic field repair may use for this company (null: no room) */
function budget(h: WorldSim, owner: string, pending: number): { floor: number; room: number } {
  const co = h.st.companies[owner], ops = opsOf(co), p = co.procurement?.repair;
  const floor = Math.max(ops.policy.minCredits, p?.enabled ? p.minCredits : 0);
  let room = Infinity;
  if (ops.policy.hourlyLimit > 0) room = ops.policy.hourlyLimit - spentLastHour(h, ops) - pending;
  if (p?.enabled) { const spent = (p.log ?? []).filter(x => x.t > h.time - 3600).reduce((n, x) => n + x.n, 0); room = Math.min(room, p.perHour - spent - pending); }
  return { floor, room };
}

/** charge what a repair ship has run up (books, hourly logs, observation) */
function flush(h: WorldSim, s: WShip) {
  const n = s.frBill ?? 0; if (n <= 0) { delete s.frBill; return; }
  const co = h.st.companies[s.owner]; if (!co) { delete s.frBill; return; }
  opsOf(co).spend.push({ t: h.time, n });
  const p = co.procurement?.repair; if (p?.enabled) (p.log ??= []).push({ t: h.time, n, ship: s.id });
  emit(h.st, { kind: 'cost', reason: 'repair', method: 'field', amount: n, company: s.owner, group: s.groupId, ship: s.id });
  delete s.frBill;
}

/** the patient a repair ship picks now: its order's ship first, then its own fleet, then anyone of its company close by */
function pick(h: WorldSim, s: WShip, near: WShip[], served: Map<string, number>): WShip | null {
  const g = h.st.groups[s.groupId], op = g ? h.opOf(g) : undefined;
  if (op?.k === 'fieldrepair') { const t = h.st.ships[op.ship]; if (t && t.owner === s.owner && patientOk(t) && dist(t.pos, s.pos) <= FIELD.reach && (served.get(t.id) ?? 0) < FIELD.dim.length) return t; }
  let best: WShip | null = null, bs = Infinity;
  for (const t of near) {
    if (t === s || (served.get(t.id) ?? 0) >= FIELD.dim.length || dist(t.pos, s.pos) > FIELD.reach) continue;
    const score = t.hp - (t.groupId === s.groupId ? 0.2 : 0) + (served.get(t.id) ?? 0) * 0.3;
    if (score < bs) { bs = score; best = t; }
  }
  return best;
}

/** once per world second: every field repair ship works on one patient in reach (sim.ts tick, slow step) */
export function stepFieldRepair(h: WorldSim, dt: number) {
  const st = h.st;
  const repairers: WShip[] = [];
  for (const s of Object.values(st.ships)) if (s.ind && usable(s) && repairGearRate(s) > 0 && st.companies[s.owner]?.kind === 'player') repairers.push(s);
  if (!repairers.length) return;
  // damaged ships per company (small lists: only ships with hull damage)
  const hurt = new Map<string, WShip[]>();
  for (const s of Object.values(st.ships)) if (patientOk(s)) { const l = hurt.get(s.owner); if (l) l.push(s); else hurt.set(s.owner, [s]); }
  const served = new Map<string, number>();
  const danger = new Map<string, boolean>();
  const pending = new Map<string, number>();
  for (const s of repairers) {
    const near = hurt.get(s.owner);
    const g = st.groups[s.groupId];
    // own ships first; a repair business (P17.2) works its paying customer only when no own ship is in reach
    const own = near?.length && g && !g.fleeing ? pick(h, s, near, served) : null;
    const paid = !own && g && !g.fleeing ? bizPatient(h, s, g, served) : null;
    const t = own ?? paid;
    if (!t || !g) { if (s.frTarget) { delete s.frTarget; flush(h, s); } continue; }
    let d = danger.get(g.id);
    if (d === undefined) { d = hostileNear(h, s.owner, s.pos, FIELD.hostileR * (st.officerV ? 1 + (groupFx(st, g).salvRisk ?? 0) : 1)); danger.set(g.id, d); }
    if (d) { s.frNote = '적대 함대 접근 — 현장 수리 중단'; if (s.frTarget) { delete s.frTarget; flush(h, s); } continue; }
    const k = served.get(t.id) ?? 0;
    let amount = Math.min(1 - t.hp, fieldRate(h, s) * FIELD.dim[k] / sizeWeight(t) / 3600 * dt);
    if (amount <= 0) continue;
    if (paid) {
      // P17.2: the customer pays the provider for exactly the hull restored (repairBiz.chargeBiz); never free
      if (s.frTarget && s.frTarget !== t.id) flush(h, s);
      if (t.hp + amount >= 0.999) amount = 1 - t.hp;   // the last sliver is charged too, never rounded up for free
      amount = chargeBiz(h, s, g, t, amount);
      if (amount <= 0) { s.frNote = `유료 수리 중단 — ${g.rbiz?.stop ?? '고객 예산 부족'}`; delete s.frTarget; continue; }
      t.hp = Math.min(1, t.hp + amount); if (t.hp >= 1 - 1e-9) t.hp = 1;
      t.frAt = h.time; served.set(t.id, k + 1);
      if (s.frTarget !== t.id) { s.frTarget = t.id; h.say(g, `${s.name}: ${t.name} 유료 수리 시작 (내구 ${Math.round(t.hp * 100)}%)`, 'radio', 30); }
      s.frNote = `유료 수리 중 — ${t.name} 내구 ${Math.round(t.hp * 100)}%`;
      if (t.hp >= 1) { delete s.frTarget; s.frNote = `${t.name} 유료 수리 완료`; }
      continue;
    }
    const co = st.companies[s.owner], unit = fieldUnitCost(h, t);
    const pend = pending.get(s.owner) ?? 0;
    const b = budget(h, s.owner, pend + (s.frBill ?? 0));
    const afford = Math.min(co.credits - b.floor, b.room);
    if (unit > 0 && afford < amount * unit) {
      amount = Math.max(0, afford / unit);
      if (amount <= 1e-6) { s.frNote = `현장 수리 보류 — ${co.credits - b.floor <= 0 ? `최소 잔고 ${Math.round(b.floor).toLocaleString()} cr` : '시간당 수리·지출 한도'} 도달`; if (s.frTarget) { delete s.frTarget; flush(h, s); } continue; }
    }
    const cost = amount * unit;
    t.hp = Math.min(1, t.hp + amount);
    if (t.hp >= 0.999) t.hp = 1;
    t.frAt = h.time;
    co.credits -= cost;
    book(h, s.owner, 'repair_fleet', -cost);   // AUD-17: own-fleet field maintenance (a cost, never income)
    bookAct(h.st, h.time, s.owner, activityOf(h.st, t), -cost);   // P17.4f: a cost of the patient's business
    s.frBill = (s.frBill ?? 0) + cost;
    pending.set(s.owner, pend + cost);
    served.set(t.id, k + 1);
    if (s.frTarget !== t.id) {
      if (s.frTarget) flush(h, s);
      s.frTarget = t.id;
      if (g) h.say(g, `${s.name}: ${t.name} 현장 수리 시작 (내구 ${Math.round(t.hp * 100)}%)`, 'radio', 30);
    }
    s.frNote = `현장 수리 중 — ${t.name} 내구 ${Math.round(t.hp * 100)}%`;
    if ((s.frBill ?? 0) >= FIELD.bill) flush(h, s);
    if (t.hp >= 1) { flush(h, s); delete s.frTarget; s.frNote = `${t.name} 현장 수리 완료`; if (g) h.say(g, `${s.name}: ${t.name} 선체 수리 완료`, 'radio', 0); }
  }
}

// ─────────────────────────────────────────────────────────── orders (movement; the work itself is stepFieldRepair)

export const NO_REPAIR_GEAR = '현장 수리 장비를 단 함선이 없습니다 — 산업 하드포인트에 현장 수리 장비가 필요합니다';
/** validate a fieldrepair / repairzone order (null = ok) */
export function validateFieldRepair(h: WorldSim, company: string, ships: WShip[], op: Extract<Op, { k: 'fieldrepair' | 'repairzone' }>): string | null {
  if (!ships.some(s => repairGearRate(s) > 0)) return NO_REPAIR_GEAR;
  if (op.k === 'fieldrepair') {
    const t = h.st.ships[op.ship];
    if (!t || t.owner !== company) return '수리할 자사 함선을 지정하세요';
    if (ships.includes(t)) return '편대 안의 함선은 따로 지정하지 않아도 자동으로 수리합니다';
    if (t.hp >= 0.999) return `${t.name}: 선체 손상 없음`;
    return null;
  }
  if (!(op.radius >= FIELD.zoneMin && op.radius <= FIELD.zoneMax)) return `작업 반경은 ${FIELD.zoneMin}~${FIELD.zoneMax}m`;
  if (!h.sysOf(op.at)) return '성계 안의 좌표를 지정하세요';
  return null;
}

/** the group step of a fieldrepair / repairzone order (sim.ts runGroup). Returns true when it moved the ships. */
export function stepRepairOrder(h: WorldSim, g: WGroup, ships: WShip[], op: Extract<Op, { k: 'fieldrepair' | 'repairzone' }>, dt: number): boolean {
  const st = h.st, speed = h.groupSpeedOf(g);
  const mobile = ships.filter(s => econOf(s).cruise > 0);
  if (!mobile.length) return false;
  const center = h.groupCenter(g) ?? mobile[0].pos;
  if (hostileNear(h, g.owner, center, FIELD.hostileR)) {
    // stop and get clear: the nearest dock (the commander's own threat check usually has the fleet fleeing already)
    const sta = h.nearestDock(center, g.owner);
    for (const s of mobile) if (sta) h.goDock(s, sta, dt, speed);
    g.status = `현장 수리 중단 — 적대 함대 접근${sta ? `, ${sta.name}(으)로 대피` : ''}`;
    return true;
  }
  let target: WShip | undefined, where: V | undefined;
  if (op.k === 'fieldrepair') {
    target = st.ships[op.ship];
    if (!target || target.owner !== g.owner || target.hp <= 0) return finish(h, g, '수리 대상 소실');
    if (target.hp >= 0.999) return finish(h, g, `${target.name} 수리 완료`);
    if (target.state === 'battle') { g.status = `현장 수리: ${target.name} 교전 중 — 전투 종료 대기`; hold(mobile); return true; }
    where = target.pos;
  } else {
    // the most damaged own ship in the zone (not in battle); ties by id
    let best: WShip | undefined;
    for (const s of Object.values(st.ships)) {
      if (s.owner !== g.owner || !patientOk(s) || ships.includes(s) || dist(s.pos, op.at) > op.radius) continue;
      if (!best || s.hp < best.hp || (s.hp === best.hp && s.id < best.id)) best = s;
    }
    target = best; where = best?.pos ?? op.at;
  }
  for (const s of mobile) {
    const slot = h.formationSlot(s, g, where!, target ? 90 : 120);
    if (dist(s.pos, slot) > 40) h.moveTo(s, slot, target && dist(s.pos, where!) < FIELD.reach ? speed * 0.5 : speed, dt, 30);
    else if (s.state === 'space') { s.vel.x *= 0.8; s.vel.z *= 0.8; }
  }
  const working = mobile.find(s => s.frTarget && s.frNote);
  g.status = target
    ? (working && target && working.frTarget === target.id ? `현장 수리 중 — ${target.name} 내구 ${Math.round(target.hp * 100)}%` : `현장 수리: ${target.name}(내구 ${Math.round(target.hp * 100)}%)로 이동`)
    : `수리 구역 대기 — 반경 ${Math.round((op as Extract<Op, { k: 'repairzone' }>).radius)}m 안에 손상된 함선 없음`;
  return true;
}
function hold(ships: WShip[]) { for (const s of ships) if (s.state === 'space') { s.vel.x *= 0.85; s.vel.z *= 0.85; } }
function finish(h: WorldSim, g: WGroup, why: string): boolean {
  h.say(g, `현장 수리 종료 — ${why}. 대기합니다.`, 'info', 0);
  if (g.override || !g.parentId) { g.op = { k: 'idle' }; g.override = !!g.parentId; }
  g.status = `현장 수리 종료 — ${why}`;
  return false;
}
