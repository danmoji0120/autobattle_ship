// A-3.2a: the first-business guide for hauler and miner starts. It reads the real world (markets, budgets,
// fields, the company's ledger) through world/firstBusiness.ts and acts only through ordinary commands:
// `buy` + `poolCreate` (hauler), `setOp` mine (miner), `setOp` dock/idle (moving empty haulers).
import type { WorldView } from '../../server/protocol';
import type { WorldState } from '../../world/types';
import { itemName } from '../../world/industry';
import { buyCost } from '../../world/market';
import { econOf } from '../../world/hullops';
import { FIELD_JUMPS, fieldOptions, movableGroups, firstBusinessOn, firstBusinessStatus, relocationOptions, riskLabel, sellWalk, TRADE_JUMPS, tradeOpportunities, type FieldOption, type FirstStatus, type Relocation, type TradeOption } from '../../world/firstBusiness';
import { BACKGROUND } from '../../world/backgrounds';
import { morph } from '../../ui/morph';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
const sgn = (n: number) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
const full = (w: WorldView) => w as unknown as WorldState;
const CAT: Record<string, string> = { sales: '판매', purchase: '구매', upkeep: '운영비', other: '계약·기타', storage: '보관 임대', repair: '수리', fines: '벌금', law_fines: '치안 벌금' };
const JOB_STATE: Record<string, string> = { queued: '배차 대기', active: '운송 중', waiting: '대기', paused: '일시정지', complete: '완료', cancelled: '취소' };

export interface FirstBusinessHost {
  cmd(c: any): Promise<boolean>;
  openStation(id: string): void;
  openLogistics(): void;
  toast(msg: string, kind?: string): void;
}

/** the guide panel; the HUD owns one and calls render() on every refresh */
export class FirstBusinessPanel {
  open = false;
  private el: HTMLElement | null = null;
  private key = '';
  private cache: { at: number; trades: TradeOption[]; reloc: Relocation[]; fields: FieldOption[] } | null = null;
  /** empty haulers this guide sent to another station: switched back to standby (pool) on arrival */
  private moving: { groups: string[]; station: string } | null = null;

  constructor(private root: HTMLElement, private host: FirstBusinessHost, private w: () => WorldView, private me: () => string) {}

  /** whether the top bar shows the guide button */
  available(): boolean { const w = this.w(); return !!w && firstBusinessOn(w.companies[this.me()]); }
  done(): boolean { return !!this.w()?.companies[this.me()]?.milestones.includes('first_profit'); }

  /** open it once, the first time a new hauler/miner company is seen on this browser */
  autoOpen() {
    if (!this.available() || this.done()) return;
    const k = `siderarium.fb.${this.me()}`;
    try { if (localStorage.getItem(k)) return; localStorage.setItem(k, '1'); } catch { /* storage blocked: open anyway */ }
    this.open = true;
  }

  toggle() { this.open = !this.open; this.render(true); }
  close() { this.open = false; this.render(true); }

  /** moving haulers: once every one of them is docked at the target, put the groups back on standby */
  private tickMoving() {
    const m = this.moving; if (!m) return;
    const w = this.w(), ships = Object.values(w.ships).filter(s => s.owner === this.me() && m.groups.includes(s.groupId));
    if (!ships.length || m.groups.some(g => w.groups[g]?.op.k !== 'dock')) { this.moving = null; return; }
    if (ships.every(s => s.state === 'docked' && s.task.k === 'docked' && s.task.station === m.station)) {
      this.moving = null;
      for (const g of m.groups) void this.host.cmd({ c: 'setOp', group: g, op: { k: 'idle' } });
    }
  }

  render(force: boolean) {
    this.tickMoving();
    if (!this.open || !this.available()) { this.el?.remove(); this.el = null; return; }
    const w = full(this.w()), me = this.me(), co = w.companies[me];
    const now = performance.now();
    if (force || !this.cache || now - this.cache.at > 4000) {
      const trades = co.background === 'hauler' ? tradeOpportunities(w, me) : [];
      this.cache = { at: now, trades, reloc: co.background === 'hauler' && !trades.length ? relocationOptions(w, me) : [], fields: co.background === 'miner' ? fieldOptions(w, me).slice(0, 6) : [] };
    }
    const s = firstBusinessStatus(w, me)!;
    const key = JSON.stringify([this.cache.at, Math.round(co.credits), s.steps.map(x => x.done), s.jobs.map(j => [j.state, Math.round(j.delivered), Math.round(j.earned)]), s.mining.map(g => [g.field, g.deliver, g.status]), s.warnings, this.moving]);
    if (!force && key === this.key && this.el) return;
    this.key = key;
    if (!this.el) { this.el = document.createElement('div'); this.el.className = 'upkwrap fbwrap'; this.root.appendChild(this.el); }
    // keep typed amounts across re-renders
    const typed = new Map([...this.el.querySelectorAll<HTMLInputElement>('[data-fbamt]')].map(i => [i.dataset.fbamt!, i.value]));
    morph(this.el, this.html(w, me, s));
    for (const [k, v] of typed) { const i = this.el.querySelector<HTMLInputElement>(`[data-fbamt="${k}"]`); if (i) { i.value = v; this.reprice(i); } }
    this.bind(w, me);
  }

  private html(w: WorldState, me: string, s: FirstStatus): string {
    const co = w.companies[me], bg = BACKGROUND[co.background!], stn = (id?: string) => esc(w.stations[id ?? '']?.name ?? id ?? '');
    const p = s.pnl, cats = (o: Record<string, number>, sign: string) => Object.entries(o).filter(([, v]) => Math.abs(v) >= 1).map(([k, v]) => `<span>${CAT[k] ?? k} ${sign}${fmt(v)}</span>`).join(' · ');
    const steps = s.steps.map((x, i) => `<li class="${x.done ? 'good' : i === s.steps.findIndex(y => !y.done) ? 'fbnow' : 'dim'}">${x.done ? '✓' : '○'} ${esc(x.label)}</li>`).join('');
    const pnl = `<div class="fbpnl"><div>자금 <b>${fmt(s.start)}</b> → <b class="money">${fmt(s.credits)}</b> cr <b class="${s.cash >= 0 ? 'good' : 'warn'}">(${sgn(s.cash)})</b></div>
      <div class="small">수입: ${cats(p.income, '+') || '없음'}</div><div class="small">지출: ${cats(p.expense, '−') || '없음'}</div>
      <div class="small">장부상 순이익 <b class="${p.net >= 0 ? 'good' : 'warn'}">${sgn(p.net)} cr</b> — 운영비는 함선이 놀아도 계속 나갑니다${Object.keys(s.stored).length ? ` · 보유 재고: ${Object.entries(s.stored).map(([k, n]) => `${esc(itemName(k))} ${fmt(n)}`).join(', ')}` : ''}</div></div>`;
    const warn = s.warnings.length ? `<ul class="fbwarn">${s.warnings.map(x => `<li class="warnish">${esc(x)}</li>`).join('')}</ul>` : '';
    const doneTxt = s.done ? `<div class="good fbdone">첫 사업 완료 — 운영비를 빼고도 자금이 창업 때보다 늘었습니다. 같은 방법으로 계속 거래하거나, 회사 본부에서 반복 업무로 맡길 수 있습니다.</div>` : '';
    const body = co.background === 'hauler' ? this.haulerHtml(w, me, s, stn) : this.minerHtml(w, me, s, stn);
    return `<div class="panel upk fb"><div class="shdr"><div><div class="stitle">첫 사업 — ${esc(bg?.name ?? '')}</div><div class="dim small">${esc(stn(co.homeStation))}에서 시작 · 지원금 없이 실제 시장과 함선으로 운영합니다</div></div><button class="btn" data-fbclose>✕</button></div>
      ${doneTxt}<ol class="fbsteps">${steps}</ol>${pnl}${warn}${body}</div>`;
  }

  private haulerHtml(w: WorldState, me: string, s: FirstStatus, stn: (id?: string) => string): string {
    const jobs = s.jobs.length ? `<div class="ptitle"><span>진행 중 · 최근 운송</span><button class="btn mini" data-fblog>물류 현황</button></div><table class="gt"><tr><th>화물</th><th>경로</th><th class="n">판매/수량</th><th class="n">수입</th><th>상태</th></tr>${s.jobs.map(j => `<tr><td>${esc(itemName(j.item))}</td><td class="small">${stn(j.from)} → ${stn(j.to)}</td><td class="n">${fmt(j.delivered)}/${fmt(j.amount)}</td><td class="n">${j.earned ? fmt(j.earned) : '—'}</td><td class="small">${JOB_STATE[j.state] ?? j.state}${j.reason ? ` · <span class="dim">${esc(j.reason)}</span>` : ''}</td></tr>`).join('')}</table>` : '';
    const idle = Object.values(w.ships).filter(x => x.owner === me && x.classId === 'hauler');
    const free = idle.filter(x => x.state === 'docked' && !x.logisticsJob && w.groups[x.groupId]?.op.k === 'idle');
    const trades = this.cache!.trades;
    const intro = `<div class="small fbintro">대기 중인 수송선이 있는 정거장에서 살 수 있고, ${TRADE_JUMPS}점프 안의 다른 정거장에서 더 비싸게 팔리는 화물입니다. 예상 금액은 지금 시세로 계산하며, 사는 만큼 출발지 가격이 오르고 파는 만큼 도착지 가격이 내려가는 것까지 반영했습니다. <b>구매·출발</b>을 누르면 출발지에서 사서 창고에 넣고, 수송선이 실어 가서 도착지 시장에 팝니다(물류 작업). 수량은 바꿀 수 있습니다.</div>`;
    let list = '';
    if (this.moving) list = `<div class="small">빈 수송선이 ${stn(this.moving.station)}로 이동 중입니다 — 도착하면 운송 대기로 돌아가고 그곳의 거래 기회가 보입니다.</div>`;
    else if (!free.length) list = `<div class="small dim">대기 중인 수송선이 없습니다 — 운송이 끝나면 다시 기회를 보여 드립니다.</div>`;
    else if (trades.length) list = `<table class="gt fbtrades"><tr><th>화물</th><th>경로</th><th class="n">수량</th><th class="n">구매</th><th class="n">예상 판매</th><th class="n">예상 이익</th><th></th></tr>${trades.map((o, i) => `<tr data-fbrow="${i}">
        <td>${esc(itemName(o.item))}<div class="dim small">제한: ${esc(o.limit)}</div></td>
        <td class="small"><a href="#" data-fbst="${o.from}">${stn(o.from)}</a> → <a href="#" data-fbst="${o.to}">${stn(o.to)}</a><div class="dim">${o.jumps}점프 · <span class="${o.risk > 55 ? 'warn' : o.risk > 30 ? 'warnish' : 'good'}">항로 ${riskLabel(o.risk)} ${o.risk}</span></div></td>
        <td class="n"><input type="number" min="1" max="${o.amount}" step="1" value="${o.amount}" data-fbamt="${i}" class="fbamt"></td>
        <td class="n" data-fbcost="${i}">${fmt(o.cost)}</td><td class="n" data-fbrev="${i}">${fmt(o.revenue)}</td><td class="n good" data-fbprof="${i}">+${fmt(o.profit)}</td>
        <td><button class="btn mini" data-fbtrade="${i}">구매·출발</button></td></tr>`).join('')}</table>`;
    else if (this.cache!.reloc.length) list = `<div class="small">지금 수송선이 있는 곳에서는 이익이 나는 화물이 없습니다(시장이 포화됐거나 자금·수요가 부족). 빈 배로 가까운 정거장에 가면 다음 거래를 시작할 수 있습니다:</div><table class="gt">${this.cache!.reloc.map((r, i) => `<tr><td>${stn(r.station)} <span class="dim small">${r.jumps}점프 · 항로 ${riskLabel(r.risk)} ${r.risk}</span></td><td class="small">그곳에서: ${esc(itemName(r.best.item))} → ${stn(r.best.to)} 예상 <b class="good">+${fmt(r.best.profit)}</b></td><td><button class="btn mini" data-fbmove="${i}">빈 배로 이동</button></td></tr>`).join('')}</table>`;
    else list = `<div class="small dim">주변에 이익이 나는 거래가 없습니다. 시장은 시간이 지나면 회복됩니다 — 잠시 뒤 다시 확인하세요.</div>`;
    return `${jobs}<div class="ptitle"><span>지금의 거래 기회</span><span class="dim small">수송선 ${free.length}/${idle.length}척 대기</span></div>${intro}${list}`;
  }

  private minerHtml(w: WorldState, me: string, s: FirstStatus, stn: (id?: string) => string): string {
    const g = this.minerGroup(w, me), op = g?.op.k === 'mine' ? g.op : undefined;
    const roles = g ? (() => { const ships = Object.values(w.ships).filter(x => x.owner === me && x.groupId === g.id); const m = ships.filter(x => econOf(x).mine > 0).length, h = ships.filter(x => x.classId === 'hauler').length; return `채굴선 ${m}척이 광구에서 캐고, 수송선 ${h}척이 다 찬 화물을 받아 하역지로 나릅니다. 하역지에서 시장이 사는 품목은 바로 팔고(정거장 구매 예산 안에서), 나머지는 창고에 넣습니다.`; })() : '';
    const cur = op ? `<div class="fbcur">현재: <b>${esc(w.fields[op.field]?.name ?? op.field)}</b> → <a href="#" data-fbst="${op.deliver}">${stn(op.deliver)}</a> ${op.sell ? '판매' : '보관'} · <span class="dim">${esc(g!.status ?? '')}</span></div>` : '';
    const sold = Object.entries(s.pnl.sales).filter(([, v]) => v >= 1);
    const sales = sold.length ? `<div class="small">품목별 판매: ${sold.map(([k, v]) => `${esc(itemName(k))} ${fmt(v)} cr`).join(' · ')} · 채굴량 ${fmt(w.companies[me].stats.mined)}</div>` : '';
    const fields = this.cache!.fields.map(f => {
      const mix = Object.entries(f.mix).map(([k, v]) => `${esc(itemName(k))} ${Math.round(v * 100)}%`).join(' · ');
      const rows = f.deliveries.map(d => `<tr><td class="small"><a href="#" data-fbst="${d.station}">${stn(d.station)}</a> <span class="dim">${d.jumps ? `${d.jumps}점프` : '같은 성계'}</span></td><td class="n">${fmt(d.per100)}</td><td class="n ${d.unsold ? 'warnish' : ''}">${d.unsold ? `${d.unsold}%` : '—'}</td><td class="n small">${fmt(d.funds)}</td><td>${op && op.field === f.field && op.deliver === d.station ? '<span class="good small">진행 중</span>' : `<button class="btn mini" data-fbmine="${f.field}|${d.station}">이곳에 하역·판매</button>`}</td></tr>`).join('');
      return `<div class="fbfield"><div><b>${esc(f.name)}</b> <span class="dim small">${f.jumps ? `본거지에서 ${f.jumps}점프` : '본거지 성계'} · 잔량 ${fmt(f.amount)}/${fmt(f.max)}${f.depleted ? ' · <span class="warn">고갈</span>' : ''} · 위험 ${f.danger}</span></div><div class="small dim">구성: ${mix}</div>
        ${rows ? `<table class="gt"><tr><th>하역지</th><th class="n">100단위당 cr</th><th class="n">안 팔림</th><th class="n">구매 예산</th><th></th></tr>${rows}</table>` : '<div class="small warn">근처에 이 광석을 사는 시장이 없습니다</div>'}</div>`;
    }).join('');
    return `<div class="ptitle"><span>채굴 작전</span><button class="btn mini" data-fblog>물류 현황</button></div><div class="small">${roles}</div>${cur}${sales}
      <div class="small fbintro">광구와 하역지를 고르면 부대 전체가 그 작전을 반복합니다(매번 명령할 필요 없음). 금액은 지금 시세로 100단위를 팔 때의 값입니다. 이웃 성계 하역지는 멀지만 비싸게 사는 곳이 많고, 같은 성계는 가깝지만 조합 시장의 구매 예산(${fmt(w.stations[w.companies[me].homeStation ?? '']?.funds ?? 0)} cr)이 바닥나면 판매가 멈춥니다. "안 팔림"은 그 정거장이 사지 않는 광석 비율로, 창고에 쌓입니다. 광구는 캘수록 줄어들고 시간이 지나면 다시 찹니다(${FIELD_JUMPS}점프 안의 알려진 광구).</div>
      ${fields}`;
  }

  private minerGroup(w: WorldState, me: string) {
    return Object.values(w.groups).find(g => g.owner === me && Object.values(w.ships).some(s => s.owner === me && s.groupId === g.id && econOf(s).mine > 0));
  }

  /** a typed amount: recompute the estimate with the same walks as the server */
  private reprice(i: HTMLInputElement) {
    const o = this.cache?.trades[Number(i.dataset.fbamt)]; if (!o || !this.el) return;
    const w = full(this.w()), n = Math.max(1, Math.min(o.amount, Math.floor(Number(i.value) || 0)));
    const cost = buyCost(w.stations[o.from]?.market?.[o.item], n, true), rev = sellWalk(w, w.stations[o.to], o.item, n).value;
    const set = (sel: string, t: string) => { const e = this.el!.querySelector(sel); if (e) e.textContent = t; };
    set(`[data-fbcost="${i.dataset.fbamt}"]`, fmt(cost)); set(`[data-fbrev="${i.dataset.fbamt}"]`, fmt(rev));
    const pe = this.el.querySelector<HTMLElement>(`[data-fbprof="${i.dataset.fbamt}"]`); if (pe) { pe.textContent = sgn(rev - cost); pe.className = `n ${rev - cost >= 0 ? 'good' : 'warn'}`; }
  }

  private bind(w: WorldState, me: string) {
    const e = this.el!;
    e.querySelector<HTMLButtonElement>('[data-fbclose]')!.onclick = () => this.close();
    e.querySelectorAll<HTMLButtonElement>('[data-fblog]').forEach(b => b.onclick = () => this.host.openLogistics());
    e.querySelectorAll<HTMLAnchorElement>('[data-fbst]').forEach(a => a.onclick = ev => { ev.preventDefault(); this.host.openStation(a.dataset.fbst!); });
    e.querySelectorAll<HTMLInputElement>('[data-fbamt]').forEach(i => i.oninput = () => this.reprice(i));
    e.querySelectorAll<HTMLButtonElement>('[data-fbtrade]').forEach(b => b.onclick = async () => {
      const i = b.dataset.fbtrade!, o = this.cache?.trades[Number(i)]; if (!o) return;
      const n = Math.max(1, Math.min(o.amount, Math.floor(Number(e.querySelector<HTMLInputElement>(`[data-fbamt="${i}"]`)?.value) || 0)));
      b.disabled = true;
      if (!(await this.host.cmd({ c: 'buy', station: o.from, res: o.item, amount: n }))) { b.disabled = false; return; }
      // the goods are in the origin warehouse now; the pool hauler takes them to market
      if (!(await this.host.cmd({ c: 'poolCreate', request: { from: o.from, to: o.to, item: o.item, kind: 'sell', amount: n, priority: 5, repeat: false } }))) { this.host.toast(`${itemName(o.item)} ${n}은(는) ${w.stations[o.from]?.name} 창고에 있습니다 — 물류 현황에서 다시 보낼 수 있습니다`, 'warn'); }
      this.cache = null; this.render(true);
    });
    e.querySelectorAll<HTMLButtonElement>('[data-fbmove]').forEach(b => b.onclick = async () => {
      const r = this.cache?.reloc[Number(b.dataset.fbmove)]; if (!r) return;
      const groups = movableGroups(w, me, r.from);
      b.disabled = true;
      let ok = groups.length > 0;
      for (const g of groups) ok = (await this.host.cmd({ c: 'setOp', group: g, op: { k: 'dock', station: r.station } })) && ok;
      if (ok) this.moving = { groups, station: r.station };
      this.cache = null; this.render(true);
    });
    e.querySelectorAll<HTMLButtonElement>('[data-fbmine]').forEach(b => b.onclick = async () => {
      const [field, deliver] = b.dataset.fbmine!.split('|'); const g = this.minerGroup(w, me); if (!g) return;
      b.disabled = true;
      await this.host.cmd({ c: 'setOp', group: g.id, op: { k: 'mine', field, deliver, sell: true } });
      this.cache = null; this.render(true);
    });
  }
}
