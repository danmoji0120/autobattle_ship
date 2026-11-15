// P13.2 cargo raiding (piracyV worlds). Players and pirate bands stop real haulers, threaten them and take
// real cargo:
//   • non-destructive: demand → the victim complies → part of its real cargo is jettisoned as a container
//     (CargoDrop) at its position → the raider recovers it physically with the P13.1 salvage engine
//     (approach, work into real holds, unload at a station / carry home to the lair);
//   • destructive: the victim flees / resists → the raider may use force → an ordinary P11 battle → a P13.1
//     wreck holding what was really aboard → salvage.
// Nothing is created: a container holds exactly what left the hauler, ownership changes only when a unit is
// recovered, logistics jobs are settled at the moment of the drop (lost), and NPCs follow the same rules.
// See docs/P13_2_PIRACY.md.
import type { WorldSim } from './sim';
import type { Cargo, Op, V, WGroup, WShip, WorldState } from './types';
import { addc, cargoKeys, cargoSum, qty, takec } from './types';
import type { WreckLot } from './wrecks';
import { lotValue, itemLabel, wreckUnits, WRECK_SEEN_R } from './wrecks';
import { coRelation } from './battleAuth';
import { econOf, growthOn } from './hullops';
import { priceOf } from './market';
import type { Station } from './types';
import { shipValue } from './data';
import { dist, sysAt } from './geom';
import { effSec } from './security';
import { bumpStanding } from './territory';
import { emit } from './observe';
import { isExclusiveEquip, isExclusiveShip } from './exclusive';
import { isExclusive } from '../content/registry';
import { SALV, salvageRoom, stepCollect, canCollect } from './salvage';
import { cargoLost } from './autonomousLogistics';
import type { CommanderDef } from '../sim/data/commanders';

type Host = WorldSim;

/** raider policy: 비파괴 우선 / 무력 사용 허용 / 수송망 파괴 우선 */
export type PlunderPolicy = 'nonlethal' | 'force' | 'destroy';
/** victim policy: 생존 우선 / 균형 대응 / 화물 보호 우선 */
export type VictimPolicy = 'survive' | 'balanced' | 'protect';
/** how a threatened hauler answers */
export type Response = 'comply' | 'flee' | 'resist' | 'stall';
export type DemandKind = 'part' | 'all' | 'item';

export interface PlunderState {
  /** the order this state belongs to (a new order resets it) */
  key: string;
  phase: 'search' | 'intercept' | 'wait' | 'collect' | 'force' | 'loot' | 'home' | 'done';
  /** victim group / ship */
  target?: string; ship?: string;
  /** container or wreck being collected */
  site?: string;
  since: number; next: number;
  /** after a refusal: wait until (stall) */
  until?: number;
  /** force: the victim is in a P11 battle now / battles it escaped from */
  fight?: boolean; escapes?: number;
  /** groups not to pick again before the given time */
  ignore?: Record<string, number>;
  /** the victim's last known position (to find its wreck after a fight) */
  last?: V;
  /** the victim group that was told a raider is closing in (it is told again when the raider leaves) */
  warned?: string;
  why?: string;
  /** P13.2.2 lane plunder: the target choice estimate (comply chance, real sale value, risk, expected profit) */
  est?: { p: number; sale: number; risk: number; profit: number };
}

/** a jettisoned cargo container: same shape as a wreck for the salvage engine */
export interface CargoDrop {
  id: string; kind: 'drop';
  name: string;
  system: string; pos: V;
  created: number; expires: number;
  /** jettisoned by (ship, its owner) at the demand of `by` */
  ship: string; owner: string; by: string;
  /** the demand event */
  ev: string;
  lots: WreckLot[];
  initial: number;
  taken: Record<string, Record<string, number>>;
  seen: string[];
  crime?: Record<string, number>;
  /** companies whose recovery the owner was told about (server bookkeeping) */
  told?: string[];
  /** P13.2.2: the raiding group whose demand made it (its assigned recovery fleets collect it) */
  raid?: string;
}

export interface PiracyLog {
  id: string; t: number;
  kind: 'threat' | Response | 'drop' | 'withdraw' | 'force' | 'sunk' | 'extortion' | 'store';
  by: string; to?: string; group?: string; ship?: string; system?: string; value?: number; items?: Cargo; policy?: string; pressure?: number;
}
/**
 * A post-surrender truce between the parties of one plunder event (P13.2.1): the raiding group (with its parent /
 * sub-groups and any group of the raider recovering that very container) and the surrendered group (with its
 * parent / sub-groups and the groups escorting it). Other groups of the same companies are not covered.
 * `id` is the container id (one truce per event). It follows its parties wherever they go for `PIR.truceFor`
 * seconds (a surrendered hauler that runs for the dock the raider also heads to is still covered); `pos`/`r`
 * only bound truces without `pa`/`pb`, which come from P13.2 saves (company pair, within r of the jettison).
 */
export interface Truce { id?: string; a: string; b: string; pa?: string[]; pb?: string[]; ship?: string; pos: V; r: number; until: number }
export interface PiracyBook { seq: number; truces: Truce[]; log: PiracyLog[] }

export const PIR = {
  /** demands are made within this distance of the victim ship (P11 contact is 420 m) */
  threatR: 1200,
  /** a victim is warned when the raider's warships come this close */
  warnR: 3500,
  /** the raider keeps this far from the victim while it has not used force */
  standoff: 850,
  /** one demand per ship in this time (whoever demands); after a stall the raider may ask again sooner */
  redemand: 600, restall: 90,
  /** containers last this long */
  dropLife: 1800,
  /** after compliance: no new P11 contact between the two companies near the drop */
  truceFor: 180, truceR: 4000,
  /** pressure thresholds by victim policy */
  threshold: { survive: 0.6, balanced: 1.2, protect: 2.5 } as Record<VictimPolicy, number>,
  /** defence counted within this distance; support approaching within this one makes the victim stall */
  defR: 1800, supportR: 6000,
  /** share of the cargo value asked by a partial demand */
  part: 0.5,
  /** flee lasts at least this long */
  fleeFor: 60,
  /** search: victims within this distance of the zone (plus its radius); chase gives up after this time */
  searchPad: 1500, chaseMax: 240,
  /** once force is used the raider keeps after its prey this long (several P11 rounds, as an attack order) */
  forceMax: 2400,
  /** ...or once the victim has escaped this many of those P11 battles (civilians withdraw at 900 m) */
  forceEscapes: 3,
  /** extortion of a neutral company where the law reaches (same scale as unauthorised salvage) */
  lawSec: 25,
  logMax: 400,
  /** a pirate band gives up collecting after this long (its warships work slowly) */
  npcCollectMax: 600, npcWreckAge: 900, npcWreckR: 3000,
  /** P13.2.2: an assigned recovery fleet counts in the victim's judgement within this distance of the victim,
   *  and follows its raid this far behind */
  tenderR: 4000, tenderTrail: 1500,
  /** P13.2.2 lane-plunder target choice: below this expected profit (cr) a target is not worth it; refusal risk per
   *  value of opposing warships (force: a fight, otherwise exposure); fixed time added to travel (demand, collect) */
  aiMinProfit: 400, aiForceRisk: 0.3, aiExposure: 0.03, aiFixedTime: 240,
} as const;

export const POLICY_NAME: Record<VictimPolicy, string> = { survive: '생존 우선', balanced: '균형 대응', protect: '화물 보호 우선' };
export const PLUNDER_NAME: Record<PlunderPolicy, string> = { nonlethal: '비파괴 우선', force: '무력 사용 허용', destroy: '수송망 파괴 우선' };
export const RESPONSE_NAME: Record<Response, string> = { comply: '화물 투하(응낙)', flee: '도주', resist: '저항', stall: '지원 대기(버팀)' };

const book = (st: WorldState): PiracyBook => (st.piracy ??= { seq: 0, truces: [], log: [] });
function log(h: Host, e: Omit<PiracyLog, 'id' | 't'>): PiracyLog {
  const b = book(h.st); const x: PiracyLog = { id: `pv${++b.seq}`, t: h.time, ...e };
  b.log.push(x); if (b.log.length > PIR.logMax) b.log.splice(0, b.log.length - PIR.logMax);
  emit(h.st, { kind: 'piracy', reason: e.kind, amount: e.value ?? 0, company: e.by, from: e.to, group: e.group, ship: e.ship, system: e.system, ref: x.id });
  return x;
}

/** may this item leave a ship as plunder (exclusive content never) */
export const droppable = (item: string) => !isExclusiveEquip(item) && !isExclusive(item) && !item.startsWith('bp:');
/** the plunderable cargo aboard a ship */
export function lootOf(s: WShip): Cargo {
  const out: Cargo = {};
  if (isExclusiveShip(s)) return out;
  for (const k of cargoKeys(s.cargo)) { const n = Math.floor(qty(s.cargo, k) + 1e-9); if (n > 0 && droppable(k)) out[k] = n; }
  return out;
}
const valueOf = (st: WorldState, c: Cargo) => Object.entries(c).reduce((a, [k, n]) => a + n * lotValue(st, { item: k }), 0);

// ------------------------------------------------------------------ truce

/** is group g one of the parties of side `side` of truce t (see Truce) */
function inParty(st: WorldState, t: Truce, side: 'a' | 'b', g: WGroup): boolean {
  if (g.owner !== (side === 'a' ? t.a : t.b)) return false;
  const ids = side === 'a' ? t.pa : t.pb;
  if (!ids) return true;   // P13.2 save: the whole company
  if (ids.includes(g.id) || (g.parentId && ids.includes(g.parentId))) return true;
  const op = g.op;
  if (op.k === 'escort' && ids.includes(op.group)) return true;
  if (side === 'a' && t.id && (op.k === 'recover' && op.wreck === t.id || g.salv?.key === `collect:${t.id}`)) return true;
  return false;
}
/** does truce t stand between groups x and y (one on each side) */
function pairs(st: WorldState, t: Truce, x: WGroup, y: WGroup): boolean {
  return (inParty(st, t, 'a', x) && inParty(st, t, 'b', y)) || (inParty(st, t, 'a', y) && inParty(st, t, 'b', x));
}
/** P11 contact between groups x and y at p is held back by an active truce of their plunder event */
export function truceBlocks(st: WorldState, x: WGroup, y: WGroup, p: V, time: number): boolean {
  const ts = st.piracy?.truces; if (!ts?.length) return false;
  for (const t of ts) {
    if (t.until <= time) continue;
    // a party truce covers its parties anywhere; an old company-pair truce only around the jettison point
    if (!(t.pa || t.pb) && !(Math.abs(t.pos.x - p.x) < t.r && dist(t.pos, p) < t.r)) continue;
    if (pairs(st, t, x, y)) return true;
  }
  return false;
}
/** group g would only meet truce partners among `others` (all of them covered): it must not be pulled in against them */
export function truceShields(st: WorldState, g: WGroup, others: WGroup[], p: V, time: number): boolean {
  if (!st.piracy?.truces?.length || !others.length) return false;
  return others.every(o => truceBlocks(st, g, o, p, time));
}
/** the parties of one side: the group, its parent and sub-groups (and, for the victim, its escorts) */
function partyIds(h: Host, g: WGroup | undefined, escorts: boolean): string[] {
  if (!g) return [];
  const out = new Set<string>([g.id]);
  if (g.parentId) out.add(g.parentId);
  for (const x of Object.values(h.st.groups)) {
    if (x.owner !== g.owner) continue;
    if (x.parentId === g.id || (escorts && x.op.k === 'escort' && x.op.group === g.id)) out.add(x.id);
  }
  return [...out];
}
function truce(h: Host, id: string, a: string, b: string, raider: WGroup | undefined, victim: WGroup | undefined, ship: string, pos: V) {
  const B = book(h.st);
  B.truces = B.truces.filter(t => t.until > h.time);
  if (B.truces.some(t => t.id === id)) return;   // one truce per plunder event (a replayed event adds nothing)
  // the raid's assigned recovery fleets close by are recovery parties too (the ones the victim's judgement counted)
  const pa = [...partyIds(h, raider, false), ...(raider ? tendersNear(h, raider, pos).map(o => o.id) : [])];
  B.truces.push({ id, a, b, pa, pb: partyIds(h, victim, true), ship, pos: { ...pos }, r: PIR.truceR, until: h.time + PIR.truceFor });
}
/** end the truces standing between groups x and y (only those); returns how many ended */
function breakTruce(h: Host, x: WGroup, y: WGroup): number {
  const B = h.st.piracy; if (!B) return 0;
  const n = B.truces.length;
  B.truces = B.truces.filter(t => t.until > h.time && !pairs(h.st, t, x, y));
  return n - B.truces.length;
}
/** a direct attack order by group `g` on group `target`: the truces between those two end, recorded as force */
export function endTruce(h: Host, g: WGroup, target: WGroup) {
  const live = (h.st.piracy?.truces ?? []).filter(t => t.until > h.time).length;
  if (!live) return;
  if (breakTruce(h, g, target)) log(h, { kind: 'force', by: g.owner, to: target.owner, group: g.id, policy: `attack:${target.id}` });
}

// ------------------------------------------------------------------ the victim's decision

export function victimPolicy(st: WorldState, g: WGroup): VictimPolicy {
  return g.piracyPolicy ?? st.companies[g.owner]?.piracyPolicy ?? 'balanced';
}
const military = (h: Host, g: WGroup) => h.shipsOf(g).filter(s => s.state !== 'battle' && s.state !== 'docked' && econOf(s).military);
const minSpeed = (h: Host, ships: WShip[]) => ships.length ? Math.min(...ships.map(s => h.cruiseOf(s))) : 0;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** P13.2.2: the recovery fleets assigned to this raid (same company, op lootTender) within PIR.tenderR of `p`, in space */
export function tendersNear(h: Host, raider: WGroup, p: V): WGroup[] {
  const out: WGroup[] = [];
  for (const o of Object.values(h.st.groups)) {
    if (o.owner !== raider.owner || o === raider || o.op.k !== 'lootTender' || o.op.group !== raider.id || o.fleeing) continue;
    const c = h.groupCenter(o); if (!c || Math.abs(c.x - p.x) > PIR.tenderR || dist(c, p) > PIR.tenderR) continue;
    if (h.shipsOf(o).some(s => s.state === 'space')) out.push(o);
  }
  return out;
}
/** free hold that could really take the goods at `p`: the raid's own ships in space plus its assigned recovery fleets close by */
export function recoveryRoom(h: Host, raider: WGroup, p: V): number {
  let room = h.shipsOf(raider).filter(s => s.state === 'space').reduce((a, s) => a + salvageRoom(h, s), 0);
  for (const o of tendersNear(h, raider, p)) room += h.shipsOf(o).filter(s => s.state === 'space' && econOf(s).cruise > 0).reduce((a, s) => a + salvageRoom(h, s), 0);
  return room;
}

export interface Judgement { response: Response; pressure: number; threshold: number; attack: number; defense: number; support: number; damage: number; escape: number; recovery: number; cargo: number; security: number; policy: VictimPolicy }

/**
 * How a threatened hauler answers: deterministic from the situation plus ±10 % from the world RNG.
 * Factors: attacking warship value, defence (own + nearby own/allied warships, Union for pirate raids),
 * support coming, damage, chance to escape (speed, distance to a dock), the raider's ability to take the
 * goods, cargo value, local security, the victim commander's aggression and its policy.
 */
export function judge(h: Host, raider: WGroup, victim: WGroup, ship: WShip, want: Cargo): Judgement {
  const a = assess(h, raider, victim, ship, want);
  const noise = 0.9 + 0.2 * h.rng.next();
  const pressure = a.base * noise;
  return { response: respond(a, pressure), pressure, threshold: a.threshold, attack: a.attack, defense: a.defense, support: a.support, damage: a.damage, escape: a.escape, recovery: a.recovery, cargo: a.cargo, security: a.security, policy: a.policy };
}
/** the situation as judge() sees it, without the ±10 % noise (pure: no RNG, no state change) */
export interface Assessment { base: number; threshold: number; attack: number; defense: number; support: number; damage: number; escape: number; recovery: number; cargo: number; security: number; policy: VictimPolicy; room: number; units: number }
export function assess(h: Host, raider: WGroup, victim: WGroup, ship: WShip, want: Cargo): Assessment {
  const st = h.st, pos = ship.pos, policy = victimPolicy(st, victim);
  const attack = military(h, raider).reduce((a, s) => a + shipValue(s.classId) * (0.4 + 0.6 * s.hp), 0);
  let defense = 0, support = 0;
  for (const o of Object.values(st.groups)) {
    if (!o.shipIds.length || (o.owner !== victim.owner && coRelation(st, o.owner, victim.owner) !== 1 && !(o.owner === 'union' && raider.owner === 'pirates'))) continue;
    const c = o === victim ? pos : h.groupCenter(o); if (!c) continue;
    const d = dist(c, pos), v = h.groupValue(o, true); if (v <= 0) continue;
    if (d <= PIR.defR) defense += v; else if (d <= PIR.supportR) support += v;
  }
  const vs = h.shipsOf(victim).filter(s => s.state === 'space');
  const damage = vs.length ? 1 - vs.reduce((a, s) => a + s.hp, 0) / vs.length : 0;
  // a way out: the nearest dock it may use, or a jump gate of this system
  const dock = h.nearestDock(pos, victim.owner);
  const gate = Math.min(Infinity, ...(sysAt(st.systems, pos)?.gates ?? []).map(x => dist(x.pos, pos) * 1.3));
  const dd = Math.min(dock ? h.routeDistance(dock.pos, pos) : Infinity, gate);
  const rs = minSpeed(h, military(h, raider)), spd = minSpeed(h, vs.filter(s => !econOf(s).military));
  const escape = clamp01(0.55 * clamp01((spd / Math.max(1, rs) - 0.6) / 0.8) + 0.45 * clamp01(1 - dd / 20000));
  const units = Object.values(want).reduce((a, n) => a + n, 0);
  const room = recoveryRoom(h, raider, pos);
  const recovery = room < 1 ? 0.35 : Math.min(1, 0.35 + 0.65 * room / Math.max(1, units));
  const cargo = valueOf(st, want);
  const sys = sysAt(st.systems, pos); const security = sys ? effSec(sys) : 0;
  const aggr = h.cmdr(victim).aggression;
  const base = attack / (defense + 50) * (1 + 1.2 * damage) * recovery * (1 - 0.5 * escape) * (1.15 - 0.3 * aggr)
    * (1.1 - 0.2 * clamp01(cargo / 60000)) * (1 - security / 250);
  return { base, threshold: PIR.threshold[policy], attack, defense, support, damage, escape, recovery, cargo, security, policy, room, units };
}
/** the answer for a pressure (the order of the rules is the game rule) */
function respond(a: Pick<Assessment, 'threshold' | 'support' | 'defense' | 'escape' | 'policy'>, pressure: number): Response {
  if (pressure >= a.threshold) return 'comply';
  if (a.support > 0) return 'stall';
  if (a.defense > 0) return 'resist';
  if (a.escape >= 0.4) return 'flee';
  if (a.policy === 'survive') return 'comply';
  return 'resist';
}
/** probability that judge() answers comply, over its uniform ±10 % noise (exact for the current situation) */
export function complyChance(a: Assessment): number {
  const below = respond(a, -Infinity) === 'comply' ? 1 : 0;   // what happens when the pressure is not enough
  if (a.base <= 0) return below;
  const p = clamp01((1.1 - a.threshold / a.base) / 0.2);
  return p + (1 - p) * below;
}

/** what a demand asks of this ship (whole units, plunderable only) */
export function wanted(h: Host, s: WShip, kind: DemandKind = 'part', item?: string): Cargo {
  const loot = lootOf(s), out: Cargo = {};
  const total = valueOf(h.st, loot);
  if (kind === 'all') return loot;
  let budget = total * PIR.part;
  const keys = Object.keys(loot).sort((a, b) => (kind === 'item' && item ? (b === item ? 1 : 0) - (a === item ? 1 : 0) : 0) || lotValue(h.st, { item: b }) - lotValue(h.st, { item: a }) || a.localeCompare(b));
  for (const k of keys) {
    if (budget <= 0) break;
    const v = Math.max(1e-6, lotValue(h.st, { item: k }));
    const n = Math.min(loot[k], Math.max(1, Math.floor(budget / v)));
    out[k] = n; budget -= n * v;
  }
  return out;
}

/** can `raider` demand from this ship now (and from which company it is) */
export function demandable(h: Host, raider: WGroup, s: WShip, neutral: boolean, near = true): string | null {
  const st = h.st;
  if (s.owner === raider.owner) return '자사 함선';
  if (s.state !== 'space' || s.engagement || s.warp?.phase === 'warp') return '상대가 공간에 없습니다 (정박·교전·워프 중)';
  if (econOf(s).military) return '군함에는 요구할 수 없습니다';
  const rel = coRelation(st, raider.owner, s.owner);
  if (rel === 1) return '동맹 회사';
  if (rel === 0 && !neutral && raider.owner !== 'pirates') return '중립 회사 — 명시적 허가(중립 대상 포함)가 필요합니다';
  if (st.companies[s.owner]?.kind === 'pirate') return '해적';
  if (!Object.keys(lootOf(s)).length) return '약탈할 화물이 없습니다';
  const mil = military(h, raider);
  if (!mil.length) return '위협할 군함이 없습니다';
  if (near && !mil.some(x => x.state === 'space' && dist(x.pos, s.pos) <= PIR.threatR)) return `위협 거리(${PIR.threatR}m) 밖입니다`;
  const p = s.pir;
  if (p && h.time - p.t < (p.act === 'stall' ? PIR.restall : PIR.redemand)) return '최근 이미 요구를 받은 함선입니다';
  return null;
}

/**
 * Threaten one ship: the server decides the answer at once. On compliance the cargo leaves the ship as a
 * container at its position (idempotent per demand event), the logistics job is settled, and a local truce
 * keeps P11 from starting while the raider picks it up.
 */
export function demand(h: Host, raider: WGroup, s: WShip, opts: { kind?: DemandKind; item?: string; neutral?: boolean; policy?: string } = {}): { response: Response; drop?: CargoDrop; j: Judgement } | string {
  const st = h.st;
  const why = demandable(h, raider, s, !!opts.neutral); if (why) return why;
  const victim = st.groups[s.groupId]; if (!victim) return '대상 편대 없음';
  const want = wanted(h, s, opts.kind, opts.item);
  const j = judge(h, raider, victim, s, want);
  const sys = sysAt(st.systems, s.pos);
  const tl = log(h, { kind: 'threat', by: raider.owner, to: s.owner, group: raider.id, ship: s.id, system: sys?.id, value: j.cargo, items: want, policy: j.policy, pressure: Math.round(j.pressure * 100) / 100 });
  log(h, { kind: j.response, by: raider.owner, to: s.owner, group: victim.id, ship: s.id, system: sys?.id, value: j.cargo, pressure: Math.round(j.pressure * 100) / 100 });
  s.pir = { t: h.time, by: raider.owner, ev: tl.id, act: j.response };
  const rName = st.companies[raider.owner]?.name ?? raider.owner, vName = st.companies[s.owner]?.name ?? s.owner;
  const sum = Object.entries(want).map(([k, n]) => `${itemLabel(k)} ${n}`).join(', ');
  h.ev('warn', `${victim.name}: ${rName}의 화물 요구 (${sum}) — ${RESPONSE_NAME[j.response]} [${POLICY_NAME[j.policy]}]`, { company: s.owner, pos: s.pos, ref: victim.id, tag: 'piracy' });
  h.ev('info', `${raider.name}: ${vName} ${victim.name}에 화물 요구 — ${RESPONSE_NAME[j.response]}`, { company: raider.owner, pos: s.pos, ref: raider.id, tag: 'piracy' });
  if (j.response === 'flee') flee(h, victim);
  if (j.response !== 'comply') return { response: j.response, j };
  const drop = jettison(h, s, raider.owner, tl.id, want, raider.id);
  if (drop) s.pir.dropped = drop.initial;
  return { response: 'comply', drop: drop ?? undefined, j };
}

/** a direct move / dock / return order is not overridden by an automatic flight */
function flee(h: Host, g: WGroup) {
  const op = h.opOf(g);
  if (g.override && (op.k === 'move' || op.k === 'dock' || op.k === 'return' || op.k === 'attack')) return;
  g.fleeing = true; (g as any)._safeSince = h.time + PIR.fleeFor;
}

/** the cargo physically leaves the ship into a container (idempotent per demand event) */
export function jettison(h: Host, s: WShip, by: string, ev: string, want: Cargo, raider?: string): CargoDrop | null {
  const st = h.st, drops = (st.drops ??= {});
  const id = `cd_${ev}`; if (drops[id]) return drops[id];
  const sys = sysAt(st.systems, s.pos);
  const lots: WreckLot[] = []; const moved: Cargo = {};
  for (const [item, n0] of Object.entries(want)) {
    const n = Math.min(Math.floor(n0 + 1e-9), Math.floor(qty(s.cargo, item) + 1e-9)); if (n <= 0 || !droppable(item)) continue;
    takec(s.cargo, item, n); moved[item] = n;
    if (s.salvaged?.[item]) { s.salvaged[item] = Math.max(0, s.salvaged[item] - n); if (s.salvaged[item] <= 1e-9) delete s.salvaged[item]; if (!Object.keys(s.salvaged).length) delete s.salvaged; }
    lots.push({ id: `l${lots.length}`, k: 'cargo', item, n, owner: s.owner });
    cargoLost(h, s, item, n);
    emit(st, { kind: 'piracy', reason: 'to_drop', item, amount: n, company: s.owner, group: s.groupId, ship: s.id, system: sys?.id, ref: id, to: by });
  }
  if (!lots.length) return null;
  const value = valueOf(st, moved);
  const d: CargoDrop = {
    id, kind: 'drop', name: `${sys?.name ?? '심우주'} 투하 화물 (${st.groups[s.groupId]?.name ?? s.id})`, system: sys?.id ?? '', pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
    created: h.time, expires: h.time + PIR.dropLife, ship: s.id, owner: s.owner, by, ev, lots, initial: lots.reduce((a, l) => a + l.n, 0), taken: {},
    seen: [...new Set([s.owner, by].filter(c => st.companies[c]?.kind === 'player'))],
    ...(raider ? { raid: raider } : {}),
  };
  drops[id] = d;
  log(h, { kind: 'drop', by, to: s.owner, ship: s.id, system: d.system, value, items: moved });
  truce(h, id, by, s.owner, raider ? h.st.groups[raider] : undefined, st.groups[s.groupId], s.id, d.pos);
  // extortion of a company that is not at war with the raider, where the law reaches
  if (by !== 'pirates' && coRelation(st, by, s.owner) !== -1) {
    const sec = sys ? effSec(sys) : 0;
    log(h, { kind: 'extortion', by, to: s.owner, ship: s.id, system: d.system, value });
    const co = st.companies[by];
    if (sec >= PIR.lawSec && co) {
      const rep = value * SALV.repPerCr * (sec / 100);
      co.rep = Math.max(0, co.rep - rep);
      emit(st, { kind: 'reputation', reason: 'extortion', amount: -rep, company: by, system: d.system });
      if (st.factions && sys?.faction && sys.faction !== 'pirates') bumpStanding(st, by, sys.faction, -value * SALV.standingPerCr * (sec / 100));
      h.ev('warn', `${sys?.name ?? ''}: 중립 회사 화물 갈취 — 치안 구역 위반 (평판 하락)`, { company: by, pos: d.pos, ref: id, tag: 'piracy' });
    }
  }
  h.ev('warn', `${d.name}: 화물 ${d.initial}단위 투하 (약 ${Math.round(value).toLocaleString()} cr) — 회수되기 전까지 귀사 소유`, { company: s.owner, pos: d.pos, ref: id, tag: 'piracy' });
  return d;
}

// ------------------------------------------------------------------ containers

/** remove exhausted / expired containers; what is left is lost (consume/drop_decay) */
export function expireDrops(st: WorldState, time: number): CargoDrop[] {
  const gone: CargoDrop[] = [];
  for (const d of Object.values(st.drops ?? {})) {
    d.lots = d.lots.filter(l => l.n > 0);
    if (d.lots.length && d.expires > time) continue;
    for (const l of d.lots) emit(st, { kind: 'consume', reason: 'drop_decay', item: l.item, amount: l.n, company: l.owner, system: d.system, ref: d.id });
    delete st.drops![d.id]; gone.push(d);
  }
  if (st.piracy) st.piracy.truces = st.piracy.truces.filter(t => t.until > time);
  return gone;
}
/** containers are seen only by companies whose ships came close (and the two parties) */
export function dropFor(d: CargoDrop, company: string | undefined) {
  if (!company || !d.seen.includes(company)) return null;
  return { id: d.id, kind: 'drop' as const, name: d.name, system: d.system, pos: d.pos, created: d.created, expires: d.expires, initial: d.initial, left: wreckUnits(d), owner: d.owner, by: d.by, lots: d.lots, taken: d.taken[company] ? { [company]: d.taken[company] } : {} };
}
export type DropView = NonNullable<ReturnType<typeof dropFor>>;
export { WRECK_SEEN_R as DROP_SEEN_R };

// ------------------------------------------------------------------ the raider

const opKeyOf = (op: Op) => JSON.stringify(op);
type PlunderOp = Extract<Op, { k: 'plunder' }>;
/** the plunder order of a group, if it has one (`plunder`, or `harass` with a plunder policy in piracyV) */
export function plunderOrder(st: WorldState, op: Op): PlunderOp | null {
  if (!st.piracyV) return null;
  if (op.k === 'plunder') return op;
  if (op.k === 'harass' && op.plunder) return { k: 'plunder', at: op.at, radius: op.radius, policy: op.plunder, ...(op.neutral ? { neutral: true } : {}) };
  return null;
}

function setPhase(h: Host, P: PlunderState, phase: PlunderState['phase'], why?: string) { if (P.phase !== phase) { P.phase = phase; P.since = h.time; } P.why = why; }

/** the ship of a victim group worth stopping: the one with most plunderable cargo, in space */
function victimShip(h: Host, t: WGroup): WShip | undefined {
  let best: WShip | undefined, bv = 0;
  for (const s of h.shipsOf(t)) {
    if (s.state !== 'space' || econOf(s).military) continue;
    const v = valueOf(h.st, lootOf(s)); if (v > bv) { bv = v; best = s; }
  }
  return best;
}
function legalVictim(h: Host, g: WGroup, t: WGroup, op: PlunderOp): boolean {
  if (t.owner === g.owner || !t.shipIds.length) return false;
  const k = h.st.companies[t.owner]?.kind; if (!k || k === 'pirate') return false;
  const rel = coRelation(h.st, g.owner, t.owner);
  if (rel === 1) return false;
  if (rel === 0 && !op.neutral && g.owner !== 'pirates') return false;
  if (op.policy === 'destroy' && rel === 0 && k !== 'player') return false;
  return true;
}
// ------------------------------------------------------------------ target choice (P13.2.2)

/** what selling `n` units of `item` at this station would really pay now: the same 50-unit walk down the bid,
 *  station tax and purchase budget as WorldSim.sellAt, on a copy (pure) */
export function saleQuote(h: Host, st: Station, item: string, n: number): { sold: number; value: number } {
  const m = st.market?.[item]; if (!m || n <= 0) return { sold: 0, value: 0 };
  const v3 = growthOn(h.st), tax = 1 - (st.tax ?? 0);
  const budget = v3 && st.public && st.funds !== undefined;
  let funds = st.funds ?? 0, stock = m.stock, left = n, sold = 0, total = 0;
  while (left > 0.01) {
    let chunk = Math.min(left, 50);
    const p = priceOf({ ...m, stock }, 'sell', v3);
    if (budget) { const can = p > 0 ? funds / (p * tax) : 0; if (can < chunk) chunk = Math.max(0, Math.floor(can)); if (chunk <= 0) break; funds -= chunk * p * tax; }
    total += chunk * p; stock += chunk; left -= chunk; sold += chunk;
  }
  return { sold, value: total * tax };
}
/** best real sale of these goods at a station the company may dock at (each item at its best market) */
function bestSale(h: Host, company: string, goods: Cargo, cache: Map<string, { st: Station; bid: number }[]>): number {
  let total = 0;
  for (const [item, n] of Object.entries(goods)) {
    if (n <= 0) continue;
    let list = cache.get(item);
    if (!list) {
      list = Object.values(h.st.stations).filter(st => st.market?.[item] && h.canDock(st, company)).map(st => ({ st, bid: priceOf(st.market![item], 'sell', growthOn(h.st)) })).sort((a, b) => b.bid - a.bid).slice(0, 3);
      cache.set(item, list);
    }
    let best = 0;
    for (const { st } of list) best = Math.max(best, saleQuote(h, st, item, n).value);
    total += best;
  }
  return total;
}
export interface TargetEstimate { p: number; units: number; recover: number; sale: number; risk: number; profit: number; score: number }
/**
 * Expected outcome of threatening ship `s` of group `t` (lane plunder only): the chance it complies (judge()
 * without its noise, nearby separate escorts and support included), the units the raid can really take away
 * (its holds and assigned recovery fleets close to the ship; what does not fit counts half, for extra trips),
 * their real sale value at the best market now, and the risk of a refusal (a fight under `force`, wasted
 * exposure otherwise). Pure: no RNG, no state change.
 */
export function estimateTarget(h: Host, g: WGroup, t: WGroup, s: WShip, op: PlunderOp, from: V, cache = new Map<string, { st: Station; bid: number }[]>()): TargetEstimate {
  const want = wanted(h, s, op.demand, op.item);
  const a = assess(h, g, t, s, want);
  const p = complyChance(a);
  const units = a.units;
  const recover = units <= 0 ? 0 : a.room >= units ? units : a.room + 0.5 * (units - a.room);
  const share = units > 0 ? recover / units : 0;
  const goods: Cargo = {}; for (const [k, n] of Object.entries(want)) goods[k] = Math.floor(n * share);
  const sale = bestSale(h, g.owner, goods, cache);
  const opposed = Math.min(a.attack, a.defense + a.support);
  const risk = (1 - p) * opposed * (op.policy === 'force' ? PIR.aiForceRisk : PIR.aiExposure);
  const profit = p * sale - risk;
  const speed = Math.max(50, h.groupSpeedOf(g));
  const score = profit / (dist(s.pos, from) / speed + PIR.aiFixedTime);
  return { p, units, recover, sale, risk, profit, score };
}

/** pick a victim around the zone (P13.2.2: expected real profit per time for lane plunder; designated targets and
 *  network destruction are never filtered by profit) */
function search(h: Host, g: WGroup, op: PlunderOp, P: PlunderState, from: V): WGroup | undefined {
  if (op.group) { const t = h.st.groups[op.group]; return t && legalVictim(h, g, t, op) ? t : undefined; }
  if (!op.at) return undefined;
  let best: WGroup | undefined, bs = 0, bestEst: TargetEstimate | undefined, seen = 0;
  const r = (op.radius ?? 3000) + PIR.searchPad;
  const cache = new Map<string, { st: Station; bid: number }[]>();
  const cands: { t: WGroup; s: WShip; ub: number; i: number }[] = [];
  const speed = Math.max(50, h.groupSpeedOf(g));
  for (const t of Object.values(h.st.groups)) {
    if ((P.ignore?.[t.id] ?? 0) > h.time || !legalVictim(h, g, t, op)) continue;
    const s = victimShip(h, t); if (!s || dist(s.pos, op.at) > r) continue;
    if (op.policy !== 'destroy' && demandable(h, g, s, !!op.neutral, false)) continue;
    if (op.policy === 'destroy') {
      // network destruction: as before (cargo value over defence and distance), no profit filter
      const v = valueOf(h.st, lootOf(s)), mil = h.groupValue(t, true);
      const score = (v + 100) / (mil + 80) / (dist(s.pos, from) + 1200);
      if (score > bs) { bs = score; best = t; }
      continue;
    }
    seen++;
    // exact upper bound first: profit ≤ the real sale of everything demanded (p ≤ 1, risk ≥ 0, recovered ≤ demanded),
    // so a cheap quote skips the costly judgement (escape route search) without changing any choice
    const ub = bestSale(h, g.owner, wanted(h, s, op.demand, op.item), cache);
    if (ub < PIR.aiMinProfit) continue;
    cands.push({ t, s, ub: ub / (dist(s.pos, from) / speed + PIR.aiFixedTime), i: cands.length });
  }
  // best upper bound first; stop once no remaining candidate can beat the best real score. Same choice as checking
  // all of them in group order (a tie goes to the earlier group, as before)
  cands.sort((a, b) => b.ub - a.ub || a.i - b.i);
  let bi = Infinity;
  for (const c of cands) {
    if (best && c.ub < bs) break;
    const e = estimateTarget(h, g, c.t, c.s, op, from, cache);
    if (e.profit < PIR.aiMinProfit) continue;
    if (e.score > bs || (e.score === bs && best && c.i < bi)) { bs = e.score; best = c.t; bestEst = e; bi = c.i; }
  }
  if (op.policy !== 'destroy') {
    if (bestEst) P.est = { p: round2(bestEst.p), sale: Math.round(bestEst.sale), risk: Math.round(bestEst.risk), profit: Math.round(bestEst.profit) };
    else if (seen) P.why = `수익성 있는 목표 없음 (${seen}척 검토)`;
  }
  return best;
}
const round2 = (x: number) => Math.round(x * 100) / 100;

/** the wreck that a forced fight left of the victim (nearest new one around where it was last seen) */
function victimWreck(h: Host, P: PlunderState): string | undefined {
  if (!P.last) return undefined;
  let best: string | undefined, bd = 4000;
  for (const w of Object.values(h.st.wrecks ?? {})) {
    if (w.created < P.since - 5) continue;
    const d = dist(w.pos, P.last); if (d < bd && w.lots.some(l => l.n >= 1)) { bd = d; best = w.id; }
  }
  return best;
}

/** move the raider's ships toward a point in formation */
function steer(h: Host, g: WGroup, ships: WShip[], to: V, dt: number, full = true, spread = 80) {
  const speed = full ? Math.min(...ships.map(s => h.cruiseOf(s))) : h.groupSpeedOf(g);
  for (const s of ships) if (s.state === 'space' || s.state === 'docked') h.moveTo(s, h.formationSlot(s, g, to, spread), speed, dt, 30);
}
/** a point `d` from `p` on the side of `from` */
const standoff = (p: V, from: V, d: number): V => { const dx = from.x - p.x, dz = from.z - p.z, l = Math.hypot(dx, dz) || 1; return { x: p.x + dx / l * d, y: p.y, z: p.z + dz / l * d }; };

/**
 * One tick of a plunder order (player `plunder`, `harass` with a plunder policy, or a pirate raid that found a
 * hauler with cargo). Returns true when it moved the group's ships.
 */
export function stepPlunder(h: Host, g: WGroup, ships: WShip[], op: PlunderOp, dt: number, c: CommanderDef, key = opKeyOf(op), nounload = false): boolean {
  const st = h.st;
  void c;
  if (g.plx && g.plx.key !== key) delete g.plx;
  const P = (g.plx ??= { key, phase: 'search', since: h.time, next: 0 });
  const mobile = ships.filter(s => s.state === 'space' || s.state === 'docked');
  if (!mobile.length) return false;
  const center = h.groupCenter(g) ?? mobile[0].pos;
  const illegal = !!op.neutral;
  // ---- collecting: a container or the victim's wreck, with the salvage engine
  if (P.phase === 'collect' || P.phase === 'loot') {
    const site = P.site;
    if (nounload && h.time - P.since > PIR.npcCollectMax) { delete g.salv; P.site = undefined; }
    else if (site && canCollect(h, mobile, site, illegal) || g.salv?.key === `collect:${site}`) {
      const ph = stepCollect(h, g, mobile, site!, illegal, dt, nounload);
      if (ph !== 'done' && ph !== 'blocked') { /* status text comes from the salvage engine (약탈품 회수 중 / 회수품 하역 중) */ return true; }
      if (ph === 'blocked') { delete g.salv; h.say(g, '약탈품 하역 불가 — 정거장 창고·정박 규격 확인', 'warn', 30); }
    }
    delete g.salv;
    P.site = undefined; P.target = undefined; P.ship = undefined;
    if (nounload) { setPhase(h, P, 'home'); return false; }
    return conclude(h, g, P, op, '', '약탈 완료');
  }
  if (P.phase === 'home') return false;
  if (P.phase === 'done') return conclude(h, g, P, op, '', '약탈 종료');
  // ---- after using force: the fight is P11's; then loot the wreck
  if (P.phase === 'force') {
    const t = P.target ? st.groups[P.target] : undefined;
    const s = P.ship ? st.ships[P.ship] : undefined;
    if (s && t && s.state !== 'docked') {
      if (s.state === 'space') P.last = { ...s.pos };
      // a hauler that keeps escaping P11 battles (civilians withdraw at 900 m) is not chased into battle after battle
      if (s.state === 'battle') P.fight = true;
      else if (P.fight) { P.fight = false; P.escapes = (P.escapes ?? 0) + 1; }
      if ((P.escapes ?? 0) >= PIR.forceEscapes && s.state === 'space') { (P.ignore ??= {})[t.id] = h.time + PIR.redemand; return conclude(h, g, P, op, `대상이 교전에서 ${P.escapes}회 이탈`, '약탈 실패', 'warn'); }
      if (h.time - P.since > PIR.forceMax && s.state === 'space') { (P.ignore ??= {})[t.id] = h.time + PIR.redemand; return conclude(h, g, P, op, '추격 시간 초과', '약탈 실패', 'warn'); }
      if (s.state === 'space') { steer(h, g, mobile, s.pos, dt, true, 40); g.status = `약탈 — 무력 사용: ${t.name}`; }
      return true;
    }
    if (!s) log(h, { kind: 'sunk', by: g.owner, to: t?.owner, ship: P.ship, system: P.last ? sysAt(st.systems, P.last)?.id : undefined });
    const w = victimWreck(h, P);
    if (w) { P.site = w; setPhase(h, P, 'loot'); return true; }
    if (s?.state === 'docked') { (P.ignore ??= {})[P.target!] = h.time + PIR.redemand; }
    return conclude(h, g, P, op, s ? '대상이 정박해 피신' : '대상 격침 — 회수할 잔해 없음', '약탈 종료');
  }
  // ---- after a stall: hold off, then ask again
  if (P.phase === 'wait') {
    const s = P.ship ? st.ships[P.ship] : undefined;
    if (!s || s.state !== 'space' || h.time >= (P.until ?? 0)) { setPhase(h, P, s && s.state === 'space' ? 'intercept' : 'search'); }
    else { steer(h, g, mobile, standoff(s.pos, center, PIR.threatR - 100), dt, false); g.status = '약탈 — 상대가 버티는 중, 대기'; return true; }
  }
  // ---- choose a victim
  if (P.phase === 'search' || !P.target || !st.groups[P.target]) {
    if (h.time >= P.next) {
      P.next = h.time + 2;
      const t = search(h, g, op, P, center);
      if (t) { P.target = t.id; P.ship = victimShip(h, t)?.id; setPhase(h, P, 'intercept'); h.say(g, `약탈 목표 포착 — ${t.name}`, 'radio', 10); }
    }
    if (P.phase === 'search') {
      if (op.group) return conclude(h, g, P, op, '대상이 없거나 약탈할 수 없습니다', '약탈 종료', 'warn');
      const at = op.at ?? center, a = h.time * 0.03;
      const r = (op.radius ?? 3000) * 0.6;
      steer(h, g, mobile, { x: at.x + Math.cos(a) * r, y: at.y, z: at.z + Math.sin(a) * r }, dt, false, 90);
      g.status = `약탈 구역 탐색 [${PLUNDER_NAME[op.policy]}]`;
      return true;
    }
  }
  // ---- intercept and threaten
  const t = st.groups[P.target!];
  let s = P.ship ? st.ships[P.ship] : undefined;
  if (!s || s.groupId !== t.id || s.state !== 'space') { s = victimShip(h, t); P.ship = s?.id; }
  if (!s) { (P.ignore ??= {})[t.id] = h.time + 60; return conclude(h, g, P, op, '대상이 정박했거나 화물이 없습니다', '약탈 실패', 'warn'); }
  P.last = { ...s.pos };
  if (h.time - P.since > PIR.chaseMax) { (P.ignore ??= {})[t.id] = h.time + PIR.redemand; return conclude(h, g, P, op, `${t.name} 추격 시간 초과`, '약탈 실패', 'warn'); }
  // the threat is the warships: their distance counts (a raider's own hauler may fly ahead)
  const guns = mobile.filter(x => econOf(x).military && x.state === 'space');
  const d = guns.length ? Math.min(...guns.map(x => dist(x.pos, s!.pos))) : Infinity;
  if (d <= PIR.warnR && P.warned !== t.id) {
    P.warned = t.id;
    h.ev('warn', `${t.name}: 무장 함대 접근 — 화물 약탈 위험 (${st.companies[g.owner]?.name ?? g.owner})`, { company: t.owner, pos: s.pos, ref: t.id, tag: 'piracy' });
  }
  if (op.policy === 'destroy') return force(h, g, t, s, P, mobile, dt, 'destroy');
  // in warp or fighting someone: out of reach for now, keep after it (the chase limit decides)
  if (d > PIR.threatR || s.warp?.phase === 'warp' || s.engagement) {
    // lead the target, stop at the standoff
    const aim = s.vel && (s.vel.x || s.vel.z) ? { x: s.pos.x + s.vel.x * Math.min(30, d / 200), y: s.pos.y, z: s.pos.z + s.vel.z * Math.min(30, d / 200) } : s.pos;
    steer(h, g, mobile, standoff(aim, center, PIR.standoff), dt, true, 60);
    g.status = `약탈 — 요격 중: ${t.name} (${Math.round(d)}m)`;
    return true;
  }
  const r = demand(h, g, s, { kind: op.demand, item: op.item, neutral: op.neutral, policy: op.policy });
  if (typeof r === 'string') {
    // already asked recently (by anyone): leave it, unless we may use force
    if (op.policy === 'force' && s.pir && s.pir.by === g.owner && s.pir.act !== 'comply' && s.pir.act !== 'stall') return force(h, g, t, s, P, mobile, dt, 'force');
    (P.ignore ??= {})[t.id] = h.time + 60;
    return conclude(h, g, P, op, r, '약탈 불가', 'warn');
  }
  if (r.response === 'comply' && r.drop) { P.site = r.drop.id; setPhase(h, P, 'collect'); h.say(g, `${t.name} 화물 투하 확인 — 회수한다.`, 'radio', 4); return true; }
  if (r.response === 'stall' && op.policy !== 'force') { P.until = h.time + PIR.restall; setPhase(h, P, 'wait'); return true; }
  if (op.policy === 'force') return force(h, g, t, s, P, mobile, dt, 'force');
  // non-destructive: withdraw
  log(h, { kind: 'withdraw', by: g.owner, to: t.owner, group: g.id, ship: s.id, system: sysAt(st.systems, s.pos)?.id });
  (P.ignore ??= {})[t.id] = h.time + PIR.redemand;
  h.say(g, `${t.name} 요구 거부(${RESPONSE_NAME[r.response]}) — 비파괴 원칙에 따라 물러난다.`, 'radio', 4);
  return conclude(h, g, P, op, `요구 거부 (${RESPONSE_NAME[r.response]})`, '약탈 실패 — 철수', 'warn');
}

// ------------------------------------------------------------------ separate recovery fleet (P13.2.2)

type TenderOp = Extract<Op, { k: 'lootTender' }>;
/** containers this raid made jettison that these ships may take now (the raid's current one first, then the nearest) */
function tenderSite(h: Host, raid: WGroup, ships: WShip[], from: V, illegal: boolean): string | undefined {
  const cur = raid.plx?.site;
  if (cur && h.st.drops?.[cur]?.raid === raid.id && canCollect(h, ships, cur, illegal)) return cur;
  let best: string | undefined, bd = Infinity;
  for (const d of Object.values(h.st.drops ?? {})) {
    if (d.raid !== raid.id || d.by !== raid.owner) continue;
    const dd = dist(d.pos, from); if (dd >= bd || !canCollect(h, ships, d.id, illegal)) continue;
    bd = dd; best = d.id;
  }
  return best;
}
/**
 * One tick of a recovery fleet assigned to a raid: follow the raid at a distance; when that raid made a ship
 * jettison, recover the container with the salvage engine (approach, work into the real holds, unload at a
 * station when full) and come back. It never threatens, fights or counts as force; the raid's guns do that.
 */
export function stepTender(h: Host, g: WGroup, ships: WShip[], op: TenderOp, dt: number): boolean {
  const st = h.st;
  const raid = st.groups[op.group];
  const mobile = ships.filter(s => s.state === 'space' || s.state === 'docked');
  if (!raid || raid.owner !== g.owner || !raid.shipIds.length) {
    if (!(g.salv?.key.startsWith('collect:') && mobile.some(salvAboard))) {
      delete g.salv;
      h.say(g, '약탈 회수 지원 종료 — 지원할 약탈 편대가 없습니다. 대기합니다.', 'info', 0);
      if (g.override || !g.parentId) { g.op = { k: 'idle' }; g.override = !!g.parentId; }
      g.status = '약탈 회수 지원 종료 — 약탈 편대 없음';
      return true;
    }
  }
  if (!mobile.length) return false;
  const rop = raid ? plunderOrder(st, h.opOf(raid)) : null;
  const illegal = !!rop?.neutral;
  const center = h.groupCenter(g) ?? mobile[0].pos;
  // a collection run in progress (also its unloading trip after the container is gone) goes on
  let site = g.salv?.key.startsWith('collect:') ? g.salv.key.slice(8) : undefined;
  if (!site && raid && h.time >= ((g as unknown as { _tenderLook?: number })._tenderLook ?? 0)) {
    (g as unknown as { _tenderLook?: number })._tenderLook = h.time + 1;
    site = tenderSite(h, raid, mobile, center, illegal);
  }
  if (site) {
    const ph = stepCollect(h, g, mobile, site, illegal, dt);
    if (ph !== 'done' && ph !== 'blocked') return true;
    if (ph === 'blocked') h.say(g, '회수품 하역 불가 — 정거장 창고·정박 규격 확인', 'warn', 30);
    delete g.salv;
  }
  if (!raid) return true;
  // follow: hold PIR.tenderTrail behind the raid, on our side of it
  const rc = h.groupCenter(raid);
  if (!rc) { g.status = `약탈 회수 지원 — ${raid.name} 대기`; return true; }
  const to = standoff(rc, center, PIR.tenderTrail);
  if (dist(center, rc) > PIR.tenderTrail + 300) steer(h, g, mobile.filter(s => econOf(s).cruise > 0), to, dt, false, 90);
  else for (const s of mobile) if (s.state === 'space') { s.vel.x *= 0.9; s.vel.z *= 0.9; }
  const ph = raid.plx?.phase;
  g.status = `약탈 회수 지원 — ${raid.name} ${ph === 'collect' ? '투하 화물 회수 대기' : ph === 'search' ? '항로 탐색 동행' : '동행'}`;
  return true;
}
const salvAboard = (s: WShip) => !!s.salvaged && Object.keys(s.salvaged).some(k => qty(s.cargo, k) > 1e-9);

/** validate a lootTender order (server) */
export function validateTender(h: Host, company: string, g: WGroup, op: TenderOp, ships: WShip[]): string | null {
  if (!h.st.piracyV) return '이 세계에서는 화물 약탈(P13.2)이 활성화되지 않았습니다';
  const raid = typeof op.group === 'string' ? h.st.groups[op.group] : undefined;
  if (!raid || !raid.shipIds.length) return '지원할 약탈 편대가 없습니다';
  if (raid.owner !== company) return '자사 약탈 편대만 지원할 수 있습니다';
  if (raid.id === g.id) return '자기 편대는 지정할 수 없습니다';
  if (raid.parentId === g.id || g.parentId === raid.id) return '상하위 편대는 이미 같은 작전입니다 — 분리된 편대를 지정하세요';
  if (!ships.some(s => econOf(s).cruise > 0 && !econOf(s).military && salvageRoom(h, s) + cargoSum(s.cargo) > 0)) return '회수품을 실을 수송선이 없습니다';
  return null;
}

/** the victim that was warned hears that the raider has gone (its own state is not disclosed) */
/** a new order replaces a plunder: its state (chase, escape count, warning) ends with it */
export function endPlunder(h: Host, g: WGroup, nextKey: string) {
  const P = g.plx; if (!P || P.key === nextKey || P.key === 'raid') return;
  leave(h, g, P); delete g.plx;
}
function leave(h: Host, g: WGroup, P: PlunderState) {
  const t = P.warned ? h.st.groups[P.warned] : undefined;
  P.warned = undefined;
  if (!t || t.owner === g.owner) return;
  const c = h.groupCenter(g);
  h.ev('info', `${t.name}: ${h.st.companies[g.owner]?.name ?? g.owner} 무장 함대 이탈`, { company: t.owner, ...(c ? { pos: c } : {}), ref: t.id, tag: 'piracy' });
}

/** a designated raid ends here (report, stand by); a zone raid looks for the next target */
function conclude(h: Host, g: WGroup, P: PlunderState, op: PlunderOp, why: string, head: string, kind: 'info' | 'warn' = 'info'): boolean {
  leave(h, g, P);
  P.target = undefined; P.ship = undefined; P.site = undefined; P.est = undefined;
  if (!op.group) { setPhase(h, P, 'search', why); return true; }
  if (P.key === 'raid') { delete g.plx; return true; }   // a pirate band goes back to its raid
  h.say(g, `${head}${why ? ` — ${why}` : ''}. 대기합니다.`, kind, 0);
  if (g.override || !g.parentId) { g.op = { k: 'idle' }; g.override = !!g.parentId; }
  delete g.plx; g.status = `${head}${why ? ` — ${why}` : ''}`;
  return true;
}

/** use force: neutral NPCs never; a neutral player is declared hostile (same rule as an attack order) */
function force(h: Host, g: WGroup, t: WGroup, s: WShip, P: PlunderState, mobile: WShip[], dt: number, why: 'force' | 'destroy'): boolean {
  const st = h.st, rel = coRelation(st, g.owner, t.owner), k = st.companies[t.owner]?.kind;
  if (rel !== -1) {
    if (k !== 'player' || st.companies[g.owner]?.kind !== 'player') { (P.ignore ??= {})[t.id] = h.time + PIR.redemand; setPhase(h, P, 'search', '중립 NPC에는 무력을 사용할 수 없습니다'); return true; }
    h.setStance(g.owner, t.owner, -1, 'attack');
  }
  breakTruce(h, g, t);
  log(h, { kind: 'force', by: g.owner, to: t.owner, group: g.id, ship: s.id, system: sysAt(st.systems, s.pos)?.id, policy: why });
  h.ev('warn', `${t.name}: ${st.companies[g.owner]?.name ?? g.owner}이(가) 무력을 사용합니다`, { company: t.owner, pos: s.pos, ref: t.id, tag: 'piracy' });
  h.say(g, why === 'destroy' ? `${t.name} 격침에 나선다.` : `${t.name} 요구 거부 — 무력을 사용한다.`, 'warn', 4);
  P.last = { ...s.pos };
  setPhase(h, P, 'force');
  steer(h, g, mobile, s.pos, dt, true, 40);
  return true;
}

// ------------------------------------------------------------------ pirate bands

/**
 * A pirate raid that found a hauler with cargo: demand first (same rules), collect a container physically
 * within the band's salvage hold, carry it to the lair and store it there (lair.hold). Returns true when it
 * moved the band this tick; false lets the ordinary raid behaviour (charge → P11) run.
 */
export function stepPirateRaid(h: Host, g: WGroup, ships: WShip[], op: Extract<Op, { k: 'raid' }>, dt: number, c: CommanderDef): boolean {
  const st = h.st; if (!st.piracyV) return false;
  const lair = st.lairs[op.home];
  const mobile = ships.filter(s => s.state === 'space');
  if (!mobile.length) return false;
  const P = g.plx;
  // carrying plunder home
  const aboard = mobile.some(s => s.salvaged && Object.keys(s.salvaged).some(k => qty(s.cargo, k) > 1e-9));
  if (P?.phase === 'home' && !aboard) { delete g.plx; return false; }
  if (P?.phase === 'home' || (!P && aboard)) {
    if (!lair || !lair.alive) { delete g.plx; return false; }
    const d = dist(h.groupCenter(g) ?? mobile[0].pos, lair.pos);
    if (d > 700) { steer(h, g, mobile, lair.pos, dt, false, 80); g.status = '약탈품 운반 — 은신처 귀환'; if (g.plx) g.plx.phase = 'home'; else g.plx = { key: 'raid', phase: 'home', since: h.time, next: 0 }; return true; }
    storeAtLair(h, lair, mobile);
    delete g.plx; return false;
  }
  // after a fight: what the band can carry from a fresh wreck close by (the same salvage engine, its own hold)
  if (!P && h.time >= ((g as any)._wreckLook ?? 0)) {
    (g as any)._wreckLook = h.time + 5;
    const cen = h.groupCenter(g) ?? mobile[0].pos;
    if (mobile.reduce((a, s) => a + salvageRoom(h, s), 0) >= 1) for (const w of Object.values(st.wrecks ?? {})) {
      if (h.time - w.created > PIR.npcWreckAge || Math.abs(w.pos.x - cen.x) > PIR.npcWreckR || dist(w.pos, cen) > PIR.npcWreckR) continue;
      if (!w.lots.some(l => l.k === 'cargo' && l.n >= 1) || !canCollect(h, mobile, w.id, false)) continue;
      g.plx = { key: 'raid', phase: 'loot', since: h.time, next: 0, site: w.id };
      return stepPlunder(h, g, mobile, { k: 'plunder', policy: 'force' }, dt, c, 'raid', true);
    }
  }
  if (P && (P.phase === 'collect' || P.phase === 'loot' || P.phase === 'wait')) return stepPlunder(h, g, mobile, { k: 'plunder', policy: 'force', group: P.target }, dt, c, 'raid', true);
  // the band has chosen its prey (pickRaidTarget): demand once in range, otherwise let the raid charge
  const t = op.target ? st.groups[op.target] : undefined; if (!t) return false;
  const s = victimShip(h, t); if (!s) return false;
  const d = Math.min(...mobile.filter(x => econOf(x).military).map(x => dist(x.pos, s.pos)));
  if (d > PIR.threatR) return false;
  if (demandable(h, g, s, true)) return false;
  const r = demand(h, g, s, { kind: 'part' });
  if (typeof r === 'string' || r.response !== 'comply' || !r.drop) return false;   // refused: the raid goes on as before (charge → P11)
  g.plx = { key: 'raid', phase: 'collect', since: h.time, next: 0, target: t.id, ship: s.id, site: r.drop.id };
  h.say(g, '화물 투하 확인 — 챙겨라.', 'radio', 4);
  return true;
}

/** put what a band recovered into its lair's hold (real goods; nothing else uses them yet — P14) */
function storeAtLair(h: Host, lair: NonNullable<WorldState['lairs'][string]>, ships: WShip[]) {
  const hold = (lair.hold ??= {}); const moved: Cargo = {};
  for (const s of ships) {
    for (const k of Object.keys(s.salvaged ?? {})) {
      const n = Math.min(qty(s.salvaged!, k), qty(s.cargo, k)); if (n <= 1e-9) continue;
      takec(s.cargo, k, n); addc(hold, k, n); moved[k] = (moved[k] ?? 0) + n;
      emit(h.st, { kind: 'piracy', reason: 'lair_store', item: k, amount: n, company: s.owner, group: s.groupId, ship: s.id, ref: lair.id });
    }
    delete s.salvaged;
  }
  if (Object.keys(moved).length) log(h, { kind: 'store', by: 'pirates', system: sysAt(h.st.systems, lair.pos)?.id, value: valueOf(h.st, moved), items: moved });
}

/** expected plunder of a target for pickRaidTarget: real cargo value, capped by what the band could carry */
export function raidLootValue(h: Host, band: WGroup, t: WGroup): number {
  const room = h.shipsOf(band).reduce((a, s) => a + salvageRoom(h, s), 0);
  let v = 0, units = 0;
  for (const s of h.shipsOf(t)) { if (s.state !== 'space') continue; const l = lootOf(s); v += valueOf(h.st, l); units += cargoSum(l); }
  return units > 0 ? v * Math.min(1, room / units) : 0;
}

/** validate a plunder order (server) */
export function validatePlunder(h: Host, company: string, g: WGroup, op: Op, ships: WShip[]): string | null | undefined {
  if (op.k !== 'plunder' && !(op.k === 'harass' && (op.plunder !== undefined || op.neutral !== undefined))) return undefined;
  if (!h.st.piracyV) return '이 세계에서는 화물 약탈(P13.2)이 활성화되지 않았습니다';
  const pol = op.k === 'plunder' ? op.policy : op.plunder;
  if (pol !== 'nonlethal' && pol !== 'force' && pol !== 'destroy') return '약탈 정책을 선택하세요 (비파괴 우선 / 무력 사용 허용 / 수송망 파괴 우선)';
  if (op.neutral !== undefined && typeof op.neutral !== 'boolean') return '중립 대상 허가 값 오류';
  if (!ships.some(s => econOf(s).military && econOf(s).cruise > 0)) return '위협할 군함이 없습니다';
  if (op.k === 'harass') return null;
  if (op.demand !== undefined && op.demand !== 'part' && op.demand !== 'all' && op.demand !== 'item') return '요구 방식 오류';
  if (op.demand === 'item' && (typeof op.item !== 'string' || !droppable(op.item))) return '요구할 품목을 선택하세요';
  if (!!op.group === !!op.at) return '대상 함대 또는 약탈 구역 하나를 지정하세요';
  if (op.group) {
    const t = h.st.groups[op.group];
    if (!t || !t.shipIds.length) return '약탈 대상 없음';
    if (t.owner === company) return '자사 함대는 약탈할 수 없습니다';
    const rel = coRelation(h.st, company, t.owner);
    if (rel === 1) return '동맹 회사는 약탈할 수 없습니다';
    if (rel === 0 && !op.neutral) return '중립 회사입니다 — 「중립 대상 포함」을 명시해야 약탈할 수 있습니다 (치안 구역에서는 평판 하락)';
    if (h.st.companies[t.owner]?.kind === 'pirate') return '해적 함대는 약탈 대상이 아닙니다';
    if (op.policy === 'destroy' && rel === 0 && h.st.companies[t.owner]?.kind !== 'player') return '중립 NPC에는 무력을 사용할 수 없습니다';
    return null;
  }
  const p = op.at as V;
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return '좌표 오류';
  if (!h.sysOf(p)) return '좌표가 성계 밖입니다';
  if (op.radius !== undefined && !(typeof op.radius === 'number' && op.radius >= 300 && op.radius <= 12000)) return '반경은 300–12000 사이여야 합니다';
  return null;
}

/** conservation check used by tests: every unit that left a ship is in a container, recovered or decayed */
export function dropUnits(st: WorldState): number { return Object.values(st.drops ?? {}).reduce((a, d) => a + wreckUnits(d), 0); }
export { WRECK_SEEN_R };
void ({} as WShip | undefined);
