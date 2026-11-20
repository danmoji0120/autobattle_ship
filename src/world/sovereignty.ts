// B-3 system sovereignty, effective control and territory war.
//
// A company never becomes sovereign of a star system by building a station or by paying. Sovereignty is the
// end of a long chain of real achievements, measured by the world every minute:
//
//   economy        — net assets, liquidity (the lowest cash balance of recent hours, so a borrowed / moved-in sum
//                    for a moment does not pass), operating revenue booked in the last hours, no arrears
//   infrastructure — an own operating station of the region's size with a governance seat (built through the normal
//                    construction queue), power online, storage, defence batteries
//   logistics      — the governance seat consumes administration goods every hour; the measured inflow into the
//                    sovereign's storage there over a rolling window must cover it (a one-time stockpile ages out)
//   military       — real combat ships (own, or under a B-2 guard contract the claimant posted) present in the
//                    system, with an officer, in good repair, above the region minimum plus the local threat, active
//   effective control — control points (governance seat, stations, gates, pirate lairs) held by armed presence;
//                    the control value moves only a few points per hour, so a large fleet that comes for a moment
//                    gains almost nothing
//   legitimacy     — unowned systems: pioneering; lawless: pacification; NPC faction space: cession treaty or a won
//                    war; another company's territory: transfer agreement or a won war; capitals: war only, and only
//                    when the faction is broken
//   stabilisation  — all of the above held for many hours; a shortfall pauses the progress (several shortfalls decay
//                    it a little) — it is never reset
//
// The legal sovereign is kept here, never in StarSystem.faction (which stays the NPC faction model): when an NPC
// faction cedes a system, the faction simply leaves it. Public, per-viewer data: `StarSystem.terr` (only for systems
// the viewer may see) and `Company.sovx` (the owner's own reports). Everything else in `w.sov` is server-side.
// See docs/B3_TERRITORY.md.
import { addc } from './types';
import type { WorldSim } from './sim';
import type { Company, Contract, Gate, StarSystem, Station, V, WGroup, WorldState, WShip } from './types';
import { econOf, shipWorth } from './hullops';
import { shipValue, MODULES } from './data';
import { dist, hashId, jumps, sysAt } from './geom';
import { effSec } from './security';
import { FACTIONS, standingOf, bumpStanding } from './territory';
import { STATION_SIZES } from './stations';
import { stationSupportOnline } from './production';
import { itemPrice } from './industry';
import { book } from './operations';
import { watchMoney } from './observe';
import { coRelation } from './battleAuth';
import { isMil } from './military';
import { rate, calibOf } from './combatRating';
import { shipLoadout, legacySig } from './fitting';
import { SHIP_CLASSES } from '../sim/data/ships';

type Host = WorldSim;
type Size = 'S' | 'M' | 'L' | 'XL';

// ───────────────────────────────────────────────────────────── tuning (docs/B3_TERRITORY.md §4 — measured, see §9)

export type RegionClass = 'outer' | 'rich' | 'lawless' | 'npc_border' | 'npc_core' | 'capital';
export const CLASS_NAME: Record<RegionClass, string> = { outer: '외곽 미개척', rich: '고가치 성계', lawless: '무법 지대', npc_border: 'NPC 세력 국경', npc_core: 'NPC 세력 핵심', capital: '세력 수도' };
export interface ClassRule { mult: number; station: Size; defense: number; stabH: number; legit: Legit; holdH: number }
export const CLASS: Record<RegionClass, ClassRule> = {
  outer:      { mult: 1.0, station: 'M', defense: 2, stabH: 12, legit: 'pioneer', holdH: 24 },
  rich:       { mult: 1.35, station: 'M', defense: 3, stabH: 14, legit: 'pioneer', holdH: 24 },
  lawless:    { mult: 1.5, station: 'M', defense: 3, stabH: 16, legit: 'pacify', holdH: 24 },
  npc_border: { mult: 1.75, station: 'L', defense: 4, stabH: 18, legit: 'cession', holdH: 24 },
  npc_core:   { mult: 2.2, station: 'L', defense: 5, stabH: 24, legit: 'cession', holdH: 30 },
  capital:    { mult: 3.0, station: 'XL', defense: 6, stabH: 36, legit: 'war', holdH: 36 },
};
export type Legit = 'pioneer' | 'pacify' | 'cession' | 'war' | 'agreement';
export const LEGIT_NAME: Record<Legit, string> = { pioneer: '개척', pacify: '평정', cession: '할양 조약', war: '전쟁 조약', agreement: '이양 합의' };

export const SOV = {
  cycle: 60,
  // economy (× class mult × (1 + extra per territory already held))
  assets: 1_500_000, liquid: 150_000, revenue: 150_000, revWindowH: 12, liqWindowH: 6, perHeld: 0.5,
  // military: recommended ship value (shipValue units: frigate 60, destroyer 80, light cruiser 105, cruiser 140, battlecruiser 220, battleship 300 — 1,200 ≈ 9 cruisers or 20 frigates) × class mult, + threat
  power: 1200, threatMul: 1.2, minHpAvg: 0.6, activeH: 6,
  // control
  ctlUp: 5, ctlDown: 4, ctlNeed: 60, ctlRival: 40, influence: 20, gateR: 4000, stationR: 5000, lairR: 3000, gateMemH: 2,
  // governance seat: administration goods per hour (× class mult); logistics window
  supply: { alloy: 30, chemicals: 20, machinery: 4, electronics: 2 } as Record<string, number>,
  supplyWindowH: 12, supplyMinH: 6, supplyCapMul: 3, supplyShare: 0.8,
  // stabilisation
  decayPerH: 0.03, inactiveH: 48,
  // upkeep per hour
  upAdmin: 1200, upStation: 150, upGate: 100, upJump: 120, upThreat: 10, upPerHeld: 0.15,
  // declaration
  declareFee: 20_000, maxClaims: 2,
  // stability (0..100)
  stabUp: 3, stabMiss: 2, stabArrears: 4,
  disputeH: 24, lapseH: 72, abandonH: 168,
  // pacification
  pacifyH: 6, pirateCtlMax: 10,
  // cession
  cessionStanding: 60, cessionCoreStanding: 75, cessionCtl: 40, cessionPrice: 400_000,
  // war
  warFee: 50_000, noticeH: 4, noticeNpcH: 2, noticeInactiveH: 1, inactiveDays: 7, truceCoolH: 48, anyCoolH: 12, staleH: 72,
  occAtt: 60, occDef: 25, occBreak: 35,
  // permits (24 h) and policies
  permitH: 24, tollMax: 2000, royaltyMax: 0.25, enforce: 150, enforceMine: 300,
} as const;

// ───────────────────────────────────────────────────────────── state

export type SovStatus = 'none' | 'declared' | 'pioneering' | 'established' | 'disputed' | 'occupied';
export const STATUS_NAME: Record<SovStatus, string> = { none: '무주', declared: '선언됨', pioneering: '개척 중', established: '확립', disputed: '분쟁', occupied: '점령' };
export const STAGE_NAME = ['미진출', '진출', '거점', '영향력', '선언', '통치기반', '실효지배', '안정화', '확립'];
export type CondKey = 'econ' | 'infra' | 'logi' | 'mil' | 'ctl' | 'legit' | 'stab';
export const COND_NAME: Record<CondKey, string> = { econ: '경제력', infra: '기반시설', logi: '물류', mil: '군사 통제력', ctl: '실효 지배', legit: '정치적 정당성', stab: '안정화' };
export interface Cond { ok: boolean; v: number; need: number; miss: string[]; fix: string }
export type Report = Record<CondKey, Cond>;

export interface SovPolicy {
  mine: 'free' | 'permit' | 'exclusive' | 'royalty'; royalty: number;
  build: 'free' | 'permit' | 'closed'; buildFee: number;
  pass: 'free' | 'restricted' | 'toll'; toll: number;
  /** strict: wanted companies (P13.4 wanted ≥ 2) are refused passage where the sovereign enforces */
  security: 'standard' | 'strict';
  /** price of a 24 h permit sold to another company (0 = not for sale) */
  price: { mine: number; build: number; pass: number };
}
export const DEFAULT_POLICY = (): SovPolicy => ({ mine: 'free', royalty: 0, build: 'free', buildFee: 0, pass: 'free', toll: 0, security: 'standard', price: { mine: 0, build: 0, pass: 0 } });

export interface SovClaim {
  co: string; at: number;
  /** stabilisation progress (seconds of qualifying time) */
  prog: number;
  /** how this claim is legitimate (set by pioneering, pacification, a treaty or a won war) */
  legit?: Legit;
  /** pacification: seconds without pirate presence */
  pac?: number;
  /** last time the claim made real progress (≥ 4 conditions held) */
  live: number;
  stage: number;
}
export interface SovSys {
  id: string;
  owner?: string; since?: number;
  /** how the owner obtained it */
  how?: Legit;
  claims: Record<string, SovClaim>;
  /** control 0..100 per party (company id, `fac:<faction>`, `pirates`) */
  ctl: Record<string, number>;
  /** control points: last holder and time (gates remember their holder for a while) */
  pts: Record<string, { p: string; t: number }>;
  /** last time each company held a point here with combat ships (recent operations) */
  act: Record<string, number>;
  stab: number;
  policy: SovPolicy;
  permits: { mine: Record<string, number>; build: Record<string, number>; pass: Record<string, number> };
  /** sovereign's unpaid territory upkeep */
  arrears: number;
  /** unpaid royalties per company */
  owed: Record<string, number>;
  /** administration logistics per company (the sovereign and every claimant keep their own seat, stock, measured
   *  inflow, shortage and reservation — one company's shortage never touches another's) */
  gov?: Record<string, GovLog>;
  /** @deprecated pre-split saves: one shared record per system; moved into `gov` on the first cycle (migrateGov) */
  sup?: [number, number, number][];
  /** @deprecated see `sup` */
  stock?: Record<string, number>;
  /** @deprecated see `sup` */
  short?: number;
  /** dispute bookkeeping */
  disputeT?: number;
  /** income / upkeep ledger by hour (last 24) */
  led: { h: number; tax: number; toll: number; permit: number; up: number }[];
  occ?: { by: string; war: string; since: number; held: number };
  /** difficulty class fixed at the start */
  cls?: RegionClass;
  /** an NPC faction agreed to cede the system to this claimant (it leaves when the claimant is established) */
  ceded?: string;
  /** cached derived flags */
  eff?: number;
}
/** one company's administration logistics at its governance seat in one system */
export interface GovLog {
  /** hourly [hour, inflow value-weighted units, demand units] */
  sup: [number, number, number][];
  /** last snapshot of storage + reservation at the seat (for inflow) */
  stock?: Record<string, number>;
  /** consecutive shortage (seconds) */
  short?: number;
  /** inflow counted this hour per item (the hourly counting cap) */
  raw?: { h: number; in: Record<string, number> };
  /** the station whose goods are reserved */
  seat?: string;
  /** administration goods set aside for the next operating cycle: moved out of the seat's free storage (like a
   *  construction reservation), so fleet supply, sales, logistics and production cannot take them; consumed first;
   *  returned to the seat's storage when the governance stops. Never created — only real stock is reserved. */
  res?: Record<string, number>;
  /** last reservation shortfall per item (target − reserved) */
  lack?: Record<string, number>;
}
export interface SovCo {
  /** hourly lowest credits (hour, low) */
  low: [number, number][];
  /** last time this company was online */
  seen: number;
}
export interface SovWar {
  id: string; att: string; def: string; sys: string;
  at: number; start: number; status: 'notice' | 'active' | 'ended';
  end?: { t: number; how: string };
  /** NPC defence fleets deployed for this war: group id → strength equivalent locked in */
  fleets?: Record<string, number>;
  lostAtt?: number; lostDef?: number;
  log: { t: number; txt: string }[];
}
export interface SovTreaty {
  id: string; kind: 'truce' | 'cession' | 'reparations' | 'return' | 'transfer';
  from: string; to: string; sys: string; war?: string; pay: number; at: number;
  status: 'offer' | 'accepted' | 'rejected' | 'expired';
}
export interface SovState {
  sys: Record<string, SovSys>;
  co: Record<string, SovCo>;
  wars: Record<string, SovWar>;
  treaties: Record<string, SovTreaty>;
  /** re-declaration limits: `${att}:${sys}` or `*:${sys}` → time */
  cool: Record<string, number>;
  /** faction strength at enable (capital rule) */
  str0: Record<string, number>;
  /** last faction reinforcement per system */
  reinf: Record<string, number>;
  seq: number;
  /** seconds accumulated toward the next cycle */
  acc?: number;
  /** recent public territory news */
  news: { t: number; txt: string }[];
}
/** what every viewer who can see the system gets (StarSystem.terr) */
export interface TerrPub {
  owner?: string; ownerName?: string; status: SovStatus; how?: Legit;
  claims: { co: string; name: string; stage: number }[];
  top?: { p: string; ctl: number }[];
  war?: { id: string; att: string; def: string; status: SovWar['status'] }[];
  occ?: { by: string; held: number; need: number };
  cls: RegionClass; stab?: number;
  /** the sovereign's public rules (what visitors must obey or buy) */
  pol?: Pick<SovPolicy, 'mine' | 'royalty' | 'build' | 'buildFee' | 'pass' | 'toll' | 'security' | 'price'>;
}
/** the company's own territory reports (Company.sovx) */
export interface SovX {
  t: number;
  rows: SovRow[];
  wars: SovWar[];
  treaties: SovTreaty[];
  alerts: string[];
}
export interface SovRow {
  sys: string; name: string; cls: RegionClass; stage: number; status: SovStatus; owner?: string;
  claim?: { at: number; prog: number; need: number; legit?: Legit };
  rep?: Report; ctl: number; stab?: number; power: number; needPower: number;
  upkeep: number; income: { tax: number; toll: number; permit: number; up: number };
  arrears?: number; policy?: SovPolicy; permits?: SovSys['permits']; supply?: { in: number; need: number; stock: Record<string, number>; demand: Record<string, number>; /** goods set aside for the next cycle, the reservation shortfall, seconds the seat has been stalled */ reserved?: Record<string, number>; lack?: Record<string, number>; stalled?: number };
  facilities?: { gov?: string; station?: string; size?: string; defense: number; power: boolean };
  rivals: { co: string; name: string; ctl: number; stage: number }[];
  occ?: TerrPub['occ'];
}

export const sovOn = (w: Pick<WorldState, 'sovV'>) => w.sovV === 1;
const S = (w: WorldState): SovState => (w.sov ??= { sys: {}, co: {}, wars: {}, treaties: {}, cool: {}, str0: {}, reinf: {}, seq: 1, news: [] });

/** turn sovereignty on (new standard worlds; saves by TERRITORY_B3_MIGRATE) — needs the P10 layout, P11 combat, P12 ops and B-2 */
export function enableTerritory(w: WorldState): { applied: boolean; reason: string } {
  if (w.sovV === 1) return { applied: false, reason: '이미 적용됨' };
  if (!w.factions || w.combatV !== 2 || !w.opsV) return { applied: false, reason: 'P10 성계·P11 전투·P12 작전 월드가 아님' };
  w.sovV = 1;
  const s = S(w);
  for (const [id, f] of Object.entries(w.factions)) s.str0[id] = f.strength;
  for (const sys of Object.values(w.systems)) rec(w, sys.id);
  return { applied: true, reason: '적용' };
}
/** explicit, non-destructive save migration: no system changes hands; NPC factions keep their space */
export const migrateTerritory = enableTerritory;

function rec(w: WorldState, id: string): SovSys {
  const s = S(w);
  let r = s.sys[id];
  if (!r) {
    const sys = w.systems[id];
    const f = sys?.faction;
    r = s.sys[id] = { id, cls: sys ? regionClass(w, sys) : 'outer', claims: {}, ctl: {}, pts: {}, act: {}, stab: 100, policy: DEFAULT_POLICY(), permits: { mine: {}, build: {}, pass: {} }, arrears: 0, owed: {}, gov: {}, led: [] };
    // NPC space starts fully controlled by its faction (pirate space by the pirates)
    if (f) r.ctl[f === 'pirates' ? 'pirates' : 'fac:' + f] = f === 'pirates' ? 70 : 100;
  }
  return r;
}

// ───────────────────────────────────────────────────────────── basic helpers

const isPirate = (w: WorldState, owner: string) => owner === 'pirates' || w.companies[owner]?.kind === 'pirate';
export const facOf = (p: string | undefined) => p?.startsWith('fac:') ? p.slice(4) : undefined;
export const FAC_CO = (f: string) => `fac_${f}`;
/** the party a company acts for: faction defence companies act for their faction */
export function partyOf(w: WorldState, owner: string): string {
  if (isPirate(w, owner)) return 'pirates';
  if (owner.startsWith('fac_')) return 'fac:' + owner.slice(4);
  return owner;
}
export const partyName = (w: WorldState, p: string | undefined) => !p ? '없음' : p === 'pirates' ? '해적' : facOf(p) ? (FACTIONS[facOf(p)!]?.name ?? p) : (w.companies[p]?.name ?? p);
/** the legal sovereign of a system: a company (B-3), else the NPC faction that holds it (P10), else none */
export function legalOf(w: WorldState, sysId: string): string | undefined {
  const o = w.sov?.sys[sysId]?.owner; if (o) return o;
  const f = w.systems[sysId]?.faction;
  return f ? (f === 'pirates' ? undefined : 'fac:' + f) : undefined;
}
export const sovOwner = (w: WorldState, sysId: string | undefined) => sysId ? w.sov?.sys[sysId]?.owner : undefined;

export function regionClass(w: WorldState, sys: StarSystem): RegionClass {
  // the difficulty of a system is fixed when sovereignty starts (a ceded NPC core system stays a hard system)
  const fixed = w.sov?.sys[sys.id]?.cls; if (fixed) return fixed;
  if (sys.region === 'capital') return 'capital';
  if (sys.faction === 'pirates' || sys.region === 'lawless') return 'lawless';
  if (sys.faction) return sys.region === 'industrial' ? 'npc_core' : 'npc_border';
  if (sys.exploration?.tier === 3 || sys.planets.length >= 2) return 'rich';
  return 'outer';
}
const sysOfPos = (w: WorldState, p: V) => sysAt(w.systems, p);
const stationsIn = (h: Host, sysId: string) => Object.values(h.st.stations).filter(x => h.sysOf(x.pos)?.id === sysId);
const builtN = (st: Station, kind: string) => st.modules.filter(m => m.kind === kind && m.built).length;
const sizeRank = (s: string | undefined) => ({ S: 1, M: 2, L: 3, XL: 4 } as Record<string, number>)[s ?? ''] ?? 0;
const hourOf = (t: number) => Math.floor(t / 3600);
const round = (n: number, step = 1000) => Math.round(n / step) * step;
const heldCount = (w: WorldState, co: string) => Object.values(w.sov?.sys ?? {}).filter(r => r.owner === co).length;
/** the company's governance seat in a system: an own station with a built governance facility */
export function govStation(h: Host, co: string, sysId: string): Station | undefined {
  return stationsIn(h, sysId).find(x => x.owner === co && builtN(x, 'governance') > 0);
}
const ownStations = (h: Host, co: string, sysId: string) => stationsIn(h, sysId).filter(x => x.owner === co && !x.public && builtN(x, 'core') > 0);

// ───────────────────────────────────────────────────────────── presence (once per cycle)

interface Unit { pos: V; val: number; g: string; docked: boolean; officer: boolean; hp: number }
type Presence = Map<string, Map<string, Unit[]>>;   // system → party → combat ships
let cache: { t: number; w: WorldState; p: Presence } | null = null;

/** combat ships by system and by the party they fight for: own ships, and ships of a company working a contract
 *  for that party there (B-2 guard contracts; B-3 war contracts) */
export function presence(h: Host): Presence {
  if (cache && cache.w === h.st && cache.t === h.time) return cache.p;
  const w = h.st, out: Presence = new Map();
  const forParty = contractParties(w);
  for (const g of Object.values(w.groups)) {
    if (!g.shipIds.length) continue;
    const off = !!g.commanderId || (!!g.parentId && !!w.groups[g.parentId]?.commanderId);
    for (const id of g.shipIds) {
      const s = w.ships[id]; if (!s || !econOf(s).military || (s.state !== 'space' && s.state !== 'docked' && s.state !== 'battle')) continue;
      if (s.warp?.phase === 'warp') continue;
      // laid-up (reserve) ships and ships still reactivating are not combat-ready: they hold nothing
      if (s.reserve) continue;
      const sys = sysOfPos(w, s.pos); if (!sys) continue;
      // the Union authority's garrisons stand for the faction that holds the system; merchants hold nothing
      const kind = w.companies[s.owner]?.kind;
      const self = s.owner === 'union' ? (sys.faction && sys.faction !== 'pirates' ? 'fac:' + sys.faction : '') : kind === 'guild' ? '' : partyOf(w, s.owner);
      const parties = [...(self ? [self] : []), ...(forParty.get(`${g.id}:${sys.id}`) ?? [])];
      for (const p of parties) {
        let m = out.get(sys.id); if (!m) out.set(sys.id, m = new Map());
        let l = m.get(p); if (!l) m.set(p, l = []);
        l.push({ pos: s.pos, val: shipRating(h, s, g), g: g.id, docked: s.state === 'docked', officer: off, hp: s.hp });
      }
    }
  }
  cache = { t: h.time, w, p: out };
  return out;
}
/** B-3 combat rating of a ship as it would fight now (combatRating.ts, calibrated in real battles): its mounts and
 *  fitting, research and armoury effects (as the battle engine gets them), its group commander's judgement,
 *  speciality and officer effects, × √hull (Lanchester: staying power is linear in hull, the rating is a root),
 *  × supply state (owner's upkeep stage ≥ 2: no resupply or maintenance → 0.85; heavy wear → down to 0.85).
 *  The undamaged rating is cached per ship and refreshed when anything it depends on changes. */
const rcache = new Map<string, { k: string; r: number }>();
export function shipRating(h: Host, s: WShip, g: WGroup): number {
  const c = h.cmdr(g), co = h.st.companies[s.owner];
  const sig = s.fitting?.sig ?? '';
  const key = `${s.classId}|${s.loadoutId}|${sig}|${(s.fit ?? []).join(',')}|${co?.tech?.length ?? 0}|${c.skill.toFixed(3)}|${c.specialty}|${c.ofx ? JSON.stringify(c.ofx) : ''}|${hourOf(h.time)}`;
  let e = rcache.get(s.id);
  if (!e || e.k !== key) {
    const cls = SHIP_CLASSES[s.classId];
    let r = shipValue(s.classId);
    if (cls?.loadouts.length) {
      const custom = !!s.fitting && sig !== legacySig(s.loadoutId, s.fit);
      const lo = s.fitting ? shipLoadout(s) : cls.loadouts.find(l => l.id === s.loadoutId) ?? cls.loadouts[0];
      const fx = co?.kind === 'player' ? h.shipFxOf(s) : undefined;
      r = rate({ cls, lo, fx, skill: c.skill, spec: c.specialty, ofx: c.ofx }).cr * calibOf(s.classId, custom ? undefined : lo.id === s.loadoutId ? s.loadoutId : undefined);
    }
    rcache.set(s.id, e = { k: key, r });
    if (rcache.size > 20000) rcache.clear();
  }
  const supply = co?.kind === 'player' && (co.upkeep?.stage ?? 0) >= 2 ? 0.85 : 1 - 0.15 * Math.max(0, (s.wear ?? 0) - 0.5) * 2;
  return e.r * Math.sqrt(Math.max(0, s.hp)) * supply;
}
/** group:system → parties it works for under a contract (guard: the poster; war contracts: the side that posted) */
function contractParties(w: WorldState): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!w.milV) return m;
  for (const k of Object.values(w.contracts)) {
    if (!isMil(k) || k.done || !k.takenBy || !k.mil.group || !k.mil.poster) continue;
    const t = k.mil.target ?? '';
    const sys = t.startsWith('war:') ? w.sov?.wars[t.split(':')[1]]?.sys : k.mil.type === 'defend' ? k.mil.sys : undefined;
    if (!sys) continue;
    for (const g of subtree(w, k.mil.group)) { const key = `${g}:${sys}`; const l = m.get(key) ?? []; l.push(k.mil.poster); m.set(key, l); }
  }
  return m;
}
function subtree(w: WorldState, gid: string): string[] {
  const g = w.groups[gid]; if (!g) return [];
  return [gid, ...g.childIds.flatMap(c => subtree(w, c))];
}
const sum = (l: Unit[] | undefined, f: (u: Unit) => boolean = () => true) => (l ?? []).reduce((a, u) => a + (f(u) ? u.val : 0), 0);
/** combat value a party has in a system (ships docked at a station there count at 60 %) */
export function powerIn(h: Host, party: string, sysId: string): number {
  const l = presence(h).get(sysId)?.get(party);
  return (l ?? []).reduce((a, u) => a + u.val * (u.docked ? 0.6 : 1), 0);
}
export const near = (l: Unit[] | undefined, p: V, r: number) => (l ?? []).reduce((a, u) => a + (!u.docked && dist(u.pos, p) < r ? u.val : 0), 0);

/** pirate strength in a system and next to it (the local threat a sovereign must answer) */
export function threatOf(h: Host, sysId: string): number {
  const sys = h.st.systems[sysId]; if (!sys) return 0;
  const P = presence(h);
  const here = sum(P.get(sysId)?.get('pirates')), nb = sys.gates.reduce((a, g) => a + sum(P.get(g.to)?.get('pirates')), 0) / Math.max(1, sys.gates.length);
  const lairs = Object.values(h.st.lairs).filter(l => l.alive && h.sysOf(l.pos)?.id === sysId).length;
  return Math.round(here + nb * 0.5 + lairs * 250);
}

// ───────────────────────────────────────────────────────────── war relations (used by combat detection)

/** parties at war in a system: attacker side vs defender side (with their contractors) */
export function warSides(w: WorldState, war: SovWar): [Set<string>, Set<string>] {
  const a = new Set([war.att]), d = new Set([war.def]);
  if (w.milV) for (const k of Object.values(w.contracts)) {
    if (!isMil(k) || k.done || !k.takenBy || !k.mil.poster) continue;
    const t = k.mil.target ?? '';
    const isWar = t.startsWith('war:') && t.split(':')[1] === war.id;
    const isGuard = k.mil.type === 'defend' && k.mil.sys === war.sys;
    if (!isWar && !isGuard) continue;
    if (k.mil.poster === war.att) a.add(k.takenBy); else if (k.mil.poster === war.def || partyOf(w, k.mil.poster) === war.def) d.add(k.takenBy);
  }
  return [a, d];
}
/** are companies a and b enemies in this system because of a formal territory war (or a contract inside one)? */
export function sovWarHostile(w: WorldState, a: string, b: string, sysId: string | undefined): boolean {
  if (!w.sovV || !sysId || !w.sov) return false;
  const pa = partyOf(w, a), pb = partyOf(w, b);
  for (const war of Object.values(w.sov.wars)) {
    if (war.status !== 'active' || war.sys !== sysId) continue;
    const [A, D] = warSides(w, war);
    if ((A.has(pa) || A.has(a)) && (D.has(pb) || D.has(b))) return true;
    if ((A.has(pb) || A.has(b)) && (D.has(pa) || D.has(a))) return true;
  }
  return false;
}
/** relation with a system: war hostility on top of the stance relation */
export function relIn(w: WorldState, a: string, b: string, sysId: string | undefined) {
  const r = coRelation(w, a, b);
  return r !== -1 && sovWarHostile(w, a, b, sysId) ? -1 : r;
}

// ───────────────────────────────────────────────────────────── control points and the control value

interface Pt { id: string; pos: V; r: number; w: number; base?: string; def: number; name: string }
/** the places that decide who controls a system */
export function points(h: Host, sysId: string): Pt[] {
  const w = h.st, sys = w.systems[sysId]; if (!sys) return [];
  const out: Pt[] = [];
  const fac = sys.faction && sys.faction !== 'pirates' && !w.sov?.sys[sysId]?.ceded ? 'fac:' + sys.faction : undefined;
  if (fac) out.push({ id: 'adm', pos: sys.origin, r: sys.radius, w: 2, base: fac, def: 300 + Math.min(1500, (w.factions?.[sys.faction!]?.strength ?? 0) * 12) * (sys.region === 'capital' ? 2 : sys.region === 'industrial' ? 1.4 : 1), name: `${FACTIONS[sys.faction!]?.name ?? ''} 행정권` });
  for (const st of stationsIn(h, sysId)) {
    if (!st.public && !builtN(st, 'core')) continue;
    // a governance seat without administration goods for over an hour is a building, not a government
    const gov = !st.public && builtN(st, 'governance') > 0 && (w.sov?.sys[sysId]?.gov?.[st.owner]?.short ?? 0) < 3600;
    const base = st.public ? fac : st.owner;
    const def = st.public ? (base ? (st.garrison ?? 0) * 400 + 200 : 0) : (stationSupportOnline(st) ? builtN(st, 'defense') * 300 * st.defenseHp : 0);
    out.push({ id: 'st:' + st.id, pos: st.pos, r: SOV.stationR, w: gov ? 3 : st.public ? (base ? 2 : 1) : 2, base, def, name: st.name });
  }
  for (const g of sys.gates) out.push({ id: 'gt:' + g.id, pos: g.pos, r: SOV.gateR, w: 1, def: 0, name: g.name });
  for (const l of Object.values(w.lairs)) if (l.alive && h.sysOf(l.pos)?.id === sysId) out.push({ id: 'lr:' + l.id, pos: l.pos, r: SOV.lairR, w: 2, base: 'pirates', def: 600 * l.hp, name: l.name });
  return out;
}
const coOfParty = (p: string) => facOf(p) ? FAC_CO(facOf(p)!) : p;
/** may party q take a point held by party p? (pirates against everyone; others only in a formal war there) */
function enemies(w: WorldState, p: string, q: string, sysId: string) {
  if (p === q) return false;
  if ((p === 'pirates') !== (q === 'pirates')) return true;
  return sovWarHostile(w, coOfParty(p), coOfParty(q), sysId);
}
/** who holds each point now */
export function holders(h: Host, sysId: string): { pt: Pt; p?: string }[] {
  const w = h.st, r = rec(w, sysId), P = presence(h).get(sysId) ?? new Map<string, Unit[]>();
  const res: { pt: Pt; p?: string }[] = [];
  for (const pt of points(h, sysId)) {
    const nearBy = [...P.entries()].map(([p, l]) => [p, near(l, pt.pos, pt.r)] as [string, number]).filter(x => x[1] > 0);
    let holder: string | undefined;
    if (pt.base) {
      const mine = (nearBy.find(x => x[0] === pt.base)?.[1] ?? 0) + pt.def;
      const foe = nearBy.filter(x => enemies(w, pt.base!, x[0], sysId)).sort((a, b) => b[1] - a[1])[0];
      holder = foe && foe[1] >= Math.max(100, mine * 1.2) ? foe[0] : pt.base;
      if (holder !== pt.base) r.pts[pt.id] = { p: holder, t: h.time };
    } else {
      const top = nearBy.sort((a, b) => b[1] - a[1])[0];
      const prev = r.pts[pt.id];
      if (top && top[1] >= 60) { holder = top[0]; r.pts[pt.id] = { p: holder, t: h.time }; }
      else if (prev && h.time - prev.t < SOV.gateMemH * 3600) holder = prev.p;
    }
    if (holder && w.companies[holder]?.kind === 'player' && nearBy.some(x => x[0] === holder)) r.act[holder] = h.time;
    res.push({ pt, p: holder });
  }
  return res;
}
/** move every party's control toward its share of the held points (a few points per hour, never a jump) */
function stepControl(h: Host, r: SovSys, dt: number) {
  const hs = holders(h, r.id);
  const tot = hs.reduce((a, x) => a + x.pt.w, 0) || 1;
  const share = new Map<string, number>();
  for (const x of hs) if (x.p) share.set(x.p, (share.get(x.p) ?? 0) + x.pt.w / tot);
  const parties = new Set([...Object.keys(r.ctl), ...share.keys()]);
  for (const p of parties) {
    const cur = r.ctl[p] ?? 0, target = (share.get(p) ?? 0) * 100;
    let rate = target > cur ? SOV.ctlUp : SOV.ctlDown;
    // a collapsing sovereign loses its grip faster
    if (p === r.owner && r.stab < 15 && target <= cur) rate += 3;
    const step = rate * dt / 3600;
    const nv = target > cur ? Math.min(target, cur + step) : Math.max(target, cur - step);
    if (nv <= 0.05 && target === 0) delete r.ctl[p]; else r.ctl[p] = nv;
  }
  return hs;
}

// ───────────────────────────────────────────────────────────── economy measurement

const REVENUE = ['sales', 'mil_contract', 'bounty', 'sov_tax', 'sov_toll', 'sov_permit'];
function sampleCredits(h: Host) {
  const s = S(h.st), hr = hourOf(h.time);
  for (const co of Object.values(h.st.companies)) {
    if (co.kind !== 'player') continue;
    const c = (s.co[co.id] ??= { low: [], seen: co.online ? h.time : co.createdAt ?? 0 });
    if (co.online) c.seen = h.time;
    const last = c.low.at(-1);
    if (last && last[0] === hr) last[1] = Math.min(last[1], co.credits);
    else { c.low.push([hr, co.credits]); if (c.low.length > 24) c.low.splice(0, c.low.length - 24); }
  }
}
/** lowest cash of the last hours (a balance moved in for a moment does not count) */
export function liquidity(w: WorldState, co: string, now: number): number {
  const c = w.sov?.co[co], hr = hourOf(now); const cr = w.companies[co]?.credits ?? 0;
  const xs = (c?.low ?? []).filter(x => x[0] > hr - SOV.liqWindowH).map(x => x[1]);
  // a company measured for less than the window: the missing hours count as nothing in hand
  const known = new Set((c?.low ?? []).filter(x => x[0] > hr - SOV.liqWindowH).map(x => x[0])).size;
  return known < SOV.liqWindowH ? 0 : Math.min(cr, ...xs);
}
/** operating revenue booked in the last hours: sales, military contracts, bounties, territory income */
export function revenue(w: WorldState, co: string, now: number, hours: number = SOV.revWindowH): number {
  const led = w.companies[co]?.ops?.ledger ?? [], hr = hourOf(now);
  return led.filter(b => b.h > hr - hours).reduce((a, b) => a + REVENUE.reduce((x, k) => x + (b.inc[k] ?? 0), 0), 0);
}
/** what the company really owns: cash, stations and facilities at construction cost, ships, goods — minus debts */
export function netAssets(h: Host, co: string): number {
  const w = h.st, c = w.companies[co]; if (!c) return 0;
  let v = c.credits - (c.upkeep?.debt ?? 0);
  for (const r of Object.values(w.sov?.sys ?? {})) if (r.owner === co) v -= r.arrears;
  for (const st of Object.values(w.stations)) {
    if (st.owner === co && !st.public) {
      v += STATION_SIZES[(st.size ?? 'S') as Size]?.credits ?? 0;
      for (const m of st.modules) if (m.built && m.kind !== 'core') v += MODULES[m.kind]?.credits ?? 0;
    }
    const sto = st.storage[co]; if (sto) for (const [k, n] of Object.entries(sto)) if (n > 0) v += n * itemPrice(k);
  }
  for (const s of Object.values(w.ships)) if (s.owner === co) v += shipWorth(w, s) * (0.5 + 0.5 * s.hp);
  return Math.round(v);
}

// ───────────────────────────────────────────────────────────── logistics at the governance seat

export const supplyNeed = (cls: RegionClass) => Object.fromEntries(Object.entries(SOV.supply).map(([k, n]) => [k, n * CLASS[cls].mult]));
const valueOfCargo = (c: Record<string, number>) => Object.entries(c).reduce((a, [k, n]) => a + n * itemPrice(k), 0);
/** a company's administration logistics record in a system (created on first use) */
export function govLog(r: SovSys, co: string): GovLog { const g = (r.gov ??= {}); return (g[co] ??= { sup: [] }); }
/** pre-split saves kept one shared record per system: it belonged to the sovereign (or the only claimant) */
function migrateGov(r: SovSys) {
  if (!r.sup && r.stock === undefined && r.short === undefined && !(r as any).raw) return;
  const who = r.owner ?? (Object.keys(r.claims).length === 1 ? Object.keys(r.claims)[0] : undefined);
  if (who && !r.gov?.[who]) { const g = govLog(r, who); g.sup = r.sup ?? []; if (r.stock) g.stock = r.stock; if (r.short) g.short = r.short; if ((r as any).raw) g.raw = (r as any).raw; }
  delete r.sup; delete r.stock; delete r.short; delete (r as any).raw;
}
/** goods reserved for the next operating cycle (hours of need) */
const RESERVE_H = 1;
/** give a reservation back to the seat's storage (governance stopped, seat moved, claim ended) */
function releaseRes(h: Host, g: GovLog, co: string) {
  const st = g.seat ? h.st.stations[g.seat] : undefined;
  if (st && g.res) { const sto = (st.storage[co] ??= {}); for (const [k, n] of Object.entries(g.res)) if (n > 0) addc(sto, k, n); }
  delete g.res; delete g.lack; delete g.seat;
}
/** consume administration goods for this cycle (reservation first), measure the inflow since the last cycle, and
 *  reserve the next cycle's goods from free stock */
function stepSupply(h: Host, r: SovSys, co: string, G: Station, cls: RegionClass, dt: number) {
  const L = govLog(r, co);
  if (L.seat && L.seat !== G.id) releaseRes(h, L, co);
  L.seat = G.id;
  const need = supplyNeed(cls), sto = (G.storage[co] ??= {}), res = (L.res ??= {});
  const hr = hourOf(h.time);
  let b = L.sup.at(-1); if (!b || b[0] !== hr) { b = [hr, 0, 0]; L.sup.push(b); if (L.sup.length > SOV.supplyWindowH + 1) L.sup.splice(0, L.sup.length - SOV.supplyWindowH - 1); }
  const prev = L.stock ?? {};
  let short = false, inV = 0, needV = 0;
  const raw = (L.raw ??= { h: hr, in: {} });
  if (raw.h !== hr) { raw.h = hr; raw.in = {}; }
  const lack: Record<string, number> = {};
  for (const [k, perH] of Object.entries(need)) {
    const want = perH * dt / 3600;
    // consume: the reservation first, then free stock
    const fromRes = Math.min(res[k] ?? 0, want), fromSto = Math.min(sto[k] ?? 0, want - fromRes), took = fromRes + fromSto;
    if (took < want - 1e-6) short = true;
    res[k] = (res[k] ?? 0) - fromRes;
    if (fromSto > 0) { sto[k] = (sto[k] ?? 0) - fromSto; if (sto[k] < 1e-9) delete sto[k]; }
    // inflow on storage + reservation (moving goods into the reservation is not inflow)
    const now = (sto[k] ?? 0) + res[k], before = prev[k];
    const inflow = before === undefined ? 0 : Math.max(0, now - (before - took));
    // a big delivery counts for at most a few hours of need in the hour it arrived (stockpiling does not carry the window)
    const cap = perH * SOV.supplyCapMul, already = raw.in[k] ?? 0, counted = Math.max(0, Math.min(inflow, cap - already));
    raw.in[k] = already + counted;
    inV += counted * itemPrice(k); needV += want * itemPrice(k);
    // reserve the next cycle from free stock (only what is really there)
    const target = perH * RESERVE_H, top = Math.min(sto[k] ?? 0, Math.max(0, target - res[k]));
    if (top > 0) { sto[k] -= top; if (sto[k] < 1e-9) delete sto[k]; res[k] += top; }
    if (res[k] < 1e-9) delete res[k];
    if (target - (res[k] ?? 0) > 1e-6) lack[k] = target - (res[k] ?? 0);
  }
  b[1] += inV; b[2] += needV;
  L.stock = Object.fromEntries(Object.keys(need).map(k => [k, (sto[k] ?? 0) + (res[k] ?? 0)]));
  L.lack = Object.keys(lack).length ? lack : undefined;
  if (!L.lack) delete L.lack;
  L.short = short ? (L.short ?? 0) + dt : 0;
}
/** goods a company's governance reservations hold at a station (they keep their warehouse space) */
export function govReservedSpace(w: WorldState, station: string, co: string): number {
  let n = 0;
  for (const r of Object.values(w.sov?.sys ?? {})) { const g = r.gov?.[co]; if (g?.seat === station && g.res) for (const v of Object.values(g.res)) n += v; }
  return n;
}
export function supplyStats(r: SovSys, co: string, now: number) {
  const hr = hourOf(now), win = (r.gov?.[co]?.sup ?? []).filter(x => x[0] > hr - SOV.supplyWindowH);
  const inV = win.reduce((a, x) => a + x[1], 0), needV = win.reduce((a, x) => a + x[2], 0);
  return { hours: win.length, inV, needV, ratio: needV > 0 ? inV / needV : 0 };
}

// ───────────────────────────────────────────────────────────── the seven conditions

const C = (ok: boolean, v: number, need: number, miss: string[], fix: string): Cond => ({ ok, v: Math.round(v * 100) / 100, need: Math.round(need * 100) / 100, miss, fix });
const cr = (n: number) => Math.round(n).toLocaleString();
/** territory upkeep per hour for this company in this system (also the estimate shown before establishment) */
export function upkeepOf(h: Host, co: string, sysId: string): number {
  const w = h.st, sys = w.systems[sysId], c = w.companies[co]; if (!sys || !c) return 0;
  const cls = regionClass(w, sys), home = c.homeStation && w.stations[c.homeStation] ? h.sysOf(w.stations[c.homeStation].pos)?.id : undefined;
  const j = home ? Math.min(12, Math.max(0, jumps(w.systems, home, sysId))) : 6;
  const held = Math.max(0, heldCount(w, co) - (w.sov?.sys[sysId]?.owner === co ? 1 : 0));
  const base = SOV.upAdmin * CLASS[cls].mult + SOV.upStation * ownStations(h, co, sysId).length + SOV.upGate * sys.gates.length + SOV.upJump * (Number.isFinite(j) ? j : 6) + SOV.upThreat * (100 - effSec(sys));
  return Math.round(base * (1 + SOV.upPerHeld * held));
}
/** military strength a claimant / sovereign needs in the system */
export function powerNeed(h: Host, co: string, sysId: string): number {
  const w = h.st, sys = w.systems[sysId]; if (!sys) return 0;
  const cls = regionClass(w, sys);
  let enemy = 0;
  for (const war of Object.values(w.sov?.wars ?? {})) if (war.status === 'active' && war.sys === sysId && (war.att === co || war.def === co)) enemy += powerIn(h, war.att === co ? war.def : war.att, sysId);
  return Math.round(SOV.power * CLASS[cls].mult + threatOf(h, sysId) * SOV.threatMul + enemy);
}

export function evaluate(h: Host, co: string, sysId: string): Report {
  const w = h.st, sys = w.systems[sysId], r = rec(w, sysId), c = w.companies[co];
  const cls = regionClass(w, sys), rule = CLASS[cls], claim = r.claims[co];
  const held = Math.max(0, heldCount(w, co) - (r.owner === co ? 1 : 0));
  const k = rule.mult * (1 + SOV.perHeld * held);
  // economy
  const up = upkeepOf(h, co, sysId);
  const nA = SOV.assets * k, nL = Math.max(SOV.liquid * k, up * 24), nR = SOV.revenue * k;
  const A = netAssets(h, co), L = liquidity(w, co, h.time), R = revenue(w, co, h.time);
  const debt = (c?.upkeep?.debt ?? 0) + Object.values(w.sov?.sys ?? {}).filter(x => x.owner === co).reduce((a, x) => a + x.arrears, 0);
  const em: string[] = [];
  if (A < nA) em.push(`순자산 ${cr(A)} / ${cr(nA)} cr`);
  if (L < nL) em.push(`최근 ${SOV.liqWindowH}시간 최저 보유 자금 ${cr(L)} / ${cr(nL)} cr`);
  if (R < nR) em.push(`최근 ${SOV.revWindowH}시간 영업 수입 ${cr(R)} / ${cr(nR)} cr`);
  if (debt > 0) em.push(`체납 ${cr(debt)} cr`);
  const econ = C(!em.length, Math.min(A / nA, L / nL, R / nR), 1, em, em.length ? '판매·계약 수입을 늘리고 현금을 일정 시간 유지하세요. 체납은 먼저 청산해야 합니다 (빌리거나 잠깐 옮겨 온 자금은 인정되지 않음).' : '');
  // infrastructure
  const own = ownStations(h, co, sysId);
  const G = own.find(x => builtN(x, 'governance') > 0) ?? own.sort((a, b) => sizeRank(b.size) - sizeRank(a.size))[0];
  const im: string[] = [];
  if (!G) im.push('이 성계에 자사 운영 정거장 없음');
  else {
    if (sizeRank(G.size) < sizeRank(rule.station)) im.push(`정거장 규모 ${G.size ?? 'S'} / ${rule.station} 이상`);
    if (!builtN(G, 'governance')) im.push('성계 통치청 미건설');
    if (!stationSupportOnline(G)) im.push('전력 부족 (발전소 증설)');
    if (!builtN(G, 'warehouse')) im.push('창고 없음');
    if (builtN(G, 'defense') < rule.defense) im.push(`방어시설 ${builtN(G, 'defense')} / ${rule.defense}`);
  }
  const infra = C(!im.length, G ? 1 - im.length / 5 : 0, 1, im, im.length ? `${rule.station}급 이상 정거장에 통치청·발전소·창고·방어시설 ${rule.defense}기를 건설하세요.` : '');
  // logistics
  const gov = G && builtN(G, 'governance') ? G : undefined;
  const ss = supplyStats(r, co, h.time), GL = r.gov?.[co];
  const lm: string[] = [];
  if (!gov) lm.push('통치청이 가동되어야 보급 실적을 측정합니다');
  else {
    if (ss.hours < SOV.supplyMinH) lm.push(`보급 측정 ${ss.hours} / ${SOV.supplyMinH}시간`);
    if (ss.ratio < SOV.supplyShare) lm.push(`최근 ${SOV.supplyWindowH}시간 보급 반입 ${Math.round(ss.ratio * 100)}% / ${Math.round(SOV.supplyShare * 100)}% (한 번에 쌓아 둔 재고는 시간이 지나면 인정되지 않음)`);
    if ((GL?.short ?? 0) > 600) lm.push(`행정 물자 부족 — 통치청이 멈춰 있음 (${Math.round((GL!.short ?? 0) / 60)}분째${GL?.lack ? ': ' + Object.entries(GL.lack).map(([k, n]) => `${k} ${Math.ceil(n)}`).join(', ') + ' 모자람' : ''})`);
    else if (GL?.lack) lm.push(`다음 운영 주기 예약 부족: ${Object.entries(GL.lack).map(([k, n]) => `${k} ${Math.ceil(n)}`).join(', ')} — 재고가 바닥나면 통치청이 멈춥니다`);
  }
  const logi = C(!lm.length, ss.ratio, SOV.supplyShare, lm, lm.length ? `통치청 정거장 창고에 ${Object.entries(supplyNeed(cls)).map(([g, n]) => `${g} ${Math.round(n)}/시간`).join(', ')}을 꾸준히 반입하세요 (자체 생산·구매·물류 계약 모두 인정). 통치청은 다음 1시간분을 예약해 두므로 함대 보급·판매·물류가 그 몫을 가져가지 못하지만, 예약 외 재고는 함대 보급에도 쓰이니 주둔 함대 소모분은 따로 반입해야 합니다.` : '');
  // military
  const pw = powerIn(h, co, sysId), pn = powerNeed(h, co, sysId);
  const units = presence(h).get(sysId)?.get(co) ?? [];
  const mm: string[] = [];
  if (pw < pn) mm.push(`전력 ${cr(pw)} / ${cr(pn)} (위협 반영)`);
  if (units.length && !units.some(u => u.officer)) mm.push('지휘관이 배치된 함대 없음');
  const hpAvg = units.length ? units.reduce((a, u) => a + u.hp, 0) / units.length : 0;
  if (units.length && hpAvg < SOV.minHpAvg) mm.push(`함대 정비 상태 ${Math.round(hpAvg * 100)}% (수리 필요)`);
  if (!r.act[co] || h.time - r.act[co] > SOV.activeH * 3600) mm.push(`최근 ${SOV.activeH}시간 성계 거점 확보 활동 없음`);
  const mil = C(!mm.length, pn > 0 ? pw / pn : 0, 1, mm, mm.length ? '전투함을 이 성계에 배치해 관문·정거장을 순찰하세요. 자사 함대가 부족하면 경비 계약(B-2)으로 다른 회사의 함대를 고용할 수 있습니다.' : '');
  // effective control
  const my = r.ctl[co] ?? 0;
  const rival = Object.entries(r.ctl).filter(([p]) => p !== co).sort((a, b) => b[1] - a[1])[0];
  const govHeld = !!gov && r.pts['st:' + gov.id]?.p !== undefined ? r.pts['st:' + gov.id].p === co : !!gov;
  const cm: string[] = [];
  if (my < SOV.ctlNeed) cm.push(`실효 지배 ${Math.round(my)} / ${SOV.ctlNeed}`);
  if (rival && rival[1] >= SOV.ctlRival) cm.push(`${partyName(w, rival[0])}의 지배력 ${Math.round(rival[1])} (≥ ${SOV.ctlRival}이면 불인정)`);
  if (gov && !govHeld) cm.push('통치청이 적에게 제압됨');
  const ctl = C(!cm.length, my, SOV.ctlNeed, cm, cm.length ? `관문·정거장 주변을 무장 함대로 계속 확보하면 지배력이 시간당 약 ${SOV.ctlUp}씩 오릅니다 (짧게 큰 함대를 보내도 빨리 오르지 않음).` : '');
  // legitimacy
  const lg = legitimacy(h, co, sysId);
  const legit = C(lg.ok, lg.ok ? 1 : 0, 1, lg.miss, lg.fix);
  // stabilisation
  const need = rule.stabH * 3600;
  const prog = r.owner === co ? need : claim?.prog ?? 0;
  const stab = C(prog >= need, prog / need, 1, prog >= need ? [] : [`안정화 ${(prog / 3600).toFixed(1)} / ${rule.stabH}시간 (모든 조건을 유지하는 동안 진행)`], '나머지 여섯 조건을 계속 유지하세요. 일부가 모자라면 진행이 멈추고, 여럿이 모자라면 조금씩 줄어듭니다 (초기화되지 않음).');
  return { econ, infra, logi, mil, ctl, legit, stab };
}

function legitimacy(h: Host, co: string, sysId: string): { ok: boolean; miss: string[]; fix: string } {
  const w = h.st, sys = w.systems[sysId], r = rec(w, sysId), claim = r.claims[co], cls = regionClass(w, sys);
  if (r.owner === co) return { ok: true, miss: [], fix: '' };
  if (!claim) return { ok: false, miss: ['영유권 선언 전'], fix: '조건이 갖춰지면 영유권을 선언하세요 (거점·영향력 필요).' };
  if (r.owner) {
    if (claim.legit === 'agreement' || claim.legit === 'war') return { ok: true, miss: [], fix: '' };
    return { ok: false, miss: [`${partyName(w, r.owner)}의 영토`], fix: '이양 합의를 받거나 영토 전쟁에서 이겨 조약을 맺어야 합니다.' };
  }
  let rule = CLASS[cls].legit;
  // a former NPC system whose faction is gone (ceded earlier, title lapsed later) is open to pioneering again
  if ((rule === 'cession' || rule === 'war') && !sys.faction) rule = 'pioneer';
  if (rule === 'pioneer') return { ok: true, miss: [], fix: '' };
  if (rule === 'pacify') {
    const m: string[] = [];
    const lairs = Object.values(w.lairs).filter(l => l.alive && h.sysOf(l.pos)?.id === sysId).length;
    if (lairs) m.push(`해적 소굴 ${lairs}곳 잔존`);
    if ((r.ctl.pirates ?? 0) >= SOV.pirateCtlMax) m.push(`해적 지배력 ${Math.round(r.ctl.pirates ?? 0)} / ${SOV.pirateCtlMax} 미만`);
    if ((claim.pac ?? 0) < SOV.pacifyH * 3600) m.push(`평정 유지 ${((claim.pac ?? 0) / 3600).toFixed(1)} / ${SOV.pacifyH}시간`);
    return { ok: !m.length, miss: m, fix: m.length ? '해적 소굴을 파괴하고 해적 무리가 성계에 머물지 못하게 하세요.' : '' };
  }
  if (claim.legit === 'cession' || claim.legit === 'war') {
    if (cls === 'capital' && claim.legit !== 'war') return { ok: false, miss: ['수도는 전쟁 조약으로만'], fix: '' };
    return { ok: true, miss: [], fix: '' };
  }
  const f = sys.faction ? FACTIONS[sys.faction]?.name : '세력';
  if (cls === 'capital') return { ok: false, miss: [`${f} 수도 — 돈이나 협상으로 얻을 수 없음`], fix: `${f}의 전력이 크게 꺾인 상태에서 영토 전쟁으로 점령을 유지해야 합니다.` };
  return { ok: false, miss: [`${f} 영역 — 할양 조약 또는 전쟁 조약 필요`], fix: `${f} 신뢰도 ${cls === 'npc_core' ? SOV.cessionCoreStanding : SOV.cessionStanding} 이상과 지배력 ${SOV.cessionCtl} 이상에서 할양 협상을 하거나, 영토 전쟁으로 점령 후 조약을 맺으세요.` };
}

/** the development stage 0..8 of a company in a system (each stage needs the ones before it) */
export function stageOf(h: Host, co: string, sysId: string, rep?: Report): number {
  const w = h.st, r = rec(w, sysId);
  if (r.owner === co) return 8;
  const P = presence(h).get(sysId)?.get(co);
  const shipHere = !!P?.length || Object.values(w.ships).some(s => s.owner === co && h.sysOf(s.pos)?.id === sysId);
  const own = ownStations(h, co, sysId);
  if (!shipHere && !own.length) return 0;
  if (!own.length) return 1;
  if ((r.ctl[co] ?? 0) < SOV.influence) return 2;
  if (!r.claims[co]) return 3;
  if (!own.some(x => builtN(x, 'governance'))) return 4;
  rep ??= evaluate(h, co, sysId);
  if (!rep.ctl.ok || !rep.mil.ok) return 5;
  if (!(['econ', 'infra', 'logi', 'mil', 'ctl', 'legit'] as CondKey[]).every(k => rep!=null && rep[k].ok)) return 6;
  return 7;
}

// ───────────────────────────────────────────────────────────── money (real credits only — nothing is created)

function ledOf(r: SovSys, now: number) {
  const hr = hourOf(now); let b = r.led.at(-1);
  if (!b || b.h !== hr) { b = { h: hr, tax: 0, toll: 0, permit: 0, up: 0 }; r.led.push(b); if (r.led.length > 24) r.led.splice(0, r.led.length - 24); }
  return b;
}
/** move credits from one company to another; false when the payer cannot pay in full */
function transfer(h: Host, from: string, to: string, amount: number, cat: 'sov_tax' | 'sov_toll' | 'sov_permit' | 'sov_treaty', why: string): boolean {
  const w = h.st, a = w.companies[from], b = w.companies[to];
  if (!a || !b || amount <= 0 || a.credits < amount) return false;
  watchMoney(w, 'sov_' + cat, { company: from }, () => { a.credits -= amount; b.credits += amount; });
  book(h, from, cat + '_paid', -amount); book(h, to, cat, amount);
  void why;
  return true;
}
const efficiency = (r: SovSys) => r.stab >= 60 ? 1 : r.stab >= 35 ? 0.8 : r.stab >= 15 ? 0.5 : 0.25;
/** may the sovereign enforce its policy at this place now (real armed presence, not a switch)? */
export function enforcing(h: Host, sysId: string, at?: V, r0?: number): boolean {
  const w = h.st, r = w.sov?.sys[sysId]; if (!r?.owner || r.stab < 15 || r.occ) return false;
  const l = presence(h).get(sysId)?.get(r.owner);
  if (at) return near(l, at, r0 ?? SOV.gateR) >= SOV.enforce;
  return powerIn(h, r.owner, sysId) >= SOV.enforceMine;
}
const permitted = (r: SovSys, kind: keyof SovSys['permits'], co: string, now: number) => (r.permits[kind][co] ?? 0) > now;
const exempt = (w: WorldState, r: SovSys, co: string) => co === r.owner || w.companies[co]?.kind !== 'player' || coRelation(w, co, r.owner!) === 1;

// ── hooks called by the simulation

/** mining in a sovereign system: a reason when the sovereign refuses this miner and enforces it */
export function sovMineBlock(h: Host, owner: string, sysId: string | undefined): string | null {
  const w = h.st; if (!w.sovV || !sysId) return null;
  const r = w.sov?.sys[sysId]; if (!r?.owner || exempt(w, r, owner)) return null;
  const pol = r.policy.mine;
  const refused = pol === 'exclusive' ? !permitted(r, 'mine', owner, h.time) : pol === 'permit' ? !permitted(r, 'mine', owner, h.time) : pol === 'royalty' ? (r.owed[owner] ?? 0) > 20000 : false;
  if (!refused || !enforcing(h, sysId)) return null;
  return `${w.companies[r.owner]?.name ?? '영유 회사'} 영토 — ${pol === 'royalty' ? '미납 사용료' : '채굴 허가 없음'}`;
}
/** value just mined by a non-sovereign company: royalties owed under a royalty policy */
export function sovMined(h: Host, owner: string, sysId: string | undefined, value: number) {
  const w = h.st; if (!w.sovV || !sysId || value <= 0) return;
  const r = w.sov?.sys[sysId]; if (!r?.owner || exempt(w, r, owner) || r.policy.mine !== 'royalty' || r.policy.royalty <= 0) return;
  r.owed[owner] = (r.owed[owner] ?? 0) + value * r.policy.royalty;
}
/** a ship jumps into a sovereign system: refused (false) only where the sovereign really guards that gate */
export function sovGateTransit(h: Host, s: WShip, exit: Gate, dest: StarSystem): boolean {
  const w = h.st; if (!w.sovV) return true;
  const r = w.sov?.sys[dest.id]; if (!r?.owner || exempt(w, r, s.owner) || isPirate(w, s.owner)) return true;
  const pol = r.policy, permit = permitted(r, 'pass', s.owner, h.time);
  const wanted = pol.security === 'strict' && (w.companies[s.owner]?.law?.level ?? 0) >= 2;
  const banned = (pol.pass === 'restricted' && !permit) || wanted;
  const toll = pol.pass === 'toll' && !permit ? Math.min(SOV.tollMax, pol.toll) : 0;
  if (!banned && toll <= 0) return true;
  if (!enforcing(h, dest.id, exit.pos)) return true;   // nobody there to stop it: the policy is only words
  if (banned) { tell(h, s.owner, `${dest.name} 관문 통과 거부 — ${wanted ? '수배 회사 통행 금지' : '통행 허가 없음'} (${w.companies[r.owner]?.name} 경비 함대가 관문을 지키고 있음)`, s.pos); return false; }
  if (!transfer(h, s.owner, r.owner, toll, 'sov_toll', 'toll')) { tell(h, s.owner, `${dest.name} 관문 통과 거부 — 통행료 ${cr(toll)} cr를 낼 자금 부족`, s.pos); return false; }
  ledOf(r, h.time).toll += toll;
  return true;
}
const told = new Map<string, number>();
function tell(h: Host, co: string, txt: string, pos?: V) {
  const k = co + txt; if ((told.get(k) ?? -1e9) > h.time - 120) return; told.set(k, h.time);
  h.ev('warn', txt, { company: co, pos, tag: 'sov' });
}
/** founding a station in a sovereign system */
export function sovFoundRule(w: WorldState, sysId: string | undefined, co: string, now: number): { ok: false; why: string } | { ok: true; fee: number; to?: string } {
  if (!w.sovV || !sysId) return { ok: true, fee: 0 };
  const r = w.sov?.sys[sysId]; if (!r?.owner || r.owner === co) return { ok: true, fee: 0 };
  const name = w.companies[r.owner]?.name ?? '영유 회사';
  if (r.policy.build === 'closed' && !permitted(r, 'build', co, now)) return { ok: false, why: `${name}의 영토 — 신규 정거장 건설이 허가되지 않습니다` };
  if (r.policy.build === 'permit' && !permitted(r, 'build', co, now)) return { ok: false, why: `${name}의 영토 — 건설 허가가 필요합니다 (영토 화면에서 구매)` };
  return { ok: true, fee: Math.max(0, Math.round(r.policy.buildFee)), to: r.owner };
}
export function sovFoundPay(h: Host, sysId: string | undefined, co: string): string | null {
  const rule = sovFoundRule(h.st, sysId, co, h.time);
  if (!rule.ok) return rule.why;
  if (rule.fee > 0 && rule.to) {
    if (!transfer(h, co, rule.to, rule.fee, 'sov_permit', 'build')) return `건설 허가료 ${cr(rule.fee)} cr 부족`;
    ledOf(h.st.sov!.sys[sysId!], h.time).permit += rule.fee;
  }
  return null;
}
/** the governance seat may be planned only where the company has declared a claim (or already rules) */
export function sovGovernanceRule(h: Host, co: string, st: Station): string | null {
  const w = h.st; if (!w.sovV) return '이 월드에는 영유권 체계가 없습니다';
  const sys = h.sysOf(st.pos); if (!sys) return '성계 밖';
  const r = rec(w, sys.id);
  if (!r.claims[co] && r.owner !== co) return '먼저 이 성계에 영유권을 선언해야 합니다 (영토 화면)';
  if (sizeRank(st.size) < 2) return '중형(M) 이상 정거장에만 건설할 수 있습니다';
  if (stationsIn(h, sys.id).some(x => x.owner === co && x.modules.some(m => m.kind === 'governance'))) return '이 성계에는 이미 통치청이 있습니다';
  return null;
}
/** station batteries do not repair while enemy warships besiege them in a war */
export function sovSieged(h: Host, st: Station): boolean {
  const w = h.st; if (!w.sovV || st.public) return false;
  const sys = h.sysOf(st.pos); if (!sys) return false;
  for (const war of Object.values(w.sov?.wars ?? {})) {
    if (war.status !== 'active' || war.sys !== sys.id || (war.def !== st.owner && war.att !== st.owner)) continue;
    const foe = war.def === st.owner ? war.att : war.def;
    if (near(presence(h).get(sys.id)?.get(foe), st.pos, SOV.stationR) > 0) return true;
  }
  return false;
}
/** an active war where these attackers may assault this station's batteries (combat detection) */
export function sovSiegeTargets(h: Host): { st: Station; groups: WGroup[] }[] {
  const w = h.st, out: { st: Station; groups: WGroup[] }[] = [];
  if (!w.sovV) return out;
  for (const war of Object.values(w.sov?.wars ?? {})) {
    if (war.status !== 'active' || facOf(war.def)) continue;
    const [A] = warSides(w, war);
    for (const st of stationsIn(h, war.sys)) {
      if (st.owner !== war.def || !builtN(st, 'defense') || !stationSupportOnline(st) || st.defenseHp <= 0.15) continue;
      const gs = Object.values(w.groups).filter(g => A.has(g.owner) && g.shipIds.some(id => { const s = w.ships[id]; return !!s && econOf(s).military && s.state === 'space' && !s.engagement && s.warp?.phase !== 'warp' && dist(s.pos, st.pos) < 1500; }));
      if (gs.length) out.push({ st, groups: gs });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────── claims

function news(h: Host, txt: string, sysId?: string) {
  const s = S(h.st); s.news.push({ t: h.time, txt }); if (s.news.length > 40) s.news.splice(0, s.news.length - 40);
  h.ev('world', txt, { ref: sysId, tag: 'sov' });
}
const pay = (h: Host, co: Company, n: number, cat: string) => { watchMoney(h.st, cat, { company: co.id }, () => { co.credits -= n; }); book(h, co.id, cat, -n); };

export function sovDeclare(h: Host, co: string, sysId: string): string | null {
  const w = h.st, c = w.companies[co], sys = w.systems[sysId];
  if (!c || c.kind !== 'player' || !sys) return '선언 불가';
  const r = rec(w, sysId);
  if (r.owner === co) return '이미 자사 영토입니다';
  if (r.claims[co]) return '이미 영유권을 선언했습니다';
  if (Object.values(w.sov!.sys).filter(x => x.claims[co]).length >= SOV.maxClaims) return `동시에 주장할 수 있는 성계는 ${SOV.maxClaims}곳까지입니다`;
  const st = stageOf(h, co, sysId);
  if (st < 3) return `선언하려면 이 성계에 자사 운영 정거장이 있고 지배력이 ${SOV.influence} 이상이어야 합니다 (현재 ${STAGE_NAME[st]} 단계)`;
  const fee = round(SOV.declareFee * CLASS[regionClass(w, sys)].mult, 500);
  if (c.credits < fee) return `선언 비용 ${cr(fee)} cr 부족 (행정 등록·공시 비용)`;
  pay(h, c, fee, 'sov_admin');
  r.claims[co] = { co, at: h.time, prog: 0, live: h.time, stage: 4, ...(CLASS[regionClass(w, sys)].legit === 'pioneer' && !r.owner ? { legit: 'pioneer' as const } : {}) };
  const f = sys.faction && sys.faction !== 'pirates' ? sys.faction : undefined;
  if (f) { bumpStanding(w, co, f, -8); h.ev('warn', `${FACTIONS[f].name}이(가) ${sys.name} 영유권 주장에 공식 항의했습니다 (신뢰도 -8)`, { company: co, tag: 'sov' }); }
  if (r.owner) h.ev('warn', `${c.name}이(가) 귀사 영토 ${sys.name}에 영유권을 주장했습니다`, { company: r.owner, tag: 'sov' });
  for (const o of Object.keys(r.claims)) if (o !== co) h.ev('warn', `${c.name}이(가) ${sys.name}에 경쟁 영유권을 선언했습니다`, { company: o, tag: 'sov' });
  news(h, `${c.name}이(가) ${sys.name}의 영유권을 선언했습니다`, sysId);
  return null;
}
export function sovWithdraw(h: Host, co: string, sysId: string): string | null {
  const r = h.st.sov?.sys[sysId]; if (!r?.claims[co]) return '선언한 영유권이 없습니다';
  if (Object.values(h.st.sov!.wars).some(x => x.status !== 'ended' && x.sys === sysId && x.att === co)) return '진행 중인 영토 전쟁이 있습니다 — 먼저 종전하세요';
  delete r.claims[co]; if (r.ceded === co) r.ceded = undefined;
  news(h, `${h.st.companies[co]?.name}이(가) ${h.st.systems[sysId]?.name} 영유권 주장을 철회했습니다`, sysId);
  return null;
}
function establish(h: Host, r: SovSys, co: string, how: Legit, stab = 70) {
  const w = h.st, sys = w.systems[r.id], prev = r.owner;
  r.owner = co; r.since = h.time; r.how = how; r.stab = stab; r.arrears = 0; r.disputeT = undefined; r.occ = undefined;
  delete r.claims[co];
  // an NPC faction that ceded the system leaves it: its markets stay as public stations, under no faction
  if (sys.faction) {
    const f = sys.faction;
    sys.faction = undefined;
    for (const st of stationsIn(h, r.id)) if (st.public && st.faction === f) st.faction = undefined;
    const fs = w.factions?.[f]; if (fs?.claimed) fs.claimed = fs.claimed.filter(x => x !== r.id);
  }
  r.ceded = undefined;
  if (prev && prev !== co) { r.policy = DEFAULT_POLICY(); r.permits = { mine: {}, build: {}, pass: {} }; r.owed = {}; }
  const c = w.companies[co];
  if (c && !c.milestones.includes('first_sov')) c.milestones.push('first_sov');
  news(h, `${c?.name}이(가) ${sys.name}의 영유권을 확립했습니다 (${LEGIT_NAME[how]}${prev ? ` — 이전 영유: ${partyName(w, prev)}` : ''})`, r.id);
  h.ev('milestone', `${sys.name} 영유권 확립 — 이제 성계 정책과 유지비를 관리하세요`, { company: co, tag: 'sov' });
}
function lapse(h: Host, r: SovSys, why: string) {
  const w = h.st, prev = r.owner!; const sys = w.systems[r.id];
  r.owner = undefined; r.since = undefined; r.how = undefined; r.disputeT = undefined; r.policy = DEFAULT_POLICY(); r.permits = { mine: {}, build: {}, pass: {} }; r.owed = {}; r.arrears = 0;
  news(h, `${partyName(w, prev)}의 ${sys.name} 영유권이 소멸했습니다 — ${why}`, r.id);
  h.ev('warn', `${sys.name} 영유권 상실: ${why}`, { company: prev, tag: 'sov' });
}

// ───────────────────────────────────────────────────────────── policy and permits

export function sovPolicy(h: Host, co: string, sysId: string, p: unknown): string | null {
  const r = h.st.sov?.sys[sysId]; if (!r || r.owner !== co) return '자사 영토가 아닙니다';
  if (!p || typeof p !== 'object') return '정책 형식 오류';
  const x = p as Partial<SovPolicy>, pol = r.policy;
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined;
  if (x.mine && ['free', 'permit', 'exclusive', 'royalty'].includes(x.mine)) pol.mine = x.mine;
  if (x.royalty !== undefined) pol.royalty = num(x.royalty, 0, SOV.royaltyMax) ?? pol.royalty;
  if (x.build && ['free', 'permit', 'closed'].includes(x.build)) pol.build = x.build;
  if (x.buildFee !== undefined) pol.buildFee = Math.round(num(x.buildFee, 0, 500000) ?? pol.buildFee);
  if (x.pass && ['free', 'restricted', 'toll'].includes(x.pass)) pol.pass = x.pass;
  if (x.toll !== undefined) pol.toll = Math.round(num(x.toll, 0, SOV.tollMax) ?? pol.toll);
  if (x.security && ['standard', 'strict'].includes(x.security)) pol.security = x.security;
  if (x.price && typeof x.price === 'object') for (const k of ['mine', 'build', 'pass'] as const) { const v = num((x.price as any)[k], 0, 1_000_000); if (v !== undefined) pol.price[k] = Math.round(v); }
  return null;
}
/** the sovereign grants or revokes a permit (free) */
export function sovGrant(h: Host, co: string, sysId: string, kind: unknown, target: unknown, on: unknown): string | null {
  const r = h.st.sov?.sys[sysId]; if (!r || r.owner !== co) return '자사 영토가 아닙니다';
  if (kind !== 'mine' && kind !== 'build' && kind !== 'pass') return '허가 종류 오류';
  if (typeof target !== 'string' || h.st.companies[target]?.kind !== 'player' || target === co) return '대상 회사 오류';
  if (on) r.permits[kind][target] = h.time + SOV.permitH * 3600 * 7; else delete r.permits[kind][target];
  h.ev('info', `${h.st.systems[sysId].name} ${kind === 'mine' ? '채굴' : kind === 'build' ? '건설' : '통행'} 허가 ${on ? '부여' : '취소'}: ${h.st.companies[target].name}`, { company: target, tag: 'sov' });
  return null;
}
/** another company buys a 24 h permit at the sovereign's price (credits go to the sovereign) */
export function sovBuyPermit(h: Host, co: string, sysId: string, kind: unknown): string | null {
  const r = h.st.sov?.sys[sysId]; if (!r?.owner || r.owner === co) return '구매할 수 없는 허가';
  if (kind !== 'mine' && kind !== 'build' && kind !== 'pass') return '허가 종류 오류';
  const price = r.policy.price[kind];
  if (!(price > 0)) return '영유 회사가 이 허가를 판매하지 않습니다';
  if (r.policy.mine === 'exclusive' && kind === 'mine') return '독점 채굴권 성계 — 채굴 허가는 영유 회사가 직접 부여합니다';
  if (!transfer(h, co, r.owner, price, 'sov_permit', kind)) return `허가료 ${cr(price)} cr 부족`;
  ledOf(r, h.time).permit += price;
  r.permits[kind][co] = Math.max(h.time, r.permits[kind][co] ?? 0) + SOV.permitH * 3600;
  h.ev('money', `${h.st.companies[co].name}이(가) ${h.st.systems[sysId].name} ${kind === 'mine' ? '채굴' : kind === 'build' ? '건설' : '통행'} 허가를 구매 (+${cr(price)} cr)`, { company: r.owner, tag: 'sov' });
  return null;
}

// ───────────────────────────────────────────────────────────── NPC cession by negotiation

export function cessionTerms(h: Host, co: string, sysId: string): { ok: boolean; why: string[]; price: number; standing: number; need: number } {
  const w = h.st, sys = w.systems[sysId], r = rec(w, sysId), cls = regionClass(w, sys), f = sys?.faction;
  const why: string[] = [];
  const need = cls === 'npc_core' ? SOV.cessionCoreStanding : SOV.cessionStanding;
  const standing = f ? standingOf(w, co, f) : 0;
  const price = round(SOV.cessionPrice * CLASS[cls].mult, 5000);
  if (!f || f === 'pirates') why.push('NPC 세력 영역이 아닙니다');
  else {
    if (cls === 'capital') why.push('세력 수도는 협상으로 넘겨받을 수 없습니다');
    if (!r.claims[co]) why.push('먼저 영유권을 선언하세요');
    if (r.ceded) why.push('이미 할양이 합의된 성계입니다');
    if (standing < need) why.push(`${FACTIONS[f].name} 신뢰도 ${Math.round(standing)} / ${need}`);
    if ((r.ctl[co] ?? 0) < SOV.cessionCtl) why.push(`지배력 ${Math.round(r.ctl[co] ?? 0)} / ${SOV.cessionCtl}`);
    if (Object.values(w.sov!.wars).some(x => x.status !== 'ended' && x.sys === sysId)) why.push('전쟁 중');
    if ((w.companies[co]?.credits ?? 0) < price) why.push(`할양 대금 ${cr(price)} cr 부족`);
  }
  return { ok: !why.length, why, price, standing, need };
}
export function sovNegotiate(h: Host, co: string, sysId: string): string | null {
  const w = h.st, t = cessionTerms(h, co, sysId);
  if (!t.ok) return t.why.join(' · ');
  const sys = w.systems[sysId], f = sys.faction!, fs = w.factions?.[f], c = w.companies[co];
  // the price goes into the faction's own treasury (its economy spends it); nothing is created or destroyed
  watchMoney(w, 'sov_cession', { company: co }, () => { c.credits -= t.price; if (fs?.econ) fs.econ.budget += t.price; });
  book(h, co, 'sov_treaty_paid', -t.price);
  const r = rec(w, sysId); r.ceded = co; r.claims[co].legit = 'cession';
  bumpStanding(w, co, f, -5);
  news(h, `${FACTIONS[f].name}이(가) ${sys.name}을(를) ${c.name}에 할양하기로 합의했습니다 (대금 ${cr(t.price)} cr) — 영유권 확립 조건을 채우면 세력이 철수합니다`, sysId);
  return null;
}

// ───────────────────────────────────────────────────────────── territory war

const inactiveLong = (w: WorldState, co: string, now: number) => w.companies[co]?.kind === 'player' && now - (w.sov?.co[co]?.seen ?? 0) > SOV.inactiveDays * 86400;
export const activeWar = (w: WorldState, sysId: string) => Object.values(w.sov?.wars ?? {}).find(x => x.status !== 'ended' && x.sys === sysId);
function wlog(war: SovWar, t: number, txt: string) { war.log.push({ t, txt }); if (war.log.length > 30) war.log.splice(0, war.log.length - 30); }
export function holdNeed(w: WorldState, war: SovWar): number {
  const sys = w.systems[war.sys]; const h = CLASS[regionClass(w, sys)].holdH * 3600;
  return inactiveLong(w, war.def, war.start) ? h / 2 : h;
}

export function sovDeclareWar(h: Host, co: string, sysId: string): string | null {
  const w = h.st, c = w.companies[co], sys = w.systems[sysId];
  if (!c || c.kind !== 'player' || !sys) return '선전포고 불가';
  const r = rec(w, sysId);
  if (!r.claims[co]) return '영유권을 선언한 성계에만 영토 전쟁을 선포할 수 있습니다';
  const def = legalOf(w, sysId);
  if (!def) return sys.faction === 'pirates' || regionClass(w, sys) === 'lawless' ? '해적 지대는 전쟁이 아니라 평정 대상입니다' : '법적 영유자가 없는 성계 — 개척으로 영유권을 얻으세요';
  if (def === co) return '자사 영토입니다';
  if (activeWar(w, sysId)) return '이 성계에는 이미 영토 전쟁이 진행 중입니다';
  if (!facOf(def) && coRelation(w, co, def) === 1) return '동맹 회사와는 전쟁할 수 없습니다';
  const s = S(w), cool = Math.max(s.cool[`${co}:${sysId}`] ?? 0, s.cool[`*:${sysId}`] ?? 0);
  if (cool > h.time) return `종전 직후 재침공 제한 — ${Math.ceil((cool - h.time) / 3600)}시간 후 가능`;
  const fee = round(SOV.warFee * CLASS[regionClass(w, sys)].mult, 1000);
  if (c.credits < fee) return `선전포고 비용 ${cr(fee)} cr 부족 (동원·법적 절차)`;
  pay(h, c, fee, 'sov_war');
  const notice = facOf(def) ? SOV.noticeNpcH : inactiveLong(w, def, h.time) ? SOV.noticeInactiveH : SOV.noticeH;
  const id = `war${s.seq++}`;
  const war: SovWar = { id, att: co, def, sys: sysId, at: h.time, start: h.time + notice * 3600, status: 'notice', log: [] };
  s.wars[id] = war;
  wlog(war, h.time, `${c.name}이(가) ${partyName(w, def)}에 ${sys.name} 영토 전쟁을 선포 — ${notice}시간 후 개전`);
  if (facOf(def)) bumpStanding(w, co, facOf(def)!, -25);
  else h.ev('warn', `⚠ ${c.name}이(가) 귀사 영토 ${sys.name}에 영토 전쟁을 선포했습니다 — ${notice}시간 후 개전. 방어 함대를 배치하거나 방어 계약을 게시하세요.`, { company: def, tag: 'sov' });
  news(h, `${c.name} ↔ ${partyName(w, def)}: ${sys.name} 영토 전쟁 선포 (${notice}시간 예고)`, sysId);
  return null;
}

/** end a war (treaty, stalemate, withdrawal) */
function endWar(h: Host, war: SovWar, how: string) {
  const w = h.st, s = S(w);
  if (war.status === 'ended') return;
  war.status = 'ended'; war.end = { t: h.time, how };
  const r = rec(w, war.sys);
  if (r.occ?.war === war.id) r.occ = undefined;
  s.cool[`${war.att}:${war.sys}`] = h.time + SOV.truceCoolH * 3600;
  s.cool[`*:${war.sys}`] = Math.max(s.cool[`*:${war.sys}`] ?? 0, h.time + SOV.anyCoolH * 3600);
  wlog(war, h.time, `종전: ${how}`);
  for (const t of Object.values(s.treaties)) if (t.war === war.id && t.status === 'offer') t.status = 'expired';
  news(h, `${w.systems[war.sys].name} 영토 전쟁 종료 — ${how}`, war.sys);
  recallFleets(h, war);
}

/** the attacker has held the occupation long enough: impose the war treaty (cession) */
export function sovImpose(h: Host, co: string, warId: string): string | null {
  const w = h.st, war = w.sov?.wars[warId];
  if (!war || war.att !== co || war.status !== 'active') return '진행 중인 자사 공격 전쟁이 아닙니다';
  const r = rec(w, war.sys), need = holdNeed(w, war);
  if (!r.occ || r.occ.by !== co || r.occ.held < need) return `점령 유지 ${((r.occ?.held ?? 0) / 3600).toFixed(1)} / ${(need / 3600).toFixed(0)}시간 — 아직 조약을 강제할 수 없습니다`;
  const sys = w.systems[war.sys];
  if (regionClass(w, sys) === 'capital') {
    const f = facOf(war.def); const s0 = f ? S(w).str0[f] ?? 1 : 1, now = f ? w.factions?.[f]?.strength ?? 0 : 0;
    if (f && now > s0 * 0.35) return `수도 할양은 ${FACTIONS[f].name}의 전력이 크게 꺾여야 가능합니다 (현재 ${Math.round(now)} / 기준 ${Math.round(s0 * 0.35)} 이하)`;
  }
  const claim = r.claims[co]; if (claim) claim.legit = 'war';
  endWar(h, war, `전쟁 조약 — ${partyName(w, war.def)}이(가) ${sys.name}을(를) 할양`);
  establish(h, r, co, 'war', 40);
  return null;
}

/** offer a treaty (truce, reparations, return, transfer) to the other side */
export function sovPropose(h: Host, co: string, kind: unknown, sysId: unknown, to: unknown, amount: unknown): string | null {
  const w = h.st, s = S(w);
  if (kind !== 'truce' && kind !== 'reparations' && kind !== 'return' && kind !== 'transfer' && kind !== 'cession') return '조약 종류 오류';
  if (typeof sysId !== 'string' || !w.systems[sysId]) return '성계 오류';
  const war = activeWar(w, sysId);
  const p = typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
  let from = co, dest = typeof to === 'string' ? to : '';
  if (kind === 'transfer' || kind === 'cession') {
    // the sovereign gives its territory to another company (agreement; optional price paid by the receiver)
    const r = rec(w, sysId); if (r.owner !== co) return '자사 영토만 이양할 수 있습니다';
    if (!w.companies[dest] || w.companies[dest].kind !== 'player' || dest === co) return '이양 대상 회사를 선택하세요';
  } else {
    if (!war || war.status === 'ended') return '진행 중인 영토 전쟁이 없습니다';
    if (war.att !== co && war.def !== co) return '전쟁 당사자가 아닙니다';
    dest = war.att === co ? war.def : war.att;
    if (kind === 'return' && war.att !== co) return '점령 반환은 공격 측이 제안합니다';
    if (kind === 'reparations' && p <= 0) return '배상금을 입력하세요';
    if (kind === 'reparations' && (w.companies[co]?.credits ?? 0) < p) return '배상금을 지급할 자금이 부족합니다';
  }
  const id = `tr${s.seq++}`;
  s.treaties[id] = { id, kind, from, to: dest, sys: sysId, war: war?.id, pay: p, at: h.time, status: 'offer' };
  if (facOf(dest)) return answerAI(h, s.treaties[id]);
  h.ev('warn', `${w.companies[co].name}이(가) ${w.systems[sysId].name} ${TREATY_NAME[kind]} 조약을 제안했습니다${p ? ` (${cr(p)} cr)` : ''} — 영토 화면에서 수락/거절`, { company: dest, tag: 'sov' });
  return null;
}
export const TREATY_NAME: Record<SovTreaty['kind'], string> = { truce: '휴전', cession: '할양', reparations: '배상', return: '점령 반환', transfer: '영토 이양' };

export function sovAnswer(h: Host, co: string, id: unknown, accept: unknown): string | null {
  const w = h.st, t = typeof id === 'string' ? w.sov?.treaties[id] : undefined;
  if (!t || t.status !== 'offer' || t.to !== co) return '응답할 조약이 없습니다';
  if (!accept) { t.status = 'rejected'; h.ev('info', `${w.systems[t.sys].name} ${TREATY_NAME[t.kind]} 조약이 거절되었습니다`, { company: t.from, tag: 'sov' }); return null; }
  return apply(h, t);
}
function apply(h: Host, t: SovTreaty): string | null {
  const w = h.st, war = t.war ? w.sov!.wars[t.war] : undefined, sysName = w.systems[t.sys].name;
  switch (t.kind) {
    case 'truce': if (war) endWar(h, war, '휴전 조약'); break;
    case 'return': if (war) endWar(h, war, '점령 반환 — 공격 측 철수'); break;
    case 'reparations': {
      const payer = w.companies[t.from] ? t.from : undefined;
      if (payer && t.pay > 0) {
        const toCo = w.companies[t.to] ? t.to : undefined;
        if (toCo) { if (!transfer(h, payer, toCo, t.pay, 'sov_treaty', 'reparations')) return '배상금 지급 불가 (자금 부족)'; }
        else { const f = facOf(t.to); const fs = f ? w.factions?.[f] : undefined; const c = w.companies[payer]; if (c.credits < t.pay) return '배상금 지급 불가'; watchMoney(w, 'sov_reparations', { company: payer }, () => { c.credits -= t.pay; if (fs?.econ) fs.econ.budget += t.pay; }); book(h, payer, 'sov_treaty_paid', -t.pay); }
      }
      if (war) endWar(h, war, `배상 조약 (${cr(t.pay)} cr)`);
      break;
    }
    case 'transfer': case 'cession': {
      const r = rec(w, t.sys);
      if (r.owner !== t.from) return '이양할 영토가 아닙니다';
      if (t.pay > 0 && !transfer(h, t.to, t.from, t.pay, 'sov_treaty', 'transfer')) return '이양 대금 부족';
      if (war) endWar(h, war, '영토 이양 조약');
      establish(h, r, t.to, 'agreement', Math.min(r.stab, 60));
      break;
    }
  }
  t.status = 'accepted';
  h.ev('info', `${sysName} ${TREATY_NAME[t.kind]} 조약 체결`, { company: t.from, tag: 'sov' });
  return null;
}
/** an NPC faction answers at once, from its real situation */
function answerAI(h: Host, t: SovTreaty): string | null {
  const w = h.st, f = facOf(t.to)!, fs = w.factions?.[f], war = t.war ? w.sov!.wars[t.war] : undefined;
  const s0 = S(w).str0[f] ?? fs?.strength ?? 1;
  const tired = !!fs && (fs.strength < s0 * 0.4 || (war?.lostDef ?? 0) > (Object.values(war?.fleets ?? {}).reduce((a, x) => a + x, 0) + (war?.lostDef ?? 0)) * 0.5);
  const long = !!war && h.time - war.start > 24 * 3600;
  let ok = false;
  if (t.kind === 'truce') ok = tired || long;
  else if (t.kind === 'return') ok = true;
  else if (t.kind === 'reparations') ok = t.pay >= 100_000 * CLASS[regionClass(w, w.systems[t.sys])].mult || tired;
  if (!ok) { t.status = 'rejected'; h.ev('info', `${FACTIONS[f]?.name}이(가) ${TREATY_NAME[t.kind]} 제안을 거절했습니다${t.kind === 'truce' ? ' (아직 싸울 여력이 있음)' : ''}`, { company: t.from, tag: 'sov' }); return null; }
  return apply(h, t);
}

// ───────────────────────────────────────────────────────────── NPC faction defence (real ships from real strength)

const FLEET_T: [string, string][][] = [
  [['destroyer', 'aa'], ['destroyer', 'strike'], ['corvette', 'gun']],
  [['cruiser', 'multi'], ['destroyer', 'aa'], ['corvette', 'gun'], ['corvette', 'gun']],
];
const STR_PER_VALUE = 1 / 100;   // one abstract ship-equivalent of faction strength ≈ 100 ship value
function facCompany(h: Host, f: string): string {
  const id = FAC_CO(f), w = h.st;
  if (!w.companies[id]) w.companies[id] = { id, name: `${FACTIONS[f]?.name ?? f} 방위군`, kind: 'union', color: FACTIONS[f]?.color ?? '#9ab', credits: 0, rep: 0, createdAt: h.time, stats: { earned: 0, mined: 0, kills: 0, lost: 0, battlesWon: 0, contracts: 0 }, milestones: [], homeStation: '' } as Company;
  return id;
}
/** the faction's own station nearest to the target (its fleets sail from there through the gates) */
function facHome(h: Host, f: string, sysId: string): Station | undefined {
  const w = h.st;
  return Object.values(w.stations).filter(x => x.public && x.faction === f && w.systems[h.sysOf(x.pos)?.id ?? '']?.faction === f && h.sysOf(x.pos)?.id !== sysId)
    .map(x => ({ x, j: jumps(w.systems, h.sysOf(x.pos)!.id, sysId) })).filter(o => Number.isFinite(o.j)).sort((a, b) => a.j - b.j || (a.x.id < b.x.id ? -1 : 1))[0]?.x
    ?? Object.values(w.stations).find(x => x.public && x.faction === f && h.sysOf(x.pos)?.id === sysId);
}
function deploy(h: Host, f: string, sysId: string, size: 0 | 1, why: string, war?: SovWar): string | null {
  const w = h.st, fs = w.factions?.[f]; if (!fs) return null;
  const s0 = S(w).str0[f] ?? fs.strength;
  const tpl = FLEET_T[size], eq = tpl.reduce((a, [c]) => a + shipValue(c), 0) * STR_PER_VALUE;
  if (fs.strength - eq < s0 * 0.3) return null;                         // the faction keeps a home reserve
  const home = facHome(h, f, sysId); if (!home) return null;
  const sys = w.systems[sysId];
  const co = facCompany(h, f);
  fs.strength -= eq;                                                    // strength becomes real ships (no free spawns)
  const g = h.newGroup(co, `${FACTIONS[f].name} ${why === 'war' ? '방위함대' : '증원 순찰대'}`);
  tpl.forEach(([c, lo], i) => { const a = (i / tpl.length) * 6.28 + (hashId(g.id) % 100) / 50; h.spawnShip(co, c, lo, g.id, { x: home.pos.x + Math.cos(a) * (home.radius + 600), y: home.pos.y, z: home.pos.z + Math.sin(a) * (home.radius + 600) }); });
  const target = stationsIn(h, sysId).find(x => x.public && x.faction === f)?.pos ?? sys.origin;
  g.op = { k: 'defend', at: { ...target }, radius: 3500 };
  (g as any).sovFac = { f, sys: sysId, eq, home: home.id, war: war?.id };
  if (war) (war.fleets ??= {})[g.id] = eq;
  return g.id;
}
function recallFleets(h: Host, war: SovWar) {
  for (const gid of Object.keys(war.fleets ?? {})) { const g = h.st.groups[gid]; const x = (g as any)?.sovFac; if (g && x) g.op = { k: 'dock', station: x.home }; }
}
/** faction fleets that are home again return their (surviving) strength; lost ships are lost strength */
function stepFacFleets(h: Host) {
  const w = h.st;
  for (const g of Object.values(w.groups)) {
    const x = (g as any).sovFac as { f: string; sys: string; eq: number; home: string; war?: string } | undefined; if (!x) continue;
    const fs = w.factions?.[x.f]; const ships = h.shipsOf(g);
    const war = x.war ? w.sov?.wars[x.war] : undefined;
    const alive = ships.reduce((a, s) => a + shipValue(s.classId) * STR_PER_VALUE, 0);
    const lost = Math.max(0, x.eq - alive);
    if (lost > 0.01) { if (fs?.econ) fs.econ.led.lostStr += lost; if (war) { war.lostDef = (war.lostDef ?? 0) + lost; war.fleets![g.id] = alive; } x.eq = alive; }
    const home = w.stations[x.home];
    const docked = ships.length > 0 && ships.every(s => s.state === 'docked');
    if (!ships.length || (docked && g.op.k === 'dock') || (g.op.k === 'dock' && home && ships.every(s => dist(s.pos, home.pos) < home.radius + 1500))) {
      if (fs) fs.strength += ships.reduce((a, s) => a + shipValue(s.classId) * STR_PER_VALUE * (0.5 + 0.5 * s.hp), 0);
      for (const s of ships) delete w.ships[s.id];
      g.shipIds = []; delete w.groups[g.id];
      if (war?.fleets) delete war.fleets[g.id];
      continue;
    }
    // a reinforcement patrol goes home after its watch; a war fleet stays while the war lasts
    if (!war && g.op.k !== 'dock' && h.time - ((g as any).sovT ??= h.time) > 3 * 3600) g.op = { k: 'dock', station: x.home };
    if (war && war.status === 'ended' && g.op.k !== 'dock') g.op = { k: 'dock', station: x.home };
  }
}
/** how each NPC faction answers claims and wars in its space (every few minutes) */
function factionAI(h: Host) {
  const w = h.st, s = S(w);
  for (const war of Object.values(s.wars)) {
    const f = facOf(war.def); if (!f || war.status !== 'active') continue;
    const sys = w.systems[war.sys], cls = regionClass(w, sys);
    const want = (cls === 'capital' ? 2200 : cls === 'npc_core' ? 1300 : 800) + powerIn(h, war.att, war.sys) * 0.9;
    const have = Object.keys(war.fleets ?? {}).reduce((a, gid) => a + (w.groups[gid] ? h.shipsOf(w.groups[gid]).reduce((x, sh) => x + shipValue(sh.classId) * sh.hp, 0) : 0), 0);
    const last = s.reinf[war.id] ?? 0;
    if (have < want && h.time - last > 1800) {
      const gid = deploy(h, f, war.sys, cls === 'npc_border' ? 0 : 1, 'war', war);
      s.reinf[war.id] = h.time;
      if (gid) wlog(war, h.time, `${FACTIONS[f].name} 방위함대 출격 (${w.groups[gid].shipIds.length}척, ${w.stations[(w.groups[gid] as any).sovFac.home]?.name}에서)`);
    }
    // a beaten faction asks for a truce once
    const fs = w.factions?.[f];
    if (fs && !(war as any).aiTruce && (fs.strength < (s.str0[f] ?? 1) * 0.4 || (war.lostDef ?? 0) > 6)) {
      (war as any).aiTruce = true;
      const id = `tr${s.seq++}`;
      s.treaties[id] = { id, kind: 'truce', from: war.def, to: war.att, sys: war.sys, war: war.id, pay: 0, at: h.time, status: 'offer' };
      h.ev('info', `${FACTIONS[f].name}이(가) ${sys.name} 휴전을 제안했습니다`, { company: war.att, tag: 'sov' });
    }
  }
  // reinforcement: a claimant gaining a grip on faction space meets real patrols
  for (const r of Object.values(s.sys)) {
    const sys = w.systems[r.id], f = sys?.faction; if (!f || f === 'pirates' || r.ceded || activeWar(w, r.id)) continue;
    const strong = Object.values(r.claims).some(c => (r.ctl[c.co] ?? 0) >= 30);
    if (!strong || h.time - (s.reinf[r.id] ?? -1e9) < 3 * 3600) continue;
    s.reinf[r.id] = h.time;
    const gid = deploy(h, f, r.id, 0, 'reinforce');
    if (gid) for (const c of Object.keys(r.claims)) h.ev('warn', `${FACTIONS[f].name}이(가) ${sys.name}에 순찰대를 증파했습니다 (영유권 주장 대응)`, { company: c, tag: 'sov' });
  }
}

// ───────────────────────────────────────────────────────────── the minute tick

export function sovTick(h: Host, dt: number) {
  const w = h.st; if (!sovOn(w)) return;
  const s = S(w);
  s.acc = (s.acc ?? 0) + dt;
  if (s.acc < SOV.cycle) return;
  const step = s.acc; s.acc = 0;
  cache = null;
  sampleCredits(h);
  for (const sys of Object.values(w.systems)) rec(w, sys.id);
  // wars first (they change who may hold what)
  for (const war of Object.values(s.wars)) stepWar(h, war, step);
  for (const r of Object.values(s.sys)) stepSystem(h, r, step);
  if (Math.floor(h.time / 300) !== Math.floor((h.time - step) / 300)) factionAI(h);
  stepFacFleets(h);
  publish(h);
}

function stepWar(h: Host, war: SovWar, dt: number) {
  const w = h.st;
  if (war.status === 'notice' && h.time >= war.start) {
    war.status = 'active'; wlog(war, h.time, '개전');
    news(h, `${w.systems[war.sys].name} 영토 전쟁 개전: ${partyName(w, war.att)} → ${partyName(w, war.def)}`, war.sys);
  }
  if (war.status !== 'active') return;
  const r = rec(w, war.sys), att = r.ctl[war.att] ?? 0, def = r.ctl[war.def] ?? 0;
  // occupation: the attacker holds the system and the defender's grip is broken — not sovereignty, only a hold
  if (att >= SOV.occAtt && def <= SOV.occDef) {
    if (!r.occ || r.occ.by !== war.att) { r.occ = { by: war.att, war: war.id, since: h.time, held: 0 }; wlog(war, h.time, `${partyName(w, war.att)}이(가) ${w.systems[war.sys].name}을(를) 점령`); notifyParty(h, war.def, `⚠ ${w.systems[war.sys].name} 점령됨 — ${(holdNeed(w, war) / 3600).toFixed(0)}시간 안에 탈환하지 못하면 할양 조약을 강제당할 수 있습니다`); }
    r.occ.held += dt;
  } else if (r.occ?.war === war.id) {
    if (def > SOV.occBreak) { r.occ.held -= dt * 2; if (r.occ.held <= 0) { r.occ = undefined; wlog(war, h.time, `${partyName(w, war.def)}이(가) 탈환`); news(h, `${partyName(w, war.def)}이(가) ${w.systems[war.sys].name}을(를) 탈환했습니다`, war.sys); } }
  }
  // offline protection: the defender's stations fight by themselves; its docked warships there sortie on their own
  if (!facOf(war.def) && powerIn(h, war.att, war.sys) > 0) autoDefend(h, war);
  // a war nobody advances ends by itself
  if (!r.occ && h.time - war.start > SOV.staleH * 3600) endWar(h, war, '교착 — 자동 휴전');
  // the attacker gave up its claim / vanished
  if (!w.companies[war.att] || (!r.claims[war.att] && r.owner !== war.att)) endWar(h, war, '공격 측 주장 소멸');
}
function notifyParty(h: Host, p: string, txt: string) { if (h.st.companies[p]?.kind === 'player') h.ev('warn', txt, { company: p, tag: 'sov' }); }
function autoDefend(h: Host, war: SovWar) {
  const w = h.st;
  for (const st of stationsIn(h, war.sys)) {
    if (st.owner !== war.def) continue;
    for (const g of Object.values(w.groups)) {
      if (g.owner !== war.def || g.op.k !== 'idle' && g.op.k !== 'dock') continue;
      const ss = h.shipsOf(g); if (!ss.length || !ss.some(s => econOf(s).military)) continue;
      if (!ss.every(s => s.state === 'docked' && s.task.k === 'docked' && (s.task as any).station === st.id)) continue;
      if ((g as any).sovAuto === war.id) continue;
      (g as any).sovAuto = war.id;
      if (!h.command(war.def, { c: 'setOp', group: g.id, op: { k: 'defend', at: { ...st.pos }, radius: 2500 } } as any)) h.ev('warn', `${g.name}: 영토 전쟁 — ${st.name} 자동 방어 출격`, { company: war.def, tag: 'sov' });
    }
  }
}

function stepSystem(h: Host, r: SovSys, dt: number) {
  const w = h.st, sys = w.systems[r.id];
  migrateGov(r);
  stepControl(h, r, dt);
  const cls = regionClass(w, sys);
  // claims
  for (const claim of Object.values(r.claims)) {
    const c = w.companies[claim.co];
    if (!c) { delete r.claims[claim.co]; continue; }
    // pacification time: no pirate presence, no lair
    if (CLASS[cls].legit === 'pacify') {
      const pir = powerIn(h, 'pirates', r.id), lairs = Object.values(w.lairs).some(l => l.alive && h.sysOf(l.pos)?.id === r.id);
      claim.pac = !lairs && pir < 60 ? (claim.pac ?? 0) + dt : Math.max(0, (claim.pac ?? 0) - dt * 2);
      if (!claim.legit && (claim.pac ?? 0) >= SOV.pacifyH * 3600 && !lairs && (r.ctl.pirates ?? 0) < SOV.pirateCtlMax) claim.legit = 'pacify';
    }
    const G = govStation(h, claim.co, r.id);
    if (G) stepSupply(h, r, claim.co, G, cls, dt);
    const rep = evaluate(h, claim.co, r.id);
    claim.stage = stageOf(h, claim.co, r.id, rep);
    const keys: CondKey[] = ['econ', 'infra', 'logi', 'mil', 'ctl', 'legit'];
    const fails = keys.filter(k => !rep[k].ok).length;
    if (fails <= 2) claim.live = h.time;
    const need = CLASS[cls].stabH * 3600;
    if (!fails) {
      const margin = Math.min(1.25, Math.max(0.75, Math.min(rep.mil.v, rep.ctl.v / SOV.ctlNeed, rep.econ.v)));
      claim.prog = Math.min(need, claim.prog + dt * margin);
    } else if (fails >= 2) claim.prog = Math.max(0, claim.prog - need * SOV.decayPerH * dt / 3600);
    if (h.time - claim.live > SOV.inactiveH * 3600) {
      delete r.claims[claim.co]; if (r.ceded === claim.co) r.ceded = undefined;
      news(h, `${c.name}의 ${sys.name} 영유권 주장이 장기간 진척이 없어 소멸했습니다`, r.id);
      continue;
    }
    // establishment: the first claimant to complete stabilisation while there is no sovereign
    if (!fails && claim.prog >= need && !r.owner && !activeWar(w, r.id)) { establish(h, r, claim.co, claim.legit ?? 'pioneer'); }
  }
  if (r.owner) stepOwner(h, r, dt, cls);
  // a company that no longer governs here (claim ended, title lost, seat gone) gets its reservation back
  for (const [co, g] of Object.entries(r.gov ?? {})) {
    const active = (co === r.owner || r.claims[co]) && govStation(h, co, r.id)?.id === g.seat;
    if (!active && g.res) releaseRes(h, g, co);
    if (co !== r.owner && !r.claims[co]) delete r.gov![co];
  }
}

function stepOwner(h: Host, r: SovSys, dt: number, cls: RegionClass) {
  const w = h.st, co = r.owner!, c = w.companies[co], sys = w.systems[r.id];
  if (!c) { lapse(h, r, '회사 소멸'); return; }
  const b = ledOf(r, h.time);
  // upkeep: paid from real credits; a shortfall becomes territory arrears (paid back first when money comes in)
  const cost = upkeepOf(h, co, r.id) * dt / 3600;
  const due = cost + r.arrears;
  const paid = Math.min(Math.max(0, c.credits), due);
  if (paid > 0) { pay(h, c, paid, 'sov_upkeep'); b.up += paid; }
  r.arrears = Math.max(0, due - paid);
  // royalties: collected from what the miners really have
  for (const [m, owed] of Object.entries(r.owed)) {
    if (owed < 1) continue;
    const mc = w.companies[m]; if (!mc) { delete r.owed[m]; continue; }
    const take = Math.floor(Math.min(owed, Math.max(0, mc.credits)) * efficiency(r));
    if (take >= 1 && transfer(h, m, co, take, 'sov_tax', 'royalty')) { r.owed[m] = owed - take / efficiency(r); b.tax += take; }
  }
  // the seat keeps consuming administration goods
  const G = govStation(h, co, r.id);
  if (G) stepSupply(h, r, co, G, cls, dt);
  // retention: upkeep, supply, military, control
  const rep = evaluate(h, co, r.id);
  const miss = (r.arrears > 0 ? 1 : 0) + (rep.logi.ok && G ? 0 : 1) + (rep.mil.ok ? 0 : 1) + (rep.ctl.ok ? 0 : 1);
  const hrs = dt / 3600;
  if (!miss) r.stab = Math.min(100, r.stab + SOV.stabUp * hrs);
  else r.stab = Math.max(0, r.stab - (SOV.stabMiss * miss + (r.arrears > 0 ? SOV.stabArrears : 0)) * hrs);
  r.eff = efficiency(r);
  // dispute: another party out-controls a weakened sovereign; a long dispute with a broken grip ends the title
  const mine = r.ctl[co] ?? 0, rival = Object.entries(r.ctl).filter(([p]) => p !== co).sort((x, y) => y[1] - x[1])[0];
  if (r.stab < 35 && rival && rival[1] > mine) {
    if (r.disputeT === undefined) { r.disputeT = 0; h.ev('warn', `⚠ ${sys.name} 분쟁 상태 — ${partyName(w, rival[0])}의 지배력이 귀사를 넘어섰습니다`, { company: co, tag: 'sov' }); }
    r.disputeT += dt;
    if (r.disputeT >= SOV.lapseH * 3600 && (mine < 20 || r.stab <= 5)) { lapse(h, r, `장기 분쟁 끝에 실효 지배 상실 (${partyName(w, rival[0])} 우세)`); return; }
  } else if (r.disputeT !== undefined) { r.disputeT = Math.max(0, r.disputeT - dt * 2); if (r.disputeT === 0) r.disputeT = undefined; }
  // an abandoned title: governance collapsed (stability 0) and a week of upkeep unpaid — nobody needs to contest it
  if (r.stab <= 0 && r.arrears >= upkeepOf(h, co, r.id) * SOV.abandonH) lapse(h, r, '장기 체납과 통치 붕괴');
}

// ───────────────────────────────────────────────────────────── what clients see

function statusOf(w: WorldState, r: SovSys): SovStatus {
  if (r.occ) return 'occupied';
  if (r.owner) return r.disputeT !== undefined || !!activeWar(w, r.id) ? 'disputed' : 'established';
  const cl = Object.values(r.claims);
  if (!cl.length) return 'none';
  if (cl.length > 1 && cl.filter(c => c.stage >= 5).length > 1) return 'disputed';
  return cl.some(c => c.stage >= 5) ? 'pioneering' : 'declared';
}
/** StarSystem.terr (public, replicated with the system — fog hides it with the system) and Company.sovx */
export function publish(h: Host) {
  const w = h.st, s = S(w);
  for (const r of Object.values(s.sys)) {
    const sys = w.systems[r.id]; if (!sys) continue;
    const wars = Object.values(s.wars).filter(x => x.sys === r.id && x.status !== 'ended');
    const top = Object.entries(r.ctl).filter(([, v]) => v >= 5).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, v]) => ({ p, ctl: Math.round(v) }));
    const pub: TerrPub = {
      ...(r.owner ? { owner: r.owner, ownerName: w.companies[r.owner]?.name, how: r.how, stab: Math.round(r.stab), pol: { ...r.policy, price: { ...r.policy.price } } } : {}),
      status: statusOf(w, r), cls: regionClass(w, sys),
      claims: Object.values(r.claims).map(c => ({ co: c.co, name: w.companies[c.co]?.name ?? c.co, stage: c.stage })),
      ...(top.length ? { top } : {}),
      ...(wars.length ? { war: wars.map(x => ({ id: x.id, att: x.att, def: x.def, status: x.status })) } : {}),
      ...(r.occ ? { occ: { by: r.occ.by, held: Math.round(r.occ.held / 60) * 60, need: holdNeed(w, s.wars[r.occ.war]) } } : {}),
    };
    const old = (sys as any).terr;
    if (pub.status === 'none' && !pub.top?.some(x => !x.p.startsWith('fac:') && x.p !== 'pirates')) { if (old) delete (sys as any).terr; continue; }
    if (!old || JSON.stringify(old) !== JSON.stringify(pub)) (sys as any).terr = pub;
  }
  // per-company reports, every 5 minutes (they are the owner's private data)
  if (Math.floor(h.time / 300) === Math.floor((h.time - SOV.cycle) / 300) && !Object.values(w.companies).some(c => c.kind === 'player' && !c.sovx)) return;
  for (const c of Object.values(w.companies)) if (c.kind === 'player') c.sovx = sovReport(h, c.id);
}

/** the company's territory screen: its territories, its claims, and systems where it has a foothold */
export function sovReport(h: Host, co: string): SovX {
  const w = h.st, s = S(w), rows: SovRow[] = [], alerts: string[] = [];
  for (const r of Object.values(s.sys)) {
    const sys = w.systems[r.id]; if (!sys) continue;
    const mine = r.owner === co, claim = r.claims[co];
    const stage = mine ? 8 : claim ? claim.stage : stageOf(h, co, r.id);
    if (!mine && !claim && stage < 2) continue;
    const cls = regionClass(w, sys);
    const rep = evaluate(h, co, r.id);
    const G = govStation(h, co, r.id) ?? ownStations(h, co, r.id).sort((a, b) => sizeRank(b.size) - sizeRank(a.size))[0];
    const ss = supplyStats(r, co, h.time), L = r.gov?.[co];
    const led = r.led.filter(x => x.h > hourOf(h.time) - 24);
    const income = { tax: 0, toll: 0, permit: 0, up: 0 }; if (mine) for (const x of led) { income.tax += x.tax; income.toll += x.toll; income.permit += x.permit; income.up += x.up; }
    rows.push({
      sys: r.id, name: sys.name, cls, stage, status: statusOf(w, r), owner: r.owner,
      ...(claim ? { claim: { at: claim.at, prog: Math.round(claim.prog), need: CLASS[cls].stabH * 3600, legit: claim.legit } } : {}),
      rep, ctl: Math.round((r.ctl[co] ?? 0) * 10) / 10, ...(mine ? { stab: Math.round(r.stab), arrears: Math.round(r.arrears), policy: r.policy, permits: r.permits } : {}),
      power: Math.round(powerIn(h, co, r.id)), needPower: powerNeed(h, co, r.id), upkeep: upkeepOf(h, co, r.id), income,
      ...(G && builtN(G, 'governance') ? { supply: { in: Math.round(ss.inV), need: Math.round(ss.needV), stock: L?.stock ?? {}, demand: supplyNeed(cls), reserved: L?.res ?? {}, lack: L?.lack ?? {}, stalled: Math.round(L?.short ?? 0) } } : {}),
      facilities: { gov: G && builtN(G, 'governance') ? G.id : undefined, station: G?.id, size: G?.size, defense: G ? builtN(G, 'defense') : 0, power: !!G && stationSupportOnline(G) },
      rivals: [...Object.values(r.claims).filter(c => c.co !== co).map(c => ({ co: c.co, name: w.companies[c.co]?.name ?? c.co, ctl: Math.round(r.ctl[c.co] ?? 0), stage: c.stage })),
        ...Object.entries(r.ctl).filter(([p]) => p !== co && !r.claims[p] && (r.ctl[p] ?? 0) >= 10).map(([p, v]) => ({ co: p, name: partyName(w, p), ctl: Math.round(v), stage: p === r.owner ? 8 : 0 }))],
      ...(r.occ ? { occ: { by: r.occ.by, held: Math.round(r.occ.held), need: holdNeed(w, s.wars[r.occ.war]) } } : {}),
    });
    if (mine && r.stab < 60) alerts.push(`${sys.name} 안정도 ${Math.round(r.stab)} — ${r.arrears > 0 ? '유지비 체납' : '조건 미달'}`);
    if (mine && r.occ) alerts.push(`${sys.name} 점령됨 — 탈환 필요`);
    if (mine && r.disputeT !== undefined) alerts.push(`${sys.name} 분쟁 중`);
  }
  const wars = Object.values(s.wars).filter(x => (x.att === co || x.def === co) && (x.status !== 'ended' || h.time - (x.end?.t ?? 0) < 86400));
  for (const x of wars) if (x.status !== 'ended') alerts.push(`${w.systems[x.sys].name} 영토 전쟁 ${x.status === 'notice' ? `예고 (${Math.ceil((x.start - h.time) / 60)}분 후 개전)` : '진행 중'}`);
  const treaties = Object.values(s.treaties).filter(t => (t.to === co || t.from === co) && (t.status === 'offer' || h.time - t.at < 86400));
  for (const t of treaties) if (t.status === 'offer' && t.to === co) alerts.push(`${w.systems[t.sys].name} ${TREATY_NAME[t.kind]} 조약 제안 도착`);
  return { t: h.time, rows: rows.sort((a, b) => b.stage - a.stage || (a.name < b.name ? -1 : 1)), wars, treaties, alerts };
}

// ───────────────────────────────────────────────────────────── commands

export type SovCmd = { c: 'sov'; op: 'declare' | 'withdraw' | 'policy' | 'grant' | 'permit' | 'negotiate' | 'war' | 'impose' | 'propose' | 'answer' | 'guard' | 'warContract';
  sys?: string; war?: string; treaty?: string; kind?: string; to?: string; pay?: number; accept?: boolean; policy?: Partial<SovPolicy>; target?: string; on?: boolean; hours?: number; reward?: number };
export function sovCommand(h: Host, co: string, cmd: SovCmd): string | null {
  const w = h.st; if (!sovOn(w)) return '이 월드에는 영유권 체계가 없습니다';
  const c = w.companies[co]; if (!c || c.kind !== 'player') return '명령 불가';
  const sys = typeof cmd.sys === 'string' && w.systems[cmd.sys] ? cmd.sys : undefined;
  let r: string | null;
  switch (cmd.op) {
    case 'declare': r = sys ? sovDeclare(h, co, sys) : '성계 오류'; break;
    case 'withdraw': r = sys ? sovWithdraw(h, co, sys) : '성계 오류'; break;
    case 'policy': r = sys ? sovPolicy(h, co, sys, cmd.policy) : '성계 오류'; break;
    case 'grant': r = sys ? sovGrant(h, co, sys, cmd.kind, cmd.target, cmd.on) : '성계 오류'; break;
    case 'permit': r = sys ? sovBuyPermit(h, co, sys, cmd.kind) : '성계 오류'; break;
    case 'negotiate': r = sys ? sovNegotiate(h, co, sys) : '성계 오류'; break;
    case 'war': r = sys ? sovDeclareWar(h, co, sys) : '성계 오류'; break;
    case 'impose': r = typeof cmd.war === 'string' ? sovImpose(h, co, cmd.war) : '전쟁 오류'; break;
    case 'propose': r = sovPropose(h, co, cmd.kind, cmd.sys, cmd.to, cmd.pay); break;
    case 'answer': r = sovAnswer(h, co, cmd.treaty, cmd.accept); break;
    case 'guard': r = sys ? sovPostGuard(h, co, sys, cmd.hours, cmd.reward) : '성계 오류'; break;
    case 'warContract': r = typeof cmd.war === 'string' ? sovPostWarContract(h, co, cmd.war, cmd.hours, cmd.reward) : '전쟁 오류'; break;
    default: r = '알 수 없는 영토 명령';
  }
  if (!r) c.sovx = sovReport(h, co);
  return r;
}

// ───────────────────────────────────────────────────────────── B-2 contracts: territory guard and war service

/** a claimant / sovereign hires another company's warships to guard its system (paid from its own credits, escrowed) */
export function sovPostGuard(h: Host, co: string, sysId: string, hours: unknown, reward: unknown): string | null {
  const w = h.st, c = w.companies[co], r = rec(w, sysId);
  if (!w.milV) return '군사 계약 월드가 아닙니다';
  if (!r.claims[co] && r.owner !== co) return '자사가 주장하거나 영유한 성계에만 경비 계약을 게시할 수 있습니다';
  const hr = typeof hours === 'number' && Number.isFinite(hours) ? Math.round(hours) : NaN;
  if (!(hr >= 1 && hr <= 12)) return '근무 시간은 1~12시간';
  const payN = typeof reward === 'number' && Number.isFinite(reward) ? Math.floor(reward) : NaN;
  if (!(payN >= 2000 && payN <= 500000)) return '보수는 2,000 ~ 500,000 cr';
  if (c.credits < payN) return `자금 부족 — 보수 ${cr(payN)} cr를 예치해야 합니다`;
  const st = govStation(h, co, sysId) ?? ownStations(h, co, sysId)[0];
  const at = st?.pos ?? w.systems[sysId].origin;
  const board = Object.values(w.stations).filter(x => x.public && x.services.contracts).sort((x, y) => h.routeDistance(x.pos, at) - h.routeDistance(y.pos, at))[0];
  if (!board) return '계약을 게시할 정거장이 없습니다';
  const base = Math.round(payN * 0.75), bonus = payN - base;
  let id = '';
  watchMoney(w, 'contract_escrow', { company: co, station: board.id }, () => {
    c.credits -= payN;
    id = h.offerContract({ stationId: board.id, kind: 'mil', title: `영토 경비: ${c.name} · ${w.systems[sysId].name}`, desc: `${c.name}의 ${w.systems[sysId].name} ${st ? st.name + ' ' : ''}주변을 ${hr}시간 경비. 수주 함대는 계약 기간 동안 의뢰사의 영토 군사력·지배력으로 집계되고, 이 성계의 영토 전쟁에서는 방어 측으로 교전합니다. 보수는 의뢰사가 예치 — 기본 ${cr(base)} + 성과 ${cr(bonus)} cr.`, reward: payN, rep: 0, escrow: payN,
      mil: { type: 'defend', sys: sysId, at: { ...at }, radius: 2500, dur: hr * 3600, poster: co, src: 'poster', base, bonus, risk: 1 + (100 - effSec(w.systems[sysId])) / 80, est: hr * 3600, power: Math.round(SOV.power * 0.4), jumps: 0 } } as Omit<Contract, 'id' | 'progress' | 'expires' | 'takenBy' | 'done'>, 3600);
  });
  h.ev('info', `영토 경비 계약 게시: ${w.systems[sysId].name} ${hr}시간 (예치 ${cr(payN)} cr, ${board.name} 게시판)`, { company: co, tag: 'sov' });
  return id ? null : '게시 실패';
}
/** a side of a formal war hires warships against the enemy's military in that system only (legal targets) */
export function sovPostWarContract(h: Host, co: string, warId: string, hours: unknown, reward: unknown): string | null {
  const w = h.st, c = w.companies[co], war = w.sov?.wars[warId];
  if (!w.milV) return '군사 계약 월드가 아닙니다';
  if (!war || war.status === 'ended' || (war.att !== co && war.def !== co)) return '자사가 당사자인 영토 전쟁이 아닙니다';
  const hr = typeof hours === 'number' && Number.isFinite(hours) ? Math.round(hours) : NaN;
  if (!(hr >= 1 && hr <= 12)) return '작전 시간은 1~12시간';
  const payN = typeof reward === 'number' && Number.isFinite(reward) ? Math.floor(reward) : NaN;
  if (!(payN >= 5000 && payN <= 1_000_000)) return '보수는 5,000 ~ 1,000,000 cr';
  if (c.credits < payN) return `자금 부족 — 보수 ${cr(payN)} cr를 예치해야 합니다`;
  const sys = w.systems[war.sys];
  const board = Object.values(w.stations).filter(x => x.public && x.services.contracts).sort((x, y) => h.routeDistance(x.pos, sys.origin) - h.routeDistance(y.pos, sys.origin))[0];
  if (!board) return '계약을 게시할 정거장이 없습니다';
  const enemy = partyName(w, war.att === co ? war.def : war.att);
  const base = Math.round(payN * 0.6), bonus = payN - base;
  let id = '';
  watchMoney(w, 'contract_escrow', { company: co, station: board.id }, () => {
    c.credits -= payN;
    id = h.offerContract({ stationId: board.id, kind: 'mil', title: `전쟁 계약: ${c.name} · ${sys.name}`, desc: `${sys.name} 영토 전쟁(${c.name} ↔ ${enemy})에서 ${hr}시간 작전. 교전 허가 범위: ${sys.name} 안의 ${enemy} 측 군사 목표만 (다른 성계·다른 회사·민간선은 대상 아님). 보수는 의뢰사가 예치 — 기본 ${cr(base)} + 성과 ${cr(bonus)} cr.`, reward: payN, rep: 0, escrow: payN, target: `war:${war.id}:${war.sys}`,
      mil: { type: 'strike', sys: war.sys, target: `war:${war.id}:${war.sys}`, tname: `${sys.name} 영토 전쟁`, dur: hr * 3600, poster: co, src: 'poster', base, bonus, risk: 2, est: hr * 3600, power: Math.round(SOV.power * 0.5), jumps: 0 } } as Omit<Contract, 'id' | 'progress' | 'expires' | 'takenBy' | 'done'>, 3600);
  });
  wlog(war, h.time, `${c.name} 전쟁 계약 게시 (${hr}시간, ${cr(payN)} cr)`);
  return id ? null : '게시 실패';
}
