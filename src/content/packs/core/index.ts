import type { ContentPack } from '../../schema';
import { CORE_HULLS, CORE_VARIANTS, CORE_PRESETS, CORE_LEGACY } from './hulls';
import { CORE_ASSETS } from './assets';
import { CORE_EQUIPMENT } from './equipment';

export const CORE_PACK: ContentPack = {
  id: 'core', name: '기본 콘텐츠',
  hulls: CORE_HULLS, variants: CORE_VARIANTS, presets: CORE_PRESETS, equipment: CORE_EQUIPMENT, legacy: CORE_LEGACY, assets: CORE_ASSETS,
};
