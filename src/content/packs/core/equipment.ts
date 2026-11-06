// Fitting rules of the existing equipment items (EQUIPMENT ids in src/world/industry.ts).
// mass = load on the hull's equipment capacity, power = draw on the hull's supply (negative = supply).
// Balance notes: energy weapons trade low mass for high power; kinetic mains are heavy but cheap to
// run; missiles are light on both but need VLS/turret mounts. See docs/CODEX_CONTENT_GUIDE.md §장비.
import type { EquipSpec } from '../../schema';

export const CORE_EQUIPMENT: EquipSpec[] = [
  // weapons (hardpoints)
  { id: 'eq_autocannon', slot: 'hardpoint', size: 'S', mass: 4, power: 2 },
  { id: 'eq_pd_gun', slot: 'hardpoint', size: 'S', mass: 2, power: 2 },
  { id: 'eq_torpedo', slot: 'hardpoint', size: 'M', mass: 10, power: 1, mounts: ['fixed', 'turret', 'vls'] },
  { id: 'eq_medium_gun', slot: 'hardpoint', size: 'M', mass: 10, power: 4, mounts: ['turret', 'fixed'] },
  { id: 'eq_missile_rack', slot: 'hardpoint', size: 'M', mass: 12, power: 2, mounts: ['vls', 'turret'] },
  { id: 'eq_laser', slot: 'hardpoint', size: 'M', mass: 7, power: 10, mounts: ['turret', 'fixed'] },
  { id: 'eq_heavy_cannon', slot: 'hardpoint', size: 'L', mass: 40, power: 10, mounts: ['turret', 'fixed', 'spinal'] },
  { id: 'eq_rail_cannon', slot: 'hardpoint', size: 'L', mass: 32, power: 26, mounts: ['turret', 'fixed', 'spinal'] },
  { id: 'eq_lance', slot: 'hardpoint', size: 'L', mass: 30, power: 34, mounts: ['turret', 'fixed', 'spinal'] },
  // internal modules (bays)
  { id: 'mod_armor', slot: 'armor', size: 'M', mass: 18, power: 0 },
  { id: 'mod_armor2', slot: 'armor', size: 'M', mass: 14, power: 2 },
  { id: 'mod_engine', slot: 'engine', size: 'S', mass: 4, power: 4 },
  { id: 'mod_engine2', slot: 'engine', size: 'S', mass: 5, power: 6 },
  { id: 'mod_fcs', slot: 'fcs', size: 'S', mass: 2, power: 3 },
  { id: 'mod_sensor', slot: 'sensor', size: 'S', mass: 3, power: 4 },
  { id: 'mod_ecm', slot: 'ew', size: 'S', mass: 3, power: 6 },
  { id: 'mod_reactor', slot: 'reactor', size: 'M', mass: 10, power: -20 },
  { id: 'mod_pd', slot: 'fcs', size: 'S', mass: 2, power: 3 },
];
