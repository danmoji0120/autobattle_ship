// P14.0 reputation (repV worlds only — new worlds opt in, existing saves only through an explicit migration).
//
// Four separate things that used to be mixed:
//   A. company credit   — `Company.rep`, redefined on repV worlds as the company's public business credit
//                         (0..100): contracts honoured, pirates hunted, honest trade. Gates commercial licences
//                         and, where no territorial faction exists, the public yards.
//   B. faction trust     — `Company.standing[faction]` (−100..100) for each of the six P10 factions, each on its own.
//                         Nothing raises one faction because another rose; the only cross effect is the explicit
//                         rule that hunting pirates lowers the pirates' trust.
//   C. influence         — `StarSystem.inf` / `StarSystem.faction`: who controls the territory. It decides *where*
//                         a faction sells, never *whom* it trusts.
//   D. crime             — law.ts cases / wanted level. Each crime event reaches reputation exactly once (keyed),
//                         and repeated serious crimes leave a grudge that slows recovery.
//
// Growth: every gain is a base amount × faction personality × band multiplier (diminishing), limited per source and
// per game hour, limited per source to a ceiling (routine work cannot carry a company to the top), and the upper bands
// need a record — contracts for that faction, time in the relationship, major operations — that repetition alone
// cannot provide. Losses are not diminished.
//
// Pure helpers (bands, requirements, gates) are shared with the client; the state changes run on the server.
import type { Company, Station, StarSystem, WorldState } from './types';
import { FACTIONS } from './territory';
import { ITEMS, EQUIPMENT } from './industry';
import { emit } from './observe';

export const CREDIT = 'credit';
export type RepSrc = 'trade' | 'delivery' | 'bounty' | 'kill' | 'lair' | 'lair_contract' | 'blackmarket';
export type RepOffense = 'smuggling' | 'salvage' | 'extortion' | 'strike' | 'guard_attack' | 'flee' | 'resist';

export interface RepAcc {
  /** weighted net trade value not yet converted into trust (sales − purchases at this scope's markets) */
  net?: number;
  /** game-hour window index and the base amount each source has used in it */
  w?: number; got?: Partial<Record<RepSrc, number>>;
  /** first positive contact (relationship age is measured from here) */
  since?: number;
  /** record: contracts completed for this scope, major operations (tier ≥ 3 lairs) */
  k?: number; mj?: number;
  /** recent offence weight (halves every OFF_HALF seconds) and when it was last updated */
  off?: number; offT?: number;
  /** grudge: gains are reduced until this time */
  gr?: number;
}
export interface RepLog { t: number; s: string; d: number; why: string }
export interface CoRep {
  acc: Record<string, RepAcc>;
  log: RepLog[];
  /** event keys already applied (one battle, one lair, one contract → one change) */
  keys: string[];
  /** crime events growing over time (salvage per site, …): cumulative value and what was already charged */
  cases: Record<string, { v: number; d: number; t: number; m?: number }>;
  /** the pre-migration company reputation (legacy scale), kept for audit and rollback */
  legacy?: number;
  /** migration grace: purchase rights the company held under the old rule (keys `bp:<id>` / `hull:<id>`) */
  grand?: { until: number; keys: string[] };
}

export const REP = {
  bands: [
    { min: -100, name: '극단적 적대' }, { min: -60, name: '적대' }, { min: -25, name: '불신' }, { min: 0, name: '중립' },
    { min: 10, name: '협력' }, { min: 25, name: '우호' }, { min: 40, name: '신뢰' }, { min: 60, name: '핵심 협력사' }, { min: 80, name: '최고 신뢰' },
  ],
  /** gain multiplier by current value: the first band (0..9) is quick, later bands slower; negative values recover at
   *  the base rate (unless there is a grudge) — the 24 h runs showed 15 game hours to credit 10 without the early boost */
  dim: [{ min: 80, m: 0.08 }, { min: 60, m: 0.15 }, { min: 40, m: 0.28 }, { min: 25, m: 0.45 }, { min: 10, m: 0.7 }, { min: 0, m: 1.6 }, { min: -1e9, m: 1 }],
  /** a civilian hull at a public yard needs at most this much company credit */
  civilMax: 5,
  /** base amounts (at multiplier 1) */
  base: {
    /** per this much weighted net trade value → `trade` points */
    tradePer: 10000, trade: 0.05,
    delivery: 0.5, bounty: 0.6, lairContract: 0.8,
    /** per pirate hull destroyed (by damage share): hull cost / killDiv, clamped */
    killDiv: 500, killMin: 0.08, killMax: 0.5,
    /** lair destroyed (by damage share): by tier */
    lair: [0, 1, 1.6, 2.4, 3.2, 4],
    /** a pirate black market sale: per this much value → blackmarket points */
    bmPer: 10000, bm: 0.05,
  },
  /** base amount each source may contribute per scope per game hour */
  hourCap: { trade: 0.6, delivery: 2, bounty: 2, kill: 1.2, lair: 8, lair_contract: 3, blackmarket: 0.6 } as Record<RepSrc, number>,
  /** a source never lifts a value above its ceiling (routine work stops at 우호/신뢰 lower bands) */
  ceiling: { trade: 20, blackmarket: 20, delivery: 40, bounty: 40, kill: 40, lair_contract: 59.99, lair: 100 } as Record<RepSrc, number>,
  /** entering these bands needs a record (contracts for this scope, game hours since first contact, major operations) */
  gates: [
    { at: 40, contracts: 8, hours: 4, majors: 0 },
    { at: 60, contracts: 20, hours: 12, majors: 2 },
    { at: 80, contracts: 40, hours: 30, majors: 5 },
  ],
  /** company credit earns this share of the base (and has no faction personality) */
  creditMul: 0.6,
  /** credit floor (company credit is never negative, like the legacy reputation) */
  creditMin: 0,
  /** contract expired while taken */
  failCredit: 0.6, failTrust: 0.5,
  /** offences: trust loss = base + value / per, capped; credit loss = trust loss × creditShare */
  offense: {
    smuggling: { base: 0.5, per: 4000, cap: 6, serious: false },
    salvage: { base: 0.3, per: 3000, cap: 5, serious: false },
    extortion: { base: 2, per: 5000, cap: 10, serious: false },
    strike: { base: 8, per: 0, cap: 8, serious: true },
    guard_attack: { base: 15, per: 0, cap: 15, serious: true },
    flee: { base: 3, per: 0, cap: 3, serious: false },
    resist: { base: 10, per: 0, cap: 10, serious: true },
  } as Record<RepOffense, { base: number; per: number; cap: number; serious: boolean }>,
  creditShare: 0.5,
  /** repeat offences: loss × (1 + offStep × recent weight), capped; weight halves every offHalf seconds */
  offStep: 0.35, offMulMax: 2.5, offHalf: 7200,
  /** serious offence → gains × grudgeMul for grudgeBase × (1 + weight) seconds (capped) */
  grudgeMul: 0.35, grudgeBase: 3600, grudgeMax: 6 * 3600,
  /** an extortion above this value counts as serious */
  seriousValue: 20000,
  logMax: 40, keysMax: 240, caseLife: 6 * 3600,
  /** at most this many crime events are tallied per company (oldest dropped first; P14.0 perf run: 5,000 → 0.57 ms per call) */
  casesMax: 120,
  /** migration grace for purchase rights held under the old rule */
  graceSec: 24 * 3600,
};

/** faction personality: how much each kind of work matters to it (absent = 1, 0 = it does not care) */
export const FACTION_WEIGHT: Record<string, Partial<Record<RepSrc, number>>> = {
  union: { trade: 0.6, delivery: 1, bounty: 1.3, kill: 1.2, lair: 1.3, lair_contract: 1.2, blackmarket: 0 },
  guild: { trade: 1.3, delivery: 1.3, bounty: 0.8, kill: 0.7, lair: 0.8, lair_contract: 0.8, blackmarket: 0 },
  ceres: { trade: 1.1, delivery: 1.3, bounty: 0.6, kill: 0.5, lair: 0.7, lair_contract: 0.7, blackmarket: 0 },
  miners: { trade: 1, delivery: 1.2, bounty: 0.9, kill: 0.9, lair: 1, lair_contract: 1, blackmarket: 0 },
  iron: { trade: 0.6, delivery: 1, bounty: 1.2, kill: 1.3, lair: 1.4, lair_contract: 1.3, blackmarket: 0 },
  // pirates: only work that actually helps them (their markets, their contracts, the black market); crime alone does nothing
  pirates: { trade: 0.8, delivery: 1, bounty: 0, kill: 0, lair: 0, lair_contract: 0, blackmarket: 1 },
};
/** what each faction's markets value most (item category → weight) */
export const FACTION_GOODS: Record<string, Partial<Record<string, number>> & { other: number }> = {
  union: { equip: 1.4, shippart: 1.1, other: 0.8 },
  guild: { other: 1 },
  ceres: { raw: 1.3, refined: 1.4, part: 1.1, other: 0.7 },
  miners: { part: 1.4, refined: 1.1, raw: 0.6, other: 0.9 },
  iron: { shippart: 1.5, equip: 1.3, other: 0.7 },
  pirates: { other: 1 },
};
/** region bonus for fighting pirates (iron guards the borders, the miners their fields) */
const REGION_KILL: Record<string, Partial<Record<string, number>>> = { iron: { border: 1.3 }, miners: { resource: 1.3 }, union: { capital: 1.1, industrial: 1.1 } };

export const repOn = (w: Pick<WorldState, 'repV'>) => w.repV === 1;
export const bandOf = (v: number) => { let b = REP.bands[0]; for (const x of REP.bands) if (v >= x.min) b = x; return b; };
export const dimOf = (v: number) => REP.dim.find(d => v >= d.min)!.m;
export const scopeName = (s: string) => s === CREDIT ? '회사 신용도' : `${FACTIONS[s]?.name ?? s} 신뢰도`;
export const valueOf = (co: Company, s: string) => s === CREDIT ? co.rep : co.standing?.[s] ?? 0;
const itemCat = (k: string) => ITEMS[k]?.cat ?? (EQUIPMENT[k] ? 'equip' : 'other');
export const goodsWeight = (faction: string, item: string) => { const g = FACTION_GOODS[faction] ?? { other: 1 }; return g[itemCat(item)] ?? g.other; };

/** Legacy reputation (unbounded, thresholds 0…150, 999 = never) → the 0..100 scale. Monotonic, so a company that met
 *  a legacy threshold meets the mapped one: migration never takes a right away by itself. */
const MAP: [number, number][] = [[0, 0], [5, 5], [10, 10], [20, 16], [30, 24], [40, 32], [60, 42], [100, 60], [150, 80], [300, 92], [999, 100]];
export function mapLegacy(rep: number): number {
  if (!(rep > 0)) return 0;
  for (let i = 1; i < MAP.length; i++) if (rep <= MAP[i][0]) { const [a, x] = MAP[i - 1], [b, y] = MAP[i]; return Math.round((x + (y - x) * (rep - a) / (b - a)) * 100) / 100; }
  return 100;
}

export const coRep = (co: Company): CoRep => (co.repx ??= { acc: {}, log: [], keys: [], cases: {} });
const accOf = (co: Company, s: string) => (coRep(co).acc[s] ??= {});

/** requirement status of the next band above the current value (UI + gates) */
export interface NextReq { at: number; band: string; contracts: [number, number]; hours: [number, number]; majors: [number, number]; ok: boolean }
export function recordOf(w: Pick<WorldState, 'time'>, co: Company, s: string) {
  const a = co.repx?.acc[s] ?? {};
  const since = s === CREDIT ? co.createdAt : a.since;
  const contracts = s === CREDIT ? co.stats.contracts ?? 0 : a.k ?? 0;
  const majors = a.mj ?? 0;
  return { contracts, majors, hours: since === undefined ? 0 : Math.max(0, (w.time - since) / 3600) };
}
export function gateAt(w: Pick<WorldState, 'time'>, co: Company, s: string, at: number): NextReq | undefined {
  const g = REP.gates.find(x => x.at === at); if (!g) return undefined;
  const r = recordOf(w, co, s);
  const ok = r.contracts >= g.contracts && r.hours >= g.hours && r.majors >= g.majors;
  return { at: g.at, band: bandOf(g.at).name, contracts: [r.contracts, g.contracts], hours: [Math.floor(r.hours * 10) / 10, g.hours], majors: [r.majors, g.majors], ok };
}
export const nextReq = (w: Pick<WorldState, 'time'>, co: Company, s: string) => { const v = valueOf(co, s); const g = REP.gates.find(x => x.at > v); return g ? gateAt(w, co, s, g.at) : undefined; };
/** the highest value gains may reach now: the first gate above v whose record is not met (minus a hair) */
export function gainLimit(w: Pick<WorldState, 'time'>, co: Company, s: string, v: number): number {
  for (const g of REP.gates) if (g.at > v && !gateAt(w, co, s, g.at)!.ok) return g.at - 0.01;
  return 100;
}

function setValue(w: WorldState, co: Company, s: string, v: number) {
  if (s === CREDIT) co.rep = Math.max(REP.creditMin, Math.min(100, v));
  else (co.standing ??= {})[s] = Math.max(-100, Math.min(100, v));
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
function log(w: WorldState, co: Company, s: string, d: number, why: string) {
  const L = coRep(co).log;
  const last = L[L.length - 1];
  // consecutive small changes of the same kind within a minute are one line
  if (last && last.s === s && last.why === why && w.time - last.t < 60 && Math.sign(last.d) === Math.sign(d)) { last.d = r3(last.d + d); last.t = w.time; }
  else { L.push({ t: w.time, s, d: r3(d), why }); if (L.length > REP.logMax) L.splice(0, L.length - REP.logMax); }
}
/** key seen before → true (and remembered otherwise) */
function seen(co: Company, key: string | undefined): boolean {
  if (!key) return false;
  const K = coRep(co).keys;
  if (K.includes(key)) return true;
  K.push(key); if (K.length > REP.keysMax) K.splice(0, K.length - REP.keysMax);
  return false;
}
function decayOff(a: RepAcc, t: number) {
  if (a.off && a.offT !== undefined) a.off *= Math.pow(0.5, Math.max(0, t - a.offT) / REP.offHalf);
  a.offT = t;
  if ((a.off ?? 0) < 0.01) delete a.off;
}
const validScope = (w: WorldState, s: string) => s === CREDIT || !!w.factions?.[s];

/**
 * One gain on one scope. `base` is the amount at multiplier 1 before personality; returns what was applied.
 * Limits, in order: hourly budget of the source, personality, band multiplier, grudge, source ceiling, band gate.
 */
export function repGain(w: WorldState, coId: string, s: string, src: RepSrc, base: number, why: string, o: { mul?: number } = {}): number {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player' || !(base > 0) || !validScope(w, s)) return 0;
  const a = accOf(co, s);
  const win = Math.floor(w.time / 3600);
  if (a.w !== win) { a.w = win; a.got = {}; }
  const used = a.got?.[src] ?? 0, cap = REP.hourCap[src];
  const b = Math.min(base, Math.max(0, cap - used));
  if (b <= 0) return 0;
  (a.got ??= {})[src] = used + b;
  const pers = s === CREDIT ? REP.creditMul : FACTION_WEIGHT[s]?.[src] ?? 1;
  if (pers <= 0) return 0;
  const v = valueOf(co, s);
  let d = b * pers * (o.mul ?? 1) * dimOf(v);
  if ((a.gr ?? 0) > w.time) d *= REP.grudgeMul;
  const top = Math.min(REP.ceiling[src], gainLimit(w, co, s, v));
  d = Math.min(d, Math.max(0, top - v));
  if (d <= 1e-6) return 0;
  if (s !== CREDIT) a.since ??= w.time;
  setValue(w, co, s, v + d);
  log(w, co, s, d, why);
  emit(w, { kind: 'reputation', reason: `p14_${src}`, amount: d, company: coId, ref: s });
  return d;
}

/** a gain on the company credit and on one faction (the work's own faction), deduplicated by key */
export function repWork(w: WorldState, coId: string, faction: string | undefined, src: RepSrc, base: number, why: string, o: { key?: string; mul?: number; fmul?: number } = {}): { credit: number; trust: number } {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player' || seen(co, o.key)) return { credit: 0, trust: 0 };
  const credit = src === 'blackmarket' ? 0 : repGain(w, coId, CREDIT, src, base, why, { mul: o.mul });
  const trust = faction ? repGain(w, coId, faction, src, base, why, { mul: (o.mul ?? 1) * (o.fmul ?? 1) }) : 0;
  return { credit, trust };
}

/** a loss (not diminished): contract failures, pirates losing to the company */
export function repLoss(w: WorldState, coId: string, s: string, d: number, why: string): number {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player' || !(d > 0) || !validScope(w, s)) return 0;
  const v = valueOf(co, s);
  setValue(w, co, s, v - d);
  const got = v - valueOf(co, s);
  if (got > 1e-6) { log(w, co, s, -got, why); emit(w, { kind: 'reputation', reason: 'p14_loss', amount: -got, company: coId, ref: s }); }
  return got;
}

/** mark a record item (contract for a faction, a major operation) */
export function repRecord(w: WorldState, coId: string, s: string | undefined, what: 'k' | 'mj', key?: string) {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player' || !s || !validScope(w, s)) return;
  if (key && seen(co, `rec:${what}:${s}:${key}`)) return;
  const a = accOf(co, s);
  a[what] = (a[what] ?? 0) + 1;
  if (s !== CREDIT) a.since ??= w.time;
}

/**
 * A crime event. `key` identifies the event; a growing event (more cargo taken from the same site) passes its
 * cumulative `value` under the same key, and only the increase of the penalty is charged. Applied to the faction
 * holding the system (never the pirates) and to the company credit.
 */
/** keep the crime tally small: expired events go first, then the oldest (scanned only when a new event would exceed the cap) */
function pruneCases(R: CoRep, now: number) {
  const ks = Object.keys(R.cases);
  if (ks.length < REP.casesMax) return;
  for (const k of ks) if (now - R.cases[k].t > REP.caseLife) delete R.cases[k];
  const left = Object.entries(R.cases);
  if (left.length < REP.casesMax) return;
  left.sort((p, q) => p[1].t - q[1].t);
  for (const [k] of left.slice(0, left.length - REP.casesMax + 1)) delete R.cases[k];
}
export function repOffense(w: WorldState, coId: string, faction: string | undefined, kind: RepOffense, value: number, key: string, why: string): { trust: number; credit: number } {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player') return { trust: 0, credit: 0 };
  const R = coRep(co);
  if (!R.cases[key]) pruneCases(R, w.time);
  const c = (R.cases[key] ??= { v: 0, d: 0, t: w.time });
  const first = c.v === 0 && c.d === 0;
  c.v = Math.max(c.v, value); c.t = w.time;
  const o = REP.offense[kind];
  const full = Math.min(o.cap, o.base + (o.per > 0 ? c.v / o.per : 0));
  const serious = o.serious || (kind === 'extortion' && c.v >= REP.seriousValue);
  const f = faction && faction !== 'pirates' && w.factions?.[faction] ? faction : undefined;
  // the repeat multiplier is fixed at the event's first charge (a growing event or a repeated report never raises it)
  if (first) {
    let mul = 1;
    for (const s of [CREDIT, ...(f ? [f] : [])]) {
      const a = accOf(co, s); decayOff(a, w.time);
      mul = Math.max(mul, Math.min(REP.offMulMax, 1 + REP.offStep * (a.off ?? 0)));
      a.off = (a.off ?? 0) + (serious ? 2 : 1);
      if (serious) a.gr = Math.max(a.gr ?? 0, w.time + Math.min(REP.grudgeMax, REP.grudgeBase * (1 + a.off)));
    }
    c.m = mul;
  }
  const due = Math.max(0, full * (c.m ?? 1) - c.d);
  if (due <= 1e-6) return { trust: 0, credit: 0 };
  c.d += due;
  const trust = f ? repLoss(w, coId, f, due, why) : 0;
  const credit = repLoss(w, coId, CREDIT, due * REP.creditShare, why);
  return { trust, credit };
}

// ─────────────────────────────────────────────── trade (net, so splitting and buy/sell loops do not pay)

/** a sale or purchase at a public market: weighted net value accumulates; whole units become trust */
export function repTrade(w: WorldState, coId: string, st: Pick<Station, 'faction' | 'public'>, item: string, value: number, sell: boolean) {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player' || !st.public || !(value > 0)) return;
  const scopes: [string, number][] = [[CREDIT, 1]];
  if (st.faction && w.factions?.[st.faction]) scopes.push([st.faction, goodsWeight(st.faction, item)]);
  for (const [s, gw] of scopes) {
    const a = accOf(co, s);
    a.net = Math.max(-5 * REP.base.tradePer, (a.net ?? 0) + (sell ? 1 : -1) * value * gw);
    const n = Math.floor((a.net ?? 0) / REP.base.tradePer);
    if (n >= 1) { a.net! -= n * REP.base.tradePer; repGain(w, coId, s, 'trade', n * REP.base.trade, s === CREDIT ? '시장 거래' : '세력 시장 공급'); }
  }
}

/** a black-market sale helps the pirates (only them, and never the company credit) */
export function repBlackMarket(w: WorldState, coId: string, value: number) {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player' || !w.factions?.pirates || !(value > 0)) return;
  const a = accOf(co, 'pirates:bm');
  a.net = (a.net ?? 0) + value;
  const n = Math.floor(a.net / REP.base.bmPer);
  if (n >= 1) { a.net -= n * REP.base.bmPer; repGain(w, coId, 'pirates', 'blackmarket', n * REP.base.bm, '암시장 거래'); }
}

// ─────────────────────────────────────────────── combat

/** trust base for one destroyed pirate hull of this cost (sim/data ships `cost`) */
export const killBase = (cost: number) => Math.max(REP.base.killMin, Math.min(REP.base.killMax, cost / REP.base.killDiv));
/** pirates destroyed in one battle, settled once per battle and company (key = battle id) */
export function repBattle(w: WorldState, coId: string, battle: string, sys: StarSystem | undefined, costs: number[], share: number) {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player' || !(share > 0) || !costs.length || seen(co, `battle:${battle}`)) return;
  const base = costs.reduce((a, c) => a + killBase(c), 0) * share;
  const f = sys?.faction && sys.faction !== 'pirates' && w.factions?.[sys.faction] ? sys.faction : undefined;
  const fmul = f && sys?.region ? REGION_KILL[f]?.[sys.region] ?? 1 : 1;
  const why = `해적 ${costs.length}척 격침`;
  repGain(w, coId, CREDIT, 'kill', base, why);
  if (f) repGain(w, coId, f, 'kill', base, why, { mul: fmul });
  // explicit cross rule: the pirates remember who hunts them
  if (w.factions?.pirates) repLoss(w, coId, 'pirates', base, '해적 격침');
}
/** a lair destroyed (key = lair id + its destruction time) */
export function repLair(w: WorldState, coId: string, lairKey: string, sys: StarSystem | undefined, tier: number, share: number) {
  const co = w.companies[coId];
  if (!repOn(w) || !co || co.kind !== 'player' || !(share > 0) || seen(co, `lair:${lairKey}`)) return;
  const base = (REP.base.lair[Math.max(1, Math.min(5, tier))] ?? 1.6) * share;
  const f = sys?.faction && sys.faction !== 'pirates' && w.factions?.[sys.faction] ? sys.faction : undefined;
  const why = `해적 거점 파괴 (등급 ${tier})`;
  // a tier ≥ 3 lair taken with a real share of the fighting is a major operation (the record the top bands need)
  if (tier >= 3 && share >= 0.25) { repRecord(w, coId, CREDIT, 'mj', lairKey); if (f) repRecord(w, coId, f, 'mj', lairKey); }
  repGain(w, coId, CREDIT, 'lair', base, why);
  if (f) repGain(w, coId, f, 'lair', base, why);
  if (w.factions?.pirates) repLoss(w, coId, 'pirates', base * 2, '해적 거점 파괴');
}

// ─────────────────────────────────────────────── contracts

/** a completed contract: record + trust with the issuing station's faction (key = contract id) */
export function repContract(w: WorldState, coId: string, k: { id: string; kind: string; stationId: string; res?: string; reward: number }) {
  if (!repOn(w)) return;
  const st = w.stations[k.stationId];
  const f = st?.faction && w.factions?.[st.faction] ? st.faction : undefined;
  repRecord(w, coId, f, 'k', k.id);
  const src: RepSrc = k.kind === 'delivery' ? 'delivery' : k.kind === 'bounty' ? 'bounty' : 'lair_contract';
  const base = src === 'delivery' ? REP.base.delivery : src === 'bounty' ? REP.base.bounty : REP.base.lairContract;
  // a delivery of what the issuer's faction values most counts for more with it
  const fmul = f && src === 'delivery' && k.res ? goodsWeight(f, k.res) : 1;
  repWork(w, coId, f, src, base, `계약 완수 (${k.kind === 'delivery' ? '납품' : k.kind === 'bounty' ? '현상금' : '토벌'})`, { key: `contract:${k.id}`, fmul });
}
export function repContractFailed(w: WorldState, coId: string, k: { id: string; stationId: string }) {
  if (!repOn(w)) return;
  const co = w.companies[coId]; if (!co || seen(co, `fail:${k.id}`)) return;
  repLoss(w, coId, CREDIT, REP.failCredit, '계약 기한 만료');
  const f = w.stations[k.stationId]?.faction;
  if (f && w.factions?.[f]) repLoss(w, coId, f, REP.failTrust, '계약 기한 만료');
}

// ─────────────────────────────────────────────── gates (shared with the client)

export const graceHas = (w: Pick<WorldState, 'time'>, co: Company, key: string) => { const g = co.repx?.grand; return !!g && g.until > w.time && g.keys.includes(key); };
/** what a legacy reputation threshold means on a repV world */
export const repNeed = (legacyRep: number | undefined) => mapLegacy(legacyRep ?? 0);
export const fmtRep = (v: number) => (Math.floor(v * 10) / 10).toString();

/**
 * Buying a finished hull at a public yard (repV): civilian hulls need little company credit; military hulls need the
 * yard's faction trust (P10), or company credit where there are no territorial factions.
 */
export function hullGate(w: WorldState, co: Company, st: Pick<Station, 'faction'>, hullId: string, legacyRep: number | undefined, military: boolean): string | null {
  const need = repNeed(legacyRep);
  if (need <= 0 || graceHas(w, co, `hull:${hullId}`)) return null;
  if (!military) { const n = Math.min(REP.civilMax, need); return co.rep < n ? `회사 신용도 ${fmtRep(n)} 필요 (현재 ${fmtRep(co.rep)})` : null; }
  if (w.factions && st.faction && w.factions[st.faction]) {
    const t = co.standing?.[st.faction] ?? 0;
    return t < need ? `${FACTIONS[st.faction]?.name ?? st.faction} 신뢰도 ${fmtRep(need)} 필요 (현재 ${fmtRep(t)}) — 군용 선체는 판매 세력의 신뢰가 필요합니다` : null;
  }
  return co.rep < need ? `회사 신용도 ${fmtRep(need)} 필요 (현재 ${fmtRep(co.rep)})` : null;
}

// ─────────────────────────────────────────────── migration

/** opt-in conversion of an existing growth world. Idempotent; keeps every asset; legacy reputation is kept in repx.legacy */
export function enableRepV(w: WorldState, o: { migrate: boolean; grant?: (co: Company) => string[] } = { migrate: false }): { companies: number; mapped: Record<string, [number, number]> } | null {
  if (w.repV) return null;
  w.repV = 1;
  const mapped: Record<string, [number, number]> = {};
  let n = 0;
  for (const co of Object.values(w.companies)) {
    if (co.kind !== 'player') continue;
    n++;
    const R = coRep(co);
    if (o.migrate) {
      R.legacy ??= co.rep;
      const v = mapLegacy(R.legacy);
      mapped[co.id] = [R.legacy, v];
      co.rep = v;
      const keys = o.grant?.(co) ?? [];
      if (keys.length) R.grand = { until: w.time + REP.graceSec, keys };
      // existing faction trust is kept as it is; the relationship age starts at migration for factions already met
      for (const [f, t] of Object.entries(co.standing ?? {})) if (t > 0) accOf(co, f).since ??= w.time;
    }
  }
  return { companies: n, mapped };
}
