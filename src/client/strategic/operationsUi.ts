// Company HQ (회사 본부): one screen over the unified work system. Every action here sends the same
// commands as the detailed screens; nothing is computed authoritatively on the client.
import { pnlRows } from '../../world/industryPnl';
import type { GameClient } from '../net';
import type { Cmd } from '../../world/sim';
import { companyInventory, terminal, GOAL_KINDS, KIND_NAME, STATE_NAME, LEDGER_NAME, itemName, defaultOpsPolicy, type Work, type Approval, type ApprovalScope, type GoalSpec, type InventoryRow } from '../../world/operations';
import { ITEMS, RECIPES, TECHS, recipeFor } from '../../world/industry';
import { MODULES } from '../../world/data';
import { facLines } from '../../world/production';
import { CONTENT, hullReleased } from '../../content/registry';
import { morph, trackSelects } from '../../ui/morph';
import { qty } from '../../world/types';
import { priceOf } from '../../world/market';
import { fieldPanelHtml } from './territoryUi';
import { fleetFormHtml, fleetDraftChange, fleetGoal, loadTemplate, newDraft, newLine, saveTemplateCmd, type FleetDraft } from './fleetGoalUi';
import { saleSearchHtml, transferButtons, type SaleSearchState } from './saleSearchUi';
import { waitCode, waitActions, WAIT_NAME } from '../../world/waitCode';
import { econOf } from '../../world/hullops';
import { deliveryQuote, directDeliverable } from '../../world/contractDelivery';
import { companyPiracyHtml } from './piracyUi';
import { companyLawHtml } from './lawUi';
import { companyRepHtml } from './repUi';

// P17.4e (AUD-16): the HQ is grouped by what the player is deciding — company, fleet, industry, logistics & trade,
// contracts & operations, research — instead of ten flat tabs. Each section remembers its last sub-screen, and links
// between screens (a contract's goods → stock → transport) keep a return path.
export type OpsTab = 'hq' | 'works' | 'finance' | 'fleet' | 'industry' | 'build' | 'fields' | 'stock' | 'logistics' | 'contracts' | 'rep' | 'research';
type Tab = OpsTab;
type Section = 'hq' | 'fleet' | 'industry' | 'trade' | 'ops' | 'research';
const SECTIONS: { id: Section; label: string; tabs: [Tab, string][] }[] = [
  { id: 'hq', label: '본부', tabs: [['hq', '요약'], ['works', '전체 업무'], ['finance', '재무·결재']] },
  { id: 'fleet', label: '함대', tabs: [['fleet', '함대·조선·정비']] },
  { id: 'industry', label: '산업', tabs: [['industry', '생산'], ['build', '시설 건설'], ['fields', '광구']] },
  { id: 'trade', label: '물류·거래', tabs: [['stock', '재고·판매'], ['logistics', '운송']] },
  { id: 'ops', label: '계약·작전', tabs: [['contracts', '계약·법무'], ['rep', '평판·관계']] },
  { id: 'research', label: '연구', tabs: [['research', '연구']] },
];
const sectionOf = (t: Tab) => SECTIONS.find(x => x.tabs.some(([id]) => id === t)) ?? SECTIONS[0];
const tabLabel = (t: Tab) => { const x = sectionOf(t); const l = x.tabs.find(([id]) => id === t)![1]; return x.tabs.length > 1 ? `${x.label} · ${l}` : x.label; };
const CONTRACT_KIND: Record<string, string> = { bounty: '현상금', delivery: '납품', lair: '소굴 토벌', salvage: '인양', mil: '군사' };
interface Actions {
  station(id: string, tab?: 'store' | 'market' | 'prod' | 'build' | 'yard' | 'research' | 'contracts'): void; logistics(): void; analytics(): void; close(): void;
  /** P17.4d: catalogue fitting design (no ship) */ design?(variant: string): void;
  /** P17.4e: show a fleet on the map / open the military contract screen */ fleet?(group: string): void; military?(): void;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n0 = (v: number) => Math.round(v).toLocaleString();
const cr = (v: number) => `${v < 0 ? '−' : ''}${n0(Math.abs(v))} <small>cr</small>`;
const pct = (d: number, t: number) => t > 0 ? Math.max(0, Math.min(100, d / t * 100)) : 0;
const ago = (now: number, t: number) => { const s = Math.max(0, now - t); return s < 90 ? `${Math.round(s)}초 전` : s < 5400 ? `${Math.round(s / 60)}분 전` : `${(s / 3600).toFixed(1)}시간 전`; };
const STATE_CLASS: Record<string, string> = { running: '', waiting: 'waiting', paused: 'paused', done: 'complete', failed: 'failed', cancelled: 'paused' };

export class OperationsPanel {
  private el = document.createElement('div');
  private tab: Tab = 'hq'; private closed = false; private busy = false; private error = ''; private notice = '';
  private search = ''; private stateFilter = 'live'; private kindFilter = ''; private open = new Set<string>(); private item = '';
  /** P17.4b AUD-04: sale search inputs per item (kept across snapshot re-renders) */
  private saleQ: Record<string, SaleSearchState> = {};
  /** P17.4d: fleet goal draft (lines, group, buy) kept across re-renders */
  private fleet?: FleetDraft;
  private scope: Record<string, ApprovalScope> = {}; private goalKind: GoalSpec['k'] = 'stockpile'; private formOpen = false; private fleetFormOpen = false;
  /** P17.4e (E2): screens left through a link (return path), each section's last sub-screen, scroll per screen */
  private back: { tab: Tab; item: string }[] = []; private lastIn: Partial<Record<Section, Tab>> = {};
  private scrollOf: Partial<Record<Tab, number>> = {}; private pendingScroll?: number; private focusItem = '';
  private onSnap = () => this.render();
  private key = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopImmediatePropagation(); this.close(); } };
  constructor(root: HTMLElement, private c: GameClient, private actions: Actions, tab?: Tab) {
    if (tab) this.tab = tab;
    this.el.className = 'modal lg-modal ops-modal'; this.el.tabIndex = -1;
    this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-label', '회사 본부'); this.el.setAttribute('aria-modal', 'true');
    this.el.onkeydown = e => e.stopPropagation();
    this.el.onclick = e => this.click(e);
    this.el.oninput = e => { const t = e.target as HTMLInputElement; if (t.dataset.search !== undefined) { this.search = t.value; this.render(); } };
    this.el.onchange = e => { const t = e.target as HTMLSelectElement; if (t.dataset.filter === 'state') this.stateFilter = t.value; else if (t.dataset.filter === 'kind') this.kindFilter = t.value; else if (t.dataset.scope) this.scope[t.dataset.scope] = t.value as ApprovalScope; else if (t.dataset.goalkind !== undefined) this.goalKind = t.value as GoalSpec['k']; else if (t.dataset.fl && this.fleet) fleetDraftChange(this.fleet, t.dataset.fl, t.value, (t as unknown as HTMLInputElement).checked); else if (t.dataset.flTpl !== undefined && this.fleet) { if (t.value) loadTemplate(this.w, this.me!, this.fleet, t.value); else this.fleet.tpl = ''; } else if (t.dataset.pirDefault !== undefined) { void this.send({ c: 'piracyPolicy', policy: t.value as 'survive' | 'balanced' | 'protect' }, '화물 요구 대응 기본값을 저장했습니다'); return; } else if (t.dataset.saleQ && this.item) { const q = this.saleQ[this.item]; if (q) { const k = t.dataset.saleQ as keyof SaleSearchState; (q as any)[k] = k === 'amount' || k === 'minPrice' ? Math.max(0, Number(t.value) || 0) : t.value; } } else if (t.dataset.prio) { void this.send({ c: 'workOp', work: t.dataset.prio, op: 'priority', value: Number(t.value) }, '우선순위를 바꿨습니다'); return; } else return; this.render(); };
    root.appendChild(this.el); trackSelects(this.el); c.onSnap.push(this.onSnap); window.addEventListener('keydown', this.key, true); this.render(); this.el.focus();
  }
  close() { if (this.closed) return; this.closed = true; const i = this.c.onSnap.indexOf(this.onSnap); if (i >= 0) this.c.onSnap.splice(i, 1); window.removeEventListener('keydown', this.key, true); this.el.remove(); this.actions.close(); document.getElementById('opsBtn')?.focus(); }
  show(tab: Tab) { this.go(tab); this.render(); }
  /** switch screen. `link`: reached from a link inside another screen → that screen goes on the return path */
  private go(tab: Tab, o: { item?: string; link?: boolean } = {}) {
    const body = this.el.querySelector<HTMLElement>('.ops-body'); if (body) this.scrollOf[this.tab] = body.scrollTop;
    if (o.link && (tab !== this.tab || (o.item ?? this.item) !== this.item)) { this.back.push({ tab: this.tab, item: this.item }); if (this.back.length > 8) this.back.shift(); }
    else if (!o.link) this.back = [];
    this.tab = tab; this.lastIn[sectionOf(tab).id] = tab; this.error = ''; this.notice = '';
    if (o.item !== undefined) { this.item = o.item; this.focusItem = o.item; }
    this.pendingScroll = o.item ? undefined : this.scrollOf[tab] ?? 0;
  }
  private goBack() {
    const b = this.back.pop(); if (!b) return;
    const body = this.el.querySelector<HTMLElement>('.ops-body'); if (body) this.scrollOf[this.tab] = body.scrollTop;
    this.tab = b.tab; this.item = b.item; this.lastIn[sectionOf(b.tab).id] = b.tab; this.pendingScroll = this.scrollOf[b.tab] ?? 0; this.error = ''; this.notice = '';
  }

  private get me() { return this.c.company; }
  private get w() { return this.c.state!; }
  private works() { return Object.values(this.w.works ?? {}).filter(x => x.owner === this.me); }
  private approvals() { return Object.values(this.w.approvals ?? {}).filter(x => x.owner === this.me); }

  private async send(command: Cmd, success: string) {
    if (this.busy) return; this.busy = true; this.error = ''; this.notice = ''; this.render();
    try { const error = await this.c.cmd(command); if (this.closed) return; if (error) this.error = error; else this.notice = success; }
    catch { if (!this.closed) this.error = '연결을 확인하고 다시 시도하세요'; }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
  private val(name: string) { return (this.el.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? ''; }
  private numv(name: string) { const v = Number(this.val(name)); return Number.isFinite(v) ? v : NaN; }
  private checked(name: string) { return !!(this.el.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.checked; }

  private click(e: MouseEvent) {
    if (e.target === this.el) return this.close();
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]'); if (!b || this.busy) return;
    const a = b.dataset.a!, id = b.dataset.id ?? '';
    switch (a) {
      case 'close': return this.close();
      case 'tab': this.go(id as Tab); if (b.dataset.form) { if (id === 'fleet') this.fleetFormOpen = true; else this.formOpen = true; } if (b.dataset.kind) this.goalKind = b.dataset.kind as GoalSpec['k']; return this.render();
      case 'sect': { const x = SECTIONS.find(y => y.id === id); if (x) this.go(this.lastIn[x.id] ?? x.tabs[0][0]); return this.render(); }
      case 'back': this.goBack(); return this.render();
      case 'fleet-map': return this.actions.fleet?.(id);
      case 'military': return this.actions.military?.();
      case 'deliver': return void this.send({ c: 'deliverStock', contract: id, upTo: Number(b.dataset.n) }, '보관 재고로 납품했습니다');
      case 'toggle': if (this.open.has(id)) this.open.delete(id); else this.open.add(id); return this.render();
      case 'item': this.item = this.item === id ? '' : id; return this.render();
      case 'station': return this.actions.station(id, (b.dataset.tab as 'build') || undefined);
      case 'goto': this.go(id as Tab, { link: true, ...(b.dataset.item ? { item: b.dataset.item } : {}) }); return this.render();
      case 'quick-stock': {
        const st = b.dataset.st ?? '', item = id; const v = Number(prompt(`${this.stationName(st)}에 ${itemName(item)}을(를) 몇 개 비축할까요? (부족하면 이송·생산·구매로 채웁니다)`, b.dataset.v ?? '100'));
        if (!(v > 0) || !st) return;
        return void this.send({ c: 'workCreate', goal: { k: 'stockpile', station: st, item, target: v, maintain: true, buy: true, produce: true } }, '비축 목표를 등록했습니다');
      }
      case 'quick-fac': {
        const st = b.dataset.st ?? '', kind = id;
        if (!st || !confirm(`${this.stationName(st)}에 ${MODULES[kind]?.name ?? kind}을(를) 1개 더 짓는 목표를 등록할까요? 건설비는 결재 또는 예산으로 승인합니다.`)) return;
        const count = (this.w.stations[st]?.modules ?? []).filter(m => m.kind === kind).length + 1;
        return void this.send({ c: 'workCreate', goal: { k: 'facilities', station: st, kind, count } }, '시설 목표를 등록했습니다');
      }
      case 'logistics': return this.actions.logistics();
      case 'analytics': return this.actions.analytics();
      case 'pause': case 'resume': case 'cancel':
        if (a === 'cancel' && !confirm('이 업무를 취소할까요? 이미 지출한 비용과 적재된 화물은 그대로 남습니다.')) return;
        return void this.send({ c: 'workOp', work: id, op: a }, a === 'pause' ? '일시정지했습니다' : a === 'resume' ? '재개했습니다' : '취소했습니다');
      case 'amount': { const v = Number(prompt('새 목표 수량', b.dataset.v ?? '')); if (v > 0) void this.send({ c: 'workOp', work: id, op: 'amount', value: v }, '수량을 바꿨습니다'); return; }
      case 'budget': { const v = prompt('이 업무의 총 예산 (cr)', b.dataset.v ?? ''); if (v !== null && Number(v) >= 0) void this.send({ c: 'workOp', work: id, op: 'budget', value: Number(v) }, '예산을 설정했습니다'); return; }
      case 'decide': {
        const ap = this.w.approvals?.[id]; const opt = b.dataset.opt!; if (!ap) return;
        const o = ap.options.find(x => x.id === opt); const scope = o?.scopes.includes(this.scope[id] ?? 'once') ? this.scope[id] ?? 'once' : o?.scopes[0] ?? 'once';
        const raw = (this.el.querySelector(`[name="mod-${id}"]`) as HTMLInputElement | null)?.value; const value = opt === 'approve' && raw ? Number(raw) : undefined;
        return void this.send({ c: 'approvalDecide', approval: id, option: opt, scope, ...(value && value > 0 ? { value } : {}) }, '결재를 처리했습니다');
      }
      case 'goal': return this.createGoal();
      case 'fl-add': if (this.fleet && this.fleet.lines.length < 8) this.fleet.lines.push(newLine()); return this.render();
      case 'fl-del': this.fleet?.lines.splice(Number(id), 1); return this.render();
      case 'fl-design': return this.actions.design?.(id);
      case 'fl-tpl-save': { if (!this.fleet) return; const name = (this.el.querySelector('[data-fl-tplname]') as HTMLInputElement | null)?.value.trim() || '함대 구성'; return void this.send(saveTemplateCmd(this.fleet, name), `함대 구성 "${name}"을(를) 저장했습니다 — 비용 없음`); }
      case 'fl-tpl-del': if (this.fleet) this.fleet.tpl = ''; return void this.send({ c: 'delFleetTemplate', id }, '함대 구성을 삭제했습니다');
      case 'form': if (id === 'fleet') this.fleetFormOpen = !this.fleetFormOpen; else this.formOpen = !this.formOpen; return this.render();
      case 'policy': return this.savePolicy();
      case 'lawpay': {
        const cs = b.dataset.lawCase;
        let amount: number | undefined;
        if (b.dataset.lawAmount === 'ask') {
          const v = prompt(`납부할 금액 (cr, 최대 ${b.dataset.lawMax ?? ''})`, b.dataset.lawMax ?? '');
          if (v === null) return;
          amount = Math.floor(Number(v));
          if (!(amount >= 1)) { this.error = '납부 금액이 올바르지 않습니다'; return this.render(); }
        }
        return void this.send({ c: 'lawPay', ...(cs ? { case: cs } : {}), ...(amount ? { amount } : {}) } as Cmd, '벌금을 납부했습니다');
      }
      case 'inv-stock': {
        const row = id; const station = this.val('inv-station'), target = this.numv('inv-target');
        if (!station || !(target > 0)) { this.error = '정거장과 목표 수량을 입력하세요'; return this.render(); }
        return void this.send({ c: 'workCreate', goal: { k: 'stockpile', station, item: row, target, maintain: true, buy: true, produce: true } }, '비축 목표를 등록했습니다');
      }
      case 'inv-buy': {
        const station = this.val('inv-market'), amount = this.numv('inv-amount'); if (!station || !(amount > 0)) { this.error = '시장과 수량을 입력하세요'; return this.render(); }
        return void this.send({ c: 'buy', station, res: id, amount }, '구매했습니다');
      }
      case 'inv-sell': {
        const station = this.val('inv-market'), amount = this.numv('inv-amount'); if (!station || !(amount > 0)) { this.error = '시장과 수량을 입력하세요'; return this.render(); }
        return void this.send({ c: 'sell', station, res: id, amount }, '판매했습니다');
      }
      case 'sale-here': return void this.send({ c: 'sell', station: b.dataset.st!, res: id, amount: Number(b.dataset.n) }, '판매했습니다');
      case 'sale-ship': return void this.send({ c: 'poolCreate', request: { from: b.dataset.from!, to: b.dataset.st!, item: id, kind: 'sell', amount: Number(b.dataset.n), priority: 5, repeat: false } }, '판매 운송을 등록했습니다 — 공용 수송선이 싣고 가서 팝니다');
      case 'xfer': return void this.send({ c: 'poolCreate', request: { from: b.dataset.from!, to: b.dataset.st!, item: id, kind: 'transfer', amount: Number(b.dataset.n), priority: 5, repeat: false } }, '이송 업무를 등록했습니다 — 물류·거래 → 운송에서 진행을 봅니다');
      case 'inv-move': {
        const from = this.val('inv-from'), to = this.val('inv-station'), amount = this.numv('inv-amount'); if (!from || !to || from === to || !(amount > 0)) { this.error = '출발·도착 정거장과 수량을 확인하세요'; return this.render(); }
        return void this.send({ c: 'poolCreate', request: { from, to, item: id, kind: 'transfer', amount, priority: 5, repeat: false } }, '운송 업무를 등록했습니다');
      }
    }
  }
  private createGoal() {
    const k = this.tab === 'fleet' ? 'fleet' : this.goalKind; let goal: GoalSpec;
    const budget = this.numv('g-budget'), maxPrice = this.numv('g-price');
    switch (k) {
      case 'stockpile': goal = { k, station: this.val('g-station'), item: this.val('g-item'), target: this.numv('g-n'), maintain: this.checked('g-maintain'), buy: this.checked('g-buy'), produce: this.checked('g-produce'), ...(this.val('g-scope') === 'company' ? { scope: 'company' as const } : {}) }; break;
      case 'trade': goal = { k, item: this.val('g-item'), from: this.val('g-from'), to: this.val('g-station'), amount: this.numv('g-n'), maxBuy: this.numv('g-maxbuy'), minSell: this.numv('g-minsell'), minProfit: this.numv('g-minprofit') || 0, cycles: Math.floor(this.numv('g-cycles') || 0) }; break;
      case 'fleet': if (!this.fleet) return; goal = fleetGoal(this.fleet); break;
      case 'facilities': goal = { k, station: this.val('g-station'), kind: this.val('g-fac'), count: Math.floor(this.numv('g-n')) }; break;
      case 'survey_field': goal = { k, field: this.val('g-field'), group: this.val('g-group'), samples: Math.floor(this.numv('g-n')), ...(this.val('g-station') ? { deliver: this.val('g-station') } : {}) }; break;
      case 'develop_field': goal = { k, field: this.val('g-field'), group: this.val('g-group'), sell: this.checked('g-sell'), miners: Math.floor(this.numv('g-n') || 0), ...(this.val('g-station') ? { deliver: this.val('g-station') } : {}), ...(this.val('g-yard') ? { yard: this.val('g-yard') } : {}) }; break;
      default: goal = { k: 'condition', station: this.val('g-station'), item: this.val('g-item'), side: this.val('g-side') === 'sell' ? 'sell' : 'buy', price: this.numv('g-cond'), amount: this.numv('g-n'), repeat: this.checked('g-repeat') };
    }
    void this.send({ c: 'workCreate', goal, ...(budget > 0 ? { budget } : {}), ...(maxPrice > 0 ? { maxPrice } : {}) }, '목표를 등록했습니다');
  }
  private savePolicy() {
    const policy = { autonomy: (this.val('p-autonomy') === 'auto' ? 'auto' : 'ask') as 'auto' | 'ask', minCredits: this.numv('p-min'), hourlyLimit: this.numv('p-hour'), autoApproveBelow: this.numv('p-small'), maxRisk: this.numv('p-risk'), delegatedBudget: this.numv('p-deleg'), preferProduce: this.checked('p-produce') };
    if (Object.values(policy).some(v => typeof v === 'number' && !(v >= 0))) { this.error = '정책 값은 0 이상이어야 합니다'; return this.render(); }
    void this.send({ c: 'opsPolicy', policy }, '위임 정책을 저장했습니다');
  }

  // ─────────────────────────────────────────────────────────────── render
  private render() {
    if (this.closed) return;
    if (!this.c.state) { this.el.innerHTML = '<div class="panel lg-box"><p>회사 상태를 기다리는 중…</p></div>'; return; }
    const w = this.w, co = w.companies[this.me]; if (!co) return;
    const aps = this.approvals().filter(a => a.state === 'open');
    const live = this.works().filter(x => !terminal(x));
    const T = this.tab;
    const body = T === 'hq' ? this.hq() : T === 'works' ? this.workTab() : T === 'fleet' ? this.fleetTab() : T === 'stock' ? this.stockTab() : T === 'industry' ? this.industryTab() : T === 'research' ? this.researchTab() : T === 'logistics' ? this.logisticsTab() : T === 'build' ? this.buildTab() : T === 'fields' ? this.fieldsTab() : T === 'contracts' ? this.contractsTab() : T === 'rep' ? companyRepHtml(this.w as never, this.me) : this.financeTab();
    const sec = sectionOf(T), prev = this.back.at(-1);
    const badge = (x: Section) => x === 'hq' && aps.length ? ` <span class="ops-dot" title="결재 대기">${aps.length}</span>` : x === 'ops' && this.myContracts().length ? ` <span class="ops-dot neutral" title="수주한 계약">${this.myContracts().length}</span>` : '';
    morph(this.el, `<div class="panel lg-box ops-box"><header class="lg-head"><div><h2>회사 본부 <span>${esc(co.name)} · 진행 업무 ${live.length} · 결재 대기 ${aps.length}</span></h2></div><div class="lg-actions"><button class="btn" data-a="close" aria-label="본부 닫기">✕</button></div></header>
      <nav class="pool-tabs ops-tabs" aria-label="본부 영역">${SECTIONS.map(x => `<button class="${sec.id === x.id ? 'on' : ''}" data-a="sect" data-id="${x.id}" aria-pressed="${sec.id === x.id}">${x.label}${badge(x.id)}</button>`).join('')}</nav>
      ${sec.tabs.length > 1 ? `<nav class="ops-subtabs" aria-label="${sec.label} 화면">${sec.tabs.map(([id, l]) => `<button class="${T === id ? 'on' : ''}" data-a="tab" data-id="${id}" aria-pressed="${T === id}">${l}${id === 'finance' && aps.length ? ` <span class="ops-dot">${aps.length}</span>` : ''}</button>`).join('')}</nav>` : ''}
      ${prev ? `<div class="ops-back"><button class="btn mini" data-a="back">← 돌아가기: ${esc(tabLabel(prev.tab))}${prev.item ? ` · ${esc(itemName(prev.item))}` : ''}</button></div>` : ''}
      ${this.error ? `<div class="lg-feedback warn" role="alert">${esc(this.error)}</div>` : this.notice ? `<div class="lg-feedback good" role="status">${esc(this.notice)}</div>` : ''}
      <div class="ops-body">${body}</div>
      <footer class="lg-foot"><span></span><span><button class="an-link" data-a="logistics">물류 관리</button> · <button class="an-link" data-a="analytics">경제 · 월드</button></span></footer></div>`);
    const bodyEl = this.el.querySelector<HTMLElement>('.ops-body');
    if (bodyEl && this.focusItem) { bodyEl.querySelector<HTMLElement>(`tr[data-a="item"][data-id="${CSS.escape(this.focusItem)}"]`)?.scrollIntoView({ block: 'start' }); this.focusItem = ''; }
    else if (bodyEl && this.pendingScroll !== undefined) bodyEl.scrollTop = this.pendingScroll;
    this.pendingScroll = undefined;
  }
  private myContracts() { return Object.values(this.w.contracts).filter(k => k.takenBy === this.me && !k.done); }

  private hourly() {
    const co = this.w.companies[this.me], led = co.ops?.ledger ?? [], now = Math.floor(this.w.time / 3600);
    const sum = (h: typeof led[number] | undefined, side: 'inc' | 'exp') => h ? Object.values(h[side]).reduce((a, b) => a + b, 0) : 0;
    const last = led.find(h => h.h === now - 1), cur = led.find(h => h.h === now);
    // P17.4e: a partial hour is shown as it is (an early purchase extrapolated to a full hour read as a huge hourly loss)
    const base = last ?? cur;
    return { inc: sum(base, 'inc'), exp: sum(base, 'exp'), basis: last ? '직전 1시간' : `이번 시간 ${Math.floor((this.w.time % 3600) / 60)}분 누계` };
  }
  private stationName(id?: string) { return id ? this.w.stations[id]?.name ?? id : ''; }
  private workRow(x: Work, depth = 0): string {
    const kids = this.works().filter(k => k.parent === x.id), open = this.open.has(x.id);
    const p = x.progress, bar = p.total > 0 ? pct(p.done, p.total) : x.state === 'done' ? 100 : 0;
    const goal = GOAL_KINDS.includes(x.kind), st = x.ref.station;
    const ctrl = terminal(x) ? '' : `${x.state === 'paused' ? `<button class="btn" data-a="resume" data-id="${x.id}">재개</button>` : `<button class="btn" data-a="pause" data-id="${x.id}">일시정지</button>`}<button class="btn warnb" data-a="cancel" data-id="${x.id}">취소</button>
      ${goal || x.kind === 'production' ? `<button class="btn" data-a="amount" data-id="${x.id}" data-v="${p.total}">수량</button>` : ''}${goal ? `<button class="btn" data-a="budget" data-id="${x.id}" data-v="${x.budget?.limit ?? ''}">예산</button>` : ''}
      <label class="ops-prio">우선 <select aria-label="우선순위" data-prio="${x.id}">${[...Array(10).keys()].map(v => `<option value="${v}" ${v === x.priority ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
    return `<div class="ops-work ${STATE_CLASS[x.state]} ${depth ? 'child' : ''}">
      <div class="ops-work-top">${kids.length ? `<button class="an-link" data-a="toggle" data-id="${x.id}" aria-expanded="${open}">${open ? '▾' : '▸'} ${kids.length}</button>` : ''}<span class="ops-kind">${KIND_NAME[x.kind]}${x.auto ? ' · 자동' : ''}</span><b>${esc(x.title)}</b><span class="lg-badge ${STATE_CLASS[x.state]}">${STATE_NAME[x.state]}</span></div>
      <div class="ops-progress" role="progressbar" aria-valuenow="${Math.round(bar)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${bar}%"></i></div>
      <div class="ops-meta">${p.total > 0 ? `<span>${n0(p.done)} / ${n0(p.total)} ${esc(p.unit ?? '')}</span>` : ''}${x.reason ? `<span class="ops-why">${esc(x.reason)}</span>` : ''}${x.result ? `<span class="good">${esc(x.result)}</span>` : ''}${x.cost ? `<span>지출 ${n0(x.cost)} cr</span>` : ''}${x.income ? `<span>수입 ${n0(x.income)} cr</span>` : ''}${x.budget ? `<span>예산 ${x.budget.open ? '목표 전체 승인' : `${n0(x.budget.spent)} / ${n0(x.budget.limit)} cr`}${x.budget.maxPrice ? ` · 단가 ≤ ${n0(x.budget.maxPrice)}` : ''}</span>` : ''}<span>${ago(this.w.time, x.updated)}</span>${st && this.w.stations[st] ? `<button class="an-link" data-a="station" data-id="${st}" data-tab="${x.kind === 'production' ? 'prod' : x.kind === 'ship' ? 'yard' : x.kind === 'facility' ? 'build' : 'store'}">${esc(this.stationName(st))} 열기</button>` : ''}</div>
      ${x.kind === 'fleet' && !terminal(x) && x.rt?.ships?.length ? `<div class="ops-ships">${x.rt.ships.slice(0, 12).map(z => `<span class="${z.pct < 0 ? 'waiting' : ''}" title="${esc(z.why ?? '')}">${esc(this.w.works?.[z.work]?.title.split(' · ').pop()?.replace(/ 건조$/, '') ?? '함선')} ${z.pct < 0 ? `대기${z.why ? ` — ${esc(z.why.slice(0, 40))}` : ''}` : `${z.pct}%`}</span>`).join('')}</div>` : ''}
      ${x.log.length && open ? `<ol class="ops-log">${x.log.slice(-6).map(l => `<li><span>${ago(this.w.time, l.t)}</span> ${esc(l.text)}</li>`).join('')}</ol>` : ''}
      ${!terminal(x) && x.state !== 'running' ? this.fixes(x) : ''}
      ${ctrl ? `<div class="lg-card-actions">${ctrl}</div>` : ''}
      ${open ? kids.sort((a, b) => b.created - a.created).slice(0, 30).map(k => this.workRow(k, depth + 1)).join('') : ''}</div>`;
  }

  /** what the player can do about a waiting work, derived from its reason */
  private fixes(x: Work): string {
    // P17.4b AUD-09: the server classifies every wait (x.wait.code, since when); the generic recovery actions come from
    // that code, and the specific shortcuts (facility / stockpile goals) are added from the reason's details
    const why = x.reason ?? '', st = x.ref.station ?? (x.goal && 'station' in x.goal ? x.goal.station : undefined), out: string[] = [];
    const code = x.wait?.code ?? (x.state === 'waiting' ? waitCode(why) : undefined);
    const ap = this.approvals().find(a => a.work === x.id && a.state === 'open');
    const item = x.ref.item ?? (x.goal && 'item' in x.goal ? x.goal.item as string : undefined);
    const seen = new Set<string>();
    const add = (key: string, html: string) => { if (!seen.has(key)) { seen.add(key); out.push(html); } };
    if (ap) add('finance', `<button class="btn go" data-a="goto" data-id="finance">결재함에서 결정</button>`);
    for (const a of code ? waitActions(code, { station: st && this.w.stations[st] ? st : undefined, item }) : []) {
      const html = a.go === 'logistics' ? `<button class="btn" data-a="logistics">${esc(a.label)}</button>`
        : a.go === 'market' || a.go === 'store' ? `<button class="btn" data-a="station" data-id="${st}" data-tab="${a.go === 'store' && this.w.stations[st!]?.owner === this.me && code === 'storage' ? 'build' : a.go}">${esc(a.go === 'store' && this.w.stations[st!]?.owner === this.me && code === 'storage' ? '창고 증설' : a.label)}</button>`
        : a.go === 'sale' ? `<button class="btn" data-a="goto" data-id="stock" data-item="${item}">${esc(a.label)}</button>`
        : `<button class="btn${a.go === 'finance' && code === 'approval' ? ' go' : ''}" data-a="goto" data-id="${a.go}"${a.go === 'stock' && item ? ` data-item="${item}"` : ''}>${esc(a.label)}</button>`;
      add(a.go === 'finance' && code === 'approval' ? 'finance' : `${a.go}:${a.label}`, html);
    }
    const fac = /(\S+) 필요\)/.exec(why) ?? /(\S+) 없음/.exec(why);
    const facKind = fac ? Object.values(MODULES).find(m => why.includes(m.name))?.kind : undefined;
    if (facKind && st && this.w.stations[st]?.owner === this.me) add(`fac:${facKind}`, `<button class="btn" data-a="quick-fac" data-id="${facKind}" data-st="${st}">${esc(MODULES[facKind].name)} 건설 목표</button>`);
    const short = /(?:원료 부족|자재 확보 중|부품 부족|조달)[: ]+([^·;]+)/.exec(why);
    if (short && st) {
      const it = Object.keys(ITEMS).find(i => short[1].includes(ITEMS[i].name));
      if (it) add(`stock:${it}`, `<button class="btn" data-a="quick-stock" data-id="${it}" data-st="${st}">${esc(ITEMS[it].name)} 비축 목표</button><button class="btn" data-a="goto" data-id="stock" data-item="${it}">재고 위치 보기</button>`);
    }
    if (/전력/.test(why) && st) add('power', `<button class="btn" data-a="station" data-id="${st}" data-tab="build">발전소 건설</button>`);
    if (x.kind === 'operation' && /배속된 함선 없음/.test(why)) add('assign', '<span class="dim">함대 패널에서 이 부대에 함선을 배속하세요</span>');
    const head = code ? `<span class="dim">${esc(WAIT_NAME[code])}${x.wait ? ` · ${ago(this.w.time, x.wait.since).replace(' 전', '째')}` : ''}</span>` : '<span class="dim">해결</span>';
    return out.length || code ? `<div class="lg-card-actions ops-fix">${head}${out.join('')}</div>` : '';
  }

  private hq() {
    const w = this.w, co = w.companies[this.me], h = this.hourly(), upkeep = co.upkeep?.bill?.perHour ?? 0;
    const ws = this.works(), live = ws.filter(x => !terminal(x)), goals = live.filter(x => GOAL_KINDS.includes(x.kind));
    const delayed = live.filter(x => x.state === 'waiting' && w.time - x.created > 600);
    const failed = ws.filter(x => x.state === 'failed' && w.time - (x.finished ?? 0) < 3600);
    const aps = this.approvals().filter(a => a.state === 'open');
    const issues = [
      ...failed.map(x => ({ t: x.title, why: x.reason, how: '실패 — 원인 확인 후 다시 등록 필요' })),
      ...(co.upkeep?.debt ? [{ t: '운영 유지비 미납', why: `${n0(co.upkeep.debt)} cr 연체`, how: '수입 발생 시 자동 상환 · 재무 화면 확인' }] : []),
      ...delayed.slice(0, 6).map(x => ({ t: x.title, why: x.reason, how: aps.some(a => a.work === x.id) ? '결재 대기 — 다른 업무는 계속 진행' : '자동 재계획 중' })),
    ];
    return `<div class="lg-summary ops-kpi"><div><span>보유 자금</span><b class="money">${cr(co.credits)}</b></div><div><span>수입 <small>${h.basis}</small></span><b class="good">${cr(h.inc)}</b></div><div><span>지출 <small>${h.basis}</small></span><b class="warn">${cr(h.exp)}</b></div><div><span>순이익 <small>${h.basis}</small></span><b class="${h.inc - h.exp >= 0 ? 'good' : 'warn'}">${cr(h.inc - h.exp)}</b></div><div><span>예상 유지비 / 시간</span><b>${cr(upkeep)}</b></div><div><span>진행 업무 · 목표</span><b>${live.length} · ${goals.length}</b></div></div>
      ${this.areas()}
      <div class="ops-cols"><section class="pool-section"><div class="pool-section-head"><div><h3>회사 목표 <small>${goals.length}</small></h3></div><button class="btn mini" data-a="tab" data-id="works" data-form="1">+ 새 목표</button></div>
        ${goals.length ? goals.map(x => this.workRow(x)).join('') : '<p class="dim">진행 중인 목표 없음</p>'}</section>
      <section class="pool-section"><div class="pool-section-head"><div><h3>확인할 문제 <small>${issues.length}</small></h3></div></div>
        ${issues.length ? issues.map(i => `<div class="proc-source"><div class="proc-source-head"><strong>${esc(i.t)}</strong></div><div>${esc(i.why)}</div><div class="dim">${esc(i.how)}</div></div>`).join('') : '<p class="dim">없음</p>'}
        <div class="pool-section-head" style="margin-top:20px"><div><h3>결재 대기 <small>${aps.length}</small></h3></div>${aps.length ? '<button class="btn mini" data-a="tab" data-id="finance">결재함</button>' : ''}</div>
        ${aps.slice(0, 4).map(a => `<div class="proc-source"><strong>${esc(a.title)}</strong><div>${esc(a.reason)}</div><div class="dim">추정 ${n0(a.estimate.cost)} cr</div></div>`).join('')}
        <h3 class="ops-h3">최근 완료</h3>${ws.filter(x => x.state === 'done').sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0)).slice(0, 6).map(x => `<div class="proc-plan"><b>${esc(x.title)}</b> <span>${ago(w.time, x.finished ?? x.updated)}</span><p>${esc(x.result ?? '')}</p></div>`).join('') || '<p class="dim">아직 없음</p>'}</section></div>`;
  }

  /** P17.4e: one line per area — what needs the player there — with a way in */
  private areas() {
    const w = this.w, me = this.me, ws = this.works().filter(x => !terminal(x));
    const own = Object.values(w.stations).filter(s => s.owner === me);
    const ships = Object.values(w.ships).filter(s => s.owner === me);
    const building = own.reduce((n, s) => n + (s.builds ?? []).length, 0), damaged = ships.filter(s => s.hp < 0.7).length;
    const blocked = own.reduce((n, s) => n + (s.orders ?? []).filter(o => o.why && !/가동 중|목표 재고 도달|완료/.test(o.why) && !(s.jobs ?? []).some(j => j.order === o.id)).length, 0);
    const jobs = Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === me && j.state !== 'complete' && j.state !== 'cancelled');
    const ks = this.myContracts(), q = w.companies[me].research ?? [];
    const area = (sect: Section, label: string, main: string, warn: string) => `<button class="ops-area" data-a="sect" data-id="${sect}"><b>${label}</b><span>${main}</span>${warn ? `<span class="warn">${warn}</span>` : ''}</button>`;
    return `<div class="ops-areas">
      ${area('fleet', '함대', `함선 ${ships.length} · 건조 ${building}`, damaged ? `손상 ${damaged}척` : '')}
      ${area('industry', '산업', `생산 주문 ${own.reduce((n, s) => n + (s.orders ?? []).length, 0)}`, blocked ? `병목 ${blocked}` : '')}
      ${area('trade', '물류·거래', `운송 ${jobs.length}`, jobs.filter(j => !j.ship).length ? `배차 대기 ${jobs.filter(j => !j.ship).length}` : '')}
      ${area('ops', '계약·작전', `수주 계약 ${ks.length}`, ks.filter(k => k.expires - w.time < 600).length ? `마감 10분 이내 ${ks.filter(k => k.expires - w.time < 600).length}` : '')}
      ${area('research', '연구', `대기열 ${q.length}`, q.filter(p => p.why).length ? `대기 사유 ${q.filter(p => p.why).length}` : '')}
      ${area('hq', '업무', `진행 ${ws.length}`, ws.filter(x => x.state === 'waiting').length ? `대기 ${ws.filter(x => x.state === 'waiting').length}` : '')}</div>`;
  }

  /** P17.4e: fleet area — fleet goals and builds, the company's fleets, and the three kinds of repair kept apart (AUD-17) */
  private fleetTab() {
    const w = this.w, me = this.me, own = Object.values(w.stations).filter(s => s.owner === me);
    const groups = Object.values(w.groups).filter(g => g.owner === me && !g.parentId);
    const ships = Object.values(w.ships).filter(s => s.owner === me);
    const items = this.works().filter(x => ['ship', 'fleet'].includes(x.kind) && !terminal(x));
    const unreg = own.flatMap(s => (s.builds ?? []).filter(b => !items.some(x => x.ref.build === b.id)).map(b => `<div class="proc-plan"><b>${esc(s.name)} · ${esc(b.hull ? CONTENT.hulls[b.hull]?.name : b.classId)}</b> <span>${b.started ? `${Math.round(100 * (1 - b.left / Math.max(1e-6, b.total)))}%` : esc(b.why ?? '대기')}</span></div>`));
    const opsW = this.works().filter(x => x.kind === 'operation' && !terminal(x));
    const OPN: Record<string, string> = { idle: '대기', move: '이동', dock: '정박', mine: '채굴', haul: '운송', patrol: '순찰', escort: '호위', attack: '공격', build: '건설', salvage: '인양', repairbiz: '수리업', repairzone: '수리 구역', fieldrepair: '현장 수리' };
    const subOf = (gid: string): string[] => [gid, ...Object.values(w.groups).filter(g => g.parentId === gid).flatMap(g => subOf(g.id))];
    const groupRow = (g: (typeof groups)[number]) => {
      const ids = subOf(g.id).flatMap(id => w.groups[id]?.shipIds ?? []).filter(id => w.ships[id]);
      const dmg = ids.filter(id => w.ships[id].hp < 0.7).length, cmdr = g.commanderId ? w.commanders?.[g.commanderId]?.name : undefined;
      return `<tr><td><button class="an-link" data-a="fleet-map" data-id="${g.id}">${esc(g.name)}</button></td><td>${ids.length}</td><td>${esc(OPN[g.op.k] ?? g.op.k)}</td><td>${cmdr ? esc(cmdr) : '<span class="dim">없음</span>'}</td><td>${dmg ? `<span class="warn">${dmg}</span>` : '0'}</td></tr>`;
    };
    return `<div class="lg-summary"><div><span>편대</span><b>${groups.length}</b></div><div><span>함선</span><b>${ships.length}</b></div><div><span>건조 중</span><b>${own.reduce((n, s) => n + (s.builds ?? []).length, 0)}</b></div><div><span>내구 70% 미만</span><b class="${ships.some(s => s.hp < 0.7) ? 'warn' : ''}">${ships.filter(s => s.hp < 0.7).length}</b></div></div>
      ${this.goalForm('fleet')}
      <h3 class="ops-h3">함대 목표·건조 <small>${items.length}</small></h3>
      ${items.sort((a, b) => b.priority - a.priority || a.created - b.created).map(x => this.workRow(x)).join('') || '<p class="dim">없음</p>'}
      ${unreg.length ? `<p class="dim small">업무 편입 대기 (몇 초 안에 편입)</p>${unreg.join('')}` : ''}
      <h3 class="ops-h3">편대 <small>${groups.length}</small></h3>
      <div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>편대</th><th>함선</th><th>명령</th><th>지휘관</th><th>손상</th></tr></thead><tbody>${groups.map(groupRow).join('') || '<tr><td colspan="5" class="dim">없음</td></tr>'}</tbody></table></div>
      <p class="dim small">편대 이름을 누르면 지도에서 편대를 선택합니다. 장교 배정과 출격은 편대 패널·장교 화면에서 지시합니다.</p>
      ${opsW.length ? `<h3 class="ops-h3">지속 작전 <small>${opsW.length}</small></h3>${opsW.map(x => this.workRow(x)).join('')}` : ''}
      ${this.repairHtml()}`;
  }

  /** AUD-17: hauler recovery (automatic, a cost), own-ship maintenance (station repair / field repair, a cost) and the
   *  paid repair business (repairing other companies' and factions' ships, income) — separate lines, separate books */
  private repairHtml() {
    const w = this.w, me = this.me, co = w.companies[me], led = co.ops?.ledger ?? [];
    const tot = (side: 'inc' | 'exp', c: string) => led.reduce((n, h) => n + (h[side][c] ?? 0), 0);
    const ships = Object.values(w.ships).filter(s => s.owner === me);
    const recov = ships.filter(s => s.repairAt), rp = co.procurement?.repair, svc = co.repairService;
    const biz = Object.values(w.groups).filter(g => g.owner === me && g.op.k === 'repairbiz');
    const field = Object.values(w.groups).filter(g => g.owner === me && (g.op.k === 'repairzone' || g.op.k === 'fieldrepair'));
    const row = (name: string, kind: string, state: string, money: string, how: string) => `<tr><td><b>${name}</b><div class="dim small">${kind}</div></td><td>${state}</td><td>${money}</td><td class="small">${how}</td></tr>`;
    return `<h3 class="ops-h3">수리·정비 <small>장부 ${led.length}시간</small></h3>
      <div class="ops-table-wrap"><table class="ops-table ops-repair"><thead><tr><th>구분</th><th>현재</th><th>장부</th><th>설정</th></tr></thead><tbody>
      ${row('수송선 복구', '배차에서 빠진 손상 수송선을 수리 정거장에 보냈다가 복귀 · 자동 · 비용', `${rp?.enabled ? '켜짐' : '<span class="dim">꺼짐</span>'} · 수리 이동 ${recov.length}척`, `지출 ${n0(tot('exp', 'hauler_recovery'))} cr`, '물류·거래 → 재고·판매의 판매 정책 아래 "자동 운영"')}
      ${row('자사 함선 정비', '정거장 수리·개장 + 수리선의 현장 수리 · 비용', `현장 수리 지시 ${field.length}편대 · 손상 ${ships.filter(s => s.hp < 0.999).length}척`, `정거장 ${n0(tot('exp', 'repair'))} cr · 현장 ${n0(tot('exp', 'repair_fleet'))} cr`, '정거장 → 수리·개조 / 수리선 편대 패널의 "자사 함선 현장 정비"')}
      ${row('외부 유료 수리 이용', '다른 회사 수리선에게 돈을 내고 받는 현장 수리 · 비용', svc?.enabled ? `켜짐 · 상한 ×${svc.maxMul}` : '<span class="dim">꺼짐</span>', `지출 ${n0(tot('exp', 'repair_service'))} cr`, '자동 운영 설정의 "외부 수리 이용"')}
      ${row('유료 수리업', '자사 수리선이 다른 회사·세력 함선을 고치고 받는 돈 · 수입', `${biz.length}편대 영업`, `<span class="good">수입 ${n0(tot('inc', 'repair_biz'))} cr</span>`, '수리선 편대 패널의 "유료 수리업"')}
      </tbody></table></div>`;
  }

  /** P17.4e: contracts the company holds, with their goods' stock and a way to deliver / ship them; law and piracy */
  private contractsTab() {
    const w = this.w, me = this.me, ks = this.myContracts().sort((a, b) => a.expires - b.expires);
    const inv = new Map(companyInventory(w as never, me).map(r => [r.item, r]));
    const card = (k: (typeof ks)[number]) => {
      const left = Math.max(0, Math.round((k.expires - w.time) / 60)), item = k.res;
      const r = item ? inv.get(item) : undefined, here = item ? qty(w.stations[k.stationId]?.storage[me], item) : 0;
      const owed = Math.max(0, (k.amount ?? 0) - k.progress);
      const del = directDeliverable(k) ? deliveryQuote({ st: w as never }, me, k) : undefined;
      const n = del ? Math.floor(Math.min(del.remaining, del.usable)) : 0;
      return `<div class="ops-work${left < 10 ? ' waiting' : ''}"><div class="ops-work-top"><span class="ops-kind">${CONTRACT_KIND[k.kind] ?? k.kind}</span><b>${esc(k.title)}</b><span class="lg-badge">${left}분 남음</span></div>
        <div class="ops-meta"><span>${esc(this.stationName(k.stationId))}</span><span>보수 ${n0(k.reward)} cr</span>${k.amount ? `<span>진행 ${n0(k.progress)} / ${n0(k.amount)}</span>` : ''}
          ${item ? `<span>${esc(itemName(item))}: 납품지 보관 ${n0(here)} · 회사 총량 ${n0(r?.total ?? 0)} · 가용 ${n0(r?.available ?? 0)}</span>` : ''}</div>
        ${del?.why ? `<div class="ops-meta"><span class="ops-why">${esc(del.why)}</span></div>` : ''}
        <div class="lg-card-actions">${n >= 1 ? `<button class="btn go" data-a="deliver" data-id="${k.id}" data-n="${Math.round(k.progress + n)}">보관 재고 ${n0(n)} 납품</button>` : ''}
          ${item && owed > here ? `<button class="btn" data-a="goto" data-id="stock" data-item="${esc(item)}">${esc(itemName(item))} 재고·운송</button>` : ''}
          ${k.kind === 'mil' ? '<button class="btn" data-a="military">군사 계약 화면</button>' : `<button class="btn" data-a="station" data-id="${k.stationId}" data-tab="contracts">게시 정거장</button>`}</div></div>`;
    };
    return `<div class="lg-summary"><div><span>수주 계약</span><b>${ks.length}</b></div><div><span>보수 합계</span><b class="money">${cr(ks.reduce((a, k) => a + k.reward, 0))}</b></div><div><span>마감 10분 이내</span><b class="${ks.some(k => k.expires - w.time < 600) ? 'warn' : ''}">${ks.filter(k => k.expires - w.time < 600).length}</b></div></div>
      ${ks.map(card).join('') || '<p class="dim">수주한 계약 없음 — 정거장의 계약 게시판에서 수주합니다.</p>'}
      ${this.actions.military ? '<p><button class="btn mini" data-a="military">군사 계약 화면</button></p>' : ''}
      ${companyPiracyHtml(this.w as never, this.me)}${companyLawHtml(this.w as never, this.me)}`;
  }

  private goalForm(only?: GoalSpec['k']) {
    const w = this.w, me = this.me, k = only ?? this.goalKind, open = only ? this.fleetFormOpen : this.formOpen;
    const own = Object.values(w.stations).filter(s => s.owner === me), usable = Object.values(w.stations).filter(s => s.owner === me || s.public);
    const markets = Object.values(w.stations).filter(s => s.public && s.market);
    const opt = (list: { id: string; name: string }[], name: string) => `<select data-keep name="${name}">${list.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`;
    const items = Object.entries(ITEMS).map(([id, d]) => ({ id, name: d.name }));
    const field = (label: string, html: string) => `<label>${label}${html}</label>`;
    const num = (name: string, v = '') => `<input type="number" min="0" name="${name}" value="${v}">`;
    const kinds: [GoalSpec['k'], string][] = [['stockpile', '재고 비축'], ['trade', '반복 무역'], ['fleet', '함선 N척 건조'], ['facilities', '시설 N개 확보'], ['condition', '가격 조건 거래'], ...((w as any).intel ? [['survey_field', '광구 시험 채굴'], ['develop_field', '광구 개발']] as [GoalSpec['k'], string][] : [])];
    const fields = Object.values(w.fields).filter(x => !x.salvage).map(x => ({ id: x.id, name: x.name + ((x as any).unidentified ? ' (미확인)' : '') }));
    const groups = Object.values(w.groups).filter(g => g.owner === me && g.shipIds.some(id => w.ships[id] && econOf(w.ships[id]).mine > 0)).map(g => ({ id: g.id, name: g.name }));
    const optE = (list: { id: string; name: string }[], name: string, empty: string) => `<select data-keep name="${name}"><option value="">${empty}</option>${list.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`;
    let f = '';
    if (k === 'stockpile') f = field('범위', '<select data-keep name="g-scope"><option value="station">특정 정거장에 비축</option><option value="company">회사 전체 합계로 비축</option></select>') + field('정거장 (회사 전체: 구매품 입고지)', opt(usable, 'g-station')) + field('품목', opt(items, 'g-item')) + field('목표 수량', num('g-n', '3000')) + `<label class="ops-check"><input type="checkbox" name="g-maintain" checked> 계속 유지</label><label class="ops-check"><input type="checkbox" name="g-produce" checked> 자체 생산 우선</label><label class="ops-check"><input type="checkbox" name="g-buy" checked> 부족분 구매 허용</label>`;
    else if (k === 'trade') f = field('품목', opt(items, 'g-item')) + field('매입 시장', opt(markets, 'g-from')) + field('판매 시장', opt(markets, 'g-station')) + field('회당 수량', num('g-n', '400')) + field('최대 매입가', num('g-maxbuy')) + field('최소 판매가', num('g-minsell')) + field('회당 최소 이익', num('g-minprofit', '0')) + field('반복 횟수 (0=계속)', num('g-cycles', '0'));
    else if (k === 'fleet') { this.fleet ??= newDraft(w, me!); if (!w.stations[this.fleet.station]) this.fleet.station = own[0]?.id ?? ''; }
    else if (k === 'facilities') f = field('정거장', opt(own, 'g-station')) + field('시설', opt(Object.values(MODULES).filter(m => m.kind !== 'core').map(m => ({ id: m.kind, name: m.name })), 'g-fac')) + field('개수', num('g-n', '2'));
    else if (k === 'survey_field') f = field('광구', opt(fields, 'g-field')) + field('채굴 편대', opt(groups, 'g-group')) + field('목표 표본 수', num('g-n', '300')) + field('하역 정거장', optE(usable, 'g-station', '자동 선택 (창고 보관)'));
    else if (k === 'develop_field') f = field('광구', opt(fields, 'g-field')) + field('채굴 편대', opt(groups, 'g-group')) + field('목표 채굴선 수', num('g-n', '3')) + field('하역 정거장', optE(usable, 'g-station', '자동 선택')) + field('증원 조선소 (선택)', optE(own, 'g-yard', '증원 안 함')) + '<label class="ops-check"><input type="checkbox" name="g-sell"> 하역 시 판매 (끄면 창고 보관·내부 공급)</label>';
    else f = field('시장', opt(markets, 'g-station')) + field('품목', opt(items, 'g-item')) + field('구분', '<select data-keep name="g-side"><option value="buy">이하일 때 구매</option><option value="sell">이상일 때 판매</option></select>') + field('기준 가격', num('g-cond')) + field('수량', num('g-n', '100')) + '<label class="ops-check"><input type="checkbox" name="g-repeat"> 반복</label>';
    return `<div class="ops-goal-form"><button class="btn ${open ? '' : 'go'}" data-a="form" data-id="${only ?? ''}" aria-expanded="${open}">${open ? '− 목표 입력 닫기' : only === 'fleet' ? '+ 함대 건조 목표' : '+ 새 회사 목표'}</button>${!open ? '</div>' : ''}${open ? `<div class="proc-policy-form"><div class="proc-policy-grid">${only ? '' : field('목표 종류', `<select data-goalkind>${kinds.map(([id, l]) => `<option value="${id}" ${id === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}${f}${field('예산 (cr, 비우면 결재)', num('g-budget'))}${field('최대 단가 (선택)', num('g-price'))}</div>${k === 'fleet' && this.fleet ? fleetFormHtml(w, me!, this.fleet) : ''}
      <p class="dim">예산 안에서는 묻지 않고 진행하고, 비워 두면 돈이 필요할 때 결재를 한 번 요청합니다.</p><button class="btn go" data-a="goal">목표 등록</button></div></div>` : ''}`;
  }
  private fieldsTab() {
    const works = this.works().filter(x => (x.kind === 'survey_field' || x.kind === 'develop_field') && x.goal && 'field' in x.goal).map(x => ({ field: (x.goal as any).field as string, title: x.title, state: STATE_NAME[x.state] + (x.reason ? ` · ${x.reason}` : '') }));
    return `<section class="ops-section"><h3>광구 관리</h3><p class="dim">자사 함선이 발견하고 실제로 채굴한 결과만 표시합니다. 다른 회사의 탐사 정보는 보이지 않습니다.</p>${fieldPanelHtml(this.w, this.me!, works)}
      <p><button class="btn" data-a="tab" data-id="works" data-form="1">+ 광구 시험 채굴·개발 목표</button></p></section>`;
  }
  private workTab() {
    const q = this.search.toLowerCase(), all = this.works();
    const match = (x: Work) => (!q || x.title.toLowerCase().includes(q) || (x.reason ?? '').toLowerCase().includes(q)) && (this.stateFilter === 'all' || (this.stateFilter === 'live' ? !terminal(x) : this.stateFilter === 'issues' ? x.state === 'waiting' || x.state === 'failed' : x.state === this.stateFilter)) && (!this.kindFilter || x.kind === this.kindFilter);
    // a child appears under its goal; matching children make the parent visible
    const top = all.filter(x => !x.parent || !this.w.works?.[x.parent]).filter(x => match(x) || all.some(k => k.parent === x.id && match(k))).sort((a, b) => Number(terminal(a)) - Number(terminal(b)) || b.priority - a.priority || b.updated - a.updated).slice(0, 120);
    const kinds = [...new Set(all.map(x => x.kind))];
    return `${this.goalForm()}<div class="lg-filters"><label class="lg-search">검색<input data-search value="${esc(this.search)}" placeholder="업무명·사유"></label>
      <label>상태<select data-filter="state">${[['live', '진행 중'], ['issues', '대기·실패'], ['paused', '일시정지'], ['done', '완료'], ['cancelled', '취소'], ['all', '전체']].map(([v, l]) => `<option value="${v}" ${v === this.stateFilter ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>종류<select data-filter="kind"><option value="">전체</option>${kinds.map(k => `<option value="${k}" ${k === this.kindFilter ? 'selected' : ''}>${KIND_NAME[k]}</option>`).join('')}</select></label></div>
      ${top.length ? top.map(x => this.workRow(x)).join('') : '<p class="lg-empty">조건에 맞는 업무가 없습니다. 시장에서 사고팔거나, 건설·생산·연구를 주문하면 자동으로 업무가 됩니다.</p>'}`;
  }

  private saleSearch(r: InventoryRow): string {
    const best = [...r.stations].sort((a, b) => b.available - a.available)[0];
    const q = this.saleQ[r.item] ??= { from: best?.station ?? '', amount: Math.max(1, Math.floor(best?.available ?? 1)), minPrice: this.w.companies[this.me]?.procurement?.sales?.[r.item]?.minPrice ?? 0, strategy: this.w.companies[this.me]?.procurement?.sales?.[r.item]?.strategy ?? 'local' };
    const from = this.w.stations[q.from] ?? (best ? this.w.stations[best.station] : undefined);
    return saleSearchHtml(this.w, this.me, r.item, from, q);
  }
  private stockTab() {
    const w = this.w, rows = companyInventory(w as never, this.me).filter(r => r.total > 0.5 || r.target > 0 || r.planned > 0 || r.consumption > 0.5);
    const usable = Object.values(w.stations).filter(s => s.owner === this.me || s.public), markets = Object.values(w.stations).filter(s => s.public && s.market);
    const sel = (name: string, list: typeof usable, pick?: string) => `<select data-keep name="${name}">${list.map(s => `<option value="${s.id}" ${s.id === pick ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
    const detail = (r: InventoryRow) => `<tr class="ops-detail"><td colspan="10"><div class="ops-inv-detail">
      <div><h4>보관 위치</h4>${r.stations.map(s => `<p><button class="an-link" data-a="station" data-id="${s.station}" data-tab="store">${esc(this.stationName(s.station))}</button> 보관 ${n0(s.stored)} · 예약 ${n0(s.reserved)} · 가용 ${n0(s.available)}${s.protected ? ` · 보호 ${n0(s.protected)}` : ''}</p>${s.available >= 1 ? `<div class="lg-card-actions">${transferButtons(w, this.me, r.item, s.station, s.available)}</div>` : ''}`).join('') || '<p class="dim">없음</p>'}</div>
      <div><h4>비축 목표</h4>${r.works.map(id => w.works?.[id]).filter(x => x?.goal?.k === 'stockpile').map(x => `<p>${esc(x!.title)} — ${STATE_NAME[x!.state]}${x!.reason ? ` · ${esc(x!.reason)}` : ''}</p>`).join('') || '<p class="dim">없음 — 아래에서 정할 수 있습니다</p>'}
        <h4>운송 중 <button class="an-link small" data-a="goto" data-id="logistics">운송 현황</button></h4>${r.ships.map(s => `<p>${esc(w.ships[s.ship]?.name ?? s.ship)} ${n0(s.amount)}${s.to ? ` → ${esc(this.stationName(s.to))}` : ''}</p>`).join('') || '<p class="dim">없음</p>'}
        <h4>관련 업무</h4>${r.works.map(id => w.works?.[id]).filter(x => x && x.goal?.k !== 'stockpile').map(x => `<p>${esc(x!.title)} — ${STATE_NAME[x!.state]}</p>`).join('') || '<p class="dim">없음</p>'}</div>
      <div><h4>처리</h4><div class="proc-policy-grid"><label>정거장${sel('inv-station', usable, r.stations[0]?.station)}</label><label>출발 (운송)${sel('inv-from', usable, r.stations.find(s => s.available > 0)?.station)}</label><label>시장${sel('inv-market', markets)}</label><label>수량<input type="number" name="inv-amount" min="1" value="100"></label><label>비축 목표<input type="number" name="inv-target" min="1" value="${Math.max(r.target, Math.ceil(r.total))}"></label></div>
        <div class="lg-card-actions"><button class="btn" data-a="inv-buy" data-id="${r.item}">구매</button><button class="btn" data-a="inv-sell" data-id="${r.item}">판매</button><button class="btn" data-a="inv-move" data-id="${r.item}">운송 요청</button><button class="btn go" data-a="inv-stock" data-id="${r.item}">비축 목표 설정</button></div></div>${this.saleSearch(r)}</div></td></tr>`;
    return `<p class="dim ops-note">각 수량은 한 곳에만 집계됩니다 — 보관(자유 재고) · 예약(운송·건설에 묶임) · 운송 중(함선 화물) · 거래소 등록. 회사 총량 = 보관 + 예약 + 운송 중 + 등록. 가용 = 보관 중 보호·출고 예정분을 뺀 양. 생산·소비 예정과 비축 목표는 총량에 더하지 않습니다.</p>
      <div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>품목</th><th>회사 총량</th><th>위치</th><th>가용</th><th>예약</th><th>운송 중</th><th>생산 예정</th><th>소비 예정</th><th>비축 목표</th><th>부족·잉여</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.shortage > 0 ? 'warn' : ''}" data-a="item" data-id="${r.item}"><td><button class="an-link">${esc(itemName(r.item))}</button></td><td>${n0(r.total)}</td><td>${r.stations.filter(s => s.stored + s.reserved > 0.5).length ? `${esc(this.stationName([...r.stations].sort((a, b) => b.stored - a.stored)[0].station))}${r.stations.filter(s => s.stored + s.reserved > 0.5).length > 1 ? ` 외 ${r.stations.filter(s => s.stored + s.reserved > 0.5).length - 1}곳` : ''}` : r.inTransit ? '운송 중' : '—'}</td><td>${n0(r.available)}</td><td>${n0(r.reserved)}</td><td>${n0(r.inTransit)}</td><td>${n0(r.planned)}</td><td>${n0(r.consumption)}</td><td>${r.target ? n0(r.target) : '—'}</td><td>${r.shortage > 0 ? `<b class="warn">−${n0(r.shortage)}</b>` : r.surplus > 0 ? `<span class="good">+${n0(r.surplus)}</span>` : '—'}</td></tr>${this.item === r.item ? detail(r) : ''}`).join('') || '<tr><td colspan="10" class="dim">보유 재고가 없습니다</td></tr>'}</tbody></table></div>`;
  }

  private industryTab() {
    const w = this.w, me = this.me, co = w.companies[me];
    const own = Object.values(w.stations).filter(s => s.owner === me);
    const market = Object.values(w.stations).filter(s => s.public && s.market);
    const best = (item: string, side: 'buy' | 'sell') => { const ps = market.filter(s => s.market![item]).map(s => priceOf(s.market![item], side, true)).filter(Number.isFinite); return ps.length ? (side === 'buy' ? Math.min(...ps) : Math.max(...ps)) : NaN; };
    const led = co.ops?.ledger ?? [], sales: Record<string, number> = {};
    for (const h of led) for (const [i, v] of Object.entries(h.sales ?? {})) sales[i] = (sales[i] ?? 0) + v;
    const upkeep = co.upkeep?.bill?.perHour ?? 0, hours = Math.max(1, led.length);
    const prodItems = new Set(Object.values(RECIPES).map(r => Object.keys(r.out)[0]));
    const industrySales = Object.entries(sales).filter(([i]) => prodItems.has(i)).reduce((a, [, v]) => a + v, 0);
    const purchases = led.reduce((n, h) => n + (h.exp.purchase ?? 0), 0);
    return `<div class="lg-summary"><div><span>보관된 시간 동안 가공품 판매</span><b class="good">${cr(industrySales)}</b></div><div><span>같은 기간 구매 지출</span><b>${cr(purchases)}</b></div><div><span>운영 유지비 (함대 포함) / 시간</span><b class="warn">${cr(upkeep)}</b></div><div><span>장부 기간</span><b>${hours}시간</b></div></div>
      ${(() => { const plans = this.works().filter(x => x.goal?.k === 'stockpile' && !terminal(x)); return plans.length ? `<section class="pool-section"><div class="pool-section-head"><div><h3>회사 생산 계획</h3><p>비축 목표가 회사 전체 생산 라인에 나눠 둔 주문 (중간재 포함)</p></div></div>${plans.map(g => { const kids = this.works().filter(k => k.parent === g.id && k.kind === 'production' && !terminal(k)); return `<div class="proc-plan"><b>${esc(g.title)}</b> <span>${STATE_NAME[g.state]}</span><p>${kids.map(k => `${esc(this.stationName(k.ref.station))}: ${esc(k.title.split(' · ').slice(1).join(' · '))} ${n0(k.progress.done)}/${n0(k.progress.total)}${k.state === 'waiting' ? ` <span class="warn">(${esc(k.reason)})</span>` : ''}`).join(' · ') || esc(g.reason)}</p></div>`; }).join('')}</section>` : ''; })()}
      <p class="dim ops-note">수익성은 실제 판매 대금과 실제 지출로만 계산합니다. 장부가치나 예상가는 이익으로 보지 않으며, 아래 단위 부가가치는 현재 최저 매입가·최고 매도가 기준 추정입니다.</p>
      ${own.map(st => { const orders = st.orders ?? [], jobs = st.jobs ?? [];
        const facs = [...new Set(st.modules.filter(m => m.built).map(m => m.kind))].filter(k => Object.values(RECIPES).some(r => r.fac === k));
        return `<section class="pool-section"><div class="pool-section-head"><div><h3>${esc(st.name)}</h3><p>${facs.map(k => `${MODULES[k]?.name ?? k} ${jobs.filter(j => j.fac === k).length}/${facLines(st, k)} 가동`).join(' · ') || '생산 시설 없음'}</p></div><button class="btn" data-a="station" data-id="${st.id}" data-tab="prod">생산 화면</button></div>
          ${orders.map(o => { const r = recipeFor(w, o.recipe); if (!r) return ''; const out = Object.keys(r.out)[0]; const value = r.out[out] * best(out, 'sell') - Object.entries(r.in).reduce((n, [i, q]) => n + q * best(i, 'buy'), 0);
            const wk = this.works().find(x => x.ref.order === o.id && x.ref.station === st.id && !terminal(x)), busy = jobs.some(j => j.order === o.id);
            const blocked = o.why && !busy && o.why !== '가동 중' && !/목표 재고 도달|완료/.test(o.why);
            const lack = blocked ? Object.keys(r.in).find(i => o.why!.includes(itemName(i))) : undefined;
            return `<div class="proc-plan"><b>${esc(r.name)}</b> <span>${o.mode === 'stock' ? `재고 ${n0(qty(st.storage[me], out))}/${n0(o.n)} 유지` : `${o.done}/${o.n}회`}${o.paused ? ' · 일시정지' : ''}${wk?.parent ? ` · ${esc(this.w.works?.[wk.parent]?.title ?? '')}의 계획` : ''}</span><p>${blocked ? `<span class="warn">병목: ${esc(o.why)}</span>` : busy ? '가동 중' : esc(o.why ?? '대기')} · 배치당 부가가치 추정 ${Number.isFinite(value) ? `${value >= 0 ? '+' : '−'}${n0(Math.abs(value))} cr` : '시장가 없음'} · 기록된 판매 ${n0(sales[out] ?? 0)} cr</p>
              ${blocked ? `<div class="lg-card-actions ops-fix"><span class="dim">해결</span>${lack ? `<button class="btn" data-a="quick-stock" data-id="${lack}" data-st="${st.id}" data-v="${r.in[lack] * 4}">${esc(itemName(lack))} 비축 목표</button><button class="btn" data-a="goto" data-id="stock" data-item="${lack}">재고 위치 보기</button>` : ''}${/라인 사용 중/.test(o.why!) ? `<button class="btn" data-a="quick-fac" data-id="${r.fac}" data-st="${st.id}">${esc(MODULES[r.fac]?.name ?? r.fac)} 추가</button>` : ''}${/창고|전력/.test(o.why!) ? `<button class="btn" data-a="station" data-id="${st.id}" data-tab="build">시설 화면</button>` : ''}${wk && o.paused ? `<button class="btn" data-a="resume" data-id="${wk.id}">재개</button>` : ''}${/조달|구매/.test(wk?.reason ?? '') ? '<button class="btn" data-a="goto" data-id="finance">결재함</button>' : ''}</div>` : ''}</div>`; }).join('') || '<p class="dim">생산 주문 없음</p>'}</section>`; }).join('') || '<p class="lg-empty">자사 정거장이 없습니다.</p>'}`;
  }

  private researchTab() {
    const co = this.w.companies[this.me], q = co.research ?? [];
    return `<div class="lg-summary"><div><span>보유 기술</span><b>${co.tech?.length ?? 0}</b></div><div><span>연구 대기열</span><b>${q.length}</b></div><div><span>진행 중</span><b>${q.filter(p => p.started && !p.paused).length}</b></div><div><span>대기 사유 있음</span><b class="warn">${q.filter(p => p.why).length}</b></div></div>
      ${q.some(p => p.why) ? `<div class="lg-card-actions ops-fix"><span class="dim">해결</span>${[...new Set(q.filter(p => p.why && p.station).map(p => p.station!))].map(id => `<button class="btn" data-a="station" data-id="${id}" data-tab="research">${esc(this.stationName(id))} 연구 화면</button>`).join('')}</div>` : ''}
      ${q.map(p => { const x = this.works().find(k => k.ref.research === p.id && !terminal(k)); return x ? this.workRow(x) : `<div class="ops-work"><div class="ops-work-top"><b>${esc(TECHS[p.tech]?.name ?? p.tech)}</b></div><div class="ops-progress"><i style="width:${pct(p.total - p.left, p.total)}%"></i></div><div class="ops-meta">${esc(p.why ?? '')}</div></div>`; }).join('') || '<p class="lg-empty">진행 중인 연구가 없습니다 — 정거장의 연구 화면에서 등록하면 이곳에 업무로 나타납니다.</p>'}`;
  }

  private logisticsTab() {
    const jobs = Object.values(this.w.logisticsJobs ?? {}).filter(j => j.owner === this.me), pool = Object.values(this.w.ships).filter(s => s.owner === this.me && s.logisticsPool);
    const live = jobs.filter(j => j.state !== 'complete' && j.state !== 'cancelled');
    const transport = this.works().filter(x => (x.kind === 'transport' || x.kind === 'route') && !terminal(x));
    return `<div class="lg-summary"><div><span>공용 배차 함선</span><b>${pool.length}</b></div><div><span>진행 운송</span><b>${live.length}</b></div><div><span>배차 대기</span><b class="warn">${live.filter(j => !j.ship).length}</b></div><div><span>운송 중 화물</span><b>${n0(live.reduce((n, j) => n + j.carried, 0))}</b></div></div>
      <p class="dim ops-note">운송은 공용 배차가 처리합니다. 함선 참여·노선은 <button class="an-link" data-a="logistics">물류 관리</button>.</p>
      ${!pool.length && (live.length || this.works().some(x => !terminal(x) && /수송선/.test(x.reason))) ? `<div class="lg-feedback warn">공용 배차에 참여한 수송선이 없어 운송·구매품 이동이 멈춰 있습니다. <button class="btn go" data-a="logistics">물류 관리에서 함선 참여</button></div>` : ''}
      ${transport.map(x => this.workRow(x)).join('') || '<p class="dim">운송 업무가 없습니다.</p>'}
      ${live.filter(j => j.procurement).length ? `<h3 class="ops-h3">자동 조달 운송</h3>${live.filter(j => j.procurement).slice(0, 30).map(j => `<div class="proc-plan"><b>${esc(itemName(j.item))} ${n0(j.amount)}</b> <span>${esc(this.stationName(j.from))} → ${esc(this.stationName(j.to))} · ${j.ship ? '수행 중' : '대기'}</span><p>${esc(j.reason ?? '')}</p></div>`).join('')}` : ''}`;
  }

  private buildTab() {
    const w = this.w, me = this.me, own = Object.values(w.stations).filter(s => s.owner === me);
    const items = this.works().filter(x => ['station', 'facility', 'facilities'].includes(x.kind) && !terminal(x));   // ships / fleets: the fleet area
    // anything not yet adopted (the server adopts engine work every few seconds) is still listed, never hidden
    const unregistered = own.flatMap(s => [...s.modules.filter(m => !m.built && !items.some(x => x.ref.module === m.id)).map(m => `<div class="proc-plan"><b>${esc(s.name)} · ${esc(MODULES[m.kind]?.name ?? m.kind)}</b> <span>${Math.round(m.progress * 100)}%${m.paused ? ' · 일시정지' : ''}</span></div>`)]);
    return `<div class="lg-summary"><div><span>정거장</span><b>${own.length}</b></div><div><span>시설 건설</span><b>${own.reduce((n, s) => n + s.modules.filter(m => !m.built).length, 0)}</b></div><div><span>설립 이동</span><b>${items.filter(x => x.kind === 'station').length}</b></div></div>
      ${items.sort((a, b) => b.priority - a.priority || a.created - b.created).map(x => this.workRow(x)).join('') || '<p class="dim">시설 건설 업무 없음 — 함선 건조는 함대 영역에서 봅니다.</p>'}
      ${unregistered.length ? `<p class="dim small">업무 편입 대기 (몇 초 안에 편입)</p>${unregistered.join('')}` : ''}`;
  }

  private financeTab() {
    const w = this.w, co = w.companies[this.me], led = co.ops?.ledger ?? [], pol = { ...defaultOpsPolicy(), ...co.ops?.policy };
    const cats = [...new Set(led.flatMap(h => [...Object.keys(h.inc), ...Object.keys(h.exp)]))];
    const tot = (side: 'inc' | 'exp', c: string) => led.reduce((n, h) => n + (h[side][c] ?? 0), 0);
    const aps = this.approvals(), open = aps.filter(a => a.state === 'open'), hist = aps.filter(a => a.state !== 'open').sort((a, b) => (b.decided ?? b.updated) - (a.decided ?? a.updated)).slice(0, 20);
    const goals = this.works().filter(x => GOAL_KINDS.includes(x.kind) && !terminal(x));
    const sales = tot('inc', 'sales'), upkeep = tot('exp', 'upkeep');
    return `<div class="ops-cols"><section class="pool-section"><div class="pool-section-head"><div><h3>결재함 <small>${open.length}</small></h3><p>관련 결재는 업무별로 하나로 묶입니다. 답하지 않아도 회사는 다른 업무를 계속합니다.</p></div></div>
      ${open.map(a => this.approvalCard(a)).join('') || '<p class="dim">대기 중인 결재가 없습니다.</p>'}
      <h3 class="ops-h3">결재 이력</h3>${hist.map(a => `<div class="proc-plan"><b>${esc(a.title)}</b> <span>${a.state === 'resolved' ? '자동 해소' : a.state === 'rejected' ? '거절' : '승인'} · ${ago(w.time, a.decided ?? a.updated)}</span><p>${esc(a.choice ? a.options.find(o => o.id === a.choice)?.label ?? a.choice : a.note ?? '')}${a.scope && a.scope !== 'once' ? ` (${a.scope === 'work' ? '이 목표 전체' : '정책 위임'})` : ''}</p></div>`).join('') || '<p class="dim">없음</p>'}</section>
      <section class="pool-section"><div class="pool-section-head"><div><h3>현금 흐름 <small>최근 ${led.length}시간 실적</small></h3><p>실제 입출금만 기록합니다 (장부가치 제외).</p></div></div>
      <table class="ops-table"><thead><tr><th>항목</th><th>수입</th><th>지출</th></tr></thead><tbody>${cats.map(c => `<tr><td>${esc(LEDGER_NAME[c] ?? c)}</td><td class="good">${tot('inc', c) ? n0(tot('inc', c)) : ''}</td><td class="warn">${tot('exp', c) ? n0(tot('exp', c)) : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="dim">아직 기록 없음</td></tr>'}</tbody></table>
      <div class="proc-policy-status"><span>판매 수입<b>${n0(sales)} cr</b></span><span>운영 유지비<b>${n0(upkeep)} cr</b></span><span>판매 − 유지비<b class="${sales - upkeep >= 0 ? 'good' : 'warn'}">${n0(sales - upkeep)} cr</b></span></div>
      ${this.pnlHtml()}
      ${this.valuationNote()}
      <h3 class="ops-h3">목표별 예산</h3>${goals.map(x => `<div class="proc-plan"><b>${esc(x.title)}</b> <span>지출 ${n0(x.cost)} cr · ${x.budget ? x.budget.open ? '목표 전체 승인' : `예산 ${n0(x.budget.spent)}/${n0(x.budget.limit)} cr` : '예산 없음 (필요 시 결재)'}</span></div>`).join('') || '<p class="dim">없음</p>'}
      <h3 class="ops-h3">위임 정책</h3><div class="proc-policy-form"><div class="proc-policy-grid">
        <label>자율 수준<select data-keep name="p-autonomy"><option value="ask" ${pol.autonomy === 'ask' ? 'selected' : ''}>권한 밖 지출은 결재</option><option value="auto" ${pol.autonomy === 'auto' ? 'selected' : ''}>아래 한도 안에서 자동</option></select></label>
        <label>최소 보유 크레딧<input type="number" name="p-min" min="0" value="${pol.minCredits}"></label><label>시간당 자동 지출 한도 (0=없음)<input type="number" name="p-hour" min="0" value="${pol.hourlyLimit}"></label>
        <label>소액 자동 승인 (요구 총액 기준)<input type="number" name="p-small" min="0" value="${pol.autoApproveBelow}"></label><label>운송 위험 허용치 (0–100)<input type="number" name="p-risk" min="0" max="100" value="${pol.maxRisk}"></label>
        <label>위임 구매 예산<input type="number" name="p-deleg" min="0" value="${pol.delegatedBudget}"> <small class="dim">사용 ${n0(pol.delegatedSpent)} cr</small></label></div>
        <label class="ops-check"><input type="checkbox" name="p-produce" ${pol.preferProduce ? 'checked' : ''}> 구매보다 자체 생산 우선</label>
        <p class="dim">위임 품목: ${Object.entries(pol.autoBuy).map(([i, p]) => `${esc(itemName(i))} ≤ ${n0(p)} cr`).join(', ') || '없음'} — 결재에서 "정책 위임"을 고르면 추가됩니다.</p>
        <button class="btn go" data-a="policy">정책 저장</button></div></section></div>`;
  }
  /** P17.4f F1: the same real money by the business each ship served (industryPnl.ts) */
  private pnlHtml() {
    const rows = pnlRows(this.w.companies[this.me], this.w.time, 24);
    const sum = (k: 'inc' | 'exp' | 'net') => rows.reduce((a, r) => a + r[k], 0);
    return `<h3 class="ops-h3">사업별 손익 <small>최근 24시간 실적</small></h3><p class="dim small">함선이 그 순간 수행한 업무 기준입니다. 운영비 = 유지비·정박료(+간접비)와 소모품(기준가), 수리비는 수리받은 함선의 업무에 붙습니다. 함선이 직접 하역·판매한 수입은 그 함선의 업무로, 보관함에서 판 재고는 "보관 재고 판매"로 잡힙니다.</p>
      <div class="ops-table-wrap"><table class="ops-table ops-pnl"><thead><tr><th>사업</th><th>평균 함선</th><th>수입</th><th>운영·수리비</th><th>손익</th></tr></thead><tbody>${rows.map(r => `<tr data-act="${r.act}"><td>${esc(r.name)}</td><td>${r.ships ? r.ships.toFixed(1) : ''}</td><td class="good">${r.inc ? n0(r.inc) : ''}</td><td class="warn">${r.exp ? n0(r.exp) : ''}</td><td class="${r.net >= 0 ? 'good' : 'warn'}">${r.net >= 0 ? '+' : '−'}${n0(Math.abs(r.net))}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">아직 기록 없음</td></tr>'}</tbody>
      ${rows.length ? `<tfoot><tr><td>합계</td><td></td><td>${n0(sum('inc'))}</td><td>${n0(sum('exp'))}</td><td class="${sum('net') >= 0 ? 'good' : 'warn'}">${sum('net') >= 0 ? '+' : '−'}${n0(Math.abs(sum('net')))}</td></tr></tfoot>` : ''}</table></div>
      <p class="dim small">사업 손익에 들어가지 않는 지출(건설·조선·연구·구매·임대·장교 급여)과 계약·현상금 수입은 위 현금 흐름 표에만 있습니다.</p>`;
  }
  /** value-chain migration: what the company's goods were worth before vs now (reference, NOT cash) */
  private valuationNote() {
    const e = this.w.econ; if (!e?.before) return '';
    const mean = (k: string) => { const b = Object.values(this.w.stations).filter(s => s.public && s.market?.[k]).map(s => s.market![k].base); return b.length ? b.reduce((a, x) => a + x, 0) / b.length : NaN; };
    const rows = companyInventory(this.w as never, this.me).filter(r => r.total >= 1 && e.before![r.item] > 0 && Number.isFinite(mean(r.item)))
      .map(r => ({ item: r.item, n: r.total, was: r.total * e.before![r.item], now: r.total * mean(r.item) })).sort((a, b) => Math.abs(b.now - b.was) - Math.abs(a.now - a.was));
    const was = rows.reduce((a, r) => a + r.was, 0), now = rows.reduce((a, r) => a + r.now, 0);
    return `<h3 class="ops-h3">재고 평가 변화 <small>가격 체계 변경 참고</small></h3><p class="dim">이 월드는 가치 사슬 가격으로 바뀌었습니다. 아래는 보유 재고를 공개 시장 평균 기준가로 평가한 <b>장부상 변화</b>이며 현금 흐름(위 표)과 별개입니다. 품목·크레딧은 바뀌지 않았습니다.</p>
      <table class="ops-table"><thead><tr><th>품목</th><th>보유</th><th>변경 전 평가</th><th>현재 평가</th><th>차이</th></tr></thead><tbody>${rows.slice(0, 12).map(r => `<tr><td>${esc(itemName(r.item))}</td><td>${n0(r.n)}</td><td>${n0(r.was)}</td><td>${n0(r.now)}</td><td class="${r.now >= r.was ? 'good' : 'warn'}">${r.now >= r.was ? '+' : '−'}${n0(Math.abs(r.now - r.was))}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">평가할 재고 없음</td></tr>'}</tbody></table>
      <div class="proc-policy-status"><span>변경 전 평가<b>${n0(was)} cr</b></span><span>현재 평가<b>${n0(now)} cr</b></span><span>평가 변화 (현금 아님)<b class="${now >= was ? 'good' : 'warn'}">${now >= was ? '+' : '−'}${n0(Math.abs(now - was))} cr</b></span></div>`;
  }
  private approvalCard(a: Approval) {
    const work = this.w.works?.[a.work], scope = this.scope[a.id] ?? 'once';
    const scopes = [...new Set(a.options.flatMap(o => o.scopes))];
    return `<article class="ops-approval"><header><b>${esc(a.title)}</b><span class="lg-badge waiting">${{ purchase: '구매', budget: '예산 초과', credits: '최소 잔액', risk: '위험 경로', loss: '손실' }[a.kind]}</span></header>
      <p><b>사유</b> ${esc(a.reason)}</p><p><b>상황</b> ${esc(a.situation)}</p>${work ? `<p><b>관련 업무</b> ${esc(work.title)} — ${esc(work.reason)}</p>` : ''}
      ${a.items.length ? `<table class="ops-table"><thead><tr><th>품목</th><th>수량</th><th>단가</th><th>시장</th></tr></thead><tbody>${a.items.map(x => `<tr><td>${esc(itemName(x.item.replace(/^(hull|fac):/, '')))}</td><td>${n0(x.amount)}</td><td>${n0(x.price)}</td><td>${esc(this.stationName(x.station))}</td></tr>`).join('')}</tbody></table>` : ''}
      <p><b>추정 비용</b> ${n0(a.estimate.cost)} cr <span class="dim">(${esc(a.estimate.note)})</span></p>${a.risk ? `<p><b>위험</b> ${esc(a.risk.note)}</p>` : ''}
      <p><b>거절 시</b> ${esc(a.rejectEffect)}</p>
      <div class="ops-options">${a.options.map(o => `<div class="ops-option ${o.recommended ? 'rec' : ''}"><div><b>${esc(o.label)}${o.recommended ? ' <small>권장</small>' : ''}</b><p>${esc(o.detail)}</p></div><button class="btn ${o.id === 'reject' ? 'warnb' : o.recommended ? 'go' : ''}" data-a="decide" data-id="${a.id}" data-opt="${o.id}">${o.id === 'reject' ? '거절' : '선택'}</button></div>`).join('')}</div>
      <div class="proc-policy-grid">${scopes.length > 1 ? `<label>적용 범위<select data-scope="${a.id}">${scopes.map(s => `<option value="${s}" ${s === scope ? 'selected' : ''}>${{ once: '이번만', work: '이 목표 전체 (같은 조건)', policy: '정책으로 위임' }[s]}</option>`).join('')}</select></label>` : ''}${a.options.some(o => o.input) ? `<label>승인 금액 수정 (선택, cr)<input type="number" min="0" name="mod-${a.id}" placeholder="${n0(a.estimate.cost)}"></label>` : ''}</div>
      <p class="dim">${esc(a.scopeNote)}</p></article>`;
  }
}
