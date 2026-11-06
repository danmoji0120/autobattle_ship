// Fitting compatibility rules, shared by the validator, the server (fitting commands) and the client
// (fitting screen). Pure functions over the registry + EQUIPMENT/WEAPONS tables.
import { WEAPONS } from '../sim/data/weapons';
import { EQUIPMENT } from '../world/industry';
import { sizeRank, type HardpointDef, type HardpointType, type InternalSlotDef, type EquipSpec } from './schema';
import { CONTENT, type Registry } from './registry';

/** weapon category, as hardpoints see it */
export function weaponType(weapon: string): HardpointType {
  const w = WEAPONS[weapon];
  if (!w) return 'universal';
  if (w.hp) return w.hp;
  if (w.kind === 'pd') return 'pd';
  if (w.kind === 'missile' || w.kind === 'torpedo') return 'missile';
  return weapon === 'pulse_laser' || weapon === 'particle_lance' ? 'energy' : 'ballistic';
}

export const TYPE_NAME: Record<HardpointType, string> = { ballistic: '실탄', energy: '에너지', missile: '미사일', universal: '범용', pd: '방공' };
export const MOUNT_NAME: Record<string, string> = { turret: '포탑', fixed: '고정', vls: '수직발사', spinal: '척추' };
export const BAY_NAME: Record<string, string> = { engine: '엔진', reactor: '동력', sensor: '센서', fcs: '사격통제', ew: '전자전', armor: '장갑', special: '범용' };

export const equipSpec = (id: string, reg: Registry = CONTENT): EquipSpec | undefined => reg.equipment[id];
/** combat weapon id of a weapon equipment item */
export const weaponOf = (equipId: string): string | undefined => EQUIPMENT[equipId]?.weapon;

/** can this equipment item go on this hardpoint? null = yes, otherwise the reason */
export function hpAccepts(hp: HardpointDef, equipId: string, reg: Registry = CONTENT): string | null {
  const spec = reg.equipment[equipId], weapon = weaponOf(equipId);
  if (!spec || !weapon || !WEAPONS[weapon]) return `${EQUIPMENT[equipId]?.name ?? equipId}: 무장 장비가 아님`;
  if (spec.slot !== 'hardpoint') return `${EQUIPMENT[equipId].name}: 내부 장비는 하드포인트에 장착할 수 없음`;
  if (sizeRank(spec.size) > sizeRank(hp.size)) return `크기 초과 — 장비 ${spec.size}, 하드포인트 ${hp.size}`;
  const t = weaponType(weapon);
  if (hp.type === 'pd' && t !== 'pd') return `방공 하드포인트에는 방공 무장만`;
  if (t !== 'pd' && hp.type !== 'universal' && hp.type !== t) return `${TYPE_NAME[hp.type]} 하드포인트에 ${TYPE_NAME[t]} 무장 불가`;
  if (spec.mounts && !spec.mounts.includes(hp.mount)) return `${MOUNT_NAME[hp.mount]} 마운트에 장착 불가 (가능: ${spec.mounts.map(m => MOUNT_NAME[m]).join('·')})`;
  return null;
}

/** can this module go into this internal bay? (`special` bays take any module) */
export function bayAccepts(bay: InternalSlotDef, equipId: string, reg: Registry = CONTENT): string | null {
  const spec = reg.equipment[equipId];
  if (!spec || EQUIPMENT[equipId]?.kind !== 'module') return `${EQUIPMENT[equipId]?.name ?? equipId}: 내부 장비가 아님`;
  if (spec.slot === 'hardpoint') return `${EQUIPMENT[equipId].name}: 무장은 하드포인트에 장착`;
  if (bay.kind !== 'special' && bay.kind !== spec.slot) return `${BAY_NAME[bay.kind]} 베이에 ${BAY_NAME[spec.slot]} 장비 불가`;
  if (sizeRank(spec.size) > sizeRank(bay.size)) return `크기 초과 — 장비 ${spec.size}, 베이 ${bay.size}`;
  return null;
}

/** traverse of a weapon item on a hardpoint */
export const arcOf = (hp: HardpointDef, equipId: string) => Math.min(hp.arc, hp.arcBy?.[equipId] ?? hp.arc);

/** power and mass of equipment on a hull (reactor modules add supply) */
export function fitTotals(reg: Registry, hullId: string, onHp: Record<string, string>, inBay: Record<string, string>) {
  const h = reg.hulls[hullId]; if (!h) return null;
  let power = 0, supply = h.power, mass = 0;
  for (const id of [...Object.values(onHp), ...Object.values(inBay)]) {
    const s = reg.equipment[id]; if (!s) continue;
    mass += s.mass;
    if (s.power < 0) supply -= s.power; else power += s.power;
  }
  return { power, supply, mass, cap: h.mass };
}
