// P17.4a (AUD-03): deliver a taken delivery contract straight from the company's own store at the contract station.
//
// Before this, the only way to deliver was to unload a ship's cargo there — stock already sitting in the store had
// to be loaded onto a ship and unloaded again. Direct delivery uses the same settlement as ship unloading
// (progress → `completeContract`, which pays once and sets `done`), and only spends stock nothing else needs:
// the store's protection floor (minimum stock, station stockpile goals, construction / builds / production),
// units already promised to outbound shipments, and company-scope stockpile targets are left alone.
//
// Idempotency: the client sends `upTo`, the contract progress it wants to reach. Replaying the same command after it
// applied delivers nothing more (progress already ≥ upTo), so a resent click never takes stock twice; a finished
// contract refuses outright, so the reward is never paid twice.
import type { Contract, Station } from './types';
import { qty, takec } from './types';
import { emit } from './observe';
import { sellableStock, companySaleCap, stockFloor } from './operations';
import { RES_NAME } from './data';
import type { WorldSim } from './sim';

export interface DeliveryQuote {
  /** units still owed */ remaining: number;
  /** units in the store */ stored: number;
  /** units kept by protections / promised shipments / company targets */ held: number;
  /** units that may be delivered now */ usable: number;
  /** why nothing (or less than remaining) can be delivered */ why: string | null;
}

/** which contracts take direct delivery: ordinary delivery contracts only (salvage contracts need the recovered goods) */
export const directDeliverable = (k: Contract) => k.kind === 'delivery' && !!k.res && (k.amount ?? 0) > 0;

export function deliveryQuote(h: Pick<WorldSim, 'st'>, company: string, k: Contract): DeliveryQuote {
  const st = h.st.stations[k.stationId], res = k.res ?? '';
  const remaining = Math.max(0, (k.amount ?? 0) - k.progress);
  const stored = st ? qty(st.storage[company], res) : 0;
  if (!st) return { remaining, stored: 0, held: 0, usable: 0, why: '정거장 없음' };
  const usable = Math.max(0, Math.floor(Math.min(sellableStock(h, company, st, res), companySaleCap(h, company, res)) + 1e-9));
  const held = Math.max(0, stored - usable);
  let why: string | null = null;
  if (stored < 1) why = `${st.name} 보관함에 ${RES_NAME[res] ?? res} 없음`;
  else if (usable < 1) why = `보관 ${Math.floor(stored)} 전량이 보호·예약 중 (최소 재고·비축 목표·생산/건조 예약·출고 예정 ${Math.ceil(stockFloor(h, company, st, res))}+)`;
  else if (usable < remaining) why = `보호·예약분 ${Math.ceil(held)} 제외 — ${Math.floor(usable)}만 납품 가능`;
  return { remaining, stored, held, usable, why };
}

/** the command: returns an error text or null. `upTo` = contract progress to reach (idempotent); default = complete it */
export function deliverFromStore(h: WorldSim, company: string, contractId: string, upTo?: number): string | null {
  const k = h.st.contracts[contractId];
  if (!k) return '계약 없음';
  if (k.takenBy !== company) return '수주한 계약이 아님';
  if (k.done) return '이미 종료된 계약';
  if (!directDeliverable(k)) return k.kind === 'salvage' ? '인양 계약은 지정 잔해에서 회수한 물품만 납품할 수 있음' : '납품 계약이 아님';
  if (h.time > k.expires) return '기한 만료';
  const goal = Math.min(k.amount ?? 0, upTo ?? Infinity);
  const want = goal - k.progress;
  if (want <= 1e-9) return null;   // already there (a replayed command): nothing to do
  const q = deliveryQuote(h, company, k);
  const n = Math.min(want, q.usable);
  if (n <= 1e-9) return q.why ?? '납품 가능한 재고 없음';
  const st = h.st.stations[k.stationId] as Station;
  const taken = takec(st.storage[company], k.res!, n);
  emit(h.st, { kind: 'consume', reason: 'contract_delivery', amount: taken, company, station: st.id, item: k.res! });
  k.progress += taken;
  h.ev('info', `${k.title}: 보관 재고 ${Math.round(taken)} 직접 납품 (${Math.round(k.progress)}/${k.amount})`, { company, pos: st.pos });
  if (k.progress >= (k.amount ?? 0) - 1e-9) h.completeContract(k);
  return null;
}
