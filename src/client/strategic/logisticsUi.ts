import type { GameClient } from '../net';
import type { LogisticsRoute, RouteConfig } from '../../world/logistics';
import { routeShips, routeLabel, supplyBatch } from '../../world/logistics';
import { regionalOn } from '../../world/regional';
import { ITEMS, EQUIPMENT, itemName, techFx } from '../../world/industry';
import { cargoKeys, cargoSum, qty } from '../../world/types';
import { econOf, growthOn } from '../../world/hullops';
import { sysAt } from '../../world/geom';
import { morph, trackSelects } from '../../ui/morph';
import { queueShortfall } from '../../world/construction';
import type { PoolRequest, LogisticsJob } from '../../world/autonomousLogistics';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const num = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const modes = { transfer: '창고 운송', sell: '자동 판매', supply: '생산 공급', construction: '건설 공급' };
interface Options { station?: string; group?: string; create?: boolean; construction?: boolean }
interface Actions { station(id: string, tab?: 'store' | 'market' | 'prod' | 'build' | 'yard'): void; fleet(group: string, ship?: string): void; analytics(): void; close(): void }
export class LogisticsPanel {
  private el = document.createElement('div');
  private editing = false; private editId = ''; private editKey = 0; private group = '';
  private view: 'pool' | 'routes' = 'pool';
  private poolDraft: PoolRequest = { from: '', to: '', item: 'ore', kind: 'transfer', amount: 100, priority: 5, repeat: false };
  private draft: RouteConfig = { name: '', from: '', to: '', item: 'ore', mode: 'transfer', amount: 100, repeat: true, minStock: 20, targetStock: 100 };
  private selected = new Set<string>(); private expanded = new Set<string>(); private station = ''; private filter = 'all'; private search = '';
  private error = ''; private notice = ''; private busy = false; private saleConsent = false; private closed = false;
  private policyEditing = false;
  private onSnap = () => this.render();
  private key = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopImmediatePropagation(); this.close(); } };
  constructor(private root: HTMLElement, private c: GameClient, private actions: Actions, options: Options = {}) {
    this.station = options.station ?? ''; this.el.className = 'modal lg-modal'; this.el.tabIndex = -1;
    this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-label', '물류 관리'); this.el.setAttribute('aria-modal', 'true');
    this.el.onkeydown = e => e.stopPropagation(); this.el.onclick = e => { if (e.target === this.el) this.close(); };
    root.appendChild(this.el); trackSelects(this.el); c.onSnap.push(this.onSnap); window.addEventListener('keydown', this.key, true); this.el.focus();
    if (options.create || options.group) {
      this.view = 'routes';
      const r = Object.values(c.state?.logistics ?? {}).find(r => r.group === options.group && r.owner === c.company);
      if (r) this.edit(r); else this.newRoute(options.group, options.construction);
    } else this.render();
  }
  close() { if (this.closed) return; this.closed = true; const i = this.c.onSnap.indexOf(this.onSnap); if (i >= 0) this.c.onSnap.splice(i, 1); window.removeEventListener('keydown', this.key, true); this.el.remove(); this.actions.close(); document.getElementById('logisticsBtn')?.focus(); }
  private get routes() { return Object.values(this.c.state?.logistics ?? {}).filter(r => r.owner === this.c.company); }
  private hasExternalSource(id: string) {
    const st = this.c.state?.stations[id];
    return !!st && (cargoKeys(st.storage[this.c.company] ?? {}).length > 0 || this.routes.some(r => r.config.from === id));
  }
  private newRoute(group?: string, construction = false) {
    const w = this.c.state!;
    this.editing = true; this.editId = ''; this.editKey++; this.group = group ?? (construction ? '' : Object.values(w.groups).find(g => g.owner === this.c.company && routeShips(w, { group: g.id, owner: g.owner }).length && !this.routes.some(r => r.group === g.id))?.id ?? '');
    const home = w.companies[this.c.company]?.homeStation;
    const from = construction ? (home && home !== this.station ? home : Object.values(w.stations).find(s => s.public && s.id !== this.station)?.id ?? '') : this.station || home || Object.keys(w.stations)[0];
    const to = construction && this.station ? this.station : Object.values(w.stations).find(s => s.id !== from && s.owner === this.c.company)?.id ?? Object.values(w.stations).find(s => s.id !== from && s.public)?.id ?? '';
    const short = w.stations[to] ? queueShortfall(w.stations[to]) : {};
    const item = construction ? Object.keys(short)[0] ?? 'alloy' : 'ore';
    this.draft = { name: '', from, to, item, mode: construction ? 'construction' : 'transfer', amount: construction ? Math.max(1, Math.ceil(short[item] ?? 100)) : 100, repeat: true, minStock: 20, targetStock: 100 }; this.error = ''; this.saleConsent = false; this.render();
  }
  private edit(r: LogisticsRoute) { this.editing = true; this.editId = r.id; this.editKey++; this.group = r.group; this.draft = { ...r.config, minStock: r.config.minStock ?? 20, targetStock: r.config.targetStock ?? 100 }; this.error = ''; this.saleConsent = false; this.render(); }
  private async send(command: Parameters<GameClient['cmd']>[0], success: string, finish?: () => void) {
    if (this.busy) return; this.busy = true; this.error = ''; this.render();
    try { const error = await this.c.cmd(command); if (this.closed) return; if (error) this.error = error; else { this.notice = success; finish?.(); } }
    catch { if (!this.closed) this.error = '연결을 확인하고 다시 시도하세요'; }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
  private render() {
    if (this.closed) return;
    const w = this.c.state; if (!w) { this.el.innerHTML = '<div class="panel lg-box"><p>서버의 물류 상태를 기다리는 중…</p></div>'; return; }
    const routes = this.routes, now = w.time;
    const jobs = Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === this.c.company);
    const poolShips = Object.values(w.ships).filter(s => s.owner === this.c.company && s.logisticsPool);
    const active = routes.filter(r => r.state === 'running').length, waiting = routes.filter(r => routeLabel(r).state === 'waiting').length;
    const recent = routes.reduce((n, r) => n + r.recent.filter(b => b.t >= now - 3600).reduce((sum, b) => sum + b.delivered, 0), 0);
    const list = routes.filter(r => (!this.station || r.config.from === this.station || r.config.to === this.station) && (this.filter === 'all' || this.filter === 'issues' && ['waiting', 'paused'].includes(routeLabel(r).state) || routeLabel(r).state === this.filter) && (!this.search || `${r.config.name} ${w.groups[r.group]?.name ?? ''} ${itemName(r.config.item)}`.toLowerCase().includes(this.search.toLowerCase())));
    for (const id of this.expanded) if (!routes.some(r => r.id === id)) this.expanded.delete(id);
    for (const id of this.selected) if (!routes.some(r => r.id === id)) this.selected.delete(id);
    const stations = Object.values(w.stations).filter(s => s.public || s.owner === this.c.company || this.hasExternalSource(s.id));
    const choose = (items: { id: string; name: string }[], value: string, first: string) => `<option value="">${first}</option>${items.map(i => `<option value="${esc(i.id)}" ${i.id === value ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}`;
    morph(this.el, `<div class="panel lg-box"><header class="lg-head"><div><div class="an-eyebrow">SIDERARIUM / LOGISTICS</div><h2>물류 관리 <span>자사 운송 · 서버 자동 운용</span></h2></div><div class="lg-actions"><button class="btn go" ${this.view === 'pool' ? 'data-pool-new' : 'data-lg-new'}>+ ${this.view === 'pool' ? '작업 요청' : '운송 노선'}</button><button class="btn" data-lg-close aria-label="물류 닫기">✕</button></div></header>
      <nav class="pool-tabs" aria-label="물류 관리 보기"><button class="${this.view === 'pool' ? 'on' : ''}" data-lg-view="pool" aria-pressed="${this.view === 'pool'}">공용 배차</button><button class="${this.view === 'routes' ? 'on' : ''}" data-lg-view="routes" aria-pressed="${this.view === 'routes'}">기존 운송 노선</button></nav>
      ${this.view === 'pool' ? `<div class="lg-summary"><div><span>참여 함선</span><b>${poolShips.length}</b></div><div><span>대기 작업</span><b>${jobs.filter(j => j.state === 'queued' || j.state === 'waiting').length}</b></div><div><span>수행 중</span><b>${jobs.filter(j => !!j.ship && j.state !== 'paused').length}</b></div><div><span>완료 작업</span><b>${jobs.filter(j => j.state === 'complete').length}</b></div></div>` : `<div class="lg-summary"><div><span>운용 노선</span><b>${active}</b></div><div><span>조건 회복 대기</span><b class="${waiting ? 'warn' : ''}">${waiting}</b></div><div><span>최근 1시간 하역량</span><b>${num(recent)}</b></div><div><span>누적 판매 수입</span><b class="money">${num(routes.reduce((n, r) => n + r.stats.earned, 0))} <small>cr</small></b></div></div>`}
      ${this.error ? `<div class="lg-feedback warn" role="alert">${esc(this.error)}</div>` : this.notice ? `<div class="lg-feedback good" role="status">${esc(this.notice)}</div>` : ''}
      ${this.view === 'pool' ? this.poolPage(jobs) : `
      <div class="lg-layout ${this.editing ? 'editing' : ''}"><main class="lg-list">
        <div class="lg-filters"><label>정거장<select data-lg-station data-keep>${choose(stations, this.station, '모든 정거장')}</select></label><label>상태<select data-lg-filter data-keep>${[['all', '모든 상태'], ['issues', '대기·일시정지'], ['running', '정상 운용'], ['complete', '편도 완료']].map(([v, text]) => `<option value="${v}" ${this.filter === v ? 'selected' : ''}>${text}</option>`).join('')}</select></label><label class="lg-search">노선 찾기<input data-lg-search type="search" value="${esc(this.search)}" placeholder="노선·편대·품목"></label></div>
        <div class="lg-bulk"><span>${this.selected.size ? `${this.selected.size}개 선택` : `${list.length}개 노선`}</span><button class="btn mini" data-lg-all ${!list.length ? 'disabled' : ''}>모두 선택</button><button class="btn mini" data-lg-bulk="pause" ${!this.selected.size || this.busy ? 'disabled' : ''}>선택 정지</button><button class="btn mini" data-lg-bulk="resume" ${!this.selected.size || this.busy ? 'disabled' : ''}>선택 재개</button></div>
        <div class="lg-cards">${list.map(r => this.card(r)).join('') || `<div class="lg-empty"><div class="lg-orbit" aria-hidden="true">◉ ─── ◉</div><h3>${routes.length ? '조건에 맞는 노선이 없습니다' : '반복 운송을 시작하세요'}</h3><p>${routes.length ? '정거장·상태 필터를 바꿔 확인하세요.' : '운송 편대, 두 정거장, 물품을 선택하면 적재부터 하역까지 서버가 반복합니다.'}</p><button class="btn go" data-lg-new>운송 노선 설정</button></div>`}</div>
        ${this.mining()}
      </main>${this.editing ? this.form() : ''}</div>`}
      <footer class="lg-foot"><span>화물 소유권 유지 · 미판매 화물 보존 · 로그아웃 후에도 운용</span><button class="an-link" data-lg-analytics>수입·운영비 분석 →</button></footer></div>`);
    this.bind(list);
  }
  private newPoolJob() {
    const w = this.c.state!, home = w.companies[this.c.company]?.homeStation;
    const from = this.station || home || '', to = Object.values(w.stations).find(s => s.id !== from && s.owner === this.c.company)?.id ?? Object.values(w.stations).find(s => s.id !== from && s.public)?.id ?? '';
    this.poolDraft = { from, to, item: 'ore', kind: 'transfer', amount: 100, priority: 5, repeat: false };
    this.editing = true; this.saleConsent = false; this.error = ''; this.render();
  }
  private poolPage(jobs: LogisticsJob[]) {
    const w = this.c.state!;
    const groups = Object.values(w.groups).filter(g => g.owner === this.c.company && g.shipIds.some(id => w.ships[id]?.classId === 'hauler'));
    const rank = (j: LogisticsJob) => j.state === 'active' || j.state === 'waiting' || j.state === 'queued' ? 0 : j.state === 'paused' ? 1 : 2;
    const sorted = [...jobs].sort((a, b) => rank(a) - rank(b) || b.created - a.created || b.id.localeCompare(a.id));
    return `<div class="lg-layout ${this.editing ? 'editing' : ''}"><main class="lg-list pool-main">
      ${growthOn(w) ? this.procurementPanel() : ''}
      <section class="pool-section"><div class="pool-section-head"><div><h3>작업 대기열</h3><p>우선순위가 높은 요청부터 가용 함선에 배정합니다. 완료한 함선은 다음 작업을 받습니다.</p></div><span>${jobs.length}개 요청</span></div>
      <div class="lg-cards">${sorted.map(j => this.poolCard(j)).join('') || `<div class="lg-empty"><div class="lg-orbit" aria-hidden="true">◉ ─── ◉</div><h3>운송 작업을 요청하세요</h3><p>출발지와 목적지를 정하고 아래에서 수송선을 공용 배차에 참여시키세요.</p><button class="btn go" data-pool-new>작업 요청</button></div>`}</div></section>
      <section class="pool-section pool-participants"><div class="pool-section-head"><div><h3>참여 수송선</h3><p>대기 중인 수송선만 참여할 수 있습니다. 직접 명령이나 편제 변경은 공용 배차보다 우선합니다.</p></div><span>${groups.length}개 편대</span></div>
      ${groups.map(g => { const ships = g.shipIds.map(id => w.ships[id]).filter(s => s?.classId === 'hauler'); return `<div class="pool-group"><div class="pool-group-head"><strong>${esc(g.name)}</strong><span>${ships.filter(s => s.logisticsPool).length}/${ships.length}척 참여</span><button class="btn mini" data-pool-group="${esc(g.id)}" data-pool-on="true">편대 참여</button><button class="btn mini" data-pool-group="${esc(g.id)}" data-pool-on="false">편대 제외</button></div>${ships.map(s => { const j = s.logisticsJob && w.logisticsJobs?.[s.logisticsJob]; return `<div class="pool-ship"><div><b>${esc(s.name)}</b><small>${s.logisticsPool ? j ? `수행 중 · ${esc(itemName(j.item))} → ${esc(w.stations[j.to]?.name ?? j.to)}` : '참여 중 · 다음 작업 대기' : '공용 배차 제외'} · 화물 ${num(cargoSum(s.cargo))}/${num(econOf(s).cargo * techFx(w.companies[s.owner]?.tech).cargoMul)}</small></div><button class="btn mini" data-pool-ship="${esc(s.id)}" data-pool-on="${!s.logisticsPool}" ${this.busy ? 'disabled' : ''}>${s.logisticsPool ? '제외' : '참여'}</button></div>`; }).join('')}</div>`; }).join('') || '<p class="dim small">수송선이 없습니다. 조선소에서 수송선을 확보한 뒤 참여시킬 수 있습니다.</p>'}</section>
      </main>${this.editing ? this.poolForm() : ''}</div>`;
  }
  private poolCard(j: LogisticsJob) {
    const w = this.c.state!, status = { queued: '대기', active: '수행 중', waiting: '조건 대기', paused: '일시정지', complete: '완료', cancelled: '취소' }[j.state];
    const ship = j.ship ? w.ships[j.ship] : undefined, done = j.state === 'complete' || j.state === 'cancelled';
    const plan = j.procurement ? w.procurementPlans?.[j.procurement] : undefined;
    return `<article class="lg-card ${j.state === 'waiting' ? 'waiting' : j.state === 'paused' ? 'paused' : j.state === 'complete' ? 'complete' : ''}" data-pool-job="${esc(j.id)}"><div class="lg-card-top"><b>${j.procurement ? '자동 조달' : '직접 요청'} · ${esc(modes[j.kind])} · ${esc(itemName(j.item))}</b><span class="lg-badge ${j.state}">${status}</span></div>
      <div class="lg-path"><button class="an-link" data-lg-open="${esc(j.from)}">${esc(w.stations[j.from]?.name ?? j.from)}</button><span>→</span><button class="an-link" data-lg-open="${esc(j.to)}">${esc(w.stations[j.to]?.name ?? j.to)}</button></div>
      <div class="lg-cargo"><span>우선순위 ${j.priority} · ${j.repeat ? '반복 · 정지 또는 취소까지' : '단발'} · 요청 ${num(j.amount)}</span></div>
      <div class="lg-route-status ${j.reason ? 'warn' : 'dim'}">${esc(j.reason ?? (ship ? `${ship.name} 배정 · ${j.carried > 0 ? '목적지로 운송' : '출발지 이동·적재'}` : j.state === 'complete' ? '요청 수량 운송 완료 · 함선은 다음 작업을 받습니다' : '가용 함선 배정 대기'))}</div>
      <div class="lg-metrics"><span>완료 <b>${num(j.delivered)}</b></span><span>운송 중 <b>${num(j.carried)}</b></span><span>출발지 예약 <b>${num(j.reserved)}</b></span></div>
      ${j.lost || j.withdrawn ? `<p class="dim small">손실 ${num(j.lost)} · 작업에서 회수 ${num(j.withdrawn)} (생존 함선 화물 보존)</p>` : ''}
      <div class="lg-card-actions">${plan ? `<button class="btn mini" data-proc-open="${esc(plan.station)}" data-proc-tab="${plan.sourceKind === 'construction' ? 'build' : plan.sourceKind === 'production' ? 'prod' : 'yard'}">원본 작업 →</button>` : ''}${done ? '' : `<button class="btn mini" data-pool-control="${esc(j.id)}" data-pool-action="${j.state === 'paused' ? 'resume' : 'pause'}" ${this.busy ? 'disabled' : ''}>${j.state === 'paused' ? '재개' : '일시정지'}</button><button class="btn mini warnb" data-pool-control="${esc(j.id)}" data-pool-action="cancel" ${this.busy ? 'disabled' : ''}>취소</button>`}</div>${j.procurement && !done ? '<p class="dim small">이 운송만 취소하면 원본 수요에 따라 다시 생성될 수 있습니다. 조달 전체 정지는 원본 작업에서 설정하세요.</p>' : ''}</article>`;
  }
  private procurementPanel() {
    const w = this.c.state!, policy = w.companies[this.c.company]?.procurement;
    const plans = Object.values(w.procurementPlans ?? {}).filter(p => p.owner === this.c.company && p.state !== 'closed').sort((a, b) => b.priority - a.priority || a.created - b.created || a.id.localeCompare(b.id));
    const kinds = { construction: '시설 건설', production: '생산', ship: '함선 건조' };
    const items = [...new Set([...Object.keys(ITEMS).filter(id => !ITEMS[id].regional || regionalOn(w)), ...Object.keys(EQUIPMENT)])].sort((a, b) => itemName(a).localeCompare(itemName(b), 'ko'));
    const stations = Object.values(w.stations).filter(s => s.owner === this.c.company || s.public || this.hasExternalSource(s.id));
    const caps = Object.entries(policy?.maxPrice ?? {}).map(([item, price]) => `${esc(itemName(item))} ${num(price)} cr`).join(' · ');
    const protectedItems = Object.entries(policy?.protectedStock ?? {}).flatMap(([station, stock]) => Object.entries(stock).map(([item, amount]) => `${esc(w.stations[station]?.name ?? station)} / ${esc(itemName(item))} ${num(amount)}`)).join(' · ');
    return `<section class="pool-section proc-policy"><div class="pool-section-head"><div><h3>자율 자재 조달</h3><p>건설·생산·조선의 부족 자재를 자사 보관함에서 찾아 공용 수송선으로 운반합니다.</p></div><button class="btn mini" data-proc-policy-open>${this.policyEditing ? '설정 닫기' : '조달 설정'}</button></div>
      <div class="proc-policy-status"><span>자사 재고 운송 <b>${policy?.enabled === false ? '정지' : '켜짐'}</b></span><span>자동 구매 <b>${policy?.autoBuy ? '허용' : '꺼짐'}</b></span><span>구매 예산 사용 <b>${num(policy?.spent ?? 0)} / ${num(policy?.budget ?? 0)} cr</b></span></div>
      <p class="dim small">최대 단가: ${caps || '설정 없음'} · 보호 재고: ${protectedItems || '설정 없음'}</p>
      ${this.policyEditing ? `<form class="proc-policy-form" data-proc-policy-form><div class="proc-policy-switches"><label><input type="checkbox" name="enabled" ${policy?.enabled !== false ? 'checked' : ''}> 자사 재고 자동 운송</label><label><input type="checkbox" name="autoBuy" ${policy?.autoBuy ? 'checked' : ''}> 실제 시장 자동 구매 허용</label></div>
        <div class="proc-policy-grid"><label>누적 구매 예산 한도 (cr)<input name="budget" type="number" min="0" max="1000000000000" step="any" value="${policy?.budget ?? 0}" required></label><label>최소 보유 크레딧<input name="minCredits" type="number" min="0" max="1000000000000" step="any" value="${policy?.minCredits ?? 0}" required></label><label>경로 최대 위험 (0–100)<input name="maxRisk" type="number" min="0" max="100" step="any" value="${policy?.maxRisk ?? 100}" required></label></div>
        <p class="dim small">구매하려면 허용, 충분한 누적 예산과 해당 품목의 최대 단가가 모두 필요합니다. 예산은 지금까지의 자동 구매 지출을 포함합니다.</p>
        <div class="proc-policy-grid"><label>최대 단가를 변경할 품목<select name="priceItem" data-keep><option value="">변경 안 함</option>${items.map(id => `<option value="${esc(id)}">${esc(itemName(id))}</option>`).join('')}</select></label><label>최대 단가 (0이면 해제)<input name="maxUnitPrice" type="number" min="0" max="1000000000000" step="any" placeholder="변경 안 함"></label></div>
        <div class="proc-policy-grid"><label>보호할 보관함<select name="protectStation" data-keep><option value="">변경 안 함</option>${stations.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><label>보호 품목<select name="protectItem" data-keep><option value="">품목 선택</option>${items.map(id => `<option value="${esc(id)}">${esc(itemName(id))}</option>`).join('')}</select></label><label>남겨 둘 수량 (0이면 해제)<input name="protectAmount" type="number" min="0" max="1000000000000" step="any" placeholder="변경 안 함"></label></div><p class="dim small">보호 수량은 이 보관함에서 출발하는 자동 조달에 적용됩니다. 현장의 생산·건설과 직접 명령은 기존 규칙대로 처리됩니다.</p>
        <button class="btn go" type="submit" ${this.busy ? 'disabled' : ''}>조달 설정 저장</button></form>` : ''}
      ${plans.length ? `<div class="proc-plans"><h4>원본 작업별 조달</h4>${plans.map(p => `<article class="proc-plan"><div><b>${kinds[p.sourceKind]} · ${esc(itemName(p.item))}</b> <span>${esc(w.stations[p.station]?.name ?? p.station)} · 우선순위 ${p.priority}</span></div><p>필요 ${num(p.required)} · 투입 ${num(p.used)} · 원본 예약 ${num(p.secured)} · 현장 ${num(p.local)} · 기존 운송 ${num(p.otherIncoming)} · 계획 ${num(p.planned)} · 출발지 예약 ${num(p.reserved)} · 운송 중 ${num(p.inTransit)} · 미확보 ${num(p.shortage)}</p><p class="${p.state === 'waiting' ? 'warn' : 'dim'}">${esc(p.reason)}</p><button class="an-link" data-proc-open="${esc(p.station)}" data-proc-tab="${p.sourceKind === 'construction' ? 'build' : p.sourceKind === 'production' ? 'prod' : 'yard'}">원본 작업 확인 →</button></article>`).join('')}</div>` : '<p class="dim small">현재 표시할 조달 수요가 없습니다.</p>'}</section>`;
  }
  private poolForm() {
    const w = this.c.state!, d = this.poolDraft;
    const stations = Object.values(w.stations).filter(s => s.public || s.owner === this.c.company);
    const options = (value: string) => `<option value="">정거장 선택</option>${stations.map(s => `<option value="${esc(s.id)}" ${s.id === value ? 'selected' : ''}>${esc(s.name)} · ${esc(sysAt(w.systems, s.pos)?.name ?? '')}</option>`).join('')}`;
    const stock = w.stations[d.from]?.storage[this.c.company] ?? {};
    const items = [...new Set([...Object.keys(ITEMS).filter(id => !ITEMS[id].regional || regionalOn(w)), ...Object.keys(EQUIPMENT), ...Object.keys(stock)])].sort((a, b) => itemName(a).localeCompare(itemName(b), 'ko'));
    return `<aside class="lg-editor"><form data-pool-form><div class="lg-editor-head"><h3>새 작업 요청</h3><button class="btn mini" type="button" data-pool-form-close aria-label="작업 요청 닫기">✕</button></div>
      <label>출발지<select data-pool-field="from" data-keep>${options(d.from)}</select></label><label>목적지<select data-pool-field="to" data-keep>${options(d.to)}</select></label>
      <label>작업 종류<select data-pool-field="kind" data-keep>${Object.entries(modes).map(([v, text]) => `<option value="${v}" ${v === d.kind ? 'selected' : ''}>${text}</option>`).join('')}</select></label>
      <label>운송 품목<select data-pool-field="item" data-keep>${items.map(id => `<option value="${esc(id)}" ${id === d.item ? 'selected' : ''}>${esc(itemName(id))}</option>`).join('')}</select></label>
      <div class="lg-stock"><span>출발지 자유 재고 <b>${num(qty(stock, d.item))}</b></span></div>
      <label>요청 수량<input data-pool-field="amount" type="number" min="1" step="1" required value="${d.amount}"></label><label>우선순위 (0–9, 높을수록 먼저)<input data-pool-field="priority" type="number" min="0" max="9" step="1" required value="${d.priority}"></label>
      <label class="lg-toggle"><input data-pool-field="repeat" type="checkbox" ${d.repeat ? 'checked' : ''}> 완료 후 같은 수량을 반복 요청</label>
      ${d.kind === 'sell' ? `<label class="lg-consent"><input data-pool-sale type="checkbox" ${this.saleConsent ? 'checked' : ''}><span>이 작업이 새로 적재한 <b>${esc(itemName(d.item))}</b>을 목적지 시장에서 자동 판매합니다.</span></label>` : '<p class="dim small">자유 재고만 실제 적재하며 기존 함선 화물과 건설 예약은 사용하지 않습니다.</p>'}
      ${d.kind === 'construction' ? '<p class="dim small">자사 현장의 실제 부족량까지만 반입합니다.</p>' : d.kind === 'supply' ? '<p class="dim small">자사 생산 정거장과 출발지 또는 목적지의 물류센터가 필요합니다.</p>' : ''}
      <button class="btn go lg-submit" type="submit" ${this.busy || d.kind === 'sell' && !this.saleConsent ? 'disabled' : ''}>${this.busy ? '서버에 저장 중…' : '작업 요청'}</button></form></aside>`;
  }
  private card(r: LogisticsRoute) {
    const w = this.c.state!, state = routeLabel(r), ships = routeShips(w, r), first = ships[0];
    const position = first ? first.task.k === 'docked' ? w.stations[first.task.station]?.name ?? '정박지' : sysAt(w.systems, first.pos)?.name ?? '성계 사이' : '배정 함선 없음';
    const cargo = Object.entries(r.manifests).reduce((n, [id, m]) => n + Math.min(m.amount, qty(w.ships[id]?.cargo, m.item)), 0);
    const recent = r.recent.filter(b => b.t >= w.time - 3600).reduce((n, b) => n + b.delivered, 0);
    const blocked = Object.values(r.cursors).find(c => c.code), help = blocked?.station ?? (r.state === 'paused' ? r.config.to : undefined);
    return `<article class="lg-card ${state.state}" data-lg-card="${esc(r.id)}"><div class="lg-card-top"><label class="lg-check"><input type="checkbox" data-lg-pick="${esc(r.id)}" ${this.selected.has(r.id) ? 'checked' : ''} aria-label="${esc(r.config.name)} 선택"><b>${esc(r.config.name)}</b></label><span class="lg-badge ${state.state}">${{ running: '운용', waiting: '대기', paused: '일시정지', complete: '완료' }[state.state]}</span></div>
      <div class="lg-path"><button class="an-link" data-lg-open="${esc(r.config.from)}">${esc(w.stations[r.config.from]?.name ?? '출발지 없음')}</button><span>→</span><button class="an-link" data-lg-open="${esc(r.config.to)}">${esc(w.stations[r.config.to]?.name ?? '목적지 없음')}</button></div>
      <div class="lg-cargo"><strong>${esc(itemName(r.config.item))}</strong><span>${modes[r.config.mode]} · 함선당 최대 ${num(r.config.amount)} · ${r.config.repeat ? '반복' : '편도'}</span></div>
      <div class="lg-route-status ${state.state === 'waiting' || state.state === 'paused' ? 'warn' : 'dim'}">${esc(state.text)}${blocked?.code === 'threshold' ? `<button class="an-link" data-lg-edit="${esc(r.id)}">재고 기준 수정 →</button>` : help && w.stations[help] ? ` <button class="an-link" data-lg-help="${esc(help)}" data-lg-tab="${blocked?.code === 'budget' ? 'market' : blocked?.code === 'supply' ? 'prod' : blocked?.code === 'construction' ? 'build' : 'store'}">해결 화면 →</button>` : ''}</div>
      <div class="lg-metrics"><span>최근 하역 <b>${num(recent)}</b></span><span>운송 중 <b>${num(cargo)}</b></span><span>판매 <b class="money">${num(r.stats.earned)} cr</b></span></div>
      <details class="lg-fleet" data-lg-fleet="${esc(r.id)}" ${this.expanded.has(r.id) ? 'open' : ''}><summary>${esc(w.groups[r.group]?.name ?? '편대 없음')} · ${ships.length}척 · ${esc(position)}</summary>${ships.map(s => `<div><span>${esc(s.name)} · ${num(cargoSum(s.cargo))}/${num(econOf(s).cargo * techFx(w.companies[r.owner]?.tech).cargoMul)}</span>${s.task.k === 'docked' && cargoSum(s.cargo) > 0 ? `<button class="btn mini" data-lg-unload="${esc(s.id)}">창고로 하역</button>` : ''}<span>${s.state === 'battle' ? '교전 중' : esc(r.cursors[s.id]?.reason ?? (r.manifests[s.id] ? '목적지로 운송' : r.done.includes(s.id) ? '편도 완료' : '적재하러 이동'))}</span></div>`).join('') || '<p>함선을 배정한 뒤 노선을 재개하세요.</p>'}</details>
      <div class="lg-card-actions"><button class="btn mini" data-lg-edit="${esc(r.id)}">설정</button><button class="btn mini" data-lg-map="${esc(r.id)}" ${!ships.length ? 'disabled' : ''}>현재 위치</button><button class="btn mini" data-lg-control="${esc(r.id)}:${r.state === 'running' ? 'pause' : 'resume'}" ${this.busy ? 'disabled' : ''}>${r.state === 'running' ? '일시정지' : r.state === 'complete' ? '다시 운송' : '재개'}</button><button class="btn mini warnb" data-lg-cancel="${esc(r.id)}">취소</button></div>
    </article>`;
  }
  private suggestSupply() { const n = supplyBatch(this.c.state?.stations[this.draft.to], this.draft.item, this.c.state ?? undefined); if (n > 0) { this.draft.minStock = n; this.draft.targetStock = Math.max(n * 2, this.draft.amount); } }
  private form() {
    const w = this.c.state!, d = this.draft;
    const stations = Object.values(w.stations).filter(s => s.public || s.owner === this.c.company || this.hasExternalSource(s.id));
    const options = (value: string, destination = false) => `<option value="">정거장 선택</option>${stations.filter(s => destination ? (d.mode === 'construction' ? s.owner === this.c.company : s.public || s.owner === this.c.company && s.modules.some(m => m.kind === 'core' && m.built)) : s.public || s.owner === this.c.company && s.modules.some(m => m.kind === 'core' && m.built) || s.owner !== this.c.company && this.hasExternalSource(s.id)).map(s => `<option value="${esc(s.id)}" ${s.id === value ? 'selected' : ''}>${esc(s.name)} · ${esc(sysAt(w.systems, s.pos)?.name ?? '')}${s.owner === this.c.company && !s.modules.some(m => m.kind === 'core' && m.built) ? ' · 건설 현장' : ''}</option>`).join('')}`;
    const groups = Object.values(w.groups).filter(g => g.owner === this.c.company && routeShips(w, { group: g.id, owner: g.owner }).length);
    const stock = w.stations[d.from]?.storage[this.c.company] ?? {};
    const items = [...new Set([...Object.keys(ITEMS).filter(id => !ITEMS[id].regional || regionalOn(w)), ...Object.keys(EQUIPMENT), ...Object.keys(stock)])].sort((a, b) => itemName(a).localeCompare(itemName(b), 'ko'));
    const batch = supplyBatch(w.stations[d.to], d.item, w);
    const shipments = this.editId ? Object.values(w.logistics?.[this.editId]?.manifests ?? {}).reduce((n, m) => n + m.amount, 0) : 0;
    const available = qty(w.stations[d.from]?.storage[this.c.company], d.item), destination = qty(w.stations[d.to]?.storage[this.c.company], d.item);
    return `<aside class="lg-editor" data-lg-draft="${this.editKey}"><form data-lg-form><div class="lg-editor-head"><h3>${this.editId ? '노선 설정' : '새 운송 노선'}</h3><button class="btn mini" type="button" data-lg-form-close aria-label="노선 설정 닫기">✕</button></div>
      <label>운송 편대<select data-lg-field="group" data-keep ${this.editId ? 'disabled' : ''}><option value="">편대 선택</option>${groups.map(g => `<option value="${esc(g.id)}" ${g.id === this.group ? 'selected' : ''} ${!this.editId && this.routes.some(r => r.group === g.id) ? 'disabled' : ''}>${esc(g.name)} · ${routeShips(w, { group: g.id, owner: g.owner }).length}척</option>`).join('')}</select></label>
      <label>노선 이름<input data-lg-field="name" maxlength="40" placeholder="출발지 → 목적지" value="${esc(d.name)}"></label>
      <label>출발지<select data-lg-field="from" data-keep>${options(d.from)}</select></label><label>목적지<select data-lg-field="to" data-keep>${options(d.to, true)}</select></label>
      <fieldset><legend>운송 목적</legend><div class="lg-modes">${Object.entries(modes).map(([mode, text]) => `<button type="button" class="btn ${d.mode === mode ? 'on' : ''}" data-lg-mode="${mode}" aria-pressed="${d.mode === mode}">${text}</button>`).join('')}</div></fieldset>
      <label>운송 물품<select data-lg-field="item" data-keep>${items.map(id => `<option value="${esc(id)}" ${d.item === id ? 'selected' : ''}>${esc(itemName(id))}</option>`).join('')}</select></label>
      <div class="lg-stock"><span>출발지 자유 재고 <b>${num(available)}</b></span><span>도착지 자사 재고 <b>${num(destination)}</b></span></div>
      ${w.stations[d.from] && !w.stations[d.from].public && w.stations[d.from].owner !== this.c.company ? '<p class="dim small">사설 정거장의 자사 재고만 외부에서 인수합니다. 정박이나 타사 창고 접근 권한은 부여되지 않습니다.</p>' : ''}
      <label>함선당 회당 최대 적재량<input data-lg-field="amount" type="number" min="1" step="1" required value="${d.amount}"></label>
      ${d.mode === 'supply' ? `<div class="lg-supply"><label>보충 시작 재고<input data-lg-field="minStock" type="number" min="0" step="1" value="${d.minStock ?? 20}"></label><label>목표 재고<input data-lg-field="targetStock" type="number" min="1" step="1" value="${d.targetStock ?? 100}"></label></div><p class="dim small">${batch ? `현재 한 배치에 ${num(batch)}단위 필요. <button class="an-link" type="button" data-lg-suggest>생산 기준 적용</button> ` : ''}이 원료를 사용하는 생산 주문이 있을 때 보충합니다. 운송 중 물량을 포함하며 목표 재고를 넘겨 하역하지 않습니다. 출발지·목적지 중 한 곳에 물류센터가 필요합니다.</p>` : ''}
      ${d.mode === 'construction' ? '<p class="dim small">자사 현장에 실제 필요한 양만, 다른 노선의 운송 중 물량을 고려해 적재합니다. 현장에 접근해 외부에서 반입하며 남는 화물은 함선에 보존합니다. 출발지에서 구매한 자사 보관함 재고를 사용합니다.</p>' : ''}
      <label class="lg-toggle"><input data-lg-field="repeat" type="checkbox" ${d.repeat ? 'checked' : ''}> 반복 운송</label>
      ${d.mode === 'sell' ? `<label class="lg-consent"><input data-lg-sale type="checkbox" ${this.saleConsent ? 'checked' : ''}> <span>이 노선이 적재한 <b>${esc(itemName(d.item))}</b>을 목적지 시장의 실제 가격으로 자동 판매합니다. 미판매분은 함선에 보존합니다.</span></label>` : '<p class="dim small">보관 물품의 소유권을 유지합니다. 기존 함선 화물과 건설 예약 자재는 임의로 사용하지 않습니다.</p>'}
      ${shipments ? `<p class="warn small">운송 중 ${num(shipments)}단위. 목적지 수정은 이 화물에도 적용됩니다. 품목·판매 방식은 현재 화물 배송 후 변경할 수 있습니다.</p>` : ''}
      <button class="btn go lg-submit" type="submit" ${this.busy || !this.group || d.mode === 'sell' && !this.saleConsent ? 'disabled' : ''}>${this.busy ? '서버에 저장 중…' : this.editId ? '설정 저장' : '노선 활성화'}</button>
    </form></aside>`;
  }
  private mining() {
    const w = this.c.state!, groups = Object.values(w.groups).filter(g => g.owner === this.c.company && g.op.k === 'mine');
    if (!groups.length) return '';
    return `<section class="lg-mining"><h3>채굴 연계</h3><p class="dim small">같은 채굴 편대에 배정한 수송선이 광구에서 화물을 회수합니다. 기존 채굴선 직접 하역도 유지됩니다.</p>${groups.map(g => { const op = g.op as Extract<typeof g.op, { k: 'mine' }>; const ss = routeShips(w, { group: g.id, owner: g.owner }); return `<div><span><b>${esc(g.name)}</b> · ${esc(w.fields[op.field]?.name ?? op.field)} → ${esc(w.stations[op.deliver]?.name ?? '자동 선택')} · ${op.sell ? '판매' : '보관'}<small>${esc(g.status)} · 수송선 ${ss.filter(s => s.classId === 'hauler').length}척</small></span><button class="btn mini" data-lg-mine="${esc(g.id)}">편대·채굴 설정</button></div>`; }).join('')}</section>`;
  }
  private bind(list: LogisticsRoute[]) {
    const on = (selector: string, event: string, handler: (e: Event) => void) => { const target = this.el.querySelector(selector); if (target) Reflect.set(target, `on${event}`, handler); };
    this.el.querySelectorAll<HTMLElement>('[data-lg-view]').forEach(b => b.onclick = () => { this.view = b.dataset.lgView as 'pool' | 'routes'; this.editing = false; this.error = ''; this.notice = ''; this.render(); });
    this.el.querySelectorAll<HTMLElement>('[data-pool-new]').forEach(b => b.onclick = () => this.newPoolJob());
    on('[data-proc-policy-open]', 'click', () => { this.policyEditing = !this.policyEditing; this.render(); });
    this.el.querySelectorAll<HTMLElement>('[data-proc-open]').forEach(b => b.onclick = () => { const id = b.dataset.procOpen!, tab = b.dataset.procTab as 'build' | 'prod' | 'yard'; this.close(); this.actions.station(id, tab); });
    on('[data-proc-policy-form]', 'submit', e => {
      e.preventDefault(); const f = e.target as HTMLFormElement, data = new FormData(f);
      const priceItem = String(data.get('priceItem') ?? ''), price = String(data.get('maxUnitPrice') ?? '');
      const protectStation = String(data.get('protectStation') ?? ''), protectItem = String(data.get('protectItem') ?? ''), protect = String(data.get('protectAmount') ?? '');
      if (!!priceItem !== !!price || (!!protectStation || !!protectItem || !!protect) && !(protectStation && protectItem && protect)) { this.error = '최대 단가 또는 보호 재고를 변경하려면 품목과 수량을 모두 입력하세요'; this.render(); return; }
      const settings = { enabled: data.has('enabled'), autoBuy: data.has('autoBuy'), budget: Number(data.get('budget')), minCredits: Number(data.get('minCredits')), maxRisk: Number(data.get('maxRisk')), ...(priceItem ? { priceItem, maxUnitPrice: Number(price) } : {}), ...(protectStation ? { protectStation, protectItem, protectAmount: Number(protect) } : {}) };
      void this.send({ c: 'procPolicy', settings }, '조달 설정을 저장했습니다', () => { this.policyEditing = false; });
    });
    on('[data-pool-form-close]', 'click', () => { this.editing = false; this.render(); });
    this.el.querySelectorAll<HTMLElement>('[data-pool-ship]').forEach(b => b.onclick = () => void this.send({ c: 'poolShips', ships: [b.dataset.poolShip!], on: b.dataset.poolOn === 'true' }, b.dataset.poolOn === 'true' ? '함선이 공용 배차에 참여합니다' : '함선을 제외했습니다. 적재된 화물은 보존됩니다'));
    this.el.querySelectorAll<HTMLElement>('[data-pool-group]').forEach(b => b.onclick = () => { const on = b.dataset.poolOn === 'true', g = this.c.state?.groups[b.dataset.poolGroup!]; const ships = (g?.shipIds ?? []).map(id => this.c.state?.ships[id]).filter(s => s?.classId === 'hauler' && !!s.logisticsPool !== on).map(s => s!.id); if (ships.length) void this.send({ c: 'poolShips', ships, on }, on ? '편대 수송선이 공용 배차에 참여합니다' : '편대 수송선을 제외했습니다. 적재된 화물은 보존됩니다'); });
    this.el.querySelectorAll<HTMLElement>('[data-pool-control]').forEach(b => b.onclick = () => void this.send({ c: 'poolControl', job: b.dataset.poolControl!, action: b.dataset.poolAction as 'pause' | 'resume' | 'cancel' }, '작업 상태를 변경했습니다. 적재된 화물은 함선에 보존됩니다'));
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-pool-field]').forEach(input => { const update = () => { const key = input.dataset.poolField!; if (input instanceof HTMLInputElement && input.type === 'checkbox') this.poolDraft.repeat = input.checked; else if (key === 'amount' || key === 'priority') (this.poolDraft as unknown as Record<string, unknown>)[key] = Number(input.value); else (this.poolDraft as unknown as Record<string, unknown>)[key] = input.value; if (key === 'item' || key === 'kind') this.saleConsent = false; if (input instanceof HTMLSelectElement || input instanceof HTMLInputElement && input.type === 'checkbox') this.render(); }; input.oninput = update; input.onchange = update; });
    on('[data-pool-sale]', 'change', e => { this.saleConsent = (e.target as HTMLInputElement).checked; this.render(); });
    on('[data-pool-form]', 'submit', e => { e.preventDefault(); if (this.poolDraft.kind === 'sell' && !this.saleConsent) return; void this.send({ c: 'poolCreate', request: { ...this.poolDraft } }, '공용 작업을 대기열에 등록했습니다', () => { this.editing = false; }); });
    this.el.querySelectorAll<HTMLElement>('[data-lg-unload]').forEach(b => b.onclick = () => void this.send({ c: 'unloadCargo', ship: b.dataset.lgUnload! }, '하역 명령을 접수했습니다. 노선은 일시정지되며 처리 중이거나 남은 화물은 함선에 보존됩니다'));
    this.el.querySelectorAll<HTMLElement>('[data-lg-close]').forEach(b => b.onclick = () => this.close());
    this.el.querySelectorAll<HTMLElement>('[data-lg-new]').forEach(b => b.onclick = () => this.newRoute());
    on('[data-lg-form-close]', 'click', () => { this.editing = false; this.render(); });
    on('[data-lg-station]', 'change', e => { this.station = (e.target as HTMLSelectElement).value; this.render(); });
    on('[data-lg-filter]', 'change', e => { this.filter = (e.target as HTMLSelectElement).value; this.render(); });
    on('[data-lg-search]', 'input', e => { this.search = (e.target as HTMLInputElement).value; this.render(); });
    this.el.querySelectorAll<HTMLDetailsElement>('[data-lg-fleet]').forEach(d => d.ontoggle = () => { if (d.open) this.expanded.add(d.dataset.lgFleet!); else this.expanded.delete(d.dataset.lgFleet!); });
    this.el.querySelectorAll<HTMLInputElement>('[data-lg-pick]').forEach(b => { b.checked = this.selected.has(b.dataset.lgPick!); b.onchange = () => { if (b.checked) this.selected.add(b.dataset.lgPick!); else this.selected.delete(b.dataset.lgPick!); this.render(); }; });
    on('[data-lg-all]', 'click', () => { for (const r of list) this.selected.add(r.id); this.render(); });
    this.el.querySelectorAll<HTMLElement>('[data-lg-bulk]').forEach(b => b.onclick = () => void this.send({ c: 'routeControl', routes: [...this.selected], action: b.dataset.lgBulk as 'pause' | 'resume' }, '선택 노선에 적용했습니다'));
    this.el.querySelectorAll<HTMLElement>('[data-lg-edit]').forEach(b => b.onclick = () => { const r = this.routes.find(r => r.id === b.dataset.lgEdit); if (r) this.edit(r); });
    this.el.querySelectorAll<HTMLElement>('[data-lg-control]').forEach(b => b.onclick = () => { const [id, action] = b.dataset.lgControl!.split(':'); void this.send({ c: 'routeControl', routes: [id], action: action as 'pause' | 'resume' }, action === 'pause' ? '일시정지했습니다. 화물은 보존됩니다' : '운송을 재개했습니다'); });
    this.el.querySelectorAll<HTMLElement>('[data-lg-cancel]').forEach(b => b.onclick = () => void this.send({ c: 'routeControl', routes: [b.dataset.lgCancel!], action: 'cancel' }, '노선을 취소했습니다. 함선의 화물은 그대로 보존됩니다', () => { if (this.editId === b.dataset.lgCancel) this.editing = false; }));
    for (const attr of ['lgOpen', 'lgHelp']) this.el.querySelectorAll<HTMLElement>(attr === 'lgOpen' ? '[data-lg-open]' : '[data-lg-help]').forEach(b => b.onclick = () => { const id = b.dataset[attr]!; this.close(); this.actions.station(id, (b.dataset.lgTab as 'store' | 'market' | 'prod' | 'build') ?? 'store'); });
    this.el.querySelectorAll<HTMLElement>('[data-lg-map]').forEach(b => b.onclick = () => { const r = this.routes.find(r => r.id === b.dataset.lgMap); if (r) { const ship = routeShips(this.c.state!, r)[0]?.id; this.close(); this.actions.fleet(r.group, ship); } });
    this.el.querySelectorAll<HTMLElement>('[data-lg-mine]').forEach(b => b.onclick = () => { const id = b.dataset.lgMine!; this.close(); this.actions.fleet(id); });
    on('[data-lg-analytics]', 'click', () => { this.close(); this.actions.analytics(); });
    this.el.querySelectorAll<HTMLButtonElement>('[data-lg-mode]').forEach(b => b.onclick = () => { this.draft.mode = b.dataset.lgMode as RouteConfig['mode']; if (this.draft.mode === 'supply' && !this.editId) this.suggestSupply(); this.saleConsent = false; this.render(); });
    on('[data-lg-suggest]', 'click', () => { this.suggestSupply(); this.editKey++; this.render(); });
    on('[data-lg-sale]', 'change', e => { this.saleConsent = (e.target as HTMLInputElement).checked; this.render(); });
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-lg-field]').forEach(input => { const update = () => { const key = input.dataset.lgField!; if (key === 'group') this.group = input.value; else if (input instanceof HTMLInputElement && input.type === 'checkbox') this.draft.repeat = input.checked; else if (['amount', 'minStock', 'targetStock'].includes(key)) (this.draft as unknown as Record<string, unknown>)[key] = Number(input.value); else (this.draft as unknown as Record<string, unknown>)[key] = input.value; if (key === 'item') this.saleConsent = false; if (!this.editId && ['item', 'to'].includes(key) && this.draft.mode === 'supply') this.suggestSupply(); if (input instanceof HTMLSelectElement || input instanceof HTMLInputElement && input.type === 'checkbox') this.render(); }; input.oninput = update; input.onchange = update; });
    on('[data-lg-form]', 'submit', e => { e.preventDefault(); if (this.draft.mode === 'sell' && !this.saleConsent) return; void this.send({ c: 'putRoute', route: this.editId || undefined, group: this.group, config: { ...this.draft } }, this.editId ? '설정을 저장했습니다' : '운송 노선을 활성화했습니다', () => { this.editing = false; }); });
  }
}
