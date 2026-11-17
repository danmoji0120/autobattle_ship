// B-2 military business (군사 계약): the PMC contract screen and the security / veteran first-business guide.
// It reads the world through world/military.ts `milGuide` (the same pure view the tests use) and acts only through
// ordinary server commands: `accept` (with the chosen fleet), `milDispatch` (re-sortie), `milCancel` (abandon or
// withdraw) and `milPostEscort` (company-to-company escort job). Nothing here is shown on the strategic HUD itself.
import type { GameClient } from '../net';
import type { Cmd } from '../../world/sim';
import type { WorldState } from '../../world/types';
import { milGuide, MIL_NAME, type MilGuide, type MilOffer, type MilType } from '../../world/military';
import { econOf } from '../../world/hullops';
import { morph, trackSelects } from '../../ui/morph';

type Tab = 'board' | 'active' | 'results' | 'post';
interface Actions { close(): void; fleet?(group: string): void; station?(id: string): void }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n0 = (v: number) => Math.round(v).toLocaleString();
const sgn = (v: number) => `${v >= 0 ? '+' : '−'}${n0(Math.abs(v))}`;
const mins = (s: number) => s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분` : `${Math.max(1, Math.round(s / 60))}분`;
const FIT: Record<MilOffer['fit'], [string, string]> = { ok: ['적합', 'good'], weak: ['전력 부족', 'warn'], danger: ['위험', 'bad'] };
const TYPE_HINT: Record<MilType, string> = {
  patrol: '지정 항로를 돌며 성계에 머문 시간으로 평가. 정박 시간은 근무로 치지 않음. 저위험·안정 수입',
  defend: '지정 지점 반경 안에 머문 시간으로 평가, 격퇴 시 추가 보너스. 저~중위험',
  escort: '실제 상선단과 함께 출항해 목적지 도착으로 평가. 호위율·보호 대상 손상으로 보너스 결정',
  hunt: '실제 해적 무리·소굴을 격파하면 완수. 계약 보수와 별도로 전투 현상금',
  strike: '대형 해적 세력·고위협 항로 대상. 보수가 크지만 함대 손실 위험이 큼',
};

export class MilitaryPanel {
  private el = document.createElement('div');
  private closed = false; private busy = false; private error = ''; private notice = '';
  private tab: Tab = 'board'; private typeFilter: MilType | 'all' = 'all'; private fitOnly = false;
  private pick: Record<string, string> = {};
  private focus = '';
  private confirm = '';
  private postGroup = ''; private postTo = ''; private postReward = 3000;
  private guideKey = ''; private last = 0;
  private onSnap = () => { const t = performance.now(); if (t - this.last > 900) this.render(); };
  private key = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopImmediatePropagation(); this.close(); } };

  constructor(root: HTMLElement, private c: GameClient, private actions: Actions, focus?: string) {
    if (focus) { this.focus = focus; const k = this.w?.contracts[focus]; this.tab = k?.takenBy === this.me ? 'active' : 'board'; }
    else if (this.view()?.active.length) this.tab = 'active';
    this.el.className = 'modal lg-modal mil-modal'; this.el.tabIndex = -1;
    this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-label', '군사 계약'); this.el.setAttribute('aria-modal', 'true');
    this.el.onkeydown = e => e.stopPropagation();
    this.el.onclick = e => this.click(e);
    this.el.onchange = e => this.change(e.target as HTMLSelectElement | HTMLInputElement);
    this.el.oninput = e => { const t = e.target as HTMLInputElement; if (t.dataset.reward !== undefined) this.postReward = Math.floor(Number(t.value) || 0); };
    root.appendChild(this.el); trackSelects(this.el); c.onSnap.push(this.onSnap); window.addEventListener('keydown', this.key, true);
    this.render(); this.el.focus();
    if (this.focus) requestAnimationFrame(() => this.el.querySelector(`[data-k="${CSS.escape(this.focus)}"]`)?.scrollIntoView({ block: 'center' }));
  }
  close() { if (this.closed) return; this.closed = true; const i = this.c.onSnap.indexOf(this.onSnap); if (i >= 0) this.c.onSnap.splice(i, 1); window.removeEventListener('keydown', this.key, true); this.el.remove(); this.actions.close(); document.getElementById('milBtn')?.focus(); }

  private get me() { return this.c.company; }
  private get w() { return this.c.state as unknown as WorldState | null; }
  private view(): MilGuide | null { const w = this.w; return w ? milGuide(w, this.me) : null; }

  private async send(command: Cmd, success: string) {
    if (this.busy) return; this.busy = true; this.error = ''; this.notice = ''; this.render();
    try { const error = await this.c.cmd(command); if (this.closed) return; if (error) this.error = error; else this.notice = success; }
    catch { if (!this.closed) this.error = '연결을 확인하고 다시 시도하세요'; }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }

  private change(t: HTMLSelectElement | HTMLInputElement) {
    const d = t.dataset;
    if (d.pick !== undefined) { this.pick[d.pick] = t.value; return; }
    if (d.tfilter !== undefined) { this.typeFilter = t.value as MilType | 'all'; return this.render(); }
    if (d.fitonly !== undefined) { this.fitOnly = (t as HTMLInputElement).checked; return this.render(); }
    if (d.pgroup !== undefined) { this.postGroup = t.value; return this.render(); }
    if (d.pto !== undefined) { this.postTo = t.value; return this.render(); }
  }

  private click(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]'); if (!b || this.busy) return;
    const a = b.dataset.a!, id = b.dataset.id ?? '';
    const g = this.view();
    if (a === 'close') return this.close();
    if (a === 'tab') { this.tab = id as Tab; this.confirm = ''; this.error = ''; this.notice = ''; return this.render(); }
    if (a === 'accept') {
      // below the recommended strength: a second click confirms the risk
      const offer = g?.board.find(o => o.id === id);
      if (offer && offer.fit !== 'ok' && this.confirm !== `acc:${id}`) { this.confirm = `acc:${id}`; return this.render(); }
      this.confirm = '';
      const group = this.pick[id] || this.defaultFleet(g!, id);
      if (!group) { this.error = '투입할 전투 함대가 없습니다'; return this.render(); }
      this.tab = 'active';
      return void this.send({ c: 'accept', contract: id, group }, '수주 — 함대가 출격했습니다. 진행 탭에서 상황을 확인하세요');
    }
    if (a === 'sortie') return void this.send({ c: 'milDispatch', contract: id }, '재출격 명령을 내렸습니다');
    if (a === 'cancel') {
      if (this.confirm !== id) { this.confirm = id; return this.render(); }
      this.confirm = '';
      return void this.send({ c: 'milCancel', contract: id }, '계약을 정리했습니다 — 남은 예치금은 발주처에 반환됩니다');
    }
    if (a === 'fleet') { this.close(); this.actions.fleet?.(id); return; }
    if (a === 'station') { this.close(); this.actions.station?.(id); return; }
    if (a === 'post') {
      if (!this.postGroup || !this.postTo) { this.error = '선단과 목적지를 고르세요'; return this.render(); }
      return void this.send({ c: 'milPostEscort', group: this.postGroup, to: this.postTo, reward: this.postReward }, '호위 의뢰를 게시했습니다 — 보수는 지금 예치되었고 수주가 없으면 반환됩니다');
    }
  }

  /** the strongest idle fleet (the same one the board's fit column assumes) */
  private defaultFleet(g: MilGuide, _id: string): string { return g.fleets.filter(f => !f.busy).sort((a, b) => b.power - a.power)[0]?.id ?? ''; }

  private render() {
    if (this.closed) return;
    this.last = performance.now();
    const w = this.w;
    const head = (sub = '') => `<header class="lg-head"><div><div class="an-eyebrow">SIDERARIUM / MILITARY CONTRACTS</div><h2>군사 계약${sub}</h2></div><div class="lg-actions"><button class="btn" data-a="close" aria-label="군사 계약 닫기">✕</button></div></header>`;
    if (!w) { morph(this.el, `<div class="panel lg-box mil-box">${head()}<div class="mil-empty">회사 상태를 기다리는 중…</div></div>`); return; }
    const g = this.view();
    if (!g) { morph(this.el, `<div class="panel lg-box mil-box">${head()}<div class="mil-empty">이 월드에서는 군사 계약(B-2)이 꺼져 있습니다. 기존 현상금·소굴 계약은 정거장 계약 탭에서 볼 수 있습니다.</div></div>`); return; }
    const tabs: [Tab, string, number][] = [['board', '계약 게시판', g.board.length], ['active', '진행 중', g.active.length], ['results', '정산 기록', g.results.length], ['post', '호위 의뢰', g.posted.length]];
    const t = g.totals;
    morph(this.el, `<div class="panel lg-box mil-box">${head(` <span>보유 ${n0(g.credits)} cr · 전투 함대 ${g.fleets.length}개 · 완수 ${t.ok} / 실패 ${t.fail}</span>`)}
      ${this.error ? `<div class="lg-feedback warn" role="alert">${esc(this.error)}</div>` : this.notice ? `<div class="lg-feedback good" role="status">${esc(this.notice)}</div>` : ''}
      <div class="mil-scroll">
        ${this.guideHtml(g)}
        <nav class="mil-tabs" role="tablist">${tabs.map(([id, name, n]) => `<button class="btn${this.tab === id ? ' on' : ''}" role="tab" aria-selected="${this.tab === id}" data-a="tab" data-id="${id}">${name}${n ? ` <span class="mil-n">${n}</span>` : ''}</button>`).join('')}</nav>
        <section class="mil-body">${this.tab === 'board' ? this.boardHtml(g) : this.tab === 'active' ? this.activeHtml(g) : this.tab === 'results' ? this.resultsHtml(g) : this.postHtml(g)}</section>
      </div>
      <footer class="lg-foot"><span>보수는 발주 정거장 예산에서 수주 때 예치 · 완수 시 기본 보수 + 성과 보너스, 실패·취소·만료 시 남은 금액은 발주처로 정확히 반환 · 전투 현상금은 계약 보수와 따로 정산</span></footer></div>`);
  }

  // ------------------------------------------------------------------------------- first business

  private guideHtml(g: MilGuide): string {
    const fleets = g.fleets.length ? `<div class="mil-fleets">${g.fleets.map(f => `<div class="mil-fleet${f.busy ? ' busy' : ''}">
        <div><b>${esc(f.name)}</b> <small>${f.ships}척 · 전력 ${f.power}${f.power < f.full ? ` / 정상 ${f.full}` : ''} · 선체 ${Math.round(f.hp * 100)}%</small></div>
        <small>${esc(f.where)}${f.busy ? ` · <span class="mil-busy">${esc(f.busy)}</span>` : ' · 대기'}${f.officer ? ` · 지휘 ${esc(f.officer.name)} Lv${f.officer.level}${f.officer.top ? ` (${esc(f.officer.top)})` : ''}` : ' · <span class="warn">지휘관 없음</span>'}</small>
        <button class="an-link" data-a="fleet" data-id="${f.id}">함대 보기</button></div>`).join('')}</div>`
      : '<div class="mil-fleets"><div class="warn">전투 함대가 없습니다 — 조선소에서 초계함·호위함을 사면 계약을 맡을 수 있습니다.</div></div>';
    const steps = g.first && !g.done ? `<ol class="mil-steps">${g.steps.map(s => `<li class="${s.done ? 'done' : ''}">${s.done ? '✓' : '·'} ${esc(s.label)}</li>`).join('')}</ol>` : '';
    const prog = g.first && !g.done ? `<div class="mil-goal">첫 사업 목표: 자금 ${n0(g.credits)} / 창업 자금 ${n0(g.start)} cr 초과${g.debt > 0 ? ` · 미납 ${n0(g.debt)} cr 없음` : ''}</div>` : g.first ? '<div class="mil-goal good">첫 사업 달성 ✓ — 이제 더 큰 계약이나 함대 확장을 노려 보세요</div>' : '';
    const notes = [...g.warnings.map(x => `<li class="warn">${esc(x)}</li>`), ...g.next.slice(0, 4).map(x => `<li>${esc(x)}</li>`)].join('');
    const t = g.totals;
    const pl = g.results.length ? `<div class="mil-pl"><span>계약 보수 <b>${n0(t.pay + t.bonus)}</b></span><span>현상금 <b>${n0(t.bounty)}</b></span><span>수리비 <b>−${n0(t.repair)}</b></span><span>손실 함선 <b>−${n0(t.lost)}</b></span><span>운영비·급여 <b>−${n0(t.upkeep + t.salary)}</b></span><span>작전 순손익 <b class="${t.net >= 0 ? 'good' : 'bad'}">${sgn(t.net)}</b></span></div>` : '';
    return `<section class="mil-guide"><div class="mil-guide-l">${g.first ? '<h3>첫 군사 사업 안내</h3>' : '<h3>함대 현황</h3>'}${steps}${prog}${pl}</div>
      <div class="mil-guide-r">${fleets}${notes ? `<ul class="mil-next">${notes}</ul>` : ''}</div></section>`;
  }

  // ------------------------------------------------------------------------------------- board

  private boardHtml(g: MilGuide): string {
    const w = this.w!;
    let list = g.board.filter(o => (this.typeFilter === 'all' || o.type === this.typeFilter) && (!this.fitOnly || o.fit === 'ok'));
    if (this.focus) { const i = list.findIndex(o => o.id === this.focus); if (i > 0) list = [list[i], ...list.slice(0, i), ...list.slice(i + 1)]; }
    const idle = g.fleets.filter(f => !f.busy);
    const filters = `<div class="lg-filters"><label>종류<select data-tfilter>${(['all', 'patrol', 'escort', 'defend', 'hunt', 'strike'] as const).map(t => `<option value="${t}"${this.typeFilter === t ? ' selected' : ''}>${t === 'all' ? '전체' : MIL_NAME[t]}</option>`).join('')}</select></label>
      <label class="mil-chk"><input type="checkbox" data-fitonly${this.fitOnly ? ' checked' : ''}> 지금 함대에 적합한 계약만</label></div>`;
    if (!list.length) return `${filters}<div class="lg-empty"><h3>조건에 맞는 계약이 없습니다</h3><p>계약은 정거장마다 몇 분 간격으로 새로 게시됩니다. 호위 계약은 길드 상선단이 정박할 때 생깁니다.</p></div>`;
    const cards = list.map(o => {
      const k = w.contracts[o.id];
      const [fl, fc] = FIT[o.fit];
      const sel = this.pick[o.id] || this.defaultFleet(g, o.id);
      const opts = idle.map(f => `<option value="${f.id}"${f.id === sel ? ' selected' : ''}>${esc(f.name)} · 전력 ${f.power}${f.power < o.power * 0.85 ? ' (부족)' : ''}</option>`).join('');
      const left = Math.max(0, o.expires - w.time);
      return `<article class="lg-card mil-card ${o.fit}${this.focus === o.id ? ' focus' : ''}" data-k="${o.id}">
        <div class="lg-card-top"><b>${esc(o.title)}</b><span class="lg-badge mil-t-${o.type}">${MIL_NAME[o.type]}</span></div>
        <div class="mil-desc">${esc(o.desc)}</div>
        <div class="mil-where">${esc(o.station)} 게시 · ${esc(o.sys)} · ${o.jumps === 0 ? '현 위치 성계' : `${o.jumps}회 도약`}${o.poster ? ` · 의뢰사 ${esc(o.poster)}` : ''} · 게시 ${mins(left)} 남음${k?.stationId ? ` <button class="an-link" data-a="station" data-id="${esc(k.stationId)}">정거장</button>` : ''}</div>
        <div class="lg-metrics mil-metrics">
          <span>기본 보수<b>${n0(o.base)}</b></span><span>성과 보너스<b>최대 ${n0(o.bonus)}</b></span><span>예상 시간<b>${mins(o.est)}</b></span>
          <span>위험<b class="${o.risk >= 1.8 ? 'bad' : o.risk >= 1.3 ? 'warn' : ''}">${esc(o.riskLabel)}</b></span><span>권장 전력<b>${o.power}</b></span><span>예상 순익<b class="${o.netMin >= 0 ? 'good' : 'warn'}">${sgn(o.netMin)} ~ ${sgn(o.netMax)}</b></span>
        </div>
        <div class="mil-fit ${fc}">${fl}${o.warn ? ` — ${esc(o.warn)}` : o.fit !== 'ok' ? ` — 가장 강한 대기 함대 전력이 권장의 ${o.fit === 'weak' ? '55~85%' : '55% 미만'}입니다` : ''} · 예상 운영비 ${n0(o.cost)} cr (손상·손실 미포함)</div>
        <div class="mil-hint">${TYPE_HINT[o.type]}</div>
        ${this.confirm === `acc:${o.id}` ? '<div class="warn mil-hint">권장 전력에 못 미칩니다. 실패하면 보수 없이 신용도가 떨어지고, 전투에서 함선을 잃으면 그 손실은 회사가 집니다. 한 번 더 누르면 수주합니다.</div>' : ''}
        <div class="lg-card-actions">${idle.length ? `<label class="mil-pick">투입 함대<select data-pick="${o.id}" aria-label="투입 함대">${opts}</select></label><button class="btn ${o.fit === 'ok' ? 'go' : 'warnb'}" data-a="accept" data-id="${o.id}">${o.fit === 'ok' ? '수주 · 출격' : this.confirm === `acc:${o.id}` ? '위험 감수 — 수주 확정' : '권장 전력 미달 — 수주'}</button>` : '<span class="warn">대기 중인 전투 함대 없음</span>'}</div>
      </article>`;
    }).join('');
    return `${filters}<div class="lg-cards">${cards}</div>`;
  }

  // ------------------------------------------------------------------------------------ active

  private activeHtml(g: MilGuide): string {
    if (!g.active.length) return `<div class="lg-empty"><h3>진행 중인 계약이 없습니다</h3><p>계약 게시판에서 함대 전력에 맞는 계약을 고르세요. 수주하면 지정한 함대가 바로 출격합니다.</p><button class="btn go" data-a="tab" data-id="board">계약 게시판</button></div>`;
    return `<div class="lg-cards">${g.active.map(a => `<article class="lg-card mil-card${this.focus === a.id ? ' focus' : ''}" data-k="${a.id}">
      <div class="lg-card-top"><b>${esc(a.title)}</b><span class="lg-badge mil-t-${a.type}">${MIL_NAME[a.type]}</span></div>
      <div class="mil-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(a.progress.frac * 100)}"><i style="width:${Math.round(a.progress.frac * 100)}%"></i></div>
      <div class="mil-detail">${esc(a.progress.detail)}</div>
      <div class="lg-metrics mil-metrics"><span>기본 보수<b>${n0(a.base)}</b></span><span>성과 보너스<b>최대 ${n0(a.bonus)}</b></span><span>현상금(별도)<b>${n0(a.bounty)}</b></span></div>
      <div class="mil-where">투입 ${esc(a.fleet ?? '—')}${a.fleetStatus ? ` · ${esc(a.fleetStatus)}` : ''} · 기한 ${mins(a.left)} 남음${a.poster ? ` · 의뢰사 ${esc(a.poster)}` : ''}</div>
      <div class="lg-card-actions">
        ${a.group ? `<button class="btn" data-a="fleet" data-id="${a.group}">함대 보기</button><button class="btn" data-a="sortie" data-id="${a.id}" title="함대가 다른 명령으로 빠졌을 때 계약 작전으로 되돌립니다">재출격</button>` : ''}
        <button class="btn warnb" data-a="cancel" data-id="${a.id}">${this.confirm === a.id ? '정말 포기 — 실패 처리' : '계약 포기'}</button>
      </div>
      ${this.confirm === a.id ? '<div class="warn mil-hint">포기하면 보수 없이 실패로 처리되고 신용도와 발주 세력 신뢰도가 떨어집니다. 예치금은 발주처로 돌아갑니다.</div>' : ''}
    </article>`).join('')}</div>`;
  }

  // ----------------------------------------------------------------------------------- results

  private resultsHtml(g: MilGuide): string {
    if (!g.results.length) return '<div class="lg-empty"><h3>아직 정산된 계약이 없습니다</h3><p>계약이 끝나면(완수·실패·포기·무효) 보수, 현상금, 수리비, 손실 함선, 운영비와 지휘관 급여를 합친 작전 손익이 여기에 남습니다.</p></div>';
    const t = g.totals;
    const row = (r: MilGuide['results'][number]) => `<tr class="${r.ok ? '' : 'fail'}"><td><b>${esc(r.title)}</b><small>${r.ok ? '완수' : '실패'} — ${esc(r.why)} · ${mins(r.dur)}</small></td>
      <td>${n0(r.pay)}</td><td>${n0(r.bonus)}</td><td>${n0(r.bounty)}</td><td>${r.repair ? `−${n0(r.repair)}` : '0'}</td><td>${r.lost ? `−${n0(r.lost)}<small>${r.lostShips}척</small>` : '0'}</td><td>−${n0(r.upkeep + r.salary)}</td><td class="${r.net >= 0 ? 'good' : 'bad'}">${sgn(r.net)}</td></tr>`;
    return `<div class="mil-table-wrap"><table class="mil-table"><thead><tr><th>계약</th><th>기본 보수</th><th>보너스</th><th>현상금</th><th>수리비</th><th>손실</th><th>운영비·급여</th><th>순손익</th></tr></thead>
      <tbody>${g.results.map(row).join('')}</tbody>
      <tfoot><tr><td>최근 ${g.results.length}건 합계</td><td>${n0(t.pay)}</td><td>${n0(t.bonus)}</td><td>${n0(t.bounty)}</td><td>−${n0(t.repair)}</td><td>−${n0(t.lost)}</td><td>−${n0(t.upkeep + t.salary)}</td><td class="${t.net >= 0 ? 'good' : 'bad'}">${sgn(t.net)}</td></tr></tfoot></table></div>
      <div class="mil-hint">수리비는 작전 중 늘어난 손상분만, 운영비는 작전 기간 동안 투입 함선 몫, 급여는 투입 함대 지휘관 몫입니다. 재무 장부에서는 계약 보수(군사 계약)와 현상금(전투 현상금)이 따로 기록됩니다.</div>`;
  }

  // -------------------------------------------------------------------------------------- post

  private postHtml(g: MilGuide): string {
    const w = this.w!, me = this.me;
    const groups = Object.values(w.groups).filter(x => x.owner === me && !x.parentId && x.shipIds.some(id => { const s = w.ships[id]; return s && econOf(s).cargo > 0; }));
    if (this.postGroup && !groups.some(x => x.id === this.postGroup)) this.postGroup = '';
    const stations = Object.values(w.stations).filter(s => s.public || s.owner === me).sort((a, b) => a.name.localeCompare(b.name));
    const form = groups.length ? `<form class="mil-post" onsubmit="return false">
        <label>호위받을 자사 선단<select data-pgroup><option value="">선택</option>${groups.map(x => `<option value="${x.id}"${x.id === this.postGroup ? ' selected' : ''}>${esc(x.name)} · ${x.shipIds.length}척</option>`).join('')}</select></label>
        <label>목적지 정거장<select data-pto><option value="">선택</option>${stations.map(s => `<option value="${s.id}"${s.id === this.postTo ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>보수 (cr, 500~200,000 — 지금 예치)<input type="number" min="500" max="200000" step="100" data-reward value="${this.postReward}"></label>
        <button class="btn go" data-a="post">호위 의뢰 게시</button></form>
        <div class="mil-hint">보수의 70%는 도착 시 기본 보수, 30%는 무사 도착 보너스입니다. 수주사가 없으면 ${Math.round(1800 / 60)}분 뒤 전액 반환되고, 수주사의 함대는 이 계약 동안에만 의뢰한 선단을 호위할 수 있습니다(선단에 대한 다른 권한은 없음).</div>`
      : '<div class="lg-empty"><p>화물칸이 있는 자사 선단이 없어 호위를 의뢰할 수 없습니다.</p></div>';
    const posted = g.posted.length ? `<h3 class="mil-h3">게시한 호위 의뢰</h3><div class="lg-cards">${g.posted.map(p => `<article class="lg-card mil-card"><div class="lg-card-top"><b>${esc(p.title)}</b><span class="lg-badge">${p.taken ? '수주됨' : '대기'}</span></div>
      <div class="mil-where">예치 ${n0(p.escrow)} cr · ${p.taken ? `수주사 ${esc(p.taken)}` : '아직 수주사 없음'}</div>
      ${p.taken ? '' : `<div class="lg-card-actions"><button class="btn warnb" data-a="cancel" data-id="${p.id}">${this.confirm === p.id ? '정말 철회' : '의뢰 철회 · 예치금 반환'}</button></div>`}</article>`).join('')}</div>` : '';
    return `<h3 class="mil-h3">다른 회사에 호위 의뢰</h3>${form}${posted}`;
  }
}

/** does this company have anything to do on the military screen? (top-bar button visibility) */
export function militaryAvailable(w: WorldState | null | undefined, me: string): boolean {
  if (!w || w.milV !== 1) return false;
  return Object.values(w.ships).some(s => s.owner === me && econOf(s).military) || Object.values(w.contracts).some(k => k.kind === 'mil' && !k.done && (k.takenBy === me || k.mil?.poster === me)) || !!w.companies[me]?.milLog?.length;
}
