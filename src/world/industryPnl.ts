// Business attribution of cash movements and separately allocated operating charges.
import type { Company, WGroup, WShip, WorldState } from './types';
import { opsOf } from './operations';

export type Activity = 'mining' | 'salvage' | 'repair' | 'logistics' | 'military' | 'other' | 'unallocated';
export const ACTIVITIES: Activity[] = ['mining', 'salvage', 'repair', 'logistics', 'military', 'other', 'unallocated'];
export const ACTIVITY_NAME: Record<Activity, string> = {
  mining: '채광', salvage: '인양', repair: '수리업', logistics: '물류·수송', military: '군사·호위', other: '기타·대기', unallocated: '미배분',
};
type Amounts = Partial<Record<Activity, number>>;
export interface ActHour {
  h: number; v?: 1;
  inc: Amounts; exp: Amounts;
  sales?: Amounts;
  ships?: Amounts;
  operating?: Amounts;
  supplies?: Amounts;
}

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
  if (s.classId === 'hauler' && k === 'mine' && s.task.k !== 'mine') return 'logistics';
  return (k ? OP_ACT[k] : undefined) ?? (s.task?.k === 'mine' ? 'mining' : 'other');
}

const hourOf = (t: number) => Math.floor(t / 3600);
const EPS = 1e-9;

/** Record an attributed credit movement. Running charges are allocated separately. */
export function bookAct(st: WorldState, time: number, owner: string, act: Activity, delta: number, sale = false) {
  const co: Company | undefined = st.companies[owner];
  if (!co || co.kind !== 'player' || Math.abs(delta) < EPS) return;
  const b = bucket(co, time);
  if (delta > 0) {
    b.inc[act] = (b.inc[act] ?? 0) + delta;
    if (sale) { const sales = (b.sales ??= {}); sales[act] = (sales[act] ?? 0) + delta; }
  } else b.exp[act] = (b.exp[act] ?? 0) - delta;
}
/** Accrue assessed fleet operating charges and the reference value of supplies requested. */
export function allocateRunningCost(time: number, co: Company, act: Activity, hours: number, operating: number, supplies: number) {
  const b = bucket(co, time);
  const o = (b.operating ??= {}), s = (b.supplies ??= {}), n = (b.ships ??= {});
  o[act] = (o[act] ?? 0) + operating;
  s[act] = (s[act] ?? 0) + supplies;
  n[act] = (n[act] ?? 0) + hours;
}
function bucket(co: Company, time: number): ActHour {
  const ops = opsOf(co), hr = hourOf(time), list = (ops.act ??= []);
  let b = list.at(-1);
  if (!b || b.h !== hr || !b.v) { b = { h: hr, v: 1, inc: {}, exp: {} }; list.push(b); while (list.length && list[0].h <= hr - 48) list.shift(); }
  return b;
}

export interface ActRow {
  act: Activity; name: string; inc: number; exp: number; sales: number; operating: number; supplies: number; net: number; ships: number;
}

export function pnlRows(co: Company | undefined, now: number, hours = 24): ActRow[] {
  const from = hourOf(now) - hours + 1, ops = co?.ops;
  const list = (ops?.act ?? []).filter(b => b.v === 1 && b.h >= from);
  const start = Math.max(from, list[0]?.h ?? hourOf(now), (co?.createdAt ?? 0) / 3600) * 3600;
  const span = Math.max(1, now - start) / 3600;
  const rows = ACTIVITIES.map(act => {
    const row: ActRow = { act, name: ACTIVITY_NAME[act], inc: 0, exp: 0, sales: 0, operating: 0, supplies: 0, net: 0, ships: 0 };
    for (const b of list) {
      row.inc += b.inc[act] ?? 0;
      row.exp += b.exp[act] ?? 0;
      row.sales += b.sales?.[act] ?? 0;
      row.operating += b.operating?.[act] ?? 0; row.supplies += b.supplies?.[act] ?? 0;
      row.ships += b.ships?.[act] ?? 0;
    }
    row.ships /= span;
    return row;
  });
  // The cash journal also includes payments of accrued bills, capital expenses and miscellaneous income.
  // Earlier activity buckets stay in the save, but cannot prove either production origin or the cash/cost split.
  const cash = (ops?.ledger ?? []).filter(b => b.h >= from);
  const residual = rows.find(r => r.act === 'unallocated')!;
  for (const k of ['inc', 'exp'] as const) {
    const actual = cash.reduce((sum, b) => sum + Object.values(b[k]).reduce((a, v) => a + v, 0), 0);
    residual[k] += Math.max(0, actual - rows.reduce((sum, row) => sum + row[k], 0));
  }
  const marketSales = cash.reduce((sum, b) => sum + (b.inc.sales ?? 0), 0);
  residual.sales += Math.max(0, marketSales - rows.reduce((sum, row) => sum + row.sales, 0));
  for (const row of rows) row.net = row.inc - row.exp - row.operating;
  return rows.filter(r => r.inc > EPS || r.exp > EPS || r.operating > EPS || r.supplies > EPS || r.ships > EPS);
}
