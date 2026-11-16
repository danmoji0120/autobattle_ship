// P12.5 logistics status screen (logisticsV worlds). No routes, no per-item dispatch forms: the server moves
// goods with idle haulers on its own. The player sees haulers, shipments, shortages and problems, and has
// only a few controls: the global switch, per-ship exclusion, pause/resume/cancel of a shipment, and the
// (collapsed) purchase policy.
import type { GameClient } from '../net';
import type { LogisticsJob } from '../../world/autonomousLogistics';
import type { WGroup, WShip, Op } from '../../world/types';
import { itemName } from '../../world/industry';
import { haulerAvailability, poolMember } from '../../world/haulers';
import { morph, trackSelects } from '../../ui/morph';
import { econOf, growthOn } from '../../world/hullops';
import { salesPanelHtml, bindSalesPanel } from './salesPolicyUi';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const num = (v: number) => (Math.round(v * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
const STATE = { queued: '배차 대기', active: '운송 중', waiting: '조건 대기', paused: '일시정지', complete: '완료', cancelled: '취소' } as const;
const SOURCE = { construction: '시설 건설', production: '생산', ship: '함선 건조' } as const;
interface Actions { station(id: string): void; fleet(group: string, ship?: string): void; close(): void }

export class AutoLogisticsPanel {
  private el = document.createElement('div');
  private open = new Set<string>(); private error = ''; private notice = ''; private busy = false; private closed = false;
  private onSnap = () => this.render();
  private key = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopImmediatePropagation(); this.close(); } };
  constructor(private root: HTMLElement, private c: GameClient, private actions: Actions) {
    this.el.className = 'modal lg-modal autolg'; this.el.tabIndex = -1;
    this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-label', '물류 현황'); this.el.setAttribute('aria-modal', 'true');
    this.el.onkeydown = e => e.stopPropagation(); this.el.onclick = e => { if (e.target === this.el) this.close(); };
    root.appendChild(this.el); trackSelects(this.el); c.onSnap.push(this.onSnap); window.addEventListener('keydown', this.key, true); this.el.focus(); this.render();
  }
  close() { if (this.closed) return; this.closed = true; const i = this.c.onSnap.indexOf(this.onSnap); if (i >= 0) this.c.onSnap.splice(i, 1); window.removeEventListener('keydown', this.key, true); this.el.remove(); this.actions.close(); document.getElementById('logisticsBtn')?.focus(); }
  private async send(command: Parameters<GameClient['cmd']>[0], ok: string) {
    if (this.busy) return; this.busy = true; this.error = ''; this.render();
    try { const err = await this.c.cmd(command); if (this.closed) return; if (err) this.error = err; else this.notice = ok; }
    catch { if (!this.closed) this.error = '연결을 확인하고 다시 시도하세요'; }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
  private opOf(g: WGroup): Op { const w = this.c.state!; let cur: WGroup | undefined = g; while (cur && !cur.override && cur.parentId) cur = w.groups[cur.parentId]; return cur ? cur.op : g.op; }
  private stn(id: string) { return esc(this.c.state!.stations[id]?.name ?? id); }

  private render() {
    if (this.closed) return;
    const w = this.c.state; if (!w) { this.el.innerHTML = '<div class="panel lg-box"><p>서버의 물류 상태를 기다리는 중…</p></div>'; return; }
    const me = this.c.company, co = w.companies[me], host = { st: w as any, opOf: (g: WGroup) => this.opOf(g) };
    const mine = Object.values(w.ships).filter(s => s.owner === me && econOf(s).cargo > 0 && s.classId !== 'miner' && s.classId !== 'constructor' && (!econOf(s).military || s.logisticsPool));
    const rows = mine.map(s => ({ s, a: haulerAvailability(host as any, s), member: poolMember(w as any, s) }));
    const moving = rows.filter(r => r.s.logisticsJob), ready = rows.filter(r => r.a.ok), blocked = rows.filter(r => !r.a.ok && !r.s.logisticsJob);
    const jobs = Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === me);
    const liveJobs = jobs.filter(j => j.state !== 'complete' && j.state !== 'cancelled').sort((a, b) => Number(!!b.ship) - Number(!!a.ship) || b.priority - a.priority || a.created - b.created || a.id.localeCompare(b.id));
    // a shipment waiting only for a free hauler is normal queueing, not a problem; it stays in the shipment list
    const problems = liveJobs.filter(j => j.state === 'paused' || j.state === 'waiting' && !!j.code && j.code !== 'ship');
    const queuedForShip = liveJobs.filter(j => j.state === 'waiting' && j.code === 'ship').length;
    const plans = Object.values(w.procurementPlans ?? {}).filter(p => p.owner === me && p.state !== 'closed' && p.shortage > 0).sort((a, b) => b.priority - a.priority || a.created - b.created);
    const compat = Object.values(w.logistics ?? {}).filter(r => r.owner === me);
    const recent = jobs.filter(j => j.state === 'complete' && w.time - j.updated < 3600).reduce((n, j) => n + j.delivered, 0);
    const lostH = jobs.filter(j => w.time - j.updated < 3600).reduce((n, j) => n + j.lost, 0);
    const on = co?.autoLogistics !== false, policy = co?.procurement;
    morph(this.el, `<div class="panel lg-box autolg-box">
      <header class="lg-head"><div><div class="an-eyebrow">SIDERARIUM / LOGISTICS</div><h2>물류 현황 <span>대기 중인 수송선이 필요한 자재를 자동으로 운반합니다</span></h2></div>
        <div class="lg-actions"><button class="btn ${on ? 'go' : 'warn'}" data-al-toggle aria-pressed="${on}" ${this.busy ? 'disabled' : ''}>${on ? '자동 물류 켜짐' : '자동 물류 꺼짐'}</button><button class="btn" data-al-close aria-label="닫기">닫기</button></div></header>
      <div class="lg-summary autolg-summary">
        <div><span>가용 수송선</span><b>${ready.length}</b></div><div><span>운송 중</span><b>${moving.length}</b></div><div><span>이용 불가</span><b>${blocked.length}</b></div>
        <div><span>진행 중 운송</span><b>${liveJobs.length}</b></div><div><span>부족 자재</span><b>${plans.length}</b></div><div><span>문제</span><b class="${problems.length ? 'warn' : ''}">${problems.length}</b></div>
      </div>
      <p class="dim small autolg-note">최근 1시간 배송 ${num(recent)} · 손실 ${num(lostH)}${queuedForShip ? ` · 수송선 대기 ${queuedForShip}건 — ${ready.length ? '배정 중' : '가용 수송선이 없어 운송이 끝나는 대로 배정합니다 (수송선을 늘리면 빨라집니다)'}` : ''}${on ? '' : ' · <b>자동 물류가 꺼져 있어 새 운송을 시작하지 않습니다 (적재된 화물은 끝까지 운송)</b>'}</p>
      ${this.error ? `<div class="lg-feedback warn" role="alert">${esc(this.error)}</div>` : this.notice ? `<div class="lg-feedback good" role="status">${esc(this.notice)}</div>` : ''}
      ${problems.length ? `<section class="pool-section"><div class="pool-section-head"><div><h3>문제</h3><p>원인이 해소되면 자동으로 재시도합니다. 필요하면 일시정지·재개·취소하세요.</p></div></div><div class="lg-cards">${problems.map(j => this.job(j)).join('')}</div></section>` : ''}
      <section class="pool-section"><div class="pool-section-head"><div><h3>현재 운송</h3><p>품목 · 수량 · 목적지. 항목을 눌러 자세히 봅니다.</p></div><span>${liveJobs.length}건</span></div>
        <div class="lg-cards">${liveJobs.filter(j => !problems.includes(j)).map(j => this.job(j)).join('') || '<p class="dim">진행 중인 운송이 없습니다. 건설·생산·조선에 자재가 부족하면 자동으로 시작됩니다.</p>'}</div></section>
      <section class="pool-section"><div class="pool-section-head"><div><h3>부족 자재</h3><p>필요 − 현지 재고 − 운송 중·예정 물량. 자사 재고가 없으면 자동 구매 정책에 따릅니다.</p></div><span>${plans.length}건</span></div>
        ${plans.length ? `<ul class="autolg-list">${plans.map(p => `<li><b>${esc(itemName(p.item))} ${num(p.shortage)}</b> <span class="dim">· ${this.stn(p.station)} ${SOURCE[p.sourceKind]}</span><div class="dim small">${esc(p.reason || '대기')}</div></li>`).join('')}</ul>` : '<p class="dim">부족한 자재가 없습니다.</p>'}</section>
      ${growthOn(w) ? salesPanelHtml(w, me, this.busy) : ''}
      <section class="pool-section"><div class="pool-section-head"><div><h3>수송선</h3><p>등록할 필요 없습니다. 직접 명령을 받은 함선은 명령이 끝나 대기하면 자동 물류로 돌아옵니다.</p></div><span>${rows.length}척</span></div>
        <ul class="autolg-list">${rows.map(r => this.ship(r.s, r.a, r.member)).join('') || '<li class="dim">화물칸이 있는 수송선이 없습니다.</li>'}</ul></section>
      ${compat.length ? `<section class="pool-section"><div class="pool-section-head"><div><h3>기존 반복 노선 (호환 모드)</h3><p>이전에 설정한 반복 판매·재고 이동입니다. 새로 만들 수 없으며 정지·재개·취소만 가능합니다.</p></div></div>
        <ul class="autolg-list">${compat.map(r => `<li><b>${esc(r.config.name)}</b> <span class="dim">· ${esc(itemName(r.config.item))} · ${r.state === 'running' ? '운용 중' : r.state === 'paused' ? '정지' : '완료'}</span><div class="autolg-btns"><button class="btn mini" data-al-route="${esc(r.id)}" data-al-act="${r.state === 'paused' ? 'resume' : 'pause'}">${r.state === 'paused' ? '재개' : '정지'}</button><button class="btn mini" data-al-route="${esc(r.id)}" data-al-act="cancel">취소 (화물 보존)</button></div></li>`).join('')}</ul></section>` : ''}
      <details class="pool-section autolg-adv" ${this.open.has('adv') ? 'open' : ''} data-al-adv><summary><b>고급 설정 — 자재 조달·자동 구매</b> <span class="dim">자동 구매 ${policy?.autoBuy ? `허용 · 예산 ${num(policy.spent)} / ${num(policy.budget)} cr` : '꺼짐 (기본)'}</span></summary>
        <form class="autolg-form" data-al-policy>
          <label><input type="checkbox" name="enabled" ${policy?.enabled === false ? '' : 'checked'}> 부족 자재를 자사 재고에서 자동 운반</label>
          <label><input type="checkbox" name="autoBuy" ${policy?.autoBuy ? 'checked' : ''}> 자사 재고가 없으면 시장에서 자동 구매</label>
          <label>구매 예산 (cr)<input name="budget" type="number" min="0" step="100" value="${policy?.budget ?? 0}"></label>
          <label>최소 보유 크레딧<input name="minCredits" type="number" min="0" step="100" value="${policy?.minCredits ?? 0}"></label>
          <label>허용 경로 위험 (0–100)<input name="maxRisk" type="number" min="0" max="100" value="${policy?.maxRisk ?? 100}"></label>
          <p class="dim small">품목별 최대 단가: ${Object.entries(policy?.maxPrice ?? {}).map(([i, p]) => `${esc(itemName(i))} ${num(p)} cr`).join(' · ') || '없음 (단가 상한이 없는 품목은 사지 않습니다)'}</p>
          <label>품목<input name="priceItem" placeholder="예: alloy" autocomplete="off"></label><label>최대 단가<input name="maxUnitPrice" type="number" min="0" step="1"></label>
          <button class="btn mini go" type="submit" ${this.busy ? 'disabled' : ''}>정책 저장</button>
        </form></details>
    </div>`);
    this.bind();
  }
  private job(j: LogisticsJob) {
    const w = this.c.state!, ship = j.ship ? w.ships[j.ship] : j.held ? w.ships[j.held.ship] : undefined, open = this.open.has(j.id);
    const plan = j.procurement ? w.procurementPlans?.[j.procurement] : undefined;
    const why = j.stow ? '함선에 남은 화물을 보관 창고로 하역' : plan ? `${this.stn(plan.station)} ${SOURCE[plan.sourceKind]}` : '회사 목표·직접 요청';
    const flee = ship && w.groups[ship.groupId]?.fleeing ? '적대 세력 회피 중 — 위협이 사라지면 재개' : '';
    const status = flee || j.reason || (j.ship ? (j.carried > 0 ? `${esc(ship?.name ?? '')} — ${this.stn(j.to)}로 운송` : `${esc(ship?.name ?? '')} — ${this.stn(j.from)}에서 적재하러 이동`) : '가용 수송선 배정 대기');
    const forShip = j.state === 'waiting' && j.code === 'ship';
    const cls = j.state === 'paused' ? 'paused' : j.state === 'waiting' && !forShip ? 'waiting' : '';
    return `<article class="lg-card ${cls}" data-al-job="${esc(j.id)}"><button class="autolg-row" data-al-open="${esc(j.id)}" aria-expanded="${open}">
        <b>${esc(itemName(j.item))} ${num(j.amount - j.cycleDelivered)}</b><span>${j.stow ? '' : `${this.stn(j.from)} → `}${this.stn(j.to)}</span><span class="lg-badge ${forShip ? 'queued' : j.state}">${j.held ? '수동 명령 대기' : forShip ? '수송선 대기' : STATE[j.state]}</span></button>
      <div class="lg-route-status ${(j.reason && !forShip) || flee ? 'warn' : 'dim'}">${status}</div>
      ${open ? `<div class="lg-metrics"><span>목적 <b>${why}</b></span><span>배송 완료 <b>${num(j.delivered)}</b></span><span>적재·운송 중 <b>${num(j.carried)}</b></span><span>출발지 예약 <b>${num(j.reserved)}</b></span>${j.lost ? `<span>손실 <b>${num(j.lost)}</b></span>` : ''}${j.withdrawn ? `<span>회수(함선 보존) <b>${num(j.withdrawn)}</b></span>` : ''}${ship ? `<span>함선 <button class="an-link" data-al-ship="${esc(ship.id)}">${esc(ship.name)}</button></span>` : ''}</div>` : ''}
      ${j.state === 'paused' || j.state === 'waiting' || open ? `<div class="lg-card-actions">${j.state === 'paused' ? `<button class="btn mini" data-al-job-act="resume" data-al-id="${esc(j.id)}">재개</button>` : `<button class="btn mini" data-al-job-act="pause" data-al-id="${esc(j.id)}">일시정지</button>`}<button class="btn mini" data-al-job-act="cancel" data-al-id="${esc(j.id)}">취소${j.carried > 0 ? ' (화물 보존)' : ''}</button></div>` : ''}
    </article>`;
  }
  private ship(s: WShip, a: ReturnType<typeof haulerAvailability>, member: boolean) {
    const w = this.c.state!, j = s.logisticsJob ? w.logisticsJobs?.[s.logisticsJob] : undefined;
    const text = j ? `${esc(itemName(j.item))} ${num(j.carried || j.reserved || j.amount)} → ${this.stn(j.to)}` : a.ok ? '대기 — 다음 운송 가능' : esc(a.why);
    const tone = j ? 'good' : a.ok ? '' : 'warn';
    const manual = !a.ok && a.code === 'manual';
    return `<li class="autolg-ship"><button class="an-link" data-al-ship="${esc(s.id)}">${esc(s.name)}</button> <span class="dim">${esc(w.groups[s.groupId]?.name ?? '')} · 내구 ${Math.round(s.hp * 100)}%</span><div class="small ${tone}">${text}</div>
      <div class="autolg-btns">${manual ? `<button class="btn mini" data-al-idle="${esc(s.groupId)}" title="편대 명령을 대기로 바꿔 자동 물류로 돌려보냅니다">편대 대기 → 자동 물류</button>` : ''}<button class="btn mini" data-al-excl="${esc(s.id)}" data-al-on="${member ? 'false' : 'true'}">${member ? '자동 물류 제외' : '자동 물류 포함'}</button></div></li>`;
  }
  private bind() {
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelectorAll<T>(sel);
    bindSalesPanel(this.el, (cmd, ok) => void this.send(cmd, ok), msg => { this.error = msg; this.render(); });
    q('[data-al-close]').forEach(b => b.onclick = () => this.close());
    q('[data-al-toggle]').forEach(b => b.onclick = () => { const on = this.c.state?.companies[this.c.company]?.autoLogistics !== false; this.send({ c: 'autoLogistics', on: !on }, on ? '새 자동 운송을 멈췄습니다' : '자동 물류를 켰습니다'); });
    q('[data-al-open]').forEach(b => b.onclick = () => { const id = b.dataset.alOpen!; if (this.open.has(id)) this.open.delete(id); else this.open.add(id); this.render(); });
    q('[data-al-job-act]').forEach(b => b.onclick = () => this.send({ c: 'poolControl', job: b.dataset.alId!, action: b.dataset.alJobAct as 'pause' | 'resume' | 'cancel' }, b.dataset.alJobAct === 'cancel' ? '운송을 취소했습니다 — 실린 화물은 함선에 보존되어 창고로 하역됩니다' : '변경했습니다'));
    q('[data-al-excl]').forEach(b => b.onclick = () => this.send({ c: 'poolShips', ships: [b.dataset.alExcl!], on: b.dataset.alOn === 'true' }, b.dataset.alOn === 'true' ? '자동 물류에 포함했습니다' : '자동 물류에서 제외했습니다 — 실린 화물은 함선에 보존'));
    q('[data-al-idle]').forEach(b => b.onclick = () => this.send({ c: 'setOp', group: b.dataset.alIdle!, op: { k: 'idle' } }, '편대가 대기 상태가 되어 자동 물류로 돌아갑니다'));
    q('[data-al-route]').forEach(b => b.onclick = () => this.send({ c: 'routeControl', routes: [b.dataset.alRoute!], action: b.dataset.alAct as 'pause' | 'resume' | 'cancel' }, '노선을 변경했습니다'));
    q('[data-al-ship]').forEach(b => b.onclick = () => { const s = this.c.state?.ships[b.dataset.alShip!]; if (s) { this.actions.fleet(s.groupId, s.id); this.close(); } });
    q<HTMLDetailsElement>('[data-al-adv]').forEach(d => d.ontoggle = () => { if (d.open) this.open.add('adv'); else this.open.delete('adv'); });
    q<HTMLFormElement>('[data-al-policy]').forEach(f => f.onsubmit = e => {
      e.preventDefault(); const d = new FormData(f), n = (k: string) => Number(d.get(k) || 0), item = String(d.get('priceItem') ?? '').trim();
      this.send({ c: 'procPolicy', settings: { enabled: d.get('enabled') === 'on', autoBuy: d.get('autoBuy') === 'on', budget: n('budget'), minCredits: n('minCredits'), maxRisk: Math.min(100, n('maxRisk')), ...(item ? { priceItem: item, maxUnitPrice: n('maxUnitPrice') } : {}) } }, '조달 정책을 저장했습니다');
    });
  }
}
