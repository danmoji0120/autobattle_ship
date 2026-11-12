// P10 client views: territory info, unidentified deposits (from the company's own samples only),
// and the field-management table. Everything here reads what the server replicated to this
// company; nothing is inferred from hidden data (the server never sends it).
import type { WorldView } from '../../server/protocol';
import type { Field, StarSystem } from '../../world/types';
import { FACTIONS, REGION_RULES } from '../../world/territory';
import { fieldReport, CONFIDENCE_NAME, type FieldIntel } from '../../world/intel';
import { GEO_SIZE_NAME, type GeoSize } from '../../world/geology';
import { RES_NAME } from '../../world/data';
import { sysAt } from '../../world/geom';
import { doctrineOf } from '../../world/factionEcon';

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
    ${rel.length ? `<p class="dim small">관계: ${rel.map(([k, v]) => `${esc(FACTIONS[k].short)} ${Math.round(v)}`).join(' · ')}</p>` : ''}
    ${wars.length ? wars.map(c => `<p class="warn small">분쟁 중: ${esc(FACTIONS[c.a].short)}–${esc(FACTIONS[c.b].short)} · 관문 ${c.gates.length / 2}곳 봉쇄</p>`).join('') : ''}</section>`;
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
    return `<tr><td><b>${esc(f.name)}</b></td><td>${esc(sys?.name ?? '?')}${sys?.faction ? ` <span class="dim">${esc(FACTIONS[sys.faction]?.short ?? '')}</span>` : ''}</td>
      <td>${r.n ? '시험 채굴 중/완료' : '시험 채굴 필요'}</td><td>${r.shares.map(([k, s]) => `${esc(RES_NAME[k] ?? k)} ${pct(s)}`).join(' · ') || '-'}</td>
      <td>${fmt(r.n)}</td><td>${CONFIDENCE_NAME[r.confidence]}</td><td>${assigned}척</td><td>${w.map(x => `${esc(x.title)} (${esc(x.state)})`).join('<br>') || '-'}</td></tr>`;
  }).join('')}</tbody></table>`;
}
