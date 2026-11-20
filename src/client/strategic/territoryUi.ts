// P10 client views: territory info, unidentified deposits (from the company's own samples only),
// and the field-management table. Everything here reads what the server replicated to this
// company; nothing is inferred from hidden data (the server never sends it).
import type { WorldView } from '../../server/protocol';
import { qty, type Field, type StarSystem } from '../../world/types';
import { FACTIONS, REGION_RULES } from '../../world/territory';
import { fieldReport, CONFIDENCE_NAME, type FieldIntel } from '../../world/intel';
import { GEO_SIZE_NAME, type GeoSize } from '../../world/geology';
import { RES_NAME } from '../../world/data';
import { dist, sysAt } from '../../world/geom';
import { doctrineOf } from '../../world/factionEcon';

import { outpostProblem, STRATEGIC_RAW } from '../../world/strategicFields';
import { econOf } from '../../world/hullops';
import { coRelation } from '../../world/battleAuth';
import { storageCap } from '../../world/production';
import { logisticsReservedSpace, reservedSpace, storeUsed } from '../../world/storage';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
const pct = (x: number) => x >= .1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`;

export interface Unidentified { look: string; size: GeoSize; hints: string[]; hidden: boolean }
export const unidentified = (f: Field): Unidentified | undefined => (f as any).unidentified;
export const fieldIntel = (st: WorldView, me: string, id: string): FieldIntel | undefined => (st as any).intel?.[me]?.fields?.[id];

/** composition the player may show: true mix for identified fields, own observed shares otherwise */
export function shownMix(st: WorldView, me: string, f: Field): { shares: [string, number][]; observed: boolean } {
  if (!unidentified(f)) return { shares: Object.entries(f.mix ?? { [f.res]: 1 }).filter(([, v]) => v > 0), observed: false };
  return { shares: fieldReport(fieldIntel(st, me, f.id)).shares, observed: true };
}

export function fieldIntelHtml(st: WorldView, me: string, f: Field): string {
  const u = unidentified(f); if (!u) return '';
  const fi = fieldIntel(st, me, f.id), r = fieldReport(fi);
  const rows = r.shares.map(([k, s]) => `<div><b>${esc(RES_NAME[k] ?? k)}</b> ${fmt(fi!.units[k])}개 · 관측 비율 ${pct(s)}<span class="dim"> · 첫 채굴 ${Math.round((r.firstSeen[k] ?? 0) / 60)}분</span></div>`).join('');
  return `<div class="svc"><span class="tag">미확인 광구</span> 외형: ${esc(u.hints[0] ?? u.look)} · 규모 ${GEO_SIZE_NAME[u.size]}${u.hidden ? ' · 정밀 탐사로 발견' : ''}</div>
    ${u.hints.length > 1 ? `<div class="dim small">단서: ${u.hints.slice(1).map(esc).join(' · ')}</div>` : ''}
    <div class="svc">누적 표본 ${fmt(r.n)}개 · 신뢰도 <b>${CONFIDENCE_NAME[r.confidence]}</b>${r.n ? ` · 관측 기준 단위 가치 약 ${fmt(r.unitValue)} cr` : ''}</div>
    <div class="small">${rows || '<div class="dim">아직 채굴한 표본이 없습니다. 시험 채굴로 실제 성분을 확인하세요.</div>'}</div>
    <div class="dim small">관측 비율은 자사 함선이 실제로 캐낸 결과입니다. ${r.n ? `아직 나오지 않은 성분이 최대 약 ${pct(r.unseenMax)}까지 있을 수 있고, ` : ''}깊이·구역에 따라 성분이 달라질 수 있습니다.</div>`;
}

export function territoryHtml(st: WorldView, sys: StarSystem): string {
  if (!sys.region) return '';
  const rule = REGION_RULES[sys.region], f = sys.faction ? FACTIONS[sys.faction] : undefined;
  const fs = f ? st.factions?.[f.id] : undefined;
  const wars = Object.values(st.conflicts ?? {}).filter(c => !c.ended && f && (c.a === f.id || c.b === f.id));
  const rel = fs ? Object.entries(fs.rel).filter(([k]) => FACTIONS[k]).sort((a, b) => a[1] - b[1]).slice(0, 3) : [];
  const d = f ? doctrineOf(f.id) : undefined;
  return `<section class="gal-section"><div class="gal-section-head"><h3>세력권</h3><span>${esc(rule.name)}</span></div>
    ${f ? `<p><b style="color:${f.color}">${esc(f.name)}</b>${f.capital === sys.id ? ' · 수도' : ''}</p><p class="dim small">${esc(f.desc)}</p>` : `<p class="dim">${sys.charted === false ? '미개척 공역 — 어느 세력도 지배하지 않습니다.' : '무주 공역 — 세력의 보호가 없습니다.'}</p>`}
    <p class="small">${esc(rule.desc)}</p>
    ${fs && d ? `<p class="small">함대 전력 ${fmt(fs.strength)} / ${d.strength} · 기반시설 ${fmt(fs.infra)} / ${d.infra}${fs.strength < d.strength ? ' · <span class="warn">함선 건조 수요</span>' : ''}${fs.infra < d.infra ? ' · <span class="warn">건설 수요</span>' : ''}</p>` : ''}
    ${fs?.econ ? `<p class="small">경제 효율 ${pct(fs.econ.eff)} · 전투 준비 ${pct(fs.econ.rdy)} · 발전도 ${fs.econ.dev.toFixed(2)}${fs.econ.recon > 0 ? ' · <span class="warn">전후 재건 중</span>' : ''}</p>
    ${fs.econ.hot?.length ? `<p class="small">부족 품목: ${fs.econ.hot.map(([k, n]) => `<b>${esc(RES_NAME[k] ?? k)}</b> ${fmt(n)}`).join(' · ')}<span class="dim"> — 세력 시장에 판매하면 세력이 사들여 유지·건조·건설에 씁니다</span></p>` : ''}` : ''}
    ${rel.length ? `<p class="dim small">관계: ${rel.map(([k, v]) => `${esc(FACTIONS[k].short)} ${Math.round(v)}`).join(' · ')}</p>` : ''}
    ${wars.length ? wars.map(c => `<p class="warn small">분쟁 중: ${esc(FACTIONS[c.a].short)}–${esc(FACTIONS[c.b].short)} · 관문 ${c.gates.length / 2}곳 봉쇄</p>`).join('') : ''}</section>`;
}

export function strategicFieldHtml(st: WorldView, me: string, f: Field): string {
  if (!f.strategic) return '';
  const stations = Object.values(st.stations).filter(s => s.owner === me && dist(s.pos, f.pos) <= f.strategic!.radius)
    .sort((a, b) => Number(!!outpostProblem(st, f, a, me)) - Number(!!outpostProblem(st, f, b, me)) || dist(a.pos, f.pos) - dist(b.pos, f.pos));
  const base = stations[0];
  const capacity = base ? storageCap(base) : 0;
  const used = base ? storeUsed(base.storage[me]) + reservedSpace(base) + logisticsReservedSpace(st, base.id, me) : 0;
  const blocked = outpostProblem(st, f, base, me) ?? (capacity > 0 && used >= capacity ? '전초기지 창고 가득' : null);
  const ships = Object.values(st.ships), own = ships.filter(s => s.owner === me);
  const working = own.filter(s => s.task.k === 'mine' && s.task.field === f.id && s.state === 'space');
  const guards = own.filter(s => s.state === 'space' && !s.warp && econOf(s).military && dist(s.pos, f.pos) <= 5500);
  const contacts = new Set(ships.filter(s => s.state === 'space' && econOf(s).military && coRelation(st, me, s.owner) === -1
    && (working.some(o => dist(s.pos, o.pos) < 5600) || guards.some(o => dist(s.pos, o.pos) < 5600))).map(s => s.groupId));
  const shipments = Object.values(st.logisticsJobs ?? {}).filter(j => j.owner === me && base && j.from === base.id
    && STRATEGIC_RAW.some(item => item === j.item) && j.state !== 'complete' && j.state !== 'cancelled');
  const stock = base && STRATEGIC_RAW.filter(item => qty(base.storage[me], item) >= 1)
    .map(item => `${RES_NAME[item] ?? item} ${fmt(qty(base.storage[me], item))}`).join(' · ');
  const wards = new Set([...working.map(s => s.groupId), ...shipments.map(j => j.ship && st.ships[j.ship]?.groupId)]);
  const escorts = Object.values(st.groups).filter(g => g.owner === me && g.op.k === 'escort' && wards.has(g.op.group)
    && g.shipIds.some(id => own.some(s => s.id === id && econOf(s).military)));
  const groupNames = [...new Set(working.map(s => st.groups[s.groupId]?.name ?? s.groupId))].map(esc);
  const stalled = Object.values(st.groups).find(g => g.owner === me && g.op.k === 'mine' && g.op.field === f.id
    && /중단|허가 없음|미납 사용료/.test(g.status));
  const damaged = guards.some(s => s.hp < .85);
  const contract = base && Object.values(st.contracts).find(k => !k.done && k.mil?.field === f.id && k.mil.poster === me);
  return `<section class="sect strategic-field" data-strategic-field="${esc(f.id)}">
    <div class="svc"><b>전략 광구</b> · 중심 ${fmt(f.strategic.radius)}m 안의 자사 전초기지 필요</div>
    <div class="small">${base ? `<button class="btn mini" data-open="${esc(base.id)}">${esc(base.name)}</button> · ${fmt(dist(base.pos, f.pos))}m` : '인근 자사 거점 없음'}
      · <span class="${blocked ? 'warn' : 'good'}">${esc(blocked ?? '하역 가능')}</span></div>
    <div class="small">채굴 ${working.length}척${groupNames.length ? ` (${groupNames.join(' · ')})` : ''} · 현장 군함 ${guards.length}척 · 작업 호위 ${escorts.length}편대</div>
    <div data-strategic-warning class="small warn${stalled || damaged || contacts.size ? '' : ' hidden'}">${[
      stalled?.status, damaged && '현장 경비함 선체 손상', contacts.size && `센서 범위 내 적대 함대 ${contacts.size}개`,
    ].filter(Boolean).map(x => esc(String(x))).join(' · ')}</div>
    ${base ? `<div class="small">전략 원광 창고 ${esc(stock || '비어 있음')} · 반출 ${shipments.filter(j => j.carried > 0).length}건 · 대기 ${shipments.filter(j => !j.carried).length}건${shipments.length ? ` · ${esc(shipments.find(j => j.reason)?.reason ?? '')}` : ''}</div>` : ''}
    ${contract ? `<div class="small">광구 경비 의뢰 ${contract.takenBy ? '수주됨' : '게시 중'}</div>` : ''}
    ${base && !blocked && st.milV && !contract ? `<div class="row small"><label>경비 보수 <input data-field-pay type="number" min="500" max="200000" value="2000" aria-label="경비 보수" style="width:7em"> cr</label><button class="btn mini" data-field-guard="${esc(f.id)}" data-guard-station="${esc(base.id)}">15분 경비 의뢰</button></div>` : ''}
  </section>`;
}

/** field management table (HQ): every deposit this company has found, with its own observations */
export function fieldPanelHtml(st: WorldView, me: string, works: { field?: string; title: string; state: string }[]): string {
  const intel = (st as any).intel?.[me]?.fields as Record<string, FieldIntel> | undefined;
  const ids = Object.keys(intel ?? {}).filter(id => st.fields[id]);
  if (!ids.length) return '<p class="dim">발견한 미확인 광구가 없습니다. 미개척·무법 성계로 함선을 보내거나 탐사(survey)를 지시하세요.</p>';
  const ships = Object.values(st.ships).filter(s => s.owner === me);
  return `<table class="ops-table"><thead><tr><th>광구</th><th>위치</th><th>상태</th><th>발견 자원</th><th>표본</th><th>신뢰도</th><th>배정</th><th>업무</th></tr></thead><tbody>${ids.map(id => {
    const f = st.fields[id], fi = intel![id], r = fieldReport(fi), sys = sysAt(st.systems, f.pos);
    const assigned = ships.filter(s => s.task.k === 'mine' && s.task.field === id).length;
    const w = works.filter(x => x.field === id);
    return `<tr><td><b>${esc(f.name)}</b>${f.strategic ? ' <span class="tag">전략</span>' : ''}</td><td>${esc(sys?.name ?? '?')}${sys?.faction ? ` <span class="dim">${esc(FACTIONS[sys.faction]?.short ?? '')}</span>` : ''}</td>
      <td>${r.n ? '시험 채굴 중/완료' : '시험 채굴 필요'}</td><td>${r.shares.map(([k, s]) => `${esc(RES_NAME[k] ?? k)} ${pct(s)}`).join(' · ') || '-'}</td>
      <td>${fmt(r.n)}</td><td>${CONFIDENCE_NAME[r.confidence]}</td><td>${assigned}척</td><td>${w.map(x => `${esc(x.title)} (${esc(x.state)})`).join('<br>') || '-'}</td></tr>`;
  }).join('')}</tbody></table>`;
}
