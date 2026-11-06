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
}

/** structural variant of a hull: changes hardpoints / bays / structure, never carries equipment */
export interface VariantDef {
  id: string;
  hull: string;
  name: string;
  desc: string;
  hardpoints?: { add?: HardpointDef[]; remove?: string[] };
  internals?: { add?: InternalSlotDef[]; remove?: string[] };
  mods?: { hpMul?: number; armorMul?: number; speedMul?: number };
  blueprint: BlueprintGrade;
  /** registered asset id of a variant-specific model/skin (optional) */
  model?: string;
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
}
