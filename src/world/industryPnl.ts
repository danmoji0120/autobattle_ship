// P17.4f F1: per-industry profit and loss from real money only.
//
// The company ledger (operations.book) tells what the money was spent on (upkeep, repair, sales …) but not which
// business earned or burned it, so "is my mining fleet paying for itself" had no answer. This ledger re-books the same
// real movements by the *activity* of the ship involved:
//   • running cost — each ship's hourly credits + dock fee (the same figure upkeep accrues, overhead included) and its
//     consumables valued at their base price, booked to the activity the ship is doing at that moment;
//   • sales — a ship's own unload-and-sell is income of its activity (a miner selling its ore → mining); a sale from
//     the company's storage is "stock sale" (the goods' origin is no longer known once they are pooled);
//   • repair — the repair-business fee is repair income; a field repair or a paid repair is a cost of the patient's
//     activity; an automatic hauler recovery repair is a logistics cost.
// Nothing here moves credits: it only records. Buckets are hourly and the last 48 are kept, like the cash ledger.
import type { Company, WGroup, WShip, WorldState } from './types';
import { opsOf } from './operations';

export type Activity = 'mining' | 'salvage' | 'repair' | 'logistics' | 'military' | 'other' | 'stock';
export const ACTIVITIES: Activity[] = ['mining', 'salvage', 'repair', 'logistics', 'military', 'other', 'stock'];
export const ACTIVITY_NAME: Record<Activity, string> = {
  mining: '채광', salvage: '인양', repair: '수리업', logistics: '물류·수송', military: '군사·호위', other: '기타·대기', stock: '보관 재고 판매',
};
export interface ActHour { h: number; inc: Partial<Record<Activity, number>>; exp: Partial<Record<Activity, number>>; ships?: Partial<Record<Activity, number>> }

const OP_ACT: Record<string, Activity> = {
  mine: 'mining', survey: 'mining',
  salvage: 'salvage', salvzone: 'salvage', recover: 'salvage',
  repairbiz: 'repair', repairzone: 'repair', fieldrepair: 'repair',
  haul: 'logistics',
  patrol: 'military', escort: 'military', attack: 'military', defend: 'military', intercept: 'military', blockade: 'military', harass: 'military', amove: 'military',
};

/** the group's effective op (a sub-group follows its parent unless it overrides) */
function groupOp(st: WorldState, g: WGroup | undefined): string | undefined {
  let cur = g;
  while (cur && !cur.override && cur.parentId && st.groups[cur.parentId]) cur = st.groups[cur.parentId];
  return (cur ?? g)?.op?.k;
}

/** what business this ship is serving right now */
export function activityOf(st: WorldState, s: WShip): Activity {
  if (s.logisticsJob) return 'logistics';
  const k = groupOp(st, st.groups[s.groupId]);
  return (k ? OP_ACT[k] : undefined) ?? (s.task?.k === 'mine' ? 'mining' : 'other');
}

const hourOf = (t: number) => Math.floor(t / 3600);
const EPS = 1e-9;

/** record a real credit movement (positive income, negative cost) under an activity; `ship` counts a ship-hour */
export function bookAct(st: WorldState, time: number, owner: string, act: Activity, delta: number) {
  const co: Company | undefined = st.companies[owner];
  if (!co || co.kind !== 'player' || Math.abs(delta) < EPS) return;
  const b = bucket(co, time);
  if (delta > 0) b.inc[act] = (b.inc[act] ?? 0) + delta; else b.exp[act] = (b.exp[act] ?? 0) - delta;
}
/** a ship spent `hours` on `act` (for the per-activity ship count) */
export function countShip(st: WorldState, time: number, owner: string, act: Activity, hours: number) {
  const co = st.companies[owner];
  if (!co || co.kind !== 'player' || hours <= 0) return;
  const b = bucket(co, time); (b.ships ??= {})[act] = (b.ships[act] ?? 0) + hours;
}
function bucket(co: Company, time: number): ActHour {
  const ops = opsOf(co), hr = hourOf(time), list = (ops.act ??= []);
  let b = list.at(-1);
  if (!b || b.h !== hr) { b = { h: hr, inc: {}, exp: {} }; list.push(b); if (list.length > 48) list.splice(0, list.length - 48); }
  return b;
}

export interface ActRow { act: Activity; name: string; inc: number; exp: number; net: number; ships: number }
/** the last `hours` full hours plus the current one, summed per activity (ships = average ships on it) */
export function pnlRows(co: Company | undefined, now: number, hours = 24): ActRow[] {
  const from = hourOf(now) - hours + 1, list = co?.ops?.act ?? [];
  // average over the recorded part of the window (a new company has less than `hours` of history)
  const start = Math.max(from, list.find(b => b.h >= from)?.h ?? hourOf(now)) * 3600;
  const span = Math.max(1, now - start) / 3600;
  const acc: Record<string, ActRow> = {};
  for (const b of list) if (b.h >= from) for (const a of ACTIVITIES) {
    const r = (acc[a] ??= { act: a, name: ACTIVITY_NAME[a], inc: 0, exp: 0, net: 0, ships: 0 });
    r.inc += b.inc[a] ?? 0; r.exp += b.exp[a] ?? 0; r.ships += (b.ships?.[a] ?? 0);
  }
  return ACTIVITIES.map(a => acc[a]).filter((r): r is ActRow => !!r && (r.inc > EPS || r.exp > EPS || r.ships > EPS))
    .map(r => ({ ...r, net: r.inc - r.exp, ships: r.ships / span }));
}
