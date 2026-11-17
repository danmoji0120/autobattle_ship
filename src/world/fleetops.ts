// P12 fleet operations: the player (or an NPC) gives a fleet a purpose; the commander decides how.
//
// One handler drives every P12 operation. Decisions (threats, chase limits, return-station choice) are
// taken at the group that holds the order (opOwner) at most once per second and kept in `opx`, which is
// saved with the world; ships move every tick with the existing primitives (fleetMarch for coordinated
// travel across gates, moveTo/formationSlot, goDock). Fighting is never simulated here: a fleet closing
// on a hostile one makes contact and the P11 engagement takes over; while ships are in battle the
// order stays as it was and resumes when they come back. See docs/P12_FLEET_OPERATIONS.md.
import type { WorldSim } from './sim';
import type { Op, Station, StarSystem, V, WGroup, WShip } from './types';
import { coRelation } from './battleAuth';
import { dist } from './geom';
import { econOf, berthFits, shipWorth } from './hullops';
import { occupiedBerths, stationBerths } from './stations';
import { gateOpen } from './territory';
import { effSec } from './security';
import { canRepairAt, REPAIR_RATE } from './repair';
import type { CommanderDef } from '../sim/data/commanders';
import { groupFx } from './officers';

export type OpPhase = 'transit' | 'hold' | 'engage' | 'alert' | 'evade' | 'docking' | 'blocked' | 'done' | 'follow' | 'sweep';

export interface ReconContact { id: string; kind: 'group' | 'station'; owner: string; name: string; n: number; mil: number; pos: V; t: number; rel: -1 | 0 | 1 }

export interface OpState {
  key: string;
  phase: OpPhase;
  since: number;
  /** next decision time (decisions run at most once per second) */
  next: number;
  /** the position the operation holds / returns to after a chase */
  anchor?: V;
  /** temporary chase target (group id) and where/when the chase started */
  target?: string;
  chaseFrom?: V;
  chaseT?: number;
  /** targets given up: no new chase before this time */
  ignore?: Record<string, number>;
  /** patrol / raid / recon waypoint index */
  leg?: number;
  /** evasion: move toward `evadeTo` until this time */
  evadeUntil?: number;
  evadeTo?: V;
  /** return: chosen station (whole fleet) or per subgroup, its score and the last full evaluation */
  station?: string;
  split?: Record<string, string>;
  score?: number;
  evalT?: number;
  /** why the operation waits / cannot proceed (shown to the player) */
  reason?: string;
  reportT?: number;
  /** reinforce: a member has been in the target battle */
  joined?: boolean;
  /** recon findings */
  report?: ReconContact[];
  /** a finished operation (the order was replaced by idle): what was done */
  done?: string;
}

/** the operations handled here (P12 worlds); patrol is taken over too */
export const P12_OPS = new Set<Op['k']>(['rally', 'defend', 'amove', 'intercept', 'blockade', 'harass', 'reinforce', 'recon', 'return', 'patrol']);
export const OP_NAME: Partial<Record<Op['k'], string>> = {
  idle: '대기', move: '이동', dock: '정박', patrol: '순찰', escort: '호위', attack: '공격', rally: '집결', defend: '지역 방어',
  amove: '공격 이동', intercept: '차단 요격', blockade: '관문 봉쇄', harass: '항로 습격', reinforce: '증원', recon: '정찰', return: '복귀', plunder: '화물 약탈',
};
export const PHASE_NAME: Record<OpPhase, string> = {
  transit: '이동', hold: '위치 유지', engage: '교전 기동', alert: '경계 (우세한 적)', evade: '회피 이탈', docking: '정박 진입',
  blocked: '대기 (진행 불가)', done: '완료', follow: '동행', sweep: '탐색',
};

/** tuning (documented in docs/P12_FLEET_OPERATIONS.md) */
export const OPS = {
  think: 1, chaseMax: 90, ignoreFor: 60, marchFar: 4500,
  returnEval: 15, returnSwitch: 0.75, returnReport: 60, jumpCost: 30, riskPerSys: 60, hostileR: 6000, hostileCap: 600, serviceW: 400,
  blockadeR: 2000, blockadeLeash: 2600, blockadePost: 400, amoveDetect: 1600, amoveLeash: 2500,
  harassVuln: 0.7, harassDanger: 0.9, harassHp: 0.45, evadeFor: 30, reconSensor: 2500, reconDanger: 0.8,
} as const;

export function opKey(op: Op): string { return JSON.stringify(op); }

/** the commander's engagement limit: how much enemy strength (relative to ours) it will take on */
export function engageLimit(c: Pick<CommanderDef, 'aggression'>, hp: number): number {
  return 1.1 + 0.8 * c.aggression - 0.3 * (1 - hp);
}

/** lead pursuit: the point where a ship at `p` with speed `s` meets a target at `t` moving with `v` (≤ maxT s) */
export function interceptPoint(p: V, s: number, t: V, v: V, maxT = 120): V {
  const rx = t.x - p.x, rz = t.z - p.z;
  const a = v.x * v.x + v.z * v.z - s * s, b = 2 * (rx * v.x + rz * v.z), c = rx * rx + rz * rz;
  let tt = -1;
  if (Math.abs(a) < 1e-6) tt = b < 0 ? -c / b : -1;
  else { const disc = b * b - 4 * a * c; if (disc >= 0) { const r = Math.sqrt(disc); const t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a); tt = Math.min(...[t1, t2].filter(x => x > 0), Infinity); if (!Number.isFinite(tt)) tt = -1; } }
  if (tt < 0 || tt > maxT) tt = Math.min(maxT, Math.hypot(rx, rz) / Math.max(1, s));
  return { x: t.x + v.x * tt, y: t.y, z: t.z + v.z * tt };
}

/** systems and gates on the gate route from a to b (only gates the filter allows); null when unreachable */
export function routeSystems(systems: Record<string, StarSystem>, from: string, to: string, usable: (g: import('./types').Gate) => boolean): { sys: string[]; gates: import('./types').Gate[] } | null {
  if (from === to) return { sys: [from], gates: [] };
  const prev = new Map<string, { sys: string; gate: import('./types').Gate }>();
  const q = [from], seen = new Set([from]);
  while (q.length) {
    const cur = q.shift()!; if (cur === to) break;
    for (const g of systems[cur]?.gates ?? []) if (usable(g) && !seen.has(g.to)) { seen.add(g.to); prev.set(g.to, { sys: cur, gate: g }); q.push(g.to); }
  }
  if (!prev.has(to)) return null;
  const sys = [to], gates: import('./types').Gate[] = [];
  let node = to;
  while (node !== from) { const st = prev.get(node)!; gates.unshift(st.gate); sys.unshift(st.sys); node = st.sys; }
  return { sys, gates };
}

export interface StationEval { station: Station; ok: boolean; why?: string; score: number; time: number; risk: number; service: number }

type Host = WorldSim;
const ring = (at: V, r: number, n: number, phase: number): V[] => Array.from({ length: n }, (_, i) => { const a = phase + i / n * Math.PI * 2; return { x: at.x + Math.cos(a) * r, y: at.y, z: at.z + Math.sin(a) * r }; });
const inward = (p: V, o: V, d: number): V => { const dx = o.x - p.x, dz = o.z - p.z, l = Math.hypot(dx, dz) || 1; return { x: p.x + dx / l * d, y: p.y, z: p.z + dz / l * d }; };
const hpOf = (ss: WShip[]) => ss.length ? ss.reduce((a, s) => a + s.hp, 0) / ss.length : 1;
const milValue = (h: Host, ss: WShip[]) => ss.filter(s => econOf(s).military).reduce((a, s) => a + h.shipValueOf(s), 0);

/** the ships (outside battle, mobile) following the group's order, and every group in that command */
function members(h: Host, owner: WGroup) { return h.fleetMembers(owner); }

/** ships of the command that are inside a battle right now (they rejoin when it ends) */
function inBattle(h: Host, groups: WGroup[]): WShip[] {
  const out: WShip[] = [];
  for (const g of groups) for (const id of g.shipIds) { const s = h.st.ships[id]; if (s?.state === 'battle') out.push(s); }
  return out;
}

export interface Threat { group: WGroup; pos: V; ratio: number; mil: number; total: number; d: number }

/** hostile fleets (P11 relations: hostile only) seen within `detect` of `from` (or of `anchor` when given), never beyond `leash` from the anchor */
export function threats(h: Host, owner: WGroup, from: V, detect: number, anchor: V | null, leash: number, own: number, opx?: OpState): Threat[] {
  const out: Threat[] = [];
  const here = h.sysOf(from)?.id;
  for (const p of Object.values(h.st.groups)) {
    if (p.owner === owner.owner || !p.shipIds.length || p.cooldown > 0) continue;
    if (coRelation(h.st, owner.owner, p.owner) !== -1) continue;
    if (opx?.ignore?.[p.id] !== undefined && opx.ignore[p.id] > h.time) continue;
    const ss = h.shipsOf(p).filter(s => s.state === 'space');
    if (!ss.length) continue;
    const pc = h.centroid(ss);
    if (h.sysOf(pc)?.id !== here) continue;
    const d = dist(pc, from), da = anchor ? dist(pc, anchor) : d;
    if (Math.min(d, da) > detect || da > leash) continue;
    const mil = milValue(h, ss), total = ss.reduce((a, s) => a + h.shipValueOf(s), 0);
    out.push({ group: p, pos: pc, ratio: mil / Math.max(1, own), mil, total, d: anchor ? da : d });
  }
  return out.sort((a, b) => a.d - b.d || (a.group.id < b.group.id ? -1 : 1));
}

// ---------------------------------------------------------------------------------------- return

/** evaluate every station as a return destination for `ships` (hard conditions first, then the score) */
export function evalStations(h: Host, owner: WGroup, ships: WShip[], c: CommanderDef): StationEval[] {
  const st = h.st, co = st.companies[owner.owner];
  const cen = h.centroid(ships), here = h.sysOf(cen);
  const speed = Math.max(20, Math.min(...ships.map(s => h.cruiseOf(s) * (0.6 + 0.4 * s.hp))));
  const own = Math.max(1, milValue(h, ships));
  const need = 1 - hpOf(ships);
  const repairCost = ships.reduce((a, s) => a + Math.max(0, 1 - s.hp) * shipWorth(st, s) * REPAIR_RATE, 0);
  const riskW = 1.6 - 0.8 * c.aggression + 0.4 * c.skill;
  const battles = Object.values(st.engagements).filter(e => !e.done);
  const hostileNear = (p: V) => {
    let v = 0;
    for (const g of Object.values(st.groups)) {
      if (g.owner === owner.owner || !g.shipIds.length || coRelation(st, owner.owner, g.owner) !== -1) continue;
      const ss = h.shipsOf(g).filter(s => s.state === 'space'); if (!ss.length) continue;
      if (dist(h.centroid(ss), p) < OPS.hostileR) v += milValue(h, ss);
    }
    return v;
  };
  const out: StationEval[] = [];
  for (const S of Object.values(st.stations)) {
    const e: StationEval = { station: S, ok: false, score: Infinity, time: 0, risk: 0, service: 0 };
    out.push(e);
    if (!h.canDock(S, owner.owner)) { e.why = S.owner === owner.owner ? '핵심 모듈 미완성' : '정박 권한 없음'; continue; }
    const big = ships.find(s => !berthFits(S, econOf(s).berth));
    if (big) { e.why = `정박 규격 부족 (${econOf(big).berth}급)`; continue; }
    const lim = stationBerths(S);
    if (lim !== undefined) {
      const already = ships.filter(s => s.state === 'docked' && s.task.k === 'docked' && s.task.station === S.id).length;
      if (lim - occupiedBerths(st, S.id) + already < ships.length) { e.why = '정박 공간 부족'; continue; }
    }
    if (battles.some(b => dist(b.pos, S.pos) < 1700)) { e.why = '정거장 주변 교전 중'; continue; }
    const there = h.sysOf(S.pos);
    if (!here || !there) { e.why = '경로 없음'; continue; }
    const route = routeSystems(st.systems, here.id, there.id, gt => gateOpen(st, gt));
    if (!route) { e.why = '접근 가능한 경로 없음 (관문 봉쇄)'; continue; }
    // travel time: in-system legs (warp for long legs) plus a cost per jump
    let d = 0, p = cen, t = 0;
    for (const g of route.gates) { const l = dist(p, g.pos); t += l > 6000 ? 20 + l / 4200 : l / speed; d += l; const dest = st.systems[g.to]; const ex = dest?.gates.find(x => x.id === g.exit); p = ex ? ex.pos : g.pos; }
    const l = dist(p, S.pos); t += l > 6000 ? 20 + l / 4200 : l / speed; d += l;
    t += route.gates.length * OPS.jumpCost;
    let risk = 0;
    for (const sid of route.sys) { const sys = st.systems[sid]; if (sys) risk += (100 - effSec(sys)) / 100 * OPS.riskPerSys; }
    let hv = hostileNear(S.pos);
    for (const g of route.gates) hv += hostileNear(g.pos);
    risk += Math.min(OPS.hostileCap, hv / own * 120);
    let service = 0;
    if (need > 0.1) {
      const can = canRepairAt(S, owner.owner);
      if (can && (co?.credits ?? 0) >= repairCost) service = -need * OPS.serviceW;
      else if (!can) service = need * OPS.serviceW;
    }
    e.ok = true; e.time = t; e.risk = risk; e.service = service;
    e.score = t + riskW * risk + service;
    void d;
  }
  return out.sort((a, b) => a.score - b.score || (a.station.id < b.station.id ? -1 : 1));
}

function stationOk(h: Host, owner: WGroup, ships: WShip[], id: string, c: CommanderDef): StationEval | null {
  const e = evalStations(h, owner, ships, c).find(x => x.station.id === id);
  return e?.ok ? e : null;
}

function planReturn(h: Host, owner: WGroup, x: OpState, ships: WShip[], groups: WGroup[], c: CommanderDef): void {
  const st = h.st;
  const due = x.evalT === undefined || h.time - x.evalT >= OPS.returnEval;
  // the current destination still valid? (invalid → re-evaluate now)
  let cur: StationEval | null = null;
  if (x.station) { cur = stationOk(h, owner, ships, x.station, c); if (!cur) { const was = st.stations[x.station]?.name ?? '목적지'; h.say(owner, `${was} 이용 불가 — 귀환 목적지를 다시 정한다.`, 'warn', 0); x.station = undefined; x.score = undefined; } }
  if (x.split) for (const [gid, sid] of Object.entries(x.split)) { const g = st.groups[gid]; const ss = g ? h.shipsOf(g).filter(s => s.state !== 'battle') : []; if (!ss.length || !stationOk(h, owner, ss, sid, c)) { delete x.split[gid]; } }
  if (!due && (x.station || (x.split && Object.keys(x.split).length))) return;
  x.evalT = h.time;
  const all = evalStations(h, owner, ships, c);
  const best = all.find(e => e.ok);
  if (best) {
    if (!x.station || (best.station.id !== x.station && best.score < (cur?.score ?? Infinity) * OPS.returnSwitch)) {
      const changed = !!x.station;
      x.station = best.station.id; x.score = best.score; x.split = undefined; x.reason = undefined;
      h.say(owner, changed ? `귀환지 변경 — ${best.station.name} (더 안전·신속)` : `귀환지 결정: ${best.station.name}. 전 함대 귀환한다.`, 'radio', 0);
    } else if (cur) x.score = cur.score;
    return;
  }
  // no single station takes the whole fleet: per subgroup
  x.station = undefined;
  const split: Record<string, string> = { ...(x.split ?? {}) };
  const missing: string[] = [];
  for (const g of groups) {
    const ss = h.shipsOf(g).filter(s => s.state !== 'battle' && econOf(s).cruise > 0); if (!ss.length || split[g.id]) continue;
    const b = evalStations(h, owner, ss, c).find(e => e.ok);
    if (b) split[g.id] = b.station.id; else missing.push(g.name);
  }
  x.split = Object.keys(split).length ? split : undefined;
  const why = [...new Set(all.filter(e => !e.ok).map(e => e.why!))].slice(0, 3).join(', ');
  if (x.split && !missing.length) { x.reason = undefined; h.say(owner, `함대 전체를 받을 정거장이 없어 편대별로 귀환한다 (${Object.values(x.split).map(id => st.stations[id]?.name).filter((v, i, a) => a.indexOf(v) === i).join(', ')}).`, 'radio', 0); }
  else {
    x.reason = `귀환 가능한 정거장 없음 — ${why || '조건 불충족'}${missing.length ? ` (${missing.join(', ')})` : ''}`;
    if (x.reportT === undefined || h.time - x.reportT >= OPS.returnReport) { x.reportT = h.time; h.say(owner, `${x.reason}. 현 위치에서 대기하며 계속 탐색한다.`, 'warn', 0); }
  }
}

// ---------------------------------------------------------------------------------------- per-op plans

/** what the fleet does this tick: march somewhere, hold/approach a point, dock, or stop */
type Plan =
  | { m: 'march'; key: string; to: V; status: string }
  | { m: 'point'; to: V; spread: number; full: boolean; status: string }
  | { m: 'dock'; status: string }
  | { m: 'stop'; status: string };

function far(h: Host, cen: V, p: V) { return h.sysOf(cen)?.id !== h.sysOf(p)?.id || dist(cen, p) > OPS.marchFar; }

/** chase bookkeeping shared by all combat operations; returns the target position while chasing */
function chase(h: Host, owner: WGroup, x: OpState, anchor: V, leash: number, own: number, lim: number): V | null {
  if (!x.target) return null;
  const t = h.st.groups[x.target];
  const ss = t ? h.shipsOf(t).filter(s => s.state === 'space') : [];
  const pc = ss.length ? h.centroid(ss) : null;
  let why = '';
  if (!t || !ss.length) why = t && h.shipsOf(t).some(s => s.state === 'battle') ? '' : '목표 상실';
  else if (coRelation(h.st, owner.owner, t.owner) !== -1) why = '적대 관계 해제';
  else if (h.sysOf(pc!)?.id !== h.sysOf(anchor)?.id) why = '목표가 성계를 벗어남';
  // B-1 tracking: an interception officer chases longer and further
  const ch = 1 + (groupFx(h.st, owner).chase ?? 0);
  // (a target fighting someone else has no position in space: skip these checks and wait, as before B-1)
  if (!why && pc) {
    if (dist(pc, anchor) > leash * ch) why = '추격 한계 도달';
    else if (h.time - (x.chaseT ?? h.time) > OPS.chaseMax * ch) why = '추격 시간 초과';
    else if (milValue(h, ss) / Math.max(1, own) > lim * 1.25) why = '적 전력 우세';
  }
  if (why) {
    (x.ignore ??= {})[x.target] = h.time + OPS.ignoreFor;
    x.target = undefined; x.chaseFrom = undefined; x.chaseT = undefined; x.phase = 'hold'; x.since = h.time;
    h.say(owner, `${why} — 추격 중단, 작전 위치로 복귀한다.`, 'radio', 0);
    return null;
  }
  if (!pc) return null;   // the target is fighting someone (in battle): wait
  return pc;
}

/** start chasing the most relevant threat if the commander judges it can be taken on */
function pick(h: Host, owner: WGroup, x: OpState, list: Threat[], lim: number, say: string): Threat | null {
  const ok = list.find(t => t.ratio <= lim);
  if (ok) {
    x.target = ok.group.id; x.chaseFrom = h.centroid(h.fleetMembers(owner).ships); x.chaseT = h.time; x.phase = 'engage'; x.since = h.time;
    h.say(owner, `${say}: ${ok.group.name} (${Math.round(ok.d)}m). 요격한다.`, 'warn', 0);
    return ok;
  }
  return null;
}

function pruneIgnore(h: Host, x: OpState) { if (x.ignore) for (const [k, t] of Object.entries(x.ignore)) if (t <= h.time) delete x.ignore[k]; }

/** decide the plan of the group holding the order (once per tick; decisions once per second) */
export function planOp(h: Host, owner: WGroup, op: Op, c: CommanderDef): Plan | null {
  const st = h.st;
  const key = opKey(op);
  let x = owner.opx;
  if (!x || x.key !== key) x = owner.opx = { key, phase: 'transit', since: h.time, next: 0 };
  const { ships, groups } = members(h, owner);
  const fighting = inBattle(h, groups);
  if (!ships.length) return fighting.length ? { m: 'stop', status: `교전 중 — ${OP_NAME[op.k]} 작전 유지` } : null;
  const cen = h.centroid(ships);
  const think = h.time >= x.next;
  if (think) { x.next = h.time + OPS.think; pruneIgnore(h, x); }
  const own = Math.max(1, milValue(h, ships));
  const lim = engageLimit(c, hpOf(ships));
  const odet = groupFx(h.st, owner).detect ?? 0;   // B-1 threat detection
  const detectBonus = c.skill * 1500 * (1 + odet) + odet * 1500;

  switch (op.k) {
    case 'return': {
      if (think) planReturn(h, owner, x, ships, groups, c);
      if (!x.station && !x.split) { x.phase = 'blocked'; return { m: 'stop', status: x.reason ?? '귀환지 탐색 중' }; }
      // done: every ship of the command docked at its destination, nobody left in battle
      const dest = (s: WShip) => x!.station ?? x!.split?.[s.groupId];
      const docked = ships.filter(s => s.state === 'docked' && s.task.k === 'docked' && s.task.station === dest(s));
      if (think && docked.length === ships.length && !fighting.length) {
        const names = [...new Set(ships.map(s => st.stations[dest(s)!]?.name))].join(', ');
        owner.op = { k: 'idle' };
        owner.opx = { key: opKey(owner.op), phase: 'done', since: h.time, next: 0, done: 'return', station: x.station, split: x.split };
        owner.march = undefined;
        h.say(owner, `귀환 완료 — ${names} 정박. 정박 대기한다.`, 'radio', 0);
        return { m: 'stop', status: `복귀 완료 — ${names} 정박 대기` };
      }
      const S = x.station ? st.stations[x.station] : undefined;
      const tail = fighting.length ? ` · ${fighting.length}척 전투 이탈 대기` : '';
      if (S && far(h, cen, S.pos) && docked.length === 0) {
        x.phase = 'transit';
        return { m: 'march', key: `ret:${S.id}`, to: inward(S.pos, cen, S.radius + 600), status: `복귀 — ${S.name}로 귀환 중${tail}` };
      }
      x.phase = 'docking';
      return { m: 'dock', status: `복귀 — ${S ? S.name : '편대별 정거장'} 정박 진입 (${docked.length}/${ships.length}척)${tail}` };
    }
    case 'rally': {
      if (far(h, cen, op.at)) { x.phase = 'transit'; return { m: 'march', key: `rally:${Math.round(op.at.x)}:${Math.round(op.at.z)}`, to: op.at, status: '집결 지점으로 이동' }; }
      x.phase = 'hold';
      const n = ships.filter(s => dist(s.pos, op.at) < 600 + Math.sqrt(ships.length) * 80).length;
      return { m: 'point', to: op.at, spread: 70, full: false, status: `집결 ${n === ships.length ? '완료' : '중'} (${n}/${ships.length}척) — 대기` };
    }
    case 'defend': case 'blockade': {
      let anchor: V, detect: number, leash: number, label: string;
      if (op.k === 'defend') { anchor = op.at; detect = op.radius + 400 + detectBonus * 0.3; leash = op.radius * 1.5; label = '방어 구역'; }
      else {
        const sys = st.systems[op.system], gate = sys?.gates.find(g => g.id === op.gate);
        if (!sys || !gate) { x.phase = 'blocked'; x.reason = '관문 없음'; return { m: 'stop', status: '관문 봉쇄 불가 — 관문 없음' }; }
        anchor = inward(gate.pos, sys.origin, OPS.blockadePost); detect = OPS.blockadeR; leash = OPS.blockadeLeash; label = `${gate.name} 관문`;
      }
      x.anchor = anchor;
      const tp = chase(h, owner, x, anchor, leash, own, lim);
      if (tp) return { m: 'point', to: tp, spread: 60, full: true, status: `${label}: ${st.groups[x.target!]?.name ?? '적'} 요격` };
      if (far(h, cen, anchor)) { x.phase = 'transit'; return { m: 'march', key: `${op.k}:${Math.round(anchor.x)}:${Math.round(anchor.z)}`, to: anchor, status: `${label}으로 이동` }; }
      if (think) {
        const list = threats(h, owner, anchor, detect, anchor, leash, own, x);
        if (!pick(h, owner, x, list, lim, `${label} 침입`) && list.length) { x.phase = 'alert'; x.reason = `우세한 적 ${list[0].group.name} — 위치 고수`; h.say(owner, `${x.reason}.`, 'warn', 20); }
        else if (!list.length && x.phase === 'alert') { x.phase = 'hold'; x.reason = undefined; }
      }
      if (x.phase !== 'alert') x.phase = 'hold';
      return { m: 'point', to: anchor, spread: op.k === 'blockade' ? 110 : Math.min(300, Math.max(80, (op as any).radius * 0.15)), full: false, status: x.phase === 'alert' ? `${label}: ${x.reason}` : op.k === 'blockade' ? `${label} 봉쇄 — 통제 중 (적대 함대만 교전)` : `${label} 경계 중` };
    }
    case 'patrol': case 'harass': case 'recon': {
      const r = op.radius || 1500;
      const pts = op.k !== 'recon' && op.route?.length ? op.route : op.k === 'recon' ? [op.at, ...ring(op.at, r * 0.6, 6, 0)] : ring(op.at, r * 0.7, 8, 0);
      x.leg = (x.leg ?? 0) % pts.length;
      const wp = pts[x.leg];
      x.anchor = wp;
      const leash = r + 1500;
      // recon: record what our sensors see
      if (op.k === 'recon' && think) recon(h, owner, x, ships, c);
      // evasion (raid / recon)
      if (x.evadeUntil !== undefined && h.time < x.evadeUntil && x.evadeTo) return { m: 'point', to: x.evadeTo, spread: 80, full: true, status: `위험 — 이탈 중` };
      if (x.evadeUntil !== undefined && h.time >= x.evadeUntil) { x.evadeUntil = undefined; x.evadeTo = undefined; x.phase = 'hold'; h.say(owner, '이탈 완료 — 작전을 재개한다.', 'radio', 4); }
      if (op.k !== 'patrol' && think) {
        const danger = threats(h, owner, cen, 2500 + detectBonus * 0.5, null, Infinity, own, undefined).find(t => t.ratio > (op.k === 'harass' ? OPS.harassDanger : OPS.reconDanger));
        const hurt = op.k === 'harass' && hpOf(ships) < OPS.harassHp;
        if (danger || hurt) {
          const from = danger?.pos ?? (x.target ? h.groupCenter(st.groups[x.target]) ?? cen : cen);
          const dx = cen.x - from.x, dz = cen.z - from.z, l = Math.hypot(dx, dz) || 1;
          x.evadeTo = { x: cen.x + dx / l * 3000, y: cen.y, z: cen.z + dz / l * 3000 }; x.evadeUntil = h.time + OPS.evadeFor; x.phase = 'evade';
          if (x.target) { (x.ignore ??= {})[x.target] = h.time + OPS.ignoreFor; x.target = undefined; }
          h.say(owner, hurt ? '손상 심각 — 교전을 끊고 이탈한다.' : `우세한 적 ${danger!.group.name} 접근 — 이탈한다.`, 'warn', 4);
          return { m: 'point', to: x.evadeTo, spread: 80, full: true, status: '위험 — 이탈 중' };
        }
      }
      if (op.k !== 'recon') {
        const tp = chase(h, owner, x, wp, leash, own, op.k === 'harass' ? OPS.harassVuln * 1.4 : lim);
        if (tp) return { m: 'point', to: tp, spread: 60, full: true, status: `${op.k === 'harass' ? '습격' : '순찰 중 요격'}: ${st.groups[x.target!]?.name ?? '적'}` };
        if (think) {
          let list = threats(h, owner, cen, (op.k === 'harass' ? 3000 : r + 900) + detectBonus * 0.4, wp, leash, own, x);
          if (op.k === 'harass') list = list.filter(t => t.total / own <= OPS.harassVuln || t.mil === 0).sort((a, b) => (a.mil === 0 ? 0 : 1) - (b.mil === 0 ? 0 : 1) || a.d - b.d);
          pick(h, owner, x, list, op.k === 'harass' ? Infinity : lim, op.k === 'harass' ? '습격 목표 포착' : '순찰 구역에 적대 함대');
          if (x.target) { const t = st.groups[x.target]; const tp2 = t && h.groupCenter(t); if (tp2) return { m: 'point', to: tp2, spread: 60, full: true, status: `교전 기동: ${t.name}` }; }
        }
      }
      if (far(h, cen, wp)) { x.phase = 'transit'; return { m: 'march', key: `${op.k}:${x.leg}:${Math.round(wp.x)}:${Math.round(wp.z)}`, to: wp, status: `${OP_NAME[op.k]} 구역으로 이동` }; }
      if (dist(cen, wp) < 350) {
        x.leg = x.leg + 1;
        if (op.k === 'recon' && x.leg >= pts.length) {
          const n = x.report?.length ?? 0;
          owner.op = { k: 'idle' };
          owner.opx = { ...x, key: opKey(owner.op), phase: 'done', done: 'recon', since: h.time };
          h.ev('radio', `정찰 완료 — 접촉 ${n}건 보고`, { company: owner.owner, ref: owner.id, pos: cen });
          return { m: 'stop', status: `정찰 완료 — 접촉 ${n}건, 대기` };
        }
        x.leg %= pts.length;
      }
      x.phase = op.k === 'recon' ? 'sweep' : 'hold';
      return { m: 'point', to: pts[x.leg], spread: 80, full: false, status: op.k === 'recon' ? `정찰 중 (${x.leg + 1}/${pts.length}) · 접촉 ${x.report?.length ?? 0}건` : op.k === 'harass' ? `항로 습격 — 목표 탐색 (${x.leg + 1}/${pts.length})` : `순찰 중 (${x.leg + 1}/${pts.length})` };
    }
    case 'amove': {
      const tp = chase(h, owner, x, x.chaseFrom ?? cen, OPS.amoveLeash, own, lim);
      if (tp) return { m: 'point', to: tp, spread: 60, full: true, status: `공격 이동 중 교전: ${st.groups[x.target!]?.name ?? '적'}` };
      if (think) pick(h, owner, x, threats(h, owner, cen, OPS.amoveDetect + detectBonus * 0.3, null, Infinity, own, x), lim, '진격로에 적대 함대');
      if (x.target) { const t = st.groups[x.target]; const p = t && h.groupCenter(t); if (p) return { m: 'point', to: p, spread: 60, full: true, status: `교전 기동: ${t!.name}` }; }
      if (far(h, cen, op.to)) { x.phase = 'transit'; return { m: 'march', key: `amove:${Math.round(op.to.x)}:${Math.round(op.to.z)}`, to: op.to, status: '공격 이동 — 진격 중' }; }
      x.phase = 'hold';
      return { m: 'point', to: op.to, spread: 80, full: false, status: dist(cen, op.to) < 400 ? '공격 이동 완료 — 목표 지점 확보, 대기' : '공격 이동 — 목표 지점 접근' };
    }
    case 'intercept': {
      const t = st.groups[op.group];
      const ts = t ? h.shipsOf(t) : [];
      if (!t || !ts.length) {
        owner.op = { k: 'idle' }; owner.opx = { key: opKey(owner.op), phase: 'done', since: h.time, next: 0, done: 'intercept', reason: '목표 소멸' };
        h.say(owner, '요격 목표가 사라졌다. 작전 종료, 대기한다.', 'radio', 0);
        return { m: 'stop', status: '요격 목표 소멸 — 대기' };
      }
      const sp = ts.filter(s => s.state === 'space');
      if (!sp.length) { x.phase = 'hold'; return { m: 'stop', status: ts.some(s => s.state === 'battle') ? `${t.name} 교전 중 — 대기` : `${t.name} 정박 중 — 대기` }; }
      const tc = h.centroid(sp);
      const v = sp.reduce((a, s) => ({ x: a.x + s.vel.x / sp.length, y: 0, z: a.z + s.vel.z / sp.length }), { x: 0, y: 0, z: 0 });
      const warpTo = sp.find(s => s.warp)?.warp?.to;
      const speed = Math.min(...ships.map(s => h.cruiseOf(s) * (0.6 + 0.4 * s.hp)));
      const hostile = coRelation(st, owner.owner, t.owner) === -1;
      let p = warpTo ?? interceptPoint(cen, speed, tc, v);
      if (h.sysOf(p)?.id !== h.sysOf(tc)?.id) p = tc;
      const close = dist(cen, tc) < 900;
      x.phase = close ? 'engage' : 'transit';
      x.anchor = p;
      if (hostile) return { m: 'point', to: close ? tc : p, spread: 60, full: true, status: close ? `${t.name} 요격 — 접촉` : `${t.name} 차단 요격 — 예측 요격점으로 (${Math.round(dist(cen, p))}m)` };
      return { m: 'point', to: p, spread: 90, full: true, status: `${t.name} 진로 차단 (중립 — 공격하지 않음)` };
    }
    case 'reinforce': {
      if (op.eng) {
        const e = st.engagements[op.eng];
        if (!x.joined && fighting.some(s => s.engagement === op.eng)) x.joined = true;
        if (!e || e.done) {
          owner.op = { k: 'idle' };
          owner.opx = { key: opKey(owner.op), phase: 'done', since: h.time, next: 0, done: 'reinforce', reason: x.joined ? '증원 완료' : '교전이 먼저 끝남' };
          h.say(owner, x.joined ? '교전 종료 — 증원 임무 완료. 현 위치에서 대기한다.' : '지원할 교전이 끝났다. 대기한다.', 'radio', 0);
          return { m: 'stop', status: x.joined ? '증원 완료 — 대기' : '증원 대상 교전 종료 — 대기' };
        }
        const w = h.battles.get(e.id);
        const fightingSides = e.sides.map((s, k) => (w && k < w.sides.length && w.sides[k].out) ? null : s[0]).filter((s): s is string => !!s);
        const canJoin = fightingSides.some(co => coRelation(st, owner.owner, co) === -1);
        if (!canJoin) { x.phase = 'blocked'; x.reason = '적대 진영 없음 — 참전 불가'; return { m: 'point', to: inward(e.pos, cen, -2600), spread: 90, full: false, status: `증원 대기: ${x.reason}` }; }
        if (far(h, cen, e.pos)) { x.phase = 'transit'; return { m: 'march', key: `rf:${e.id}`, to: e.pos, status: '증원 — 교전 구역으로 이동' }; }
        x.phase = 'engage';
        return { m: 'point', to: e.pos, spread: 70, full: true, status: '증원 — 교전 구역 진입' };
      }
      const t = op.group ? st.groups[op.group] : undefined;
      const ts = t ? h.shipsOf(t) : [];
      if (!t || !ts.length) {
        owner.op = { k: 'idle' }; owner.opx = { key: opKey(owner.op), phase: 'done', since: h.time, next: 0, done: 'reinforce', reason: '지원 대상 소멸' };
        return { m: 'stop', status: '지원 대상 소멸 — 대기' };
      }
      const eng = ts.find(s => s.engagement)?.engagement;
      const e = eng ? st.engagements[eng] : undefined;
      if (e && !e.done) {
        const w = h.battles.get(e.id);
        const canJoin = e.sides.some((s, k) => !(w && k < w.sides.length && w.sides[k].out) && coRelation(st, owner.owner, s[0]) === -1);
        if (canJoin) { x.phase = 'engage'; return far(h, cen, e.pos) ? { m: 'march', key: `rf:${e.id}`, to: e.pos, status: `${t.name} 지원 — 교전 구역으로` } : { m: 'point', to: e.pos, spread: 70, full: true, status: `${t.name} 지원 — 교전 합류` }; }
        x.phase = 'blocked'; x.reason = '지원 대상의 적이 우리와 적대 관계가 아님';
        return { m: 'point', to: inward(e.pos, cen, -2600), spread: 90, full: false, status: `지원 대기: ${x.reason}` };
      }
      const tc = h.groupCenter(t) ?? ts[0].pos;
      x.phase = 'follow';
      return far(h, cen, tc) ? { m: 'march', key: `rfg:${t.id}:${Math.round(tc.x / 3000)}:${Math.round(tc.z / 3000)}`, to: tc, status: `${t.name} 지원 — 합류 이동` } : { m: 'point', to: inward(tc, cen, -300), spread: 80, full: false, status: `${t.name} 지원 — 동행` };
    }
  }
  return null;
}

function recon(h: Host, owner: WGroup, x: OpState, ships: WShip[], c: CommanderDef) {
  const st = h.st, R = (OPS.reconSensor + c.skill * 1500) * (1 + (groupFx(h.st, owner).detect ?? 0));
  const seen = new Map((x.report ?? []).map(r => [r.id, r]));
  const sees = (p: V) => ships.some(s => dist(s.pos, p) < R);
  for (const g of Object.values(st.groups)) {
    if (g.owner === owner.owner || !g.shipIds.length) continue;
    const ss = h.shipsOf(g).filter(s => s.state === 'space'); if (!ss.length) continue;
    const p = h.centroid(ss); if (!sees(p)) continue;
    const rel = coRelation(st, owner.owner, g.owner);
    seen.set(g.id, { id: g.id, kind: 'group', owner: g.owner, name: g.name, n: ss.length, mil: Math.round(milValue(h, ss)), pos: { x: Math.round(p.x), y: 0, z: Math.round(p.z) }, t: Math.round(h.time), rel });
  }
  for (const S of Object.values(st.stations)) {
    if (S.owner === owner.owner || !sees(S.pos)) continue;
    seen.set(S.id, { id: S.id, kind: 'station', owner: S.owner, name: S.name, n: 0, mil: 0, pos: { ...S.pos }, t: Math.round(h.time), rel: coRelation(st, owner.owner, S.owner) });
  }
  const list = [...seen.values()].sort((a, b) => b.t - a.t).slice(0, 30);
  const fresh = list.filter(r => !x.report?.some(o => o.id === r.id));
  x.report = list;
  if (fresh.some(r => r.rel === -1 && r.kind === 'group')) h.say(owner, `정찰 보고: 적대 함대 ${fresh.filter(r => r.rel === -1 && r.kind === 'group').map(r => `${r.name}(${r.n}척)`).join(', ')} 발견.`, 'warn', 2);
}

/** move the ships of group `g` (one of the command) according to the owner's plan */
export function stepOpShips(h: Host, g: WGroup, ships: WShip[], op: Op, plan: Plan, dt: number, c: CommanderDef) {
  const owner = h.opOwner(g);
  const x = owner.opx;
  g.status = plan.status;
  if (plan.m === 'march') {
    const m = h.fleetMarch(g, op, dt, { key: plan.key, to: plan.to });
    if (m) { for (const s of ships) h.marchShip(s, g, op, m, dt, c); g.status = `${plan.status} · ${g.status}`; return; }
  }
  for (const s of ships) {
    if (econOf(s).cruise <= 0) continue;
    const speed = h.cruiseOf(s) * (0.6 + 0.4 * s.hp);
    if (plan.m === 'stop' || plan.m === 'march') { if (s.state === 'space') { s.vel.x *= 0.85; s.vel.z *= 0.85; s.pos = { x: s.pos.x + s.vel.x * dt, y: s.pos.y, z: s.pos.z + s.vel.z * dt }; } continue; }
    if (plan.m === 'dock') {
      const sid = x?.station ?? x?.split?.[s.groupId];
      const S = sid ? h.st.stations[sid] : undefined;
      if (S) { h.goDock(s, S, dt, speed); }
      continue;
    }
    if (s.state === 'docked' && dist(s.pos, plan.to) < 200) continue;
    h.moveTo(s, h.formationSlot(s, g, plan.to, plan.spread), plan.full ? speed : Math.min(speed, h.groupSpeedOf(g)), dt, plan.full ? 10 : 40);
  }
  if (plan.m === 'dock' || plan.m === 'point' || plan.m === 'stop') g.status = plan.status;
}

// ---------------------------------------------------------------------------------------- validation

const finite = (p: unknown): p is V => !!p && typeof p === 'object' && ['x', 'y', 'z'].every(k => Number.isFinite((p as any)[k]));
const P12_ONLY = new Set<Op['k']>(['rally', 'defend', 'amove', 'intercept', 'blockade', 'harass', 'reinforce', 'recon', 'return']);

/** server-side check of a P12 order (null = valid); `subMobile` = mobile ships that would follow it */
/** undefined = not a P12 order (the regular validation applies) */
export function validateP12(h: Host, company: string, g: WGroup, op: Op, subMobile: number): string | null | undefined {
  const st = h.st;
  if (!P12_ONLY.has(op.k) && !(op.k === 'patrol' && (op as any).route !== undefined)) return undefined;
  if (!st.opsV) return '이 세계에서는 함대 작전(P12)이 활성화되지 않았습니다';
  if (!subMobile) return '기동 가능한 함선이 없음';
  const pt = (p: unknown, what = '좌표') => !finite(p) ? `${what} 오류` : !h.sysOf(p) ? `${what}가 성계 밖입니다` : null;
  const rad = (r: unknown, lo = 300, hi = 12000) => typeof r === 'number' && Number.isFinite(r) && r >= lo && r <= hi ? null : `반경은 ${lo}–${hi} 사이여야 합니다`;
  const route = (r: unknown) => r === undefined ? null : !Array.isArray(r) || r.length < 2 || r.length > 12 ? '순찰 경로는 2–12개 지점' : r.map(p => pt(p, '경로 지점')).find(Boolean) ?? null;
  switch (op.k) {
    case 'rally': return pt(op.at);
    case 'defend': case 'recon': return pt(op.at) ?? rad(op.radius);
    case 'patrol': case 'harass': return pt(op.at) ?? rad(op.radius) ?? route(op.route);
    case 'amove': return pt(op.to);
    case 'intercept': {
      const t = st.groups[op.group];
      if (!t || !t.shipIds.length) return '요격 대상 없음';
      if (t.owner === company) return '자사 함대는 요격할 수 없습니다';
      return null;
    }
    case 'blockade': {
      const sys = st.systems[op.system];
      if (!sys || !sys.gates.some(x => x.id === op.gate)) return '관문 없음';
      return null;
    }
    case 'reinforce': {
      if (!!op.eng === !!op.group) return '증원 대상(교전 또는 함대) 하나를 지정하세요';
      if (op.eng) {
        const e = st.engagements[op.eng];
        if (!e || e.done || e.v !== 2) return '진행 중인 교전이 아님';
        const w = h.battles.get(e.id);
        const fighting = e.sides.map((s, k) => (w && k < w.sides.length && w.sides[k].out) ? null : s[0]).filter((s): s is string => !!s);
        if (!fighting.some(co => coRelation(st, company, co) === -1)) return '교전 측 중 적대 관계인 세력이 없어 참전할 수 없습니다';
        return null;
      }
      const t = st.groups[op.group!];
      if (!t || !t.shipIds.length) return '지원 대상 없음';
      if (t.id === g.id || (t.owner !== company && coRelation(st, company, t.owner) !== 1)) return '자사 또는 동맹 함대만 지원할 수 있습니다';
      return null;
    }
    case 'return': return null;
  }
  return null;
}
