// P13.4 law enforcement (lawV worlds only).
//
// Crimes that already exist in the world (cargo extortion, unauthorised salvage, smuggling caught at an inspection,
// an unprovoked attack in policed space, fighting the guards, fleeing or resisting a stop) become *cases*. A case is
// known to the authority only through a real channel — a guard ship or a garrisoned station that saw it, a victim
// that survived to report it, an inspection, a battle with the guards — and only where an authority reaches
// (jurisdiction). Known cases make a per-company wanted level; the Union security forces that already patrol the
// world (patrols, rapid-response fleets — real ships, real speed, real gates) are then sent to where the suspect was
// last *seen*, issue a stop demand, and the suspect answers: comply (inspection, seizure, fine), flee (pursuit with
// limits) or resist (a P11 battle between that guard group and that target group only). Nothing is spawned or
// teleported, no company becomes permanently hostile, and the existing P13.1–P13.3 penalties are not repeated.
import type { WorldSim } from './sim';
import type { Engagement, StarSystem, Station, V, WGroup, WShip, WorldState } from './types';
import type { Relation } from '../sim/types';
import { dist } from './geom';
import { effSec } from './security';
import { relIn } from './sovereignty';
import { coRelation } from './battleAuth';
import { emit, watchMoney } from './observe';
import { book } from './operations';
import { fundsIn } from './market';
import { econOf } from './hullops';
import { guardInspect } from './blackmarket';
import { repOffense, type RepOffense } from './reputation';

type Host = WorldSim;
/** P14.0: law-only crimes charged to reputation when they become known */
const REP_AT_KNOWN: LawKind[] = ['strike', 'guard_attack', 'flee', 'resist'];

export type LawKind = 'extortion' | 'salvage' | 'smuggling' | 'strike' | 'guard_attack' | 'flee' | 'resist';
export type LawHow = 'victim' | 'guard' | 'station' | 'inspection' | 'combat';
export type LawAuth = 'union';

export const LAW = {
  /** decisions (reports, tracking, dispatch, pursuit limits) run on this interval; movement runs every tick */
  tick: 2,
  /** below this effective security (or in pirate / lawless / uncharted space) there is no authority at all */
  minSec: 15,
  /** a Union warship sees ships within this range; a garrisoned public station within this one */
  seeR: 6000, stationSeeR: 9000,
  /** a surviving victim's report reaches the authority after this delay */
  reportDelay: 30,
  /** wanted level thresholds on the case score: watch, wanted, high-risk, armed-danger */
  levels: [1, 3, 7, 12] as const,
  /** severity of one case (before its value term) */
  sev: { extortion: 3, salvage: 2, smuggling: 1, strike: 5, guard_attack: 10, flee: 4, resist: 8 } as Record<LawKind, number>,
  /** value term: + value / valueScale, capped */
  valueScale: 20000, valueCap: { extortion: 4, salvage: 3, smuggling: 0, strike: 3, guard_attack: 0, flee: 0, resist: 0 } as Record<LawKind, number>,
  /** fine: base + share of the value taken (smuggling is fined at the inspection itself — never billed again here) */
  fineBase: { extortion: 2000, salvage: 1000, smuggling: 0, strike: 6000, guard_attack: 15000, flee: 3000, resist: 8000 } as Record<LawKind, number>,
  fineRate: { extortion: 0.5, salvage: 0.5, smuggling: 0, strike: 0, guard_attack: 0, flee: 0, resist: 0 } as Record<LawKind, number>,
  /** minor cases fade over this time (an unpaid fine keeps them at watch level); serious ones only by payment + probation */
  decay: 3600, probation: 3600,
  serious: ['strike', 'guard_attack', 'resist'] as LawKind[],
  /** an unreported case nobody saw is forgotten after this */
  unreportedLife: 3600,
  /** a sighting older than this does not start a dispatch */
  staleMax: 600,
  /** guards demand a stop within this distance; the suspect has `answerFor` seconds to answer */
  stopR: 1500, standoff: 700, answerFor: 60,
  /** a suspect this far from the stopping guards before answering has fled */
  fleeR: 2600,
  /** inspection takes this long once the ship holds still */
  inspectFor: 15,
  /** caught again while fleeing / armed-danger: guards open fire within this distance */
  engageR: 1000,
  /** pursuit ends after this time, this route distance from the guards' home, or this long without a sighting at
   *  the last known position */
  pursuitMax: 900, pursuitDist: 60000, lostAfter: 90, searchR: 900,
  /** concurrent dispatches per guard home system and in the whole world */
  capSys: 2, capAll: 8,
  /** guards below this mean hull do not take a new job (they go home to repair) */
  minHp: 0.55,
  /** fines are paid by a ship within this distance of a public station in policed space (or while stopped) */
  payR: 4000,
  /** closed case records kept per world (unresolved cases and unpaid fines are never pruned) */
  keepClosed: 80,
  /** a released / ended stop stays visible to its fleet for this long */
  showFor: 300,
};

export interface LawSeen { pos: V; sys: string; t: number; group?: string }
export interface LawCase {
  id: string; key: string; kind: LawKind; t: number;
  by: string; group?: string; ship?: string;
  victim?: string; vgroup?: string;
  sys: string; pos: V;
  /** the territory whose law was broken (P10 faction; 'union' on worlds without territory) — null: lawless */
  juris: string | null;
  /** who can act on it: the Union security forces where they are stationed — null: record only */
  auth: LawAuth | null;
  value: number; sev: number;
  known: boolean; how?: LawHow; reportAt?: number;
  warrant: boolean;
  /** fine assessed (total) and paid so far: unpaid = fine − paid, always ≥ 0 */
  fine: number; paid: number;
  /** P13.4.1: the fine was fixed when the case was made (a seizure fine) — never recomputed from the case value */
  fixed?: boolean;
  /** P13.4.1: the public station whose authority billed this fine: payments go to its budget, and a ship near it can
   *  always pay (also where no Union guard enforces) */
  creditor?: string;
  /** the authority's last sighting of the suspect group (not its true position) */
  seen?: LawSeen;
  /** this case was already enforced once (stop + inspection, or a battle): it no longer starts dispatches */
  served?: number;
  state: 'unreported' | 'open' | 'probation' | 'closed';
  until?: number; end?: string; endT?: number;
}
export interface LawOp {
  id: string; co: string; target: string; guards: string[]; home: string; sys: string;
  phase: 'go' | 'demand' | 'hold' | 'pursue' | 'engage' | 'fight' | 'return';
  t0: number; tp: number; level: number;
  last: LawSeen; demandAt?: V; answerBy?: number; inspectAt?: number; e?: string;
  end?: string;
}
export interface LawBook {
  seq: number; next: number; cases: Record<string, LawCase>; keys: Record<string, string>; ops: Record<string, LawOp>;
  /** target group → when its last operation ended without catching it: a new dispatch needs a sighting after this */
  ended?: Record<string, number>;
}

/** what the suspect fleet knows about the guards stopping it (owner-only; guard positions only when they are seen) */
export interface LawStop {
  op: string; phase: 'approach' | 'demand' | 'hold' | 'pursuit' | 'fight' | 'released';
  guard: string; guardName: string; since: number; level: number;
  answerBy?: number; guardSeen?: { pos: V; t: number };
  end?: string; note?: string; until?: number;
}
export interface LawCaseView { id: string; kind: LawKind; t: number; sys: string; juris: string | null; auth: LawAuth | null; value: number; sev: number; how?: LawHow; fine: number; paid: number; state: LawCase['state']; until?: number; end?: string; served?: boolean; group?: string; creditor?: string }
/** the company's own view of its record with the authority (private: never in publicCompany). `fined` / `paid`: totals
 *  over the cases listed (fined = paid + unpaid of those cases) */
export interface CoLaw { level: number; score: number; unpaid: number; fined?: number; paid?: number; cases: LawCaseView[]; pursuits: { group: string; phase: LawStop['phase'] }[] }

export const LEVEL_KO = ['없음', '감시', '수배', '고위험', '무장 위험'];
export const KIND_KO: Record<LawKind, string> = { extortion: '화물 갈취', salvage: '무단 인양', smuggling: '밀수 적발', strike: '치안 구역 선제공격', guard_attack: '경비대 공격', flee: '정선 불응·도주', resist: '정선 무장 저항' };

export function lawBook(st: WorldState): LawBook { return (st.law ??= { seq: 0, next: 0, cases: {}, keys: {}, ops: {} }); }

// ------------------------------------------------------------------ jurisdiction

const polCache = new WeakMap<WorldState, { t: number; set: Set<string> }>();
/** systems where the Union security forces are stationed (a garrisoned public station, security ≥ 15): exactly where
 *  the existing guard plan places garrisons, patrols and response fleets */
export function policedSystems(h: Pick<Host, 'st' | 'sysOf'>): Set<string> {
  const c = polCache.get(h.st);
  if (c && Math.abs(h.st.time - c.t) < 60) return c.set;
  const set = new Set<string>();
  for (const x of Object.values(h.st.stations)) {
    if (!x.public || !(x.garrison ?? 0)) continue;
    const s = h.sysOf(x.pos); if (s && s.security >= 15) set.add(s.id);
  }
  polCache.set(h.st, { t: h.st.time, set });
  return set;
}
export function lawlessSys(sys: StarSystem | undefined): boolean {
  if (!sys) return true;
  const region = (sys as any).region as string | undefined;
  return effSec(sys) < LAW.minSec || sys.faction === 'pirates' || region === 'lawless' || region === 'uncharted';
}
/** whose law applies in this system and who can enforce it there */
export function jurisdiction(h: Pick<Host, 'st' | 'sysOf'>, sysId: string): { juris: string | null; auth: LawAuth | null } {
  const sys = h.st.systems[sysId];
  if (lawlessSys(sys)) return { juris: null, auth: null };
  return { juris: sys!.faction ?? 'union', auth: policedSystems(h).has(sysId) ? 'union' : null };
}

// ------------------------------------------------------------------ observation

const isGuard = (g: WGroup | undefined) => !!g && g.owner === 'union' && !!g.npc && (g.npc.role === 'patrol' || g.npc.role === 'qrf' || g.npc.role === 'garrison');
/** Union warships (with their group) in space, by system — rebuilt once per law tick */
function guardShips(h: Host): Map<string, WShip[]> {
  const out = new Map<string, WShip[]>();
  for (const g of Object.values(h.st.groups)) {
    if (!isGuard(g)) continue;
    for (const id of g.shipIds) {
      const s = h.st.ships[id]; if (!s || s.state === 'docked') continue;
      const sys = h.sysOf(s.pos)?.id; if (!sys) continue;
      (out.get(sys) ?? out.set(sys, []).get(sys)!).push(s);
    }
  }
  return out;
}
function watchStations(h: Host, sysId: string): Station[] {
  return Object.values(h.st.stations).filter(x => x.public && (x.garrison ?? 0) > 0 && h.sysOf(x.pos)?.id === sysId);
}
/** who of the authority saw something happen at p (a guard ship close by, a garrisoned station's sensors) */
export function witness(h: Host, p: V, sysId: string, ships?: Map<string, WShip[]>): LawHow | null {
  const gs = (ships ?? guardShips(h)).get(sysId) ?? [];
  if (gs.some(s => dist(s.pos, p) < LAW.seeR)) return 'guard';
  if (watchStations(h, sysId).some(x => dist(x.pos, p) < LAW.stationSeeR)) return 'station';
  return null;
}
/** where the authority can see the target group right now (centre of its observed ships), else null */
function observe(h: Host, g: WGroup, ships: Map<string, WShip[]>): LawSeen | null {
  let n = 0, x = 0, y = 0, z = 0, sys = '';
  for (const id of g.shipIds) {
    const s = h.st.ships[id]; if (!s) continue;
    const sy = h.sysOf(s.pos)?.id; if (!sy) continue;
    const seen = (ships.get(sy) ?? []).some(o => dist(o.pos, s.pos) < LAW.seeR) || watchStations(h, sy).some(st => dist(st.pos, s.pos) < LAW.stationSeeR);
    if (!seen) continue;
    n++; x += s.pos.x; y += s.pos.y; z += s.pos.z; sys = sy;
  }
  return n ? { pos: { x: x / n, y: y / n, z: z / n }, sys, t: h.time, group: g.id } : null;
}

// ------------------------------------------------------------------ cases

const sevOf = (k: LawKind, value: number) => LAW.sev[k] + Math.min(LAW.valueCap[k], value / LAW.valueScale);
const fineOf = (k: LawKind, value: number) => Math.round((LAW.fineBase[k] + value * LAW.fineRate[k]) / 10) * 10;
const unpaid = (c: LawCase) => Math.max(0, c.fine - c.paid);
/** a debt the company can settle: billed by the Union authority, or by a named station's authority */
const payable = (c: LawCase) => c.known && unpaid(c) > 0 && (!!c.auth || !!c.creditor);
const serious = (c: LawCase) => LAW.serious.includes(c.kind);

export interface CrimeInput {
  kind: LawKind; by: string; group?: string; ship?: string; victim?: string; vgroup?: string; sys: string; pos: V; value: number; key: string; how?: LawHow;
  /** P13.4.1: a fine already assessed by the event itself (a seizure) and what was collected at once */
  fine?: number; paid?: number; creditor?: string;
  /** P13.4.1: the event already enforced the case (goods seized at an inspection): no dispatch for it */
  served?: boolean;
}

/**
 * Record a crime. Idempotent by `key` (a drop, a salvage site per company, an inspection window, a battle, a stop):
 * the same event reported again, a restart or a repeated check never makes a second case — an open salvage case
 * only grows with the value really taken. Only player companies are prosecuted.
 */
export function lawCrime(h: Host, c: CrimeInput): LawCase | null {
  const st = h.st; if (!st.lawV) return null;
  if (st.companies[c.by]?.kind !== 'player') return null;
  const b = lawBook(st);
  const old = b.keys[c.key] ? b.cases[b.keys[c.key]] : undefined;
  if (old) {
    if (old.state === 'closed' || old.kind !== 'salvage' || c.value <= 0) return old;
    old.value += c.value; old.sev = sevOf(old.kind, old.value);
    if (old.auth && old.known) old.fine = Math.max(old.fine, fineOf(old.kind, old.value));
    refresh(h, old.by);
    return old;
  }
  const j = jurisdiction(h, c.sys);
  const cs: LawCase = {
    id: `law${++b.seq}`, key: c.key, kind: c.kind, t: h.time, by: c.by, group: c.group, ship: c.ship, victim: c.victim, vgroup: c.vgroup,
    sys: c.sys, pos: { ...c.pos }, juris: j.juris, auth: j.auth, value: Math.round(c.value), sev: sevOf(c.kind, c.value),
    known: false, warrant: false, fine: 0, paid: 0, state: 'unreported',
  };
  if (c.fine !== undefined) {
    cs.fixed = true; cs.fine = Math.max(0, Math.round(c.fine)); cs.paid = Math.min(cs.fine, Math.max(0, Math.round(c.paid ?? 0)));
  }
  if (c.creditor) cs.creditor = c.creditor;
  if (c.served) cs.served = h.time;
  b.cases[cs.id] = cs; b.keys[c.key] = cs.id;
  emit(st, { kind: 'law', reason: 'crime', amount: cs.sev, company: c.by, group: c.group, system: c.sys, ref: cs.id, item: c.kind, value: cs.value });
  if (cs.paid > 0) emit(st, { kind: 'law', reason: 'fine_paid', amount: cs.paid, company: c.by, ref: cs.id });
  // no law here: nothing to prosecute — but a fine already billed stays owed (payable at its creditor station)
  if (!j.juris) { if (cs.fixed && unpaid(cs) > 0) { cs.known = true; cs.how = c.how; } close(h, cs, 'lawless'); refresh(h, c.by); return cs; }
  const how = c.how ?? witness(h, c.pos, c.sys);
  if (how) makeKnown(h, cs, how, { pos: { ...c.pos }, sys: c.sys, t: h.time, group: c.group });
  else if (c.victim && reporter(st, c.victim)) cs.reportAt = h.time + LAW.reportDelay;
  // an enforced case paid in full at once (a seizure fine collected) is closed: no lingering wanted score
  if (cs.served !== undefined) settleCase(h, cs);
  refresh(h, c.by);
  return cs;
}
const reporter = (st: WorldState, co: string) => { const k = st.companies[co]?.kind; return k === 'player' || k === 'guild'; };

function makeKnown(h: Host, c: LawCase, how: LawHow, seen?: LawSeen) {
  if (c.known) return;
  c.known = true; c.how = how; c.state = 'open'; delete c.reportAt;
  if (seen) c.seen = seen;
  if (c.auth) { c.warrant = true; if (!c.fixed) c.fine = fineOf(c.kind, c.value); }
  emit(h.st, { kind: 'law', reason: 'known', amount: c.sev, company: c.by, system: c.sys, ref: c.id, item: c.kind });
  // P14.0 (repV): crimes that only exist as law cases reach reputation once, when the authority learns of them.
  // Extortion, salvage and smuggling were already charged by their own event (same act, never twice).
  if (h.st.repV && REP_AT_KNOWN.includes(c.kind)) repOffense(h.st, c.by, h.st.systems[c.sys]?.faction, c.kind as RepOffense, c.value, `law:${c.id}`, KIND_KO[c.kind]);
  const sys = h.st.systems[c.sys]?.name ?? c.sys;
  const src = { victim: '피해 신고', guard: '경비함 목격', station: '정거장 감시망', inspection: '검문', combat: '교전 기록' }[how];
  if (c.auth) h.ev('warn', `연합 보안국: ${sys} ${KIND_KO[c.kind]} 사건 접수 (${src})${c.fine ? ` — 벌금 ${c.fine.toLocaleString()} cr 부과` : ''}`, { company: c.by, pos: c.pos, ref: c.id, tag: 'law' });
  else h.ev('info', `${sys}: ${KIND_KO[c.kind]} 기록됨 (${src}) — 이 관할(${c.juris})에는 집행 경비대가 없어 기록만 남습니다`, { company: c.by, pos: c.pos, ref: c.id, tag: 'law' });
}
function close(h: Host, c: LawCase, end: string) {
  c.state = 'closed'; c.end = end; c.endT = h.time; delete c.reportAt; delete c.until;
  emit(h.st, { kind: 'law', reason: 'close', amount: 1, company: c.by, ref: c.id, item: c.kind });
}

/** weight of one case in the wanted score (only known cases of this authority count) */
function weight(c: LawCase, now: number): number {
  if (!c.known || !c.auth) return 0;
  if (c.state === 'probation') return c.sev * 0.5;
  if (c.state !== 'open') return 0;
  const owe = unpaid(c) > 0;
  if (c.served !== undefined) return owe ? 1 : 0;
  if (serious(c)) return c.sev;
  const w = c.sev * Math.max(0, 1 - (now - c.t) / LAW.decay);
  return owe ? Math.max(1, w) : w;
}
export function levelOf(score: number): number { let l = 0; for (const t of LAW.levels) if (score >= t - 1e-9) l++; return l; }
export function wanted(st: WorldState, co: string): { score: number; level: number } {
  let score = 0;
  for (const c of Object.values(st.law?.cases ?? {})) if (c.by === co) score += weight(c, st.time);
  return { score, level: levelOf(score) };
}

/** the company's own view (cases the authority knows of, plus unpaid / unresolved ones) */
function refresh(h: Host, co: string) {
  const c = h.st.companies[co]; if (!c || c.kind !== 'player') return;
  const w = wanted(h.st, co);
  const mine = Object.values(h.st.law?.cases ?? {}).filter(x => x.by === co && x.known && (x.juris || unpaid(x) > 0));
  const recent = mine.filter(x => x.state !== 'closed').concat(mine.filter(x => x.state === 'closed').sort((a, b) => (b.endT ?? 0) - (a.endT ?? 0)).slice(0, 8));
  const pursuits: CoLaw['pursuits'] = [];
  for (const g of Object.values(h.st.groups)) if (g.owner === co && g.lawStop && g.lawStop.phase !== 'released') pursuits.push({ group: g.id, phase: g.lawStop.phase });
  const view: CoLaw = {
    level: w.level, score: Math.round(w.score * 10) / 10, unpaid: mine.reduce((a, x) => a + (payable(x) ? unpaid(x) : 0), 0), pursuits,
    fined: recent.reduce((a, x) => a + x.fine, 0), paid: recent.reduce((a, x) => a + x.paid, 0),
    cases: recent.map(x => ({ id: x.id, kind: x.kind, t: x.t, sys: x.sys, juris: x.juris, auth: x.auth, value: x.value, sev: Math.round(x.sev * 10) / 10, how: x.how, fine: x.fine, paid: x.paid, state: x.state, until: x.until, end: x.end, served: x.served !== undefined, group: x.group, ...(x.creditor ? { creditor: x.creditor } : {}) })),
  };
  if (!view.level && !view.unpaid && !view.cases.length && !pursuits.length) { delete c.law; return; }
  c.law = view;
}

// ------------------------------------------------------------------ periodic step

/** reports, sightings, wanted levels, dispatch decisions and pursuit limits (every LAW.tick seconds) */
export function stepLaw(h: Host) {
  const st = h.st; if (!st.lawV) return;
  const b = lawBook(st);
  if (h.time < b.next) return;
  b.next = h.time + LAW.tick;
  const ships = guardShips(h);
  const touched = new Set<string>();
  // 1. reports, probation and forgetting
  for (const c of Object.values(b.cases)) {
    if (c.state === 'unreported') {
      if (c.reportAt !== undefined && h.time >= c.reportAt) {
        const alive = c.vgroup ? (st.groups[c.vgroup]?.shipIds.some(id => st.ships[id]) ?? false) : true;
        if (alive) { makeKnown(h, c, 'victim', { pos: c.pos, sys: c.sys, t: c.t, group: c.group }); touched.add(c.by); }
        else { delete c.reportAt; }
      }
      if (!c.known && c.reportAt === undefined && h.time - c.t > LAW.unreportedLife) { close(h, c, 'unreported'); }
    } else if (c.state === 'probation' && h.time >= (c.until ?? 0)) { close(h, c, 'probation_done'); touched.add(c.by); }
    else if (c.state === 'open' && !serious(c) && unpaid(c) <= 0 && h.time - c.t >= LAW.decay) { close(h, c, 'expired'); touched.add(c.by); }
  }
  // 2. sightings of wanted suspects and dispatch
  const suspects = new Map<string, LawCase[]>();
  for (const c of Object.values(b.cases)) if (c.auth && c.known && c.state === 'open' && c.served === undefined) {
    const g = targetGroup(st, c); if (!g) continue;
    (suspects.get(g.id) ?? suspects.set(g.id, []).get(g.id)!).push(c);
  }
  const levels = new Map<string, number>();
  const lvl = (co: string) => levels.get(co) ?? levels.set(co, wanted(st, co).level).get(co)!;
  for (const [gid, cases] of suspects) {
    const g = st.groups[gid]; const co = g.owner;
    const seen = observe(h, g, ships);
    if (seen) for (const c of cases) c.seen = seen;
    const last = cases.map(c => c.seen).filter((x): x is LawSeen => !!x).sort((a, b) => b.t - a.t)[0];
    const op = Object.values(b.ops).find(o => o.target === gid);
    if (op) { if (seen) op.last = seen; continue; }
    if (lvl(co) < 2 || !last || h.time - last.t > LAW.staleMax) continue;
    // no re-dispatch on the sighting an ended operation already chased (lost / out of reach): it needs a new one
    if ((b.ended?.[gid] ?? -Infinity) >= last.t) continue;
    if (!policedSystems(h).has(last.sys)) continue;
    if (g.shipIds.every(id => st.ships[id]?.state === 'battle')) continue;
    dispatch(h, g, last, lvl(co), cases);
  }
  // 3. running operations: limits, endings, reinforcement into a law battle
  for (const op of Object.values(b.ops)) { opTick(h, op, ships); touched.add(op.co); }
  if (b.ended) { for (const [gid, t] of Object.entries(b.ended)) if (h.time - t > LAW.staleMax || !st.groups[gid]) delete b.ended[gid]; if (!Object.keys(b.ended).length) delete b.ended; }
  // 4. prune closed records beyond the cap (never an unresolved case or an unpaid fine)
  const closed = Object.values(b.cases).filter(c => c.state === 'closed' && unpaid(c) <= 0).sort((a, b) => (a.endT ?? 0) - (b.endT ?? 0));
  for (let i = 0; i < closed.length - LAW.keepClosed; i++) { const c = closed[i]; delete b.cases[c.id]; if (b.keys[c.key] === c.id) delete b.keys[c.key]; }
  for (const co of Object.values(st.companies)) if (co.kind === 'player' && (co.law || touched.has(co.id) || Object.values(b.cases).some(c => c.by === co.id && c.known))) refresh(h, co.id);
  // released stops fade from the fleet view
  for (const g of Object.values(st.groups)) if (g.lawStop?.phase === 'released' && h.time >= (g.lawStop.until ?? 0)) delete g.lawStop;
}

/** the group a case points at now: the suspect ship's current group (it may have been regrouped), else its group */
function targetGroup(st: WorldState, c: LawCase): WGroup | undefined {
  const s = c.ship ? st.ships[c.ship] : undefined;
  const g = s ? st.groups[s.groupId] : c.group ? st.groups[c.group] : undefined;
  return g && g.owner === c.by && g.shipIds.length ? g : undefined;
}

// ------------------------------------------------------------------ dispatch

function freeGuard(h: Host, g: WGroup): boolean {
  if (!isGuard(g) || g.npc!.role === 'garrison' || g.lawx) return false;
  const ss = h.shipsOf(g);
  if (!ss.length || ss.some(s => s.state === 'battle') || !ss.some(s => s.state === 'space')) return false;
  return ss.reduce((a, s) => a + s.hp, 0) / ss.length >= LAW.minHp;
}
/** systems one gate away from `sys` that are policed too (guards may come from next door, never from far away) */
function near(h: Host, sys: string): Set<string> {
  const out = new Set([sys]);
  const pol = policedSystems(h);
  for (const gt of h.st.systems[sys]?.gates ?? []) if (pol.has(gt.to)) out.add(gt.to);
  return out;
}
function dispatch(h: Host, target: WGroup, last: LawSeen, level: number, cases: LawCase[]) {
  const st = h.st, b = lawBook(st), ops = Object.values(b.ops);
  if (ops.length >= LAW.capAll) return;
  const area = near(h, last.sys);
  // only guards whose pursuit limit reaches the sighting (a dispatch that would end at once on distance is pointless)
  const reach = (g: WGroup) => { const home = st.stations[g.npc!.home]; return !home || h.routeDistance(home.pos, last.pos) <= LAW.pursuitDist; };
  const cands = Object.values(st.groups).filter(g => freeGuard(h, g) && area.has(g.npc!.sys) && ops.filter(o => o.sys === g.npc!.sys).length < LAW.capSys && reach(g));
  if (!cands.length) return;
  const d = (g: WGroup) => h.routeDistance(h.groupCenter(g)!, last.pos);
  const pick: WGroup[] = [];
  const byRole = (r: string) => cands.filter(g => g.npc!.role === r).sort((a, b) => d(a) - d(b));
  // minor: the nearest patrol checks; high-risk: the response fleet; guards were attacked: both
  if (level >= 3) { const q = byRole('qrf')[0] ?? byRole('patrol')[0]; if (q) pick.push(q); }
  else { const p = byRole('patrol')[0] ?? byRole('qrf')[0]; if (p) pick.push(p); }
  if (cases.some(c => c.kind === 'guard_attack' || c.kind === 'resist')) { const x = cands.filter(g => !pick.includes(g)).sort((a, b) => d(a) - d(b))[0]; if (x) pick.push(x); }
  if (!pick.length) return;
  const lead = pick[0];
  const op: LawOp = { id: h.id('lop'), co: target.owner, target: target.id, guards: pick.map(g => g.id), home: lead.npc!.home, sys: lead.npc!.sys, phase: 'go', t0: h.time, tp: h.time, level, last: { ...last } };
  b.ops[op.id] = op;
  for (const g of pick) { g.lawx = op.id; g.status = '연합 보안국 출동 — 검문 임무'; }
  const sys = st.systems[last.sys];
  emit(st, { kind: 'law', reason: 'dispatch', amount: pick.length, company: target.owner, group: target.id, system: last.sys, ref: op.id });
  // public notice without the suspect (who is chased is the suspect's and the authority's business only)
  h.ev('world', `${sys?.name ?? ''}: ${pick.map(g => g.name).join(', ')} 출동 — 연합 보안국 검문`, { pos: last.pos });
}

// ------------------------------------------------------------------ operation decisions (law tick)

function guardsOf(h: Host, op: LawOp): WGroup[] { return op.guards.map(id => h.st.groups[id]).filter((g): g is WGroup => !!g && g.lawx === op.id && g.shipIds.some(id => h.st.ships[id])); }
function center(h: Host, gs: WGroup[]): V | null {
  let n = 0, x = 0, y = 0, z = 0;
  for (const g of gs) for (const id of g.shipIds) { const s = h.st.ships[id]; if (!s || s.state === 'battle') continue; n++; x += s.pos.x; y += s.pos.y; z += s.pos.z; }
  return n ? { x: x / n, y: y / n, z: z / n } : null;
}
function setStop(h: Host, op: LawOp, t: WGroup, phase: LawStop['phase'], extra: Partial<LawStop> = {}) {
  const lead = h.st.groups[op.guards[0]];
  const prev = t.lawStop?.op === op.id ? t.lawStop : undefined;
  t.lawStop = { ...(prev ?? {}), op: op.id, phase, guard: lead?.id ?? '', guardName: lead?.name ?? '연합 경비대', since: prev?.phase === phase ? prev.since : h.time, level: op.level, ...extra };
}

function opTick(h: Host, op: LawOp, ships: Map<string, WShip[]>) {
  const st = h.st;
  const t = st.groups[op.target];
  const gs = guardsOf(h, op);
  if (op.phase === 'return') { if (!gs.length) delete lawBook(st).ops[op.id]; return; }
  // a law battle settles first (the target or the guards may be gone with it)
  if (op.phase === 'fight') {
    const e = op.e ? st.engagements[op.e] : undefined;
    if (!e || e.done) return battleOver(h, op, e);
    // dispatched guards arriving while it runs join the guards' side; nobody else is pulled in by the law
    const w = h.battles.get(e.id);
    if (w?.joinOpen()) for (const g of gs) {
      const free = h.freeShips(g).filter(s => dist(s.pos, e.pos) < 1700);
      if (free.length) h.joinEngagement(e, 'union', [{ g, ss: free }]);
    }
    return;
  }
  if (!gs.length) return finish(h, op, 'guards_lost');
  if (!t || !t.shipIds.some(id => st.ships[id])) return finish(h, op, 'target_gone');
  const gc = center(h, gs);
  // the target's view of the guards: only what its own ships can see
  const tSeen = gc && t.shipIds.some(id => { const s = st.ships[id]; return !!s && dist(s.pos, gc) < LAW.seeR; });
  if (t.lawStop?.op === op.id && tSeen) t.lawStop.guardSeen = { pos: { ...gc! }, t: h.time };
  else if (!t.lawStop && tSeen && op.phase === 'go') setStop(h, op, t, 'approach', { guardSeen: { pos: { ...gc! }, t: h.time } });
  if (gc && op.phase !== 'hold') {
    if (h.time - op.t0 > LAW.pursuitMax) return finish(h, op, 'timeout');
    if (!policedSystems(h).has(op.last.sys)) return finish(h, op, 'left_jurisdiction');
    const home = st.stations[op.home];
    if (home && h.routeDistance(home.pos, gc) > LAW.pursuitDist) return finish(h, op, 'distance');
    const fresh = h.time - op.last.t <= LAW.tick * 1.5;
    if (!fresh && dist(gc, op.last.pos) < LAW.searchR && h.time - op.last.t > LAW.lostAfter) return finish(h, op, 'lost');
  }
  const tc = h.groupCenter(t);
  switch (op.phase) {
    case 'go': {
      const fresh = h.time - op.last.t <= LAW.tick * 1.5;
      if (!gc || !tc || !fresh || dist(gc, op.last.pos) > LAW.stopR) break;
      if (op.level >= 4) { op.phase = 'engage'; op.tp = h.time; setStop(h, op, t, 'fight', { note: '무장 위험 수배 — 강제 진압' }); h.ev('warn', `${t.name}: 연합 경비대가 무장 위험 수배자로 강제 진압에 나섰습니다`, { company: t.owner, pos: tc, ref: op.id, tag: 'law' }); break; }
      op.phase = 'demand'; op.tp = h.time; op.demandAt = { ...tc }; op.answerBy = h.time + LAW.answerFor;
      setStop(h, op, t, 'demand', { answerBy: op.answerBy, guardSeen: { pos: { ...gc }, t: h.time } });
      emit(st, { kind: 'law', reason: 'stop', amount: 1, company: t.owner, group: t.id, ref: op.id });
      h.ev('warn', `${t.name}: 연합 경비대 정선 요구 — ${LAW.answerFor}초 안에 협조·도주·저항을 선택하세요 (무응답: 협조)`, { company: t.owner, pos: tc, ref: op.id, tag: 'law' });
      for (const g of gs) h.say(g, `${t.name}, 연합 보안국이다. 즉시 정지하고 검문에 응하라.`, 'radio', 20);
      break;
    }
    case 'demand': {
      // an actual run for it (moved well away from where it was stopped / from the guards) is fleeing
      const moved = tc && op.demandAt ? dist(tc, op.demandAt) : 0, gap = tc && gc ? dist(tc, gc) : 0;
      if (moved > LAW.fleeR || gap > LAW.fleeR + LAW.stopR) { answer(h, op, t, 'flee', 'auto'); break; }
      if (h.time >= (op.answerBy ?? 0)) answer(h, op, t, 'comply', 'auto');
      break;
    }
    case 'hold':
      if (h.time >= (op.inspectAt ?? 0)) inspectAndSettle(h, op, t);
      break;
    case 'pursue': {
      const fresh = h.time - op.last.t <= LAW.tick * 1.5;
      if (gc && tc && fresh && dist(gc, op.last.pos) < LAW.engageR) { op.phase = 'engage'; op.tp = h.time; setStop(h, op, t, 'fight'); }
      break;
    }
    case 'engage': {
      if (!gc || !tc) break;
      const fresh = h.time - op.last.t <= LAW.tick * 1.5;
      if (fresh && dist(gc, tc) < LAW.engageR) startFight(h, op, t, gs);
      break;
    }
  }
}

/** the suspect's choice (a command, or the automatic answer at the deadline / when it ran) */
export function answer(h: Host, op: LawOp, t: WGroup, choice: 'comply' | 'flee' | 'resist', by: 'player' | 'auto') {
  const st = h.st, tc = h.groupCenter(t) ?? op.last.pos, sys = h.sysOf(tc)?.id ?? op.last.sys;
  emit(st, { kind: 'law', reason: `answer_${choice}`, amount: 1, company: t.owner, group: t.id, ref: op.id, item: by });
  if (choice === 'comply') {
    op.phase = 'hold'; op.tp = h.time; op.inspectAt = h.time + LAW.inspectFor;
    setStop(h, op, t, 'hold', { note: by === 'auto' ? '응답 없음 — 정지·검문 대기 (기본 협조)' : '협조 — 정지 후 검문' });
    h.ev('info', `${t.name}: 정선 요구에 협조 — 정지 후 검문 (${LAW.inspectFor}초)`, { company: t.owner, pos: tc, ref: op.id, tag: 'law' });
  } else if (choice === 'flee') {
    op.phase = 'pursue'; op.tp = h.time;
    lawCrime(h, { kind: 'flee', by: t.owner, group: t.id, ship: t.shipIds[0], sys, pos: tc, value: 0, key: `flee:${op.id}`, how: 'guard' });
    op.level = Math.max(op.level, wanted(st, t.owner).level);
    setStop(h, op, t, 'pursuit', { note: by === 'auto' ? '정선 지점 이탈 — 도주로 기록' : '도주 — 경비대 추격' });
    h.ev('warn', `${t.name}: 정선 불응·도주 — 연합 경비대 추격 시작`, { company: t.owner, pos: tc, ref: op.id, tag: 'law' });
  } else {
    op.phase = 'engage'; op.tp = h.time;
    lawCrime(h, { kind: 'resist', by: t.owner, group: t.id, ship: t.shipIds[0], sys, pos: tc, value: 0, key: `resist:${op.id}`, how: 'guard' });
    op.level = Math.max(op.level, wanted(st, t.owner).level);
    setStop(h, op, t, 'fight', { note: '무장 저항 — 교전' });
    h.ev('warn', `${t.name}: 정선 요구에 무장 저항 — 연합 경비대와 교전`, { company: t.owner, pos: tc, ref: op.id, tag: 'law' });
  }
  refresh(h, t.owner);
}

/** the inspection after compliance: contraband seized (P13.3 rules, stolen goods to their owner's customs), the
 *  company's outstanding fines with this authority billed against its credits, the stop released */
function inspectAndSettle(h: Host, op: LawOp, t: WGroup) {
  const st = h.st, co = st.companies[t.owner];
  const sysId = h.sysOf(h.groupCenter(t) ?? op.last.pos)?.id ?? op.last.sys, sys = st.systems[sysId];
  let seized = 0;
  const home = st.stations[op.home];
  for (const s of h.shipsOf(t)) if (sys) seized += guardInspect(h, s, sys, op.id, home);
  let billed = 0;
  const open = Object.values(lawBook(st).cases).filter(c => c.by === t.owner && c.auth && c.known && (c.state === 'open' || c.state === 'probation')).sort((a, b) => a.t - b.t);
  watchMoney(st, 'law_fine', { company: t.owner, station: home?.id }, () => {
    for (const c of open) {
      const due = unpaid(c); if (due <= 0 || !co || co.credits <= 0) continue;
      const pay = Math.min(due, Math.floor(co.credits));
      co.credits -= pay; c.paid += pay; billed += pay;
      book(h, t.owner, 'law_fines', -pay, c.id);
      const to = (c.creditor && st.stations[c.creditor]) || home;
      if (to?.public) fundsIn(to, pay);
    }
  });
  if (billed) emit(st, { kind: 'law', reason: 'fine_paid', amount: billed, company: t.owner, ref: op.id });
  for (const c of open) { if (targetGroup(st, c)?.id === t.id || c.group === t.id) c.served = h.time; settleCase(h, c); }
  const left = open.reduce((a, c) => a + unpaid(c), 0);
  setStop(h, op, t, 'released', { end: 'inspected', until: h.time + LAW.showFor, note: `검문 완료 — 압수 ${Math.round(seized)}단위, 벌금 납부 ${billed.toLocaleString()} cr${left ? `, 미납 ${left.toLocaleString()} cr` : ''}` });
  h.ev('info', `${t.name}: 연합 경비대 검문 종료 — 압수 ${Math.round(seized)}단위, 벌금 ${billed.toLocaleString()} cr 납부${left ? ` (미납 ${left.toLocaleString()} cr — 치안 구역 정거장에서 납부)` : ''}`, { company: t.owner, pos: h.groupCenter(t) ?? op.last.pos, ref: op.id, tag: 'law' });
  finish(h, op, 'inspected', true);
}

/** a fully paid case: a minor one closes, a serious one goes on probation (it is not wiped by one payment) */
function settleCase(h: Host, c: LawCase) {
  if (c.state !== 'open' || unpaid(c) > 0) return;
  if (serious(c)) { c.state = 'probation'; c.until = h.time + LAW.probation; }
  else close(h, c, 'paid');
}

function startFight(h: Host, op: LawOp, t: WGroup, gs: WGroup[]) {
  const st = h.st;
  const tss = h.freeShips(t); if (!tss.length) return;
  const tc = h.groupCenter(t)!;
  const list: { g: WGroup; ss: WShip[] }[] = [];
  for (const g of gs) { const ss = h.freeShips(g).filter(s => dist(s.pos, tc) < 1700); if (ss.length) list.push({ g, ss }); }
  if (!list.length) return;
  const all = list.flatMap(x => x.ss);
  let x = 0, z = 0; for (const s of all) { x += s.pos.x; z += s.pos.z; }
  const pos = { x: (x / all.length + tc.x) / 2, y: tc.y, z: (z / all.length + tc.z) / 2 };
  list.push({ g: t, ss: tss.filter(s => dist(s.pos, pos) < 1700) });
  const e = h.createEngagementP11(pos, list, undefined, { op: op.id, co: t.owner });
  op.e = e.id; op.phase = 'fight'; op.tp = h.time;
  setStop(h, op, t, 'fight', { note: '연합 경비대와 교전 중' });
  emit(st, { kind: 'law', reason: 'battle', amount: all.length, company: t.owner, group: t.id, ref: e.id });
}

function battleOver(h: Host, op: LawOp, e: Engagement | undefined) {
  const st = h.st, t = st.groups[op.target];
  // the guards lost or were damaged in it: the target fought the guards (combat record)
  const hit = e ? guardDamage(st, e) : 0;
  const tsys = e?.sys ?? op.last.sys;
  if (e && hit > 0) lawCrime(h, { kind: 'guard_attack', by: op.co, group: op.target, ship: t?.shipIds[0], sys: tsys, pos: e.pos, value: 0, key: `gatk:${e.id}`, how: 'combat' });
  const alive = !!t && t.shipIds.some(id => st.ships[id]);
  for (const c of Object.values(lawBook(st).cases)) if (c.by === op.co && c.state === 'open' && c.served === undefined && (c.group === op.target || (t && targetGroup(st, c)?.id === t.id))) {
    // a suppressed target's cases were enforced (the fines stay owed); a target that got away stays wanted
    if (!alive) c.served = h.time;
  }
  if (t) setStop(h, op, t, 'released', { end: alive ? 'battle_over' : 'suppressed', until: h.time + LAW.showFor, note: alive ? '교전 종료 — 수배 유지' : '진압됨' });
  finish(h, op, alive ? 'battle_over' : 'suppressed', true);
}
/** hull lost by the guards in a law battle (sunk ships count as a full hull) */
export function guardDamage(st: WorldState, e: Engagement): number {
  let d = 0;
  for (const [id, hp] of e.law?.ships ?? []) { const s = st.ships[id]; d += s ? Math.max(0, hp - s.hp) : hp; }
  return d > 0.01 ? d : 0;
}

/** an operation ends: guards go home (real flight; the slot keeps its refit rules), the target's stop is cleared */
function finish(h: Host, op: LawOp, end: string, keepStop = false) {
  const st = h.st;
  op.end = end; op.phase = 'return'; op.tp = h.time;
  // an operation that did not get the target (lost it, out of reach, time) blocks re-dispatch on the same sighting
  if (['lost', 'distance', 'timeout', 'left_jurisdiction', 'guards_lost'].includes(end)) (lawBook(st).ended ??= {})[op.target] = h.time;
  const t = st.groups[op.target];
  if (t?.lawStop?.op === op.id && !keepStop) {
    if (end === 'guards_lost' || end === 'target_gone') delete t.lawStop;
    else setStop(h, op, t, 'released', { end, until: h.time + LAW.showFor, note: END_KO[end] ?? end });
  }
  emit(st, { kind: 'law', reason: `end_${end}`, amount: 1, company: op.co, group: op.target, ref: op.id });
  const gs = op.guards.map(id => st.groups[id]).filter((g): g is WGroup => !!g && g.lawx === op.id);
  if (!gs.some(g => g.shipIds.length)) { for (const g of gs) delete g.lawx; delete lawBook(st).ops[op.id]; }
  if (t && end !== 'inspected' && end !== 'battle_over' && end !== 'suppressed') h.ev('info', `${t.name}: 연합 경비대 ${END_KO[end] ?? end}`, { company: t.owner, pos: h.groupCenter(t) ?? op.last.pos, ref: op.id, tag: 'law' });
  refresh(h, op.co);
}
export const END_KO: Record<string, string> = {
  inspected: '검문 완료', timeout: '추격 시간 초과 — 추격 종료', distance: '추격 거리 한계 — 추격 종료', left_jurisdiction: '관할 구역 이탈 — 추격 종료',
  lost: '목표 상실 — 추격 종료', guards_lost: '경비대 전멸', target_gone: '목표 소멸', battle_over: '교전 종료', suppressed: '진압 완료',
};

// ------------------------------------------------------------------ movement (every tick, from runGroup)

/**
 * Law movement for this tick. Dispatched guards fly (real speed, gate routing that respects closed gates) toward the
 * suspect where they can see it, otherwise toward the last sighting; a stopped suspect holds still. Returns true
 * when the group's normal order was replaced this tick.
 */
export function lawGroup(h: Host, g: WGroup, ships: WShip[], dt: number): boolean {
  const st = h.st;
  if (g.lawx) {
    const op = lawBook(st).ops[g.lawx];
    if (!op) { delete g.lawx; return false; }
    const free = ships.filter(s => s.state !== 'battle');
    if (op.phase === 'return') {
      const home = st.stations[g.npc?.home ?? op.home];
      const c = h.groupCenter(g);
      if (!home || !c || dist(c, home.pos) < 3000) {
        delete g.lawx;
        if (!Object.values(st.groups).some(x => x.lawx === op.id)) delete lawBook(st).ops[op.id];
        return false;
      }
      for (const s of free) h.moveTo(s, h.formationSlot(s, g, home.pos, 70), speedOf(h, g, s), dt, 60);
      g.status = `귀환 중 (${END_KO[op.end ?? ''] ?? op.end ?? ''})`;
      return true;
    }
    const t = st.groups[op.target];
    const tc = t ? h.groupCenter(t) : null;
    const fresh = h.time - op.last.t <= LAW.tick * 1.5;
    let goal = fresh && tc ? tc : op.last.pos, tol = 40, status = '';
    if (op.phase === 'demand' || op.phase === 'hold') {
      // hold a standoff from the stopped ship
      const c = h.groupCenter(g) ?? goal;
      const dx = c.x - goal.x, dz = c.z - goal.z, l = Math.hypot(dx, dz) || 1;
      goal = { x: goal.x + dx / l * LAW.standoff, y: goal.y, z: goal.z + dz / l * LAW.standoff };
      status = op.phase === 'demand' ? '정선 요구 중' : '검문 중';
    } else status = op.phase === 'pursue' ? `추격 중${fresh ? '' : ' (마지막 목격 지점)'}` : op.phase === 'engage' ? '강제 진압' : `출동 중${fresh ? '' : ' (마지막 목격 지점)'}`;
    for (const s of free) h.moveTo(s, h.formationSlot(s, g, goal, 60), speedOf(h, g, s), dt, tol);
    g.status = status;
    return true;
  }
  const stop = g.lawStop;
  if (stop && stop.phase === 'hold') {
    for (const s of ships) if (s.state === 'space') { s.vel.x *= 0.8; s.vel.z *= 0.8; s.pos = { x: s.pos.x + s.vel.x * dt, y: s.pos.y, z: s.pos.z + s.vel.z * dt }; }
    g.status = '정선 — 연합 경비대 검문 중';
    return true;
  }
  return false;
}
function speedOf(h: Host, g: WGroup, s: WShip): number {
  return Math.min(h.cruiseOf(s) * (0.6 + 0.4 * s.hp), h.groupSpeed(g, econOf(s).military));
}

// ------------------------------------------------------------------ commands

/** the owner answers a stop demand (or gives up / turns to fight during a pursuit) */
export function lawAnswer(h: Host, company: string, group: unknown, choice: unknown): string | null {
  const st = h.st; if (!st.lawV) return '이 월드에는 치안 집행이 없습니다';
  const g = typeof group === 'string' ? st.groups[group] : undefined;
  if (!g || g.owner !== company) return '자사 함대가 아닙니다';
  if (choice !== 'comply' && choice !== 'flee' && choice !== 'resist') return '알 수 없는 응답';
  const stop = g.lawStop, op = stop ? lawBook(st).ops[stop.op] : undefined;
  if (!stop || !op || op.target !== g.id || op.phase === 'return') return '진행 중인 정선 요구가 없습니다';
  if (op.phase === 'fight') return '이미 교전 중입니다';
  if (choice === 'comply' && (op.phase === 'hold')) return '이미 검문 중입니다';
  if (choice === 'flee' && op.phase === 'pursue') return '이미 도주 중입니다';
  if (choice === 'comply' && op.phase === 'engage') return '강제 진압 중에는 항복할 수 없습니다 — 교전 후 벌금을 납부하세요';
  if (op.phase === 'go' && choice !== 'resist') return '아직 정선 요구를 받지 않았습니다';
  answer(h, op, g, choice, 'player');
  return null;
}

/** where a fine can be paid: a ship near a public station in policed space, a ship under a stop, or (no ships) HQ */
export function payPlace(h: Host, company: string): Station | 'stop' | 'hq' | null {
  const st = h.st, pol = policedSystems(h);
  const mine = Object.values(st.ships).filter(s => s.owner === company);
  if (!mine.length) return 'hq';
  if (Object.values(st.groups).some(g => g.owner === company && g.lawStop && g.lawStop.phase !== 'released')) return 'stop';
  for (const x of Object.values(st.stations)) {
    if (!x.public) continue;
    const sys = h.sysOf(x.pos); if (!sys || !pol.has(sys.id)) continue;
    if (mine.some(s => dist(s.pos, x.pos) < LAW.payR + x.radius)) return x;
  }
  return null;
}
/** pay outstanding fines (one case, or all oldest first) from company credits; partial payment keeps the rest owed */
export function lawPay(h: Host, company: string, caseId: unknown, amount: unknown): { paid: number; left: number } | string {
  const st = h.st; if (!st.lawV) return '이 월드에는 치안 집행이 없습니다';
  const co = st.companies[company]; if (!co) return '회사 없음';
  if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1)) return '금액이 올바르지 않습니다';
  const all = Object.values(lawBook(st).cases).filter(c => c.by === company && payable(c) && (caseId === undefined || c.id === caseId)).sort((a, b) => a.t - b.t);
  if (!all.length) return caseId === undefined ? '미납 벌금이 없습니다' : '해당 사건의 미납 벌금이 없습니다';
  // where each debt can be paid: a Union case wherever the Union takes payments (payPlace); a case billed by a station
  // also next to that station (no docking needed); with no ships at all, from HQ
  const place = payPlace(h, company);
  const mine = Object.values(st.ships).filter(s => s.owner === company);
  const nearSt = (x: Station | undefined) => !!x && mine.some(s => dist(s.pos, x.pos) < LAW.payR + x.radius);
  const ok = (c: LawCase) => (!!c.auth && !!place) || (!!c.creditor && (place === 'hq' || nearSt(st.stations[c.creditor]) || (!st.stations[c.creditor] && !!place)));
  const cases = all.filter(ok);
  if (!cases.length) {
    const cr = all.find(c => c.creditor && st.stations[c.creditor]);
    return cr && !cr.auth ? `${st.stations[cr.creditor!].name} 근처(${LAW.payR / 1000} km 이내)에 자사 함선이 있어야 이 벌금을 납부할 수 있습니다` : '치안 구역(연합 경비대 주둔 성계)의 공공 정거장 근처에 자사 함선이 있어야 납부할 수 있습니다';
  }
  let budget = Math.min(Math.floor(co.credits), amount === undefined ? Infinity : Math.floor(amount as number));
  if (budget < 1) return '잔액 부족';
  let paid = 0;
  const station = typeof place === 'object' && place ? place : st.stations[co.homeStation];
  watchMoney(st, 'law_fine', { company, station: station?.id }, () => {
    for (const c of cases) {
      const pay = Math.min(unpaid(c), budget); if (pay <= 0) break;
      co.credits -= pay; c.paid += pay; budget -= pay; paid += pay;
      book(h, company, 'law_fines', -pay, c.id);
      // the money goes to the authority that billed it
      const to = (c.creditor && st.stations[c.creditor]) || station;
      if (to?.public) fundsIn(to, pay);
      settleCase(h, c);
    }
  });
  emit(st, { kind: 'law', reason: 'fine_paid', amount: paid, company });
  const left = Object.values(lawBook(st).cases).filter(c => c.by === company && payable(c)).reduce((a, c) => a + unpaid(c), 0);
  h.ev('money', `연합 보안국 벌금 납부 -${paid.toLocaleString()} cr${left ? ` (미납 ${left.toLocaleString()} cr)` : ' — 미납 없음'}`, { company, tag: 'law' });
  refresh(h, company);
  return { paid, left };
}

// ------------------------------------------------------------------ battles

/** relation inside one engagement: a law battle makes only the Union and the stopped company enemies, there */
export function engRel(st: WorldState, e: Partial<Pick<Engagement, 'law' | 'sys'>> | undefined, a: string, b: string): Relation {
  if (e?.law && ((a === 'union' && b === e.law.co) || (b === 'union' && a === e.law.co))) return -1;
  // B-3: enemies of a formal territory war in this battle's system
  return st.sovV ? relIn(st, a, b, e?.sys) : coRelation(st, a, b);
}
/** may group g be pulled into engagement e as a reinforcement? In a law battle only the dispatched guards and the
 *  stopped group itself (and third parties already hostile by their own stance) — never the company's other fleets */
export function lawJoinAllowed(e: Engagement, g: WGroup): boolean {
  if (!e.law) return true;
  if (g.owner === 'union') return !!g.lawx && g.lawx === e.law.op;
  if (g.owner === e.law.co) return false;
  return true;
}

/**
 * P11 battle hook (not law battles): a player company that attacks another, not hostile to it, in policed space
 * commits an unprovoked strike. Hostility declared by one side only marks that side as the aggressor; mutual
 * hostility (both declared) is a war between them, not a crime here. One case per battle and pair.
 */
export function lawOnBattle(h: Host, e: Engagement) {
  const st = h.st; if (!st.lawV || e.law || !e.sys) return;
  const cos = e.sides.flat().filter(c => st.companies[c]?.kind === 'player');
  for (const a of cos) for (const b of cos) {
    if (a === b) continue;
    const ah = st.stance?.[a]?.hostile?.includes(b), bh = st.stance?.[b]?.hostile?.includes(a);
    if (!ah || bh) continue;
    const vg = e.groupRefs.map(id => st.groups[id]).find(g => g?.owner === b);
    const ag = e.groupRefs.map(id => st.groups[id]).find(g => g?.owner === a);
    lawCrime(h, { kind: 'strike', by: a, group: ag?.id, ship: ag?.shipIds[0], victim: b, vgroup: vg?.id, sys: e.sys, pos: e.pos, value: 0, key: `strike:${e.id}:${a}:${b}` });
  }
}

/** guard ships (and their hull) as they go into a law battle, to tell afterwards whether the target hurt them */
export function noteLawShips(e: Engagement, ships: WShip[]) {
  if (!e.law) return;
  const have = new Set((e.law.ships ??= []).map(x => x[0]));
  for (const s of ships) if (s.owner === 'union' && !have.has(s.id)) e.law.ships.push([s.id, s.hp]);
}
