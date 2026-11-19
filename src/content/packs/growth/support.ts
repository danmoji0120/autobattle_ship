// P16.7 combat repair content: repair rigs for the support (R) hardpoint, a support computer for the computer bay,
// and one combat repair hull. docs/P16_7_REPAIR_SHIPS_DESIGN.md.
//
// What makes a ship a combat repair ship is its structure, not its class name: `support` hardpoints take only
// combat repair rigs, and combat repair rigs go nowhere else (content/rules.ts hpAccepts) — the H-slot rule of P16.
// Field (out-of-battle) repair is industrial gear instead (industrial.ts IND_REPAIR_MODULES).
//
// RELEASE: the hull is a PREVIEW hull, released only by its own switch (content/repairRelease.ts), separate from
// the carrier switch. While it is a preview the world neither sells, builds nor awards it, and the rigs and the
// support computer (which only fit / act on a support hardpoint) are not produced or sold (registry gearReleased).
import type { ArmContent, BlueprintDef, HardpointDef, HullDef, ModuleContent, PresetDef, VariantDef } from '../../schema';
import type { RepairStats } from '../../../sim/data/weapons';
import { DEV_REPAIR_HULL_ID } from '../../repairRelease';

export const REPAIR_HULL = DEV_REPAIR_HULL_ID;

/** a combat repair rig's row: it fires nothing (damage 0, salvo 0); range = work reach, reload = work cycle */
const rig = (id: string, name: string, size: 'S' | 'M', r: RepairStats, range: number, reload: number, mass: number, power: number, inp: Record<string, number>, time: number, desc: string): ArmContent => ({
  id, name, desc, family: 'repair', tier: size === 'S' ? 1 : 2, role: 'general', size, mass, power, mounts: ['turret'], tech: 'damage_control',
  combat: { kind: 'repair', damage: 0, pen: 0, range, speed: 0, reload, salvo: 0, salvoGap: 0, spread: 0, turnSpeed: 240, caliber: 0.6, sound: 'auto', repair: r },
  vis: { color: '#7dffb0', len: 0, wid: 0.5, beam: true },
  recipe: { fac: 'machine_shop', time, in: inp },
});

export const SUPPORT_ARMS: ArmContent[] = [
  rig('eq_rep_rig_s', '응급 수리 빔', 'S', { hull: 0.025, crit: 0.35 }, 650, 4, 4, 3, { machinery: 6, precision: 2, electronics: 3 }, 900,
    '아군 함선 한 척을 4초마다 응급 수리한다: 선체 최대체력 2.5%(전투당 표적별 15% 한도, 최근 3초 안에 피격된 함선은 선체 수리 불가), 화재·기관·함교·무장 손상 남은 시간 35% 단축. 침몰 중인 함선은 살릴 수 없다.'),
  rig('eq_rep_rig_m', '피해 통제 드론', 'M', { hull: 0.04, crit: 0.45 }, 750, 4, 8, 5, { machinery: 10, precision: 4, electronics: 5, composite: 2 }, 1500,
    '수리 드론 편대로 4초마다 아군 한 척을 응급 수리한다: 선체 최대체력 4%(전투당 표적별 15% 한도), 손상 남은 시간 45% 단축. 지원(R) 하드포인트(M) 전용.'),
];

export const SUPPORT_MODULES: ModuleContent[] = [
  { id: 'cpu_support', name: '지원 관제 컴퓨터', slot: 'computer', size: 'S', mass: 2, power: 3, fx: {}, cpu: { arch: 'support' }, tech: 'damage_control',
    recipe: { fac: 'electronics_fab', time: 600, in: { electronics: 5, precision: 2, crystal: 1 } },
    desc: '전열 뒤편에서 수리할 아군 곁으로 함선을 옮기고, 적 함포 사거리 안에 들면 물러난다. 수리 장비가 없으면 기본 제어.' },
];

const hp = (id: string, pos: [number, number, number], facing: number, arc: number, size: HardpointDef['size'], type: HardpointDef['type']): HardpointDef => ({ id, pos, facing, arc, size, type, mount: 'turret' });
export const MENDER_HP: HardpointDef[] = [
  hp('gun1', [0, 3, 8], 0, 150, 'M', 'ballistic'),
  hp('r1', [0, 4.4, 2], 0, 180, 'M', 'support'),
  hp('r2', [2.6, 3, -3], 90, 180, 'S', 'support'),
  hp('r3', [-2.6, 3, -3], -90, 180, 'S', 'support'),
  hp('pd1', [2.8, 2.6, 5], 90, 175, 'S', 'pd'),
  hp('pd2', [-2.8, 2.6, 5], -90, 175, 'S', 'pd'),
  hp('pd3', [2.8, 2.6, -7], 90, 175, 'S', 'pd'),
  hp('pd4', [-2.8, 2.6, -7], -90, 175, 'S', 'pd'),
];
export const MENDER_STD_WEAPONS: Record<string, string> = {
  gun1: 'eq_medium_gun', r1: 'eq_rep_rig_m', r2: 'eq_rep_rig_s', r3: 'eq_rep_rig_s', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun',
};

export const SUPPORT_HULLS: HullDef[] = [{
  id: REPAIR_HULL, classId: 'destroyer', name: '구호급', maker: '연합 방위조선', tier: 2, size: 'M', moduleSlots: 3, power: 42, mass: 60, blueprint: 'advanced', preview: true,
  mesh: { base: 'dd_picket', scale: 1 },
  desc: '지원(R) 하드포인트 세 곳에 수리 장비를 단 전투 수리함. 전열 뒤에서 아군의 화재·기관·함교 손상을 줄이고 선체를 응급 복구한다. 대함 화력은 부포 한 문뿐이다.',
  stats: { hpMul: 1, armorMul: 0.9, speedMul: 0.95 },
  ops: { cruise: 104, berth: 'M' },
  build: { yard: 2, time: 6600, credits: 5200, tech: ['damage_control'], facilities: ['machine_shop'], parts: { structure: 50, armor_plate: 16, engine: 2, reactor: 2, sensor: 2, electronics: 12, machinery: 10 } },
  upkeep: { credits: 900, supplies: { machinery: 0.3 }, wear: 0.05 },
  // no `sale`: preview hull (see the file header)
  internals: [{ id: 'fcs1', kind: 'fcs', size: 'S' }, { id: 'sen1', kind: 'sensor', size: 'S' }, { id: 'bay1', kind: 'special', size: 'M' }],
  hardpoints: MENDER_HP,
}];

export const SUPPORT_VARIANTS: VariantDef[] = [
  { id: `${REPAIR_HULL}_std`, hull: REPAIR_HULL, name: '표준형', desc: '지원 하드포인트 셋, 부포 하나, 방공포 넷.', blueprint: 'common' },
];

export const SUPPORT_PRESETS: PresetDef[] = [
  { id: 'mender_std', hull: REPAIR_HULL, variant: `${REPAIR_HULL}_std`, name: '표준 수리', desc: '피해 통제 드론 1, 응급 수리 빔 2, 부포 1, 방공포 4.', weapons: MENDER_STD_WEAPONS },
];

export const SUPPORT_BLUEPRINTS: BlueprintDef[] = [
  // station sources only: a preview hull's blueprint must not take part in random awards (validator)
  { id: `bp_${REPAIR_HULL}`, name: '구호급 전투 수리함 설계도', desc: '구호급 전투 수리함 선체의 건조 권리. 피해 통제 연구가 필요하다.', grade: 'advanced', target: { kind: 'hull', id: REPAIR_HULL },
    sources: [{ kind: 'commercial', stations: ['bastion', 'astra'], price: 52000, rep: 15, contracts: 3 }], requires: ['damage_control'] },
];

/** repair gear market rows for public stations of a world that has repair content (world/industrialGear.ts
 *  stockRepairGear — new worlds only under the repair switch, existing saves by explicit migration) */
export const REPAIR_MARKETS: Record<string, string[]> = {
  rustport: ['ind_rep_s', 'ind_rep_m'],
  exchange: ['ind_rep_s'],
  helios: ['ind_rep_m', 'ind_rep_l', 'eq_rep_rig_s', 'cpu_support'],
  bastion: ['ind_rep_s', 'eq_rep_rig_s', 'eq_rep_rig_m', 'cpu_support'],
  p9_ceres_works: ['ind_rep_s'],
};
