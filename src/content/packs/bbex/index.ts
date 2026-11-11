// BB-EX — ACCOUNT-EXCLUSIVE content.
//
// One hull, its seven exclusive weapons and its internal systems. None of it has a blueprint, a
// recipe, a research, a sale entry or a build entry: nothing in the game economy can make, buy, find
// or drop any of it (the validator enforces this — content/validate.ts, "계정 전용"). The only way it
// enters a world is world/exclusive.ts: one grant, to one verified account, set by the server operator.
//
// Combat numbers and the mount layout come from sim/bbex/data.ts (single source of truth).
import type { ContentPack, ExclusiveArm, ExclusiveModule, HardpointDef, HullDef, PresetDef, VariantDef, WeaponFamily, WeaponRole } from '../../schema';
import { WEAPONS } from '../../../sim/data/weapons';
import { BBEX_CLASS, BBEX_MOUNTS, BBEX_WEAPON } from '../../../sim/bbex/data';

export const BBEX_HULL = 'bbex';
export const BBEX_VARIANT = 'bbex_std';
export const BBEX_PRESET = 'bbex_angel';
export const eqOf = (weapon: string) => `eq_${weapon}`;

const hexOf = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const ARM_FIT: Record<string, { size: 'S' | 'M' | 'L' | 'XL'; mass: number; power: number; mounts: ExclusiveArm['mounts'] }> = {
  [BBEX_WEAPON.dcp]: { size: 'XL', mass: 180, power: 190, mounts: ['spinal'] },
  [BBEX_WEAPON.lance]: { size: 'L', mass: 34, power: 46, mounts: ['turret'] },
  [BBEX_WEAPON.edge]: { size: 'M', mass: 9, power: 16, mounts: ['turret'] },
  [BBEX_WEAPON.stinger]: { size: 'S', mass: 4, power: 7, mounts: ['turret'] },
  [BBEX_WEAPON.seraph]: { size: 'M', mass: 12, power: 6, mounts: ['vls'] },
  [BBEX_WEAPON.rain]: { size: 'S', mass: 2, power: 4, mounts: ['turret'] },
};

const ARMS: ExclusiveArm[] = Object.keys(ARM_FIT).map(id => {
  const w = WEAPONS[id], f = ARM_FIT[id];
  const { id: _id, name, desc, family, tier, role, hp: _hp, vis, sound, ...combat } = w;
  return {
    id: eqOf(id), name, desc, family: family as WeaponFamily, tier: tier ?? 5, role: role as WeaponRole, size: f.size, mass: f.mass, power: f.power, mounts: f.mounts,
    combat: { ...combat, sound }, ...(vis ? { vis: { color: hexOf(vis.color), len: vis.len, wid: vis.wid, beam: vis.beam } } : {}),
  };
});

// The exotic systems are part of the hull: these modules name them in the fitting screen. Their
// behaviour is the combat engine's (sim/bbex/system.ts); they cannot be removed or fitted elsewhere.
const MODULES: ExclusiveModule[] = [
  { id: 'mod_bbex_paradox', name: 'PARADOX 국소공간 치환기', slot: 'armor', size: 'L', mass: 40, power: 60, desc: '피격 지점의 공간을 재배치해 공격을 다른 곳으로 흘려보낸다. 결계가 과부하되면 재구성까지 방어가 약해진다.' },
  { id: 'mod_bbex_regenesis', name: 'REGENESIS 자율 재구성 코어', slot: 'special', size: 'L', mass: 36, power: 30, desc: '선체와 퍼널을 스스로 재구성한다.' },
  { id: 'mod_bbex_blackout', name: 'BLACKOUT 고차원 전자전 어레이', slot: 'ew', size: 'L', mass: 20, power: 44, desc: '적 함대 전체의 센서·유도·표적 처리를 교란한다.' },
  { id: 'mod_bbex_gravity', name: 'GRAVITY WELL 국소 중력 붕괴기', slot: 'special', size: 'L', mass: 30, power: 50, desc: '적 함대를 국소 중력장에 묶는다.' },
  { id: 'mod_bbex_phantom', name: 'PHANTOM SHIFT 전술 공간전이 구동기', slot: 'engine', size: 'L', mass: 28, power: 40, desc: '전투 중 짧은 거리의 공간전이를 수행한다.' },
  { id: 'mod_bbex_funnel', name: 'FNL-EX 퍼널 관제 코어 (12기)', slot: 'fcs', size: 'L', mass: 48, power: 36, desc: '12기의 다목적 퍼널: 공격·요격·공간고정·반사면 전개.' },
  { id: 'mod_bbex_core', name: '특이점 반응로', slot: 'reactor', size: 'L', mass: 60, power: -200, desc: 'BB-EX의 주동력. 전용 무장 전체를 동시에 가동한다.' },
  { id: 'mod_bbex_core2', name: '위상 축전 격자', slot: 'reactor', size: 'L', mass: 40, power: -200, desc: '차원절단입자포 충전용 보조 동력.' },
];

const HP_TYPE = { energy: 'energy', missile: 'missile', pd: 'pd' } as const;
const HARDPOINTS: HardpointDef[] = BBEX_MOUNTS.map(x => ({ id: x.id, pos: x.mount.pos, facing: x.mount.facing, arc: x.mount.arc, size: x.size, type: HP_TYPE[x.type], mount: x.style }));

const HULLS: HullDef[] = [{
  id: BBEX_HULL, classId: BBEX_CLASS, name: 'BB-EX', maker: '불명', tier: 4, size: 'L', moduleSlots: 8, power: 700, mass: 1100, blueprint: 'unique', exclusive: true,
  mesh: { base: 'bbex', scale: 1 },
  desc: '세계에 단 한 척뿐인 실험형 지휘·전자전 경순양함. 설계도도, 건조 기록도 없다. 지정된 한 계정에만 귀속된다.',
  ops: { cruise: 150, berth: 'M' },
  upkeep: { credits: 0 },
  internals: [
    { id: 'core1', kind: 'reactor', size: 'L' }, { id: 'core2', kind: 'reactor', size: 'L' }, { id: 'paradox', kind: 'armor', size: 'L' }, { id: 'regen', kind: 'special', size: 'L' },
    { id: 'blackout', kind: 'ew', size: 'L' }, { id: 'gravity', kind: 'special', size: 'L' }, { id: 'phantom', kind: 'engine', size: 'L' }, { id: 'funnel', kind: 'fcs', size: 'L' },
  ],
  hardpoints: HARDPOINTS,
}];

const VARIANTS: VariantDef[] = [{ id: BBEX_VARIANT, hull: BBEX_HULL, name: 'ANGEL DESCENT', desc: 'BB-EX의 유일한 구조.', blueprint: 'common' }];

const PRESETS: PresetDef[] = [{
  id: BBEX_PRESET, hull: BBEX_HULL, variant: BBEX_VARIANT, name: 'ANGEL DESCENT',
  desc: 'DCP-Ω 1 · ABYSS-LANCE 4 · VIOLET EDGE 8 · LILAC STINGER 8 · SERAPH-EX 8 · PURPLE RAIN 16 (45 장착점) + FNL-EX 퍼널 12기.',
  weapons: Object.fromEntries(BBEX_MOUNTS.map(x => [x.id, eqOf(x.mount.weapon)])),
}];

/** the internal systems, bay id → module (fixed; granted with the hull) */
export const BBEX_BAYS: Record<string, string> = {
  core1: 'mod_bbex_core', core2: 'mod_bbex_core2', paradox: 'mod_bbex_paradox', regen: 'mod_bbex_regenesis',
  blackout: 'mod_bbex_blackout', gravity: 'mod_bbex_gravity', phantom: 'mod_bbex_phantom', funnel: 'mod_bbex_funnel',
};

export const BBEX_PACK: ContentPack = {
  id: 'bbex', name: 'BB-EX (계정 전용)', minContentV: 3,
  hulls: HULLS, variants: VARIANTS, presets: PRESETS,
  exclusive: { arms: ARMS, modules: MODULES },
};
