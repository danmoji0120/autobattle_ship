// Manual hull repair: one quote for the server charge and the client button.
//
//   cost = round((1 − hp) × hull worth × REPAIR_RATE ÷ repair research multiplier)
//
// Hull worth depends on the content version (growth worlds price hulls from the hull catalogue,
// older worlds from the class economy), so the client must never price it from ECON on its own.
// This is the *manual* repair of hull damage (hp). Wear maintenance on docking (upkeep.ts
// maintainOnDock) and running costs are separate charges and are not part of this quote.
import type { Company, Station, WShip, WorldState } from './types';
import { shipWorth } from './hullops';
import { techFx } from './industry';
import { stationSize } from './stations';
import { stationPower } from './production';

export const REPAIR_RATE = 0.3;

export interface RepairQuote {
  /** credits charged for a full repair (0 when nothing to repair) */
  cost: number;
  /** null when the repair can be done right now; otherwise the exact reason */
  why: string | null;
  /** inputs, for the explanation shown next to the price */
  damage: number;
  worth: number;
  repairMul: number;
  station?: string;
}

const hasModule = (st: Station, kind: string) => st.modules.some(m => m.kind === kind && m.built);
export const canRepairAt = (st: Station, company: string) => !!st.services.repair || (st.owner === company && hasModule(st, 'repair'));

/** the price and the conditions of repairing a ship to full hull, exactly as the server charges it */
export function repairQuote(w: Pick<WorldState, 'contentV' | 'stations'>, s: WShip, co: Pick<Company, 'id' | 'credits' | 'tech'> | undefined): RepairQuote {
  const repairMul = techFx(co?.tech).repairMul;
  const worth = shipWorth(w, s), damage = Math.max(0, 1 - s.hp);
  const cost = Math.round(damage * worth * REPAIR_RATE / repairMul);
  const q: RepairQuote = { cost, why: null, damage, worth, repairMul };
  if (!co || s.owner !== co.id || s.state !== 'docked' || s.task.k !== 'docked') return { ...q, why: '정박 중인 함선만 수리 가능' };
  const st = w.stations[s.task.station];
  q.station = st?.id;
  if (!st || !canRepairAt(st, co.id)) return { ...q, why: '수리 시설 없음' };
  if (stationSize(st) && stationPower(st).factor < 1) return { ...q, why: '전력 부족 — 발전시설을 증설한 뒤 수리하세요' };
  if (damage <= 0) return { ...q, why: '손상 없음' };
  if (co.credits < cost) return { ...q, why: `자금 부족 — 수리비 ${cost.toLocaleString()} cr, 보유 ${Math.floor(co.credits).toLocaleString()} cr` };
  return q;
}
