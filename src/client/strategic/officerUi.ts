// B-1 officer management (장교 관리): roster, profile, one skill tree at a time, comparison and service record.
// Every action sends the same server commands as anywhere else (officerLearn / officerFocus / officerPost /
// assignCmd); the client only reads state and explains why something cannot be done (learnBlock is shared code).
import type { GameClient } from '../net';
import type { Cmd } from '../../world/sim';
import type { WCommander, WGroup } from '../../world/types';
import {
  TREES, TREE_NAME, SKILLS, SKILL, TIER_GATE, MAX_CAPSTONES, FX, FX_KEYS, fxText, nodeLines, TRAIT, NAMED_BY_ID, MASTERY, MASTERY_NAME,
  masteryLevel, xpToNext, MAX_LEVEL, RANK_BAND, DOMAIN_NAME, FOCUS_BONUS, type Tree, type SkillNode, type FxKey, type Domain,
} from '../../world/officerData';
import { isOfficer, officerFx, learnBlock, payroll, levelProgress, FEAT_NAME, type Officer } from '../../world/officers';
import { morph, trackSelects } from '../../ui/morph';

type Tab = 'profile' | 'tree' | 'compare' | 'log';
type Filter = 'all' | 'command' | 'director' | 'idle' | 'named' | 'injured';
type Sort = 'level' | 'name' | 'pay' | 'mastery' | 'sp';
interface Actions { close(): void; fleet?(group: string): void }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n0 = (v: number) => Math.round(v).toLocaleString();
const SRC_NAME: Record<string, string> = {
  combat: '교전', mine: '채굴', salvage: '인양', logistics: '수송', industry: '생산', research: '연구', build: '조선', construct: '건설',
  survey: '탐사', discover: '발견', site: '현장 작업', support: '정비',
};
/** which posting makes an effect domain count */
const DOMAIN_POST: Record<Domain, 'group' | 'station'> = {
  battle: 'group', fleet: 'group', mine: 'group', salvage: 'group', logistics: 'group', station: 'station', construct: 'group', explore: 'group', support: 'group',
};

export class OfficerPanel {
  private el = document.createElement('div');
  private closed = false; private busy = false; private error = ''; private notice = '';
  private tab: Tab = 'profile'; private sel = ''; private tree: Tree = 'gunnery'; private node = '';
  private filter: Filter = 'all'; private sort: Sort = 'level'; private search = ''; private cmp = new Set<string>();
  /** mobile: the detail pane replaces the list once an officer is opened */
  private detail = false;
  private onSnap = () => this.render();
  private key = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopImmediatePropagation(); this.close(); } };

  constructor(root: HTMLElement, private c: GameClient, private actions: Actions, select?: string) {
    if (select) { this.sel = select; this.detail = true; }
    this.el.className = 'modal lg-modal of-modal'; this.el.tabIndex = -1;
    this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-label', '장교 관리'); this.el.setAttribute('aria-modal', 'true');
    this.el.onkeydown = e => {
      e.stopPropagation();
      // SVG tree nodes are focusable groups: Enter/Space opens them like a click
      const t = e.target as Element;
      if ((e.key === 'Enter' || e.key === ' ') && t instanceof SVGElement && t.closest('[data-a]')) { e.preventDefault(); (t.closest('[data-a]') as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); }
    };
    this.el.onclick = e => this.click(e);
    this.el.oninput = e => { const t = e.target as HTMLInputElement; if (t.dataset.search !== undefined) { this.search = t.value; this.render(); } };
    this.el.onchange = e => this.change(e.target as HTMLSelectElement);
    root.appendChild(this.el); trackSelects(this.el); c.onSnap.push(this.onSnap); window.addEventListener('keydown', this.key, true);
    this.pickDefault(); this.render(); this.el.focus();
  }
  close() { if (this.closed) return; this.closed = true; const i = this.c.onSnap.indexOf(this.onSnap); if (i >= 0) this.c.onSnap.splice(i, 1); window.removeEventListener('keydown', this.key, true); this.el.remove(); this.actions.close(); document.getElementById('officerBtn')?.focus(); }

  private get me() { return this.c.company; }
  private get w() { return this.c.state!; }
  private mine(): Officer[] { return Object.values(this.w.commanders).filter((x): x is Officer => x.owner === this.me && isOfficer(x)); }
  private groupOf(id: string): WGroup | undefined { return Object.values(this.w.groups).find(g => g.commanderId === id && g.owner === this.me); }
  private pickDefault() {
    const list = this.mine();
    if (!this.sel || !list.some(o => o.id === this.sel)) this.sel = list[0]?.id ?? '';
    const o = list.find(x => x.id === this.sel);
    if (o) this.tree = o.of.focus ?? this.bestTree(o);
  }
  private bestTree(o: Officer): Tree { let b: Tree = 'gunnery', v = -1; for (const t of TREES) { const m = o.of.mastery[t.id] ?? 0; if (m > v) { v = m; b = t.id; } } return b; }

  private async send(command: Cmd, success: string) {
    if (this.busy) return; this.busy = true; this.error = ''; this.notice = ''; this.render();
    try { const error = await this.c.cmd(command); if (this.closed) return; if (error) this.error = error; else this.notice = success; }
    catch { if (!this.closed) this.error = '연결을 확인하고 다시 시도하세요'; }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }

  private change(t: HTMLSelectElement) {
    if (t.dataset.filter !== undefined) { this.filter = t.value as Filter; return this.render(); }
    if (t.dataset.sort !== undefined) { this.sort = t.value as Sort; return this.render(); }
    if (t.dataset.focus !== undefined) return void this.send({ c: 'officerFocus', commander: t.dataset.focus, tree: t.value || null }, t.value ? `훈련 방향을 ${TREE_NAME[t.value as Tree]}(으)로 정했습니다` : '훈련 방향을 해제했습니다');
    if (t.dataset.post !== undefined) {
      const id = t.dataset.post, v = t.value, o = this.w.commanders[id]; if (!o) return;
      if (v === 'idle') {
        const g = this.groupOf(id);
        if (g) return void this.send({ c: 'assignCmd', group: g.id, commander: null }, '지휘에서 물러나 대기합니다');
        return void this.send({ c: 'officerPost', commander: id, post: null }, '책임자에서 물러나 대기합니다');
      }
      if (v.startsWith('g:')) return void this.send({ c: 'assignCmd', group: v.slice(2), commander: id }, '편대 지휘관으로 배치했습니다');
      if (v.startsWith('s:')) return void this.send({ c: 'officerPost', commander: id, post: v.slice(2) }, '정거장 책임자로 부임했습니다');
    }
  }

  private click(e: MouseEvent) {
    if (e.target === this.el) return this.close();
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]'); if (!b) return;
    const a = b.dataset.a!, id = b.dataset.id ?? '';
    if (this.busy && a === 'learn') return;
    switch (a) {
      case 'close': return this.close();
      case 'pick': { this.sel = id; this.detail = true; this.node = ''; this.error = ''; this.notice = ''; const o = this.w.commanders[id]; if (isOfficer(o)) this.tree = o.of.focus ?? this.bestTree(o); return this.render(); }
      case 'back': this.detail = false; return this.render();
      case 'tab': this.tab = id as Tab; this.error = ''; this.notice = ''; return this.render();
      case 'tree': this.tree = id as Tree; this.node = ''; return this.render();
      case 'node': this.node = this.node === id ? '' : id; return this.render();
      case 'cmp': if (this.cmp.has(id)) this.cmp.delete(id); else if (this.cmp.size < 4) this.cmp.add(id); else { this.error = '비교는 4명까지'; } return this.render();
      case 'cmpgo': this.tab = 'compare'; this.detail = true; return this.render();
      case 'learn': {
        const n = SKILL[id]; if (!n || !this.sel) return;
        return void this.send({ c: 'officerLearn', commander: this.sel, node: id }, `"${n.name}" 습득`);
      }
      case 'fleet': return this.actions.fleet?.(id);
    }
  }

  // ------------------------------------------------------------------------------------- frame

  private render() {
    if (this.closed) return;
    if (!this.c.state) { this.el.innerHTML = '<div class="panel lg-box"><p>회사 상태를 기다리는 중…</p></div>'; return; }
    const w = this.w;
    if (w.officerV !== 1) {
      morph(this.el, `<div class="panel lg-box of-box"><header class="lg-head"><div><div class="an-eyebrow">SIDERARIUM / OFFICERS</div><h2>장교 관리</h2></div><div class="lg-actions"><button class="btn" data-a="close" aria-label="닫기">✕</button></div></header>
        <div class="of-empty">이 월드에서는 장교 육성(B-1)이 꺼져 있습니다. 지휘관은 기존 규칙(판단력·레벨)으로 활동합니다.</div></div>`);
      return;
    }
    const all = this.mine();
    if (this.sel && !all.some(o => o.id === this.sel)) this.pickDefault();
    for (const id of [...this.cmp]) if (!all.some(o => o.id === id)) this.cmp.delete(id);
    const pay = payroll(w as never, this.me);
    const sel = all.find(o => o.id === this.sel);
    const body = !all.length ? `<div class="of-empty">아직 장교가 없습니다. 자유항 정거장의 <b>인재</b> 탭에서 장교를 영입하세요. 신입 장교는 연봉이 낮고 경험치를 더 빨리 쌓습니다.</div>`
      : `<div class="of-layout${this.detail ? ' detail' : ''}">${this.listHtml(all, pay.lines)}<section class="of-main">${this.mainHtml(sel, all)}</section></div>`;
    morph(this.el, `<div class="panel lg-box of-box"><header class="lg-head"><div><div class="an-eyebrow">SIDERARIUM / OFFICERS</div><h2>장교 관리 <span>${all.length}명 · 급여 ${n0(pay.perHour)} cr/시간</span></h2></div><div class="lg-actions"><button class="btn" data-a="close" aria-label="장교 관리 닫기">✕</button></div></header>
      ${this.error ? `<div class="lg-feedback warn" role="alert">${esc(this.error)}</div>` : this.notice ? `<div class="lg-feedback good" role="status">${esc(this.notice)}</div>` : ''}
      ${body}
      <footer class="lg-foot"><span>경험치는 실제 성과(격침·피해·요격·채굴량·회수 가치·운송·생산·연구·탐사)로만 쌓입니다 · 효과는 장교가 맡은 편대 또는 정거장에만 적용</span></footer></div>`);
  }

  // ------------------------------------------------------------------------------------- roster

  private postText(o: Officer): { k: 'command' | 'director' | 'idle'; text: string } {
    const g = this.groupOf(o.id);
    if (g) return { k: 'command', text: `${g.name} 지휘 · ${g.shipIds.length}척` };
    if (o.of.post && this.w.stations[o.of.post.id]) return { k: 'director', text: `${this.w.stations[o.of.post.id].name} 책임자` };
    return { k: 'idle', text: '대기' };
  }
  private listHtml(all: Officer[], lines: { id: string; perHour: number }[]): string {
    const payOf = new Map(lines.map(l => [l.id, l.perHour]));
    const q = this.search.trim().toLowerCase();
    let list = all.filter(o => {
      const p = this.postText(o).k;
      if (this.filter === 'command' && p !== 'command') return false;
      if (this.filter === 'director' && p !== 'director') return false;
      if (this.filter === 'idle' && p !== 'idle') return false;
      if (this.filter === 'named' && !o.of.named) return false;
      if (this.filter === 'injured' && !(o.injuredUntil > this.w.time)) return false;
      if (q && !(`${o.name} ${o.rank} ${TRAIT[o.of.trait]?.name ?? ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const mt = (o: Officer) => o.of.mastery[this.tree] ?? 0;
    list = list.sort((a, b) => this.sort === 'name' ? a.name.localeCompare(b.name) : this.sort === 'pay' ? (payOf.get(b.id) ?? 0) - (payOf.get(a.id) ?? 0)
      : this.sort === 'mastery' ? mt(b) - mt(a) : this.sort === 'sp' ? b.of.sp - a.of.sp : b.level - a.level || b.xp - a.xp);
    const bands = ['전설', '베테랑', '숙련', '신입'];
    const rows = (this.sort === 'level' ? bands.map(band => ({ band, items: list.filter(o => RANK_BAND(o.level) === band) })) : [{ band: '', items: list }])
      .filter(x => x.items.length).map(x => `${x.band ? `<div class="of-band">${x.band} <small>${x.items.length}</small></div>` : ''}${x.items.map(o => this.rowHtml(o, payOf.get(o.id) ?? 0)).join('')}`).join('');
    return `<aside class="of-list"><div class="of-filters">
        <input class="of-search" type="search" placeholder="이름·특성 검색" value="${esc(this.search)}" data-search aria-label="장교 검색">
        <select data-filter aria-label="보직 필터">${([['all', '전체'], ['command', '편대 지휘'], ['director', '정거장 책임자'], ['idle', '대기'], ['named', '고유 장교'], ['injured', '부상']] as [Filter, string][]).map(([v, l]) => `<option value="${v}"${this.filter === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select data-sort aria-label="정렬">${([['level', '레벨'], ['mastery', `숙련도(${TREE_NAME[this.tree]})`], ['sp', '미사용 포인트'], ['pay', '급여'], ['name', '이름']] as [Sort, string][]).map(([v, l]) => `<option value="${v}"${this.sort === v ? ' selected' : ''}>${l}순</option>`).join('')}</select>
      </div>
      ${this.cmp.size ? `<button class="btn go of-cmpbtn" data-a="cmpgo">선택한 ${this.cmp.size}명 비교</button>` : ''}
      <div class="of-rows">${rows || '<div class="dim of-pad">조건에 맞는 장교가 없습니다.</div>'}</div></aside>`;
  }
  private rowHtml(o: Officer, pay: number): string {
    const p = this.postText(o), on = o.id === this.sel, inj = o.injuredUntil > this.w.time;
    return `<div class="of-row${on ? ' on' : ''}">
      <button class="of-rowmain" data-a="pick" data-id="${o.id}" aria-pressed="${on}">
        <span class="portrait" style="background:${o.color}">${esc(o.name.replace(/\s/g, '').slice(0, 2))}</span>
        <span class="of-rowtxt"><b>${esc(o.rank)} ${esc(o.name)}${o.of.named ? ' <i class="of-named" title="고유 장교">★</i>' : ''}</b>
          <small>Lv.${o.level} · ${esc(TRAIT[o.of.trait]?.name ?? '')} · <span class="of-post ${p.k}">${esc(p.text)}</span>${inj ? ' · <span class="warn">부상</span>' : ''}</small>
          <span class="of-xpbar" title="다음 레벨까지 ${Math.round(levelProgress(o) * 100)}%"><i style="width:${levelProgress(o) * 100}%"></i></span></span>
        <span class="of-rowside">${o.of.sp ? `<span class="of-sp" title="미사용 스킬 포인트">${o.of.sp}P</span>` : ''}<small>${n0(pay)} cr/h</small></span>
      </button>
      <button class="of-cmpck${this.cmp.has(o.id) ? ' on' : ''}" data-a="cmp" data-id="${o.id}" aria-pressed="${this.cmp.has(o.id)}" title="비교에 ${this.cmp.has(o.id) ? '포함됨 — 누르면 제외' : '추가'}" aria-label="${esc(o.name)} 비교">${this.cmp.has(o.id) ? '✓' : '+'}</button></div>`;
  }

  // ------------------------------------------------------------------------------------- detail

  private mainHtml(o: Officer | undefined, all: Officer[]): string {
    const tabs: [Tab, string][] = [['profile', '프로필'], ['tree', '스킬 트리'], ['compare', `비교${this.cmp.size ? ` ${this.cmp.size}` : ''}`], ['log', '기록']];
    const head = o ? `<div class="of-head"><button class="btn of-back" data-a="back" aria-label="목록으로">← 목록</button>
        <span class="portrait lg" style="background:${o.color}">${esc(o.name.replace(/\s/g, '').slice(0, 2))}</span>
        <div><h3>${esc(o.rank)} ${esc(o.name)}${o.of.named ? ' <span class="of-tag named">고유 장교</span>' : ''} <span class="of-tag">${RANK_BAND(o.level)}</span></h3>
        <div class="dim">${esc(TRAIT[o.of.trait]?.name ?? '')} — ${esc(TRAIT[o.of.trait]?.desc ?? '')}</div></div></div>` : '<div class="of-head"><button class="btn of-back" data-a="back">← 목록</button></div>';
    const nav = `<nav class="pool-tabs of-tabs" aria-label="장교 화면">${tabs.map(([id, l]) => `<button class="${this.tab === id ? 'on' : ''}" data-a="tab" data-id="${id}" aria-pressed="${this.tab === id}">${l}</button>`).join('')}</nav>`;
    const body = this.tab === 'compare' ? this.compareHtml(all) : !o ? '<div class="dim of-pad">장교를 선택하세요.</div>'
      : this.tab === 'tree' ? this.treeHtml(o) : this.tab === 'log' ? this.logHtml(o) : this.profileHtml(o);
    return `${head}${nav}<div class="of-body">${body}</div>`;
  }

  private postSelect(o: Officer): string {
    const w = this.w, g = this.groupOf(o.id);
    const groups = Object.values(w.groups).filter(x => x.owner === this.me);
    const stations = Object.values(w.stations).filter(s => s.owner === this.me && !s.public);
    const cur = g ? `g:${g.id}` : o.of.post ? `s:${o.of.post.id}` : 'idle';
    const holder = (s: string) => Object.values(w.commanders).find(x => x.id !== o.id && x.owner === this.me && x.of?.post?.id === s);
    return `<select data-post="${o.id}" aria-label="보직"${this.busy ? ' disabled' : ''}>
      <option value="idle"${cur === 'idle' ? ' selected' : ''}>대기 (급여 최소)</option>
      ${groups.length ? `<optgroup label="편대 지휘">${groups.map(x => { const h = x.commanderId && x.commanderId !== o.id ? w.commanders[x.commanderId] : null; return `<option value="g:${x.id}"${cur === `g:${x.id}` ? ' selected' : ''}>${esc(x.name)} · ${x.shipIds.length}척${h ? ` (현재 ${esc(h.name)} — 교체)` : ''}</option>`; }).join('')}</optgroup>` : ''}
      ${stations.length ? `<optgroup label="정거장 책임자">${stations.map(s => { const h = holder(s.id); return `<option value="s:${s.id}"${cur === `s:${s.id}` ? ' selected' : ''}${h ? ' disabled' : ''}>${esc(s.name)}${h ? ` (${esc(h.name)} 재임 중)` : ''}</option>`; }).join('')}</optgroup>` : ''}
    </select>`;
  }

  private fxRows(o: Officer): string {
    const fx = officerFx(o), p = this.postText(o).k;
    const keys = FX_KEYS.filter(k => fx[k]);
    if (!keys.length) return '<div class="dim">아직 효과가 없습니다. 스킬 트리에서 포인트를 사용하세요.</div>';
    const byDom = new Map<Domain, FxKey[]>();
    for (const k of keys) { const d = (FX[k] as { domain: Domain }).domain; byDom.set(d, [...(byDom.get(d) ?? []), k]); }
    return [...byDom].map(([d, ks]) => {
      const live = (DOMAIN_POST[d] === 'group' && p === 'command') || (DOMAIN_POST[d] === 'station' && p === 'director');
      return `<div class="of-fxdom${live ? '' : ' off'}"><div class="of-fxhead">${esc(DOMAIN_NAME[d])} <span class="${live ? 'good' : 'dim'}">${live ? '적용 중' : DOMAIN_POST[d] === 'station' ? '정거장 책임자일 때 적용' : '편대 지휘 중일 때 적용'}</span></div>
        <ul>${ks.map(k => { const v = fx[k]!, cap = (FX[k] as { cap: number }).cap; return `<li>${esc(fxText(k, v))}${v >= cap - 1e-9 && (FX[k] as { unit: string }).unit !== 'flag' ? ' <small class="warn">상한</small>' : ''}</li>`; }).join('')}</ul></div>`;
    }).join('');
  }

  private profileHtml(o: Officer): string {
    const w = this.w, of = o.of, need = xpToNext(o.level);
    const pay = payroll(w as never, this.me).lines.find(l => l.id === o.id);
    const named = of.named ? NAMED_BY_ID[of.named] : null;
    const growth = TRAIT[of.trait]?.grow ?? {};
    const masteryCol = (kind: 'combat' | 'industry') => TREES.filter(t => t.kind === kind).map(t => {
      const v = of.mastery[t.id] ?? 0, m = masteryLevel(v), next = MASTERY[m + 1];
      const g = growth[t.id] ?? 0;
      return `<button class="of-mrow${this.tree === t.id ? ' on' : ''}" data-a="tree" data-id="${t.id}" title="${esc(t.desc)}"><span>${t.icon} ${t.name}${of.focus === t.id ? ' <small class="good">훈련 중</small>' : ''}${g ? ` <small class="${g > 0 ? 'good' : 'warn'}">${g > 0 ? '+' : ''}${Math.round(g * 100)}%</small>` : ''}</span>
        <span class="of-mbar"><i style="width:${next ? Math.min(100, (v - MASTERY[m]) / (next - MASTERY[m]) * 100) : 100}%"></i></span><small>${MASTERY_NAME[m]} ${n0(v)}${next ? `/${n0(next)}` : ''}</small></button>`;
    }).join('');
    const injured = o.injuredUntil > w.time;
    const g = this.groupOf(o.id);
    // rookie → veteran progress: where this officer stands on the long road
    const milestones = [3, 8, 15, 25, 40];
    const road = milestones.map(L => `<span class="${o.level >= L ? 'done' : ''}" title="Lv.${L}: ${L === 40 ? '최고 레벨' : `${TIER_GATE[milestones.indexOf(L) + 2]?.name ?? ''} 해금 레벨`}">${L}</span>`).join('');
    return `<div class="of-grid">
      <section class="of-card"><h4>성장</h4>
        <div class="of-lv"><b>Lv.${o.level}</b>${o.level < MAX_LEVEL ? `<span class="of-xpbar big"><i style="width:${levelProgress(o) * 100}%"></i></span><small>${n0(o.xp)} / ${n0(need)} XP</small>` : '<small>최고 레벨</small>'}</div>
        <div class="of-road" aria-label="성장 단계">${road}</div>
        <dl class="of-dl"><dt>스킬 포인트</dt><dd><b>${of.sp}</b> 사용 가능 · 총 ${of.spGiven}</dd>
          <dt>판단력</dt><dd>${Math.round(o.skill * 100)}${o.level > of.lvBase ? ` (+레벨 보정 ${Math.round(0.004 * (o.level - of.lvBase) * 100)})` : ''}</dd>
          <dt>성장 재능</dt><dd>경험치 +${Math.round(of.talent * 100)}%${of.talent >= 0.15 ? ' <small class="good">빠른 성장</small>' : ''}</dd>
          <dt>교전</dt><dd>${o.battles}회</dd>
          ${named ? `<dt>고유 능력</dt><dd>${esc(SKILL[named.sig]?.name ?? '')} — ${TREE_NAME[SKILL[named.sig]?.tree as Tree]} 트리</dd>` : ''}
          ${of.migrated ? `<dt>이전</dt><dd>기존 Lv.${of.migrated.level} 지휘관에서 전환 (교전 ${of.migrated.battles}회 경력 반영)</dd>` : ''}
        </dl></section>
      <section class="of-card"><h4>보직</h4>
        <label class="of-field"><span>현재 보직 ${injured ? '<span class="warn">(부상 — 회복 전에는 효과 없음)</span>' : ''}</span>${this.postSelect(o)}</label>
        ${g ? `<button class="an-link" data-a="fleet" data-id="${g.id}">편대 보기 →</button>` : ''}
        <label class="of-field"><span>훈련 방향 <small class="dim">(해당 분야 숙련도 +${Math.round(FOCUS_BONUS * 100)}%, 1시간마다 변경 가능)</small></span><select data-focus="${o.id}"${this.busy ? ' disabled' : ''}><option value="">없음</option>${TREES.map(t => `<option value="${t.id}"${of.focus === t.id ? ' selected' : ''}>${t.name}</option>`).join('')}</select></label>
        <dl class="of-dl"><dt>급여</dt><dd><b>${n0(pay?.perHour ?? 0)} cr</b>/시간 — ${esc(pay?.post ?? '')}</dd></dl>
        <div class="dim small">급여는 보직과 지휘 규모에 따라 정해지고 레벨당 소폭 오릅니다. 체불되면 일반 운영비 미납금이 되며, 장교가 명령을 거부하거나 이탈하지 않습니다.</div></section>
      <section class="of-card of-wide"><h4>분야 숙련도 <small class="dim">— 누르면 해당 스킬 트리</small></h4>
        <div class="of-mcols"><div><div class="of-sub">전투</div>${masteryCol('combat')}</div><div><div class="of-sub">산업·지원</div>${masteryCol('industry')}</div></div></section>
      <section class="of-card of-wide"><h4>현재 효과</h4>${this.fxRows(o)}</section>
    </div>`;
  }

  // ------------------------------------------------------------------------------------- skill tree

  private nodeState(o: Officer, n: SkillNode): 'max' | 'have' | 'open' | 'lock' | 'block' {
    const r = o.of.skills[n.id] ?? 0;
    if (r >= n.max) return 'max';
    const why = learnBlock(o, n);
    if (!why) return r ? 'have' : 'open';
    if (r) return 'have';
    // mutually exclusive with something already learned, or capstone limit → permanently blocked for now
    if (/함께 배울 수 없음|최종 전문화는/.test(why)) return 'block';
    return 'lock';
  }

  private treeHtml(o: Officer): string {
    const chips = (kind: 'combat' | 'industry') => TREES.filter(t => t.kind === kind).map(t => {
      const learned = SKILLS.filter(n => n.tree === t.id && o.of.skills[n.id]).length;
      return `<button class="of-chip${this.tree === t.id ? ' on' : ''}" data-a="tree" data-id="${t.id}" aria-pressed="${this.tree === t.id}">${t.icon} ${t.name}${learned ? ` <small>${learned}</small>` : ''}</button>`;
    }).join('');
    const nodes = SKILLS.filter(n => n.tree === this.tree && (!n.sig || n.sig === o.of.named));
    const W = 5, colX = (c: number) => 70 + c * 130, rowY = (t: number) => 50 + (t - 1) * 100, R = 28;
    const pos = new Map(nodes.map(n => [n.id, { x: colX(n.col), y: rowY(n.tier) }]));
    const lines: string[] = [];
    for (const n of nodes) {
      const to = pos.get(n.id)!;
      for (const r of n.req ?? []) { const f = pos.get(r); if (f) lines.push(`<line class="of-ln${o.of.skills[r] ? ' on' : ''}" x1="${f.x}" y1="${f.y + R}" x2="${to.x}" y2="${to.y - R}"/>`); }
      for (const r of n.reqAny ?? []) { const f = pos.get(r); if (f) lines.push(`<line class="of-ln any${o.of.skills[r] ? ' on' : ''}" x1="${f.x}" y1="${f.y + R}" x2="${to.x}" y2="${to.y - R}"/>`); }
    }
    const tiers = [1, 2, 3, 4, 5].map(t => { const g = TIER_GATE[t]; const ok = o.level >= g.level && masteryLevel(o.of.mastery[this.tree] ?? 0) >= g.mastery; return `<text class="of-tier${ok ? ' ok' : ''}" x="4" y="${rowY(t) - 34}">${g.name} · Lv.${g.level}${g.mastery ? ` · ${MASTERY_NAME[g.mastery]}` : ''}</text>`; }).join('');
    const svgNodes = nodes.map(n => {
      const p = pos.get(n.id)!, st = this.nodeState(o, n), r = o.of.skills[n.id] ?? 0;
      const label = n.name.length > 7 ? n.name.slice(0, 7) + '…' : n.name;
      return `<g class="of-node ${st}${this.node === n.id ? ' sel' : ''}${n.tier === 5 ? ' cap' : ''}${n.sig ? ' sig' : ''}" data-a="node" data-id="${n.id}" tabindex="0" role="button" aria-label="${esc(n.name)} ${r}/${n.max}">
        ${n.tier === 5 ? `<polygon points="${p.x},${p.y - R - 4} ${p.x + R + 4},${p.y} ${p.x},${p.y + R + 4} ${p.x - R - 4},${p.y}"/>` : `<circle cx="${p.x}" cy="${p.y}" r="${R}"/>`}
        <text class="of-nr" x="${p.x}" y="${p.y + 5}">${r}/${n.max}</text>
        <text class="of-nl" x="${p.x}" y="${p.y + R + 16}">${esc(label)}</text>
        ${n.cross ? `<text class="of-nx" x="${p.x + R - 2}" y="${p.y - R + 6}">⇄</text>` : ''}${n.ex ? `<text class="of-nx" x="${p.x - R - 4}" y="${p.y - R + 6}">⊘</text>` : ''}</g>`;
    }).join('');
    const sel = SKILL[this.node] && this.node && nodes.some(n => n.id === this.node) ? SKILL[this.node] : null;
    const caps = Object.keys(o.of.skills).filter(id => SKILL[id]?.tier === 5).length;
    const tm = o.of.mastery[this.tree] ?? 0, ml = masteryLevel(tm);
    return `<div class="of-chips"><div><span class="of-sub">전투</span>${chips('combat')}</div><div><span class="of-sub">산업·지원</span>${chips('industry')}</div></div>
      <div class="of-treehead"><b>${TREES.find(t => t.id === this.tree)!.icon} ${TREE_NAME[this.tree]}</b> <span class="dim">${esc(TREES.find(t => t.id === this.tree)!.desc)}</span>
        <span>숙련도 <b>${MASTERY_NAME[ml]}</b> ${n0(tm)} · 포인트 <b>${o.of.sp}</b> · 최종 전문화 ${caps}/${MAX_CAPSTONES}</span></div>
      <div class="of-treewrap"><svg class="of-tree" viewBox="0 0 ${colX(W - 1) + 70} ${rowY(5) + 60}" role="group" aria-label="${TREE_NAME[this.tree]} 스킬 트리">${tiers}${lines.join('')}${svgNodes}</svg>
        <div class="of-nodeinfo">${sel ? this.nodeInfo(o, sel) : `<div class="dim">노드를 누르면 효과·조건·현재 값이 표시됩니다.</div>
          <ul class="of-legend"><li><i class="lg-max"></i>최대 단계</li><li><i class="lg-have"></i>습득</li><li><i class="lg-open"></i>지금 배울 수 있음</li><li><i class="lg-lock"></i>조건 미충족</li><li><i class="lg-block"></i>상호 배타·상한으로 막힘</li><li>실선: 선행 필수 · 점선: 하나 이상 · ⇄ 다른 분야 연계 · ⊘ 택일 · ◆ 최종 전문화</li></ul>`}</div></div>`;
  }

  private nodeInfo(o: Officer, n: SkillNode): string {
    const r = o.of.skills[n.id] ?? 0, why = learnBlock(o, n), gate = TIER_GATE[n.tier];
    const reqs: string[] = [];
    reqs.push(`${gate.name}: 장교 Lv.${gate.level}${gate.mastery ? ` · ${TREE_NAME[n.tree]} 숙련도 ${MASTERY_NAME[gate.mastery]}(${n0(MASTERY[gate.mastery])})` : ''}`);
    if (n.req?.length) reqs.push(`선행(모두): ${n.req.map(x => `${esc(SKILL[x]?.name ?? x)}${o.of.skills[x] ? ' ✓' : ''}`).join(', ')}`);
    if (n.reqAny?.length) reqs.push(`선행(하나 이상): ${n.reqAny.map(x => `${esc(SKILL[x]?.name ?? x)}${o.of.skills[x] ? ' ✓' : ''}`).join(', ')}`);
    if (n.cross) reqs.push(`분야 연계: ${TREE_NAME[SKILL[n.cross]?.tree as Tree] ?? ''} "${esc(SKILL[n.cross]?.name ?? n.cross)}"${o.of.skills[n.cross] ? ' ✓' : ''}`);
    if (n.ex) reqs.push(`택일: ${SKILLS.filter(x => x.ex === n.ex && x.id !== n.id).map(x => `"${esc(x.name)}"`).join(', ')}과(와) 함께 배울 수 없음`);
    if (n.tier === 5) reqs.push(`최종 전문화는 장교 한 명당 ${MAX_CAPSTONES}개까지`);
    const cur = r ? nodeLines(n, r) : [], next = r < n.max ? nodeLines(n, r + 1) : [];
    const dom = [...new Set(Object.keys(n.fx).map(k => (FX[k as FxKey] as { domain: Domain }).domain))];
    return `<div class="of-ni"><h4>${esc(n.name)} <small>${r}/${n.max}단계 · ${n.cost}포인트</small></h4>
      ${n.note ? `<p class="dim">${esc(n.note)}</p>` : ''}
      ${cur.length ? `<div class="of-sub">현재 효과</div><ul>${cur.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${next.length ? `<div class="of-sub">${r ? '다음 단계' : '습득 시'}</div><ul>${next.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <div class="of-sub">적용 범위</div><div class="small">${dom.map(d => esc(DOMAIN_NAME[d])).join(' · ')}</div>
      <div class="of-sub">조건</div><ul class="small">${reqs.map(x => `<li>${x}</li>`).join('')}</ul>
      ${r >= n.max ? '<div class="good">최대 단계</div>' : why ? `<div class="warn" role="note">${esc(why)}</div>` : `<button class="btn go" data-a="learn" data-id="${n.id}"${this.busy ? ' disabled' : ''}>${r ? '단계 올리기' : '습득'} (${n.cost}P)</button>`}</div>`;
  }

  // ------------------------------------------------------------------------------------- compare & log

  private compareHtml(all: Officer[]): string {
    const ids = this.cmp.size ? [...this.cmp] : this.sel ? [this.sel] : [];
    const os = ids.map(id => all.find(o => o.id === id)).filter((x): x is Officer => !!x);
    if (os.length < 2) return `<div class="dim of-pad">목록 오른쪽 체크박스로 장교를 2~4명 고르면 나란히 비교합니다.${os.length ? ` (현재 ${esc(os[0].name)} 1명)` : ''}</div>`;
    const pays = new Map(payroll(this.w as never, this.me).lines.map(l => [l.id, l.perHour]));
    const fxs = os.map(o => officerFx(o));
    const keys = FX_KEYS.filter(k => fxs.some(f => f[k]));
    const row = (label: string, cells: string[], best?: number[]) => `<tr><th>${label}</th>${cells.map((c, i) => `<td${best && best[i] === Math.max(...best) && best.filter(v => v === Math.max(...best)).length < best.length ? ' class="best"' : ''}>${c}</td>`).join('')}</tr>`;
    return `<div class="of-cmpwrap"><table class="of-cmp"><thead><tr><th></th>${os.map(o => `<th><button class="an-link" data-a="pick" data-id="${o.id}">${esc(o.name)}</button>${o.of.named ? ' ★' : ''}</th>`).join('')}</tr></thead><tbody>
      ${row('레벨', os.map(o => `Lv.${o.level} <small>${RANK_BAND(o.level)}</small>`), os.map(o => o.level))}
      ${row('특성', os.map(o => esc(TRAIT[o.of.trait]?.name ?? '')))}
      ${row('보직', os.map(o => esc(this.postText(o).text)))}
      ${row('판단력', os.map(o => String(Math.round(o.skill * 100))), os.map(o => o.skill))}
      ${row('성장 재능', os.map(o => `+${Math.round(o.of.talent * 100)}%`), os.map(o => o.of.talent))}
      ${row('포인트(미사용/총)', os.map(o => `${o.of.sp}/${o.of.spGiven}`), os.map(o => o.of.spGiven))}
      ${row('급여', os.map(o => `${n0(pays.get(o.id) ?? 0)} cr/h`))}
      ${row('교전', os.map(o => String(o.battles)), os.map(o => o.battles))}
      ${TREES.map(t => row(`${t.icon} ${t.name}`, os.map(o => { const v = o.of.mastery[t.id] ?? 0; return v ? `${MASTERY_NAME[masteryLevel(v)]} <small>${n0(v)}</small>` : '<span class="dim">—</span>'; }), os.map(o => o.of.mastery[t.id] ?? 0))).join('')}
      ${keys.length ? `<tr class="of-cmpsep"><th colspan="${os.length + 1}">스킬 효과</th></tr>` : ''}
      ${keys.map(k => row(esc((FX[k] as { label: string }).label), fxs.map(f => f[k] ? ((FX[k] as { unit: string }).unit === 'flag' ? '✓' : `${Math.round(f[k]! * 100)}${(FX[k] as { unit: string }).unit === 'pt' ? '' : '%'}`) : '<span class="dim">—</span>'), fxs.map(f => f[k] ?? 0))).join('')}
    </tbody></table></div>`;
  }

  private logHtml(o: Officer): string {
    const of = o.of, t = this.w.time;
    const ago = (x: number) => { const s = Math.max(0, t - x); return s < 90 ? `${Math.round(s)}초 전` : s < 5400 ? `${Math.round(s / 60)}분 전` : `${(s / 3600).toFixed(1)}시간 전`; };
    const earned = Object.entries(of.earned).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = earned.reduce((a, [, v]) => a + v, 0);
    return `<div class="of-grid">
      <section class="of-card"><h4>업적 <small>${of.feats.length}</small></h4>${of.feats.length ? `<ul class="of-feats">${of.feats.map(f => `<li>🏅 ${esc(FEAT_NAME[f] ?? f)}</li>`).join('')}</ul>` : '<div class="dim">아직 업적이 없습니다.</div>'}</section>
      <section class="of-card"><h4>경험치 출처 <small>총 ${n0(total)}</small></h4>${earned.length ? earned.map(([k, v]) => `<div class="of-src"><span>${esc(SRC_NAME[k] ?? k)}</span><span class="of-mbar"><i style="width:${total ? v / total * 100 : 0}%"></i></span><small>${n0(v)}</small></div>`).join('') : '<div class="dim">실적이 쌓이면 표시됩니다.</div>'}</section>
      <section class="of-card of-wide"><h4>성장 기록</h4>${of.log.length ? `<ol class="of-log">${[...of.log].reverse().map(l => `<li class="${l.k}"><small>${ago(l.t)}</small> ${esc(l.text)}</li>`).join('')}</ol>` : '<div class="dim">기록이 없습니다.</div>'}</section>
    </div>`;
  }
}

/** recruit-card summary for an officer in a hiring pool (trait, talent, growth) */
export function recruitOfficerHtml(c: WCommander): string {
  if (!isOfficer(c)) return '';
  const tr = TRAIT[c.of.trait], grow = Object.entries(tr?.grow ?? {}).filter(([, v]) => v).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const best = TREES.map(t => [t, c.of.mastery[t.id] ?? 0] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return `<div class="of-recruit"><b>${c.of.named ? '★ 고유 장교 · ' : ''}${esc(tr?.name ?? '')}</b> <span class="dim">Lv.${c.level} · ${RANK_BAND(c.level)}</span>
    <div class="small">${grow.map(([t, v]) => `<span class="${(v ?? 0) > 0 ? 'good' : 'warn'}">${TREE_NAME[t as Tree]} ${(v ?? 0) > 0 ? '+' : ''}${Math.round((v ?? 0) * 100)}%</span>`).join(' · ')}${c.of.talent ? ` · 경험치 +${Math.round(c.of.talent * 100)}%` : ''}</div>
    ${best.length ? `<div class="small dim">숙련: ${best.map(([t, v]) => `${t.name} ${MASTERY_NAME[masteryLevel(v)]}`).join(', ')}</div>` : '<div class="small dim">신입 — 급여가 낮고 어떤 분야로든 키울 수 있습니다</div>'}</div>`;
}
