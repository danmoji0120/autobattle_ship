// P10 company-ops goals for deposits. Both goals only drive existing engines: the group's normal
// mining operation (with its delivery/sale paths), the fleet goal for extra miners, and the
// existing approval flow for risk. No separate mining economy exists here.
//
//   survey_field   target → assigned group → move → test mining → record samples → evaluate → report
//   develop_field  continuous mining with delivery/sale, miner top-up via a child fleet goal,
//                  tracking of units mined and their estimated value, and a list of current problems
import type { WorldSim } from './sim';
import type { Field, Op } from './types';
import { econOf } from './hullops';
import { effSec } from './security';
import { sysAt } from './geom';
import { territoryRisk, FACTIONS } from './territory';
import { fieldReport, intelOf, CONFIDENCE_NAME, knowsField } from './intel';
import { itemPrice } from './industry';
import { RES_NAME } from './data';

export type FieldGoal =
  /** test-mine `samples` units from a deposit with `group`, then stop and report */
  | { k: 'survey_field'; field: string; group: string; samples: number; deliver?: string }
  /** keep `group` mining the deposit; top up to `miners` mining ships through a fleet goal at `yard` */
  | { k: 'develop_field'; field: string; group: string; deliver?: string; sell: boolean; miners: number; yard?: string; hull?: string };

export interface FieldGoalHost {
  h: WorldSim;
  setState(state: 'running' | 'waiting' | 'paused' | 'done' | 'failed', reason: string): void;
  log(text: string): void;
  rt: Record<string, any>;
  progress(done: number, total: number, unit: string): void;
  result(text: string): void;
  /** issue a player command as a child of this goal */
  cmd(c: any): string | null;
  /** ask for a risk approval (existing approval flow); returns true while waiting */
  askRisk(level: number, hops: number, situation: string): boolean;
  /** create a child fleet goal; returns an error text or null */
  childFleet(spec: { station: string; hull: string; count: number; group: string }): string | null;
  hasChildFleet(): boolean;
  owner: string;
  maxRisk: number;
}

export function validateFieldGoal(h: WorldSim, owner: string, g: FieldGoal): string | null {
  if (!h.st.intel) return '광구 목표는 탐사 정보가 있는 세계(P10)에서만 사용할 수 있습니다';
  const f = h.st.fields[g.field];
  if (!f || f.salvage || !knowsField(h.st, owner, f)) return '알고 있는 광구를 선택하세요';
  const grp = h.st.groups[g.group];
  if (!grp || grp.owner !== owner) return '자사 편대를 선택하세요';
  if (!h.subtreeShips(grp).some(s => econOf(s).mine > 0)) return '편대에 채굴선이 없습니다';
  if (g.deliver !== undefined && g.deliver !== '' && !h.st.stations[g.deliver]) return '하역 정거장을 확인하세요';
  if (g.k === 'survey_field' && (!Number.isSafeInteger(g.samples) || g.samples < 10 || g.samples > 20000)) return '표본 수는 10–20,000';
  if (g.k === 'develop_field') {
    if (!Number.isSafeInteger(g.miners) || g.miners < 0 || g.miners > 30) return '채굴선 목표는 0–30척';
    if (g.yard !== undefined && h.st.stations[g.yard]?.owner !== owner) return '증원 조선소는 자사 정거장이어야 합니다';
  }
  return null;
}

const minersOf = (h: WorldSim, groupId: string) => { const g = h.st.groups[groupId]; return g ? h.subtreeShips(g).filter(s => econOf(s).mine > 0) : []; };
function fieldRisk(h: WorldSim, f: Field) { const sys = sysAt(h.st.systems, f.pos); return sys ? Math.min(100, 100 - effSec(sys) + territoryRisk(h.st, sys)) : 100; }
const minedNow = (h: WorldSim, owner: string, id: string) => ({ ...(intelOf(h.st, owner).fields[id]?.units ?? {}) });
function minedSince(now: Record<string, number>, start: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(now)) { const d = v - (start[k] ?? 0); if (d > 1e-9) out[k] = d; }
  return out;
}
const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

/**
 * P17.4c AUD-11: the goal's mining order, compared on every setting it controls — the deposit, the unloading station
 * (or automatic unloading), and the sale flag. Before, only the deposit was compared: a group already mining the field
 * with another station or sale setting counted as "assigned", and a player's later change of those settings went
 * unnoticed (the goal reported progress for an order it no longer matched).
 */
function mineConflict(h: WorldSim, op: Op, g: FieldGoal, sell: boolean): string | null {
  if (op.k !== 'mine') return op.k === 'idle' ? '편대 대기 명령' : `다른 명령(${op.k})`;
  const parts: string[] = [];
  if (op.field !== g.field) parts.push(`광구 ${h.st.fields[op.field]?.name ?? op.field}`);
  const st = (id?: string) => (id && h.st.stations[id]?.name) || id || '없음';
  if (g.deliver) { if (op.auto || op.deliver !== g.deliver) parts.push(`하역지 ${op.auto ? '자동' : st(op.deliver)} (목표: ${st(g.deliver)})`); }
  else if (!op.auto) parts.push(`하역지 ${st(op.deliver)} 고정 (목표: 자동 하역)`);
  if (!!op.sell !== sell) parts.push(`하역 판매 ${op.sell ? '켜짐' : '꺼짐'} (목표: ${sell ? '켜짐' : '꺼짐'})`);
  return parts.length ? parts.join(', ') : null;
}

/** ensure the group is mining the deposit with the goal's delivery and sale settings; returns null when it is,
 *  `{ changed }` when the player has since given the group a different order (the goal pauses, never fights it),
 *  or an error text */
function ensureMining(x: FieldGoalHost, g: FieldGoal, sell: boolean): string | { changed: string } | null {
  const grp = x.h.st.groups[g.group]; if (!grp) return '편대 소실';
  const conflict = mineConflict(x.h, grp.op, g, sell);
  // a group already running exactly the goal's order is the goal's from now on: a later change is the player's
  if (!conflict) { x.rt.issued = true; x.rt.issuedOp = 'mine'; return null; }
  // the goal assigned the order before and it no longer matches: the player changed it — do not fight the player
  if (x.rt.issued) return { changed: conflict };
  const deliver = g.deliver ?? '';
  const prior = grp.op.k === 'mine' ? ` — 기존 채굴 설정(${conflict})을 목표 설정으로 교체` : grp.op.k !== 'idle' ? ` — 기존 ${conflict}을 목표로 교체` : '';
  const err = x.cmd({ c: 'setOp', group: g.group, op: { k: 'mine', field: g.field, deliver, sell, auto: !deliver } });
  if (err) return err;
  x.rt.issued = true; x.rt.issuedOp = 'mine';
  x.log(`${grp.name}: ${x.h.st.fields[g.field]?.name} 채굴 배정${prior}`);
  return null;
}
const changedText = (c: { changed: string }) => `편대 명령이 목표와 다름: ${c.changed} — 플레이어 명령 우선, 재개하면 목표 설정으로 다시 배정`;

export function runFieldGoal(x: FieldGoalHost, g: FieldGoal) {
  const h = x.h, f = h.st.fields[g.field];
  if (!f) return x.setState('failed', '광구 소실');
  const grp = h.st.groups[g.group];
  if (!grp || grp.owner !== x.owner) return x.setState('failed', '편대 소실');
  const risk = fieldRisk(h, f), sys = sysAt(h.st.systems, f.pos);
  if (risk > Math.max(x.maxRisk, x.rt.riskOk ?? 0) + 1e-9) {
    if (x.askRisk(risk, 0, `${sys?.name ?? '?'} · ${f.name} — 지역 위험 ${Math.round(risk)}${sys?.region ? ` (${sys.region === 'lawless' ? '무법 지대' : sys.region === 'uncharted' ? '미개척' : sys.region === 'border' ? '국경' : '지역'})` : ''}`))
      return x.setState('waiting', `위험 결재 대기 (위험 ${Math.round(risk)})`);
  }
  x.rt.start ??= minedNow(h, x.owner, f.id);
  x.rt.t0 ??= h.time;
  const since = minedSince(minedNow(h, x.owner, f.id), x.rt.start);
  const n = sum(since);
  if (g.k === 'survey_field') {
    x.progress(Math.min(n, g.samples), g.samples, '표본');
    if (n >= g.samples) {
      const r = fieldReport(intelOf(h.st, x.owner).fields[f.id]);
      if (grp.op.k === 'mine' && grp.op.field === f.id) x.cmd({ c: 'setOp', group: g.group, op: { k: 'idle' } });
      const shares = r.shares.map(([k, s]) => `${RES_NAME[k] ?? k} ${Math.round(s * 1000) / 10}%`).join(', ');
      x.result(`${f.name}: 표본 ${Math.round(r.n)}개 · 관측 ${shares} · 신뢰도 ${CONFIDENCE_NAME[r.confidence]} · 단위 가치 약 ${Math.round(r.unitValue)} cr · 미관측 성분 최대 ${Math.round(r.unseenMax * 1000) / 10}% 가능`);
      h.ev('info', `시험 채굴 보고: ${f.name} — ${shares || '성분 없음'} (신뢰도 ${CONFIDENCE_NAME[r.confidence]})`, { company: x.owner, pos: f.pos, ref: f.id });
      return x.setState('done', '');
    }
    const m = ensureMining(x, g, false);
    if (m && typeof m === 'object') return x.setState('paused', changedText(m));
    if (m) return x.setState('waiting', m);
    const here = minersOf(h, g.group).some(s => sysAt(h.st.systems, s.pos)?.id === sys?.id);
    return x.setState('running', here ? `시험 채굴 중 ${Math.floor(n)}/${g.samples}` : '광구로 이동 중');
  }
  // develop_field
  const m = ensureMining(x, g, g.sell);
  if (m && typeof m === 'object') return x.setState('paused', changedText(m));
  if (m) return x.setState('waiting', m);
  const problems: string[] = [];
  const miners = minersOf(h, g.group);
  if (miners.length < g.miners) {
    if (g.yard && g.hull && !x.hasChildFleet()) {
      const err = x.childFleet({ station: g.yard, hull: g.hull, count: g.miners - miners.length, group: g.group });
      if (err) problems.push(`채굴선 증원 불가: ${err}`); else x.log(`채굴선 ${g.miners - miners.length}척 증원 착수`);
    } else if (!g.yard) problems.push(`채굴선 ${miners.length}/${g.miners}척 (증원 조선소 미지정)`);
  }
  if (f.amount < 1) problems.push('매장량 고갈 — 재생 대기');
  if (grp.status.includes('대기') || grp.status.includes('불가')) problems.push(grp.status);
  if (sys?.faction && h.st.conflicts && Object.values(h.st.conflicts).some(c => !c.ended && (c.a === sys.faction || c.b === sys.faction))) problems.push(`${FACTIONS[sys.faction]?.short ?? ''} 분쟁 중 — 항로 봉쇄 가능`);
  const value = Object.entries(since).reduce((a, [k, v]) => a + v * itemPrice(k), 0);
  x.rt.profit = value;
  const hours = Math.max(1 / 60, (h.time - x.rt.t0) / 3600);
  x.progress(Math.floor(n), 0, '개');
  return x.setState(problems.length ? 'waiting' : 'running', `채굴 ${Math.floor(n).toLocaleString()}개 · 기준가 산출 가치 약 ${Math.round(value).toLocaleString()} cr (${Math.round(value / hours).toLocaleString()} cr/h)${problems.length ? ' · ' + problems.join(' · ') : ''}`);
}
