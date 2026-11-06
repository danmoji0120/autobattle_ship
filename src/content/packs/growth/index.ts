import type { ContentPack } from '../../schema';
import { GROWTH_HULLS, GROWTH_VARIANTS, GROWTH_PRESETS } from './hulls';
import { BLUEPRINTS } from './blueprints';

export const GROWTH_PACK: ContentPack = {
  id: 'growth', name: '성장 콘텐츠 (P3·P6)',
  hulls: GROWTH_HULLS, variants: GROWTH_VARIANTS, presets: GROWTH_PRESETS, blueprints: BLUEPRINTS,
};
