// P17.3f internal parts and combat computers.
//
// Computers change BEHAVIOUR only (validate.ts: a computer has no fx). The P17.3f products are new
// archetypes (missile, flank) or tuned versions of existing ones (CpuTune: range / volley / guide /
// cover / energy, sim/ai/computer.ts), so two products of one archetype genuinely fight differently.
// Internal parts are ordinary fx modules with a cost on the other side of the ledger (mass, power, or a
// second multiplier below 1) — none is a free upgrade. docs/P17_3_ARSENAL.md
import type { ModuleContent, CpuModSpec } from '../../schema';

const C = (id: string, name: string, cpu: CpuModSpec, power: number, mass: number, time: number, inp: Record<string, number>, desc: string, tech?: string): ModuleContent => ({
  id, name, desc, slot: 'computer', size: 'S', mass, power, fx: {}, cpu, ...(tech ? { tech } : {}),
  recipe: { fac: 'electronics_fab', time, in: inp },
});

export const P17_CPUS: ModuleContent[] = [
  // missile control: stand at missile range, launch every rack together, steer the missiles harder
  C('cpu_missile', '미사일 관제 컴퓨터', { arch: 'missile', tune: { volley: 2.5, guide: 1.15 } }, 4, 2, 640, { electronics: 6, precision: 3, sensor: 1 },
    '미사일 최장 사거리 근처를 지키고 접근당하면 이탈한다. 준비된 발사기는 최대 2.5초까지 다른 발사기를 기다려 한 번에 쏟아 붓고, 비행 중 유도 선회를 15% 높인다.', 'tot_fire_control'),
  C('cpu_missile_lite', '보급형 미사일 관제기', { arch: 'missile', react: 1.5, tune: { volley: 1.2 } }, 2, 2, 380, { electronics: 4, precision: 1 },
    '미사일 사거리 유지와 짧은 일제 발사 대기(1.2초)만 한다. 유도 보정은 없고 판단이 느리다(1.5초).', 'fire_control'),
  // long range / close assault: the same behaviours as artillery / swarm, pushed further
  C('cpu_longbow', '원거리 사격 컴퓨터', { arch: 'artillery', react: 0.8, tune: { range: 1.08 } }, 5, 3, 700, { electronics: 7, precision: 3, crystal: 2 },
    '포격 원형을 최장 사거리 끝(×1.08)까지 끌어내 싸운다. 정밀 사격통제가 없으면 원거리 명중률이 떨어지므로 함께 쓰는 것이 좋다.', 'long_sensors'),
  C('cpu_assault', '근접 강습 컴퓨터', { arch: 'swarm', react: 0.6, tune: { range: 0.7 } }, 4, 2, 560, { electronics: 5, precision: 3 },
    '군집 원형보다 30% 더 가까이 파고들고 0.6초마다 다시 판단한다. 단거리 고화력 무장 전용 — 장거리 무장만 단 함선에는 손해다.', 'fire_control'),
  // air defence: guards friends' incoming rounds over a wide radius whatever the ship's own order
  C('cpu_aegis', '함대 방공 컴퓨터', { arch: 'picket', tune: { cover: 1700 } }, 5, 2, 620, { electronics: 6, sensor: 2, precision: 2 },
    '초계 원형에 함대 방공망을 더한다. 반경 1,700m 안의 아군을 노리는 미사일·어뢰를 자신이 노린 것처럼 우선 요격한다.', 'proximity_flak'),
  // line keeping: a faster-reacting line computer that holds a little further back
  C('cpu_lineholder', '전열 유지 컴퓨터', { arch: 'line', react: 0.6, tune: { range: 1.05 } }, 4, 3, 560, { electronics: 6, precision: 3 },
    '전열 원형을 0.6초 주기로 갱신해 대형 오차를 줄이고, 중앙값 사거리보다 5% 뒤에서 버틴다.', 'fire_control'),
  // flank: new behaviour — swing to the target's beam / stern quarter
  C('cpu_flanker', '측면 기동 컴퓨터', { arch: 'flank' }, 4, 2, 560, { electronics: 5, precision: 3 },
    '표적의 정면을 피해 측면·후방 사분면(함수 기준 135°)으로 크게 돌아 들어가 약한 측후면 장갑을 친다. 표적이 함수를 돌려 오면 반대편으로 바꾼다.', 'vector_thrust'),
  // energy management: a line computer that steps out of range to recharge a failing shield
  C('cpu_energy', '에너지 관리 컴퓨터', { arch: 'line', tune: { energy: 0.3 } }, 4, 2, 600, { electronics: 6, crystal: 2, precision: 2 },
    '전열 원형으로 싸우다 실드가 30% 밑으로 떨어지면 적 사거리 밖으로 함수를 적에게 둔 채 물러나 재충전한 뒤 복귀한다. 실드가 없는 함선에는 효과가 없다.', 'charge_capacitors'),
  // special support: a quicker support computer with a longer stand-off
  C('cpu_medevac', '긴급 지원 컴퓨터', { arch: 'support', react: 0.5, tune: { range: 1.2 } }, 4, 2, 600, { electronics: 6, precision: 2, sensor: 1 },
    '지원·수리 원형을 0.5초 주기로 판단해 위급한 아군으로 빠르게 옮겨 간다. 수리 장비가 없으면 기본 제어로 동작한다.', 'damage_control'),
];

const M = (id: string, name: string, slot: ModuleContent['slot'], size: ModuleContent['size'], mass: number, power: number, fx: ModuleContent['fx'], fac: string, time: number, inp: Record<string, number>, desc: string, tech?: string): ModuleContent => ({
  id, name, desc, slot, size, mass, power, fx, ...(tech ? { tech } : {}), recipe: { fac, time, in: inp },
});

export const P17_PARTS: ModuleContent[] = [
  M('mod_capacitor_bank', '축전기 뱅크', 'special', 'S', 8, 9, { reloadMul: 0.93 }, 'reactor_plant', 1100, { electronics: 6, crystal: 4, composite: 2 },
    '모든 무장 재장전 -7%. 특수 베이를 쓰고 전력을 9 소모한다 — 반응로 개조(반응로 베이)와 겹쳐 쓸 수 있지만 전력 여유가 필요하다.', 'charge_capacitors'),
  M('mod_shield_cap', '고속 재생 실드', 'armor', 'M', 9, 12, { shield: 0.08, shieldRegen: 0.05 }, 'reactor_plant', 1300, { electronics: 6, crystal: 5, optics: 2 },
    '선체 내구 8%의 얇은 실드를 초당 5%씩 빠르게 되살린다. 편향 실드(15%·초당 2%)보다 한 번의 집중 사격에 약하고 소모전에 강하다.', 'deflector_shields'),
  M('mod_gyro_fcs', '자이로 안정 사격통제', 'fcs', 'S', 3, 5, { accMul: 1.12, rangeMul: 1.04 }, 'electronics_fab', 700, { electronics: 5, precision: 3, crystal: 1 },
    '명중 +12%, 사거리 +4%. 사격통제장치보다 명중은 낮지만 사거리를 함께 늘린다.', 'long_sensors'),
  M('mod_flak_director', '근접 신관 지휘기', 'fcs', 'S', 2, 4, { pdMul: 1.3, accMul: 0.95 }, 'electronics_fab', 600, { electronics: 4, sensor: 1, precision: 1 },
    '방공포 요격률 +30%. 사격통제를 방공에 돌려 주무장 명중 -5%.', 'proximity_flak'),
  M('mod_afterburner', '후연소 추진기', 'engine', 'S', 5, 8, { speedMul: 1.25, evasion: 0.05, hpMul: 0.95 }, 'engine_plant', 900, { machinery: 4, precision: 3, chemicals: 6 },
    '속도 +25%, 회피 +5%. 연료 계통이 노출돼 선체 내구 -5%.', 'vector_thrust'),
  M('mod_ablative', '삭마 장갑', 'armor', 'M', 20, 0, { armorMul: 1.15, speedMul: 0.94 }, 'armor_plant', 900, { armor_plate: 8, composite: 4, chemicals: 4 },
    '장갑 +15%. 무거워 속도 -6%.', 'reactive_armor'),
  M('mod_bulkhead', '격벽 구획화', 'special', 'M', 14, 2, { hpMul: 1.1, speedMul: 0.97 }, 'armor_plant', 800, { structure: 6, armor_plate: 2, machinery: 2 },
    '선체 내구 +10%. 내부 격벽 무게로 속도 -3%.', 'damage_control'),
  M('mod_ecm_heavy', '대형 전자전 어레이', 'ew', 'M', 8, 16, { evasion: 0.2 }, 'electronics_fab', 1400, { electronics: 10, rare_metal: 4, crystal: 4 },
    '적 명중률 -20%. 전력 16을 소모하는 대형 장비(M).', 'ecm'),
  M('mod_target_link', '표적 데이터 링크', 'sensor', 'S', 3, 6, { rangeMul: 1.12, accMul: 0.96 }, 'electronics_fab', 800, { sensor: 1, electronics: 4, precision: 1 },
    '무장 사거리 +12%. 먼 표적 데이터에 의존해 명중 -4%.', 'long_sensors'),
  M('mod_reactor_mk2', '과부하 반응로', 'reactor', 'M', 12, -30, { hpMul: 0.96 }, 'reactor_plant', 1300, { reactor: 1, electronics: 4, rare_metal: 2 },
    '전력 공급 +30. 불안정한 노심 때문에 선체 내구 -4%.', 'reactor_tuning'),
];

/** public stations that stock some of the new computers / parts (others: research + own production only) */
export const P17_PART_MARKETS: Record<string, string[]> = {
  helios: ['cpu_lineholder', 'mod_gyro_fcs', 'mod_bulkhead'],
  astra: ['cpu_assault', 'cpu_missile_lite', 'mod_afterburner'],
  bastion: ['cpu_aegis', 'mod_ablative', 'mod_flak_director'],
  drakeout: ['cpu_flanker', 'mod_shield_cap'],
};
