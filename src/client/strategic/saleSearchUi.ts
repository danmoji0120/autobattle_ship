// P17.4b (AUD-04, B3): sale-destination search and one-click transfers in the HQ stock detail.
// The search runs the server's own rules (saleOptions → saleQuote / routeInfo / canCarry) over the synced state, so
// the list matches what the automatic planner would decide; the buttons send ordinary commands (sell, poolCreate),
// which the server checks again.
import type { WorldView } from '../../server/protocol';
import type { Station, WShip } from '../../world/types';
import { saleOptions, SALE_STRATEGY_NAME, type SaleHost, type SaleStrategy } from '../../world/saleSearch';
import { priceOf } from '../../world/market';
import { sysAt } from '../../world/geom';
import { dockRefused } from '../../world/territory';
import { econOf, growthOn } from '../../world/hullops';
import { poolMember, HAULER_MIN_HP } from '../../world/haulers';
import { techFx } from '../../world/industry';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n0 = (v: number) => Math.round(v).toLocaleString();

export function clientSaleHost(w: WorldView): SaleHost {
  const st = w as never as SaleHost['st'];
  return {
    st, sysOf: p => sysAt(w.systems, p),
    price: (s, res, side) => priceOf(s.market?.[res], side, growthOn(st)),
    canDock: (s, co) => s.public ? !dockRefused(st, s, co) : s.owner === co && s.modules.some(m => m.kind === 'core' && m.built),
  } as SaleHost;
}
/** idle pool haulers that could carry a sale (the same eligibility the planner uses, read from synced state) */
export function poolHaulers(w: WorldView, me: string): WShip[] {
  const opOf = (gid: string) => { let g = w.groups[gid]; while (g && !g.override && g.parentId && w.groups[g.parentId]) g = w.groups[g.parentId]; return g?.op; };
  return Object.values(w.ships).filter(s => s.owner === me && poolMember(w as never, s) && opOf(s.groupId)?.k === 'idle' && s.hp >= HAULER_MIN_HP && s.state !== 'battle' && s.state !== 'building' && !s.reserve && !s.listed && econOf(s).cargo > 0 && !econOf(s).military && s.classId !== 'miner' && s.classId !== 'constructor');
}

export interface SaleSearchState { from: string; amount: number; minPrice: number; strategy: SaleStrategy }

export function saleSearchHtml(w: WorldView, me: string, item: string, from: Station | undefined, q: SaleSearchState): string {
  if (!from) return '<p class="dim">이 품목을 보관한 정거장이 없습니다</p>';
  const carriers = poolHaulers(w, me), mul = techFx(w.companies[me]?.tech).cargoMul;
  const rule = w.companies[me]?.procurement?.sales?.[item];
  const opts = saleOptions(clientSaleHost(w), me, item, from, Math.max(1, Math.floor(q.amount)), { minPrice: q.minPrice, strategy: q.strategy, carriers, cargoMul: mul }).slice(0, 12);
  const row = (o: (typeof opts)[number], i: number) => `<tr class="${o.why ? 'dim' : i === 0 ? 'good' : ''}"><td>${esc(o.name)}${o.local ? ' <small>(현지)</small>' : ''}<br><small>${esc(o.system ?? '')}</small></td>
    <td>${o.why ? '—' : n0(o.sold)}</td><td>${o.why ? `<small>호가 ${n0(o.bid)}</small>` : `${n0(o.unit)} <small>cr</small>`}</td><td>${o.why ? '—' : `${n0(o.net)}<br><small>세 ${n0(o.tax)}</small>`}</td>
    <td>${o.local ? '—' : `${o.hops}점프 · 위험 ${Math.round(o.risk)}`}${!o.local && !o.why ? `<br><small>왕복 약 ${Math.round(o.trip / 60)}분${o.loads ? ` · ${o.loads}회 운송` : ''}</small>` : ''}</td>
    <td>${o.why ? `<span class="warn small">${esc(o.why)}</span>` : o.local ? `<button class="btn mini go" data-a="sale-here" data-id="${esc(item)}" data-st="${o.station}" data-n="${Math.floor(o.sold)}">여기서 판매</button>` : `<button class="btn mini go" data-a="sale-ship" data-id="${esc(item)}" data-from="${from.id}" data-st="${o.station}" data-n="${Math.floor(o.sold)}">판매 운송</button>`}</td></tr>`;
  return `<div class="ops-sale-search"><h4>판매처 찾기 — ${esc(from.name)}에서 ${n0(q.amount)}개</h4>
    <div class="proc-policy-grid"><label>출발 보관함<select data-keep data-sale-q="from">${Object.values(w.stations).filter(s => (s.storage[me]?.[item] ?? 0) >= 1).map(s => `<option value="${s.id}" ${s.id === from.id ? 'selected' : ''}>${esc(s.name)} (${n0(s.storage[me]![item])})</option>`).join('')}</select></label>
      <label>수량<input type="number" min="1" data-sale-q="amount" value="${Math.floor(q.amount)}"></label><label>최저 단가(세후)<input type="number" min="0" step="any" data-sale-q="minPrice" value="${q.minPrice}"></label>
      <label>전략<select data-keep data-sale-q="strategy">${(Object.keys(SALE_STRATEGY_NAME) as SaleStrategy[]).map(k => `<option value="${k}" ${k === q.strategy ? 'selected' : ''}>${SALE_STRATEGY_NAME[k]}</option>`).join('')}</select></label></div>
    <div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>시장</th><th>매입량</th><th>평균 단가</th><th>세후 수익</th><th>경로</th><th></th></tr></thead><tbody>${opts.map(row).join('') || '<tr><td colspan="6" class="dim">이 품목을 매입하는 시장이 없습니다</td></tr>'}</tbody></table></div>
    <p class="dim small">가격은 수량만큼 내려가는 호가를 따라 계산하고, 정거장 매입 예산·세금·정박·회사 위험 한도(${w.companies[me]?.procurement?.maxRisk ?? 100})·공용 수송선 ${carriers.length}척의 정박 규격을 반영합니다. 판매 운송은 최소 비축·예약분을 남깁니다.${rule ? ` 자동 판매 규칙: 최저 ${n0(rule.minPrice)} cr · ${SALE_STRATEGY_NAME[rule.strategy ?? 'local']}.` : ''}</p></div>`;
}

/** B3: own stations a store's free stock can be moved to in one click */
export function transferButtons(w: WorldView, me: string, item: string, from: string, available: number): string {
  if (available < 1) return '';
  const to = Object.values(w.stations).filter(s => s.id !== from && (s.owner === me || (s.public && !!s.storage[me]))).slice(0, 4);
  return to.map(s => `<button class="btn mini" data-a="xfer" data-id="${esc(item)}" data-from="${from}" data-st="${s.id}" data-n="${Math.floor(available)}">→ ${esc(s.name)} ${n0(available)} 이송</button>`).join('');
}
