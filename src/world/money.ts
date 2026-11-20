// Growth-only fixed-point obligations. Integer values are decimal strings in JSON so they remain
// exact beyond Number.MAX_SAFE_INTEGER. Existing numeric fields are compatibility/UI projections.
import type { Company, UpkeepState, WorldState } from './types';
import { emit, inTransaction, afterTransaction } from './observe';
export const CREDIT_UNIT = 1_000_000_000n; // 1 nano-credit
export function moneyUnits(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error('유효하지 않은 금액');
  const negative = value < 0, n = Math.abs(value);
  const text = n < 1e21 ? n.toFixed(9) : n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
  const [whole, fraction = ''] = text.split('.');
  const units = BigInt(whole) * CREDIT_UNIT + BigInt(fraction.padEnd(9, '0'));
  return negative ? -units : units;
}
export const moneyNumber = (units: bigint) => Number(units / CREDIT_UNIT) + Number(units % CREDIT_UNIT) / Number(CREDIT_UNIT);
export const moneyText = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 9 });
export const upkeepAccount = (co: Company): UpkeepState => (co.upkeep ??= { debt: 0, stage: 0, since: 0, acc: 0, supplies: {}, last: 0, total: { credits: 0, supplies: 0, paid: 0 } });
export function debtUnits(u: UpkeepState): bigint {
  if (u.debtU === undefined || moneyNumber(BigInt(u.debtU)) !== u.debt) {
    u.debtU = moneyUnits(Math.max(0, u.debt)).toString();
    u.debt = moneyNumber(BigInt(u.debtU));
    if (u.rent && BigInt(u.rent.debtU) > BigInt(u.debtU)) u.rent.debtU = u.debtU;
  }
  return BigInt(u.debtU);
}
export function addDebt(co: Company, units: bigint, at: number) {
  if (units <= 0n) return;
  const u = upkeepAccount(co), before = debtUnits(u);
  u.debtU = (before + units).toString(); u.debt = moneyNumber(before + units);
  if (u.debtSince === undefined) u.debtSince = u.since > 0 ? u.since : at;
  u.since = u.debtSince;
}
export function chargeTotals(co: Company, credit: bigint, supply = 0n) {
  const u = upkeepAccount(co);
  u.creditChargesU = (BigInt(u.creditChargesU ?? moneyUnits(u.total.credits).toString()) + credit).toString();
  u.supplyChargesU = (BigInt(u.supplyChargesU ?? moneyUnits(u.total.supplies).toString()) + supply).toString();
  u.total.credits = moneyNumber(BigInt(u.creditChargesU)); u.total.supplies = moneyNumber(BigInt(u.supplyChargesU));
}
export function paidTotals(co: Company, units: bigint) {
  const u = upkeepAccount(co);
  u.paidU = (BigInt(u.paidU ?? moneyUnits(u.total.paid).toString()) + units).toString();
  u.paymentWindowU = (BigInt(u.paymentWindowU ?? '0') + units).toString();
  u.total.paid = moneyNumber(BigInt(u.paidU));
}
/** Rent arrears take priority within outstanding obligations. Never overdraw the wallet. */
export function payDebt(w: WorldState, co: Company, source: 'sale' | 'manual' | 'settlement' | 'rent', limit?: number, rentOnly = false): number {
  if ((w.contentV ?? 0) < 3 || co.kind !== 'player') return 0;
  const u = upkeepAccount(co), owed = debtUnits(u), r = u.rent;
  if (owed <= 0n || (rentOnly && BigInt(r?.debtU ?? '0') <= 0n)) return 0;
  const available = moneyUnits(Math.max(0, co.credits));
  let amount = owed < available ? owed : available;
  if (limit !== undefined) { const cap = moneyUnits(Math.max(0, limit)); if (amount > cap) amount = cap; }
  if (rentOnly && amount > BigInt(r?.debtU ?? '0')) amount = BigInt(r?.debtU ?? '0');
  if (amount <= 0n) return 0;
  const before = co.credits;
  co.credits = moneyNumber(available - amount);
  const remaining = owed - amount;
  u.debtU = remaining.toString(); u.debt = moneyNumber(remaining);
  if (r) {
    const rentPaid = amount < BigInt(r.debtU) ? amount : BigInt(r.debtU);
    r.debtU = (BigInt(r.debtU) - rentPaid).toString();
    r.paidU = (BigInt(r.paidU) + rentPaid).toString();
    if (BigInt(r.debtU) === 0n) delete r.sinceMs;
  }
  paidTotals(co, amount);
  u.lastPayment = { t: w.time, units: amount.toString(), source };
  if (remaining === 0n) { u.stage = 0; u.since = 0; delete u.debtSince; }
  else if (u.debt <= 1) u.stage = 0; // preserve the existing warning threshold, never waive the debt
  // A surrounding transaction records its full cash legs. Outside one, this known debit is exact.
  if (!inTransaction(w)) emit(w, { kind: 'currency.destroy', reason: source === 'rent' ? 'warehouse_rent_payment' : 'arrears_payment', amount: before - co.credits, from: `co:${co.id}`, company: co.id });
  return moneyNumber(amount);
}
export function payFromSale(w: WorldState, co: Company, proceeds: number, booked?: (paid: number) => void) {
  if ((w.contentV ?? 0) < 3 || proceeds <= 0 || !co.upkeep?.debt) return;
  // Wait until the gross transfer has been observed, so collection cannot net away trade volume.
  afterTransaction(w, () => { const paid = payDebt(w, co, 'sale', proceeds); if (paid > 0) booked?.(paid); });
}
