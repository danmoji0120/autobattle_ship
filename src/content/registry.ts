// Content registry: merges every pack into id-indexed tables. Game code reads hulls, variants,
// presets and assets only through here. Pure data — safe on server and client.
import type { AssetDef, BlueprintDef, ContentPack, EquipSpec, HardpointDef, HullDef, InternalSlotDef, LegacyLoadoutMap, PresetDef, VariantDef } from './schema';
import { PACKS } from './packs';
import { EQUIPMENT } from '../world/industry';

export interface Registry {
  packs: ContentPack[];
  hulls: Record<string, HullDef>;
  variants: Record<string, VariantDef>;
  presets: Record<string, PresetDef>;
  /** fitting rules per EQUIPMENT id */
  equipment: Record<string, EquipSpec>;
  assets: Record<string, AssetDef>;
  blueprints: Record<string, BlueprintDef>;
  /** `${classId}/${loadoutId}` → mapping */
  legacy: Record<string, LegacyLoadoutMap>;
  /** which pack defined each id (validator messages) */
  origin: Record<string, string>;
  /** duplicate ids found while merging (validator reports them) */
  dupes: string[];
}

export function buildRegistry(packs: ContentPack[]): Registry {
  const r: Registry = { packs, hulls: {}, variants: {}, presets: {}, equipment: {}, assets: {}, blueprints: {}, legacy: {}, origin: {}, dupes: [] };
  const put = <T extends { id: string }>(tab: Record<string, T>, kind: string, x: T, pack: string) => {
    const k = `${kind}:${x.id}`;
    if (r.origin[k]) r.dupes.push(`${kind} "${x.id}" (${r.origin[k]} · ${pack})`); else { tab[x.id] = x; r.origin[k] = pack; }
  };
  for (const p of packs) {
    for (const h of p.hulls ?? []) put(r.hulls, 'hull', h, p.id);
    for (const v of p.variants ?? []) put(r.variants, 'variant', v, p.id);
    for (const x of p.presets ?? []) put(r.presets, 'preset', x, p.id);
    for (const e of p.equipment ?? []) put(r.equipment, 'equipment', e, p.id);
    for (const a of p.assets ?? []) put(r.assets, 'asset', a, p.id);
    for (const b of p.blueprints ?? []) put(r.blueprints, 'blueprint', b, p.id);
    for (const l of p.legacy ?? []) { const k = `${l.classId}/${l.loadoutId}`; if (r.legacy[k]) r.dupes.push(`legacy "${k}"`); else r.legacy[k] = l; }
  }
  return r;
}

export const CONTENT: Registry = buildRegistry(PACKS);

/** effective structure of a hull variant: hardpoints and bays after the variant's changes */
export function variantLayout(variantId: string, reg: Registry = CONTENT): { hull: HullDef; variant: VariantDef; hardpoints: HardpointDef[]; internals: InternalSlotDef[] } | null {
  const v = reg.variants[variantId]; const h = v && reg.hulls[v.hull];
  if (!v || !h) return null;
  const drop = new Set(v.hardpoints?.remove ?? []), dropI = new Set(v.internals?.remove ?? []);
  return {
    hull: h, variant: v,
    hardpoints: [...h.hardpoints.filter(p => !drop.has(p.id)), ...(v.hardpoints?.add ?? [])],
    internals: [...h.internals.filter(p => !dropI.has(p.id)), ...(v.internals?.add ?? [])],
  };
}

/** combat-engine mounts of a preset (same shape as LoadoutDef.mounts) */
export function presetMounts(presetId: string, reg: Registry = CONTENT): { weapon: string; pos: [number, number, number]; facing: number; arc: number }[] {
  const p = reg.presets[presetId]; if (!p) return [];
  return layoutMounts(p.variant, p.weapons, reg);
}

/** combat mounts for a variant with equipment on hardpoints (hardpoint id → EQUIPMENT id), in the
 *  variant's hardpoint order; items that are not weapons are skipped */
export function layoutMounts(variantId: string, onHp: Record<string, string>, reg: Registry = CONTENT): { weapon: string; pos: [number, number, number]; facing: number; arc: number }[] {
  const lay = variantLayout(variantId, reg); if (!lay) return [];
  const out = [];
  for (const hp of lay.hardpoints) {
    const eq = onHp[hp.id]; const weapon = eq && EQUIPMENT[eq]?.weapon; if (!weapon) continue;
    out.push({ weapon, pos: hp.pos, facing: hp.facing, arc: Math.min(hp.arc, hp.arcBy?.[eq] ?? hp.arc) });
  }
  return out;
}

/** the hull/variant/preset an old (classId, loadoutId) pair now is; unknown loadouts fall back to the
 *  class's first loadout, exactly like getLoadout() */
export function legacyOf(classId: string, loadoutId: string, reg: Registry = CONTENT): LegacyLoadoutMap | null {
  return reg.legacy[`${classId}/${loadoutId}`] ?? Object.values(reg.legacy).find(l => l.classId === classId) ?? null;
}

export const hullsOfClass = (classId: string, reg: Registry = CONTENT) => Object.values(reg.hulls).filter(h => h.classId === classId);
export const presetsOfHull = (hullId: string, reg: Registry = CONTENT) => Object.values(reg.presets).filter(p => p.hull === hullId);
export const variantsOfHull = (hullId: string, reg: Registry = CONTENT) => Object.values(reg.variants).filter(v => v.hull === hullId);
export const assetsFor = (contentId: string, reg: Registry = CONTENT) => Object.values(reg.assets).filter(a => a.for === contentId);
/** URL of a registered asset, relative to the page (vite serves public/ at the root) */
export const assetUrl = (a: AssetDef) => `./assets/content/${a.file}`;

/** blueprints that let their holder build this hull / variant / item */
export const blueprintsFor = (kind: BlueprintDef['target']['kind'], id: string, reg: Registry = CONTENT) => Object.values(reg.blueprints).filter(b => b.target.kind === kind && b.target.id === id);
