import type { WorldView as WorldState } from '../../server/protocol';
import type { ProcurementKind } from '../../world/procurement';
import { itemName } from '../../world/industry';
import { growthOn } from '../../world/hullops';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

/** Displays the server's own demand and reservation figures, without recalculating procurement. */
export function procurementSourceHtml(w: WorldState, owner: string, station: string, kind: ProcurementKind, source: string): string {
  if (!growthOn(w) || !source || w.stations[station]?.owner !== owner) return '';
  const policy = w.companies[owner]?.procurement, key = JSON.stringify([station, kind, source]);
  const enabled = !policy?.disabled[key], global = policy?.enabled !== false, priority = policy?.priority[key] ?? (kind === 'production' ? 5 : 7);
  const plans = Object.values(w.procurementPlans ?? {}).filter(p => p.owner === owner && p.station === station && p.sourceKind === kind && p.sourceId === source && p.state !== 'closed');
  const rows = plans.map(p => {
    const sources = Object.values(w.logisticsJobs ?? {}).filter(j => j.procurement === p.id && j.state !== 'cancelled' && j.state !== 'complete');
    return `<div class="proc-source-item"><b>${esc(itemName(p.item))}</b> · 필요 ${num(p.required)} · 투입 ${num(p.used)} · 원본 예약 ${num(p.secured)} · 현장 ${num(p.local)} · 출발지 예약 ${num(p.reserved)} · 운송 중 ${num(p.inTransit)} · 미확보 ${num(p.shortage)}<small>${esc(p.reason)}${sources.length ? ` · ${sources.map(j => `${esc(w.stations[j.from]?.name ?? j.from)} ${num(j.amount)}${j.ship ? ` (${esc(w.ships[j.ship]?.name ?? '배정')})` : ' 대기'}`).join(' · ')}` : ''}</small></div>`;
  }).join('');
  return `<div class="proc-source"><div class="proc-source-head"><strong>자율 조달</strong><span>${!global ? '회사 전체 정지' : enabled ? '자동 운송 켜짐' : '이 작업 정지'}</span><button class="btn mini" data-proc-toggle data-proc-kind="${kind}" data-proc-source="${esc(source)}" data-proc-enabled="${!enabled}">${enabled ? '조달 정지' : '조달 재개'}</button><label>우선순위 <select data-proc-priority data-proc-kind="${kind}" data-proc-source="${esc(source)}" data-proc-enabled="${enabled}" aria-label="조달 우선순위">${Array.from({ length: 10 }, (_, n) => `<option value="${n}" ${n === priority ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>${rows || `<div class="dim small">${!global || !enabled ? '자동 조달이 정지되어 있습니다.' : '부족한 자재를 확인하고 공용 수송선이 운반합니다. 자동 구매는 기본적으로 꺼져 있습니다.'}</div>`}</div>`;
}
