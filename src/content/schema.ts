// SIDERARIUM content schema (growth project, P1).
//
// Every piece of static content (hulls, variants, hardpoints, fitting presets, graphic assets) is
// described by the types below and registered through a ContentPack (src/content/packs/*). The
// registry (registry.ts) merges packs and the validator (validate.ts) checks them; game code reads
// content only through the registry. Field-by-field documentation: docs/CONTENT_SCHEMA.md.
//
// Coordinates follow the combat engine: ship-local, x = port(+)/starboard(-), y = up, z = forward;
// angles are degrees (facing 0 = forward, 90 = port, -90 = starboard, 180 = aft; arc = half-angle).

/** size class: hardpoints, internal slots, equipment and industrial hulls */
export type Size = 'S' | 'M' | 'L' | 'XL';
export const SIZES: Size[] = ['S', 'M', 'L', 'XL'];
export const sizeRank = (s: Size) => SIZES.indexOf(s);

/** what a hardpoint accepts (universal takes any non-PD weapon) */
export type HardpointType = 'ballistic' | 'energy' | 'missile' | 'universal' | 'pd';
export const HARDPOINT_TYPES: HardpointType[] = ['ballistic', 'energy', 'missile', 'universal', 'pd'];

/** how the weapon is mounted: turret (traverses within arc), fixed (aimed by turning the ship),
 *  vls (vertical launch: missiles, any bearing), spinal (keel-long, very narrow arc) */
export type MountStyle = 'turret' | 'fixed' | 'vls' | 'spinal';
export const MOUNT_STYLES: MountStyle[] = ['turret', 'fixed', 'vls', 'spinal'];

export interface HardpointDef {
  /** unique within the hull; saved on ships (fitting keys), so never rename a published one */
  id: string;
  pos: [number, number, number];
  facing: number;
  arc: number;
  size: Size;
  type: HardpointType;
  mount: MountStyle;
  /** narrower traverse for specific equipment at this spot (EQUIPMENT id → arc), e.g. a long-barrel
   *  main gun fouling the superstructure. Equipment not listed uses `arc`. */
  arcBy?: Record<string, number>;
}

/** internal equipment bays (P2 fills these; listed here so the data model is final) */
export type InternalKind = 'engine' | 'reactor' | 'sensor' | 'fcs' | 'ew' | 'armor' | 'special';
export const INTERNAL_KINDS: InternalKind[] = ['engine', 'reactor', 'sensor', 'fcs', 'ew', 'armor', 'special'];
export interface InternalSlotDef { id: string; kind: InternalKind; size: Size }

/** fitting rules of one equipment item (EQUIPMENT id). `slot: 'hardpoint'` = weapon; otherwise the
 *  internal bay kind it needs (a `special` bay takes any module). power < 0 supplies power. */
export interface EquipSpec {
  id: string;
  slot: 'hardpoint' | InternalKind;
  size: Size;
  mass: number;
  power: number;
  /** hardpoint mount styles it can use (weapons; default: any) */
  mounts?: MountStyle[];
}

/** blueprint rarity (P6 owns the rules; content declares the grade from the start) */
export type BlueprintGrade = 'common' | 'advanced' | 'faction' | 'rare' | 'unique';
export const BLUEPRINT_GRADES: BlueprintGrade[] = ['common', 'advanced', 'faction', 'rare', 'unique'];

export interface HullDef {
  id: string;
  /** role/AI/combat-engine class (SHIP_CLASSES id) */
  classId: string;
  name: string;
  maker?: string;
  tier: 1 | 2 | 3 | 4;
  size: Size;
  hardpoints: HardpointDef[];
  internals: InternalSlotDef[];
  /** legacy generic module slot units (HULLS.slots); kept for reference — P2 fitting uses `internals` */
  moduleSlots: number;
  /** built-in power supply (fitted equipment draws from it; reactor modules add to it) */
  power: number;
  /** equipment mass capacity (sum of fitted weapon + module mass) */
  mass: number;
  /** mesh family used by the procedural renderer + scale; `model` = registered asset id (optional) */
  mesh: { base: string; scale: number; model?: string };
  blueprint: BlueprintGrade;
  desc: string;
  // ── growth P3/P4/P6 (contentV ≥ 3). All optional: absent = the class defaults (ECON / HULLS), so the
  //    12 mk1 hulls behave exactly as before. Data-only links for P5 (tech, facilities, parts).
  /** combat structure relative to the class (multiplies hp / armour / tactical speed; variant mods stack) */
  stats?: { hpMul?: number; armorMul?: number; speedMul?: number };
  /** strategic operation: replaces the class's ECON values for this hull */
  ops?: HullOps;
  /** own-yard construction: replaces HULLS[classId] for this hull */
  build?: HullBuild;
  /** running cost (P4) */
  upkeep?: HullUpkeep;
  /** NPC supply: which public yards stock it and how fast they rebuild their stock */
  sale?: HullSale;
}

/** strategic operation of a hull (units as ECON) */
export interface HullOps {
  cruise?: number;
  /** cargo capacity (units) */
  cargo?: number;
  /** mining rate (units/s) */
  mine?: number;
  /** construction work rate (constructor = 1) */
  build?: number;
  /** the smallest berth it fits: S/M dock anywhere, L/XL need a large berth (public hubs or own docks) */
  berth?: Size;
  /** mining: fields smaller than this (max amount) cannot hold the hull efficiently (yield ×0.5) */
  minField?: number;
}

export interface HullBuild {
  /** shipyard size class 1..4 */
  yard: number;
  /** seconds in one build slot */
  time: number;
  credits: number;
  parts: Record<string, number>;
  /** research needed (all). P5 links production tech here. */
  tech?: string[];
  /** other facilities the building station must have (FACILITIES kinds) */
  facilities?: string[];
}

export interface HullUpkeep {
  /** credits per hour of service (crew, maintenance contracts) */
  credits: number;
  /** consumables per hour, taken from storage or bought at the market (P4 demand) */
  supplies?: Record<string, number>;
  /** wear gained per hour of operation (0..1 scale; wear slows mining/cruise up to −25%) */
  wear?: number;
}

export interface HullSale {
  /** public stations whose yards stock it */
  stations: string[];
  /** credits (NPC list price). Omit to use the production-cost price (src/world/valuation.ts) */
  price?: number;
  /** Union standing needed */
  rep?: number;
  /** ships in stock at most / seconds to build one more (the yard consumes market goods to do it) */
  stock: number;
  restock: number;
}

/** structural variant of a hull: changes hardpoints / bays / structure, never carries equipment */
export interface VariantDef {
  id: string;
  hull: string;
  name: string;
  desc: string;
  hardpoints?: { add?: HardpointDef[]; remove?: string[] };
  internals?: { add?: InternalSlotDef[]; remove?: string[] };
  mods?: { hpMul?: number; armorMul?: number; speedMul?: number; cargoMul?: number; mineMul?: number; buildMul?: number; cruiseMul?: number; upkeepMul?: number };
  blueprint: BlueprintGrade;
  /** registered asset id of a variant-specific model/skin (optional) */
  model?: string;
  /** extra parts the variant needs on top of its hull's (own-yard builds) */
  parts?: Record<string, number>;
  /** extra facilities / research the variant's structure needs at the building yard (growth worlds) */
  needs?: { facilities?: string[]; tech?: string[] };
}

// ─────────────────────────────────────────────── blueprints (P6)

/** what owning a blueprint lets the holder produce. Research (tech) is separate: building usually
 *  needs both. Buying a finished ship needs neither. */
export type BlueprintTarget = { kind: 'hull'; id: string } | { kind: 'variant'; id: string } | { kind: 'equipment'; id: string } | { kind: 'recipe'; id: string };

/** how a blueprint can be acquired (one blueprint may list several) */
export type BlueprintSource =
  /** general sale at these stations (credits) */
  | { kind: 'shop'; stations: string[]; price: number }
  /** high-price commercial licence: credits + Union standing (+ a record of completed contracts) */
  | { kind: 'commercial'; stations: string[]; price: number; rep: number; contracts?: number }
  /** a faction/company sells it only where its influence is strong, to companies in good standing */
  | { kind: 'faction'; faction: 'union' | 'guild' | 'pirates'; stations: string[]; price: number; influence: number; rep?: number }
  /** awarded for completing contracts (lair assaults of at least this tier) */
  | { kind: 'contract'; minTier: number; chance: number }
  /** salvaged as fragments (`bpf:<blueprint id>` items) from wrecks; `fragments` of them assemble it */
  | { kind: 'salvage'; fragments: number; chance: number }
  /** found whole in derelict archives at exploration sites of at least this tier (growth worlds) */
  | { kind: 'explore'; tier: number; chance: number }
  /** unique: at most `limit` holders in the world; awarded like a contract (first come) */
  | { kind: 'unique'; limit: number; minTier: number };

export interface BlueprintDef {
  id: string;
  name: string;
  desc: string;
  grade: BlueprintGrade;
  target: BlueprintTarget;
  sources: BlueprintSource[];
  /** research the holder must know to *use* it (production), P5 links here */
  requires?: string[];
  /** limited-run licence: builds per copy (absent = perpetual) */
  runs?: number;
}

/** a named weapon layout for a hull variant (hardpoint id → weapon equipment item) */
export interface PresetDef {
  id: string;
  hull: string;
  variant: string;
  name: string;
  desc: string;
  /** hardpoint id → EQUIPMENT id (weapon items) */
  weapons: Record<string, string>;
  /** price difference vs the hull's base cost (credits, NPC purchase) */
  costDelta?: number;
}

/** an old (classId, loadoutId) pair and the content it now corresponds to */
export interface LegacyLoadoutMap { classId: string; loadoutId: string; hull: string; variant: string; preset: string }

// ─────────────────────────────────────────────── graphic assets (Codex-authored)

export type AssetKind = 'ship-model' | 'variant-model' | 'portrait' | 'equipment-icon' | 'item-icon' | 'facility-icon';
export const ASSET_KINDS: AssetKind[] = ['ship-model', 'variant-model', 'portrait', 'equipment-icon', 'item-icon', 'facility-icon'];

export interface AssetDef {
  /** unique id, `<kind-prefix>.<name>` e.g. `model.dd_aegis`, `portrait.cmd_vega`, `icon.eq_laser` */
  id: string;
  kind: AssetKind;
  /** path under public/assets/content/ (forward slashes, lowercase, no ..) */
  file: string;
  /** content id it belongs to (hull, variant, commander, equipment, item or facility id) */
  for: string;
  author?: string;
  license?: string;
  /** models: forward axis must be +z, origin at the hull centre, 1 unit = 1 game unit */
  notes?: string;
}

export interface ContentPack {
  id: string;
  name: string;
  hulls?: HullDef[];
  variants?: VariantDef[];
  presets?: PresetDef[];
  equipment?: EquipSpec[];
  legacy?: LegacyLoadoutMap[];
  assets?: AssetDef[];
  blueprints?: BlueprintDef[];
}
