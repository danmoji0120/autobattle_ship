// P8 production ships. These entries extend the existing growth-only arsenal pack and never alter
// the original hulls or their saved hardpoint ids. GLB markers are generated from these positions.
import type { BlueprintDef, HardpointDef, HullDef, PresetDef, VariantDef } from '../../schema';

export const PATHFINDER_HP: HardpointDef[] = [
  { id: 'main1', pos: [0, 1.25, 3.7], facing: 0, arc: 145, size: 'S', type: 'ballistic', mount: 'turret' },
  { id: 'gun1', pos: [1.55, 1.18, -1.25], facing: 90, arc: 125, size: 'S', type: 'ballistic', mount: 'turret' },
  { id: 'gun2', pos: [-1.55, 1.18, -1.25], facing: -90, arc: 125, size: 'S', type: 'ballistic', mount: 'turret' },
  { id: 'pd1', pos: [0, 1.42, -4.45], facing: 180, arc: 150, size: 'S', type: 'pd', mount: 'turret' },
];

export const LANCET_HP: HardpointDef[] = [
  { id: 'gun1', pos: [0, 2.5, 8.3], facing: 0, arc: 145, size: 'M', type: 'ballistic', mount: 'turret' },
  { id: 'vls1', pos: [1.25, 2.15, 3], facing: 0, arc: 180, size: 'M', type: 'missile', mount: 'vls' },
  { id: 'vls2', pos: [-1.25, 2.15, 3], facing: 0, arc: 180, size: 'M', type: 'missile', mount: 'vls' },
  { id: 'vls3', pos: [1.25, 2.15, -1], facing: 0, arc: 180, size: 'M', type: 'missile', mount: 'vls' },
  { id: 'vls4', pos: [-1.25, 2.15, -1], facing: 0, arc: 180, size: 'M', type: 'missile', mount: 'vls' },
  { id: 'pd1', pos: [2.65, 2.25, -7.7], facing: 90, arc: 160, size: 'S', type: 'pd', mount: 'turret' },
  { id: 'pd2', pos: [-2.65, 2.25, -7.7], facing: -90, arc: 160, size: 'S', type: 'pd', mount: 'turret' },
];
export const QUARRY_HP: HardpointDef[] = [
  { id: 'pd1', pos: [3.65, 3.1, -9], facing: 90, arc: 150, size: 'S', type: 'pd', mount: 'turret' },
  { id: 'pd2', pos: [-3.65, 3.1, -9], facing: -90, arc: 150, size: 'S', type: 'pd', mount: 'turret' },
];
export const MERIDIAN_HP: HardpointDef[] = [
  { id: 'pd1', pos: [5.15, 4.5, 21.5], facing: 90, arc: 160, size: 'S', type: 'pd', mount: 'turret' },
  { id: 'pd2', pos: [-5.15, 4.5, 21.5], facing: -90, arc: 160, size: 'S', type: 'pd', mount: 'turret' },
  { id: 'pd3', pos: [5.15, 4.5, -21.5], facing: 90, arc: 160, size: 'S', type: 'pd', mount: 'turret' },
  { id: 'pd4', pos: [-5.15, 4.5, -21.5], facing: -90, arc: 160, size: 'S', type: 'pd', mount: 'turret' },
];
export const VIGIL_HP: HardpointDef[] = [
  { id: 'main1', pos: [0, 3.15, 10.5], facing: 0, arc: 145, size: 'M', type: 'universal', mount: 'turret' },
  { id: 'main2', pos: [0, 3.15, -10], facing: 180, arc: 145, size: 'M', type: 'universal', mount: 'turret' },
  { id: 'aux1', pos: [3.15, 2.65, -1], facing: 90, arc: 140, size: 'S', type: 'energy', mount: 'turret' },
  { id: 'aux2', pos: [-3.15, 2.65, -1], facing: -90, arc: 140, size: 'S', type: 'energy', mount: 'turret' },
  { id: 'pd1', pos: [3.1, 2.55, 7], facing: 90, arc: 150, size: 'S', type: 'pd', mount: 'turret' },
  { id: 'pd2', pos: [-3.1, 2.55, 7], facing: -90, arc: 150, size: 'S', type: 'pd', mount: 'turret' },
];

export const P8_HULLS: HullDef[] = [{
  id: 'patrol_pathfinder', classId: 'corvette', name: '길잡이급', maker: '연합 방위조선', tier: 1, size: 'S',
  moduleSlots: 2, power: 22, mass: 34, blueprint: 'common',
  mesh: { base: 'corvette', scale: 1.05, model: 'model.patrol_pathfinder' },
  desc: '선수와 좌우에 기관포를 갖춘 범용 초계함. 어뢰 초계함보다 사각이 적고 호위에 유리하지만 대형함을 상대로 한 일격이 약하다.',
  stats: { hpMul: 1.03, armorMul: 1, speedMul: 0.95 },
  ops: { cruise: 142, berth: 'S' },
  build: { yard: 1, time: 1800, credits: 1800, parts: { structure: 20, armor_plate: 7, engine: 1, reactor: 1, sensor: 1, electronics: 5 } },
  upkeep: { credits: 340, supplies: { chemicals: 0.5 }, wear: 0.05 },
  sale: { stations: ['helios', 'bastion', 'astra'], stock: 3, restock: 2700 },
  internals: [{ id: 'bay1', kind: 'special', size: 'M' }, { id: 'sen1', kind: 'sensor', size: 'S' }],
  hardpoints: PATHFINDER_HP,
}, {
  id: 'destroyer_lancet', classId: 'destroyer', name: '침봉급', maker: '헬리오스 조병창', tier: 2, size: 'M',
  moduleSlots: 3, power: 38, mass: 78, blueprint: 'advanced',
  mesh: { base: 'dd_vls', scale: 1.1, model: 'model.destroyer_lancet' },
  desc: '중앙 발사갑판에 VLS 네 기를 배치한 미사일 구축함. 장거리 포화에 강하지만 장갑과 근접 포격 지속력이 낮다.',
  stats: { hpMul: 0.9, armorMul: 0.84, speedMul: 0.98 },
  ops: { cruise: 110, berth: 'M' },
  build: { yard: 2, time: 6900, credits: 5600, tech: ['guided_missiles'], facilities: ['electronics_fab'], parts: { structure: 48, armor_plate: 15, engine: 2, reactor: 2, sensor: 3, electronics: 20 } },
  upkeep: { credits: 1000, supplies: { chemicals: 4, electronics: 0.2 }, wear: 0.05 },
  sale: { stations: ['helios'], rep: 15, stock: 2, restock: 6000 },
  internals: [{ id: 'fcs1', kind: 'fcs', size: 'S' }, { id: 'sen1', kind: 'sensor', size: 'S' }, { id: 'rx1', kind: 'reactor', size: 'M' }, { id: 'bay1', kind: 'special', size: 'M' }],
  hardpoints: LANCET_HP,
}, {
  id: 'miner_quarry', classId: 'miner', name: '석맥급', maker: '바르카 채광조합', tier: 1, size: 'M',
  moduleSlots: 2, power: 23, mass: 31, blueprint: 'common',
  mesh: { base: 'miner_m', scale: 1.3, model: 'model.miner_quarry' },
  desc: '쌍 굴착 붐과 선내 선광 호퍼를 갖춘 중형 채굴선. 소형선보다 채굴량이 크지만 운용비와 조선 기반이 더 필요하다.',
  ops: { bonus: { mine: 1.22 }, gear: ['ind_mine_m'], cruise: 60, cargo: 400, mine: 6.1, berth: 'M' },
  build: { yard: 2, time: 3900, credits: 3200, tech: ['mining_lasers'], facilities: ['machine_shop'], parts: { structure: 48, armor_plate: 8, engine: 2, reactor: 1, machinery: 22, precision: 2 } },
  upkeep: { credits: 850, supplies: { machinery: 0.14 }, wear: 0.05 },
  sale: { stations: ['astra', 'barcaco', 'drakeout'], stock: 3, restock: 3300 },
  internals: [{ id: 'bay1', kind: 'special', size: 'M' }, { id: 'eng1', kind: 'engine', size: 'S' }, { id: 'ind1', kind: 'industrial', size: 'M' }],
  hardpoints: QUARRY_HP,
}, {
  id: 'hauler_meridian', classId: 'hauler', name: '자오선급', maker: '상인 길드 조선', tier: 2, size: 'L',
  moduleSlots: 3, power: 22, mass: 32, blueprint: 'advanced',
  mesh: { base: 'hauler_l', scale: 1.7, model: 'model.hauler_meridian' },
  desc: '양현 화물 모듈 여섯 개를 골조에 고정한 대형 수송선. 대량 운송에 적합하지만 큰 정박 시설과 높은 유지비가 필요하다.',
  ops: { cruise: 64, cargo: 3100, berth: 'L' },
  build: { yard: 3, time: 6400, credits: 6400, tech: ['logistics_ai'], facilities: ['dock'], parts: { structure: 150, engine: 4, reactor: 2, machinery: 26, electronics: 6 } },
  upkeep: { credits: 2200, supplies: { chemicals: 1.3 }, wear: 0.04 },
  sale: { stations: ['exchange'], rep: 10, stock: 1, restock: 6600 },
  internals: [{ id: 'bay1', kind: 'special', size: 'M' }, { id: 'bay2', kind: 'special', size: 'M' }, { id: 'eng1', kind: 'engine', size: 'S' }, { id: 'ind1', kind: 'industrial', size: 'M' }],
  hardpoints: MERIDIAN_HP,
}, {
  id: 'cruiser_vigil', classId: 'light_cruiser', name: '감시자급', maker: '연합 방위조선', tier: 3, size: 'M',
  moduleSlots: 3, power: 58, mass: 64, blueprint: 'rare',
  mesh: { base: 'light_cruiser', scale: 1.1, model: 'model.cruiser_vigil' },
  desc: '전후 범용 포좌와 양현 광학 포좌를 갖춘 고급 경순양함. 유연한 혼합 화력을 얻는 대신 주포 수와 선체 내구를 양보한다.',
  stats: { hpMul: 0.92, armorMul: 1.03, speedMul: 1.04 },
  ops: { cruise: 104, berth: 'M' },
  build: { yard: 2, time: 12600, credits: 9000, tech: ['light_cruiser_design', 'microelectronics', 'optical_lasers'], facilities: ['electronics_fab'], parts: { structure: 92, armor_plate: 38, engine: 4, reactor: 3, sensor: 4, electronics: 24, precision: 6 } },
  upkeep: { credits: 1550, supplies: { chemicals: 1.5, electronics: 0.2 }, wear: 0.05 },
  sale: { stations: ['helios', 'bastion'], rep: 25, stock: 1, restock: 10800 },
  internals: [{ id: 'fcs1', kind: 'fcs', size: 'S' }, { id: 'sen1', kind: 'sensor', size: 'S' }, { id: 'rx1', kind: 'reactor', size: 'M' }, { id: 'bay1', kind: 'special', size: 'M' }],
  hardpoints: VIGIL_HP,
}];

export const P8_VARIANTS: VariantDef[] = [
  { id: 'patrol_pathfinder_std', hull: 'patrol_pathfinder', name: '표준형', desc: '함수와 양현 기관포로 폭넓은 사계를 확보한 기본 구조.', blueprint: 'common' },
  { id: 'patrol_pathfinder_scout', hull: 'patrol_pathfinder', name: '정찰형', desc: '후방 방공포를 철거해 센서 베이를 늘렸다. 속도는 오르지만 내구와 방공 능력이 줄어든다.', blueprint: 'common', hardpoints: { remove: ['pd1'] }, internals: { add: [{ id: 'sen2', kind: 'sensor', size: 'S' }] }, mods: { hpMul: 0.95, speedMul: 1.04, cruiseMul: 1.05 } },
  { id: 'destroyer_lancet_std', hull: 'destroyer_lancet', name: '표준형', desc: '네 VLS와 선수 부포로 원거리 공격을 수행하는 기본 구조.', blueprint: 'common' },
  { id: 'destroyer_lancet_screen', hull: 'destroyer_lancet', name: '호위 지휘형', desc: '후방 VLS 두 기를 제거하고 전자전 베이를 추가했다. 방어 지원에 유리하지만 일제사격이 약해진다.', blueprint: 'common', hardpoints: { remove: ['vls3', 'vls4'] }, internals: { add: [{ id: 'ew1', kind: 'ew', size: 'S' }] }, mods: { hpMul: 0.96, speedMul: 1.04 } },
  { id: 'miner_quarry_std', hull: 'miner_quarry', name: '표준형', desc: '쌍 굴착 붐과 선광 호퍼를 이용하는 기본 구조.', blueprint: 'common' },
  { id: 'miner_quarry_hold', hull: 'miner_quarry', name: '확장 호퍼형', desc: '내부 선광 설비 일부를 저장 공간으로 바꿨다. 적재 +25%, 채굴 −15%, 순항 −5%.', blueprint: 'common', mods: { cargoMul: 1.25, mineMul: 0.85, cruiseMul: 0.95 } },
  { id: 'hauler_meridian_std', hull: 'hauler_meridian', name: '표준형', desc: '여섯 화물 모듈과 자위 방공포를 갖춘 기본 구조.', blueprint: 'common' },
  { id: 'hauler_meridian_express', hull: 'hauler_meridian', name: '급행형', desc: '화물 모듈 일부를 추진제와 기계 설비로 사용한다. 적재 −20%, 순항 +13%, 유지비 +10%.', blueprint: 'common', mods: { cargoMul: 0.8, cruiseMul: 1.13, speedMul: 1.05, upkeepMul: 1.1 } },
  { id: 'cruiser_vigil_std', hull: 'cruiser_vigil', name: '표준형', desc: '전후 포좌와 양현 광학 포좌를 사용하는 기본 구조.', blueprint: 'common' },
  { id: 'cruiser_vigil_command', hull: 'cruiser_vigil', name: '지휘형', desc: '양현 광학 포좌를 센서·전자전 장비로 바꾼다. 지휘 장비가 늘지만 보조 화력과 내구가 줄어든다.', blueprint: 'advanced', hardpoints: { remove: ['aux1', 'aux2'] }, internals: { add: [{ id: 'sen2', kind: 'sensor', size: 'S' }, { id: 'ew1', kind: 'ew', size: 'S' }] }, mods: { hpMul: 0.94 }, parts: { sensor: 1, electronics: 6 }, needs: { facilities: ['comms'], tech: ['long_sensors'] } },
];

export const P8_PRESETS: PresetDef[] = [
  { id: 'pathfinder_patrol', hull: 'patrol_pathfinder', variant: 'patrol_pathfinder_std', name: '범용 초계', desc: '기관포 3, 후방 방공포 1. 어뢰 없이 지속 교전에 집중한다.', weapons: { main1: 'eq_autocannon', gun1: 'eq_autocannon', gun2: 'eq_autocannon', pd1: 'eq_pd_gun' } },
  { id: 'pathfinder_scout', hull: 'patrol_pathfinder', variant: 'patrol_pathfinder_scout', name: '장거리 정찰', desc: '기관포 3. 방공포를 포기하고 센서와 속도를 확보한다.', weapons: { main1: 'eq_autocannon', gun1: 'eq_autocannon', gun2: 'eq_autocannon' } },
  { id: 'lancet_salvo', hull: 'destroyer_lancet', variant: 'destroyer_lancet_std', name: '원거리 포화', desc: 'VLS 4와 부포 1, 방공포 2. 근접 포격보다 일제사격에 집중한다.', weapons: { gun1: 'eq_medium_gun', vls1: 'eq_missile_rack', vls2: 'eq_missile_rack', vls3: 'eq_missile_rack', vls4: 'eq_missile_rack', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' } },
  { id: 'lancet_screen', hull: 'destroyer_lancet', variant: 'destroyer_lancet_screen', name: '호위 지원', desc: 'VLS 2, 부포 1, 방공포 2. 포화 화력을 줄이고 전자전 공간을 확보한다.', weapons: { gun1: 'eq_medium_gun', vls1: 'eq_missile_rack', vls2: 'eq_missile_rack', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' } },
  { id: 'quarry_mining', hull: 'miner_quarry', variant: 'miner_quarry_std', name: '표준 채굴', desc: '방공포 2. 채굴 장비에 공간을 할애해 대함 무장이 없다.', weapons: { pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' } },
  { id: 'quarry_hold', hull: 'miner_quarry', variant: 'miner_quarry_hold', name: '장거리 채굴', desc: '방공포 2. 채굴 속도를 줄여 저장량을 늘린다.', weapons: { pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' } },
  { id: 'meridian_cargo', hull: 'hauler_meridian', variant: 'hauler_meridian_std', name: '표준 수송', desc: '방공포 4. 호신에 집중하며 대함 무장은 싣지 않는다.', weapons: { pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' } },
  { id: 'meridian_express', hull: 'hauler_meridian', variant: 'hauler_meridian_express', name: '급행 수송', desc: '방공포 4. 화물량보다 빠른 왕복을 우선한다.', weapons: { pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' } },
  { id: 'vigil_mixed', hull: 'cruiser_vigil', variant: 'cruiser_vigil_std', name: '혼합 호위', desc: '부포 2, 적색 레이저 2, 방공포 2. 미사일 대신 다양한 사계에 집중한다.', weapons: { main1: 'eq_medium_gun', main2: 'eq_medium_gun', aux1: 'eq_laser_red', aux2: 'eq_laser_red', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' } },
  { id: 'vigil_command', hull: 'cruiser_vigil', variant: 'cruiser_vigil_command', name: '지휘 호위', desc: '부포 2, 방공포 2. 광학 보조포를 포기하고 지휘 베이를 확보한다.', weapons: { main1: 'eq_medium_gun', main2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' } },
];

export const P8_BLUEPRINTS: BlueprintDef[] = [
  { id: 'bp_patrol_pathfinder', name: '길잡이급 초계함 설계도', desc: '길잡이급 선체를 자사 조선소에서 건조할 권리.', grade: 'common', target: { kind: 'hull', id: 'patrol_pathfinder' }, sources: [{ kind: 'shop', stations: ['helios', 'bastion', 'astra'], price: 4200 }] },
  { id: 'bp_destroyer_lancet', name: '침봉급 구축함 설계도', desc: '침봉급 선체의 건조 권리. 유도 미사일 연구가 별도로 필요하다.', grade: 'advanced', target: { kind: 'hull', id: 'destroyer_lancet' }, sources: [{ kind: 'commercial', stations: ['helios'], price: 75000, rep: 18, contracts: 3 }, { kind: 'explore', tier: 2, chance: 0.06 }], requires: ['guided_missiles'] },
  { id: 'bp_miner_quarry', name: '석맥급 채굴선 설계도', desc: '석맥급 선체의 건조 권리. 채굴 레이저 연구가 별도로 필요하다.', grade: 'common', target: { kind: 'hull', id: 'miner_quarry' }, sources: [{ kind: 'shop', stations: ['astra', 'barcaco', 'drakeout'], price: 14000 }], requires: ['mining_lasers'] },
  { id: 'bp_hauler_meridian', name: '자오선급 수송선 설계도', desc: '자오선급 선체의 건조 권리. 물류 AI 연구와 대형 정박 시설이 필요하다.', grade: 'advanced', target: { kind: 'hull', id: 'hauler_meridian' }, sources: [{ kind: 'commercial', stations: ['exchange'], price: 62000, rep: 12, contracts: 2 }, { kind: 'explore', tier: 1, chance: 0.05 }], requires: ['logistics_ai'] },
  { id: 'bp_cruiser_vigil', name: '감시자급 경순양함 설계도', desc: '감시자급 선체의 건조 권리. 경순양함 설계와 미세 전자공학, 광학 레이저가 필요하다.', grade: 'rare', target: { kind: 'hull', id: 'cruiser_vigil' }, sources: [{ kind: 'commercial', stations: ['helios', 'bastion'], price: 110000, rep: 30, contracts: 5 }, { kind: 'explore', tier: 2, chance: 0.04 }, { kind: 'salvage', fragments: 5, chance: 0.05 }], requires: ['light_cruiser_design', 'microelectronics', 'optical_lasers'] },
  { id: 'bp_cruiser_vigil_command', name: '감시자급 지휘형 설계도', desc: '감시자급 지휘 구조를 건조하거나 개장할 권리. 통신 시설과 장거리 센서 연구가 필요하다.', grade: 'advanced', target: { kind: 'variant', id: 'cruiser_vigil_command' }, sources: [{ kind: 'commercial', stations: ['helios', 'bastion'], price: 60000, rep: 35, contracts: 5 }, { kind: 'explore', tier: 2, chance: 0.05 }] },
];
