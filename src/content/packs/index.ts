// Every content pack the game loads, in load order. A new pack = a new folder + one line here.
import type { ContentPack } from '../schema';
import { CORE_PACK } from './core';
import { GROWTH_PACK } from './growth';

export const PACKS: ContentPack[] = [CORE_PACK, GROWTH_PACK];
