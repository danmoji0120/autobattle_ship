// Growth UI (contentV ≥ 3): public yard stock, own-yard builds by hull, the player ship exchange,
// blueprints and running costs. Pure HTML builders; hud.ts wires the data-* buttons to commands.
import type { Station, Cargo, WShip } from '../../world/types';
import type { WorldView } from '../../server/protocol';
import type { WorldState as FullState } from '../../world/types';
// the client view lacks only rng/events, which none of these helpers read
type WorldState = WorldView;
const full = (w: WorldView) => w as unknown as FullState;
import { qty } from '../../world/types';
import { CONTENT } from '../../content/registry';
import { SHIP_CLASSES } from '../../sim/data/ships';
import { EQUIPMENT, TECHS, FACILITIES } from '../../world/industry';
import { MODULES } from '../../world/data';
import { yardSlots, buildNeeds, YARD_NAME } from '../../world/production';
import { hullEcon, hullBuild, hullSale, hullUpkeep, yardHulls, berthOf, berthFits } from '../../world/hullops';
import { holds, hullBlueprint, variantBlueprint, buildTech, offersAt, ownedBlueprints, bpName, SRC_NAME, FRAG_PREFIX, fragmentsNeeded } from '../../world/blueprints';
import { forecast, shipRate, STAGE_NAME, STAGE_AT, REACTIVATE_S, departureHeld } from '../../world/upkeep';
import { iname, itemList } from './industryUi';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
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
  const hulls = Object.values(CONTENT.hulls).filter(h => h.classId !== 'platform');
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
  const shipLine = (x: WShip) => `<b>${esc(x.name)}</b> <span class="dim">${esc(hullTitle(x.hull ?? `${x.classId}_mk1`))} · 내구 ${Math.round(x.hp * 100)}% · 마모 ${Math.round((x.wear ?? 0) * 100)}%</span>`;
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
    <div class="bdr">시간당 약 <b class="money">${fmt(f.perHour)} cr</b> — 선체 유지 ${fmt(f.credits)} · 규모 간접비 ${fmt(f.overhead)} · 대형선 정박료 ${fmt(f.dock)} · 소모품 ${fmt(f.suppliesCr)}${Object.keys(f.supplies).length ? ` (${itemList(f.supplies)})` : ''}</div>
    <div class="dim small">소모품은 자사 창고(자사 정거장 → 본거지)에서 먼저 쓰고, 없으면 본거지 시장에서 실제 재고·가격으로 삽니다. 함선은 우주에서 일하며 마모되고, 수리 시설이 있는 곳에 정박할 때마다 자동 정비됩니다. 함선이 8척을 넘으면 척당 3%씩 간접비가 붙습니다.</div>
    <div class="bdr">상태: <b class="${stage >= 2 ? 'warn' : stage ? 'warnish' : 'good'}">${STAGE_NAME[stage]}</b>${u?.debt ? ` · 체납 <b class="warn">${fmt(u.debt)} cr</b>` : ''}${next > 0 ? ` · 다음 단계까지 ${dur(next)}` : ''}</div>
    ${stage ? '<div class="small">체납 단계: 1 경고 → 2 보급·정비 지연(30분) → 3 정박 함선 신규 출항 보류(60분) → 4 예비역 전환 권고(120분). 운항·전투 중인 함선은 건드리지 않으며, 함선·장비는 삭제되지 않습니다. 자금이 들어오면 자동으로 갚습니다.</div>' : ''}
    ${b ? `<div class="dim small">최근 정산: 청구 ${fmt(b.credits + b.supplies)} cr · 지불 ${fmt(b.paid)} cr${b.short ? ` · 미납 ${fmt(b.short)}` : ''}${Object.keys(b.fromStore).length ? ` · 창고 사용 ${itemList(b.fromStore)}` : ''}${Object.keys(b.bought).length ? ` · 시장 구매 ${itemList(b.bought)}` : ''}</div>` : ''}
    <label class="small"><input type="checkbox" data-autores ${u?.autoReserve ? 'checked' : ''}> 체납 4단계에서 정박 중인 유휴 함선을 자동으로 예비역 전환 (동의)</label>
    <table class="gt"><tr><th>함선</th><th>상태</th><th class="n">cr/h</th><th class="n">마모</th><th></th></tr>${ships.map(s => {
      const r = shipRate(full(w), s); const held = departureHeld(full(w), s);
      return `<tr><td>${esc(s.name)} <span class="dim small">${esc(hullTitle(s.hull ?? `${s.classId}_mk1`))}</span></td><td class="small">${s.state === 'docked' ? '정박' : s.state === 'space' ? '운항' : esc(s.state)}${held ? ` · <span class="warn">${esc(held)}</span>` : ''}</td><td class="n">${fmt(r.credits + r.dock)}</td><td class="n">${Math.round((s.wear ?? 0) * 100)}%</td>
        <td>${s.reserve ? (s.reserve.until ? `<span class="dim small">재취역 ${dur(Math.max(0, s.reserve.until - w.time))}</span>` : `<button class="btn mini" data-reserve="${s.id}:0" title="재취역 ${REACTIVATE_S / 60}분, 2시간분 운영비">재취역</button>`) : s.state === 'docked' && !s.listed ? `<button class="btn mini" data-reserve="${s.id}:1" title="운영비 85% 절감, 출항 불가">예비역</button>` : ''}</td></tr>`;
    }).join('')}</table></div>`;
}
