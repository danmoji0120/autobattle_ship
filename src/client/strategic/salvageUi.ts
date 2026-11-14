// P13.1 battlefield wrecks in the strategic HUD (salvageV worlds only): map label, wreck info panel with
// recover / zone-salvage orders, and the fleet panel's salvage section (automatic pickup toggle, current
// phase, stop / return). All numbers are what the server sent; the server re-validates every order.
import type { WorldView } from '../../server/protocol';
import type { WGroup } from '../../world/types';
import type { WreckLot, WreckSource, WreckView } from '../../world/wrecks';
import { itemLabel } from '../../world/wrecks';
import { SALV_PHASE } from '../../world/salvage';
import { coRelation } from '../../world/battleAuth';
import { SHIP_CLASSES } from '../../sim/data/ships';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
const KIND: Record<WreckLot['k'], string> = { cargo: '화물', equip: '장비', hull: '선체 고철', frag: '설계도 조각' };
const SIZE = ['', '소형', '중형', '대형'];

export const wrecksOf = (st: WorldView): WreckView[] => Object.values(((st as any).wrecks ?? {}) as Record<string, WreckView>);
export const wreckOf = (st: WorldView, id: string): WreckView | undefined => ((st as any).wrecks ?? {})[id];
export const salvageOn = (st: WorldView) => !!(st as any).salvageV;
const minutes = (st: WorldView, w: WreckView) => Math.max(0, Math.round((w.expires - st.time) / 60));

/** map label text + sub line */
export function wreckLabel(st: WorldView, w: WreckView): { text: string; sub: string } {
  const left = w.left !== undefined ? `잔여 ${fmt(w.left)}` : '내용 미확인';
  return { text: `✕ ${w.name}`, sub: `${SIZE[w.size]} · 격침 ${w.ships}척 · ${left} · ${minutes(st, w)}분` };
}

/** can the viewer take this lot without an explicit unauthorised order (mirror of the server rule) */
function legal(st: WorldView, me: string, l: WreckLot): boolean {
  if (l.k !== 'cargo' || l.owner === me) return true;
  const o = st.companies[l.owner];
  if (!o || o.kind === 'pirate' || l.owner === 'pirates') return true;
  return coRelation(st as any, me, l.owner) === -1;
}

export function wreckInfoHtml(st: WorldView, me: string, w: WreckView, group: WGroup | null): string {
  const coName = (id: string) => esc(st.companies[id]?.name ?? (id === 'pirates' ? '해적' : id === 'union' ? '연합군' : id));
  const sys = st.systems[w.system]?.name ?? '';
  const risk = (st.systems[w.system] as any)?.security !== undefined ? Math.round((st.systems[w.system] as any).security) : null;
  const lots = (w.lots ?? []).filter(l => l.n >= 1);
  const rows = lots.length ? lots.sort((a, b) => a.k.localeCompare(b.k) || b.n - a.n).map(l => `<tr><td>${KIND[l.k]}</td><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.n)}</td><td>${coName(l.owner)}${legal(st, me, l) ? '' : ' <span class="warn" title="중립·우호 회사의 화물 — 명시적 무단 회수 명령만 가져갑니다. 치안 구역에서는 평판이 떨어집니다.">보호</span>'}</td></tr>`).join('') : '';
  const srcs = (w.sources ?? []).reduce((m: Record<string, number>, s: WreckSource) => { const k = `${s.owner}|${s.classId}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const mine = w.taken?.[me] ? Object.entries(w.taken[me]).map(([k, n]) => `${esc(itemLabel(k))} ${fmt(n)}`).join(', ') : '';
  const prot = lots.some(l => !legal(st, me, l));
  const zone = (r: number) => JSON.stringify({ k: 'salvzone', at: w.pos, radius: r });
  return `<div class="info wreck-info"><div class="ih"><b style="color:#e8c070">✕ ${esc(w.name)}</b></div>
    <div class="dim">${esc(sys)} · ${SIZE[w.size]} 잔해장 · 격침 ${w.ships}척 · ${minutes(st, w)}분 후 소멸${risk !== null ? ` · 치안 ${risk}` : ''}</div>
    ${w.known ? `<div class="small">출처: ${Object.entries(srcs).map(([k, n]) => { const [o, c] = k.split('|'); return `${coName(o)} ${SHIP_CLASSES[c]?.name ?? c}×${n}`; }).join(', ')}</div>
      <div class="dim small">회수 진행 ${w.initial ? Math.round((1 - (w.left ?? 0) / w.initial) * 100) : 0}% (잔여 ${fmt(w.left ?? 0)} / ${fmt(w.initial)})${mine ? ` · 자사 회수: ${mine}` : ''}</div>
      ${rows ? `<table class="tbl small wreck-lots"><tr><th>종류</th><th>품목</th><th>수량</th><th>원소유</th></tr>${rows}</table>` : '<div class="dim">회수 가능한 물품이 남지 않았습니다.</div>'}`
    : '<div class="dim">아직 내용을 모릅니다 — 함선이 가까이 가면(약 8km) 남은 화물·장비가 보입니다.</div>'}
    <div class="dim small">화물은 수송선, 선체 고철은 채굴선·공작선, 장비·조각은 공작선이 잘 회수합니다. 군함은 소량의 화물·장비만 싣습니다. 회수물은 정거장에 정박해 하역해야 창고에 들어갑니다.</div>
    ${group ? `<div class="row"><button class="btn" data-salv-recover="${w.id}">선택 편대로 인양</button><button class="btn" data-quick='${zone(3000)}'>이 지점 구역 인양 (3km)</button>${prot ? `<button class="btn danger" data-salv-illegal="${w.id}" title="보호된 화물까지 가져갑니다. 치안 구역에서는 평판·세력 우호도가 떨어지고 소유 회사에 통보됩니다.">무단 회수 포함</button>` : ''}</div>`
      : '<div class="dim">편대를 선택하고 잔해를 우클릭하면 인양을 지시합니다.</div>'}</div>`;
}

/** fleet panel: automatic pickup toggle, current salvage phase, stop / return */
export function groupSalvageHtml(st: WorldView, g: WGroup): string {
  const S = g.salv;
  const auto = g.autoSalvage !== false;
  const phase = S ? `<span class="tag ov">${S.mode === 'auto' ? '현장 인양' : S.mode === 'zone' ? '구역 인양' : '지정 인양'}</span> ${SALV_PHASE[S.phase]}${S.why ? ` — ${esc(S.why)}` : ''}` : '';
  const active = g.op.k === 'recover' || g.op.k === 'salvzone' || !!S;
  return `<div class="bdr small salv-panel">
    <label class="chk" title="전투가 끝난 뒤 대기·방어·순찰 중인 편대가 근처(3km) 잔해에서 합법적인 물품만 최대 10분간 회수합니다. 적대 함대가 가까우면 하지 않습니다."><input type="checkbox" data-salv-auto="${g.id}" ${auto ? 'checked' : ''}> 현장 자동 인양</label>
    ${phase ? `<div class="salv-state">${phase}</div>` : ''}
    ${active ? `<div class="row"><button class="btn mini" data-quick='{"k":"idle"}'>인양 중지</button>${st.opsV ? `<button class="btn mini" data-quick='{"k":"return"}'>귀환</button>` : ''}</div>` : ''}
  </div>`;
}
