// P13.3 black markets and smuggling (blackMarketV worlds only; a world without the flag never reaches this file).
//
//  - Stolen goods are separate cargo keys `hot:<item>:<victim>`. Every generic cargo path (ship holds, company
//    storage, containers, wreck lots, lair holds, staged unloading) moves them as their own key, so 100 normal
//    units and 40 stolen units of the same item are never one pile. Normal markets, recipes, construction,
//    fitting, contracts, logistics and listings only know plain item ids, so they cannot buy or consume them.
//  - Region-restricted goods are normal items that a few law-abiding regions forbid at their public stations.
//  - One hidden black market per region type, at an existing dockable public station chosen from the world seed.
//    It has a real buying budget (drawn from its host station's public budget, never created), a fee, a price that
//    sinks with what it already absorbed, and a small real stock of restricted goods for sale.
//  - Inspections are events (a gate jump into a policed system, docking at a public station), decided by a hash of
//    (world seed, ship, place, 30-minute window) and recorded on the ship: a retry in the same window repeats the
//    recorded outcome instead of rolling again. Only illicit cargo is ever checked.
import type { WorldSim } from './sim';
import type { Cargo, Company, Op, Station, StarSystem, WGroup, WShip, WorldState } from './types';
import { addc, cargoSum, qty, takec } from './types';
import { EQUIPMENT, ITEMS, ITEM_NAME_HOOKS, itemPrice } from './industry';
import { econOf } from './hullops';
import { effSec } from './security';
import { bumpStanding, standingOf } from './territory';
import { emit, watchMoney } from './observe';
import { priceOf, fundsIn } from './market';
import { growthOn } from './hullops';
import { payFromSale } from './money';
import { book } from './operations';
import { stationCargoRate } from './stations';
import { sysAt } from './geom';
import { routeSystems } from './fleetops';
import { gateOpen } from './territory';
import { lawCrime } from './law';
import { dist } from './geom';

type Host = WorldSim;

// ------------------------------------------------------------------ stolen keys

export const HOT = 'hot:';
export const isHot = (k: string) => k.startsWith(HOT);
export const hotKey = (item: string, owner: string) => `${HOT}${item}:${owner}`;
/** `hot:<item>:<owner>` → parts (item ids never contain ':' for cargo that can be stolen; owner ids never do) */
export function parseHot(k: string): { item: string; owner: string } | null {
  if (!isHot(k)) return null;
  const i = k.lastIndexOf(':');
  if (i <= HOT.length) return null;
  const item = k.slice(HOT.length, i), owner = k.slice(i + 1);
  return item && owner ? { item, owner } : null;
}
/** plain item behind a key (itself for normal goods) */
export const baseItem = (k: string) => parseHot(k)?.item ?? k;
ITEM_NAME_HOOKS.push(id => { const p = parseHot(id); if (!p) return undefined; const n = ITEMS[p.item]?.name ?? EQUIPMENT[p.item]?.name ?? p.item; return `장물 ${n}`; });

/** a key the black-market rules may carry as stolen (a real cargo item; blueprints/fragments never) */
const stealable = (item: string) => (Object.hasOwn(ITEMS, item) || Object.hasOwn(EQUIPMENT, item)) && !item.includes(':');

/**
 * P13.3: what lands in the hold when `recoverer` takes `n` units of cargo lot `lot` (P13.1 salvage engine).
 * Cargo belonging to another real company (not pirates) is stolen goods; the owner taking its own goods back
 * (also stolen goods of its own that were lost again) gets plain goods; hull scrap, equipment of wrecks and
 * fragments stay plain salvage. Off without blackMarketV.
 */
export function recoveredKey(st: WorldState, recoverer: string, lot: { k: string; item: string; owner: string }): string {
  if (!st.blackMarketV || lot.k !== 'cargo') return lot.item;
  const hot = parseHot(lot.item);
  if (hot) return hot.owner === recoverer ? hot.item : lot.item;   // provenance stays with the first victim
  if (lot.owner === recoverer || !stealable(lot.item)) return lot.item;
  const o = st.companies[lot.owner];
  if (!o || o.kind === 'pirate' || lot.owner === 'pirates') return lot.item;
  return hotKey(lot.item, lot.owner);
}

// ------------------------------------------------------------------ restricted goods

/** military contraband: legal to own and fit, forbidden to bring into law-abiding public stations */
export const RESTRICTED_ITEMS = ['mod_ecm', 'eq_heavy_cannon'] as const;
/** P10 factions that forbid them at their public stations; a world without factions: public stations at security ≥ 75 */
export const RESTRICTING_FACTIONS: Record<string, readonly string[]> = { union: RESTRICTED_ITEMS, iron: RESTRICTED_ITEMS };
export const P9_RESTRICT_SEC = 75;
/** items forbidden at this public station (never at private stations, never items its own market trades) */
export function restrictedAt(w: WorldState, st: Station | undefined): readonly string[] {
  if (!st?.public || !w.blackMarketV) return [];
  let list: readonly string[];
  if (w.factions && st.faction) list = RESTRICTING_FACTIONS[st.faction] ?? [];
  else { const sys = sysAt(w.systems, st.pos); list = sys && sys.security >= P9_RESTRICT_SEC ? RESTRICTED_ITEMS : []; }
  return list.filter(k => !st.market?.[k]);
}

// ------------------------------------------------------------------ black markets

export type BmTier = 'lawless' | 'border' | 'neutral' | 'secure';
export interface BlackMarket {
  id: string;
  station: string;
  tier: BmTier;
  /** buying budget: funded from the host station's public budget (moved, never created) and from what buyers pay */
  funds: number;
  fundsMax: number;
  /** units of each base item absorbed recently: the more, the less it pays (decays as the network moves them on) */
  glut: Record<string, number>;
  /** restricted goods for sale (real stock, slow restock toward target) */
  stock: Record<string, { n: number; target: number }>;
  /** P14 hook: nearby pirate lairs whose holds may supply this market later (structural link only; nothing flows yet) */
  lairs: string[];
  /** totals for reports */
  paid: number; took: number; sold: number;
}
export interface BmTierDef { name: string; disc: number; fee: number; premium: number; ask: number; fundsMax: number; stock: Record<string, number> }
export const BM_TIERS: Record<BmTier, BmTierDef> = {
  // disc: share of the reference price paid for stolen goods; premium: for restricted goods where they are forbidden
  lawless: { name: '무법 지대 장물아비', disc: 0.55, fee: 0.05, premium: 1.0, ask: 1.05, fundsMax: 60000, stock: { mod_ecm: 24, eq_heavy_cannon: 6 } },
  border: { name: '국경 밀거래상', disc: 0.5, fee: 0.08, premium: 1.15, ask: 1.2, fundsMax: 60000, stock: { mod_ecm: 10, eq_heavy_cannon: 2 } },
  neutral: { name: '중립 지대 뒷거래소', disc: 0.45, fee: 0.1, premium: 1.35, ask: 1.4, fundsMax: 60000, stock: {} },
  secure: { name: '치안 구역 밀매 조직', disc: 0.4, fee: 0.12, premium: 2.2, ask: 1.9, fundsMax: 90000, stock: {} },
};
export const BM = {
  /** host budget the black market never draws below (share of the station's fundsMax) */
  hostFloor: 0.3,
  /** budget recovery per hour (share of its own max), moved from the host budget */
  regenH: 0.15,
  /** share of what buyers pay that returns to the buying budget */
  inflow: 0.7,
  /** glut that halves the price: about `glutValue` credits of a good */
  glutValue: 25000,
  /** glut absorbed per hour (share of its cap) */
  glutDecayH: 0.25,
  /** restock per hour (share of target) */
  restockH: 0.05,
  chunk: 10,
  /** inspection */
  window: 1800,
  gateBase: 0.3, dockBase: 0.5, maxChance: 0.95,
  /** security below this never inspects */
  secFloor: 20,
  /** fine as share of the seized goods' reference value */
  fine: 0.3,
  /** reputation lost per credit of seized goods (× security / 100) */
  repPerCr: 0.002,
  /** standing lost per credit seized, capped */
  standingPerCr: 1 / 3000, standingCap: 15,
  logCap: 30,
  /** P13.3.1: warning interval of a hauler that holds stolen goods with no safe place to unload */
  unloadWarn: 600,
};

const pctOf = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
const hash32 = (s: string) => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };

/** the region type of a system (P10 region; without one, by security) — undefined: no black market tier */
export function tierOf(sys: StarSystem | undefined): BmTier | undefined {
  if (!sys) return undefined;
  const r = sys.region;
  if (r) {
    if (r === 'lawless') return 'lawless';
    if (r === 'border') return 'border';
    if (r === 'neutral') return 'neutral';
    if ((r === 'capital' || r === 'industrial') && sys.security >= 75) return 'secure';
    return undefined;
  }
  const s = sys.security;
  return s < 20 ? 'lawless' : s < 50 ? 'border' : s < 75 ? 'neutral' : 'secure';
}

/** place one black market per region type (deterministic from the world seed); idempotent */
export function seedBlackMarkets(h: Pick<Host, 'st'>) {
  const w = h.st; if (!w.blackMarketV || w.blackMarkets) return;
  const out: Record<string, BlackMarket> = {};
  const seed = String(w.seed ?? 1);
  for (const tier of Object.keys(BM_TIERS) as BmTier[]) {
    let cands = Object.values(w.stations).filter(st => st.public && st.market && tierOf(sysAt(w.systems, st.pos)) === tier).sort((a, b) => a.id.localeCompare(b.id));
    // the secure-region market sits where goods are actually forbidden (its premium needs a local ban), if any such station exists
    if (tier === 'secure') { const strict = cands.filter(st => restrictedAt(w, st).length > 0); if (strict.length) cands = strict; }
    if (!cands.length) continue;
    const st = cands.reduce((best, c) => hash32(`${seed}|bm|${tier}|${c.id}`) < hash32(`${seed}|bm|${tier}|${best.id}`) ? c : best);
    const def = BM_TIERS[tier], id = `bm_${tier}`;
    // the opening budget is moved out of the host's public budget (no money is created)
    const take = Math.min(def.fundsMax * 0.5, Math.max(0, (st.funds ?? 0) - (st.fundsMax ?? 0) * BM.hostFloor));
    if (st.funds !== undefined) st.funds -= take;
    const sys = sysAt(w.systems, st.pos);
    void sys;
    const d2 = (p: { x: number; z: number }) => (p.x - st.pos.x) ** 2 + (p.z - st.pos.z) ** 2;
    const lairs = Object.values(w.lairs ?? {}).sort((a, b) => d2(a.pos) - d2(b.pos) || a.id.localeCompare(b.id)).slice(0, 2).map(l => l.id);
    out[id] = { id, station: st.id, tier, funds: take, fundsMax: def.fundsMax, glut: {}, stock: Object.fromEntries(Object.entries(def.stock).map(([k, n]) => [k, { n, target: n }])), lairs, paid: 0, took: 0, sold: 0 };
  }
  w.blackMarkets = out;
}
export const bmAt = (w: WorldState, station: string): BlackMarket | undefined => Object.values(w.blackMarkets ?? {}).find(b => b.station === station);
export const knowsBm = (co: Company | undefined, id: string) => !!co?.bm?.known.includes(id);

/** budget recovery from the host's public budget, glut absorption, restock (dt seconds) */
export function stepBlackMarkets(h: Pick<Host, 'st'>, dt: number) {
  const w = h.st; if (!w.blackMarketV || !w.blackMarkets) return;
  for (const b of Object.values(w.blackMarkets)) {
    const host = w.stations[b.station];
    if (host?.funds !== undefined && b.funds < b.fundsMax) {
      const room = host.funds - (host.fundsMax ?? 0) * BM.hostFloor;
      const x = Math.max(0, Math.min(b.fundsMax * BM.regenH / 3600 * dt, b.fundsMax - b.funds, room));
      if (x > 0) { host.funds -= x; b.funds += x; }
    }
    for (const [k, g] of Object.entries(b.glut)) {
      const left = g - glutCap(w, k) * BM.glutDecayH / 3600 * dt;
      if (left <= 1e-6) delete b.glut[k]; else b.glut[k] = left;
    }
    for (const s of Object.values(b.stock)) if (s.n < s.target) s.n = Math.min(s.target, s.n + s.target * BM.restockH / 3600 * dt);
  }
}

/** reference price of a plain item: median normal-market bid over public stations, else its base value */
const refCache = new WeakMap<WorldState, { t: number; m: Map<string, number> }>();
export function refPrice(w: WorldState, item: string): number {
  let c = refCache.get(w); if (!c || c.t !== w.time) { c = { t: w.time, m: new Map() }; refCache.set(w, c); }
  const hit = c.m.get(item); if (hit !== undefined) return hit;
  const v = refPriceNow(w, item); c.m.set(item, v); return v;
}
function refPriceNow(w: WorldState, item: string): number {
  const v3 = growthOn(w), bids: number[] = [];
  for (const st of Object.values(w.stations)) if (st.public && st.market?.[item]) bids.push(priceOf(st.market[item], 'sell', v3));
  if (!bids.length) return itemPrice(item);
  bids.sort((a, b) => a - b);
  return bids[Math.floor(bids.length / 2)];
}
const glutCap = (w: WorldState, item: string) => Math.max(20, Math.round(BM.glutValue / Math.max(1, refPrice(w, item))));

/** why this black market will not buy this key (null = it buys it) */
export function bmRefusal(w: WorldState, b: BlackMarket, key: string): string | null {
  if (isHot(key)) return stealable(baseItem(key)) ? null : '취급하지 않는 장물입니다';
  if (!(RESTRICTED_ITEMS as readonly string[]).includes(key)) return '정상 화물은 일반 시장에서 거래하세요 — 암시장은 장물과 지역 제한 물품만 매입합니다';
  return null;
}
/** price per unit this black market pays for `key` before the fee, with `extra` units already sold in this deal */
export function bmBid(w: WorldState, b: BlackMarket, key: string, extra = 0): number {
  const item = baseItem(key), def = BM_TIERS[b.tier];
  const restricted = restrictedAt(w, w.stations[b.station]).includes(item);
  const mul = isHot(key) ? def.disc : restricted ? def.premium : 0.8;
  const sat = Math.max(0.2, 1 - 0.5 * ((b.glut[item] ?? 0) + extra) / glutCap(w, item));
  return Math.round(refPrice(w, item) * mul * sat * 10) / 10;
}
/** price per unit asked for restricted goods it stocks */
export const bmAsk = (w: WorldState, b: BlackMarket, item: string) => Math.round(refPrice(w, item) * BM_TIERS[b.tier].ask * 10) / 10;

/** what a sale of n units would pay now (after fee, within budget) */
export function bmQuote(w: WorldState, b: BlackMarket, key: string, n: number): { sold: number; gross: number; fee: number; net: number } {
  const feeR = BM_TIERS[b.tier].fee;
  let funds = b.funds, left = Math.floor(n), sold = 0, gross = 0;
  while (left > 0) {
    let chunk = Math.min(left, BM.chunk);
    const p = bmBid(w, b, key, sold); if (p <= 0) break;
    const can = Math.floor(funds / (p * (1 - feeR)));
    if (can < chunk) chunk = can;
    if (chunk <= 0) break;
    gross += chunk * p; funds -= chunk * p * (1 - feeR); sold += chunk; left -= chunk;
  }
  return { sold, gross, fee: gross * feeR, net: gross * (1 - feeR) };
}

function log(co: Company, e: BmLog) { const b = (co.bm ??= { known: [] }); (b.log ??= []).push(e); if (b.log.length > BM.logCap) b.log.splice(0, b.log.length - BM.logCap); }
export interface BmLog { t: number; k: 'sell' | 'buy' | 'pass' | 'seize' | 'return' | 'found' | 'held' | 'claim'; at: string; items?: Cargo; value?: number; fine?: number; why?: string }

/**
 * P13.3.1 customs return lot: stolen goods of a player company that the authorities seized from someone else.
 * They stay at the customs office of the station where they were seized (gate seizures: the nearest public station
 * of that system the owner may dock at) until the owner claims them there with a docked ship, into that ship's free
 * hold or its storage room at that station. A lot is neither storage nor cargo, so production, markets, contracts,
 * construction and logistics never see it; it lives in the owner's private company record (saved, never sent to
 * other companies) and is never destroyed.
 */
/** `station` '' (P13.4 worlds): held by the authorities in system `sys` at `pos` (the seizure point) — no customs
 *  station there; the owner collects it there with a ship, it never moves to another system by itself */
export interface CustomsLot { id: string; item: string; n: number; station: string; from: string; t: number; sys?: string; pos?: { x: number; y: number; z: number } }

/** the company learns where this black market is (docking at its station; P10 deep intel of its system) */
export function discover(h: Pick<Host, 'st' | 'time' | 'ev'>, company: string, b: BlackMarket, how: string) {
  const co = h.st.companies[company]; if (!co || co.kind !== 'player') return;
  const s = (co.bm ??= { known: [] });
  if (s.known.includes(b.id)) return;
  s.known.push(b.id);
  const st = h.st.stations[b.station];
  log(co, { t: h.time, k: 'found', at: b.station, why: how });
  h.ev('info', `${st?.name ?? b.station}: 암시장 접선처 발견 (${BM_TIERS[b.tier].name}) — ${how}`, { company, pos: st?.pos, ref: b.station, tag: 'blackmarket' });
}
/** P10 intel: full knowledge (level 3) of a system reveals its black market */
export function discoverByIntel(h: Pick<Host, 'st' | 'time' | 'ev'>) {
  const w = h.st; if (!w.blackMarketV || !w.blackMarkets || w.fog !== 1) return;
  for (const b of Object.values(w.blackMarkets)) {
    const sys = sysAt(w.systems, w.stations[b.station]?.pos ?? { x: 0, y: 0, z: 0 }); if (!sys) continue;
    for (const [co, intel] of Object.entries(w.intel ?? {})) if ((intel.sys[sys.id] ?? 0) >= 3 && !knowsBm(w.companies[co], b.id)) discover(h, co, b, '성계 정밀 정보');
  }
}

// ------------------------------------------------------------------ trades

/** where the goods of a black-market trade are: a docked own ship's hold, or the company's storage at the station */
function source(h: Host, company: string, st: Station, ship?: string): { cargo: Cargo; s?: WShip } | string {
  if (ship !== undefined) {
    const s = h.st.ships[ship];
    if (!s || s.owner !== company) return '자사 함선이 아닙니다';
    if (s.state !== 'docked' || s.task.k !== 'docked' || s.task.station !== st.id) return '이 정거장에 정박 중인 함선이 아닙니다';
    return { cargo: s.cargo, s };
  }
  return { cargo: h.storage(st, company) };
}
/** shared checks: world, station, known market, docking */
function access(h: Host, company: string, station: unknown): { st: Station; b: BlackMarket } | string {
  if (!h.st.blackMarketV) return '이 월드에는 암시장이 없습니다';
  if (typeof station !== 'string' || !Object.hasOwn(h.st.stations, station)) return '정거장이 없습니다';
  const st = h.st.stations[station], b = bmAt(h.st, station);
  if (!b || !knowsBm(h.st.companies[company], b.id)) return '이 정거장에서 아는 암시장 접선처가 없습니다';
  if (!h.canDock(st, company)) return '이 정거장에 입항할 수 없습니다 (세력 평판)';
  return { st, b };
}

/** sell stolen / restricted goods to a black market; credits only for units really taken */
export function bmSell(h: Host, company: string, station: unknown, key: unknown, amount: unknown, ship?: string): { sold: number; net: number; fee: number } | string {
  const a = access(h, company, station); if (typeof a === 'string') return a;
  if (typeof key !== 'string' || !key || Object.hasOwn(Object.prototype, key)) return '품목이 올바르지 않습니다';
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1) return '판매 수량이 올바르지 않습니다';
  const why = bmRefusal(h.st, a.b, key); if (why) return why;
  const src = source(h, company, a.st, ship); if (typeof src === 'string') return src;
  const have = Math.floor(qty(src.cargo, key) + 1e-9);
  if (have <= 0) return ship ? '함선에 해당 화물이 없습니다' : '보관함에 해당 화물이 없습니다';
  const n = Math.min(Math.floor(amount), have);
  return watchMoney(h.st, 'black_market_sale', { company, station: a.st.id, item: key }, () => {
    const q = bmQuote(h.st, a.b, key, n);
    if (q.sold <= 0) return `암시장 매입 자금이 바닥났습니다 (현재 ${Math.round(a.b.funds).toLocaleString()} cr) — 시간이 지나면 회복됩니다`;
    takec(src.cargo, key, q.sold);
    if (src.s?.salvaged?.[key]) { src.s.salvaged[key] = Math.max(0, src.s.salvaged[key] - q.sold); if (src.s.salvaged[key] <= 1e-9) delete src.s.salvaged[key]; if (!Object.keys(src.s.salvaged).length) delete src.s.salvaged; }
    a.b.funds -= q.net; a.b.paid += q.net; a.b.took += q.sold;
    const item = baseItem(key); a.b.glut[item] = (a.b.glut[item] ?? 0) + q.sold;
    const co = h.st.companies[company];
    co.credits += q.net; co.stats.earned += q.net;
    book(h, company, 'blackmarket', q.net, key);
    const before = co.credits; payFromSale(h.st, co, q.net); if (co.credits !== before) book(h, company, 'upkeep', co.credits - before);
    emit(h.st, { kind: 'blackmarket', reason: 'sell', amount: q.sold, value: q.net, company, station: a.st.id, item: key, ref: a.b.id });
    log(co, { t: h.time, k: 'sell', at: a.st.id, items: { [key]: q.sold }, value: q.net, fine: q.fee });
    h.ev('money', `${a.st.name} 암시장: ${itemNameOf(key)} ${q.sold} 처분 +${Math.round(q.net).toLocaleString()} cr (수수료 ${Math.round(q.fee).toLocaleString()})${q.sold < n ? ` — 매입 자금 소진, ${n - q.sold}은(는) 남음` : ''}`, { company, pos: a.st.pos, tag: 'blackmarket' });
    return { sold: q.sold, net: q.net, fee: q.fee };
  });
}

/** buy restricted goods a black market stocks, into a docked ship or company storage at the station */
export function bmBuy(h: Host, company: string, station: unknown, item: unknown, amount: unknown, ship?: string): { bought: number; cost: number } | string {
  const a = access(h, company, station); if (typeof a === 'string') return a;
  if (typeof item !== 'string' || !Object.hasOwn(a.b.stock, item)) return '이 암시장은 이 품목을 팔지 않습니다';
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1) return '구매 수량이 올바르지 않습니다';
  const s = a.b.stock[item], n = Math.min(Math.floor(amount), Math.floor(s.n + 1e-9));
  if (n <= 0) return '재고가 없습니다';
  const co = h.st.companies[company], price = bmAsk(h.st, a.b, item), cost = n * price;
  if (co.credits < cost) return `자금 부족 (${Math.round(cost).toLocaleString()} cr 필요)`;
  const dst = source(h, company, a.st, ship); if (typeof dst === 'string') return dst;
  if (dst.s) { const free = Math.floor(econOf(dst.s).cargo - cargoSum(dst.s.cargo)); if (free < n) return `화물칸 부족 — 여유 ${Math.max(0, free)}`; }
  else if (h.overCap(a.st, company, n)) return h.storageFullMsg(a.st, company, n);
  return watchMoney(h.st, 'black_market_buy', { company, station: a.st.id, item }, () => {
    co.credits -= cost; s.n -= n; addc(dst.cargo, item, n); a.b.sold += n;
    a.b.funds = Math.min(a.b.fundsMax * 1.5, a.b.funds + cost * BM.inflow);
    book(h, company, 'blackmarket', -cost, item);
    emit(h.st, { kind: 'blackmarket', reason: 'buy', amount: n, value: cost, company, station: a.st.id, item, ref: a.b.id });
    log(co, { t: h.time, k: 'buy', at: a.st.id, items: { [item]: n }, value: cost });
    h.ev('money', `${a.st.name} 암시장: ${itemNameOf(item)} ${n} 구매 -${Math.round(cost).toLocaleString()} cr`, { company, pos: a.st.pos, tag: 'blackmarket' });
    return { bought: n, cost };
  });
}
const itemNameOf = (k: string) => ITEM_NAME_HOOKS.map(f => f(k)).find(Boolean) ?? ITEMS[k]?.name ?? EQUIPMENT[k]?.name ?? k;

/** P13.3.1: how many black markets this company knows and may dock at now (no hidden knowledge involved) */
export function knownBmCount(h: Pick<Host, 'st' | 'canDock'>, company: string): number {
  const w = h.st; if (!w.blackMarketV) return 0;
  const co = w.companies[company];
  return Object.values(w.blackMarkets ?? {}).filter(b => knowsBm(co, b.id) && w.stations[b.station] && h.canDock(w.stations[b.station], company)).length;
}
/** shown where a raid finds no target only because nothing it could take would sell (P13.3.1 decision 2) */
export const NO_BM_WHY = '암시장 미발견 — 약탈품은 장물이 되어 아는 암시장에서만 처분할 수 있습니다. 암시장 정거장에 입항하거나 성계 정밀 정보를 얻어 찾아야 자동 목표 선정이 가능합니다 (목표 직접 지정 약탈은 가능)';
/** best black-market sale (net) of these goods for a company: markets it knows and may dock at, each item at its best */
export function bmBestSale(h: Pick<Host, 'st' | 'canDock'>, company: string, goods: Cargo): number {
  const w = h.st; if (!w.blackMarketV) return 0;
  const co = w.companies[company];
  const mine = Object.values(w.blackMarkets ?? {}).filter(b => knowsBm(co, b.id) && w.stations[b.station] && h.canDock(w.stations[b.station], company));
  let total = 0;
  for (const [k, n] of Object.entries(goods)) { if (n <= 0) continue; let best = 0; for (const b of mine) if (!bmRefusal(w, b, k)) best = Math.max(best, bmQuote(w, b, k, n).net); total += best; }
  return total;
}

// ------------------------------------------------------------------ inspections

/** illicit cargo aboard for this check: stolen goods always, restricted goods only where they are forbidden */
export function contraband(w: WorldState, s: WShip, forbidden: readonly string[]): Cargo {
  const out: Cargo = {};
  for (const k in s.cargo) { const n = s.cargo[k]; if (n > 1e-9 && (isHot(k) || forbidden.includes(k))) out[k] = n; }
  return out;
}
const cargoValue = (w: WorldState, c: Cargo) => Object.entries(c).reduce((a, [k, n]) => a + n * refPrice(w, baseItem(k)), 0);

/** detection chance of this cargo at this place (0 where the law does not reach, own stations never) */
export function inspectChance(w: WorldState, company: string, sys: StarSystem | undefined, kind: 'gate' | 'dock', c: Cargo, st?: Station): number {
  if (!sys || !Object.keys(c).length) return 0;
  if (kind === 'dock' && (!st?.public || st.owner === company)) return 0;
  const sec = effSec(sys); if (sec < BM.secFloor) return 0;
  const secW = Math.min(1, (sec - BM.secFloor) / (100 - BM.secFloor));
  const size = Math.max(0.5, Math.min(1.5, 0.5 + cargoValue(w, c) / 40000));
  const fac = st?.faction ?? sys.faction;
  const stand = w.factions && fac ? Math.max(0.4, Math.min(1.6, 1 - standingOf(w, company, fac) / 150)) : 1;
  const covert = st && bmAt(w, st.id) && knowsBm(w.companies[company], bmAt(w, st.id)!.id) ? 0.5 : 1;   // contacts at the black market's own station
  const base = kind === 'gate' ? BM.gateBase * secW ** 1.5 : BM.dockBase * secW ** 1.2;
  return Math.max(0, Math.min(BM.maxChance, base * size * stand * covert));
}

/**
 * Event check (gate jump into `sys`, or docking at `st`) of a player's ship carrying illicit cargo. Decided once per
 * (ship, place, window) — redocking or rejumping in the same window replays the recorded outcome, it does not roll
 * again. Returns the outcome, or null when nothing was checked.
 */
export function inspect(h: Host, s: WShip, kind: 'gate' | 'dock', sys: StarSystem | undefined, st?: Station): 'pass' | 'seize' | null {
  const w = h.st; if (!w.blackMarketV || !sys) return null;
  const co = w.companies[s.owner]; if (!co || co.kind !== 'player') return null;
  const forbidden = kind === 'dock' ? restrictedAt(w, st) : [];
  const c = contraband(w, s, forbidden);
  const p = inspectChance(w, s.owner, sys, kind, c, st); if (p <= 0) return null;
  const place = kind === 'dock' ? `st:${st!.id}` : `sys:${sys.id}`;
  const win = Math.floor(h.time / BM.window), key = `${place}#${win}`;
  // a retry in the same window replays the recorded outcome (an alerted post seizes again); it never rolls anew
  const rec = s.insp?.[key];
  const caught = rec ? rec === 'seize' : hash32(`${w.seed ?? 1}|insp|${s.id}|${key}`) / 4294967296 < p;
  s.insp = { ...(s.insp ?? {}) };
  for (const k of Object.keys(s.insp)) if (!k.endsWith(`#${win}`) && !k.endsWith(`#${win - 1}`)) delete s.insp[k];
  s.insp[key] = caught ? 'seize' : 'pass';
  const at = kind === 'dock' ? st!.id : sys.id, where = kind === 'dock' ? st!.name : `${sys.name} 관문`;
  emit(w, { kind: 'blackmarket', reason: caught ? 'inspect_seize' : 'inspect_pass', amount: cargoSum(c), company: s.owner, ship: s.id, system: sys.id, station: st?.id, value: Math.round(p * 1000) / 1000 });
  if (!caught) {
    log(co, { t: h.time, k: 'pass', at, items: c, why: `${kind === 'dock' ? '입항' : '관문'} 검문 통과 (적발 확률 ${pctOf(p)})` });
    h.ev('info', `${s.name}: ${where} 검문 통과 — 불법 화물 미적발`, { company: s.owner, pos: s.pos, tag: 'blackmarket' });
    return 'pass';
  }
  seize(h, s, c, sys, st, where, p, key);
  return 'seize';
}

/**
 * P13.4: the inspection a Union guard group makes after a stop it was complied with. Every stolen unit aboard is
 * found (a real inspection, no roll); the P13.3 seizure rules apply (owner's goods to customs, fine on the seized
 * value). Once per ship and operation — repeating it never seizes or fines twice. Returns the units seized.
 */
export function guardInspect(h: Host, s: WShip, sys: StarSystem, ref: string): number {
  const w = h.st; if (!w.blackMarketV) return 0;
  const co = w.companies[s.owner]; if (!co || co.kind !== 'player') return 0;
  const key = `stop:${ref}`;
  if (s.insp?.[key]) return 0;
  const c = contraband(w, s, []);
  const n = cargoSum(c);
  s.insp = { ...(s.insp ?? {}), [key]: n > 0 ? 'seize' : 'pass' };
  emit(w, { kind: 'blackmarket', reason: n > 0 ? 'inspect_seize' : 'inspect_pass', amount: n, company: s.owner, ship: s.id, system: sys.id, ref });
  if (n <= 0) { log(co, { t: h.time, k: 'pass', at: sys.id, why: '연합 경비대 정선 검문 — 불법 화물 없음' }); return 0; }
  seize(h, s, c, sys, undefined, `${sys.name} 연합 경비대 정선`, 1, key);
  return n;
}

/** confiscation: every illicit unit found leaves the hold (stolen goods go back to a player owner), fine, reputation */
function seize(h: Host, s: WShip, c: Cargo, sys: StarSystem, st: Station | undefined, where: string, p: number, key: string) {
  const w = h.st, co = w.companies[s.owner];
  watchMoney(w, 'black_market_fine', { company: s.owner, station: st?.id }, () => {
    const value = cargoValue(w, c);
    const returned: Record<string, Cargo> = {};
    for (const [k, n] of Object.entries(c)) {
      takec(s.cargo, k, n);
      if (s.salvaged?.[k]) { s.salvaged[k] = Math.max(0, s.salvaged[k] - n); if (s.salvaged[k] <= 1e-9) delete s.salvaged[k]; if (!Object.keys(s.salvaged).length) delete s.salvaged; }
      const hot = parseHot(k), owner = hot ? w.companies[hot.owner] : undefined;
      const office = owner && owner.kind === 'player' && hot!.owner !== s.owner ? customsOffice(h, hot!.owner, st, sys, s.pos) : undefined;
      if (hot && office) {
        holdLot(h, hot.owner, office, hot.item, n, s.owner);
        (returned[hot.owner] ??= {})[hot.item] = (returned[hot.owner][hot.item] ?? 0) + n;
        emit(w, { kind: 'blackmarket', reason: 'customs_hold', amount: n, company: hot.owner, from: s.owner, station: office.id, item: hot.item });
      } else if (hot && w.lawV && owner && owner.kind === 'player' && hot.owner !== s.owner) {
        // P13.4: no customs station in this system — the authorities keep it here, conserved, until the owner comes
        holdLot(h, hot.owner, { sys: sys.id, pos: s.pos }, hot.item, n, s.owner);
        (returned[hot.owner] ??= {})[hot.item] = (returned[hot.owner][hot.item] ?? 0) + n;
        emit(w, { kind: 'blackmarket', reason: 'customs_hold', amount: n, company: hot.owner, from: s.owner, system: sys.id, item: hot.item });
      } else emit(w, { kind: 'blackmarket', reason: 'confiscate', amount: n, company: s.owner, ship: s.id, station: st?.id, system: sys.id, item: k });
    }
    const fine = Math.min(Math.max(0, co.credits), Math.round(value * BM.fine));
    if (fine > 0) {
      co.credits -= fine; book(h, s.owner, 'fines', -fine);
      if (st?.public) fundsIn(st, fine);
      emit(w, { kind: 'blackmarket', reason: 'fine', amount: fine, company: s.owner, station: st?.id, system: sys.id });
    }
    const sec = effSec(sys);
    co.rep = Math.max(0, co.rep - value * BM.repPerCr * (sec / 100));
    const fac = st?.faction ?? sys.faction;
    if (w.factions && fac && fac !== 'pirates') bumpStanding(w, s.owner, fac, -Math.min(BM.standingCap, value * BM.standingPerCr));
    log(co, { t: h.time, k: 'seize', at: st?.id ?? sys.id, items: c, value, fine, why: `${where} 검문 적발 (확률 ${pctOf(p)})` });
    h.ev('warn', `${s.name}: ${where} 검문에 적발 — 불법 화물 ${Math.round(cargoSum(c))}단위 압수, 벌금 ${fine.toLocaleString()} cr`, { company: s.owner, pos: s.pos, tag: 'blackmarket' });
    for (const [owner, items] of Object.entries(returned)) {
      const office = customsOffice(h, owner, st, sys, s.pos);
      const list = Object.entries(items).map(([k, n]) => `${itemNameOf(k)} ${Math.round(n)}`).join(', ');
      if (office) {
        log(w.companies[owner], { t: h.time, k: 'held', at: office.id, items, why: `${co.name} 화물 압수 — 도난품 세관 반환 대기` });
        h.ev('info', `당국이 도난 화물을 회수했습니다 (${list}) — ${office.name} 세관 반환 대기. 자사 함선을 입항시켜 인수하세요`, { company: owner, pos: office.pos, ref: office.id, tag: 'blackmarket' });
      } else {
        log(w.companies[owner], { t: h.time, k: 'held', at: sys.id, items, why: `${co.name} 화물 압수 — ${sys.name} 현장 보관 (세관 정거장 없음)` });
        h.ev('info', `당국이 도난 화물을 회수했습니다 (${list}) — ${sys.name}에 세관 정거장이 없어 압수 지점에 보관 중. 자사 함선을 보내 인수하세요`, { company: owner, pos: s.pos, tag: 'blackmarket' });
      }
    }
    if (w.lawV) lawCrime(h, { kind: 'smuggling', by: s.owner, group: s.groupId, ship: s.id, sys: sys.id, pos: s.pos, value, key: `smug:${s.id}:${key}`, how: 'inspection' });
  });
}

// ------------------------------------------------------------------ customs return lots (P13.3.1)

/** where the authorities keep goods seized here for `owner`: the inspecting station, else the nearest public station
 *  of the system the owner may dock at, else the nearest such station anywhere (never the owner's home by magic) */
export function customsOffice(h: Host, owner: string, st: Station | undefined, sys: StarSystem, pos: { x: number; y: number; z: number }): Station | undefined {
  if (st?.public) return st;
  const pub = Object.values(h.st.stations).filter(x => x.public && h.canDock(x, owner));
  const d2 = (x: Station) => (x.pos.x - pos.x) ** 2 + (x.pos.y - pos.y) ** 2 + (x.pos.z - pos.z) ** 2;
  const here = pub.filter(x => sysAt(h.st.systems, x.pos)?.id === sys.id);
  // P13.4: goods never jump to a station in another system — without one here they stay held in this system
  if (h.st.lawV && !here.length) return undefined;
  const pool = here.length ? here : pub.length ? pub : Object.values(h.st.stations).filter(x => x.public);
  let best: Station | undefined;
  for (const x of pool) if (!best || d2(x) < d2(best) || (d2(x) === d2(best) && x.id < best.id)) best = x;
  return best;
}
export const customsLots = (co: Company | undefined): CustomsLot[] => co?.bm?.customs ?? [];
/** units of `item` (all items when omitted) waiting at customs for this company */
export function customsHeld(co: Company | undefined, item?: string): number { return customsLots(co).reduce((a, l) => a + (item === undefined || l.item === item ? l.n : 0), 0); }
function holdLot(h: Host, owner: string, office: Station | { sys: string; pos: { x: number; y: number; z: number } }, item: string, n: number, from: string) {
  const b = (h.st.companies[owner].bm ??= { known: [] }), lots = (b.customs ??= []);
  if ('sys' in office) {
    // in-system hold: one lot per item and system, at the first seizure point there
    const same = lots.find(l => !l.station && l.sys === office.sys && l.item === item);
    if (same) { same.n += n; same.t = h.time; same.from = from; }
    else lots.push({ id: h.id('cu'), item, n, station: '', sys: office.sys, pos: { x: office.pos.x, y: office.pos.y, z: office.pos.z }, from, t: h.time });
    return;
  }
  const same = lots.find(l => l.station === office.id && l.item === item);
  if (same) { same.n += n; same.t = h.time; same.from = from; }
  else lots.push({ id: h.id('cu'), item, n, station: office.id, from, t: h.time });
}
/** a ship can collect an in-system customs lot: in space in that system, within this distance of the hold point */
export const HOLD_R = 3000;

/**
 * The owner takes a customs lot back: one of its ships must be docked at the lot's station (the pick-up), and the
 * goods go into that ship's free hold (`ship`) or the company's storage room at that station. Only what really fits
 * moves; the rest keeps waiting. Nothing is created or lost.
 */
export function customsClaim(h: Host, company: string, lotId: unknown, amount: unknown, ship: unknown, toStorage: unknown): { moved: number; left: number } | string {
  const w = h.st; if (!w.blackMarketV) return '이 월드에는 세관 반환 제도가 없습니다';
  const co = w.companies[company], lots = co?.bm?.customs;
  const lot = typeof lotId === 'string' ? lots?.find(l => l.id === lotId) : undefined;
  if (!lot || !lots) return '세관 반환 대기 화물이 없습니다';
  if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1)) return '인수 수량이 올바르지 않습니다';
  if (typeof ship !== 'string') return '인수할 함선을 지정하세요';
  if (!lot.station) return claimHeld(h, co, lots, lot, amount, ship, toStorage);
  const st = w.stations[lot.station]; if (!st) return '보관 정거장이 없습니다';
  const s = w.ships[ship];
  if (!s || s.owner !== company) return '자사 함선이 아닙니다';
  if (s.state !== 'docked' || s.task.k !== 'docked' || s.task.station !== st.id) return `${st.name}에 정박 중인 함선이 있어야 인수할 수 있습니다`;
  if (!h.canDock(st, company)) return '이 정거장에 입항할 수 없습니다 (세력 평판)';
  const want = Math.min(lot.n, amount === undefined ? lot.n : Math.floor(amount as number));
  let room: number;
  if (toStorage === true) room = Math.floor(h.intakeRoom(st, company, lot.item) + 1e-9);
  else room = Math.floor(econOf(s).cargo - cargoSum(s.cargo) + 1e-9);
  const n = Math.min(want, Math.max(0, room));
  if (n < 1) return toStorage === true ? h.storageFullMsg(st, company, Math.max(1, Math.ceil(want))) : `화물칸 부족 — 여유 ${Math.max(0, room)}`;
  addc(toStorage === true ? h.storage(st, company) : s.cargo, lot.item, n);
  lot.n -= n;
  if (lot.n <= 1e-9) lots.splice(lots.indexOf(lot), 1);
  if (!lots.length) delete co.bm!.customs;
  emit(w, { kind: 'blackmarket', reason: 'customs_claim', amount: n, company, station: st.id, ship: s.id, item: lot.item });
  log(co, { t: h.time, k: 'claim', at: st.id, items: { [lot.item]: n }, why: toStorage === true ? '세관 인수 → 보관함' : `세관 인수 → ${s.name}` });
  h.ev('info', `${st.name} 세관: ${itemNameOf(lot.item)} ${n} 인수 (${toStorage === true ? '보관함' : s.name})${lot.n > 1e-9 ? ` — ${Math.round(lot.n)} 대기 중` : ''}`, { company, pos: st.pos, ref: st.id, tag: 'blackmarket' });
  return { moved: n, left: Math.max(0, lot.n) };
}

/** P13.4: collect an in-system hold — a ship of the owner in space at the hold point, into its free hold only */
function claimHeld(h: Host, co: Company, lots: CustomsLot[], lot: CustomsLot, amount: unknown, ship: string, toStorage: unknown): { moved: number; left: number } | string {
  const w = h.st, s = w.ships[ship], sys = lot.sys ? w.systems[lot.sys] : undefined;
  if (!s || s.owner !== co.id) return '자사 함선이 아닙니다';
  if (toStorage === true) return '현장 보관 화물은 함선 화물칸으로만 인수할 수 있습니다';
  if (!sys || !lot.pos || s.state !== 'space' || sysAt(w.systems, s.pos)?.id !== sys.id || dist(s.pos, lot.pos) > HOLD_R) return `${sys?.name ?? lot.sys} 압수 지점(${HOLD_R / 1000} km 이내)에 자사 함선이 있어야 인수할 수 있습니다`;
  const want = Math.min(lot.n, amount === undefined ? lot.n : Math.floor(amount as number));
  const room = Math.floor(econOf(s).cargo - cargoSum(s.cargo) + 1e-9);
  const n = Math.min(want, Math.max(0, room));
  if (n < 1) return `화물칸 부족 — 여유 ${Math.max(0, room)}`;
  addc(s.cargo, lot.item, n);
  lot.n -= n;
  if (lot.n <= 1e-9) lots.splice(lots.indexOf(lot), 1);
  if (!lots.length) delete co.bm!.customs;
  emit(w, { kind: 'blackmarket', reason: 'customs_claim', amount: n, company: co.id, system: sys.id, ship: s.id, item: lot.item });
  log(co, { t: h.time, k: 'claim', at: sys.id, items: { [lot.item]: n }, why: `${sys.name} 현장 보관 인수 → ${s.name}` });
  h.ev('info', `${sys.name} 현장 보관: ${itemNameOf(lot.item)} ${n} 인수 (${s.name})${lot.n > 1e-9 ? ` — ${Math.round(lot.n)} 대기 중` : ''}`, { company: co.id, pos: lot.pos, tag: 'blackmarket' });
  return { moved: n, left: Math.max(0, lot.n) };
}

// ------------------------------------------------------------------ safe automatic unloading (P13.3.1)

/**
 * Inspection risk when an automatic unloading run takes these ships' cargo from `from` to `st`: the largest
 * detection chance among the gate checks of the systems entered on the gate route and the dock check at the station
 * (stolen goods, plus goods restricted there). 0 = no inspection can happen (own stations, private stations,
 * lawless space, no contraband). Pirates and NPC companies are never inspected.
 */
export function unloadRisk(h: Host, company: string, from: { x: number; y: number; z: number }, st: Station, ships: WShip[]): number {
  const w = h.st; if (!w.blackMarketV || w.companies[company]?.kind !== 'player') return 0;
  const hot: Cargo = {}, dockC: Cargo = {}, forb = restrictedAt(w, st);
  for (const s of ships) for (const k in s.cargo) { const n = s.cargo[k]; if (n <= 1e-9) continue; if (isHot(k)) hot[k] = (hot[k] ?? 0) + n; if (isHot(k) || forb.includes(k)) dockC[k] = (dockC[k] ?? 0) + n; }
  let p = inspectChance(w, company, sysAt(w.systems, st.pos), 'dock', dockC, st);
  if (Object.keys(hot).length) {
    const a = sysAt(w.systems, from), b = sysAt(w.systems, st.pos);
    if (a && b && a.id !== b.id) {
      const r = routeSystems(w.systems, a.id, b.id, g => !w.conflicts || gateOpen(w, g)) ?? routeSystems(w.systems, a.id, b.id, () => true);
      for (const id of r?.sys.slice(1) ?? []) p = Math.max(p, inspectChance(w, company, w.systems[id], 'gate', hot));
    }
  }
  return p;
}
const unsafeWarned = new Map<string, number>();
/** a fleet keeps its stolen goods aboard because no station is safe to unload at: tell the owner (throttled) */
export function warnNoSafeUnload(h: Host, g: WGroup) {
  if ((unsafeWarned.get(g.id) ?? -Infinity) + BM.unloadWarn > h.time) return;
  unsafeWarned.set(g.id, h.time);
  h.ev('warn', `${g.name}: 장물 안전 하역지 없음 — 검문 위험이 없는 자사·안전 정거장이 없어 화물을 실은 채 대기합니다. 밀수 운송이나 직접 입항·하역을 지시하세요`, { company: g.owner, pos: h.groupCenter(g) ?? undefined, tag: 'blackmarket' });
}

/** sim hooks */
export function onJump(h: Host, s: WShip, sys: StarSystem | undefined) { if (h.st.blackMarketV && s.cargo && cargoSum(s.cargo) > 0) inspect(h, s, 'gate', sys); }
export function onDock(h: Host, s: WShip, st: Station) {
  const w = h.st; if (!w.blackMarketV) return;
  const b = bmAt(w, st.id);
  if (b && w.companies[s.owner]?.kind === 'player') discover(h, s.owner, b, `${s.name} 입항 중 접선`);
  if (cargoSum(s.cargo) > 0) inspect(h, s, 'dock', sysAt(w.systems, st.pos), st);
}

// ------------------------------------------------------------------ smuggling order

export interface SmuggleState { key: string; phase: 'load' | 'go' | 'sell' | 'done'; why?: string; loaded?: Cargo; sold?: number; net?: number; since: number }
type SmuggleOp = Extract<Op, { k: 'smuggle' }>;
const carriers = (ships: WShip[]) => ships.filter(s => econOf(s).cargo > 0 && econOf(s).cruise > 0);
/** what a smuggling run carries from storage: stolen goods, and restricted goods if asked */
const smugglable = (k: string, op: SmuggleOp) => isHot(k) ? (!op.items || op.items.includes(k)) : !!op.items?.includes(k) && (RESTRICTED_ITEMS as readonly string[]).includes(k);

export function validateSmuggle(h: Host, company: string, ships: WShip[], op: SmuggleOp): string | null {
  if (!h.st.blackMarketV) return '이 월드에는 암시장이 없습니다';
  const a = access(h, company, op.to); if (typeof a === 'string') return a;
  if (op.from !== undefined) { const f = typeof op.from === 'string' && Object.hasOwn(h.st.stations, op.from) ? h.st.stations[op.from] : undefined; if (!f || !h.canDock(f, company)) return '적재할 출발 정거장을 선택하세요'; if (f.id === a.st.id) return '출발지와 암시장 정거장이 같습니다'; }
  if (op.items !== undefined && (!Array.isArray(op.items) || op.items.some(k => typeof k !== 'string' || (!isHot(k) && !(RESTRICTED_ITEMS as readonly string[]).includes(k))))) return '밀수 품목이 올바르지 않습니다';
  if (!carriers(ships).length) return '화물을 실을 함선이 없습니다';
  return null;
}

/** one tick of a smuggling run: load at `from` (optional) → fly to the black market's station (gate and docking checks
 *  happen on the way, as events) → dock → sell what is aboard (optional) → wait docked */
export function stepSmuggle(h: Host, g: WGroup, ships: WShip[], op: SmuggleOp, dt: number): boolean {
  const w = h.st; if (!w.blackMarketV) return false;
  const key = JSON.stringify(op);
  let S = g.smug; if (!S || S.key !== key) S = g.smug = { key, phase: op.from ? 'load' : 'go', since: h.time };
  const work = carriers(ships), speed = h.groupSpeedOf(g);
  const to = w.stations[op.to];
  if (!to) { finish(h, g, S, '목적 정거장이 사라졌습니다'); return true; }
  if (S.phase === 'load') {
    const from = w.stations[op.from!];
    if (!from || !h.canDock(from, g.owner)) { S.phase = 'go'; S.why = '출발 정거장에 입항할 수 없어 적재 없이 출발'; }
    else {
      let ready = 0;
      const store = h.storage(from, g.owner);
      for (const s of work) {
        if (!h.goDock(s, from, dt, speed)) continue;
        const free = Math.floor(econOf(s).cargo - cargoSum(s.cargo));
        const want = Object.keys(store).filter(k => qty(store, k) >= 1 && smugglable(k, op)).sort();
        const total = Math.min(free, want.reduce((a, k) => a + Math.floor(qty(store, k)), 0));
        if (total <= 0) { ready++; continue; }
        const permit = stationCargoRate(from) !== undefined ? h.cargoPermit(s, from, 'smuggle-load', total) : total;
        if (permit === null) continue;
        let left = Math.floor(permit);
        for (const k of want) {
          const n = Math.min(left, Math.floor(qty(store, k))); if (n <= 0) continue;
          takec(store, k, n); addc(s.cargo, k, n); left -= n;
          (S.loaded ??= {})[k] = (S.loaded[k] ?? 0) + n;
          emit(w, { kind: 'blackmarket', reason: 'load', amount: n, company: g.owner, ship: s.id, station: from.id, item: k });
        }
        ready++;
      }
      if (ready === work.length) { S.phase = 'go'; S.since = h.time; if (!S.loaded) S.why = '출발 정거장 보관함에 실을 장물·제한 물품이 없습니다'; }
      g.status = `밀수: ${from.name}에서 적재 중`;
      return true;
    }
  }
  if (S.phase === 'go') {
    let docked = 0;
    for (const s of work) if (h.goDock(s, to, dt, speed)) docked++;
    g.status = `밀수: ${to.name}(으)로 이동 중`;
    if (docked === work.length) { S.phase = op.sell ? 'sell' : 'done'; S.since = h.time; if (!op.sell) finish(h, g, S, `${to.name} 도착 — 암시장 거래 화면에서 처분하세요`); }
    return true;
  }
  if (S.phase === 'sell') {
    let sold = 0, net = 0; const left: string[] = [];
    for (const s of work) for (const k of Object.keys(s.cargo).filter(k => qty(s.cargo, k) >= 1 && (isHot(k) || (RESTRICTED_ITEMS as readonly string[]).includes(k))).sort()) {
      const r = bmSell(h, g.owner, to.id, k, Math.floor(qty(s.cargo, k)), s.id);
      if (typeof r === 'string') { left.push(r); continue; }
      sold += r.sold; net += r.net;
      if (qty(s.cargo, k) >= 1) left.push('매입 자금 소진');
    }
    S.sold = sold; S.net = net;
    finish(h, g, S, sold > 0 ? `${to.name} 암시장 처분 ${sold}단위 +${Math.round(net).toLocaleString()} cr${left.length ? ` (일부 남음: ${[...new Set(left)][0]})` : ''}` : `처분 실패 — ${left[0] ?? '실은 장물이 없습니다'}`);
    return true;
  }
  g.status = `밀수 완료 — ${S.why ?? ''}`;
  return true;
}
function finish(h: Host, g: WGroup, S: NonNullable<WGroup['smug']>, why: string) {
  S.phase = 'done'; S.why = why;
  h.say(g, `밀수 작전 종료 — ${why}`, 'info', 0);
  g.op = { k: 'idle' };
  g.status = `밀수 완료 — ${why}`;
}
