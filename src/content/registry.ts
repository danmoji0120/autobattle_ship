// Content registry: merges every pack into id-indexed tables. Game code reads hulls, variants,
// presets and assets only through here. Pure data — safe on server and client.
import type { AssetDef, BlueprintDef, ContentPack, EquipSpec, HardpointDef, HullDef, InternalSlotDef, LegacyLoadoutMap, PresetDef, VariantDef, ArmContent, ModuleContent, ItemContent, TechContent, FacilityContent, RecipeContent, WeaponFamily, ExclusiveArm, ExclusiveModule } from './schema';
import { PACKS } from './packs';
import { COMPUTER_BAY } from './schema';
import { SHIP_CLASSES } from '../sim/data/ships';
import { EQUIPMENT, ITEMS, RECIPES, TECHS, FACILITIES } from '../world/industry';
import { WEAPONS } from '../sim/data/weapons';
import { CORE_TECH_AREA, CORE_WEAPON_META } from './packs/growth/arsenal';

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
  // P5 content (weapons, modules, goods, research, facilities, recipes)
  arms: Record<string, ArmContent>;
  modules: Record<string, ModuleContent>;
  items: Record<string, ItemContent>;
  techs: Record<string, TechContent>;
  facilities: Record<string, FacilityContent & { id: string }>;
  recipes: Record<string, RecipeContent>;
  /** ids (items, equipment, techs, facility kinds, recipes) that exist only at contentV ≥ 3 */
  growthOnly: Set<string>;
  /** account-exclusive ids (hulls and equipment): outside every catalogue */
  exclusive: Set<string>;
  exArms: Record<string, ExclusiveArm>;
  exModules: Record<string, ExclusiveModule>;
}

/** P15.1: a combat hull's dedicated combat-computer bay (schema COMPUTER_BAY). A copy — pack data is not mutated. */
function withComputerBay(h: HullDef): HullDef {
  const cls = SHIP_CLASSES[h.classId];
  if (!cls || cls.role === 'civilian' || h.classId === 'platform' || h.exclusive || h.internals.some(b => b.kind === 'computer')) return h;
  return { ...h, internals: [...h.internals, { ...COMPUTER_BAY }] };
}
export function buildRegistry(packs: ContentPack[]): Registry {
  const r: Registry = { packs, hulls: {}, variants: {}, presets: {}, equipment: {}, assets: {}, blueprints: {}, legacy: {}, origin: {}, dupes: [], arms: {}, modules: {}, items: {}, techs: {}, facilities: {}, recipes: {}, growthOnly: new Set(), exclusive: new Set(), exArms: {}, exModules: {} };
  const put = <T extends { id: string }>(tab: Record<string, T>, kind: string, x: T, pack: string) => {
    const k = `${kind}:${x.id}`;
    if (r.origin[k]) r.dupes.push(`${kind} "${x.id}" (${r.origin[k]} · ${pack})`); else { tab[x.id] = x; r.origin[k] = pack; }
  };
  for (const p of packs) {
    for (const h of p.hulls ?? []) { put(r.hulls, 'hull', withComputerBay(h), p.id); if (h.exclusive) r.exclusive.add(h.id); }
    for (const v of p.variants ?? []) { put(r.variants, 'variant', v, p.id); if ((p.minContentV ?? 0) >= 3) r.growthOnly.add(v.id); }
    for (const x of p.presets ?? []) { put(r.presets, 'preset', x, p.id); if ((p.minContentV ?? 0) >= 3) r.growthOnly.add(x.id); }
    for (const e of p.equipment ?? []) put(r.equipment, 'equipment', e, p.id);
    for (const a of p.assets ?? []) put(r.assets, 'asset', a, p.id);
    for (const b of p.blueprints ?? []) put(r.blueprints, 'blueprint', b, p.id);
    for (const l of p.legacy ?? []) { const k = `${l.classId}/${l.loadoutId}`; if (r.legacy[k]) r.dupes.push(`legacy "${k}"`); else r.legacy[k] = l; }
    const g = (p.minContentV ?? 0) >= 3;
    const mark = (id: string) => { if (g) r.growthOnly.add(id); };
    for (const x of p.items ?? []) { put(r.items, 'item', x, p.id); mark(x.id); }
    for (const a of p.arms ?? []) {
      put(r.arms, 'arm', a, p.id); mark(a.id); mark(a.id);
      put(r.equipment, 'equipment', { id: a.id, slot: 'hardpoint', size: a.size, mass: a.mass, power: a.power, ...(a.mounts ? { mounts: a.mounts } : {}) }, p.id);
    }
    for (const m of p.modules ?? []) {
      put(r.modules, 'module', m, p.id); mark(m.id);
      put(r.equipment, 'equipment', { id: m.id, slot: m.slot, size: m.size, mass: m.mass, power: m.power }, p.id);
    }
    // account-exclusive equipment: a fitting rule and nothing else (no recipe, research or market row)
    for (const a of p.exclusive?.arms ?? []) {
      put(r.exArms, 'arm', a, p.id); mark(a.id); r.exclusive.add(a.id);
      put(r.equipment, 'equipment', { id: a.id, slot: 'hardpoint', size: a.size, mass: a.mass, power: a.power, ...(a.mounts ? { mounts: a.mounts } : {}) }, p.id);
    }
    for (const m of p.exclusive?.modules ?? []) {
      put(r.exModules, 'module', m, p.id); mark(m.id); r.exclusive.add(m.id);
      put(r.equipment, 'equipment', { id: m.id, slot: m.slot, size: m.size, mass: m.mass, power: m.power }, p.id);
    }
    for (const t of p.techs ?? []) { put(r.techs, 'tech', t, p.id); mark(t.id); }
    for (const f of p.facilities ?? []) { put(r.facilities, 'facility', { ...f, id: f.kind }, p.id); mark(f.kind); }
    for (const x of p.recipes ?? []) { put(r.recipes, 'recipe', x, p.id); mark(x.id); }
  }
  return r;
}

/** combat weapon id of an arm (`eq_laser_red` → `laser_red`) */
export const armWeaponId = (armId: string) => armId.replace(/^eq_/, '');
/** hardpoint category of a weapon family */
export const familyHp = (f: WeaponFamily | string): 'ballistic' | 'energy' | 'missile' | 'pd' =>
  f === 'laser' || f === 'plasma' || f === 'particle' ? 'energy' : f === 'missile' || f === 'torpedo' ? 'missile' : f === 'pd' ? 'pd' : 'ballistic';
const hex = (c: string) => parseInt(c.replace('#', ''), 16);
const sizeNum = (s: string): 1 | 2 | 3 => s === 'S' ? 1 : s === 'M' ? 2 : 3;
/** account-exclusive content (hull, variant of one, preset of one, or equipment)? */
export const isExclusive = (id: string | undefined, reg: Registry = CONTENT): boolean => {
  if (!id) return false;
  if (reg.exclusive.has(id)) return true;
  const v = reg.variants[id]; if (v && reg.exclusive.has(v.hull)) return true;
  const p = reg.presets[id]; return !!p && reg.exclusive.has(p.hull);
};

/** writes the packs' P5 content into the game tables (WEAPONS, EQUIPMENT, ITEMS, RECIPES, TECHS,
 *  FACILITIES). New rows are appended after the built-in ones, so every lookup the c0 game makes
 *  (first match by weapon / by tech) finds the same row as before. Growth-only rows carry
 *  `growth: true`; the sim and the UI hide them below contentV 3. Idempotent. */
/** EQUIPMENT ids written by installContent (pack content, not built-in rows) */
export const INSTALLED_EQUIPMENT = new Set<string>();
export function installContent(r: Registry) {
  for (const id of [...Object.keys(r.arms), ...Object.keys(r.modules), ...Object.keys(r.exArms), ...Object.keys(r.exModules)]) INSTALLED_EQUIPMENT.add(id);
  for (const a of Object.values(r.exArms)) {
    const wid = armWeaponId(a.id), c = a.combat;
    WEAPONS[wid] ??= { id: wid, name: a.name, desc: a.desc, ...c, sound: c.sound ?? (c.kind === 'shell' ? 'medium' : c.kind === 'craft' ? 'auto' : c.kind), family: a.family, tier: a.tier, role: a.role, hp: c.kind === 'craft' ? 'hangar' : familyHp(a.family), vsShield: c.vsShield ?? 1, ...(a.vis ? { vis: { color: hex(a.vis.color), len: a.vis.len, wid: a.vis.wid, beam: a.vis.beam } } : {}) };
    EQUIPMENT[a.id] ??= { id: a.id, name: a.name, kind: 'weapon', weapon: wid, size: sizeNum(a.size), desc: a.desc, growth: true, exclusive: true };
  }
  for (const m of Object.values(r.exModules)) EQUIPMENT[m.id] ??= { id: m.id, name: m.name, kind: 'module', size: sizeNum(m.size), desc: m.desc, growth: true, exclusive: true };
  for (const x of Object.values(r.items)) ITEMS[x.id] ??= { ...x, ...(r.growthOnly.has(x.id) ? { growth: true } : {}) };
  for (const a of Object.values(r.arms)) {
    const wid = armWeaponId(a.id), g = r.growthOnly.has(a.id);
    const c = a.combat;
    WEAPONS[wid] ??= { id: wid, name: a.name, desc: a.desc, ...c, sound: c.sound ?? (c.kind === 'shell' ? 'medium' : c.kind === 'craft' ? 'auto' : c.kind), family: a.family, tier: a.tier, role: a.role, hp: c.kind === 'craft' ? 'hangar' : familyHp(a.family), vsShield: c.vsShield ?? 1, ...(a.vis ? { vis: { color: hex(a.vis.color), len: a.vis.len, wid: a.vis.wid, beam: a.vis.beam } } : {}) };
    EQUIPMENT[a.id] ??= { id: a.id, name: a.name, kind: 'weapon', weapon: wid, size: sizeNum(a.size), desc: a.desc, ...(a.tech ? { tech: a.tech } : {}), ...(a.supply ? { supply: a.supply } : {}), ...(g ? { growth: true } : {}) };
    RECIPES[a.id] ??= { id: a.id, name: `${a.name} 생산`, fac: a.recipe.fac, time: a.recipe.time, in: a.recipe.in, out: { [a.id]: 1 }, ...(a.tech ? { tech: a.tech } : {}), ...(g ? { growth: true } : {}) };
  }
  for (const m of Object.values(r.modules)) {
    const g = r.growthOnly.has(m.id);
    EQUIPMENT[m.id] ??= { id: m.id, name: m.name, kind: 'module', size: sizeNum(m.size), desc: m.desc, cfx: m.fx, ...(m.ind ? { ind: { ...m.ind } } : {}), ...(m.cpu ? { cpu: { ...m.cpu } } : {}), ...(m.air ? { air: { ...m.air } } : {}), ...(m.tech ? { tech: m.tech } : {}), ...(g ? { growth: true } : {}) };
    RECIPES[m.id] ??= { id: m.id, name: `${m.name} 제작`, fac: m.recipe.fac, time: m.recipe.time, in: m.recipe.in, out: { [m.id]: 1 }, ...(m.tech ? { tech: m.tech } : {}), ...(g ? { growth: true } : {}) };
  }
  for (const t of Object.values(r.techs)) {
    TECHS[t.id] ??= { id: t.id, name: t.name, field: t.field as never, desc: t.desc, time: t.time, cost: t.cost, credits: t.credits, ...(t.pre ? { pre: t.pre } : {}), unlocks: t.unlocks, ...(t.fx ? { fx: t.fx } : {}), area: t.area, ...(t.needLab ? { needLab: t.needLab } : {}), ...(t.cfx ? { cfx: t.cfx } : {}), ...(r.growthOnly.has(t.id) ? { growth: true } : {}) };
  }
  for (const f of Object.values(r.facilities)) {
    const { id: _id, ...def } = f as FacilityContent & { id?: string };
    FACILITIES[f.kind] ??= { ...def, ...(r.growthOnly.has(f.kind) ? { growth: true } : {}) };
  }
  for (const x of Object.values(r.recipes)) RECIPES[x.id] ??= { ...x, ...(r.growthOnly.has(x.id) ? { growth: true } : {}) };
  // metadata on the built-in rows (area of the 13-area tree, weapon family/tier) — read only by
  // growth code and the UI; no c0 rule looks at these fields
  for (const [id, area] of Object.entries(CORE_TECH_AREA)) if (TECHS[id] && !TECHS[id].area) TECHS[id].area = area;
  for (const [id, m] of Object.entries(CORE_WEAPON_META)) if (WEAPONS[id] && !WEAPONS[id].family) Object.assign(WEAPONS[id], { family: m.family, tier: m.tier, vsShield: m.vsShield });   // no `role`: c0 target choice stays as it was
}

export const CONTENT: Registry = buildRegistry(PACKS);
installContent(CONTENT);

/** what a weapon is for (UI; built-in weapons from the arsenal meta table) */
export const weaponRole = (weaponId: string): string => WEAPONS[weaponId]?.role ?? CORE_WEAPON_META[weaponId]?.role ?? 'general';

/** is this item/equipment/tech/facility/recipe id available in a world at this content version? */
export const contentAvail = (id: string, contentV: number | undefined, reg: Registry = CONTENT) => !reg.growthOnly.has(id) || (contentV ?? 0) >= 3;

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

/** P16: a hull the world has released (not a dev, account-exclusive or preview hull) — catalogues, purchase,
 *  construction and blueprint offers use only these */
export const hullReleased = (hullId: string | undefined, reg: Registry = CONTENT): boolean => { const h = hullId ? reg.hulls[hullId] : undefined; return !!h && !h.dev && !h.exclusive && !h.preview; };
/** the hull a blueprint lets its holder build (hull or variant targets), if any */
export const blueprintHull = (bp: BlueprintDef, reg: Registry = CONTENT): string | undefined => bp.target.kind === 'hull' ? bp.target.id : bp.target.kind === 'variant' ? reg.variants[bp.target.id]?.hull : undefined;
export const hullsOfClass = (classId: string, reg: Registry = CONTENT) => Object.values(reg.hulls).filter(h => h.classId === classId);
export const presetsOfHull = (hullId: string, reg: Registry = CONTENT) => Object.values(reg.presets).filter(p => p.hull === hullId);
export const variantsOfHull = (hullId: string, reg: Registry = CONTENT) => Object.values(reg.variants).filter(v => v.hull === hullId);
export const assetsFor = (contentId: string, reg: Registry = CONTENT) => Object.values(reg.assets).filter(a => a.for === contentId);
/** URL of a registered asset, relative to the page (vite serves public/ at the root) */
export const assetUrl = (a: AssetDef) => `./assets/content/${a.file}`;

/** blueprints that let their holder build this hull / variant / item */
export const blueprintsFor = (kind: BlueprintDef['target']['kind'], id: string, reg: Registry = CONTENT) => Object.values(reg.blueprints).filter(b => b.target.kind === kind && b.target.id === id);
