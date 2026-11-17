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
export type InternalKind = 'engine' | 'reactor' | 'sensor' | 'fcs' | 'ew' | 'armor' | 'special' | 'industrial' | 'computer';
export const INTERNAL_KINDS: InternalKind[] = ['engine', 'reactor', 'sensor', 'fcs', 'ew', 'armor', 'special', 'industrial', 'computer'];
/** P15.1: every combat hull (role ≠ civilian, not a fixed platform, not account-exclusive) gets this
 *  dedicated combat-computer bay from the registry unless its data already declares a `computer` bay.
 *  Its id is saved on fittings: never rename it. */
export const COMPUTER_BAY: InternalSlotDef = { id: 'cpu1', kind: 'computer', size: 'S' };
/** P15.1 combat computer: the behaviour archetype it runs (sim/ai/computer.ts) and how fast it re-decides */
export interface CpuModSpec { arch: import('../sim/ai/computer').CpuArch; /** re-decision interval s (default 1) */ react?: number }
/** industrial work an `industrial` module performs (mining laser, construction rig, salvage rig) */
export type IndWork = 'mine' | 'build' | 'salvage';
/** what an industrial module does: mine = units/s, build = construction work rate (1 = the old
 *  standard constructor), salvage = multiplier on the salvage base rates (1 = the old constructor) */
export interface IndSpec { work: IndWork; rate: number }
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
  /** development hull (model/loader tests): never sold, built or granted; needs no blueprint. Only
   *  tests and the model preview spawn it. Fixture models may only be used by dev hulls. */
  dev?: boolean;
  /** ACCOUNT-EXCLUSIVE hull: exists once in the world, granted by the server to one verified account
   *  (world/exclusive.ts). Never sold, built, listed, dropped or blueprinted — the validator rejects
   *  `sale`, `build` and any blueprint that targets it, and every catalogue skips it. */
  exclusive?: boolean;
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
  /** industrial hardpoints: efficiency multiplier the hull's design gives fitted industrial gear of each
   *  work (miner → mine, constructor → build, salvager → salvage; absent = ×1). The hull itself does no
   *  industrial work: without gear in an `industrial` bay it cannot mine, build or salvage. */
  bonus?: Partial<Record<IndWork, number>>;
  /** standard industrial fit (equipment ids) of a new hull bought from a yard or given at company start */
  gear?: string[];
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

/** the six P10 territorial factions (world/territory.ts FACTIONS) */
export type FactionId = 'union' | 'guild' | 'ceres' | 'miners' | 'iron' | 'pirates';
export const FACTION_IDS: readonly FactionId[] = ['union', 'guild', 'ceres', 'miners', 'iron', 'pirates'];

/** how a blueprint can be acquired (one blueprint may list several) */
export type BlueprintSource =
  /** general sale at these stations (credits) */
  | { kind: 'shop'; stations: string[]; price: number }
  /** high-price commercial licence: credits + Union standing (+ a record of completed contracts).
   *  P14.0 (repV worlds): `rep` is read as company credit through the legacy→0..100 map, or `credit` if given */
  | { kind: 'commercial'; stations: string[]; price: number; rep: number; contracts?: number; credit?: number }
  /** a faction sells it only where its influence is strong, to companies in good standing.
   *  Legacy worlds: system influence (`inf`, union/guild/pirates only) + Union standing `rep`.
   *  P14.0 (repV worlds): only at stations the faction actually holds (P10), to companies whose trust with *that*
   *  faction reaches `trust` (default: `rep` through the legacy map) and that completed `contracts` of its contracts.
   *  `repOnly` sources exist only on repV worlds (the six-faction catalogue). */
  | { kind: 'faction'; faction: FactionId; stations: string[]; price: number; influence: number; rep?: number; trust?: number; contracts?: number; repOnly?: true }
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

export type AssetKind = 'ship-model' | 'variant-model' | 'model-lod' | 'portrait' | 'equipment-icon' | 'item-icon' | 'facility-icon';
export const ASSET_KINDS: AssetKind[] = ['ship-model', 'variant-model', 'model-lod', 'portrait', 'equipment-icon', 'item-icon', 'facility-icon'];

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
  /** models: SHA-256 (hex) of the file. Required for models: the validator compares it with the file
   *  (a stale or partial copy is an error) and the client uses it to version the URL (cache busting). */
  sha256?: string;
  /** models: a loader-test fixture, not final art. Only `dev` hulls (and their variants) may use one. */
  fixture?: boolean;
  /** ship/variant models: asset id of a lower-detail model (kind `model-lod`) drawn from far away */
  lod?: string;
  /** models: move the bounding-box centre to the origin (for files authored with another origin).
   *  Off by default — the standard origin is the hull centre and hardpoints are relative to it. */
  recenter?: boolean;
}

// ─────────────────────────────────────────────── P5: weapons, research, facilities (growth content)

/** weapon family: tiers of one family share a technology line and a look in combat */
export type WeaponFamily = 'cannon' | 'coil' | 'laser' | 'plasma' | 'particle' | 'missile' | 'torpedo' | 'pd';
export const WEAPON_FAMILIES: WeaponFamily[] = ['cannon', 'coil', 'laser', 'plasma', 'particle', 'missile', 'torpedo', 'pd'];
/** what a weapon is for: target selection prefers matching targets, the UI explains the trade-off */
export type WeaponRole = 'anti-small' | 'general' | 'anti-capital' | 'pd';
/** the 13 research areas (each owns its own kinds of effect — see validate.ts AREA_EFFECTS) */
export type ResearchArea = 'hull' | 'propulsion' | 'power' | 'kinetic' | 'energy' | 'missile' | 'defense' | 'electronics' | 'industry' | 'resource' | 'logistics' | 'station' | 'tactics';
export const RESEARCH_AREAS: ResearchArea[] = ['hull', 'propulsion', 'power', 'kinetic', 'energy', 'missile', 'defense', 'electronics', 'industry', 'resource', 'logistics', 'station', 'tactics'];

/** combat statistics of a weapon (the combat engine's WeaponDef without id/name/desc) */
export interface WeaponStats {
  kind: 'shell' | 'missile' | 'torpedo' | 'pd';
  damage: number; pen: number; range: number; speed: number; reload: number;
  salvo: number; salvoGap: number; spread: number; turnSpeed: number; caliber: number;
  guidedTurn?: number; munitionHp?: number; pdChance?: number; magazine?: number;
  /** effectiveness against shields (1 = full damage to the shield) */
  vsShield?: number;
  sound?: string;
  /** exotic behaviours of exclusive weapons (see sim/data/weapons.ts) */
  pierce?: number; seek?: number; phase?: boolean; special?: 'dcp';
  /** P15 battle rules (BattleSetup.rules ≥ 1): unguided run / magazine for a weapon that had none */
  p15?: { unguided?: boolean; magazine?: number };
}
/** visual of a weapon in combat (tracer / beam colour and size) */
export interface WeaponVis { color: string; len: number; wid: number; beam?: boolean }

/** one weapon: equipment item + combat stats + fitting rule + how it is made, in one record */
export interface ArmContent {
  /** EQUIPMENT id (`eq_` prefix); the combat weapon id is the same without the prefix */
  id: string;
  name: string;
  desc: string;
  family: WeaponFamily;
  /** 1 … 5 within the family */
  tier: number;
  role: WeaponRole;
  size: Size;
  mass: number;
  /** power draw on the hull's supply */
  power: number;
  mounts?: MountStyle[];
  /** research that unlocks its production (and fitting it from storage needs nothing) */
  tech?: string;
  combat: WeaponStats;
  vis?: WeaponVis;
  /** production: facility kind, seconds, inputs (output is one item) */
  recipe: { fac: string; time: number; in: Record<string, number> };
  /** goods consumed per hour while the ship is in service (ammunition, propellant); energy weapons
   *  usually need none and pay in power instead */
  supply?: Record<string, number>;
}
/** ACCOUNT-EXCLUSIVE weapon (ContentPack.exclusive.arms): fitted only on an exclusive hull. It has no
 *  recipe, no research and no supply — nothing in the world can make, unlock, trade or drop it — and
 *  it stands outside the weapon budget rules by design. */
export type ExclusiveArm = Omit<ArmContent, 'recipe' | 'tech' | 'supply' | 'size'> & { size: Size };
/** ACCOUNT-EXCLUSIVE internal module: a named, fixed system of an exclusive hull (its behaviour lives
 *  in the combat engine, not in `fx`) */
export interface ExclusiveModule { id: string; name: string; desc: string; slot: InternalKind; size: Size; mass: number; power: number }
/** combat effects a module or a research applies (multipliers default 1; shield/regen/evasion add) */
export interface CombatFx {
  /** only weapons of this family (research in a weapon area) */
  family?: WeaponFamily | WeaponFamily[];
  dmgMul?: number; reloadMul?: number; rangeMul?: number;
  hpMul?: number; armorMul?: number; speedMul?: number; accMul?: number; pdMul?: number; evasion?: number;
  /** shield capacity as a share of hull HP (modules) or a multiplier on it (research: shieldMul) */
  shield?: number; shieldMul?: number;
  /** shield regeneration (share of capacity per second) / multiplier on it */
  shieldRegen?: number; shieldRegenMul?: number;
}
/** an internal module: fitting rule + combat effect + recipe */
export interface ModuleContent {
  id: string; name: string; desc: string;
  slot: InternalKind; size: Size; mass: number; power: number;
  fx: CombatFx;
  /** industrial work (only on `industrial` modules) */
  ind?: IndSpec;
  /** combat computer behaviour (only on `computer` modules) */
  cpu?: CpuModSpec;
  tech?: string;
  recipe: { fac: string; time: number; in: Record<string, number> };
}
/** a new tradeable good (keep these few: ore / alloy / rare stay the core resources) */
export interface ItemContent { id: string; name: string; cat: 'refined' | 'part' | 'shippart'; tier: number; price: number; color: string; desc: string }
/** strategic research effects (company-wide multipliers) */
export interface TechFxContent { mineMul?: number; prodMul?: number; buildMul?: number; researchMul?: number; cargoMul?: number; skillGain?: number; repairMul?: number; cruiseMul?: number; constructMul?: number; supplyMul?: number; upkeepMul?: number }
export interface TechContent {
  id: string; name: string; desc: string;
  area: ResearchArea;
  /** lab field that can research it (a lab facility's `lab` list) */
  field: string;
  time: number; credits: number; cost: Record<string, number>;
  pre?: string[];
  /** a specialised lab this station must have (advanced research) */
  needLab?: string;
  /** player-facing summary of what it unlocks/changes (shown in the tree) */
  unlocks: string;
  fx?: TechFxContent;
  cfx?: CombatFx;
}
/** a station facility (same fields as the built-in FACILITIES rows) */
export interface FacilityContent {
  kind: string; name: string; cat: '기반' | '정제' | '부품' | '조선' | '군사' | '연구' | '물류'; desc: string;
  credits: number; mats: Record<string, number>; work: number; power: number;
  lines?: number; storage?: number; requires?: string; tech?: string; max?: number; unlocks: string;
  lab?: string[]; yard?: number;
  /** Minimum station size for a new installation, separate from the yard's ship class. */
  minStation?: Size;
  /** Historical terms for old saves and legacy worlds. */
  legacyBuild?: { credits: number; mats: Record<string, number> };
}
export interface RecipeContent { id: string; name: string; fac: string; time: number; in: Record<string, number>; out: Record<string, number>; tech?: string }

export interface ContentPack {
  id: string;
  name: string;
  /** content of this pack exists only in worlds at or above this content version (growth = 3) */
  minContentV?: number;
  items?: ItemContent[];
  arms?: ArmContent[];
  modules?: ModuleContent[];
  techs?: TechContent[];
  facilities?: FacilityContent[];
  recipes?: RecipeContent[];
  hulls?: HullDef[];
  variants?: VariantDef[];
  presets?: PresetDef[];
  equipment?: EquipSpec[];
  legacy?: LegacyLoadoutMap[];
  assets?: AssetDef[];
  blueprints?: BlueprintDef[];
  /** account-exclusive equipment (the hulls that carry it are marked `exclusive` themselves) */
  exclusive?: { arms?: ExclusiveArm[]; modules?: ExclusiveModule[] };
}
