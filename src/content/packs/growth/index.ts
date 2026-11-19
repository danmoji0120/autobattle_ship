import type { ContentPack } from '../../schema';
import { GROWTH_HULLS, GROWTH_VARIANTS, GROWTH_PRESETS } from './hulls';
import { BLUEPRINTS } from './blueprints';
import { P5_ITEMS, P5_ARMS, P5_MODULES, P5_TECHS, P5_FACILITIES, P5_RECIPES, P5_VARIANTS, P5_PRESETS } from './arsenal';
import { P8_HULLS, P8_VARIANTS, P8_PRESETS, P8_BLUEPRINTS } from './p8';
import { P8_ASSETS } from './p8-assets';
import { IND_MODULES, IND_REPAIR_MODULES } from './industrial';
import { CPU_MODULES } from './computers';
import { P17_CPUS, P17_PARTS } from './parts17';
import { CARRIER_ARMS, CARRIER_MODULES, CARRIER_HULLS, CARRIER_VARIANTS, CARRIER_PRESETS, CARRIER_BLUEPRINTS } from './carrier';
import { P17_ARMS, P17_TECHS } from './arsenal17';
import { P17_HULLS, P17_VARIANTS, P17_PRESETS, P17_BLUEPRINTS } from './fleet17';
import { SUPPORT_ARMS, SUPPORT_MODULES, SUPPORT_HULLS, SUPPORT_VARIANTS, SUPPORT_PRESETS, SUPPORT_BLUEPRINTS } from './support';

export const GROWTH_PACK: ContentPack = {
  id: 'growth', name: '성장 콘텐츠 (P3·P6)',
  hulls: GROWTH_HULLS, variants: GROWTH_VARIANTS, presets: GROWTH_PRESETS, blueprints: BLUEPRINTS,
};

/** Growth-only arsenal and P8 production hulls. Keep the existing rows first for stable lookup order. */
export const ARSENAL_PACK: ContentPack = {
  id: 'arsenal', name: '무장·연구·시설 확장 (P5)', minContentV: 3,
  items: P5_ITEMS, arms: [...P5_ARMS, ...CARRIER_ARMS, ...SUPPORT_ARMS, ...P17_ARMS], modules: [...P5_MODULES, ...IND_MODULES, ...IND_REPAIR_MODULES, ...CPU_MODULES, ...CARRIER_MODULES, ...SUPPORT_MODULES, ...P17_CPUS, ...P17_PARTS], techs: [...P5_TECHS, ...P17_TECHS], facilities: P5_FACILITIES, recipes: P5_RECIPES,
  hulls: [...P8_HULLS, ...CARRIER_HULLS, ...SUPPORT_HULLS, ...P17_HULLS], variants: [...P5_VARIANTS, ...P8_VARIANTS, ...CARRIER_VARIANTS, ...SUPPORT_VARIANTS, ...P17_VARIANTS], presets: [...P5_PRESETS, ...P8_PRESETS, ...CARRIER_PRESETS, ...SUPPORT_PRESETS, ...P17_PRESETS],
  blueprints: [...P8_BLUEPRINTS, ...CARRIER_BLUEPRINTS, ...SUPPORT_BLUEPRINTS, ...P17_BLUEPRINTS], assets: P8_ASSETS,
};
