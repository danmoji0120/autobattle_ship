// P9.7 authored resource origins and opt-in world activation. No random numbers or market stock
// are created here: the normal mining, industry and player-exchange systems own the materials.
import type { Cargo, Field, WorldState } from './types';

export const REGIONAL_ORIGINS: Readonly<Record<string, string>> = {
  dense_titanium_ore: '앤빌 광구', dense_alloy: '앤빌 광구',
  resonant_crystal: '파편 항로', resonant_optics: '파편 항로',
  unstable_isotope: '황혼 광맥', stabilized_isotope: '황혼 광맥',
  singular_ore: '검은 관문', singular_alloy: '검은 관문 · 앤빌 광구',
};

/** Additional inputs, not replacements for the existing advanced recipes. */
export const REGIONAL_RECIPE_INPUTS: Readonly<Record<string, Cargo>> = {
  eq_rail_cannon: { dense_alloy: 6 },
  eq_lance: { resonant_optics: 6, singular_alloy: 2 },
  mod_armor2: { dense_alloy: 4 },
  mod_reactor: { stabilized_isotope: 3 },
};

export const regionalOn = (w?: { regionalV?: number } | null) => w?.regionalV === 1;
/** Only the newly restricted advanced equipment needs an actual NPC-market stock on refit. */
export const regionalMarketRequired = (w: { regionalV?: number } | null | undefined, item: string) =>
  regionalOn(w) && Object.hasOwn(REGIONAL_RECIPE_INPUTS, item);
/** Copy the requirement so a newly registered build owns its snapshot. */
export function regionalHullMaterials(w: { regionalV?: number } | undefined, hull: string): Cargo | undefined {
  return regionalOn(w) && hull === 'dreadnought_mk1' ? { dense_alloy: 20, singular_alloy: 40 } : undefined;
}

interface RegionalFieldDef {
  sys: string; id: string; name: string; res: string; mix: Cargo; amount: number;
  regen: number; rich: number; danger: number; angle: number;
}
export const REGIONAL_FIELDS: readonly RegionalFieldDef[] = [
  { sys: 'anvil', id: 'p97_anvil_dense', name: '앤빌 고밀도 광맥', res: 'dense_titanium_ore', mix: { dense_titanium_ore: .3, titanium_ore: .5, ore: .2 }, amount: 8000, regen: .02, rich: 1.2, danger: 2, angle: 5.2 },
  { sys: 'shard', id: 'p97_shard_resonance', name: '파편 공명 결정대', res: 'resonant_crystal', mix: { resonant_crystal: .3, crystal: .45, rare_ore: .25 }, amount: 4500, regen: .018, rich: 1.35, danger: 3, angle: 4.5 },
  { sys: 'dusk', id: 'p97_dusk_isotope', name: '황혼 동위원소 구름', res: 'unstable_isotope', mix: { unstable_isotope: .35, gas: .35, crystal: .3 }, amount: 4500, regen: .018, rich: 1.5, danger: 3, angle: 1.3 },
  { sys: 'blackgate', id: 'p97_blackgate_singular', name: '검은 관문 특이 광맥', res: 'singular_ore', mix: { singular_ore: .3, rare_ore: .4, ore: .3 }, amount: 5000, regen: .015, rich: 1.1, danger: 3, angle: 1.9 },
];

/**
 * Explicitly activate on a P9 growth world. Called during fresh world creation; it is never called
 * by save loading. An offline caller may apply it to a copy after reviewing its effects. Validate
 * everything before mutation, preserve old queues, and refuse ID/resource collisions.
 */
export function activateRegionalResources(w: WorldState): void {
  if (regionalOn(w)) return;
  if (w.regionalV !== undefined || w.worldLayout !== 'p9' || (w.contentV ?? 0) < 4) throw new Error('P9.7 requires a P9 growth world');
  const raw = new Set(REGIONAL_FIELDS.map(f => f.res));
  const fields: Field[] = REGIONAL_FIELDS.map(d => {
    const s = w.systems[d.sys];
    if (!s || w.fields[d.id]) throw new Error(`P9.7 missing system or field collision: ${d.id}`);
    return { id: d.id, name: d.name, pos: { x: s.origin.x + Math.cos(d.angle) * 25000, y: 0, z: s.origin.z + Math.sin(d.angle) * 25000 },
      radius: 900, res: d.res, mix: { ...d.mix }, amount: d.amount, max: d.amount, regen: d.regen, rocks: 100,
      salvage: false, expires: 0, danger: d.danger, rich: d.rich };
  });
  for (const f of Object.values(w.fields)) {
    if (raw.has(f.res) || Object.keys(f.mix ?? {}).some(k => raw.has(k))) throw new Error(`P9.7 regional resource already present: ${f.id}`);
  }
  // A queued pre-activation order keeps its original recipe for all remaining batches. Running
  // jobs already consumed their inputs, and their output is unchanged. Existing builds have no
  // regionalMaterials snapshot; only subsequently registered builds receive one.
  for (const st of Object.values(w.stations)) for (const order of st.orders ?? []) {
    if (REGIONAL_RECIPE_INPUTS[order.recipe]) order.legacyRecipe = true;
  }
  for (const f of fields) w.fields[f.id] = f;
  w.regionalV = 1;
}
