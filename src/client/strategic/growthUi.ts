import { moneyText } from '../../world/money';
// Growth UI (contentV ≥ 3): public yard stock, own-yard builds by hull, the player ship exchange,
// blueprints and running costs. Pure HTML builders; hud.ts wires the data-* buttons to commands.
import type { Station, Cargo, WShip } from '../../world/types';
import type { WorldView } from '../../server/protocol';
import type { WorldState as FullState } from '../../world/types';
// the client view lacks only rng/events, which none of these helpers read
type WorldState = WorldView;
const full = (w: WorldView) => w as unknown as FullState;
import { cargoKeys, qty } from '../../world/types';
import { CONTENT } from '../../content/registry';
import { SHIP_CLASSES } from '../../sim/data/ships';
import { EQUIPMENT, TECHS, FACILITIES, itemName } from '../../world/industry';
import { MODULES } from '../../world/data';
import { yardSlots, buildNeeds, YARD_NAME } from '../../world/production';
import { hullEcon, hullBuild, hullSale, hullUpkeep, yardHulls, berthOf, berthFits } from '../../world/hullops';
import { holds, hullBlueprint, variantBlueprint, buildTech, offersAt, ownedBlueprints, bpName, SRC_NAME, FRAG_PREFIX, fragmentsNeeded } from '../../world/blueprints';
import { forecast, shipRate, STAGE_NAME, STAGE_AT, REACTIVATE_S, departureHeld } from '../../world/upkeep';
import { iname, itemList } from './industryUi';
import { hullPrice } from '../../world/valuation';
import { serviceOf, publicCap, storeUsed, reservedSpace, listedSpace, leasedAt, LEASE_BLOCK, leaseRate, ownRepairCap, OWN_REPAIR, dockCapacity, SERVICES } from '../../world/storage';
import { sitesIn, knows, surveyLeft, SCAN_NEED } from '../../world/explore';
import { storageCap } from '../../world/production';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
const stockFmt = (n: number) => n > 0 && n < .001 ? '&lt;0.001' : n.toLocaleString(undefined, { maximumFractionDigits: 3 });
const dur = (t: number) => t >= 3600 ? `${Math.floor(t / 3600)}시간 ${Math.round(t % 3600 / 60)}분` : t >= 60 ? `${Math.floor(t / 60)}분` : `${Math.ceil(t)}초`;
const hullTitle = (id: string) => { const h = CONTENT.hulls[id]; return h ? `${h.name} ${SHIP_CLASSES[h.classId]?.type ?? ''}` : id; };
const presetsOf = (hull: string, commonOnly = false) => Object.values(CONTENT.presets).filter(p => p.hull === hull && (!commonOnly || CONTENT.variants[p.variant]?.blueprint === 'common'));
const GRADE: Record<string, string> = { common: '일반', advanced: '고급', faction: '세력', rare: '희귀', unique: '유일' };

/** short stat line of a hull (with what makes it different) */
function hullStats(id: string, variant?: string): string {
  const h = CONTENT.hulls[id]; const c = SHIP_CLASSES[h.classId]; const e = hullEcon(id, variant);
  const st = h.stats ?? {};
  const bits = [`내구 ${fmt(c.hp * (st.hpMul ?? 1))}`, `순항 ${fmt(e.cruise)}`, `전력 ${h.power} · 적재 ${h.mass}`, `하드포인트 ${h.hardpoints.length} · 베이 ${h.internals.length}`];
  if (e.cargo) bits.push(`화물 ${fmt(e.cargo)}`);
  if (e.mine) bits.push(`채굴 ${e.mine}/s${e.minField ? ` (광맥 ${fmt(e.minField)} 미만이면 절반)` : ''}`);
  if (e.build && h.classId === 'constructor') bits.push(`건설 ×${e.build}`);
  bits.push(`정박 ${e.berth}급`);
  const u = hullUpkeep(id, variant);
  bits.push(`운영비 ${fmt(u.credits)} cr/h${u.supplies && Object.keys(u.supplies).length ? ` + ${itemList(u.supplies)}/h` : ''}`);
  return bits.join(' · ');
}

// ───────────────────────────────────────────────────────── public yard (stock)

export function pubYardHtml(w: WorldState, s: Station, me: string, groups: { id: string; name: string }[]): string {
  const co = w.companies[me];
  const hulls = yardHulls(s);
  if (!hulls.length) return '<div class="dim">이 정거장은 함선을 팔지 않습니다.</div>';
  return `<div class="dim small">공영 조선소는 재고만큼만 팝니다. 재고가 줄수록 값이 오르고, 이 지역 시장의 합금·전자부품으로 다음 함선을 건조해 재고를 채웁니다. 표준 구조만 판매하며, 특수 변형은 설계도를 얻어 직접 건조해야 합니다.</div>
  <div class="yard">${hulls.map(id => {
    const h = CONTENT.hulls[id]; const sale = hullSale(id)!;
    const k = s.shipStock?.[id]; const n = k?.n ?? sale.stock;
    const price = Math.round(sale.price * (1.25 - 0.25 * Math.min(1, n / Math.max(1, sale.stock))) / 10) * 10;
    const locked = co.rep < (sale.rep ?? 0);
    const berthOk = berthFits(s, hullEcon(id).berth);
    const ps = presetsOf(id, true);
    const why = locked ? `연합 평판 ${sale.rep} 필요 (현재 ${Math.floor(co.rep)})` : n < 1 ? `재고 없음 — 다음 함선 건조 ${Math.round(100 * (k?.t ?? 0) / sale.restock)}%${k?.why ? ` (${esc(k.why)})` : ''}` : co.credits < price ? `자금 부족 — ${fmt(price - co.credits)} cr 더 필요` : '';
    return `<div class="ycard${locked ? ' locked' : ''}"><div class="yn"><b>${esc(hullTitle(id))}</b> <span class="dim small">${h.size} · ${GRADE[h.blueprint]}</span><span class="money">${fmt(price)} cr</span></div>
      <div class="dim">${esc(h.desc)}</div>
      <div class="ys small">${hullStats(id)}</div>
      ${priceWhy(id)}
      <div class="small">재고 <b>${n}</b>/${sale.stock} · 보충 주기 ${dur(sale.restock)}${berthOk ? '' : ` · <span class="warn">이 정거장 정박 ${berthOf(s)}급</span>`}</div>
      <div class="yrow"><select data-hpre="${id}" data-keep>${ps.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <select data-hgrp2="${id}" data-keep><option value="">새 편대</option>${groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
      <button class="btn go" data-buyhull="${id}" ${why ? 'disabled' : ''}>구매</button></div>
      ${why ? `<div class="warn small">${why}</div>` : ''}</div>`;
  }).join('')}</div>`;
}

// ───────────────────────────────────────────────────────── own yard (build by hull)

export interface GrowthYardUi { hull: string | null; preset: string | null; fit: string[] }
export const newGrowthYardUi = (): GrowthYardUi => ({ hull: null, preset: null, fit: [] });

/** why this company cannot build this hull + variant here ('' = it can) */
function buildWhy(w: WorldState, s: Station, me: string, hull: string, variant: string): string {
  const co = w.companies[me];
  const hb = hullBlueprint(hull);
  if (!hb) return '설계도가 공개되지 않은 선체';
  if (!holds(co, hb)) return `설계도 필요: ${esc(bpName(hb))}`;
  const vb = variantBlueprint(variant);
  if (vb && !holds(co, vb)) return `변형 설계도 필요: ${esc(bpName(vb))}`;
  const miss = buildTech(hull, variant).filter(t => !co.tech?.includes(t));
  if (miss.length) return `연구 필요: ${miss.map(t => esc(TECHS[t]?.name ?? t)).join(', ')}`;
  const b = hullBuild(hull, variant);
  if (!yardSlots(s).some(y => y.size >= b.yard)) return `${YARD_NAME[b.yard]} 이상 조선소 필요`;
  const fac = (b.facilities ?? []).filter(f => !s.modules.some(m => m.kind === f && m.built));
  if (fac.length) return `필요 시설: ${fac.map(f => esc(MODULES[f]?.name ?? FACILITIES[f]?.name ?? f)).join(', ')}`;
  const berth = hullEcon(hull).berth;
  if (!berthFits(s, berth)) return `${berth}급 정박 시설 필요 (현재 ${berthOf(s)}급 — 하역시설 증설)`;
  return '';
}

export function ownYardGrowthHtml(w: WorldState, s: Station, me: string, ui: GrowthYardUi, groups: { id: string; name: string }[]): string {
  const co = w.companies[me];
  const hulls = Object.values(CONTENT.hulls).filter(h => h.classId !== 'platform' && !h.dev);
  const byClass = new Map<string, typeof hulls>();
  for (const h of hulls) (byClass.get(h.classId) ?? byClass.set(h.classId, []).get(h.classId)!).push(h);
  let html = `<h3>선체 설계 (${hulls.length})</h3><div class="dim small">건조하려면 <b>설계도</b>(생산 권리)와 <b>연구</b>, 맞는 크기의 <b>조선소</b>·<b>시설</b>, 부품과 시간이 필요합니다. 완성된 함선을 사고팔 때는 설계도나 연구가 필요 없습니다.</div>
  <div class="bcols"><div class="rlist">${[...byClass.entries()].map(([cls, hs]) => `<div class="dim small" style="margin-top:6px">${esc(SHIP_CLASSES[cls]?.type ?? cls)}</div>${hs.map(h => {
    const why = buildWhy(w, s, me, h.id, `${h.id}_std`);
    return `<div class="bfac pick${ui.hull === h.id ? ' sel' : ''}${why ? ' locked' : ''}" data-ghull="${h.id}"><b>${esc(hullTitle(h.id))}</b> <span class="dim small">${h.size} · ${YARD_NAME[hullBuild(h.id).yard]}</span>${why ? `<div class="small warn">${why}</div>` : ''}</div>`;
  }).join('')}`).join('')}</div>
  <div class="bdet">${ui.hull && CONTENT.hulls[ui.hull] ? ownHullDetail(w, s, me, ui, groups) : '<div class="dim" style="padding:12px">선체를 선택하면 설계도·연구·조선소·시설·부품 조건과 무장 구성을 고를 수 있습니다.</div>'}</div></div>`;
  void co;
  return html;
}

function ownHullDetail(w: WorldState, s: Station, me: string, ui: GrowthYardUi, groups: { id: string; name: string }[]): string {
  const co = w.companies[me];
  const id = ui.hull!; const h = CONTENT.hulls[id];
  const ps = presetsOf(id);
  const p = ps.find(x => x.id === ui.preset) ?? ps[0];
  const variant = p?.variant ?? `${id}_std`;
  const b = hullBuild(id, variant);
  const store: Cargo = s.storage[me] ?? {};
  const fit = ui.fit.filter(k => EQUIPMENT[k]?.kind === 'module');
  const need = buildNeeds(h.classId, '', fit, { hull: id, variant, preset: p?.id });
  const rows = Object.entries(need).map(([k, n]) => `<tr><td>${iname(k)}</td><td class="n">${fmt(n)}</td><td class="n">${fmt(qty(store, k))}</td><td class="n">${qty(store, k) >= n ? '<span class="good">충분</span>' : `<span class="warn">${fmt(n - qty(store, k))} 부족</span>`}</td></tr>`).join('');
  const why = buildWhy(w, s, me, id, variant) || (co.credits < b.credits ? `자금 부족 — ${fmt(b.credits - co.credits)} cr` : '');
  const vb = variantBlueprint(variant);
  const mods = Object.values(EQUIPMENT).filter(x => x.kind === 'module' && qty(store, x.id) >= 1);
  return `<div class="bdh"><b>${esc(hullTitle(id))}</b> <span class="dim">· ${esc(h.maker ?? '')} · ${GRADE[h.blueprint]} 설계</span></div>
    <div class="dim small">${esc(h.desc)}</div>
    <div class="bdr small">${hullStats(id, variant)}</div>
    ${baseChecklist(w, s, me, id, variant)}
    ${priceWhy(id, variant)}
    <div class="bdr">조선소 <b>${YARD_NAME[b.yard]}</b> 이상 · 건조 ${dur(b.time)} · 공임 <b class="money">${fmt(b.credits)} cr</b>${b.facilities?.length ? ` · 시설 ${b.facilities.map(f => esc(MODULES[f]?.name ?? f)).join(', ')}` : ''}${b.tech?.length ? ` · 연구 ${b.tech.map(t => esc(TECHS[t]?.name ?? t)).join(', ')}` : ''}</div>
    <div class="yrow"><select data-gpre data-keep>${ps.map(x => `<option value="${x.id}"${x.id === p?.id ? ' selected' : ''}>${esc(x.name)} — ${esc(CONTENT.variants[x.variant]?.name ?? '')}${CONTENT.variants[x.variant]?.blueprint !== 'common' ? ' (변형 설계도)' : ''}</option>`).join('')}</select>
    <select data-ggrp data-keep><option value="">새 편대</option>${groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
    ${p ? `<div class="dim small">${esc(p.desc)}${vb ? ` · 변형 설계도 ${holds(co, vb) ? '<span class="good">보유</span>' : '<span class="warn">미보유</span>'}` : ''}</div>` : ''}
    <div class="bdr small">모듈 (창고 보유분): ${mods.map(m => `<button class="chip${fit.includes(m.id) ? ' on' : ''}" data-gfit="${m.id}" title="${esc(m.desc)}">${esc(m.name)} <span class="dim">${fmt(qty(store, m.id))}</span></button>`).join(' ') || '<span class="dim">없음</span>'}</div>
    <table class="gt bmat"><tr><th>소모 부품·장비</th><th class="n">필요</th><th class="n">창고</th><th class="n">상태</th></tr>${rows}</table>
    ${why ? `<div class="warn">${why}</div>` : ''}<button class="btn go" data-gbuild="${id}" ${why ? 'disabled' : ''}>건조 등록</button>
    <div class="dim small">부품이 모자라도 등록할 수 있습니다. 조선소 슬롯이 비고 부품이 모두 이 정거장 창고에 있으면 자동으로 기공합니다.</div>`;
}

// ───────────────────────────────────────────────────────── ship exchange

export function exchangeHtml(w: WorldState, s: Station, me: string, groups: { id: string; name: string }[]): string {
  const co = w.companies[me];
  const ls = s.shipListings ?? [];
  const mine = Object.values(w.ships).filter(x => x.owner === me && x.state === 'docked' && x.task.k === 'docked' && (x.task as any).station === s.id && x.classId !== 'platform');
  const shipLine = (x: WShip) => `<b>${esc(x.name)}</b> <span class="dim">${esc(hullTitle(x.hull ?? `${x.classId}_mk1`))} · 내구 ${Math.round(x.hp * 100)}% · 마모 ${Math.round((x.wear ?? 0) * 100)}%</span>${x.owner === me && cargoKeys(x.cargo).length ? ` <span class="warn">화물: ${cargoKeys(x.cargo).map(k => `${esc(itemName(k))} ${stockFmt(x.cargo[k])}`).join(', ')} · 먼저 하역</span>` : ''}`;
  const fitLine = (x: WShip) => { const n: Record<string, number> = {}; for (const k of Object.values(x.fitting?.hp ?? {})) n[k] = (n[k] ?? 0) + 1; for (const k of Object.values(x.fitting?.bay ?? x.fit ?? {})) n[k] = (n[k] ?? 0) + 1; return Object.entries(n).map(([k, c]) => `${esc(EQUIPMENT[k]?.name ?? k)}${c > 1 ? ` ×${c}` : ''}`).join(', '); };
  return `<h3>함선 매물 (${ls.length})</h3><div class="dim small">플레이어가 내놓은 완성 함선입니다. 장착된 무장·모듈과 함께 넘어오며, 사는 쪽은 설계도나 연구가 필요 없습니다. 판매 대금에서 거래 수수료 ${Math.round((s.tax ?? 0.02) * 100)}%가 빠집니다.</div>
    ${ls.length ? `<table class="gt"><tr><th>함선</th><th>장비</th><th>판매사</th><th class="n">가격</th><th></th></tr>${ls.map(l => {
      const x = w.ships[l.ship]; if (!x) return '';
      const own = l.seller === me;
      return `<tr><td>${shipLine(x)}</td><td class="small">${fitLine(x) || '<span class="dim">없음</span>'}</td><td>${esc(w.companies[l.seller]?.name ?? '?')}</td><td class="n money">${fmt(l.price)}</td>
        <td>${own ? `<button class="btn" data-delist="${l.id}">내리기</button>` : `<select data-lgrp="${l.id}" data-keep><option value="">새 편대</option>${groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select> <button class="btn go" data-buylist="${l.id}" ${co.credits < l.price ? 'disabled' : ''}>인수</button>`}</td></tr>`;
    }).join('')}</table>` : '<div class="dim">지금은 매물이 없습니다.</div>'}
    <h3>내 함선 내놓기</h3>${mine.filter(x => !x.listed).length ? `<table class="gt"><tr><th>함선</th><th>장비</th><th>가격 (cr)</th><th></th></tr>${mine.filter(x => !x.listed).map(x => `<tr><td>${shipLine(x)}</td><td class="small">${fitLine(x)}</td>
      <td><input type="number" min="100" step="100" value="${Math.round(hullEcon(x.hull ?? `${x.classId}_mk1`).price * 0.8 / 100) * 100}" data-lprice="${x.id}" data-keep style="width:90px"></td><td><button class="btn" data-listship="${x.id}">매물 등록</button></td></tr>`).join('')}</table>
      <div class="dim small">매물로 등록하면 편대에서 빠져 거래소에 정박한 채 대기합니다 (출항 불가). 화물은 먼저 하역하세요. 정거장당 5척까지.</div>` : '<div class="dim">이 정거장에 정박한 자사 함선이 없습니다.</div>'}`;
}

// ───────────────────────────────────────────────────────── blueprints

export function blueprintsHtml(w: WorldState, s: Station, me: string): string {
  const co = w.companies[me];
  const offers = offersAt(full(w), s, co);
  const owned = ownedBlueprints(co);
  const store: Cargo = s.storage[me] ?? {};
  const frags = Object.keys(store).filter(k => k.startsWith(FRAG_PREFIX) && qty(store, k) >= 1);
  const target = (bp: { target: { kind: string; id: string } }) => bp.target.kind === 'hull' ? hullTitle(bp.target.id) : bp.target.kind === 'variant' ? `${CONTENT.variants[bp.target.id]?.name ?? bp.target.id} (${hullTitle(CONTENT.variants[bp.target.id]?.hull ?? '')})` : bp.target.id;
  const how = (bp: { sources: { kind: string }[] }) => bp.sources.map(x => SRC_NAME[x.kind as keyof typeof SRC_NAME]).join(' · ');
  return `<div class="dim small">설계도는 <b>건조 권리</b>입니다 (연구와 별개). 함선을 사서 쓰는 데는 필요 없고, 직접 건조할 때 선체·특수 변형마다 필요합니다.</div>
    <h3>이 정거장에서 판매 (${offers.length})</h3>${offers.length ? `<table class="gt"><tr><th>설계도</th><th>대상</th><th>경로</th><th class="n">가격</th><th></th></tr>${offers.map(o => `<tr><td><b>${esc(o.bp.name)}</b> <span class="dim small">${GRADE[o.bp.grade] ?? ''}</span>${o.bp.runs ? ` <span class="dim small">(${o.bp.runs}회)</span>` : ''}</td><td>${esc(target(o.bp))}</td><td class="small">${SRC_NAME[o.src.kind]}</td><td class="n money">${fmt(o.price)}</td>
      <td>${o.why ? `<span class="small ${o.why === '보유 중' ? 'good' : 'warn'}">${esc(o.why)}</span>` : `<button class="btn mini" data-buybp="${o.bp.id}">구매</button>`}</td></tr>`).join('')}</table>` : '<div class="dim">이 정거장은 설계도를 팔지 않습니다.</div>'}
    ${frags.length ? `<h3>잔해 설계 조각 (이 정거장 창고)</h3><table class="gt">${frags.map(k => { const bp = k.slice(FRAG_PREFIX.length); const need = fragmentsNeeded(bp) ?? 0; const have = Math.floor(qty(store, k)); return `<tr><td>${esc(bpName(bp))}</td><td class="n">${have}/${need}</td><td>${holds(co, bp) ? '<span class="good small">보유 중</span>' : `<button class="btn" data-asmbp="${bp}" ${have < need ? 'disabled' : ''}>복원</button>`}</td></tr>`; }).join('')}</table>` : ''}
    <h3>보유 설계도 (${owned.length})</h3><table class="gt"><tr><th>설계도</th><th>대상</th><th>획득</th><th>건조 연구</th></tr>${owned.map(o => {
      const tech = o.bp.target.kind === 'hull' ? buildTech(o.bp.target.id, `${o.bp.target.id}_std`) : (o.bp.requires ?? []);
      return `<tr><td><b>${esc(o.bp.name)}</b>${o.runs !== undefined ? ` <span class="dim small">남은 ${o.runs}회</span>` : ''}</td><td>${esc(target(o.bp))}</td><td class="small">${esc(SRC_NAME[o.src as keyof typeof SRC_NAME] ?? (o.src === 'migration' ? '기존 권한 이관' : o.src === 'starter' ? '창업 지급' : o.src))}</td>
        <td class="small">${tech.length ? tech.map(t => co.tech?.includes(t) ? `<span class="good">${esc(TECHS[t]?.name ?? t)}</span>` : `<span class="warn">${esc(TECHS[t]?.name ?? t)}</span>`).join(', ') : '<span class="dim">없음</span>'}</td></tr>`;
    }).join('')}</table>
    <details class="small"><summary>다른 설계도는 어디서?</summary>${Object.values(CONTENT.blueprints).filter(b => !holds(co, b.id)).map(b => `<div>${esc(b.name)} — <span class="dim">${how(b)}${b.sources.map(x => 'stations' in x ? ` (${(x as { stations: string[] }).stations.map(id => esc(w.stations[id]?.name ?? id)).join(', ')})` : '').join('')}</span></div>`).join('')}</details>`;
}

// ───────────────────────────────────────────────────────── running costs

export function upkeepTop(w: WorldState, me: string): string {
  const co = w.companies[me];
  const f = forecast(full(w), co); const u = co.upkeep;
  const st = u?.stage ?? 0;
  return `<div class="kv" data-upkeep style="cursor:pointer" title="운영비 상세"><span>운영비</span><b class="${st >= 2 ? 'warn' : st ? 'warnish' : ''}">${fmt(f.perHour)} <small>cr/h</small>${st ? ` · ${STAGE_NAME[st]}` : ''}</b></div>`;
}

export function upkeepHtml(w: WorldState, me: string): string {
  const co = w.companies[me];
  const f = forecast(full(w), co); const u = co.upkeep;
  const ships = Object.values(w.ships).filter(s => s.owner === me && s.classId !== 'platform');
  const stage = u?.stage ?? 0;
  const next = stage >= 1 && stage < 4 && u?.since ? STAGE_AT[stage + 1] - (w.time - u.since) : 0;
  const b = u?.bill;
  return `<div class="panel upk"><div class="shdr"><div class="stitle">운영비</div><button class="btn" data-upclose>✕</button></div>
    <div class="bdr">시간당 약 <b class="money">${fmt(f.perHour)} cr</b> — 선체 유지 ${fmt(f.credits)} · 관리비 ${fmt(f.overhead)} · 대형선 정박료 ${fmt(f.dock)} · 정거장 ${fmt(f.station)} · 창고 임대 ${fmt(f.lease)} · 소모품 ${fmt(f.suppliesCr)}${Object.keys(f.supplies).length ? ` (${itemList(f.supplies)})` : ''}</div>
    <div class="dim small">소모품은 자사 창고(자사 정거장 → 본거지)에서 먼저 쓰고, 없으면 본거지 시장에서 실제 재고·가격으로 삽니다. 함선은 우주에서 일하며 마모되고, 수리 시설이 있는 곳에 정박할 때마다 자동 정비됩니다. 관리비는 함선마다 똑같이 유지비의 10%입니다 (함대를 나눠도 줄지 않음). 대형 함대의 진짜 부담은 정비 능력입니다 — 공용 정비소는 모든 회사가 나눠 쓰므로 붐비면 마모가 다 지워지지 않고, 자사 정비소·격납고가 있어야 대함대를 유지할 수 있습니다.</div>
    <div class="bdr">상태: <b class="${stage >= 2 ? 'warn' : stage ? 'warnish' : 'good'}">${!stage && u?.debt ? '소액 미납' : STAGE_NAME[stage]}</b>${u?.debt ? ` · 체납 <b class="warn">${moneyText(u.debt)} cr</b>` : ''}${next > 0 ? ` · 다음 단계까지 ${dur(next)}` : ''}</div>
    ${stage ? '<div class="small">체납 단계: 1 경고 → 2 보급·정비 지연(30분) → 3 정박 함선 신규 출항 보류(60분) → 4 예비역 전환 권고(120분). 운항·전투 중인 함선은 건드리지 않으며, 함선·장비는 삭제되지 않습니다. 자금이 들어오면 자동으로 갚습니다.</div>' : ''}
    ${b ? `<div class="dim small">최근 정산: 청구 ${moneyText(b.credits + b.supplies)} cr · 지불 ${moneyText(b.paid)} cr${b.short ? ` · 미납 ${moneyText(b.short)}` : ''}${Object.keys(b.fromStore).length ? ` · 창고 사용 ${itemList(b.fromStore)}` : ''}${Object.keys(b.bought).length ? ` · 시장 구매 ${itemList(b.bought)}` : ''}</div>` : ''}
    ${u?.debt ? `<div class="bdr small"><button class="btn" data-payarrears ${co.credits <= 0 ? 'disabled' : ''}>보유 크레딧으로 미납금 납부</button> · 물품·함선 판매대금은 미납금부터 자동 정산합니다. 잔액 부족분은 보존되며 잔액을 음수로 만들지 않습니다.</div>` : ''}
    ${u?.rent?.sinceMs !== undefined && Object.values(co.leases ?? {}).some(n => n > 0) ? `<div class="warn small">창고 임대료 미납 ${moneyText(Number(u.rent.debtU) / 1e9)} cr · 추가 임대 구획 자동 해지까지 ${dur(Math.max(0, u.rent.sinceMs / 1000 + 3600 - w.time))}. 일부 납부만으로 유예 시간이 초기화되지 않습니다.</div>` : ''}
    ${u?.rent?.cancelled ? `<div class="warnish small">최근 임대 해지: 임대료 미납으로 추가 구획이 자동 해지됐습니다 (게임 시간 ${dur(u.rent.cancelled.t)}). 기존 물품은 보존됩니다. 미납 정산 후 다시 임대할 수 있습니다.</div>` : ''}
    <label class="small"><input type="checkbox" data-autores ${u?.autoReserve ? 'checked' : ''}> 체납 4단계에서 정박 중인 유휴 함선을 자동으로 예비역 전환 (동의)</label>
    <table class="gt"><tr><th>함선</th><th>상태</th><th class="n">cr/h</th><th class="n">마모</th><th></th></tr>${ships.map(s => {
      const r = shipRate(full(w), s); const held = departureHeld(full(w), s);
      return `<tr><td>${esc(s.name)} <span class="dim small">${esc(hullTitle(s.hull ?? `${s.classId}_mk1`))}</span></td><td class="small">${s.state === 'docked' ? '정박' : s.state === 'space' ? '운항' : esc(s.state)}${held ? ` · <span class="warn">${esc(held)}</span>` : ''}</td><td class="n">${fmt(r.credits + r.dock)}</td><td class="n">${Math.round((s.wear ?? 0) * 100)}%</td>
        <td>${s.reserve ? (s.reserve.until ? `<span class="dim small">재취역 ${dur(Math.max(0, s.reserve.until - w.time))}</span>` : `<button class="btn mini" data-reserve="${s.id}:0" title="재취역 ${REACTIVATE_S / 60}분, 2시간분 운영비">재취역</button>`) : s.state === 'docked' && !s.listed ? `<button class="btn mini" data-reserve="${s.id}:1" title="운영비 85% 절감, 출항 불가">예비역</button>` : ''}</td></tr>`;
    }).join('')}</table></div>`;
}

// ───────────────────────────────────────────────────────── rev 2: why things cost what they cost

/** why a hull costs what it does: parts, labour, yard time, weapons, then tier and grade multipliers */
export function priceWhy(hull: string, variant?: string): string {
  const p = hullPrice(hull, variant);
  const b = hullBuild(hull, variant);
  const pricingYard = b.pricingYard ?? b.yard;
  const tier = ['', '소형 양산', '중형 군용', '대형 주력', '초대형'][pricingYard] ?? '';
  return `<details class="small pwhy"><summary>가격 구성 — 생산원가 <b>${fmt(p.total)}</b> cr × ${tier} 배율 ${p.mul} × 등급 ${p.grade}</summary>
    <table class="gt"><tr><td>부품 (${Object.keys(b.parts).length}종)</td><td class="n">${fmt(p.parts)}</td><td class="dim">${itemList(b.parts)}</td></tr>
    <tr><td>조립 공임</td><td class="n">${fmt(p.labour)}</td><td></td></tr>
    <tr><td>조선소 가동 (${dur(b.time)})</td><td class="n">${fmt(p.yard)}</td><td class="dim">${YARD_NAME[pricingYard]} 비용 기준${pricingYard !== b.yard ? ' · 변경 전 가격 유지' : ' — 큰 독일수록 시간당 비용이 크다'}</td></tr>
    <tr><td>표준 무장</td><td class="n">${fmt(p.equipment)}</td><td></td></tr></table>
    <div class="dim">공영 조선소 가격 = 원가 × 함급 허가 배율 ×${p.mul} × 설계 등급 ×${p.grade}. 초계함·호위함과 민간선은 대량 생산 보조로 원가보다 싸고, 구축함부터는 군용 허가·희소성 때문에 원가를 크게 웃돈다. 직접 건조하면 원가(부품 + 공임 + 조선소 운영비)와 시설 투자로 지을 수 있다.</div></details>`;
}

/** every condition a build needs here, ticked or not (not just the first one missing) */
function baseChecklist(w: WorldState, s: Station, me: string, hull: string, variant: string): string {
  const co = w.companies[me];
  const b = hullBuild(hull, variant);
  const has = (f: string) => s.modules.some(m => m.kind === f && m.built);
  const items: [boolean, string][] = [];
  const hb = hullBlueprint(hull); if (hb) items.push([holds(co, hb), `설계도: ${esc(bpName(hb))}`]);
  const vb = variantBlueprint(variant); if (vb) items.push([holds(co, vb), `변형 설계도: ${esc(bpName(vb))}`]);
  for (const t of buildTech(hull, variant)) items.push([!!co.tech?.includes(t), `연구: ${esc(TECHS[t]?.name ?? t)}`]);
  items.push([yardSlots(s).some(y => y.size >= b.yard), `${YARD_NAME[b.yard]} 이상 조선소`]);
  for (const f of b.facilities ?? []) items.push([has(f), `시설: ${esc(MODULES[f]?.name ?? FACILITIES[f]?.name ?? f)}`]);
  items.push([berthFits(s, hullEcon(hull).berth), `${hullEcon(hull).berth}급 정박 시설`]);
  const ok = items.filter(x => x[0]).length;
  return `<div class="bdr small"><b>산업 기반 ${ok}/${items.length}</b> <span class="dim">— 함급이 오를수록 조선소 크기와 함께 선체·장갑·전자·동력·무기 공장이 단계적으로 필요합니다</span><div class="chk">${items.map(([o, t]) => `<span class="${o ? 'good' : 'warn'}">${o ? '✓' : '✗'} ${t}</span>`).join(' ')}</div></div>`;
}

// ───────────────────────────────────────────────────────── rev 2: public storage & services

export function storageGrowthHtml(w: WorldState, s: Station, me: string): string {
  const co = w.companies[me];
  if (!s.public) {
    if (s.owner !== me) return '';
    const cap = storageCap(s); const used = storeUsed(s.storage[me]);
    const overflow = cap ? Math.max(0, used - cap) : 0;
    const held = reservedSpace(s) + listedSpace(s, me);
    return `<div class="bdr"><b>자사 창고</b> ${stockFmt(used)} / ${cap ? fmt(cap) : '건설 계획의 부족 자재만 수용'}${overflow > 0 ? ` · <span class="warn">초과 보관 ${stockFmt(overflow)} — 신규 입고 불가</span>` : held > 0 && used + held >= cap ? ' · <span class="warnish">예약 자재·매물 반환 공간 확보 — 일반 입고 대기</span>' : ''}${co.pendingLoot?.[s.id] ? ` · <span class="warnish">회수품 ${fmt(Object.values(co.pendingLoot[s.id]).reduce((n, v) => n + v, 0))} 안전 보관 중 — 공간 확보 시 자동 입고</span>` : ''} · 자체 정비 능력 ${fmt(ownRepairCap(s))} 정비점/h <span class="dim small">(정비소 +${OWN_REPAIR.repair} · 격납고 +${OWN_REPAIR.hangar})</span></div>`;
  }
  const sv = serviceOf(s);
  const cap = publicCap(co, s), used = storeUsed(s.storage[me]), listed = listedSpace(s, me);
  const n = leasedAt(co, s.id);
  const pct = Math.min(100, used / Math.max(1, cap) * 100);
  const over = used > cap;
  const cls = over ? 'warn' : pct > 85 ? 'warnish' : 'good';
  return `<div class="bdr stor"><b>공용 창고</b> <span class="${cls}">${stockFmt(used)} / ${fmt(cap)}</span>
      <div class="sbar"><i style="width:${pct.toFixed(0)}%" class="${cls}"></i></div>
      <div class="small">기본 ${fmt(sv.store)} + 임대 ${n}/${sv.blocks}구획 × ${fmt(LEASE_BLOCK)} · 구획당 <b class="money">${fmt(sv.lease)} cr/h</b> (현재 임대료 합계 ${fmt(leaseRate(full(w), co))} cr/h)
        <button class="btn mini" data-lease="${n + 1}" ${co.upkeep?.debt ? 'disabled title="미납금 정산 후 임대 가능"' : n >= sv.blocks ? 'disabled title="이 정거장의 임대 한도"' : ''}>+1 구획 임대</button>
        <button class="btn mini" data-lease="${n - 1}" ${n <= 0 ? 'disabled' : ''}>1 구획 반납</button></div>
      ${listed ? `<div class="dim small">매물 회수 공간 ${fmt(listed)} 예약 · 물품은 판매되거나 회수될 때까지 그대로 보존됩니다.</div>` : ''}
      ${over ? `<div class="warn small">한도를 넘었습니다 — 보관 중인 물품은 그대로지만 새로 들여올 수 없습니다 (하역분은 함선에 남고, 구매는 거부). 팔거나 옮기거나 구획을 임대하세요.</div>` : pct > 85 ? '<div class="warnish small">창고가 거의 찼습니다. 하역하지 못한 화물은 함선에 남아 채굴·운송이 멈춥니다.</div>' : ''}
      <div class="dim small">${esc(sv.note)} 공용 정비 능력 ${fmt(sv.repair)} 정비점/h (모든 회사 공유, 남은 ${fmt(dockCapacity(full(w), s))}) · 정비료 ×${sv.fee}</div>
      <div class="dim small">추가 구획은 첫 1시간 요금을 즉시 선납합니다. 구획별 선납 만료 후 사용 시간만 고정소수점으로 청구하며 60초마다 명세를 갱신합니다. 미납이 게임 시간 1시간 지속되면 모든 추가 구획이 자동 해지되고 이후 임대료는 중단됩니다. 미납금·보관 물품은 보존되며, 미납 정산 전에는 새 임대가 제한됩니다. 반납은 최근 추가 구획부터이며 선납 환불은 없습니다.</div>
      ${n ? `<div class="small">선납 잔여: ${(co.leasePaidUntil?.[s.id] ?? []).map((t, i) => `${i + 1}구획 ${dur(Math.max(0, t - w.time))}`).join(' · ') || '기존 임대 — 사용 시간 후불 정산'} · 최근 정산 임대료 ${moneyText(co.upkeep?.bill?.lease ?? 0)} cr</div>` : ''}
      ${!n && co.upkeep?.rent?.cancelled?.blocks[s.id] ? `<div class="warnish small">미납 1시간으로 추가 구획이 해지되었습니다. 이후 임대료는 발생하지 않으며 기존 물품은 보존됩니다.</div>` : ''}
      ${co.upkeep?.debt ? `<div class="warn small">미납 ${moneyText(co.upkeep.debt)} cr — 보관 물품을 판매하면 미납금을 우선 정산합니다. 운영비 화면에서 보유 크레딧으로 납부할 수도 있습니다.${co.upkeep.rent?.sinceMs !== undefined && Object.values(co.leases ?? {}).some(n => n > 0) ? ` 추가 구획 자동 해지까지 ${dur(Math.max(0, co.upkeep.rent.sinceMs / 1000 + 3600 - w.time))}.` : ''}</div>` : ''}
      ${storeUsed(co.pendingLoot?.[s.id]) > 0 ? `<div class="warnish small">전장 회수품 ${fmt(storeUsed(co.pendingLoot?.[s.id]))} 안전 보관 중 · 공간 확보 시 자동 입고</div>` : ''}
    </div>
    <details class="small"><summary>공용 정거장 vs 자체 정거장</summary><table class="gt">
      <tr><th></th><th>공용 (${esc(s.name)})</th><th>자체 정거장</th></tr>
      <tr><td>창고</td><td>${fmt(sv.store)} + 임대 최대 ${fmt(sv.blocks * LEASE_BLOCK)} (${fmt(sv.lease * sv.blocks)} cr/h)</td><td>코어 20,000 + 창고 모듈마다 30,000 · 임대료 없음</td></tr>
      <tr><td>정비</td><td>${fmt(sv.repair)}/h를 모든 회사가 나눠 씀 · 정비료 ×${sv.fee}</td><td>정비소 ${OWN_REPAIR.repair}/h · 격납고 ${OWN_REPAIR.hangar}/h (자사 전용) · 정비료 50%</td></tr>
      <tr><td>가공·생산</td><td>없음 (시장에서 사고팔기만)</td><td>제련·정제·부품 공장 — 광석을 합금·부품으로 가공해 가치를 더함</td></tr>
      <tr><td>조선</td><td>표준 선체 재고만 (값이 원가보다 비쌈)</td><td>조선소 + 공장 단계에 따라 고급 선체·변형 직접 건조</td></tr>
      <tr><td>물류·방어</td><td>—</td><td>물류센터(자동 보급) · 거래소 · 통신 · 방어 시설</td></tr>
    </table><div class="dim">공용 창고가 가득 차도 진행은 막히지 않습니다: 정박한 함선 화물칸으로 바로 구매할 수 있고, 정거장 설립용 합금은 공작선이 직접 싣고 가며, 건설 중인 자체 정거장(코어 완공 전)은 용량 제한이 없습니다.</div></details>`;
}

/** compact station-services comparison (all public stations) */
export function servicesTable(w: WorldState): string {
  return `<table class="gt small"><tr><th>정거장</th><th class="n">기본 창고</th><th class="n">임대 cr/h</th><th class="n">최대 구획</th><th class="n">정비/h</th><th class="n">정비료</th></tr>${Object.entries(SERVICES).filter(([id]) => w.stations[id]).map(([id, v]) => `<tr><td>${esc(w.stations[id].name)}</td><td class="n">${fmt(v.store)}</td><td class="n">${v.lease}</td><td class="n">${v.blocks}</td><td class="n">${v.repair}</td><td class="n">×${v.fee}</td></tr>`).join('')}</table>`;
}

// ───────────────────────────────────────────────────────── rev 2: exploration

/** sites this company knows in a system + survey state (for the fleet panel) */
export function sitesHtml(w: WorldState, me: string, sysId: string, canSalvage: boolean): string {
  const sys = w.systems[sysId];
  if (!sys || !full(w).sites) return '';
  if (sys.kind === 'core' || sys.security >= 90) return '<div class="dim small">핵심 성계에는 숨은 잔해가 없습니다. 변경·위험·무법 성계를 탐사하세요.</div>';
  const all = sitesIn(full(w), sysId, w.time);
  const mine = all.filter(x => knows(x, me));
  const hidden = all.length - mine.length;
  const left = surveyLeft(full(w), me, sysId);
  const T = ['', '얕은', '깊은', '심층'];
  return `<div class="small"><b>${esc(sys.name)} 탐사</b> · 발견 ${mine.length}곳${hidden ? ` · 미발견 신호 ${hidden}곳 (함선 1척 기준 약 ${Math.ceil(left / 60)}분 탐사)` : ' · 숨은 지점 없음'}</div>
    ${mine.map(x => `<div class="small">◆ ${esc(x.name)} <span class="dim">${T[x.tier]} 유적 · 인양 ${Math.floor(x.work / x.need * 100)}% · 필요 작업 ${dur(x.need)} (채굴선·공작선 2배)</span>${canSalvage ? ` <button class="btn mini" data-salvage="${x.id}">인양</button>` : ''}</div>`).join('')}
    <div class="dim small">탐사는 성계를 크게 돌며 신호를 찾습니다 (등급 1/2/3: ${SCAN_NEED[1] / 60}/${SCAN_NEED[2] / 60}/${SCAN_NEED[3] / 60}분·척). 인양물(합금·희토류·전자부품·설계 조각, 깊은 유적은 판매되지 않는 설계도)은 화물칸에 실리고, 인양 소문이 나면 그 성계의 해적 활동이 늘어납니다.</div>`;
}
