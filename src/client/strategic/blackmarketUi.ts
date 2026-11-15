// P13.3 black market inside the station's existing trade tab (no new panel). Shown only where the viewer knows a
// black market (the server replicates a black market only to companies that found it).
import type { Cargo, Station, WorldState, WShip, WGroup } from '../../world/types';
import { qty } from '../../world/types';
import { BM_TIERS, RESTRICTED_ITEMS, bmAt, bmAsk, bmBid, bmQuote, bmRefusal, contraband, inspectChance, isHot, parseHot, restrictedAt, type BlackMarket, type BmLog } from '../../world/blackmarket';
import { econOf } from '../../world/hullops';
import { sysAt } from '../../world/geom';
import { itemName } from '../../world/industry';

/** the client's world view (no server-only rng / events) */
type View = Pick<WorldState, 'blackMarketV' | 'blackMarkets' | 'companies' | 'stations' | 'ships' | 'systems'>;
const W = (v: View) => v as unknown as WorldState;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
const pct = (p: number) => `${Math.round(p * 100)}%`;

/** a black market the viewer knows at this station */
export function knownBmAt(v: View, s: Station, me: string): BlackMarket | undefined {
  const w = W(v); if (!w.blackMarketV) return undefined;
  const b = bmAt(w, s.id);
  return b && w.companies[me]?.bm?.known.includes(b.id) ? b : undefined;
}

/** what a key is, legally */
function legality(w: WorldState, key: string, s: Station): string {
  const h = parseHot(key);
  if (h) return `<span class="bad">장물</span> <span class="dim small">원소유 ${esc(w.companies[h.owner]?.name ?? h.owner)}</span>`;
  if (restrictedAt(w, s).includes(key)) return '<span class="warn">지역 제한</span>';
  if ((RESTRICTED_ITEMS as readonly string[]).includes(key)) return '<span class="dim">제한 물품 (이 지역 허용)</span>';
  return '정상';
}

/** note on the normal market: stolen / restricted goods the viewer holds here cannot be sold there */
export function contrabandNote(v: View, s: Station, me: string): string {
  const w = W(v); if (!w.blackMarketV) return '';
  const store: Cargo = s.storage[me] ?? {};
  const hot = Object.keys(store).filter(k => isHot(k) && store[k] >= 1);
  const banned = restrictedAt(w, s);
  if (!hot.length && !banned.length) return '';
  return `<div class="bdr small" data-bm-note>${hot.length ? `<b>장물 보관 중</b>: ${hot.map(k => `${esc(itemName(k))} ${fmt(store[k])}`).join(', ')} — 일반 시장·거래소·생산·물류에 쓸 수 없습니다. 아는 암시장에서만 처분할 수 있고, 치안 구역 입항·관문에서 검문에 걸리면 압수됩니다.` : ''}
    ${banned.length ? `<div>이 정거장 반입 금지(지역 제한): ${banned.map(k => esc(itemName(k))).join(', ')} — 화물칸에 싣고 입항하면 검문 대상입니다.</div>` : ''}</div>`;
}

/** the black-market view of the trade tab */
export function blackMarketHtml(v: View, s: Station, me: string, groups: WGroup[]): string {
  const w = W(v); const b = knownBmAt(w, s, me); if (!b) return '';
  const def = BM_TIERS[b.tier], co = w.companies[me];
  const store: Cargo = s.storage[me] ?? {};
  const docked = Object.values(w.ships).filter(x => x.owner === me && x.task.k === 'docked' && (x.task as { station?: string }).station === s.id);
  const sys = sysAt(w.systems, s.pos);
  const banned = restrictedAt(w, s);
  // rows: what the viewer has here (storage, then each docked hold) that this market buys
  const rows: { key: string; n: number; ship?: WShip }[] = [];
  for (const k of Object.keys(store).sort()) if (store[k] >= 1 && !bmRefusal(w, b, k)) rows.push({ key: k, n: Math.floor(store[k]) });
  for (const x of docked) for (const k of Object.keys(x.cargo).sort()) if (x.cargo[k] >= 1 && !bmRefusal(w, b, k)) rows.push({ key: k, n: Math.floor(x.cargo[k]), ship: x });
  const risk = (c: Cargo) => sys ? inspectChance(w, me, sys, 'dock', c, s) : 0;
  const aboard: Cargo = {}; for (const x of docked) Object.assign(aboard, contraband(w, x, banned));
  const sell = rows.map(r => {
    const q = bmQuote(w, b, r.key, r.n), unit = bmBid(w, b, r.key) * (1 - def.fee), lot = Math.min(r.n, 10);
    const why = q.sold <= 0 ? '매입 자금 부족' : q.sold < r.n ? `자금 한도 ${fmt(q.sold)}` : '';
    return `<tr><td><b>${esc(itemName(r.key))}</b><div class="small">${legality(w, r.key, s)}</div></td><td>${r.ship ? `${esc(r.ship.name)} 화물칸` : '보관함'}</td><td class="n">${fmt(r.n)}</td><td class="n">${fmt(unit)}</td><td class="n">${fmt(q.net)}${why ? `<div class="dim small">${why}</div>` : ''}</td>
      <td><button class="btn mini" data-bmsell="${esc(r.key)}|${lot}|${r.ship?.id ?? ''}" ${q.sold <= 0 ? 'disabled' : ''}>${lot} 처분</button><button class="btn mini" data-bmsell="${esc(r.key)}|${r.n}|${r.ship?.id ?? ''}" ${q.sold <= 0 ? 'disabled' : ''}>전량</button></td></tr>`;
  }).join('');
  const stock = Object.entries(b.stock).map(([k, x]) => `<tr><td><b>${esc(itemName(k))}</b><div class="small">${legality(w, k, s)}</div></td><td class="n">${fmt(Math.floor(x.n))}</td><td class="n">${fmt(bmAsk(w, b, k))}</td>
    <td><button class="btn mini" data-bmbuy="${k}|1" ${x.n < 1 || co.credits < bmAsk(w, b, k) ? 'disabled' : ''}>1 구매</button><button class="btn mini" data-bmbuy="${k}|${Math.max(1, Math.floor(x.n))}" ${x.n < 1 ? 'disabled' : ''}>전량</button></td></tr>`).join('');
  // smuggling run: from a station where the viewer stores stolen / restricted goods, with a fleet that has a hold
  const sources = Object.values(w.stations).filter(st => st.id !== s.id && Object.keys(st.storage[me] ?? {}).some(k => (isHot(k) || (RESTRICTED_ITEMS as readonly string[]).includes(k)) && qty(st.storage[me], k) >= 1));
  const haulers = groups.filter(g => g.shipIds.some(id => { const x = w.ships[id]; return !!x && econOf(x).cargo > 0; }));
  const log = (co.bm?.log ?? []).slice(-8).reverse();
  const L: Record<BmLog['k'], string> = { sell: '처분', buy: '구매', pass: '검문 통과', seize: '압수', return: '반환', found: '발견', held: '세관 보관', claim: '세관 인수' };
  return `<div class="bm" data-bm="${b.id}">
    <div class="bdr small"><b>${esc(def.name)}</b> · 수수료 ${pct(def.fee)} · 매입 자금 <b class="money">${fmt(b.funds)}</b> / ${fmt(b.fundsMax)} cr
      <div class="dim">장물은 시세의 약 ${pct(def.disc)}에 매입하고, 많이 받을수록 값이 내려갑니다. 매입 자금은 이 정거장의 공공 예산에서 넘어오며, 바닥나면 처분이 멈춥니다.</div>
      <div>이곳 입항 검문 적발 확률 <b>${pct(risk(Object.keys(aboard).length ? aboard : { 'hot:alloy:x': 100 }))}</b> <span class="dim">${Object.keys(aboard).length ? '(정박 중인 자사 화물 기준)' : '(장물 100단위 기준)'} — 치안·세력 평판·화물 가치에 따라 달라지며, 같은 30분 안에 다시 입항해도 결과는 바뀌지 않습니다.</span></div></div>
    <h3>장물·제한 물품 처분</h3>
    ${sell ? `<table class="gt"><tr><th>품목</th><th>위치</th><th class="n">수량</th><th class="n">개당 실수령</th><th class="n">전량 처분 시</th><th></th></tr>${sell}</table>` : '<div class="dim small">이 정거장 보관함이나 정박 중인 자사 함선에 처분할 장물·제한 물품이 없습니다. 정상 화물은 일반 시장에서 거래하세요.</div>'}
    ${stock ? `<h3>암시장 재고</h3><table class="gt"><tr><th>품목</th><th class="n">재고</th><th class="n">개당</th><th></th></tr>${stock}</table><div class="dim small">구매품은 이 정거장 보관함으로 들어갑니다. 반입이 금지된 지역 정거장에 실어 가면 입항 검문 대상입니다.</div>` : ''}
    <h3>밀수 운송</h3>
    ${sources.length && haulers.length ? `<div class="yrow small"><select data-smug-g data-keep>${haulers.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
      <select data-smug-from data-keep>${sources.map(st => `<option value="${st.id}">${esc(st.name)}에서 적재</option>`).join('')}</select>
      <label><input type="checkbox" data-smug-sell checked> 도착 후 처분</label><button class="btn go" data-smug>이 암시장으로 출발</button></div>
      <div class="dim small">함대가 출발지 보관함의 장물을 화물칸에 싣고 실제 항로로 이동합니다. 치안 성계의 관문과 공공 정거장 입항 때 검문을 받으며, 적발되면 불법 화물은 모두 압수되고 벌금·평판 하락이 따릅니다.</div>`
      : '<div class="dim small">장물을 보관 중인 다른 정거장과 화물칸이 있는 편대가 있으면 이곳으로 밀수 운송을 지시할 수 있습니다.</div>'}
    ${log.length ? `<h3>최근 암거래·검문 기록</h3><table class="gt small">${log.map(e => `<tr><td>${L[e.k]}</td><td>${esc(w.stations[e.at]?.name ?? w.systems[e.at]?.name ?? e.at)}</td><td>${Object.entries(e.items ?? {}).map(([k, n]) => `${esc(itemName(k))} ${fmt(n)}`).join(', ')}</td><td class="n">${e.value !== undefined ? fmt(e.value) + ' cr' : ''}${e.fine ? ` <span class="dim">(${e.k === 'seize' ? '벌금' : '수수료'} ${fmt(e.fine)})</span>` : ''}</td><td class="dim">${esc(e.why ?? '')}</td></tr>`).join('')}</table>` : ''}
  </div>`;
}

/**
 * P13.3.1 customs return lots of the viewer (stolen goods of its own the authorities seized from someone else).
 * Shown in the station's storage tab: where they wait, and claim buttons when an own ship is docked here.
 */
export function customsHtml(v: View, s: Station, me: string): string {
  const w = W(v); if (!w.blackMarketV) return '';
  const lots = w.companies[me]?.bm?.customs ?? [];
  if (!lots.length) return '';
  const here = lots.filter(l => l.station === s.id), away = lots.filter(l => l.station !== s.id);
  const docked = Object.values(w.ships).filter(x => x.owner === me && x.state === 'docked' && x.task.k === 'docked' && (x.task as { station: string }).station === s.id);
  const pick = docked.length ? `<select data-cu-ship data-keep>${docked.map(x => `<option value="${x.id}">${esc(x.name)} (여유 ${fmt(Math.max(0, econOf(x).cargo - Object.values(x.cargo).reduce((a, n) => a + n, 0)))})</option>`).join('')}</select>` : '';
  const rows = here.map(l => `<tr><td><b>${esc(itemName(l.item))}</b><div class="dim small">${esc(w.companies[l.from]?.name ?? l.from)}에게서 압수</div></td><td class="n">${fmt(l.n)}</td>
    <td>${docked.length ? `<button class="btn mini" data-cuclaim="${l.id}|hold">함선 화물칸으로</button><button class="btn mini" data-cuclaim="${l.id}|store">이 정거장 보관함으로</button>` : '<span class="dim small">자사 함선 정박 필요</span>'}</td></tr>`).join('');
  const far = away.map(l => `<tr><td>${esc(itemName(l.item))}</td><td class="n">${fmt(l.n)}</td><td>${esc(w.stations[l.station]?.name ?? l.station)}</td></tr>`).join('');
  return `<div class="bdr small customs"><h3>세관 반환 대기</h3>
    <div class="dim">당국이 다른 회사에게서 압수한 자사 도난품입니다. 압수된 정거장 세관에 보관되며, 생산·판매·건설에 쓸 수 없습니다. 그 정거장에 자사 함선을 정박시킨 뒤 화물칸 여유나 보관함 공간만큼 인수할 수 있고, 남은 수량은 계속 보관됩니다.</div>
    ${rows ? `${pick}<table class="gt"><tr><th>품목</th><th class="n">수량</th><th></th></tr>${rows}</table>` : ''}
    ${far ? `<div>다른 정거장 세관</div><table class="gt"><tr><th>품목</th><th class="n">수량</th><th>보관 정거장</th></tr>${far}</table>` : ''}
  </div>`;
}
