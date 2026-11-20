// P17.4b (AUD-15): what automatic work a manual order would interrupt.
//
// The engines already give a manual order priority and never take the group back on their own: a managed route
// pauses ("수동 명령 우선"), a pool shipment lets go of the ship (cargo kept aboard, the rest re-dispatched), a field
// goal pauses until the player resumes it. What was missing was saying so *before* the order — the player found
// out afterwards, if at all. This module lists, for a group (and its sub-groups that follow its order) or a single
// ship, every automatic work holding it and what the manual order does to it. The client shows it as a
// confirmation; the server writes the same list to the event log when the order is accepted, so the interruption
// is on record. Pure over the world state, so the client and the server read the same answer.
import type { WGroup, WShip, WorldState, Op } from './types';

export interface AutoHold { kind: 'route' | 'pool' | 'field' | 'mil' | 'operation'; label: string; effect: string }

const OP_LABEL: Record<string, string> = {
  mine: '채굴', haul: '수송', patrol: '순찰', escort: '호위', build: '건설 지원', salvzone: '구역 인양', recover: '잔해 인양',
  repairzone: '구역 현장 수리', repairbiz: '수리업', lootTender: '약탈 회수 지원',
};
const CONTINUOUS = new Set(['mine', 'haul', 'patrol', 'escort', 'build', 'salvzone', 'lootTender', 'repairzone', 'repairbiz']);

function shipsUnder(w: Pick<WorldState, 'groups' | 'ships'>, g: WGroup): WShip[] {
  const out: WShip[] = [];
  const walk = (x: WGroup) => { for (const id of x.shipIds) { const s = w.ships[id]; if (s) out.push(s); } for (const c of x.childIds) { const cg = w.groups[c]; if (cg && !cg.override) walk(cg); } };
  walk(g); return out;
}
function opOwner(w: Pick<WorldState, 'groups'>, g: WGroup): WGroup {
  let cur = g;
  while (!cur.override && cur.parentId && w.groups[cur.parentId]) cur = w.groups[cur.parentId];
  return cur;
}

/**
 * Automatic work a manual order on `group` (or on `ship` alone) would interrupt. `next` is the order about to be
 * given: re-issuing the operation the group already runs (e.g. a new escort focus) interrupts nothing.
 */
export function automationHolds(w: Pick<WorldState, 'groups' | 'ships' | 'logistics' | 'logisticsJobs' | 'works' | 'contracts'>, owner: string, sel: { group?: string; ship?: string }, next?: Op): AutoHold[] {
  const g = sel.group ? w.groups[sel.group] : sel.ship ? w.groups[w.ships[sel.ship]?.groupId ?? ''] : undefined;
  if (!g || g.owner !== owner) return [];
  const out: AutoHold[] = [];
  const root = opOwner(w, g), op = root.op;
  const same = !!next && next.k === op.k && (next.k !== 'haul' || (next as { route?: string }).route === (op as { route?: string }).route) && (next.k !== 'mine' || (next as { field?: string }).field === (op as { field?: string }).field);
  if (same) return [];
  const ships = sel.ship ? [w.ships[sel.ship]].filter((s): s is WShip => !!s) : shipsUnder(w, g);
  // managed routes bound to this group (or whose haul order it follows)
  for (const r of Object.values(w.logistics ?? {})) {
    if (r.owner !== owner || r.state === 'complete') continue;
    if (r.group === g.id || op.k === 'haul' && (op as { route?: string }).route === r.id) out.push({ kind: 'route', label: `정기 운송 · ${r.config.name || r.config.item}`, effect: '노선 일시정지 — 노선을 재개하면 다시 운송 명령으로 전환' });
  }
  // pool shipments carried by these ships
  const jobs = ships.map(s => s.logisticsJob ? w.logisticsJobs?.[s.logisticsJob] : undefined).filter((j): j is NonNullable<typeof j> => !!j);
  if (jobs.length) out.push({ kind: 'pool', label: `자동 물류 운송 ${jobs.length}건${jobs.some(j => j.kind === 'sell') ? ' (판매 포함)' : ''}`, effect: '수송선이 운송에서 빠짐 — 실은 화물은 함선에 보존, 남은 물량은 다른 수송선에 재배차' });
  // field goals driving this group
  for (const x of Object.values(w.works ?? {})) {
    if (x.owner !== owner || (x.kind !== 'survey_field' && x.kind !== 'develop_field') || x.state === 'paused' || ['done', 'failed', 'cancelled'].includes(x.state)) continue;
    if ((x.goal as { group?: string } | undefined)?.group === root.id || (x.goal as { group?: string } | undefined)?.group === g.id) out.push({ kind: 'field', label: x.title, effect: '광구 목표 일시정지 — 다시 배정하지 않음, 목표를 재개하면 채굴 재배정' });
  }
  // military contracts this fleet is fulfilling
  for (const k of Object.values(w.contracts ?? {})) {
    const m = (k as { mil?: { group?: string } }).mil;
    if (!m || k.done || k.takenBy !== owner || (m.group !== g.id && m.group !== root.id)) continue;
    out.push({ kind: 'mil', label: `군사 계약 · ${k.title}`, effect: '함대가 계약 작전에서 이탈 — 계약은 유지되며 기한 안에 다시 투입하지 않으면 실패(보증금·평판 손실)' });
  }
  // a running continuous operation (mining, salvage zone, repair business…) ends
  if (!sel.ship && CONTINUOUS.has(op.k) && !out.some(x => x.kind === 'route')) out.push({ kind: 'operation', label: `${root.name} · ${OP_LABEL[op.k] ?? op.k} 운영`, effect: '운영 종료 — 새 명령으로 대체되며 자동으로 되돌아가지 않음' });
  return out;
}

export const holdsText = (hs: AutoHold[]) => hs.map(x => `· ${x.label}: ${x.effect}`).join('\n');
