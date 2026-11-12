// P10 unidentified deposits. A geo field has a hidden, non-uniform interior: depth layers (by the
// cumulative units ever mined from it) and rock zones, with rare veins that only open after long
// mining and only in some zones. Mining turns the continuously extracted amount into discrete units,
// each drawn deterministically from the local composition — so what a company learns is exactly
// what its ships actually brought up. Regeneration (field.regen) is unchanged: it restores amount,
// it does not reset depth. No goods are created here: every unit is taken from field.amount.
import type { Cargo, Field, WShip } from './types';
import { hashId } from './geom';

export interface GeoLayer { until: number; mix: Cargo }
export interface GeoVein { item: string; share: number; after: number; zones: number[] }
export type GeoSize = 'small' | 'medium' | 'large' | 'huge';
export interface FieldGeo {
  /** visible appearance: the item a remote look suggests (not a composition claim) */
  look: string;
  size: GeoSize;
  /** limited hints revealed on discovery (wording only, never shares) */
  hints: string[];
  layers: GeoLayer[];
  veins: GeoVein[];
  /** rock zones (ship rock index % zones) */
  zones: number;
  /** cumulative units mined (depth) */
  mined: number;
  /** discrete draws so far (deterministic sampling counter) */
  draws: number;
  /** needs a survey (intel level 3) to be found; otherwise a visit reveals it */
  hidden?: boolean;
}

export const GEO_SIZE_NAME: Record<GeoSize, string> = { small: '소형', medium: '중형', large: '대형', huge: '초대형' };
export const sizeOf = (max: number): GeoSize => max < 3000 ? 'small' : max < 7000 ? 'medium' : max < 14000 ? 'large' : 'huge';

const sorted = (m: Cargo) => Object.keys(m).filter(k => m[k] > 0).sort();

/** composition at the current depth for a rock zone */
export function localMix(geo: FieldGeo, zone: number): Cargo {
  const layer = geo.layers.find(l => geo.mined < l.until) ?? geo.layers[geo.layers.length - 1];
  const out: Cargo = { ...layer.mix };
  let open = 0;
  for (const v of geo.veins) if (geo.mined >= v.after && v.zones.includes(zone % geo.zones)) open += v.share;
  if (open > 0) {
    const keep = Math.max(0, 1 - open);
    for (const k of Object.keys(out)) out[k] *= keep;
    for (const v of geo.veins) if (geo.mined >= v.after && v.zones.includes(zone % geo.zones)) out[v.item] = (out[v.item] ?? 0) + v.share;
  }
  return out;
}

/** the true average composition over all zones at the current depth (server-only; used for tests and NPC valuation) */
export function trueMix(geo: FieldGeo): Cargo {
  const out: Cargo = {};
  for (let z = 0; z < geo.zones; z++) for (const [k, v] of Object.entries(localMix(geo, z))) out[k] = (out[k] ?? 0) + v / geo.zones;
  return out;
}

/** well-mixed 32-bit hash of (field, n): the plain string hash clusters for sequential n, which skewed draws */
function unitHash(fieldId: string, n: number): number {
  let x = (hashId(fieldId) ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return x >>> 0;
}
/** deterministic weighted draw for the n-th unit of a field */
export function drawItem(fieldId: string, n: number, mix: Cargo): string {
  const keys = sorted(mix); if (!keys.length) return 'ore';
  const total = keys.reduce((a, k) => a + mix[k], 0);
  let r = (unitHash(fieldId, n) / 4294967296) * total;
  for (const k of keys) { r -= mix[k]; if (r < 0) return k; }
  return keys[keys.length - 1];
}

/**
 * Convert `a` freshly extracted units (already removed from field.amount) into discrete units.
 * The fractional remainder is held on the ship, tied to the field; switching fields returns it.
 * Returns the units produced (item → count).
 */
export function mineGeo(f: Field, s: WShip, a: number, zone: number, fields: Record<string, Field>): Cargo {
  const geo = f.geo!;
  if (s.mineAcc && s.mineAcc.field !== f.id) releaseAcc(s, fields);
  const acc = (s.mineAcc ??= { field: f.id, a: 0 });
  acc.a += a;
  const out: Cargo = {};
  while (acc.a >= 1) {
    const item = drawItem(f.id, geo.draws, localMix(geo, zone));
    geo.draws++; geo.mined++;
    out[item] = (out[item] ?? 0) + 1;
    acc.a -= 1;
  }
  if (acc.a < 1e-9) delete s.mineAcc;
  return out;
}

/** return a pending fraction to its field (conservation when a ship stops or switches field) */
export function releaseAcc(s: WShip, fields: Record<string, Field>) {
  const acc = s.mineAcc; if (!acc) return;
  const f = fields[acc.field];
  if (f) f.amount += acc.a;
  delete s.mineAcc;
}

/** rough look for a raw item */
export const LOOK_HINT: Record<string, string> = {
  ore: '철질 암괴', titanium_ore: '밝은 금속 광택', crystal: '반투명 결정', rare_ore: '짙은 금속 광맥', silicate: '규산염 먼지', gas: '가스 구름',
  dense_titanium_ore: '고밀도 금속 반응', resonant_crystal: '공명하는 결정', unstable_isotope: '불안정한 방사 반응', singular_ore: '이상 중력 반응',
};
