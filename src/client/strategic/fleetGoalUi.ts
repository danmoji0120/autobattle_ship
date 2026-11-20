// P17.4d: fleet goal form — lines (hull · structure · weapons / company fitting · count), assigned group, buying
// ready-made hulls, saved compositions (templates) and the estimate before ordering (D4). The rules are the server's
// (fleetPlan.normLines / fleetEstimate); the form only collects a draft and shows what the goal would do.
import type { WorldView } from '../../server/protocol';
import type { Cmd } from '../../world/sim';
import type { GoalSpec } from '../../world/operations';
import { CONTENT, hullReleased, variantsOfHull, contentAvail } from '../../content/registry';
import { fleetEstimate, normLines, type FleetLine } from '../../world/fleetPlan';
import { clientSaleHost } from './saleSearchUi';
import { itemName } from '../../world/industry';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n0 = (v: number) => Math.round(v).toLocaleString();

/** `fit`: '' = the structure's standard weapons, 'p:<preset>' = a hull preset, 'c:<id>' = a saved company fitting */
export interface FleetDraftLine { hull: string; variant: string; fit: string; count: number }
export interface FleetDraft { station: string; group: string; buy: boolean; tpl: string; lines: FleetDraftLine[] }

const buildable = () => Object.entries(CONTENT.hulls).filter(([id, h]) => hullReleased(id) && h.classId !== 'platform' && !h.dev && !h.exclusive).map(([id, h]) => ({ id, name: h.name }));
export const newLine = (hull?: string): FleetDraftLine => { const h = hull ?? buildable()[0]?.id ?? ''; return { hull: h, variant: `${h}_std`, fit: '', count: 1 }; };
export function newDraft(w: WorldView, me: string): FleetDraft {
  const own = Object.values(w.stations).find(s => s.owner === me);
  return { station: own?.id ?? '', group: '', buy: false, tpl: '', lines: [newLine()] };
}

export function toLines(d: FleetDraft): FleetLine[] {
  return d.lines.map(l => ({ hull: l.hull, variant: l.variant, count: Math.floor(l.count), ...(l.fit.startsWith('p:') ? { preset: l.fit.slice(2) } : l.fit.startsWith('c:') ? { fitPreset: l.fit.slice(2) } : {}) }));
}
export function fleetGoal(d: FleetDraft): GoalSpec {
  const ls = toLines(d), first = ls[0];
  return { k: 'fleet', station: d.station, hull: first?.hull ?? '', count: ls.reduce((a, l) => a + l.count, 0), ...(ls.length > 1 ? { lines: ls } : { variant: first?.variant, preset: first?.preset, fitPreset: first?.fitPreset }), ...(d.group ? { group: d.group } : {}), ...(d.buy ? { buy: true } : {}) };
}
export const saveTemplateCmd = (d: FleetDraft, name: string): Cmd => ({ c: 'saveFleetTemplate', name, lines: toLines(d) });

/** a template's lines back into the draft */
export function loadTemplate(w: WorldView, me: string, d: FleetDraft, id: string): boolean {
  const t = w.companies[me]?.fleetTemplates?.find(x => x.id === id); if (!t) return false;
  d.lines = t.lines.map(l => ({ hull: l.hull, variant: l.variant ?? `${l.hull}_std`, fit: l.fitPreset ? `c:${l.fitPreset}` : l.preset ? `p:${l.preset}` : '', count: l.count }));
  d.tpl = id; return true;
}

/** a `data-fl` field changed: "<index>:<field>" or "station" / "group" / "buy" */
export function fleetDraftChange(d: FleetDraft, key: string, value: string, checked: boolean) {
  if (key === 'station') d.station = value; else if (key === 'group') d.group = value; else if (key === 'buy') d.buy = checked;
  else {
    const [i, f] = key.split(':'); const l = d.lines[Number(i)]; if (!l) return;
    if (f === 'hull') { Object.assign(l, newLine(value)); } else if (f === 'variant') { l.variant = value; l.fit = ''; } else if (f === 'fit') l.fit = value; else if (f === 'count') l.count = Math.max(1, Math.min(50, Math.floor(Number(value) || 1)));
  }
}

export function fleetFormHtml(w: WorldView, me: string, d: FleetDraft): string {
  const co = w.companies[me], own = Object.values(w.stations).filter(s => s.owner === me);
  const groups = Object.values(w.groups).filter(g => g.owner === me);
  const hulls = buildable();
  const sel = (key: string, opts: { id: string; name: string }[], cur: string, empty?: string) => `<select data-keep data-fl="${key}">${empty !== undefined ? `<option value="">${esc(empty)}</option>` : ''}${opts.map(o => `<option value="${esc(o.id)}" ${o.id === cur ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
  const row = (l: FleetDraftLine, i: number) => {
    const vars = variantsOfHull(l.hull).filter(v => contentAvail(v.id, (w as { contentV?: number }).contentV)).map(v => ({ id: v.id, name: v.name + (v.blueprint !== 'common' ? ' (설계도)' : '') }));
    const fits = [...Object.values(CONTENT.presets).filter(p => p.variant === l.variant).map(p => ({ id: `p:${p.id}`, name: p.name })), ...(co?.fitPresets ?? []).filter(p => p.variant === l.variant).map(p => ({ id: `c:${p.id}`, name: `회사 · ${p.name}` }))];
    return `<tr><td>${sel(`${i}:hull`, hulls, l.hull)}</td><td>${sel(`${i}:variant`, vars, l.variant)}</td><td>${sel(`${i}:fit`, fits, l.fit, '표준 무장')}</td>
      <td><input type="number" min="1" max="50" data-fl="${i}:count" value="${l.count}" style="width:4.5em"></td>
      <td><button class="btn mini" data-a="fl-design" data-id="${esc(l.variant)}" title="함선 없이 이 구조를 피팅해 회사 피팅으로 저장">설계</button>${d.lines.length > 1 ? `<button class="btn mini warnb" data-a="fl-del" data-id="${i}" aria-label="구성 삭제">✕</button>` : ''}</td></tr>`;
  };
  const tpls = co?.fleetTemplates ?? [];
  const st = w.stations[d.station];
  const lines = normLines(w as never, co, toLines(d));
  let est = '';
  if (!own.length) est = '<p class="warn small ops-fleet-est">자사 조선소가 없어 건조 목표를 둘 수 없습니다 — 완성함은 공영 정거장의 조선소 화면에서 삽니다.</p>';
  else if (typeof lines === 'string') est = `<p class="warn">${esc(lines)}</p>`;
  else if (st) {
    const e = fleetEstimate(clientSaleHost(w) as never, me, st, lines, d.buy);
    const noYard = e.lines.filter(x => !x.yard);
    const short = e.needs.filter(n => n.short > 0);
    est = `<div class="ops-fleet-est"><table class="ops-table"><thead><tr><th>구성</th><th>척수</th><th>건조</th>${d.buy ? '<th>완성함 구매</th>' : ''}<th>착공비/척</th><th>조선소 슬롯</th></tr></thead><tbody>
      ${e.lines.map(x => `<tr><td>${esc(x.name)}</td><td>${x.count}</td><td>${x.build}</td>${d.buy ? `<td>${x.buyable ? `${x.buyable}척 · ${n0(x.buyPrice)} cr` : '<span class="dim">없음</span>'}</td>` : ''}<td>${n0(x.perHull)} cr</td><td>${x.yard || '<span class="warn">불가</span>'}</td></tr>`).join('')}</tbody></table>
      <p>착공비 합계 <b>${n0(e.buildCredits)} cr</b>${d.buy ? ` · 완성함 구매 <b>${n0(e.buyCredits)} cr</b>` : ''} · 보유 ${n0(co?.credits ?? 0)} cr</p>
      ${short.length ? `<p class="warn small">${esc(st.name)} 보관함 부족: ${short.slice(0, 8).map(n => `${esc(itemName(n.item))} ${n0(n.short)}`).join(', ')}${short.length > 8 ? ` 외 ${short.length - 8}종` : ''} — 조달 체계가 생산·구매·운송으로 확보</p>` : e.needs.length ? '<p class="good small">필요 부품·장비가 조선소 보관함에 있습니다</p>' : ''}
      ${noYard.length ? `<p class="warn small">${esc(st.name)}에서 건조할 수 없는 선체: ${noYard.map(x => esc(x.name)).join(', ')}</p>` : ''}</div>`;
  }
  return `<div class="ops-fleet-form">
    <div class="proc-policy-grid"><label>조선소${sel('station', own.map(s => ({ id: s.id, name: s.name })), d.station)}</label>
      <label>진수 후 배속 편대${sel('group', groups.map(g => ({ id: g.id, name: g.name })), d.group, '새 편대 (자동)')}</label>
      <label class="ops-check"><input type="checkbox" data-fl="buy" ${d.buy ? 'checked' : ''}> 공영 조선소 재고는 완성함으로 구매</label></div>
    <div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>선체</th><th>구조</th><th>무장·피팅</th><th>척수</th><th></th></tr></thead><tbody>${d.lines.map(row).join('')}</tbody></table></div>
    <p><button class="btn mini" data-a="fl-add">+ 구성 추가</button>
      ${tpls.length ? `<select data-keep data-fl-tpl><option value="">저장한 구성 불러오기</option>${tpls.map(t => `<option value="${esc(t.id)}" ${t.id === d.tpl ? 'selected' : ''}>${esc(t.name)} (${t.lines.reduce((a, l) => a + l.count, 0)}척)</option>`).join('')}</select>${d.tpl ? `<button class="btn mini warnb" data-a="fl-tpl-del" data-id="${esc(d.tpl)}">구성 삭제</button>` : ''}` : ''}
      <input data-fl-tplname placeholder="구성 이름" maxlength="24" style="width:9em"><button class="btn mini" data-a="fl-tpl-save">구성 저장</button></p>
    ${est}
    <p class="dim small">장교 배정과 출격은 진수 후 따로 지시합니다.</p></div>`;
}
