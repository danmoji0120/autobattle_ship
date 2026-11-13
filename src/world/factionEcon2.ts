// Faction economy v2: large, sustained faction economies (opt-in, isolated P10 worlds only).
//
// Active only when `w.factionEcon === 2` (WorldSim.create(seed, { layout: 'p10', factionEcon: 'v2' })).
// Worlds without it (c0, P9, existing P10 saves) keep the v1 rules in factionEcon.ts unchanged.
//
// Every faction is an aggregate economy derived from its territory, not a fixed consumption table:
//   size      territory weight (region types of the systems it holds)
//   civ/ind/mun  civilian economy, industrial and munitions capacity = size × faction profile × dev
//   dev       development level, raised only by modernization (real goods), lowered by war damage
//   eff       efficiency 0.35..1: follows how well civilian demand and infrastructure upkeep are supplied
//   rdy       military readiness 0..1: follows how well fleet upkeep (and war munitions) are supplied
//   budget    finite treasury: income from its economy and its exports, spent on market purchases
//
// Each 60 s cycle (fixed cadence; rates are per hour × cycle length, so the result does not depend on
// the simulation tick) a faction:
//   1. extracts raw goods and runs its aggregate industry (real recipe inputs → outputs) into its stockpile
//   2. consumes from the stockpile: civilian demand, infrastructure upkeep, fleet upkeep, war munitions
//   3. runs programs from the stockpile: rebuild lost strength, (re)construct infrastructure, modernize
//   4. buys what its stockpile is short of from public markets (own territory first, then reachable
//      partners through open gates), paying from its budget; the payment goes to the selling station's
//      NPC buying budget (`funds`), so a station that sold the faction goods can buy again from players
//   5. sells real surplus into markets below target (own first, then partners in reach; paid by the station)
// Shortage is real: unmet demand lowers efficiency (production and income), readiness (strength decays,
// war losses rise) and leaves rebuilding/construction undone. Nothing is created except raw extraction
// and recipe outputs, both recorded in the faction ledger; nothing is consumed without being recorded.
//
// Markets: in faction territory the goods this module manages (FE_GOODS) no longer refill or vanish by
// themselves (market.ts driftV3 / economy.ts profile make/use are skipped for them); their stock moves
// only through players, station conversion recipes and this module. Other goods keep the old rules.
import type { Cargo, Market, Station, StarSystem, WorldState } from './types';
import { addc, qty } from './types';
import { FACTIONS, type Conflict, type FactionState, type RegionKind } from './territory';
import { conflicts, doctrineOf, atWar, INFRA_RECIPE, type EconHost } from './factionEcon';
import { gateOpen } from './territory';
import { RECIPES, ITEMS } from './industry';
import { priceOf } from './market';
import { growthOn } from './hullops';
import { emit } from './observe';

export const FE_VERSION = 2;
/** cycle length (s). Rates are per hour, so changing it changes granularity, not totals. */
export const FE_CYCLE = 60;

export interface FactionLedger {
  /** credits: economy income, export sales, purchases paid, purchase cost that did not reach a station budget */
  income: number; exportRev: number; spent: number; sunk: number;
  /** treasury above its cap handed to the faction's own stations' NPC buying budgets (civilian spending) */
  grants?: number;
  /** goods: raw extraction, recipe outputs, recipe inputs, final consumption, purchases, export sales, unmet demand */
  extracted: Cargo; made: Cargo; inputs: Cargo; used: Cargo; bought: Cargo; exported: Cargo; short: Cargo;
  /** subsets of `used` by purpose */
  war: Cargo; rebuild: Cargo; build: Cargo; modern: Cargo; upkeep: Cargo; civ: Cargo; maint: Cargo;
  /** subset of `bought` that came from markets of other factions */
  imported: Cargo;
  lostStr: number; builtStr: number; builtInfra: number; infraLost: number; devGain: number;
  /** stockpile when v2 started:
   *  stock = opening + extracted + made − inputs + bought + seized + salvaged − used − exported − lost */
  opening: Cargo;
  /** goods destroyed or seized outside the economy (raids, blockades; `writeOff`) */
  lost?: Cargo;
  /** raider factions: goods taken from neighbours' stockpiles (the victim records the same goods as `lost`) */
  seized?: Cargo;
  /** raider factions: material recovered from wrecks of a fight they took part in */
  salvaged?: Cargo;
}
export interface FactionEconState {
  dev: number; eff: number; rdy: number; budget: number;
  /** seconds of post-war reconstruction priority left */
  recon: number;
  /** goods this faction is shortest of after its last purchases: [item, units missing from its stock target] */
  hot?: [string, number][];
  led: FactionLedger;
}

const emptyLedger = (): FactionLedger => ({ income: 0, exportRev: 0, spent: 0, sunk: 0, extracted: {}, made: {}, inputs: {}, used: {}, bought: {}, exported: {}, short: {},
  war: {}, rebuild: {}, build: {}, modern: {}, upkeep: {}, civ: {}, maint: {}, imported: {}, lostStr: 0, builtStr: 0, builtInfra: 0, infraLost: 0, devGain: 0, opening: {} });

// ───────────────────────────────────────────────────────────── per-faction profiles (tuning lives here)

/** territory weight of a system by region type */
export const REGION_WEIGHT: Record<RegionKind, number> = { capital: 4, industrial: 3, resource: 2, border: 1.5, neutral: 2.5, lawless: 1.5, uncharted: 1 };
/** global scale of every flow below (one knob for overall economy size) */
export const FE_SCALE = 100;

interface Profile {
  /** civilian economy / industrial / munitions capacity per size unit */
  civ: number; ind: number; mun: number;
  /** raw extraction per size unit per hour (× FE_SCALE) */
  mine: Cargo;
  /** aggregate industry: output units per hour per capacity unit (× FE_SCALE), by recipe id */
  sectors: Record<string, number>;
  /** income per civ unit per hour, as a multiple of TAX_BASE × FE_SCALE */
  tax: number;
  /** how far (jumps) it buys from partner markets, and the logistics surcharge per jump */
  reach: number;
  /** unstable supply base (pirates): production/extraction swings cycle to cycle */
  unstable?: boolean;
  /** raider economy (pirates): smuggles through embargoes, raids hostile neighbours, salvages wrecks */
  raider?: boolean;
}
export const PROFILES2: Record<string, Profile> = {
  // large civilian economy; security and administration; chemicals/electronics industry
  union: { civ: 1.2, ind: .45, mun: .15, mine: { gas: 5, silicate: 2.5, ore: 2 }, sectors: { chemicals: 8, silicon: 4, electronics: 1.2, metal: 4, alloy: 2 }, tax: 1.0, reach: 4 },
  // trade and logistics; varied light industry; buys from the furthest
  guild: { civ: 1.0, ind: .35, mun: .1, mine: { ore: 3, gas: 3 }, sectors: { metal: 6, chemicals: 5, machinery: 1.2 }, tax: 1.15, reach: 6 },
  // heavy industry: eats ore/titanium ore/metal, makes alloy, structure, machinery, precision, engines
  ceres: { civ: .6, ind: 1.2, mun: .2, mine: { ore: 1 }, sectors: { metal: 13, titanium: 5, alloy: 12, structure: 2.2, machinery: 1.2, precision: .8, engine: .015 }, tax: 1.5, reach: 4 },
  // raw-material exporter; imports machinery, chemicals, electronics
  miners: { civ: .5, ind: .25, mun: .1, mine: { ore: 20, titanium_ore: 12, rare_ore: .5, silicate: 2, gas: 3 }, sectors: { metal: 3, titanium: 4 }, tax: .9, reach: 4 },
  // munitions, armour plate and ship parts in bulk; refines its own titanium for armour plate from imported
  // titanium ore (ceres uses all of its titanium for alloy); imports alloy, titanium ore, precision, chemicals
  iron: { civ: .5, ind: .5, mun: 1.2, mine: { ore: .5 }, sectors: { titanium: 1, armor_plate: .45, weapon_parts: .45, structure: 1.2, eq_autocannon: .05, eq_medium_gun: .02, mod_armor: .01 }, tax: 3.5, reach: 4 },
  // raiders: munitions and repair goods, crystal/rare ore, unstable base
  pirates: { civ: .4, ind: .15, mun: .5, mine: { crystal: .6, rare_ore: .6, ore: 1.5, gas: 2 }, sectors: { chemicals: 3, weapon_parts: .5, metal: 2 }, tax: .7, reach: 3, unstable: true, raider: true },
};
/** recipes that run on munitions capacity (the rest run on industrial capacity) */
const MUNITIONS = new Set(['armor_plate', 'weapon_parts', 'eq_autocannon', 'eq_medium_gun', 'mod_armor']);

// demand baskets, per hour (× FE_SCALE)
/** per civ unit */
export const CIV_BASKET: Cargo = { chemicals: .7, metal: .6, alloy: .5, structure: .18, machinery: .12, electronics: .08 };
/** per infrastructure point */
export const INFRA_UPKEEP: Cargo = { structure: .012, alloy: .025, machinery: .005 };
/** per strength point (peacetime fleet upkeep) */
export const FLEET_UPKEEP: Cargo = { chemicals: .03, weapon_parts: .0016, armor_plate: .0016, machinery: .0015, eq_autocannon: .00015 };
/** per strength point while at war (munitions, repair stores) */
export const WAR_MUNITIONS: Cargo = { weapon_parts: .009, chemicals: .08, armor_plate: .005, eq_autocannon: .0008, eq_medium_gun: .0004 };
/** one strength point of new ships (on top of the doctrine hull recipe) */
const SHIP_FIT: Cargo = { engine: .15, eq_autocannon: .4, eq_medium_gun: .15 };
/** modernization: goods per 0.01 development */
export const MODERN_RECIPE: Cargo = { alloy: 120, structure: 50, machinery: 25, electronics: 12, precision: 4 };
const MODERN_RATE = .01;     // development per hour while modernizing
const DEV_CAP = 1.6;
/** share of doctrine strength an unsupplied fleet keeps (laid-up skeleton) */
const SKELETON = .35;
const SHIP_RATE_H = 60;      // doctrine shipRate is per minute in v1
const BUILD_RATE_H = 12;     // infrastructure points per hour (v1: 0.2/min)

/** stock cover (hours of need) the stockpile aims for */
const COVER = { civ: 8, upkeep: 8, war: 16, program: 4, input: 3 };
/** share of the remaining deficit bought per hour on top of the current cycle's need */
const REFILL_H = .5;
/** share of sector capacity run for export beyond the faction's own need */
const EXPORT_SHARE = .2;
/** stock above this multiple of the target is sold into own markets */
const EXPORT_ABOVE = 1.2;
/** goods a faction makes or mines beyond its own need (export goods): stock above this share of the
 *  target goes to its own markets, and the faction never buys them back above it (no export/re-buy loop) */
const EXPORT_FLOOR = .5;
/** tuning knobs scripts may change for experiments (defaults are the shipped behaviour) */
export const FE_TUNING = {
  /** faction exports fill a market only up to this share of its target; the band above is left to player
   *  sellers (1 = factions may fill markets completely) */
  exportFill: .6,
};
/** export goods: at least this share of the cycle's own output of a good is offered to markets even when the
 *  faction's stock is below its export floor (strategic goods keep flowing in war, scarce and expensive) */
const EXPORT_MIN_SHARE = .25;
/** modernization waits until the fleet is supplied (readiness), so civilian growth does not outrun munitions */
const MODERN_MIN_RDY = .9;
/** raider economy (pirates): */
/** extra logistics cost per jump when smuggling through an embargo (hostile, not at war) */
const SMUGGLE = .15;
/** goods value a raider takes per strength point per hour at full readiness, before the victim's defence */
const RAID_VALUE = 250;
/** a raid never takes a victim's stock below this share of the victim's own target */
const RAID_KEEP = .5;
/** wreck material a raider recovers per strength point lost in its fights (either side) */
const SALVAGE: Cargo = { alloy: 6, metal: 4, weapon_parts: .1 };
/** export goods: own-market room is refilled this many times per hour (planned production for others) */
const EXPORT_PULL = 2;
/** markets keep this share of target stock for others */
export const RESERVE2 = .3;
/** logistics surcharge per jump on partner-market purchases (cost that leaves the economy) */
const SURCHARGE = .05;
/** a station spends at most this share of its budget per cycle on faction exports */
const STATION_EXPORT_SHARE = .25;
/** credits per civ unit per hour per FE_SCALE (≈ 60% of the civilian basket's value) */
const TAX_BASE = 60;
/** budget is capped at this many hours of income */
const BUDGET_CAP_H = 24;
/** v2 faction markets keep this share of the old regional budget recovery (civilian buyers) */
export const FE_FUNDS_REGEN = .5;

function shipRecipe(id: string): Cargo { const r: Cargo = { ...doctrineOf(id).ship }; for (const [k, n] of Object.entries(SHIP_FIT)) addc(r, k, n); return r; }

/** every good this module manages (produced or consumed by some faction) */
export const FE_GOODS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  const add = (c: Cargo) => { for (const k of Object.keys(c)) s.add(k); };
  for (const p of Object.values(PROFILES2)) { add(p.mine); for (const r of Object.keys(p.sectors)) { add(RECIPES[r].in); add(RECIPES[r].out); } }
  for (const c of [CIV_BASKET, INFRA_UPKEEP, FLEET_UPKEEP, WAR_MUNITIONS, SHIP_FIT, MODERN_RECIPE, INFRA_RECIPE]) add(c);
  for (const id of Object.keys(FACTIONS)) add(doctrineOf(id).ship);
  return s;
})();

export const feOn = (w: Pick<WorldState, 'factionEcon' | 'factions'>) => w.factionEcon === FE_VERSION && !!w.factions;
/** a market whose FE_GOODS are driven by the faction economy (no free refill/absorption for them) */
export const feMarket = (w: Pick<WorldState, 'factionEcon' | 'factions'>, s: Station) => feOn(w) && s.public && !!s.faction && !!w.factions?.[s.faction];

/** give a new P10 world the v2 economy (idempotent; only before any player joins) */
export function enableFactionEcon2(w: WorldState) {
  if (!w.factions || w.worldLayout !== 'p10') throw new Error('faction economy v2 needs a P10 world');
  if (w.factionEcon === FE_VERSION) return;
  if (Object.values(w.companies).some(c => c.kind === 'player') || w.time > 0) throw new Error('faction economy v2 is only enabled on a brand-new world');
  w.factionEcon = FE_VERSION;
  for (const f of Object.values(w.factions)) {
    const st = initState(w, f);
    f.econ = st;
    // a starting stockpile of a few hours of civilian/upkeep need, so the first hour is not a purchasing panic
    const need = rates(w, f, st);
    for (const [k, n] of Object.entries(need.base)) addc(f.stock, k, n * 4);
    st.led.opening = { ...f.stock };   // opening balance of the stockpile (ledger identity starts here)
  }
}

function initState(w: WorldState, f: FactionState): FactionEconState {
  const p = PROFILES2[f.id];
  const civ = sizeOf(w, f.id) * (p?.civ ?? .5);
  return { dev: 1, eff: 1, rdy: 1, budget: civ * (p?.tax ?? 1) * TAX_BASE * FE_SCALE * 12, recon: 0, led: emptyLedger() };
}

// ───────────────────────────────────────────────────────────── geometry helpers (recomputed per cycle)

export function sizeOf(w: WorldState, fid: string) {
  let n = 0; for (const s of Object.values(w.systems)) if (s.faction === fid) n += REGION_WEIGHT[s.region ?? 'neutral'] ?? 1;
  return n;
}
function stationSystem(w: WorldState, st: Station): StarSystem | undefined {
  for (const s of Object.values(w.systems)) if (Math.abs(st.pos.x - s.origin.x) < s.radius + 20000) return s;
  return undefined;
}
/** jumps from the faction's territory to every system reachable through open gates (≤ reach) */
function reachFrom(w: WorldState, fid: string, reach: number): Map<string, number> {
  const d = new Map<string, number>(); let frontier: string[] = [];
  for (const s of Object.values(w.systems)) if (s.faction === fid) { d.set(s.id, 0); frontier.push(s.id); }
  for (let j = 1; j <= reach && frontier.length; j++) {
    const next: string[] = [];
    for (const id of frontier) for (const g of w.systems[id].gates) if (!d.has(g.to) && gateOpen(w, g)) { d.set(g.to, j); next.push(g.to); }
    frontier = next;
  }
  return d;
}
const warBetween = (w: WorldState, a: string, b: string) => Object.values(w.conflicts ?? {}).some(c => !c.ended && ((c.a === a && c.b === b) || (c.a === b && c.b === a)));
/** markets a faction may trade with, cheapest logistics first: [station, jumps, own, logistics cost per jump] */
type Supplier = [Station, number, boolean, number];
function suppliers(w: WorldState, f: FactionState, sysOf: Map<string, StarSystem | undefined>): Supplier[] {
  const p = PROFILES2[f.id]; const reach = reachFrom(w, f.id, p?.reach ?? 3);
  const out: Supplier[] = [];
  for (const st of Object.values(w.stations)) {
    if (!st.public || !st.market || !st.faction) continue;
    if (st.faction === f.id) { out.push([st, 0, true, 0]); continue; }
    const g = w.factions![st.faction]; if (!g) continue;
    // trade stops in war; outside war only the hostile faction is embargoed by bad relations — a raider
    // smuggles through the embargo at a higher logistics cost
    const hostile = FACTIONS[f.id]?.hostile || FACTIONS[st.faction]?.hostile;
    if (warBetween(w, f.id, st.faction)) continue;
    const embargo = hostile && Math.min(f.rel[st.faction] ?? 0, g.rel[f.id] ?? 0) <= -50;
    if (embargo && !p?.raider) continue;
    const sys = sysOf.get(st.id); const j = sys ? reach.get(sys.id) : undefined;
    if (j === undefined) continue;
    out.push([st, Math.max(1, j), false, embargo ? SMUGGLE : SURCHARGE]);
  }
  return out.sort((a, b) => a[1] * a[3] - b[1] * b[3] || (a[0].id < b[0].id ? -1 : 1));
}
const value = (k: string) => ITEMS[k]?.price ?? 50;
const tierOf = (r: string) => ITEMS[Object.keys(RECIPES[r].out)[0]]?.tier ?? 1;
/** a faction's sectors in dependency order: a sector comes after every own sector that makes one of its
 *  inputs (titanium before alloy before armour plate), ties by output tier then id */
const orderCache = new Map<Profile, string[]>();
function sectorOrder(p: Profile): string[] {
  const hit = orderCache.get(p); if (hit && hit.length === Object.keys(p.sectors).length) return hit;
  const rs = Object.keys(p.sectors), makes = new Map(rs.map(r => [Object.keys(RECIPES[r].out)[0], r]));
  const depth = new Map<string, number>();
  const dep = (r: string, seen: Set<string>): number => {
    if (depth.has(r)) return depth.get(r)!;
    if (seen.has(r)) return 0;
    seen.add(r);
    let d = 0; for (const i of Object.keys(RECIPES[r].in)) { const m = makes.get(i); if (m && m !== r) d = Math.max(d, dep(m, seen) + 1); }
    depth.set(r, d); return d;
  };
  for (const r of rs) dep(r, new Set());
  const out = rs.sort((a, b) => depth.get(a)! - depth.get(b)! || tierOf(a) - tierOf(b) || (a < b ? -1 : 1));
  orderCache.set(p, out); return out;
}
/** deterministic per-cycle noise in [lo, hi] (does not draw from the world RNG) */
function noise(t: number, id: string, lo: number, hi: number) {
  let h = 2166136261 ^ Math.floor(t);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return lo + ((h >>> 0) / 4294967296) * (hi - lo);
}

// ───────────────────────────────────────────────────────────── demand

interface Rates {
  civ: number; ind: number; mun: number; size: number; war: boolean;
  /** per-hour needs by purpose */
  cls: { civ: Cargo; maint: Cargo; upkeep: Cargo; war: Cargo };
  /** per-hour program needs (only while the program runs) */
  prog: { rebuild: Cargo; build: Cargo; modern: Cargo };
  /** per-hour sector input needs for the planned runs */
  input: Cargo;
  /** planned recipe runs per hour by sector */
  plan: Record<string, number>;
  /** sum of the always-on needs (civ + maint + upkeep + war) */
  base: Cargo;
  /** stockpile target per good */
  target: Cargo;
  /** export goods: own capacity (sector + extraction) above 1.1 × own need */
  exportGood: Set<string>;
}
const scaled = (c: Cargo, k: number): Cargo => Object.fromEntries(Object.entries(c).map(([i, n]) => [i, n * k]));

/** `room(k)`: empty space (target − stock) in the faction's own markets; for export goods it is planned
 *  production on top of own need, so other factions find the goods there (omitted: own need only) */
export function rates(w: WorldState, f: FactionState, st: FactionEconState = f.econ!, room?: (k: string) => number): Rates {
  const p = PROFILES2[f.id]; const size = sizeOf(w, f.id); const war = atWar(w, f.id);
  const civ = size * p.civ * st.dev, ind = size * p.ind * st.dev, mun = size * p.mun * st.dev;
  const d = doctrineOf(f.id);
  const cls = {
    civ: scaled(CIV_BASKET, civ * FE_SCALE),
    maint: scaled(INFRA_UPKEEP, f.infra * FE_SCALE),
    upkeep: scaled(FLEET_UPKEEP, f.strength * FE_SCALE),
    war: war ? scaled(WAR_MUNITIONS, f.strength * FE_SCALE) : {},
  };
  const shipH = Math.min(d.shipRate * SHIP_RATE_H, Math.max(0, d.strength - f.strength));
  const buildH = Math.min(BUILD_RATE_H * (st.recon > 0 ? 2 : 1), Math.max(0, d.infra - f.infra));
  const modernH = modernizing(w, f, st, d) ? MODERN_RATE * 100 : 0;
  const prog = { rebuild: scaled(shipRecipe(f.id), shipH), build: scaled(INFRA_RECIPE, buildH), modern: scaled(MODERN_RECIPE, modernH) };
  const base: Cargo = {};
  for (const c of Object.values(cls)) for (const [k, n] of Object.entries(c)) addc(base, k, n);
  // sector plan, highest tier first: run for own need (consumption + programs + downstream inputs) plus an
  // export share of capacity; inputs are bought only for the planned runs, not for idle capacity
  const input: Cargo = {}, plan: Record<string, number> = {};
  for (const r of sectorOrder(p).slice().reverse()) {
    const rec = RECIPES[r]; const [o, outN] = Object.entries(rec.out)[0];
    const cap = (MUNITIONS.has(r) ? mun : ind) * p.sectors[r] * FE_SCALE;
    const need = (base[o] ?? 0) + Object.values(prog).reduce((n, c) => n + (c[o] ?? 0), 0) + (input[o] ?? 0);
    const pull = room && cap > need * 1.1 ? room(o) * EXPORT_PULL : 0;
    const out = Math.min(cap, need * 1.1 + cap * EXPORT_SHARE + pull);
    plan[r] = out / outN;
    for (const [i, n] of Object.entries(rec.in)) addc(input, i, n * plan[r]);
  }
  const capOf: Cargo = {}, needOf: Cargo = {};
  for (const [k, n] of Object.entries(p.mine)) addc(capOf, k, size * n * FE_SCALE * st.dev);
  for (const r of Object.keys(p.sectors)) { const [o] = Object.keys(RECIPES[r].out); addc(capOf, o, (MUNITIONS.has(r) ? mun : ind) * p.sectors[r] * FE_SCALE); }
  for (const c of [base, input, ...Object.values(prog)]) for (const [k, n] of Object.entries(c)) addc(needOf, k, n);
  const exportGood = new Set(Object.keys(capOf).filter(k => (capOf[k] ?? 0) > (needOf[k] ?? 0) * 1.1));
  const target: Cargo = {};
  for (const [k, n] of Object.entries(cls.civ)) addc(target, k, n * COVER.civ);
  for (const [k, n] of Object.entries(cls.maint)) addc(target, k, n * COVER.civ);
  for (const [k, n] of Object.entries(cls.upkeep)) addc(target, k, n * (war ? COVER.war : COVER.upkeep));
  for (const [k, n] of Object.entries(cls.war)) addc(target, k, n * COVER.war);
  for (const c of Object.values(prog)) for (const [k, n] of Object.entries(c)) addc(target, k, n * COVER.program);
  for (const [k, n] of Object.entries(input)) addc(target, k, n * COVER.input);
  return { civ, ind, mun, size, war, cls, prog, input, plan, base, target, exportGood };
}
function modernizing(_w: WorldState, f: FactionState, st: FactionEconState, d: ReturnType<typeof doctrineOf>) {
  return !atWar(_w, f.id) && f.infra >= d.infra - 1e-6 && st.eff >= .9 && st.rdy >= MODERN_MIN_RDY && st.dev < DEV_CAP + .1 * (f.claimed?.length ?? 0);
}

// ───────────────────────────────────────────────────────────── one cycle

/** one v2 faction-economy cycle for every faction, then conflicts (dt = FE_CYCLE normally) */
export function factionEcon2Step(host: EconHost, w: WorldState, dt = FE_CYCLE) {
  if (!feOn(w)) return;
  const h = dt / 3600;
  const sysOf = new Map<string, StarSystem | undefined>();
  for (const st of Object.values(w.stations)) if (st.public && st.market && st.faction) sysOf.set(st.id, stationSystem(w, st));
  // purchase order rotates every cycle so no faction always has first pick of a shared market
  const all = Object.values(w.factions!); const r = Math.floor(w.time / FE_CYCLE) % all.length;
  for (const f of [...all.slice(r), ...all.slice(0, r)]) cycle(w, f, h, sysOf);
  conflicts(host, w, dt / 60, {
    lossMul: (victim, attacker) => (.5 + .5 * (attacker.econ?.rdy ?? 1)) * (1.5 - .5 * (victim.econ?.rdy ?? 1)),
    onLoss: (f, lost, c) => {
      const st = f.econ; if (!st || lost <= 0) return;
      // a raider strips the wrecks of every fight it is in (its own and the enemy's losses)
      for (const id of [c.a, c.b]) { const r = w.factions![id]; if (r?.econ && PROFILES2[id]?.raider) for (const [k, n] of Object.entries(SALVAGE)) { addc(r.stock, k, n * lost); addc((r.econ.led.salvaged ??= {}), k, n * lost); } }
      st.led.lostStr += lost;
      // fighting on the border damages infrastructure and slows development
      const dmg = Math.min(f.infra, lost * .25); f.infra -= dmg; st.led.infraLost += dmg;
      st.dev = Math.max(1, st.dev - lost * .0005);
    },
    onEnd: (c: Conflict) => { for (const id of [c.a, c.b]) { const st = w.factions![id]?.econ; if (st) st.recon = 3 * 3600; } },
  });
}

/** the faction's own public markets (stable order) and the empty space in them per good */
export const ownMarkets = (w: WorldState, fid: string) => Object.values(w.stations).filter(s => s.public && s.market && s.faction === fid).sort((a, b) => (a.id < b.id ? -1 : 1));
export const roomIn = (own: Station[]) => (k: string) => own.reduce((n, s) => n + Math.max(0, (s.market![k]?.target ?? 0) * FE_TUNING.exportFill - (s.market![k]?.stock ?? 0)), 0);

function cycle(w: WorldState, f: FactionState, h: number, sysOf: Map<string, StarSystem | undefined>) {
  const st = (f.econ ??= initState(w, f));   // a faction added later starts with an empty ledger
  const p = PROFILES2[f.id]; if (!p) return;
  const led = st.led;
  const own = ownMarkets(w, f.id);
  const room = roomIn(own);
  const R = rates(w, f, st, room);
  const outCap = (k: string) => (R.target[k] ?? 0) * (EXPORT_ABOVE + .3) + room(k);
  const swing = p.unstable ? noise(w.time, f.id, .5, 1.3) : 1;
  /** per-cycle shares below are defined for the standard 60 s cycle; scale them with the cycle length */
  const per = h * 3600 / FE_CYCLE;
  const prodMul = st.eff * (R.war ? .85 : 1) * swing;

  // 1. extraction and aggregate industry, lowest tier first
  // extraction grows with development (mines are part of the modernized economy, like the industry)
  for (const [k, n] of Object.entries(p.mine)) {
    const amt = Math.min(R.size * n * FE_SCALE * st.dev * prodMul * h, Math.max(0, outCap(k) - qty(f.stock, k)));
    if (amt <= 1e-9) continue;
    addc(f.stock, k, amt); addc(led.extracted, k, amt);
  }
  // industry leaves this cycle's direct consumption of an input in stock (metal for the civilian economy is
  // not turned into export structure first); fleet goods (upkeep, war) may still draw on it
  const madeNow: Cargo = {};
  const keep = (i: string, out: string) => (R.cls.upkeep[out] || R.cls.war[out] ? 0 : ((R.cls.civ[i] ?? 0) + (R.cls.maint[i] ?? 0) + (R.cls.upkeep[i] ?? 0) + (R.cls.war[i] ?? 0)) * h);
  for (const r of sectorOrder(p)) {
    const rec = RECIPES[r]; const [o, outN] = Object.entries(rec.out)[0];
    let runs = R.plan[r] * prodMul * h;
    for (const [i, n] of Object.entries(rec.in)) runs = Math.min(runs, Math.max(0, qty(f.stock, i) - keep(i, o)) / n);
    runs = Math.min(runs, Math.max(0, outCap(o) - qty(f.stock, o)) / outN);
    if (runs <= 1e-9) continue;
    for (const [i, n] of Object.entries(rec.in)) { addc(f.stock, i, -n * runs); addc(led.inputs, i, n * runs); }
    addc(f.stock, o, outN * runs); addc(led.made, o, outN * runs); addc(madeNow, o, outN * runs);
  }

  // 2. sustained consumption from the stockpile
  const sat: Record<string, [number, number]> = {};
  for (const [cls, need] of Object.entries(R.cls) as [keyof Rates['cls'], Cargo][]) {
    let want = 0, got = 0;
    for (const [k, n] of Object.entries(need)) {
      const q = n * h; const use = Math.min(q, Math.max(0, qty(f.stock, k)));
      if (use > 0) { addc(f.stock, k, -use); addc(led.used, k, use); addc(led[cls], k, use); }
      if (q - use > 1e-9) addc(led.short, k, q - use);
      want += q * value(k); got += use * value(k);
    }
    sat[cls] = [got, want];
  }
  const frac = (...c: string[]) => { const g = c.reduce((n, x) => n + (sat[x]?.[0] ?? 0), 0), wnt = c.reduce((n, x) => n + (sat[x]?.[1] ?? 0), 0); return wnt > 0 ? g / wnt : 1; };

  // 3. programs: rebuild strength, construct infrastructure, modernize (whole goods only)
  const program = (recipe: Cargo, units: number, into: Cargo) => {
    if (units <= 1e-9) return 0;
    let k = units; for (const [i, n] of Object.entries(recipe)) k = Math.min(k, qty(f.stock, i) / n);
    if (k <= 1e-9) return 0;
    for (const [i, n] of Object.entries(recipe)) { addc(f.stock, i, -n * k); addc(led.used, i, n * k); addc(into, i, n * k); }
    return k;
  };
  const d = doctrineOf(f.id);
  if (f.strength < d.strength) {
    const n = program(shipRecipe(f.id), Math.min(d.shipRate * SHIP_RATE_H * h, d.strength - f.strength), led.rebuild);
    f.strength += n; f.made.ships += n; led.builtStr += n;
  }
  if (f.infra < d.infra) {
    const n = program(INFRA_RECIPE, Math.min(BUILD_RATE_H * (st.recon > 0 ? 2 : 1) * h, d.infra - f.infra), led.build);
    f.infra += n; f.made.infra += n; led.builtInfra += n;
  } else if (modernizing(w, f, st, d)) {
    const n = program(MODERN_RECIPE, MODERN_RATE * 100 * h, led.modern);
    st.dev += n / 100; led.devGain += n / 100;
  }
  st.recon = Math.max(0, st.recon - h * 3600);

  // 4. effects of supply: efficiency, readiness, decay
  const civSat = frac('civ', 'maint'), milSat = frac('upkeep', 'war');
  st.eff += (Math.min(1, .35 + .65 * civSat) - st.eff) * Math.min(1, h / 4);
  st.rdy += (milSat - st.rdy) * Math.min(1, h / 1);
  // an unsupplied fleet is laid up down to a skeleton force (35 % of doctrine), not to nothing
  const floor = d.strength * SKELETON;
  if (st.rdy < 1 && f.strength > floor) { const loss = Math.min(f.strength - floor, f.strength * .03 * (1 - st.rdy) * h); f.strength -= loss; led.lostStr += loss; }
  const maintSat = frac('maint');
  if (maintSat < 1) { const loss = f.infra * .01 * (1 - maintSat) * h; f.infra -= loss; led.infraLost += loss; }

  // 5. income (bounded treasury)
  const incomeH = R.civ * st.eff * p.tax * TAX_BASE * FE_SCALE * (R.war ? .85 : 1);
  const inc = Math.max(0, Math.min(incomeH * h, incomeH * BUDGET_CAP_H - st.budget));
  st.budget += inc; led.income += inc;

  // 6. purchases: what the stockpile is short of, most urgent first
  let R2 = rates(w, f, st, room);   // targets after this cycle's programs (a finished program needs nothing)
  if (p.raider && raid(w, f, st, R2, h)) R2 = rates(w, f, st, room);
  const direct = (k: string) => (R2.cls.war[k] ? 0 : R2.cls.upkeep[k] ? 1 : R2.cls.civ[k] || R2.cls.maint[k] ? 2 : R2.prog.rebuild[k] || R2.prog.build[k] ? 3 : R2.input[k] ? 4 : 5);
  // make before buy: the inputs of a good the faction makes itself inherit that good's urgency (alloy for
  // iron's own weapon parts is as urgent as the weapon parts), so a producer is not starved into importing
  const pr: Record<string, number> = {};
  for (const r of [...sectorOrder(p)].reverse()) {
    const [o] = Object.keys(RECIPES[r].out); const po = pr[o] ?? direct(o);
    for (const i of Object.keys(RECIPES[r].in)) pr[i] = Math.min(pr[i] ?? direct(i), po);
  }
  const prio = (k: string) => pr[k] ?? direct(k);
  const buyTarget = (k: string) => (R2.target[k] ?? 0) * (R2.exportGood.has(k) ? EXPORT_FLOOR : 1);
  const items = Object.keys(R2.target).filter(k => buyTarget(k) - qty(f.stock, k) > 1e-6).sort((a, b) => prio(a) - prio(b) || (a < b ? -1 : 1));
  let markets: Supplier[] | undefined;
  const v3 = growthOn(w);
  const wantOf = (k: string) => {
    const deficit = buyTarget(k) - qty(f.stock, k);
    const perH = (R2.base[k] ?? 0) + Object.values(R2.prog).reduce((n, c) => n + (c[k] ?? 0), 0) + (R2.input[k] ?? 0);
    return Math.min(deficit, deficit * REFILL_H * h + perH * h);
  };
  // one priority tier at a time; inside a tier the budget is shared in proportion to each good's
  // deficit value, so one bulky good (ore) cannot starve another (titanium ore)
  for (let tier = 0; tier <= 5; tier++) {
    const tierItems = items.filter(k => prio(k) === tier);
    if (!tierItems.length) continue;
    // industry inputs keep a small reserve for upkeep; modernization waits for a healthy treasury
    if ((tier === 4 && st.budget < incomeH * .25) || (tier === 5 && st.budget < incomeH * 2)) continue;
    const wants = tierItems.map(k => [k, wantOf(k)] as [string, number]);
    const cost = wants.reduce((n, [k, q]) => n + q * value(k), 0);
    const share = cost > 0 ? Math.min(1, st.budget / cost) : 1;
    const pool = st.budget;
    for (const [k, q] of wants) {
      let want = q;
      let cap = q * value(k) * share * (pool / Math.max(pool, cost * share));   // this good's slice of the tier budget
      markets ??= suppliers(w, f, sysOf);
      for (const [s, jumps, mine, perJump] of markets) {
        if (want <= 1e-6 || st.budget <= 1 || cap <= 1) break;
        const m = s.market![k]; if (!m) continue;
        for (let slice = 0; slice < 2 && want > 1e-6; slice++) {
          const avail = m.stock - m.target * RESERVE2; if (avail <= 1e-6) break;
          const unit = priceOf(m, mine ? 'sell' : 'buy', v3); if (!(unit > 0)) break;
          const cost1 = unit * (1 + perJump * jumps);
          // one faction takes at most half of what a market can spare in a cycle (others share the rest)
          const take = Math.min(slice === 0 ? want / 2 : want, avail * Math.min(1, (slice === 0 ? .25 : .5) * per), Math.min(st.budget, cap * 1.5) / cost1);
          if (take <= 1e-6) break;
          m.stock -= take; want -= take;
          const pay = take * cost1, toStation = take * unit;
          st.budget -= pay; led.spent += pay; cap -= pay;
          const credit = s.fundsMax === undefined ? 0 : Math.max(0, Math.min(toStation, s.fundsMax * 1.5 - (s.funds ?? 0)));
          if (credit > 0) s.funds = (s.funds ?? 0) + credit;
          led.sunk += pay - credit;
          addc(f.stock, k, take); addc(led.bought, k, take); if (!mine) addc(led.imported, k, take);
          emit(w, { kind: 'consume', amount: take, station: s.id, item: k, reason: 'faction_purchase', ref: f.id, value: pay });
        }
      }
    }
  }

  // 7. exports: real surplus into markets below target, own territory first, then partner markets in reach
  //    (no war, open gates). The buying station pays its sell price from its NPC budget; shipping to a
  //    partner market costs the exporter SURCHARGE per jump (leaves the economy, recorded as sunk)
  for (const k of Object.keys(f.stock).sort()) {
    let surplus = qty(f.stock, k) - (R2.target[k] ?? 0) * (R2.exportGood.has(k) ? EXPORT_FLOOR : EXPORT_ABOVE);
    // an export good keeps a minimum flow to markets even when the maker is short itself (war stockpiling)
    if (R2.exportGood.has(k)) surplus = Math.max(surplus, Math.min(qty(f.stock, k), (madeNow[k] ?? 0) * EXPORT_MIN_SHARE));
    if (surplus <= 1e-6) continue;
    markets ??= suppliers(w, f, sysOf);
    for (const [s, jumps, mine, perJump] of markets) {
      const m = s.market![k]; if (!m) continue;
      const fill = m.target * FE_TUNING.exportFill;
      if (m.stock >= fill) continue;
      const unit = priceOf(m, 'sell', v3); if (!(unit > 0)) continue;
      const put = Math.min(surplus, fill - m.stock, Math.max(0, (s.funds ?? 0) * Math.min(1, STATION_EXPORT_SHARE * per)) / unit);
      if (put <= 1e-6) continue;
      const pay = put * unit, ship = mine ? 0 : pay * perJump * jumps;
      m.stock += put; surplus -= put;
      addc(f.stock, k, -put); addc(led.exported, k, put);
      s.funds = (s.funds ?? 0) - pay; st.budget += pay - ship; led.exportRev += pay - ship; led.sunk += ship;
      emit(w, { kind: 'supply', amount: put, station: s.id, item: k, reason: 'faction_export', ref: f.id, value: pay });
      if (surplus <= 1e-6) break;
    }
  }

  // 8. a treasury above its cap is spent on the civilian economy: it becomes NPC buying budget of its own
  //    stations, then of its trading partners' (money keeps circulating instead of piling up), never above fundsMax
  const capB = incomeH * BUDGET_CAP_H;
  if (st.budget > capB) for (const s of [...own, ...(markets ??= suppliers(w, f, sysOf)).filter(x => !x[2]).map(x => x[0])]) {
    if (s.fundsMax === undefined) continue;
    const g = Math.min(st.budget - capB, Math.max(0, s.fundsMax - (s.funds ?? 0)));
    if (g <= 1e-6) continue;
    s.funds = (s.funds ?? 0) + g; st.budget -= g; led.grants = (led.grants ?? 0) + g;
    if (st.budget <= capB + 1e-6) break;
  }
  st.hot = Object.entries(R2.target).map(([k, t]) => [k, Math.max(0, t - qty(f.stock, k))] as [string, number])
    .filter(([, n]) => n >= 1).sort((a, b) => b[1] * value(b[0]) - a[1] * value(a[0]) || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([k, n]) => [k, Math.round(n)]);
  // tiny float residue never goes negative
  for (const k of Object.keys(f.stock)) if (f.stock[k]! < 1e-9) { if (f.stock[k]! < -1e-6) throw new Error(`faction ${f.id} stock negative: ${k} ${f.stock[k]}`); delete f.stock[k]; }
}

/** raider economy: take what the raider is short of from the stockpiles of hostile neighbours (a system of the
 *  victim shares a gate with the raider's territory; relations ≤ −50 or at war). The yield grows with the raider's
 *  strength and readiness and falls with the victim's ready strength (patrols); the victim keeps RAID_KEEP of its
 *  own target of every good. Goods move, nothing is created: victim `lost`, raider `seized`. Returns credits taken. */
function raid(w: WorldState, f: FactionState, st: FactionEconState, R: Rates, h: number): number {
  const mine = new Set(Object.values(w.systems).filter(s => s.faction === f.id).map(s => s.id));
  const victims = new Set<string>();
  for (const id of mine) for (const g of w.systems[id].gates) { const o = w.systems[g.to]?.faction; if (o && o !== f.id && w.factions![o]) victims.add(o); }
  const hostile = [...victims].sort().filter(v => warBetween(w, f.id, v) || Math.min(f.rel[v] ?? 0, w.factions![v].rel[f.id] ?? 0) <= -50);
  if (!hostile.length || f.strength <= 0) return 0;
  // wanted goods by value of what the raider is missing against its target, most valuable first
  const want = Object.entries(R.target).map(([k, t]) => [k, Math.max(0, t - qty(f.stock, k))] as [string, number]).filter(x => x[1] > 1e-6)
    .sort((a, b) => b[1] * value(b[0]) - a[1] * value(a[0]) || (a[0] < b[0] ? -1 : 1));
  if (!want.length) return 0;
  let took = 0;
  for (const vid of hostile) {
    const v = w.factions![vid]; if (!v.econ) continue;
    const def = v.strength * (v.econ.rdy ?? 1) * .5;
    let budget = f.strength * st.rdy * RAID_VALUE * h / hostile.length * (f.strength / (f.strength + def));
    const vt = rates(w, v, v.econ).target;
    for (const [k] of want) {
      if (budget <= 1) break;
      const n0 = Math.min(Math.max(0, R.target[k] - qty(f.stock, k)), Math.max(0, qty(v.stock, k) - (vt[k] ?? 0) * RAID_KEEP), budget / value(k));
      if (n0 <= 1e-6) continue;
      const n = writeOff(v, k, n0);
      addc(f.stock, k, n); addc((st.led.seized ??= {}), k, n);
      budget -= n * value(k); took += n * value(k);
    }
  }
  return took;
}

/** markets of a v2 world: is this good driven by the faction economy here (no free refill/absorption)? */
export const feManaged = (w: WorldState, s: Station, k: string) => feMarket(w, s) && FE_GOODS.has(k);

// ───────────────────────────────────────────────────────────── hooks for future real faction fleets
// A real fleet (ships that exist in the world) must not be counted twice against abstract strength:
//   - when real faction ships die, call `realLoss` instead of letting conflicts() attrite the same fight;
//   - real fleets draw munitions/repair goods from the faction stockpile with `drawStores`, which records
//     them as war use, so the abstract WAR_MUNITIONS demand must be reduced by the same share of strength
//     that is deployed as real ships (`deployed` share, not yet modelled: 0 today).
export function realLoss(f: FactionState, strengthEq: number) {
  const st = f.econ; const n = Math.min(f.strength, Math.max(0, strengthEq));
  f.strength -= n; if (st) st.led.lostStr += n;
  return n;
}
/** goods a faction loses from its stockpile to an outside event (raid, seizure, blockade), recorded */
export function writeOff(f: FactionState, item: string, want: number): number {
  const n = Math.min(Math.max(0, want), qty(f.stock, item));
  if (n <= 0) return 0;
  addc(f.stock, item, -n);
  if (f.econ) addc((f.econ.led.lost ??= {}), item, n);
  if (qty(f.stock, item) < 1e-9) delete f.stock[item];
  return n;
}
export function drawStores(f: FactionState, item: string, want: number): number {
  const st = f.econ; const n = Math.min(Math.max(0, want), qty(f.stock, item));
  if (n <= 0) return 0;
  addc(f.stock, item, -n);
  if (st) { addc(st.led.used, item, n); addc(st.led.war, item, n); }
  return n;
}

/** market list helper for scripts/UI: what a faction is short of right now (per hour) */
export function shortList(w: WorldState, f: FactionState): [string, number][] {
  if (!f.econ) return [];
  const R = rates(w, f, f.econ);
  return Object.entries(R.target).map(([k, t]) => [k, Math.max(0, t - qty(f.stock, k)) * value(k)] as [string, number]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
}
export type { Market };
