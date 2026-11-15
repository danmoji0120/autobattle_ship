// Station industry panels (HTML builders). Pure functions of the replicated world state plus a
// small UI-state object, so live updates re-render without losing filters / picks.

import type { Station, Cargo } from '../../world/types';
import type { WorldView as WorldState } from '../../server/protocol';
import { qty, cargoKeys, cargoSum } from '../../world/types';
import { ITEMS, ITEM_CAT_NAME, RECIPES, FACILITIES, FAC_CATS, TECHS, EQUIPMENT, facilityTech, techUnlocks, itemName, itemCat, recipeFor, type ItemCat, type RecipeDef } from '../../world/industry';
import { REGIONAL_ORIGINS } from '../../world/regional';
import { RES_COLOR } from '../../world/data';
import { stationPower, storageCap, facLines, facilityLoad, prodSpeed, recipeOk, stationNeeds, builtCount, yardSlots, buildNeeds, buildSpec, fitUnits, buildSpeed, YARD_NAME, hullName } from '../../world/production';
import { HULLS } from '../../world/industry';
import { SHIP_CLASSES, getLoadout } from '../../sim/data/ships';
import { ECON } from '../../world/data';
import { FIELD_NAME, techFx, type Field } from '../../world/industry';
import { growthOn } from '../../world/hullops';
import { WEAPONS } from '../../sim/data/weapons';
import { weaponRole } from '../../content/registry';
import { labSlots, projectCost, projectCredits, projectTime, salvageItem, missingPre, COPY_COST } from '../../world/research';
import { storeUsed, reservedSpace, listedSpace, logisticsReservedSpace } from '../../world/storage';
import { procurementSourceHtml } from './procurementUi';
import { materialReferenceCost, regionalReferenceValue, valueOf } from '../../world/valuation';

export interface IndUi { invCat: string; invQ: string; recFac: string; recQ: string; recSel: string | null; mkCat: string; mkQ: string; hull: string | null; fit: string[]; rField: string; tSel: string | null }
export const newIndUi = (): IndUi => ({ invCat: 'all', invQ: '', recFac: 'all', recQ: '', recSel: null, mkCat: 'all', mkQ: '', hull: null, fit: [], rField: 'all', tSel: null });

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => (Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString();
const stockFmt = (n: number) => n > 0 && n < .001 ? '&lt;0.001' : n.toLocaleString(undefined, { maximumFractionDigits: 3 });
const dur = (t: number) => t >= 3600 ? `${Math.floor(t / 3600)}시간 ${Math.round(t % 3600 / 60)}분` : t >= 60 ? `${Math.floor(t / 60)}분 ${Math.round(t % 60)}초` : `${Math.ceil(t)}초`;
export const iname = (id: string) => `<span style="color:${RES_COLOR[id]}">${esc(itemName(id))}</span>`;
const CATS: ItemCat[] = ['raw', 'refined', 'part', 'shippart', 'equip', 'blueprint'];
const match = (id: string, q: string) => !q || itemName(id).toLowerCase().includes(q.toLowerCase()) || id.includes(q.toLowerCase());

function chips(name: string, cur: string, opts: [string, string][]) {
  return `<div class="chips">${opts.map(([v, l]) => `<button class="chip${cur === v ? ' on' : ''}" data-${name}="${v}">${l}</button>`).join('')}</div>`;
}

/** items as "a 3 · b 4" */
export const itemList = (c: Record<string, number>, mul = 1) => Object.entries(c).map(([k, n]) => `${iname(k)} ${fmt(n * mul)}`).join(' · ');

// ───────────────────────────────────────────────────────── storage

export function storeHtml(w: WorldState, s: Station, me: string, ui: IndUi): string {
  const store: Cargo = s.storage[me] ?? {};
  const own = s.owner === me;
  const cap = own ? storageCap(s) : 0;
  const used = growthOn(w as any) && own ? storeUsed(store) : cargoSum(store);
  const overflow = cap ? Math.max(0, used - cap) : 0;
  const poolHeld = logisticsReservedSpace(w, s.id, me);
  const held = own && growthOn(w as any) ? reservedSpace(s) + listedSpace(s, me) + poolHeld : poolHeld;
  const ids = cargoKeys(store);
  const reserved: Record<string, number> = {};
  for (const m of s.modules) for (const [k, n] of Object.entries(m.reserved ?? {})) if (n > 0.01) reserved[k] = (reserved[k] ?? 0) + n;
  const inJobs: Record<string, number> = {};
  for (const j of own ? s.jobs ?? [] : []) for (const [k, n] of Object.entries(j.out ?? RECIPES[j.recipe]?.out ?? {})) inJobs[k] = (inJobs[k] ?? 0) + n;
  const needs = own ? stationNeeds(s, w) : {};
  const shown = ids.filter(k => (ui.invCat === 'all' || itemCat(k) === ui.invCat) && match(k, ui.invQ)).sort((a, b) => CATS.indexOf(itemCat(a)) - CATS.indexOf(itemCat(b)) || (ITEMS[a]?.tier ?? 9) - (ITEMS[b]?.tier ?? 9) || a.localeCompare(b));
  // logistics: own haul operations touching this station
  const hauls = Object.values(w.groups).filter(g => g.owner === me && g.op.k === 'haul' && ((g.op as any).to === s.id || (g.op as any).from === s.id));
  const label = (r: string) => r === '*auto' ? '자동 보급' : r === '*all' ? '전 품목' : itemName(r);
  let html = `<div class="bstore"><div><b>${own ? '정거장 창고' : '자사 보관함'}</b> · ${ids.length}종 · 총 ${stockFmt(used)}${cap ? ` / 용량 ${fmt(cap)} <span class="${used > cap * 0.9 ? 'warn' : 'dim'}">(${Math.round(used / cap * 100)}%)</span>` : own ? ' <span class="warn">도킹 허브 완공 전 — 창고 없음</span>' : (growthOn(w as any) ? '' : ' <span class="dim">(공용 정거장: 용량 제한 없음)</span>')}</div>
    ${cap ? `<div class="bar"><i style="width:${Math.min(100, used / cap * 100)}%;${used > cap * 0.9 ? 'background:var(--warn)' : ''}"></i></div>` : ''}
    ${overflow > 0 ? `<div class="warn" role="status">초과 보관 ${fmt(overflow)} — 신규 입고 불가 · 자재 이동·소비 또는 창고 증설</div>` : held > 0 && used + held >= cap ? '<div class="warnish small">건설 예약·매물의 반환 공간 확보 중 — 일반 입고 대기</div>' : ''}
    ${Object.keys(reserved).length ? `<div class="dim small">건설 예약(창고에서 빠짐): ${itemList(reserved)}</div>` : ''}
    ${poolHeld ? `<div class="dim small">공용 물류 예약 ${fmt(poolHeld)} · 출발지에 보관 중이며 취소 시 자유 재고로 반환</div>` : ''}
    ${Object.keys(inJobs).length ? `<div class="dim small">생산 중 (완료 시 입고): ${itemList(inJobs)}</div>` : ''}
    ${Object.keys(needs).length ? `<div class="small"><span class="warn">생산 원료 부족</span>: ${itemList(needs)}</div>` : ''}
    </div>`;
  html += `<div class="frow">${chips('icat', ui.invCat, [['all', '전체'], ...CATS.map(c => [c, ITEM_CAT_NAME[c]] as [string, string])])}<input class="search" data-iq placeholder="품목 검색" value="${esc(ui.invQ)}"></div>`;
  html += shown.length ? `<table class="gt inv"><tr><th>품목</th><th>분류</th><th class="n">수량</th><th class="n">참고 가치</th><th class="n">가치</th></tr>${shown.map(k => {
    const p = regionalReferenceValue(w, k) ?? ITEMS[k]?.price ?? 0;
    return `<tr><td>${iname(k)}</td><td class="dim">${ITEM_CAT_NAME[itemCat(k)]}</td><td class="n"><b>${stockFmt(qty(store, k))}</b></td><td class="n dim">${p ? fmt(p) : '—'}</td><td class="n dim">${p ? fmt(p * qty(store, k)) : '—'}</td></tr>`;
  }).join('')}</table>` : `<div class="dim small" style="padding:8px">${ids.length ? '조건에 맞는 품목이 없습니다.' : '보관 중인 품목이 없습니다.'}</div>`;
  html += `<h3>물류</h3>${hauls.length ? `<table class="gt"><tr><th>편대</th><th>경로</th><th>품목</th><th>상태</th></tr>${hauls.map(g => {
    const op = g.op as { from: string; to: string; res: string };
    return `<tr><td><b>${esc(g.name)}</b></td><td>${esc(w.stations[op.from]?.name ?? '?')} → ${esc(w.stations[op.to]?.name ?? '?')}</td><td>${esc(label(op.res))}</td><td class="dim small">${esc(g.status)}</td></tr>`;
  }).join('')}</table>` : '<div class="dim small">이 정거장을 오가는 자사 운송 편대가 없습니다.</div>'}
  <div class="dim small">수송선 편대 → 운송 명령: 특정 품목, <b>전 품목</b>, 또는 <b>자동 보급</b>(도착지의 생산·건설에 부족한 원료만 골라 실음 — 물류센터 필요)을 고를 수 있습니다.</div>`;
  return html;
}

// ───────────────────────────────────────────────────────── production

export function prodHtml(w: WorldState, s: Station, me: string, ui: IndUi): string {
  const co = w.companies[me];
  const store: Cargo = s.storage[me] ?? {};
  const pw = stationPower(s);
  const speed = prodSpeed(s, co);
  const load = facilityLoad(s);
  const orders = s.orders ?? [];
  const jobs = s.jobs ?? [];
  let html = `<div class="bstore"><div><b>전력</b> 공급 ${fmt(pw.supply)} / 수요 ${fmt(pw.demand)} ${pw.factor < 1 ? `<span class="warn">전력 부족 — 모든 생산·연구 속도 ${Math.round(pw.factor * 100)}% (발전소 증설 필요)</span>` : '<span class="good">충분</span>'}</div>
    <div class="dim small">생산 속도 ×${speed.toFixed(2)} (전력 ${Math.round(pw.factor * 100)}%${(co?.tech ?? []).length ? ' · 연구 보너스 포함' : ''}${builtCount(s, 'habitat') ? ' · 지원시설 +10%' : ''})</div></div>`;
  // facilities: lines, load, bottleneck
  const facs = Object.entries(load);
  html += `<h3>생산 시설 가동 현황</h3>${facs.length ? `<table class="gt"><tr><th>시설</th><th class="n">라인</th><th class="n">가동</th><th class="n">대기 주문</th><th>상태</th></tr>${facs.map(([k, l]) => {
    const st = l.busy >= l.lines && l.waiting ? '<span class="warn">병목 — 라인 부족 (시설 증설 시 처리량 증가)</span>' : l.busy ? '<span class="good">가동 중</span>' : l.waiting ? '<span class="warn">원료 대기</span>' : '<span class="dim">유휴</span>';
    return `<tr><td><b>${esc(FACILITIES[k]?.name ?? k)}</b> <span class="dim">×${builtCount(s, k)}</span></td><td class="n">${l.lines}</td><td class="n">${l.busy}</td><td class="n">${l.waiting}</td><td class="small">${st}</td></tr>`;
  }).join('')}</table>` : '<div class="dim small">생산 시설이 없습니다. 건설 탭에서 정제소·공장을 지으세요.</div>'}`;
  // order queue
  html += `<h3>생산 주문 (${orders.length})</h3>${orders.length ? `<div class="bq">${orders.map((o, i) => {
    const r = recipeFor(w, o.recipe) ?? RECIPES[o.recipe];
    const running = jobs.filter(j => j.order === o.id);
    const prog = running.length ? Math.max(...running.map(j => 1 - j.left / j.total)) : 0;
    const ok = o.why === '가동 중' || o.why?.startsWith('가동 중');
    const target = o.mode === 'count' ? `${o.done}/${o.n} 배치` : `재고 유지 ${fmt(o.n)} (현재 ${fmt(qty(store, Object.keys(r.out)[0]))})`;
    return `<div class="bqrow${o.paused ? ' ps-paused' : ok ? ' ps-building' : ' ps-materials'}"><span class="bqn">${i + 1}</span>
      <div class="bqm"><div><b>${esc(r.name)}</b> <span class="dim">· ${esc(FACILITIES[r.fac]?.name ?? '')}</span> <span class="pst">${esc(o.why ?? '대기')}</span></div>
      <div class="bar"><i style="width:${Math.round(prog * 100)}%"></i></div>
      <div class="small">${itemList(r.in)} → ${itemList(r.out)} · ${target}${running.length > 1 ? ` · 라인 ${running.length}개 가동` : ''}</div>${procurementSourceHtml(w, me, s.id, 'production', o.id)}</div>
      <div class="bqa"><button class="btn mini" data-oop="up:${o.id}" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn mini" data-oop="down:${o.id}" ${i === orders.length - 1 ? 'disabled' : ''}>▼</button>
      ${o.paused ? `<button class="btn mini" data-oop="resume:${o.id}">▶</button>` : `<button class="btn mini" data-oop="pause:${o.id}">⏸</button>`}<button class="btn mini warnb" data-oop="cancel:${o.id}">✕</button></div></div>`;
  }).join('')}</div>` : '<div class="dim small">주문이 없습니다. 아래 레시피에서 생산 주문을 등록하세요.</div>'}`;
  // recipe catalog
  const allRec = Object.keys(RECIPES).map(id => recipeFor(w, id)).filter((r): r is RecipeDef => !!r && (!r.growth || growthOn(w as any)));
  const facKinds = [...new Set(allRec.map(r => r.fac))];
  const recs = allRec.filter(r => (ui.recFac === 'all' || ui.recFac === r.fac) && (!ui.recQ || r.name.includes(ui.recQ) || Object.keys(r.out).some(k => match(k, ui.recQ)) || Object.keys(r.in).some(k => match(k, ui.recQ))));
  html += `<h3>레시피</h3><div class="frow">${chips('rfac', ui.recFac, [['all', '전체'], ...facKinds.map(k => [k, FACILITIES[k].name] as [string, string])])}<input class="search" data-rq placeholder="레시피·품목 검색" value="${esc(ui.recQ)}"></div>
    <div class="bcols"><div class="rlist">${recs.map(r => {
      const have = builtCount(s, r.fac) > 0, known = recipeOk(r, co);
      return `<div class="bfac pick${ui.recSel === r.id ? ' sel' : ''}${have && known ? '' : ' locked'}" data-rsel="${r.id}"><b>${esc(r.name)}</b> <span class="dim small">${esc(FACILITIES[r.fac].name)}</span><div class="small">${itemList(r.out)}${known ? '' : ' · <span class="warn">연구 필요</span>'}${have ? '' : ' · <span class="dim">시설 없음</span>'}</div></div>`;
    }).join('') || '<div class="dim small">결과 없음</div>'}</div><div class="bdet">${recipeDetail(s, me, w, ui.recSel ? recipeFor(w, ui.recSel) : undefined, speed)}</div></div>`;
  return html;
}

function recipeDetail(s: Station, me: string, w: WorldState, r: RecipeDef | undefined, speed: number): string {
  if (!r) return '<div class="dim" style="padding:12px">레시피를 선택하면 재료·시간·생산 주문 등록이 표시됩니다.</div>';
  const co = w.companies[me];
  const store: Cargo = s.storage[me] ?? {};
  const lines = facLines(s, r.fac);
  const known = recipeOk(r, co);
  const rows = Object.entries(r.in).map(([k, n]) => `<tr><td>${iname(k)}${REGIONAL_ORIGINS[k] ? `<div class="dim small">지역 소재 · ${esc(REGIONAL_ORIGINS[k])}</div>` : ''}</td><td class="n">${fmt(n)}</td><td class="n">${fmt(qty(store, k))}</td><td class="n">${qty(store, k) >= n ? '<span class="good">충분</span>' : `<span class="warn">${fmt(n - qty(store, k))} 부족</span>`}</td></tr>`).join('');
  const batches = Math.floor(Math.min(...Object.entries(r.in).map(([k, n]) => qty(store, k) / n)));
  const perH = lines ? 3600 / (r.time / speed) * lines : 0;
  const why = !known ? `연구 필요: ${esc(TECHS[r.tech!]?.name ?? r.tech!)}` : !lines ? `${esc(FACILITIES[r.fac].name)}이(가) 이 정거장에 없습니다 (건설 탭)` : '';
  const regional = Object.keys(r.out).some(id => regionalReferenceValue(w, id) !== undefined);
  return `<div class="bdh"><b>${esc(r.name)}</b> <span class="dim">· ${esc(FACILITIES[r.fac].name)}</span></div>
    <table class="gt bmat"><tr><th>투입</th><th class="n">배치당</th><th class="n">창고</th><th class="n">상태</th></tr>${rows}</table>
    ${Object.keys(r.in).some(k => REGIONAL_ORIGINS[k]) ? '<div class="dim small">지역 소재는 표시된 산지에서 채굴·가공하거나 플레이어 거래소에서 구할 수 있습니다.</div>' : ''}
    <div class="bdr">산출: <b>${itemList(r.out)}</b></div>
    ${regional ? `<div class="bdr small">예상 재료 원가 (배치당): <b>${fmt(materialReferenceCost(w, r.in))} cr</b> · 기존 참고 가치 (산출물): ${fmt(Object.entries(r.out).reduce((n, [id, amount]) => n + valueOf(id) * amount, 0))} cr · 지역 소재 반영 참고 가치: ${fmt(Object.entries(r.out).reduce((n, [id, amount]) => n + (regionalReferenceValue(w, id) ?? valueOf(id)) * amount, 0))} cr</div><div class="dim small">재료별 참고 가치로 계산한 추정치이며 실제 지불액·실제 거래 가능 가격이 아닙니다. 생산 시간과 시설 운영비는 재료 원가에 포함되지 않습니다.</div>` : ''}
    <div class="bdr">배치 시간 ${dur(r.time)}${speed !== 1 ? ` (현재 속도로 ${dur(r.time / speed)})` : ''} · 라인 ${lines}개${perH ? ` · 최대 시간당 ${itemList(r.out, perH)}` : ''}</div>
    <div class="bdr dim small">지금 창고 재료로 ${batches}배치 가능</div>
    ${why ? `<div class="warn">${why}</div>` : ''}
    <div class="yrow"><select data-pmode data-keep><option value="count">배치 수만큼 생산</option><option value="stock">재고 목표 유지</option></select><input class="num" data-pn type="number" min="1" value="10"><button class="btn go" data-porder="${r.id}" ${why ? 'disabled' : ''}>생산 주문</button></div>
    <div class="dim small">재료가 모두 창고에 있어야 배치가 시작되고, 시작할 때 재료가 차감됩니다. 재고 목표: 산출물이 목표 수량 아래로 떨어지면 자동으로 다시 생산합니다.</div>`;
}

// ───────────────────────────────────────────────────────── market

export function marketHtml(w: WorldState, s: Station, me: string, ui: IndUi, price: (r: string, side: 'sell' | 'buy') => number): string {
  const store: Cargo = s.storage[me] ?? {};
  return (s.market ? npcMarketHtml(s, store, ui, price) : '') + exchangeHtml(w, s, me, store, ui);
}

/** PMC-to-PMC listings at this station (escrow) */
function exchangeHtml(w: WorldState, s: Station, me: string, store: Cargo, ui: IndUi): string {
  const ls = (s.listings ?? []).filter(l => (ui.mkCat === 'all' || itemCat(l.item) === ui.mkCat) && match(l.item, ui.mkQ));
  const mine = cargoKeys(store).filter(k => store[k] >= 1 && !k.startsWith('hot:'));   // stolen goods are never listed
  return `<h3>PMC 거래소</h3>${ls.length ? `<table class="gt"><tr><th>품목</th><th>판매사</th><th class="n">수량</th><th class="n">개당</th><th></th></tr>${ls.map(l => {
    const own = l.seller === me;
    return `<tr><td>${iname(l.item)}</td><td>${esc(w.companies[l.seller]?.name ?? '?')}</td><td class="n">${fmt(l.qty)}</td><td class="n">${fmt(l.price)}</td><td>${own ? `<button class="btn mini" data-delist="${l.id}">회수</button>` : `<button class="btn mini" data-buyl="${l.id}:1">1 구매</button><button class="btn mini" data-buyl="${l.id}:${l.qty}">전량 ${fmt(l.qty * l.price)} cr</button>`}</td></tr>`;
  }).join('')}</table>` : '<div class="dim small">올라온 매물이 없습니다.</div>'}
  ${mine.length ? `<div class="yrow"><select data-lit data-keep>${mine.map(k => `<option value="${k}"${regionalReferenceValue(w, k) !== undefined ? ` data-region-value="${regionalReferenceValue(w, k)}"` : ''}>${esc(itemName(k))} (보유 ${fmt(store[k])})</option>`).join('')}</select><input class="num" data-lq type="number" min="1" value="10" title="수량"><input class="num" data-lp type="number" min="1" value="100" title="개당 가격"><button class="btn go" data-list>매물 등록</button></div><div class="dim small" data-list-reference></div>
  <div class="dim small">등록한 물건은 거래소에 보관(에스크로)되어 다른 PMC가 바로 살 수 있습니다. 판매 대금은 수수료를 뗀 뒤 자동 입금되고, 언제든 회수할 수 있습니다. 설계도·장비·부품도 거래할 수 있습니다.</div>` : ''}`;
}

function npcMarketHtml(s: Station, store: Cargo, ui: IndUi, price: (r: string, side: 'sell' | 'buy') => number): string {
  const ids = Object.keys(s.market ?? {}).filter(k => (ui.mkCat === 'all' || itemCat(k) === ui.mkCat) && match(k, ui.mkQ)).sort((a, b) => CATS.indexOf(itemCat(a)) - CATS.indexOf(itemCat(b)) || (ITEMS[a]?.tier ?? 9) - (ITEMS[b]?.tier ?? 9));
  const cats = CATS.filter(c => Object.keys(s.market ?? {}).some(k => itemCat(k) === c));
  const lot = (k: string) => { const p = price(k, 'buy'); return p > 5000 ? 1 : p > 500 ? 5 : p > 100 ? 20 : 100; };
  return `<div class="frow">${chips('mcat', ui.mkCat, [['all', '전체'], ...cats.map(c => [c, ITEM_CAT_NAME[c]] as [string, string])])}<input class="search" data-mq placeholder="품목 검색" value="${esc(ui.mkQ)}"></div>
    <table class="gt"><tr><th>품목</th><th class="n">시장 재고</th><th class="n">자사 보유</th><th class="n">팔 때</th><th class="n">살 때</th><th></th></tr>
    ${ids.map(r => {
      const m = s.market![r]; const have = qty(store, r); const L = lot(r);
      const trend = m.stock < m.target * 0.6 ? '<span style="color:var(--good)">▲ 품귀</span>' : m.stock > m.target * 1.4 ? '<span style="color:var(--enemy)">▼ 과잉</span>' : '';
      return `<tr><td><b>${iname(r)}</b> <span class="dim small">${ITEM_CAT_NAME[itemCat(r)]}</span></td><td class="n">${fmt(m.stock)} ${trend}</td><td class="n">${fmt(have)}</td><td class="n">${fmt(price(r, 'sell'))}</td><td class="n">${fmt(price(r, 'buy'))}</td>
        <td><button class="btn mini" data-trade="sell:${r}:${L}" ${have < 1 ? 'disabled' : ''}>${L} 판매</button><button class="btn mini" data-trade="sell:${r}:${Math.floor(have)}" ${have < 1 ? 'disabled' : ''}>전량</button><button class="btn mini" data-trade="buy:${r}:${L}" ${m.stock < 1 ? 'disabled' : ''}>${L} 구매</button></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="dim">조건에 맞는 품목이 없습니다.</td></tr>'}</table>
    <div class="dim small">이 지역에서 생산되는 품목은 재고가 회복되고, 소비되는 품목은 줄어듭니다. 성계의 해적 활동이 높으면 공급이 막혀 값이 오릅니다. 구매품은 이 정거장의 자사 보관함에 들어갑니다.</div>`;
}

// ───────────────────────────────────────────────────────── own shipyard

const HULL_ORDER = ['corvette', 'frigate', 'miner', 'hauler', 'destroyer', 'light_cruiser', 'constructor', 'cruiser', 'battlecruiser', 'battleship', 'dreadnought'];

export function yardOwnHtml(w: WorldState, s: Station, me: string, ui: IndUi, groups: { id: string; name: string }[]): string {
  const co = w.companies[me];
  const store: Cargo = s.storage[me] ?? {};
  const slots = yardSlots(s);
  const q = s.builds ?? [];
  const speed = buildSpeed(s, co);
  // slot occupancy, same rule as the server (smallest fitting slot, queue order)
  const used = new Set<number>(); const at = new Map<string, number>();
  for (const b of q) if (b.started) { const i = slots.findIndex((x, j) => !used.has(j) && x.size >= buildSpec(b).yard); if (i >= 0) { used.add(i); at.set(b.id, i); } }
  let html = `<div class="bstore"><div><b>조선소 슬롯</b> ${slots.length ? slots.map((y, i) => {
    const b = q.find(x => at.get(x.id) === i);
    return `<span class="cap${b ? ' on' : ''}">${YARD_NAME[y.size]} ${b ? `— ${esc(hullName(b.classId))} ${Math.round((1 - b.left / b.total) * 100)}%` : '— 비어 있음'}</span>`;
  }).join(' · ') : '<span class="warn">조선소가 없습니다 — 건설 탭에서 소형 조선소를 지으세요</span>'}</div>
    <div class="dim small">건조 속도 ×${speed.toFixed(2)} · 조선소를 여러 개 지으면 동시에 여러 척을 건조합니다. 큰 조선소는 작은 함선도 건조할 수 있습니다.</div></div>`;
  html += `<h3>건조 대기열 (${q.length})</h3>${q.length ? `<div class="bq">${q.map((b, i) => `<div class="bqrow${b.started ? ' ps-building' : b.paused ? ' ps-paused' : ' ps-materials'}"><span class="bqn">${i + 1}</span>
    <div class="bqm"><div><b>${esc(hullName(b.classId))}</b> <span class="dim">· ${esc(getLoadout(b.classId, b.loadoutId).name)}${b.fit.length ? ` · ${b.fit.map(k => esc(EQUIPMENT[k]?.name ?? k)).join(', ')}` : ''}</span> <span class="pst">${esc(b.why ?? '대기')}</span></div>
    <div class="bar"><i style="width:${Math.round((1 - b.left / b.total) * 100)}%"></i></div>
    <div class="small">${b.started ? `남은 시간 ${dur(b.left / Math.max(0.01, speed))}` : `필요: ${itemList(buildNeeds(b.classId, b.loadoutId, b.fit, b))}`}</div>${!b.started ? procurementSourceHtml(w, me, s.id, 'ship', b.id) : ''}</div>
    <div class="bqa"><button class="btn mini" data-bop="up:${b.id}" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn mini" data-bop="down:${b.id}" ${i === q.length - 1 ? 'disabled' : ''}>▼</button>
    ${b.paused ? `<button class="btn mini" data-bop="resume:${b.id}">▶</button>` : `<button class="btn mini" data-bop="pause:${b.id}">⏸</button>`}<button class="btn mini warnb" data-bop="cancel:${b.id}">✕</button></div></div>`).join('')}</div>` : '<div class="dim small">건조 중인 함선이 없습니다.</div>'}`;
  // hull catalog
  html += `<h3>함선 설계</h3><div class="bcols"><div class="rlist">${HULL_ORDER.filter(id => HULLS[id]).map(id => {
    const h = HULLS[id], c = SHIP_CLASSES[id];
    const known = !h.tech || co.tech?.includes(h.tech);
    const yardOk = slots.some(y => y.size >= h.yard);
    return `<div class="bfac pick${ui.hull === id ? ' sel' : ''}${known && yardOk ? '' : ' locked'}" data-hull="${id}"><b>${esc(c.name)} ${esc(c.type)}</b> <span class="dim small">${YARD_NAME[h.yard]} · ${dur(h.time)}</span><div class="small">${known ? '' : '<span class="warn">설계 연구 필요</span> '}${yardOk ? '' : `<span class="dim">${YARD_NAME[h.yard]} 조선소 필요</span>`}</div></div>`;
  }).join('')}</div><div class="bdet">${ui.hull ? hullDetail(w, s, me, ui, groups) : '<div class="dim" style="padding:12px">함급을 선택하면 필요 부품·조선소·시간·무장·피팅을 고를 수 있습니다.</div>'}</div></div>`;
  return html;
}

function hullDetail(w: WorldState, s: Station, me: string, ui: IndUi, groups: { id: string; name: string }[]): string {
  const id = ui.hull!; const h = HULLS[id], c = SHIP_CLASSES[id], e = ECON[id];
  const co = w.companies[me];
  const store: Cargo = s.storage[me] ?? {};
  const lo = getLoadout(id, (ui as any).lo ?? c.loadouts[0].id);
  const fit = ui.fit.filter(k => EQUIPMENT[k]);
  const need = buildNeeds(id, lo.id, fit);
  const rows = Object.entries(need).map(([k, n]) => `<tr><td>${iname(k)}</td><td class="n">${fmt(n)}</td><td class="n">${fmt(qty(store, k))}</td><td class="n">${qty(store, k) >= n ? '<span class="good">충분</span>' : `<span class="warn">${fmt(n - qty(store, k))} 부족</span>`}</td></tr>`).join('');
  const mods = Object.values(EQUIPMENT).filter(x => x.kind === 'module' && !x.exclusive);
  const known = !h.tech || co.tech?.includes(h.tech);
  const yardOk = yardSlots(s).some(y => y.size >= h.yard);
  const why = !known ? `설계 연구 필요: ${esc(TECHS[h.tech!]?.name ?? '')}` : !yardOk ? `${YARD_NAME[h.yard]} 이상 조선소가 필요합니다` : co.credits < h.credits ? `자금 부족 — ${fmt(h.credits - co.credits)} cr` : fitUnits(fit) > h.slots ? '피팅 슬롯 초과' : '';
  return `<div class="bdh"><b>${esc(c.name)} ${esc(c.type)}</b> <span class="dim">· ${esc(c.desc)}</span></div>
    <div class="bdr small">내구 ${fmt(c.hp)} · 장갑 ${c.armor.front}/${c.armor.side}/${c.armor.rear} · 최고속 ${c.maxSpeed} · 선회 ${c.turnRate}°/s · 길이 ${c.length}m · 순항 ${e?.cruise ?? '-'} · 피팅 슬롯 ${h.slots}${e?.cargo ? ` · 화물 ${e.cargo}` : ''}${e?.mine ? ` · 채굴 ${e.mine}/s` : ''}</div>
    <div class="bdr">조선소 <b>${YARD_NAME[h.yard]}</b> 이상 · 건조 ${dur(h.time)} · 공임 <b class="money">${fmt(h.credits)} cr</b> (등록 시)</div>
    <div class="yrow"><select data-hlo data-keep>${c.loadouts.map(l => `<option value="${l.id}"${l.id === lo.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select><select data-hgrp data-keep><option value="">새 편대</option>${groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
    <div class="dim small">${esc(lo.desc)}</div>
    <div class="bdr small">피팅 (${fitUnits(fit)}/${h.slots}): ${mods.map(m => { const on = fit.includes(m.id); return `<button class="chip${on ? ' on' : ''}" data-hfit="${m.id}" title="${esc(m.desc)}">${esc(m.name)} <span class="dim">${m.size}칸 · 보유 ${fmt(qty(store, m.id))}</span></button>`; }).join(' ')}</div>
    <table class="gt bmat"><tr><th>소모 부품·장비</th><th class="n">필요</th><th class="n">창고</th><th class="n">상태</th></tr>${rows}</table>
    ${why ? `<div class="warn">${why}</div>` : ''}<button class="btn go" data-hbuild="${id}" ${why ? 'disabled' : ''}>건조 등록</button>
    <div class="dim small">부품이 부족해도 등록할 수 있습니다. 조선소 슬롯이 비고 모든 부품·장비가 이 정거장 창고에 있으면 자동으로 기공하며, 그때 부품이 차감됩니다.</div>`;
}

/** fitting panel for one docked ship */
export function fitHtml(w: WorldState, ship: { id: string; classId: string; fit?: string[] }, store: Cargo): string {
  const h = HULLS[ship.classId]; const slots = h?.slots ?? 1;
  const cur = ship.fit ?? [];
  const mods = Object.values(EQUIPMENT).filter(x => x.kind === 'module' && (cur.includes(x.id) || qty(store, x.id) >= 1));
  return `<div class="small">피팅 ${fitUnits(cur)}/${slots}: ${cur.map((k, i) => `<button class="chip on" data-unfit="${ship.id}:${i}" title="해제 — 창고로">${esc(EQUIPMENT[k]?.name ?? k)} ✕</button>`).join(' ') || '<span class="dim">없음</span>'}
    ${mods.filter(m => !cur.includes(m.id) || qty(store, m.id) >= 1).map(m => `<button class="chip" data-dofit="${ship.id}:${m.id}" ${fitUnits([...cur, m.id]) > slots || qty(store, m.id) < 1 ? 'disabled' : ''} title="${esc(m.desc)}">+ ${esc(m.name)} (${m.size}칸, ${fmt(qty(store, m.id))})</button>`).join(' ')}</div>`;
}

// ───────────────────────────────────────────────────────── research

const FIELDS = Object.keys(FIELD_NAME) as Field[];

/** state of a tech for a company: known / in queue / available / locked */
function techState(co: any, id: string): ['known' | 'run' | 'queued' | 'ok' | 'locked', string] {
  if (co.tech?.includes(id)) return ['known', '보유'];
  const p = (co.research ?? []).find((r: any) => r.tech === id && r.source !== 'copy');
  if (p) return p.started ? ['run', `연구 중 ${Math.round((1 - p.left / p.total) * 100)}%`] : ['queued', '대기열'];
  const queued = new Set((co.research ?? []).map((r: any) => r.tech));
  const miss = (TECHS[id].pre ?? []).filter(x => !co.tech?.includes(x) && !queued.has(x));
  return miss.length ? ['locked', `선행: ${miss.map(x => TECHS[x].name).join(', ')}`] : ['ok', '연구 가능'];
}

export function researchHtml(w: WorldState, s: Station, me: string, ui: IndUi): string {
  const co = w.companies[me];
  const own = s.owner === me;
  const store: Cargo = s.storage[me] ?? {};
  const slots = own ? labSlots(s) : [];
  const fields = new Set(slots.flatMap(x => x.fields));
  const mul = techFx(co.tech).researchMul * (own ? stationPower(s).factor : 1);
  const q = co.research ?? [];
  // labs
  let html = `<div class="bstore"><div><b>연구 슬롯</b> ${slots.length ? slots.map(x => `<span class="cap">${esc(FACILITIES[x.kind].name)} <span class="dim">(${x.fields.map(f => FIELD_NAME[f]).join('·')})</span></span>`).join(' · ') : `<span class="warn">${own ? '연구소가 없습니다 — 건설 탭의 「연구」 분류에서 기초과학 연구소부터 지으세요' : '자사 정거장에서만 연구할 수 있습니다 (설계도 습득은 어디서나 가능)'}</span>`}</div>
    <div class="dim small">보유 기술 ${co.tech?.length ?? 0}/${Object.keys(TECHS).length} · 연구 속도 ×${mul.toFixed(2)} · 연구소마다 슬롯이 있어 여러 연구를 동시에 진행합니다. 재료는 연구가 시작될 때 이 정거장 창고에서 소모됩니다.</div></div>`;
  // queue (company-wide)
  html += `<h3>연구 대기열 (${q.length})</h3>${q.length ? `<div class="bq">${q.map((r, i) => `<div class="bqrow${r.started ? ' ps-building' : r.paused ? ' ps-paused' : ' ps-materials'}"><span class="bqn">${i + 1}</span>
    <div class="bqm"><div><b>${esc(TECHS[r.tech]?.name ?? r.tech)}</b> <span class="dim">· ${r.source === 'copy' ? '설계도 복제' : r.source === 'salvage' ? '노획품 분석' : FIELD_NAME[TECHS[r.tech]?.field]} · ${esc(w.stations[r.station]?.name ?? '')}</span> <span class="pst">${esc(r.why ?? '대기')}</span></div>
    <div class="bar"><i style="width:${Math.round((1 - r.left / r.total) * 100)}%"></i></div>
    <div class="small">${r.started ? `남은 시간 ${dur(r.left / Math.max(0.01, mul))}` : `필요: ${itemList(projectCost(r))}`}</div></div>
    <div class="bqa"><button class="btn mini" data-rop="up:${r.id}" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn mini" data-rop="down:${r.id}" ${i === q.length - 1 ? 'disabled' : ''}>▼</button>
    ${r.paused ? `<button class="btn mini" data-rop="resume:${r.id}">▶</button>` : `<button class="btn mini" data-rop="pause:${r.id}">⏸</button>`}<button class="btn mini warnb" data-rop="cancel:${r.id}">✕</button></div></div>`).join('')}</div>` : '<div class="dim small">진행 중인 연구가 없습니다.</div>'}`;
  // blueprints in this storage
  const bps = cargoKeys(store).filter(k => k.startsWith('bp:') && qty(store, k) >= 1);
  if (bps.length) html += `<h3>보유 설계도 (이 정거장 창고)</h3><div class="chips">${bps.map(k => { const t = k.slice(3); const kn = co.tech?.includes(t); const miss = missingPre(co as any, t); return `<button class="chip" data-tlearn="${t}" ${kn || miss.length ? 'disabled' : ''} title="${kn ? '이미 보유' : miss.length ? '선행 기술 필요' : '설계도를 소모해 기술 습득'}">${esc(TECHS[t]?.name ?? t)} ×${fmt(qty(store, k))} — ${kn ? '보유' : miss.length ? '선행 필요' : '습득'}</button>`; }).join('')}</div>`;
  // tree — growth worlds: the 13 research areas as depth columns; older worlds: the lab fields
  const g = growthOn(w as any);
  const vis = Object.values(TECHS).filter(t => g || !t.growth);
  if (g) {
    const areas = AREAS.filter(a => vis.some(t => t.area === a));
    const labHave = (a: string) => vis.some(t => t.area === a && fields.has(t.field));
    html += `<h3>기술 트리 <span class="dim small">· 13개 분야 · 분야마다 효과가 다릅니다 (무장 해금 · 시설 · 생산 효율 · 장비 효율 · 운용 · 전술)</span></h3>${chips('rfield', ui.rField, [['all', '전체'], ...areas.map(a => [a, AREA_NAME[a] + (labHave(a) ? '' : ' ·')] as [string, string])])}`;
    const show = areas.filter(a => ui.rField === 'all' || ui.rField === a);
    html += `<div class="bcols"><div class="rlist">${show.map(a => {
      const ts = vis.filter(t => t.area === a);
      const cols: typeof ts[] = [];
      for (const t of ts) (cols[depthIn(t.id, a)] ??= []).push(t);
      return `<div class="rarea"><div class="rah"><b>${AREA_NAME[a]}</b> <span class="dim small">${AREA_NOTE[a] ?? ''}</span>${labHave(a) ? '' : ' <span class="warn small">— 이 정거장에 연구소 없음</span>'}</div><div class="rtree">${cols.filter(Boolean).map(col => `<div class="rcol">${col.sort((x, y) => x.time - y.time).map(t => {
        const [k, label] = techState(co, t.id);
        const tags = techTags(t.id, w).map(x => `<span class="rtag rt-${x[0]}">${x[1]}</span>`).join('');
        return `<div class="rcard tst-${k}${ui.tSel === t.id ? ' sel' : ''}" data-tsel="${t.id}" title="${esc(t.unlocks)}"><b>${esc(t.name)}</b><div class="small dim">${dur(t.time)}${t.needLab ? ` · <span class="${s.modules.some(m => m.built && m.kind === t.needLab) ? 'good' : 'warn'}">${esc(FACILITIES[t.needLab]?.name ?? '')}</span>` : ''}</div><div class="rtags">${tags}</div><div class="small tst-l">${esc(label)}</div></div>`;
      }).join('')}</div>`).join('<div class="rarrow">›</div>')}</div></div>`;
    }).join('')}</div><div class="bdet">${ui.tSel && TECHS[ui.tSel] ? techDetail(w, s, me, ui.tSel, fields, store) : '<div class="dim" style="padding:12px">기술을 선택하면 선행 조건·비용·해금 내용을 볼 수 있습니다.</div>'}</div></div>`;
    return html;
  }
  html += `<h3>기술 트리</h3>${chips('rfield', ui.rField, [['all', '전체'], ...FIELDS.filter(f => vis.some(t => t.field === f)).map(f => [f, FIELD_NAME[f] + (fields.has(f) ? '' : ' ·')] as [string, string])])}`;
  const show = FIELDS.filter(f => (ui.rField === 'all' || ui.rField === f) && vis.some(t => t.field === f));
  html += `<div class="bcols"><div class="rlist">${show.map(f => {
    const ts = vis.filter(t => t.field === f).sort((a, b) => depth(a.id) - depth(b.id) || a.time - b.time);
    return `<div class="dim small" style="margin:6px 0 2px">${FIELD_NAME[f]}${fields.has(f) ? '' : ' <span class="warn">— 이 정거장에 연구소 없음</span>'}</div>` + ts.map(t => {
      const [k, label] = techState(co, t.id);
      return `<div class="bfac pick tst-${k}${ui.tSel === t.id ? ' sel' : ''}${k === 'locked' ? ' locked' : ''}" data-tsel="${t.id}" style="margin-left:${depth(t.id) * 10}px"><b>${esc(t.name)}</b> <span class="dim small">${dur(t.time)}</span><div class="small ${k === 'known' ? 'good' : k === 'locked' ? 'dim' : ''}">${esc(label)}</div></div>`;
    }).join('');
  }).join('')}</div><div class="bdet">${ui.tSel && TECHS[ui.tSel] ? techDetail(w, s, me, ui.tSel, fields, store) : '<div class="dim" style="padding:12px">기술을 선택하면 선행 조건·비용·해금 내용을 볼 수 있습니다.</div>'}</div></div>`;
  return html;
}
const AREAS = ['hull', 'propulsion', 'power', 'kinetic', 'energy', 'missile', 'defense', 'electronics', 'industry', 'resource', 'logistics', 'station', 'tactics'];
export const AREA_NAME: Record<string, string> = { hull: '선체', propulsion: '추진', power: '동력', kinetic: '실탄 무장', energy: '에너지 무장', missile: '유도 무장', defense: '방어', electronics: '전자', industry: '산업', resource: '자원', logistics: '물류', station: '정거장', tactics: '전술' };
const AREA_NOTE: Record<string, string> = {
  hull: '함선 설계 · 건조 속도 · 내구', propulsion: '엔진 시설 · 순항 · 전투 속도', power: '반응로 · 실드 회복', kinetic: '코일·레일·함포 · 탄도 효율', energy: '레이저·플라즈마·입자 · 빔 효율',
  missile: '미사일·어뢰 · 탄약 공장 · 탄두', defense: '장갑 · 실드 용량 · 수리', electronics: '사격통제 · 방공 · 명중', industry: '생산 속도 · 고효율 레시피', resource: '채굴 · 희귀 소재',
  logistics: '적재량 · 보급 소모 · 유지비', station: '연구 속도 · 건설 · 전문 연구소', tactics: '지휘관 성장 · 회피 기동',
};
/** depth of a tech among the techs of its own area (prerequisites from other areas do not indent) */
const depthAreaMemo = new Map<string, number>();
function depthIn(id: string, area: string): number {
  const k = `${area}:${id}`; if (depthAreaMemo.has(k)) return depthAreaMemo.get(k)!;
  const d = Math.min(5, Math.max(0, ...(TECHS[id]?.pre ?? []).filter(p => TECHS[p]?.area === area).map(p => depthIn(p, area) + 1)));
  depthAreaMemo.set(k, d); return d;
}
/** what a tech does, as short tags: weapon / module / facility / recipe / hull / effect */
export function techTags(id: string, world?: { regionalV?: number }): [string, string][] {
  const t = TECHS[id]; const out: [string, string][] = [];
  const eq = Object.values(EQUIPMENT).filter(e => e.tech === id);
  for (const e of eq) out.push([e.kind === 'weapon' ? 'w' : 'm', e.kind === 'weapon' ? '무장' : '장비']);
  if (Object.values(FACILITIES).some(f => f.tech === id)) out.push(['f', '시설']);
  if (Object.keys(RECIPES).some(k => { const r = recipeFor(world, k); return r?.tech === id && !EQUIPMENT[Object.keys(r.out)[0]]; })) out.push(['r', '레시피']);
  if (/함선:/.test(t?.unlocks ?? '')) out.push(['h', '함선']);
  if (t?.fx || t?.cfx) out.push(['x', '효과']);
  if (t?.needLab) out.push(['l', '전문']);
  return out.filter((x, i) => out.findIndex(y => y[0] === x[0]) === i);
}
/** the content a tech unlocks, with the key numbers (weapons: role, size, power) */
function unlockedList(id: string, w: WorldState): string {
  const eq = Object.values(EQUIPMENT).filter(e => e.tech === id);
  const fac = Object.values(FACILITIES).filter(f => facilityTech(f, growthOn(w)) === id);
  const rec = Object.keys(RECIPES).map(k => recipeFor(w, k)).filter((r): r is RecipeDef => !!r && r.tech === id && !EQUIPMENT[Object.keys(r.out)[0]]);
  if (!eq.length && !fac.length && !rec.length) return '';
  const row = (icon: string, name: string, note: string) => `<div class="uline"><span class="uico">${icon}</span><b>${esc(name)}</b> <span class="dim small">${note}</span></div>`;
  return `<div class="bdr ulist">${[
    ...eq.map(e => { const w = e.weapon ? WEAPONS[e.weapon] : undefined; return row(e.kind === 'weapon' ? '⚔' : '⚙', e.name, w ? `${ROLE_NAME[weaponRole(w.id)] ?? ''} · ${['', 'S', 'M', 'L'][e.size]} · 사거리 ${w.range} · 관통 ${w.pen}${w.vsShield !== undefined ? ` · 대실드 ×${w.vsShield}` : ''}` : esc(e.desc)); }),
    ...fac.map(f => row('🏭', f.name, esc(f.unlocks))),
    ...rec.map(r => row('⚗', r.name, `${itemList(r.in)} → ${itemList(r.out)}`)),
  ].join('')}</div>`;
}
export const ROLE_NAME: Record<string, string> = { 'anti-small': '대소형함', general: '범용', 'anti-capital': '대함(대형함)', pd: '방공' };
const depthMemo = new Map<string, number>();
function depth(id: string): number {
  if (depthMemo.has(id)) return depthMemo.get(id)!;
  const d = Math.min(6, Math.max(0, ...(TECHS[id]?.pre ?? []).map(p => depth(p) + 1)));
  depthMemo.set(id, d); return d;
}
function techDetail(w: WorldState, s: Station, me: string, id: string, fields: Set<string>, store: Cargo): string {
  const t = TECHS[id]; const co = w.companies[me];
  const own = s.owner === me;
  const [k, label] = techState(co, id);
  const cost = projectCost({ tech: id, source: 'lab' });
  const rows = Object.entries(cost).map(([r, n]) => `<tr><td>${iname(r)}</td><td class="n">${fmt(n)}</td><td class="n">${fmt(qty(store, r))}</td><td class="n">${qty(store, r) >= n ? '<span class="good">충분</span>' : `<span class="warn">${fmt(n - qty(store, r))} 부족</span>`}</td></tr>`).join('');
  const after = Object.values(TECHS).filter(x => x.pre?.includes(id)).map(x => x.name);
  const why = !own ? '자사 정거장에서만 연구' : !fields.has(t.field) ? `${FIELD_NAME[t.field]} 연구소 필요` : k === 'known' ? '' : k === 'run' || k === 'queued' ? '이미 대기열에 있음' : k === 'locked' ? label : co.credits < t.credits ? `자금 부족 — ${fmt(t.credits - co.credits)} cr` : '';
  const sal = salvageItem(id);
  const canSal = own && fields.has(t.field) && k === 'ok' && sal && qty(store, sal) >= 1;
  const canCopy = own && fields.has(t.field) && k === 'known' && !!t.bp;
  return `<div class="bdh"><b>${esc(t.name)}</b> <span class="dim">· ${FIELD_NAME[t.field]} · ${esc(t.desc)}</span></div>
    <div class="bdr"><b>해금:</b> ${esc(techUnlocks(id, growthOn(w as any)))}</div>${unlockedList(id, w)}
    ${t.needLab ? `<div class="bdr small">전문 연구소: <span class="${s.modules.some(m => m.built && m.kind === t.needLab) ? 'good' : 'warn'}">${esc(FACILITIES[t.needLab]?.name ?? t.needLab)}</span> (이 정거장에 건설되어 있어야 연구 가능)</div>` : ''}
    <div class="bdr small">선행: ${(t.pre ?? []).map(p => `<span class="${co.tech?.includes(p) ? 'good' : 'warn'}">${esc(TECHS[p].name)}</span>`).join(', ') || '없음'}${after.length ? ` · 후속: ${after.map(esc).join(', ')}` : ''}</div>
    <div class="bdr">연구 ${dur(t.time)} (슬롯 1개 기준) · 비용 <b class="money">${fmt(t.credits)} cr</b> (등록 시)${t.bp ? ` · 설계도 시세 ${fmt(t.bp)} cr` : ''}</div>
    <table class="gt bmat"><tr><th>소모 재료 (시작 시)</th><th class="n">필요</th><th class="n">창고</th><th class="n">상태</th></tr>${rows}</table>
    <div class="small ${k === 'known' ? 'good' : ''}">상태: ${esc(label)}</div>
    ${why ? `<div class="warn">${esc(why)}</div>` : ''}${k !== 'known' ? `<button class="btn go" data-tres="${id}" ${why ? 'disabled' : ''}>연구 등록</button>` : ''}
    ${sal ? `<button class="btn" data-tsalv="${id}" ${canSal ? '' : 'disabled'} title="노획한 ${esc(itemName(sal))} 1개를 분해 분석 — 시간 ${dur(projectTime(id, 'salvage'))}, 비용 ${fmt(projectCredits(id, 'salvage'))} cr, 재료 30%">노획품 분석 (${esc(itemName(sal))} 보유 ${fmt(qty(store, sal))})</button>` : ''}
    ${t.bp ? `<button class="btn" data-tcopy="${id}" ${canCopy ? '' : 'disabled'} title="보유 기술을 거래 가능한 설계도로 — ${dur(projectTime(id, 'copy'))}, ${fmt(projectCredits(id, 'copy'))} cr, ${Object.entries(COPY_COST).map(([r, n]) => itemName(r) + ' ' + n).join(', ')}">설계도 복제</button>` : ''}
    <div class="dim small">재료가 부족해도 등록할 수 있습니다 — 슬롯이 비고 재료가 이 정거장 창고에 모이면 자동으로 시작합니다. 선행 연구가 대기열 앞에 있으면 함께 등록할 수 있습니다.</div>`;
}

export { FAC_CATS };
