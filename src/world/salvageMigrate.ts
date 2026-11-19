// P13.1: switch a world to physical battlefield wrecks & salvage. Idempotent; never creates, destroys or
// moves goods or blueprints. New worlds get it at creation (WorldSim.create { salvage: 'p131' }). An
// existing save is converted only by an explicit, separately approved step — scripts/salvage/
// p131-convert-check.ts runs this on a copy and checks that nothing of value changed.
//   • random derelict sites are retired (sites removed; what a company already recovered stays with it);
//   • fleets on a derelict order (salvage) stop and stand by; a derelict survey stops unless the world has
//     fog, where the survey stays as the field-intel scan;
//   • legacy battle-debris fields stay until they expire (they are mined, not salvaged — nothing new is made);
//   • pendingLoot (remote recovery waiting for storage room) is kept and keeps being delivered;
//   • P11 / P12 / P12.5 are switched on as P13.1 requires (P12.5 through its own conversion).
import type { WorldSim } from './sim';
import { enableAutoLogistics, type AutoLogisticsConversion } from './logisticsMigrate';

export interface SalvageConversion {
  already: boolean;
  sitesRetired: number;
  /** derelict sites some company had found but not yet salvaged (their contents never existed as goods) */
  sitesKnownUnsalvaged: number;
  groupsStopped: { group: string; op: string }[];
  debrisFieldsKept: string[];
  pendingLootKept: string[];
  logistics?: AutoLogisticsConversion;
}

type Host = Pick<WorldSim, 'st' | 'time' | 'id'>;

export function enableSalvageP131(h: Host): SalvageConversion {
  const st = h.st;
  const out: SalvageConversion = { already: st.salvageV === 1, sitesRetired: 0, sitesKnownUnsalvaged: 0, groupsStopped: [], debrisFieldsKept: [], pendingLootKept: [] };
  if (out.already) return out;
  st.combatV = 2; st.opsV = 1;
  if (st.logisticsV !== 1) out.logistics = enableAutoLogistics(h);
  for (const s of Object.values(st.sites ?? {})) { out.sitesRetired++; if (s.seen.length && s.born <= h.time) out.sitesKnownUnsalvaged++; }
  delete st.sites;
  for (const g of Object.values(st.groups).sort((a, b) => a.id.localeCompare(b.id))) {
    if (g.op.k === 'salvage' || (g.op.k === 'survey' && !st.fog)) { out.groupsStopped.push({ group: g.id, op: g.op.k }); g.op = { k: 'idle' }; g.status = '대기 (P13.1 전환: 유기선 탐사·인양 종료)'; }
  }
  out.debrisFieldsKept = Object.values(st.fields).filter(f => f.salvage).map(f => f.id).sort();
  out.pendingLootKept = Object.values(st.companies).filter(c => c.pendingLoot && Object.keys(c.pendingLoot).length).map(c => c.id).sort();
  st.salvageV = 1;
  st.wrecks ??= {};
  return out;
}

/** P17.1 explicit save migration (idempotent): salvage quality rules for an industrial world. Nothing already
 *  recovered changes; only future recovery uses gear precision, officers and wreck condition. */
export function migrateSalvageQuality(st: import('./types').WorldState): { applied: boolean; reason?: string } {
  if (st.salvQV) return { applied: false, reason: '이미 적용됨' };
  if (!st.indV) return { applied: false, reason: '산업 하드포인트 규칙(indV) 이전 월드' };
  st.salvQV = 1;
  return { applied: true };
}
