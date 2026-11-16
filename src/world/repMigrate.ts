// P14.0: explicit, idempotent migration of an existing save to the reputation rules (repV).
//
// Policy (docs/P14_0_REPUTATION.md §8):
//   - only growth worlds (contentV ≥ 3); legacy worlds are never converted
//   - nothing is deleted: ships, blueprints, credits, cargo, stats stay exactly as they are
//   - company reputation keeps its order: the legacy value is kept in repx.legacy and mapped monotonically
//     to 0..100 (mapLegacy), the same map that turns legacy thresholds into new ones — so a company that met a
//     legacy threshold still meets it
//   - faction trust (co.standing) is kept as it is; the common reputation is never copied into it
//   - purchase rights held under the old rule that the new rule would refuse (a faction sale gated by the
//     common reputation, now by that faction's trust) are kept for REP.graceSec of game time (repx.grand)
import type { Company, WorldState } from './types';
import { CONTENT } from '../content/registry';
import { growthOn, hullSale, yardHulls } from './hullops';
import { offersAt } from './blueprints';
import { enableRepV, repOn } from './reputation';

/** what a company could buy under the legacy rule right now (money aside): `bp:<id>` and `hull:<id>` keys */
export function legacyRights(w: WorldState, co: Company): string[] {
  if (repOn(w)) return [];
  const keys = new Set<string>();
  for (const st of Object.values(w.stations)) {
    if (!st.public) continue;
    for (const o of offersAt(w, st, co)) if (!o.why || o.why.startsWith('자금 부족')) if (o.src.kind === 'faction' || o.src.kind === 'commercial') keys.add(`bp:${o.bp.id}`);
    for (const h of yardHulls(st)) { const sale = hullSale(h); if (sale && co.rep >= (sale.rep ?? 0) && (sale.rep ?? 0) > 0) keys.add(`hull:${h}`); }
  }
  return [...keys].filter(k => !k.startsWith('bp:') || CONTENT.blueprints[k.slice(3)]);
}

export interface RepMigration { ok: boolean; why?: string; companies?: number; mapped?: Record<string, [number, number]>; grace?: Record<string, number> }
export function migrateRep(w: WorldState): RepMigration {
  if (repOn(w)) return { ok: true, why: '이미 적용됨 (변경 없음)' };
  if (!growthOn(w)) return { ok: false, why: '레거시 월드(contentV < 3)에는 적용하지 않습니다' };
  const rights = new Map<string, string[]>();
  for (const co of Object.values(w.companies)) if (co.kind === 'player') rights.set(co.id, legacyRights(w, co));
  const r = enableRepV(w, { migrate: true, grant: co => rights.get(co.id) ?? [] })!;
  const grace: Record<string, number> = {};
  for (const [id, k] of rights) grace[id] = k.length;
  return { ok: true, companies: r.companies, mapped: r.mapped, grace };
}
