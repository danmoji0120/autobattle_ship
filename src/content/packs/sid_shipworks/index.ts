// SIDERARIUM Shipworks: four role-defined hulls, structural derivatives and production licences.
// All ids are save-facing: never rename or recycle once published.
// This data-only pack is enabled in growth worlds (contentV >= 3).
import type { BlueprintDef, ContentPack, HardpointDef, HullDef, PresetDef, VariantDef } from '../../schema';

const pd = (id: string, x: number, y: number, z: number, facing: number): HardpointDef =>
  ({ id, pos: [x, y, z], facing, arc: 175, size: 'S', type: 'pd', mount: 'turret' });

const vls = (id: string, x: number, y: number, z: number): HardpointDef =>
  ({ id, pos: [x, y, z], facing: 0, arc: 180, size: 'M', type: 'missile', mount: 'vls' });

const std = (hull: string, desc: string): VariantDef =>
  ({ id: `${hull}_std`, hull, name: '표준형', desc, blueprint: 'common' });

const preset = (
  id: string, hull: string, variant: string, name: string, desc: string, weapons: Record<string, string>,
): PresetDef => ({ id, hull, variant, name, desc, weapons });

const pds = (...ids: string[]): Record<string, string> =>
  Object.fromEntries(ids.map(id => [id, 'eq_pd_gun']));

export const SID_SHIPWORKS_HULLS: HullDef[] = [
  {
    id: 'sid_frigate_kestrel', classId: 'frigate', name: '황조롱이급', maker: '드레이크 항로조선',
    tier: 1, size: 'S', moduleSlots: 2, power: 30, mass: 38, blueprint: 'advanced',
    mesh: { base: 'frigate', scale: 0.9 },
    desc: '정면 어뢰 돌입을 위해 장갑과 전방위 포격을 포기한 고속 호위함. 적의 측후방을 잡으면 위협적이나 선회전과 집중 포화에 약하다.',
    stats: { hpMul: 0.72, armorMul: 0.68, speedMul: 1.3 },
    ops: { cruise: 152, berth: 'S' },
    build: {
      yard: 1, time: 4300, credits: 3300, tech: ['ship_propulsion'], facilities: ['engine_plant'],
      parts: { structure: 35, armor_plate: 8, engine: 3, reactor: 1, sensor: 1, electronics: 8 },
    },
    upkeep: { credits: 810, supplies: { chemicals: 2.5, machinery: 0.1 }, wear: 0.065 },
    sale: { stations: ['drakeout', 'rustport'], rep: 10, stock: 2, restock: 5000 },
    internals: [
      { id: 'eng1', kind: 'engine', size: 'S' },
      { id: 'bay1', kind: 'special', size: 'M' },
    ],
    hardpoints: [
      { id: 'tube1', pos: [0, 0.7, 7.8], facing: 0, arc: 18, size: 'M', type: 'missile', mount: 'fixed' },
      { id: 'coil1', pos: [1.5, 1.3, 3.5], facing: 0, arc: 22, size: 'S', type: 'ballistic', mount: 'fixed' },
      { id: 'coil2', pos: [-1.5, 1.3, 3.5], facing: 0, arc: 22, size: 'S', type: 'ballistic', mount: 'fixed' },
      pd('pd1', 1.8, 2, -3.5, 90), pd('pd2', -1.8, 2, -3.5, -90),
    ],
  },
  {
    id: 'sid_light_cruiser_prism', classId: 'light_cruiser', name: '프리즘급', maker: '헬리오스 광학국',
    tier: 2, size: 'M', moduleSlots: 3, power: 64, mass: 70, blueprint: 'advanced',
    mesh: { base: 'light_cruiser', scale: 1.05 },
    desc: '선체 축을 따라 대형 광학포 한 문을 운용하는 경순양함. 대형함을 장거리에서 위협하지만 사격 호각이 좁고 근접전 방어력이 낮다.',
    stats: { hpMul: 0.73, armorMul: 0.65, speedMul: 1.04 },
    ops: { cruise: 132, berth: 'M' },
    build: {
      yard: 2, time: 8500, credits: 8700, tech: ['fire_control'], facilities: ['electronics_fab', 'hull_works'],
      parts: { structure: 78, armor_plate: 20, engine: 3, reactor: 4, sensor: 4, electronics: 28, optics: 10 },
    },
    upkeep: { credits: 1900, supplies: { electronics: 0.7, chemicals: 2 }, wear: 0.065 },
    sale: { stations: ['helios'], rep: 25, stock: 1, restock: 10000 },
    internals: [
      { id: 'rx1', kind: 'reactor', size: 'M' },
      { id: 'fcs1', kind: 'fcs', size: 'S' },
      { id: 'sen1', kind: 'sensor', size: 'S' },
    ],
    hardpoints: [
      { id: 'spine1', pos: [0, 1.8, 13], facing: 0, arc: 10, size: 'L', type: 'energy', mount: 'spinal' },
      { id: 'side1', pos: [3, 3.1, -2], facing: 90, arc: 125, size: 'M', type: 'energy', mount: 'turret' },
      pd('pd1', 3.2, 2.7, 7, 90), pd('pd2', -3.2, 2.7, -7, -90),
    ],
  },
  {
    id: 'sid_battlecruiser_tempest', classId: 'battlecruiser', name: '폭풍우급', maker: '바스티온 전술조선',
    tier: 3, size: 'L', moduleSlots: 5, power: 85, mass: 152, blueprint: 'faction',
    mesh: { base: 'battlecruiser', scale: 1.02 },
    desc: '대구경 포탑을 장거리 유도탄과 대함 어뢰 셀로 교체한 순양전함. 첫 포화는 강력하지만 방공망·탄약 소모·얇은 선체에 취약하다.',
    stats: { hpMul: 0.77, armorMul: 0.62, speedMul: 1.1 },
    ops: { cruise: 119, berth: 'L' },
    build: {
      yard: 3, time: 15400, credits: 14800,
      tech: ['capital_hulls', 'guided_missiles'], facilities: ['weapons_factory', 'dock'],
      parts: { structure: 195, armor_plate: 45, engine: 5, reactor: 5, sensor: 6, electronics: 42, precision: 14 },
    },
    upkeep: { credits: 4200, supplies: { chemicals: 8, electronics: 1.1, machinery: 0.7 }, wear: 0.075 },
    sale: { stations: ['bastion', 'helios'], rep: 45, stock: 1, restock: 18000 },
    internals: [
      { id: 'rx1', kind: 'reactor', size: 'M' },
      { id: 'sen1', kind: 'sensor', size: 'S' },
      { id: 'fcs1', kind: 'fcs', size: 'S' },
      { id: 'bay1', kind: 'special', size: 'M' },
      { id: 'eng1', kind: 'engine', size: 'S' },
    ],
    hardpoints: [
      { id: 'strike1', pos: [0, 3.6, 13], facing: 0, arc: 180, size: 'L', type: 'missile', mount: 'vls' },
      vls('vls1', 4, 2.8, 7), vls('vls2', -4, 2.8, 7),
      vls('vls3', 4, 2.8, 0), vls('vls4', -4, 2.8, 0),
      vls('vls5', 4, 2.8, -7), vls('vls6', -4, 2.8, -7),
      pd('pd1', 5, 4, 15, 90), pd('pd2', -5, 4, 15, -90),
      pd('pd3', 5, 4, -15, 90), pd('pd4', -5, 4, -15, -90),
    ],
  },
  {
    id: 'sid_hauler_bulwark', classId: 'hauler', name: '성채급', maker: '상인 길드 호송조선',
    tier: 2, size: 'L', moduleSlots: 4, power: 42, mass: 90, blueprint: 'advanced',
    mesh: { base: 'hauler_l', scale: 1.55 },
    desc: '대형 벌크선의 적재 공간 절반을 장갑 격벽·자위 화포·방공 시설에 양보한 호송 화물선. 호위 없이도 소규모 습격에 대응하지만 운송 단가가 높다. 정거장 기능은 없다.',
    stats: { hpMul: 1.55, armorMul: 1.55, speedMul: 0.76 },
    ops: { cruise: 44, cargo: 1600, berth: 'L' },
    build: {
      yard: 2, time: 8400, credits: 8900, tech: ['logistics_ai', 'reactive_armor'],
      facilities: ['armor_plant', 'dock'],
      parts: { structure: 180, armor_plate: 65, engine: 4, reactor: 3, machinery: 32, electronics: 20 },
    },
    upkeep: { credits: 3000, supplies: { machinery: 0.5, alloy: 2, chemicals: 1.5 }, wear: 0.055 },
    sale: { stations: ['exchange', 'helios'], rep: 20, stock: 1, restock: 9000 },
    internals: [
      { id: 'arm1', kind: 'armor', size: 'M' },
      { id: 'arm2', kind: 'armor', size: 'M' },
      { id: 'fcs1', kind: 'fcs', size: 'S' },
      { id: 'eng1', kind: 'engine', size: 'S' },
    ],
    hardpoints: [
      { id: 'gun1', pos: [0, 6, 12], facing: 0, arc: 140, size: 'M', type: 'ballistic', mount: 'turret' },
      { id: 'gun2', pos: [0, 6, -12], facing: 180, arc: 140, size: 'M', type: 'ballistic', mount: 'turret' },
      pd('pd1', 5, 5.3, 16, 90), pd('pd2', -5, 5.3, 16, -90),
      pd('pd3', 5, 5.3, -16, 90), pd('pd4', -5, 5.3, -16, -90),
    ],
  },
];

export const SID_SHIPWORKS_VARIANTS: VariantDef[] = [
  std('sid_frigate_kestrel', '정면 고정 코일건 두 문과 어뢰관 한 기를 둔 습격형.'),
  {
    id: 'sid_frigate_kestrel_interceptor', hull: 'sid_frigate_kestrel', name: '요격형', blueprint: 'advanced',
    desc: '어뢰관을 철거하고 선회 레이저 두 문과 사격통제를 증설. 대소형함 대응은 늘지만 주력함 타격 수단을 잃고 유지비가 오른다.',
    hardpoints: {
      remove: ['tube1'], add: [
        { id: 'laser1', pos: [1.2, 2.1, 5], facing: 60, arc: 135, size: 'S', type: 'energy', mount: 'turret' },
        { id: 'laser2', pos: [-1.2, 2.1, 5], facing: -60, arc: 135, size: 'S', type: 'energy', mount: 'turret' },
      ],
    },
    internals: { add: [{ id: 'fcs2', kind: 'fcs', size: 'S' }] },
    mods: { hpMul: 0.94, upkeepMul: 1.18 },
    parts: { optics: 4, electronics: 8 },
    needs: { facilities: ['electronics_fab'], tech: ['optical_lasers'] },
  },
  {
    id: 'sid_frigate_kestrel_longstrike', hull: 'sid_frigate_kestrel', name: '쌍뢰형', blueprint: 'advanced',
    desc: '전방 코일건을 모두 철거하고 어뢰관을 하나 더 실었다. 대형함 돌입 화력은 높지만 경함정에 무력하고 선체 강성도 낮다.',
    hardpoints: {
      remove: ['coil1', 'coil2'], add: [
        { id: 'tube2', pos: [0, 0.7, 5.8], facing: 0, arc: 18, size: 'M', type: 'missile', mount: 'fixed' },
      ],
    },
    mods: { hpMul: 0.86, armorMul: 0.94, speedMul: 0.95, upkeepMul: 1.25 },
    parts: { structure: 5, munitions: 16 },
    needs: { facilities: ['weapons_factory'], tech: ['torpedo_casting'] },
  },

  std('sid_light_cruiser_prism', '척추형 광학 주포와 측면 부포 한 기. 장거리 화력 집중형.'),
  {
    id: 'sid_light_cruiser_prism_overload', hull: 'sid_light_cruiser_prism', name: '감마 과부하형', blueprint: 'rare',
    desc: '측면 부포와 방공포를 전부 걷어내 감마선 척추포의 방열·송전부를 확보한다. 한 방은 강하지만 근접 방어가 전무하고 속도·장갑·운영 효율이 악화한다.',
    hardpoints: { remove: ['side1', 'pd1', 'pd2'] },
    mods: { hpMul: 0.86, armorMul: 0.8, speedMul: 0.9, upkeepMul: 1.45 },
    parts: { reactor: 3, electronics: 15, optics: 8 },
    needs: { facilities: ['energy_fab'], tech: ['gamma_lasers'] },
  },
  {
    id: 'sid_light_cruiser_prism_screen', hull: 'sid_light_cruiser_prism', name: '광학 방공형', blueprint: 'advanced',
    desc: '척추포를 포기하고 선회 광학포 두 문과 방공 포탑 두 문을 증설한다. 대형함 장거리 관통력 대신 경함정·유도탄 대응력과 생존성을 얻는다.',
    hardpoints: {
      remove: ['spine1'], add: [
        { id: 'screen1', pos: [2.7, 3.1, 6.5], facing: 0, arc: 145, size: 'M', type: 'energy', mount: 'turret' },
        { id: 'screen2', pos: [-2.7, 3.1, 6.5], facing: 0, arc: 145, size: 'M', type: 'energy', mount: 'turret' },
        pd('pd3', 3.2, 2.7, -5, 90), pd('pd4', -3.2, 2.7, 5, -90),
      ],
    },
    mods: { hpMul: 1.17, armorMul: 1.12, speedMul: 0.88, upkeepMul: 1.22 },
    parts: { electronics: 12, armor_plate: 8 },
    needs: { facilities: ['electronics_fab'], tech: ['fire_control'] },
  },

  std('sid_battlecruiser_tempest', '유도탄 VLS 여섯 셀과 중어뢰 셀 한 기. 방공포 네 문.'),
  {
    id: 'sid_battlecruiser_tempest_arsenal', hull: 'sid_battlecruiser_tempest', name: '포화형', blueprint: 'advanced',
    desc: '대함 어뢰 셀과 함미 방공포 두 문을 철거하고 유도탄 VLS 두 셀을 추가. 장거리 포화량 대신 탄약 비용과 단독 생존성 문제가 커진다.',
    hardpoints: {
      remove: ['strike1', 'pd3', 'pd4'],
      add: [vls('vls7', 4, 2.8, -12), vls('vls8', -4, 2.8, -12)],
    },
    mods: { hpMul: 0.91, armorMul: 0.9, speedMul: 0.96, upkeepMul: 1.42 },
    parts: { electronics: 18, munitions: 48 },
    needs: { facilities: ['weapons_factory'], tech: ['lr_missiles'] },
  },
  {
    id: 'sid_battlecruiser_tempest_harpoon', hull: 'sid_battlecruiser_tempest', name: '작살형', blueprint: 'rare',
    desc: '중형 유도탄 네 셀을 제거하고 용골 대함 어뢰관을 증설. 대형함을 근거리에서 집중 타격하지만 선체 방향 의존·낮은 요격 회피력·기동성 저하가 심하다.',
    hardpoints: {
      remove: ['vls3', 'vls4', 'vls5', 'vls6'],
      add: [{ id: 'prow2', pos: [0, 1.8, 17], facing: 0, arc: 16, size: 'L', type: 'missile', mount: 'fixed' }],
    },
    mods: { hpMul: 0.94, armorMul: 0.84, speedMul: 0.86, upkeepMul: 1.32 },
    parts: { structure: 20, precision: 8, munitions: 30 },
    needs: { facilities: ['weapons_factory'], tech: ['asm_torpedoes'] },
  },

  std('sid_hauler_bulwark', '화물창을 희생한 2문 주포·4문 방공포·장갑 격벽 수송형.'),
  {
    id: 'sid_hauler_bulwark_guard', hull: 'sid_hauler_bulwark', name: '호송 방공형', blueprint: 'advanced',
    desc: '중형 주포 두 문을 철거하고 방공포 두 문·격실 방어를 강화. 호송 대열 보호력은 늘지만 대함 포격 능력과 적재량이 감소한다.',
    hardpoints: {
      remove: ['gun1', 'gun2'],
      add: [pd('pd5', 5.2, 5.3, 4, 90), pd('pd6', -5.2, 5.3, -4, -90)],
    },
    mods: { hpMul: 1.1, cargoMul: 0.9, speedMul: 0.93, upkeepMul: 1.2 },
    parts: { armor_plate: 12, electronics: 8 },
    needs: { facilities: ['electronics_fab'], tech: ['fire_control'] },
  },
  {
    id: 'sid_hauler_bulwark_runner', hull: 'sid_hauler_bulwark', name: '긴급 수송형', blueprint: 'advanced',
    desc: '후방 주포와 전방 방공포 두 문, 장갑 격벽을 빼고 추진기와 화물창을 늘린다. 빠르고 조금 더 실으나 방호력이 낮고 여전히 일반 벌크선보다 비싸다.',
    hardpoints: { remove: ['gun2', 'pd1', 'pd2'] },
    internals: {
      remove: ['arm2'],
      add: [{ id: 'eng2', kind: 'engine', size: 'S' }],
    },
    mods: { hpMul: 0.84, armorMul: 0.76, speedMul: 1.32, cargoMul: 1.2, upkeepMul: 1.25 },
    parts: { engine: 3, machinery: 10 },
    needs: { facilities: ['engine_plant'], tech: ['ship_propulsion'] },
  },
];

export const SID_SHIPWORKS_PRESETS: PresetDef[] = [
  preset('sid_kestrel_torpedo', 'sid_frigate_kestrel', 'sid_frigate_kestrel_std', '침투',
    '표준 어뢰 1 + 고정 코일건 2 + 방공 2. 대형함의 측후방에 진입한다.',
    { tube1: 'eq_torp_std', coil1: 'eq_coil_s', coil2: 'eq_coil_s', ...pds('pd1', 'pd2') }),
  preset('sid_kestrel_cheap', 'sid_frigate_kestrel', 'sid_frigate_kestrel_std', '저비용 습격',
    '일반 어뢰 1 + 기관포 2 + 방공 2. 초반 보급 부담을 줄인 형식.',
    { tube1: 'eq_torpedo', coil1: 'eq_autocannon', coil2: 'eq_autocannon', ...pds('pd1', 'pd2') }),
  preset('sid_kestrel_intercept', 'sid_frigate_kestrel', 'sid_frigate_kestrel_interceptor', '경함정 요격',
    '적색 레이저 2 + 코일건 2 + 방공 2. 대함 어뢰는 없다.',
    { laser1: 'eq_laser_red', laser2: 'eq_laser_red', coil1: 'eq_coil_s', coil2: 'eq_coil_s', ...pds('pd1', 'pd2') }),
  preset('sid_kestrel_double_torp', 'sid_frigate_kestrel', 'sid_frigate_kestrel_longstrike', '쌍열 어뢰 돌입',
    '고정 어뢰관 2 + 방공 2. 적 방공망이 두꺼우면 화력이 급감한다.',
    { tube1: 'eq_torp_std', tube2: 'eq_torp_std', ...pds('pd1', 'pd2') }),

  preset('sid_prism_xray', 'sid_light_cruiser_prism', 'sid_light_cruiser_prism_std', '정밀 저격',
    'X선 척추포 1 + 청색 레이저 1 + 방공 2. 대형함 저격에 집중한다.',
    { spine1: 'eq_laser_xray', side1: 'eq_laser_blue', ...pds('pd1', 'pd2') }),
  preset('sid_prism_gamma', 'sid_light_cruiser_prism', 'sid_light_cruiser_prism_overload', '감마 일격',
    '감마선 척추포 단독 운용. 방공·측후방 화력이 전무하다.',
    { spine1: 'eq_laser_gamma' }),
  preset('sid_prism_screen', 'sid_light_cruiser_prism', 'sid_light_cruiser_prism_screen', '광학 방공망',
    '선회 레이저 3 + 방공 4. X선 주포는 없다.',
    { side1: 'eq_laser_blue', screen1: 'eq_laser_blue', screen2: 'eq_laser_blue', ...pds('pd1', 'pd2', 'pd3', 'pd4') }),

  preset('sid_tempest_longrange', 'sid_battlecruiser_tempest', 'sid_battlecruiser_tempest_std', '원거리 초탄',
    '장거리 순항 미사일 6 + 고급 대함 어뢰 1 + 방공 4. 긴 비행 시간과 탄약 소모에 주의.',
    { strike1: 'eq_torp_asm', vls1: 'eq_missile_lr', vls2: 'eq_missile_lr', vls3: 'eq_missile_lr', vls4: 'eq_missile_lr', vls5: 'eq_missile_lr', vls6: 'eq_missile_lr', ...pds('pd1', 'pd2', 'pd3', 'pd4') }),
  preset('sid_tempest_smart', 'sid_battlecruiser_tempest', 'sid_battlecruiser_tempest_std', '유도탄 집중',
    '고급 유도 미사일 6 + 고급 대함 어뢰 1 + 방공 4. 요격 대응력을 높이는 대신 무장 비용이 높다.',
    { strike1: 'eq_torp_asm', vls1: 'eq_missile_smart', vls2: 'eq_missile_smart', vls3: 'eq_missile_smart', vls4: 'eq_missile_smart', vls5: 'eq_missile_smart', vls6: 'eq_missile_smart', ...pds('pd1', 'pd2', 'pd3', 'pd4') }),
  preset('sid_tempest_arsenal', 'sid_battlecruiser_tempest', 'sid_battlecruiser_tempest_arsenal', '수평선 포화',
    '장거리 순항 미사일 8 + 방공 2. 함대 방공 호위가 필수.',
    { vls1: 'eq_missile_lr', vls2: 'eq_missile_lr', vls3: 'eq_missile_lr', vls4: 'eq_missile_lr', vls5: 'eq_missile_lr', vls6: 'eq_missile_lr', vls7: 'eq_missile_lr', vls8: 'eq_missile_lr', ...pds('pd1', 'pd2') }),
  preset('sid_tempest_harpoon', 'sid_battlecruiser_tempest', 'sid_battlecruiser_tempest_harpoon', '작살 일제사격',
    '고급 대함 어뢰 2 + 장거리 순항 미사일 2 + 방공 4. 어뢰 사거리 안쪽으로 접근해야 한다.',
    { strike1: 'eq_torp_asm', prow2: 'eq_torp_asm', vls1: 'eq_missile_lr', vls2: 'eq_missile_lr', ...pds('pd1', 'pd2', 'pd3', 'pd4') }),

  preset('sid_bulwark_selfdefense', 'sid_hauler_bulwark', 'sid_hauler_bulwark_std', '자위 호송',
    '중형 함포 2 + 방공 4. 장갑 모듈은 내부 슬롯에서 별도 장착한다.',
    { gun1: 'eq_medium_gun', gun2: 'eq_medium_gun', ...pds('pd1', 'pd2', 'pd3', 'pd4') }),
  preset('sid_bulwark_guard', 'sid_hauler_bulwark', 'sid_hauler_bulwark_guard', '수송선단 방공',
    '방공 6. 전투함의 포격을 버텨낼 주무장은 없다.', pds('pd1', 'pd2', 'pd3', 'pd4', 'pd5', 'pd6')),
  preset('sid_bulwark_runner', 'sid_hauler_bulwark', 'sid_hauler_bulwark_runner', '긴급 수송',
    '함수 부포 1 + 후방 방공 2. 내부 엔진 모듈 추가 장착을 권장한다.',
    { gun1: 'eq_medium_gun', ...pds('pd3', 'pd4') }),
];

const hullBp = (
  hull: string, name: string, grade: BlueprintDef['grade'], sources: BlueprintDef['sources'], desc: string,
): BlueprintDef => ({ id: `bp_${hull}`, name: `${name} 선체 설계도`, desc, grade, target: { kind: 'hull', id: hull }, sources });
const variantBp = (
  variant: string, name: string, grade: BlueprintDef['grade'], sources: BlueprintDef['sources'], desc: string,
): BlueprintDef => ({ id: `bp_${variant}`, name: `${name} 개장 설계도`, desc, grade, target: { kind: 'variant', id: variant }, sources });

export const SID_SHIPWORKS_BLUEPRINTS: BlueprintDef[] = [
  hullBp('sid_frigate_kestrel', '황조롱이급', 'advanced', [
    { kind: 'commercial', stations: ['drakeout'], price: 35000, rep: 12, contracts: 2 },
    { kind: 'salvage', fragments: 4, chance: 0.12 },
  ], '고속 어뢰 호위함 선체 제작 허가. 완성 함선 구매와는 별개다.'),
  variantBp('sid_frigate_kestrel_interceptor', '황조롱이급 요격형', 'advanced', [
    { kind: 'commercial', stations: ['astra'], price: 25000, rep: 10, contracts: 2 },
    { kind: 'salvage', fragments: 4, chance: 0.1 },
  ], '어뢰관 대신 광학포·사격통제실을 설치하는 개장 권리.'),
  variantBp('sid_frigate_kestrel_longstrike', '황조롱이급 쌍뢰형', 'advanced', [
    { kind: 'commercial', stations: ['drakeout'], price: 30000, rep: 15, contracts: 3 },
    { kind: 'salvage', fragments: 5, chance: 0.09 },
  ], '정면 고정 어뢰관 두 기를 구성하는 개장 권리.'),

  hullBp('sid_light_cruiser_prism', '프리즘급', 'advanced', [
    { kind: 'commercial', stations: ['helios'], price: 80000, rep: 25, contracts: 4 },
    { kind: 'explore', tier: 2, chance: 0.055 },
  ], '대구경 척추포를 운용할 수 있는 광학 경순양함 선체 제작 허가.'),
  variantBp('sid_light_cruiser_prism_overload', '프리즘급 감마 과부하형', 'rare', [
    { kind: 'explore', tier: 3, chance: 0.035 },
    { kind: 'salvage', fragments: 10, chance: 0.035 },
  ], '감마선포를 위한 대규모 함내 송전·방열 개장 설계.'),
  variantBp('sid_light_cruiser_prism_screen', '프리즘급 광학 방공형', 'advanced', [
    { kind: 'commercial', stations: ['helios'], price: 54000, rep: 22, contracts: 3 },
    { kind: 'salvage', fragments: 6, chance: 0.08 },
  ], '척추포 공간을 선회 레이저와 방공 센서로 전환하는 설계.'),

  hullBp('sid_battlecruiser_tempest', '폭풍우급', 'faction', [
    { kind: 'faction', faction: 'union', stations: ['bastion'], price: 160000, influence: 40, rep: 35 },
    { kind: 'salvage', fragments: 12, chance: 0.03 },
  ], '연합 해군 고밀도 VLS 전용 순양전함 선체의 제작 권리.'),
  variantBp('sid_battlecruiser_tempest_arsenal', '폭풍우급 포화형', 'advanced', [
    { kind: 'commercial', stations: ['helios'], price: 90000, rep: 35, contracts: 5 },
    { kind: 'salvage', fragments: 8, chance: 0.055 },
  ], '고급 대함 어뢰 셀을 철거하고 유도탄 셀을 확충하는 개장.'),
  variantBp('sid_battlecruiser_tempest_harpoon', '폭풍우급 작살형', 'rare', [
    { kind: 'contract', minTier: 3, chance: 0.055 },
    { kind: 'salvage', fragments: 10, chance: 0.04 },
  ], '고정형 대형 어뢰관을 선체 용골에 설치하는 개장.'),

  hullBp('sid_hauler_bulwark', '성채급', 'advanced', [
    { kind: 'commercial', stations: ['exchange'], price: 95000, rep: 18, contracts: 4 },
    { kind: 'salvage', fragments: 8, chance: 0.08 },
  ], '장갑 격벽과 호송용 자위 화포를 갖춘 화물선 제작 허가.'),
  variantBp('sid_hauler_bulwark_guard', '성채급 호송 방공형', 'advanced', [
    { kind: 'commercial', stations: ['exchange'], price: 62000, rep: 18, contracts: 3 },
    { kind: 'salvage', fragments: 7, chance: 0.08 },
  ], '중형 포탑을 함대 방공 시설로 치환하는 개장.'),
  variantBp('sid_hauler_bulwark_runner', '성채급 긴급 수송형', 'advanced', [
    { kind: 'commercial', stations: ['astra'], price: 58000, rep: 16, contracts: 3 },
    { kind: 'salvage', fragments: 6, chance: 0.08 },
  ], '장갑 격실 일부를 화물창과 추진기로 전환하는 개장.'),
];

export const SID_SHIPWORKS_PACK: ContentPack = {
  id: 'sid_shipworks', name: 'SIDERARIUM 시범 신형 함선 4종 및 파생형', minContentV: 3,
  hulls: SID_SHIPWORKS_HULLS,
  variants: SID_SHIPWORKS_VARIANTS,
  presets: SID_SHIPWORKS_PRESETS,
  blueprints: SID_SHIPWORKS_BLUEPRINTS,
};
