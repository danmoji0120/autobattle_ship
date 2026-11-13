// Econ migration e0 → e1: moves an EXISTING c4 save onto value-chain pricing (econChain.ts). Never runs
// by itself: the server applies it only with ECON_MIGRATE=apply (node.ts, inside the atomic backup →
// transform → verify → write transaction), and scripts/econ/migrate-save.ts applies it to a dev save copy.
//
// What it changes: ONLY the `base` of goods in public NPC markets, plus `st.econ` (rule and policy).
// What it keeps:   market stock and target stock, NPC funds, every company's credits, storage, ship
//                  cargo, reservations, production/construction/yard queues (running jobs keep the output
//                  they started with), research, goals, approvals and work budgets, ships and equipment.
// Prices are not assets, so the asset census (migrate.ts) must be identical before and after.
// Rollback: `rollbackEconChain` restores every base recorded in st.econLog and removes st.econ (the
// rule then reverts to the world's previous prices). Limits: trades made at the new prices stay made.
import type { WorldState } from './types';
import { PROFILES } from './economy';
import { chainOn, chainPriced, chainBase, newChainState, type EqPolicy } from './econChain';

export const ECON_VERSION = 1;

export interface EconMigrationRecord {
  v: number; at: number; how: 'migrated' | 'rolled-back';
  /** station → good → base before the migration (exactly what rollback restores) */
  prev: Record<string, Record<string, number>>;
  changed: number;
}
export interface EconMigrationReport { ok: boolean; why?: string; changed: number; markets: number; goods: number; skipped: string[] }

const multOf = (id: string) => PROFILES[id]?.mult ?? 1;

/** may this save move to chain pricing? (c4 growth economy only; c0–c3 saves are refused) */
export function econEligible(st: WorldState): string | null {
  if (chainOn(st)) return '이미 가치 사슬 가격 적용됨';
  if ((st.contentV ?? 0) < 4) return `콘텐츠 버전 c${st.contentV ?? 0} — c4 저장만 이관할 수 있음`;
  if (!Object.values(st.stations).some(s => s.public && s.market)) return '공개 시장 없음';
  return null;
}

/** Idempotent. Computes every new base first and validates it; only then writes (all or nothing). */
export function migrateEconChain(st: WorldState, opts: { eq?: EqPolicy; alloyDirect?: number } = {}): EconMigrationReport {
  const no = econEligible(st);
  if (no) return { ok: chainOn(st), why: no, changed: 0, markets: 0, goods: 0, skipped: [] };
  const econ = newChainState('migrated', st.time, opts);
  const probe = { econ };
  const plan: [Record<string, { base: number }>, string, number][] = [];
  const prev: EconMigrationRecord['prev'] = {};
  const skipped: string[] = [];
  let markets = 0, goods = 0;
  for (const x of Object.values(st.stations)) {
    if (!x.public || !x.market) continue;
    markets++;
    for (const [k, e] of Object.entries(x.market)) {
      if (!chainPriced(k)) { if (!k.startsWith('bp:')) skipped.push(`${x.id}:${k}`); continue; }
      const base = chainBase(probe, k, multOf(x.id));
      if (!Number.isFinite(base) || base <= 0) throw new Error(`econ 이관 중단: ${x.id}:${k} 기준가 계산 실패 (${base}) — 저장은 변경되지 않음`);
      goods++;
      if (base === e.base) continue;
      (prev[x.id] ??= {})[k] = e.base;
      plan.push([x.market as Record<string, { base: number }>, k, base]);
    }
  }
  const acc: Record<string, [number, number]> = {};
  for (const x of Object.values(st.stations)) if (x.public && x.market) for (const [k, e] of Object.entries(x.market)) if (chainPriced(k)) { const a = (acc[k] ??= [0, 0]); a[0] += e.base; a[1]++; }
  econ.before = Object.fromEntries(Object.entries(acc).map(([k, [sum, n]]) => [k, Math.round(sum / n * 10) / 10]));
  for (const [m, k, base] of plan) m[k].base = base;
  st.econ = econ;
  (st.econLog ??= []).push({ v: ECON_VERSION, at: st.time, how: 'migrated', prev, changed: plan.length });
  return { ok: true, changed: plan.length, markets, goods, skipped };
}

/** Undo the last econ migration on this save: restore recorded bases, drop the rule. */
export function rollbackEconChain(st: WorldState): { ok: boolean; why?: string; restored: number } {
  const rec = [...(st.econLog ?? [])].reverse().find(r => r.how === 'migrated');
  if (!chainOn(st) || !rec) return { ok: false, why: '되돌릴 econ 이관 기록 없음', restored: 0 };
  let restored = 0;
  for (const [sid, goods] of Object.entries(rec.prev)) {
    const m = st.stations[sid]?.market; if (!m) continue;
    for (const [k, base] of Object.entries(goods)) if (m[k]) { m[k].base = base; restored++; }
  }
  Reflect.deleteProperty(st, 'econ');
  st.econLog!.push({ v: 0, at: st.time, how: 'rolled-back', prev: {}, changed: restored });
  return { ok: true, restored };
}

/** a NEW world (WorldSim.create with econ: 'chain'): price every public market by the chain rule */
export function enableEconChainNew(st: WorldState, opts: { eq?: EqPolicy; alloyDirect?: number } = {}): number {
  st.econ = newChainState('new', st.time, opts);
  let n = 0;
  for (const x of Object.values(st.stations)) {
    if (!x.public || !x.market) continue;
    for (const [k, e] of Object.entries(x.market)) {
      if (!chainPriced(k)) continue;
      const base = chainBase(st as { econ: NonNullable<WorldState['econ']> }, k, multOf(x.id));
      if (base !== e.base) { e.base = base; n++; }
    }
  }
  return n;
}
