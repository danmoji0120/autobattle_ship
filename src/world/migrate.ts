// Save-data migration for the growth project (content model). Separate from WORLD_VERSION (world
// layout) and INDUSTRY_VERSION (economy data): st.contentV tracks how far a save has been moved onto
// the content registry. Every step is additive and deterministic, never deletes anything, and records
// every item it *creates* in st.grants so asset conservation can be checked:
//     after = before + granted   (per item, per company)
// Rules and the operating procedure: docs/GROWTH_PLAN.md §6.
import type { WShip, WorldState, ShipBuild } from './types';
import { legacyOf } from '../content/registry';
import { EQUIPMENT } from './industry';
import { getLoadout } from '../sim/data/ships';
import { loadoutEquipment } from './industry';
import { fittingFromLegacy, fittingItems, legacySig, bayModules } from './fitting';
import { addc } from './types';

export const CONTENT_VERSION = 2;
/** contentV from which player ships carry a real fitting (P2) */
export const FITTING_V = 2;

/** an existing item that changed form (e.g. a loadout weapon that became a fitted item) — not new */
export interface ConversionRecord { v: number; company: string; item: string; n: number; ships: number; why: string }

/** an item the migration created (it did not exist in the old save in any form) */
export interface GrantRecord {
  v: number;            // migration step that granted it
  at: number;           // world time
  company: string;
  ref: string;          // ship / station id it was attached to
  item: string;
  n: number;
  why: string;
}

export interface MigrationReport {
  from: number; to: number;
  ships: number; builds: number;
  /** ships/builds whose class is unknown to the registry (left untouched) */
  unmapped: string[];
  granted: GrantRecord[];
  /** player ships that received a fitting (v2) */
  fitted: number;
  /** existing items that changed form, per company/item */
  converted: ConversionRecord[];
  /** modules that had no bay and went to the company's storage (nothing is dropped) */
  returned: { company: string; ship: string; station: string; item: string }[];
}

/** hull + variant of a ship from its legacy class/loadout */
export function contentOf(classId: string, loadoutId: string): { hull: string; variant: string } | null {
  const m = legacyOf(classId, loadoutId);
  return m ? { hull: m.hull, variant: m.variant } : null;
}

/** keep hull/variant in step with the ship's loadout (call after spawning or refitting) */
export function syncShipContent(st: WorldState, s: WShip | ShipBuild): void {
  if ((st.contentV ?? 0) < 1) return;
  // a fitted ship's variant is chosen by its fitting, not derived from the loadout label
  if ('fitting' in s && s.fitting) return;
  const c = contentOf(s.classId, s.loadoutId);
  if (c) { s.hull = c.hull; s.variant = c.variant; }
}

/** move a save to CONTENT_VERSION. Idempotent; also repairs ships created by an older build of the
 *  code after the save was migrated (rollback then roll forward). */
export function migrateContent(st: WorldState): MigrationReport {
  const from = st.contentV ?? 0;
  const rep: MigrationReport = { from, to: Math.max(from, CONTENT_VERSION), ships: 0, builds: 0, unmapped: [], granted: [], fitted: 0, converted: [], returned: [] };
  st.grants ??= [];
  // v1: every ship and queued build gets its hull and structural variant (no items change hands)
  const fill = (x: WShip | ShipBuild, kind: 'ship' | 'build') => {
    if (x.hull && x.variant) return false;
    const c = contentOf(x.classId, x.loadoutId);
    if (!c) { rep.unmapped.push(`${kind} ${x.id} (${x.classId}/${x.loadoutId})`); return false; }
    x.hull = c.hull; x.variant = c.variant; return true;
  };
  for (const s of Object.values(st.ships)) if (fill(s, 'ship')) rep.ships++;
  for (const x of Object.values(st.stations)) for (const b of x.builds ?? []) if (fill(b, 'build')) rep.builds++;
  // v2: player ships get a real fitting — the weapons their loadout mounted and the modules they had
  // become fitted items (same items, new form: recorded as conversions, not grants). Also repairs ships
  // made or refitted by an older build after the save was migrated (their loadout/fit changed).
  const conv = new Map<string, ConversionRecord>();
  for (const s of Object.values(st.ships)) {
    if (st.companies[s.owner]?.kind !== 'player') continue;
    if (s.fitting && s.fitting.sig === legacySig(s.loadoutId, s.fit)) continue;
    const r = fittingFromLegacy(s.classId, s.loadoutId, s.fit);
    if (!r) { rep.unmapped.push(`fitting ${s.id} (${s.classId}/${s.loadoutId})`); continue; }
    s.hull = r.hull; s.variant = r.variant; s.fitting = r.fitting;
    for (const m of r.unplaced) {
      const at = s.task.k === 'docked' ? (s.task as any).station : st.companies[s.owner].homeStation;
      const x = st.stations[at] ?? Object.values(st.stations).find(y => y.public);
      if (!x) continue;
      addc((x.storage[s.owner] ??= { ore: 0, alloy: 0, crystal: 0 }), m, 1);
      rep.returned.push({ company: s.owner, ship: s.id, station: x.id, item: m });
    }
    s.fit = bayModules(r.variant, r.fitting);
    r.fitting.sig = legacySig(s.loadoutId, s.fit);
    rep.fitted++;
    for (const [item, n] of Object.entries(fittingItems(r.fitting))) {
      const k = `${s.owner}/${item}`;
      const c = conv.get(k) ?? { v: 2, company: s.owner, item, n: 0, ships: 0, why: '로드아웃 무장·장착 모듈 → 피팅 장비' };
      c.n += n; c.ships++; conv.set(k, c);
    }
  }
  rep.converted = [...conv.values()];
  if (rep.converted.length) (st.conversions ??= []).push(...rep.converted);
  st.contentV = rep.to;
  st.grants.push(...rep.granted);
  return rep;
}

// ─────────────────────────────────────────────── asset census (migration safety)

const isEquip = (id: string) => !!EQUIPMENT[id];

/** everything a player owns, counted the same way before and after any migration.
 *  equipment = stored equipment items + modules fitted on ships + weapons mounted by loadouts
 *  (mounted weapons are part of the ship today; P2 turns them into real items, so they are counted
 *  from the start and a conversion cannot silently duplicate or lose them). */
export function census(w: WorldState) {
  const players = Object.values(w.companies ?? {}).filter(c => c.kind === 'player');
  const ids = new Set(players.map(c => c.id));
  const sum = (c: Record<string, number> | undefined, pick: (k: string) => boolean) => Object.entries(c ?? {}).reduce((a, [k, v]) => a + (pick(k) ? Number(v) || 0 : 0), 0);
  const own = Object.values(w.stations ?? {}).filter(s => ids.has(s.owner));
  const ships = Object.values(w.ships ?? {}).filter(s => ids.has(s.owner));
  const equipment: Record<string, number> = {};
  const add = (k: string, n: number) => { equipment[k] = (equipment[k] ?? 0) + n; };
  for (const s of Object.values(w.stations ?? {})) for (const id of ids) for (const [k, v] of Object.entries(s.storage?.[id] ?? {})) if (isEquip(k)) add(k, Number(v) || 0);
  for (const s of ships) {
    if (s.fitting) { for (const [k, n] of Object.entries(fittingItems(s.fitting))) add(k, n); continue; }
    for (const k of s.fit ?? []) add(k, 1);
    for (const [k, n] of Object.entries(loadoutEquipment(getLoadout(s.classId, s.loadoutId)?.mounts ?? []))) add(k, n);
  }
  // a started build has already taken its modules and weapons out of storage
  for (const s of own) for (const b of s.builds ?? []) if (b.started) {
    for (const k of b.fit ?? []) add(k, 1);
    for (const [k, n] of Object.entries(loadoutEquipment(getLoadout(b.classId, b.loadoutId)?.mounts ?? []))) add(k, n);
  }
  const granted: Record<string, number> = {};
  for (const g of w.grants ?? []) if (ids.has(g.company)) granted[g.item] = (granted[g.item] ?? 0) + g.n;
  return {
    players: players.length,
    credits: Math.round(players.reduce((a, c) => a + c.credits, 0)),
    ships: ships.length,
    stations: own.length,
    modules: own.reduce((a, s) => a + s.modules.length, 0),
    stored: Math.round(Object.values(w.stations ?? {}).reduce((a, s) => a + [...ids].reduce((b, id) => b + sum(s.storage?.[id], () => true), 0), 0)),
    equipment,
    granted,
  };
}
export type Census = ReturnType<typeof census>;

/** problems between two censuses (empty = assets conserved). `granted` in `after` is new since `before`. */
export function compareCensus(before: Census, after: Census): string[] {
  const bad: string[] = [];
  for (const k of ['players', 'ships', 'stations', 'modules'] as const) if (after[k] !== before[k]) bad.push(`${k} ${before[k]} → ${after[k]}`);
  if (Math.abs(after.credits - before.credits) > 1) bad.push(`credits ${before.credits} → ${after.credits}`);
  const newGrant = (k: string) => (after.granted[k] ?? 0) - (before.granted[k] ?? 0);
  for (const k of new Set([...Object.keys(before.equipment), ...Object.keys(after.equipment)])) {
    const want = (before.equipment[k] ?? 0) + newGrant(k);
    if ((after.equipment[k] ?? 0) !== want) bad.push(`equipment ${k}: ${before.equipment[k] ?? 0} + 지급 ${newGrant(k)} ≠ ${after.equipment[k] ?? 0}`);
  }
  const storedGrant = 0; // P1 grants nothing; later steps add their stored grants here
  if (after.stored < before.stored + storedGrant - 1) bad.push(`stored ${before.stored} → ${after.stored}`);
  return bad;
}
