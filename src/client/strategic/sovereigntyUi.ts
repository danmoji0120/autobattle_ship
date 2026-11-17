// B-3 territory (성계 영유권) screen. It reads only what the server sends this company: its own private territory
// report (Company.sovx — rows, wars, treaties, alerts) and the public territory summary of systems it can see
// (StarSystem.terr; fog hides it with the system). Every action is an ordinary `sov` server command; nothing here
// decides ownership. The strategic HUD shows only the entry button and the alert count.
import type { GameClient } from '../net';
import type { Cmd } from '../../world/sim';
import type { WorldState, StarSystem } from '../../world/types';
import { CLASS, CLASS_NAME, COND_NAME, LEGIT_NAME, SOV, STAGE_NAME, STATUS_NAME, TREATY_NAME, type CondKey, type SovPolicy, type SovRow, type SovX, type TerrPub, type SovWar, type SovTreaty } from '../../world/sovereignty';
import { FACTIONS } from '../../world/territory';
import { morph, trackSelects } from '../../ui/morph';

type Tab = 'terr' | 'sys' | 'war' | 'help';
interface Actions { close(): void; system?(id: string): void; station?(id: string): void }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n0 = (v: number) => Math.round(v).toLocaleString();
const hrs = (s: number) => s >= 3600 ? `${(s / 3600).toFixed(1)}시간` : `${Math.max(0, Math.round(s / 60))}분`;
const CONDS: CondKey[] = ['econ', 'infra', 'logi', 'mil', 'ctl', 'legit', 'stab'];
const MINE_NAME: Record<SovPolicy['mine'], string> = { free: '자유 채굴', permit: '허가제', exclusive: '독점(영유사·허가 회사만)', royalty: '로열티 징수' };
const BUILD_NAME: Record<SovPolicy['build'], string> = { free: '자유 건설', permit: '허가제', closed: '건설 금지' };
const PASS_NAME: Record<SovPolicy['pass'], string> = { free: '자유 통행', restricted: '허가 회사만', toll: '통행료' };
const KIND_NAME = { mine: '채굴', build: '건설', pass: '통행' } as const;

export const partyLabel = (w: WorldState, p: string | undefined) => !p ? '없음' : p === 'pirates' ? '해적' : p.startsWith('fac:') ? (FACTIONS[p.slice(4)]?.name ?? p) : (w.companies[p]?.name ?? p);

export class TerritoryPanel {
  private el = document.createElement('div');
  private closed = false; private busy = false; private error = ''; private notice = '';
  private tab: Tab = 'terr';
  private sel = '';
  private confirm = '';
  private draft: Partial<SovPolicy> | null = null;
  private form = { grantTo: '', grantKind: 'mine' as 'mine' | 'build' | 'pass', guardH: 4, guardR: 20000, warH: 6, warR: 60000, rep: 50000, transferTo: '', transferPay: 0 };
  private last = 0;
  private onSnap = () => { const t = performance.now(); if (t - this.last > 900) this.render(); };
  private key = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopImmediatePropagation(); this.close(); } };

  constructor(root: HTMLElement, private c: GameClient, private actions: Actions, focusSys?: string) {
    const x = this.x;
    if (focusSys) { this.sel = focusSys; this.tab = x?.rows.some(r => r.sys === focusSys) ? 'terr' : 'sys'; }
    else this.sel = x?.rows[0]?.sys ?? '';
    if (!focusSys && x?.wars.some(w => w.status !== 'ended') ) this.tab = x.rows.length ? 'terr' : 'war';
    this.el.className = 'modal lg-modal mil-modal sov-modal'; this.el.tabIndex = -1;
    this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-label', '영토'); this.el.setAttribute('aria-modal', 'true');
    this.el.onkeydown = e => e.stopPropagation();
    this.el.onclick = e => this.click(e);
    this.el.onchange = e => this.change(e.target as HTMLSelectElement | HTMLInputElement);
    root.appendChild(this.el); trackSelects(this.el); c.onSnap.push(this.onSnap); window.addEventListener('keydown', this.key, true);
    this.render(); this.el.focus();
  }
  close() { if (this.closed) return; this.closed = true; const i = this.c.onSnap.indexOf(this.onSnap); if (i >= 0) this.c.onSnap.splice(i, 1); window.removeEventListener('keydown', this.key, true); this.el.remove(); this.actions.close(); document.getElementById('sovBtn')?.focus(); }

  private get me() { return this.c.company; }
  private get w() { return this.c.state as unknown as WorldState | null; }
  private get x(): SovX | undefined { return this.w?.companies[this.me]?.sovx; }

  private async send(command: Omit<Extract<Cmd, { c: 'sov' }>, 'c'>, success: string) {
    if (this.busy) return; this.busy = true; this.error = ''; this.notice = ''; this.render();
    try { const error = await this.c.cmd({ c: 'sov', ...command } as Cmd); if (this.closed) return; if (error) this.error = error; else { this.notice = success; this.draft = null; } }
    catch { if (!this.closed) this.error = '연결을 확인하고 다시 시도하세요'; }
    finally { this.busy = false; this.confirm = ''; if (!this.closed) this.render(); }
  }

  private change(t: HTMLSelectElement | HTMLInputElement) {
    const d = t.dataset, num = () => Math.floor(Number(t.value) || 0);
    if (d.sel !== undefined) { this.sel = t.value; this.draft = null; this.confirm = ''; return this.render(); }
    if (d.pol !== undefined) { const k = d.pol as keyof SovPolicy; const p = (this.draft ??= {}); (p as any)[k] = k === 'royalty' ? Number(t.value) / 100 : k === 'toll' || k === 'buildFee' ? num() : t.value; return this.render(); }
    if (d.price !== undefined) { const p = (this.draft ??= {}); const cur = this.policyOf()?.price ?? { mine: 0, build: 0, pass: 0 }; p.price = { ...cur, ...(p.price ?? {}), [d.price]: num() }; return; }
    if (d.f !== undefined) { (this.form as any)[d.f] = t.type === 'number' ? num() : t.value; return; }
  }

  private policyOf(): SovPolicy | undefined { return this.x?.rows.find(r => r.sys === this.sel)?.policy; }

  private click(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]'); if (!b || this.busy) return;
    const a = b.dataset.a!, id = b.dataset.id ?? '', sys = this.sel;
    const twice = (k: string) => { if (this.confirm !== k) { this.confirm = k; this.render(); return false; } return true; };
    switch (a) {
      case 'close': return this.close();
      case 'tab': this.tab = id as Tab; this.confirm = ''; this.error = ''; this.notice = ''; return this.render();
      case 'pick': this.sel = id; this.draft = null; this.confirm = ''; this.tab = this.x?.rows.some(r => r.sys === id) ? 'terr' : 'sys'; return this.render();
      case 'map': this.close(); this.actions.system?.(id); return;
      case 'station': this.close(); this.actions.station?.(id); return;
      case 'declare': if (!twice('declare')) return; return void this.send({ op: 'declare', sys }, '영유권을 선언했습니다 — 이제 일곱 가지 조건을 함께 유지해야 안정화가 진행됩니다');
      case 'withdraw': if (!twice('withdraw')) return; return void this.send({ op: 'withdraw', sys }, '영유권 주장을 철회했습니다');
      case 'negotiate': if (!twice('negotiate')) return; return void this.send({ op: 'negotiate', sys }, '할양 협상이 타결되었습니다 — 확립 조건을 채우면 세력이 물러납니다');
      case 'war': if (!twice('war')) return; return void this.send({ op: 'war', sys }, '영토 전쟁을 선포했습니다 — 예고 기간 뒤 개전합니다');
      case 'impose': return void this.send({ op: 'impose', war: id }, '전쟁 조약을 강제했습니다');
      case 'policy': if (!this.draft) return; return void this.send({ op: 'policy', sys, policy: this.draft }, '통치 정책을 적용했습니다');
      case 'policyReset': this.draft = null; return this.render();
      case 'grant': if (!this.form.grantTo) { this.error = '회사를 고르세요'; return this.render(); } return void this.send({ op: 'grant', sys, kind: this.form.grantKind, target: this.form.grantTo, on: true }, '허가를 부여했습니다 (7일)');
      case 'revoke': { const [kind, target] = id.split(':'); return void this.send({ op: 'grant', sys, kind, target, on: false }, '허가를 취소했습니다'); }
      case 'buy': if (!twice(`buy:${id}`)) return; return void this.send({ op: 'permit', sys, kind: id }, '24시간 허가를 구매했습니다');
      case 'guard': return void this.send({ op: 'guard', sys, hours: this.form.guardH, reward: this.form.guardR }, '경비 계약을 게시했습니다 — 보수는 지금 예치되었습니다');
      case 'warContract': return void this.send({ op: 'warContract', war: id, hours: this.form.warH, reward: this.form.warR }, '전쟁 용병 계약을 게시했습니다');
      case 'propose': { const [kind, s] = id.split(':'); return void this.send({ op: 'propose', kind, sys: s, pay: kind === 'reparations' ? this.form.rep : undefined }, '조약을 제안했습니다'); }
      case 'transfer': if (!this.form.transferTo) { this.error = '이양 대상 회사를 고르세요'; return this.render(); } if (!twice('transfer')) return; return void this.send({ op: 'propose', kind: 'transfer', sys, to: this.form.transferTo, pay: this.form.transferPay }, '영토 이양을 제안했습니다 — 상대가 수락하면 이양됩니다');
      case 'accept': return void this.send({ op: 'answer', treaty: id, accept: true }, '조약을 수락했습니다');
      case 'reject': return void this.send({ op: 'answer', treaty: id, accept: false }, '조약을 거절했습니다');
    }
  }

  private render() {
    if (this.closed) return;
    this.last = performance.now();
    const w = this.w, x = this.x;
    const head = (sub = '') => `<header class="lg-head"><div><div class="an-eyebrow">SIDERARIUM / TERRITORY</div><h2>영토${sub}</h2></div><div class="lg-actions"><button class="btn" data-a="close" aria-label="영토 화면 닫기">✕</button></div></header>`;
    if (!w) { morph(this.el, `<div class="panel lg-box mil-box">${head()}<div class="mil-empty">회사 상태를 기다리는 중…</div></div>`); return; }
    if (w.sovV !== 1) { morph(this.el, `<div class="panel lg-box mil-box">${head()}<div class="mil-empty">이 월드에는 성계 영유권(B-3)이 꺼져 있습니다.</div></div>`); return; }
    const rows = x?.rows ?? [], wars = (x?.wars ?? []), live = wars.filter(v => v.status !== 'ended');
    const owned = rows.filter(r => r.owner === this.me).length, claims = rows.filter(r => r.claim).length;
    const offers = (x?.treaties ?? []).filter(t => t.status === 'offer' && t.to === this.me).length;
    const tabs: [Tab, string, number][] = [['terr', '자사 영토·주장', owned + claims], ['sys', '성계 정보', 0], ['war', '전쟁·조약', live.length + offers], ['help', '영유권 안내', 0]];
    const body = this.tab === 'terr' ? this.terrHtml(w, x) : this.tab === 'sys' ? this.sysHtml(w, x) : this.tab === 'war' ? this.warHtml(w, x) : this.helpHtml();
    morph(this.el, `<div class="panel lg-box mil-box">${head(` <span>영유 ${owned} · 주장 ${claims} · 전쟁 ${live.length}${offers ? ` · 조약 제안 ${offers}` : ''}</span>`)}
      ${this.error ? `<div class="lg-feedback warn" role="alert">${esc(this.error)}</div>` : this.notice ? `<div class="lg-feedback good" role="status">${esc(this.notice)}</div>` : ''}
      ${x?.alerts.length ? `<ul class="sov-alerts">${x.alerts.slice(0, 5).map(a => `<li class="warn">${esc(a)}</li>`).join('')}</ul>` : ''}
      <div class="mil-scroll">
        <nav class="mil-tabs" role="tablist">${tabs.map(([id, name, n]) => `<button class="btn${this.tab === id ? ' on' : ''}" role="tab" aria-selected="${this.tab === id}" data-a="tab" data-id="${id}">${name}${n ? ` <span class="mil-n">${n}</span>` : ''}</button>`).join('')}</nav>
        <section class="mil-body">${body}</section>
      </div>
      <footer class="lg-foot"><span>영유권은 정거장 건설이나 비용 지불만으로 생기지 않습니다 — 경제력·기반시설·물류·군사·실효 지배·정당성을 함께 유지한 채 안정화 시간을 채워야 확립됩니다. 영토가 없어도 회사는 정상적으로 성장할 수 있습니다.</span></footer></div>`);
  }

  // ------------------------------------------------------------------------- own territories / claims

  private terrHtml(w: WorldState, x: SovX | undefined): string {
    const rows = x?.rows ?? [];
    if (!rows.length) return `<div class="lg-empty"><h3>영토 활동이 없습니다</h3><p>영유권은 선택 사항입니다. 어떤 성계에 자사 정거장과 상주 전투 함대를 두고 지배력을 쌓으면(단계 3 '영향력') 영유권을 선언할 수 있습니다. 성계 정보 탭에서 보이는 성계의 영유 현황을 확인하세요.</p><button class="btn" data-a="tab" data-id="help">영유권 안내</button></div>`;
    if (!rows.some(r => r.sys === this.sel)) this.sel = rows[0].sys;
    const list = `<div class="sov-list" role="list">${rows.map(r => `<button class="sov-item${r.sys === this.sel ? ' on' : ''}" role="listitem" data-a="pick" data-id="${r.sys}">
      <b>${esc(r.name)}</b><small>${r.owner === this.me ? `<span class="good">영유</span> · 안정도 ${r.stab}` : r.claim ? `주장 · ${STAGE_NAME[r.stage]}` : STAGE_NAME[r.stage]} · ${STATUS_NAME[r.status]}</small>
      <i class="sov-stage" style="--p:${(r.stage / 8) * 100}%"></i></button>`).join('')}</div>`;
    const r = rows.find(v => v.sys === this.sel)!;
    return `<div class="sov-split">${list}<div class="sov-detail">${this.rowHtml(w, x!, r)}</div></div>`;
  }

  private rowHtml(w: WorldState, x: SovX, r: SovRow): string {
    const mine = r.owner === this.me, cls = CLASS[r.cls];
    const stages = `<ol class="sov-stages">${STAGE_NAME.map((n, i) => `<li class="${i < r.stage ? 'done' : i === r.stage ? 'cur' : ''}">${i}. ${n}</li>`).join('')}</ol>`;
    const prog = r.claim ? `<div class="mil-bar" role="progressbar" aria-label="안정화 진행" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(r.claim.prog / r.claim.need * 100)}"><i style="width:${Math.min(100, r.claim.prog / r.claim.need * 100)}%"></i></div>
      <div class="mil-detail">안정화 ${hrs(r.claim.prog)} / ${hrs(r.claim.need)} · 정당성 ${r.claim.legit ? LEGIT_NAME[r.claim.legit] : `미확보 (필요: ${LEGIT_NAME[cls.legit]})`} · 선언 ${hrs(w.time - r.claim.at)} 전 · 조건이 2개 이상 무너지면 진행이 시간당 ${Math.round(SOV.decayPerH * 100)}%씩 줄고, ${SOV.inactiveH}시간 진척이 없으면 주장이 소멸합니다</div>` : '';
    const conds = r.rep ? `<table class="mil-table sov-conds"><thead><tr><th>조건</th><th>상태</th><th>부족한 점 · 해결 방법</th></tr></thead><tbody>${CONDS.map(k => { const c = r.rep![k]; return `<tr class="${c.ok ? '' : 'fail'}"><td><b>${COND_NAME[k]}</b></td><td class="${c.ok ? 'good' : 'bad'}">${c.ok ? '충족' : '미달'}</td><td>${c.ok ? '' : `${c.miss.map(m => `<div>${esc(m)}</div>`).join('')}<small>${esc(c.fix)}</small>`}</td></tr>`; }).join('')}</tbody></table>` : '';
    const f = r.facilities;
    const metrics = `<div class="lg-metrics mil-metrics">
      <span>등급<b>${CLASS_NAME[r.cls]}</b></span><span>지배력<b>${r.ctl}</b></span>${mine ? `<span>안정도<b class="${(r.stab ?? 0) >= 60 ? 'good' : (r.stab ?? 0) >= 35 ? 'warn' : 'bad'}">${r.stab}</b></span>` : ''}
      <span>성계 내 전력<b class="${r.power >= r.needPower ? 'good' : 'warn'}">${n0(r.power)} / ${n0(r.needPower)}</b></span>
      <span>유지비(시간당)<b>${n0(r.upkeep)}</b></span>${mine && r.arrears ? `<span>체납<b class="bad">${n0(r.arrears)}</b></span>` : ''}</div>`;
    const fac = `<div class="mil-where">통치 거점: ${f?.station ? `<button class="an-link" data-a="station" data-id="${f.station}">${esc(w.stations[f.station]?.name ?? f.station)}</button> (${f.size}${f.gov ? ' · 통치청 ✓' : ' · <span class="warn">통치청 없음</span>'} · 방어 시설 ${f.defense}/${cls.defense} · 전력 ${f.power ? '정상' : '<span class="warn">부족</span>'})` : '<span class="warn">자사 정거장 없음</span>'} · 필요 ${cls.station}급 이상 · <button class="an-link" data-a="map" data-id="${r.sys}">지도에서 보기</button></div>`;
    const sup = r.supply ? `<div class="sov-supply"><b>행정 물자 (시간당 필요)</b> ${Object.entries(r.supply.demand).map(([k, n]) => `<span>${esc(k)} ${Math.round(n)} <small>재고 ${Math.round(r.supply!.stock[k] ?? 0)}</small></span>`).join('')}<span>최근 공급률 <b class="${r.supply.need && r.supply.in / r.supply.need >= SOV.supplyShare ? 'good' : 'warn'}">${r.supply.need ? Math.round(r.supply.in / r.supply.need * 100) : 0}%</b></span></div>` : '';
    const inc = mine ? `<div class="mil-pl"><span>세금(로열티) <b>${n0(r.income.tax)}</b></span><span>통행료 <b>${n0(r.income.toll)}</b></span><span>허가 판매 <b>${n0(r.income.permit)}</b></span><span>유지비 <b>−${n0(r.income.up)}</b></span><span>최근 24시간 순수익 <b class="${r.income.tax + r.income.toll + r.income.permit - r.income.up >= 0 ? 'good' : 'bad'}">${n0(r.income.tax + r.income.toll + r.income.permit - r.income.up)}</b></span></div>` : '';
    const rivals = r.rivals.length ? `<div class="sov-rivals"><b>경쟁 세력</b> ${r.rivals.map(v => `<span>${esc(v.name)} 지배력 ${v.ctl}${v.stage ? ` · ${STAGE_NAME[v.stage]}` : ''}</span>`).join('')}</div>` : '';
    const occ = r.occ ? `<div class="warn">점령: ${esc(partyLabel(w, r.occ.by))} 유지 ${hrs(r.occ.held)} / ${hrs(r.occ.need)} — 점령은 영유권이 아닙니다. 지배력을 회복하면 탈환됩니다.</div>` : '';
    const acts: string[] = [];
    if (!mine && !r.claim && r.stage >= 3) acts.push(`<button class="btn go" data-a="declare">${this.confirm === 'declare' ? `확인 — 선언 수수료 ${n0(SOV.declareFee * cls.mult)} cr` : '영유권 선언'}</button>`);
    if (r.claim) acts.push(`<button class="btn warnb" data-a="withdraw">${this.confirm === 'withdraw' ? '정말 철회 (진행 소멸)' : '주장 철회'}</button>`);
    const sys = w.systems[r.sys];
    if (r.claim && !mine && (r.cls === 'npc_border' || r.cls === 'npc_core') && sys?.faction) acts.push(`<button class="btn" data-a="negotiate" title="세력 신뢰도 ${r.cls === 'npc_core' ? SOV.cessionCoreStanding : SOV.cessionStanding} 이상, 지배력 ${SOV.cessionCtl} 이상, 대금은 세력 금고로">${this.confirm === 'negotiate' ? `확인 — 할양 대금 약 ${n0(SOV.cessionPrice * cls.mult)} cr` : '할양 협상'}</button>`);
    if (r.claim && !mine && (sys?.terr?.owner || (sys?.faction && sys.faction !== 'pirates' && r.cls !== 'lawless'))) acts.push(`<button class="btn warnb" data-a="war">${this.confirm === 'war' ? `확인 — 선전포고 비용 ${n0(SOV.warFee * cls.mult)} cr` : '영토 전쟁 선포'}</button>`);
    const guard = (mine || r.claim) && w.milV === 1 ? `<details class="sov-sub"><summary>경비 계약 게시 (다른 회사 함대 고용)</summary><div class="mil-post">
      <label>기간(시간 1~12)<input type="number" min="1" max="12" data-f="guardH" value="${this.form.guardH}"></label><label>보수 cr<input type="number" min="2000" max="500000" step="1000" data-f="guardR" value="${this.form.guardR}"></label>
      <button class="btn" data-a="guard">게시 · 예치</button></div><div class="mil-hint">고용한 함대도 이 성계의 자사 전력·지배력으로 계산됩니다. 보수는 자사 자금에서 예치되고 실패·만료 시 반환됩니다.</div></details>` : '';
    return `<h3 class="mil-h3">${esc(r.name)} <small>${STATUS_NAME[r.status]}${mine ? ` · 영유 (${r.claim?.legit ? LEGIT_NAME[r.claim.legit] : ''})` : ''}</small></h3>
      ${stages}${prog}${metrics}${fac}${occ}${conds}${sup}${inc}${rivals}
      ${acts.length ? `<div class="lg-card-actions">${acts.join('')}</div>` : ''}
      ${mine ? this.policyHtml(w, r) : ''}${guard}${mine ? this.transferHtml(w) : ''}`;
  }

  private policyHtml(w: WorldState, r: SovRow): string {
    const p = { ...r.policy!, ...(this.draft ?? {}), price: { ...r.policy!.price, ...(this.draft?.price ?? {}) } };
    const sel = <T extends string>(k: keyof SovPolicy, names: Record<T, string>, v: T) => `<select data-pol="${k}">${Object.entries(names).map(([id, n]) => `<option value="${id}"${id === v ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    const permits = r.permits ? (['mine', 'build', 'pass'] as const).flatMap(k => Object.entries(r.permits![k]).filter(([, t]) => t > w.time).map(([co, t]) => `<span class="sov-permit">${KIND_NAME[k]} · ${esc(w.companies[co]?.name ?? co)} · ${hrs(t - w.time)} <button class="an-link" data-a="revoke" data-id="${k}:${co}">취소</button></span>`)) : [];
    const others = Object.values(w.companies).filter(c => c.kind === 'player' && c.id !== this.me);
    return `<details class="sov-sub" open><summary>통치 정책</summary>
      <div class="mil-post sov-policy">
        <label>채굴 ${sel('mine', MINE_NAME, p.mine)}</label>
        ${p.mine === 'royalty' ? `<label>로열티 %(최대 ${SOV.royaltyMax * 100})<input type="number" min="0" max="${SOV.royaltyMax * 100}" data-pol="royalty" value="${Math.round(p.royalty * 100)}"></label>` : ''}
        <label>건설 ${sel('build', BUILD_NAME, p.build)}</label>
        ${p.build === 'permit' ? `<label>건설 수수료 cr<input type="number" min="0" max="500000" data-pol="buildFee" value="${p.buildFee}"></label>` : ''}
        <label>통행 ${sel('pass', PASS_NAME, p.pass)}</label>
        ${p.pass === 'toll' ? `<label>통행료 cr/척 (최대 ${SOV.tollMax})<input type="number" min="0" max="${SOV.tollMax}" data-pol="toll" value="${p.toll}"></label>` : ''}
        <label>치안 ${sel('security', { standard: '표준', strict: '엄격 (수배 회사 통행 거부)' }, p.security)}</label>
        ${(['mine', 'build', 'pass'] as const).map(k => `<label>${KIND_NAME[k]} 허가 판매가 (24h, 0=판매 안 함)<input type="number" min="0" max="1000000" step="500" data-price="${k}" value="${p.price[k]}"></label>`).join('')}
        <button class="btn go" data-a="policy"${this.draft ? '' : ' disabled'}>정책 적용</button>${this.draft ? '<button class="btn" data-a="policyReset">되돌리기</button>' : ''}
      </div>
      <div class="mil-hint">제한·통행료는 자사 전력이 관문/성계에서 실제로 집행할 수 있을 때만 적용됩니다(관문 근처 전력 ${SOV.enforce}, 채굴 단속 성계 전력 ${SOV.enforceMine} 이상). 세금·통행료·허가료는 상대 회사의 실제 자금에서 이체되며, 낼 수 없으면 거부되거나 미납으로 남습니다.</div>
      <div class="sov-permits"><b>발급된 허가</b> ${permits.length ? permits.join('') : '<small>없음</small>'}</div>
      <div class="mil-post"><label>허가 부여<select data-f="grantKind">${(['mine', 'build', 'pass'] as const).map(k => `<option value="${k}"${this.form.grantKind === k ? ' selected' : ''}>${KIND_NAME[k]}</option>`).join('')}</select></label>
        <label>회사<select data-f="grantTo"><option value="">선택</option>${others.map(c => `<option value="${c.id}"${this.form.grantTo === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label><button class="btn" data-a="grant">무상 허가 (7일)</button></div>
    </details>`;
  }

  private transferHtml(w: WorldState): string {
    const others = Object.values(w.companies).filter(c => c.kind === 'player' && c.id !== this.me);
    if (!others.length) return '';
    return `<details class="sov-sub"><summary>영토 이양 (합의)</summary><div class="mil-post">
      <label>받을 회사<select data-f="transferTo"><option value="">선택</option>${others.map(c => `<option value="${c.id}"${this.form.transferTo === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>대금 cr (상대가 지급)<input type="number" min="0" step="1000" data-f="transferPay" value="${this.form.transferPay}"></label>
      <button class="btn warnb" data-a="transfer">${this.confirm === 'transfer' ? '확인 — 이양 제안' : '이양 제안'}</button></div>
      <div class="mil-hint">상대가 수락하면 영유권이 넘어갑니다(안정도 최대 60으로 이어짐). 대금은 수락 시 상대의 실제 자금에서 이체됩니다.</div></details>`;
  }

  // ------------------------------------------------------------------------------- any system

  private sysHtml(w: WorldState, x: SovX | undefined): string {
    const known = Object.values(w.systems).filter(s => !(s as any).unknown).sort((a, b) => a.name.localeCompare(b.name));
    if (!known.some(s => s.id === this.sel)) this.sel = known[0]?.id ?? '';
    const pick = `<label class="sov-pick">성계<select data-sel>${known.map(s => `<option value="${s.id}"${s.id === this.sel ? ' selected' : ''}>${esc(s.name)}${s.terr?.owner ? ` — ${esc(s.terr.ownerName ?? '')}` : s.terr?.claims.length ? ' — 주장 있음' : ''}</option>`).join('')}</select></label>`;
    const s = w.systems[this.sel] as StarSystem | undefined; if (!s) return pick;
    const t = s.terr as TerrPub | undefined, row = x?.rows.find(r => r.sys === s.id);
    const legal = t?.owner ? esc(t.ownerName ?? t.owner) : s.faction ? esc(partyLabel(w, `fac:${s.faction}`)) + (s.faction === 'pirates' ? ' (무법)' : ' (NPC 세력)') : '무주';
    const cls = t?.cls;
    const info = `<div class="lg-metrics mil-metrics"><span>법적 영유<b>${legal}</b></span><span>상태<b>${t ? STATUS_NAME[t.status] : '무주'}</b></span>${cls ? `<span>등급<b>${CLASS_NAME[cls]}</b></span>` : ''}${t?.stab !== undefined ? `<span>안정도<b>${t.stab}</b></span>` : ''}${t?.how ? `<span>획득<b>${LEGIT_NAME[t.how]}</b></span>` : ''}</div>`;
    const top = t?.top?.length ? `<div class="sov-rivals"><b>실효 지배</b> ${t.top.map(v => `<span>${esc(partyLabel(w, v.p))} ${v.ctl}</span>`).join('')}</div>` : '';
    const claims = t?.claims.length ? `<div class="sov-rivals"><b>영유권 주장</b> ${t.claims.map(c => `<span>${esc(c.name)} · ${STAGE_NAME[c.stage]}</span>`).join('')}</div>` : '';
    const war = t?.war?.length ? `<div class="warn">영토 전쟁: ${t.war.map(v => `${esc(partyLabel(w, v.att))} → ${esc(partyLabel(w, v.def))} (${v.status === 'notice' ? '예고' : '진행'})`).join(', ')}</div>` : '';
    const occ = t?.occ ? `<div class="warn">점령: ${esc(partyLabel(w, t.occ.by))} ${hrs(t.occ.held)} / ${hrs(t.occ.need)}</div>` : '';
    let pol = '';
    if (t?.owner && t.pol && t.owner !== this.me) {
      const p = t.pol;
      const buy = (['mine', 'build', 'pass'] as const).filter(k => p.price[k] > 0 && !(k === 'mine' && p.mine === 'exclusive')).map(k => `<button class="btn" data-a="buy" data-id="${k}">${this.confirm === `buy:${k}` ? `확인 — ${n0(p.price[k])} cr` : `${KIND_NAME[k]} 허가 구매 (24h · ${n0(p.price[k])} cr)`}</button>`).join('');
      pol = `<div class="sov-sub"><b>영유 회사의 통치 규칙</b><ul class="mil-next"><li>채굴: ${MINE_NAME[p.mine]}${p.mine === 'royalty' ? ` ${Math.round(p.royalty * 100)}%` : ''}</li><li>건설: ${BUILD_NAME[p.build]}${p.build === 'permit' && p.buildFee ? ` (수수료 ${n0(p.buildFee)} cr)` : ''}</li><li>통행: ${PASS_NAME[p.pass]}${p.pass === 'toll' ? ` ${n0(p.toll)} cr/척` : ''}</li><li>치안: ${p.security === 'strict' ? '엄격 — 수배 회사 통행 거부' : '표준'}</li></ul>
        <div class="mil-hint">규칙은 영유 회사 전력이 현장에 있을 때만 집행됩니다.</div>${buy ? `<div class="lg-card-actions">${buy}</div>` : ''}</div>`;
    }
    const mineRow = row ? `<div class="lg-card-actions"><button class="btn go" data-a="pick" data-id="${s.id}">자사 진행 상황 보기 (${STAGE_NAME[row.stage]})</button></div>` : '<div class="mil-hint">이 성계에 자사 정거장과 전투 함대를 두고 지배력을 쌓으면 진행 상황이 나타납니다.</div>';
    return `${pick}<h3 class="mil-h3">${esc(s.name)} <button class="an-link" data-a="map" data-id="${s.id}">지도</button></h3>${info}${top}${claims}${war}${occ}${pol}${mineRow}
      ${cls ? `<div class="mil-hint">${CLASS_NAME[cls]} 성계 요구: ${CLASS[cls].station}급 정거장 · 방어 시설 ${CLASS[cls].defense} · 안정화 ${CLASS[cls].stabH}시간 · 정당성 ${LEGIT_NAME[CLASS[cls].legit]} · 난이도 배율 ×${CLASS[cls].mult}</div>` : ''}`;
  }

  // ------------------------------------------------------------------------------- wars / treaties

  private warHtml(w: WorldState, x: SovX | undefined): string {
    const wars = x?.wars ?? [], tr = x?.treaties ?? [];
    const warCard = (v: SovWar) => {
      const att = v.att === this.me, name = w.systems[v.sys]?.name ?? v.sys, t = w.systems[v.sys]?.terr;
      const acts: string[] = [];
      if (v.status !== 'ended') {
        acts.push(`<button class="btn" data-a="propose" data-id="truce:${v.sys}">휴전 제안</button>`);
        if (att) acts.push(`<button class="btn" data-a="propose" data-id="return:${v.sys}">점령 반환·철수 제안</button>`);
        acts.push(`<label class="mil-pick">배상금<input type="number" min="0" step="1000" data-f="rep" value="${this.form.rep}"></label><button class="btn" data-a="propose" data-id="reparations:${v.sys}">배상 지급 제안</button>`);
        if (att && t?.occ && t.occ.by === this.me && t.occ.held >= t.occ.need) acts.push(`<button class="btn go" data-a="impose" data-id="${v.id}">전쟁 조약 강제 (할양)</button>`);
      }
      const merc = v.status !== 'ended' && w.milV === 1 ? `<div class="mil-post"><label>용병 계약 기간(1~12h)<input type="number" min="1" max="12" data-f="warH" value="${this.form.warH}"></label><label>보수 cr<input type="number" min="5000" max="1000000" step="1000" data-f="warR" value="${this.form.warR}"></label><button class="btn" data-a="warContract" data-id="${v.id}">전쟁 계약 게시</button></div>` : '';
      return `<article class="lg-card mil-card"><div class="lg-card-top"><b>${esc(name)} 영토 전쟁</b><span class="lg-badge">${v.status === 'notice' ? `예고 · ${hrs(v.start - w.time)} 후 개전` : v.status === 'active' ? '진행 중' : '종전'}</span></div>
        <div class="mil-where">${esc(partyLabel(w, v.att))} (공격) → ${esc(partyLabel(w, v.def))} (방어) · 자사: ${att ? '공격' : '방어'}${t?.occ ? ` · 점령 ${esc(partyLabel(w, t.occ.by))} ${hrs(t.occ.held)} / ${hrs(t.occ.need)}` : ''}${v.end ? ` · ${esc(v.end.how)}` : ''}</div>
        <ul class="mil-next">${v.log.slice(-5).reverse().map(l => `<li>${esc(l.txt)}</li>`).join('')}</ul>
        ${acts.length ? `<div class="lg-card-actions">${acts.join('')}</div>` : ''}${merc}
        <div class="mil-hint">점령은 영유권이 아닙니다. 공격 측이 지배력 ${SOV.occAtt} 이상, 방어 측 ${SOV.occDef} 이하를 유지하면 점령 시간이 쌓이고, 필요 시간을 채운 뒤에만 할양 조약을 강제할 수 있습니다. ${SOV.staleH}시간 진척이 없으면 자동 휴전됩니다.</div></article>`;
    };
    const trCard = (t: SovTreaty) => `<article class="lg-card mil-card"><div class="lg-card-top"><b>${esc(w.systems[t.sys]?.name ?? t.sys)} ${TREATY_NAME[t.kind]} 조약</b><span class="lg-badge">${t.status === 'offer' ? '제안' : t.status === 'accepted' ? '수락' : t.status === 'rejected' ? '거절' : '만료'}</span></div>
      <div class="mil-where">${esc(partyLabel(w, t.from))} → ${esc(partyLabel(w, t.to))}${t.pay ? ` · ${n0(t.pay)} cr` : ''}</div>
      ${t.status === 'offer' && t.to === this.me ? `<div class="lg-card-actions"><button class="btn go" data-a="accept" data-id="${t.id}">수락</button><button class="btn warnb" data-a="reject" data-id="${t.id}">거절</button></div>` : ''}</article>`;
    if (!wars.length && !tr.length) return '<div class="lg-empty"><h3>전쟁·조약이 없습니다</h3><p>영토 전쟁은 영유권을 선언한 성계에서만, 예고 기간을 두고 선포할 수 있습니다. 실제 함대로 지배력을 빼앗아야 하며, 비용 지불만으로는 이길 수 없습니다.</p></div>';
    return `${wars.length ? `<h3 class="mil-h3">영토 전쟁</h3><div class="lg-cards">${wars.map(warCard).join('')}</div>` : ''}${tr.length ? `<h3 class="mil-h3">조약</h3><div class="lg-cards">${tr.map(trCard).join('')}</div>` : ''}`;
  }

  private helpHtml(): string {
    return `<section class="sov-help"><h3>영유권 확립 단계</h3><ol class="sov-stages">${STAGE_NAME.map((n, i) => `<li>${i}. ${n}</li>`).join('')}</ol>
      <h3>일곱 가지 조건 (확립 전 선언 이후 동시에 유지)</h3><ul class="mil-next">
      <li><b>경제력</b> — 순자산·최근 최저 보유 현금(유동성)·최근 12시간 실제 수입. 보유 영토가 늘수록 기준이 오릅니다.</li>
      <li><b>기반시설</b> — 성계 등급에 맞는 크기의 자사 정거장, 성계 통치청, 방어 시설, 전력 정상.</li>
      <li><b>물류</b> — 통치청에 행정 물자(합금·화학·기계·전자)가 실제로 반입되어 수요의 ${Math.round(SOV.supplyShare * 100)}% 이상 유지.</li>
      <li><b>군사 통제력</b> — 성계 안 자사 전투 전력(위협 수준에 비례), 지휘관, 정비 상태, 최근 활동.</li>
      <li><b>실효 지배</b> — 관문·정거장·세력 행정 거점 등 거점을 실제 함대로 장악해 지배력 ${SOV.ctlNeed} 이상, 경쟁자 ${SOV.ctlRival} 미만.</li>
      <li><b>정치적 정당성</b> — 무주지 개척, 해적 지대 평정, NPC 세력 할양(신뢰도·대금), 회사 간 합의 또는 전쟁 조약. 세력 수도는 특별 전쟁 조건으로만.</li>
      <li><b>안정화</b> — 위 조건을 유지한 시간이 등급별 시간(12~36시간)에 도달. 부족하면 멈추거나 일부 감소할 뿐 초기화되지 않습니다.</li></ul>
      <h3>성계 등급</h3><table class="mil-table"><thead><tr><th>등급</th><th>배율</th><th>정거장</th><th>방어</th><th>안정화</th><th>정당성</th></tr></thead><tbody>${Object.entries(CLASS).map(([k, c]) => `<tr><td>${CLASS_NAME[k as keyof typeof CLASS]}</td><td>×${c.mult}</td><td>${c.station}</td><td>${c.defense}</td><td>${c.stabH}h</td><td>${LEGIT_NAME[c.legit]}</td></tr>`).join('')}</tbody></table>
      <div class="mil-hint">확립 후에도 유지비(거리·보안·보유 영토 수에 따라 증가)와 물자·전력·지배력을 유지해야 하며, 소홀하면 안정도가 떨어지고 분쟁을 거쳐 영유권이 소멸할 수 있습니다.</div></section>`;
  }
}

/** top-bar button visibility: the world has territory and this company has anything territorial (or a foothold) */
export function territoryAvailable(w: WorldState | null | undefined, me: string): boolean {
  if (!w || w.sovV !== 1) return false;
  const x = w.companies[me]?.sovx;
  return !!x && (x.rows.length > 0 || x.wars.length > 0 || x.treaties.length > 0);
}
