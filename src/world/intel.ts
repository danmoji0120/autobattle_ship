// P10 per-company exploration knowledge. Only active on fog worlds (w.fog === 1).
//
//   level 0  unknown       — uncharted system the company has never reached (adjacent ones show as stubs)
//   level 1  charted       — public chart: name, faction, gates, public stations, identified fields
//   level 2  visited       — a company ship arrived: planets, stations and non-hidden deposits appear
//   level 3  surveyed      — a survey sweep finished: hidden deposits appear
//
// Deposit knowledge comes only from the company's own mined units (recordSample). Nothing here is
// shared: sync replicates intel[company] to that company alone (server/sync.ts). NPC companies are
// treated as omniscient for their AI, which never reaches clients.
import type { Cargo, Field, StarSystem, WorldState } from './types';
import { sysAt } from './geom';
import { siteTier, SCAN_NEED } from './explore';
import { itemPrice } from './industry';

export interface FieldIntel {
  /** time the deposit was found by this company */
  found: number;
  /** discrete units sampled by this company's ships */
  n: number;
  /** cumulative units by item (exact observations) */
  units: Cargo;
  /** first time each item was observed */
  first: Record<string, number>;
  /** last sample time */
  last: number;
}
export interface CompanyIntel {
  /** system id → 2 visited | 3 surveyed (charted level 1 is implicit) */
  sys: Record<string, 2 | 3>;
  /** survey ship-seconds accumulated per system toward level 3 */
  scan: Record<string, number>;
  fields: Record<string, FieldIntel>;
}

export const fogOn = (w: Pick<WorldState, 'fog'>) => w.fog === 1;
const isPlayer = (w: WorldState, co: string) => w.companies[co]?.kind === 'player';

export function intelOf(w: WorldState, co: string): CompanyIntel {
  const all = (w.intel ??= {});
  return (all[co] ??= { sys: {}, scan: {}, fields: {} });
}

/** 0..3; non-fog worlds and NPC companies know everything */
export function sysLevel(w: WorldState, co: string, sysId: string): number {
  const sys = w.systems[sysId]; if (!sys) return 0;
  if (!fogOn(w) || !isPlayer(w, co)) return 3;
  const lv = w.intel?.[co]?.sys[sysId] ?? 0;
  return Math.max(lv, sys.charted === false ? 0 : 1);
}

/** a system name and gates may be shown (known, or one jump from a known system) */
export function sysStub(w: WorldState, co: string, sysId: string): boolean {
  if (sysLevel(w, co, sysId) > 0) return true;
  const sys = w.systems[sysId];
  return !!sys?.gates.some(g => sysLevel(w, co, g.to) >= 2);
}

/** may this company see the deposit at all? */
export function knowsField(w: WorldState, co: string, f: Field): boolean {
  if (!fogOn(w) || !isPlayer(w, co)) return true;
  if (w.intel?.[co]?.fields[f.id]) return true;
  const sys = sysAt(w.systems, f.pos); if (!sys) return false;
  const lv = sysLevel(w, co, sys.id);
  if (!f.geo) return lv >= (sys.charted === false ? 2 : 1);
  return lv >= (f.geo.hidden ? 3 : 2);
}

/** may this company see the object (station, lair, site) located in a system? */
export const knowsSystemContents = (w: WorldState, co: string, sysId: string | undefined) => !sysId || sysLevel(w, co, sysId) >= (w.systems[sysId]?.charted === false ? 2 : 1);

function discover(w: WorldState, co: string, sys: StarSystem, level: 2 | 3): Field[] {
  const I = intelOf(w, co), found: Field[] = [];
  for (const f of Object.values(w.fields)) {
    if (!f.geo || I.fields[f.id] || f.salvage) continue;
    if (sysAt(w.systems, f.pos)?.id !== sys.id) continue;
    if (f.geo.hidden && level < 3) continue;
    I.fields[f.id] = { found: w.time, n: 0, units: {}, first: {}, last: 0 };
    found.push(f);
  }
  return found;
}

/** a company ship entered a system (call after every jump/arrival). Returns newly found deposits. */
export function visit(w: WorldState, co: string, sysId: string): { first: boolean; fields: Field[] } {
  if (!fogOn(w) || !isPlayer(w, co)) return { first: false, fields: [] };
  const sys = w.systems[sysId]; if (!sys) return { first: false, fields: [] };
  const I = intelOf(w, co);
  const first = !I.sys[sysId];
  if (first) I.sys[sysId] = 2;
  return { first, fields: first ? discover(w, co, sys, 2) : [] };
}

/** survey ship-seconds; at the system's tier need the system becomes surveyed (hidden deposits appear) */
export function surveyIntel(w: WorldState, co: string, sysId: string, power: number): { done: boolean; fields: Field[] } {
  if (!fogOn(w) || !isPlayer(w, co)) return { done: false, fields: [] };
  const sys = w.systems[sysId]; if (!sys) return { done: false, fields: [] };
  const I = intelOf(w, co);
  if ((I.sys[sysId] ?? 0) >= 3) return { done: false, fields: [] };
  I.sys[sysId] = 2;
  I.scan[sysId] = (I.scan[sysId] ?? 0) + power;
  if (I.scan[sysId] < SCAN_NEED[siteTier(sys)]) return { done: false, fields: discover(w, co, sys, 2) };
  delete I.scan[sysId];
  I.sys[sysId] = 3;
  return { done: true, fields: discover(w, co, sys, 3) };
}

/** record units actually mined by a company's ship from a deposit (P10 worlds; identified fields too, for goal tracking) */
export function recordSample(w: WorldState, co: string, f: Field, units: Cargo) {
  if (!w.intel || !isPlayer(w, co)) return;
  const I = intelOf(w, co);
  const fi = (I.fields[f.id] ??= { found: w.time, n: 0, units: {}, first: {}, last: 0 });
  for (const [k, n] of Object.entries(units)) {
    if (n <= 0) continue;
    fi.units[k] = (fi.units[k] ?? 0) + n;
    fi.n += n;
    fi.first[k] ??= w.time;
  }
  fi.last = w.time;
}

export type Confidence = 'none' | 'insufficient' | 'low' | 'medium' | 'high';
export const CONFIDENCE_NAME: Record<Confidence, string> = { none: '시험 채굴 필요', insufficient: '표본 부족', low: '낮음', medium: '보통', high: '높음' };
export const confidenceOf = (n: number): Confidence => n <= 0 ? 'none' : n < 30 ? 'insufficient' : n < 200 ? 'low' : n < 1000 ? 'medium' : 'high';

export interface FieldReport {
  n: number;
  shares: [string, number][];
  confidence: Confidence;
  /** 95% upper bound on the share of any item not yet observed (rule of three) — never "none" */
  unseenMax: number;
  /** estimated reference value per mined unit from observed shares */
  unitValue: number;
  firstSeen: Record<string, number>;
}
export function fieldReport(fi: FieldIntel | undefined): FieldReport {
  const n = fi?.n ?? 0;
  const shares = Object.entries(fi?.units ?? {}).filter(([, v]) => v > 0).map(([k, v]) => [k, v / Math.max(1, n)] as [string, number]).sort((a, b) => b[1] - a[1]);
  return { n, shares, confidence: confidenceOf(n), unseenMax: n > 0 ? Math.min(1, 3 / n) : 1, unitValue: shares.reduce((a, [k, s]) => a + s * itemPrice(k), 0), firstSeen: { ...(fi?.first ?? {}) } };
}

/** what a company believes a deposit yields (for delivery planning): its own samples, else the look */
export function believedMix(w: WorldState, co: string, f: Field): Cargo {
  if (!f.geo) return f.mix ?? { [f.res]: 1 };
  const fi = w.intel?.[co]?.fields[f.id];
  if (fi && fi.n > 0) { const out: Cargo = {}; for (const [k, v] of Object.entries(fi.units)) out[k] = v / fi.n; return out; }
  return { [f.geo.look]: 1 };
}
