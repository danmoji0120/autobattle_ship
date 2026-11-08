// Every content pack the game loads, in load order. A new pack = a new folder + one line here.
import type { ContentPack } from '../schema';
import { CORE_PACK } from './core';
import { GROWTH_PACK, ARSENAL_PACK } from './growth';
import { EXAMPLE_PACK } from './example';
import { MODELTEST_PACK } from './modeltest';
import { SID_SHIPWORKS_PACK } from './sid_shipworks';

export const PACKS: ContentPack[] = [CORE_PACK, GROWTH_PACK, ARSENAL_PACK, EXAMPLE_PACK, MODELTEST_PACK, SID_SHIPWORKS_PACK];
