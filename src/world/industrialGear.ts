// Industrial hardpoints (indV worlds). Mining, construction and salvage are equipment, not hull
// properties: a player ship does that work only with a mining laser / construction rig / salvage rig in
// an `industrial` bay, at the gear's rate × its hull's design bonus (hullops.ts gearEcon). Any hull with a
// compatible industrial bay can carry any of the three. Gear is ordinary equipment: fitted, removed,
// stored, bought and produced through the existing fitting (sim.applyFitting) and inventory paths.
//
// New standard worlds start with it (WorldSim.create, opts.industrial). An existing save converts only by
// explicit migration (migrateIndustrial — server env INDUSTRIAL_MIGRATE=1): every player industrial ship
// gets the gear equal to what its hull did before, so nothing a company could do is lost. NPC ships have
// no fitting and keep their hull values.
import { CONTENT } from '../content/registry';
import { bayAccepts, fitTotals } from '../content/rules';
import type { WorldState, WShip } from './types';
import type { GrantRecord } from './migrate';
import { EQUIPMENT } from './industry';
import { addGood, PROFILES } from './economy';
import { bayModules, legacySig } from './fitting';
import { hullIdOf } from './hullops';
import { variantLayout } from '../content/registry';
import { CPU_MARKETS } from '../content/packs/growth/computers';
import { P17_PART_MARKETS } from '../content/packs/growth/parts17';
import { P17_ARM_MARKETS } from '../content/packs/growth/arsenal17';
import { CARRIER_HULL, CARRIER_MARKETS } from '../content/packs/growth/carrier';
import { hullReleased } from '../content/registry';
import { REPAIR_MARKETS } from '../content/packs/growth/support';
import { DEV_REPAIR_RELEASE } from '../content/repairRelease';

export const indOn = (st: Pick<WorldState, 'indV'> | undefined) => !!st?.indV;

/** public stations that trade industrial gear from the start (S/M everywhere listed, L where large hulls are sold) */
export const IND_MARKETS: Record<string, string[]> = {
  astra: ['ind_mine_s', 'ind_mine_m', 'ind_build_s', 'ind_build_m', 'ind_salv_s'],
  barcaco: ['ind_mine_s', 'ind_mine_m', 'ind_mine_l'],
  drakeout: ['ind_mine_s', 'ind_mine_m', 'ind_salv_s'],
  exchange: ['ind_build_s', 'ind_build_m', 'ind_salv_s', 'ind_salv_m'],
  helios: ['ind_mine_l', 'ind_build_m', 'ind_build_l', 'ind_salv_l'],
  rustport: ['ind_salv_s', 'ind_salv_m'],
  p9_anvil_port: ['ind_mine_s', 'ind_mine_m'],
  p9_ceres_works: ['ind_salv_s', 'ind_salv_m', 'ind_build_s'],
  p10_kiln_works: ['ind_mine_s', 'ind_mine_m'],
  p10_crossroads_bazaar: ['ind_salv_s', 'ind_salv_m', 'ind_build_s'],
};

/** add the industrial gear market rows (idempotent: an existing row is never touched) */
export function stockIndustrialGear(st: WorldState): number {
  let n = 0;
  for (const [sid, ids] of Object.entries(IND_MARKETS)) {
    const x = st.stations[sid]; if (!x?.public || !x.market) continue;
    for (const id of ids) if (EQUIPMENT[id] && !x.market[id]) { addGood(x.market, id, PROFILES[sid]?.mult ?? 1, 0.6, st); n++; }
  }
  return n;
}

/** P15.1: standard combat computers on the public markets of a new growth world (idempotent; st.cpuV marks it).
 *  Existing saves are not converted automatically: their companies can produce computers (electronics_fab). */
export function stockComputers(st: WorldState): number {
  let n = 0;
  for (const [sid, ids] of Object.entries(CPU_MARKETS)) {
    const x = st.stations[sid]; if (!x?.public || !x.market) continue;
    for (const id of ids) if (EQUIPMENT[id] && !x.market[id]) { addGood(x.market, id, PROFILES[sid]?.mult ?? 1, 0.5, st); n++; }
  }
  st.cpuV = 1;
  return n;
}

/** P17.3: a few of the new computers / internal parts on public markets of a NEW growth world (world creation
 *  only — no existing-world migration: those companies research and build them). Idempotent. */
export function stockParts17(st: WorldState): number {
  let n = 0;
  for (const [sid, ids] of [...Object.entries(P17_PART_MARKETS), ...Object.entries(P17_ARM_MARKETS)]) {
    const x = st.stations[sid]; if (!x?.public || !x.market) continue;
    for (const id of ids) if (EQUIPMENT[id] && !x.market[id]) { addGood(x.market, id, PROFILES[sid]?.mult ?? 1, 0.4, st); n++; }
  }
  return n;
}

/** put industrial gear into a ship's free industrial bays (only what fits: bay size, power, mass).
 *  Returns the gear placed. The caller decides where the gear came from (a new hull: part of its standard
 *  build or founding fleet; a migration: the capability the hull had). */
export function fitGear(s: WShip, gear: readonly string[]): string[] {
  if (!s.fitting || !s.variant || !gear.length) return [];
  const lay = variantLayout(s.variant); if (!lay) return [];
  const placed: string[] = [];
  for (const g of gear) {
    const bay = lay.internals.find(b => b.kind === 'industrial' && !s.fitting!.bay[b.id] && !bayAccepts(b, g));
    if (!bay) continue;
    const next: Record<string, string> = { ...s.fitting.bay, [bay.id]: g };
    const t = fitTotals(CONTENT, lay.hull.id, s.fitting.hp, next);
    if (t && (t.power > t.supply || t.mass > t.cap)) continue;
    s.fitting = { ...s.fitting, bay: next };
    placed.push(g);
  }
  if (placed.length) {
    s.fit = bayModules(s.variant, s.fitting);
    s.fitting.sig = legacySig(s.loadoutId, s.fit);
  }
  return placed;
}
/** the hull's standard industrial gear (HullOps.gear) */
export const fitStandardGear = (s: WShip) => fitGear(s, CONTENT.hulls[hullIdOf(s)]?.ops?.gear ?? []);

/** new worlds: industrial hardpoint rules from the start */
export function enableIndustrial(st: WorldState) {
  st.indV = 1;
  st.salvQV = 1;   // P17.1: salvage quality (gear precision · officer · wreck condition) from the start
  stockIndustrialGear(st);
}

export interface IndMigration { applied: boolean; reason?: string; ships: number; gear: number; markets: number }
/** explicit save migration (idempotent): player ships come under industrial hardpoint rules, each keeping
 *  the work its hull did (its standard gear is fitted — recorded in st.grants for the asset census); markets get
 *  gear rows. Blueprints, credits, items and other ships are untouched. */
export function migrateIndustrial(st: WorldState): IndMigration {
  if ((st.contentV ?? 0) < 3) return { applied: false, reason: '성장 콘텐츠(c3) 이전 월드', ships: 0, gear: 0, markets: 0 };
  let ships = 0, gear = 0;
  const grants: GrantRecord[] = [];
  for (const s of Object.values(st.ships)) {
    if (s.ind || st.companies[s.owner]?.kind !== 'player' || !s.fitting || !s.variant) continue;
    let got = fitStandardGear(s);
    // a hauler could recover wreck cargo by itself in a salvage world: it keeps that with a small salvage rig
    if (!got.length && st.salvageV && s.classId === 'hauler') got = fitGear(s, ['ind_salv_s']);
    s.ind = 1; ships++;
    // the gear is new equipment standing in for what the hull did by itself: a recorded grant (census)
    for (const g of got) { gear++; grants.push({ v: 5, at: st.time, company: s.owner, ref: s.id, item: g, n: 1, why: '선체 고유 산업 능력 → 산업 하드포인트 장비 (동일 능력)' }); }
  }
  const markets = stockIndustrialGear(st);
  if (grants.length) (st.grants ??= []).push(...grants);
  st.indV = 1;
  return { applied: true, ships, gear, markets };
}

export interface CpuMigration { applied: boolean; reason?: string; markets: number }
/** P15.1 explicit save migration (idempotent, COMPUTERS_P151_MIGRATE=1): public stations of an existing growth
 *  world get the standard combat-computer market rows (same rows as a new standard world). Nothing else changes:
 *  ships, fittings, credits, items, blueprints and existing market rows are untouched. A fitted computer only
 *  acts in battles recorded with rules >= 2, so no running or recorded battle changes. */
export function migrateComputers(st: WorldState): CpuMigration {
  if ((st.contentV ?? 0) < 3) return { applied: false, reason: '성장 콘텐츠(c3) 이전 월드', markets: 0 };
  if (st.cpuV) return { applied: false, reason: '이미 적용됨', markets: 0 };
  return { applied: true, markets: stockComputers(st) };
}

/** ships a world spawns for a player in an indV world come under the rules */
export function markIndustrial(st: WorldState, s: WShip) { if (indOn(st) && s.fitting) s.ind = 1; }

export interface CarrierMigration { applied: boolean; reason?: string; markets: number }
/** P16.3 migration PREPARATION (CARRIERS_P16_MIGRATE=1; not run on any world): once the carrier hull is released
 *  (HullDef.preview removed after the integration and balance review), public stations of an existing growth world
 *  get the carrier gear market rows (CARRIER_MARKETS: air wings, aviation modules, the carrier computer). Refused
 *  while the hull is still a preview, before growth content, and when already applied (st.carrierV). Ships,
 *  fittings, credits, items, blueprints and existing rows are untouched; carrier battles need rules >= 3, so no
 *  running or recorded battle changes. `released` overrides the content check (tests / the check script). */
export function migrateCarriers(st: WorldState, opt: { released?: boolean } = {}): CarrierMigration {
  if ((st.contentV ?? 0) < 3) return { applied: false, reason: '성장 콘텐츠(c3) 이전 월드', markets: 0 };
  if (st.carrierV) return { applied: false, reason: '이미 적용됨', markets: 0 };
  if (!(opt.released ?? hullReleased(CARRIER_HULL))) return { applied: false, reason: '항모 미공개(preview) — 공개 결정 전에는 적용하지 않음', markets: 0 };
  let n = 0;
  for (const [sid, ids] of Object.entries(CARRIER_MARKETS)) {
    const x = st.stations[sid]; if (!x?.public || !x.market) continue;
    for (const id of ids) if (EQUIPMENT[id] && !x.market[id]) { addGood(x.market, id, PROFILES[sid]?.mult ?? 1, 0.3, st); n++; }
  }
  st.carrierV = 1;
  return { applied: true, markets: n };
}

export interface RepairMigration { applied: boolean; reason?: string; markets: number }
/** P16.7 repair gear market rows (REPAIR_MARKETS: field repair rigs, combat repair rigs, the support computer) on public
 *  stations. New growth worlds get them only under the repair switch (WorldSim.create); an existing save only by this
 *  explicit, idempotent migration (REPAIR_P167_MIGRATE=1, refused without the switch — production is not approved).
 *  Ships, fittings, credits, items, blueprints and existing rows are untouched. `released` overrides the switch (tests). */
export function migrateRepair(st: WorldState, opt: { released?: boolean } = {}): RepairMigration {
  if ((st.contentV ?? 0) < 3) return { applied: false, reason: '성장 콘텐츠(c3) 이전 월드', markets: 0 };
  if (st.repairV) return { applied: false, reason: '이미 적용됨', markets: 0 };
  if (!(opt.released ?? DEV_REPAIR_RELEASE)) return { applied: false, reason: '수리 콘텐츠 미공개 — 공개 결정 전에는 적용하지 않음', markets: 0 };
  let n = 0;
  for (const [sid, ids] of Object.entries(REPAIR_MARKETS)) {
    const x = st.stations[sid]; if (!x?.public || !x.market) continue;
    for (const id of ids) if (EQUIPMENT[id] && !x.market[id]) { addGood(x.market, id, PROFILES[sid]?.mult ?? 1, 0.4, st); n++; }
  }
  st.repairV = 1;
  return { applied: true, markets: n };
}
