// AUTO-P0: shared "재고 정책 · 자동 판매" section used by both logistics panels
import type { GameClient } from '../net';
import type { WorldView } from '../../server/protocol';
import { regionalOn } from '../../world/regional';
import { ITEMS, EQUIPMENT, itemName } from '../../world/industry';
import { SALE_STRATEGY_NAME, SALE_STRATEGY_DESC, type SaleStrategy } from '../../world/saleSearch';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const num = (v: number) => (Math.round(v * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
type Cmd = Parameters<GameClient['cmd']>[0];

/** AUTO-P0: minimum stock per store and automatic sale of what is above it */
export function salesPanelHtml(w: WorldView, me: string, busy: boolean): string {
  const policy = w.companies[me]?.procurement;
  const rules = policy?.sales ?? {}, status = policy?.salesStatus ?? {};
  const held = new Map<string, number>();
  for (const st of Object.values(w.stations)) for (const [k, n] of Object.entries(st.storage[me] ?? {})) if ((n as number) >= 1) held.set(k, (held.get(k) ?? 0) + (n as number));
  const keeps = Object.entries(policy?.protectedStock ?? {}).flatMap(([station, stock]) => Object.entries(stock).map(([item, amount]) => ({ station, item, amount })));
  const items = [...new Set([...Object.keys(rules), ...held.keys(), ...keeps.map(k => k.item)])].filter(id => ITEMS[id] || EQUIPMENT[id]).sort((a, b) => itemName(a).localeCompare(itemName(b), 'ko'));
  const all = [...new Set([...items, ...Object.keys(ITEMS).filter(id => !ITEMS[id].regional || regionalOn(w))])].sort((a, b) => itemName(a).localeCompare(itemName(b), 'ko'));
  const stations = Object.values(w.stations).filter(s => s.owner === me || s.public);
  const rows = items.map(id => {
    const r = rules[id], st = status[id], k = keeps.filter(x => x.item === id);
    return `<tr><td><b>${esc(itemName(id))}</b></td><td>${num(held.get(id) ?? 0)}</td><td>${k.length ? k.map(x => `${esc(w.stations[x.station]?.name ?? x.station)} ${num(x.amount)}`).join('<br>') : '<span class="dim">없음</span>'}</td><td>${r ? `켜짐 · 최저 ${num(r.minPrice)} cr · ${SALE_STRATEGY_NAME[r.strategy ?? 'local']}` : '<span class="dim">꺼짐</span>'}</td><td class="${st && /수송선 없음|시장 없음|손상|불가/.test(st.reason) ? 'warn' : 'dim'}">${r && st ? esc(st.reason) : ''}${r && st && st.sold ? `<br>현지 판매 ${num(st.sold)} · ${num(st.earned)} cr` : ''}</td><td>${r ? `<button class="btn mini" data-sale-off="${esc(id)}" ${busy ? 'disabled' : ''}>끄기</button>` : ''}</td></tr>`;
  }).join('');
  return `<section class="pool-section sales-policy"><div class="pool-section-head"><div><h3>재고 정책 · 자동 판매</h3><p>보관함마다 남길 최소 수량을 정하고, 초과분만 공용 수송선으로 매입 시장에 팔아 창고가 차지 않게 합니다.</p></div></div>
    ${rows ? `<div class="gt"><table class="sales-table"><thead><tr><th>품목</th><th>보관</th><th>최소 비축</th><th>자동 판매</th><th>상태</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="dim small">보관 중인 재고가 없습니다.</p>'}
    <form class="proc-policy-form" data-sales-form><div class="proc-policy-grid"><label>품목<select name="item" data-keep required>${all.map(id => `<option value="${esc(id)}">${esc(itemName(id))}</option>`).join('')}</select></label><label><span><input type="checkbox" name="sell" checked> 초과분 자동 판매</span></label><label>최저 판매 단가 (cr)<input name="minPrice" type="number" min="0" step="any" value="0"></label><label>판매 전략<select name="strategy" data-keep>${(Object.keys(SALE_STRATEGY_NAME) as SaleStrategy[]).map(k => `<option value="${k}" title="${esc(SALE_STRATEGY_DESC[k])}">${SALE_STRATEGY_NAME[k]}</option>`).join('')}</select></label></div>
      <div class="proc-policy-grid"><label>최소 비축 보관함<select name="station" data-keep><option value="">변경 안 함</option>${stations.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><label>남길 수량 (0이면 해제)<input name="keep" type="number" min="0" step="1" placeholder="변경 안 함"></label></div>
      <p class="dim small">최소 비축·비축 목표·생산/건설/조선 예약을 뺀 초과분만 판다. 판매 전략 — ${(Object.keys(SALE_STRATEGY_NAME) as SaleStrategy[]).map(k => `${SALE_STRATEGY_NAME[k]}: ${esc(SALE_STRATEGY_DESC[k])}`).join(' / ')}. 어느 전략이든 가격·예산·위험(조달 경로 최대 위험)·정박 조건은 같다. 시장별 비교는 본부 → 재고 → 품목 상세의 '판매처 찾기'에서 볼 수 있다. 채굴 편대의 수송선은 채굴 운반만 하므로, 운송하려면 대기 편대에 수송선을 둔다. 판매처나 수송선이 없으면 재고를 그대로 두고 다시 시도한다. 채굴선의 하역 판매·조건부 판매·판매 운송도 최소 비축을 남긴다.</p>
      <button class="btn go" type="submit" ${busy ? 'disabled' : ''}>판매 정책 저장</button></form>
    ${autoOpsHtml(w, me, busy)}</section>`;
}

/** AUTO-P1: mining-hauler sale trips, automatic repair and what each automated hauler is doing */
function autoOpsHtml(w: WorldView, me: string, busy: boolean): string {
  const policy = w.companies[me]?.procurement, rep = policy?.repair, svc = w.companies[me]?.repairService;
  const jobs = Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === me && j.ship && j.state !== 'complete' && j.state !== 'cancelled');
  const opOf = (gid: string) => { let g = w.groups[gid]; while (g && !g.override && g.parentId && w.groups[g.parentId]) g = w.groups[g.parentId]; return g?.op; };
  const ships = Object.values(w.ships).filter(s => s.owner === me && s.classId === 'hauler').sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const stn = (id?: string) => esc((id && w.stations[id]?.name) ?? id ?? '');
  const row = (s: (typeof ships)[number]) => {
    const j = jobs.find(x => x.ship === s.id), op = opOf(s.groupId), st = rep?.status?.[s.id];
    const what = j?.miner ? `판매 왕복 → ${stn(j.to)} (${esc(itemName(j.item))} ${num(j.carried || j.reserved)})${j.reason ? ` · ${esc(j.reason)}` : ''}`
      : s.repairAt ? `수리 이동 → ${stn(s.repairAt.station)} (예상 ${num(s.repairAt.quote)} cr)`
      : j ? `자동 물류 운송 → ${stn(j.to)}`
      : op?.k === 'mine' ? '채굴 운반' : op?.k === 'idle' ? '대기' : `직접 명령 (${esc(op?.k ?? '?')})`;
    const hp = Math.round(s.hp * 100);
    return `<li><b>${esc(s.name)}</b> <span class="dim">내구 ${hp}%</span> — ${what}${st && (hp < 40 || h1(w, st.t)) ? `<div class="small ${hp < 40 ? 'warn' : 'dim'}">${esc(st.reason)}</div>` : ''}</li>`;
  };
  return `<div class="auto-ops" data-auto-ops><h4>채굴 수송선 · 자동 수리</h4>
    <ul class="autolg-list">${ships.map(row).join('') || '<li class="dim">수송선이 없습니다</li>'}</ul>
    ${policy && policy.minerSales !== false && policy.minerTrip ? `<p class="small dim">채굴 수송선 판매 왕복: ${esc(policy.minerTrip.reason)}</p>` : ''}
    <form class="proc-policy-form" data-auto-ops-form>
      <label style="display:block"><input type="checkbox" name="haulOnly" ${policy?.minerSales === false ? 'checked' : ''}> 채굴 운반 전용 — 채굴 편대 수송선은 판매 왕복을 하지 않음 (기본: 자동 판매 품목의 초과 재고를 3점프 이내 시장에 팔고 복귀, 유휴 공용 수송선이 있으면 그쪽 우선)</label>
      <label style="display:block"><input type="checkbox" name="repair" ${rep?.enabled ? 'checked' : ''}> 손상으로 배차에서 빠진 수송선 자동 수리</label>
      <div class="proc-policy-grid"><label>최소 잔고 (cr)<input name="minCredits" type="number" min="0" step="100" value="${rep?.minCredits ?? 0}"></label><label>1회 최대 수리비<input name="maxPerRepair" type="number" min="0" step="100" value="${rep?.maxPerRepair ?? 0}"></label><label>시간당 수리 예산<input name="perHour" type="number" min="0" step="100" value="${rep?.perHour ?? 0}"></label></div>
      <p class="dim small">자동 수리는 기본 꺼짐. 한도 안에서만 수리하고, 넘으면 화물·작업을 보존한 채 이유를 표시합니다. 정박한 정거장에서 수리할 수 없으면 경로 위험 제한 안의 가장 가까운 수리 정거장으로 갔다가 하던 일로 돌아갑니다.</p>
      <label style="display:block"><input type="checkbox" name="svc" ${svc?.enabled ? 'checked' : ''}> 외부 수리 이용 — 다른 회사 수리선의 유료 현장 수리 허용</label>
      <div class="proc-policy-grid"><label>가격 상한 (정거장 가격 ×)<input name="svcMul" type="number" min="0.5" max="3" step="0.1" value="${svc?.maxMul ?? 1.5}"></label><label>시간당 예산<input name="svcHour" type="number" min="0" step="100" value="${svc?.perHour ?? 5000}"></label><label>최소 잔고<input name="svcMin" type="number" min="0" step="100" value="${svc?.minCredits ?? 0}"></label></div>
      <button class="btn mini go" type="submit" ${busy ? 'disabled' : ''}>자동 운영 설정 저장</button></form></div>`;
}
const h1 = (w: WorldView, t: number) => w.time - t < 600;

export function bindSalesPanel(el: HTMLElement, send: (cmd: Cmd, ok: string) => void, fail: (msg: string) => void) {
  const form = el.querySelector<HTMLFormElement>('[data-sales-form]');
  if (form) form.onsubmit = e => {
    e.preventDefault(); const data = new FormData(form);
    const station = String(data.get('station') ?? ''), keep = String(data.get('keep') ?? '');
    if (!!station !== !!keep) { fail('최소 비축은 보관함과 수량을 함께 입력하세요'); return; }
    const settings = { item: String(data.get('item')), sell: data.has('sell'), minPrice: Number(data.get('minPrice') || 0), strategy: String(data.get('strategy') || 'local') as SaleStrategy, ...(station ? { station, keep: Number(keep) } : {}) };
    send({ c: 'salesPolicy', settings }, '판매 정책을 저장했습니다');
  };
  const ops = el.querySelector<HTMLFormElement>('[data-auto-ops-form]');
  if (ops) ops.onsubmit = e => {
    e.preventDefault(); const d = new FormData(ops);
    send({ c: 'autoOpsPolicy', minerSales: !d.has('haulOnly'), repair: { enabled: d.has('repair'), minCredits: Number(d.get('minCredits') || 0), maxPerRepair: Number(d.get('maxPerRepair') || 0), perHour: Number(d.get('perHour') || 0) }, repairService: { enabled: d.has('svc'), maxMul: Number(d.get('svcMul') || 1.5), perHour: Number(d.get('svcHour') || 0), minCredits: Number(d.get('svcMin') || 0) } }, '자동 운영 설정을 저장했습니다');
  };
  el.querySelectorAll<HTMLElement>('[data-sale-off]').forEach(b => b.onclick = () => send({ c: 'salesPolicy', settings: { item: b.dataset.saleOff!, sell: false } }, '자동 판매를 껐습니다. 이미 실린 화물은 판매를 마칩니다'));
}
