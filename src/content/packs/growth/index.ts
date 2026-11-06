import type { ContentPack } from '../../schema';
import { GROWTH_HULLS, GROWTH_VARIANTS, GROWTH_PRESETS } from './hulls';
import { BLUEPRINTS } from './blueprints';
import { P5_ITEMS, P5_ARMS, P5_MODULES, P5_TECHS, P5_FACILITIES, P5_RECIPES, P5_VARIANTS, P5_PRESETS } from './arsenal';

export const GROWTH_PACK: ContentPack = {
  id: 'growth', name: '성장 콘텐츠 (P3·P6)',
  hulls: GROWTH_HULLS, variants: GROWTH_VARIANTS, presets: GROWTH_PRESETS, blueprints: BLUEPRINTS,
};

/** P5 arsenal: weapon families, shields, the 13-area research additions, factories and labs */
export const ARSENAL_PACK: ContentPack = {
  id: 'arsenal', name: '무장·연구·시설 확장 (P5)', minContentV: 3,
  items: P5_ITEMS, arms: P5_ARMS, modules: P5_MODULES, techs: P5_TECHS, facilities: P5_FACILITIES, recipes: P5_RECIPES,
  variants: P5_VARIANTS, presets: P5_PRESETS,
};
