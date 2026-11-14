// P12.5: the single answer to "may this ship haul for the company right now, and if not, why not".
// Legacy worlds keep the explicit `logisticsPool` opt-in; logisticsV worlds use every idle cargo ship.
import type { WorldSim } from './sim';
import type { WShip, WorldState } from './types';
import { cargoSum } from './types';
import { econOf } from './hullops';
import { techFx } from './industry';

/** below this hull integrity a hauler is not sent on new automatic work (it is shown as damaged) */
export const HAULER_MIN_HP = 0.4;
const EPS = 1e-9;
export const autoLogistics = (st: Pick<WorldState, 'logisticsV'> | undefined) => st?.logisticsV === 1;

/** a member of the company's automatic hauler pool (not necessarily available this moment) */
export function poolMember(st: WorldState, s: WShip): boolean {
  if (!autoLogistics(st)) return !!s.logisticsPool;
  if (st.companies[s.owner]?.kind !== 'player' || s.logisticsExcluded || s.hp <= 0) return false;
  const ec = econOf(s);
  if (ec.cargo <= 0 || s.classId === 'miner' || s.classId === 'constructor') return false;
  // warships haul only when the player explicitly allowed it for that ship
  return !ec.military || !!s.logisticsPool;
}

export const cargoRoom = (st: WorldState, s: WShip) => Math.max(0, econOf(s).cargo * techFx(st.companies[s.owner]?.tech).cargoMul - cargoSum(s.cargo));

export type HaulerState = { ok: true } | { ok: false; code: string; why: string };
type Host = Pick<WorldSim, 'st' | 'opOf'>;
/**
 * Why a pool member cannot take new automatic work now. `cargo` false skips the free-hold check
 * (untracked cargo is stowed first). A ship already on a shipment is reported as `busy`.
 */
export function haulerAvailability(h: Host, s: WShip, cargo = true): HaulerState {
  if (!poolMember(h.st, s)) return { ok: false, code: 'excluded', why: s.logisticsExcluded ? '자동 물류에서 제외됨' : '자동 물류 대상 아님' };
  if (s.logisticsJob) return { ok: false, code: 'busy', why: '운송 중' };
  if (s.state === 'building') return { ok: false, code: 'building', why: '건조 중' };
  if (s.listed) return { ok: false, code: 'listed', why: '거래소 매물' };
  if (s.reserve) return { ok: false, code: 'reserve', why: '예비역' };
  if (s.recover) return { ok: false, code: 'recover', why: '자율 재구성 중' };
  const g = h.st.groups[s.groupId];
  if (!g) return { ok: false, code: 'group', why: '편대 없음' };
  const op = h.opOf(g);
  if (op.k !== 'idle') return { ok: false, code: 'manual', why: `직접 명령 수행 중 (${op.k}) — 대기 명령 시 자동 물류 복귀` };
  if (g.fleeing) return { ok: false, code: 'flee', why: '적대 세력 회피 중' };
  // P13.1: a fleet picking up wreckage, or carrying recovered goods to a warehouse, is not free for shipments
  if (g.salv) return { ok: false, code: 'salvage', why: '현장 인양 중' };
  if (s.salvaged && Object.keys(s.salvaged).some(k => (s.cargo[k] ?? 0) > 1e-9)) return { ok: false, code: 'salvage', why: '인양물 적재 — 하역 대기' };
  if (s.state === 'battle') return { ok: false, code: 'battle', why: '교전 중' };
  if (s.cargoWork) return { ok: false, code: 'cargo_work', why: '화물 작업 중' };
  if (autoLogistics(h.st)) {
    if (s.hp < HAULER_MIN_HP) return { ok: false, code: 'damaged', why: `손상 — 수리 필요 (내구 ${Math.round(s.hp * 100)}%)` };
    if (h.st.companies[s.owner]?.autoLogistics === false) return { ok: false, code: 'off', why: '자동 물류 꺼짐' };
  }
  if (cargo && cargoRoom(h.st, s) <= EPS) return { ok: false, code: 'full', why: '화물칸 가득' };
  return { ok: true };
}
