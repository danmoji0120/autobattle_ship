// P17.2 repair business. A fleet with field repair gear (P16.7) set once to `repairbiz` sells field repair to
// damaged ships of other companies around its base, with no further orders: every scan it picks the best paying
// job (fee ÷ (travel + work + 60 s), never in battle, never near hostiles), flies there, repairs to full with the
// P16.7 engine (gear rate × officer ÷ hull size, stepFieldRepair) and looks again; nothing to do → it waits docked.
//
// Money only moves from a real customer to the provider, per unit of hull actually restored (no up-front charge,
// nothing for work not done, no settlement left pending across a save):
//   • player companies — only with their explicit consent (`Company.repairService`): price cap (× station price),
//     hourly budget and minimum balance; the provider's price must be within the cap;
//   • NPC navies (company kind `union`, incl. sovereignty defence forces) — paid from the treasury of the faction
//     whose space the group serves (faction economy v2 `econ.budget`, a finite treasury with real income), above a
//     reserve and within an hourly share; worlds without v2 have no NPC customers;
//   • guild traders (no treasury) and pirates (hostile) are never customers.
// The price per whole hull = ship value × REPAIR_RATE (the station price) × the provider's multiplier, fixed when
// the job is accepted. Own ships always come first: a repair ship works a paying job only when no damaged ship of
// its own company is in reach. docs/P17_INDUSTRY.md §P17.2.
import { activityOf, bookAct } from './industryPnl';
import type { WorldSim } from './sim';
import type { Company, Op, V, WGroup, WShip } from './types';
import { econOf, shipWorth } from './hullops';
import { REPAIR_RATE } from './repair';
import { coRelation } from './battleAuth';
import { hostileNear } from './salvage';
import { FIELD, fieldRate, patientOk, repairGearRate, sizeWeight } from './fieldRepair';
import { dist, jumps } from './geom';
import { emit } from './observe';
import { book } from './operations';
import { factionOf } from './territory';
import { feOn } from './factionEcon2';

export type RepairBizOp = Extract<Op, { k: 'repairbiz' }>;

export const RB = {
  /** seconds between job searches while idle */
  scan: 30,
  /** a patient must miss at least this share of its hull */
  minHurt: 0.03,
  /** allowed provider price multipliers (× station price) and the customer cap range */
  mul: [0.5, 3] as [number, number],
  /** NPC navies pay at most this × station price (they have their own docks) */
  npcMaxMul: 1.5,
  /** a faction treasury never goes below this for repairs, and spends at most this share of it per hour */
  npcReserve: 20000, npcHourShare: 0.05,
  /** no work within this distance of a running battle */
  battleR: 12000,
  /** a dropped customer is skipped this long (s) */
  ignore: 900,
  /** completed jobs kept for the panel */
  log: 12,
  /** Bound a navy ship's time off patrol while it waits for a nearby repair fleet. */
  fieldWindow: 240,
  homeR: 3500,
  homeRate: 0.012,
};

export interface RepairService { enabled: boolean; maxMul: number; perHour: number; minCredits: number; log?: { t: number; n: number }[] }
export interface RepairBizJob { t: number; ship: string; name: string; client: string; fee: number; hull: number; savedSeconds?: number }
export interface RepairBizState {
  target?: string; client?: string; unit?: number; billed?: number; hp0?: number;
  /** why the last job ended early (budget, battle, …) — the group step drops it */
  stop?: string;
  rendezvous?: { at: V; since: number; until: number; homeSeconds: number };
  next?: number; ignore?: Record<string, number>;
  income: number; jobs: RepairBizJob[]; note?: string; since: number;
}

type Payer = { kind: 'player'; co: Company } | { kind: 'faction'; fid: string };

/** who pays for this ship's repair (null: nobody can) */
export function payerOf(h: WorldSim, t: WShip): Payer | null {
  const co = h.st.companies[t.owner]; if (!co) return null;
  if (co.kind === 'player') return co.repairService?.enabled ? { kind: 'player', co } : null;
  if (co.kind !== 'union' || !feOn(h.st)) return null;
  const g = h.st.groups[t.groupId];
  const sys = (g?.npc?.sys ? h.st.systems[g.npc.sys] : undefined) ?? h.sysOf(t.pos);
  const fid = factionOf(h.st, sys);
  return fid && h.st.factions?.[fid]?.econ ? { kind: 'faction', fid } : null;
}
const hourSpent = (log: { t: number; n: number }[] | undefined, now: number) => (log ?? []).reduce((a, x) => a + (x.t > now - 3600 ? x.n : 0), 0);
const trim = (log: { t: number; n: number }[], now: number) => { while (log.length && log[0].t <= now - 3600) log.shift(); };

/** credits this payer can spend on repair now */
export function payRoom(h: WorldSim, p: Payer): number {
  if (p.kind === 'player') {
    const s = p.co.repairService!;
    return Math.max(0, Math.min(p.co.credits - Math.max(0, s.minCredits), s.perHour - hourSpent(s.log, h.time)));
  }
  const e = h.st.factions![p.fid].econ!;
  return Math.max(0, Math.min(e.budget - RB.npcReserve, e.budget * RB.npcHourShare - hourSpent(e.repairLog, h.time)));
}
/** the most a payer accepts per whole hull, as a multiple of the station price */
const maxMul = (p: Payer) => p.kind === 'player' ? p.co.repairService!.maxMul : RB.npcMaxMul;

/** station price of one whole hull of this ship (no customer discounts) */
export const baseUnit = (h: WorldSim, t: WShip) => shipWorth(h.st, t) * REPAIR_RATE;

function clientPayer(op: RepairBizOp, h: WorldSim, provider: string, t: WShip): Payer | null {
  if (t.owner === provider) return null;
  const co = h.st.companies[t.owner];
  if (!co || co.kind === 'pirate' || coRelation(h.st, provider, t.owner) === -1) return null;
  if (op.clients === 'npc' && co.kind === 'player') return null;
  if (op.clients === 'players' && co.kind !== 'player') return null;
  return payerOf(h, t);
}
function clientOk(op: RepairBizOp, h: WorldSim, provider: string, t: WShip): boolean {
  const payer = clientPayer(op, h, provider, t);
  return !!payer && op.mul <= maxMul(payer) + 1e-9;
}
/** a hostile fleet or a running battle near this point (repair businesses keep clear of both) */
export function riskyAt(h: WorldSim, owner: string, p: V): boolean {
  if (hostileNear(h, owner, p, FIELD.hostileR)) return true;
  for (const e of Object.values(h.st.engagements)) if (!e.done && dist(e.pos, p) < RB.battleR) return true;
  return false;
}
const inZone = (h: WorldSim, op: RepairBizOp, at: V) => {
  const a = h.sysOf(op.at), b = h.sysOf(at);
  return !!a && !!b && (a.id === b.id || jumps(h.st.systems, a.id, b.id) <= op.jumps);
};
/** another live repair business job holds this ship */
function heldByOther(h: WorldSim, t: WShip, g: WGroup): boolean {
  const o = t.rbBy && t.rbBy !== g.id ? h.st.groups[t.rbBy] : undefined;
  return !!o && o.rbiz?.target === t.id && h.opOf(o).k === 'repairbiz';
}

export function inspectRepairCandidate(h: WorldSim, g: WGroup, op: RepairBizOp, t: WShip) {
  if (t.owner === g.owner || !patientOk(t) || t.state !== 'space' || 1 - t.hp < RB.minHurt) return 'damage';
  if (!inZone(h, op, t.pos)) return 'range';
  const p = clientPayer(op, h, g.owner, t);
  if (!p) return 'payer';
  if (op.mul > maxMul(p) + 1e-9) return 'price';
  const unit = baseUnit(h, t) * op.mul, fee = (1 - t.hp) * unit;
  if (fee < op.minFee) return 'minFee';
  if (payRoom(h, p) < Math.min(fee, FIELD.bill)) return 'budget';
  if (op.avoidRisk && riskyAt(h, g.owner, t.pos)) return 'risk';
  return { unit, fee, faction: p.kind === 'faction' };
}

/** The best job for this fleet now, with a wait reason when there is none. */
export function findJob(h: WorldSim, g: WGroup, op: RepairBizOp, ships: WShip[]): { t: WShip; unit: number; rendezvous?: RepairBizState['rendezvous'] } | string {
  const S = g.rbiz!, rate = ships.reduce((a, s, i) => a + fieldRate(h, s) * (FIELD.dim[i] ?? 0), 0);
  if (rate <= 0) return '현장 수리 장비 없음';
  const from = h.groupCenter(g) ?? ships[0].pos, speed = Math.max(1, h.groupSpeedOf(g));
  let best: { t: WShip; unit: number; rendezvous?: RepairBizState['rendezvous'] } | null = null, bs = 0;
  const reasons = new Set<string>();
  for (const t of Object.values(h.st.ships)) {
    if ((S.ignore?.[t.id] ?? 0) > h.time || heldByOther(h, t, g) || (t.frAt ?? -1e9) > h.time - 10) continue;
    const cand = inspectRepairCandidate(h, g, op, t);
    if (typeof cand === 'string') { reasons.add(cand); continue; }
    const travel = h.travelEta(from, t.pos, speed);
    const work = (1 - t.hp) * sizeWeight(t) / rate * 3600;
    let rendezvous: RepairBizState['rendezvous'];
    if (cand.faction) {
      const navy = h.st.groups[t.groupId], home = navy?.npc?.home ? h.st.stations[navy.npc.home] : undefined;
      const atHome = home && dist(h.groupCenter(navy) ?? t.pos, home.pos) < RB.homeR;
      if (atHome && travel >= (1 - t.hp) / RB.homeRate) { reasons.add('home'); continue; }
      const onDuty = navy?.op.k === 'guard' || navy?.op.k === 'respond' && !navy.op.target;
      if (home && !atHome && onDuty && !navy._repair && !t.warp && h.sysOf(from)?.id === h.sysOf(t.pos)?.id
        && travel <= 45 && travel + work + 8 <= RB.fieldWindow && !riskyAt(h, t.owner, t.pos)) {
        const homeSeconds = 2 * h.travelEta(t.pos, home.pos, h.groupSpeedOf(navy)) + (1 - t.hp) / RB.homeRate;
        if (travel + work + 8 < homeSeconds) rendezvous = { at: { ...t.pos }, since: h.time, until: h.time + RB.fieldWindow, homeSeconds };
      }
    }
    const score = cand.fee / (travel + work + 60);
    if (score > bs || (score === bs && best && t.id < best.t.id)) { bs = score; best = { t, unit: cand.unit, rendezvous }; }
  }
  if (best) return best;
  if (reasons.has('risk')) return '교전·적대 함대 때문에 의뢰 보류';
  if (reasons.has('budget') || reasons.has('minFee') || reasons.has('price') || reasons.has('payer')) return '가격·최소 수익·고객 예산 조건을 충족하는 의뢰 없음';
  if (reasons.has('home')) return '후보 함대가 모항에서 자체 수리 중';
  return '영업 지역에 수리가 필요한 고객 함선 없음';
}

/** An on-duty navy patrol can wait for a confirmed, faster field service at its current position. */
export function navyRepairStop(h: WorldSim, s: WShip): V | undefined {
  const provider = s.rbBy ? h.st.groups[s.rbBy] : undefined;
  const job = provider?.rbiz, stop = job?.rendezvous;
  return provider && job?.target === s.id && !job.stop && stop && h.time < stop.until && h.opOf(provider).k === 'repairbiz' ? stop.at : undefined;
}

function drop(h: WorldSim, g: WGroup, why: string, ignore = RB.ignore) {
  const S = g.rbiz!; const t = S.target ? h.st.ships[S.target] : undefined;
  if (t && t.rbBy === g.id) delete t.rbBy;
  if (S.target && ignore > 0) (S.ignore ??= {})[S.target] = h.time + ignore;
  if (S.target && (S.billed ?? 0) > 0) h.say(g, `유료 수리 중단 — ${why} (정산 ${Math.round(S.billed!).toLocaleString()} cr)`, 'info', 0);
  if (S.target) emit(h.st, { kind: 'repair_job', reason: why, amount: 1, company: g.owner, group: g.id, ship: S.target });
  delete S.target; delete S.client; delete S.unit; delete S.billed; delete S.hp0; delete S.stop; delete S.rendezvous;
  S.note = why; S.next = h.time + 5;
}
function complete(h: WorldSim, g: WGroup, t: WShip) {
  const S = g.rbiz!;
  const savedSeconds = S.rendezvous && Math.max(0, Math.round(S.rendezvous.homeSeconds - (h.time - S.rendezvous.since)));
  S.jobs.unshift({ t: h.time, ship: t.id, name: t.name, client: t.owner, fee: Math.round(S.billed ?? 0), hull: Math.round((1 - (S.hp0 ?? t.hp)) * 100), ...(savedSeconds ? { savedSeconds } : {}) });
  emit(h.st, { kind: 'repair_job', reason: 'complete', amount: 1, value: savedSeconds, company: g.owner, group: g.id, ship: t.id });
  if (S.jobs.length > RB.log) S.jobs.length = RB.log;
  h.say(g, `${t.name} 유료 수리 완료 — ${Math.round(S.billed ?? 0).toLocaleString()} cr`, 'radio', 0);
  if (t.rbBy === g.id) delete t.rbBy;
  delete S.target; delete S.client; delete S.unit; delete S.billed; delete S.hp0; delete S.stop; delete S.rendezvous;
  S.next = h.time;
}

/** the group step of a repairbiz order (sim.ts runGroup): find a job, fly to it, wait docked when there is none */
export function stepRepairBiz(h: WorldSim, g: WGroup, ships: WShip[], op: RepairBizOp, dt: number): boolean {
  const S = (g.rbiz ??= { income: 0, jobs: [], since: h.time });
  const mobile = ships.filter(s => econOf(s).cruise > 0 && repairGearRate(s) > 0);
  if (!mobile.length) { g.status = '수리업: 현장 수리 장비를 단 함선 없음'; return false; }
  const speed = h.groupSpeedOf(g), center = h.groupCenter(g) ?? mobile[0].pos;
  if (S.ignore) for (const [k, v] of Object.entries(S.ignore)) if (v <= h.time) delete S.ignore[k];
  // danger at the fleet: drop the job and get clear to the nearest dock
  if (hostileNear(h, g.owner, center, FIELD.hostileR)) {
    if (S.target) drop(h, g, '적대 함대 접근');
    const sta = h.nearestDock(center, g.owner);
    for (const s of mobile) if (sta) h.goDock(s, sta, dt, speed);
    g.status = `수리업: 적대 함대 접근 — ${sta ? `${sta.name}(으)로 대피` : '대피'}`;
    return true;
  }
  let t = S.target ? h.st.ships[S.target] : undefined;
  if (S.target) {
    const navy = S.rendezvous && t ? h.st.groups[t.groupId] : undefined;
    const expired = S.rendezvous && (h.time >= S.rendezvous.until || navy?._repair || navy?.op.k === 'respond' && !!navy.op.target
      || !!t && (dist(t.pos, S.rendezvous.at) > FIELD.reach * 2 || !op.avoidRisk && riskyAt(h, t.owner, t.pos)));
    const why = S.stop ?? (expired ? '함대가 작전 복귀' : null) ?? (!t || t.hp <= 0 ? '대상 소실' : t.state === 'battle' ? '고객 함선 교전 중' : t.state !== 'space' ? '고객 함선 정박·이동' : !inZone(h, op, t.pos) ? '영업 지역 이탈'
      : op.avoidRisk && riskyAt(h, g.owner, t.pos) ? '고객 주변 적대 함대·교전' : !clientOk(op, h, g.owner, t) ? '고객 이용 조건 변경' : null);
    // repaired by someone else (NPC home dock, the owner's own repair ship) before any paid work: not a job
    if (t && !why && t.hp >= 0.999) { if ((S.billed ?? 0) > 0) complete(h, g, t); else drop(h, g, '고객 함선이 다른 경로로 수리됨', 0); t = undefined; }
    else if (why) { drop(h, g, why); t = undefined; }
  }
  if (!t && h.time >= (S.next ?? 0)) {
    const r = findJob(h, g, op, mobile);
    S.next = h.time + RB.scan;
    if (typeof r === 'string') S.note = r;
    else {
      t = r.t; S.target = t.id; S.client = t.owner; S.unit = r.unit; S.billed = 0; S.hp0 = t.hp; t.rbBy = g.id; S.rendezvous = r.rendezvous; delete S.note;
      emit(h.st, { kind: 'repair_job', reason: 'accepted', amount: 1, company: g.owner, group: g.id, ship: t.id });
      h.say(g, `수리 의뢰 수주 — ${h.st.companies[t.owner]?.name ?? t.owner} ${t.name} (내구 ${Math.round(t.hp * 100)}%, 단가 ${Math.round(r.unit * (1 - t.hp)).toLocaleString()} cr 이내)`, 'radio', 0);
    }
  }
  if (!t) {
    const sta = h.nearestDock(op.at, g.owner);
    for (const s of mobile) if (sta) h.goDock(s, sta, dt, speed); else if (s.state === 'space') { s.vel.x *= 0.85; s.vel.z *= 0.85; }
    g.status = `수리업 대기${sta ? ` (${sta.name})` : ''} — ${S.note ?? '의뢰 탐색 중'}`;
    return true;
  }
  for (const s of mobile) {
    const slot = h.formationSlot(s, g, S.rendezvous?.at ?? t.pos, 90);
    if (dist(s.pos, slot) > 40) h.moveTo(s, slot, dist(s.pos, t.pos) < FIELD.reach ? speed * 0.5 : speed, dt, 30);
    else if (s.state === 'space') { s.vel.x *= 0.8; s.vel.z *= 0.8; }
  }
  const working = mobile.some(s => s.frTarget === t!.id);
  g.status = `수리업: ${h.st.companies[t.owner]?.name ?? ''} ${t.name} ${working ? '수리 중' : '(으)로 이동'} — 내구 ${Math.round(t.hp * 100)}% · 정산 ${Math.round(S.billed ?? 0).toLocaleString()} cr`;
  return true;
}

/** stepFieldRepair: the paying patient of this repair ship (only when it has no own patient in reach) */
export function bizPatient(h: WorldSim, s: WShip, g: WGroup, served: Map<string, number>): WShip | null {
  if (h.opOf(g).k !== 'repairbiz' || !g.rbiz?.target || g.rbiz.stop) return null;
  const t = h.st.ships[g.rbiz.target];
  if (!t || t.rbBy !== g.id || !patientOk(t) || t.state !== 'space' || dist(t.pos, s.pos) > FIELD.reach || (served.get(t.id) ?? 0) >= FIELD.dim.length) return null;
  return t;
}

/** stepFieldRepair: charge the customer for `amount` of hull and pay the provider; returns the hull share paid for
 *  (≤ amount; 0 = the customer cannot pay — the job is stopped). Credits move in the same tick as the work. */
export function chargeBiz(h: WorldSim, s: WShip, g: WGroup, t: WShip, amount: number): number {
  const S = g.rbiz!, unit = S.unit ?? 0;
  if (unit <= 0) return amount;
  const p = payerOf(h, t); if (!p) { S.stop = '고객 이용 조건 변경'; return 0; }
  const room = payRoom(h, p);
  if (room < amount * unit) amount = room / unit;
  if (amount <= 1e-7) { S.stop = '고객 예산 부족'; return 0; }
  const fee = amount * unit, prov = h.st.companies[g.owner];
  if (p.kind === 'player') {
    p.co.credits -= fee;
    const log = (p.co.repairService!.log ??= []); log.push({ t: h.time, n: fee }); trim(log, h.time);
  } else {
    const e = h.st.factions![p.fid].econ!;
    e.budget -= fee;
    e.led.services = (e.led.services ?? 0) + fee;
    const log = (e.repairLog ??= []); log.push({ t: h.time, n: fee }); trim(log, h.time);
  }
  // AUD-17: the client's paid repair and the provider's repair-business income are separate ledger lines
  if (p.kind === 'player') { book(h, p.co.id, 'repair_service', -fee); bookAct(h.st, h.time, p.co.id, activityOf(h.st, t), -fee); }
  prov.credits += fee; prov.stats.earned += fee; book(h, g.owner, 'repair_biz', fee);
  bookAct(h.st, h.time, g.owner, 'repair', fee);   // P17.4f: repair-business income
  S.billed = (S.billed ?? 0) + fee; S.income += fee;
  emit(h.st, { kind: 'cost', reason: 'repair_service', amount: fee, company: p.kind === 'player' ? p.co.id : t.owner, ship: t.id, to: g.owner, ...(p.kind === 'faction' ? { method: `faction:${p.fid}` } : {}) });
  emit(h.st, { kind: 'income', reason: 'repair_service', amount: fee, company: g.owner, group: g.id, ship: s.id, from: t.owner });
  return amount;
}

// ─────────────────────────────────────────────────────────── order / customer settings

export const NO_BIZ_GEAR = '현장 수리 장비를 단 함선이 없습니다 — 수리업에는 현장 수리 장비가 필요합니다';
export function validateRepairBiz(h: WorldSim, ships: WShip[], op: RepairBizOp): string | null {
  if (!h.st.indV) return '이 월드에서는 수리업을 할 수 없습니다';
  if (!ships.some(s => repairGearRate(s) > 0)) return NO_BIZ_GEAR;
  if (!op.at || !h.sysOf(op.at)) return '영업 거점 좌표를 지정하세요';
  if (!(op.jumps === 0 || op.jumps === 1)) return '활동 범위는 0~1점프';
  if (!(op.mul >= RB.mul[0] && op.mul <= RB.mul[1])) return `가격 배율은 ${RB.mul[0]}~${RB.mul[1]}`;
  if (!['all', 'npc', 'players'].includes(op.clients)) return '고객 범위를 확인하세요';
  if (!(op.minFee >= 0 && op.minFee <= 1e6)) return '최소 수익 기준을 확인하세요';
  if (typeof op.avoidRisk !== 'boolean') return '위험 회피 설정을 확인하세요';
  return null;
}
/** a player company's consent to buy field repair from other companies (its own setting only) */
export function setRepairService(co: Company, v: unknown): string | null {
  const s = v as Partial<RepairService> | undefined;
  if (!s || typeof s.enabled !== 'boolean') return '외부 수리 이용 설정을 확인하세요';
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!n(s.maxMul) || s.maxMul! < RB.mul[0] || s.maxMul! > RB.mul[1]) return `가격 상한은 정거장 가격의 ${RB.mul[0]}~${RB.mul[1]}배`;
  if (!n(s.perHour) || !n(s.minCredits)) return '예산·최소 잔고를 확인하세요';
  co.repairService = { enabled: s.enabled, maxMul: s.maxMul!, perHour: s.perHour!, minCredits: s.minCredits!, log: co.repairService?.log ?? [] };
  return null;
}
