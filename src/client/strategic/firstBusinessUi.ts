// A-3.2a: the first-business guide for hauler and miner starts. It reads the real world (markets, budgets,
// fields, the company's ledger) through world/firstBusiness.ts and acts only through ordinary commands:
// `buy` + `poolCreate` (hauler), `setOp` mine (miner), `setOp` dock/idle (moving empty haulers); A-3.2b salvager:
// `setOp` recover (인양 시작), `accept` (only on an explicit click), `salesPolicy` (회수품 자동 판매).
import type { WorldView } from '../../server/protocol';
import type { WorldState } from '../../world/types';
import { itemName } from '../../world/industry';
import { buyCost } from '../../world/market';
import { econOf } from '../../world/hullops';
import { FIELD_JUMPS, fieldOptions, movableGroups, firstBusinessOn, firstBusinessStatus, relocationOptions, riskLabel, sellWalk, TRADE_JUMPS, tradeOpportunities, salvageOpportunities, SALVAGE_JUMPS, SALVAGE_ROLES, SALVAGE_SELL_ITEMS, salvageConfirm, salvageOperatingStatus, SALVAGE_OP_NAME, SITE_THREAT_R, type SalvageOpStatus, type FieldOption, type FirstStatus, type Relocation, type TradeOption, type SalvageOption } from '../../world/firstBusiness';
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
  /** A-3.2b.2: the station's existing shipyard screen with this hull's card picked out (buying stays there) */
  openYard(station: string, hull: string): void;
  openLogistics(): void;
  toast(msg: string, kind?: string): void;
}

/** the guide panel; the HUD owns one and calls render() on every refresh */
export class FirstBusinessPanel {
  open = false;
  private el: HTMLElement | null = null;
  private key = '';
  private cache: { at: number; trades: TradeOption[]; reloc: Relocation[]; fields: FieldOption[]; salvage: SalvageOption[] } | null = null;
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
      this.cache = { at: now, trades, reloc: co.background === 'hauler' && !trades.length ? relocationOptions(w, me) : [], fields: co.background === 'miner' ? fieldOptions(w, me).slice(0, 6) : [], salvage: co.background === 'salvager' ? salvageOpportunities(w, me) : [] };
    }
    const s = firstBusinessStatus(w, me)!;
    const sv = s.salvage;
    const key = JSON.stringify([this.cache.at, Math.round(co.credits), s.steps.map(x => x.done), s.jobs.map(j => [j.state, Math.round(j.delivered), Math.round(j.earned)]), s.mining.map(g => [g.field, g.deliver, g.status]), s.warnings, this.moving,
      sv ? [sv.groups.map(g => [g.op, g.target, g.status]), Math.round(sv.units), Object.values(sv.aboard).map(Math.round), sv.contracts.map(k => [Math.round(k.progress), k.done]), sv.board.map(k => k.id)] : 0]);
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
    const body = co.background === 'hauler' ? this.haulerHtml(w, me, s, stn) : co.background === 'salvager' ? this.salvagerHtml(w, me, s, stn) : this.minerHtml(w, me, s, stn);
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

  /** A-3.2b: the salvager's guide — nearby targets, contracts on the boards, the fleet's roles and what it recovered */
  private salvagerHtml(w: WorldState, me: string, s: FirstStatus, stn: (id?: string) => string): string {
    const sv = s.salvage!, g = this.salvageGroup(w, me), cur = g ? sv.groups.find(x => x.group === g.id) : undefined;
    const site = (id?: string) => id ? (w.wrecks?.[id]?.name ?? id) : '';
    const cls: Record<string, string> = { hauler_mk1: 'hauler', hauler: 'hauler', miner_mk1: 'miner', miner: 'miner', constructor_s: 'constructor', constructor: 'constructor' };
    const roles = cur ? `<ul class="small fbroles">${[...new Set(cur.ships)].map(c => `<li>${esc(c === 'hauler' ? '수송선' : c === 'miner' ? '채굴선' : c === 'constructor' ? '공작선' : c)} — ${esc(SALVAGE_ROLES[cls[c] ?? c] ?? '')}</li>`).join('')}</ul>` : '';
    const now = cur && (cur.op === 'recover' || cur.op === 'salvzone') ? `<div class="fbcur">현재: <b>${esc(cur.op === 'recover' ? site(cur.target) : '구역 인양')}</b> · <span class="dim">${esc(cur.status ?? '')}</span></div>` : cur ? `<div class="fbcur dim">인양반 대기 중 (${esc(cur.status ?? cur.op)})</div>` : '';
    const got = sv.units > 0 ? `<div class="small">회수 누계 ${fmt(sv.units)}단위 (기준가 ${fmt(sv.value)} cr): ${Object.entries(sv.items).filter(([, n]) => n >= 1).map(([k, n]) => `${esc(k.startsWith('bpf:') ? '설계도 조각' : itemName(k))} ${fmt(n)}`).join(', ')}${Object.keys(sv.aboard).length ? ` · <b>적재 중(하역 전)</b> ${Object.entries(sv.aboard).map(([k, n]) => `${esc(itemName(k))} ${fmt(n)}`).join(', ')}` : ''}</div>` : '';
    const sold = Object.entries(s.pnl.sales).filter(([, v]) => v >= 1);
    const sales = sold.length ? `<div class="small">품목별 판매: ${sold.map(([k, v]) => `${esc(itemName(k))} ${fmt(v)} cr`).join(' · ')}</div>` : '';
    const autoOn = SALVAGE_SELL_ITEMS.filter(k => w.companies[me].procurement?.sales?.[k]).length;
    const mine = sv.contracts.length ? `<div class="ptitle"><span>내 인양 계약</span></div><table class="gt">${sv.contracts.map(k => `<tr><td>${esc(k.title)}<div class="dim small">납품처 <a href="#" data-fbst="${k.station}">${stn(k.station)}</a></div></td><td class="n">${fmt(k.progress)}/${fmt(k.amount ?? 0)}</td><td class="n money">${fmt(k.reward)}</td><td class="small">${k.done ? (k.ended ? `<span class="warn">${esc(k.ended)}</span>` : k.progress >= (k.amount ?? 0) ? '<span class="good">완수</span>' : '<span class="warn">만료</span>') : `${Math.round(k.expiresIn / 60)}분 남음`}</td></tr>`).join('')}</table>` : '';
    const board = sv.board.length ? `<div class="ptitle"><span>계약 게시판 (${SALVAGE_JUMPS}점프 안)</span></div><div class="small fbintro">보수는 수주할 때 발주 정거장 예산에서 예약되고, 대상에서 직접 회수한 물품을 그 정거장에 하역하면 지급됩니다. 이미 가진 같은 물품은 인정되지 않고, 납품분은 발주처에 넘어갑니다. 남는 회수품은 회사 몫입니다. 수주는 직접 눌러야 하며 자동으로 하지 않습니다.</div><table class="gt">${sv.board.map(k => `<tr><td>${esc(k.title)}<div class="dim small">${stn(k.station)} · ${k.jumps ? `${k.jumps}점프` : '같은 성계'} · 대상 <span class="${k.risk > 55 ? 'warn' : k.risk > 30 ? 'warnish' : 'good'}">${riskLabel(k.risk)} ${k.risk}</span>${k.target ? ` · ${esc(site(k.target))}` : ''}</div></td><td class="n money">${fmt(k.reward)}</td><td><button class="btn mini" data-fbaccept="${k.id}">수주</button></td></tr>`).join('')}</table>` : '';
    const opts = this.cache!.salvage;
    const kindName = (o: SalvageOption) => o.kind === 'derelict' ? `유기선${o.grade === 'small' ? ' (소형·초보)' : o.grade === 'medium' ? ' (중형)' : o.grade === 'large' ? ' (대형)' : ''}` : o.kind === 'drop' ? '투하 화물' : '전장 잔해';
    const rows = opts.map((o, i) => `<tr data-fbsalv="${i}"><td><b>${esc(o.name)}</b><div class="dim small">${kindName(o)} · ${o.jumps ? `${o.jumps}점프` : '같은 성계'} · 치안 ${o.sec} · <span class="${o.risk > 55 ? 'warn' : o.risk > 30 ? 'warnish' : 'good'}">경로 ${riskLabel(o.risk)} ${o.risk}</span> · ${Math.round(o.expiresIn / 60)}분 뒤 소멸</div>
        <div class="small fbband">${o.recommended ? '<span class="good">추천 — 안전 경로</span>' : o.band === 'safe' ? `<span class="warnish">${o.threat.near ? '안전 경로 · 현장 위협' : '안전 경로 · 최근 전투'}</span>` : o.band === 'caution' ? '<span class="warnish">주의 — 출발 전 확인</span>' : '<span class="warn">위험 — 격침 가능</span>'} · ${o.threat.near ? `<span class="warn" data-fbthreat>현장(${SITE_THREAT_R / 1000}k 안)에 적대 함대 ${o.threat.near}척 확인</span>` : o.threat.system ? `<span class="warnish" data-fbthreat>현장에는 없음 · 같은 성계에 적대 함대 ${o.threat.system}척</span>` : '<span class="dim">현장 주변 적대 함대 미확인</span>'}</div>${o.battle ? `<div class="small" data-fbbattle="${o.battle.recent ? 'recent' : 'old'}">${o.battle.fighting ? '<span class="warn">현장에서 교전 진행 중</span>' : o.battle.recent ? `<span class="warnish">최근 전투 ${Math.max(1, Math.round(o.battle.ago / 60))}분 전</span> <span class="dim">— 전투 세력이 남아 있을 수 있음(위 적대 함대와 별개)</span>` : `<span class="dim">전투 ${Math.round(o.battle.ago / 60)}분 전 — 시간이 지나 위험 표시 해제</span>`}</div>` : ''}
        <div class="small">${o.known ? '확인된 내용' : '보고된 추정'}: ${o.main.map(k => esc(k === 'bpf' ? '설계도 조각' : itemName(k))).join(', ') || '—'}${o.units ? ` · ${fmt(o.units)}단위` : ''}${o.protectedCargo ? ' · <span class="warnish">타사 소유 화물 포함 — 일반 인양은 건너뜀(가져가면 무단 인양)</span>' : o.kind === 'derelict' ? ' · <span class="good">소유자 없음 — 합법 인양</span>' : ''}${o.contract ? `<div class="small">계약: ${esc(o.contract.title)} · ${fmt(o.contract.reward)} cr${o.contract.mine ? ' <span class="good">(수주함)</span>' : o.contract.taken ? ' (다른 회사 수주)' : ''}</div>` : ''}</div></td>
        <td class="n">${o.value ? `${o.known ? '' : '약 '}${fmt(o.value)}` : '—'}</td>
        <td>${cur?.target === o.id ? '<span class="good small">인양 중</span>' : `<button class="btn mini${o.band === 'danger' ? ' warn' : ''}" data-fbrecover="${i}">${o.band === 'danger' ? '위험 — 인양 시작' : '인양 시작'}</button>`}</td></tr>`).join('');
    const list = rows ? `<table class="gt fbtrades"><tr><th>대상</th><th class="n">기준가 cr</th><th></th></tr>${rows}</table>` : `<div class="small dim">${SALVAGE_JUMPS}점프 안에 보이는 인양 대상이 없습니다. 유기선은 지역마다 정해진 수만큼 불규칙하게 나타나고(모든 회사 공유), 전장 잔해는 실제 전투 뒤에 생깁니다 — 잠시 뒤 다시 확인하세요.</div>`;
    const op = this.opHtml(w, salvageOperatingStatus(w, me), stn);
    return `<div class="ptitle"><span>인양반</span><button class="btn mini" data-fblog>물류 현황</button></div>${op}${roles}${now}${got}${sales}
      <div class="small fbintro"><b>인양 시작</b>을 누르면 인양반 전체가 그 대상으로 가서 회수하고, 화물칸이 차면 가까운 정거장(인양 계약이 있으면 그 납품처)에 하역한 뒤 대상이 빌 때까지 반복합니다. 처음에는 <span class="good">추천</span>(경로 위험 30 이하·현장 위협 없음·최근 30분 안에 전투 없음) 대상을 고르세요 — 31~55는 출발 전에 확인하고, 55를 넘으면 격침 경고가 뜹니다. 자동 판매가 켜져 있으면 하역을 마친 수송선이 그 정거장이 사지 않는 회수품을 가까운 시장(3점프 안)에 팔고 돌아오며, 그동안 나머지 함선은 계속 인양합니다. 끝나면 정박 대기로 돌아가 수송선은 공용 물류에 쓰입니다. 금액은 회수 기준가이며 실제 판매가는 시장·예산에 따라 다릅니다. 위험 경로는 함선을 잃을 수 있습니다(호위 없음).</div>
      <label class="small fbauto"><input type="checkbox" data-fbautosell ${autoOn || !w.companies[me].procurement?.sales ? 'checked' : ''}> 회수품 자동 판매 — 하역한 고철·부품을 그 정거장 시장에 팔고, 사지 않는 품목은 대기 수송선이 다른 시장으로 운송 (물류 관리 › 재고 정책과 같음 · 장비·설계도 조각 제외)${autoOn ? ` <span class="good">켜짐 ${autoOn}품목</span>` : ''}</label>
      ${list}${mine}${board}`;
  }

  /** A-3.2b.1: what the fleet can still do; when the business is halted, the A-2.1 comeback route (cash, rebuy, recovery) */
  private opHtml(w: WorldState, op: SalvageOpStatus, stn: (id?: string) => string): string {
    void w;
    const cls = op.state === 'ok' ? 'good' : op.state === 'halted' ? 'warn' : 'warnish';
    const can = [op.can.cargo && '화물', op.can.hull && '선체', op.can.equip && '장비·설계도 조각'].filter(Boolean).join('·') || '없음';
    const head = `<div class="small fbop" data-fbop="${op.state}">운영 상태: <b class="${cls}">${SALVAGE_OP_NAME[op.state]}</b> <span class="dim">· 작업선 ${op.workers}척 · 운송 가능 수송선 ${op.haulers}척${op.damagedHaulers ? ` (손상 ${op.damagedHaulers})` : ''} · 회수 가능: ${can}${op.lost ? ` · 누적 손실 ${op.lost}척` : ''}</span>${op.issues.length ? `<ul class="fbissues">${op.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}</div>`;
    const c = op.comeback; if (!c) return head;
    const offers = c.offers.length ? `<table class="gt small">${c.offers.map(o => `<tr><td>${esc(o.name)} <span class="dim">${esc(o.role)}</span></td><td><a href="#" data-fbst="${o.station}">${stn(o.station)}</a> ${o.jumps ? `${o.jumps}점프` : '본거지 성계'}</td><td class="n ${o.affordable ? 'good' : 'warn'}">${fmt(o.price)} cr</td><td><button class="btn mini" data-fbyard="${o.station}|${o.hull}" title="그 정거장 조선소 화면을 엽니다 — 구매는 그 화면에서 직접 확정">조선소 열기</button></td></tr>`).join('')}</table><div class="dim">구매는 열린 조선소 화면에서 직접 확정합니다(가격·재고·잔액은 그 화면 기준).</div>` : '';
    return `${head}<div class="small fbcomeback" data-fbcomeback><b>${op.state === 'halted' ? '사업 재개 방법' : '부족한 능력 보충'}</b> — 현금 ${fmt(c.credits)} cr${c.debt > 1 ? ` · 미납 운영비 ${fmt(c.debt)} cr` : ''}${c.stage ? ` · 체납 ${c.stage}단계` : ''}${c.stockValue ? ` · 자동 판매 재고 약 ${fmt(c.stockValue)} cr` : ''}<ul>${c.steps.map(t => `<li>${esc(t)}</li>`).join('')}</ul>${offers}<div class="dim">달성한 이정표는 그대로 남습니다.</div></div>`;
  }

  private salvageGroup(w: WorldState, me: string) {
    const gs = Object.values(w.groups).filter(g => g.owner === me && Object.values(w.ships).some(s => s.owner === me && s.groupId === g.id));
    return gs.find(g => g.op.k === 'recover' || g.op.k === 'salvzone') ?? gs.find(g => Object.values(w.ships).some(s => s.owner === me && s.groupId === g.id && s.classId.startsWith('constructor'))) ?? gs[0];
  }

  private async autoSell(on: boolean) {
    const w = full(this.w()), cur = w.companies[this.me()].procurement?.sales ?? {};
    for (const item of SALVAGE_SELL_ITEMS) if (!!cur[item] !== on) await this.host.cmd({ c: 'salesPolicy', settings: { item, sell: on, ...(on ? { minPrice: 0 } : {}) } });
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
    e.querySelectorAll<HTMLButtonElement>('[data-fbyard]').forEach(b => b.onclick = () => { const [st, hull] = b.dataset.fbyard!.split('|'); this.host.openYard(st, hull); });
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
    e.querySelectorAll<HTMLButtonElement>('[data-fbrecover]').forEach(b => b.onclick = async () => {
      const o = this.cache?.salvage[Number(b.dataset.fbrecover)], g = this.salvageGroup(w, me); if (!o || !g) return;
      const ask = salvageConfirm(o); if (ask && !confirm(ask)) return;   // A-3.2b.1: the player decides; the target is never swapped
      b.disabled = true;
      const sell = e.querySelector<HTMLInputElement>('[data-fbautosell]');
      if (sell?.checked) await this.autoSell(true);
      if (await this.host.cmd({ c: 'setOp', group: g.id, op: { k: 'recover', wreck: o.id } })) this.host.toast(`인양반 출발: ${o.name}`, 'good');
      this.cache = null; this.render(true);
    });
    e.querySelectorAll<HTMLButtonElement>('[data-fbaccept]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      await this.host.cmd({ c: 'accept', contract: b.dataset.fbaccept! });
      this.cache = null; this.render(true);
    });
    const autoSell = e.querySelector<HTMLInputElement>('[data-fbautosell]');
    if (autoSell) autoSell.onchange = async () => { autoSell.disabled = true; await this.autoSell(autoSell.checked); autoSell.disabled = false; this.render(true); };
    e.querySelectorAll<HTMLButtonElement>('[data-fbmine]').forEach(b => b.onclick = async () => {
      const [field, deliver] = b.dataset.fbmine!.split('|'); const g = this.minerGroup(w, me); if (!g) return;
      b.disabled = true;
      await this.host.cmd({ c: 'setOp', group: g.id, op: { k: 'mine', field, deliver, sell: true } });
      this.cache = null; this.render(true);
    });
  }
}
