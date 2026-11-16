// A-3.2b natural derelicts and salvage contracts (salvageV worlds with derelictV).
//
// A derelict is an ordinary P13.1 WreckSite with `origin: 'derelict'`: one shared world object every company
// works with the same salvage engine (recover / salvzone / auto), never a per-player copy. Its lots are
// ownerless (owner ''), so taking them is legal salvage — the P13.1 protection, crime and reputation rules
// are unchanged because they only concern cargo of an existing company.
//
// Supply is finite and irregular. Systems are grouped into regions (faction territory × security band); each
// region has a concurrent count, a total value cap and a spawn period with jitter. A check runs once a minute
// (never per tick), ids come from a counter in the world state and contents from a hash of the world seed and
// that counter, so a restart or a reconnect can never create a derelict twice and other RNG streams are untouched.
// What appears is recorded as salvage/derelict_<kind> per lot; what is left when it expires is consume/wreck_decay
// (expireWrecks), so: spawned = recovered + remaining + decayed.
//
// Salvage contracts: a station posts a job on an existing derelict nearby (or, within its own budget and
// cooldown, has one reported in its own system). The reward is reserved from the station's real funds when a
// company accepts it, paid on completion and returned on failure. Only goods recovered from the target and
// unloaded at the posting station count (ship-side provenance `salvSrc`); they are consumed (handed over).
// See docs/A3_2B_FIRST_SALVAGE.md.
import type { Contract, Station, StarSystem, V, WorldState } from './types';
import type { WreckLot, WreckSite } from './wrecks';
import { lotValue } from './wrecks';
import { emit } from './observe';
import { jumps, sysAt } from './geom';
import { wreckFragments } from './blueprints';
import { itemName } from './industry';

export type Grade = 'small' | 'medium' | 'large';
export interface RegionState { next: number; nudged?: number }
export interface DerelictState {
  /** derelicts made so far (id counter and content seed) */
  seq: number;
  /** next spawn check (world time) */
  check: number;
  regions: Record<string, RegionState>;
  /** salvage contracts: next posting allowed per station, and contract-made derelicts per station */
  posts: Record<string, number>;
  /** running totals (reporting) */
  spawned: number; value: number;
}

/** tunables (docs §3) */
export const DERELICT_CFG = {
  /** seconds between spawn checks */
  check: 60,
  /** security bands: grade, per-region concurrent cap, total value cap, mean period (s, ±25 %), lifetime (s) */
  band: {
    safe: { minSec: 70, grade: 'small' as Grade, max: 2, valueCap: 7000, period: 5400, life: 3 * 3600 },
    frontier: { minSec: 40, grade: 'medium' as Grade, max: 1, valueCap: 12000, period: 7200, life: 3 * 3600 },
    danger: { minSec: 0, grade: 'large' as Grade, max: 2, valueCap: 50000, period: 7200, life: 4 * 3600 },
  },
  /** whole-world caps */
  globalMax: 24, globalValue: 300000,
  /** a newly founded salvager may bring its home region's next spawn forward, at most this often per region */
  nudgeEvery: 1800,
  /** placement: distance from the system centre */
  rMin: 12000, rMax: 30000,
  /** salvage contracts */
  contract: {
    /** a station posts at most one open salvage contract, then waits this long before the next */
    cooldown: 2700,
    /** whole world: open salvage contracts at a time, and live derelicts made for contracts */
    maxOpen: 6, maxSpawned: 3,
    /** home stations of salvager companies may post above maxOpen, up to this many extra in the world (beginner follow-up jobs) */
    homeExtra: 2,
    /** chance per contracts pass (≈ every 10 s slow tick) once the cooldown is over */
    chance: 0.05,
    /** target search radius (jumps from the station) */
    jumps: 2,
    /** reward: units × reference value × (base + risk × (100 − security)/100), capped by the station's spare funds */
    base: 1.0, risk: 0.8, fundsShare: 0.06, minFunds: 20000, minReward: 600,
    /** time to finish after acceptance (s) */
    life: 3600,
    /** how long an untaken contract stays on the board (s) */
    board: 2400,
    /** a station may have a derelict reported for its own contract at most this often (s) */
    spawnEvery: 3 * 3600,
  },
} as const;
type BandKey = keyof typeof DERELICT_CFG.band;

export const derelictsOn = (w: Pick<WorldState, 'salvageV' | 'derelictV'>) => !!w.salvageV && !!w.derelictV;
export const isDerelict = (w: Pick<WreckSite, 'origin'> | undefined) => w?.origin === 'derelict';

/** deterministic stream from the world seed and the derelict counter (never touches the world RNG) */
function stream(seed: number, n: number): () => number {
  let a = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(n + 1, 0x85ebca6b)) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (r: () => number, a: number, b: number) => Math.round(a + (b - a) * r());

export const bandOf = (sec: number): BandKey => sec >= DERELICT_CFG.band.safe.minSec ? 'safe' : sec >= DERELICT_CFG.band.frontier.minSec ? 'frontier' : 'danger';
export const regionOf = (s: StarSystem) => `${s.faction ?? 'none'}:${bandOf(s.security)}`;
export const GRADE_NAME: Record<Grade, string> = { small: '소형 유기선', medium: '버려진 수송선', large: '대형 난파선' };

/** systems of each region (stable order) */
function regions(w: WorldState): Map<string, StarSystem[]> {
  const out = new Map<string, StarSystem[]>();
  for (const s of Object.values(w.systems).sort((a, b) => a.idx - b.idx)) { const k = regionOf(s); const l = out.get(k); if (l) l.push(s); else out.set(k, [s]); }
  return out;
}
const live = (w: WorldState) => Object.values(w.wrecks ?? {}).filter(x => x.origin === 'derelict' && x.lots.some(l => l.n > 0));
const siteValue = (w: WorldState, x: Pick<WreckSite, 'lots'>) => x.lots.reduce((a, l) => a + l.n * lotValue(w, l), 0);

/** what a derelict of this grade carries (ownerless): hull scrap, a little trade cargo; equipment / fragments only in large ones */
export function derelictLots(r: () => number, grade: Grade): Omit<WreckLot, 'id' | 'owner'>[] {
  const out: Omit<WreckLot, 'id' | 'owner'>[] = [];
  const pick = <T,>(xs: readonly T[]) => xs[Math.min(xs.length - 1, Math.floor(r() * xs.length))];
  if (grade === 'small') {
    out.push({ k: 'hull', item: 'alloy', n: between(r, 20, 40) }, { k: 'hull', item: 'metal', n: between(r, 25, 45) });
    const c = pick(['machinery', 'metal', 'alloy', 'electronics'] as const);
    out.push({ k: 'cargo', item: c, n: c === 'machinery' ? between(r, 4, 8) : c === 'electronics' ? between(r, 2, 5) : between(r, 15, 30) });
  } else if (grade === 'medium') {
    out.push({ k: 'hull', item: 'alloy', n: between(r, 60, 100) }, { k: 'hull', item: 'metal', n: between(r, 60, 100) }, { k: 'hull', item: 'electronics', n: between(r, 6, 14) });
    out.push({ k: 'cargo', item: pick(['machinery', 'electronics', 'titanium'] as const), n: between(r, 8, 16) });
  } else {
    out.push({ k: 'hull', item: 'alloy', n: between(r, 150, 250) }, { k: 'hull', item: 'metal', n: between(r, 120, 200) }, { k: 'hull', item: 'electronics', n: between(r, 15, 35) }, { k: 'hull', item: 'weapon_parts', n: between(r, 3, 8) });
    out.push({ k: 'cargo', item: pick(['machinery', 'electronics', 'weapon_parts'] as const), n: between(r, 10, 20) });
    const eq = between(r, 0, 2); for (let i = 0; i < eq; i++) out.push({ k: 'equip', item: pick(['eq_autocannon', 'eq_pd_gun', 'eq_medium_gun'] as const), n: 1 });
    if (r() < 0.3) for (const f of wreckFragments(r, ['frigate', 'frigate', 'frigate', 'frigate']).slice(0, 1)) out.push({ k: 'frag', item: f, n: 1 });
  }
  // merge same kind/item
  const m = new Map<string, Omit<WreckLot, 'id' | 'owner'>>();
  for (const l of out) { const k = `${l.k}|${l.item}`; const x = m.get(k); if (x) x.n += l.n; else m.set(k, { ...l }); }
  return [...m.values()].filter(l => l.n > 0);
}

export interface SpawnOpts { system: StarSystem; grade: Grade; region: string; time: number; life: number; near?: V; contract?: string }
/** create one derelict (counter id, seeded contents) and record its appearance; returns it */
export function spawnDerelict(w: WorldState, o: SpawnOpts): WreckSite {
  const D = w.derelicts!;
  const n = ++D.seq, r = stream(w.seed, n);
  const lots: WreckLot[] = derelictLots(r, o.grade).map((l, i) => ({ ...l, id: `l${i}`, owner: '' }));
  const a = r() * Math.PI * 2, rad = o.near ? 6000 + r() * 8000 : DERELICT_CFG.rMin + r() * (DERELICT_CFG.rMax - DERELICT_CFG.rMin);
  const c = o.near ?? o.system.origin;
  const pos = { x: c.x + Math.cos(a) * rad, y: 0, z: c.z + Math.sin(a) * rad };
  // never outside its system
  const inside = sysAt(w.systems, pos)?.id === o.system.id ? pos : { x: o.system.origin.x + Math.cos(a) * DERELICT_CFG.rMin, y: 0, z: o.system.origin.z + Math.sin(a) * DERELICT_CFG.rMin };
  const value = siteValue(w, { lots });
  const main = [...new Set([...lots].sort((x, y) => y.n * lotValue(w, y) - x.n * lotValue(w, x)).map(l => l.item.startsWith('bpf:') ? 'bpf' : l.item))].slice(0, 3);
  const site: WreckSite = {
    id: `dr_${n}`, name: `${o.system.name} ${GRADE_NAME[o.grade]} ${n}`, eng: `derelict:${n}`, system: o.system.id, pos: inside,
    created: o.time, expires: o.time + o.life, sources: [], lots, initial: lots.reduce((s, l) => s + l.n, 0), taken: {}, seen: [],
    origin: 'derelict', grade: o.grade, region: o.region, est: Math.round(value / 100) * 100, main, ...(o.contract ? { contract: o.contract } : {}),
  };
  (w.wrecks ??= {})[site.id] = site;
  D.spawned++; D.value += value;
  for (const l of lots) emit(w, { kind: 'salvage', reason: `derelict_${l.k}`, item: l.item, amount: l.n, system: site.system, ref: site.id });
  return site;
}

/** turn the system on for a world (idempotent): state, then fill every region once (initial placement) */
export function enableDerelicts(w: WorldState, time: number): { made: number } {
  if (!w.salvageV) return { made: 0 };
  w.derelictV = 1;
  w.wrecks ??= {};
  if (w.derelicts) return { made: 0 };
  w.derelicts = { seq: 0, check: time, regions: {}, posts: {}, spawned: 0, value: 0 };
  // stagger the regions' first respawn; fill each region to its cap now
  let made = 0;
  for (const [key, systems] of regions(w)) {
    const B = DERELICT_CFG.band[key.split(':')[1] as BandKey];
    w.derelicts.regions[key] = { next: time };
    for (let i = 0; i < B.max; i++) made += stepRegion(w, key, systems, time, true) ? 1 : 0;
  }
  return { made };
}

/** one region: spawn when its timer is due and its caps allow; returns whether one was made */
function stepRegion(w: WorldState, key: string, systems: StarSystem[], time: number, initial = false): boolean {
  const D = w.derelicts!, R = (D.regions[key] ??= { next: time });
  if (!initial && R.next > time) return false;
  const B = DERELICT_CFG.band[key.split(':')[1] as BandKey];
  const all = live(w), mine = all.filter(x => x.region === key && !x.contract);
  const r = stream(w.seed ^ 0x5bd1e995, D.seq * 31 + systems[0].idx);
  R.next = time + B.period * (0.75 + r() * 0.5);
  if (mine.length >= B.max || all.length >= DERELICT_CFG.globalMax) return false;
  if (mine.reduce((a, x) => a + siteValue(w, x), 0) >= B.valueCap) return false;
  if (all.reduce((a, x) => a + siteValue(w, x), 0) >= DERELICT_CFG.globalValue) return false;
  // a system of the region with no derelict yet, else any of them
  const used = new Set(mine.map(x => x.system));
  const free = systems.filter(s => !used.has(s.id)), pool = free.length ? free : systems;
  const sys = pool[Math.min(pool.length - 1, Math.floor(r() * pool.length))];
  spawnDerelict(w, { system: sys, grade: B.grade, region: key, time, life: B.life });
  return true;
}

/** slow-tick entry: at most once per DERELICT_CFG.check seconds; returns the derelicts made */
export function stepDerelicts(w: WorldState, time: number): WreckSite[] {
  const D = w.derelicts; if (!derelictsOn(w) || !D || D.check > time) return [];
  D.check = time + DERELICT_CFG.check;
  const before = D.seq, made: WreckSite[] = [];
  for (const [key, systems] of regions(w)) stepRegion(w, key, systems, time);
  for (let n = before + 1; n <= D.seq; n++) { const x = w.wrecks?.[`dr_${n}`]; if (x) made.push(x); }
  return made;
}

/** a new salvager: bring its home region's next spawn forward (still capped and shared; at most once per nudgeEvery) */
export function nudgeHomeRegion(w: WorldState, sysId: string | undefined, time: number, homeStation?: string): boolean {
  const D = w.derelicts, s = sysId ? w.systems[sysId] : undefined; if (!derelictsOn(w) || !D || !s) return false;
  const key = regionOf(s), R = (D.regions[key] ??= { next: time });
  if ((R.nudged ?? -Infinity) + DERELICT_CFG.nudgeEvery > time) return false;
  R.nudged = time; R.next = Math.min(R.next, time);
  D.check = Math.min(D.check, time);
  // the home station may post its next salvage job now (same once-per-nudgeEvery limit; budget and target rules unchanged)
  if (homeStation && (D.posts[homeStation] ?? -Infinity) > time) D.posts[homeStation] = time;
  return true;
}

// ───────────────────────────── salvage contracts

/** units of `item` recoverable from a site (lots of any kind) */
export const siteItem = (x: Pick<WreckSite, 'lots'>, item: string) => x.lots.filter(l => l.item === item).reduce((a, l) => a + l.n, 0);

export interface SalvageOffer { target: WreckSite; res: string; amount: number; reward: number; spawn?: SpawnOpts }

/** what a station would post now (pure: nothing changes), or why not */
export function salvageOffer(w: WorldState, st: Station, time: number, r: () => number, secOf: (s: StarSystem) => number): SalvageOffer | string {
  const C = DERELICT_CFG.contract, D = w.derelicts; if (!D) return 'off';
  const home = sysAt(w.systems, st.pos); if (!home) return 'no system';
  if ((st.funds ?? 0) < C.minFunds) return 'funds';
  const open = live(w).filter(x => !x.contract && x.expires - time > C.life + C.board && jumps(w.systems, home.id, x.system) <= C.jumps)
    .sort((a, b) => jumps(w.systems, home.id, a.system) - jumps(w.systems, home.id, b.system) || a.id.localeCompare(b.id));
  // half the time the nearest one (often a safe beginner job), otherwise any within reach (farther ones pay a risk premium)
  let target = open.length ? (r() < 0.5 ? open[0] : open[Math.min(open.length - 1, Math.floor(r() * open.length))]) : undefined;
  let spawn: SpawnOpts | undefined;
  if (!target) {
    if (live(w).filter(x => x.contract && w.contracts[x.contract]?.spawned).length >= C.maxSpawned) return 'spawn cap';
    // no derelict nearby: within the station's own budget, one is reported in its own system for this contract
    if ((D.posts[`spawn:${st.id}`] ?? -Infinity) + C.spawnEvery > time) return 'cooldown';
    const band = bandOf(home.security), B = DERELICT_CFG.band[band];
    spawn = { system: home, grade: B.grade, region: regionOf(home), time, life: B.life, near: st.pos };
    const lots = derelictLots(stream(w.seed, D.seq + 1), B.grade);
    target = { lots: lots.map((l, i) => ({ ...l, id: `l${i}`, owner: '' })), system: home.id } as WreckSite;
  }
  const items = target.lots.filter(l => (l.k === 'hull' || l.k === 'cargo') && l.n >= 10).sort((a, b) => b.n * lotValue(w, b) - a.n * lotValue(w, a));
  if (!items.length) return 'nothing';
  const lot = items[0], have = siteItem(target, lot.item);
  let amount = Math.max(5, Math.floor(have * 0.6 / 5) * 5);
  const sec = secOf(w.systems[target.system] ?? home);
  const unit = lotValue(w, lot) * (C.base + C.risk * (100 - sec) / 100);
  const cap = (st.funds ?? 0) * C.fundsShare;
  if (amount * unit > cap) amount = Math.floor(cap / unit / 5) * 5;   // shrink to the budget
  const reward = Math.round(amount * unit / 50) * 50;
  if (amount < 5 || reward < C.minReward) return 'budget';
  return { target, res: lot.item, amount, reward, spawn };
}

export const contractText = (w: WorldState, k: Pick<Contract, 'target' | 'res' | 'amount'>, st: Station, x: Pick<WreckSite, 'name' | 'system'>) => ({
  title: `인양: ${itemName(k.res!)} ${k.amount} 회수`,
  desc: `${w.systems[x.system]?.name ?? ''}의 ${x.name}에서 ${itemName(k.res!)} ${k.amount}단위를 인양해 ${st.name}에 하역하라. 이 대상에서 직접 회수한 물품만 인정되며 납품분은 발주처에 인도된다. 보수는 수주 시 정거장 예산에서 예약된다. 대상은 다른 회사도 인양할 수 있다.`,
});
