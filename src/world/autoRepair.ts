// AUTO-P1: conditional automatic repair of automated haulers.
//
// A hauler of the automatic logistics pool, or a mining fleet's own hauler, drops out of dispatch below
// HAULER_MIN_HP. When the player has allowed it, this repairs it within the limits the player set:
//   - never below the company's minimum balance (the larger of this policy's and the company operations policy's),
//   - never more than `maxPerRepair` for one repair, and never more than `perHour` over the last game hour,
//   - and inside the company's hourly automatic-spending limit (operations policy), which the repair also uses up.
// The price is the existing manual repair quote (repair.ts) and the charge goes through the existing `repair`
// command (ledger, work record, events); the policy itself is the player's prior approval. A ship docked at a repair
// station is repaired there; otherwise it flies to the nearest reachable repair station within the logistics risk
// limit and comes back to its work afterwards. One repair per ship at a time; cargo stays aboard throughout.
import type { WorldSim } from './sim';
import type { Station, WShip } from './types';
import { cargoSum } from './types';
import { HAULER_MIN_HP, poolMember } from './haulers';
import { canRepairAt, repairQuote } from './repair';
import { berthFits, econOf, growthOn } from './hullops';
import { opsOf, spentLastHour } from './operations';
import { routeScore } from './procurement';

export interface RepairPolicy {
  enabled: boolean;
  /** keep at least this balance after a repair */
  minCredits: number;
  /** the most one repair may cost */
  maxPerRepair: number;
  /** the most automatic repairs may cost over any game hour (0 = none allowed) */
  perHour: number;
  /** recent automatic repairs (last hour kept) */
  log?: { t: number; n: number; ship: string }[];
  /** last decision per ship (shown to the player) */
  status?: Record<string, { t: number; reason: string }>;
}
export interface RepairSettings { enabled: boolean; minCredits: number; maxPerRepair: number; perHour: number }
const EPS = 1e-9;
const money = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12;

export function setRepairPolicy(h: WorldSim, owner: string, s: RepairSettings): string | null {
  const co = h.st.companies[owner];
  if (!growthOn(h.st) || !co || co.kind !== 'player' || !co.procurement) return '이 세계에서는 자동 수리를 사용할 수 없습니다';
  if (!s || typeof s !== 'object' || typeof s.enabled !== 'boolean' || !money(s.minCredits) || !money(s.maxPerRepair) || !money(s.perHour)) return '자동 수리 설정을 확인하세요 (금액은 0 이상)';
  if (s.enabled && (s.maxPerRepair <= 0 || s.perHour <= 0)) return '자동 수리를 켜려면 1회 최대 수리비와 시간당 수리 예산을 0보다 크게 정하세요';
  const p = co.procurement.repair ??= { enabled: false, minCredits: 0, maxPerRepair: 0, perHour: 0 };
  p.enabled = s.enabled; p.minCredits = s.minCredits; p.maxPerRepair = s.maxPerRepair; p.perHour = s.perHour;
  if (!s.enabled) { for (const sh of Object.values(h.st.ships)) if (sh.owner === owner && sh.repairAt) delete sh.repairAt; delete p.status; }
  return null;
}

/** ships automatic repair looks after: automatic-logistics haulers and mining fleets' own haulers */
function covered(h: WorldSim, s: WShip): boolean {
  if (s.hp <= 0 || s.state === 'building' || s.reserve || s.listed) return false;
  const g = h.st.groups[s.groupId]; if (!g) return false;
  if (s.classId === 'hauler' && h.opOf(g).k === 'mine') return true;
  return poolMember(h.st, s) && h.opOf(g).k === 'idle' && econOf(s).cargo > 0;
}
const repairSpent = (h: WorldSim, p: RepairPolicy) => { p.log = (p.log ?? []).filter(x => x.t > h.time - 3600); return p.log.reduce((n, x) => n + x.n, 0); };
/** null when a repair costing `cost` is within every limit, else why not */
function budgetProblem(h: WorldSim, owner: string, p: RepairPolicy, cost: number): string | null {
  const co = h.st.companies[owner], ops = opsOf(co), floor = Math.max(p.minCredits, ops.policy.minCredits);
  if (cost > p.maxPerRepair + EPS) return `수리비 ${Math.round(cost).toLocaleString()} cr가 1회 한도 ${Math.round(p.maxPerRepair).toLocaleString()} cr 초과`;
  if (co.credits - cost < floor - EPS) return `수리 후 잔고가 최소 잔고 ${Math.round(floor).toLocaleString()} cr 아래로 내려감`;
  const spent = repairSpent(h, p);
  if (spent + cost > p.perHour + EPS) return `시간당 수리 예산 ${Math.round(p.perHour).toLocaleString()} cr 중 ${Math.round(spent).toLocaleString()} cr 사용 — 다음 시간에 재시도`;
  if (ops.policy.hourlyLimit > 0 && spentLastHour(h, ops) + cost > ops.policy.hourlyLimit + EPS) return `회사 시간당 자동 지출 한도 ${Math.round(ops.policy.hourlyLimit).toLocaleString()} cr 초과`;
  return null;
}
const note = (h: WorldSim, p: RepairPolicy, s: WShip, reason: string) => { (p.status ??= {})[s.id] = { t: h.time, reason }; };

/** repair now (docked at a repair station, within the limits); true when repaired */
function repairHere(h: WorldSim, s: WShip, p: RepairPolicy): boolean {
  const co = h.st.companies[s.owner], q = repairQuote(h.st, s, co);
  if (q.why) { note(h, p, s, q.why); return false; }
  const why = budgetProblem(h, s.owner, p, q.cost); if (why) { note(h, p, s, why); return false; }
  const err = h.command(s.owner, { c: 'repair', ship: s.id, quote: q.cost });
  if (err) { note(h, p, s, err); return false; }
  (p.log ??= []).push({ t: h.time, n: q.cost, ship: s.id }); opsOf(co).spend.push({ t: h.time, n: q.cost });
  note(h, p, s, `자동 수리 완료 — ${q.cost.toLocaleString()} cr`);
  delete s.repairAt;
  return true;
}
/** the nearest repair station this ship can reach within the logistics risk limit */
function repairStation(h: WorldSim, s: WShip): Station | undefined {
  const maxRisk = h.st.companies[s.owner]?.procurement?.maxRisk ?? 100;
  const here = s.task.k === 'docked' ? h.st.stations[s.task.station] : undefined;
  const from: Station = here ?? ({ id: '_ship', pos: s.pos } as Station);
  return Object.values(h.st.stations)
    .filter(st => canRepairAt(st, s.owner) && h.canDock(st, s.owner) && berthFits(st, econOf(s).berth))
    .map(st => ({ st, score: st.id === here?.id ? 0 : routeScore(h, from, st, maxRisk) }))
    .filter(x => Number.isFinite(x.score)).sort((a, b) => a.score - b.score || a.st.id.localeCompare(b.st.id))[0]?.st;
}

/** every 10 s with the logistics planners: start the repairs the policy allows */
export function planAutoRepairs(h: WorldSim) {
  if (!growthOn(h.st)) return;
  for (const co of Object.values(h.st.companies)) {
    const p = co.kind === 'player' ? co.procurement?.repair : undefined;
    if (!p?.enabled) continue;
    for (const s of Object.values(h.st.ships)) {
      if (s.owner !== co.id) continue;
      if (s.repairAt) { if (!covered(h, s) || s.hp >= HAULER_MIN_HP) delete s.repairAt; continue; }
      if (s.hp >= HAULER_MIN_HP || !covered(h, s) || s.logisticsJob || s.state === 'battle') { if (p.status?.[s.id] && s.hp >= HAULER_MIN_HP && h.time - p.status[s.id].t > 600) delete p.status[s.id]; continue; }
      // a mining hauler goes only when its hold is empty, so the fleet's ore is never carried off to a repair yard
      if (h.opOf(h.st.groups[s.groupId]).k === 'mine' && cargoSum(s.cargo) > EPS) { note(h, p, s, '손상 — 화물 하역 후 자동 수리'); continue; }
      const docked = s.state === 'docked' && s.task.k === 'docked' ? h.st.stations[s.task.station] : undefined;
      if (docked && canRepairAt(docked, s.owner)) { repairHere(h, s, p); continue; }
      const q = repairQuote(h.st, s, co), why = budgetProblem(h, s.owner, p, q.cost);
      if (why) { note(h, p, s, `손상(내구 ${Math.round(s.hp * 100)}%) — 자동 수리 보류: ${why}. 화물·작업 보존`); continue; }
      const st = repairStation(h, s);
      if (!st) { note(h, p, s, `손상(내구 ${Math.round(s.hp * 100)}%) — 위험 제한 안에서 갈 수 있는 수리 정거장 없음. 화물·작업 보존`); continue; }
      s.repairAt = { station: st.id, since: h.time, quote: q.cost };
      note(h, p, s, `수리하러 ${st.name}(으)로 이동 — 예상 ${q.cost.toLocaleString()} cr`);
    }
  }
}

/** per tick for a ship with an approved repair trip; true while the trip controls the ship */
export function stepAutoRepair(h: WorldSim, s: WShip, dt: number, speed: number): boolean {
  const r = s.repairAt; if (!r) return false;
  const p = h.st.companies[s.owner]?.procurement?.repair, st = h.st.stations[r.station];
  if (!p?.enabled || !st || !canRepairAt(st, s.owner) || !h.canDock(st, s.owner) || s.logisticsJob || s.hp >= HAULER_MIN_HP) { delete s.repairAt; return false; }
  if (!h.goDock(s, st, dt, speed)) return true;
  if (!repairHere(h, s, p)) delete s.repairAt;   // limits changed on the way: keep the ship and its cargo, show why
  return false;
}
/** a covered damaged ship that is docked at a repair station right now is repaired at once (within the limits) */
export function autoRepairDocked(h: WorldSim, s: WShip): boolean {
  const p = h.st.companies[s.owner]?.procurement?.repair;
  if (!p?.enabled || s.hp >= HAULER_MIN_HP || !covered(h, s) || s.state !== 'docked' || s.task.k !== 'docked') return false;
  const st = h.st.stations[s.task.station];
  return !!st && canRepairAt(st, s.owner) && repairHere(h, s, p);
}
