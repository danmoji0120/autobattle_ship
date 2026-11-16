// P14.0 reputation panel (company HQ → 평판·관계): company credit, the six faction trusts, their bands, what the
// next band needs, what each trust unlocks now and what stays locked (with the exact requirement), recent changes.
// Pure HTML from the replicated state; the rules are the shared ones in world/reputation.ts and world/blueprints.ts.
import type { WorldView } from '../../server/protocol';
import type { Company, WorldState } from '../../world/types';
import { CONTENT } from '../../content/registry';
import { FACTIONS } from '../../world/territory';
import { REP, CREDIT, bandOf, nextReq, gainLimit, valueOf, repNeed, fmtRep, FACTION_WEIGHT, graceHas } from '../../world/reputation';
import { yardHulls, hullSale, hullEcon } from '../../world/hullops';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const SRC_KO: Record<string, string> = { trade: '시장 공급', delivery: '납품 계약', bounty: '현상금 계약', kill: '해적 격침', lair: '해적 거점 파괴', lair_contract: '토벌 계약', blackmarket: '암시장 거래' };
const LIKES: Record<string, string> = {
  union: '해적 토벌·현상금, 합법 계약, 장비·무장 공급 — 치안 질서를 중시합니다',
  guild: '교역·납품 계약, 시장 공급 전반 — 물류와 거래를 중시합니다',
  ceres: '원자재·정제 소재 납품과 공급 — 산업 공급망을 중시합니다',
  miners: '기계부품·화학소재 공급, 광구 주변 해적 소탕 — 채굴 지원을 중시합니다',
  iron: '군사 작전, 국경 해적 소탕, 장갑판·무장 부품 공급 — 국경 방위를 중시합니다',
  pirates: '해적 시장 공급, 해적 정거장 계약, 암시장 거래 — 범죄 자체로는 오르지 않습니다',
};
const bar = (v: number, lo: number) => {
  const pct = Math.max(0, Math.min(100, (v - lo) / (100 - lo) * 100)), zero = lo < 0 ? (0 - lo) / (100 - lo) * 100 : 0;
  return `<span class="rep-bar" aria-hidden="true"><i class="rep-zero" style="left:${zero}%"></i><b class="${v < 0 ? 'neg' : ''}" style="width:${pct}%"></b></span>`;
};

interface Item { key: string; label: string; need: number; contracts?: number; where: string }
/** what a faction sells (blueprints at its stations, military hulls at its yards), with the trust each needs */
function factionItems(w: WorldState, f: string): Item[] {
  const out: Item[] = [];
  const held = new Set(Object.values(w.stations).filter(s => s.public && s.faction === f).map(s => s.id));
  for (const bp of Object.values(CONTENT.blueprints)) for (const s of bp.sources) {
    if (s.kind !== 'faction' || s.faction !== f) continue;
    const at = s.stations.filter(x => held.has(x)); if (!at.length) continue;
    out.push({ key: `bp:${bp.id}`, label: bp.name, need: s.trust ?? repNeed(s.rep), contracts: s.contracts, where: at.map(x => w.stations[x]?.name ?? x).join(', ') });
    break;
  }
  const seen = new Set<string>();
  for (const id of held) for (const h of yardHulls(w.stations[id])) {
    if (seen.has(h) || !hullEcon(h).military) continue; seen.add(h);
    const need = repNeed(hullSale(h)?.rep); if (need <= 0) continue;
    out.push({ key: `hull:${h}`, label: `${CONTENT.hulls[h]?.name ?? h} (완성 함선)`, need, where: w.stations[id]?.name ?? id });
  }
  return out.sort((a, b) => a.need - b.need || a.label.localeCompare(b.label));
}

function reqLine(w: WorldState, co: Company, s: string): string {
  const v = valueOf(co, s);
  const nb = REP.bands.find(b => b.min > v);
  if (!nb) return '<span class="dim">최고 단계</span>';
  const r = nextReq(w, co, s);
  if (!r || r.at !== nb.min) return `<span class="dim">다음 단계 ${esc(nb.name)}: ${fmtRep(v)} / ${nb.min}</span>`;
  const part = (ok: boolean, t: string) => `<span class="${ok ? 'good' : 'warn'}">${t}</span>`;
  return `<span class="dim">다음 단계 ${esc(r.band)} (${r.at}) 조건:</span> ${part(r.contracts[0] >= r.contracts[1], `계약 ${r.contracts[0]}/${r.contracts[1]}건`)} · ${part(r.hours[0] >= r.hours[1], `관계 ${r.hours[0]}/${r.hours[1]}시간`)}${r.majors[1] ? ` · ${part(r.majors[0] >= r.majors[1], `주요 작전 ${r.majors[0]}/${r.majors[1]}회`)}` : ''}${r.ok ? '' : ` <span class="dim">— 조건 전까지 ${fmtRep(gainLimit(w, co, s, v))}에서 멈춥니다</span>`}`;
}

export function companyRepHtml(view: WorldView, me: string): string {
  const w = view as unknown as WorldState, co = w.companies[me];
  if (!co) return '';
  if (!w.repV) {
    const st = co.standing ?? {};
    return `<h3 class="ops-h3">평판 (기존 규칙)</h3><div class="proc-policy-form" data-rep-panel="legacy">
      <div class="proc-policy-status"><span>연합 평판<b data-rep-credit="${co.rep}">${Math.floor(co.rep)}</b></span></div>
      <p class="dim small">이 월드는 기존 평판 규칙을 사용합니다: 연합 평판 하나로 공영 조선소 군함·상업/세력 설계도를 판정합니다.${w.factions ? ' 세력 평판은 −25 미만이면 해당 세력 시장 정박·설립이 거부됩니다.' : ''}</p>
      ${w.factions ? `<div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>세력</th><th>평판</th></tr></thead><tbody>${Object.keys(w.factions).map(f => `<tr><td>${esc(FACTIONS[f]?.name ?? f)}</td><td>${fmtRep(st[f] ?? 0)}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
  }
  const R = co.repx;
  const credit = co.rep;
  const grudge = (s: string) => (R?.acc[s]?.gr ?? 0) > w.time ? `<span class="warn small" title="중대 범죄 이후 이 기간에는 신뢰 상승이 크게 줄어듭니다">불신 기간 ${Math.ceil(((R!.acc[s].gr ?? 0) - w.time) / 60)}분</span>` : '';
  const grace = R?.grand && R.grand.until > w.time ? `<p class="warn small" data-rep-grace>전환 유예: 이전 규칙에서 구매할 수 있던 항목 ${R.grand.keys.length}개는 ${Math.ceil((R.grand.until - w.time) / 3600)}시간(게임 시간) 동안 계속 구매할 수 있습니다.</p>` : '';
  const rows = w.factions ? Object.keys(w.factions).map(f => {
    const v = co.standing?.[f] ?? 0, b = bandOf(v);
    const items = factionItems(w, f);
    const open = items.filter(i => v >= i.need && (!i.contracts || (R?.acc[f]?.k ?? 0) >= i.contracts));
    const locked = items.filter(i => !open.includes(i));
    const next = locked[0];
    const lockTxt = (i: Item) => `${esc(i.label)} — ${esc(FACTIONS[f]?.short ?? f)} 신뢰도 <b class="${v >= i.need ? 'good' : 'warn'}">${fmtRep(v)} / ${fmtRep(i.need)}</b>${i.contracts ? ` · 계약 <b class="${(R?.acc[f]?.k ?? 0) >= i.contracts ? 'good' : 'warn'}">${R?.acc[f]?.k ?? 0} / ${i.contracts}건</b>` : ''} <span class="dim">(${esc(i.where)})</span>${graceHas(w, co, i.key) ? ' <span class="good">전환 유예 중</span>' : ''}`;
    const pers = FACTION_WEIGHT[f] ?? {};
    const top = Object.entries(pers).filter(([, x]) => (x ?? 0) >= 1.2).map(([k]) => SRC_KO[k] ?? k);
    return `<tr data-rep-faction="${f}" data-rep-value="${v}"><td><b style="color:${FACTIONS[f]?.color ?? 'inherit'}">${esc(FACTIONS[f]?.name ?? f)}</b><br><span class="dim small">${esc(LIKES[f] ?? '')}</span></td>
      <td class="rep-val"><b>${fmtRep(v)}</b> ${bar(v, -100)}<span class="rep-band${v < 0 ? ' warn' : ''}" data-rep-band="${esc(b.name)}">${esc(b.name)}</span>${grudge(f)}<br>${reqLine(w, co, f)}${top.length ? `<br><span class="dim small">특히 높이 평가: ${top.map(esc).join(', ')}</span>` : ''}</td>
      <td class="small">${open.length ? `<div class="good">해금: ${open.map(i => esc(i.label)).join(', ')}</div>` : '<div class="dim">아직 해금된 세력 전용 품목 없음</div>'}
        ${next ? `<div data-rep-next>다음 혜택: ${lockTxt(next)}</div>` : ''}
        ${locked.length > 1 ? `<details><summary class="dim">잠긴 품목 ${locked.length}개</summary>${locked.map(i => `<div data-rep-locked>${lockTxt(i)}</div>`).join('')}</details>` : ''}
        ${f === 'pirates' || v >= -25 ? '' : '<div class="warn">관계 악화: 이 세력 시장 정박·정거장 설립이 거부됩니다</div>'}</td></tr>`;
  }).join('') : '';
  const log = (R?.log ?? []).slice(-14).reverse().map(l => `<tr><td>${esc(l.s === CREDIT ? '회사 신용도' : FACTIONS[l.s]?.short ?? l.s)}</td><td class="${l.d < 0 ? 'warn' : 'good'}">${l.d > 0 ? '+' : ''}${l.d.toFixed(2)}</td><td>${esc(l.why)}</td><td class="dim">${Math.floor(l.t / 3600)}h ${Math.floor(l.t % 3600 / 60)}m</td></tr>`).join('');
  return `<h3 class="ops-h3">평판·관계</h3><div class="proc-policy-form rep-panel" data-rep-panel="p14">
    <div class="proc-policy-status"><span>회사 신용도<b data-rep-credit="${credit}">${fmtRep(credit)}</b></span><span>단계<b>${esc(bandOf(credit).name)}</b></span>${grudge(CREDIT)}</div>
    <div class="small">${bar(credit, 0)} ${reqLine(w, co, CREDIT)}</div>
    <p class="dim small">회사 신용도는 합법적인 계약 이행·해적 토벌·정상 거래로 쌓이는 공적 신용입니다(상업 라이선스 설계도, 민간선 구매). 세력 신뢰도는 세력마다 따로 쌓이며 다른 세력으로 옮겨가지 않습니다 — 그 세력의 영토에서 그 세력이 원하는 일을 해야 오릅니다. 영향력은 영토 지배력일 뿐 신뢰가 아닙니다.
      같은 일을 반복하면 시간당 한도와 단계별 감소가 적용되고, 일상 업무(교역 ${REP.ceiling.trade}, 납품·현상금 ${REP.ceiling.delivery})만으로는 그 이상 오르지 않습니다. 신뢰 40·60·80 단계에는 그 세력 계약 실적, 관계 기간, 주요 작전(등급 3 이상 해적 거점 파괴) 기록이 필요합니다. 범죄는 그 성계를 지배하는 세력의 신뢰와 신용도를 한 번씩 깎고, 중대 범죄가 반복되면 차감이 커지고 한동안 회복이 느려집니다.</p>
    ${grace}
    ${rows ? `<div class="ops-table-wrap"><table class="ops-table rep-table"><thead><tr><th>세력</th><th>신뢰도 · 관계</th><th>혜택</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="dim small">이 월드에는 영토 세력이 없습니다 — 회사 신용도가 공영 조선소 군함과 세력 설계도 판정을 맡습니다.</p>'}
    <h4>최근 변동</h4>${log ? `<div class="ops-table-wrap"><table class="ops-table rep-log"><thead><tr><th>대상</th><th>변화</th><th>사유</th><th>시각</th></tr></thead><tbody>${log}</tbody></table></div>` : '<p class="dim">아직 변동이 없습니다.</p>'}
  </div>`;
}
