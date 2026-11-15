// P13.2 cargo raiding in the strategic HUD (piracyV worlds only): jettisoned-cargo containers on the map and
// their info panel (recover order), the fleet panel's raid section (policy for plunder orders, what the raid
// is doing) and the victim response policy (group override / company default). The server re-validates
// every order; numbers shown are what the server sent this viewer.
import type { WorldView } from '../../server/protocol';
import type { WGroup } from '../../world/types';
import type { DropView, PlunderPolicy, VictimPolicy } from '../../world/piracy';
import { POLICY_NAME, PLUNDER_NAME } from '../../world/piracy';
import { itemLabel } from '../../world/wrecks';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();

export const piracyOn = (st: WorldView) => !!(st as any).piracyV;
export const dropsOf = (st: WorldView): DropView[] => Object.values(((st as any).drops ?? {}) as Record<string, DropView>);
export const dropOf = (st: WorldView, id: string): DropView | undefined => ((st as any).drops ?? {})[id];
const minutes = (st: WorldView, d: DropView) => Math.max(0, Math.round((d.expires - st.time) / 60));
const coName = (st: WorldView, id: string) => st.companies[id]?.name ?? (id === 'pirates' ? '해적' : id);

/** map label (◈, cyan — distinct from the amber ✕ of a wreck) */
export function dropLabel(st: WorldView, d: DropView): { text: string; sub: string } {
  return { text: `◈ ${d.name}`, sub: `투하 화물 · 잔여 ${fmt(d.left)} · ${minutes(st, d)}분` };
}

const PHASE: Record<string, string> = { search: '목표 탐색', intercept: '요격·접근', wait: '상대 버팀 — 대기', collect: '약탈품 회수 중', force: '무력 사용', loot: '전장 잔해 인양', home: '귀환', done: '종료' };

export function dropInfoHtml(st: WorldView, me: string, d: DropView, group: WGroup | null): string {
  const sys = st.systems[d.system]?.name ?? '';
  const lots = d.lots.filter(l => l.n >= 1).sort((a, b) => b.n - a.n);
  const mine = d.taken?.[me] ? Object.entries(d.taken[me]).map(([k, n]) => `${esc(itemLabel(k))} ${fmt(n)}`).join(', ') : '';
  const own = d.owner === me, mineRaid = d.by === me;
  // who may take it without an explicit unauthorised order: its owner, the company it was dropped for, or anyone hostile to the owner
  const legal = own || mineRaid || st.companies[d.owner]?.kind === 'pirate';
  const rows = lots.map(l => `<tr><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.n)}</td></tr>`).join('');
  return `<div class="info drop-info"><div class="ih"><b style="color:#5fe0d0">◈ ${esc(d.name)}</b></div>
    <div class="dim">${esc(sys)} · 위치 ${Math.round(d.pos.x)}, ${Math.round(d.pos.z)} · 투하 ${Math.max(0, Math.round((st.time - d.created) / 60))}분 전 · ${minutes(st, d)}분 후 소멸</div>
    <div class="small">원소유 <b>${esc(coName(st, d.owner))}</b>${own ? ' (자사)' : ''} · 요구 측 <b>${esc(coName(st, d.by))}</b>${mineRaid ? ' (자사)' : ''}</div>
    <div class="dim small">잔여 ${fmt(d.left)} / ${fmt(d.initial)}${mine ? ` · 자사 회수: ${mine}` : ''}</div>
    ${rows ? `<table class="tbl small wreck-lots"><tr><th>품목</th><th>수량</th></tr>${rows}</table>` : '<div class="dim">남은 화물이 없습니다.</div>'}
    <div class="dim small">투하된 화물은 실제로 회수해 정거장에 하역해야 소유가 넘어갑니다. 수송선이 가장 빨리 싣습니다. 소멸 시각까지 남은 화물은 사라집니다.</div>
    ${group ? `<div class="row"><button class="btn" data-salv-recover="${d.id}">${legal ? '선택 편대로 회수' : '선택 편대로 회수 (합법분만)'}</button>${legal ? '' : `<button class="btn danger" data-salv-illegal="${d.id}" title="중립·우호 회사의 화물을 가져갑니다. 치안 구역에서는 평판·세력 우호도가 떨어지고 소유 회사에 통보됩니다.">무단 회수</button>`}</div>`
      : '<div class="dim">편대를 선택하고 컨테이너를 우클릭하면 회수를 지시합니다.</div>'}</div>`;
}

/** fleet panel: plunder policy for the next plunder order, raid state, and the victim response policy */
export function groupPiracyHtml(st: WorldView, me: string, g: WGroup, plunder: PlunderPolicy, neutral: boolean, hasMil: boolean): string {
  const co = st.companies[me] as any;
  const def: VictimPolicy = co?.piracyPolicy ?? 'balanced';
  const pol = g.piracyPolicy;
  const P = g.plx;
  const op = g.op;
  const cur = op.k === 'plunder' ? op.policy : op.k === 'harass' ? op.plunder : undefined;
  const tgt = P?.target ? st.groups[P.target] : op.k === 'plunder' && op.group ? st.groups[op.group] : undefined;
  return `<div class="bdr small pir-panel">
    ${hasMil ? `<div class="pir-row"><span class="pir-l">약탈 방식</span><span class="pir-seg">${(Object.keys(PLUNDER_NAME) as PlunderPolicy[]).map(k => `<button class="btn mini${plunder === k ? ' on' : ''}${k === 'destroy' ? ' danger' : ''}" data-pir-plunder="${k}">${PLUNDER_NAME[k]}</button>`).join('')}</span></div>
    <div class="pir-row"><button class="btn" data-op="plunder" title="다른 회사 편대를 클릭: 화물 투하를 요구하고 투하된 컨테이너를 회수합니다">대상 약탈</button><button class="btn" data-op="plunder_lane" title="항로 지점을 클릭: 반경 3km를 순회하며 지나는 화물선에 요구합니다">항로 약탈</button>
      <label class="chk" title="중립 회사도 대상으로 삼습니다. 치안 구역에서는 갈취로 평판이 떨어지고, 무력을 쓰면 적대 선언으로 기록됩니다."><input type="checkbox" data-pir-neutral ${neutral ? 'checked' : ''}> 중립 포함</label></div>` : ''}
    ${cur ? `<div class="pir-state"><span class="tag ov">약탈 · ${PLUNDER_NAME[cur]}</span> ${P ? esc(PHASE[P.phase] ?? P.phase) : '준비'}${tgt ? ` — <b>${esc(tgt.name)}</b>` : ''}${P?.why ? ` <span class="dim">(${esc(P.why)})</span>` : ''}
      <div class="row"><button class="btn mini" data-quick='{"k":"idle"}'>작전 중단</button>${st.opsV ? `<button class="btn mini" data-quick='{"k":"return"}'>복귀</button>` : ''}</div></div>` : ''}
    <div class="pir-row"><span class="pir-l" title="이 편대가 화물 요구를 받았을 때의 대응. 생존 우선은 쉽게 투하하고, 화물 보호 우선은 웬만하면 버팁니다.">요구 대응</span>
      <select data-pir-policy="${g.id}"><option value="">회사 기본 (${POLICY_NAME[def]})</option>${(Object.keys(POLICY_NAME) as VictimPolicy[]).map(k => `<option value="${k}"${pol === k ? ' selected' : ''}>${POLICY_NAME[k]}</option>`).join('')}</select></div>
  </div>`;
}

/** company settings: the default response of every group without an override */
export function companyPiracyHtml(st: WorldView, me: string): string {
  if (!piracyOn(st)) return '';
  const def: VictimPolicy = (st.companies[me] as any)?.piracyPolicy ?? 'balanced';
  return `<h3 class="ops-h3">화물 요구 대응 (회사 기본)</h3><div class="proc-policy-form"><label>기본 대응 <select data-keep data-pir-default>${(Object.keys(POLICY_NAME) as VictimPolicy[]).map(k => `<option value="${k}"${def === k ? ' selected' : ''}>${POLICY_NAME[k]}</option>`).join('')}</select></label>
    <div class="dim small">무장 함대가 화물 투하를 요구할 때 편대가 따르는 기본 원칙입니다. 생존 우선: 쉽게 투하해 함선을 지킴 · 균형 대응: 전력·탈출 가능성을 따져 판단 · 화물 보호 우선: 호위가 있으면 저항. 편대 패널에서 편대별로 바꿀 수 있습니다. 직접 내린 이동·정박 명령이 자동 대응보다 우선합니다.</div></div>`;
}
