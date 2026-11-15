// P13.4 law enforcement — the player's own record with the authority and the stop / pursuit state of its fleets.
// Only what the server replicates to this company is shown: its own case list and its own fleets' stop state. Guard
// positions appear only as the fleet's own sighting (`guardSeen`); undiscovered guards are never revealed.
import type { WorldView } from '../../server/protocol';
import type { WGroup } from '../../world/types';
import type { CoLaw, LawStop, LawKind } from '../../world/law';
import { itemName } from '../../world/industry';
import { sysAt } from '../../world/geom';
import { effSec } from '../../world/security';

export const lawOn = (st: WorldView) => !!(st as any).lawV;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
const LEVEL = ['없음', '감시', '수배', '고위험', '무장 위험'];
const LEVEL_NOTE = [
  '현재 수배 없음',
  '감시: 기록만 있고 출동하지 않습니다',
  '수배: 목격되면 가까운 순찰대가 정선·검문·벌금·압수',
  '고위험: 신속대응함대가 마지막 목격 지점으로 출동·추격',
  '무장 위험: 정선 요구 없이 강제 진압',
];
const KIND: Record<LawKind, string> = { extortion: '화물 갈취', salvage: '무단 인양', smuggling: '밀수 적발', strike: '치안 구역 선제공격', guard_attack: '경비대 공격', flee: '정선 불응·도주', resist: '정선 무장 저항' };
const HOW: Record<string, string> = { victim: '피해 신고', guard: '경비함 목격', station: '정거장 감시', inspection: '검문', combat: '교전 기록' };
const STATE: Record<string, string> = { open: '진행', probation: '보호관찰', closed: '종결', unreported: '미신고' };
const END: Record<string, string> = { paid: '벌금 완납', expired: '시효 경과', probation_done: '보호관찰 종료', lawless: '무법 구역' };
const PHASE: Record<LawStop['phase'], string> = { approach: '경비대 접근 중', demand: '정선 요구 받음', hold: '정지 — 검문 중', pursuit: '도주 중 — 추격당함', fight: '경비대와 교전', released: '종료' };

/** company panel: wanted level, jurisdiction, unpaid fines, recent reports / inspections / enforcement, pay */
export function companyLawHtml(st: WorldView, me: string): string {
  if (!lawOn(st)) return '';
  const L = (st.companies[me] as any)?.law as CoLaw | undefined;
  const lv = L?.level ?? 0;
  const sysName = (id: string) => esc((st.systems as any)[id]?.name ?? id);
  const rows = (L?.cases ?? []).map(c => `<tr><td>${esc(KIND[c.kind] ?? c.kind)}</td><td>${sysName(c.sys)}<br><span class="dim">${c.auth ? '연합 보안국' : `기록만 (${esc(c.juris ?? '무법')})`}</span></td><td>${esc(c.how ? HOW[c.how] ?? c.how : '')}</td>
    <td>${c.fine ? `${fmt(c.paid)}/${fmt(c.fine)}` : '—'}</td><td>${esc(STATE[c.state] ?? c.state)}${c.end ? ` · ${esc(END[c.end] ?? c.end)}` : ''}${c.served && c.state === 'open' ? ' · 집행됨' : ''}${c.state === 'probation' && c.until ? `<br><span class="dim">~${Math.max(0, Math.round((c.until - st.time) / 60))}분</span>` : ''}</td></tr>`).join('');
  return `<h3 class="ops-h3">치안 기록 (연합 보안국)</h3><div class="proc-policy-form law-panel" data-law-panel>
    <div class="proc-policy-status"><span>수배 등급<b class="${lv >= 3 ? 'warn' : lv >= 2 ? 'warn' : ''}" data-law-level="${lv}">${LEVEL[lv]}</b></span><span>점수<b>${L?.score ?? 0}</b></span><span>미납 벌금<b class="${(L?.unpaid ?? 0) > 0 ? 'warn' : ''}" data-law-unpaid="${L?.unpaid ?? 0}">${fmt(L?.unpaid ?? 0)} cr</b></span></div>
    <div class="dim small">${LEVEL_NOTE[lv]}. 관할: 연합 경비대가 주둔한 성계(주둔 정거장이 있는 치안 15 이상)에서만 집행합니다. 그 밖의 세력 영역은 기록만, 무법·미개척 구역은 수배가 생기지 않습니다.
      경범죄는 시간이 지나면 등급이 내려가지만 미납 벌금은 사라지지 않습니다(감시 등급 유지). 선제공격·경비대 공격·무장 저항은 납부 후 보호관찰 기간이 지나야 해제됩니다.</div>
    ${(L?.unpaid ?? 0) > 0 ? `<div class="row"><button class="btn go" data-a="lawpay" title="치안 구역 공공 정거장 근처(4km)에 자사 함선이 있거나, 정선 중인 편대가 있으면 납부할 수 있습니다. 입항이 거부된 상태에서도 접근만으로 납부 가능합니다.">벌금 납부 (${fmt(L!.unpaid)} cr)</button></div>` : ''}
    ${rows ? `<div class="ops-table-wrap"><table class="ops-table law-cases"><thead><tr><th>사건</th><th>장소·관할</th><th>인지</th><th>벌금</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="dim">당국에 알려진 사건이 없습니다.</p>'}
    ${L?.pursuits?.length ? `<p class="warn small">진행 중인 단속: ${L.pursuits.map(p => `${esc((st.groups as any)[p.group]?.name ?? p.group)} — ${PHASE[p.phase]}`).join(', ')}</p>` : ''}
  </div>`;
}

/** fleet panel: the stop demand / pursuit this fleet is under and the answers it can give */
export function groupLawHtml(st: WorldView, g: WGroup): string {
  if (!lawOn(st)) return '';
  const s = g.lawStop;
  if (!s) return '';
  const left = s.answerBy !== undefined ? Math.max(0, Math.ceil(s.answerBy - st.time)) : undefined;
  const seen = s.guardSeen ? `마지막 확인: ${Math.max(0, Math.round(st.time - s.guardSeen.t))}초 전` : '경비대 위치 미확인';
  const can = s.phase === 'demand' || s.phase === 'approach' || s.phase === 'pursuit' || s.phase === 'hold';
  const btn = (k: string, label: string, cls = '', title = '') => `<button class="btn mini${cls}" data-law="${k}" data-law-group="${g.id}" title="${title}">${label}</button>`;
  return `<div class="bdr small law-stop law-${s.phase}" data-law-stop="${s.phase}">
    <div><span class="tag ${s.phase === 'released' ? '' : 'ov'}">연합 보안국</span> <b>${PHASE[s.phase]}</b> — ${esc(s.guardName)} <span class="dim">(수배 등급 ${LEVEL[s.level] ?? s.level} · ${seen})</span></div>
    ${s.phase === 'demand' ? `<div class="warn">정선 요구: ${left}초 안에 선택하세요. 응답이 없으면 협조로 처리됩니다(정지·검문). 정선 지점에서 멀리 벗어나면 도주로 기록됩니다.</div>` : ''}
    ${s.note ? `<div class="dim">${esc(s.note)}${s.end ? '' : ''}</div>` : ''}
    ${can ? `<div class="row">${s.phase === 'demand' || s.phase === 'pursuit' ? btn('comply', '협조 (정지·검문)', ' go', '정지해 검문을 받습니다. 불법 화물은 압수되고 미납 벌금이 잔액에서 납부됩니다.') : ''}${s.phase === 'demand' || s.phase === 'hold' ? btn('flee', '도주', '', '정선 불응·도주 사건이 기록되고 경비대가 실제 속도로 추격합니다. 관할을 벗어나거나 시야에서 사라지면 추격이 끝납니다.') : ''}${btn('resist', '저항 (교전)', ' danger', '무장 저항 사건이 기록되고 이 편대와 경비대 사이에 실제 전투가 벌어집니다. 경비대에 피해를 주면 경비대 공격으로 추가 기록됩니다.')}</div>` : ''}
  </div>`;
}

/** fleet panel: seized goods held on site (no customs station in that system) that this fleet can collect now */
export function heldLotsHtml(st: WorldView, me: string, g: WGroup): string {
  if (!lawOn(st)) return '';
  const lots = ((st.companies[me] as any)?.bm?.customs ?? []).filter((l: any) => !l.station && l.pos);
  if (!lots.length) return '';
  const ships = g.shipIds.map(id => (st.ships as any)[id]).filter((x: any) => x && x.state === 'space' && x.pos);
  const rows: string[] = [];
  for (const l of lots) {
    const s = ships.find((x: any) => Math.hypot(x.pos.x - l.pos.x, x.pos.y - l.pos.y, x.pos.z - l.pos.z) <= 3000);
    if (!s) continue;
    rows.push(`<div class="row"><span>${esc(itemName(l.item))} ${fmt(l.n)} — ${esc((st.systems as any)[l.sys]?.name ?? l.sys)} 현장 보관</span><button class="btn mini" data-heldclaim="${l.id}|${s.id}">${esc(s.name)} 화물칸으로 인수</button></div>`);
  }
  return rows.length ? `<div class="bdr small law-held"><b>압수 지점 현장 보관 화물</b>${rows.join('')}</div>` : '';
}

/** system bar: is this an enforcement area (public — garrisoned stations are visible to everyone), how risky it is for
 *  this company right now, and which of its own fleets are being stopped or chased here. Guard ships themselves are
 *  only what the map already shows (fog rules unchanged). */
export function sysLawBadge(st: WorldView, me: string, sysId: string): string {
  if (!lawOn(st)) return '';
  const sys = (st.systems as any)[sysId]; if (!sys) return '';
  const lawless = effSec(sys) < 15 || sys.faction === 'pirates' || sys.region === 'lawless' || sys.region === 'uncharted';
  const policed = !lawless && sys.security >= 15 && Object.values(st.stations as any).some((x: any) => x.public && (x.garrison ?? 0) > 0 && sysAt(st.systems as any, x.pos)?.id === sysId);
  const lv = ((st.companies[me] as any)?.law as CoLaw | undefined)?.level ?? 0;
  const mine = Object.values(st.groups as any).filter((g: any) => g.owner === me && g.lawStop && g.lawStop.phase !== 'released' && g.shipIds.some((id: string) => { const x = (st.ships as any)[id]; return x?.pos && sysAt(st.systems as any, x.pos)?.id === sysId; })) as WGroup[];
  const tag = lawless ? '<span class="dim law-badge" data-law-area="none" title="무법·미개척 구역: 연합 보안국 관할이 아니며 수배가 생기지 않습니다">무법 구역</span>'
    : policed ? `<span class="${lv >= 2 ? 'warn' : 'dim'} law-badge" data-law-area="policed" title="연합 경비대 주둔 성계 — 범죄가 목격·신고되면 수배되고, 수배 중이면 순찰대·신속대응함대가 출동합니다${lv >= 2 ? ` (현재 수배 등급: ${LEVEL[lv]})` : ''}">치안 집행${lv >= 2 ? ' · 단속 위험' : ''}</span>`
    : `<span class="dim law-badge" data-law-area="record" title="세력 영역이지만 연합 경비대가 주둔하지 않음 — 범죄는 기록만 됩니다">기록 관할</span>`;
  return `${tag}${mine.length ? ` <span class="warn law-badge" data-law-pursuit title="${esc(mine.map(g => `${g.name}: ${PHASE[g.lawStop!.phase]}`).join(', '))}">⚠ 단속 ${mine.length}</span>` : ''}`;
}
