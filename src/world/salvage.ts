// P13.1 physical salvage (salvageV worlds). One engine for every way of recovering wreckage:
//   • recover   — a fleet ordered to one wreck: fly there, work it, unload at a station when full, come back
//                 until nothing workable is left, then stand by;
//   • salvzone  — a continuing salvage operation: the commander picks wrecks around a point (value, work,
//                 distance, risk, hold space), unloads and returns, until told otherwise;
//   • auto      — after a battle an idle (or holding defence / patrol) fleet picks up what is close, safe and
//                 legal, within a time and distance limit, then carries on with what it was doing.
// Work moves whole units from the wreck's lot into the ship's real hold in the same step (the server is
// single-threaded, so two companies on one wreck can never take the same unit). Recovered goods only reach
// a warehouse by docking and unloading. Cargo of a non-hostile company is protected: automatic salvage never
// takes it, an explicit order must say so, and doing it where the law reaches costs reputation / standing.
// See docs/P13_1_SALVAGE.md.
import type { WorldSim } from './sim';
import type { Cargo, Op, Station, V, WGroup, WShip } from './types';
import { addc, cargoSum, qty, takec } from './types';
import type { WreckLot, SalvSite } from './wrecks';
import { lotValue, itemLabel, siteOf, allSites } from './wrecks';
import { coRelation } from './battleAuth';
import { econOf, berthFits } from './hullops';
import { shipValue } from './data';
import { dist, sysAt } from './geom';
import { techFx } from './industry';
import { effSec } from './security';
import { bumpStanding } from './territory';
import { repOffense } from './reputation';
import { lawCrime } from './law';
import { emit } from './observe';
import { stationCargoRate } from './stations';
import { opKey } from './fleetops';
import { recoveredKey, unloadRisk, warnNoSafeUnload } from './blackmarket';
import { contractStationFor, deliverSalvage, noteSalvageSource, trimSalvageSource } from './salvageContracts';
import type { CommanderDef } from '../sim/data/commanders';
import { stepPoolShip } from './autonomousLogistics';
import { planMinerSaleTrip } from './procurement';

type Host = WorldSim;
import { shipFx, groupFx } from './officers';
import { XP_RATE } from './officerData';

export interface SalvState {
  mode: 'recover' | 'zone' | 'auto';
  /** the order this state belongs to (a new order resets it) */
  key: string;
  phase: 'transit' | 'work' | 'unload' | 'return' | 'hold' | 'blocked' | 'done';
  wreck?: string;
  station?: string;
  since: number;
  next: number;
  /** automatic pickup: gives up at this time */
  until?: number;
  /** automatic pickup: where it started (max distance from there) */
  anchor?: V;
  why?: string;
  /** wrecks / stations not to pick again before the given time */
  ignore?: Record<string, number>;
  /** P13.2 collection for a raid: never go unloading at a station (the raider decides where the goods go) */
  nounload?: true;
}

export const SALV = {
  /** work distance from a wreck's centre */
  reach: 380,
  /** units / s per ship, by lot kind and ship role (×1.5 with salvage_ops; rate halves below 50 % hull) */
  rate: {
    cargo: { hauler: 8, constructor: 5, miner: 4, military: 2 },
    equip: { constructor: 0.1, military: 0.02, other: 0 },
    hull: { miner: 5, constructor: 3 },
    frag: { constructor: 0.05, other: 0 },
  },
  /** with salvage_ops, haulers and miners can also pull equipment, and anyone fragments */
  techEquip: 0.02, techFrag: 0.02, techMul: 1.5,
  /** industrial-hardpoint ships (WShip.ind): units / s per 1.0 of fitted salvage gear × hull bonus — the
   *  old constructor row, so a small salvage rig works like the old 석공급. No gear, no salvage. */
  gear: { cargo: 5, equip: 0.1, hull: 3, frag: 0.05 },
  /** salvage hold of a warship (it has no cargo bay): shipValue × this */
  warHold: 0.1,
  /** automatic pickup: nearby wrecks only, limited time, nobody hostile around */
  autoRange: 3000, autoTime: 600, autoCheck: 3, hostileR: 5000,
  /** reputation / standing lost per credit of protected cargo taken, where security ≥ lawSec */
  lawSec: 25, repPerCr: 1 / 2000, standingPerCr: 1 / 1000,
  /** zone: wrecks scored by value / (travel + work time) × safety */
  ignoreFor: 600,
} as const;

const roleOf = (s: WShip): 'hauler' | 'constructor' | 'miner' | 'military' | 'other' => {
  const e = econOf(s);
  return e.military ? 'military' : s.classId === 'constructor' ? 'constructor' : s.classId === 'miner' ? 'miner' : s.classId === 'hauler' || e.cargo > 0 ? 'hauler' : 'other';
};
/** what this ship can hold of salvage (warships: a small salvage hold) */
export function salvageHold(h: Pick<Host, 'st'>, s: WShip): number {
  const e = econOf(s);
  const base = e.military ? Math.round(shipValue(s.classId) * SALV.warHold) : e.cargo * techFx(h.st.companies[s.owner]?.tech).cargoMul;
  // B-1: a scrap master packs the salvage hold tighter (salvage only — mining and trade holds are unchanged)
  const hold = h.st.officerV ? shipFx(h.st, s).salvHold ?? 0 : 0;
  return hold ? Math.round(base * (1 + hold)) : base;
}
export const salvageRoom = (h: Pick<Host, 'st'>, s: WShip) => Math.max(0, salvageHold(h, s) - cargoSum(s.cargo));
/** units / s this ship works a lot of this kind (0 = cannot) */
export function salvageRate(h: Pick<Host, 'st'>, s: WShip, k: WreckLot['k']): number {
  const role = roleOf(s), tech = !!h.st.companies[s.owner]?.tech?.includes('salvage_ops');
  // industrial hardpoint rules: a civilian hull salvages only with salvage gear fitted, at the gear's rate
  // (× hull bonus); research and officers then make that work faster but never grant it. Warships keep
  // their small battlefield pickup (they have no industrial hardpoint).
  const gear = s.ind && role !== 'military';
  const t = SALV.rate[k] as Record<string, number>;
  let r = gear ? SALV.gear[k] * (econOf(s).salv ?? 0) : t[role] ?? t.other ?? 0;
  if (!gear && tech && !r && k === 'equip') r = SALV.techEquip;
  if (!gear && tech && !r && k === 'frag') r = SALV.techFrag;
  // B-1 salvage officer: faster recovery; hull cutting extended to haulers and warships
  const fx = h.st.officerV ? shipFx(h.st, s) : undefined;
  if (fx) {
    if (!gear && k === 'hull' && !r && fx.salvHull) r = role === 'military' ? 0.8 : role === 'hauler' ? 1.5 : 0;
    r *= 1 + (fx.salv ?? 0) + (k === 'equip' ? fx.salvEquip ?? 0 : k === 'frag' ? fx.salvFrag ?? 0 : 0);
  }
  return r * (tech ? SALV.techMul : 1) * (s.hp > 0.5 ? 1 : 0.5);
}
const weightless = (l: WreckLot) => l.k === 'frag';

/** cargo of a non-hostile company is protected (hull scrap, equipment and fragments of wrecks are free salvage) */
export function protectedLot(h: Pick<Host, 'st'>, company: string, l: WreckLot): boolean {
  if (l.k !== 'cargo' || l.owner === company) return false;
  const o = h.st.companies[l.owner];
  if (!o || o.kind === 'pirate' || l.owner === 'pirates') return false;
  return coRelation(h.st, company, l.owner) !== -1;
}
const PRI: Record<WreckLot['k'], number> = { cargo: 0, equip: 1, frag: 2, hull: 3 };
/** lots this ship may and can work now, best first */
function lotsFor(h: Host, s: WShip, w: SalvSite, illegal: boolean): WreckLot[] {
  const room = salvageRoom(h, s);
  const byValue = h.st.officerV && !!shipFx(h.st, s).salvValue;   // B-1 appraisal: the most valuable lot first
  return w.lots.filter(l => l.n >= 1 && (illegal || !protectedLot(h, s.owner, l)) && salvageRate(h, s, l.k) > 0 && (weightless(l) || room >= 1))
    .sort((a, b) => (byValue ? lotValue(h.st, b) - lotValue(h.st, a) : 0) || PRI[a.k] - PRI[b.k] || lotValue(h.st, b) - lotValue(h.st, a) || a.id.localeCompare(b.id));
}
/** can any of these ships still do something at this wreck */
export function workable(h: Host, ships: WShip[], w: SalvSite, illegal: boolean): boolean {
  return ships.some(s => lotsFor(h, s, w, illegal).length > 0);
}
/** rough value the fleet could take from a wreck (capped by free hold) */
function prospect(h: Host, ships: WShip[], w: SalvSite, illegal: boolean): { value: number; units: number; time: number } {
  let room = ships.reduce((a, s) => a + salvageRoom(h, s), 0), value = 0, units = 0, time = 0;
  const rates: Record<string, number> = {};
  for (const s of ships) for (const k of ['cargo', 'equip', 'hull', 'frag'] as const) rates[k] = (rates[k] ?? 0) + salvageRate(h, s, k);
  for (const l of [...w.lots].sort((a, b) => lotValue(h.st, b) - lotValue(h.st, a))) {
    if (l.n < 1 || !rates[l.k] || (!illegal && protectedLot(h, ships[0]?.owner ?? '', l))) continue;
    const n = weightless(l) ? l.n : Math.min(l.n, room); if (n <= 0) continue;
    if (!weightless(l)) room -= n;
    value += n * lotValue(h.st, l); units += n; time += n / rates[l.k];
  }
  return { value, units, time };
}

function hostileNear(h: Host, owner: string, p: V, r: number): boolean {
  for (const g of Object.values(h.st.groups)) {
    if (g.owner === owner || !g.shipIds.length || g.cooldown > 0 || coRelation(h.st, owner, g.owner) !== -1) continue;
    const c = h.groupCenter(g); if (!c || Math.abs(c.x - p.x) > r || dist(c, p) > r) continue;
    if (g.shipIds.some(id => { const x = h.st.ships[id]; return !!x && x.state !== 'docked' && econOf(x).military; })) return true;
  }
  return false;
}

/** one ship works the wreck for dt seconds; returns units moved */
function workShip(h: Host, s: WShip, w: SalvSite, illegal: boolean, dt: number): number {
  if (s.logisticsJob || s.cargoWork) return 0;
  const lot = lotsFor(h, s, w, illegal)[0]; if (!lot) return 0;
  const key = `${w.id}:${lot.id}`;
  let a = (s.salvAcc?.lot === key ? s.salvAcc.a : 0) + salvageRate(h, s, lot.k) * dt;
  const take = Math.min(Math.floor(a + 1e-9), lot.n, weightless(lot) ? Infinity : Math.floor(salvageRoom(h, s) + 1e-9));
  if (take > 0) {
    lot.n -= take; a -= take;
    // P13.3: another company's cargo becomes stolen goods (its own key), the owner's own goods come back plain
    const k = recoveredKey(h.st, s.owner, lot);
    addc(s.cargo, k, take);
    addc((s.salvaged ??= {}), k, take);
    if (h.st.derelictV) noteSalvageSource(h.st, s, k, w.id, take, take * lotValue(h.st, lot));
    const t = (w.taken[s.owner] ??= {}); t[lot.item] = (t[lot.item] ?? 0) + take;
    if (!w.seen.includes(s.owner)) w.seen.push(s.owner);
    recovered(h, s, w, lot, take);
    emit(h.st, { kind: 'salvage', reason: 'recover', item: k, amount: take, company: s.owner, group: s.groupId, ship: s.id, system: w.system, ref: w.id, from: lot.owner });
    if (protectedLot(h, s.owner, lot)) crime(h, s, w, lot, take);
    // B-1 experience: real recovered value — never for taking back one's own goods or for protected (stolen) cargo
    else if (h.st.officerV && lot.owner !== s.owner) { const g = h.st.groups[s.groupId]; const c = h.groupOfficer(g); if (c) h.officerXp(c, 'salvage', take * lotValue(h.st, lot) * XP_RATE.salvage, { salvage: 1 }); }
  }
  s.salvAcc = { lot: key, a: Math.min(a, 1) };
  return take;
}

/** P13.2: the owner of jettisoned cargo hears (once per recovering company) that someone is taking it */
function recovered(h: Host, s: WShip, w: SalvSite, lot: WreckLot, n: number) {
  const d = h.st.drops?.[w.id]; if (!d || n <= 0) return;
  const key = s.owner, told = (d.told ??= []);
  if (told.includes(key)) return; told.push(key);
  const co = h.st.companies[s.owner]?.name ?? s.owner;
  if (s.owner === d.owner) h.ev('info', `${d.name}: 자사 투하 화물 회수 시작`, { company: d.owner, pos: d.pos, ref: d.id, tag: 'piracy' });
  else {
    h.ev('info', `${d.name}: 화물 회수 시작 (${itemLabel(lot.item)})`, { company: s.owner, pos: d.pos, ref: d.id, tag: 'piracy' });
    if (h.st.companies[d.owner]?.kind === 'player') h.ev('warn', `${d.name}: ${co}이(가) 귀사 투하 화물을 회수했습니다 — 소유권 이전`, { company: d.owner, pos: d.pos, ref: d.id, tag: 'piracy' });
  }
}

/** unauthorised recovery of another company's cargo: reputation / standing where the law reaches */
function crime(h: Host, s: WShip, w: SalvSite, lot: WreckLot, n: number) {
  const value = n * lotValue(h.st, lot);
  (w.crime ??= {})[s.owner] = (w.crime[s.owner] ?? 0) + value;
  const sys = h.st.systems[w.system], sec = sys ? effSec(sys) : 0;
  const co = h.st.companies[s.owner];
  emit(h.st, { kind: 'salvage', reason: 'unauthorized', item: lot.item, amount: n, value, company: s.owner, ref: w.id, from: lot.owner, system: w.system });
  // P13.4: one law case per site and company, growing with what is really taken (the reputation rule below stays as is)
  if (h.st.lawV) lawCrime(h, { kind: 'salvage', by: s.owner, group: s.groupId, ship: s.id, victim: lot.owner, sys: w.system, pos: s.pos, value, key: `salv:${w.id}:${s.owner}` });
  // P14.0 (repV): one penalty per site and company, growing with the cumulative value (not per lot)
  if (h.st.repV && sec >= SALV.lawSec && co) repOffense(h.st, s.owner, sys?.faction, 'salvage', w.crime[s.owner], `salv:${w.id}:${s.owner}`, '무단 인양');
  else if (sec >= SALV.lawSec && co) {
    const rep = value * SALV.repPerCr * (sec / 100);
    co.rep = Math.max(0, co.rep - rep);
    emit(h.st, { kind: 'reputation', reason: 'unauthorized_salvage', amount: -rep, company: s.owner, system: w.system });
    if (h.st.factions && sys?.faction && sys.faction !== 'pirates') bumpStanding(h.st, s.owner, sys.faction, -value * SALV.standingPerCr * (sec / 100));
  }
  const key = `_warn_${s.owner}`, any = w as unknown as Record<string, number>;
  if ((any[key] ?? -1e9) + 120 <= h.time) {
    any[key] = h.time;
    h.ev('warn', `${w.name}: ${h.st.companies[lot.owner]?.name ?? lot.owner} 소유 화물 무단 회수${sec >= SALV.lawSec ? ` — 치안 구역 위반 (평판 하락)` : ' (무법 구역)'}`, { company: s.owner, pos: w.pos, ref: w.id, tag: 'salvage' });
    if (h.st.companies[lot.owner]?.kind === 'player') h.ev('warn', `${w.name}: ${co?.name ?? s.owner}이(가) 귀사 화물을 회수하고 있습니다`, { company: lot.owner, pos: w.pos, ref: w.id, tag: 'salvage' });
  }
}

/** unload what came from wrecks (only that) into company storage; staged by the station's cargo rate */
export function unloadSalvage(h: Host, s: WShip, st: Station): number {
  // A-3.2b: goods owed to a salvage contract of this station are handed over first (consumed, never stored)
  const handed = h.st.derelictV && s.salvSrc ? deliverSalvage(h, s, st) : 0;
  const moved = unloadToStore(h, s, st);
  if (h.st.derelictV && moved + handed > 0) { const co = h.st.companies[s.owner]; if (co?.kind === 'player') h.milestone(co, 'first_salvage'); }
  if (s.salvSrc) trimSalvageSource(s);
  return moved + handed;
}
function unloadToStore(h: Host, s: WShip, st: Station): number {
  const sal = s.salvaged; if (!sal) return 0;
  const total = Object.keys(sal).reduce((a, k) => a + Math.min(qty(sal, k), qty(s.cargo, k)), 0);
  if (total <= 1e-9) { delete s.salvaged; return 0; }
  let limit = Infinity;
  if (stationCargoRate(st) !== undefined) { const p = h.cargoPermit(s, st, 'salvage-unload', total); if (p === null) return 0; limit = p; }
  let moved = 0;
  for (const k of Object.keys(sal)) {
    const n = Math.min(qty(sal, k), qty(s.cargo, k), h.intakeRoom(st, s.owner, k), limit - moved);
    if (n <= 1e-9) continue;
    takec(s.cargo, k, n); takec(sal, k, n); addc(h.storage(st, s.owner), k, n); moved += n;
    emit(h.st, { kind: 'logistics', reason: 'salvage_unload', amount: n, company: s.owner, group: s.groupId, ship: s.id, station: st.id, item: k });
  }
  for (const k of Object.keys(sal)) if (qty(sal, k) <= 1e-9 || qty(s.cargo, k) <= 1e-9) delete sal[k];
  if (!Object.keys(sal).length) delete s.salvaged;
  return moved;
}
const mobileOrDocked = (ships: WShip[]) => ships.filter(s => (s.state === 'space' || s.state === 'docked') && econOf(s).cruise > 0 && !s.logisticsJob && !s.cargoWork);
const salvageAboard = (s: WShip) => !!s.salvaged && Object.keys(s.salvaged).some(k => qty(s.cargo, k) > 1e-9);

/** a station to unload at: dockable, storage room for what is aboard, berths for the fleet; nearest (own preferred).
 *  P13.3.1: never a station an automatic run would reach through an inspection (route gates or the dock) with
 *  contraband aboard — `skip.risky` counts such stations so the caller can say why it waits with the cargo. */
function pickStation(h: Host, g: WGroup, ships: WShip[], from: V, ignore: Record<string, number> = {}, skip?: { risky: number }): Station | null {
  // A-3.2b: a salvage contract's station takes the delivery first (the goods owed are handed over, not stored)
  const owed = h.st.derelictV ? contractStationFor(h, ships) : undefined, cs = owed ? h.st.stations[owed] : undefined;
  if (cs && (ignore[cs.id] ?? 0) <= h.time && h.canDock(cs, g.owner) && ships.every(s => berthFits(cs, econOf(s).berth)) && unloadRisk(h, g.owner, from, cs, ships) <= 0) return cs;
  const items = new Set<string>(); for (const s of ships) for (const k of Object.keys(s.salvaged ?? {})) items.add(k);
  let best: Station | null = null, bd = Infinity;
  for (const st of Object.values(h.st.stations)) {
    if ((ignore[st.id] ?? 0) > h.time || !h.canDock(st, g.owner)) continue;
    if (!ships.every(s => berthFits(st, econOf(s).berth))) continue;
    if (items.size && ![...items].some(k => h.intakeRoom(st, g.owner, k) > 1)) continue;
    const d = h.routeDistance(from, st.pos) * (st.owner === g.owner ? 0.8 : 1);
    if (d >= bd) continue;
    if (unloadRisk(h, g.owner, from, st, ships) > 0) { if (skip) skip.risky++; continue; }
    bd = d; best = st;
  }
  return best;
}
const NO_SAFE = '장물 안전 하역지 없음 — 검문 위험이 없는 자사·안전 정거장이 없어 화물을 보존한 채 대기 (밀수 운송·직접 입항 하역 지시 가능)';
const NO_ROOM = '하역 가능한 정거장이 없습니다 — 창고 공간·정박 규격 확인';
/** blocked: say why (no safe station vs. no room), and warn the owner when stolen goods are what holds it up */
function blockUnload(h: Host, g: WGroup, S: SalvState, skip: { risky: number }) {
  if (skip.risky > 0) { setPhase(h, S, 'blocked', NO_SAFE); warnNoSafeUnload(h, g); }
  else setPhase(h, S, 'blocked', NO_ROOM);
}

const MODE_NAME = { recover: '지정 인양', zone: '구역 인양', auto: '현장 자동 인양' } as const;
export const SALV_PHASE: Record<SalvState['phase'], string> = { transit: '잔해로 이동', work: '인양 중', unload: '하역하러 이동', return: '인양 구역 복귀', hold: '구역 대기', blocked: '작업 불가', done: '완료' };
/** P13.2.1 display only: what the group is actually working on — a sunk ship's wreck, a jettisoned container,
 *  or a container it plundered (key collect:<id>) — and the matching words. No effect on the work itself. */
export type SalvTarget = 'wreck' | 'drop' | 'plunder';
export const SALV_TARGET_NAME: Record<SalvTarget, string> = { wreck: '전장 잔해 인양', drop: '투하 화물 회수', plunder: '약탈품 회수 중' };
export const DROP_PHASE: Record<SalvState['phase'], string> = { transit: '화물로 이동', work: '회수 중', unload: '회수품 하역 중', return: '구역 복귀', hold: '구역 대기', blocked: '작업 불가', done: '완료' };
export function salvTarget(st: { drops?: Record<string, unknown> }, S: Pick<SalvState, 'wreck' | 'key'>): SalvTarget {
  if (S.key?.startsWith('collect:')) return 'plunder';
  // a container keeps its kind after it is emptied and removed (unloading what came out of it): ids `cd_…` (piracy.ts)
  return S.wreck && (st.drops?.[S.wreck] || S.wreck.startsWith('cd_')) ? 'drop' : 'wreck';
}
/** short label of a group's salvage state, used by the fleet panel and the status line */
export function salvLabel(st: { drops?: Record<string, unknown> }, S: SalvState): { head: string; phase: string } {
  const t = salvTarget(st, S);
  if (t === 'plunder') return S.phase === 'unload' ? { head: '회수품 하역 중', phase: '' } : { head: '약탈품 회수 중', phase: DROP_PHASE[S.phase] };
  if (t === 'drop') return { head: S.mode === 'auto' ? '현장 투하 화물 회수' : SALV_TARGET_NAME.drop, phase: DROP_PHASE[S.phase] };
  return { head: S.mode === 'auto' ? '현장 자동 인양' : S.mode === 'zone' ? '구역 잔해 인양' : SALV_TARGET_NAME.wreck, phase: SALV_PHASE[S.phase] };
}

/** may this fleet pick up wreckage on its own right now (op allows it, setting on, nobody hostile) */
function autoAllowed(h: Host, g: WGroup, op: Op, w: SalvSite): boolean {
  if (g.autoSalvage === false || g.fleeing || h.st.companies[g.owner]?.kind !== 'player') return false;
  if (op.k === 'idle') return true;
  if ((op.k === 'defend' || op.k === 'patrol') && dist(op.at, w.pos) <= op.radius) { const ph = h.opOwner(g).opx?.phase; return ph === 'hold' || ph === 'sweep' || ph === 'transit' && false; }
  return false;
}

/**
 * The salvage step of a group (called from runGroup before ordinary behaviour). Returns true when it moved
 * the group's ships this tick (the caller then skips its own behaviour).
 */
export function stepSalvage(h: Host, g: WGroup, ships: WShip[], op: Op, dt: number, c: CommanderDef): boolean {
  const st = h.st; if (!st.salvageV) return false;
  void c;
  // docked ships put recovered goods in the warehouse whenever their order lets them sit at a station
  if (op.k === 'idle' || op.k === 'dock' || op.k === 'return' || op.k === 'recover' || op.k === 'salvzone')
    for (const s of ships) if (s.salvaged && s.state === 'docked' && s.task.k === 'docked' && !s.logisticsJob && !s.cargoWork) { const sta = st.stations[s.task.station]; if (sta && h.canDock(sta, s.owner)) unloadSalvage(h, s, sta); }
  // P13.2: a raid's own collection run (stepCollect) is driven by the raid, not by this step
  if (g.salv?.key.startsWith('collect:') && (op.k === 'plunder' || op.k === 'harass' || op.k === 'raid' || op.k === 'lootTender')) return false;
  const manual = op.k === 'recover' || op.k === 'salvzone';
  const key = opKey(op);
  if (g.salv && (g.salv.mode === 'auto' ? manual : g.salv.key !== key)) delete g.salv;
  if (!manual) return stepAuto(h, g, ships, op, dt);
  const mode = op.k === 'recover' ? 'recover' : 'zone';
  const S = (g.salv ??= { mode, key, phase: 'transit', since: h.time, next: 0 });
  const illegal = !!(op as Extract<Op, { k: 'recover' | 'salvzone' }>).illegal;
  // A-3.2b.1: a hauler on a sale round trip (AUTO-P1.1 rules) flies that trip; the rest of the fleet keeps salvaging
  const trip = ships.filter(s => onSaleTrip(h, g, s));
  for (const s of trip) stepPoolShip(h, s, g, dt, h.cruiseOf(s) * (0.6 + 0.4 * s.hp));
  const work = ships.filter(s => econOf(s).cruise > 0 && !trip.includes(s));
  if (h.time >= S.next) { decide(h, g, work, op as Extract<Op, { k: 'recover' | 'salvzone' }>, S, illegal); S.next = h.time + 1; }
  move(h, g, work, S, illegal, dt, op as Extract<Op, { k: 'recover' | 'salvzone' }>);
  g.status = status(h, g, S, op);
  return true;
}

/** A-3.2b.1: this ship flies its salvage fleet's sale round trip (a logistics job owned by the fleet) */
function onSaleTrip(h: Host, g: WGroup, s: WShip): boolean {
  const j = s.logisticsJob ? h.st.logisticsJobs?.[s.logisticsJob] : undefined;
  return !!j && j.miner === g.id && !!j.salvTrip && j.ship === s.id;
}
/**
 * A-3.2b.1: after a salvage fleet's hauler (hauler role, not a warship, miner or constructor) has unloaded and is
 * docked and empty, it may take one sale round trip of the station's excess stock — the same planner, policy,
 * minimum price, distance and value rules as a mining hauler (procurement.ts planMinerSaleTrip). Only when the
 * ships that stay can still work the current site (or there is none); only stored stock is sold, so goods owed
 * to a salvage contract (handed over on unloading, never stored) cannot leave on it.
 */
function trySaleTrip(h: Host, g: WGroup, s: WShip, ships: WShip[], sta: Station, S: SalvState, illegal: boolean): boolean {
  if (s.classId !== 'hauler' || econOf(s).military || salvageAboard(s) || cargoSum(s.cargo) > 1e-9 || s.logisticsJob || s.cargoWork) return false;
  const others = ships.filter(x => x !== s && econOf(x).cruise > 0);
  const w = siteOf(h.st, S.wreck);
  if (w && !workable(h, others, w, illegal)) return false;
  if (!others.length && w) return false;
  return planMinerSaleTrip(h, s, sta, true);
}

function setPhase(h: Host, S: SalvState, phase: SalvState['phase'], why?: string) { if (S.phase !== phase) { S.phase = phase; S.since = h.time; } S.why = why; }

function decide(h: Host, g: WGroup, ships: WShip[], op: Extract<Op, { k: 'recover' | 'salvzone' }>, S: SalvState, illegal: boolean) {
  const st = h.st, center = h.groupCenter(g) ?? ships[0]?.pos;
  if (!center || !ships.length) return;
  const loaded = ships.some(salvageAboard);
  const room = ships.reduce((a, s) => a + salvageRoom(h, s), 0);
  if (S.phase === 'unload') {
    // stay on the unloading run until everything recovered is in a warehouse (or the station is full)
    if (loaded) {
      const sta = S.station ? st.stations[S.station] : null;
      if (sta && h.canDock(sta, g.owner) && !S.nounload && unloadRisk(h, g.owner, center, sta, ships) <= 0) return;
      const skip = { risky: 0 };
      const next = S.nounload ? null : pickStation(h, g, ships, center, S.ignore, skip);
      if (next) { S.station = next.id; return; }
      S.station = undefined;
      blockUnload(h, g, S, skip); return;
    }
    S.station = undefined;
    setPhase(h, S, 'return');
  }
  let target: SalvSite | undefined;
  if (op.k === 'recover') {
    target = siteOf(st, op.wreck);
    if (!target || !workable(h, ships, target, illegal)) {
      if (loaded && !S.nounload) { const skip = { risky: 0 }; const sta = pickStation(h, g, ships, center, S.ignore, skip); if (sta) { S.station = sta.id; setPhase(h, S, 'unload'); return; } if (skip.risky > 0) { blockUnload(h, g, S, skip); return; } }
      finish(h, g, S, !target ? '잔해가 소멸했거나 모두 회수되었습니다' : '이 함대가 회수할 수 있는 물품이 남지 않았습니다');
      return;
    }
  } else {
    const ign = S.ignore ?? {};
    let best = -Infinity;
    for (const w of allSites(st)) {
      if ((ign[w.id] ?? 0) > h.time || dist(w.pos, op.at) > op.radius + 400) continue;
      if (!workable(h, ships, w, illegal)) continue;
      const p = prospect(h, ships, w, illegal); if (p.value <= 0) continue;
      const travel = h.routeDistance(center, w.pos) / Math.max(50, h.groupSpeedOf(g));
      const risk = hostileNear(h, g.owner, w.pos, SALV.hostileR * (h.st.officerV ? 1 + (groupFx(h.st, g).salvRisk ?? 0) : 1)) ? 0.2 : 1;
      const left = w.expires - h.time; if (left < travel + 30) continue;
      const score = p.value / (travel + p.time + 30) * risk;
      if (score > best) { best = score; target = w; }
    }
    const cur = siteOf(st, S.wreck);
    if (target && cur && cur.id !== target.id && workable(h, ships, cur, illegal) && S.phase === 'work') target = cur;   // finish the current one first
  }
  if (target && room >= 1 || target && target.lots.some(l => l.k === 'frag' && l.n >= 1 && ships.some(s => salvageRate(h, s, 'frag') > 0))) {
    S.wreck = target.id;
    const near = ships.some(s => dist(s.pos, target!.pos) <= SALV.reach);
    setPhase(h, S, near ? 'work' : (S.phase === 'return' ? 'return' : 'transit'));
    return;
  }
  if (loaded && S.nounload) { finish(h, g, S, '화물칸이 가득 찼습니다'); return; }
  if (loaded) { const skip = { risky: 0 }; const sta = pickStation(h, g, ships, center, S.ignore, skip); if (sta) { S.station = sta.id; setPhase(h, S, 'unload'); } else blockUnload(h, g, S, skip); return; }
  if (op.k === 'salvzone') { S.wreck = undefined; setPhase(h, S, 'hold', '구역에 회수 가능한 잔해가 없습니다 — 새 잔해를 기다립니다'); return; }
  setPhase(h, S, 'blocked', '화물칸이 가득 찼고 하역할 화물이 없습니다');
}

function finish(h: Host, g: WGroup, S: SalvState, why: string) {
  setPhase(h, S, 'done', why);
  // a collection run for a raid (P13.2) ends quietly: the raid decides what comes next
  if (S.key.startsWith('collect:')) { delete g.salv; return; }
  h.say(g, `인양 완료 — ${why}. 대기합니다.`, 'info', 0);
  if (g.override || !g.parentId) { g.op = { k: 'idle' }; g.override = !!g.parentId; }
  delete g.salv;
  g.status = `인양 완료 — ${why}`;
}

function move(h: Host, g: WGroup, ships: WShip[], S: SalvState, illegal: boolean, dt: number, op?: Extract<Op, { k: 'recover' | 'salvzone' }>) {
  const st = h.st, speed = h.groupSpeedOf(g);
  if (S.phase === 'unload') {
    const sta = S.station ? st.stations[S.station] : null; if (!sta) return;
    let moved = 0, docked = 0;
    for (const s of ships) {
      if (!h.goDock(s, sta, dt, speed)) continue;
      docked++; const got = unloadSalvage(h, s, sta); moved += got;
      // like a mining hauler: planned once, right after it has unloaded everything
      if (op && got > 0 && trySaleTrip(h, g, s, ships, sta, S, illegal)) docked--;
    }
    // a full warehouse: try another station next time
    if (docked === ships.length && !moved && ships.some(salvageAboard) && ships.every(s => !s.salvaged || Object.keys(s.salvaged).every(k => h.intakeRoom(sta, s.owner, k) <= 1e-9))) {
      (S.ignore ??= {})[sta.id] = h.time + SALV.ignoreFor; S.station = undefined;
    }
    return;
  }
  const w = siteOf(st, S.wreck);
  if ((S.phase === 'transit' || S.phase === 'work' || S.phase === 'return') && w) {
    for (const s of ships) {
      const slot = h.formationSlot(s, g, w.pos, 110);
      if (dist(s.pos, w.pos) > SALV.reach) { h.moveTo(s, slot, speed, dt, 40); continue; }
      if (dist(s.pos, slot) > 30) h.moveTo(s, slot, speed * 0.5, dt, 30); else { s.vel.x *= 0.8; s.vel.z *= 0.8; }
      workShip(h, s, w, illegal, dt);
    }
    if (S.phase !== 'work' && ships.some(s => dist(s.pos, w.pos) <= SALV.reach)) setPhase(h, S, 'work');
    return;
  }
  if (S.phase === 'hold') {
    const op = h.opOf(g); const at = op.k === 'salvzone' ? op.at : null;
    for (const s of ships) { if (at) h.moveTo(s, h.formationSlot(s, g, at, 120), speed, dt, 60); else if (s.state === 'space') { s.vel.x *= 0.9; s.vel.z *= 0.9; } }
  }
}

function status(h: Host, g: WGroup, S: SalvState, op: Op): string {
  const w = siteOf(h.st, S.wreck);
  const sta = S.station ? h.st.stations[S.station] : undefined;
  const ships = h.shipsOf(g), room = ships.reduce((a, s) => a + salvageRoom(h, s), 0), hold = ships.reduce((a, s) => a + salvageHold(h, s), 0);
  const fill = hold > 0 ? ` · 화물칸 ${Math.round((1 - room / hold) * 100)}%` : '';
  const L = salvLabel(h.st, S), head = L.head, plunder = salvTarget(h.st, S) === 'plunder';
  void MODE_NAME;
  switch (S.phase) {
    case 'transit': case 'return': return `${head}: ${L.phase} — ${w?.name ?? ''}${fill}`;
    case 'work': return `${head}: ${L.phase} — ${w?.name ?? ''} (잔여 ${Math.round(w ? w.lots.reduce((a, l) => a + l.n, 0) : 0)})${fill}${room < 1 ? ' · 화물칸 부족' : ''}`;
    case 'unload': return `${head}${plunder ? ' — ' : ': '}${sta && ships.some(s => s.state === 'docked') ? `${sta.name} 정박·하역 중` : `하역하러 이동 — ${sta?.name ?? ''}`}`;
    case 'hold': return `${head}: ${S.why ?? '구역 대기'}`;
    case 'blocked': return `${head}: 작업 불가 — ${S.why ?? ''}`;
    default: void op; return `${head}: ${S.why ?? '완료'}`;
  }
}

/** automatic on-site pickup after a battle: short, close, legal, safe; never overrides an order */
function stepAuto(h: Host, g: WGroup, ships: WShip[], op: Op, dt: number): boolean {
  const st = h.st;
  // B-1 salvage officer: wider on-site search and longer work; a wider hostile watch while working
  const ofx = st.officerV ? groupFx(st, g) : undefined;
  const reachMul = 1 + (ofx?.salvRange ?? 0), riskMul = 1 + (ofx?.salvRisk ?? 0);
  const mobile = ships.filter(s => s.state === 'space' && econOf(s).cruise > 0 && !s.logisticsJob && !s.cargoWork);
  let S = g.salv;
  if (!S) {
    if ((!st.wrecks && !st.drops) || !mobile.length) return false;
    const any = g as unknown as { _autoNext?: number };
    if ((any._autoNext ?? 0) > h.time) return false;
    any._autoNext = h.time + SALV.autoCheck;
    const center = h.groupCenter(g); if (!center) return false;
    let best: SalvSite | undefined, bd = Infinity;
    for (const w of allSites(st)) {
      const d = dist(w.pos, center); if (d > SALV.autoRange * reachMul || d >= bd) continue;
      if (!autoAllowed(h, g, op, w) || !workable(h, mobile, w, false)) continue;
      best = w; bd = d;
    }
    if (!best || hostileNear(h, g.owner, best.pos, SALV.hostileR)) return false;
    S = g.salv = { mode: 'auto', key: opKey(op), phase: 'transit', wreck: best.id, since: h.time, next: 0, until: h.time + SALV.autoTime * reachMul, anchor: center };
    h.say(g, `${best.name} 회수 가능 — 현장 자동 인양 (최대 ${Math.round(SALV.autoTime * reachMul / 60)}분)`, 'radio', 0);
  }
  if (S.phase === 'unload') {
    // after an on-site pickup an idle fleet takes what it recovered to a warehouse; any order takes over
    const loaded = mobileOrDocked(ships).some(salvageAboard);
    if (op.k !== 'idle' || !loaded) { delete g.salv; return false; }
    if (h.time >= S.next) { S.next = h.time + 1; const sta = S.station ? st.stations[S.station] : null; const at = h.groupCenter(g) ?? ships[0].pos; if (!sta || !h.canDock(sta, g.owner) || unloadRisk(h, g.owner, at, sta, ships) > 0) { const skip = { risky: 0 }; const nx = pickStation(h, g, ships, at, S.ignore, skip); if (!nx) { if (skip.risky > 0) warnNoSafeUnload(h, g); delete g.salv; return false; } S.station = nx.id; } }
    move(h, g, mobileOrDocked(ships), S, false, dt);
    g.status = status(h, g, S, op);
    return true;
  }
  const w = siteOf(st, S.wreck);
  const why = !w ? '잔해 소멸' : !autoAllowed(h, g, op, w) ? '명령 변경' : h.time > (S.until ?? 0) ? '작업 시간 초과' : !workable(h, mobile, w, false) ? (mobile.some(s => salvageRoom(h, s) >= 1) ? '회수 가능한 물품 없음' : '화물칸 부족')
    : S.anchor && dist(w.pos, S.anchor) > SALV.autoRange * reachMul + 500 ? '거리 초과' : (h.time >= S.next && hostileNear(h, g.owner, w.pos, SALV.hostileR * riskMul)) ? '적대 함대 접근' : '';
  if (why) {
    delete g.salv;
    const got = Object.entries(mobile.reduce((acc: Cargo, s) => { for (const [k, n] of Object.entries(s.salvaged ?? {})) acc[k] = (acc[k] ?? 0) + n; return acc; }, {}));
    h.say(g, `현장 인양 종료 (${why})${got.length ? ` — 적재: ${got.map(([k, n]) => `${itemLabel(k)} ${Math.round(n)}`).join(', ')}` : ''}`, 'radio', 0);
    // an idle fleet (no order, no threat) carries what it picked up to the nearest warehouse
    if (got.length && op.k === 'idle' && why !== '적대 함대 접근') {
      const skip = { risky: 0 };
      const sta = pickStation(h, g, mobile, h.groupCenter(g) ?? mobile[0].pos, {}, skip);
      if (!sta && skip.risky > 0) warnNoSafeUnload(h, g);
      if (sta) { g.salv = { mode: 'auto', key: opKey(op), phase: 'unload', station: sta.id, wreck: S.wreck, since: h.time, next: h.time + 1 }; g.status = status(h, g, g.salv, op); }
    }
    return false;
  }
  if (h.time >= S.next) S.next = h.time + 1;
  move(h, g, mobile, S, false, dt);
  g.status = status(h, g, S, op);
  return true;
}

/** validate a recover / salvzone order (null = ok) */
export function validateSalvage(h: Host, company: string, ships: WShip[], op: Op): string | null {
  if (!h.st.salvageV) return '이 월드에서는 전장 잔해 인양을 사용할 수 없습니다';
  if (!ships.length) return '함선이 없는 편대입니다';
  const can = ships.filter(s => econOf(s).cruise > 0 && salvageHold(h, s) > 0);
  if (!can.length) return '인양물을 실을 함선이 없습니다';
  if (op.k === 'recover') {
    const w = siteOf(h.st, op.wreck);
    if (!w) return '잔해가 없거나 이미 소멸했습니다';
    if (!can.some(s => (['cargo', 'equip', 'hull', 'frag'] as const).some(k => salvageRate(h, s, k) > 0 && w.lots.some(l => l.k === k && l.n >= 1 && (op.illegal || !protectedLot(h, company, l))))))
      return w.seen.includes(company) ? '이 편대가 회수할 수 있는 물품이 없습니다 (선체 해체는 채굴선·공작선, 장비는 공작선)' : null;
    return null;
  }
  if (op.k === 'salvzone') {
    if (!(op.radius >= 500 && op.radius <= 30000)) return '작업 반경은 500~30000m';
    if (!h.sysOf(op.at)) return '성계 안의 좌표를 지정하세요';
    return null;
  }
  return null;
}

/**
 * P13.2: one collection run at a site (a raid's jettisoned cargo or its victim's wreck) with the same
 * engine as a recover order — approach, work into the real holds, and (unless `nounload`) unload at a
 * station when full. Returns the phase it is in, or 'done' when nothing more can be taken here.
 */
export function stepCollect(h: Host, g: WGroup, ships: WShip[], siteId: string, illegal: boolean, dt: number, nounload = false): SalvState['phase'] {
  const key = `collect:${siteId}`;
  if (g.salv && g.salv.key !== key) delete g.salv;
  const S = (g.salv ??= { mode: 'recover', key, phase: 'transit', since: h.time, next: 0, ...(nounload ? { nounload: true as const } : {}) });
  const op = { k: 'recover', wreck: siteId, ...(illegal ? { illegal: true } : {}) } as Extract<Op, { k: 'recover' }>;
  const work = ships.filter(s => econOf(s).cruise > 0);
  if (h.time >= S.next) { decide(h, g, work, op, S, illegal); S.next = h.time + 1; }
  if (g.salv !== S) return 'done';
  move(h, g, work, S, illegal, dt);
  g.status = status(h, g, S, op);
  return S.phase;
}
/** can these ships take anything (legally, or with `illegal`) from this site now */
export function canCollect(h: Host, ships: WShip[], siteId: string, illegal: boolean): boolean {
  const w = siteOf(h.st, siteId); return !!w && workable(h, ships.filter(s => econOf(s).cruise > 0), w, illegal);
}
